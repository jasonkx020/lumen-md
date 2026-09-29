//! Markdown (GFM) → DOCX / GitHub 风 HTML。
//! 色板与版式对齐 GitHub Primer / GFM 预览；DOCX 为可编辑近似，PDF 优先 HTML 打印。

use std::cell::RefCell;
use std::io::Cursor;
use std::panic::AssertUnwindSafe;

use comrak::nodes::{AstNode, ListType, NodeValue, TableAlignment};
use comrak::{format_html, parse_document, Arena, Options};
use docx_rs::*;

use crate::export_assets::{
    embed_images_in_html, extract_local_img_srcs, parse_simple_anchor, read_local_image_bytes,
    ExportAssetCtx,
};
use crate::html_sanitize::{is_html_table, sanitize_html_fragment};
use crate::html_table_docx::try_html_to_docx_table;

thread_local! {
    static ASSET_CTX: RefCell<ExportAssetCtx> = RefCell::new(ExportAssetCtx::default());
}

fn with_asset_ctx<T>(ctx: &ExportAssetCtx, f: impl FnOnce() -> T) -> T {
    ASSET_CTX.with(|cell| {
        *cell.borrow_mut() = ctx.clone();
        let out = f();
        *cell.borrow_mut() = ExportAssetCtx::default();
        out
    })
}

fn current_asset_ctx() -> ExportAssetCtx {
    ASSET_CTX.with(|cell| cell.borrow().clone())
}

const MAX_EXPORT_BYTES: u64 = 32 * 1024 * 1024;

/// HTML→PDF 探针：打印成功后应出现在 PDF 字节流中（用于拒绝 Chrome 新标签页假 PDF）。
pub const PDF_HTML_CANARY: &str = "LUMENMD_PDF_OK";

const BULLET_NUM_ID: usize = 10; // 避开 docx-rs 硬编码的 default numId=1（decimal）
const ORDERED_NUM_ID: usize = 11;

/// 正文默认字号（半磅）：16px≈12pt → 24 half-points（GitHub markdown-body 偏 16px）
const BODY_SIZE: usize = 22;
/// 行距 auto 360 ≈ 1.5
const BODY_LINE: i32 = 360;
const PARA_AFTER: u32 = 200;
const LIST_TIGHT_AFTER: u32 = 40;
const LIST_LOOSE_AFTER: u32 = 140;

// —— GitHub Primer 风格 token（与 HTML CSS 共用）——
const COLOR_FG: &str = "24292F";
const COLOR_QUOTE: &str = "656D76";
const COLOR_HR: &str = "D0D7DE";
const COLOR_QUOTE_BORDER: &str = "D0D7DE";
const COLOR_CODE_BG: &str = "F6F8FA";
const COLOR_INLINE_CODE_BG: &str = "EFF1F3";
const COLOR_INLINE_CODE_FG: &str = "24292F";
const COLOR_TABLE_HEADER: &str = "F6F8FA";
const COLOR_TABLE_RULE: &str = "D0D7DE";
const COLOR_TABLE_RULE_LIGHT: &str = "D8DEE4";
const COLOR_LINK: &str = "0969DA";
const COLOR_H6: &str = "656D76";

/// 约 A4 页芯宽度（twips），与 ~2cm 页边距配套
const TABLE_WIDTH_DXA: usize = 9026;

fn gfm_options() -> Options<'static> {
    let mut options = Options::default();
    options.extension.strikethrough = true;
    options.extension.table = true;
    options.extension.tasklist = true;
    options.extension.autolink = true;
    options.extension.footnotes = true;
    // 给 h1–h6 生成 id，便于 PDF 书签 / 锚点
    options.extension.header_ids = Some(String::new());
    options
}

/// PDF/HTML 导出：在已消毒前提下允许透传原始 HTML（保留 table/rowspan）。
fn gfm_options_allow_sanitized_html() -> Options<'static> {
    let mut options = gfm_options();
    options.render.r#unsafe = true;
    options
}

/// 就地消毒 AST 中的 HtmlBlock / HtmlInline。
fn sanitize_html_nodes<'a>(root: &'a AstNode<'a>) {
    for node in root.descendants() {
        let mut data = node.data.borrow_mut();
        match &mut data.value {
            NodeValue::HtmlBlock(hb) => {
                hb.literal = sanitize_html_fragment(&hb.literal);
            }
            NodeValue::HtmlInline(s) => {
                *s = sanitize_html_fragment(s);
            }
            _ => {}
        }
    }
}

fn html_open_tag_name(html: &str) -> Option<String> {
    let t = html.trim();
    if t.starts_with("</") || t.ends_with("/>") {
        return None;
    }
    let bytes = t.as_bytes();
    if !bytes.starts_with(b"<") {
        return None;
    }
    let rest = &t[1..];
    let name: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == ':')
        .collect();
    if name.is_empty() {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    match lower.as_str() {
        "area" | "base" | "br" | "col" | "embed" | "hr" | "img" | "input" | "link" | "meta"
        | "param" | "source" | "track" | "wbr" => None,
        _ => {
            if t.ends_with('>') && !t[1..].contains('<') {
                Some(lower)
            } else {
                None
            }
        }
    }
}

fn html_close_tag_name(html: &str) -> Option<String> {
    let t = html.trim();
    let rest = t.strip_prefix("</")?;
    let name: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == ':')
        .collect();
    if name.is_empty() || !t.ends_with('>') {
        return None;
    }
    Some(name.to_ascii_lowercase())
}

/// 合并拆散的行内 HTML：`<a …>` + text + `</a>` → 单个 HtmlInline。
fn merge_html_inlines<'a>(root: &'a AstNode<'a>) {
    let parents: Vec<&'a AstNode<'a>> = root.descendants().collect();
    for parent in parents {
        let children: Vec<&'a AstNode<'a>> = parent.children().collect();
        if children.len() < 2 {
            continue;
        }
        let mut i = 0usize;
        while i < children.len() {
            let open_tag = match &children[i].data.borrow().value {
                NodeValue::HtmlInline(s) => html_open_tag_name(s),
                _ => None,
            };
            let Some(tag) = open_tag else {
                i += 1;
                continue;
            };
            let mut parts = Vec::new();
            if let NodeValue::HtmlInline(s) = &children[i].data.borrow().value {
                parts.push(s.clone());
            }
            let mut depth = 1i32;
            let mut j = i + 1;
            let mut ok = false;
            while j < children.len() && depth > 0 {
                match &children[j].data.borrow().value {
                    NodeValue::HtmlInline(s) => {
                        if html_open_tag_name(s).as_deref() == Some(tag.as_str()) {
                            depth += 1;
                        } else if html_close_tag_name(s).as_deref() == Some(tag.as_str()) {
                            depth -= 1;
                        }
                        parts.push(s.clone());
                        j += 1;
                        if depth == 0 {
                            ok = true;
                            break;
                        }
                    }
                    NodeValue::Text(t) => {
                        parts.push(t.to_string());
                        j += 1;
                    }
                    _ => break,
                }
            }
            if ok {
                children[i].data.borrow_mut().value = NodeValue::HtmlInline(parts.join(""));
                for node in children.iter().take(j).skip(i + 1) {
                    node.detach();
                }
                i = j;
            } else {
                i += 1;
            }
        }
    }
}

fn body_fonts() -> RunFonts {
    RunFonts::new()
        .ascii("Segoe UI")
        .hi_ansi("Segoe UI")
        .east_asia("微软雅黑")
}

fn mono_fonts() -> RunFonts {
    RunFonts::new()
        .ascii("Consolas")
        .hi_ansi("Consolas")
        .east_asia("Consolas")
}

fn body_line_spacing() -> LineSpacing {
    LineSpacing::new()
        .line_rule(LineSpacingType::Auto)
        .line(BODY_LINE)
}

fn para_spacing(after: u32) -> LineSpacing {
    body_line_spacing().after(after)
}

fn heading_spacing(before: u32, after: u32) -> LineSpacing {
    LineSpacing::new()
        .line_rule(LineSpacingType::Auto)
        .line(276)
        .before(before)
        .after(after)
}

fn shade_fill(fill: &str) -> Shading {
    Shading::new()
        .shd_type(ShdType::Clear)
        .fill(fill)
        .color("auto")
}

fn with_para_shading(mut p: Paragraph, fill: &str) -> Paragraph {
    p.property = p.property.shading(shade_fill(fill));
    p
}

/// 将 Markdown 转为 DOCX 字节（OOXML zip）。
#[allow(dead_code)] // 无 ctx 便捷入口 / 单测；导出走 with_ctx
pub fn markdown_to_docx_bytes(markdown: &str) -> anyhow::Result<Vec<u8>> {
    markdown_to_docx_bytes_with_ctx(markdown, &ExportAssetCtx::default())
}

pub fn markdown_to_docx_bytes_with_ctx(
    markdown: &str,
    ctx: &ExportAssetCtx,
) -> anyhow::Result<Vec<u8>> {
    if markdown.len() as u64 > MAX_EXPORT_BYTES {
        anyhow::bail!("导出内容超过上限 {} bytes", MAX_EXPORT_BYTES);
    }

    with_asset_ctx(ctx, || {
        let arena = Arena::new();
        let root = parse_document(&arena, markdown, &gfm_options());
        merge_html_inlines(root);
        sanitize_html_nodes(root);

        let mut docx = apply_document_chrome(Docx::new())
            .add_abstract_numbering(bullet_abstract(BULLET_NUM_ID))
            .add_abstract_numbering(ordered_abstract(ORDERED_NUM_ID))
            .add_numbering(Numbering::new(BULLET_NUM_ID, BULLET_NUM_ID))
            .add_numbering(Numbering::new(ORDERED_NUM_ID, ORDERED_NUM_ID));

        let mut bookmark_id = 1usize;
        for child in root.children() {
            docx = append_block(docx, child, None, &mut bookmark_id);
        }

        let mut buf = Cursor::new(Vec::new());
        docx.build()
            .pack(&mut buf)
            .map_err(|e| anyhow::anyhow!("DOCX 打包失败: {e}"))?;
        Ok(buf.into_inner())
    })
}

/// GitHub 风独立 HTML（PDF 首选打印源）。
pub fn markdown_to_github_html(markdown: &str) -> anyhow::Result<String> {
    markdown_to_github_html_with_ctx(markdown, &ExportAssetCtx::default())
}

pub fn markdown_to_github_html_with_ctx(
    markdown: &str,
    ctx: &ExportAssetCtx,
) -> anyhow::Result<String> {
    if markdown.len() as u64 > MAX_EXPORT_BYTES {
        anyhow::bail!("导出内容超过上限 {} bytes", MAX_EXPORT_BYTES);
    }
    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &gfm_options());
    merge_html_inlines(root);
    sanitize_html_nodes(root);
    let mut body = String::new();
    format_html(root, &gfm_options_allow_sanitized_html(), &mut body)
        .map_err(|e| anyhow::anyhow!("HTML 渲染失败: {e}"))?;
    body = embed_images_in_html(&body, ctx);
    Ok(format!(
        r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>export · {canary}</title>
<style>
/* 自研 GitHub Primer / markdown-body 等价样式（MIT 产品内嵌，非 GPL） */
:root {{
  --fg: #{fg};
  --muted: #{quote};
  --border: #{rule};
  --canvas-subtle: #{code_bg};
  --accent: #{link};
  --inline-code-bg: #{inline_bg};
}}
* {{ box-sizing: border-box; }}
html, body {{ margin: 0; padding: 0; background: #fff; }}
body {{
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial,
    "Microsoft YaHei", sans-serif;
  font-size: 16px;
  line-height: 1.5;
  color: var(--fg);
}}
.markdown-body {{
  max-width: 980px;
  margin: 0 auto;
  padding: 32px 40px;
  word-wrap: break-word;
}}
.markdown-body h1, .markdown-body h2, .markdown-body h3,
.markdown-body h4, .markdown-body h5, .markdown-body h6 {{
  margin-top: 24px;
  margin-bottom: 16px;
  font-weight: 600;
  line-height: 1.25;
}}
.markdown-body h1 {{
  font-size: 2em;
}}
.markdown-body h2 {{
  font-size: 1.5em;
}}
.markdown-body h3 {{ font-size: 1.25em; }}
.markdown-body h4 {{ font-size: 1em; }}
.markdown-body h5 {{ font-size: 0.875em; }}
.markdown-body h6 {{ font-size: 0.85em; color: var(--muted); }}
.markdown-body p, .markdown-body ul, .markdown-body ol,
.markdown-body blockquote, .markdown-body pre, .markdown-body table {{
  margin-top: 0;
  margin-bottom: 16px;
}}
.markdown-body a {{ color: var(--accent); text-decoration: none; }}
.markdown-body a:hover {{ text-decoration: underline; }}
.markdown-body a[href] {{ cursor: pointer; }}
.markdown-body a[target="_blank"]::after {{ content: ""; }}
.markdown-body ul, .markdown-body ol {{ padding-left: 2em; }}
.markdown-body li + li {{ margin-top: 0.25em; }}
.markdown-body blockquote {{
  margin: 0 0 16px;
  padding: 0 1em;
  color: var(--muted);
  border-left: 0.25em solid var(--border);
}}
.markdown-body hr {{
  height: 0.25em;
  padding: 0;
  margin: 24px 0;
  background-color: var(--border);
  border: 0;
}}
.markdown-body code {{
  padding: 0.2em 0.4em;
  margin: 0;
  font-size: 85%;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  background-color: var(--inline-code-bg);
  border-radius: 6px;
}}
.markdown-body pre {{
  padding: 16px;
  overflow: auto;
  font-size: 85%;
  line-height: 1.45;
  background-color: var(--canvas-subtle);
  border-radius: 6px;
}}
.markdown-body pre code {{
  padding: 0;
  margin: 0;
  background: transparent;
  border-radius: 0;
  font-size: 100%;
}}
.markdown-body table {{
  border-spacing: 0;
  border-collapse: collapse;
  table-layout: fixed;
  width: 100%;
  max-width: 100%;
  border: none;
}}
/* 覆盖 HTML border="1" 等属性带来的浏览器默认黑框，四边与横线同色 */
.markdown-body table[border],
.markdown-body table[border] th,
.markdown-body table[border] td {{
  border-color: var(--border) !important;
}}
.markdown-body table th, .markdown-body table td {{
  padding: 6px 13px;
  border: 1px solid var(--border);
  vertical-align: top;
}}
.markdown-body table th {{
  font-weight: 600;
  background-color: var(--canvas-subtle);
}}
.markdown-body table tr {{ background-color: #fff; }}
.markdown-body table tr:nth-child(2n) {{ background-color: var(--canvas-subtle); }}
.markdown-body img {{ max-width: 100%; height: auto; vertical-align: middle; }}
.markdown-body a img {{ border: 0; }}
/* 默认块级图居中；flex 图墙除外 */
.markdown-body > p > img,
.markdown-body > p > a > img,
.markdown-body > img,
.markdown-body > a > img,
.markdown-body > picture {{
  display: block;
  margin-left: auto;
  margin-right: auto;
}}
.markdown-body > p:has(> img:only-child),
.markdown-body > p:has(> a:only-child > img) {{
  text-align: center;
}}
/* Typora/GitHub flex 图墙：可缩成一行 + 图间距 */
.markdown-body .lumen-html-flex,
.markdown-body div[style*="display: flex"],
.markdown-body div[style*="display:flex"] {{
  display: flex !important;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  align-items: flex-start;
  gap: 8px;
  text-align: initial;
  line-height: 0;
}}
.markdown-body .lumen-html-flex > a,
.markdown-body .lumen-html-flex > img,
.markdown-body .lumen-html-flex > picture,
.markdown-body div[style*="display: flex"] > a,
.markdown-body div[style*="display:flex"] > a,
.markdown-body div[style*="display: flex"] > img,
.markdown-body div[style*="display:flex"] > img {{
  min-width: 0;
  flex: 1 1 0;
  margin: 0;
  max-width: 100%;
  line-height: 0;
}}
.markdown-body .lumen-html-flex img,
.markdown-body div[style*="display: flex"] img,
.markdown-body div[style*="display:flex"] img {{
  display: block;
  width: 100%;
  max-width: 100%;
  height: auto;
  margin: 0;
  object-fit: contain;
  vertical-align: top;
}}
@media print {{
  .markdown-body {{ padding: 0; max-width: none; }}
  @page {{ margin: 1.5cm; }}
  a {{ color: var(--accent); }}
}}
.footnote-ref {{ font-size: 0.75em; vertical-align: super; }}
.footnotes {{ margin-top: 2em; border-top: 1px solid var(--border); padding-top: 0.5em; font-size: 0.9em; }}
.mermaid-export {{ text-align: center; margin: 1em 0; }}
</style>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>
(function () {{
  function run() {{
    if (!window.mermaid) return;
    mermaid.initialize({{ startOnLoad: false, securityLevel: "strict", theme: "neutral" }});
    var blocks = document.querySelectorAll("pre > code.language-mermaid, pre code.language-mermaid, pre[data-language='mermaid'] code, code.language-mermaid");
    var i = 0;
    blocks.forEach(function (code) {{
      var pre = code.closest("pre") || code.parentElement;
      if (!pre || pre.dataset.mermaidDone === "1") return;
      var src = (code.textContent || "").trim();
      if (!src) return;
      var host = document.createElement("div");
      host.className = "mermaid-export";
      pre.parentNode.insertBefore(host, pre);
      pre.style.display = "none";
      pre.dataset.mermaidDone = "1";
      var id = "mmd-exp-" + (i++);
      mermaid.render(id, src).then(function (r) {{
        host.innerHTML = r.svg;
      }}).catch(function (e) {{
        host.textContent = String(e);
        pre.style.display = "";
      }});
    }});
  }}
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
}})();
</script>
</head>
<body>
<article class="markdown-body">
{body}
</article>
</body>
</html>"#,
        fg = COLOR_FG,
        quote = COLOR_QUOTE,
        rule = COLOR_TABLE_RULE,
        code_bg = COLOR_CODE_BG,
        link = COLOR_LINK,
        inline_bg = COLOR_INLINE_CODE_BG,
        canary = PDF_HTML_CANARY,
    ))
}

/// 兼容旧名（测试 / 外部仍可调用）。
#[allow(dead_code)]
pub fn markdown_to_standalone_html(markdown: &str) -> anyhow::Result<String> {
    markdown_to_github_html(markdown)
}

fn apply_document_chrome(docx: Docx) -> Docx {
    let margin = PageMargin::new()
        .top(1134)
        .bottom(1134)
        .left(1134)
        .right(1134);

    let mut docx = docx
        .page_margin(margin)
        .default_size(BODY_SIZE)
        .default_fonts(body_fonts())
        .default_line_spacing(body_line_spacing());

    // GitHub 风格标题字号（半磅）+ H1/H2 底部分割线
    let headings: &[(u8, usize, u32, u32, Option<&str>, bool)] = &[
        (1, 40, 200, 200, None, true),
        (2, 30, 280, 160, None, true),
        (3, 24, 240, 140, None, false),
        (4, 22, 200, 120, None, false),
        (5, 20, 180, 100, None, false),
        (6, 18, 160, 80, Some(COLOR_H6), false),
    ];
    for &(level, size, before, after, color, bottom_rule) in headings {
        let id = format!("Heading{level}");
        let name = format!("Heading {level}");
        // OOXML outlineLvl：0 = 最高级（对应 Heading1）
        let mut style = Style::new(&id, StyleType::Paragraph)
            .name(name)
            .based_on("Normal")
            .bold()
            .size(size)
            .color(COLOR_FG)
            .fonts(body_fonts())
            .line_spacing(heading_spacing(before, after))
            .outline_lvl((level as usize).saturating_sub(1));
        if let Some(c) = color {
            style = style.color(c);
        }
        if bottom_rule {
            style.paragraph_property = style.paragraph_property.set_borders(
                ParagraphBorders::with_empty().set(
                    ParagraphBorder::new(ParagraphBorderPosition::Bottom)
                        .val(BorderType::Single)
                        .size(6)
                        .space(4)
                        .color(COLOR_HR),
                ),
            );
        }
        docx = docx.add_style(style);
    }

    let mut code_style = Style::new("mdCodeBlock", StyleType::Paragraph)
        .name("MD Code Block")
        .based_on("Normal")
        .fonts(mono_fonts())
        .size(18)
        .color(COLOR_FG)
        .line_spacing(LineSpacing::new().before(120).after(160).line(276));
    code_style.paragraph_property = code_style
        .paragraph_property
        .shading(shade_fill(COLOR_CODE_BG));
    docx = docx.add_style(code_style);

    let mut quote_style = Style::new("mdQuote", StyleType::Paragraph)
        .name("MD Quote")
        .based_on("Normal")
        .color(COLOR_QUOTE)
        .fonts(body_fonts())
        .size(BODY_SIZE)
        .indent(Some(420), None, None, None)
        .line_spacing(para_spacing(PARA_AFTER));
    quote_style.paragraph_property = quote_style.paragraph_property.set_borders(
        ParagraphBorders::with_empty().set(
            ParagraphBorder::new(ParagraphBorderPosition::Left)
                .val(BorderType::Single)
                .size(24)
                .space(10)
                .color(COLOR_QUOTE_BORDER),
        ),
    );
    docx.add_style(quote_style)
}

fn bullet_abstract(id: usize) -> AbstractNumbering {
    let mut abs = AbstractNumbering::new(id);
    for level in 0..6usize {
        abs = abs.add_level(
            Level::new(
                level,
                Start::new(1),
                NumberFormat::new("bullet"),
                LevelText::new(match level % 3 {
                    0 => "▪",
                    1 => "◦",
                    _ => "•",
                }),
                LevelJc::new("left"),
            )
            .indent(
                Some((720 + level * 360) as i32),
                Some(SpecialIndentType::Hanging(360)),
                None,
                None,
            ),
        );
    }
    abs
}

fn ordered_level_text(level: usize) -> String {
    let mut s = String::new();
    for i in 1..=(level + 1) {
        if i > 1 {
            s.push('.');
        }
        s.push('%');
        s.push_str(&i.to_string());
    }
    s.push('.');
    s
}

fn ordered_abstract(id: usize) -> AbstractNumbering {
    let mut abs = AbstractNumbering::new(id);
    for level in 0..6usize {
        abs = abs.add_level(
            Level::new(
                level,
                Start::new(1),
                NumberFormat::new("decimal"),
                LevelText::new(ordered_level_text(level)),
                LevelJc::new("left"),
            )
            .indent(
                Some((720 + level * 360) as i32),
                Some(SpecialIndentType::Hanging(360)),
                None,
                None,
            ),
        );
    }
    abs
}

#[derive(Clone, Copy)]
struct ListCtx {
    numbering_id: usize,
    indent: usize,
    tight: bool,
}

fn append_block<'a>(
    mut docx: Docx,
    node: &'a AstNode<'a>,
    list: Option<ListCtx>,
    bookmark_id: &mut usize,
) -> Docx {
    let value = node.data.borrow().value.clone();
    match value {
        NodeValue::Paragraph => {
            let mut p = paragraph_from_inlines(node, InlineOpts::default());
            if let Some(ctx) = list {
                p = p.numbering(
                    NumberingId::new(ctx.numbering_id),
                    IndentLevel::new(ctx.indent.min(5)),
                );
                let after = if ctx.tight {
                    LIST_TIGHT_AFTER
                } else {
                    LIST_LOOSE_AFTER
                };
                p = p.line_spacing(para_spacing(after));
            } else {
                p = p.line_spacing(para_spacing(PARA_AFTER));
            }
            docx.add_paragraph(p)
        }
        NodeValue::Heading(h) => {
            let level = h.level.clamp(1, 6);
            let style_id = match level {
                1 => "Heading1",
                2 => "Heading2",
                3 => "Heading3",
                4 => "Heading4",
                5 => "Heading5",
                _ => "Heading6",
            };
            let title = inline_plain_text(node);
            let bm_name = docx_heading_bookmark_name(*bookmark_id, &title);
            let id = *bookmark_id;
            *bookmark_id += 1;
            let p = paragraph_from_inlines(node, InlineOpts::default())
                .style(style_id)
                .outline_lvl((level as usize).saturating_sub(1))
                .add_bookmark_start(id, bm_name)
                .add_bookmark_end(id);
            docx.add_paragraph(p)
        }
        NodeValue::BlockQuote | NodeValue::MultilineBlockQuote(_) | NodeValue::Alert(_) => {
            for child in node.children() {
                docx = append_blockquote_block(docx, child, bookmark_id);
            }
            docx
        }
        NodeValue::CodeBlock(cb) => {
            let literal = cb.literal.trim_end_matches('\n');
            let mut p = Paragraph::new().style("mdCodeBlock");
            for (i, line) in literal.split('\n').enumerate() {
                if i > 0 {
                    p = p.add_run(Run::new().add_break(BreakType::TextWrapping));
                }
                p = p.add_run(code_run(line));
            }
            if literal.is_empty() {
                p = p.add_run(code_run(""));
            }
            p = with_para_shading(p, COLOR_CODE_BG);
            docx.add_paragraph(p)
        }
        NodeValue::ThematicBreak => {
            let p = Paragraph::new()
                .add_run(Run::new().add_text(""))
                .line_spacing(LineSpacing::new().before(200).after(200))
                .set_borders(
                    ParagraphBorders::with_empty().set(
                        ParagraphBorder::new(ParagraphBorderPosition::Bottom)
                            .val(BorderType::Single)
                            .size(12)
                            .space(1)
                            .color(COLOR_HR),
                    ),
                );
            docx.add_paragraph(p)
        }
        NodeValue::List(meta) => {
            let numbering_id = match meta.list_type {
                ListType::Bullet => BULLET_NUM_ID,
                ListType::Ordered => ORDERED_NUM_ID,
            };
            let base_indent = list.map(|c| c.indent + 1).unwrap_or(0);
            let tight = meta.tight;
            for item in node.children() {
                docx = append_list_item(
                    docx,
                    item,
                    ListCtx {
                        numbering_id,
                        indent: base_indent,
                        tight,
                    },
                    bookmark_id,
                );
            }
            docx
        }
        NodeValue::Item(_) | NodeValue::TaskItem(_) => append_list_item(
            docx,
            node,
            list.unwrap_or(ListCtx {
                numbering_id: BULLET_NUM_ID,
                indent: 0,
                tight: true,
            }),
            bookmark_id,
        ),
        NodeValue::Table(table) => {
            let aligns = table.alignments.clone();
            // 先收集单元格节点，再按内容权重分配列宽
            struct CellSrc<'a> {
                node: &'a AstNode<'a>,
                is_header: bool,
            }
            let mut row_srcs: Vec<Vec<CellSrc<'_>>> = Vec::new();
            let mut max_cols = aligns.len();
            for row_node in node.children() {
                if !matches!(row_node.data.borrow().value, NodeValue::TableRow(_)) {
                    continue;
                }
                let is_header =
                    matches!(row_node.data.borrow().value, NodeValue::TableRow(true));
                let mut cells = Vec::new();
                for cell_node in row_node.children() {
                    if !matches!(cell_node.data.borrow().value, NodeValue::TableCell) {
                        continue;
                    }
                    cells.push(CellSrc {
                        node: cell_node,
                        is_header,
                    });
                }
                max_cols = max_cols.max(cells.len());
                if !cells.is_empty() {
                    row_srcs.push(cells);
                }
            }
            if row_srcs.is_empty() {
                return docx;
            }
            let n_cols = max_cols.max(1);
            let mut col_weights = vec![1usize; n_cols];
            for row in &row_srcs {
                for (col, cell) in row.iter().enumerate() {
                    let w = display_weight(&inline_plain_text(cell.node));
                    col_weights[col] = col_weights[col].max(w);
                }
            }
            let col_widths = allocate_col_widths(&col_weights, TABLE_WIDTH_DXA);

            let mut rows: Vec<TableRow> = Vec::new();
            for row in &row_srcs {
                let mut cells: Vec<TableCell> = Vec::new();
                for (col, cell_src) in row.iter().enumerate() {
                    let mut p = paragraph_from_inlines(
                        cell_src.node,
                        InlineOpts {
                            force_bold: cell_src.is_header,
                            quote_color: false,
                        },
                    );
                    if let Some(a) = aligns.get(col) {
                        p = apply_cell_align(p, *a);
                    }
                    let width = *col_widths.get(col).unwrap_or(&col_widths[0]);
                    let mut cell = TableCell::new()
                        .add_paragraph(p)
                        .width(width, WidthType::Dxa)
                        .set_borders(md_cell_borders(cell_src.is_header))
                        .vertical_align(VAlignType::Top);
                    if cell_src.is_header {
                        cell = cell.shading(shade_fill(COLOR_TABLE_HEADER));
                    }
                    cell.property = cell
                        .property
                        .margin_top(60, WidthType::Dxa)
                        .margin_bottom(60, WidthType::Dxa)
                        .margin_left(100, WidthType::Dxa)
                        .margin_right(100, WidthType::Dxa);
                    cells.push(cell);
                }
                rows.push(TableRow::new(cells));
            }

            let mut table = Table::new(rows)
                .set_grid(col_widths)
                .width(TABLE_WIDTH_DXA, WidthType::Dxa)
                .layout(TableLayoutType::Fixed)
                .set_borders(md_table_borders());
            table.property = table
                .property
                .cell_margin_top(60, WidthType::Dxa)
                .cell_margin_bottom(60, WidthType::Dxa)
                .cell_margin_left(100, WidthType::Dxa)
                .cell_margin_right(100, WidthType::Dxa);
            docx.add_table(table)
        }
        NodeValue::HtmlBlock(hb) => {
            if is_html_table(&hb.literal) {
                if let Some(table) = try_html_to_docx_table(
                    &hb.literal,
                    TABLE_WIDTH_DXA,
                    COLOR_TABLE_HEADER,
                    md_cell_borders,
                    md_table_borders(),
                ) {
                    return docx.add_table(table);
                }
            }
            let safe = sanitize_html_fragment(&hb.literal);
            let ctx = current_asset_ctx();
            let img_srcs = extract_local_img_srcs(&safe);
            if !img_srcs.is_empty() {
                let mut any = false;
                for src in &img_srcs {
                    if let Some(bytes) = read_local_image_bytes(src, &ctx) {
                        if let Some(pic) = pic_from_bytes(&bytes) {
                            docx = docx.add_paragraph(
                                Paragraph::new()
                                    .add_run(Run::new().add_image(pic))
                                    .line_spacing(para_spacing(PARA_AFTER)),
                            );
                            any = true;
                        }
                    }
                }
                if any {
                    return docx;
                }
            }
            // 整块近似单个 <a>…</a>（含 star-history）
            if let Some((href, text)) = parse_simple_anchor(&safe) {
                let only_anchor = !safe.to_ascii_lowercase().contains("<div")
                    && !safe.to_ascii_lowercase().contains("<table");
                if only_anchor {
                    let mut h = Hyperlink::new(&href, HyperlinkType::External);
                    h = h.add_run(
                        Run::new()
                            .add_text(text)
                            .fonts(body_fonts())
                            .size(BODY_SIZE)
                            .color(COLOR_LINK)
                            .underline("single"),
                    );
                    return docx.add_paragraph(
                        Paragraph::new()
                            .add_hyperlink(h)
                            .line_spacing(para_spacing(PARA_AFTER)),
                    );
                }
            }
            let text = strip_rough_html(&safe);
            if text.trim().is_empty() {
                docx
            } else {
                docx.add_paragraph(
                    Paragraph::new()
                        .add_run(Run::new().add_text(text).fonts(body_fonts()).size(BODY_SIZE))
                        .line_spacing(para_spacing(PARA_AFTER)),
                )
            }
        }
        NodeValue::FrontMatter(s) => {
            if s.trim().is_empty() {
                docx
            } else {
                let p = with_para_shading(
                    Paragraph::new()
                        .style("mdCodeBlock")
                        .add_run(code_run(s.trim())),
                    COLOR_CODE_BG,
                );
                docx.add_paragraph(p)
            }
        }
        NodeValue::FootnoteDefinition(_)
        | NodeValue::DescriptionList
        | NodeValue::DescriptionItem(_)
        | NodeValue::DescriptionTerm
        | NodeValue::DescriptionDetails
        | NodeValue::Document => {
            for child in node.children() {
                docx = append_block(docx, child, list, bookmark_id);
            }
            docx
        }
        _ => docx,
    }
}

fn append_blockquote_block<'a>(
    mut docx: Docx,
    node: &'a AstNode<'a>,
    bookmark_id: &mut usize,
) -> Docx {
    let value = node.data.borrow().value.clone();
    match value {
        NodeValue::Paragraph => {
            let p = paragraph_from_inlines(
                node,
                InlineOpts {
                    force_bold: false,
                    quote_color: true,
                },
            )
            .style("mdQuote");
            docx.add_paragraph(p)
        }
        NodeValue::List(_) | NodeValue::CodeBlock(_) | NodeValue::Heading(_) => {
            append_block(docx, node, None, bookmark_id)
        }
        _ => {
            for child in node.children() {
                docx = append_blockquote_block(docx, child, bookmark_id);
            }
            docx
        }
    }
}

fn append_list_item<'a>(
    mut docx: Docx,
    item: &'a AstNode<'a>,
    ctx: ListCtx,
    bookmark_id: &mut usize,
) -> Docx {
    let task_prefix = match &item.data.borrow().value {
        NodeValue::TaskItem(t) => {
            if t.symbol.is_some() {
                Some("☑ ")
            } else {
                Some("☐ ")
            }
        }
        _ => None,
    };

    let after = if ctx.tight {
        LIST_TIGHT_AFTER
    } else {
        LIST_LOOSE_AFTER
    };

    let mut first_para = true;
    for child in item.children() {
        let v = child.data.borrow().value.clone();
        match v {
            NodeValue::Paragraph => {
                let mut p = if first_para {
                    if let Some(mark) = task_prefix {
                        paragraph_with_prefix(child, mark)
                    } else {
                        paragraph_from_inlines(child, InlineOpts::default())
                    }
                } else {
                    paragraph_from_inlines(child, InlineOpts::default())
                };
                p = p.line_spacing(para_spacing(after));
                if first_para {
                    p = p.numbering(
                        NumberingId::new(ctx.numbering_id),
                        IndentLevel::new(ctx.indent.min(5)),
                    );
                    first_para = false;
                } else {
                    p = p.indent(Some((720 + ctx.indent * 360) as i32), None, None, None);
                }
                docx = docx.add_paragraph(p);
            }
            NodeValue::List(_) => {
                docx = append_block(docx, child, Some(ctx), bookmark_id);
                first_para = false;
            }
            _ => {
                docx = append_block(docx, child, None, bookmark_id);
                first_para = false;
            }
        }
    }
    if first_para {
        let text = task_prefix.unwrap_or("");
        docx = docx.add_paragraph(
            Paragraph::new()
                .add_run(Run::new().add_text(text).fonts(body_fonts()).size(BODY_SIZE))
                .line_spacing(para_spacing(after))
                .numbering(
                    NumberingId::new(ctx.numbering_id),
                    IndentLevel::new(ctx.indent.min(5)),
                ),
        );
    }
    docx
}

fn paragraph_with_prefix<'a>(node: &'a AstNode<'a>, mark: &str) -> Paragraph {
    let mut p = Paragraph::new().add_run(
        Run::new()
            .add_text(mark)
            .fonts(body_fonts())
            .size(BODY_SIZE),
    );
    let pieces = collect_inlines(node, &mut InlineStyle::default());
    for piece in pieces {
        p = match piece {
            InlinePiece::Run(r) => p.add_run(r),
            InlinePiece::Link { url, runs } => {
                let mut h = Hyperlink::new(&url, HyperlinkType::External);
                for r in runs {
                    h = h.add_run(r.color(COLOR_LINK).underline("single"));
                }
                p.add_hyperlink(h)
            }
        };
    }
    p
}

fn apply_cell_align(p: Paragraph, align: TableAlignment) -> Paragraph {
    match align {
        TableAlignment::Left => p.align(AlignmentType::Left),
        TableAlignment::Center => p.align(AlignmentType::Center),
        TableAlignment::Right => p.align(AlignmentType::Right),
        TableAlignment::None => p,
    }
}

/// 显示宽度权重：ASCII=1，中文等宽字符=2。
fn display_weight(s: &str) -> usize {
    let w: usize = s
        .chars()
        .map(|c| if c.is_ascii() { 1 } else { 2 })
        .sum();
    w.max(1)
}

/// 按列权重比例分配总宽，保证列宽之和为 `total`，且不低于下限。
fn allocate_col_widths(weights: &[usize], total: usize) -> Vec<usize> {
    let n = weights.len().max(1);
    if total == 0 {
        return vec![0; n];
    }
    let min_w = (total / (n * 5)).max(720);
    let capped: Vec<usize> = weights.iter().map(|w| (*w).max(1)).collect();
    let sum: usize = capped.iter().sum::<usize>().max(1);
    let mut widths: Vec<usize> = capped.iter().map(|w| (total * w / sum).max(min_w)).collect();
    let sum2: usize = widths.iter().sum();
    if sum2 == 0 {
        return (0..n).map(|i| if i + 1 == n { total } else { total / n }).collect();
    }
    // 归一化到 total（末列吃误差）
    let mut acc = 0usize;
    for i in 0..widths.len() {
        if i + 1 == widths.len() {
            widths[i] = total.saturating_sub(acc);
        } else {
            widths[i] = total * widths[i] / sum2;
            acc = acc.saturating_add(widths[i]);
        }
    }
    widths
}

fn md_table_borders() -> TableBorders {
    // MD/GFM 表格：无外框竖线，仅保留浅色水平分隔
    TableBorders::with_empty()
        .set(
            TableBorder::new(TableBorderPosition::Top)
                .border_type(BorderType::Nil)
                .size(0)
                .color("auto"),
        )
        .set(
            TableBorder::new(TableBorderPosition::Left)
                .border_type(BorderType::Nil)
                .size(0)
                .color("auto"),
        )
        .set(
            TableBorder::new(TableBorderPosition::Bottom)
                .border_type(BorderType::Nil)
                .size(0)
                .color("auto"),
        )
        .set(
            TableBorder::new(TableBorderPosition::Right)
                .border_type(BorderType::Nil)
                .size(0)
                .color("auto"),
        )
        .set(
            TableBorder::new(TableBorderPosition::InsideV)
                .border_type(BorderType::Nil)
                .size(0)
                .color("auto"),
        )
        .set(
            TableBorder::new(TableBorderPosition::InsideH)
                .border_type(BorderType::Single)
                .size(4)
                .color(COLOR_TABLE_RULE_LIGHT),
        )
}

fn md_cell_borders(is_header: bool) -> TableCellBorders {
    let (sz, color) = if is_header {
        (10usize, COLOR_TABLE_RULE)
    } else {
        (4usize, COLOR_TABLE_RULE_LIGHT)
    };
    TableCellBorders::with_empty()
        .set(
            TableCellBorder::new(TableCellBorderPosition::Top)
                .border_type(BorderType::Nil)
                .size(0)
                .color("auto"),
        )
        .set(
            TableCellBorder::new(TableCellBorderPosition::Left)
                .border_type(BorderType::Nil)
                .size(0)
                .color("auto"),
        )
        .set(
            TableCellBorder::new(TableCellBorderPosition::Right)
                .border_type(BorderType::Nil)
                .size(0)
                .color("auto"),
        )
        .set(
            TableCellBorder::new(TableCellBorderPosition::Bottom)
                .border_type(BorderType::Single)
                .size(sz)
                .color(color),
        )
}

fn code_run(text: &str) -> Run {
    Run::new()
        .add_text(text)
        .fonts(mono_fonts())
        .size(18)
}

#[derive(Clone, Copy, Default)]
struct InlineOpts {
    force_bold: bool,
    quote_color: bool,
}

#[derive(Clone, Default)]
struct InlineStyle {
    bold: bool,
    italic: bool,
    strike: bool,
    code: bool,
    quote_color: bool,
}

fn paragraph_from_inlines<'a>(node: &'a AstNode<'a>, opts: InlineOpts) -> Paragraph {
    let mut style = InlineStyle {
        bold: opts.force_bold,
        quote_color: opts.quote_color,
        ..InlineStyle::default()
    };
    let pieces = collect_inlines(node, &mut style);
    let mut p = Paragraph::new();
    for piece in pieces {
        p = match piece {
            InlinePiece::Run(r) => p.add_run(r),
            InlinePiece::Link { url, runs } => {
                let mut h = Hyperlink::new(&url, HyperlinkType::External);
                for r in runs {
                    h = h.add_run(r.color(COLOR_LINK).underline("single"));
                }
                p.add_hyperlink(h)
            }
        };
    }
    p
}

enum InlinePiece {
    Run(Run),
    Link { url: String, runs: Vec<Run> },
}

fn collect_inlines<'a>(node: &'a AstNode<'a>, style: &mut InlineStyle) -> Vec<InlinePiece> {
    let mut out = Vec::new();
    append_inlines(node, style, &mut out);
    out
}

fn append_inlines<'a>(node: &'a AstNode<'a>, style: &mut InlineStyle, out: &mut Vec<InlinePiece>) {
    for child in node.children() {
        let value = child.data.borrow().value.clone();
        match value {
            NodeValue::Text(t) => {
                out.push(InlinePiece::Run(styled_run(t.as_ref(), style)));
            }
            NodeValue::Code(c) => {
                let mut s = style.clone();
                s.code = true;
                out.push(InlinePiece::Run(styled_run(&c.literal, &s)));
            }
            NodeValue::SoftBreak => {
                out.push(InlinePiece::Run(Run::new().add_text(" ")));
            }
            NodeValue::LineBreak => {
                out.push(InlinePiece::Run(
                    Run::new().add_break(BreakType::TextWrapping),
                ));
            }
            NodeValue::Emph => {
                let prev = style.italic;
                style.italic = true;
                append_inlines(child, style, out);
                style.italic = prev;
            }
            NodeValue::Strong => {
                let prev = style.bold;
                style.bold = true;
                append_inlines(child, style, out);
                style.bold = prev;
            }
            NodeValue::Strikethrough => {
                let prev = style.strike;
                style.strike = true;
                append_inlines(child, style, out);
                style.strike = prev;
            }
            NodeValue::Underline => {
                let mut runs = Vec::new();
                collect_plain_runs(child, style, &mut runs);
                for r in runs {
                    out.push(InlinePiece::Run(r.underline("single")));
                }
            }
            NodeValue::Link(link) => {
                let mut runs = Vec::new();
                collect_plain_runs(child, style, &mut runs);
                if runs.is_empty() {
                    runs.push(styled_run(&link.url, style));
                }
                out.push(InlinePiece::Link {
                    url: link.url.clone(),
                    runs,
                });
            }
            NodeValue::Image(link) => {
                let ctx = current_asset_ctx();
                if let Some(bytes) = read_local_image_bytes(&link.url, &ctx) {
                    if let Some(pic) = pic_from_bytes(&bytes) {
                        out.push(InlinePiece::Run(Run::new().add_image(pic)));
                        continue;
                    }
                }
                let alt = inline_plain_text(child);
                let label = if alt.is_empty() {
                    format!("[图片: {}]", link.url)
                } else {
                    format!("[图片: {alt}]")
                };
                out.push(InlinePiece::Run(styled_run(&label, style).italic()));
            }
            NodeValue::HtmlInline(s) => {
                let safe = sanitize_html_fragment(&s);
                if let Some((href, text)) = parse_simple_anchor(&safe) {
                    out.push(InlinePiece::Link {
                        url: href,
                        runs: vec![styled_run(&text, style)],
                    });
                    continue;
                }
                let ctx = current_asset_ctx();
                let mut embedded = false;
                for src in extract_local_img_srcs(&safe) {
                    if let Some(bytes) = read_local_image_bytes(&src, &ctx) {
                        if let Some(pic) = pic_from_bytes(&bytes) {
                            out.push(InlinePiece::Run(Run::new().add_image(pic)));
                            embedded = true;
                        }
                    }
                }
                if embedded {
                    continue;
                }
                let t = strip_rough_html(&safe);
                if !t.is_empty() {
                    out.push(InlinePiece::Run(styled_run(&t, style)));
                }
            }
            NodeValue::FootnoteReference(r) => {
                out.push(InlinePiece::Run(styled_run(
                    &format!("[{}]", r.name),
                    style,
                )));
            }
            NodeValue::Math(m) => {
                out.push(InlinePiece::Run(styled_run(&m.literal, style).italic()));
            }
            NodeValue::WikiLink(w) => {
                let text = inline_plain_text(child);
                let label = if text.is_empty() {
                    w.url.clone()
                } else {
                    text
                };
                out.push(InlinePiece::Run(styled_run(&label, style)));
            }
            NodeValue::Raw(s) => {
                out.push(InlinePiece::Run(styled_run(&s, style)));
            }
            NodeValue::Escaped
            | NodeValue::EscapedTag(_)
            | NodeValue::Superscript
            | NodeValue::Subscript
            | NodeValue::Highlight
            | NodeValue::SpoileredText => {
                append_inlines(child, style, out);
            }
            _ => {
                append_inlines(child, style, out);
            }
        }
    }
}

fn collect_plain_runs<'a>(node: &'a AstNode<'a>, style: &InlineStyle, out: &mut Vec<Run>) {
    for piece in collect_inlines(node, &mut style.clone()) {
        match piece {
            InlinePiece::Run(r) => out.push(r),
            InlinePiece::Link { runs, .. } => out.extend(runs),
        }
    }
}

/// Word 书签名：字母数字开头，避免非法字符。
fn docx_heading_bookmark_name(id: usize, title: &str) -> String {
    let mut slug: String = title
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_')
        .take(48)
        .collect();
    if slug.is_empty() {
        slug = "h".into();
    }
    if slug.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        slug.insert(0, '_');
    }
    format!("_Toc{id}_{slug}")
}

fn inline_plain_text<'a>(node: &'a AstNode<'a>) -> String {
    let mut s = String::new();
    for child in node.descendants() {
        match &child.data.borrow().value {
            NodeValue::Text(t) => s.push_str(t),
            NodeValue::Code(c) => s.push_str(&c.literal),
            _ => {}
        }
    }
    s
}

fn styled_run(text: &str, style: &InlineStyle) -> Run {
    let mut r = Run::new()
        .add_text(text)
        .fonts(body_fonts())
        .size(BODY_SIZE)
        .color(COLOR_FG);
    if style.bold {
        r = r.bold();
    }
    if style.italic {
        r = r.italic();
    }
    if style.strike {
        r = r.strike();
    }
    if style.quote_color {
        r = r.color(COLOR_QUOTE);
    }
    if style.code {
        // shading + highlight：highlight 在 Word→PDF 时更稳可见
        r = r
            .fonts(mono_fonts())
            .size(18)
            .color(COLOR_INLINE_CODE_FG)
            .shading(shade_fill(COLOR_INLINE_CODE_BG))
            .highlight("lightGray");
    }
    r
}

fn pic_from_bytes(bytes: &[u8]) -> Option<Pic> {
    // Pic::new 在坏图时可能 panic；失败则放弃嵌入
    std::panic::catch_unwind(AssertUnwindSafe(|| {
        let pic = Pic::new(bytes);
        // 限制导出宽度约 480px，避免撑破页宽
        let (w, h) = pic.size;
        let max_w = 480u32 * 9525;
        if w > max_w && w > 0 {
            let ratio = max_w as f64 / w as f64;
            let nh = ((h as f64) * ratio) as u32;
            pic.size(max_w, nh.max(1))
        } else {
            pic
        }
    }))
    .ok()
}

fn strip_rough_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read};

    fn document_xml(bytes: Vec<u8>) -> String {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        let mut file = archive
            .by_name("word/document.xml")
            .expect("document.xml");
        let mut xml = String::new();
        file.read_to_string(&mut xml).unwrap();
        xml
    }

    fn styles_xml(bytes: Vec<u8>) -> String {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        let mut file = archive.by_name("word/styles.xml").expect("styles.xml");
        let mut xml = String::new();
        file.read_to_string(&mut xml).unwrap();
        xml
    }

    fn numbering_xml(bytes: Vec<u8>) -> String {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        let mut file = archive
            .by_name("word/numbering.xml")
            .expect("numbering.xml");
        let mut xml = String::new();
        file.read_to_string(&mut xml).unwrap();
        xml
    }

    #[test]
    fn bullet_list_uses_non_default_numid_and_bullet_fmt() {
        let md = r#"- 段落 → 表格，或 `/` → 表格
- `Ctrl+S` 保存 · `Ctrl+W` 关闭
"#;
        let bytes = markdown_to_docx_bytes(md).expect("docx");
        let doc = document_xml(bytes.clone());
        let numbering = numbering_xml(bytes);

        // 段落必须引用避开 docx-rs 默认 id=1 的 bullet numId
        assert!(
            doc.contains(r#"w:val="10""#) || doc.contains("w:numId w:val=\"10\""),
            "unordered list should use numId=10, document snippet missing it"
        );
        assert!(
            !doc.contains(r#"w:numId w:val="1""#) && !doc.contains("numId w:val=\"1\""),
            "unordered list must not use reserved numId=1"
        );

        // abstractNum 10 应为 bullet
        assert!(
            numbering.contains("abstractNumId=\"10\"") || numbering.contains(r#"w:abstractNumId w:val="10""#),
            "missing abstractNumId 10"
        );
        assert!(
            numbering.contains(r#"w:val="bullet""#) || numbering.contains("numFmt w:val=\"bullet\""),
            "abstract numbering for bullets should use numFmt=bullet"
        );

        // numId 10 → abstractNumId 10（`<w:num w:numId="10">`）
        assert!(
            numbering.contains(r#"w:numId="10""#) || numbering.contains("numId=\"10\""),
            "missing numId 10 mapping in numbering.xml"
        );
    }

    #[test]
    fn ordered_list_uses_numid_11_decimal() {
        let md = "1. 甲\n2. 乙\n";
        let bytes = markdown_to_docx_bytes(md).expect("docx");
        let doc = document_xml(bytes.clone());
        let numbering = numbering_xml(bytes);
        assert!(
            doc.contains(r#"w:val="11""#) || doc.contains("w:numId w:val=\"11\""),
            "ordered list should use numId=11"
        );
        assert!(
            numbering.contains("abstractNumId=\"11\"") || numbering.contains(r#"w:abstractNumId w:val="11""#),
            "missing abstractNumId 11"
        );
    }

    #[test]
    fn allocate_col_widths_favors_heavier_column() {
        let widths = allocate_col_widths(&[2, 20], TABLE_WIDTH_DXA);
        assert_eq!(widths.len(), 2);
        assert_eq!(widths.iter().sum::<usize>(), TABLE_WIDTH_DXA);
        assert!(
            widths[1] > widths[0],
            "heavier column should be wider: {:?}",
            widths
        );
    }

    #[test]
    fn table_column_widths_follow_content() {
        let md = r#"| 版本 | 变更说明很长很长很长很长很长很长很长 |
|------|--------------------------------------|
| 0.1  | 初始版本与大量说明文字用于拉宽第二列 |
"#;
        let bytes = markdown_to_docx_bytes(md).expect("docx");
        let xml = document_xml(bytes);
        assert!(
            xml.contains(r#"w:type="dxa""#) || xml.contains("w:type=\"dxa\""),
            "expected dxa column widths"
        );
        assert!(
            xml.contains("w:tblLayout") && xml.contains("fixed")
                || xml.contains(r#"w:type="fixed""#),
            "expected fixed table layout"
        );

        // 解析 gridCol / tcW 的 w:w 数值，第二列应更大
        fn parse_widths(xml: &str, tag_hint: &str) -> Vec<usize> {
            let mut out = Vec::new();
            let mut rest = xml;
            while let Some(idx) = rest.find(tag_hint) {
                let slice = &rest[idx..];
                // 找随后的 w:w="NNN"
                if let Some(wpos) = slice.find(r#"w:w=""#) {
                    let after = &slice[wpos + 5..];
                    if let Some(end) = after.find('"') {
                        if let Ok(n) = after[..end].parse::<usize>() {
                            out.push(n);
                        }
                    }
                }
                rest = &rest[idx + tag_hint.len()..];
            }
            out
        }

        let grid = parse_widths(&xml, "w:gridCol");
        assert!(
            grid.len() >= 2,
            "expected >=2 gridCol widths, got {:?}",
            grid
        );
        assert!(
            grid[1] > grid[0],
            "second column grid should be wider: {:?}",
            grid
        );

        let tcw = parse_widths(&xml, "w:tcW");
        assert!(tcw.len() >= 2, "expected tcW widths, got {:?}", tcw);
        // 第一行两个单元格：第二列更宽
        assert!(
            tcw[1] > tcw[0],
            "second cell tcW should be wider: {:?}",
            tcw
        );
    }

    #[test]
    fn exports_basic_gfm_docx() {
        let md = r#"# 标题

段落 **粗体** *斜体* ~~删除~~ `code`。

- 列表一
- 列表二

1. 有序

| A | B |
|---|---|
| 1 | 2 |

> 引用

```rust
fn main() {}
```

---
"#;
        let bytes = markdown_to_docx_bytes(md).expect("docx");
        assert!(bytes.len() > 1000, "docx too small: {}", bytes.len());
        assert_eq!(&bytes[0..2], b"PK");

        let xml = document_xml(bytes.clone());
        assert!(
            xml.contains("w:tblBorders") || xml.contains("tblBorders"),
            "missing table borders"
        );
        assert!(
            xml.contains("nil") || xml.contains(r#"w:val="nil""#),
            "MD-style table should clear vertical borders (nil)"
        );
        assert!(xml.contains("Heading1") || xml.contains("标题"), "missing heading");
        assert!(
            xml.contains("w:outlineLvl") || xml.contains("outlineLvl"),
            "heading missing outlineLvl for navigation bookmarks"
        );
        assert!(
            xml.contains("w:bookmarkStart") || xml.contains("bookmarkStart"),
            "heading missing bookmark"
        );
        assert!(xml.contains("w:pBdr"), "missing paragraph borders (quote/hr)");
        assert!(
            xml.contains("F6F8FA") || xml.contains("f6f8fa"),
            "missing code/header shading"
        );
        assert!(
            xml.contains("lightGray") || xml.contains("EFEFEF") || xml.contains("efefef"),
            "missing inline code highlight/shading"
        );

        let styles = styles_xml(bytes);
        assert!(styles.contains("Heading1"), "styles missing Heading1");
        assert!(
            styles.contains("w:sz") || styles.contains("sz"),
            "styles missing font size"
        );
        assert!(
            styles.contains("微软雅黑") || styles.contains("Segoe UI"),
            "styles missing body fonts"
        );
    }

    #[test]
    fn hard_break_emits_br() {
        // CommonMark hard break: two spaces + newline
        let md = "line1  \nline2\n";
        let bytes = markdown_to_docx_bytes(md).expect("docx");
        let xml = document_xml(bytes);
        assert!(
            xml.contains("<w:br") || xml.contains("w:br "),
            "hard break should emit w:br, got snippet without br"
        );
    }

    #[test]
    fn github_html_keeps_flex_gallery_div() {
        let md = r#"## Hardware

<div style="display: flex; justify-content: space-between;">
  <a href="docs/v1/a.jpg" target="_blank">
    <img src="docs/v1/a.jpg" width="240" />
  </a>
  <a href="docs/v1/b.jpg" target="_blank">
    <img src="docs/v1/b.jpg" width="240" />
  </a>
</div>
"#;
        let html = markdown_to_github_html(md).unwrap();
        assert!(
            html.contains("display") && html.contains("flex"),
            "flex style lost: {}",
            &html[html.find("Hardware").unwrap_or(0)..]
                .chars()
                .take(500)
                .collect::<String>()
        );
        assert!(
            html.contains("justify-content") || html.contains("space-between"),
            "justify-content lost"
        );
        assert!(html.contains("<div"), "div tag lost");
        assert!(
            html.contains("lumen-html-flex"),
            "flex class missing: {}",
            &html[html.find("Hardware").unwrap_or(0)..]
                .chars()
                .take(400)
                .collect::<String>()
        );
        assert!(html.contains("docs/v1/a.jpg") || html.contains("data:image"), "img lost");
    }

    #[test]
    fn github_html_has_markdown_body_and_tokens() {
        let html = markdown_to_github_html(
            "# Title\n\n| 版本 | 变更 |\n|------|------|\n| 0.1  | 初始 |\n\n`code`\n",
        )
        .unwrap();
        assert!(html.contains("markdown-body"), "missing markdown-body");
        assert!(html.contains("#24292F") || html.contains("#24292f") || html.contains("24292F"));
        assert!(html.contains("#0969DA") || html.contains("#0969da") || html.contains("0969DA"));
        assert!(html.contains("#F6F8FA") || html.contains("#f6f8fa") || html.contains("F6F8FA"));
        assert!(html.contains("#D0D7DE") || html.contains("#d0d7de") || html.contains("D0D7DE"));
        assert!(html.contains("<table"));
        assert!(html.contains("<h1>"));
    }

    #[test]
    fn github_html_merges_inline_anchor_and_keeps_target() {
        let md = r#"- <a href="https://example.com" target="_blank" title="x">LiChuang</a>
"#;
        let html = markdown_to_github_html(md).unwrap();
        assert!(
            html.contains("LiChuang") && html.contains("https://example.com"),
            "{html}"
        );
        assert!(
            html.contains("<a ") && html.contains("LiChuang</a>"),
            "anchor text should be inside <a>: {}",
            html
        );
        assert!(html.contains("target="), "target should be kept: {html}");
    }

    #[test]
    fn github_html_embeds_relative_img_with_doc_abs() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!(
            "lumen-md-html-embed-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        let png: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00,
            0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08,
            0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xFE,
            0xD4, 0xEF, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        let mut f = std::fs::File::create(dir.join("docs/a.png")).unwrap();
        f.write_all(png).unwrap();
        let md_path = dir.join("README.md");
        std::fs::write(&md_path, "").unwrap();
        let ctx = ExportAssetCtx {
            doc_abs: Some(md_path),
            workspace_root: Some(dir.clone()),
        };
        let html = markdown_to_github_html_with_ctx(
            "<img src=\"docs/a.png\" alt=\"x\" width=\"10\">\n",
            &ctx,
        )
        .unwrap();
        assert!(html.contains("data:image/png;base64,"), "{html}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn github_html_preserves_sanitized_html_table_rowspan() {
        let md = r#"before

<table border="1">
  <tr>
    <td rowspan="2">文件状态</td>
    <td>版本</td>
  </tr>
  <tr>
    <td>1.0</td>
  </tr>
</table>

after
"#;
        let html = markdown_to_github_html(md).unwrap();
        assert!(
            html.contains("<table"),
            "raw HTML table should pass through after sanitize, got: {}",
            &html[html.find("before").unwrap_or(0)..(html.find("before").unwrap_or(0) + 400).min(html.len())]
        );
        assert!(html.contains("rowspan"), "rowspan should be kept");
        assert!(!html.contains("<!-- raw HTML omitted -->"));
        assert!(!html.to_ascii_lowercase().contains("<script>alert"));
        assert!(!html.to_ascii_lowercase().contains("文件状态<script"));
    }

    #[test]
    fn docx_html_table_emits_vmerge() {
        let md = r#"
<table>
  <tr><td rowspan="2">A</td><td>B</td></tr>
  <tr><td>C</td></tr>
</table>
"#;
        let bytes = markdown_to_docx_bytes(md).expect("docx");
        let cursor = std::io::Cursor::new(bytes);
        let mut zip = zip::ZipArchive::new(cursor).expect("zip");
        let mut file = zip.by_name("word/document.xml").expect("document.xml");
        let mut xml = String::new();
        std::io::Read::read_to_string(&mut file, &mut xml).unwrap();
        assert!(
            xml.contains("w:vMerge") || xml.contains("vMerge"),
            "expected vertical merge in OOXML, snippet missing vMerge"
        );
        assert!(xml.contains('A') && xml.contains('B') && xml.contains('C'));
    }

    #[test]
    fn probe_html_table_escape() {
        let md = "before\n\n<table style=\"writing-mode: vertical-rl\"><tr><th>jia</th><td>1</td></tr></table>\n\nafter\n";
        let html = markdown_to_github_html(md).unwrap();
        assert!(html.contains("<table"), "table should not be omitted");
    }

    #[test]
    fn standalone_html_has_table_css() {
        let html = markdown_to_standalone_html("|a|b|\n|-|-|\n|1|2|\n").unwrap();
        assert!(html.contains("<table"));
        assert!(html.contains("markdown-body"));
        assert!(
            html.contains("width: 100%") && html.contains("table-layout: fixed"),
            "PDF table CSS should be full-width like the editor"
        );
        assert!(
            !html.contains("max-content"),
            "PDF table CSS must not use width: max-content"
        );
        assert!(
            html.contains("border: 1px solid var(--border)"),
            "cell borders should use shared --border color on all sides"
        );
    }
}

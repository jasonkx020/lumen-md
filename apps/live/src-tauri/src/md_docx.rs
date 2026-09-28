//! Markdown (GFM) → DOCX / GitHub 风 HTML。
//! 色板与版式对齐 GitHub Primer / GFM 预览；DOCX 为可编辑近似，PDF 优先 HTML 打印。

use std::io::Cursor;

use comrak::nodes::{AstNode, ListType, NodeValue, TableAlignment};
use comrak::{format_html, parse_document, Arena, Options};
use docx_rs::*;

use crate::html_sanitize::{is_html_table, sanitize_html_fragment};
use crate::html_table_docx::try_html_to_docx_table;

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
pub fn markdown_to_docx_bytes(markdown: &str) -> anyhow::Result<Vec<u8>> {
    if markdown.len() as u64 > MAX_EXPORT_BYTES {
        anyhow::bail!("导出内容超过上限 {} bytes", MAX_EXPORT_BYTES);
    }

    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &gfm_options());

    let mut docx = apply_document_chrome(Docx::new())
        .add_abstract_numbering(bullet_abstract(BULLET_NUM_ID))
        .add_abstract_numbering(ordered_abstract(ORDERED_NUM_ID))
        .add_numbering(Numbering::new(BULLET_NUM_ID, BULLET_NUM_ID))
        .add_numbering(Numbering::new(ORDERED_NUM_ID, ORDERED_NUM_ID));

    for child in root.children() {
        docx = append_block(docx, child, None);
    }

    let mut buf = Cursor::new(Vec::new());
    docx.build()
        .pack(&mut buf)
        .map_err(|e| anyhow::anyhow!("DOCX 打包失败: {e}"))?;
    Ok(buf.into_inner())
}

/// GitHub 风独立 HTML（PDF 首选打印源）。
pub fn markdown_to_github_html(markdown: &str) -> anyhow::Result<String> {
    if markdown.len() as u64 > MAX_EXPORT_BYTES {
        anyhow::bail!("导出内容超过上限 {} bytes", MAX_EXPORT_BYTES);
    }
    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &gfm_options());
    sanitize_html_nodes(root);
    let mut body = String::new();
    format_html(root, &gfm_options_allow_sanitized_html(), &mut body)
        .map_err(|e| anyhow::anyhow!("HTML 渲染失败: {e}"))?;
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
.markdown-body img {{ max-width: 100%; }}
@media print {{
  .markdown-body {{ padding: 0; max-width: none; }}
  @page {{ margin: 1.5cm; }}
  a {{ color: var(--accent); }}
}}
</style>
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
        let mut style = Style::new(&id, StyleType::Paragraph)
            .name(name)
            .based_on("Normal")
            .bold()
            .size(size)
            .color(COLOR_FG)
            .fonts(body_fonts())
            .line_spacing(heading_spacing(before, after));
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

fn append_block<'a>(mut docx: Docx, node: &'a AstNode<'a>, list: Option<ListCtx>) -> Docx {
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
            let p = paragraph_from_inlines(node, InlineOpts::default()).style(style_id);
            docx.add_paragraph(p)
        }
        NodeValue::BlockQuote | NodeValue::MultilineBlockQuote(_) | NodeValue::Alert(_) => {
            for child in node.children() {
                docx = append_blockquote_block(docx, child);
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
            let text = strip_rough_html(&sanitize_html_fragment(&hb.literal));
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
                docx = append_block(docx, child, list);
            }
            docx
        }
        _ => docx,
    }
}

fn append_blockquote_block<'a>(mut docx: Docx, node: &'a AstNode<'a>) -> Docx {
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
            append_block(docx, node, None)
        }
        _ => {
            for child in node.children() {
                docx = append_blockquote_block(docx, child);
            }
            docx
        }
    }
}

fn append_list_item<'a>(mut docx: Docx, item: &'a AstNode<'a>, ctx: ListCtx) -> Docx {
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
                docx = append_block(docx, child, Some(ctx));
                first_para = false;
            }
            _ => {
                docx = append_block(docx, child, None);
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
                let alt = inline_plain_text(child);
                let label = if alt.is_empty() {
                    format!("[图片: {}]", link.url)
                } else {
                    format!("[图片: {alt}]")
                };
                out.push(InlinePiece::Run(styled_run(&label, style).italic()));
            }
            NodeValue::HtmlInline(s) => {
                let t = strip_rough_html(&sanitize_html_fragment(&s));
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
        assert!(!html.to_ascii_lowercase().contains("<script"));
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

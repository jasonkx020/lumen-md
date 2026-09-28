//! RenderModel → Markdown 序列化。

use lumen_core::Dialect;

use crate::model::{InlineSpan, RenderBlock, RenderKind, RenderModel};

impl RenderModel {
    pub fn to_markdown(&self) -> String {
        let mut out = String::new();
        let mut i = 0;
        while i < self.blocks.len() {
            let b = &self.blocks[i];
            match &b.kind {
                RenderKind::ListItem { .. } => {
                    // group consecutive list items at same depth
                    let depth = b.depth;
                    while i < self.blocks.len() {
                        let cur = &self.blocks[i];
                        match &cur.kind {
                            RenderKind::ListItem {
                                ordered: o,
                                start: s,
                                index: idx,
                                checked,
                            } if cur.depth == depth => {
                                let pad = "  ".repeat(depth.saturating_sub(1) as usize);
                                let bullet = if let Some(is_checked) = checked {
                                    if *is_checked {
                                        "- [x]".into()
                                    } else {
                                        "- [ ]".into()
                                    }
                                } else if *o {
                                    format!("{}.", s + idx)
                                } else {
                                    "-".into()
                                };
                                out.push_str(&pad);
                                out.push_str(&bullet);
                                out.push(' ');
                                out.push_str(&inlines_to_md(&cur.inlines));
                                out.push('\n');
                                i += 1;
                            }
                            _ => break,
                        }
                    }
                    out.push('\n');
                    continue;
                }
                _ => {
                    out.push_str(&block_to_md(b));
                    if !out.ends_with("\n\n") {
                        if out.ends_with('\n') {
                            out.push('\n');
                        } else {
                            out.push_str("\n\n");
                        }
                    }
                    i += 1;
                }
            }
        }
        while out.ends_with("\n\n\n") {
            out.pop();
        }
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out
    }
}

fn block_to_md(b: &RenderBlock) -> String {
    let quote_prefix = if b.depth > 0
        && !matches!(
            b.kind,
            RenderKind::ListItem { .. } | RenderKind::CodeBlock { .. } | RenderKind::Table { .. }
        ) {
        "> ".repeat(b.depth.min(3) as usize)
    } else {
        String::new()
    };

    match &b.kind {
        RenderKind::Heading { level } => {
            format!(
                "{}{} {}",
                quote_prefix,
                "#".repeat((*level).max(1).min(6) as usize),
                inlines_to_md(&b.inlines)
            )
        }
        RenderKind::Paragraph | RenderKind::BlockQuote => {
            format!("{}{}", quote_prefix, inlines_to_md(&b.inlines))
        }
        RenderKind::ListItem {
            ordered,
            start,
            index,
            checked,
        } => {
            let bullet = if let Some(is_checked) = checked {
                if *is_checked {
                    "- [x]".into()
                } else {
                    "- [ ]".into()
                }
            } else if *ordered {
                format!("{}.", start + index)
            } else {
                "-".into()
            };
            format!("{}{} {}", quote_prefix, bullet, inlines_to_md(&b.inlines))
        }
        RenderKind::CodeBlock { info, literal } => {
            let mut s = String::from("```");
            s.push_str(info);
            s.push('\n');
            s.push_str(literal);
            if !literal.ends_with('\n') {
                s.push('\n');
            }
            s.push_str("```");
            s
        }
        RenderKind::ThematicBreak => "---".into(),
        RenderKind::HtmlBlock { literal } => literal.clone(),
        RenderKind::Table { headers, rows } => table_to_md(headers, rows),
        RenderKind::ExtensionStub { name } => format!("<!-- extension:{name} -->"),
    }
}

fn table_to_md(headers: &[Vec<InlineSpan>], rows: &[Vec<Vec<InlineSpan>>]) -> String {
    let cols = headers
        .len()
        .max(rows.iter().map(|r| r.len()).max().unwrap_or(0))
        .max(1);
    let mut out = String::new();
    out.push('|');
    for i in 0..cols {
        let cell = headers.get(i).map(|c| inlines_to_md(c)).unwrap_or_default();
        out.push(' ');
        out.push_str(&cell);
        out.push_str(" |");
    }
    out.push('\n');
    out.push('|');
    for _ in 0..cols {
        out.push_str(" --- |");
    }
    out.push('\n');
    for row in rows {
        out.push('|');
        for i in 0..cols {
            let cell = row.get(i).map(|c| inlines_to_md(c)).unwrap_or_default();
            out.push(' ');
            out.push_str(&cell);
            out.push_str(" |");
        }
        out.push('\n');
    }
    out
}

pub fn inlines_to_md(spans: &[InlineSpan]) -> String {
    let mut out = String::new();
    for sp in spans {
        if sp.hard_break {
            out.push_str("  \n");
            continue;
        }
        if let Some(src) = &sp.image_src {
            out.push_str(&format!("![{}]({})", sp.text, src));
            continue;
        }
        let mut t = sp.text.clone();
        if sp.code {
            t = format!("`{t}`");
        }
        if sp.strong {
            t = format!("**{t}**");
        }
        if sp.emphasis {
            t = format!("*{t}*");
        }
        if sp.strikethrough {
            t = format!("~~{t}~~");
        }
        if let Some(url) = &sp.link_url {
            t = format!("[{t}]({url})");
        }
        out.push_str(&t);
    }
    out
}

pub fn plain_text(spans: &[InlineSpan]) -> String {
    spans
        .iter()
        .filter(|s| !s.soft_break || !s.text.is_empty())
        .map(|s| {
            if s.hard_break {
                "\n"
            } else {
                s.text.as_str()
            }
        })
        .collect()
}

pub fn plain_to_inlines(text: &str) -> Vec<InlineSpan> {
    vec![InlineSpan::plain(text.to_string())]
}

/// 将 markdown 行内片段解析为 spans（用于编辑提交，保留 strong/em/code/link/strike）。
pub fn parse_inlines_md(text: &str, dialect: Dialect) -> Vec<InlineSpan> {
    if text.is_empty() {
        return Vec::new();
    }
    let model = RenderModel::build(text, dialect);
    let mut out = Vec::new();
    for (i, b) in model.blocks.iter().enumerate() {
        if i > 0 && !out.is_empty() {
            let mut br = InlineSpan::plain(" ");
            br.soft_break = true;
            out.push(br);
        }
        match &b.kind {
            RenderKind::CodeBlock { literal, .. } => {
                let mut sp = InlineSpan::plain(literal.clone());
                sp.code = true;
                out.push(sp);
            }
            RenderKind::Table { headers, rows } => {
                for cell in headers {
                    out.extend(cell.clone());
                }
                for row in rows {
                    for cell in row {
                        out.extend(cell.clone());
                    }
                }
            }
            _ => {
                out.extend(b.inlines.clone());
            }
        }
    }
    if out.is_empty() {
        plain_to_inlines(text)
    } else {
        out
    }
}

/// 对整块纯文本应用行内格式（简化：整块包裹）。
pub fn apply_inline_format(spans: &mut Vec<InlineSpan>, kind: InlineFormat) {
    let text = plain_text(spans);
    if text.is_empty() {
        return;
    }
    match kind {
        InlineFormat::Strong => {
            *spans = plain_to_inlines(&text);
            spans[0].strong = true;
        }
        InlineFormat::Emphasis => {
            *spans = plain_to_inlines(&text);
            spans[0].emphasis = true;
        }
        InlineFormat::Code => {
            *spans = plain_to_inlines(&text);
            spans[0].code = true;
        }
        InlineFormat::Strike => {
            *spans = plain_to_inlines(&text);
            spans[0].strikethrough = true;
        }
        InlineFormat::Link(url) => {
            *spans = plain_to_inlines(&text);
            spans[0].link_url = Some(url);
        }
        InlineFormat::Clear => {
            *spans = plain_to_inlines(&text);
        }
    }
}

#[derive(Debug, Clone)]
pub enum InlineFormat {
    Strong,
    Emphasis,
    Code,
    Strike,
    Link(String),
    Clear,
}

pub fn set_block_kind(block: &mut RenderBlock, kind: RenderKind) {
    // preserve text content when changing structure
    match &kind {
        RenderKind::CodeBlock { .. } => {
            let lit = if block.inlines.is_empty() {
                if let RenderKind::CodeBlock { literal, .. } = &block.kind {
                    literal.clone()
                } else {
                    plain_text(&block.inlines)
                }
            } else {
                plain_text(&block.inlines)
            };
            let info = if let RenderKind::CodeBlock { info, .. } = &kind {
                info.clone()
            } else {
                String::new()
            };
            block.kind = RenderKind::CodeBlock {
                info,
                literal: lit,
            };
            block.inlines.clear();
        }
        RenderKind::ThematicBreak => {
            block.kind = RenderKind::ThematicBreak;
            block.inlines.clear();
        }
        RenderKind::Table { .. } => {
            let text = plain_text(&block.inlines);
            if let RenderKind::Table { headers, rows } = kind.clone() {
                block.kind = RenderKind::Table { headers, rows };
            } else {
                block.kind = RenderKind::Table {
                    headers: vec![vec![InlineSpan::plain(text)]],
                    rows: vec![],
                };
            }
            block.inlines.clear();
        }
        other => {
            if let RenderKind::CodeBlock { literal, .. } = &block.kind {
                if block.inlines.is_empty() {
                    block.inlines = plain_to_inlines(literal);
                }
            }
            if let RenderKind::Table { headers, rows } = &block.kind {
                if block.inlines.is_empty() {
                    let mut t = String::new();
                    for cell in headers {
                        t.push_str(&plain_text(cell));
                        t.push(' ');
                    }
                    for row in rows {
                        for cell in row {
                            t.push_str(&plain_text(cell));
                            t.push(' ');
                        }
                    }
                    block.inlines = plain_to_inlines(t.trim());
                }
            }
            block.kind = other.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::RenderModel;
    use lumen_core::Dialect;
    use std::path::PathBuf;

    fn fixture_gfm() -> String {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/gfm/roundtrip.md");
        std::fs::read_to_string(&path).unwrap_or_else(|_| {
            // fallback inline if fixture missing during early build
            r#"# GFM Roundtrip

| Name | Value |
| --- | --- |
| a | 1 |
| b | 2 |

- [ ] todo
- [x] done

This has ~~strike~~ and a [link](https://example.com).

![logo](assets/logo.png)

```rust
fn main() {}
```
"#
            .into()
        })
    }

    #[test]
    fn gfm_roundtrip_preserves_structure() {
        let src = fixture_gfm();
        let model = RenderModel::build(&src, Dialect::Lumen);
        let md = model.to_markdown();
        let again = RenderModel::build(&md, Dialect::Lumen);

        assert!(
            model.blocks.iter().any(|b| matches!(b.kind, RenderKind::Table { .. })),
            "expected table in first parse"
        );
        assert!(
            again.blocks.iter().any(|b| matches!(b.kind, RenderKind::Table { .. })),
            "expected table after roundtrip"
        );

        let tasks: Vec<_> = again
            .blocks
            .iter()
            .filter_map(|b| match &b.kind {
                RenderKind::ListItem { checked, .. } => Some(*checked),
                _ => None,
            })
            .collect();
        assert!(
            tasks.iter().any(|c| *c == Some(false)),
            "expected unchecked task"
        );
        assert!(
            tasks.iter().any(|c| *c == Some(true)),
            "expected checked task"
        );

        let has_strike = again.blocks.iter().any(|b| {
            b.inlines.iter().any(|s| s.strikethrough)
        });
        assert!(has_strike, "expected strikethrough span");

        let has_link = again.blocks.iter().any(|b| {
            b.inlines.iter().any(|s| s.link_url.is_some())
        });
        assert!(has_link, "expected link");

        let has_image = again.blocks.iter().any(|b| {
            b.inlines.iter().any(|s| {
                s.image_src
                    .as_deref()
                    .map(|p| p.contains("logo.png") || p.contains("assets/"))
                    .unwrap_or(false)
            })
        });
        assert!(has_image, "expected relative image");

        let has_code = again
            .blocks
            .iter()
            .any(|b| matches!(&b.kind, RenderKind::CodeBlock { info, .. } if info.contains("rust")));
        assert!(has_code, "expected rust code fence");
    }

    #[test]
    fn parse_inlines_md_keeps_formats() {
        let spans = parse_inlines_md("**bold** and *em* and `code` and ~~del~~", Dialect::Lumen);
        assert!(spans.iter().any(|s| s.strong));
        assert!(spans.iter().any(|s| s.emphasis));
        assert!(spans.iter().any(|s| s.code));
        assert!(spans.iter().any(|s| s.strikethrough));
    }

    #[test]
    fn gfm_fixture_file_roundtrip() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/gfm/roundtrip.md");
        let src = std::fs::read_to_string(&path).expect("fixture");
        let m1 = RenderModel::build(&src, Dialect::Lumen);
        assert!(m1.blocks.iter().any(|b| matches!(b.kind, RenderKind::Table { .. })));
        assert!(m1.blocks.iter().any(|b| matches!(
            b.kind,
            RenderKind::ListItem { checked: Some(_), .. }
        )));
        let md = m1.to_markdown();
        let m2 = RenderModel::build(&md, Dialect::Lumen);
        assert!(m2.blocks.iter().any(|b| matches!(b.kind, RenderKind::Table { .. })));
        assert!(m2
            .blocks
            .iter()
            .flat_map(|b| b.inlines.iter())
            .any(|s| s.strikethrough));
        assert!(m2
            .blocks
            .iter()
            .any(|b| matches!(b.kind, RenderKind::CodeBlock { .. })));
    }
}

//! RenderModel → Markdown 序列化。

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
                            } if cur.depth == depth => {
                                let pad = "  ".repeat(depth.saturating_sub(1) as usize);
                                let bullet = if *o {
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
            RenderKind::ListItem { .. } | RenderKind::CodeBlock { .. }
        ) {
        // depth from blockquote — approximate with >
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
        RenderKind::ListItem { ordered, start, index } => {
            let bullet = if *ordered {
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
        RenderKind::ExtensionStub { name } => format!("<!-- extension:{name} -->"),
    }
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
    vec![InlineSpan {
        text: text.to_string(),
        strong: false,
        emphasis: false,
        code: false,
        link_url: None,
        image_src: None,
        soft_break: false,
        hard_break: false,
    }]
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
    Link(String),
    Clear,
}

pub fn set_block_kind(block: &mut RenderBlock, kind: RenderKind) {
    // preserve text content when changing structure
    match &kind {
        RenderKind::CodeBlock { .. } => {
            let lit = plain_text(&block.inlines);
            block.kind = RenderKind::CodeBlock {
                info: String::new(),
                literal: lit,
            };
            block.inlines.clear();
        }
        RenderKind::ThematicBreak => {
            block.kind = RenderKind::ThematicBreak;
            block.inlines.clear();
        }
        other => {
            if let RenderKind::CodeBlock { literal, .. } = &block.kind {
                if block.inlines.is_empty() {
                    block.inlines = plain_to_inlines(literal);
                }
            }
            block.kind = other.clone();
        }
    }
}

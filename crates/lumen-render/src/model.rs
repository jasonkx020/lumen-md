//! 渲染模型与 comrak AST 展平。

use comrak::nodes::{AstNode, ListType, NodeValue};
use comrak::Arena;
use lumen_core::{Dialect, MarkdownEngine};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct InlineSpan {
    pub text: String,
    pub strong: bool,
    pub emphasis: bool,
    pub code: bool,
    pub strikethrough: bool,
    pub link_url: Option<String>,
    pub image_src: Option<String>,
    pub soft_break: bool,
    pub hard_break: bool,
}

impl InlineSpan {
    pub fn plain(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            strong: false,
            emphasis: false,
            code: false,
            strikethrough: false,
            link_url: None,
            image_src: None,
            soft_break: false,
            hard_break: false,
        }
    }
}

#[derive(Debug, Clone)]
pub enum RenderKind {
    Paragraph,
    Heading { level: u8 },
    BlockQuote,
    ListItem {
        ordered: bool,
        start: u32,
        index: u32,
        checked: Option<bool>,
    },
    CodeBlock { info: String, literal: String },
    ThematicBreak,
    HtmlBlock { literal: String },
    /// GFM 表格：headers 为一行单元格；rows 为数据行。
    Table {
        headers: Vec<Vec<InlineSpan>>,
        rows: Vec<Vec<Vec<InlineSpan>>>,
    },
    /// 扩展挂载点（M2+）
    ExtensionStub { name: String },
}

#[derive(Debug, Clone)]
pub struct RenderBlock {
    pub kind: RenderKind,
    pub inlines: Vec<InlineSpan>,
    pub depth: u16,
    /// 预估高度（px），虚拟化用
    pub est_height: f32,
    pub source_line: usize,
}

#[derive(Debug, Clone)]
pub struct HeadingOutline {
    pub level: u8,
    pub title: String,
    pub block_index: usize,
}

#[derive(Debug, Clone)]
pub struct RenderModel {
    pub fingerprint: String,
    pub dialect: Dialect,
    pub blocks: Vec<RenderBlock>,
    pub outline: Vec<HeadingOutline>,
    pub total_height: f32,
}

impl RenderModel {
    pub fn build(source: &str, dialect: Dialect) -> Self {
        let engine = MarkdownEngine::new(dialect);
        let fp = MarkdownEngine::fingerprint(source, dialect);
        let arena = Arena::new();
        let root = engine.parse(&arena, source);
        let mut blocks = Vec::new();
        let mut outline = Vec::new();
        flatten(root, 0, &mut blocks, &mut outline, false, false, 1, 0);
        let total_height: f32 = blocks.iter().map(|b| b.est_height).sum();
        Self {
            fingerprint: fp,
            dialect,
            blocks,
            outline,
            total_height,
        }
    }

    pub fn matches(&self, source: &str, dialect: Dialect) -> bool {
        self.fingerprint == MarkdownEngine::fingerprint(source, dialect)
    }

    pub fn recompute_total_height(&mut self) {
        self.total_height = self.blocks.iter().map(|b| b.est_height).sum();
    }
}

fn flatten<'a>(
    node: &'a AstNode<'a>,
    depth: u16,
    blocks: &mut Vec<RenderBlock>,
    outline: &mut Vec<HeadingOutline>,
    in_blockquote: bool,
    _in_list: bool,
    list_start: u32,
    list_index: u32,
) {
    let data = node.data.borrow();
    match &data.value {
        NodeValue::Document => {
            for c in node.children() {
                flatten(c, depth, blocks, outline, in_blockquote, false, 1, 0);
            }
        }
        NodeValue::BlockQuote => {
            for c in node.children() {
                flatten(c, depth + 1, blocks, outline, true, false, 1, 0);
            }
        }
        NodeValue::List(list) => {
            let start = list.start as u32;
            let mut idx = 0u32;
            for c in node.children() {
                flatten(
                    c,
                    depth + 1,
                    blocks,
                    outline,
                    in_blockquote,
                    true,
                    start,
                    idx,
                );
                idx += 1;
            }
        }
        NodeValue::Item(_) => {
            push_list_item(
                node,
                depth,
                blocks,
                outline,
                in_blockquote,
                list_start,
                list_index,
                None,
            );
        }
        NodeValue::TaskItem(marker) => {
            // None = unchecked `[ ]`；Some(c) = checked（通常为 x/X）
            let checked = match marker {
                Some(_) => Some(true),
                None => Some(false),
            };
            push_list_item(
                node,
                depth,
                blocks,
                outline,
                in_blockquote,
                list_start,
                list_index,
                checked,
            );
        }
        NodeValue::Heading(h) => {
            let mut inlines = Vec::new();
            collect_inlines(node, &mut inlines);
            let title: String = inlines.iter().map(|s| s.text.as_str()).collect();
            let level = h.level;
            let kind = RenderKind::Heading { level };
            let est = estimate_height(&kind, &inlines, depth);
            let idx = blocks.len();
            outline.push(HeadingOutline {
                level,
                title,
                block_index: idx,
            });
            blocks.push(RenderBlock {
                kind,
                inlines,
                depth,
                est_height: est,
                source_line: data.sourcepos.start.line,
            });
        }
        NodeValue::Paragraph => {
            let mut inlines = Vec::new();
            collect_inlines(node, &mut inlines);
            let kind = RenderKind::Paragraph;
            let est = estimate_height(&kind, &inlines, depth);
            blocks.push(RenderBlock {
                kind,
                inlines,
                depth: depth.saturating_add(if in_blockquote { 1 } else { 0 }),
                est_height: est,
                source_line: data.sourcepos.start.line,
            });
        }
        NodeValue::CodeBlock(cb) => {
            let info = cb.info.clone();
            let literal = cb.literal.clone();
            let kind = RenderKind::CodeBlock {
                info,
                literal: literal.clone(),
            };
            let lines = literal.lines().count().max(1) as f32;
            blocks.push(RenderBlock {
                kind,
                inlines: vec![],
                depth,
                est_height: 12.0 + lines * 16.0,
                source_line: data.sourcepos.start.line,
            });
        }
        NodeValue::ThematicBreak => {
            let kind = RenderKind::ThematicBreak;
            blocks.push(RenderBlock {
                kind,
                inlines: vec![],
                depth,
                est_height: 24.0,
                source_line: data.sourcepos.start.line,
            });
        }
        NodeValue::HtmlBlock(hb) => {
            let literal = hb.literal.clone();
            let lines = literal.lines().count().max(1) as f32;
            blocks.push(RenderBlock {
                kind: RenderKind::HtmlBlock {
                    literal: literal.clone(),
                },
                inlines: vec![],
                depth,
                est_height: 10.0 + lines * 14.0,
                source_line: data.sourcepos.start.line,
            });
        }
        NodeValue::Table(_) => {
            let mut headers: Vec<Vec<InlineSpan>> = Vec::new();
            let mut rows: Vec<Vec<Vec<InlineSpan>>> = Vec::new();
            for row_node in node.children() {
                let is_header = matches!(
                    row_node.data.borrow().value,
                    NodeValue::TableRow(true)
                );
                if !matches!(
                    row_node.data.borrow().value,
                    NodeValue::TableRow(_)
                ) {
                    continue;
                }
                let mut cells = Vec::new();
                for cell in row_node.children() {
                    let mut inlines = Vec::new();
                    collect_inlines(cell, &mut inlines);
                    cells.push(inlines);
                }
                if is_header && headers.is_empty() {
                    headers = cells;
                } else {
                    rows.push(cells);
                }
            }
            let kind = RenderKind::Table {
                headers: headers.clone(),
                rows: rows.clone(),
            };
            let est = estimate_height(&kind, &[], depth);
            blocks.push(RenderBlock {
                kind,
                inlines: vec![],
                depth,
                est_height: est,
                source_line: data.sourcepos.start.line,
            });
        }
        NodeValue::TableRow(_) | NodeValue::TableCell => {
            // handled under Table
        }
        _ => {
            for c in node.children() {
                flatten(c, depth, blocks, outline, in_blockquote, false, 1, 0);
            }
        }
    }
}

fn push_list_item<'a>(
    node: &'a AstNode<'a>,
    depth: u16,
    blocks: &mut Vec<RenderBlock>,
    outline: &mut Vec<HeadingOutline>,
    in_blockquote: bool,
    list_start: u32,
    list_index: u32,
    checked: Option<bool>,
) {
    let data = node.data.borrow();
    let mut inlines = Vec::new();
    let mut nested = Vec::new();
    for c in node.children() {
        match &c.data.borrow().value {
            NodeValue::Paragraph | NodeValue::Heading(_) => {
                collect_inlines(c, &mut inlines);
            }
            NodeValue::List(_)
            | NodeValue::BlockQuote
            | NodeValue::CodeBlock(_)
            | NodeValue::Table(_) => {
                nested.push(c);
            }
            _ => {
                collect_inlines(c, &mut inlines);
            }
        }
    }
    let ordered = node
        .parent()
        .and_then(|p| match &p.data.borrow().value {
            NodeValue::List(l) => Some(matches!(l.list_type, ListType::Ordered)),
            _ => None,
        })
        .unwrap_or(false);
    let kind = RenderKind::ListItem {
        ordered,
        start: list_start,
        index: list_index,
        checked,
    };
    let est = estimate_height(&kind, &inlines, depth);
    blocks.push(RenderBlock {
        kind,
        inlines,
        depth: depth.saturating_add(if in_blockquote { 1 } else { 0 }),
        est_height: est,
        source_line: data.sourcepos.start.line,
    });
    for n in nested {
        flatten(
            n,
            depth + 1,
            blocks,
            outline,
            in_blockquote,
            true,
            list_start,
            0,
        );
    }
}

fn collect_inlines<'a>(node: &'a AstNode<'a>, out: &mut Vec<InlineSpan>) {
    collect_inlines_styled(node, out, false, false, false);
}

fn collect_inlines_styled<'a>(
    node: &'a AstNode<'a>,
    out: &mut Vec<InlineSpan>,
    strong: bool,
    emphasis: bool,
    strikethrough: bool,
) {
    match &node.data.borrow().value {
        NodeValue::Text(t) => {
            out.push(InlineSpan {
                text: t.clone(),
                strong,
                emphasis,
                code: false,
                strikethrough,
                link_url: None,
                image_src: None,
                soft_break: false,
                hard_break: false,
            });
        }
        NodeValue::Code(c) => {
            out.push(InlineSpan {
                text: c.literal.clone(),
                strong,
                emphasis,
                code: true,
                strikethrough,
                link_url: None,
                image_src: None,
                soft_break: false,
                hard_break: false,
            });
        }
        NodeValue::SoftBreak => {
            out.push(InlineSpan {
                text: " ".into(),
                strong,
                emphasis,
                code: false,
                strikethrough,
                link_url: None,
                image_src: None,
                soft_break: true,
                hard_break: false,
            });
        }
        NodeValue::LineBreak => {
            out.push(InlineSpan {
                text: "\n".into(),
                strong,
                emphasis,
                code: false,
                strikethrough,
                link_url: None,
                image_src: None,
                soft_break: false,
                hard_break: true,
            });
        }
        NodeValue::Strong => {
            for c in node.children() {
                collect_inlines_styled(c, out, true, emphasis, strikethrough);
            }
        }
        NodeValue::Emph => {
            for c in node.children() {
                collect_inlines_styled(c, out, strong, true, strikethrough);
            }
        }
        NodeValue::Strikethrough => {
            for c in node.children() {
                collect_inlines_styled(c, out, strong, emphasis, true);
            }
        }
        NodeValue::Link(link) => {
            let url = link.url.clone();
            let mut children = Vec::new();
            for c in node.children() {
                collect_inlines_styled(c, &mut children, strong, emphasis, strikethrough);
            }
            if children.is_empty() {
                out.push(InlineSpan {
                    text: url.clone(),
                    strong,
                    emphasis,
                    code: false,
                    strikethrough,
                    link_url: Some(url),
                    image_src: None,
                    soft_break: false,
                    hard_break: false,
                });
            } else {
                for mut s in children {
                    s.link_url = Some(url.clone());
                    out.push(s);
                }
            }
        }
        NodeValue::Image(img) => {
            let url = img.url.clone();
            let mut alt = String::new();
            for c in node.children() {
                let mut tmp = Vec::new();
                collect_inlines_styled(c, &mut tmp, false, false, false);
                for t in tmp {
                    alt.push_str(&t.text);
                }
            }
            out.push(InlineSpan {
                text: if alt.is_empty() {
                    "[图片]".into()
                } else {
                    alt
                },
                strong,
                emphasis,
                code: false,
                strikethrough,
                link_url: None,
                image_src: Some(url),
                soft_break: false,
                hard_break: false,
            });
        }
        NodeValue::HtmlInline(h) => {
            out.push(InlineSpan {
                text: h.clone(),
                strong,
                emphasis,
                code: true,
                strikethrough,
                link_url: None,
                image_src: None,
                soft_break: false,
                hard_break: false,
            });
        }
        _ => {
            for c in node.children() {
                collect_inlines_styled(c, out, strong, emphasis, strikethrough);
            }
        }
    }
}

fn estimate_height(kind: &RenderKind, inlines: &[InlineSpan], depth: u16) -> f32 {
    let text_len: usize = inlines.iter().map(|s| s.text.len()).sum();
    let lines = ((text_len / 48) + 1) as f32;
    let base = match kind {
        RenderKind::Heading { level } => match level {
            1 => 36.0,
            2 => 30.0,
            3 => 26.0,
            _ => 22.0,
        },
        RenderKind::CodeBlock { literal, .. } => {
            16.0 + literal.lines().count().max(1) as f32 * 16.0
        }
        RenderKind::ThematicBreak => 20.0,
        RenderKind::HtmlBlock { literal } => 12.0 + literal.lines().count().max(1) as f32 * 14.0,
        RenderKind::ListItem { .. } => 8.0 + lines * 18.0,
        RenderKind::Paragraph | RenderKind::BlockQuote => 8.0 + lines * 28.0,
        RenderKind::Table { headers: _, rows } => 28.0 + (rows.len() + 1) as f32 * 24.0,
        RenderKind::ExtensionStub { .. } => 24.0,
    };
    base + depth as f32 * 2.0
}

/// 供扩展注册占位（M2+）。
pub fn extension_stub_hash(name: &str) -> String {
    let mut h = Sha256::new();
    h.update(name.as_bytes());
    hex::encode(h.finalize())
}

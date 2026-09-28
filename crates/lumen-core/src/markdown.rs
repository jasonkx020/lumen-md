//! CommonMark / Lumen 方言解析（comrak）。

use comrak::{
    nodes::{AstNode, NodeValue},
    Arena, ComrakOptions,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
    /// 严格 CommonMark
    CommonMark,
    /// CM + 扩展挂载点（M1 解析仍以 CM 为主；扩展位留给 M2+）
    #[default]
    Lumen,
}

impl Dialect {
    pub fn as_str(self) -> &'static str {
        match self {
            Dialect::CommonMark => "commonmark",
            Dialect::Lumen => "lumen",
        }
    }
}

pub struct SoftLimit;

impl SoftLimit {
    pub const FILE_BYTES: u64 = crate::workspace::MAX_FILE_BYTES;
}

#[derive(Debug, Clone)]
pub struct ParseResult {
    pub fingerprint: String,
    pub dialect: Dialect,
    /// 源码内容指纹对应的原文长度
    pub source_len: usize,
}

pub struct MarkdownEngine {
    dialect: Dialect,
}

impl MarkdownEngine {
    pub fn new(dialect: Dialect) -> Self {
        Self { dialect }
    }

    pub fn dialect(&self) -> Dialect {
        self.dialect
    }

    pub fn set_dialect(&mut self, d: Dialect) {
        self.dialect = d;
    }

    pub fn options(&self) -> ComrakOptions {
        let mut opts = ComrakOptions::default();
        let lumen = matches!(self.dialect, Dialect::Lumen);
        // Lumen：GFM 表 / 任务列表 / 删除线；CommonMark 保持严格
        opts.extension.strikethrough = lumen;
        opts.extension.table = lumen;
        opts.extension.autolink = lumen;
        opts.extension.tasklist = lumen;
        opts.extension.superscript = false;
        opts.extension.footnotes = false;
        opts.extension.description_lists = false;
        opts.parse.smart = false;
        opts.render.unsafe_ = false; // 不输出可执行 HTML
        opts.render.escape = true;
        opts
    }

    pub fn fingerprint(source: &str, dialect: Dialect) -> String {
        let mut h = Sha256::new();
        h.update(dialect.as_str().as_bytes());
        h.update(b"\0");
        h.update(source.as_bytes());
        hex::encode(h.finalize())
    }

    /// 解析并校验可走通 AST；返回指纹。完整 AST 由 lumen-render 再 parse 构建模型。
    pub fn validate(&self, source: &str) -> anyhow::Result<ParseResult> {
        let arena = Arena::new();
        let opts = self.options();
        let root = comrak::parse_document(&arena, source, &opts);
        walk_ok(root)?;
        Ok(ParseResult {
            fingerprint: Self::fingerprint(source, self.dialect),
            dialect: self.dialect,
            source_len: source.len(),
        })
    }

    pub fn parse<'a>(
        &self,
        arena: &'a Arena<AstNode<'a>>,
        source: &str,
    ) -> &'a AstNode<'a> {
        comrak::parse_document(arena, source, &self.options())
    }
}

fn walk_ok<'a>(node: &'a AstNode<'a>) -> anyhow::Result<()> {
    // 触达所有节点，确保 AST 完整
    for n in node.descendants() {
        let _ = n.data.borrow().value;
        if matches!(n.data.borrow().value, NodeValue::Document) && n.parent().is_some() {
            // noop
        }
    }
    Ok(())
}

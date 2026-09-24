//! Lumen MD 可信核心：工作区沙箱、原子写、Markdown 引擎。

pub mod markdown;
pub mod workspace;

pub use markdown::{Dialect, MarkdownEngine, ParseResult, SoftLimit};
pub use workspace::{FileEntry, Workspace, MAX_FILE_BYTES};

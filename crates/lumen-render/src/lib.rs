//! CommonMark 块级渲染：AST → RenderModel → egui 虚拟化绘制 / 就地编辑。

mod model;
mod paint;
mod serialize;

pub use model::{HeadingOutline, InlineSpan, RenderBlock, RenderKind, RenderModel};
pub use paint::{PreviewState, show_preview};
pub use serialize::InlineFormat;

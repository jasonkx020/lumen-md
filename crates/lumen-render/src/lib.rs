//! CommonMark 块级渲染：AST → RenderModel → egui 虚拟化绘制 / 就地编辑。

mod model;
mod paint;
mod serialize;

pub use model::{HeadingOutline, InlineSpan, RenderBlock, RenderKind, RenderModel};
pub use paint::{show_preview, PreviewState};
pub use serialize::{
    inlines_to_md, parse_inlines_md, plain_text, plain_to_inlines, InlineFormat,
};

//! 商用视觉令牌：纸墨写作体系（非紫白 / 非奶油陶土）。

use eframe::egui::{
    self, Color32, FontFamily, FontId, Frame, Margin, RichText, Rounding, Stroke, TextStyle,
    Vec2, Visuals,
};

pub const APP_NAME: &str = "Lumen MD";
pub const APP_TAGLINE: &str = "本地 Markdown · CommonMark · 绿色单文件";

/// 顶栏墨色
pub const INK: Color32 = Color32::from_rgb(0x1A, 0x23, 0x2E);
pub const INK_SOFT: Color32 = Color32::from_rgb(0x2C, 0x3A, 0x4A);
/// 画布 / 纸面
pub const PAPER: Color32 = Color32::from_rgb(0xFB, 0xFA, 0xF7);
pub const PAPER_EDGE: Color32 = Color32::from_rgb(0xE8, 0xE4, 0xDC);
/// 侧栏
pub const SIDEBAR: Color32 = Color32::from_rgb(0xF0, 0xF2, 0xF5);
pub const SIDEBAR_HOVER: Color32 = Color32::from_rgb(0xE4, 0xE8, 0xEE);
pub const SIDEBAR_ACTIVE: Color32 = Color32::from_rgb(0xD6, 0xE4, 0xF0);
/// 文本
pub const TEXT: Color32 = Color32::from_rgb(0x1C, 0x19, 0x17);
pub const TEXT_MUTED: Color32 = Color32::from_rgb(0x6B, 0x72, 0x80);
pub const TEXT_ON_INK: Color32 = Color32::from_rgb(0xF5, 0xF7, 0xFA);
/// 强调：松柏青绿（避开紫色）
pub const ACCENT: Color32 = Color32::from_rgb(0x0D, 0x7A, 0x6F);
pub const ACCENT_HOVER: Color32 = Color32::from_rgb(0x0A, 0x63, 0x5A);
pub const ACCENT_SOFT: Color32 = Color32::from_rgb(0xD5, 0xF0, 0xEB);
pub const DANGER: Color32 = Color32::from_rgb(0xC4, 0x35, 0x2B);
pub const WARN: Color32 = Color32::from_rgb(0xB4, 0x5F, 0x06);
pub const BORDER: Color32 = Color32::from_rgb(0xD8, 0xDE, 0xE6);

pub const ROUND: f32 = 5.0;

pub fn apply(ctx: &egui::Context) {
    let mut visuals = Visuals::light();
    visuals.window_fill = PAPER;
    visuals.panel_fill = SIDEBAR;
    visuals.extreme_bg_color = PAPER;
    visuals.faint_bg_color = SIDEBAR;
    visuals.code_bg_color = Color32::from_rgb(0xEE, 0xF1, 0xF4);
    visuals.override_text_color = Some(TEXT);
    visuals.hyperlink_color = ACCENT;
    visuals.warn_fg_color = WARN;
    visuals.error_fg_color = DANGER;
    visuals.window_rounding = Rounding::same(ROUND);
    visuals.menu_rounding = Rounding::same(ROUND);
    visuals.window_stroke = Stroke::new(1.0, BORDER);
    visuals.widgets.noninteractive.bg_fill = PAPER;
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0, TEXT_MUTED);
    visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0, BORDER);
    visuals.widgets.noninteractive.rounding = Rounding::same(ROUND);
    visuals.widgets.inactive.bg_fill = Color32::from_rgb(0xFF, 0xFF, 0xFF);
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0, TEXT);
    visuals.widgets.inactive.bg_stroke = Stroke::new(1.0, BORDER);
    visuals.widgets.inactive.rounding = Rounding::same(ROUND);
    visuals.widgets.hovered.bg_fill = ACCENT_SOFT;
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0, TEXT);
    visuals.widgets.hovered.bg_stroke = Stroke::new(1.0, ACCENT);
    visuals.widgets.hovered.rounding = Rounding::same(ROUND);
    visuals.widgets.active.bg_fill = Color32::from_rgb(0xB8, 0xE0, 0xD8);
    visuals.widgets.active.fg_stroke = Stroke::new(1.0, TEXT);
    visuals.widgets.active.bg_stroke = Stroke::new(1.5, ACCENT);
    visuals.widgets.active.rounding = Rounding::same(ROUND);
    visuals.widgets.open.bg_fill = ACCENT_SOFT;
    visuals.widgets.open.bg_stroke = Stroke::new(1.0, ACCENT);
    visuals.selection.bg_fill = Color32::from_rgb(0x9B, 0xD4, 0xCB);
    visuals.selection.stroke = Stroke::new(1.0, ACCENT);
    ctx.set_visuals(visuals);

    let mut style = (*ctx.style()).clone();
    style.spacing.item_spacing = Vec2::new(8.0, 6.0);
    style.spacing.button_padding = Vec2::new(12.0, 6.0);
    style.spacing.window_margin = Margin::same(12.0);
    style.interaction.tooltip_delay = 0.3;
    style.text_styles.insert(
        TextStyle::Heading,
        FontId::new(20.0, FontFamily::Proportional),
    );
    style
        .text_styles
        .insert(TextStyle::Body, FontId::new(14.0, FontFamily::Proportional));
    style.text_styles.insert(
        TextStyle::Button,
        FontId::new(13.5, FontFamily::Proportional),
    );
    style.text_styles.insert(
        TextStyle::Small,
        FontId::new(12.0, FontFamily::Proportional),
    );
    style.text_styles.insert(
        TextStyle::Monospace,
        FontId::new(13.5, FontFamily::Monospace),
    );
    ctx.set_style(style);
}

pub fn top_bar_frame() -> Frame {
    Frame::none()
        .fill(INK)
        .inner_margin(Margin::symmetric(14.0, 10.0))
        .stroke(Stroke::NONE)
}

pub fn sidebar_frame() -> Frame {
    Frame::none()
        .fill(SIDEBAR)
        .inner_margin(Margin::symmetric(10.0, 10.0))
        .stroke(Stroke::NONE)
}

pub fn paper_frame() -> Frame {
    Frame::none()
        .fill(PAPER)
        .inner_margin(Margin::symmetric(12.0, 10.0))
}

pub fn status_frame() -> Frame {
    Frame::none()
        .fill(Color32::from_rgb(0xE8, 0xEC, 0xF1))
        .inner_margin(Margin::symmetric(12.0, 6.0))
        .stroke(Stroke::new(1.0, BORDER))
}

pub fn brand_on_ink(size: f32) -> RichText {
    RichText::new(APP_NAME)
        .size(size)
        .strong()
        .color(TEXT_ON_INK)
}

pub fn muted(s: impl Into<String>) -> RichText {
    RichText::new(s).color(TEXT_MUTED)
}

pub fn primary_button(ui: &mut egui::Ui, label: &str) -> egui::Response {
    ui.add(
        egui::Button::new(RichText::new(label).color(TEXT_ON_INK).strong())
            .fill(ACCENT)
            .stroke(Stroke::NONE)
            .rounding(Rounding::same(ROUND)),
    )
}

pub fn ink_ghost_button(ui: &mut egui::Ui, label: &str) -> egui::Response {
    ui.add(
        egui::Button::new(RichText::new(label).color(TEXT_ON_INK))
            .fill(INK_SOFT)
            .stroke(Stroke::new(1.0, Color32::from_rgb(0x3D, 0x4F, 0x63)))
            .rounding(Rounding::same(ROUND)),
    )
}

pub fn panel_title(ui: &mut egui::Ui, title: &str) {
    ui.label(
        RichText::new(title)
            .size(11.0)
            .strong()
            .color(TEXT_MUTED),
    );
    ui.add_space(4.0);
}

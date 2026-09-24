//! egui 预览：块选中、就地编辑、虚拟化。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use egui::{
    self, text::LayoutJob, Color32, FontId, Galley, RichText, ScrollArea, Sense, TextFormat, Ui,
    Vec2,
};
use lumen_core::Dialect;

use crate::model::{InlineSpan, RenderBlock, RenderKind, RenderModel};
use crate::serialize::{
    apply_inline_format, plain_text, plain_to_inlines, set_block_kind, InlineFormat,
};

const DEBOUNCE: Duration = Duration::from_millis(80);

pub struct PreviewState {
    pub dialect: Dialect,
    /// 是否允许就地编辑（浏览即编辑）
    pub editable: bool,
    pending_src: String,
    last_edit: Instant,
    model: Option<RenderModel>,
    last_width: f32,
    galley_width: f32,
    scroll_to_block: Option<usize>,
    image_fail: HashMap<String, bool>,
    workspace_root: Option<PathBuf>,
    pub selected: Option<usize>,
    /// 选中块正在编辑的纯文本
    edit_buf: String,
    /// 外部应读取：编辑产生了新的 markdown
    pub pending_markdown: Option<String>,
    link_dialog: bool,
    link_url_buf: String,
}

impl Default for PreviewState {
    fn default() -> Self {
        Self {
            dialect: Dialect::Lumen,
            editable: true,
            pending_src: String::new(),
            last_edit: Instant::now() - Duration::from_secs(10),
            model: None,
            last_width: 0.0,
            galley_width: 0.0,
            scroll_to_block: None,
            image_fail: HashMap::new(),
            workspace_root: None,
            selected: None,
            edit_buf: String::new(),
            pending_markdown: None,
            link_dialog: false,
            link_url_buf: String::new(),
        }
    }
}

impl PreviewState {
    pub fn set_workspace_root(&mut self, root: Option<PathBuf>) {
        self.workspace_root = root;
        self.image_fail.clear();
    }

    pub fn notify_source(&mut self, source: &str) {
        if source != self.pending_src {
            self.pending_src = source.to_string();
            self.last_edit = Instant::now();
            // 外部源码变更时清除选中，避免错位
            if self.selected.is_none() {
                // keep
            }
        }
    }

    pub fn force_rebuild(&mut self) {
        self.last_edit = Instant::now() - DEBOUNCE;
        self.model = None;
    }

    pub fn take_pending_markdown(&mut self) -> Option<String> {
        self.pending_markdown.take()
    }

    pub fn outline(&self) -> Vec<(u8, String, usize)> {
        self.model
            .as_ref()
            .map(|m| {
                m.outline
                    .iter()
                    .map(|o| (o.level, o.title.clone(), o.block_index))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn jump_to_block(&mut self, idx: usize) {
        self.scroll_to_block = Some(idx);
        self.select_block(idx);
    }

    pub fn select_block(&mut self, idx: usize) {
        self.commit_edit_buf();
        if let Some(m) = &self.model {
            if idx < m.blocks.len() {
                self.selected = Some(idx);
                self.edit_buf = block_edit_text(&m.blocks[idx]);
            }
        }
    }

    pub fn clear_selection(&mut self) {
        self.commit_edit_buf();
        self.selected = None;
        self.edit_buf.clear();
    }

    fn commit_edit_buf(&mut self) {
        let Some(idx) = self.selected else { return };
        let Some(model) = self.model.as_mut() else { return };
        if idx >= model.blocks.len() {
            return;
        }
        let block = &mut model.blocks[idx];
        match &mut block.kind {
            RenderKind::CodeBlock { literal, .. } => {
                if *literal != self.edit_buf {
                    *literal = self.edit_buf.clone();
                    self.emit_md();
                }
            }
            RenderKind::ThematicBreak | RenderKind::HtmlBlock { .. } => {}
            _ => {
                let old = plain_text(&block.inlines);
                if old != self.edit_buf {
                    // 保留简单格式若仅空白变化；否则用纯文本
                    block.inlines = plain_to_inlines(&self.edit_buf);
                    self.emit_md();
                }
            }
        }
    }

    fn emit_md(&mut self) {
        if let Some(m) = &self.model {
            let md = m.to_markdown();
            self.pending_src = md.clone();
            self.pending_markdown = Some(md);
            // 更新指纹避免立即被 debounce 覆盖
            self.last_edit = Instant::now();
        }
    }

    pub fn cmd_set_paragraph(&mut self, kind: RenderKind) {
        self.commit_edit_buf();
        let Some(idx) = self.selected else { return };
        let Some(model) = self.model.as_mut() else { return };
        if idx >= model.blocks.len() {
            return;
        }
        set_block_kind(&mut model.blocks[idx], kind);
        self.edit_buf = block_edit_text(&model.blocks[idx]);
        self.emit_md();
        self.force_rebuild_keep_sel(idx);
    }

    pub fn cmd_inline(&mut self, fmt: InlineFormat) {
        self.commit_edit_buf();
        let Some(idx) = self.selected else { return };
        let Some(model) = self.model.as_mut() else { return };
        if idx >= model.blocks.len() {
            return;
        }
        apply_inline_format(&mut model.blocks[idx].inlines, fmt);
        self.edit_buf = block_edit_text(&model.blocks[idx]);
        self.emit_md();
        self.force_rebuild_keep_sel(idx);
    }

    pub fn cmd_insert_break(&mut self) {
        self.commit_edit_buf();
        let Some(model) = self.model.as_mut() else { return };
        let idx = self.selected.map(|i| i + 1).unwrap_or(model.blocks.len());
        model.blocks.insert(
            idx,
            RenderBlock {
                kind: RenderKind::ThematicBreak,
                inlines: vec![],
                depth: 0,
                est_height: 24.0,
                source_line: 0,
            },
        );
        self.selected = Some(idx);
        self.edit_buf.clear();
        self.emit_md();
        self.force_rebuild_keep_sel(idx);
    }

    pub fn cmd_insert_paragraph(&mut self) {
        self.commit_edit_buf();
        let Some(model) = self.model.as_mut() else {
            let mut m = RenderModel::build("", self.dialect);
            m.blocks.push(RenderBlock {
                kind: RenderKind::Paragraph,
                inlines: plain_to_inlines(""),
                depth: 0,
                est_height: 28.0,
                source_line: 0,
            });
            self.model = Some(m);
            self.selected = Some(0);
            self.edit_buf.clear();
            self.emit_md();
            return;
        };
        let idx = self.selected.map(|i| i + 1).unwrap_or(model.blocks.len());
        model.blocks.insert(
            idx,
            RenderBlock {
                kind: RenderKind::Paragraph,
                inlines: plain_to_inlines(""),
                depth: 0,
                est_height: 28.0,
                source_line: 0,
            },
        );
        self.selected = Some(idx);
        self.edit_buf.clear();
        self.emit_md();
        self.force_rebuild_keep_sel(idx);
    }

    fn force_rebuild_keep_sel(&mut self, idx: usize) {
        // 从当前 model 序列化后再 parse，保证与 comrak 一致
        if let Some(md) = self.pending_markdown.clone() {
            self.model = Some(RenderModel::build(&md, self.dialect));
            self.pending_src = md;
            if idx < self.model.as_ref().map(|m| m.blocks.len()).unwrap_or(0) {
                self.selected = Some(idx);
                if let Some(m) = &self.model {
                    self.edit_buf = block_edit_text(&m.blocks[idx]);
                }
            }
        }
    }

    pub fn open_link_dialog(&mut self) {
        self.link_url_buf.clear();
        self.link_dialog = true;
    }

    fn ensure_model(&mut self) {
        // 有未提交选中编辑时不要用旧 pending 覆盖
        if self.selected.is_some() && self.pending_markdown.is_none() {
            // 仍允许首次构建
            if self.model.is_some() {
                return;
            }
        }
        if self.last_edit.elapsed() < DEBOUNCE && self.model.is_some() {
            return;
        }
        let need = match &self.model {
            None => true,
            Some(m) => !m.matches(&self.pending_src, self.dialect),
        };
        if need {
            let sel = self.selected;
            self.model = Some(RenderModel::build(&self.pending_src, self.dialect));
            self.galley_width = 0.0;
            if let Some(idx) = sel {
                if let Some(m) = &self.model {
                    if idx < m.blocks.len() {
                        self.selected = Some(idx);
                        self.edit_buf = block_edit_text(&m.blocks[idx]);
                    } else {
                        self.selected = None;
                    }
                }
            }
        }
    }
}

fn block_edit_text(b: &RenderBlock) -> String {
    match &b.kind {
        RenderKind::CodeBlock { literal, .. } => literal.clone(),
        RenderKind::HtmlBlock { literal } => literal.clone(),
        RenderKind::ThematicBreak => String::new(),
        _ => plain_text(&b.inlines),
    }
}

/// 返回 true 表示文档被编辑。
pub fn show_preview(ui: &mut Ui, state: &mut PreviewState) -> bool {
    state.ensure_model();
    let mut dirty = false;

    if state.link_dialog {
        egui::Window::new("插入链接")
            .collapsible(false)
            .resizable(false)
            .show(ui.ctx(), |ui| {
                ui.label("URL");
                ui.text_edit_singleline(&mut state.link_url_buf);
                ui.horizontal(|ui| {
                    if ui.button("确定").clicked() {
                        let url = state.link_url_buf.clone();
                        state.link_dialog = false;
                        state.cmd_inline(InlineFormat::Link(url));
                        dirty = true;
                    }
                    if ui.button("取消").clicked() {
                        state.link_dialog = false;
                    }
                });
            });
    }

    let width = ui.available_width();
    if (width - state.last_width).abs() > 1.0 {
        state.last_width = width;
        state.galley_width = 0.0;
    }

    let Some(model) = state.model.clone() else {
        ui.spinner();
        ui.label("解析中…");
        if state.last_edit.elapsed() >= DEBOUNCE {
            state.model = Some(RenderModel::build(&state.pending_src, state.dialect));
        } else {
            ui.ctx().request_repaint_after(DEBOUNCE);
        }
        return false;
    };

    let content_w = (width - 16.0).max(120.0);
    state.galley_width = content_w;

    let mut scroll = ScrollArea::vertical()
        .auto_shrink([false, false])
        .id_source("lumen_preview_scroll");

    if let Some(idx) = state.scroll_to_block.take() {
        let y: f32 = model.blocks.iter().take(idx).map(|b| b.est_height).sum();
        scroll = scroll.vertical_scroll_offset(y);
    }

    let mut clicked: Option<usize> = None;
    let mut edit_changed = false;

    scroll.show_viewport(ui, |ui, viewport| {
        ui.set_width(content_w);
        let pad = viewport.height().max(200.0);
        let y0 = (viewport.top() - pad).max(0.0);
        let y1 = viewport.bottom() + pad;

        let mut y = 0.0_f32;
        let mut start_i = 0usize;
        for (i, b) in model.blocks.iter().enumerate() {
            if y + b.est_height >= y0 {
                start_i = i;
                break;
            }
            y += b.est_height;
        }
        if start_i > 0 {
            ui.allocate_exact_size(Vec2::new(content_w, y), Sense::hover());
        }

        let mut drawn_h = 0.0_f32;
        for (i, block) in model.blocks.iter().enumerate().skip(start_i) {
            if y + drawn_h > y1 && state.selected != Some(i) {
                let rest: f32 = model.blocks[i..].iter().map(|b| b.est_height).sum();
                ui.allocate_exact_size(Vec2::new(content_w, rest), Sense::hover());
                break;
            }
            let selected = state.selected == Some(i);
            let before = ui.cursor().top();

            ui.horizontal(|ui| {
                let bar_w = 3.0;
                let (bar, _) = ui.allocate_exact_size(
                    Vec2::new(bar_w, block.est_height.max(22.0)),
                    Sense::hover(),
                );
                if selected {
                    ui.painter().rect_filled(
                        bar,
                        1.0,
                        Color32::from_rgb(0x0D, 0x7A, 0x6F),
                    );
                }
                ui.add_space(8.0);

                let avail = (content_w - 20.0).max(80.0);
                ui.vertical(|ui| {
                    ui.set_max_width(avail);
                    if state.editable && selected {
                        if paint_block_editor(ui, state, block, &mut edit_changed) {
                            // editing
                        }
                    } else {
                        let resp = ui.allocate_ui(Vec2::new(avail, 0.0), |ui| {
                            paint_block_view(ui, state, block, avail);
                        });
                        if state.editable && resp.response.clicked() {
                            clicked = Some(i);
                        }
                    }
                });
            });

            let after = ui.cursor().top();
            drawn_h += (after - before).max(block.est_height * 0.5);
        }
    });

    if let Some(i) = clicked {
        state.select_block(i);
        dirty = true;
    }
    if edit_changed {
        state.commit_edit_buf();
        dirty = true;
    }

    dirty
}

fn paint_block_editor(ui: &mut Ui, state: &mut PreviewState, block: &RenderBlock, changed: &mut bool) -> bool {
    match &block.kind {
        RenderKind::ThematicBreak => {
            ui.separator();
            ui.label(RichText::new("分隔线").small().color(Color32::GRAY));
        }
        RenderKind::CodeBlock { info, .. } => {
            if !info.is_empty() {
                ui.label(RichText::new(info).small().color(Color32::GRAY));
            }
            let resp = ui.add(
                egui::TextEdit::multiline(&mut state.edit_buf)
                    .desired_width(f32::INFINITY)
                    .font(FontId::monospace(13.0))
                    .code_editor(),
            );
            if resp.changed() {
                *changed = true;
            }
            if resp.lost_focus() {
                *changed = true;
            }
        }
        RenderKind::Heading { level } => {
            let size = heading_size(*level);
            let resp = ui.add(
                egui::TextEdit::multiline(&mut state.edit_buf)
                    .desired_width(f32::INFINITY)
                    .desired_rows(1)
                    .font(FontId::proportional(size)),
            );
            if resp.changed() || resp.lost_focus() {
                *changed = true;
            }
        }
        _ => {
            let resp = ui.add(
                egui::TextEdit::multiline(&mut state.edit_buf)
                    .desired_width(f32::INFINITY)
                    .desired_rows(2)
                    .font(FontId::proportional(14.5)),
            );
            if resp.changed() || resp.lost_focus() {
                *changed = true;
            }
        }
    }
    true
}

fn heading_size(level: u8) -> f32 {
    match level {
        1 => 28.0,
        2 => 22.0,
        3 => 18.0,
        4 => 16.0,
        _ => 15.0,
    }
}

fn paint_block_view(ui: &mut Ui, state: &mut PreviewState, block: &RenderBlock, width: f32) {
    let indent = block.depth as f32 * 12.0;
    if indent > 0.0 {
        ui.add_space(indent);
    }
    match &block.kind {
        RenderKind::Heading { level } => {
            paint_inlines(ui, state, &block.inlines, heading_size(*level), true);
            if *level <= 2 {
                ui.add_space(4.0);
                ui.separator();
            }
            ui.add_space(6.0);
        }
        RenderKind::Paragraph | RenderKind::BlockQuote => {
            paint_inlines(ui, state, &block.inlines, 14.5, false);
            ui.add_space(8.0);
        }
        RenderKind::ListItem {
            ordered,
            start,
            index,
        } => {
            let bullet = if *ordered {
                format!("{}.", start + index)
            } else {
                "•".into()
            };
            ui.horizontal_top(|ui| {
                ui.label(
                    RichText::new(bullet)
                        .strong()
                        .color(Color32::from_rgb(0x0D, 0x7A, 0x6F)),
                );
                ui.add_space(6.0);
                ui.vertical(|ui| {
                    paint_inlines(ui, state, &block.inlines, 14.5, false);
                });
            });
            ui.add_space(4.0);
        }
        RenderKind::CodeBlock { info, literal } => {
            if !info.is_empty() {
                ui.label(RichText::new(info).small().color(Color32::GRAY));
            }
            egui::Frame::none()
                .fill(Color32::from_rgb(0xF1, 0xF5, 0xF9))
                .inner_margin(8.0)
                .show(ui, |ui| {
                    ui.set_min_width(width - 8.0);
                    ui.add(
                        egui::Label::new(RichText::new(literal.as_str()).monospace().size(13.0))
                            .wrap(true),
                    );
                });
            ui.add_space(8.0);
        }
        RenderKind::ThematicBreak => {
            ui.add_space(6.0);
            ui.separator();
            ui.add_space(6.0);
        }
        RenderKind::HtmlBlock { literal } => {
            ui.label(RichText::new("(HTML)").small().color(Color32::GRAY));
            ui.add(
                egui::Label::new(RichText::new(literal.as_str()).monospace().size(12.0)).wrap(true),
            );
            ui.add_space(6.0);
        }
        RenderKind::ExtensionStub { name } => {
            ui.label(RichText::new(format!("[扩展:{name}]")).italics().color(Color32::GRAY));
        }
    }
}

fn paint_inlines(
    ui: &mut Ui,
    state: &mut PreviewState,
    spans: &[InlineSpan],
    size: f32,
    heading: bool,
) {
    if spans.is_empty() {
        ui.add_space(size);
        return;
    }
    let mut job = LayoutJob::default();
    let mut pending_images: Vec<(String, String)> = Vec::new();

    for sp in spans {
        if let Some(src) = &sp.image_src {
            pending_images.push((src.clone(), sp.text.clone()));
            continue;
        }
        if sp.hard_break {
            job.append("\n", 0.0, text_fmt(size, heading, sp));
            continue;
        }
        let mut fmt = text_fmt(size, heading, sp);
        if sp.code {
            fmt.font_id = FontId::monospace(size * 0.92);
            fmt.background = Color32::from_rgb(0xE2, 0xE8, 0xF0);
        }
        if sp.link_url.is_some() {
            fmt.color = Color32::from_rgb(0x0D, 0x7A, 0x6F);
            fmt.underline = egui::Stroke::new(1.0, Color32::from_rgb(0x0D, 0x7A, 0x6F));
        }
        job.append(&sp.text, 0.0, fmt);
    }

    if !job.is_empty() {
        let galley: std::sync::Arc<Galley> = ui.fonts(|f| f.layout_job(job));
        let size = galley.size();
        let (rect, resp) = ui.allocate_exact_size(size, Sense::click());
        ui.painter().galley(rect.min, galley, Color32::PLACEHOLDER);
        if resp.clicked() {
            if let Some(url) = spans.iter().find_map(|s| s.link_url.clone()) {
                ui.ctx().output_mut(|o| {
                    o.open_url = Some(egui::output::OpenUrl {
                        url,
                        new_tab: false,
                    });
                });
            }
        }
    }

    for (src, alt) in pending_images {
        show_image(ui, state, &src, &alt);
    }
}

fn text_fmt(size: f32, heading: bool, sp: &InlineSpan) -> TextFormat {
    let mut fmt = TextFormat {
        font_id: FontId::proportional(size),
        color: Color32::from_rgb(0x1C, 0x19, 0x17),
        ..Default::default()
    };
    if heading || sp.strong {
        fmt.color = Color32::from_rgb(0x02, 0x06, 0x17);
        fmt.extra_letter_spacing = 0.2;
    }
    if sp.emphasis {
        fmt.italics = true;
    }
    fmt
}

fn show_image(ui: &mut Ui, state: &mut PreviewState, src: &str, alt: &str) {
    if src.starts_with("http://") || src.starts_with("https://") {
        ui.label(
            RichText::new(format!("[远程图片已禁用] {alt}"))
                .color(Color32::GRAY)
                .italics(),
        );
        return;
    }
    let path = resolve_image_path(state.workspace_root.as_deref(), src);
    let failed = state.image_fail.get(src).copied().unwrap_or(false);
    if failed || path.as_ref().map(|p| !p.exists()).unwrap_or(true) {
        state.image_fail.insert(src.to_string(), true);
        ui.label(
            RichText::new(format!("[图片缺失: {alt}]"))
                .color(Color32::from_rgb(0xB9, 0x1C, 0x1C)),
        );
        return;
    }
    let path = path.unwrap();
    match load_texture(ui.ctx(), &path) {
        Some(tex) => {
            let max_w = ui.available_width().min(480.0);
            let size = tex.size_vec2();
            let scale = (max_w / size.x).min(1.0);
            ui.image((tex.id(), size * scale));
        }
        None => {
            state.image_fail.insert(src.to_string(), true);
            ui.label(RichText::new("[无法解码图片]").color(Color32::DARK_RED));
        }
    }
}

fn resolve_image_path(root: Option<&Path>, src: &str) -> Option<PathBuf> {
    let p = Path::new(src);
    if p.is_absolute() {
        return None;
    }
    let root = root?;
    let joined = root.join(p);
    let canon = joined.canonicalize().ok()?;
    let root_c = root.canonicalize().ok()?;
    if canon.starts_with(root_c) {
        Some(canon)
    } else {
        None
    }
}

fn load_texture(ctx: &egui::Context, path: &Path) -> Option<egui::TextureHandle> {
    let id = format!("img:{}", path.display());
    let bytes = std::fs::read(path).ok()?;
    let img = image::load_from_memory(&bytes).ok()?.to_rgba8();
    let size = [img.width() as usize, img.height() as usize];
    let color = egui::ColorImage::from_rgba_unmultiplied(size, img.as_raw());
    Some(ctx.load_texture(id, color, egui::TextureOptions::LINEAR))
}

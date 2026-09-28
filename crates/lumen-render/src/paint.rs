//! egui 预览：块选中、就地编辑、虚拟化。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use egui::{
    self, text::LayoutJob, Color32, FontId, Frame, Galley, Margin, RichText, ScrollArea, Sense,
    Stroke, TextFormat, Ui, Vec2,
};
use lumen_core::Dialect;

use crate::model::{InlineSpan, RenderBlock, RenderKind, RenderModel};
use crate::serialize::{
    apply_inline_format, inlines_to_md, parse_inlines_md, plain_text, plain_to_inlines,
    set_block_kind, InlineFormat,
};

const DEBOUNCE: Duration = Duration::from_millis(80);
const BODY_SIZE: f32 = 17.0;
const BODY_LINE: f32 = 1.7;
const READ_MAX_W: f32 = 820.0;
const TEAL: Color32 = Color32::from_rgb(0x0D, 0x7A, 0x6F);

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
    /// 选中块正在编辑的文本（行内块为 markdown）
    edit_buf: String,
    /// 代码块语言行
    code_info_buf: String,
    /// 表格单元格编辑：(block_idx, row, col)；row=0 为表头
    editing_cell: Option<(usize, usize, usize)>,
    /// 外部应读取：编辑产生了新的 markdown
    pub pending_markdown: Option<String>,
    link_dialog: bool,
    link_text_buf: String,
    link_url_buf: String,
    image_dialog: bool,
    image_alt_buf: String,
    image_path_buf: String,
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
            code_info_buf: String::new(),
            editing_cell: None,
            pending_markdown: None,
            link_dialog: false,
            link_text_buf: String::new(),
            link_url_buf: String::new(),
            image_dialog: false,
            image_alt_buf: String::new(),
            image_path_buf: String::new(),
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
        self.editing_cell = None;
        let bufs = self
            .model
            .as_ref()
            .and_then(|m| m.blocks.get(idx))
            .map(edit_bufs_from_block);
        if let Some((edit, info)) = bufs {
            self.selected = Some(idx);
            self.edit_buf = edit;
            self.code_info_buf = info;
        }
    }

    pub fn clear_selection(&mut self) {
        self.commit_edit_buf();
        self.selected = None;
        self.editing_cell = None;
        self.edit_buf.clear();
        self.code_info_buf.clear();
    }

    fn commit_edit_buf(&mut self) {
        // 表格单元格提交
        if let Some((bi, row, col)) = self.editing_cell {
            let dialect = self.dialect;
            let text = self.edit_buf.clone();
            let Some(model) = self.model.as_mut() else { return };
            if bi >= model.blocks.len() {
                return;
            }
            if let RenderKind::Table { headers, rows } = &mut model.blocks[bi].kind {
                let spans = if text.contains(['*', '`', '~', '[', '!']) {
                    parse_inlines_md(&text, dialect)
                } else {
                    plain_to_inlines(&text)
                };
                if row == 0 {
                    if col < headers.len() {
                        headers[col] = spans;
                    }
                } else {
                    let ri = row - 1;
                    if ri < rows.len() && col < rows[ri].len() {
                        rows[ri][col] = spans;
                    }
                }
                self.editing_cell = None;
                self.emit_md();
            }
            return;
        }

        let Some(idx) = self.selected else { return };
        let dialect = self.dialect;
        let Some(model) = self.model.as_mut() else { return };
        if idx >= model.blocks.len() {
            return;
        }
        let block = &mut model.blocks[idx];
        match &mut block.kind {
            RenderKind::CodeBlock { info, literal } => {
                let mut changed = false;
                if *literal != self.edit_buf {
                    *literal = self.edit_buf.clone();
                    changed = true;
                }
                if *info != self.code_info_buf {
                    *info = self.code_info_buf.clone();
                    changed = true;
                }
                if changed {
                    self.emit_md();
                }
            }
            RenderKind::ThematicBreak | RenderKind::HtmlBlock { .. } | RenderKind::Table { .. } => {}
            _ => {
                let old_md = inlines_to_md(&block.inlines);
                if old_md != self.edit_buf {
                    block.inlines = parse_inlines_md(&self.edit_buf, dialect);
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
        let bufs = edit_bufs_from_block(&model.blocks[idx]);
        self.edit_buf = bufs.0;
        self.code_info_buf = bufs.1;
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
        let bufs = edit_bufs_from_block(&model.blocks[idx]);
        self.edit_buf = bufs.0;
        self.code_info_buf = bufs.1;
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

    pub fn cmd_insert_table(&mut self, cols: usize, rows: usize) {
        self.commit_edit_buf();
        let cols = cols.max(1);
        let rows = rows.max(1);
        let empty = || vec![InlineSpan::plain("")];
        let headers: Vec<Vec<InlineSpan>> = (0..cols)
            .map(|i| vec![InlineSpan::plain(format!("列{}", i + 1))])
            .collect();
        let data: Vec<Vec<Vec<InlineSpan>>> = (0..rows)
            .map(|_| (0..cols).map(|_| empty()).collect())
            .collect();
        let kind = RenderKind::Table {
            headers: headers.clone(),
            rows: data.clone(),
        };
        let est = 28.0 + (rows + 1) as f32 * 24.0;
        let block = RenderBlock {
            kind,
            inlines: vec![],
            depth: 0,
            est_height: est,
            source_line: 0,
        };
        let Some(model) = self.model.as_mut() else {
            let mut m = RenderModel::build("", self.dialect);
            m.blocks.push(block);
            self.model = Some(m);
            self.selected = Some(0);
            self.emit_md();
            return;
        };
        let idx = self.selected.map(|i| i + 1).unwrap_or(model.blocks.len());
        model.blocks.insert(idx, block);
        self.selected = Some(idx);
        self.emit_md();
        self.force_rebuild_keep_sel(idx);
    }

    pub fn cmd_insert_image(&mut self, alt: &str, path: &str) {
        self.commit_edit_buf();
        let mut sp = InlineSpan::plain(if alt.is_empty() { "图片" } else { alt });
        sp.image_src = Some(path.to_string());
        let Some(model) = self.model.as_mut() else {
            let mut m = RenderModel::build("", self.dialect);
            m.blocks.push(RenderBlock {
                kind: RenderKind::Paragraph,
                inlines: vec![sp],
                depth: 0,
                est_height: 40.0,
                source_line: 0,
            });
            self.model = Some(m);
            self.selected = Some(0);
            self.emit_md();
            return;
        };
        if let Some(idx) = self.selected {
            if idx < model.blocks.len() {
                model.blocks[idx].inlines.push(sp);
                let bufs = edit_bufs_from_block(&model.blocks[idx]);
                self.edit_buf = bufs.0;
                self.code_info_buf = bufs.1;
                self.emit_md();
                self.force_rebuild_keep_sel(idx);
                return;
            }
        }
        let idx = model.blocks.len();
        model.blocks.push(RenderBlock {
            kind: RenderKind::Paragraph,
            inlines: vec![sp],
            depth: 0,
            est_height: 40.0,
            source_line: 0,
        });
        self.selected = Some(idx);
        self.emit_md();
        self.force_rebuild_keep_sel(idx);
    }

    pub fn cmd_insert_code_block(&mut self) {
        self.commit_edit_buf();
        let block = RenderBlock {
            kind: RenderKind::CodeBlock {
                info: String::new(),
                literal: String::new(),
            },
            inlines: vec![],
            depth: 0,
            est_height: 48.0,
            source_line: 0,
        };
        let Some(model) = self.model.as_mut() else {
            let mut m = RenderModel::build("", self.dialect);
            m.blocks.push(block);
            self.model = Some(m);
            self.selected = Some(0);
            self.code_info_buf.clear();
            self.edit_buf.clear();
            self.emit_md();
            return;
        };
        let idx = self.selected.map(|i| i + 1).unwrap_or(model.blocks.len());
        model.blocks.insert(idx, block);
        self.selected = Some(idx);
        self.code_info_buf.clear();
        self.edit_buf.clear();
        self.emit_md();
        self.force_rebuild_keep_sel(idx);
    }

    pub fn cmd_toggle_task(&mut self) {
        self.commit_edit_buf();
        let Some(idx) = self.selected else {
            // 无选中时插入新任务项
            let block = RenderBlock {
                kind: RenderKind::ListItem {
                    ordered: false,
                    start: 1,
                    index: 0,
                    checked: Some(false),
                },
                inlines: plain_to_inlines("任务"),
                depth: 1,
                est_height: 28.0,
                source_line: 0,
            };
            let Some(model) = self.model.as_mut() else {
                let mut m = RenderModel::build("", self.dialect);
                m.blocks.push(block);
                self.model = Some(m);
                self.selected = Some(0);
                self.emit_md();
                return;
            };
            let i = model.blocks.len();
            model.blocks.push(block);
            self.selected = Some(i);
            self.emit_md();
            self.force_rebuild_keep_sel(i);
            return;
        };
        let Some(model) = self.model.as_mut() else { return };
        if idx >= model.blocks.len() {
            return;
        }
        match &mut model.blocks[idx].kind {
            RenderKind::ListItem { checked, .. } => {
                *checked = match *checked {
                    Some(true) => Some(false),
                    Some(false) => Some(true),
                    None => Some(false),
                };
            }
            _ => {
                set_block_kind(
                    &mut model.blocks[idx],
                    RenderKind::ListItem {
                        ordered: false,
                        start: 1,
                        index: 0,
                        checked: Some(false),
                    },
                );
            }
        }
        let bufs = edit_bufs_from_block(&model.blocks[idx]);
        self.edit_buf = bufs.0;
        self.code_info_buf = bufs.1;
        self.emit_md();
        self.force_rebuild_keep_sel(idx);
    }

    pub fn cmd_table_add_row(&mut self) {
        self.commit_edit_buf();
        let Some(idx) = self.selected else { return };
        let Some(model) = self.model.as_mut() else { return };
        if let RenderKind::Table { headers, rows } = &mut model.blocks[idx].kind {
            let cols = headers.len().max(1);
            rows.push((0..cols).map(|_| vec![InlineSpan::plain("")]).collect());
            self.emit_md();
            self.force_rebuild_keep_sel(idx);
        }
    }

    pub fn cmd_table_remove_row(&mut self) {
        self.commit_edit_buf();
        let Some(idx) = self.selected else { return };
        let Some(model) = self.model.as_mut() else { return };
        if let RenderKind::Table { rows, .. } = &mut model.blocks[idx].kind {
            if !rows.is_empty() {
                rows.pop();
                self.emit_md();
                self.force_rebuild_keep_sel(idx);
            }
        }
    }

    pub fn cmd_table_add_col(&mut self) {
        self.commit_edit_buf();
        let Some(idx) = self.selected else { return };
        let Some(model) = self.model.as_mut() else { return };
        if let RenderKind::Table { headers, rows } = &mut model.blocks[idx].kind {
            headers.push(vec![InlineSpan::plain("")]);
            for row in rows.iter_mut() {
                row.push(vec![InlineSpan::plain("")]);
            }
            self.emit_md();
            self.force_rebuild_keep_sel(idx);
        }
    }

    pub fn cmd_table_remove_col(&mut self) {
        self.commit_edit_buf();
        let Some(idx) = self.selected else { return };
        let Some(model) = self.model.as_mut() else { return };
        if let RenderKind::Table { headers, rows } = &mut model.blocks[idx].kind {
            if headers.len() > 1 {
                headers.pop();
                for row in rows.iter_mut() {
                    if row.len() > headers.len() {
                        row.pop();
                    }
                }
                self.emit_md();
                self.force_rebuild_keep_sel(idx);
            }
        }
    }

    fn force_rebuild_keep_sel(&mut self, idx: usize) {
        if let Some(md) = self.pending_markdown.clone() {
            self.model = Some(RenderModel::build(&md, self.dialect));
            self.pending_src = md;
            if idx < self.model.as_ref().map(|m| m.blocks.len()).unwrap_or(0) {
                self.selected = Some(idx);
                if let Some(bufs) = self
                    .model
                    .as_ref()
                    .and_then(|m| m.blocks.get(idx))
                    .map(edit_bufs_from_block)
                {
                    self.edit_buf = bufs.0;
                    self.code_info_buf = bufs.1;
                }
            }
        }
    }

    pub fn open_link_dialog(&mut self) {
        self.link_text_buf.clear();
        if let Some(idx) = self.selected {
            if let Some(m) = &self.model {
                if idx < m.blocks.len() {
                    self.link_text_buf = plain_text(&m.blocks[idx].inlines);
                }
            }
        }
        self.link_url_buf.clear();
        self.link_dialog = true;
    }

    pub fn open_image_dialog(&mut self) {
        self.image_alt_buf.clear();
        self.image_path_buf.clear();
        self.image_dialog = true;
    }

    fn ensure_model(&mut self) {
        if self.selected.is_some() && self.pending_markdown.is_none() {
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
                let bufs = self
                    .model
                    .as_ref()
                    .and_then(|m| m.blocks.get(idx))
                    .map(edit_bufs_from_block);
                if let Some((edit, info)) = bufs {
                    self.selected = Some(idx);
                    self.edit_buf = edit;
                    self.code_info_buf = info;
                } else {
                    self.selected = None;
                }
            }
        }
    }
}

fn edit_bufs_from_block(block: &RenderBlock) -> (String, String) {
    let edit = block_edit_text(block);
    let info = match &block.kind {
        RenderKind::CodeBlock { info, .. } => info.clone(),
        _ => String::new(),
    };
    (edit, info)
}

fn block_edit_text(b: &RenderBlock) -> String {
    match &b.kind {
        RenderKind::CodeBlock { literal, .. } => literal.clone(),
        RenderKind::HtmlBlock { literal } => literal.clone(),
        RenderKind::ThematicBreak | RenderKind::Table { .. } => String::new(),
        _ => inlines_to_md(&b.inlines),
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
                ui.label("文本");
                ui.text_edit_singleline(&mut state.link_text_buf);
                ui.label("URL");
                ui.text_edit_singleline(&mut state.link_url_buf);
                ui.horizontal(|ui| {
                    if ui.button("确定").clicked() {
                        let url = state.link_url_buf.clone();
                        let text = state.link_text_buf.clone();
                        state.link_dialog = false;
                        if let Some(idx) = state.selected {
                            if let Some(model) = state.model.as_mut() {
                                if idx < model.blocks.len() {
                                    let mut sp = InlineSpan::plain(if text.is_empty() {
                                        url.clone()
                                    } else {
                                        text
                                    });
                                    sp.link_url = Some(url);
                                    model.blocks[idx].inlines = vec![sp];
                                    let bufs = edit_bufs_from_block(&model.blocks[idx]);
                                    state.edit_buf = bufs.0;
                                    state.code_info_buf = bufs.1;
                                    state.emit_md();
                                    state.force_rebuild_keep_sel(idx);
                                    dirty = true;
                                }
                            }
                        } else {
                            state.cmd_inline(InlineFormat::Link(url));
                            dirty = true;
                        }
                    }
                    if ui.button("取消").clicked() {
                        state.link_dialog = false;
                    }
                });
            });
    }

    if state.image_dialog {
        egui::Window::new("插入图片")
            .collapsible(false)
            .resizable(false)
            .show(ui.ctx(), |ui| {
                ui.label("替代文本");
                ui.text_edit_singleline(&mut state.image_alt_buf);
                ui.label("相对路径");
                ui.text_edit_singleline(&mut state.image_path_buf);
                ui.horizontal(|ui| {
                    if ui.button("确定").clicked() {
                        let alt = state.image_alt_buf.clone();
                        let path = state.image_path_buf.clone();
                        state.image_dialog = false;
                        if !path.is_empty() {
                            state.cmd_insert_image(&alt, &path);
                            dirty = true;
                        }
                    }
                    if ui.button("取消").clicked() {
                        state.image_dialog = false;
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

    // 居中阅读栏 ≈820
    let content_w = (width - 16.0).min(READ_MAX_W).max(120.0);
    let side_pad = ((width - content_w) * 0.5).max(0.0);
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
    let mut cell_click: Option<(usize, usize, usize)> = None;
    let mut toggle_task_idx: Option<usize> = None;
    let mut measured: Vec<(usize, f32)> = Vec::new();

    scroll.show_viewport(ui, |ui, viewport| {
        ui.add_space(side_pad);
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
            if y + drawn_h > y1 && state.selected != Some(i) && state.editing_cell.map(|(b, _, _)| b) != Some(i)
            {
                let rest: f32 = model.blocks[i..].iter().map(|b| b.est_height).sum();
                ui.allocate_exact_size(Vec2::new(content_w, rest), Sense::hover());
                break;
            }
            let selected = state.selected == Some(i);
            let before = ui.cursor().top();

            ui.horizontal(|ui| {
                // 选中条 + 引用竖条
                let quote_depth = if matches!(block.kind, RenderKind::BlockQuote)
                    || (block.depth > 0
                        && matches!(
                            block.kind,
                            RenderKind::Paragraph | RenderKind::Heading { .. }
                        ))
                {
                    block.depth.max(1)
                } else if block.depth > 0
                    && !matches!(
                        block.kind,
                        RenderKind::ListItem { .. } | RenderKind::CodeBlock { .. }
                    )
                {
                    // depth 可能来自 blockquote
                    1u16
                } else {
                    0u16
                };

                let bar_w = if selected { 3.0 } else { 0.0 };
                if selected {
                    let (bar, _) = ui.allocate_exact_size(
                        Vec2::new(bar_w, block.est_height.max(22.0)),
                        Sense::hover(),
                    );
                    ui.painter().rect_filled(bar, 1.0, TEAL);
                }
                if quote_depth > 0 {
                    for _ in 0..quote_depth.min(3) {
                        let (qbar, _) = ui.allocate_exact_size(
                            Vec2::new(3.0, block.est_height.max(22.0)),
                            Sense::hover(),
                        );
                        ui.painter().rect_filled(qbar, 0.0, TEAL);
                        ui.add_space(6.0);
                    }
                } else {
                    ui.add_space(8.0);
                }

                let avail = (content_w - 28.0).max(80.0);
                ui.vertical(|ui| {
                    ui.set_max_width(avail);
                    if state.editable && selected && !matches!(block.kind, RenderKind::Table { .. })
                    {
                        paint_block_editor(ui, state, block, &mut edit_changed);
                    } else if matches!(block.kind, RenderKind::Table { .. }) {
                        paint_table(
                            ui,
                            state,
                            i,
                            block,
                            avail,
                            &mut cell_click,
                            &mut clicked,
                            &mut edit_changed,
                        );
                    } else {
                        let resp = ui.allocate_ui(Vec2::new(avail, 0.0), |ui| {
                            paint_block_view(ui, state, i, block, avail, &mut toggle_task_idx);
                        });
                        if state.editable && resp.response.clicked() {
                            clicked = Some(i);
                        }
                    }
                });
            });

            let after = ui.cursor().top();
            let measured_h = (after - before).max(block.est_height * 0.5);
            measured.push((i, measured_h));
            drawn_h += measured_h;
        }
    });

    // 用实测高度更新虚拟化估计
    if let Some(m) = state.model.as_mut() {
        let mut changed = false;
        for (i, h) in measured {
            if i < m.blocks.len() && (m.blocks[i].est_height - h).abs() > 2.0 {
                m.blocks[i].est_height = h;
                changed = true;
            }
        }
        if changed {
            m.recompute_total_height();
        }
    }

    if let Some(i) = toggle_task_idx {
        if let Some(m) = state.model.as_mut() {
            if let RenderKind::ListItem { checked, .. } = &mut m.blocks[i].kind {
                *checked = Some(!checked.unwrap_or(false));
                state.emit_md();
                dirty = true;
            }
        }
    }

    if let Some((bi, row, col)) = cell_click {
        state.commit_edit_buf();
        state.selected = Some(bi);
        state.editing_cell = Some((bi, row, col));
        if let Some(m) = &state.model {
            if let RenderKind::Table { headers, rows } = &m.blocks[bi].kind {
                let spans = if row == 0 {
                    headers.get(col).cloned().unwrap_or_default()
                } else {
                    rows.get(row - 1)
                        .and_then(|r| r.get(col))
                        .cloned()
                        .unwrap_or_default()
                };
                state.edit_buf = plain_text(&spans);
            }
        }
        dirty = true;
    }

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

fn paint_block_editor(
    ui: &mut Ui,
    state: &mut PreviewState,
    block: &RenderBlock,
    changed: &mut bool,
) -> bool {
    match &block.kind {
        RenderKind::ThematicBreak => {
            ui.separator();
            ui.label(RichText::new("分隔线").small().color(Color32::GRAY));
        }
        RenderKind::CodeBlock { .. } => {
            ui.horizontal(|ui| {
                ui.label(RichText::new("语言").small().color(Color32::GRAY));
                let resp = ui.add(
                    egui::TextEdit::singleline(&mut state.code_info_buf)
                        .desired_width(120.0)
                        .hint_text("rust"),
                );
                if resp.changed() || resp.lost_focus() {
                    *changed = true;
                }
            });
            let resp = ui.add(
                egui::TextEdit::multiline(&mut state.edit_buf)
                    .desired_width(f32::INFINITY)
                    .font(FontId::monospace(13.0))
                    .code_editor(),
            );
            if resp.changed() || resp.lost_focus() {
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
                    .font(FontId::proportional(BODY_SIZE)),
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

fn paint_block_view(
    ui: &mut Ui,
    state: &mut PreviewState,
    block_idx: usize,
    block: &RenderBlock,
    width: f32,
    toggle_task: &mut Option<usize>,
) {
    let indent = match &block.kind {
        RenderKind::ListItem { .. } => block.depth.saturating_sub(1) as f32 * 12.0,
        _ => 0.0,
    };
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
            paint_inlines(ui, state, &block.inlines, BODY_SIZE, false);
            ui.add_space(BODY_SIZE * (BODY_LINE - 1.0));
        }
        RenderKind::ListItem {
            ordered,
            start,
            index,
            checked,
        } => {
            ui.horizontal_top(|ui| {
                if let Some(is_checked) = checked {
                    let label = if *is_checked { "☑" } else { "☐" };
                    if ui
                        .add(egui::Button::new(RichText::new(label).size(BODY_SIZE)).frame(false))
                        .clicked()
                    {
                        *toggle_task = Some(block_idx);
                    }
                } else {
                    let bullet = if *ordered {
                        format!("{}.", start + index)
                    } else {
                        "•".into()
                    };
                    ui.label(RichText::new(bullet).strong().color(TEAL));
                }
                ui.add_space(6.0);
                ui.vertical(|ui| {
                    paint_inlines(ui, state, &block.inlines, BODY_SIZE, false);
                });
            });
            ui.add_space(4.0);
        }
        RenderKind::CodeBlock { info, literal } => {
            if !info.is_empty() {
                ui.label(RichText::new(info).small().color(Color32::GRAY));
            }
            Frame::none()
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
        RenderKind::Table { .. } => {}
        RenderKind::ExtensionStub { name } => {
            ui.label(
                RichText::new(format!("[扩展:{name}]"))
                    .italics()
                    .color(Color32::GRAY),
            );
        }
    }
}

fn paint_table(
    ui: &mut Ui,
    state: &mut PreviewState,
    block_idx: usize,
    block: &RenderBlock,
    width: f32,
    cell_click: &mut Option<(usize, usize, usize)>,
    block_click: &mut Option<usize>,
    edit_changed: &mut bool,
) {
    let RenderKind::Table { headers, rows } = &block.kind else {
        return;
    };
    let cols = headers
        .len()
        .max(rows.iter().map(|r| r.len()).max().unwrap_or(0))
        .max(1);
    let col_w = ((width - 4.0) / cols as f32).max(40.0);
    let border = Stroke::new(1.0, Color32::from_rgb(0xD8, 0xDE, 0xE6));

    // clone structure for iteration (avoid borrow issues while editing)
    let header_cells = headers.clone();
    let body_rows = rows.clone();

    let resp = ui.allocate_ui(Vec2::new(width, 0.0), |ui| {
        paint_table_row(
            ui,
            state,
            block_idx,
            &header_cells,
            0,
            true,
            cols,
            col_w,
            border,
            cell_click,
            edit_changed,
        );
        for (ri, row) in body_rows.iter().enumerate() {
            paint_table_row(
                ui,
                state,
                block_idx,
                row,
                ri + 1,
                false,
                cols,
                col_w,
                border,
                cell_click,
                edit_changed,
            );
        }
        if state.selected == Some(block_idx) || state.editing_cell.map(|(b, _, _)| b) == Some(block_idx)
        {
            ui.horizontal(|ui| {
                if ui.small_button("+行").clicked() {
                    state.selected = Some(block_idx);
                    state.cmd_table_add_row();
                }
                if ui.small_button("-行").clicked() {
                    state.selected = Some(block_idx);
                    state.cmd_table_remove_row();
                }
                if ui.small_button("+列").clicked() {
                    state.selected = Some(block_idx);
                    state.cmd_table_add_col();
                }
                if ui.small_button("-列").clicked() {
                    state.selected = Some(block_idx);
                    state.cmd_table_remove_col();
                }
            });
        }
    });
    if state.editable && resp.response.clicked() && cell_click.is_none() {
        *block_click = Some(block_idx);
    }
    ui.add_space(8.0);
}

fn paint_table_row(
    ui: &mut Ui,
    state: &mut PreviewState,
    block_idx: usize,
    cells: &[Vec<InlineSpan>],
    row_i: usize,
    header: bool,
    cols: usize,
    col_w: f32,
    border: Stroke,
    cell_click: &mut Option<(usize, usize, usize)>,
    edit_changed: &mut bool,
) {
    ui.horizontal(|ui| {
        for c in 0..cols {
            let spans = cells.get(c).cloned().unwrap_or_default();
            let editing = state.editing_cell == Some((block_idx, row_i, c));
            Frame::none()
                .stroke(border)
                .inner_margin(Margin::symmetric(6.0, 4.0))
                .fill(if header {
                    Color32::from_rgb(0xF0, 0xF2, 0xF5)
                } else {
                    Color32::WHITE
                })
                .show(ui, |ui| {
                    ui.set_min_width(col_w - 4.0);
                    ui.set_max_width(col_w - 4.0);
                    if editing {
                        let resp = ui.add(
                            egui::TextEdit::singleline(&mut state.edit_buf)
                                .desired_width(col_w - 12.0)
                                .font(FontId::proportional(BODY_SIZE * 0.9)),
                        );
                        // 失焦时提交，避免每键清空 editing_cell
                        if resp.lost_focus() {
                            *edit_changed = true;
                        }
                    } else {
                        let text = plain_text(&spans);
                        let label = if text.is_empty() { " " } else { text.as_str() };
                        let rich = if header {
                            RichText::new(label).strong().size(BODY_SIZE * 0.9)
                        } else {
                            RichText::new(label).size(BODY_SIZE * 0.9)
                        };
                        let resp = ui.add(
                            egui::Button::new(rich)
                                .frame(false)
                                .min_size(Vec2::new(col_w - 16.0, 20.0)),
                        );
                        if state.editable && resp.clicked() {
                            *cell_click = Some((block_idx, row_i, c));
                        }
                    }
                });
        }
    });
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
    job.wrap.max_width = ui.available_width();
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
            fmt.color = TEAL;
            fmt.underline = Stroke::new(1.0, TEAL);
        }
        if sp.strikethrough {
            fmt.strikethrough = Stroke::new(1.0, Color32::from_rgb(0x1C, 0x19, 0x17));
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
        line_height: Some(size * BODY_LINE),
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

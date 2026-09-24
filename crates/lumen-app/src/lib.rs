//! Lumen MD：Typora 式菜单 + 浏览即编辑。

mod fonts;
mod ime;
mod theme;

use eframe::egui::{self, Align, Color32, FontId, Frame, Layout, Margin, RichText, ScrollArea, Stroke, Vec2};
use lumen_core::{Dialect, FileEntry, MarkdownEngine, Workspace};
use lumen_render::{InlineFormat, PreviewState, RenderKind};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::{Duration, Instant};

const UNDO_MAX: usize = 40;

pub struct LumenApp {
    workspace: Option<Workspace>,
    tree_cache: Vec<FileEntry>,
    tree_rel: String,
    current_rel: Option<String>,
    source: String,
    dirty: bool,
    status: String,
    preview: PreviewState,
    show_tree: bool,
    show_outline: bool,
    /// 视图 → 源代码模式
    source_mode: bool,
    focus_mode: bool,
    root_input: String,
    theme_applied: bool,
    status_flash_at: Instant,
    undo_stack: VecDeque<String>,
    redo_stack: VecDeque<String>,
    show_help: bool,
    show_about: bool,
    save_as_name: String,
    show_save_as: bool,
}

impl Default for LumenApp {
    fn default() -> Self {
        Self {
            workspace: None,
            tree_cache: Vec::new(),
            tree_rel: String::new(),
            current_rel: None,
            source: String::new(),
            dirty: false,
            status: "欢迎使用 Lumen MD — 点击正文即可编辑".into(),
            preview: PreviewState::default(),
            show_tree: true,
            show_outline: true,
            source_mode: false,
            focus_mode: false,
            root_input: String::new(),
            theme_applied: false,
            status_flash_at: Instant::now(),
            undo_stack: VecDeque::new(),
            redo_stack: VecDeque::new(),
            show_help: false,
            show_about: false,
            save_as_name: String::new(),
            show_save_as: false,
        }
    }
}

impl LumenApp {
    pub fn new(cc: &eframe::CreationContext<'_>) -> Self {
        fonts::configure_cjk_fonts(&cc.egui_ctx);
        theme::apply(&cc.egui_ctx);
        let mut app = Self::default();
        app.preview.dialect = Dialect::Lumen;
        app.preview.editable = true;
        app.theme_applied = true;
        app
    }

    fn set_status(&mut self, s: impl Into<String>) {
        self.status = s.into();
        self.status_flash_at = Instant::now();
    }

    fn push_undo(&mut self) {
        self.undo_stack.push_back(self.source.clone());
        if self.undo_stack.len() > UNDO_MAX {
            self.undo_stack.pop_front();
        }
        self.redo_stack.clear();
    }

    fn undo(&mut self) {
        if let Some(prev) = self.undo_stack.pop_back() {
            self.redo_stack.push_back(self.source.clone());
            self.apply_source(prev, false);
            self.set_status("已撤销");
        }
    }

    fn redo(&mut self) {
        if let Some(next) = self.redo_stack.pop_back() {
            self.undo_stack.push_back(self.source.clone());
            self.apply_source(next, false);
            self.set_status("已重做");
        }
    }

    fn apply_source(&mut self, text: String, record_undo: bool) {
        if record_undo {
            self.push_undo();
        }
        self.source = text;
        self.dirty = true;
        self.preview.clear_selection();
        self.preview.notify_source(&self.source);
        self.preview.force_rebuild();
    }

    fn sync_from_preview(&mut self) {
        if let Some(md) = self.preview.take_pending_markdown() {
            if md != self.source {
                self.push_undo();
                self.source = md;
                self.dirty = true;
                self.preview.notify_source(&self.source);
            }
        }
    }

    fn open_workspace(&mut self, path: PathBuf) {
        match Workspace::open(&path) {
            Ok(ws) => {
                self.root_input = ws.root().display().to_string();
                self.preview
                    .set_workspace_root(Some(ws.root().to_path_buf()));
                self.workspace = Some(ws);
                self.current_rel = None;
                self.source.clear();
                self.dirty = false;
                self.tree_rel.clear();
                self.undo_stack.clear();
                self.redo_stack.clear();
                self.refresh_tree();
                self.set_status("已打开工作区");
            }
            Err(e) => self.set_status(format!("打开失败: {e}")),
        }
    }

    fn refresh_tree(&mut self) {
        let Some(ws) = &self.workspace else {
            self.tree_cache.clear();
            return;
        };
        match ws.list_dir(&self.tree_rel) {
            Ok(list) => self.tree_cache = list,
            Err(e) => self.set_status(format!("列表失败: {e}")),
        }
    }

    fn open_file(&mut self, rel: &str) {
        let Some(ws) = &self.workspace else { return };
        if self.dirty {
            self.set_status("有未保存修改 — 请先保存，或编辑→放弃更改");
            return;
        }
        match ws.read_text(rel) {
            Ok(text) => {
                self.current_rel = Some(rel.to_string());
                self.source = text;
                self.dirty = false;
                self.undo_stack.clear();
                self.redo_stack.clear();
                self.preview.clear_selection();
                self.preview.notify_source(&self.source);
                self.preview.force_rebuild();
                // 定位文件树到所在目录
                if let Some(i) = rel.rfind('/') {
                    self.tree_rel = rel[..i].to_string();
                } else {
                    self.tree_rel.clear();
                }
                self.refresh_tree();
                self.set_status(format!("已打开 {rel}"));
            }
            Err(e) => self.set_status(format!("读取失败: {e}")),
        }
    }

    /// 拖放：文件夹 → 工作区；.md/.markdown/.txt → 以其父目录为工作区并打开文件。
    fn open_dropped_path(&mut self, path: PathBuf) {
        let Ok(path) = path.canonicalize() else {
            self.set_status(format!("无法解析路径: {}", path.display()));
            return;
        };
        if path.is_dir() {
            self.open_workspace(path);
            return;
        }
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !(name.ends_with(".md")
            || name.ends_with(".markdown")
            || name.ends_with(".txt"))
        {
            self.set_status("仅支持拖入文件夹或 .md / .markdown / .txt 文件");
            return;
        }
        let Some(parent) = path.parent() else {
            self.set_status("无法确定文件所在目录");
            return;
        };
        // 若已在某工作区内且文件在其下，直接相对打开
        let mut rel_opt: Option<String> = None;
        if let Some(ws) = &self.workspace {
            if let Ok(root) = ws.root().canonicalize() {
                if let Ok(stripped) = path.strip_prefix(&root) {
                    rel_opt = Some(stripped.to_string_lossy().replace('\\', "/"));
                }
            }
        }
        if let Some(rel) = rel_opt {
            self.open_file(&rel);
            return;
        }
        // 否则以父目录为工作区再打开
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("note.md")
            .to_string();
        self.open_workspace(parent.to_path_buf());
        if self.workspace.is_some() {
            self.open_file(&file_name);
        }
    }

    fn poll_file_drop(&mut self, ctx: &egui::Context) {
        let hovered = ctx.input(|i| !i.raw.hovered_files.is_empty());
        let dropped: Vec<PathBuf> = ctx.input(|i| {
            i.raw
                .dropped_files
                .iter()
                .filter_map(|f| f.path.clone())
                .collect()
        });
        if hovered && dropped.is_empty() {
            // 仅提示，不打断编辑
            ctx.output_mut(|o| {
                o.cursor_icon = egui::CursorIcon::Copy;
            });
        }
        if dropped.is_empty() {
            return;
        }
        // 取第一个有效路径
        if let Some(path) = dropped.into_iter().next() {
            self.open_dropped_path(path);
        }
        ctx.input_mut(|i| i.raw.dropped_files.clear());
    }

    fn save(&mut self) {
        if self.workspace.is_none() {
            self.set_status("未打开工作区");
            return;
        }
        let Some(rel) = self.current_rel.clone() else {
            self.set_status("未打开文件");
            return;
        };
        self.preview.clear_selection();
        self.sync_from_preview();
        let _ = MarkdownEngine::new(self.preview.dialect).validate(&self.source);
        let source = self.source.clone();
        match self.workspace.as_ref().unwrap().write_text(&rel, &source) {
            Ok(()) => {
                self.dirty = false;
                self.set_status(format!("已保存 {rel}"));
            }
            Err(e) => self.set_status(format!("保存失败: {e}")),
        }
    }

    fn save_as(&mut self, name: &str) {
        let name = name.trim();
        if name.is_empty() {
            self.set_status("文件名不能为空");
            return;
        }
        if self.workspace.is_none() {
            return;
        }
        let rel = if self.tree_rel.is_empty() {
            name.to_string()
        } else {
            format!("{}/{}", self.tree_rel, name)
        };
        self.preview.clear_selection();
        self.sync_from_preview();
        let source = self.source.clone();
        let ws = self.workspace.as_ref().unwrap();
        if let Err(e) = ws.create_file(&rel) {
            if !e.to_string().contains("已存在") {
                self.set_status(format!("{e}"));
                return;
            }
        }
        match ws.write_text(&rel, &source) {
            Ok(()) => {
                self.current_rel = Some(rel.clone());
                self.dirty = false;
                self.refresh_tree();
                self.set_status(format!("已另存为 {rel}"));
            }
            Err(e) => self.set_status(format!("另存失败: {e}")),
        }
    }

    fn discard_changes(&mut self) {
        if let Some(rel) = self.current_rel.clone() {
            if let Some(ws) = &self.workspace {
                if let Ok(text) = ws.read_text(&rel) {
                    self.source = text;
                    self.dirty = false;
                    self.preview.clear_selection();
                    self.preview.notify_source(&self.source);
                    self.preview.force_rebuild();
                    self.set_status("已放弃更改");
                    return;
                }
            }
        }
        self.dirty = false;
        self.source.clear();
        self.current_rel = None;
        self.preview.clear_selection();
        self.preview.notify_source("");
        self.preview.force_rebuild();
        self.set_status("已放弃");
    }

    fn file_title(&self) -> String {
        match &self.current_rel {
            Some(r) => {
                let name = r.rsplit('/').next().unwrap_or(r);
                if self.dirty {
                    format!("{name} · 未保存")
                } else {
                    name.to_string()
                }
            }
            None => "未选择文件".into(),
        }
    }

    fn draw_menus(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        // 文件
        ui.menu_button("文件(F)", |ui| {
            if ui.button("打开文件夹…").clicked() {
                self.set_status("请在顶栏路径框粘贴文件夹路径后点「进入」");
                ui.close_menu();
            }
            ui.separator();
            if ui
                .add_enabled(self.current_rel.is_some(), egui::Button::new("保存\tCtrl+S"))
                .clicked()
            {
                self.save();
                ui.close_menu();
            }
            if ui
                .add_enabled(self.workspace.is_some(), egui::Button::new("另存为…"))
                .clicked()
            {
                self.save_as_name = self
                    .current_rel
                    .as_ref()
                    .and_then(|r| r.rsplit('/').next())
                    .unwrap_or("untitled.md")
                    .to_string();
                self.show_save_as = true;
                ui.close_menu();
            }
            ui.separator();
            if ui.button("退出").clicked() {
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                ui.close_menu();
            }
        });

        // 编辑
        ui.menu_button("编辑(E)", |ui| {
            if ui.button("撤销\tCtrl+Z").clicked() {
                self.undo();
                ui.close_menu();
            }
            if ui.button("重做\tCtrl+Y").clicked() {
                self.redo();
                ui.close_menu();
            }
            ui.separator();
            if ui.button("插入段落").clicked() {
                self.preview.cmd_insert_paragraph();
                self.sync_from_preview();
                ui.close_menu();
            }
            if ui
                .add_enabled(self.dirty, egui::Button::new("放弃更改"))
                .clicked()
            {
                self.discard_changes();
                ui.close_menu();
            }
        });

        // 段落
        ui.menu_button("段落(P)", |ui| {
            let has = self.preview.selected.is_some();
            if ui
                .add_enabled(has, egui::Button::new("正文"))
                .clicked()
            {
                self.preview.cmd_set_paragraph(RenderKind::Paragraph);
                self.sync_from_preview();
                ui.close_menu();
            }
            for level in 1u8..=6 {
                if ui
                    .add_enabled(has, egui::Button::new(format!("标题 {level}")))
                    .clicked()
                {
                    self.preview
                        .cmd_set_paragraph(RenderKind::Heading { level });
                    self.sync_from_preview();
                    ui.close_menu();
                }
            }
            ui.separator();
            if ui
                .add_enabled(has, egui::Button::new("无序列表"))
                .clicked()
            {
                self.preview.cmd_set_paragraph(RenderKind::ListItem {
                    ordered: false,
                    start: 1,
                    index: 0,
                });
                self.sync_from_preview();
                ui.close_menu();
            }
            if ui
                .add_enabled(has, egui::Button::new("有序列表"))
                .clicked()
            {
                self.preview.cmd_set_paragraph(RenderKind::ListItem {
                    ordered: true,
                    start: 1,
                    index: 0,
                });
                self.sync_from_preview();
                ui.close_menu();
            }
            if ui
                .add_enabled(has, egui::Button::new("代码块"))
                .clicked()
            {
                self.preview.cmd_set_paragraph(RenderKind::CodeBlock {
                    info: String::new(),
                    literal: String::new(),
                });
                self.sync_from_preview();
                ui.close_menu();
            }
            if ui.button("分隔线").clicked() {
                self.preview.cmd_insert_break();
                self.sync_from_preview();
                ui.close_menu();
            }
        });

        // 格式
        ui.menu_button("格式(O)", |ui| {
            let has = self.preview.selected.is_some();
            if ui
                .add_enabled(has, egui::Button::new("加粗\tCtrl+B"))
                .clicked()
            {
                self.preview.cmd_inline(InlineFormat::Strong);
                self.sync_from_preview();
                ui.close_menu();
            }
            if ui
                .add_enabled(has, egui::Button::new("斜体\tCtrl+I"))
                .clicked()
            {
                self.preview.cmd_inline(InlineFormat::Emphasis);
                self.sync_from_preview();
                ui.close_menu();
            }
            if ui
                .add_enabled(has, egui::Button::new("行内代码"))
                .clicked()
            {
                self.preview.cmd_inline(InlineFormat::Code);
                self.sync_from_preview();
                ui.close_menu();
            }
            if ui
                .add_enabled(has, egui::Button::new("超链接…"))
                .clicked()
            {
                self.preview.open_link_dialog();
                ui.close_menu();
            }
            if ui
                .add_enabled(has, egui::Button::new("清除格式"))
                .clicked()
            {
                self.preview.cmd_inline(InlineFormat::Clear);
                self.sync_from_preview();
                ui.close_menu();
            }
        });

        // 视图
        ui.menu_button("视图(V)", |ui| {
            ui.checkbox(&mut self.show_tree, "文件树");
            ui.checkbox(&mut self.show_outline, "大纲");
            if ui
                .checkbox(&mut self.source_mode, "源代码模式")
                .changed()
            {
                self.preview.editable = !self.source_mode;
                if self.source_mode {
                    self.preview.clear_selection();
                    self.set_status("源代码模式（高级）");
                } else {
                    self.preview.notify_source(&self.source);
                    self.preview.force_rebuild();
                    self.set_status("浏览即编辑");
                }
            }
            ui.checkbox(&mut self.focus_mode, "专注模式");
        });

        // 主题
        ui.menu_button("主题(T)", |ui| {
            if ui.button("纸墨（当前）").clicked() {
                theme::apply(ui.ctx());
                ui.close_menu();
            }
            ui.add_enabled(false, egui::Button::new("简洁浅色（即将推出）"));
        });

        // 帮助
        ui.menu_button("帮助(H)", |ui| {
            if ui.button("使用说明").clicked() {
                self.show_help = true;
                ui.close_menu();
            }
            if ui.button("关于").clicked() {
                self.show_about = true;
                ui.close_menu();
            }
        });
    }
}

impl eframe::App for LumenApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if !self.theme_applied {
            theme::apply(ctx);
            self.theme_applied = true;
        }
        ime::sanitize_cjk_ime_events(ctx);
        self.poll_file_drop(ctx);

        // 拖放悬停提示条
        let hovering_drop = ctx.input(|i| !i.raw.hovered_files.is_empty());
        if hovering_drop {
            egui::Area::new(egui::Id::new("drop_overlay"))
                .fixed_pos(egui::pos2(0.0, 0.0))
                .order(egui::Order::Foreground)
                .show(ctx, |ui| {
                    let screen = ctx.screen_rect();
                    ui.allocate_ui_at_rect(screen, |ui| {
                        ui.painter().rect_filled(
                            screen,
                            0.0,
                            Color32::from_rgba_unmultiplied(0x0D, 0x7A, 0x6F, 40),
                        );
                        ui.centered_and_justified(|ui| {
                            ui.label(
                                RichText::new("释放以打开文件夹或 Markdown 文件")
                                    .size(22.0)
                                    .strong()
                                    .color(theme::INK),
                            );
                        });
                    });
                });
        }

        // 快捷键
        let (ctrl, shift, key_s, key_z, key_y, key_b, key_i) = ctx.input(|i| {
            (
                i.modifiers.ctrl,
                i.modifiers.shift,
                i.key_pressed(egui::Key::S),
                i.key_pressed(egui::Key::Z),
                i.key_pressed(egui::Key::Y),
                i.key_pressed(egui::Key::B),
                i.key_pressed(egui::Key::I),
            )
        });
        if ctrl && key_s && !shift {
            self.save();
        }
        if ctrl && key_z && !shift {
            self.undo();
        }
        if ctrl && key_y {
            self.redo();
        }
        if ctrl && key_b && self.preview.selected.is_some() {
            self.preview.cmd_inline(InlineFormat::Strong);
            self.sync_from_preview();
        }
        if ctrl && key_i && self.preview.selected.is_some() {
            self.preview.cmd_inline(InlineFormat::Emphasis);
            self.sync_from_preview();
        }

        // 顶栏：品牌 + 菜单 + 路径
        egui::TopBottomPanel::top("top")
            .frame(theme::top_bar_frame())
            .show(ctx, |ui| {
                ui.horizontal_centered(|ui| {
                    ui.label(theme::brand_on_ink(16.0));
                    ui.add_space(12.0);
                    ui.visuals_mut().override_text_color = Some(theme::TEXT_ON_INK);
                    self.draw_menus(ui, ctx);
                    ui.visuals_mut().override_text_color = None;

                    ui.add_space(12.0);
                    ui.add(
                        egui::TextEdit::singleline(&mut self.root_input)
                            .desired_width(260.0)
                            .hint_text("工作区路径…"),
                    );
                    if theme::primary_button(ui, "进入").clicked() {
                        let t = self.root_input.trim();
                        if !t.is_empty() {
                            self.open_workspace(PathBuf::from(t));
                        }
                    }
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if self.dirty {
                            ui.label(
                                RichText::new("未保存")
                                    .size(12.0)
                                    .color(Color32::from_rgb(0xFC, 0xA5, 0xA5)),
                            );
                        }
                        ui.label(
                            RichText::new(self.file_title())
                                .size(12.5)
                                .color(theme::TEXT_ON_INK),
                        );
                    });
                });
            });

        egui::TopBottomPanel::bottom("status")
            .frame(theme::status_frame())
            .exact_height(28.0)
            .show(ctx, |ui| {
                ui.horizontal_centered(|ui| {
                    ui.label(RichText::new(&self.status).size(12.0).color(theme::TEXT));
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.label(
                            RichText::new(format!("{} 字", self.source.chars().count()))
                                .size(12.0)
                                .color(theme::TEXT_MUTED),
                        );
                        ui.label(
                            RichText::new(if self.source_mode {
                                "源代码"
                            } else {
                                "所见即所得"
                            })
                            .size(12.0)
                            .color(theme::TEXT_MUTED),
                        );
                    });
                });
            });

        let show_tree = self.show_tree && !self.focus_mode;
        let show_outline = self.show_outline && !self.focus_mode;

        if show_tree {
            egui::SidePanel::left("tree")
                .default_width(240.0)
                .frame(theme::sidebar_frame())
                .show(ctx, |ui| {
                    theme::panel_title(ui, "资源管理器");
                    if self.workspace.is_none() {
                        ui.label(theme::muted("文件 → 或粘贴路径后「进入」"));
                        return;
                    }
                    ui.horizontal(|ui| {
                        if ui.small_button("刷新").clicked() {
                            self.refresh_tree();
                        }
                        if !self.tree_rel.is_empty() && ui.small_button("上级").clicked() {
                            if let Some(i) = self.tree_rel.rfind('/') {
                                self.tree_rel.truncate(i);
                            } else {
                                self.tree_rel.clear();
                            }
                            self.refresh_tree();
                        }
                    });
                    ui.separator();
                    ScrollArea::vertical().show(ui, |ui| {
                        let mut open_dir = None;
                        let mut open_file = None;
                        for ent in &self.tree_cache {
                            let selected =
                                self.current_rel.as_deref() == Some(ent.rel_path.as_str());
                            let prefix = if ent.is_dir { "▸  " } else { "    " };
                            let label = format!("{prefix}{}", ent.name);
                            let fill = if selected {
                                theme::SIDEBAR_ACTIVE
                            } else {
                                Color32::TRANSPARENT
                            };
                            if ui
                                .add(
                                    egui::Button::new(
                                        RichText::new(label).size(13.5).color(theme::TEXT),
                                    )
                                    .fill(fill)
                                    .stroke(Stroke::NONE)
                                    .min_size(Vec2::new(ui.available_width(), 26.0)),
                                )
                                .clicked()
                            {
                                if ent.is_dir {
                                    open_dir = Some(ent.rel_path.clone());
                                } else {
                                    open_file = Some(ent.rel_path.clone());
                                }
                            }
                        }
                        if let Some(d) = open_dir {
                            self.tree_rel = d;
                            self.refresh_tree();
                        }
                        if let Some(f) = open_file {
                            self.open_file(&f);
                        }
                    });
                });
        }

        if show_outline {
            egui::SidePanel::right("outline")
                .default_width(200.0)
                .frame(theme::sidebar_frame())
                .show(ctx, |ui| {
                    theme::panel_title(ui, "大纲");
                    ui.separator();
                    ScrollArea::vertical().show(ui, |ui| {
                        for (level, title, idx) in self.preview.outline() {
                            let pad = (level.saturating_sub(1) as f32) * 10.0;
                            ui.horizontal(|ui| {
                                ui.add_space(pad);
                                let t = if title.is_empty() {
                                    "(无题)".into()
                                } else {
                                    title
                                };
                                if ui
                                    .add(
                                        egui::Button::new(RichText::new(t).size(12.5)).frame(false),
                                    )
                                    .clicked()
                                {
                                    self.preview.jump_to_block(idx);
                                }
                            });
                        }
                    });
                });
        }

        // 对话框
        if self.show_save_as {
            egui::Window::new("另存为")
                .collapsible(false)
                .resizable(false)
                .show(ctx, |ui| {
                    ui.label("文件名（.md）");
                    ui.text_edit_singleline(&mut self.save_as_name);
                    ui.horizontal(|ui| {
                        if ui.button("保存").clicked() {
                            let n = self.save_as_name.clone();
                            self.show_save_as = false;
                            self.save_as(&n);
                        }
                        if ui.button("取消").clicked() {
                            self.show_save_as = false;
                        }
                    });
                });
        }
        if self.show_help {
            egui::Window::new("使用说明")
                .open(&mut self.show_help)
                .default_width(420.0)
                .show(ctx, |ui| {
                    ui.label("点击正文中的段落即可编辑（浏览即编辑）。");
                    ui.label("用「段落」「格式」菜单改变标题、列表、加粗等。");
                    ui.label("可将文件夹或 .md 文件拖入窗口直接打开。");
                    ui.label("「视图 → 源代码模式」可查看原始 Markdown。");
                    ui.label("Ctrl+S 保存 · Ctrl+B 加粗 · Ctrl+I 斜体");
                });
        }
        if self.show_about {
            egui::Window::new("关于")
                .open(&mut self.show_about)
                .resizable(false)
                .show(ctx, |ui| {
                    ui.label(RichText::new(theme::APP_NAME).size(20.0).strong());
                    ui.label(theme::APP_TAGLINE);
                    ui.label("块级所见即所得 · Win7 绿色版");
                });
        }

        egui::CentralPanel::default()
            .frame(Frame::none().fill(theme::PAPER).inner_margin(Margin::ZERO))
            .show(ctx, |ui| {
                if self.workspace.is_none() {
                    let mut pending = None;
                    draw_welcome(ui, &mut self.root_input, &mut |p| pending = Some(p));
                    if let Some(p) = pending {
                        self.open_workspace(p);
                    }
                    return;
                }
                if self.current_rel.is_none() {
                    ui.centered_and_justified(|ui| {
                        ui.label(
                            RichText::new("在左侧打开一个 Markdown 文件")
                                .size(17.0)
                                .color(theme::TEXT_MUTED),
                        );
                    });
                    return;
                }

                Frame::none()
                    .fill(Color32::from_rgb(0xF5, 0xF3, 0xEE))
                    .inner_margin(Margin::symmetric(14.0, 8.0))
                    .show(ui, |ui| {
                        ui.label(
                            RichText::new(self.file_title())
                                .size(14.0)
                                .strong()
                                .color(theme::TEXT),
                        );
                    });

                if self.source_mode {
                    ui.add_space(4.0);
                    Frame::none()
                        .fill(Color32::from_rgb(0xFF, 0xFE, 0xFC))
                        .inner_margin(Margin::same(12.0))
                        .show(ui, |ui| {
                            let before = self.source.clone();
                            ScrollArea::vertical().show(ui, |ui| {
                                let resp = ui.add(
                                    egui::TextEdit::multiline(&mut self.source)
                                        .code_editor()
                                        .desired_width(f32::INFINITY)
                                        .desired_rows(40)
                                        .font(FontId::monospace(14.0)),
                                );
                                if resp.changed() && self.source != before {
                                    self.dirty = true;
                                    self.preview.notify_source(&self.source);
                                }
                            });
                        });
                } else {
                    Frame::none()
                        .fill(Color32::WHITE)
                        .inner_margin(Margin::symmetric(28.0, 16.0))
                        .show(ui, |ui| {
                            let _ = lumen_render::show_preview(ui, &mut self.preview);
                            self.sync_from_preview();
                        });
                }
            });

        ctx.request_repaint_after(Duration::from_millis(50));
    }
}

fn draw_welcome(
    ui: &mut egui::Ui,
    root_input: &mut String,
    open: &mut dyn FnMut(PathBuf),
) {
    let rect = ui.max_rect();
    ui.painter().rect_filled(rect, 0.0, theme::PAPER);
    let band = egui::Rect::from_min_size(rect.min, Vec2::new(rect.width(), rect.height() * 0.20));
    ui.painter()
        .rect_filled(band, 0.0, Color32::from_rgb(0xE8, 0xEF, 0xED));

    let mut child = ui.child_ui(rect, Layout::top_down(Align::Center));
    child.add_space(rect.height() * 0.24);
    child.label(
        RichText::new(theme::APP_NAME)
            .size(42.0)
            .strong()
            .color(theme::INK),
    );
    child.add_space(8.0);
    child.label(
        RichText::new("浏览即编辑 · 拖入文件即可打开")
            .size(14.0)
            .color(theme::TEXT_MUTED),
    );
    child.add_space(28.0);
    child.horizontal(|ui| {
        ui.add(
            egui::TextEdit::singleline(root_input)
                .desired_width(420.0)
                .hint_text("粘贴本地文件夹路径"),
        );
        if theme::primary_button(ui, "打开工作区").clicked() {
            let t = root_input.trim();
            if !t.is_empty() {
                open(PathBuf::from(t));
            }
        }
    });
}

pub fn run() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1360.0, 860.0])
            .with_min_inner_size([960.0, 600.0])
            .with_title(theme::APP_NAME),
        ..Default::default()
    };
    eframe::run_native(
        theme::APP_NAME,
        options,
        Box::new(|cc| Box::new(LumenApp::new(cc))),
    )
}

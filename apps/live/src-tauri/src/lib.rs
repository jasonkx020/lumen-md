//! Lumen MD Live — Tauri 命令与沙箱 FS IPC。

mod assets_fs;
mod export_assets;
mod export_file;
mod html_sanitize;
mod html_table_docx;
mod llm;
mod md_docx;
mod sandbox_fs;
mod settings_store;

use parking_lot::Mutex;
use sandbox_fs::{
    is_allowed_text_ext, read_abs_text, write_abs_text, FileEntry, Workspace, MAX_FILE_BYTES,
};
use settings_store::{Prefs, SettingsSetReq, SettingsView};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::State;

pub struct AppState {
    pub workspace: Mutex<Option<Workspace>>,
    /// 独立打开过的绝对路径白名单（多 Tab 可同时多个）。
    pub allowed_abs: Mutex<HashSet<PathBuf>>,
    /// 启动时通过命令行传入的待打开 Markdown 路径（前端 take 一次后清空）。
    pub startup_files: Mutex<Vec<String>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            workspace: Mutex::new(None),
            allowed_abs: Mutex::new(HashSet::new()),
            startup_files: Mutex::new(Vec::new()),
        }
    }
}

fn map_err(e: anyhow::Error) -> String {
    e.to_string()
}

fn with_ws<T>(
    state: &AppState,
    f: impl FnOnce(&Workspace) -> anyhow::Result<T>,
) -> Result<T, String> {
    let guard = state.workspace.lock();
    let ws = guard.as_ref().ok_or_else(|| "未打开工作区".to_string())?;
    f(ws).map_err(map_err)
}

#[tauri::command]
fn open_workspace(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let ws = Workspace::open(&path).map_err(map_err)?;
    let root = ws.root().to_string_lossy().into_owned();
    *state.workspace.lock() = Some(ws);
    settings_store::push_recent(&root, "folder");
    Ok(root)
}

#[tauri::command]
fn get_workspace_root(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state
        .workspace
        .lock()
        .as_ref()
        .map(|w| w.root().to_string_lossy().into_owned()))
}

#[tauri::command]
fn list_dir(state: State<'_, AppState>, rel: String) -> Result<Vec<FileEntry>, String> {
    with_ws(&state, |ws| ws.list_dir(&rel))
}

#[tauri::command]
fn fs_read(state: State<'_, AppState>, rel: String) -> Result<String, String> {
    with_ws(&state, |ws| ws.read_text(&rel))
}

#[tauri::command]
fn fs_write(state: State<'_, AppState>, rel: String, content: String) -> Result<(), String> {
    with_ws(&state, |ws| ws.write_text(&rel, &content))
}

#[tauri::command]
fn fs_create(state: State<'_, AppState>, rel: String) -> Result<(), String> {
    with_ws(&state, |ws| ws.create_file(&rel))
}

/// 打开绝对路径 md：在工作区内返回 workspace 模式；否则 standalone（不挂父目录）。
#[tauri::command]
fn open_absolute_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<OpenFileResult, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err("不是文件".into());
    }
    if !is_allowed_text_ext(&p) {
        return Err("仅支持 Markdown / 文本文件".into());
    }
    let canon = std::fs::canonicalize(&p).map_err(|e| e.to_string())?;

    // 已在当前工作区内 → workspace 模式
    {
        let guard = state.workspace.lock();
        if let Some(ws) = guard.as_ref() {
            if is_under(&canon, ws.root()) {
                let rel = relativize(&canon, ws.root())
                    .ok_or_else(|| "无法计算相对路径".to_string())?;
                let content = ws.read_text(&rel).map_err(map_err)?;
                return Ok(OpenFileResult {
                    mode: "workspace".into(),
                    workspace_root: Some(ws.root().to_string_lossy().into_owned()),
                    rel_path: Some(rel),
                    abs_path: None,
                    content,
                });
            }
        }
    }

    // 独立文件：加入白名单，不打开父目录为工作区
    let content = read_abs_text(&canon).map_err(map_err)?;
    state.allowed_abs.lock().insert(canon.clone());
    let abs_s = canon.to_string_lossy().into_owned();
    settings_store::push_recent(&abs_s, "file");
    Ok(OpenFileResult {
        mode: "standalone".into(),
        workspace_root: None,
        rel_path: None,
        abs_path: Some(abs_s),
        content,
    })
}

/// 白名单内绝对路径原子写。
#[tauri::command]
fn fs_write_abs(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<(), String> {
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err(format!("内容超过软上限 {} bytes", MAX_FILE_BYTES));
    }
    let p = PathBuf::from(&path);
    let canon = std::fs::canonicalize(&p).map_err(|e| e.to_string())?;

    let allowed = state.allowed_abs.lock();
    let ok = allowed.contains(&canon) || allowed.iter().any(|a| paths_equal(a, &canon));
    drop(allowed);
    if !ok {
        return Err("路径未授权（请先打开该文件）".into());
    }

    write_abs_text(&canon, &content).map_err(map_err)
}

fn export_ctx_from_state(
    state: &AppState,
    doc_abs: Option<String>,
) -> export_assets::ExportAssetCtx {
    let workspace_root = state
        .workspace
        .lock()
        .as_ref()
        .map(|ws| ws.root().to_string_lossy().into_owned());
    export_assets::ExportAssetCtx::from_opts(doc_abs.as_deref(), workspace_root.as_deref())
}

/// Markdown → DOCX（纯 Rust：comrak + docx-rs）。
#[tauri::command]
fn export_md_to_docx(
    state: State<'_, AppState>,
    markdown: String,
    path: String,
    doc_abs: Option<String>,
) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let lower = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if lower != "docx" {
        return Err("目标路径须为 .docx".into());
    }
    let ctx = export_ctx_from_state(&state, doc_abs);
    export_file::md_to_docx_with_ctx(&markdown, &p, &ctx).map_err(map_err)
}

/// Markdown → PDF（首选 GitHub HTML；回退 DOCX→Word/LO；返回模式 github-html|libreoffice|word）。
#[tauri::command]
fn export_md_to_pdf(
    state: State<'_, AppState>,
    markdown: String,
    path: String,
    doc_abs: Option<String>,
) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let lower = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if lower != "pdf" {
        return Err("目标路径须为 .pdf".into());
    }
    let ctx = export_ctx_from_state(&state, doc_abs);
    export_file::md_to_pdf_with_ctx(&markdown, &p, &ctx)
        .map(|mode| mode.to_string())
        .map_err(map_err)
}

/// 另存为：校验扩展名、写入并加入白名单。
#[tauri::command]
fn register_and_write_abs(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !is_allowed_text_ext(&p) {
        return Err("仅允许 .md / .markdown / .txt".into());
    }
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err(format!("内容超过软上限 {} bytes", MAX_FILE_BYTES));
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    write_abs_text(&p, &content).map_err(map_err)?;
    let canon = std::fs::canonicalize(&p).map_err(|e| e.to_string())?;
    state.allowed_abs.lock().insert(canon.clone());
    Ok(canon.to_string_lossy().into_owned())
}

#[derive(serde::Serialize)]
struct OpenFileResult {
    mode: String,
    workspace_root: Option<String>,
    rel_path: Option<String>,
    abs_path: Option<String>,
    content: String,
}

#[derive(serde::Serialize)]
struct ResolveDocLinkResult {
    kind: String,
    rel_path: Option<String>,
    abs_path: Option<String>,
    exists: bool,
    open_url: Option<String>,
    message: Option<String>,
}

fn is_doc_ext(path: &Path) -> bool {
    is_allowed_text_ext(path)
}

fn join_base_href(base_dir: &Path, href: &str) -> Result<PathBuf, String> {
    let href = href.replace('\\', "/");
    if href.split('/').any(|p| p == "..") {
        return Err("链接路径不允许 ..".into());
    }
    let mut out = base_dir.to_path_buf();
    for part in href.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        out.push(part);
    }
    Ok(out)
}

/// 解析文档内链接：锚点 / 本地 md / 外链。
#[tauri::command]
fn resolve_doc_link(
    state: State<'_, AppState>,
    href: String,
    base_rel: Option<String>,
    base_abs: Option<String>,
) -> Result<ResolveDocLinkResult, String> {
    let href = href.trim().to_string();
    if href.is_empty() {
        return Ok(ResolveDocLinkResult {
            kind: "missing".into(),
            rel_path: None,
            abs_path: None,
            exists: false,
            open_url: None,
            message: Some("空链接".into()),
        });
    }

    if href.starts_with('#') {
        return Ok(ResolveDocLinkResult {
            kind: "anchor".into(),
            rel_path: None,
            abs_path: None,
            exists: true,
            open_url: None,
            message: None,
        });
    }

    let lower = href.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")
    {
        return Ok(ResolveDocLinkResult {
            kind: "external".into(),
            rel_path: None,
            abs_path: None,
            exists: false,
            open_url: Some(href),
            message: None,
        });
    }

    // file:// → 本地绝对路径
    let path_str = if lower.starts_with("file://") {
        let rest = href[7..].to_string();
        // file:///C:/... or file://localhost/C:/...
        let stripped = rest
            .trim_start_matches('/')
            .trim_start_matches("localhost/");
        // Windows: C:/...
        if stripped.chars().nth(1) == Some(':') {
            stripped.to_string()
        } else if cfg!(windows) {
            format!("/{}", stripped)
        } else {
            format!("/{}", stripped)
        }
    } else {
        href.clone()
    };

    let candidate = {
        let p = PathBuf::from(&path_str);
        if p.is_absolute() || (cfg!(windows) && path_str.chars().nth(1) == Some(':')) {
            p
        } else {
            // 相对当前文件目录或工作区根
            let base_dir = if let Some(abs) = base_abs.as_ref() {
                PathBuf::from(abs)
                    .parent()
                    .map(|d| d.to_path_buf())
                    .unwrap_or_else(|| PathBuf::from(abs))
            } else if let Some(rel) = base_rel.as_ref() {
                let ws = state.workspace.lock();
                let root = ws
                    .as_ref()
                    .map(|w| w.root().to_path_buf())
                    .ok_or_else(|| "未打开工作区".to_string())?;
                let parent = Path::new(rel)
                    .parent()
                    .map(|d| d.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                if parent.is_empty() {
                    root
                } else {
                    root.join(parent)
                }
            } else {
                let ws = state.workspace.lock();
                ws.as_ref()
                    .map(|w| w.root().to_path_buf())
                    .ok_or_else(|| "无法解析相对链接：无工作区或当前文件".to_string())?
            };
            join_base_href(&base_dir, &path_str)?
        }
    };

    // 若有工作区，相对链接解析结果必须仍在工作区内
    {
        let guard = state.workspace.lock();
        if let Some(ws) = guard.as_ref() {
            let abs_link = PathBuf::from(&path_str).is_absolute()
                || (cfg!(windows) && path_str.chars().nth(1) == Some(':'));
            if !abs_link && !is_under(&candidate, ws.root()) {
                // 文件可能尚不存在：用字符串前缀粗检
                let cand_s = candidate.to_string_lossy().replace('/', "\\").to_lowercase();
                let root_s = ws.root().to_string_lossy().replace('/', "\\").to_lowercase();
                if !cand_s.starts_with(&root_s) {
                    return Ok(ResolveDocLinkResult {
                        kind: "denied".into(),
                        rel_path: None,
                        abs_path: None,
                        exists: false,
                        open_url: None,
                        message: Some("链接路径逃逸被拒绝".into()),
                    });
                }
            }
        }
    }

    // 尝试补全扩展名
    let mut tries = vec![candidate.clone()];
    if candidate.extension().is_none() {
        for ext in ["md", "markdown", "txt"] {
            let mut t = candidate.clone();
            t.set_extension(ext);
            tries.push(t);
        }
    }

    for try_path in tries {
        let exists = try_path.is_file();
        if !exists {
            continue;
        }
        if !is_doc_ext(&try_path) {
            return Ok(ResolveDocLinkResult {
                kind: "denied".into(),
                rel_path: None,
                abs_path: None,
                exists: true,
                open_url: None,
                message: Some("仅允许打开 Markdown / 文本文件".into()),
            });
        }

        let canon = std::fs::canonicalize(&try_path).map_err(|e| e.to_string())?;

        // 工作区内 → rel
        {
            let guard = state.workspace.lock();
            if let Some(ws) = guard.as_ref() {
                if is_under(&canon, ws.root()) {
                    let rel = relativize(&canon, ws.root())
                        .ok_or_else(|| "无法计算相对路径".to_string())?;
                    return Ok(ResolveDocLinkResult {
                        kind: "local".into(),
                        rel_path: Some(rel),
                        abs_path: None,
                        exists: true,
                        open_url: None,
                        message: None,
                    });
                }
            }
        }

        // 已在白名单或可注册为 standalone
        state.allowed_abs.lock().insert(canon.clone());
        return Ok(ResolveDocLinkResult {
            kind: "local".into(),
            rel_path: None,
            abs_path: Some(canon.to_string_lossy().into_owned()),
            exists: true,
            open_url: None,
            message: None,
        });
    }

    // 相对文档未找到：不误开浏览器
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Ok(ResolveDocLinkResult {
            kind: "missing".into(),
            rel_path: None,
            abs_path: Some(candidate.to_string_lossy().into_owned()),
            exists: false,
            open_url: None,
            message: Some(format!("未找到本地文档: {href}")),
        });
    }

    Ok(ResolveDocLinkResult {
        kind: "external".into(),
        rel_path: None,
        abs_path: None,
        exists: false,
        open_url: Some(href),
        message: None,
    })
}

#[tauri::command]
fn settings_get() -> Result<SettingsView, String> {
    Ok(settings_store::settings_view())
}

#[tauri::command]
fn settings_set(req: SettingsSetReq) -> Result<SettingsView, String> {
    settings_store::apply_settings(req).map_err(map_err)
}

#[tauri::command]
fn settings_clear_key() -> Result<SettingsView, String> {
    let prefs = settings_store::load_prefs();
    settings_store::clear_api_key(prefs.platform).map_err(map_err)?;
    Ok(settings_store::settings_view())
}

#[tauri::command]
async fn llm_test() -> Result<String, String> {
    llm::test_connection().await
}

#[tauri::command]
async fn llm_complete(
    system: String,
    user: String,
    temperature: Option<f32>,
    images: Option<Vec<String>>,
) -> Result<String, String> {
    llm::complete(&system, &user, temperature, images).await
}

/// Markdown → HTML（GitHub 风 standalone）。
#[tauri::command]
fn export_md_to_html(
    state: State<'_, AppState>,
    markdown: String,
    path: String,
    doc_abs: Option<String>,
) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let lower = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if lower != "html" && lower != "htm" {
        return Err("目标路径须为 .html".into());
    }
    let ctx = export_ctx_from_state(&state, doc_abs);
    let html = md_docx::markdown_to_github_html_with_ctx(&markdown, &ctx).map_err(map_err)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, html.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Markdown → HTML 字符串（剪贴板复制用）。
#[tauri::command]
fn markdown_to_html_string(
    state: State<'_, AppState>,
    markdown: String,
    doc_abs: Option<String>,
) -> Result<String, String> {
    let ctx = export_ctx_from_state(&state, doc_abs);
    md_docx::markdown_to_github_html_with_ctx(&markdown, &ctx).map_err(map_err)
}

/// 保存图片等二进制资源。bytesBase64 为原始字节的 base64。
#[tauri::command]
fn fs_save_asset(
    state: State<'_, AppState>,
    bytes_base64: String,
    preferred_name: Option<String>,
    mime_hint: Option<String>,
    doc_abs: Option<String>,
) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64.trim())
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    let prefs = settings_store::load_prefs();
    let sub = prefs.assets_dir.clone();
    let mode = prefs.asset_mode.clone();

    if mode == "beside" {
        let doc = doc_abs
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "相对文档落盘需要当前文件路径".to_string())?;
        let (rel, abs) = assets_fs::save_beside_doc(
            Path::new(doc),
            &bytes,
            preferred_name.as_deref(),
            mime_hint.as_deref(),
            &sub,
        )
        .map_err(map_err)?;
        state.allowed_abs.lock().insert(abs);
        return Ok(rel);
    }

    // workspace 优先
    let guard = state.workspace.lock();
    if let Some(ws) = guard.as_ref() {
        return assets_fs::save_in_workspace(
            ws,
            &bytes,
            preferred_name.as_deref(),
            mime_hint.as_deref(),
            &sub,
        )
        .map_err(map_err);
    }
    // 无工作区时尝试 beside
    let doc = doc_abs
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "请先打开工作区或已保存的文档再插入图片".to_string())?;
    let (rel, abs) = assets_fs::save_beside_doc(
        Path::new(doc),
        &bytes,
        preferred_name.as_deref(),
        mime_hint.as_deref(),
        &sub,
    )
    .map_err(map_err)?;
    drop(guard);
    state.allowed_abs.lock().insert(abs);
    Ok(rel)
}

/// 从本机绝对路径导入图片到 assets，返回相对路径。
#[tauri::command]
fn fs_import_asset_path(
    state: State<'_, AppState>,
    abs_path: String,
    doc_abs: Option<String>,
) -> Result<String, String> {
    let p = PathBuf::from(abs_path.trim());
    if !p.is_file() {
        return Err("不是有效的图片文件".into());
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().into_owned());
    let mime = match p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => Some("image/jpeg".into()),
        "gif" => Some("image/gif".into()),
        "webp" => Some("image/webp".into()),
        "svg" => Some("image/svg+xml".into()),
        "png" => Some("image/png".into()),
        _ => None,
    };
    // 复用 fs_save_asset 的落盘策略
    use base64::Engine;
    let bytes_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    fs_save_asset(state, bytes_base64, name, mime, doc_abs)
}

/// 将工作区相对路径图片读为 data URL（供编辑器预览）。
#[tauri::command]
fn resolve_asset_url(
    state: State<'_, AppState>,
    src: String,
    doc_abs: Option<String>,
) -> Result<String, String> {
    let src = src.trim();
    if src.is_empty() {
        return Err("空路径".into());
    }
    if src.starts_with("data:") || src.starts_with("http://") || src.starts_with("https://") {
        return Ok(src.to_string());
    }
    let path = if Path::new(src).is_absolute() {
        PathBuf::from(src)
    } else {
        // Typora 语义：相对路径优先相对当前 md 所在目录
        let from_doc = doc_abs
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|doc| {
                Path::new(doc)
                    .parent()
                    .unwrap_or_else(|| Path::new("."))
                    .join(src)
            });
        if let Some(ref p) = from_doc {
            if p.is_file() {
                p.clone()
            } else {
                // 回退工作区根（assets/ 等）
                let from_ws = {
                    let guard = state.workspace.lock();
                    guard
                        .as_ref()
                        .and_then(|ws| ws.resolve(src).ok())
                        .filter(|p| p.is_file())
                };
                from_ws
                    .or_else(|| from_doc)
                    .ok_or_else(|| "未打开工作区且无文档路径，无法解析图片".to_string())?
            }
        } else {
            let guard = state.workspace.lock();
            let ws = guard
                .as_ref()
                .ok_or_else(|| "未打开工作区且无文档路径，无法解析图片".to_string())?;
            ws.resolve(src).map_err(map_err)?
        }
    };
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let mime = match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "image/png",
    };
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchHit {
    rel_path: String,
    line: usize,
    preview: String,
}

#[tauri::command]
fn workspace_search(
    state: State<'_, AppState>,
    query: String,
    max_hits: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let limit = max_hits.unwrap_or(100).min(500);
    with_ws(&state, |ws| {
        let mut hits = Vec::new();
        let mut stack = vec![ws.root().to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else {
                continue;
            };
            for ent in rd.flatten() {
                let path = ent.path();
                let name = ent.file_name().to_string_lossy().into_owned();
                if name == ".git" || name == "node_modules" || name == "target" {
                    continue;
                }
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if !(name.ends_with(".md")
                    || name.ends_with(".markdown")
                    || name.ends_with(".txt"))
                {
                    continue;
                }
                let Ok(text) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let rel = path
                    .strip_prefix(ws.root())
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_else(|_| name.clone());
                for (i, line) in text.lines().enumerate() {
                    if line.contains(q) {
                        hits.push(SearchHit {
                            rel_path: rel.clone(),
                            line: i + 1,
                            preview: line.chars().take(160).collect(),
                        });
                        if hits.len() >= limit {
                            return Ok(hits);
                        }
                    }
                }
            }
        }
        Ok(hits)
    })
}

#[allow(dead_code)]
fn default_prefs() -> Prefs {
    Prefs::default()
}

fn paths_equal(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => false,
    }
}

/// 从命令行参数中提取可打开的 Markdown/文本路径。
fn collect_open_files_from_args<I, S>(args: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = Vec::new();
    for maybe in args {
        let s = maybe.as_ref().trim();
        if s.is_empty() || s.starts_with('-') {
            continue;
        }
        let path = if let Ok(url) = url::Url::parse(s) {
            if url.scheme() == "file" {
                url.to_file_path().ok()
            } else {
                None
            }
        } else {
            Some(PathBuf::from(s))
        };
        let Some(p) = path else {
            continue;
        };
        if !p.is_file() {
            continue;
        }
        if !is_allowed_text_ext(&p) {
            continue;
        }
        let display = std::fs::canonicalize(&p)
            .unwrap_or(p)
            .to_string_lossy()
            .into_owned();
        // Windows canonicalize 可能带 \\?\ 前缀，前端/对话框更习惯普通路径
        let display = display
            .strip_prefix(r"\\?\")
            .unwrap_or(&display)
            .to_string();
        if !out.iter().any(|x| x == &display) {
            out.push(display);
        }
    }
    out
}

/// 前端启动时取走命令行传入的文件路径（只取一次）。
#[tauri::command]
fn take_startup_files(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(std::mem::take(&mut *state.startup_files.lock()))
}

fn emit_open_files(app: &tauri::AppHandle, files: Vec<String>) {
    if files.is_empty() {
        return;
    }
    use tauri::{Emitter, Manager};
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_focus();
        let _ = win.emit("open-files", files);
    } else {
        let _ = app.emit("open-files", files);
    }
}

fn is_under(path: &Path, root: &Path) -> bool {
    let Ok(p) = std::fs::canonicalize(path) else {
        return false;
    };
    let Ok(r) = std::fs::canonicalize(root) else {
        return false;
    };
    p.starts_with(&r)
}

fn relativize(path: &Path, root: &Path) -> Option<String> {
    let p = std::fs::canonicalize(path).ok()?;
    let r = std::fs::canonicalize(root).ok()?;
    p.strip_prefix(&r)
        .ok()
        .map(|s| s.to_string_lossy().replace('\\', "/"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let startup = collect_open_files_from_args(std::env::args().skip(1));

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let files = collect_open_files_from_args(argv.iter().skip(1).map(|s| s.as_str()));
            emit_open_files(app, files);
        }));
    }

    let state = AppState {
        startup_files: Mutex::new(startup),
        ..AppState::default()
    };

    builder
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            open_workspace,
            get_workspace_root,
            list_dir,
            fs_read,
            fs_write,
            fs_create,
            open_absolute_file,
            fs_write_abs,
            register_and_write_abs,
            export_md_to_docx,
            export_md_to_pdf,
            export_md_to_html,
            markdown_to_html_string,
            fs_save_asset,
            fs_import_asset_path,
            resolve_asset_url,
            workspace_search,
            resolve_doc_link,
            settings_get,
            settings_set,
            settings_clear_key,
            llm_test,
            llm_complete,
            take_startup_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

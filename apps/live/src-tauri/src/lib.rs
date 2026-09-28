//! Lumen MD Live — Tauri 命令与沙箱 FS IPC。

mod export_file;
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
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            workspace: Mutex::new(None),
            allowed_abs: Mutex::new(HashSet::new()),
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
    Ok(OpenFileResult {
        mode: "standalone".into(),
        workspace_root: None,
        rel_path: None,
        abs_path: Some(canon.to_string_lossy().into_owned()),
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

/// Markdown → DOCX（纯 Rust：comrak + docx-rs）。
#[tauri::command]
fn export_md_to_docx(markdown: String, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let lower = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if lower != "docx" {
        return Err("目标路径须为 .docx".into());
    }
    export_file::md_to_docx(&markdown, &p).map_err(map_err)
}

/// Markdown → PDF（首选 GitHub HTML；回退 DOCX→Word/LO；返回模式 github-html|libreoffice|word）。
#[tauri::command]
fn export_md_to_pdf(markdown: String, path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let lower = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if lower != "pdf" {
        return Err("目标路径须为 .pdf".into());
    }
    export_file::md_to_pdf(&markdown, &p)
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
) -> Result<String, String> {
    llm::complete(&system, &user, temperature).await
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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
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
            resolve_doc_link,
            settings_get,
            settings_set,
            settings_clear_key,
            llm_test,
            llm_complete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

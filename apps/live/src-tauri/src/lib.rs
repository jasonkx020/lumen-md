//! Lumen MD Live — Tauri 命令与沙箱 FS IPC。

mod sandbox_fs;

use parking_lot::Mutex;
use sandbox_fs::{
    is_allowed_text_ext, read_abs_text, write_abs_text, FileEntry, Workspace, MAX_FILE_BYTES,
};
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

//! Lumen MD Live — Tauri 命令与沙箱 FS IPC。

mod sandbox_fs;

use parking_lot::Mutex;
use sandbox_fs::{FileEntry, Workspace};
use std::path::{Path, PathBuf};
use tauri::State;

pub struct AppState {
    pub workspace: Mutex<Option<Workspace>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            workspace: Mutex::new(None),
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

/// 打开绝对路径的 md：若在当前工作区内则返回相对路径；否则以父目录为工作区。
#[tauri::command]
fn open_absolute_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<OpenFileResult, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err("不是文件".into());
    }
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let lower = name.to_lowercase();
    if !(lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".txt")) {
        return Err("仅支持 Markdown / 文本文件".into());
    }

    let parent = p
        .parent()
        .ok_or_else(|| "无效路径".to_string())?;

    let mut guard = state.workspace.lock();
    let need_reopen = match guard.as_ref() {
        Some(ws) => !is_under(&p, ws.root()),
        None => true,
    };
    if need_reopen {
        *guard = Some(Workspace::open(parent).map_err(map_err)?);
    }
    let ws = guard.as_ref().unwrap();
    let root = ws.root();
    let rel = relativize(&p, root).ok_or_else(|| "无法计算相对路径".to_string())?;
    let content = ws.read_text(&rel).map_err(map_err)?;
    Ok(OpenFileResult {
        workspace_root: root.to_string_lossy().into_owned(),
        rel_path: rel,
        content,
    })
}

#[derive(serde::Serialize)]
struct OpenFileResult {
    workspace_root: String,
    rel_path: String,
    content: String,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

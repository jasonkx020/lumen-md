//! 工作区 / 文档旁资源落盘（图片等）。

use crate::sandbox_fs::Workspace;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_ASSET_BYTES: u64 = 16 * 1024 * 1024;

fn stamp_name(ext: &str) -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let ext = ext.trim_start_matches('.').to_lowercase();
    let ext = if ext.is_empty() { "png" } else { &ext };
    format!("img-{ms}.{ext}")
}

fn guess_ext(preferred: Option<&str>, mime_hint: Option<&str>) -> String {
    if let Some(p) = preferred {
        let p = p.trim();
        if let Some(dot) = p.rfind('.') {
            let e = &p[dot + 1..];
            if !e.is_empty() && e.len() <= 8 {
                return e.to_lowercase();
            }
        }
    }
    match mime_hint.unwrap_or("").to_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => "jpg".into(),
        "image/gif" => "gif".into(),
        "image/webp" => "webp".into(),
        "image/svg+xml" => "svg".into(),
        _ => "png".into(),
    }
}

/// 保存到工作区 `assets/`（或自定义子目录），返回相对根的路径。
pub fn save_in_workspace(
    ws: &Workspace,
    bytes: &[u8],
    preferred_name: Option<&str>,
    mime_hint: Option<&str>,
    assets_subdir: &str,
) -> anyhow::Result<String> {
    if bytes.len() as u64 > MAX_ASSET_BYTES {
        anyhow::bail!("资源超过上限 {} bytes", MAX_ASSET_BYTES);
    }
    let sub = assets_subdir.trim().trim_matches('/').trim_matches('\\');
    let sub = if sub.is_empty() { "assets" } else { sub };
    let ext = guess_ext(preferred_name, mime_hint);
    let name = stamp_name(&ext);
    let rel = format!("{sub}/{name}");
    let path = ws.resolve(&rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, bytes)?;
    Ok(rel.replace('\\', "/"))
}

/// 保存到某 md 文件同级 `assets/`，返回相对该 md 的路径。
pub fn save_beside_doc(
    doc_abs: &Path,
    bytes: &[u8],
    preferred_name: Option<&str>,
    mime_hint: Option<&str>,
    assets_subdir: &str,
) -> anyhow::Result<(String, PathBuf)> {
    if bytes.len() as u64 > MAX_ASSET_BYTES {
        anyhow::bail!("资源超过上限 {} bytes", MAX_ASSET_BYTES);
    }
    let parent = doc_abs
        .parent()
        .ok_or_else(|| anyhow::anyhow!("文档无父目录"))?;
    let sub = assets_subdir.trim().trim_matches('/').trim_matches('\\');
    let sub = if sub.is_empty() { "assets" } else { sub };
    let ext = guess_ext(preferred_name, mime_hint);
    let name = stamp_name(&ext);
    let dir = parent.join(sub);
    fs::create_dir_all(&dir)?;
    let abs = dir.join(&name);
    fs::write(&abs, bytes)?;
    let rel = format!("{sub}/{name}").replace('\\', "/");
    Ok((rel, abs))
}

//! 工作区路径沙箱与原子写（自 lumen-core 迁入，供 Live IPC 使用）。

use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub rel_path: String,
    pub is_dir: bool,
}

#[derive(Debug)]
pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    pub fn open(root: impl AsRef<Path>) -> anyhow::Result<Self> {
        let root = fs::canonicalize(root.as_ref())?;
        if !root.is_dir() {
            anyhow::bail!("不是目录: {}", root.display());
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn resolve(&self, rel: &str) -> anyhow::Result<PathBuf> {
        let rel = rel.replace('\\', "/");
        if rel.is_empty() || rel.starts_with('/') || rel.contains(':') {
            anyhow::bail!("非法路径");
        }
        let mut cleaned = PathBuf::new();
        for c in Path::new(&rel).components() {
            match c {
                Component::Normal(s) => cleaned.push(s),
                Component::CurDir => {}
                Component::ParentDir => anyhow::bail!("路径不允许 .."),
                _ => anyhow::bail!("非法路径分量"),
            }
        }
        let joined = self.root.join(&cleaned);
        let check = if joined.exists() {
            fs::canonicalize(&joined)?
        } else if let Some(parent) = joined.parent() {
            if parent.exists() {
                fs::canonicalize(parent)?.join(joined.file_name().unwrap_or_default())
            } else {
                let tentative = self.root.join(&cleaned);
                if !path_under(&tentative, &self.root) {
                    anyhow::bail!("路径逃逸被拒绝");
                }
                return Ok(tentative);
            }
        } else {
            anyhow::bail!("非法路径");
        };
        if !path_under(&check, &self.root) {
            anyhow::bail!("路径逃逸被拒绝");
        }
        Ok(check)
    }

    pub fn list_dir(&self, rel: &str) -> anyhow::Result<Vec<FileEntry>> {
        let dir = if rel.is_empty() {
            self.root.clone()
        } else {
            self.resolve(rel)?
        };
        if !dir.is_dir() {
            anyhow::bail!("不是目录");
        }
        let mut out = Vec::new();
        for ent in fs::read_dir(&dir)? {
            let ent = ent?;
            let name = ent.file_name().to_string_lossy().into_owned();
            if name == ".git" || name == "target" || name == "node_modules" {
                continue;
            }
            let is_dir = ent.file_type()?.is_dir();
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", rel.trim_end_matches('/'), name)
            };
            if is_dir
                || name.ends_with(".md")
                || name.ends_with(".markdown")
                || name.ends_with(".txt")
            {
                out.push(FileEntry {
                    name,
                    rel_path: child_rel.replace('\\', "/"),
                    is_dir,
                });
            }
        }
        out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(out)
    }

    pub fn read_text(&self, rel: &str) -> anyhow::Result<String> {
        let path = self.resolve(rel)?;
        let meta = fs::metadata(&path)?;
        if meta.len() > MAX_FILE_BYTES {
            anyhow::bail!(
                "文件超过软上限 {} bytes（{}）",
                MAX_FILE_BYTES,
                meta.len()
            );
        }
        let bytes = fs::read(&path)?;
        String::from_utf8(bytes).map_err(|_| anyhow::anyhow!("仅支持 UTF-8"))
    }

    pub fn write_text(&self, rel: &str, content: &str) -> anyhow::Result<()> {
        if content.len() as u64 > MAX_FILE_BYTES {
            anyhow::bail!("内容超过软上限 {} bytes", MAX_FILE_BYTES);
        }
        let path = self.resolve(rel)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
            if parent.exists() {
                let canon = fs::canonicalize(parent)?;
                if !path_under(&canon, &self.root) {
                    anyhow::bail!("路径逃逸被拒绝");
                }
            }
        }
        let tmp = path.with_extension("md.tmp");
        {
            let mut f = File::create(&tmp)?;
            f.write_all(content.as_bytes())?;
            f.flush()?;
        }
        fs::rename(&tmp, &path)?;
        Ok(())
    }

    pub fn create_file(&self, rel: &str) -> anyhow::Result<()> {
        let lower = rel.to_lowercase();
        if !(lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".txt")) {
            anyhow::bail!("仅允许创建 .md / .markdown / .txt");
        }
        let path = self.resolve(rel)?;
        if path.exists() {
            anyhow::bail!("已存在");
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        self.write_text(rel, "")?;
        Ok(())
    }
}

fn path_under(path: &Path, root: &Path) -> bool {
    let Ok(p) = fs::canonicalize(path) else {
        return path.starts_with(root);
    };
    let Ok(r) = fs::canonicalize(root) else {
        return false;
    };
    p.starts_with(&r)
}

/// 读取绝对路径文本（独立文件模式）。
pub fn read_abs_text(path: &Path) -> anyhow::Result<String> {
    let meta = fs::metadata(path)?;
    if meta.len() > MAX_FILE_BYTES {
        anyhow::bail!(
            "文件超过软上限 {} bytes（{}）",
            MAX_FILE_BYTES,
            meta.len()
        );
    }
    let bytes = fs::read(path)?;
    String::from_utf8(bytes).map_err(|_| anyhow::anyhow!("仅支持 UTF-8"))
}

/// 原子写入绝对路径（独立文件模式）。
pub fn write_abs_text(path: &Path, content: &str) -> anyhow::Result<()> {
    if content.len() as u64 > MAX_FILE_BYTES {
        anyhow::bail!("内容超过软上限 {} bytes", MAX_FILE_BYTES);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("md.tmp");
    {
        let mut f = File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.flush()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

pub fn is_allowed_text_ext(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    name.ends_with(".md") || name.ends_with(".markdown") || name.ends_with(".txt")
}

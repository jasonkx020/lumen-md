//! 工作区路径沙箱与原子写。

use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

/// 单文件软上限（8 MiB）。
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

    /// 将用户相对路径解析到沙箱内绝对路径；拒绝逃逸。
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
        // 目标可能尚不存在（新建）；校验父目录在 root 下
        let check = if joined.exists() {
            fs::canonicalize(&joined)?
        } else if let Some(parent) = joined.parent() {
            if parent.exists() {
                fs::canonicalize(parent)?.join(joined.file_name().unwrap_or_default())
            } else {
                // 逐步确保不逃逸：用 root + cleaned 的规范化比较
                let canon_root = self.root.clone();
                let tentative = canon_root.join(&cleaned);
                if !path_under(&tentative, &canon_root) {
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
            if name == ".git" || name == "target" {
                continue;
            }
            let is_dir = ent.file_type()?.is_dir();
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", rel.trim_end_matches('/'), name)
            };
            // 只展示目录与常见文本/markdown
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
        let text = String::from_utf8(bytes).map_err(|_| anyhow::anyhow!("仅支持 UTF-8"))?;
        Ok(text)
    }

    /// 原子写：tmp → flush → rename。
    pub fn write_text(&self, rel: &str, content: &str) -> anyhow::Result<()> {
        if content.len() as u64 > MAX_FILE_BYTES {
            anyhow::bail!("内容超过软上限 {} bytes", MAX_FILE_BYTES);
        }
        let path = self.resolve(rel)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
            if !path_under(
                &fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf()),
                &self.root,
            ) && parent.exists()
            {
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
        // 不存在时用组件前缀判断
        return path.starts_with(root);
    };
    let Ok(r) = fs::canonicalize(root) else {
        return false;
    };
    p.starts_with(&r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn rejects_parent_escape() {
        let dir = env::temp_dir().join("lumen_ws_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let ws = Workspace::open(&dir).unwrap();
        assert!(ws.resolve("../x").is_err());
        assert!(ws.resolve("a/../../x").is_err());
    }
}

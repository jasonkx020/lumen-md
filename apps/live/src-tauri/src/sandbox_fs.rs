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
            if is_dir || is_allowed_text_ext(Path::new(&name)) {
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
        decode_text_bytes(bytes)
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

/// 采样前 8KB：含 NUL，或异常控制字符占比过高，则视为二进制。
pub fn looks_like_binary(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    let sample = &bytes[..bytes.len().min(8192)];
    if sample.contains(&0) {
        return true;
    }
    let non_text = sample
        .iter()
        .filter(|&&b| b < 0x09 || (b > 0x0d && b < 0x20) || b == 0x7f)
        .count();
    non_text * 100 / sample.len() > 10
}

/// Decode file bytes: UTF-8 → GB18030 → BOM-sniff → GB18030 lossy.
fn decode_text_bytes(bytes: Vec<u8>) -> anyhow::Result<String> {
    if looks_like_binary(&bytes) {
        anyhow::bail!("二进制文件，无法按文本打开");
    }
    match String::from_utf8(bytes) {
        Ok(s) => Ok(s),
        Err(e) => {
            let bytes = e.into_bytes();
            let (cow, _enc, had_errors) = encoding_rs::GB18030.decode(&bytes);
            if !had_errors {
                return Ok(cow.into_owned());
            }
            if let Some((enc, offset)) = encoding_rs::Encoding::for_bom(&bytes) {
                let (cow, _, had) = enc.decode(&bytes[offset..]);
                if !had {
                    return Ok(cow.into_owned());
                }
            }
            // Last resort: GB18030 lossy so drag-open works on messy Win GBK files
            let (cow, _, _) = encoding_rs::GB18030.decode(&bytes);
            Ok(cow.into_owned())
        }
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
    decode_text_bytes(bytes)
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

/// 可按纯文本打开/编辑/保存的扩展名（小写、无点）。
pub const ALLOWED_TEXT_EXTS: &[&str] = &[
    // 文档
    "md",
    "markdown",
    "txt",
    "log",
    "csv",
    "tsv",
    // 数据 / 配置
    "json",
    "yml",
    "yaml",
    "xml",
    "toml",
    "ini",
    "conf",
    "cfg",
    "env",
    // 脚本
    "bat",
    "cmd",
    "ps1",
    "sh",
    "bash",
    "zsh",
    // 代码 / 前端
    "py",
    "js",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "jsx",
    "css",
    "scss",
    "html",
    "htm",
    "rs",
    "go",
    "java",
    "c",
    "h",
    "cpp",
    "hpp",
    "cs",
    "php",
    "rb",
    "lua",
    "sql",
];

pub fn is_allowed_text_ext(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let Some(dot) = name.rfind('.') else {
        return false;
    };
    let ext = &name[dot + 1..];
    if ext.is_empty() {
        return false;
    }
    ALLOWED_TEXT_EXTS.iter().any(|e| *e == ext)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_script_and_config_exts() {
        assert!(is_allowed_text_ext(Path::new("a.bat")));
        assert!(is_allowed_text_ext(Path::new("run.SH")));
        assert!(is_allowed_text_ext(Path::new("cfg.json")));
        assert!(is_allowed_text_ext(Path::new("note.markdown")));
        assert!(!is_allowed_text_ext(Path::new("app.exe")));
        assert!(!is_allowed_text_ext(Path::new("noext")));
    }

    #[test]
    fn rejects_nul_as_binary() {
        assert!(looks_like_binary(b"abc\0def"));
        assert!(!looks_like_binary(b"hello\r\nworld\t!"));
    }
}

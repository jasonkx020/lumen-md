//! 导出时解析本地图片并嵌入 data URL（HTML/PDF）或供 DOCX 读取字节。

use std::path::{Path, PathBuf};

use base64::Engine;
use scraper::{Html, Selector};

#[derive(Debug, Clone, Default)]
pub struct ExportAssetCtx {
    pub doc_abs: Option<PathBuf>,
    pub workspace_root: Option<PathBuf>,
}

impl ExportAssetCtx {
    pub fn from_opts(doc_abs: Option<&str>, workspace_root: Option<&str>) -> Self {
        Self {
            doc_abs: doc_abs
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(PathBuf::from),
            workspace_root: workspace_root
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(PathBuf::from),
        }
    }
}

fn needs_embed(src: &str) -> bool {
    let s = src.trim();
    if s.is_empty() {
        return false;
    }
    let lower = s.to_ascii_lowercase();
    if lower.starts_with("data:")
        || lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("blob:")
        || lower.starts_with("asset:")
    {
        return false;
    }
    true
}

/// 对齐 Live `resolve_asset_url`：相对路径优先相对文档目录，再回退工作区根。
pub fn resolve_local_image(src: &str, ctx: &ExportAssetCtx) -> Option<PathBuf> {
    let src = src.trim();
    if src.is_empty() || !needs_embed(src) {
        return None;
    }
    let path = Path::new(src);
    if path.is_absolute() {
        return path.is_file().then(|| path.to_path_buf());
    }
    if let Some(doc) = ctx.doc_abs.as_deref() {
        let from_doc = doc.parent().unwrap_or_else(|| Path::new(".")).join(src);
        if from_doc.is_file() {
            return Some(from_doc);
        }
        if let Some(root) = ctx.workspace_root.as_deref() {
            let from_ws = root.join(src);
            if from_ws.is_file() {
                return Some(from_ws);
            }
        }
        return None;
    }
    if let Some(root) = ctx.workspace_root.as_deref() {
        let from_ws = root.join(src);
        if from_ws.is_file() {
            return Some(from_ws);
        }
    }
    None
}

pub fn file_to_data_url(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let mime = match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        _ => "image/png",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:{mime};base64,{b64}"))
}

pub fn read_local_image_bytes(src: &str, ctx: &ExportAssetCtx) -> Option<Vec<u8>> {
    let path = resolve_local_image(src, ctx)?;
    std::fs::read(path).ok()
}

/// 将 HTML 内相对路径 `img[src]` 替换为 data URL，并为 flex 容器打 class。
pub fn embed_images_in_html(html: &str, ctx: &ExportAssetCtx) -> String {
    let mut out = html.to_string();
    if ctx.doc_abs.is_some() || ctx.workspace_root.is_some() {
        if html.to_ascii_lowercase().contains("<img") {
            let fragment = Html::parse_fragment(html);
            if let Ok(sel) = Selector::parse("img[src]") {
                let mut replacements: Vec<(String, String)> = Vec::new();
                for img in fragment.select(&sel) {
                    let Some(src) = img.value().attr("src") else {
                        continue;
                    };
                    if !needs_embed(src) {
                        continue;
                    }
                    if let Some(path) = resolve_local_image(src, ctx) {
                        if let Some(data) = file_to_data_url(&path) {
                            replacements.push((src.to_string(), data));
                        }
                    }
                }
                for (src, data) in replacements {
                    for (open, close) in [('"', '"'), ('\'', '\'')] {
                        let needle = format!("src={open}{src}{close}");
                        let repl = format!("src={open}{data}{close}");
                        out = out.replace(&needle, &repl);
                    }
                }
            }
        }
    }
    mark_flex_containers_in_html(&out)
}

/// 给带 display:flex 的元素加上 `lumen-html-flex` class，便于导出 CSS 命中。
pub fn mark_flex_containers_in_html(html: &str) -> String {
    if !html.to_ascii_lowercase().contains("flex") {
        return html.to_string();
    }
    let fragment = Html::parse_fragment(html);
    let Ok(sel) = Selector::parse("[style]") else {
        return html.to_string();
    };

    // 收集需要改写的 style 属性片段：在原字符串上为对应开标签插入 class
    let mut out = html.to_string();
    for el in fragment.select(&sel) {
        let Some(style) = el.value().attr("style") else {
            continue;
        };
        if !style_looks_flex(style) {
            continue;
        }
        let tag = el.value().name();
        // 已有 class 则追加，否则新增
        let open_pat = format!("<{tag}");
        // 用 style 值定位开标签（足够唯一于常见 README）
        let style_needle = format!("style=\"{style}\"");
        let style_needle_sq = format!("style='{style}'");
        if let Some(idx) = out.find(&style_needle).or_else(|| out.find(&style_needle_sq)) {
            // 向前找最近的 <tag
            let prefix = &out[..idx];
            if let Some(rel) = prefix.rfind(&open_pat) {
                let tag_start = rel;
                let tag_slice = &out[tag_start..idx];
                if tag_slice.contains("lumen-html-flex") {
                    continue;
                }
                if let Some(class_pos) = tag_slice.find("class=\"") {
                    let insert_at = tag_start + class_pos + "class=\"".len();
                    out.insert_str(insert_at, "lumen-html-flex ");
                } else if let Some(class_pos) = tag_slice.find("class='") {
                    let insert_at = tag_start + class_pos + "class='".len();
                    out.insert_str(insert_at, "lumen-html-flex ");
                } else {
                    // 插在标签名后
                    let insert_at = tag_start + open_pat.len();
                    out.insert_str(insert_at, " class=\"lumen-html-flex\"");
                }
            }
        }
        let _ = open_pat;
    }
    out
}

fn style_looks_flex(style: &str) -> bool {
    let compact: String = style
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase();
    compact.contains("display:flex") || compact.contains("display:inline-flex")
}

/// 从 HTML 片段提取所有本地可解析的 img src（按出现顺序）。
pub fn extract_local_img_srcs(html: &str) -> Vec<String> {
    let fragment = Html::parse_fragment(html);
    let Ok(sel) = Selector::parse("img[src]") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for img in fragment.select(&sel) {
        if let Some(src) = img.value().attr("src") {
            if needs_embed(src) {
                out.push(src.to_string());
            }
        }
    }
    out
}

/// 解析完整单标签 HTML `<a …>text</a>` → (href, text)。
pub fn parse_simple_anchor(html: &str) -> Option<(String, String)> {
    let trimmed = html.trim();
    let fragment = Html::parse_fragment(trimmed);
    let Ok(sel) = Selector::parse("a[href]") else {
        return None;
    };
    let a = fragment.select(&sel).next()?;
    let href = a.value().attr("href")?.to_string();
    let text = a.text().collect::<String>();
    let text = if text.trim().is_empty() {
        href.clone()
    } else {
        text
    };
    Some((href, text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn embed_relative_img() {
        let dir = std::env::temp_dir().join(format!(
            "lumen-embed-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        let img = dir.join("docs").join("a.png");
        // 1x1 PNG
        let png: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00,
            0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08,
            0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xFE,
            0xD4, 0xEF, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        let mut f = std::fs::File::create(&img).unwrap();
        f.write_all(png).unwrap();

        let md_path = dir.join("README.md");
        std::fs::write(&md_path, "# x\n").unwrap();
        let ctx = ExportAssetCtx {
            doc_abs: Some(md_path),
            workspace_root: Some(dir.clone()),
        };
        let html = r#"<p><img src="docs/a.png" alt="x" width="10"></p>"#;
        let out = embed_images_in_html(html, &ctx);
        assert!(out.contains("data:image/png;base64,"), "{out}");
        assert!(!out.contains("docs/a.png"), "{out}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn marks_flex_class() {
        let html = r#"<div style="display: flex; justify-content: space-between;"><img src="docs/a.jpg"></div>"#;
        let out = mark_flex_containers_in_html(html);
        assert!(out.contains("lumen-html-flex"), "{out}");
        assert!(out.contains("display: flex"), "{out}");
    }

    #[test]
    fn parse_anchor() {
        let (href, text) = parse_simple_anchor(
            r#"<a href="https://example.com" target="_blank">LiChuang</a>"#,
        )
        .unwrap();
        assert_eq!(href, "https://example.com");
        assert_eq!(text, "LiChuang");
    }
}

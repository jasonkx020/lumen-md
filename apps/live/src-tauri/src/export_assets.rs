//! 导出时解析本地图片并嵌入 data URL（HTML/PDF）或供 DOCX 读取字节。
//! DOCX 额外支持 http(s) 拉取、磁盘缓存，以及 SVG → PNG 栅格化（Word / docx-rs 不吃 SVG）。

use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use directories::ProjectDirs;
use scraper::{Html, Selector};

const MAX_REMOTE_IMAGE_BYTES: usize = 12 * 1024 * 1024;
const MAX_SVG_RASTER_EDGE: u32 = 1600;

#[derive(Debug, Clone, Default)]
pub struct ExportAssetCtx {
    pub doc_abs: Option<PathBuf>,
    pub workspace_root: Option<PathBuf>,
    /// 前端 Chromium 栅格化结果：原始 URL → PNG/JPEG 等字节（优先于网络/resvg）
    pub image_overrides: HashMap<String, Vec<u8>>,
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
            image_overrides: HashMap::new(),
        }
    }

    pub fn with_image_overrides(mut self, overrides: HashMap<String, Vec<u8>>) -> Self {
        self.image_overrides = overrides;
        self
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

fn is_remote_http(src: &str) -> bool {
    let lower = src.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn is_data_url(src: &str) -> bool {
    src.trim().to_ascii_lowercase().starts_with("data:")
}

fn looks_like_svg(bytes: &[u8], src_hint: &str) -> bool {
    let hint = src_hint.to_ascii_lowercase();
    if hint.contains("image/svg") || hint.contains(".svg") || hint.contains("/svg?") {
        return true;
    }
    let head = std::str::from_utf8(bytes.get(..256.min(bytes.len())).unwrap_or(b""))
        .unwrap_or("")
        .trim_start();
    let head = head.strip_prefix("\u{feff}").unwrap_or(head);
    head.starts_with("<svg")
        || head.starts_with("<?xml") && head.to_ascii_lowercase().contains("<svg")
}

fn looks_like_raster(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) // PNG
        || bytes.starts_with(&[0xFF, 0xD8, 0xFF]) // JPEG
        || (bytes.len() > 6 && &bytes[..6] == b"GIF87a")
        || (bytes.len() > 6 && &bytes[..6] == b"GIF89a")
        || (bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP")
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

fn decode_data_url(src: &str) -> Option<Vec<u8>> {
    let s = src.trim();
    let comma = s.find(',')?;
    let (meta, data) = s.split_at(comma);
    let data = &data[1..];
    if meta.to_ascii_lowercase().contains(";base64") {
        base64::engine::general_purpose::STANDARD.decode(data).ok()
    } else {
        Some(urlencoding_decode(data))
    }
}

fn urlencoding_decode(s: &str) -> Vec<u8> {
    // 轻量百分号解码；失败则按原字节
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(a), Some(b)) = (from_hex(bytes[i + 1]), from_hex(bytes[i + 2])) {
                out.push((a << 4) | b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

fn from_hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn fetch_remote_image_bytes(url: &str) -> Option<(Vec<u8>, String)> {
    if let Some(hit) = read_disk_cache(url) {
        return Some(hit);
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("lumen-md-export/0.1")
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .ok()?;
    let resp = client.get(url).send().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = resp.bytes().ok()?;
    if bytes.is_empty() || bytes.len() > MAX_REMOTE_IMAGE_BYTES {
        return None;
    }
    let bytes = bytes.to_vec();
    write_disk_cache(url, &bytes, &ctype);
    Some((bytes, ctype))
}

fn image_cache_dir() -> Option<PathBuf> {
    let dirs = ProjectDirs::from("com", "LumenMD", "Lumen MD Live")?;
    let dir = dirs.cache_dir().join("image-cache");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn url_cache_stem(url: &str) -> String {
    let mut hasher = DefaultHasher::new();
    url.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn cache_paths(url: &str) -> Option<(PathBuf, PathBuf)> {
    let dir = image_cache_dir()?;
    let stem = url_cache_stem(url);
    Some((dir.join(format!("{stem}.bin")), dir.join(format!("{stem}.ctype"))))
}

fn read_disk_cache(url: &str) -> Option<(Vec<u8>, String)> {
    let (bin, ctype_path) = cache_paths(url)?;
    let bytes = std::fs::read(bin).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_REMOTE_IMAGE_BYTES {
        return None;
    }
    let ctype = std::fs::read_to_string(ctype_path).unwrap_or_default();
    Some((bytes, ctype))
}

fn write_disk_cache(url: &str, bytes: &[u8], ctype: &str) {
    let Some((bin, ctype_path)) = cache_paths(url) else {
        return;
    };
    let _ = std::fs::write(bin, bytes);
    let _ = std::fs::write(ctype_path, ctype);
}

fn mime_from_bytes_or_ctype(bytes: &[u8], ctype: &str) -> &'static str {
    if looks_like_svg(bytes, ctype) {
        return "image/svg+xml";
    }
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return "image/png";
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return "image/jpeg";
    }
    if bytes.len() > 6 && (&bytes[..6] == b"GIF87a" || &bytes[..6] == b"GIF89a") {
        return "image/gif";
    }
    let c = ctype.to_ascii_lowercase();
    if c.contains("jpeg") || c.contains("jpg") {
        return "image/jpeg";
    }
    if c.contains("gif") {
        return "image/gif";
    }
    if c.contains("webp") {
        return "image/webp";
    }
    if c.contains("svg") {
        return "image/svg+xml";
    }
    "image/png"
}

/// 预览用：下载（或读缓存）远程图，返回 data URL。
pub fn cache_remote_image_data_url(url: &str) -> anyhow::Result<String> {
    let url = url.trim();
    if !is_remote_http(url) {
        anyhow::bail!("仅支持 http(s) URL");
    }
    let (bytes, ctype) =
        fetch_remote_image_bytes(url).ok_or_else(|| anyhow::anyhow!("下载远程图片失败"))?;
    let mime = mime_from_bytes_or_ctype(&bytes, &ctype);
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

/// 解析前端传入的 imageOverrides（URL → data URL）。
pub fn parse_image_overrides(
    raw: Option<HashMap<String, String>>,
) -> HashMap<String, Vec<u8>> {
    let mut out = HashMap::new();
    let Some(map) = raw else {
        return out;
    };
    for (url, data_url) in map {
        let url = url.trim().to_string();
        if url.is_empty() {
            continue;
        }
        if let Some(bytes) = decode_data_url(&data_url) {
            if !bytes.is_empty() && bytes.len() <= MAX_REMOTE_IMAGE_BYTES {
                out.insert(url, bytes);
            }
        }
    }
    out
}

/// SVG → PNG；docx-rs / Word 嵌入路径只稳妥吃栅格图。
pub fn svg_to_png(svg_bytes: &[u8]) -> Option<Vec<u8>> {
    let mut opt = resvg::usvg::Options::default();
    opt.fontdb_mut().load_system_fonts();
    let tree = resvg::usvg::Tree::from_data(svg_bytes, &opt).ok()?;
    let size = tree.size().to_int_size();
    let mut w = size.width().max(1);
    let mut h = size.height().max(1);
    if w > MAX_SVG_RASTER_EDGE || h > MAX_SVG_RASTER_EDGE {
        let scale = (MAX_SVG_RASTER_EDGE as f32) / (w.max(h) as f32);
        w = ((w as f32) * scale).round().max(1.0) as u32;
        h = ((h as f32) * scale).round().max(1.0) as u32;
    }
    let mut pixmap = resvg::tiny_skia::Pixmap::new(w, h)?;
    let sx = w as f32 / tree.size().width();
    let sy = h as f32 / tree.size().height();
    let transform = resvg::tiny_skia::Transform::from_scale(sx, sy);
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    pixmap.encode_png().ok()
}

fn ensure_docx_raster(bytes: Vec<u8>, src_hint: &str) -> Option<Vec<u8>> {
    if looks_like_raster(&bytes) {
        return Some(bytes);
    }
    if looks_like_svg(&bytes, src_hint) {
        svg_to_png(&bytes)
    } else {
        Some(bytes)
    }
}

/// DOCX 用：overrides → 本地 / data URL / http(s)（SVG 必要时栅格化为 PNG）。
pub fn read_export_image_bytes(src: &str, ctx: &ExportAssetCtx) -> Option<Vec<u8>> {
    let src = src.trim();
    if src.is_empty() {
        return None;
    }
    if let Some(bytes) = ctx.image_overrides.get(src) {
        return ensure_docx_raster(bytes.clone(), src);
    }
    if is_data_url(src) {
        let bytes = decode_data_url(src)?;
        return ensure_docx_raster(bytes, src);
    }
    if is_remote_http(src) {
        let (bytes, ctype) = fetch_remote_image_bytes(src)?;
        let hint = if ctype.is_empty() { src } else { &ctype };
        return ensure_docx_raster(bytes, hint);
    }
    let bytes = read_local_image_bytes(src, ctx)?;
    ensure_docx_raster(bytes, src)
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

/// DOCX 用：本地相对路径 + http(s) + data URL 的 `img[src]`（含 `<picture>` 内）。
pub fn extract_export_img_srcs(html: &str) -> Vec<String> {
    let fragment = Html::parse_fragment(html);
    let Ok(sel) = Selector::parse("img[src]") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for img in fragment.select(&sel) {
        let Some(src) = img.value().attr("src") else {
            continue;
        };
        let src = src.trim();
        if src.is_empty() {
            continue;
        }
        if needs_embed(src) || is_remote_http(src) || is_data_url(src) {
            out.push(src.to_string());
        }
    }
    out
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
            ..Default::default()
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

    #[test]
    fn extract_export_srcs_from_picture() {
        let html = r#"<a href="https://star-history.com/#78/xiaozhi-esp32&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=78/xiaozhi-esp32&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=78/xiaozhi-esp32&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=78/xiaozhi-esp32&type=Date" />
 </picture>
</a>"#;
        let local = extract_local_img_srcs(html);
        assert!(local.is_empty(), "remote should not be local-only: {local:?}");
        let all = extract_export_img_srcs(html);
        assert_eq!(all.len(), 1);
        assert!(all[0].starts_with("https://api.star-history.com/svg?"));
    }

    #[test]
    fn svg_rasterizes_to_png() {
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20">
  <rect width="40" height="20" fill="#336699"/>
</svg>"##;
        let png = svg_to_png(svg).expect("svg_to_png");
        assert!(png.starts_with(&[0x89, 0x50, 0x4E, 0x47]), "not png");
        assert!(png.len() > 40);
    }

    #[test]
    fn overrides_skip_network() {
        let png: Vec<u8> = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00,
            0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08,
            0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xFE,
            0xD4, 0xEF, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        let url = "https://example.com/never-fetched.svg";
        let mut overrides = HashMap::new();
        overrides.insert(url.to_string(), png.clone());
        let ctx = ExportAssetCtx {
            image_overrides: overrides,
            ..Default::default()
        };
        let got = read_export_image_bytes(url, &ctx).expect("override");
        assert_eq!(got, png);
    }

    #[test]
    fn parse_overrides_from_data_url() {
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let mut raw = HashMap::new();
        raw.insert(
            "https://example.com/a.png".into(),
            format!("data:image/png;base64,{png_b64}"),
        );
        let map = parse_image_overrides(Some(raw));
        assert_eq!(map.len(), 1);
        assert!(map.get("https://example.com/a.png").unwrap().starts_with(&[0x89, 0x50, 0x4E, 0x47]));
    }
}

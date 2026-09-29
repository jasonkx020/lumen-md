//! Markdown → DOCX / PDF（GitHub 主题）。
//!
//! # PDF 策略
//! 首选：GitHub 风 HTML → 本机临时 HTTP → Chrome/Chromium/Edge `--print-to-pdf`。
//! 回退：自研 DOCX → LibreOffice（若已安装）。
//!
//! 刻意避免高危进程指纹：脚本宿主绕过执行策略、Office 自动化、浏览器远程调试端口等
//! （易触发国内杀软启发式误报）。

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crate::export_assets::ExportAssetCtx;
use crate::md_docx::{
    markdown_to_docx_bytes_with_ctx, markdown_to_github_html_with_ctx, PDF_HTML_CANARY,
};

/// PDF 转换所用后端（返回给前端状态栏）。
pub type PdfExportMode = &'static str;

fn ensure_parent(path: &Path) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn tmp_export_dir() -> anyhow::Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!(
        "lumen-md-export-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn which_in_path(name: &str) -> anyhow::Result<PathBuf> {
    #[cfg(windows)]
    let output = Command::new("where")
        .arg(name)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()?;
    #[cfg(not(windows))]
    let output = Command::new("sh")
        .args(["-c", &format!("command -v {}", shell_escape(name))])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()?;

    if !output.status.success() {
        anyhow::bail!("not found");
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let first = text
        .lines()
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("empty"))?;
    let p = PathBuf::from(first);
    if p.is_file() {
        Ok(p)
    } else {
        anyhow::bail!("invalid")
    }
}

#[cfg(not(windows))]
fn shell_escape(s: &str) -> String {
    // PATH 查找名仅允许安全字符
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        s.to_string()
    } else {
        String::new()
    }
}

/// 在目录内生成临时 docx，返回路径。
fn md_to_temp_docx(
    dir: &Path,
    markdown: &str,
    ctx: &ExportAssetCtx,
) -> anyhow::Result<PathBuf> {
    let bytes = markdown_to_docx_bytes_with_ctx(markdown, ctx)?;
    let out_tmp = dir.join("out.docx");
    fs::write(&out_tmp, bytes)?;
    Ok(out_tmp)
}

/// Markdown → DOCX（纯 Rust）。
#[allow(dead_code)] // 无 ctx 便捷入口；IPC 走 with_ctx
pub fn md_to_docx(markdown: &str, out_path: &Path) -> anyhow::Result<()> {
    md_to_docx_with_ctx(markdown, out_path, &ExportAssetCtx::default())
}

pub fn md_to_docx_with_ctx(
    markdown: &str,
    out_path: &Path,
    ctx: &ExportAssetCtx,
) -> anyhow::Result<()> {
    ensure_parent(out_path)?;
    let bytes = markdown_to_docx_bytes_with_ctx(markdown, ctx)?;
    fs::write(out_path, bytes)?;
    Ok(())
}

fn find_libreoffice() -> Option<PathBuf> {
    let mut candidates = Vec::new();

    #[cfg(windows)]
    {
        let prog = std::env::var_os("PROGRAMFILES").map(PathBuf::from);
        let prog86 = std::env::var_os("PROGRAMFILES(X86)").map(PathBuf::from);
        for root in [prog, prog86].into_iter().flatten() {
            let base = root.join("LibreOffice").join("program");
            candidates.push(base.join("soffice.com"));
            candidates.push(base.join("soffice.exe"));
        }
        for name in ["soffice.com", "soffice", "soffice.exe"] {
            if let Ok(p) = which_in_path(name) {
                candidates.push(p);
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from(
            "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        ));
        if let Ok(p) = which_in_path("soffice") {
            candidates.insert(0, p);
        }
    }

    #[cfg(target_os = "linux")]
    {
        for p in [
            "/usr/bin/soffice",
            "/usr/bin/libreoffice",
            "/usr/lib/libreoffice/program/soffice",
            "/snap/bin/libreoffice",
        ] {
            candidates.push(PathBuf::from(p));
        }
        for name in ["soffice", "libreoffice"] {
            if let Ok(p) = which_in_path(name) {
                candidates.insert(0, p);
            }
        }
    }

    candidates.into_iter().find(|p| p.is_file())
}

fn docx_to_pdf_libreoffice(docx: &Path, out_pdf: &Path) -> anyhow::Result<()> {
    let soffice = find_libreoffice().ok_or_else(|| anyhow::anyhow!("未找到 LibreOffice"))?;
    let outdir = out_pdf
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    ensure_parent(out_pdf)?;

    let user_profile = std::env::temp_dir().join(format!(
        "lumen-lo-profile-{}",
        std::process::id()
    ));
    let _ = fs::create_dir_all(&user_profile);
    let profile_url = {
        let s = strip_windows_verbatim(&user_profile)
            .to_string_lossy()
            .replace('\\', "/");
        if s.starts_with('/') {
            format!("file://{s}")
        } else {
            format!("file:///{s}")
        }
    };

    let status = Command::new(&soffice)
        .arg("--headless")
        .arg("--norestore")
        .arg("--nolockcheck")
        .arg(format!("-env:UserInstallation={profile_url}"))
        .arg("--convert-to")
        .arg("pdf:writer_pdf_Export")
        .arg("--outdir")
        .arg(&outdir)
        .arg(docx)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .status()?;

    if !status.success() {
        anyhow::bail!("LibreOffice 退出码 {:?}", status.code());
    }

    let produced = outdir.join(
        docx.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("out")
            .to_string()
            + ".pdf",
    );

    for _ in 0..40 {
        if produced.is_file() && fs::metadata(&produced).map(|m| m.len()).unwrap_or(0) > 0 {
            if produced != out_pdf {
                fs::copy(&produced, out_pdf)?;
            }
            let _ = fs::remove_dir_all(&user_profile);
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    anyhow::bail!("LibreOffice 未生成 PDF");
}

fn strip_windows_verbatim(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

fn pdf_looks_nonempty(path: &Path) -> bool {
    fs::metadata(path)
        .map(|m| m.is_file() && m.len() >= 800)
        .unwrap_or(false)
}

/// Chrome 常把 PDF `/Title` 写成 UTF-16BE hex（`<FEFF004C…>`），正文流则压缩，
/// 直接搜 ASCII 金丝雀会误判「未打开导出 HTML」。
fn pdf_canary_utf16be_hex(canary: &str) -> String {
    canary
        .chars()
        .map(|c| format!("{:04X}", u32::from(c)))
        .collect()
}

fn pdf_contains_canary(path: &Path) -> bool {
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    let ascii = String::from_utf8_lossy(&bytes);
    if ascii.contains(PDF_HTML_CANARY)
        || ascii.contains("lumen-md-pdf-canary")
        || bytes
            .windows(PDF_HTML_CANARY.len())
            .any(|w| w == PDF_HTML_CANARY.as_bytes())
    {
        return true;
    }
    let hex = pdf_canary_utf16be_hex(PDF_HTML_CANARY);
    ascii.to_ascii_uppercase().contains(&hex)
}

fn pdf_looks_like_browser_ntp(bytes: &[u8]) -> bool {
    let ascii = String::from_utf8_lossy(bytes).to_ascii_lowercase();
    ascii.contains("chrome://new-tab")
        || ascii.contains("chrome://newtab")
        || ascii.contains("chrome://new-tab-page")
        || ascii.contains("/title (google)")
        || ascii.contains("/title(google)")
        || ascii.contains("在 google 中搜索")
        || ascii.contains("search google or type a url")
}

fn md_to_pdf_github_html(
    markdown: &str,
    out_path: &Path,
    ctx: &ExportAssetCtx,
) -> anyhow::Result<()> {
    let html = markdown_to_github_html_with_ctx(markdown, ctx)?;
    html_to_pdf(&html, out_path)
}

/// Markdown → PDF。返回模式：`github-html` | `libreoffice`。
#[allow(dead_code)] // 无 ctx 便捷入口 / 单测；IPC 走 with_ctx
pub fn md_to_pdf(markdown: &str, out_path: &Path) -> anyhow::Result<PdfExportMode> {
    md_to_pdf_with_ctx(markdown, out_path, &ExportAssetCtx::default())
}

pub fn md_to_pdf_with_ctx(
    markdown: &str,
    out_path: &Path,
    ctx: &ExportAssetCtx,
) -> anyhow::Result<PdfExportMode> {
    ensure_parent(out_path)?;
    let _ = fs::remove_file(out_path);

    let mut last_err = String::new();

    // 1) GitHub 风 HTML → Edge/Chrome（最接近 github.com 预览）
    match md_to_pdf_github_html(markdown, out_path, ctx) {
        Ok(()) if pdf_looks_nonempty(out_path) => return Ok("github-html"),
        Ok(()) => {
            let _ = fs::remove_file(out_path);
            last_err.push_str("GitHub HTML 打印结果为空");
        }
        Err(e) => {
            last_err.push_str(&format!("GitHub HTML: {e}"));
        }
    }

    // 2) 回退：DOCX → LibreOffice
    let dir = tmp_export_dir()?;
    let docx = match md_to_temp_docx(&dir, markdown, ctx) {
        Ok(p) => p,
        Err(e) => {
            let _ = fs::remove_dir_all(&dir);
            anyhow::bail!("PDF 导出失败：{last_err}；生成 DOCX 也失败：{e}");
        }
    };
    let tmp_pdf = dir.join("converted.pdf");

    if find_libreoffice().is_some() {
        let _ = fs::remove_file(&tmp_pdf);
        match docx_to_pdf_libreoffice(&docx, &tmp_pdf) {
            Ok(()) if pdf_looks_nonempty(&tmp_pdf) => {
                fs::copy(&tmp_pdf, out_path)?;
                let _ = fs::remove_dir_all(&dir);
                return Ok("libreoffice");
            }
            Ok(()) => {
                if !last_err.is_empty() {
                    last_err.push_str("; ");
                }
                last_err.push_str("LibreOffice 生成了空 PDF");
            }
            Err(e) => {
                if !last_err.is_empty() {
                    last_err.push_str("; ");
                }
                last_err.push_str(&format!("LibreOffice: {e}"));
            }
        }
    }

    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_file(out_path);
    anyhow::bail!(
        "PDF 导出失败：{last_err}。请确认已安装 Chrome / Chromium / Edge，或 LibreOffice。"
    );
}

fn browser_candidates() -> Vec<PathBuf> {
    let mut list = Vec::new();

    #[cfg(windows)]
    {
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        let prog = std::env::var_os("PROGRAMFILES").map(PathBuf::from);
        let prog86 = std::env::var_os("PROGRAMFILES(X86)").map(PathBuf::from);

        if let Some(la) = &local {
            list.push(
                la.join("Microsoft")
                    .join("Edge")
                    .join("Application")
                    .join("msedge.exe"),
            );
            list.push(
                la.join("Google")
                    .join("Chrome")
                    .join("Application")
                    .join("chrome.exe"),
            );
        }
        for root in [prog, prog86].into_iter().flatten() {
            list.push(
                root.join("Microsoft")
                    .join("Edge")
                    .join("Application")
                    .join("msedge.exe"),
            );
            list.push(
                root.join("Google")
                    .join("Chrome")
                    .join("Application")
                    .join("chrome.exe"),
            );
        }
    }

    #[cfg(target_os = "macos")]
    {
        list.push(PathBuf::from(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ));
        list.push(PathBuf::from(
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ));
        list.push(PathBuf::from(
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ));
        for name in ["google-chrome", "chromium", "microsoft-edge"] {
            if let Ok(p) = which_in_path(name) {
                list.push(p);
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        for p in [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge",
            "/usr/bin/microsoft-edge-stable",
            "/snap/bin/chromium",
        ] {
            list.push(PathBuf::from(p));
        }
        for name in [
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
            "microsoft-edge",
            "microsoft-edge-stable",
        ] {
            if let Ok(p) = which_in_path(name) {
                list.insert(0, p);
            }
        }
    }

    list
}

/// 构造 file:// URL（HTTP 打印失败时的回退；不放开浏览器本地文件跨源读取）。
fn file_url(path: &Path) -> String {
    let path = strip_windows_verbatim(path);
    let s = path.to_string_lossy().replace('\\', "/");
    let s = s.strip_prefix("//?/").unwrap_or(&s);
    if s.starts_with('/') {
        format!("file://{s}")
    } else {
        format!("file:///{s}")
    }
}

fn handle_http_client(mut stream: TcpStream, body: &[u8]) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buf = [0u8; 2048];
    let n = stream.read(&mut buf).unwrap_or(0);
    let req = String::from_utf8_lossy(&buf[..n]);
    let line = req.lines().next().unwrap_or("");
    let ok = line.contains("GET / ")
        || line.contains("GET /export.html")
        || line.contains("GET /index.html");
    if ok {
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(header.as_bytes());
        let _ = stream.write_all(body);
    } else {
        let msg = b"Not Found";
        let header = format!(
            "HTTP/1.1 404 Not Found\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            msg.len()
        );
        let _ = stream.write_all(header.as_bytes());
        let _ = stream.write_all(msg);
    }
    let _ = stream.flush();
}

/// 在 127.0.0.1 上短生命周期托管 HTML，供 headless 浏览器打印（避免 file 协议放开本地文件访问）。
fn spawn_local_html_server(
    html: &[u8],
) -> anyhow::Result<(u16, Arc<AtomicBool>, thread::JoinHandle<()>)> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = Arc::clone(&stop);
    let body = html.to_vec();
    let handle = thread::spawn(move || {
        let _ = listener.set_nonblocking(true);
        let deadline = Instant::now() + Duration::from_secs(90);
        while !stop_flag.load(Ordering::SeqCst) && Instant::now() < deadline {
            match listener.accept() {
                Ok((stream, _)) => handle_http_client(stream, &body),
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20));
                }
                Err(_) => break,
            }
        }
    });
    Ok((port, stop, handle))
}

fn try_print_cli(browser: &Path, page_url: &str, pdf_abs: &Path) -> anyhow::Result<()> {
    let pdf_for_chrome = strip_windows_verbatim(pdf_abs);
    let _ = fs::remove_file(&pdf_for_chrome);
    if pdf_abs != pdf_for_chrome.as_path() {
        let _ = fs::remove_file(pdf_abs);
    }
    // 低敏感参数：不用沙箱关闭开关、本地文件放开、远程调试端口
    let status = Command::new(browser)
        .arg("--headless=new")
        .arg("--disable-gpu")
        .arg("--no-pdf-header-footer")
        .arg("--force-device-scale-factor=1")
        .arg("--run-all-compositor-stages-before-draw")
        .arg("--virtual-time-budget=15000")
        .arg(format!("--print-to-pdf={}", pdf_for_chrome.display()))
        .arg(page_url)
        .status()?;
    if !status.success() {
        anyhow::bail!("退出码 {:?}", status.code());
    }
    for _ in 0..80 {
        if pdf_looks_nonempty(&pdf_for_chrome) && pdf_contains_canary(&pdf_for_chrome) {
            if pdf_abs != pdf_for_chrome.as_path() {
                fs::copy(&pdf_for_chrome, pdf_abs)?;
            }
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    if let Ok(bytes) = fs::read(&pdf_for_chrome) {
        if pdf_looks_like_browser_ntp(&bytes) || !pdf_contains_canary(&pdf_for_chrome) {
            anyhow::bail!("浏览器未打开导出 HTML（疑似打印了新标签页）。URL: {page_url}");
        }
        anyhow::bail!("生成的 PDF 疑似空白（{} bytes）", bytes.len());
    }
    anyhow::bail!("未生成有效 PDF；URL: {page_url}");
}

fn html_to_pdf(html: &str, pdf_path: &Path) -> anyhow::Result<()> {
    ensure_parent(pdf_path)?;

    let tmp_dir = tmp_export_dir()?;
    let html_path = tmp_dir.join("export.html");
    fs::write(&html_path, html.as_bytes())?;
    let html_bytes = fs::read(&html_path)?;
    let tmp_pdf = tmp_dir.join("export.pdf");
    let mut last_err = String::from("未找到可用的 Chrome/Chromium/Edge");

    // 1) 本机 HTTP（避免 file 协议放开本地文件访问）
    let http_ok = {
        let (port, stop, server) = spawn_local_html_server(&html_bytes)?;
        let page_url = format!("http://127.0.0.1:{port}/export.html");
        let result = try_print_with_browsers(&page_url, &tmp_pdf, &mut last_err);
        stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", port));
        let _ = server.join();
        if result.is_ok() {
            if let Err(e) = fs::copy(&tmp_pdf, pdf_path) {
                let _ = fs::remove_dir_all(&tmp_dir);
                return Err(e.into());
            }
            let _ = fs::remove_dir_all(&tmp_dir);
            return Ok(());
        }
        false
    };
    let _ = http_ok;

    // 2) file:// 回退（自包含 HTML；不用高危 file-access 开关）
    let file_page = file_url(&html_path);
    match try_print_with_browsers(&file_page, &tmp_pdf, &mut last_err) {
        Ok(()) => {
            fs::copy(&tmp_pdf, pdf_path)?;
            let _ = fs::remove_dir_all(&tmp_dir);
            Ok(())
        }
        Err(_) => {
            let _ = fs::remove_dir_all(&tmp_dir);
            anyhow::bail!(
                "无法用浏览器生成 PDF（{}）。请安装 Chrome / Chromium / Edge。",
                last_err
            )
        }
    }
}

fn try_print_with_browsers(
    page_url: &str,
    tmp_pdf: &Path,
    last_err: &mut String,
) -> anyhow::Result<()> {
    for browser in browser_candidates() {
        if !browser.is_file() {
            continue;
        }
        let _ = fs::remove_file(tmp_pdf);
        match try_print_cli(&browser, page_url, tmp_pdf) {
            Ok(()) => return Ok(()),
            Err(e) => {
                *last_err = format!("{}: {}", browser.display(), e);
            }
        }
    }
    anyhow::bail!("{last_err}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_verbatim_and_file_url() {
        let p = PathBuf::from(r"\\?\C:\Users\Admin\AppData\Local\Temp\export.html");
        assert_eq!(
            strip_windows_verbatim(&p),
            PathBuf::from(r"C:\Users\Admin\AppData\Local\Temp\export.html")
        );
        assert_eq!(
            file_url(&p),
            "file:///C:/Users/Admin/AppData/Local/Temp/export.html"
        );
        let bad = format!("file://{}", p.to_string_lossy().replace('\\', "/"));
        assert!(bad.contains("//?/"), "sanity: raw verbatim URL is broken");
        assert!(!file_url(&p).contains("//?/"));
    }

    #[test]
    fn github_html_contains_canary() {
        let html = crate::md_docx::markdown_to_github_html("# hi\n\nprobe").unwrap();
        assert!(html.contains(PDF_HTML_CANARY));
    }

    #[test]
    fn canary_detects_chrome_utf16be_hex_title() {
        // 模拟 Chrome 写入的 /Title <FEFF…UTF-16BE hex…>
        let hex = pdf_canary_utf16be_hex(PDF_HTML_CANARY);
        assert_eq!(hex, "004C0055004D0045004E004D0044005F005000440046005F004F004B");
        let fake = format!("%PDF-1.4\n1 0 obj<</Title <FEFF{hex}>>endobj\n");
        let dir = tmp_export_dir().expect("tmp");
        let p = dir.join("fake.pdf");
        fs::write(&p, fake.as_bytes()).unwrap();
        assert!(pdf_contains_canary(&p));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn md_to_pdf_github_html_not_ntp() {
        let dir = tmp_export_dir().expect("tmp");
        let out = dir.join("out.pdf");
        let mode = md_to_pdf("# PDF 修复验证\n\n正文 **bold** 与 `code`。\n", &out)
            .expect("md_to_pdf");
        assert_eq!(mode, "github-html");
        assert!(pdf_contains_canary(&out), "PDF must contain HTML canary");
        let bytes = fs::read(&out).unwrap();
        assert!(!pdf_looks_like_browser_ntp(&bytes));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_high_risk_process_fingerprints() {
        let src = include_str!("export_file.rs");
        // 只扫本测试之前的实现代码，避免断言字面量自污染
        let code = src
            .split("mod tests")
            .next()
            .expect("tests module");
        let needles = [
            ["Execution", "Policy"].concat(),
            ["By", "pass"].concat(),
            ["remote-debugging", "-port"].concat(),
            ["--no-", "sandbox"].concat(),
            ["allow-file-access-from-", "files"].concat(),
            ["New-Object -Com", "Object"].concat(),
            "powershell".to_string(),
        ];
        for n in needles {
            assert!(
                !code.to_ascii_lowercase().contains(&n.to_ascii_lowercase()),
                "high-risk fingerprint still present: {n}"
            );
        }
    }
}

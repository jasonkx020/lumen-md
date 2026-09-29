//! Markdown → DOCX / PDF（GitHub 主题）。
//!
//! # PDF 策略
//! 首选：GitHub 风 HTML → Chrome/Chromium/Edge 打印（模式 `github-html`）。
//! 回退：自研 DOCX → LibreOffice；Windows 另可回退 Word COM。

use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};

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
    let soffice = find_libreoffice().ok_or_else(|| anyhow::anyhow!("无 LibreOffice"))?;
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
        .arg(format!("-env:UserInstallation={}", profile_url))
        .arg("--convert-to")
        .arg("pdf:writer_pdf_Export")
        .arg("--outdir")
        .arg(&outdir)
        .arg(docx)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .status()?;

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

    let _ = fs::remove_dir_all(&user_profile);
    if !status.success() {
        anyhow::bail!("LibreOffice 退出码 {:?}", status.code());
    }
    anyhow::bail!("LibreOffice 未生成 PDF");
}

/// Windows `canonicalize` 常带 `\\?\`；Chrome 的 `file://` 打不开，会落到新标签页再「打印」成假 PDF。
fn strip_windows_verbatim(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else if let Some(rest) = s.strip_prefix("//?/") {
        PathBuf::from(rest.replace('/', "\\"))
    } else {
        path.to_path_buf()
    }
}

/// 粗测 PDF 是否像「有正文」（避免空白页被当成成功）。
fn pdf_looks_nonempty(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if meta.len() < 8000 {
        return false;
    }
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    let ascii = String::from_utf8_lossy(&bytes);
    ascii.contains("/Type /Page") || ascii.contains("/Type/Page")
}

fn pdf_contains_canary(path: &Path) -> bool {
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    let ascii = String::from_utf8_lossy(&bytes);
    if ascii.contains(PDF_HTML_CANARY) {
        return true;
    }
    // Chromium 常把 <title> 写成 /Title <FEFF....> UTF-16BE 十六进制
    let hex: String = PDF_HTML_CANARY
        .encode_utf16()
        .flat_map(|u| u.to_be_bytes())
        .map(|b| format!("{b:02X}"))
        .collect();
    ascii.to_ascii_uppercase().contains(&hex)
}

/// Headless 打开无效 file:// 时会打印 Google 新标签页（体积也可能够大）。
fn pdf_looks_like_browser_ntp(bytes: &[u8]) -> bool {
    let ascii = String::from_utf8_lossy(bytes);
    ascii.contains("chrome-search://")
        || ascii.contains("chrome://new-tab")
        || ascii.contains("chrome://newtab")
        || ascii.contains("chrome://new-tab-page")
        || ascii.contains("/Title (Google)")
        || ascii.contains("/Title(Google)")
        || ascii.contains("在 Google 中搜索")
        || ascii.contains("Search Google or type a URL")
}

/// Word COM：SaveAs2 → PDF（仅 Windows）。Quit 常抛 0x800706BE，以文件是否生成为准。
#[cfg(windows)]
fn docx_to_pdf_word_com(docx: &Path, out_pdf: &Path) -> anyhow::Result<()> {
    ensure_parent(out_pdf)?;
    let _ = fs::remove_file(out_pdf);
    let docx_s = docx.to_string_lossy().replace('\'', "''");
    let pdf_s = out_pdf.to_string_lossy().replace('\'', "''");
    let script = format!(
        r#"
$ErrorActionPreference = 'Continue'
$word = $null
$ok = $false
try {{
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Open('{docx}', $false, $true)
  $doc.SaveAs2('{pdf}', 17)
  $doc.Close($false)
  $ok = (Test-Path -LiteralPath '{pdf}') -and ((Get-Item -LiteralPath '{pdf}').Length -ge 8000)
}} catch {{
  Write-Output ("WORD_ERR:" + $_.Exception.Message)
}} finally {{
  if ($null -ne $word) {{
    try {{ $word.Quit($false) }} catch {{ }}
    try {{ [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) }} catch {{ }}
  }}
}}
if (-not $ok) {{ exit 2 }}
exit 0
"#,
        docx = docx_s,
        pdf = pdf_s,
    );

    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()?;

    if pdf_looks_nonempty(out_pdf) {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&output.stderr);
    let out = String::from_utf8_lossy(&output.stdout);
    anyhow::bail!(
        "Word COM 未生成有效 PDF（exit {:?}）：{} {}",
        output.status.code(),
        err.trim(),
        out.trim()
    );
}

fn md_to_pdf_github_html(
    markdown: &str,
    out_path: &Path,
    ctx: &ExportAssetCtx,
) -> anyhow::Result<()> {
    let html = markdown_to_github_html_with_ctx(markdown, ctx)?;
    html_to_pdf(&html, out_path)
}

/// Markdown → PDF。返回模式：`github-html` | `libreoffice` | `word`。
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

    // 2) 回退：DOCX → LibreOffice / Word
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

    let _ = fs::remove_file(&tmp_pdf);
    #[cfg(windows)]
    {
        match docx_to_pdf_word_com(&docx, &tmp_pdf) {
            Ok(()) if pdf_looks_nonempty(&tmp_pdf) => {
                fs::copy(&tmp_pdf, out_path)?;
                let _ = fs::remove_dir_all(&dir);
                return Ok("word");
            }
            Ok(()) => {
                if !last_err.is_empty() {
                    last_err.push_str("; ");
                }
                last_err.push_str("Word 生成了空 PDF");
            }
            Err(e) => {
                if !last_err.is_empty() {
                    last_err.push_str("; ");
                }
                last_err.push_str(&format!("Word: {e}"));
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

fn try_print(browser: &Path, file_url: &str, pdf_abs: &Path) -> anyhow::Result<()> {
    // 优先 CDP：generateDocumentOutline → PDF 书签目录
    match try_print_cdp(browser, file_url, pdf_abs) {
        Ok(()) => return Ok(()),
        Err(e) => {
            eprintln!("[lumen] CDP PDF 失败，回退 CLI: {e}");
        }
    }
    try_print_cli(browser, file_url, pdf_abs)
}

fn pick_free_port() -> anyhow::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

fn wait_http_ok(url: &str, timeout: Duration) -> anyhow::Result<String> {
    let start = Instant::now();
    let mut last = String::new();
    while start.elapsed() < timeout {
        match ureq_get(url) {
            Ok(body) => return Ok(body),
            Err(e) => last = e.to_string(),
        }
        std::thread::sleep(Duration::from_millis(80));
    }
    anyhow::bail!("等待 Chrome DevTools 超时: {last}")
}

/// 极简 HTTP GET（避免再引 reqwest 到同步路径）。
fn ureq_get(url: &str) -> anyhow::Result<String> {
    let resp = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()?
        .get(url)
        .send()?;
    if !resp.status().is_success() {
        anyhow::bail!("HTTP {}", resp.status());
    }
    Ok(resp.text()?)
}

fn try_print_cdp(browser: &Path, file_url: &str, pdf_abs: &Path) -> anyhow::Result<()> {
    let pdf_for_chrome = strip_windows_verbatim(pdf_abs);
    let _ = fs::remove_file(&pdf_for_chrome);
    if pdf_abs != pdf_for_chrome.as_path() {
        let _ = fs::remove_file(pdf_abs);
    }

    let port = pick_free_port()?;
    let mut child: Child = Command::new(browser)
        .arg("--headless=new")
        .arg("--no-sandbox")
        .arg("--disable-gpu")
        .arg("--allow-file-access-from-files")
        .arg("--remote-allow-origins=*")
        .arg(format!("--remote-debugging-port={port}"))
        .arg(file_url)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;

    let result = (|| -> anyhow::Result<()> {
        let list_url = format!("http://127.0.0.1:{port}/json/list");
        let body = wait_http_ok(&list_url, Duration::from_secs(12))?;
        let pages: Value = serde_json::from_str(&body)?;
        let arr = pages
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("/json/list 非数组"))?;
        let ws = arr
            .iter()
            .find_map(|p| {
                let t = p.get("type")?.as_str()?;
                if t != "page" {
                    return None;
                }
                p.get("webSocketDebuggerUrl")?.as_str().map(|s| s.to_string())
            })
            .ok_or_else(|| anyhow::anyhow!("无可用 page WebSocket"))?;

        let (mut socket, _) = tungstenite::connect(&ws)
            .map_err(|e| anyhow::anyhow!("WebSocket 连接失败: {e}"))?;

        let mut next_id = 1u64;
        let mut send = |method: &str, params: Value| -> anyhow::Result<Value> {
            let id = next_id;
            next_id += 1;
            let msg = json!({ "id": id, "method": method, "params": params });
            socket
                .send(tungstenite::Message::Text(msg.to_string().into()))
                .map_err(|e| anyhow::anyhow!("WS send: {e}"))?;
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                if Instant::now() > deadline {
                    anyhow::bail!("CDP 等待 {method} 超时");
                }
                let msg = socket
                    .read()
                    .map_err(|e| anyhow::anyhow!("WS read: {e}"))?;
                let text = match msg {
                    tungstenite::Message::Text(t) => t.to_string(),
                    tungstenite::Message::Ping(p) => {
                        let _ = socket.send(tungstenite::Message::Pong(p));
                        continue;
                    }
                    tungstenite::Message::Close(_) => anyhow::bail!("WS closed"),
                    _ => continue,
                };
                let v: Value = serde_json::from_str(&text)?;
                if v.get("id").and_then(|x| x.as_u64()) == Some(id) {
                    if let Some(err) = v.get("error") {
                        anyhow::bail!("CDP {method} error: {err}");
                    }
                    return Ok(v.get("result").cloned().unwrap_or(Value::Null));
                }
            }
        };

        // 页面可能仍在加载 mermaid；稍等再打印
        std::thread::sleep(Duration::from_millis(600));
        let _ = send("Page.enable", json!({}));
        // 再导航一次保证 file URL 内容就绪
        let _ = send(
            "Page.navigate",
            json!({ "url": file_url }),
        );
        std::thread::sleep(Duration::from_millis(800));

        let result = send(
            "Page.printToPDF",
            json!({
                "printBackground": true,
                "preferCSSPageSize": true,
                "displayHeaderFooter": false,
                "generateDocumentOutline": true,
            }),
        )?;
        let data_b64 = result
            .get("data")
            .and_then(|d| d.as_str())
            .ok_or_else(|| anyhow::anyhow!("printToPDF 无 data"))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_b64)
            .map_err(|e| anyhow::anyhow!("PDF base64: {e}"))?;
        if bytes.len() < 800 {
            anyhow::bail!("PDF 过小");
        }
        fs::write(&pdf_for_chrome, &bytes)?;
        if pdf_abs != pdf_for_chrome.as_path() {
            fs::copy(&pdf_for_chrome, pdf_abs)?;
        }
        if !pdf_contains_canary(&pdf_for_chrome) {
            anyhow::bail!("PDF 缺少 canary，可能未加载目标 HTML");
        }
        Ok(())
    })();

    let _ = child.kill();
    let _ = child.wait();
    result
}

fn try_print_cli(browser: &Path, file_url: &str, pdf_abs: &Path) -> anyhow::Result<()> {
    let pdf_for_chrome = strip_windows_verbatim(pdf_abs);
    let _ = fs::remove_file(&pdf_for_chrome);
    if pdf_abs != pdf_for_chrome.as_path() {
        let _ = fs::remove_file(pdf_abs);
    }
    let status = Command::new(browser)
        .arg("--headless=new")
        .arg("--no-sandbox")
        .arg("--disable-gpu")
        .arg("--allow-file-access-from-files")
        .arg("--no-pdf-header-footer")
        .arg("--force-device-scale-factor=1")
        .arg("--run-all-compositor-stages-before-draw")
        .arg("--virtual-time-budget=15000")
        .arg(format!("--print-to-pdf={}", pdf_for_chrome.display()))
        .arg(file_url)
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
            anyhow::bail!(
                "浏览器未打开本地 HTML（疑似打印了新标签页）。file URL: {file_url}"
            );
        }
        anyhow::bail!("生成的 PDF 疑似空白（{} bytes）", bytes.len());
    }
    anyhow::bail!("未生成有效 PDF；file URL: {file_url}");
}

fn html_to_pdf(html: &str, pdf_path: &Path) -> anyhow::Result<()> {
    ensure_parent(pdf_path)?;

    let tmp_dir = tmp_export_dir()?;
    let html_path = tmp_dir.join("export.html");
    fs::write(&html_path, html.as_bytes())?;
    // canonicalize 便于解析联接路径，但必须剥掉 Windows \\?\
    let html_abs = strip_windows_verbatim(&fs::canonicalize(&html_path)?);
    let url = file_url(&html_abs);
    let tmp_pdf = tmp_dir.join("export.pdf");
    let mut last_err = String::from("未找到可用的 Chrome/Chromium/Edge");

    for browser in browser_candidates() {
        if !browser.is_file() {
            continue;
        }
        let _ = fs::remove_file(&tmp_pdf);
        match try_print(&browser, &url, &tmp_pdf) {
            Ok(()) => {
                fs::copy(&tmp_pdf, pdf_path)?;
                let _ = fs::remove_dir_all(&tmp_dir);
                return Ok(());
            }
            Err(e) => {
                last_err = format!("{}: {}", browser.display(), e);
            }
        }
    }

    let _ = fs::remove_dir_all(&tmp_dir);
    anyhow::bail!(
        "无法用浏览器生成 PDF（{}）。请安装 Chrome / Chromium / Edge。",
        last_err
    );
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
        // 错误形态：未剥离时会变成 file:////?/C:/...
        let bad = format!(
            "file://{}",
            p.to_string_lossy().replace('\\', "/")
        );
        assert!(bad.contains("//?/"), "sanity: raw verbatim URL is broken");
        assert!(!file_url(&p).contains("//?/"));
    }

    #[test]
    fn github_html_contains_canary() {
        let html = crate::md_docx::markdown_to_github_html("# hi\n\nprobe").unwrap();
        assert!(html.contains(PDF_HTML_CANARY));
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
}

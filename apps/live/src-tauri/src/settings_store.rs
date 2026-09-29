//! 非敏感 prefs.json + 系统凭据库存 API Key（Win 凭据管理器 / macOS Keychain / Linux Secret Service）；
//! keyring 不可用时回退到配置目录下的受保护本地文件。

use directories::ProjectDirs;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const SERVICE: &str = "lumen-md-live";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LlmPlatform {
    #[default]
    Deepseek,
    Zhipu,
    Openai,
    Qwen,
    Ollama,
}

impl LlmPlatform {
    pub fn as_str(self) -> &'static str {
        match self {
            LlmPlatform::Deepseek => "deepseek",
            LlmPlatform::Zhipu => "zhipu",
            LlmPlatform::Openai => "openai",
            LlmPlatform::Qwen => "qwen",
            LlmPlatform::Ollama => "ollama",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "zhipu" | "glm" | "智谱" => LlmPlatform::Zhipu,
            "openai" | "chatgpt" | "gpt" => LlmPlatform::Openai,
            "qwen" | "tongyi" | "千问" => LlmPlatform::Qwen,
            "ollama" | "olama" | "本地" => LlmPlatform::Ollama,
            _ => LlmPlatform::Deepseek,
        }
    }

    pub fn default_model(self) -> &'static str {
        match self {
            LlmPlatform::Deepseek => "deepseek-chat",
            LlmPlatform::Zhipu => "glm-4-flash",
            LlmPlatform::Openai => "gpt-4o-mini",
            LlmPlatform::Qwen => "qwen-plus",
            LlmPlatform::Ollama => "llama3.2",
        }
    }

    pub fn base_url(self) -> &'static str {
        match self {
            LlmPlatform::Deepseek => "https://api.deepseek.com/v1",
            LlmPlatform::Zhipu => "https://open.bigmodel.cn/api/paas/v4",
            LlmPlatform::Openai => "https://api.openai.com/v1",
            LlmPlatform::Qwen => "https://dashscope.aliyuncs.com/compatible-mode/v1",
            LlmPlatform::Ollama => "http://127.0.0.1:11434/v1",
        }
    }

    pub fn requires_api_key(self) -> bool {
        !matches!(self, LlmPlatform::Ollama)
    }
}

/// 启发式判断当前模型是否支持视觉多模态（OpenAI 兼容 vision）。
pub fn model_supports_vision(platform: LlmPlatform, model: &str) -> bool {
    let m = model.trim().to_lowercase();
    if m.is_empty() {
        return false;
    }
    // 明显纯文本
    if m.contains("gpt-3.5") || m == "deepseek-chat" || m == "deepseek-reasoner" {
        return false;
    }

    match platform {
        LlmPlatform::Openai => {
            m.contains("gpt-4o")
                || m.contains("gpt-4.1")
                || m.contains("gpt-4-turbo")
                || m.contains("gpt-4-vision")
                || m.starts_with("o1")
                || m.starts_with("o3")
                || m.starts_with("o4")
                || m.contains("vision")
        }
        LlmPlatform::Zhipu => {
            m.contains("glm-4v") || m.contains("glm-4.1v") || m.contains("glm-4v-")
        }
        LlmPlatform::Qwen => {
            m.contains("qwen-vl")
                || m.contains("qwen2-vl")
                || m.contains("qwen2.5-vl")
                || m.contains("qwen3-vl")
                || m.contains("qwen2.5vl")
        }
        LlmPlatform::Deepseek => m.contains("deepseek-vl"),
        LlmPlatform::Ollama => {
            m.contains("llava")
                || m.contains("bakllava")
                || m.contains("moondream")
                || m.contains("minicpm-v")
                || m.contains("qwen2.5vl")
                || m.contains("qwen2-vl")
                || m.contains("qwen2.5-vl")
                || m.contains("gemma3")
                || m.contains("vision")
        }
    }
}

fn default_theme() -> String {
    "as-light".into()
}

fn normalize_theme(s: &str) -> String {
    match s.trim() {
        "as-light" | "as-dark" | "as-darcula" | "as-high-contrast" => s.trim().into(),
        "dark" => "as-dark".into(),
        "light" => "as-light".into(),
        _ => default_theme(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub path: String,
    /// "file" | "folder"
    pub kind: String,
}

fn default_assets_dir() -> String {
    "assets".into()
}

fn default_asset_mode() -> String {
    "workspace".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    pub html_enabled: bool,
    pub platform: LlmPlatform,
    pub model: String,
    #[serde(default = "default_theme")]
    pub theme: String,
    /// 非空时覆盖平台默认 Base URL（主要用于 Ollama 改端口/远程）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default)]
    pub recent: Vec<RecentEntry>,
    #[serde(default)]
    pub focus_mode: bool,
    #[serde(default)]
    pub typewriter_mode: bool,
    /// workspace | beside
    #[serde(default = "default_asset_mode")]
    pub asset_mode: String,
    #[serde(default = "default_assets_dir")]
    pub assets_dir: String,
    #[serde(default)]
    pub user_css: String,
    #[serde(default)]
    pub restore_last_folder: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_folder: Option<String>,
}

impl Default for Prefs {
    fn default() -> Self {
        let platform = LlmPlatform::Deepseek;
        Self {
            html_enabled: true,
            platform,
            model: platform.default_model().into(),
            theme: default_theme(),
            base_url: None,
            recent: Vec::new(),
            focus_mode: false,
            typewriter_mode: false,
            asset_mode: default_asset_mode(),
            assets_dir: default_assets_dir(),
            user_css: String::new(),
            restore_last_folder: false,
            last_folder: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSetReq {
    pub html_enabled: Option<bool>,
    pub platform: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub theme: Option<String>,
    pub base_url: Option<String>,
    pub focus_mode: Option<bool>,
    pub typewriter_mode: Option<bool>,
    pub asset_mode: Option<String>,
    pub assets_dir: Option<String>,
    pub user_css: Option<String>,
    pub restore_last_folder: Option<bool>,
}

fn config_dir() -> anyhow::Result<PathBuf> {
    let dirs = ProjectDirs::from("com", "LumenMD", "Lumen MD Live")
        .ok_or_else(|| anyhow::anyhow!("无法定位配置目录"))?;
    let dir = dirs.config_dir();
    fs::create_dir_all(dir)?;
    Ok(dir.to_path_buf())
}

fn prefs_path() -> anyhow::Result<PathBuf> {
    Ok(config_dir()?.join("prefs.json"))
}

fn fallback_key_path(platform: LlmPlatform) -> anyhow::Result<PathBuf> {
    Ok(config_dir()?.join(format!(".llm-key-{}.dat", platform.as_str())))
}

pub fn load_prefs() -> Prefs {
    let Ok(path) = prefs_path() else {
        return Prefs::default();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return Prefs::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save_prefs(prefs: &Prefs) -> anyhow::Result<()> {
    let path = prefs_path()?;
    let raw = serde_json::to_string_pretty(prefs)?;
    fs::write(path, raw)?;
    Ok(())
}

fn key_entry(platform: LlmPlatform) -> anyhow::Result<Entry> {
    Entry::new(SERVICE, &format!("llm-key:{}", platform.as_str()))
        .map_err(|e| anyhow::anyhow!("凭据存储不可用: {e}"))
}

/// 简单混淆（优先 keyring；回退文件仅防随手翻看，依赖本机目录权限）
fn obscure(key: &str) -> String {
    key.as_bytes()
        .iter()
        .enumerate()
        .map(|(i, b)| format!("{:02x}", b ^ (0xA5u8.wrapping_add(i as u8))))
        .collect()
}

fn unobscure(data: &str) -> Option<String> {
    let data = data.trim();
    if data.len() % 2 != 0 {
        return None;
    }
    let mut plain = Vec::with_capacity(data.len() / 2);
    for (i, pair) in data.as_bytes().chunks(2).enumerate() {
        let hex = std::str::from_utf8(pair).ok()?;
        let b = u8::from_str_radix(hex, 16).ok()?;
        plain.push(b ^ (0xA5u8.wrapping_add(i as u8)));
    }
    String::from_utf8(plain).ok()
}

fn set_fallback_key(platform: LlmPlatform, key: &str) -> anyhow::Result<()> {
    let path = fallback_key_path(platform)?;
    fs::write(path, obscure(key))?;
    Ok(())
}

fn get_fallback_key(platform: LlmPlatform) -> Option<String> {
    let path = fallback_key_path(platform).ok()?;
    let raw = fs::read_to_string(path).ok()?;
    unobscure(raw.trim())
}

fn clear_fallback_key(platform: LlmPlatform) {
    if let Ok(path) = fallback_key_path(platform) {
        let _ = fs::remove_file(path);
    }
}

pub fn set_api_key(platform: LlmPlatform, key: &str) -> anyhow::Result<()> {
    let key = key.trim();
    if key.is_empty() {
        clear_api_key(platform)?;
        return Ok(());
    }

    let mut keyring_ok = false;
    if let Ok(entry) = key_entry(platform) {
        match entry.set_password(key) {
            Ok(()) => keyring_ok = true,
            Err(e) => {
                // 回退文件，同时把错误记进消息若回退也失败
                if set_fallback_key(platform, key).is_err() {
                    anyhow::bail!("保存 API Key 失败（凭据管理器: {e}）");
                }
            }
        }
    } else {
        set_fallback_key(platform, key)?;
    }

    // 双写回退，避免仅内存/异常凭据存储
    if keyring_ok {
        let _ = set_fallback_key(platform, key);
    }

    // 立即回读校验
    if get_api_key(platform).as_deref() != Some(key) {
        anyhow::bail!("API Key 写入后无法读取，请重试或检查系统凭据权限");
    }
    Ok(())
}

pub fn clear_api_key(platform: LlmPlatform) -> anyhow::Result<()> {
    if let Ok(entry) = key_entry(platform) {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(anyhow::anyhow!("清除 API Key 失败: {e}")),
        }
    }
    clear_fallback_key(platform);
    Ok(())
}

pub fn get_api_key(platform: LlmPlatform) -> Option<String> {
    if let Ok(entry) = key_entry(platform) {
        if let Ok(pw) = entry.get_password() {
            let t = pw.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    get_fallback_key(platform).filter(|s| !s.trim().is_empty())
}

pub fn has_api_key(platform: LlmPlatform) -> bool {
    get_api_key(platform).is_some()
}

pub fn key_hint(platform: LlmPlatform) -> Option<String> {
    let key = get_api_key(platform)?;
    let trimmed = key.trim();
    if trimmed.len() <= 4 {
        return Some("••••".into());
    }
    Some(format!("••••{}", &trimmed[trimmed.len() - 4..]))
}

pub fn resolve_base_url(prefs: &Prefs) -> String {
    if let Some(u) = prefs.base_url.as_deref() {
        let t = u.trim().trim_end_matches('/');
        if !t.is_empty() {
            return t.to_string();
        }
    }
    prefs.platform.base_url().to_string()
}

pub fn normalize_base_url_input(raw: &str, platform: LlmPlatform) -> Option<String> {
    let t = raw.trim().trim_end_matches('/').to_string();
    if t.is_empty() {
        return None;
    }
    // 与平台默认相同则不落盘，避免冗余
    if t == platform.base_url() {
        return None;
    }
    Some(t)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub html_enabled: bool,
    pub platform: String,
    pub model: String,
    pub has_key: bool,
    pub key_hint: Option<String>,
    pub base_url: String,
    pub theme: String,
    pub requires_api_key: bool,
    pub supports_multimodal: bool,
    pub recent: Vec<RecentEntry>,
    pub focus_mode: bool,
    pub typewriter_mode: bool,
    pub asset_mode: String,
    pub assets_dir: String,
    pub user_css: String,
    pub restore_last_folder: bool,
    pub last_folder: Option<String>,
}

pub fn settings_view() -> SettingsView {
    let prefs = load_prefs();
    SettingsView {
        html_enabled: prefs.html_enabled,
        platform: prefs.platform.as_str().into(),
        model: prefs.model.clone(),
        has_key: has_api_key(prefs.platform),
        key_hint: key_hint(prefs.platform),
        base_url: resolve_base_url(&prefs),
        theme: normalize_theme(&prefs.theme),
        requires_api_key: prefs.platform.requires_api_key(),
        supports_multimodal: model_supports_vision(prefs.platform, &prefs.model),
        recent: prefs.recent.clone(),
        focus_mode: prefs.focus_mode,
        typewriter_mode: prefs.typewriter_mode,
        asset_mode: prefs.asset_mode.clone(),
        assets_dir: prefs.assets_dir.clone(),
        user_css: prefs.user_css.clone(),
        restore_last_folder: prefs.restore_last_folder,
        last_folder: prefs.last_folder.clone(),
    }
}

pub fn push_recent(path: &str, kind: &str) {
    let mut prefs = load_prefs();
    let path = path.trim();
    if path.is_empty() {
        return;
    }
    prefs.recent.retain(|e| e.path != path);
    prefs.recent.insert(
        0,
        RecentEntry {
            path: path.to_string(),
            kind: kind.to_string(),
        },
    );
    prefs.recent.truncate(20);
    if kind == "folder" {
        prefs.last_folder = Some(path.to_string());
    }
    let _ = save_prefs(&prefs);
}

pub fn apply_settings(req: SettingsSetReq) -> anyhow::Result<SettingsView> {
    let mut prefs = load_prefs();
    if let Some(html) = req.html_enabled {
        prefs.html_enabled = html;
    }
    if let Some(p) = req.platform.as_deref() {
        let platform = LlmPlatform::parse(p);
        if prefs.platform != platform {
            prefs.platform = platform;
            if prefs.model.is_empty()
                || prefs.model == LlmPlatform::Deepseek.default_model()
                || prefs.model == LlmPlatform::Zhipu.default_model()
                || prefs.model == LlmPlatform::Openai.default_model()
                || prefs.model == LlmPlatform::Qwen.default_model()
                || prefs.model == LlmPlatform::Ollama.default_model()
            {
                prefs.model = platform.default_model().into();
            }
            if !matches!(platform, LlmPlatform::Ollama) {
                prefs.base_url = None;
            }
        }
    }
    if let Some(m) = req.model {
        let t = m.trim().to_string();
        if !t.is_empty() {
            prefs.model = t;
        }
    }
    if let Some(t) = req.theme.as_deref() {
        prefs.theme = normalize_theme(t);
    }
    if let Some(bu) = req.base_url.as_deref() {
        prefs.base_url = normalize_base_url_input(bu, prefs.platform);
    }
    if let Some(v) = req.focus_mode {
        prefs.focus_mode = v;
    }
    if let Some(v) = req.typewriter_mode {
        prefs.typewriter_mode = v;
    }
    if let Some(m) = req.asset_mode.as_deref() {
        let m = m.trim().to_lowercase();
        if m == "workspace" || m == "beside" {
            prefs.asset_mode = m;
        }
    }
    if let Some(d) = req.assets_dir.as_deref() {
        let t = d.trim().trim_matches('/').trim_matches('\\');
        if !t.is_empty() && !t.contains("..") {
            prefs.assets_dir = t.to_string();
        }
    }
    if let Some(css) = req.user_css {
        prefs.user_css = css.chars().take(200_000).collect();
    }
    if let Some(v) = req.restore_last_folder {
        prefs.restore_last_folder = v;
    }
    save_prefs(&prefs)?;

    if let Some(key) = req.api_key {
        let t = key.trim();
        if !t.is_empty() {
            set_api_key(prefs.platform, t)?;
        }
    }

    Ok(settings_view())
}

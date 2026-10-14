//! OpenAI 兼容 Chat Completions（DeepSeek / 智谱 / OpenAI / 千问 / Ollama）。
//! 支持视觉多模态：user content 可为 string 或 text/image_url parts。

use crate::settings_store::{self, LlmPlatform, Prefs};
use serde::{Deserialize, Serialize};

const MAX_IMAGES: usize = 3;
/// data URL 中 base64 段大致对应的解码后字节上限（约 4MB）。
const MAX_IMAGE_DECODED_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    temperature: f32,
    /// 显式关闭流式，避免部分网关默认 SSE 导致客户端一直等不到完整 JSON。
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    /// 火山方舟深度思考：助手长任务易卡住，默认关闭（连通性测试不受影响）。
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<ThinkingOpt>,
}

#[derive(Debug, Serialize)]
struct ThinkingOpt {
    #[serde(rename = "type")]
    kind: &'static str,
}

#[derive(Debug, Serialize)]
struct ChatMessage {
    role: String,
    content: MessageContent,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
enum MessageContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ContentPart {
    Text { text: String },
    ImageUrl { image_url: ImageUrl },
}

#[derive(Debug, Serialize, Deserialize)]
struct ImageUrl {
    url: String,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Option<Vec<Choice>>,
    error: Option<ApiError>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: Option<ResponseMessage>,
}

#[derive(Debug, Deserialize)]
struct ResponseMessage {
    #[serde(default)]
    content: Option<MessageContent>,
    /// 豆包等深度思考模型可能把过程放在此字段。
    #[serde(default)]
    reasoning_content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiError {
    message: Option<String>,
    #[allow(dead_code)]
    code: Option<serde_json::Value>,
}

fn validate_images(images: &[String]) -> Result<Vec<String>, String> {
    if images.is_empty() {
        return Ok(Vec::new());
    }
    if images.len() > MAX_IMAGES {
        return Err(format!("最多附带 {MAX_IMAGES} 张图片"));
    }
    let mut out = Vec::with_capacity(images.len());
    for (i, raw) in images.iter().enumerate() {
        let url = raw.trim();
        if url.is_empty() {
            return Err(format!("第 {} 张图片为空", i + 1));
        }
        if url.starts_with("data:") {
            let b64 = url
                .split(',')
                .nth(1)
                .ok_or_else(|| format!("第 {} 张图片 data URL 无效", i + 1))?;
            // base64 约 4/3 膨胀；用字符长度粗估解码体积
            let approx = b64.len().saturating_mul(3) / 4;
            if approx > MAX_IMAGE_DECODED_BYTES {
                return Err(format!(
                    "第 {} 张图片过大（上限约 {}MB）",
                    i + 1,
                    MAX_IMAGE_DECODED_BYTES / (1024 * 1024)
                ));
            }
        } else if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err(format!(
                "第 {} 张图片须为 data URL 或 http(s) URL",
                i + 1
            ));
        }
        out.push(url.to_string());
    }
    Ok(out)
}

fn build_user_content(user: &str, images: &[String]) -> MessageContent {
    if images.is_empty() {
        return MessageContent::Text(user.to_string());
    }
    // 先图后文：提高视觉模型对附图的权重，避免长文本压过识图
    let mut parts = Vec::with_capacity(1 + images.len());
    for url in images {
        parts.push(ContentPart::ImageUrl {
            image_url: ImageUrl { url: url.clone() },
        });
    }
    parts.push(ContentPart::Text {
        text: user.to_string(),
    });
    MessageContent::Parts(parts)
}

fn content_to_string(c: MessageContent) -> Option<String> {
    match c {
        MessageContent::Text(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(s)
            }
        }
        MessageContent::Parts(parts) => {
            let mut buf = String::new();
            for p in parts {
                if let ContentPart::Text { text } = p {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(&text);
                }
            }
            let t = buf.trim();
            if t.is_empty() {
                None
            } else {
                Some(buf)
            }
        }
    }
}

pub async fn complete(
    system: &str,
    user: &str,
    temperature: Option<f32>,
    images: Option<Vec<String>>,
) -> Result<String, String> {
    let prefs = settings_store::load_prefs();
    let key = settings_store::get_api_key(prefs.platform);
    if prefs.platform.requires_api_key() && key.as_ref().map(|k| k.trim().is_empty()).unwrap_or(true)
    {
        return Err("未配置 API Key，请在 设置 → 大模型配置 中配置".into());
    }

    let model = if prefs.model.trim().is_empty() {
        prefs.platform.default_model().to_string()
    } else {
        prefs.model.clone()
    };

    let images = validate_images(images.as_deref().unwrap_or(&[]))?;
    if !images.is_empty() && !prefs.multimodal_enabled {
        return Err(
            "未启用多模态。请在 设置 → 大模型配置 中勾选「启用多模态」，并确认当前模型支持视觉。"
                .into(),
        );
    }

    // 助手常带整篇文档；过长时方舟侧可能长时间无响应
    const MAX_USER_CHARS: usize = 60_000;
    let user_owned = if user.chars().count() > MAX_USER_CHARS {
        let truncated: String = user.chars().take(MAX_USER_CHARS).collect();
        format!("{truncated}\n\n…（内容过长，已截断；请缩小选区后重试）")
    } else {
        user.to_string()
    };

    let base = settings_store::resolve_base_url(&prefs);
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));
    let is_volc = matches!(prefs.platform, LlmPlatform::Volcengine);
    let body = ChatRequest {
        model: model.clone(),
        messages: vec![
            ChatMessage {
                role: "system".into(),
                content: MessageContent::Text(system.to_string()),
            },
            ChatMessage {
                role: "user".into(),
                content: build_user_content(&user_owned, &images),
            },
        ],
        temperature: temperature.unwrap_or(0.3),
        stream: false,
        max_tokens: Some(if is_volc { 4096 } else { 8192 }),
        // 深度思考模型做润色/扩写等会极慢，表现为「卡住」
        thinking: if is_volc {
            Some(ThinkingOpt { kind: "disabled" })
        } else {
            None
        },
    };

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| format!("HTTP 客户端错误: {e}"))?;

    let mut req = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body);

    if let Some(k) = key.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        req = req.bearer_auth(k);
    }

    let resp = req.send().await.map_err(|e| {
        let timed_out = e.is_timeout() || e.to_string().to_ascii_lowercase().contains("timed out");
        if matches!(prefs.platform, LlmPlatform::Ollama) {
            format!(
                "无法连接 Ollama（{e}）。请确认已启动：ollama serve，并检查 Base URL：{base}"
            )
        } else if matches!(prefs.platform, LlmPlatform::Volcengine) {
            if timed_out {
                format!(
                    "火山方舟请求超时（模型：{model}）。请缩小选区/正文，或换非深度思考模型后重试。"
                )
            } else {
                format!(
                    "无法连接火山方舟（{e}）。请检查网络，并确认模型为控制台「模型 ID」或接入点 ep-…（当前：{model}）"
                )
            }
        } else if timed_out {
            format!("LLM 请求超时: {e}")
        } else {
            format!("网络请求失败: {e}")
        }
    })?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;

    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("API Key 无效或权限不足，请在设置中检查后重新保存".into());
    }
    if !status.is_success() {
        let hint = parse_error_message(&text).unwrap_or_else(|| text.chars().take(200).collect());
        let extra = if matches!(prefs.platform, LlmPlatform::Ollama) {
            "（若提示模型不存在，请先 ollama pull <模型名>）"
        } else if matches!(prefs.platform, LlmPlatform::Volcengine) {
            "（火山方舟请使用完整模型 ID 或 ep- 接入点，族名如 doubao-1.5-pro 可能无效）"
        } else {
            ""
        };
        return Err(format!("LLM 请求失败 ({status}): {hint}{extra}"));
    }

    // 若网关误开 SSE，首包常以 data: 开头——尽快失败，避免空等
    let trimmed = text.trim_start();
    if trimmed.starts_with("data:") || trimmed.starts_with("event:") {
        return Err(
            "收到流式 SSE 响应，当前客户端仅支持非流式。请确认请求未强制 stream=true。"
                .into(),
        );
    }

    let parsed: ChatResponse =
        serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {e}"))?;
    if let Some(err) = parsed.error {
        return Err(err
            .message
            .unwrap_or_else(|| "LLM 返回错误".into()));
    }
    let message = parsed
        .choices
        .and_then(|c| c.into_iter().next())
        .and_then(|c| c.message)
        .ok_or_else(|| "LLM 返回空内容".to_string())?;
    let content = message
        .content
        .and_then(content_to_string)
        .or_else(|| {
            message
                .reasoning_content
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .ok_or_else(|| "LLM 返回空内容".to_string())?;

    Ok(strip_outer_fence(content.trim()))
}

pub async fn test_connection() -> Result<String, String> {
    // 约定口令：模型须在回复正文中给出，仅 HTTP 连通不算成功。
    const MARKER: &str = "测试成功";
    let reply = complete(
        &format!(
            "你是连通性测试助手。必须只回复这四个字：{MARKER}。禁止输出其它文字、标点或解释。"
        ),
        "请严格按系统要求回复。",
        Some(0.0),
        None,
    )
    .await
    .map_err(|e| format!("测试失败：{e}"))?;

    let t = reply.trim();
    if t.is_empty() {
        return Err("测试失败：模型未返回任何内容（仅连接成功不算通过）".into());
    }
    if !t.contains(MARKER) {
        let preview: String = t.chars().take(120).collect();
        return Err(format!(
            "测试失败：未收到完整有效回复（须包含「{MARKER}」）。实际回复：{preview}"
        ));
    }
    Ok(format!("测试成功：模型已完整回复「{MARKER}」"))
}

fn parse_error_message(text: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    v.pointer("/error/message")
        .and_then(|m| m.as_str())
        .map(|s| s.to_string())
}

/// 去掉模型常见的整篇 ``` / ```markdown / ```md 包裹。
/// 保留 ```mermaid、```LaTeX 等业务围栏，否则插入后无法可视化渲染。
fn strip_outer_fence(s: &str) -> String {
    let t = s.trim();
    if !t.starts_with("```") {
        return t.to_string();
    }
    let after = &t[3..];
    let nl = match after.find('\n') {
        Some(i) => i,
        None => return t.to_string(),
    };
    let lang = after[..nl].trim().to_ascii_lowercase();
    // 仅剥「空语言 / markdown / md」；mermaid、latex、json 等必须保留
    if !lang.is_empty() && lang != "markdown" && lang != "md" {
        return t.to_string();
    }
    let body = &after[nl + 1..];
    if let Some(inner) = body.strip_suffix("```") {
        return inner.trim().to_string();
    }
    t.to_string()
}

#[allow(dead_code)]
pub fn current_prefs() -> Prefs {
    settings_store::load_prefs()
}

#[allow(dead_code)]
pub fn platform_label(p: LlmPlatform) -> &'static str {
    match p {
        LlmPlatform::Deepseek => "DeepSeek",
        LlmPlatform::Zhipu => "智谱",
        LlmPlatform::Openai => "ChatGPT",
        LlmPlatform::Qwen => "通义千问",
        LlmPlatform::Volcengine => "火山引擎",
        LlmPlatform::Ollama => "Ollama",
    }
}

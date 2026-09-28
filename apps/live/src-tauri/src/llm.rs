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
    let mut parts = Vec::with_capacity(1 + images.len());
    parts.push(ContentPart::Text {
        text: user.to_string(),
    });
    for url in images {
        parts.push(ContentPart::ImageUrl {
            image_url: ImageUrl { url: url.clone() },
        });
    }
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
        return Err("未配置 API Key，请在 设置 → AI 中配置".into());
    }

    let model = if prefs.model.trim().is_empty() {
        prefs.platform.default_model().to_string()
    } else {
        prefs.model.clone()
    };

    let images = validate_images(images.as_deref().unwrap_or(&[]))?;
    if !images.is_empty() && !settings_store::model_supports_vision(prefs.platform, &model) {
        return Err(
            "当前模型不支持多模态。请在设置中换成带视觉能力的模型（如 gpt-4o-mini、glm-4v-flash、qwen-vl-plus、llava）"
                .into(),
        );
    }

    let base = settings_store::resolve_base_url(&prefs);
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));
    let body = ChatRequest {
        model,
        messages: vec![
            ChatMessage {
                role: "system".into(),
                content: MessageContent::Text(system.to_string()),
            },
            ChatMessage {
                role: "user".into(),
                content: build_user_content(user, &images),
            },
        ],
        temperature: temperature.unwrap_or(0.3),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
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
        if matches!(prefs.platform, LlmPlatform::Ollama) {
            format!(
                "无法连接 Ollama（{e}）。请确认已启动：ollama serve，并检查 Base URL：{base}"
            )
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
        } else {
            ""
        };
        return Err(format!("LLM 请求失败 ({status}): {hint}{extra}"));
    }

    let parsed: ChatResponse =
        serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {e}"))?;
    if let Some(err) = parsed.error {
        return Err(err
            .message
            .unwrap_or_else(|| "LLM 返回错误".into()));
    }
    let content = parsed
        .choices
        .and_then(|c| c.into_iter().next())
        .and_then(|c| c.message)
        .and_then(|m| m.content)
        .and_then(content_to_string)
        .ok_or_else(|| "LLM 返回空内容".to_string())?;

    Ok(strip_outer_fence(content.trim()))
}

pub async fn test_connection() -> Result<String, String> {
    complete(
        "你是连通性测试助手。只回复两个字：成功",
        "ping",
        Some(0.0),
        None,
    )
    .await
    .map(|_| "连接成功".into())
}

fn parse_error_message(text: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    v.pointer("/error/message")
        .and_then(|m| m.as_str())
        .map(|s| s.to_string())
}

/// 去掉模型常见的整篇 ```markdown 包裹。
fn strip_outer_fence(s: &str) -> String {
    let t = s.trim();
    if let Some(rest) = t.strip_prefix("```") {
        let rest = rest
            .strip_prefix("markdown")
            .or_else(|| rest.strip_prefix("md"))
            .unwrap_or(rest);
        let rest = rest.trim_start_matches('\n');
        if let Some(inner) = rest.strip_suffix("```") {
            return inner.trim().to_string();
        }
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
        LlmPlatform::Ollama => "Ollama",
    }
}

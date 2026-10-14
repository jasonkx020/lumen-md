import { useEffect, useState } from "react";
import {
  llmTest,
  settingsClearKey,
  settingsGet,
  settingsSet,
  type SettingsView,
} from "../api";

const PLATFORMS: {
  id: string;
  label: string;
  defaultModel: string;
  defaultBaseUrl: string;
  requiresKey: boolean;
  visionHint: string;
}[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    defaultModel: "deepseek-chat",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    requiresKey: true,
    visionHint: "deepseek-vl（若可用）",
  },
  {
    id: "zhipu",
    label: "智谱",
    defaultModel: "glm-4-flash",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    requiresKey: true,
    visionHint: "glm-4v-flash",
  },
  {
    id: "openai",
    label: "ChatGPT (OpenAI)",
    defaultModel: "gpt-4o-mini",
    defaultBaseUrl: "https://api.openai.com/v1",
    requiresKey: true,
    visionHint: "gpt-4o-mini",
  },
  {
    id: "qwen",
    label: "通义千问",
    defaultModel: "qwen-plus",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    requiresKey: true,
    visionHint: "qwen-vl-plus",
  },
  {
    id: "volcengine",
    label: "火山引擎（豆包）",
    defaultModel: "doubao-seed-1-6-251015",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    requiresKey: true,
    visionHint: "doubao-1.5-vision-pro（完整版本号或 ep-…）",
  },
  {
    id: "ollama",
    label: "Ollama（本地）",
    defaultModel: "llama3.2",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    requiresKey: false,
    visionHint: "llava",
  },
];

type Props = {
  open: boolean;
  onClose: () => void;
  onChanged?: (view: SettingsView) => void;
};

export function LlmSettingsModal({ open, onClose, onChanged }: Props) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [platform, setPlatform] = useState("deepseek");
  const [model, setModel] = useState("deepseek-chat");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [multimodalEnabled, setMultimodalEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const platformMeta =
    PLATFORMS.find((x) => x.id === platform) ?? PLATFORMS[0];
  const isOllama = platform === "ollama";

  useEffect(() => {
    if (!open) return;
    setMsg("");
    setApiKey("");
    void settingsGet()
      .then((v) => {
        setView(v);
        setPlatform(v.platform);
        setModel(v.model);
        setBaseUrl(v.baseUrl);
        setMultimodalEnabled(!!v.supportsMultimodal);
        onChanged?.(v);
      })
      .catch((e) => setMsg(`读取设置失败: ${e}`));
  }, [open, onChanged]);

  if (!open) return null;

  const save = async () => {
    setBusy(true);
    setMsg("");
    try {
      const v = await settingsSet({
        platform,
        model,
        baseUrl: baseUrl.trim() || null,
        apiKey: apiKey.trim() ? apiKey.trim() : null,
        multimodalEnabled,
      });
      setView(v);
      setBaseUrl(v.baseUrl);
      setMultimodalEnabled(!!v.supportsMultimodal);
      if (apiKey.trim()) setApiKey("");
      onChanged?.(v);
      onClose();
    } catch (e) {
      setMsg(`保存失败: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async () => {
    setBusy(true);
    setMsg("");
    try {
      const v = await settingsClearKey();
      setView(v);
      onChanged?.(v);
      setMsg("已清除当前平台 API Key");
    } catch (e) {
      setMsg(`清除失败: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setMsg("测试中…");
    try {
      const keyToSave = apiKey.trim();
      const v = await settingsSet({
        platform,
        model,
        baseUrl: baseUrl.trim() || null,
        apiKey: keyToSave ? keyToSave : null,
        multimodalEnabled,
      });
      setView(v);
      setBaseUrl(v.baseUrl);
      setMultimodalEnabled(!!v.supportsMultimodal);
      onChanged?.(v);
      if (v.requiresApiKey && !v.hasKey && !keyToSave) {
        setMsg("未配置 API Key：请在上方输入 Key 后点「保存」或「测试连接」");
        return;
      }
      if (keyToSave) setApiKey("");
      const r = await llmTest();
      setMsg(r);
    } catch (e) {
      setMsg(`测试失败: ${e}`);
      try {
        onChanged?.(await settingsGet());
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-dialog" role="presentation">
      <div
        className="settings-dialog-panel"
        role="dialog"
        aria-label="大模型配置"
        aria-modal="true"
      >
        <header className="settings-header">
          <h2>大模型配置</h2>
          <button type="button" className="settings-close" onClick={onClose}>
            ×
          </button>
        </header>

        <section className="settings-section">
          <label className="settings-field">
            <span>平台</span>
            <select
              value={platform}
              onChange={(e) => {
                const id = e.target.value;
                setPlatform(id);
                const p = PLATFORMS.find((x) => x.id === id);
                if (p) {
                  setModel(p.defaultModel);
                  setBaseUrl(p.defaultBaseUrl);
                }
              }}
            >
              {PLATFORMS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span>模型</span>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={
                isOllama
                  ? `例如 ${platformMeta.visionHint} / llama3.2`
                  : platform === "volcengine"
                    ? `模型 ID 或 ep-…；默认 ${platformMeta.defaultModel}`
                    : `例如 ${platformMeta.defaultModel}；视觉：${platformMeta.visionHint}`
              }
              spellCheck={false}
            />
          </label>
          <p className="settings-hint">
            {platform === "volcengine"
              ? "火山方舟：须填控制台完整模型 ID（含版本号）或接入点 ep-…；勿只用族名（如 doubao-1.5-pro），否则可能失败或长时间无响应。"
              : `视觉模型示例：${platformMeta.visionHint}`}
          </p>
          <label className="settings-row">
            <input
              type="checkbox"
              checked={multimodalEnabled}
              onChange={(e) => setMultimodalEnabled(e.target.checked)}
            />
            <span>启用多模态（贴图 / 图片转 Markdown）</span>
          </label>
          <p className="settings-hint">
            请自行确认当前引擎与模型支持视觉；误开可能导致请求失败。
          </p>
          {isOllama ? (
            <label className="settings-field">
              <span>Base URL</span>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={platformMeta.defaultBaseUrl}
                spellCheck={false}
              />
            </label>
          ) : null}
          <label className="settings-field">
            <span>API Key{isOllama ? "（可选）" : ""}</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                isOllama
                  ? view?.hasKey
                    ? `已保存 ${view.keyHint ?? "••••"}（可选，输入新 Key 覆盖）`
                    : "本地 Ollama 通常无需 Key"
                  : view?.hasKey
                    ? `已保存 ${view.keyHint ?? "••••"}（输入新 Key 覆盖）`
                    : "粘贴你的 API Key"
              }
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <p className="settings-hint">
            {isOllama
              ? "本地 Ollama：请先运行 ollama serve，并 pull 对应模型。Key 可选。"
              : "Key 保存在本机凭据库（Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service），不会写入项目文件。"}{" "}
            当前接口：{(view?.baseUrl ?? baseUrl) || "—"}
          </p>
        </section>

        <div className="settings-actions">
          <button type="button" disabled={busy} onClick={() => void clearKey()}>
            清除 Key
          </button>
          <button type="button" disabled={busy} onClick={() => void test()}>
            测试连接
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void save()}
          >
            保存
          </button>
        </div>
        {msg ? <p className="settings-msg">{msg}</p> : null}
      </div>
    </div>
  );
}

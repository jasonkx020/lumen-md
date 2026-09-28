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
}[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    defaultModel: "deepseek-chat",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    requiresKey: true,
  },
  {
    id: "zhipu",
    label: "智谱",
    defaultModel: "glm-4-flash",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    requiresKey: true,
  },
  {
    id: "openai",
    label: "ChatGPT (OpenAI)",
    defaultModel: "gpt-4o-mini",
    defaultBaseUrl: "https://api.openai.com/v1",
    requiresKey: true,
  },
  {
    id: "qwen",
    label: "通义千问",
    defaultModel: "qwen-plus",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    requiresKey: true,
  },
  {
    id: "ollama",
    label: "Ollama（本地）",
    defaultModel: "llama3.2",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    requiresKey: false,
  },
];

type Props = {
  open: boolean;
  onClose: () => void;
  onChanged?: (view: SettingsView) => void;
};

export function SettingsModal({ open, onClose, onChanged }: Props) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [htmlEnabled, setHtmlEnabled] = useState(true);
  const [platform, setPlatform] = useState("deepseek");
  const [model, setModel] = useState("deepseek-chat");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
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
        setHtmlEnabled(v.htmlEnabled);
        setPlatform(v.platform);
        setModel(v.model);
        setBaseUrl(v.baseUrl);
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
        htmlEnabled,
        platform,
        model,
        baseUrl: baseUrl.trim() || null,
        apiKey: apiKey.trim() ? apiKey.trim() : null,
      });
      setView(v);
      setBaseUrl(v.baseUrl);
      if (apiKey.trim()) setApiKey("");
      onChanged?.(v);
      if (isOllama) {
        setMsg(
          v.hasKey
            ? `已保存 Ollama（可选 Key：${v.keyHint ?? "已配置"}）· ${v.baseUrl}`
            : `已保存 Ollama · ${v.baseUrl}`,
        );
      } else {
        setMsg(
          v.hasKey
            ? `已保存（当前平台 Key：${v.keyHint ?? "已配置"}）`
            : "已保存偏好；尚未检测到 API Key，请填写 Key 后再保存",
        );
      }
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
        htmlEnabled,
        platform,
        model,
        baseUrl: baseUrl.trim() || null,
        apiKey: keyToSave ? keyToSave : null,
      });
      setView(v);
      setBaseUrl(v.baseUrl);
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
    <div className="settings-dialog" role="presentation" onClick={onClose}>
      <div
        className="settings-dialog-panel"
        role="dialog"
        aria-label="设置"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-header">
          <h2>设置</h2>
          <button type="button" className="settings-close" onClick={onClose}>
            ×
          </button>
        </header>

        <section className="settings-section">
          <h3>编辑器</h3>
          <label className="settings-row">
            <input
              type="checkbox"
              checked={htmlEnabled}
              onChange={(e) => setHtmlEnabled(e.target.checked)}
            />
            <span>支持 HTML 标签预览与编辑</span>
          </label>
        </section>

        <section className="settings-section" id="settings-ai">
          <h3>AI 平台</h3>
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
                isOllama ? "例如 llama3.2（需已 ollama pull）" : undefined
              }
              spellCheck={false}
            />
          </label>
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
              : "Key 保存在本机凭据管理器（静默加密），不会写入项目文件。"}{" "}
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

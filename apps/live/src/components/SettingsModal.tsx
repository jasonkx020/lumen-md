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
    id: "ollama",
    label: "Ollama（本地）",
    defaultModel: "llama3.2",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    requiresKey: false,
    visionHint: "llava",
  },
];

/** 与后端 model_supports_vision 对齐的前端启发式（设置页即时提示）。 */
function modelSupportsVisionLocal(platform: string, model: string): boolean {
  const m = model.trim().toLowerCase();
  if (!m) return false;
  if (m.includes("gpt-3.5") || m === "deepseek-chat" || m === "deepseek-reasoner") {
    return false;
  }
  switch (platform) {
    case "openai":
      return (
        m.includes("gpt-4o") ||
        m.includes("gpt-4.1") ||
        m.includes("gpt-4-turbo") ||
        m.includes("gpt-4-vision") ||
        m.startsWith("o1") ||
        m.startsWith("o3") ||
        m.startsWith("o4") ||
        m.includes("vision")
      );
    case "zhipu":
      return (
        m.includes("glm-4v") || m.includes("glm-4.1v") || m.includes("glm-4v-")
      );
    case "qwen":
      return (
        m.includes("qwen-vl") ||
        m.includes("qwen2-vl") ||
        m.includes("qwen2.5-vl") ||
        m.includes("qwen3-vl") ||
        m.includes("qwen2.5vl")
      );
    case "deepseek":
      return m.includes("deepseek-vl");
    case "ollama":
      return (
        m.includes("llava") ||
        m.includes("bakllava") ||
        m.includes("moondream") ||
        m.includes("minicpm-v") ||
        m.includes("qwen2.5vl") ||
        m.includes("qwen2-vl") ||
        m.includes("qwen2.5-vl") ||
        m.includes("gemma3") ||
        m.includes("vision")
      );
    default:
      return false;
  }
}

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
  const [assetMode, setAssetMode] = useState("workspace");
  const [assetsDir, setAssetsDir] = useState("assets");
  const [userCss, setUserCss] = useState("");
  const [restoreLastFolder, setRestoreLastFolder] = useState(false);

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
        setAssetMode(v.assetMode || "workspace");
        setAssetsDir(v.assetsDir || "assets");
        setUserCss(v.userCss || "");
        setRestoreLastFolder(!!v.restoreLastFolder);
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
        assetMode,
        assetsDir: assetsDir.trim() || "assets",
        userCss,
        restoreLastFolder,
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
          <label className="settings-row">
            <input
              type="checkbox"
              checked={restoreLastFolder}
              onChange={(e) => setRestoreLastFolder(e.target.checked)}
            />
            <span>启动时恢复上次打开的文件夹</span>
          </label>
          <label className="settings-field">
            <span>图片落盘位置</span>
            <select
              value={assetMode}
              onChange={(e) => setAssetMode(e.target.value)}
            >
              <option value="workspace">相对工作区根（assets/）</option>
              <option value="beside">相对当前文档旁</option>
            </select>
          </label>
          <label className="settings-field">
            <span>资源目录名</span>
            <input
              type="text"
              value={assetsDir}
              onChange={(e) => setAssetsDir(e.target.value)}
              placeholder="assets"
              spellCheck={false}
            />
          </label>
        </section>

        <section className="settings-section">
          <h3>自定义 CSS</h3>
          <p className="settings-hint">
            覆盖 `.markdown-body` / `.crepe-host` 等选择器；不保证 100% 兼容 Typora 主题。
          </p>
          <textarea
            className="settings-css"
            rows={8}
            value={userCss}
            onChange={(e) => setUserCss(e.target.value)}
            placeholder={".crepe-host { font-size: 16px; }"}
            spellCheck={false}
          />
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
                isOllama
                  ? `例如 ${platformMeta.visionHint} / llama3.2`
                  : `例如 ${platformMeta.defaultModel}；视觉：${platformMeta.visionHint}`
              }
              spellCheck={false}
            />
          </label>
          <p className="settings-hint">
            {modelSupportsVisionLocal(platform, model)
              ? "当前模型支持多模态：保存后可在 AI 面板贴图 / 图片转 Markdown。"
              : `当前模型为纯文本，贴图功能关闭。视觉示例：${platformMeta.visionHint}`}
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

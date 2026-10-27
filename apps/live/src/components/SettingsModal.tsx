import { useEffect, useRef, useState } from "react";
import { settingsGet, settingsSet, type SettingsView } from "../api";
import {
  AI_CAPABILITIES,
  SELECTION_WRITEBACK_IDS,
  type AiCapabilityId,
} from "../ai/capabilities";

function defaultReplaceMap(): Record<string, boolean> {
  const m: Record<string, boolean> = {};
  for (const id of SELECTION_WRITEBACK_IDS) m[id] = true;
  return m;
}

const PAPER_MARGIN_PRESETS = [
  { id: "narrow", label: "窄", top: 12, right: 12, bottom: 12, left: 12 },
  { id: "medium", label: "中", top: 18, right: 22, bottom: 24, left: 22 },
  { id: "wide", label: "宽", top: 25, right: 28, bottom: 28, left: 25 },
] as const;

type PaperMargins = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

function clampMarginMm(n: number): number {
  if (!Number.isFinite(n)) return 18;
  return Math.min(40, Math.max(5, Math.round(n)));
}

type Props = {
  open: boolean;
  onClose: () => void;
  onChanged?: (view: SettingsView) => void;
  /** 边距即时预览（不必等保存） */
  onPaperMarginsChange?: (m: PaperMargins) => void;
};

export function SettingsModal({
  open,
  onClose,
  onChanged,
  onPaperMarginsChange,
}: Props) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [htmlEnabled, setHtmlEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [assetMode, setAssetMode] = useState("workspace");
  const [assetsDir, setAssetsDir] = useState("assets");
  const [userCss, setUserCss] = useState("");
  const [restoreLastFolder, setRestoreLastFolder] = useState(false);
  const [aiReplaceByCapability, setAiReplaceByCapability] = useState<
    Record<string, boolean>
  >(() => defaultReplaceMap());
  const [paperMarginTop, setPaperMarginTop] = useState(18);
  const [paperMarginRight, setPaperMarginRight] = useState(22);
  const [paperMarginBottom, setPaperMarginBottom] = useState(24);
  const [paperMarginLeft, setPaperMarginLeft] = useState(22);
  const viewRef = useRef<SettingsView | null>(null);
  const marginPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const onChangedRef = useRef(onChanged);
  const onPaperMarginsChangeRef = useRef(onPaperMarginsChange);
  onChangedRef.current = onChanged;
  onPaperMarginsChangeRef.current = onPaperMarginsChange;
  viewRef.current = view;

  /** 边距变更：立刻推到预览，并防抖写入 prefs */
  const applyPaperMargins = (next: PaperMargins, persistDelayMs = 200) => {
    const top = clampMarginMm(next.top);
    const right = clampMarginMm(next.right);
    const bottom = clampMarginMm(next.bottom);
    const left = clampMarginMm(next.left);
    setPaperMarginTop(top);
    setPaperMarginRight(right);
    setPaperMarginBottom(bottom);
    setPaperMarginLeft(left);
    onPaperMarginsChangeRef.current?.({ top, right, bottom, left });
    const base = viewRef.current;
    if (base) {
      setView({
        ...base,
        paperMarginTop: top,
        paperMarginRight: right,
        paperMarginBottom: bottom,
        paperMarginLeft: left,
      });
    }
    if (marginPersistTimer.current) {
      clearTimeout(marginPersistTimer.current);
    }
    marginPersistTimer.current = setTimeout(() => {
      void settingsSet({
        paperMarginTop: top,
        paperMarginRight: right,
        paperMarginBottom: bottom,
        paperMarginLeft: left,
      })
        .then((v) => {
          setView(v);
          onChangedRef.current?.(v);
        })
        .catch(() => {});
    }, persistDelayMs);
  };

  useEffect(() => {
    if (!open) return;
    setMsg("");
    void settingsGet()
      .then((v) => {
        setView(v);
        setHtmlEnabled(v.htmlEnabled);
        setAssetMode(v.assetMode || "workspace");
        setAssetsDir(v.assetsDir || "assets");
        setUserCss(v.userCss || "");
        setRestoreLastFolder(!!v.restoreLastFolder);
        setAiReplaceByCapability({
          ...defaultReplaceMap(),
          ...(v.aiReplaceByCapability ?? {}),
        });
        setPaperMarginTop(clampMarginMm(v.paperMarginTop ?? 18));
        setPaperMarginRight(clampMarginMm(v.paperMarginRight ?? 22));
        setPaperMarginBottom(clampMarginMm(v.paperMarginBottom ?? 24));
        setPaperMarginLeft(clampMarginMm(v.paperMarginLeft ?? 22));
        onChanged?.(v);
      })
      .catch((e) => setMsg(`读取设置失败: ${e}`));
  }, [open, onChanged]);

  useEffect(() => {
    return () => {
      if (marginPersistTimer.current) {
        clearTimeout(marginPersistTimer.current);
      }
    };
  }, []);

  // 关闭设置时立刻落盘未写入的边距，避免防抖被打断
  useEffect(() => {
    if (open) return;
    if (!marginPersistTimer.current) return;
    clearTimeout(marginPersistTimer.current);
    marginPersistTimer.current = null;
    void settingsSet({
      paperMarginTop: clampMarginMm(paperMarginTop),
      paperMarginRight: clampMarginMm(paperMarginRight),
      paperMarginBottom: clampMarginMm(paperMarginBottom),
      paperMarginLeft: clampMarginMm(paperMarginLeft),
    })
      .then((v) => {
        setView(v);
        onChangedRef.current?.(v);
      })
      .catch(() => {});
  }, [open, paperMarginTop, paperMarginRight, paperMarginBottom, paperMarginLeft]);

  if (!open) return null;

  const save = async () => {
    setBusy(true);
    setMsg("");
    try {
      const v = await settingsSet({
        htmlEnabled,
        assetMode,
        assetsDir: assetsDir.trim() || "assets",
        userCss,
        restoreLastFolder,
        aiReplaceByCapability,
        paperMarginTop: clampMarginMm(paperMarginTop),
        paperMarginRight: clampMarginMm(paperMarginRight),
        paperMarginBottom: clampMarginMm(paperMarginBottom),
        paperMarginLeft: clampMarginMm(paperMarginLeft),
      });
      setView(v);
      setAiReplaceByCapability({
        ...defaultReplaceMap(),
        ...(v.aiReplaceByCapability ?? {}),
      });
      setPaperMarginTop(clampMarginMm(v.paperMarginTop));
      setPaperMarginRight(clampMarginMm(v.paperMarginRight));
      setPaperMarginBottom(clampMarginMm(v.paperMarginBottom));
      setPaperMarginLeft(clampMarginMm(v.paperMarginLeft));
      onChanged?.(v);
      onClose();
    } catch (e) {
      setMsg(`保存失败: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-dialog" role="presentation">
      <div
        className="settings-dialog-panel"
        role="dialog"
        aria-label="首选项"
        aria-modal="true"
      >
        <header className="settings-header">
          <h2>首选项</h2>
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
          <h3>AI 写回</h3>
          <p className="settings-hint">
            勾选「替换选区」时，启用结果会直接覆盖所选内容；取消勾选则插在选区后并保留原文。默认均为替换。
          </p>
          {(
            [
              ["write", "写作"],
              ["subject", "学科"],
            ] as const
          ).map(([mode, title]) => {
            const items = AI_CAPABILITIES.filter(
              (c) =>
                c.mode === mode &&
                SELECTION_WRITEBACK_IDS.includes(c.id as AiCapabilityId),
            );
            if (!items.length) return null;
            return (
              <div key={mode} className="settings-ai-writeback-group">
                <h4 className="settings-subheading">{title}</h4>
                {items.map((c) => (
                  <label className="settings-row" key={c.id}>
                    <input
                      type="checkbox"
                      checked={aiReplaceByCapability[c.id] !== false}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setAiReplaceByCapability((prev) => ({
                          ...prev,
                          [c.id]: checked,
                        }));
                      }}
                    />
                    <span>
                      {c.label}
                      <span className="settings-row-muted"> · 替换选区</span>
                    </span>
                  </label>
                ))}
              </div>
            );
          })}
        </section>

        <section className="settings-section">
          <h3>A4 页边距</h3>
          <p className="settings-hint">
            单位毫米（5–40）。预览与 PDF/HTML 导出共用；可先选预设再微调。
          </p>
          <div className="settings-margin-presets" role="group" aria-label="边距预设">
            {PAPER_MARGIN_PRESETS.map((p) => {
              const active =
                paperMarginTop === p.top &&
                paperMarginRight === p.right &&
                paperMarginBottom === p.bottom &&
                paperMarginLeft === p.left;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={
                    "settings-preset-btn" + (active ? " is-active" : "")
                  }
                  onClick={() => {
                    applyPaperMargins(
                      {
                        top: p.top,
                        right: p.right,
                        bottom: p.bottom,
                        left: p.left,
                      },
                      0,
                    );
                  }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          <div className="settings-margin-grid">
            {(
              [
                ["上", "top", paperMarginTop],
                ["右", "right", paperMarginRight],
                ["下", "bottom", paperMarginBottom],
                ["左", "left", paperMarginLeft],
              ] as const
            ).map(([label, key, value]) => (
              <label className="settings-field settings-margin-field" key={label}>
                <span>{label}（mm）</span>
                <input
                  type="number"
                  min={5}
                  max={40}
                  step={1}
                  value={value}
                  onChange={(e) => {
                    const n = clampMarginMm(Number(e.target.value));
                    applyPaperMargins({
                      top: key === "top" ? n : paperMarginTop,
                      right: key === "right" ? n : paperMarginRight,
                      bottom: key === "bottom" ? n : paperMarginBottom,
                      left: key === "left" ? n : paperMarginLeft,
                    });
                  }}
                />
              </label>
            ))}
          </div>
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

        <div className="settings-actions">
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

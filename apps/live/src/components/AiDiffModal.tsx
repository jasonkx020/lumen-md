import { useEffect } from "react";

export type AiDiffPreview = {
  label: string;
  before: string;
  after: string;
  replaceSelection: boolean;
  warn?: string;
  /** Live 编辑器选区位置（对比弹窗会丢掉选区） */
  from?: number;
  to?: number;
  inTableCell?: boolean;
  tableSelectionBlocked?: boolean;
};

type Props = {
  preview: AiDiffPreview | null;
  onAccept: () => void;
  onDiscard: () => void;
};

export function AiDiffModal({ preview, onAccept, onDiscard }: Props) {
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDiscard();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onAccept();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview, onAccept, onDiscard]);

  if (!preview) return null;

  const scopeHint = preview.replaceSelection ? "仅替换选中内容" : "替换整篇文档";

  return (
    <div className="ai-diff-dialog" role="presentation" onClick={onDiscard}>
      <div
        className="ai-diff-panel"
        role="dialog"
        aria-label="AI 结果对比"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ai-diff-header">
          <div>
            <h2>AI 结果对比</h2>
            <p className="ai-diff-meta">
              {preview.label}
              <span className="ai-diff-dot">·</span>
              {scopeHint}
              {preview.warn ? (
                <>
                  <span className="ai-diff-dot">·</span>
                  <span className="ai-diff-warn">{preview.warn}</span>
                </>
              ) : null}
            </p>
          </div>
          <button
            type="button"
            className="settings-close"
            onClick={onDiscard}
            aria-label="关闭"
          >
            ×
          </button>
        </header>

        <div className="ai-diff-cols">
          <section className="ai-diff-col">
            <h3>处理前</h3>
            <pre className="ai-diff-pre">{preview.before}</pre>
          </section>
          <section className="ai-diff-col">
            <h3>处理后</h3>
            <pre className="ai-diff-pre is-after">{preview.after}</pre>
          </section>
        </div>

        <footer className="ai-diff-actions">
          <span className="ai-diff-hint">Esc 丢弃 · Ctrl/⌘+Enter 启用</span>
          <div className="ai-diff-buttons">
            <button type="button" onClick={onDiscard}>
              丢弃
            </button>
            <button type="button" className="primary" onClick={onAccept}>
              启用结果
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

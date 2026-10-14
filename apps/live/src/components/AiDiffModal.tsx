import { useEffect } from "react";
import { AiDiffPane } from "./AiDiffVisual";

export type AiDiffPreview = {
  label: string;
  before: string;
  after: string;
  replaceSelection: boolean;
  /** insert_at_cursor | replace_document | replace_selection */
  writeMode?: "replace_selection" | "replace_document" | "insert_at_cursor";
  warn?: string;
  /** Live 编辑器选区位置（对比弹窗会丢掉选区） */
  from?: number;
  to?: number;
  inTableCell?: boolean;
  tableSelectionBlocked?: boolean;
  /** 识图入库：用户上传的附图（data URL），对比左侧应展示这些图而非文档内图片 */
  inputImages?: string[];
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

  const scopeHint =
    preview.writeMode === "insert_at_cursor"
      ? "插入到光标处"
      : preview.replaceSelection || preview.writeMode === "replace_selection"
        ? "仅替换选中内容"
        : "替换整篇文档";

  const hasInputImages = (preview.inputImages?.length ?? 0) > 0;
  // 插入类「处理前」多为提示语；替换类两侧都尽量可视化
  // 识图：左侧展示上传图，不把文档 Markdown 当可视化（避免冒出文档内图片）
  const beforeDefaultVisual =
    !hasInputImages && preview.writeMode !== "insert_at_cursor";

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
          <AiDiffPane
            text={preview.before}
            variant="before"
            defaultVisual={beforeDefaultVisual}
            inputImages={preview.inputImages}
            beforeTitle={hasInputImages ? "输入图片" : undefined}
          />
          <AiDiffPane text={preview.after} variant="after" defaultVisual />
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

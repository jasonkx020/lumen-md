import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  getQuickCapabilities,
  type AiCapabilityId,
} from "../ai/capabilities";
import { platformShortcut } from "../platform";

export type EditMenuAction = "cut" | "copy" | "paste" | "selectAll";

type Props = {
  x: number;
  y: number;
  open: boolean;
  hasKey: boolean;
  hasSelection: boolean;
  /** 即时能力：空 note 一键跑 */
  onRun: (id: AiCapabilityId) => void;
  /** 打开完整 AI 面板（可写补充说明） */
  onOpenAiPanel: () => void;
  onEdit: (action: EditMenuAction) => void;
  onOpenSettings: () => void;
  onClose: () => void;
};

const PAD = 8;
/** 编辑项 + 分隔 + 少量即时 AI + 打开面板 */
const EST_W = 220;
const EST_H = 320;

function clampPos(
  x: number,
  y: number,
  w: number,
  h: number,
): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = x;
  let top = y;
  if (left + w > vw - PAD) left = Math.max(PAD, vw - w - PAD);
  if (top + h > vh - PAD) top = Math.max(PAD, vh - h - PAD);
  if (left < PAD) left = PAD;
  if (top < PAD) top = PAD;
  return { left, top };
}

export function AiContextMenu({
  x,
  y,
  open,
  hasKey,
  hasSelection,
  onRun,
  onOpenAiPanel,
  onEdit,
  onOpenSettings,
  onClose,
}: Props) {
  const [pos, setPos] = useState(() => clampPos(x, y, EST_W, EST_H));
  const rootRef = useRef<HTMLDivElement>(null);
  const quick = getQuickCapabilities();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (rootRef.current?.contains(t)) return;
      onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [open, onClose]);

  useLayoutEffect(() => {
    if (!open) return;
    const next = rootRef.current
      ? clampPos(
          x,
          y,
          rootRef.current.getBoundingClientRect().width,
          rootRef.current.getBoundingClientRect().height,
        )
      : clampPos(x, y, EST_W, EST_H);
    setPos(next);
  }, [open, x, y, hasKey]);

  if (!open) return null;

  const edit = (action: EditMenuAction) => {
    onEdit(action);
    onClose();
  };

  return createPortal(
    <div
      ref={rootRef}
      className="ai-context-menu"
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        type="button"
        className="ai-context-item"
        disabled={!hasSelection}
        onClick={() => edit("cut")}
      >
        剪切
        <span className="ai-context-shortcut">
          {platformShortcut("Ctrl+X")}
        </span>
      </button>
      <button
        type="button"
        className="ai-context-item"
        disabled={!hasSelection}
        onClick={() => edit("copy")}
      >
        复制
        <span className="ai-context-shortcut">
          {platformShortcut("Ctrl+C")}
        </span>
      </button>
      <button
        type="button"
        className="ai-context-item"
        onClick={() => edit("paste")}
      >
        粘贴
        <span className="ai-context-shortcut">
          {platformShortcut("Ctrl+V")}
        </span>
      </button>
      <button
        type="button"
        className="ai-context-item"
        onClick={() => edit("selectAll")}
      >
        全选
        <span className="ai-context-shortcut">
          {platformShortcut("Ctrl+A")}
        </span>
      </button>

      <div className="ai-context-sep" />

      {!hasKey ? (
        <button
          type="button"
          className="ai-context-item"
          onClick={() => {
            onOpenSettings();
            onClose();
          }}
        >
          配置 API Key…
        </button>
      ) : (
        <>
          {quick.map((c) => {
            const needSel = c.scope === "selection_required";
            const disabled = needSel && !hasSelection;
            return (
              <button
                key={c.id}
                type="button"
                className="ai-context-item"
                disabled={disabled}
                title={disabled ? "请先选中文本" : c.description}
                onClick={() => {
                  onRun(c.id);
                  onClose();
                }}
              >
                {c.label}
              </button>
            );
          })}
          <div className="ai-context-sep" />
          <button
            type="button"
            className="ai-context-item"
            onClick={() => {
              onOpenAiPanel();
              onClose();
            }}
          >
            在 AI 面板中打开…
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

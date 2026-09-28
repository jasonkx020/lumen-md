import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AI_CAPABILITIES,
  type AiCapabilityId,
} from "../ai/capabilities";

export type EditMenuAction = "cut" | "copy" | "paste" | "selectAll";

type Props = {
  x: number;
  y: number;
  open: boolean;
  hasKey: boolean;
  hasSelection: boolean;
  onRun: (id: AiCapabilityId) => void;
  onEdit: (action: EditMenuAction) => void;
  onOpenSettings: () => void;
  onClose: () => void;
};

const PAD = 8;
/** 4 编辑项 + 分隔 + 最多 4 个 AI 项，用于首帧估算 */
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
  onEdit,
  onOpenSettings,
  onClose,
}: Props) {
  const [pos, setPos] = useState(() => clampPos(x, y, EST_W, EST_H));
  const rootRef = useRef<HTMLDivElement>(null);

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
        <span className="ai-context-shortcut">Ctrl+X</span>
      </button>
      <button
        type="button"
        className="ai-context-item"
        disabled={!hasSelection}
        onClick={() => edit("copy")}
      >
        复制
        <span className="ai-context-shortcut">Ctrl+C</span>
      </button>
      <button
        type="button"
        className="ai-context-item"
        onClick={() => edit("paste")}
      >
        粘贴
        <span className="ai-context-shortcut">Ctrl+V</span>
      </button>
      <button
        type="button"
        className="ai-context-item"
        onClick={() => edit("selectAll")}
      >
        全选
        <span className="ai-context-shortcut">Ctrl+A</span>
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
        AI_CAPABILITIES.map((c) => {
          const needSel =
            c.id === "polish" || c.id === "rewrite_selection";
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
        })
      )}
    </div>,
    document.body,
  );
}

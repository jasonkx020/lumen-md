/**
 * MathLive 可视化公式编辑器。
 * 确认后回写 LaTeX；支持行内 ↔ 块级形态切换。
 */

import { useEffect, useRef, useState } from "react";
import { MathfieldElement } from "mathlive";
import "mathlive/fonts.css";
import "mathlive/static.css";
import { FORMULA_PALETTES } from "./formulaPalettes";
import {
  DEFAULT_MATHLIVE_LAYOUTS,
  getFormulaEditorLayouts,
} from "./mathliveNumericLayout";
import { applyMathliveZhLocale } from "./mathliveZhLocale";

export type FormulaDisplayKind = "inline" | "block";

// 菜单/工具提示用中文（Tauri WebView 常为 en-US；补全官方缺失的「插入」子菜单）
applyMathliveZhLocale();

if (typeof window !== "undefined" && !customElements.get("math-field")) {
  customElements.define("math-field", MathfieldElement);
}

function getVk(): Window["mathVirtualKeyboard"] | null {
  if (typeof window === "undefined") return null;
  return window.mathVirtualKeyboard ?? null;
}

function isVkVisible(): boolean {
  try {
    return !!getVk()?.visible;
  } catch {
    return false;
  }
}

function hideVk() {
  try {
    getVk()?.hide({ animate: false });
  } catch {
    /* ignore */
  }
}

function isMathLiveUiTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest(
    [
      ".ML__keyboard",
      ".ML__keyboard-container",
      "math-virtual-keyboard",
      "[data-ml-container]",
      ".ML__menu-container",
      ".ML__popover",
      "[role='menu']",
      "[role='menuitem']",
      ".lumen-mathfield",
      "math-field",
    ].join(","),
  );
}

type Props = {
  open: boolean;
  initialLatex: string;
  /** 打开时的默认形态 */
  initialKind?: FormulaDisplayKind;
  /** 新建 vs 更新：页脚按钮文案 */
  isInsert?: boolean;
  title?: string;
  onConfirm: (latex: string, kind: FormulaDisplayKind) => void;
  onCancel: () => void;
};

export function FormulaVisualEditor({
  open,
  initialLatex,
  initialKind = "inline",
  isInsert = false,
  title = "可视化公式",
  onConfirm,
  onCancel,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mfRef = useRef<MathfieldElement | null>(null);
  const [tab, setTab] = useState<"math" | "chem" | "physics">("math");
  const [source, setSource] = useState(initialLatex);
  const [mode, setMode] = useState<"visual" | "source">("visual");
  const [kind, setKind] = useState<FormulaDisplayKind>(initialKind);

  useEffect(() => {
    if (!open) return;
    setSource(initialLatex);
    setMode("visual");
    setKind(initialKind);
  }, [open, initialLatex, initialKind]);

  // 键盘必须挂 body；打开时套用带 Shift 角标的布局
  useEffect(() => {
    const vk = getVk();
    if (!vk) return;
    try {
      vk.container = document.body;
    } catch {
      /* ignore */
    }
    if (open) {
      try {
        vk.layouts = getFormulaEditorLayouts();
      } catch {
        /* ignore */
      }
    } else {
      hideVk();
      try {
        vk.layouts = [...DEFAULT_MATHLIVE_LAYOUTS];
      } catch {
        /* ignore */
      }
    }
    return () => {
      hideVk();
      try {
        vk.container = document.body;
        vk.layouts = [...DEFAULT_MATHLIVE_LAYOUTS];
      } catch {
        /* ignore */
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      mfRef.current = null;
      if (hostRef.current) hostRef.current.replaceChildren();
      hideVk();
      return;
    }
    if (mode !== "visual") {
      hideVk();
      return;
    }
    const host = hostRef.current;
    if (!host) return;

    let mf = mfRef.current;
    const needCreate = !mf || !host.contains(mf);
    if (needCreate) {
      mf = new MathfieldElement();
      mf.className = "lumen-mathfield";
      mf.mathVirtualKeyboardPolicy = "manual";
      mf.addEventListener("input", () => {
        setSource(mf!.getValue("latex") || "");
      });
      host.replaceChildren(mf);
      mfRef.current = mf;
    }
    mf!.setValue(source, { silenceNotifications: true });
    requestAnimationFrame(() => mf?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (isVkVisible()) {
        hideVk();
        return;
      }
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onCancel]);

  if (!open) return null;

  const palette =
    FORMULA_PALETTES.find((p) => p.id === tab) ?? FORMULA_PALETTES[0]!;

  const insertLatex = (latex: string) => {
    if (mode === "source") {
      setSource((s) => s + latex);
      return;
    }
    const mf = mfRef.current;
    if (!mf) return;
    mf.insert(latex);
    setSource(mf.getValue("latex") || "");
    mf.focus();
  };

  const confirm = () => {
    hideVk();
    const latex =
      mode === "source"
        ? source.trim()
        : (mfRef.current?.getValue("latex") || source).trim();
    onConfirm(latex, kind);
  };

  return (
    <div
      className="formula-visual-overlay"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (isMathLiveUiTarget(e.target)) return;
        if (e.target === e.currentTarget) {
          hideVk();
          onCancel();
        }
      }}
    >
      <div className="formula-visual-panel">
        <header className="formula-visual-header">
          <h3>{title}</h3>
          <div className="formula-visual-modes">
            <button
              type="button"
              className={mode === "visual" ? "is-active" : ""}
              onClick={() => setMode("visual")}
            >
              可视化
            </button>
            <button
              type="button"
              className={mode === "source" ? "is-active" : ""}
              onClick={() => {
                const v = mfRef.current?.getValue("latex") || source;
                setSource(v);
                hideVk();
                setMode("source");
              }}
            >
              LaTeX 源码
            </button>
          </div>
        </header>

        <div className="formula-visual-kind">
          <span className="formula-visual-kind-label">形态</span>
          <div className="formula-visual-modes">
            <button
              type="button"
              className={kind === "inline" ? "is-active" : ""}
              title="行内公式，源码为 $…$"
              onClick={() => setKind("inline")}
            >
              行内 $…$
            </button>
            <button
              type="button"
              className={kind === "block" ? "is-active" : ""}
              title="块级公式（与 / 公式一致）"
              onClick={() => setKind("block")}
            >
              块级 $$…$$
            </button>
          </div>
        </div>

        <div className="formula-visual-tabs">
          {FORMULA_PALETTES.map((p) => (
            <button
              key={p.id}
              type="button"
              className={tab === p.id ? "is-active" : ""}
              onClick={() => setTab(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="formula-visual-palettes">
          {palette.groups.map((g) => (
            <div key={g.name} className="formula-visual-group">
              <div className="formula-visual-group-name">{g.name}</div>
              <div className="formula-visual-chips">
                {g.chips.map((c) => (
                  <button
                    key={c.label + c.latex}
                    type="button"
                    title={c.title || c.latex}
                    onClick={() => insertLatex(c.latex)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {mode === "visual" ? (
          <div className="formula-visual-field" ref={hostRef} />
        ) : (
          <textarea
            className="formula-visual-source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            spellCheck={false}
            rows={4}
          />
        )}

        <footer className="formula-visual-footer">
          <button
            type="button"
            className="formula-btn-ghost"
            onClick={() => {
              hideVk();
              onCancel();
            }}
          >
            取消
          </button>
          <button type="button" className="formula-btn-primary" onClick={confirm}>
            {isInsert ? "插入公式" : "更新公式"}
          </button>
        </footer>
      </div>
    </div>
  );
}

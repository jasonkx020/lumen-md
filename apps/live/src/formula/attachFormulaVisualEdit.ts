/**
 * 在 Crepe 宿主上挂接可视化公式编辑：
 * - 双击行内公式 / LaTeX 代码块 → 打开 MathLive
 * - 行内 tooltip 出现时注入「可视化」按钮
 * - 支持新建插入与行内 ↔ 块级转换写回
 */

import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import type { Node as PmNode, Schema } from "@milkdown/kit/prose/model";
import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import { EditorView as CodeMirrorView } from "@codemirror/view";
import type { FormulaDisplayKind } from "./FormulaVisualEditor";

export type FormulaEditRequest = {
  /** 原节点形态；insert-* 表示新建 */
  kind: FormulaDisplayKind | "insert-inline" | "insert-block";
  /** ProseMirror 节点起点（新建时为选区 from） */
  pos: number;
  latex: string;
};

function isLatexLang(lang: string): boolean {
  const l = lang.trim().toLowerCase();
  return l === "latex" || l === "tex" || l === "math";
}

function findInlineMathFromEvent(target: EventTarget | null): {
  el: HTMLElement;
  latex: string;
} | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest(
    'span[data-type="math_inline"]',
  ) as HTMLElement | null;
  if (!el) return null;
  return { el, latex: el.dataset.value ?? "" };
}

function findLatexCodeBlock(target: EventTarget | null): {
  host: HTMLElement;
  latex: string;
} | null {
  if (!(target instanceof Element)) return null;
  const host = target.closest(".milkdown-code-block") as HTMLElement | null;
  if (!host) return null;
  const langBtn = host.querySelector(".language-button");
  const langText = (langBtn?.textContent || "").replace(/\s+/g, " ").trim();
  const langAttr =
    host.querySelector("[data-language]")?.getAttribute("data-language") ||
    "";
  const hasKatexPreview = !!host.querySelector(
    ".preview .katex, .preview-panel .katex, .katex-display",
  );
  if (!isLatexLang(langText) && !isLatexLang(langAttr) && !hasKatexPreview) {
    return null;
  }
  if (host.querySelector(".mermaid-preview-root, .mermaid-preview")) {
    return null;
  }
  const cmRoot =
    host.querySelector<HTMLElement>(".cm-editor") ||
    host.querySelector<HTMLElement>(".codemirror-host");
  let latex = "";
  if (cmRoot) {
    const view = CodeMirrorView.findFromDOM(cmRoot);
    if (view) latex = view.state.doc.toString();
  }
  return { host, latex };
}

function injectTooltipButton(
  tooltip: HTMLElement,
  onVisual: () => void,
): void {
  if (tooltip.querySelector("[data-lumen-formula-visual]")) return;
  const container = tooltip.querySelector(".container") || tooltip;
  container.classList.add("lumen-latex-inline-container");

  const confirmBtn = container.querySelector<HTMLButtonElement>(":scope > button");
  if (confirmBtn) {
    confirmBtn.classList.add("lumen-latex-confirm-btn");
    confirmBtn.title = "确认";
    confirmBtn.setAttribute("aria-label", "确认");
    if (!confirmBtn.querySelector(".lumen-latex-confirm-label")) {
      const label = document.createElement("span");
      label.className = "lumen-latex-confirm-label";
      label.textContent = "确认";
      confirmBtn.appendChild(label);
    }
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.dataset.lumenFormulaVisual = "1";
  btn.className = "lumen-formula-visual-btn";
  btn.title = "可视化编辑";
  btn.setAttribute("aria-label", "可视化编辑");
  btn.innerHTML =
    '<span class="lumen-formula-visual-ico" aria-hidden="true">▦</span><span>可视化</span>';
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onVisual();
  });
  container.appendChild(btn);
}

function findCodeBlockPos(
  doc: { resolve: (n: number) => { depth: number; node: (d: number) => PmNode; before: (d: number) => number }; content: { size: number }; nodeAt: (n: number) => PmNode | null },
  pos: number,
): number | null {
  const at = doc.nodeAt(pos);
  if (at?.type.name === "code_block") return pos;
  const $pos = doc.resolve(Math.min(pos + 1, doc.content.size));
  for (let d = $pos.depth; d >= 0; d--) {
    if ($pos.node(d).type.name === "code_block") return $pos.before(d);
  }
  return null;
}

function createInlineMath(schema: Schema, latex: string): PmNode | null {
  const t = schema.nodes.math_inline;
  if (!t) return null;
  return t.create({ value: latex });
}

function createLatexCodeBlock(schema: Schema, latex: string): PmNode | null {
  const t = schema.nodes.code_block;
  if (!t) return null;
  return t.create({ language: "LaTeX" }, latex ? schema.text(latex) : undefined);
}

/**
 * @returns dispose
 */
export function attachFormulaVisualEdit(
  root: HTMLElement,
  crepe: Crepe,
  onRequest: (req: FormulaEditRequest) => void,
): () => void {
  const onDblClick = (ev: MouseEvent) => {
    const inline = findInlineMathFromEvent(ev.target);
    if (inline) {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const pos = view.posAtDOM(inline.el, 0);
          onRequest({ kind: "inline", pos, latex: inline.latex });
        });
      } catch {
        /* ignore */
      }
      return;
    }
    const block = findLatexCodeBlock(ev.target);
    if (block) {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const pos = view.posAtDOM(block.host, 0);
          onRequest({ kind: "block", pos, latex: block.latex });
        });
      } catch {
        /* ignore */
      }
    }
  };

  const observer = new MutationObserver(() => {
    const tip = root.querySelector<HTMLElement>(".milkdown-latex-inline-edit");
    if (!tip || tip.dataset.show === "false") return;
    injectTooltipButton(tip, () => {
      try {
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const sel = view.state.selection;
          if (!(sel instanceof NodeSelection)) return;
          if (sel.node.type.name !== "math_inline") return;
          onRequest({
            kind: "inline",
            pos: sel.from,
            latex: String(sel.node.attrs.value ?? ""),
          });
        });
      } catch {
        /* ignore */
      }
    });
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-show"],
  });

  root.addEventListener("dblclick", onDblClick, true);

  return () => {
    root.removeEventListener("dblclick", onDblClick, true);
    observer.disconnect();
  };
}

export function isFormulaInsertRequest(req: FormulaEditRequest): boolean {
  return req.kind === "insert-inline" || req.kind === "insert-block";
}

export function formulaRequestDisplayKind(
  req: FormulaEditRequest,
): FormulaDisplayKind {
  if (req.kind === "insert-block" || req.kind === "block") return "block";
  return "inline";
}

/**
 * 按最终形态写回：新建插入，或更新/转换已有节点。
 */
export function applyFormulaLatex(
  crepe: Crepe,
  req: FormulaEditRequest,
  latex: string,
  outputKind: FormulaDisplayKind = formulaRequestDisplayKind(req),
): boolean {
  try {
    let ok = false;
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state, dispatch } = view;
      const { schema } = state;
      const inserting = isFormulaInsertRequest(req);
      const srcKind: FormulaDisplayKind | null = inserting
        ? null
        : req.kind === "block"
          ? "block"
          : "inline";

      if (inserting) {
        if (outputKind === "inline") {
          const node = createInlineMath(schema, latex);
          if (node) dispatch(state.tr.replaceSelectionWith(node, false));
          else dispatch(state.tr.insertText(`$${latex}$`));
          ok = true;
        } else {
          const block = createLatexCodeBlock(schema, latex);
          if (!block) return;
          dispatch(state.tr.replaceSelectionWith(block, false));
          ok = true;
        }
        requestAnimationFrame(() => view.focus());
        return;
      }

      if (srcKind === "inline" && outputKind === "inline") {
        const node = state.doc.nodeAt(req.pos);
        if (!node || node.type.name !== "math_inline") return;
        dispatch(state.tr.setNodeAttribute(req.pos, "value", latex));
        ok = true;
        requestAnimationFrame(() => view.focus());
        return;
      }

      if (srcKind === "block" && outputKind === "block") {
        const blockPos = findCodeBlockPos(state.doc, req.pos);
        if (blockPos == null) return;
        const block = state.doc.nodeAt(blockPos);
        if (!block || block.type.name !== "code_block") return;
        const from = blockPos + 1;
        const to = blockPos + block.nodeSize - 1;
        const tr = state.tr.replaceWith(
          from,
          to,
          latex ? schema.text(latex) : [],
        );
        tr.setNodeMarkup(blockPos, undefined, {
          ...block.attrs,
          language: "LaTeX",
        });
        dispatch(tr);
        ok = true;
        requestAnimationFrame(() => view.focus());
        return;
      }

      if (srcKind === "inline" && outputKind === "block") {
        const node = state.doc.nodeAt(req.pos);
        if (!node || node.type.name !== "math_inline") return;
        const block = createLatexCodeBlock(schema, latex);
        if (!block) return;
        const from = req.pos;
        const to = req.pos + node.nodeSize;
        const $from = state.doc.resolve(from);
        let tr = state.tr.delete(from, to);
        const insertAt = tr.mapping.map($from.after($from.depth));
        tr = tr.insert(insertAt, block);
        dispatch(tr);
        ok = true;
        requestAnimationFrame(() => view.focus());
        return;
      }

      if (srcKind === "block" && outputKind === "inline") {
        const blockPos = findCodeBlockPos(state.doc, req.pos);
        if (blockPos == null) return;
        const block = state.doc.nodeAt(blockPos);
        if (!block || block.type.name !== "code_block") return;
        const inline = createInlineMath(schema, latex);
        if (!inline) return;
        const paraType = schema.nodes.paragraph;
        const replacement = paraType ? paraType.create(null, inline) : inline;
        const tr = state.tr.replaceWith(
          blockPos,
          blockPos + block.nodeSize,
          replacement,
        );
        const selPos = Math.min(blockPos + 1, tr.doc.content.size);
        try {
          tr.setSelection(TextSelection.create(tr.doc, selPos));
        } catch {
          /* ignore */
        }
        dispatch(tr);
        ok = true;
        requestAnimationFrame(() => view.focus());
      }
    });
    return ok;
  } catch {
    return false;
  }
}

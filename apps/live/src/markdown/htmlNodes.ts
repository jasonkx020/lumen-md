import { htmlSchema } from "@milkdown/kit/preset/commonmark";
import { $view } from "@milkdown/kit/utils";
import type { Node as ProseNode } from "@milkdown/prose/model";
import type { EditorView, NodeView } from "@milkdown/prose/view";
import { sanitizeHtml } from "./sanitizeHtml";

function openHtmlEditor(
  initial: string,
  onSave: (next: string) => void,
  onCancel: () => void,
) {
  const overlay = document.createElement("div");
  overlay.className = "html-md-dialog";
  overlay.innerHTML = `
    <div class="html-md-dialog-panel" role="dialog" aria-label="编辑 HTML">
      <h3>编辑 HTML</h3>
      <textarea></textarea>
      <div class="html-md-dialog-actions">
        <button type="button" data-act="cancel">取消</button>
        <button type="button" class="primary" data-act="save">保存</button>
      </div>
    </div>
  `;
  const ta = overlay.querySelector("textarea")!;
  ta.value = initial;
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      close();
      onCancel();
    }
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      close();
      onCancel();
    }
  });
  overlay.querySelector('[data-act="cancel"]')!.addEventListener("click", () => {
    close();
    onCancel();
  });
  overlay.querySelector('[data-act="save"]')!.addEventListener("click", () => {
    const next = ta.value;
    close();
    onSave(next);
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  ta.focus();
}

function createHtmlNodeView(
  node: ProseNode,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  // 必须用 div：span 是 phrasing 容器，innerHTML 放入 <table> 会被浏览器拆掉
  const dom = document.createElement("div");
  dom.className = "html-md-node";
  dom.setAttribute("data-type", "html");
  dom.contentEditable = "false";

  const badge = document.createElement("span");
  badge.className = "html-md-badge";
  badge.textContent = "HTML";

  const body = document.createElement("div");
  body.className = "html-md-body";

  const render = (value: string) => {
    const safe = sanitizeHtml(value);
    body.innerHTML = safe || `<code>${escapeText(value)}</code>`;
    dom.dataset.value = value;
  };

  render(String(node.attrs.value ?? ""));

  dom.appendChild(badge);
  dom.appendChild(body);

  const edit = () => {
    const pos = getPos();
    if (pos === undefined) return;
    const current = String(
      view.state.doc.nodeAt(pos)?.attrs.value ?? dom.dataset.value ?? "",
    );
    openHtmlEditor(
      current,
      (next) => {
        const tr = view.state.tr.setNodeMarkup(pos, undefined, {
          value: next,
        });
        view.dispatch(tr);
        render(next);
      },
      () => {},
    );
  };

  dom.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    edit();
  });

  return {
    dom,
    update(updated) {
      if (updated.type.name !== "html") return false;
      render(String(updated.attrs.value ?? ""));
      return true;
    },
    selectNode() {
      dom.classList.add("is-selected");
    },
    deselectNode() {
      dom.classList.remove("is-selected");
    },
    stopEvent(event) {
      return event.type === "dblclick";
    },
    ignoreMutation: () => true,
  };
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 将 Milkdown html atom 渲染为消毒后的 HTML，双击可编辑源码。 */
export const htmlPreviewView = $view(htmlSchema.node, () => {
  return (node, view, getPos) =>
    createHtmlNodeView(node, view, getPos as () => number | undefined);
});

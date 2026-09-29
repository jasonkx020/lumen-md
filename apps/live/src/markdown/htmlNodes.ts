import { htmlSchema } from "@milkdown/kit/preset/commonmark";
import { $view } from "@milkdown/kit/utils";
import type { Node as ProseNode } from "@milkdown/prose/model";
import type { EditorView, NodeView } from "@milkdown/prose/view";
import { htmlBlockSchema } from "./htmlBlockNodes";
import { getHtmlAssetDocAbs } from "./htmlAssetContext";
import { sanitizeHtml } from "./sanitizeHtml";
import { rewriteHtmlImgSrcs } from "./rewriteHtmlAssets";

/** Shadow 内最小复位：不覆盖作者 style，只保证图片不被撑满整行。 */
const SHADOW_BASE_CSS = `
:host {
  display: block;
  position: relative;
  margin: 0.35em 0;
}
.badge {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
  font-size: 10px;
  letter-spacing: 0.04em;
  color: #656d76;
  font-family: system-ui, sans-serif;
  opacity: 0;
  user-select: none;
  pointer-events: none;
  line-height: 1;
  padding: 1px 4px;
  background: rgba(255, 255, 255, 0.85);
  border-radius: 3px;
}
:host(:hover) .badge,
:host(.is-selected) .badge {
  opacity: 1;
}
.body {
  display: block;
  max-width: 100%;
  overflow: visible;
  line-height: 0; /* 消除行内基线空隙；文字节点自行恢复 */
}
.body > :not(img):not(a):not(picture):not(div) {
  line-height: 1.75;
}
/* 勿写 display/flex！作者 inline style 优先，交给 WebView2 布局 */
.body img {
  max-width: 100%;
  height: auto;
  vertical-align: middle;
}
/* 独立块级图默认居中 */
.body > img,
.body > picture,
.body > a:has(> img):only-child {
  display: block;
  margin-left: auto;
  margin-right: auto;
  line-height: 0;
}
/*
 * flex 图墙：可缩成一行 + 图间距。
 * 子项默认 min-width:auto 会按 img width=240 撑开换行。
 */
.body .lumen-html-flex,
.body > div[style*="display: flex"],
.body > div[style*="display:flex"] {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  align-items: flex-start;
  gap: 8px;
  line-height: 0;
}
.body .lumen-html-flex > a,
.body .lumen-html-flex > img,
.body .lumen-html-flex > picture,
.body > div[style*="display: flex"] > a,
.body > div[style*="display:flex"] > a,
.body > div[style*="display: flex"] > img,
.body > div[style*="display:flex"] > img,
.body > div[style*="display: flex"] > picture,
.body > div[style*="display:flex"] > picture {
  min-width: 0;
  flex: 1 1 0;
  margin: 0;
  line-height: 0;
}
.body .lumen-html-flex img,
.body > div[style*="display: flex"] img,
.body > div[style*="display:flex"] img {
  display: block;
  width: 100%;
  max-width: 100%;
  height: auto;
  margin: 0;
  object-fit: contain;
  vertical-align: top;
}
.body a {
  color: #0969da;
  text-decoration: none;
}
.body a:hover {
  text-decoration: underline;
}
.body a img {
  border: 0;
}
`;

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

function isLinkEventTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el?.closest?.("a[href]"));
}

function isLinkFromEvent(event: Event): boolean {
  const path =
    typeof event.composedPath === "function" ? event.composedPath() : [];
  for (const n of path) {
    if (n instanceof HTMLElement && n.tagName === "A" && n.hasAttribute("href")) {
      return true;
    }
  }
  return isLinkEventTarget(event.target);
}

/** 块级：Shadow DOM 隔离编辑器 CSS，保留 WebView2 对 HTML/style 的原生布局。 */
function createBlockHtmlNodeView(
  node: ProseNode,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  const dom = document.createElement("div");
  dom.className = "html-md-node is-block";
  dom.setAttribute("data-type", "html-block");
  dom.contentEditable = "false";

  const shadow = dom.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = SHADOW_BASE_CSS;
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = "HTML";
  const body = document.createElement("div");
  body.className = "body";
  shadow.append(style, badge, body);

  let renderGen = 0;
  const render = (value: string) => {
    const gen = ++renderGen;
    // template.innerHTML = WebView2/Chromium 解析；再挂进 shadow
    const safe = sanitizeHtml(value);
    body.innerHTML = safe || `<code>${escapeText(value)}</code>`;
    dom.dataset.value = value;
    const docAbs = getHtmlAssetDocAbs();
    void rewriteHtmlImgSrcs(body, docAbs).then(() => {
      if (gen !== renderGen) return;
    });
  };

  render(String(node.attrs.value ?? ""));

  const edit = () => {
    const pos = getPos();
    if (pos === undefined) return;
    const current = String(
      view.state.doc.nodeAt(pos)?.attrs.value ?? dom.dataset.value ?? "",
    );
    openHtmlEditor(
      current,
      (next) => {
        const tr = view.state.tr.setNodeMarkup(pos, undefined, { value: next });
        view.dispatch(tr);
        render(next);
      },
      () => {},
    );
  };

  dom.addEventListener("dblclick", (e) => {
    if (isLinkFromEvent(e)) return;
    e.preventDefault();
    e.stopPropagation();
    edit();
  });

  return {
    dom,
    update(updated) {
      if (updated.type.name !== "html_block") return false;
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
      if (event.type === "dblclick") return true;
      if (
        (event.type === "click" ||
          event.type === "mousedown" ||
          event.type === "mouseup") &&
        isLinkFromEvent(event)
      ) {
        return true;
      }
      return false;
    },
    ignoreMutation: () => true,
  };
}

/** 行内：仍用 light DOM（display:contents），避免打断段落流。 */
function createInlineHtmlNodeView(
  node: ProseNode,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  const dom = document.createElement("span");
  dom.className = "html-md-node is-inline";
  dom.setAttribute("data-type", "html");
  dom.contentEditable = "false";

  const body = document.createElement("span");
  body.className = "html-md-body";
  body.style.display = "contents";

  let renderGen = 0;
  const render = (value: string) => {
    const gen = ++renderGen;
    const safe = sanitizeHtml(value);
    body.innerHTML = safe || `<code>${escapeText(value)}</code>`;
    dom.dataset.value = value;
    const docAbs = getHtmlAssetDocAbs();
    void rewriteHtmlImgSrcs(body, docAbs).then(() => {
      if (gen !== renderGen) return;
    });
  };

  render(String(node.attrs.value ?? ""));
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
        const tr = view.state.tr.setNodeMarkup(pos, undefined, { value: next });
        view.dispatch(tr);
        render(next);
      },
      () => {},
    );
  };

  dom.addEventListener("dblclick", (e) => {
    if (isLinkFromEvent(e)) return;
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
      if (event.type === "dblclick") return true;
      if (
        (event.type === "click" ||
          event.type === "mousedown" ||
          event.type === "mouseup") &&
        isLinkFromEvent(event)
      ) {
        return true;
      }
      return false;
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

export const htmlPreviewView = $view(htmlSchema.node, () => {
  return (node, view, getPos) =>
    createInlineHtmlNodeView(node, view, getPos as () => number | undefined);
});

export const htmlBlockPreviewView = $view(htmlBlockSchema.node, () => {
  return (node, view, getPos) =>
    createBlockHtmlNodeView(node, view, getPos as () => number | undefined);
});

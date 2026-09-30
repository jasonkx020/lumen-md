/** Crepe code-block `renderPreview`：Mermaid SVG + 轻量工具条编辑。 */

import mermaid from "mermaid";
import {
  findCodeBlockHost,
  findSvgNodeElement,
  insertEdge,
  insertNode,
  insertSubgraph,
  isFlowchartSource,
  nextNodeId,
  parseSvgNodeId,
  readMermaidSource,
  renameNodeLabel,
  setFlowchartDirection,
  writeMermaidSource,
} from "./mermaidEdit";
import {
  looksLikeMermaidDiagram,
  prepareMermaidSource,
} from "./normalizeMermaidMd";

let ready = false;

function ensureMermaid() {
  if (ready) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    theme: "neutral",
  });
  ready = true;
}

export function shouldRenderMermaid(language: string, content: string): boolean {
  if (!content.trim()) return false;
  const lang = language.trim().toLowerCase();
  if (lang === "mermaid") return true;
  if (!lang || lang === "text" || lang === "txt" || lang === "plain") {
    return looksLikeMermaidDiagram(content);
  }
  return false;
}

type LinkMode = {
  active: boolean;
  fromId: string | null;
};

/** 每个 code-block 一份连线状态（预览 DOM 会被 sanitize 重建）。 */
const linkByHost = new WeakMap<HTMLElement, LinkMode>();

function getLinkMode(host: HTMLElement): LinkMode {
  let m = linkByHost.get(host);
  if (!m) {
    m = { active: false, fromId: null };
    linkByHost.set(host, m);
  }
  return m;
}

function applySource(
  host: HTMLElement,
  fallback: string,
  transform: (src: string) => string,
): void {
  const cur = readMermaidSource(host, fallback);
  const next = transform(cur);
  if (next === cur) return;
  writeMermaidSource(host, next);
}

function clearLinkHighlight(scope: ParentNode) {
  scope.querySelectorAll("g.node.mermaid-link-from").forEach((el) => {
    el.classList.remove("mermaid-link-from");
  });
}

function syncLinkUi(root: HTMLElement, link: LinkMode) {
  const btn = root.querySelector<HTMLButtonElement>(
    '[data-mmd-action="link-mode"]',
  );
  if (btn) {
    btn.classList.toggle("is-active", link.active);
    btn.textContent = link.active ? "取消连线" : "添加连线";
  }
  const st = root.querySelector<HTMLElement>("[data-mmd-status]");
  if (st) {
    st.textContent = link.active
      ? link.fromId
        ? `已选 ${link.fromId}，再点目标节点`
        : "连线模式：点选起点"
      : "";
  }
}

function resetLinkMode(host: HTMLElement, root: HTMLElement) {
  const link = getLinkMode(host);
  link.active = false;
  link.fromId = null;
  clearLinkHighlight(root);
  syncLinkUi(root, link);
}

function buildToolbarMarkup(snapshot: string): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "mermaid-edit-toolbar";

  if (!isFlowchartSource(snapshot)) {
    const hint = document.createElement("span");
    hint.className = "mermaid-edit-hint";
    hint.textContent = "当前图类型请用「编辑源码」修改";
    bar.append(hint);
    return bar;
  }

  const mkBtn = (label: string, action: string, title?: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mermaid-edit-btn";
    b.dataset.mmdAction = action;
    b.textContent = label;
    if (title) b.title = title;
    return b;
  };

  bar.append(
    mkBtn("添加节点", "add-node", "在图末追加一个节点"),
    mkBtn("添加连线", "link-mode", "依次点击两个节点连线"),
    mkBtn("添加子图", "add-subgraph"),
    mkBtn("方向 TB", "dir-tb"),
    mkBtn("方向 LR", "dir-lr"),
  );

  const status = document.createElement("span");
  status.className = "mermaid-edit-status";
  status.dataset.mmdStatus = "1";
  bar.append(status);
  return bar;
}

/**
 * Milkdown PreviewPanel 会把 HTMLElement sanitize 后写进 innerHTML，
 * 本地 addEventListener 会丢失，因此用 document 级委托。
 * 代码块 NodeView.stopEvent 会吞掉点击，需自管「选中/编辑」态。
 */
let delegationReady = false;

function setMermaidEditing(host: HTMLElement, on: boolean) {
  host.classList.toggle("mermaid-editing", on);
  if (!on) {
    const root = host.querySelector<HTMLElement>(".mermaid-preview-root");
    if (root) resetLinkMode(host, root);
  }
}

function ensureEditDelegation() {
  if (delegationReady) return;
  delegationReady = true;

  document.addEventListener(
    "mousedown",
    (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      const inside = target.closest(".milkdown-code-block.mermaid-editing");
      document
        .querySelectorAll<HTMLElement>(".milkdown-code-block.mermaid-editing")
        .forEach((host) => {
          if (inside !== host && !host.contains(target)) {
            setMermaidEditing(host, false);
          }
        });
    },
    true,
  );

  document.addEventListener(
    "click",
    (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;

      const root = target.closest(".mermaid-preview-root");
      if (!(root instanceof HTMLElement)) return;
      const host = findCodeBlockHost(root);
      if (!host) return;

      const wasEditing = host.classList.contains("mermaid-editing");
      // 点到图即进入编辑态（显示工具条）
      setMermaidEditing(host, true);

      const actionBtn = target.closest(
        "[data-mmd-action]",
      ) as HTMLElement | null;
      if (actionBtn && root.contains(actionBtn)) {
        ev.preventDefault();
        ev.stopPropagation();
        handleToolbarAction(
          host,
          root,
          actionBtn.dataset.mmdAction || "",
        );
        return;
      }

      const nodeEl = findSvgNodeElement(target);
      if (!nodeEl || !root.contains(nodeEl)) return;
      const nodeId = parseSvgNodeId(nodeEl);
      if (!nodeId) return;

      // 首次点选只激活工具条，避免误弹改标签
      if (!wasEditing && !getLinkMode(host).active) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }

      ev.preventDefault();
      ev.stopPropagation();
      handleNodeClick(host, root, nodeEl, nodeId);
    },
    true,
  );

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    const host = document.querySelector<HTMLElement>(
      ".milkdown-code-block.mermaid-editing, .milkdown-code-block.selected",
    );
    if (!host) return;
    const root = host.querySelector<HTMLElement>(".mermaid-preview-root");
    if (!root) return;
    const link = getLinkMode(host);
    if (link.active) {
      resetLinkMode(host, root);
      return;
    }
    // 再按 Esc 退出编辑态
    setMermaidEditing(host, false);
  });
}

function handleToolbarAction(
  host: HTMLElement,
  root: HTMLElement,
  action: string,
) {
  const fallback = readMermaidSource(host, "");
  const link = getLinkMode(host);

  if (action === "add-node") {
    resetLinkMode(host, root);
    applySource(host, fallback, (src) => {
      const id = nextNodeId(src);
      return insertNode(src, id, "新节点");
    });
    return;
  }
  if (action === "add-subgraph") {
    resetLinkMode(host, root);
    applySource(host, fallback, insertSubgraph);
    return;
  }
  if (action === "dir-tb") {
    applySource(host, fallback, (src) => setFlowchartDirection(src, "TB"));
    return;
  }
  if (action === "dir-lr") {
    applySource(host, fallback, (src) => setFlowchartDirection(src, "LR"));
    return;
  }
  if (action === "link-mode") {
    link.active = !link.active;
    link.fromId = null;
    clearLinkHighlight(root);
    syncLinkUi(root, link);
  }
}

function handleNodeClick(
  host: HTMLElement,
  root: HTMLElement,
  nodeEl: Element,
  nodeId: string,
) {
  const fallback = readMermaidSource(host, "");
  const link = getLinkMode(host);

  if (link.active) {
    if (!link.fromId) {
      link.fromId = nodeId;
      clearLinkHighlight(root);
      nodeEl.classList.add("mermaid-link-from");
      syncLinkUi(root, link);
      return;
    }
    if (link.fromId === nodeId) {
      link.fromId = null;
      clearLinkHighlight(root);
      syncLinkUi(root, link);
      return;
    }
    const from = link.fromId;
    resetLinkMode(host, root);
    applySource(host, fallback, (src) => insertEdge(src, from, nodeId));
    return;
  }

  const labelText =
    nodeEl
      .querySelector(".nodeLabel, .label, foreignObject")
      ?.textContent?.trim() || nodeId;
  const next = window.prompt(`节点 ${nodeId} 的标签`, labelText);
  if (next == null) return;
  const label = next.trim();
  if (!label) return;
  applySource(host, fallback, (src) => renameNodeLabel(src, nodeId, label));
}

/**
 * 异步预览：返回 `undefined` 让 code-block 显示 Loading，完成后 `applyPreview`。
 */
export function renderMermaidPreview(
  content: string,
  applyPreview: (value: null | string | HTMLElement) => void,
): undefined {
  ensureMermaid();
  ensureEditDelegation();
  const code = prepareMermaidSource(content);
  const id = `mmd-${Math.random().toString(36).slice(2, 10)}`;

  void mermaid
    .render(id, code || "flowchart TB\nA[ ]")
    .then(({ svg }) => {
      const root = document.createElement("div");
      root.className = "mermaid-preview-root";
      root.dataset.mmdPreview = "1";

      const toolbar = buildToolbarMarkup(code);
      const preview = document.createElement("div");
      preview.className = "mermaid-preview";
      preview.innerHTML = svg;

      root.append(toolbar, preview);
      applyPreview(root);
    })
    .catch((e) => {
      const err = document.createElement("pre");
      err.className = "mermaid-error";
      err.textContent = String(e instanceof Error ? e.message : e);
      applyPreview(err);
    });
  return undefined;
}

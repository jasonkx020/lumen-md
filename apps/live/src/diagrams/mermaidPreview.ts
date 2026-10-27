/** Crepe code-block `renderPreview`：Mermaid SVG + 形状工具栏 / 锚点连线。 */

import mermaid from "mermaid";
import {
  collectNodeIds,
  findCodeBlockHost,
  findSvgNodeAtPoint,
  findSvgNodeElement,
  getNodeLabel,
  insertEdge,
  insertNode,
  isFlowchartSource,
  isSvgFlowNode,
  nextNodeId,
  type NodeShape,
  parseSvgEdgeEndpoints,
  parseSvgNodeId,
  readMermaidSource,
  removeEdge,
  removeNode,
  renameNodeLabel,
  resolveSourceNodeId,
  setFlowchartDirection,
  setNodeShape,
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

type DragLinkState = {
  host: HTMLElement;
  root: HTMLElement;
  fromId: string;
  startX: number;
  startY: number;
  dragging: boolean;
  overlay: SVGSVGElement | null;
  line: SVGLineElement | null;
  hoverEl: Element | null;
  suppressClick: boolean;
};

let dragLink: DragLinkState | null = null;
/** 单击选中的流程图节点：工具栏添加图形时作为父节点连出子节点 */
let selectedFlowNode: {
  host: HTMLElement;
  root: HTMLElement;
  nodeId: string;
} | null = null;
const DRAG_THRESHOLD_PX = 6;
/** 从锚点拖到空白处新建时，至少拖这么远，避免误触 */
const BLANK_CREATE_MIN_PX = 28;
const DROP_HIT_PAD_PX = 14;

function hostIsInteractive(host: HTMLElement): boolean {
  return (
    host.classList.contains("mermaid-editing") ||
    host.classList.contains("selected")
  );
}

function rootIsFlowchart(root: HTMLElement, host: HTMLElement): boolean {
  if (root.dataset.mmdFlow === "1") return true;
  return isFlowchartSource(readMermaidSource(host, ""));
}

/** 写入 CM 后强制刷新预览：Milkdown 有时不会立刻用新源码重跑 renderPreview。 */
let previewGen = 0;
const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * 在每个 flowchart 节点 g 上注入四向锚点 circle。
 * 选中/编辑态由 CSS 显示，不依赖悬停命中（foreignObject 上 closest 常失败）。
 */
function decorateMermaidSvgPorts(root: HTMLElement): void {
  const preview = root.querySelector(".mermaid-preview");
  if (!preview) return;
  const host = findCodeBlockHost(root);
  const source = host ? readMermaidSource(host, "") : "";
  const nodes = Array.from(
    preview.querySelectorAll(
      "g.node, g[class*='flowchart-node'], g[id^='flowchart-'], g[data-mmd-id]",
    ),
  );
  let decorated = 0;
  for (const node of nodes) {
    if (!(node instanceof SVGGElement)) continue;
    if (!isSvgFlowNode(node)) continue;
    let nodeId = parseSvgNodeId(node);
    if (!nodeId) {
      const raw = node.getAttribute("id") || "";
      const m = /^(?:flowchart-)?(.+?)(?:-\d+)?$/.exec(raw);
      nodeId = m?.[1] && m[1] !== "node" ? m[1] : null;
    }
    if (nodeId && source) {
      const labelHint =
        node
          .querySelector(".nodeLabel, .label, foreignObject")
          ?.textContent?.trim() || "";
      nodeId =
        resolveSourceNodeId(source, nodeId, labelHint) ||
        (collectNodeIds(source).includes(nodeId) ? nodeId : null);
    }
    if (!nodeId) continue;
    node.setAttribute("data-mmd-id", nodeId);
    decorated += 1;

    // 已有正确锚点则跳过，避免重复叠加
    const existing = Array.from(node.children).filter(
      (c): c is Element =>
        c instanceof Element && c.classList.contains("mermaid-svg-port"),
    );
    if (
      existing.length === 4 &&
      existing.every((p) => p.getAttribute("data-mmd-from") === nodeId)
    ) {
      continue;
    }
    existing.forEach((p) => p.remove());
    node.querySelectorAll(".mermaid-svg-port").forEach((p) => p.remove());

    let bb: DOMRect;
    try {
      bb = node.getBBox();
    } catch {
      continue;
    }
    if (!(bb.width > 1 && bb.height > 1)) continue;

    const pts: Array<[string, number, number]> = [
      ["n", bb.x + bb.width / 2, bb.y],
      ["s", bb.x + bb.width / 2, bb.y + bb.height],
      ["w", bb.x, bb.y + bb.height / 2],
      ["e", bb.x + bb.width, bb.y + bb.height / 2],
    ];
    for (const [dir, cx, cy] of pts) {
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("class", "mermaid-svg-port");
      c.setAttribute("data-mmd-port", dir);
      c.setAttribute("data-mmd-from", nodeId);
      c.setAttribute("cx", String(cx));
      c.setAttribute("cy", String(cy));
      c.setAttribute("r", "6");
      c.setAttribute("role", "button");
      c.setAttribute("aria-label", "拖出连线");
      node.appendChild(c);
    }
  }
  if (decorated > 0) root.dataset.mmdFlow = "1";
  reapplySelectedHighlight(root);
}

function clearSelectedHighlight(scope: ParentNode = document) {
  scope
    .querySelectorAll(".mermaid-node-selected")
    .forEach((el) => el.classList.remove("mermaid-node-selected"));
}

function reapplySelectedHighlight(root?: HTMLElement | null) {
  const sel = selectedFlowNode;
  if (!sel) return;
  const scope = root && root.isConnected ? root : sel.root;
  if (!scope.isConnected || !sel.host.isConnected) {
    selectedFlowNode = null;
    return;
  }
  clearSelectedHighlight(scope);
  const el = Array.from(scope.querySelectorAll<Element>("[data-mmd-id]")).find(
    (n) => n.getAttribute("data-mmd-id") === sel.nodeId,
  );
  if (el) el.classList.add("mermaid-node-selected");
}

function setSelectedFlowNode(
  host: HTMLElement,
  root: HTMLElement,
  nodeId: string | null,
) {
  clearSelectedHighlight(root);
  if (!nodeId) {
    if (selectedFlowNode?.host === host) selectedFlowNode = null;
    return;
  }
  const src = readMermaidSource(host, "");
  const resolved = resolveSourceNodeId(src, nodeId) || nodeId;
  selectedFlowNode = { host, root, nodeId: resolved };
  setMermaidEditing(host, true);
  reapplySelectedHighlight(root);
}

function scheduleDecoratePorts(root?: HTMLElement | null) {
  const run = () => {
    if (root && root.isConnected) {
      decorateMermaidSvgPorts(root);
      return;
    }
    document
      .querySelectorAll<HTMLElement>(".mermaid-preview-root")
      .forEach((r) => decorateMermaidSvgPorts(r));
  };
  // Milkdown 会把 Element 再 sanitize 进 DOM，需延后一帧装饰
  requestAnimationFrame(() => {
    run();
    requestAnimationFrame(run);
    window.setTimeout(run, 50);
    window.setTimeout(run, 200);
  });
}

function refreshMermaidPreview(host: HTMLElement, source: string): void {
  const root = host.querySelector<HTMLElement>(".mermaid-preview-root");
  const preview = root?.querySelector<HTMLElement>(".mermaid-preview");
  if (!preview || !root) return;
  const code = prepareMermaidSource(source);
  if (!code) return;
  if (isFlowchartSource(code)) root.dataset.mmdFlow = "1";
  ensureMermaid();
  const gen = ++previewGen;
  const id = `mmd-rf-${Math.random().toString(36).slice(2, 10)}`;
  clearPorts();
  void mermaid
    .render(id, code)
    .then(({ svg }) => {
      if (gen !== previewGen) return;
      if (!host.contains(preview)) return;
      preview.innerHTML = svg;
      decorateMermaidSvgPorts(root);
      scheduleDecoratePorts(root);
    })
    .catch((e) => {
      if (gen !== previewGen) return;
      if (!host.contains(preview)) return;
      preview.innerHTML = "";
      const err = document.createElement("pre");
      err.className = "mermaid-error";
      err.textContent = String(e instanceof Error ? e.message : e);
      preview.appendChild(err);
    });
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
  refreshMermaidPreview(host, next);
}

function clearLinkHighlight(scope: ParentNode) {
  scope
    .querySelectorAll(".mermaid-link-from, .mermaid-link-hover")
    .forEach((el) => {
      el.classList.remove("mermaid-link-from", "mermaid-link-hover");
    });
}

function clearDragHover(state: DragLinkState | null = dragLink) {
  if (state?.hoverEl) {
    state.hoverEl.classList.remove("mermaid-link-hover");
    state.hoverEl = null;
  }
}

function swallowNextClick() {
  const swallow = (ev: MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    document.removeEventListener("click", swallow, true);
  };
  document.addEventListener("click", swallow, true);
  window.setTimeout(() => {
    document.removeEventListener("click", swallow, true);
  }, 0);
}

/** 从 SVG 节点对齐到源码里已有的 id；对不上则 null（禁止凭空造节点）。 */
function sourceIdFromSvgNode(
  source: string,
  nodeEl: Element | null,
  fallbackRaw = "",
): string | null {
  if (!nodeEl && !fallbackRaw) return null;
  const raw =
    nodeEl?.getAttribute("data-mmd-id") ||
    (nodeEl ? parseSvgNodeId(nodeEl) : null) ||
    fallbackRaw;
  const hint =
    nodeEl
      ?.querySelector(".nodeLabel, .label, foreignObject")
      ?.textContent?.trim() || "";
  const resolved = resolveSourceNodeId(source, raw || "", hint);
  if (!resolved) return null;
  return collectNodeIds(source).includes(resolved) ? resolved : null;
}

function createLinkedNode(
  host: HTMLElement,
  fromId: string,
  shape: NodeShape,
) {
  const fallback = readMermaidSource(host, "");
  applySource(host, fallback, (src) => {
    const id = nextNodeId(src);
    let next = insertNode(src, id, "新节点", shape);
    next = insertEdge(next, fromId, id);
    return next;
  });
}

function endDragLink(
  commit: boolean,
  toEl: Element | null,
  onBlank: boolean,
  menuX = 0,
  menuY = 0,
) {
  const state = dragLink;
  if (!state) return;
  // 先清空，防止同一次手势重复 mouseup 提交多次
  dragLink = null;
  clearDragHover(state);
  state.overlay?.remove();
  state.root.classList.remove("mermaid-drag-linking");
  const host = state.host;
  const suppress = state.suppressClick || state.dragging;

  if (state.dragging) {
    const fallback = readMermaidSource(host, "");
    const fromId =
      sourceIdFromSvgNode(fallback, null, state.fromId) ||
      resolveSourceNodeId(fallback, state.fromId) ||
      null;

    if (commit && toEl) {
      const toId = sourceIdFromSvgNode(fallback, toEl);
      if (fromId && toId && toId !== fromId) {
        applySource(host, fallback, (src) => insertEdge(src, fromId, toId));
      }
      // 命中了节点但 id 对不齐：取消，绝不新建
    } else if (onBlank && fromId) {
      openShapePickMenu(menuX, menuY, (shape) =>
        createLinkedNode(host, fromId, shape),
      );
    }
  }

  if (suppress) swallowNextClick();
}

function placeDragOverlay(
  overlay: SVGSVGElement,
  root: HTMLElement,
): DOMRect {
  const rect = root.getBoundingClientRect();
  overlay.style.left = `${rect.left}px`;
  overlay.style.top = `${rect.top}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
  overlay.setAttribute("width", String(Math.max(1, rect.width)));
  overlay.setAttribute("height", String(Math.max(1, rect.height)));
  overlay.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
  return rect;
}

function ensureDragOverlay(root: HTMLElement): {
  overlay: SVGSVGElement;
  line: SVGLineElement;
} {
  let overlay = document.querySelector<SVGSVGElement>("svg.mermaid-drag-overlay");
  if (!overlay) {
    overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    overlay.classList.add("mermaid-drag-overlay");
    overlay.setAttribute("aria-hidden", "true");
    document.body.appendChild(overlay);
  }
  let line = overlay.querySelector<SVGLineElement>("line.mermaid-drag-line");
  if (!line) {
    line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.classList.add("mermaid-drag-line");
    overlay.appendChild(line);
  }
  placeDragOverlay(overlay, root);
  return { overlay, line };
}

function clientToRoot(root: HTMLElement, clientX: number, clientY: number) {
  const rect = root.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function isMermaidFloatingUi(el: Element | null): boolean {
  return !!el?.closest(
    ".mermaid-port-layer, .mermaid-port, .mermaid-ctx-menu, .mermaid-shape-pick, .mermaid-rename-pop, .mermaid-drag-overlay",
  );
}

type ClientRectLike = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

function pointInRect(
  r: ClientRectLike,
  clientX: number,
  clientY: number,
): boolean {
  return (
    clientX >= r.left &&
    clientX <= r.right &&
    clientY >= r.top &&
    clientY <= r.bottom
  );
}

function clearPorts() {
  // 清掉历史 HTML 浮层锚点（已改用 SVG 内锚点）
  document.querySelectorAll(".mermaid-port-layer").forEach((el) => el.remove());
}

function findPreviewRootAt(clientX: number, clientY: number): HTMLElement | null {
  const stack = document.elementsFromPoint(clientX, clientY);
  for (const el of stack) {
    if (!(el instanceof Element)) continue;
    if (isMermaidFloatingUi(el)) continue;
    const root = el.closest(".mermaid-preview-root");
    if (root instanceof HTMLElement) return root;
  }
  for (const root of Array.from(
    document.querySelectorAll<HTMLElement>(".mermaid-preview-root"),
  )) {
    const preview = root.querySelector(".mermaid-preview");
    if (
      preview &&
      pointInRect(preview.getBoundingClientRect(), clientX, clientY)
    ) {
      return root;
    }
  }
  return null;
}

function beginDragLink(
  host: HTMLElement,
  root: HTMLElement,
  fromId: string,
  clientX: number,
  clientY: number,
) {
  clearPorts();
  setMermaidEditing(host, true);
  const src = readMermaidSource(host, "");
  const resolved =
    sourceIdFromSvgNode(src, null, fromId) ||
    resolveSourceNodeId(src, fromId) ||
    fromId;
  dragLink = {
    host,
    root,
    fromId: resolved,
    startX: clientX,
    startY: clientY,
    dragging: false,
    overlay: null,
    line: null,
    hoverEl: null,
    suppressClick: false,
  };
  root
    .querySelectorAll(
      "g.node, g[class*='flowchart-node'], g[id^='flowchart-'], g[data-mmd-id]",
    )
    .forEach((n) => {
      const id = sourceIdFromSvgNode(src, n);
      if (id === resolved) n.classList.add("mermaid-link-from");
    });
}

/** 按坐标解析节点（双击/右键优先，避免 foreignObject 上 closest 失败）。 */
function resolveNodeAtEvent(
  root: HTMLElement,
  ev: MouseEvent,
  target: Element,
): { nodeEl: Element; nodeId: string } | null {
  let nodeEl =
    findSvgNodeAtPoint(root, ev.clientX, ev.clientY, 8) ||
    findSvgNodeElement(target);
  if (nodeEl && !root.contains(nodeEl)) nodeEl = null;
  if (!nodeEl) {
    const port = target.closest("[data-mmd-from]");
    const fromId = port?.getAttribute("data-mmd-from");
    if (fromId) {
      const byData = Array.from(
        root.querySelectorAll<Element>("[data-mmd-id]"),
      ).find((el) => el.getAttribute("data-mmd-id") === fromId);
      if (byData) nodeEl = byData;
    }
  }
  if (!nodeEl || !root.contains(nodeEl)) return null;
  const nodeId = parseSvgNodeId(nodeEl);
  if (!nodeId) return null;
  return { nodeEl, nodeId };
}

/** Tauri/WebView2 不支持 window.prompt，用自绘输入框。 */
function promptRename(host: HTMLElement, nodeEl: Element, nodeId: string) {
  const fallback = readMermaidSource(host, "");
  const fromSvg =
    nodeEl
      .querySelector(".nodeLabel, .label, foreignObject")
      ?.textContent?.trim() || "";
  const resolvedId =
    resolveSourceNodeId(fallback, nodeId, fromSvg) ||
    resolveSourceNodeId(fallback, nodeId) ||
    nodeId;
  const fromSource = getNodeLabel(fallback, resolvedId);
  const labelText =
    (fromSource && fromSource !== resolvedId ? fromSource : fromSvg) ||
    fromSource ||
    resolvedId;

  closeCtxMenu();
  document.querySelectorAll(".mermaid-rename-pop").forEach((el) => el.remove());

  const rect = nodeEl.getBoundingClientRect();
  const pop = document.createElement("div");
  pop.className = "mermaid-rename-pop";
  pop.style.left = `${Math.max(8, rect.left)}px`;
  pop.style.top = `${Math.min(window.innerHeight - 52, rect.bottom + 6)}px`;

  const label = document.createElement("label");
  label.className = "mermaid-rename-label";
  label.textContent = `修改文案（${resolvedId}）`;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "mermaid-rename-input";
  input.value = labelText;
  input.setAttribute("aria-label", "节点标签");

  const okBtn = document.createElement("button");
  okBtn.type = "button";
  okBtn.className = "mermaid-rename-ok";
  okBtn.textContent = "确定";

  const commit = () => {
    const v = input.value.trim();
    pop.remove();
    if (!v || v === labelText) return;
    applySource(host, fallback, (src) => {
      const id =
        resolveSourceNodeId(src, resolvedId, labelText) || resolvedId;
      return renameNodeLabel(src, id, v);
    });
  };
  const cancel = () => pop.remove();

  okBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    commit();
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      commit();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      cancel();
    }
  });
  pop.addEventListener("mousedown", (ev) => ev.stopPropagation());
  pop.addEventListener("click", (ev) => ev.stopPropagation());

  pop.append(label, input, okBtn);
  document.body.appendChild(pop);
  window.setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
}

function closeCtxMenu() {
  document
    .querySelectorAll(".mermaid-ctx-menu, .mermaid-shape-pick")
    .forEach((el) => el.remove());
}

function openCtxMenu(
  x: number,
  y: number,
  items: Array<{ label: string; action: () => void }>,
) {
  closeCtxMenu();
  const menu = document.createElement("div");
  menu.className = "mermaid-ctx-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.addEventListener("mousedown", (ev) => ev.stopPropagation());
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mermaid-ctx-item";
    btn.textContent = item.label;
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeCtxMenu();
      item.action();
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
}

/** 锚点拖到空白：用图形按钮选择新建矩形/菱形 */
function openShapePickMenu(
  x: number,
  y: number,
  onPick: (shape: NodeShape) => void,
) {
  closeCtxMenu();
  const menu = document.createElement("div");
  menu.className = "mermaid-shape-pick";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "选择节点形状");
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.addEventListener("mousedown", (ev) => ev.stopPropagation());

  const mk = (shape: NodeShape, title: string) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mermaid-shape-pick-btn";
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.setAttribute("role", "menuitem");
    btn.innerHTML = shapeIconSvg(shape);
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeCtxMenu();
      onPick(shape);
    });
    return btn;
  };

  menu.append(
    mk("rect", "新建矩形并连线"),
    mk("diamond", "新建菱形并连线"),
  );
  document.body.appendChild(menu);
}

function addNodeOfShape(host: HTMLElement, shape: NodeShape) {
  const fallback = readMermaidSource(host, "");
  const parentFromSel =
    selectedFlowNode?.host === host
      ? resolveSourceNodeId(fallback, selectedFlowNode.nodeId) ||
        selectedFlowNode.nodeId
      : null;
  const parentId =
    parentFromSel && collectNodeIds(fallback).includes(parentFromSel)
      ? parentFromSel
      : null;

  applySource(host, fallback, (src) => {
    const id = nextNodeId(src);
    let next = insertNode(src, id, "新节点", shape);
    // 优先接到当前选中节点；否则接到最后一个，避免孤立节点不显示
    const existing = collectNodeIds(src);
    const last = existing.length > 0 ? existing[existing.length - 1]! : null;
    const from =
      parentId && existing.includes(parentId)
        ? parentId
        : last && last !== id
          ? last
          : null;
    if (from && from !== id) {
      next = insertEdge(next, from, id);
    }
    return next;
  });

  // 刷新后保持父节点选中，便于连续添加多个子节点
  if (parentId && selectedFlowNode?.host === host) {
    selectedFlowNode = {
      host,
      root:
        host.querySelector<HTMLElement>(".mermaid-preview-root") ||
        selectedFlowNode.root,
      nodeId: parentId,
    };
    scheduleDecoratePorts(selectedFlowNode.root);
  }
}

function shapeIconSvg(shape: NodeShape): string {
  if (shape === "diamond") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><polygon points="12,2 22,12 12,22 2,12" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="1" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
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

  const mkShape = (shape: NodeShape, title: string) => {
    // 用 div：Milkdown 预览 sanitize 可能剥掉 button / draggable
    const b = document.createElement("div");
    b.className = "mermaid-edit-btn mermaid-shape-btn";
    b.dataset.mmdAction = shape === "rect" ? "add-rect" : "add-diamond";
    b.dataset.mmdShape = shape;
    b.title = title;
    b.setAttribute("role", "button");
    b.setAttribute("tabindex", "0");
    b.setAttribute("aria-label", title);
    b.innerHTML = shapeIconSvg(shape);
    return b;
  };

  bar.append(
    mkShape("rect", "添加矩形子节点（先单击选中父节点）"),
    mkShape("diamond", "添加菱形子节点（先单击选中父节点）"),
  );
  return bar;
}

type MmdWindow = Window & {
  __lumenMmdEditAbort?: AbortController;
  __lumenMmdPortObs?: MutationObserver;
};

function setMermaidEditing(host: HTMLElement, on: boolean) {
  host.classList.toggle("mermaid-editing", on);
  if (!on) {
    clearPorts();
    closeCtxMenu();
    if (selectedFlowNode?.host === host) {
      clearSelectedHighlight(selectedFlowNode.root);
      selectedFlowNode = null;
    }
  }
}

function ensurePortObserver() {
  const w = window as MmdWindow;
  if (w.__lumenMmdPortObs) return;
  let timer: number | null = null;
  const obs = new MutationObserver(() => {
    if (timer != null) return;
    timer = window.setTimeout(() => {
      timer = null;
      document
        .querySelectorAll<HTMLElement>(".mermaid-preview-root")
        .forEach((root) => {
          if (!root.querySelector(".mermaid-svg-port")) {
            decorateMermaidSvgPorts(root);
          }
        });
    }, 40);
  });
  obs.observe(document.body, { childList: true, subtree: true });
  w.__lumenMmdPortObs = obs;
}

function ensureEditDelegation() {
  // Vite HMR 会重跑模块：必须先卸旧监听，否则一次松手会创建多个节点
  const w = window as MmdWindow;
  w.__lumenMmdEditAbort?.abort();
  const ac = new AbortController();
  w.__lumenMmdEditAbort = ac;
  const cap: AddEventListenerOptions = { capture: true, signal: ac.signal };
  ensurePortObserver();
  dragLink = null;
  clearPorts();
  document
    .querySelectorAll(".mermaid-drag-overlay")
    .forEach((el) => el.remove());
  scheduleDecoratePorts();

  document.addEventListener(
    "mousedown",
    (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;

      // 菜单/改名框/锚点在 body 上：先放行，勿拆掉正在操作的浮层
      if (isMermaidFloatingUi(target)) {
        if (!target.closest(".mermaid-ctx-menu, .mermaid-shape-pick")) {
          closeCtxMenu();
        }
        return;
      }

      if (!target.closest(".mermaid-ctx-menu, .mermaid-shape-pick")) {
        closeCtxMenu();
      }
      if (!target.closest(".mermaid-rename-pop")) {
        document
          .querySelectorAll(".mermaid-rename-pop")
          .forEach((el) => el.remove());
      }

      const zoomBtn = target.closest('[data-mmd-action="zoom"]');
      if (zoomBtn instanceof HTMLElement) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (target.closest(".mermaid-lightbox")) {
        if (!target.closest(".mermaid-lightbox-close")) {
          ev.stopPropagation();
        }
        return;
      }

      const inside = target.closest(".milkdown-code-block.mermaid-editing");
      document
        .querySelectorAll<HTMLElement>(".milkdown-code-block.mermaid-editing")
        .forEach((host) => {
          if (inside !== host && !host.contains(target)) {
            setMermaidEditing(host, false);
          }
        });
    },
    cap,
  );

  document.addEventListener(
    "click",
    (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;

      if (target.closest(".mermaid-lightbox-close")) {
        ev.preventDefault();
        ev.stopPropagation();
        closeMermaidLightbox();
        return;
      }
      if (target.closest(".mermaid-lightbox")) {
        ev.stopPropagation();
        return;
      }
      if (target.closest(".mermaid-ctx-menu")) return;
      if (target.closest(".mermaid-port")) return;

      const root = target.closest(".mermaid-preview-root");
      if (!(root instanceof HTMLElement)) return;
      const host = findCodeBlockHost(root);
      if (!host) return;

      const actionBtn = target.closest(
        "[data-mmd-action]",
      ) as HTMLElement | null;
      if (
        actionBtn &&
        root.contains(actionBtn) &&
        actionBtn.dataset.mmdAction === "zoom"
      ) {
        ev.preventDefault();
        ev.stopPropagation();
        openMermaidLightbox(host, root);
        return;
      }

      setMermaidEditing(host, true);

      if (actionBtn && root.contains(actionBtn)) {
        const action = actionBtn.dataset.mmdAction || "";
        if (action === "add-rect" || action === "add-diamond") {
          ev.preventDefault();
          ev.stopPropagation();
          addNodeOfShape(host, action === "add-diamond" ? "diamond" : "rect");
          return;
        }
      }

      // 单击节点：选中为父节点，供工具栏添加子节点
      if (target.closest(".mermaid-svg-port")) return;
      if (!rootIsFlowchart(root, host)) return;
      const hit = resolveNodeAtEvent(root, ev, target);
      if (hit) {
        ev.preventDefault();
        ev.stopPropagation();
        setSelectedFlowNode(host, root, hit.nodeId);
        return;
      }
      if (target.closest(".mermaid-preview")) {
        setSelectedFlowNode(host, root, null);
      }
    },
    cap,
  );

  document.addEventListener(
    "dblclick",
    (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".mermaid-lightbox")) return;
      if (target.closest(".mermaid-rename-pop, .mermaid-ctx-menu")) return;
      const root =
        target.closest(".mermaid-preview-root") ||
        findPreviewRootAt(ev.clientX, ev.clientY);
      if (!(root instanceof HTMLElement)) return;
      const host = findCodeBlockHost(root);
      if (!host) return;
      if (!rootIsFlowchart(root, host)) return;
      const hit = resolveNodeAtEvent(root, ev, target);
      if (!hit) return;
      ev.preventDefault();
      ev.stopPropagation();
      setMermaidEditing(host, true);
      promptRename(host, hit.nodeEl, hit.nodeId);
    },
    cap,
  );

  document.addEventListener(
    "contextmenu",
    (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".mermaid-lightbox")) return;
      if (target.closest(".mermaid-rename-pop, .mermaid-ctx-menu")) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      const root =
        target.closest(".mermaid-preview-root") ||
        findPreviewRootAt(ev.clientX, ev.clientY);
      if (!(root instanceof HTMLElement)) return;
      const host = findCodeBlockHost(root);
      if (!host) return;
      if (!rootIsFlowchart(root, host)) return;
      setMermaidEditing(host, true);

      const hit = resolveNodeAtEvent(root, ev, target);
      if (hit) {
        const { nodeEl, nodeId } = hit;
        ev.preventDefault();
        ev.stopPropagation();
        const labelHint =
          nodeEl
            .querySelector(".nodeLabel, .label, foreignObject")
            ?.textContent?.trim() || "";
        const srcId = () => {
          const src = readMermaidSource(host, "");
          return resolveSourceNodeId(src, nodeId, labelHint) || nodeId;
        };
        openCtxMenu(ev.clientX, ev.clientY, [
          {
            label: "修改文案",
            action: () => promptRename(host, nodeEl, nodeId),
          },
          {
            label: "设为矩形",
            action: () =>
              applySource(host, readMermaidSource(host, ""), (src) =>
                setNodeShape(src, srcId(), "rect"),
              ),
          },
          {
            label: "设为菱形",
            action: () =>
              applySource(host, readMermaidSource(host, ""), (src) =>
                setNodeShape(src, srcId(), "diamond"),
              ),
          },
          {
            label: "删除节点",
            action: () =>
              applySource(host, readMermaidSource(host, ""), (src) =>
                removeNode(src, srcId()),
              ),
          },
        ]);
        return;
      }

      const edgeEnds = parseSvgEdgeEndpoints(target);
      if (edgeEnds && target.closest(".mermaid-preview")) {
        ev.preventDefault();
        ev.stopPropagation();
        openCtxMenu(ev.clientX, ev.clientY, [
          {
            label: "删除连线",
            action: () =>
              applySource(host, readMermaidSource(host, ""), (src) =>
                removeEdge(src, edgeEnds.from, edgeEnds.to),
              ),
          },
        ]);
        return;
      }

      if (
        target.closest(".mermaid-preview") ||
        pointInRect(
          (
            root.querySelector(".mermaid-preview") || root
          ).getBoundingClientRect(),
          ev.clientX,
          ev.clientY,
        )
      ) {
        ev.preventDefault();
        ev.stopPropagation();
        openCtxMenu(ev.clientX, ev.clientY, [
          {
            label: "方向 TB",
            action: () =>
              applySource(host, readMermaidSource(host, ""), (src) =>
                setFlowchartDirection(src, "TB"),
              ),
          },
          {
            label: "方向 LR",
            action: () =>
              applySource(host, readMermaidSource(host, ""), (src) =>
                setFlowchartDirection(src, "LR"),
              ),
          },
        ]);
      }
    },
    cap,
  );

  // 仅从 SVG 四向锚点拖线（悬停节点时由 CSS 显示）
  document.addEventListener(
    "mousedown",
    (ev) => {
      if (ev.button !== 0) return;
      const target = ev.target;
      if (!(target instanceof Element)) return;

      const port = target.closest<Element>(".mermaid-svg-port[data-mmd-port]");
      if (!port) return;
      const fromId = port.getAttribute("data-mmd-from");
      const root = port.closest(".mermaid-preview-root");
      if (!fromId || !(root instanceof HTMLElement)) return;
      const host = findCodeBlockHost(root);
      if (!host || !hostIsInteractive(host)) return;
      ev.preventDefault();
      ev.stopPropagation();
      beginDragLink(host, root, fromId, ev.clientX, ev.clientY);
    },
    cap,
  );

  document.addEventListener(
    "mousemove",
    (ev) => {
      const state = dragLink;
      if (!state) return;
      const dx = ev.clientX - state.startX;
      const dy = ev.clientY - state.startY;
      if (!state.dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        state.dragging = true;
        state.suppressClick = true;
        state.root.classList.add("mermaid-drag-linking");
        const { overlay, line } = ensureDragOverlay(state.root);
        state.overlay = overlay;
        state.line = line;
        const start = clientToRoot(state.root, state.startX, state.startY);
        line.setAttribute("x1", String(start.x));
        line.setAttribute("y1", String(start.y));
        line.setAttribute("x2", String(start.x));
        line.setAttribute("y2", String(start.y));
      }
      ev.preventDefault();
      if (state.overlay) placeDragOverlay(state.overlay, state.root);
      const end = clientToRoot(state.root, ev.clientX, ev.clientY);
      state.line?.setAttribute("x2", String(end.x));
      state.line?.setAttribute("y2", String(end.y));

      const hoverNode = findSvgNodeAtPoint(
        state.root,
        ev.clientX,
        ev.clientY,
        DROP_HIT_PAD_PX,
      );
      const src = readMermaidSource(state.host, "");
      const fromId =
        sourceIdFromSvgNode(src, null, state.fromId) || state.fromId;
      const hoverId = hoverNode ? sourceIdFromSvgNode(src, hoverNode) : null;
      const hoverOk =
        hoverNode && hoverId && hoverId !== fromId ? hoverNode : null;
      if (state.hoverEl !== hoverOk) {
        clearDragHover(state);
        if (hoverOk) {
          hoverOk.classList.add("mermaid-link-hover");
          state.hoverEl = hoverOk;
        }
      }
    },
    cap,
  );

  document.addEventListener(
    "mouseup",
    (ev) => {
      if (!dragLink) return;
      const state = dragLink;
      const dragDist = Math.hypot(
        ev.clientX - state.startX,
        ev.clientY - state.startY,
      );

      const src = readMermaidSource(state.host, "");
      const fromId =
        sourceIdFromSvgNode(src, null, state.fromId) || state.fromId;

      // 用 bbox 命中目标节点（勿依赖 foreignObject 上的 closest）
      // 优先用拖动过程中的 hover 高亮节点，更稳
      let toEl =
        state.hoverEl && state.root.contains(state.hoverEl)
          ? state.hoverEl
          : findSvgNodeAtPoint(
              state.root,
              ev.clientX,
              ev.clientY,
              DROP_HIT_PAD_PX,
            );
      if (!toEl) {
        toEl = findSvgNodeAtPoint(state.root, ev.clientX, ev.clientY, 24);
      }

      const toId = toEl ? sourceIdFromSvgNode(src, toEl) : null;
      const onOther = !!toEl && !!toId && toId !== fromId;
      // 指针落在任一节点上（含起点/无法解析 id）→ 禁止当成空白新建
      const overAnyNode = !!toEl;
      const preview = state.root.querySelector(".mermaid-preview");
      const inPreview =
        !!preview &&
        pointInRect(preview.getBoundingClientRect(), ev.clientX, ev.clientY);
      const onBlank =
        !overAnyNode &&
        !onOther &&
        inPreview &&
        dragDist >= BLANK_CREATE_MIN_PX;

      endDragLink(
        onOther,
        onOther ? toEl : null,
        onBlank,
        ev.clientX,
        ev.clientY,
      );
      clearLinkHighlight(state.root);
    },
    cap,
  );

  document.addEventListener(
    "keydown",
    (ev) => {
      if (ev.key !== "Escape") return;
      if (document.querySelector(".mermaid-lightbox")) {
        ev.preventDefault();
        return;
      }
      if (
        document.querySelector(".mermaid-ctx-menu, .mermaid-shape-pick")
      ) {
        closeCtxMenu();
        ev.preventDefault();
        return;
      }
      const renamePop = document.querySelector(".mermaid-rename-pop");
      if (renamePop) {
        renamePop.remove();
        ev.preventDefault();
        return;
      }
      if (dragLink) {
        const root = dragLink.root;
        endDragLink(false, null, false);
        clearLinkHighlight(root);
        ev.preventDefault();
        return;
      }
      const host = document.querySelector<HTMLElement>(
        ".milkdown-code-block.mermaid-editing, .milkdown-code-block.selected",
      );
      if (!host) return;
      setMermaidEditing(host, false);
    },
    cap,
  );
}

function closeMermaidLightbox() {
  document.querySelectorAll(".mermaid-lightbox").forEach((el) => el.remove());
}

const LB_SCALE_MIN = 0.4;
const LB_SCALE_MAX = 6;

function attachLightboxPanZoom(stage: HTMLElement, canvas: HTMLElement) {
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let baseW = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  const applySize = () => {
    const svg = canvas.querySelector("svg");
    if (!svg || !(baseW > 0)) return;
    svg.style.width = `${baseW * scale}px`;
    svg.style.height = "auto";
    svg.style.maxWidth = "none";
    svg.style.maxHeight = "none";
  };

  const apply = () => {
    applySize();
    canvas.style.transform = `translate(${tx}px, ${ty}px)`;
  };

  const centerContent = () => {
    const svg = canvas.querySelector("svg");
    if (svg) {
      const w =
        parseFloat(svg.style.width) ||
        svg.getBoundingClientRect().width ||
        0;
      if (w > 0) baseW = w / (scale || 1);
    }
    scale = 1;
    applySize();
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const cw = canvas.offsetWidth || canvas.getBoundingClientRect().width;
    const ch = canvas.offsetHeight || canvas.getBoundingClientRect().height;
    tx = (sw - cw) / 2;
    ty = (sh - ch) / 2;
    apply();
  };

  apply();

  stage.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      if (!(baseW > 0)) return;
      const mx = stage.clientWidth / 2;
      const my = stage.clientHeight / 2;
      const cx = (mx - tx) / scale;
      const cy = (my - ty) / scale;
      const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      const next = Math.min(
        LB_SCALE_MAX,
        Math.max(LB_SCALE_MIN, scale * factor),
      );
      if (next === scale) return;
      scale = next;
      applySize();
      tx = mx - cx * scale;
      ty = my - cy * scale;
      canvas.style.transform = `translate(${tx}px, ${ty}px)`;
    },
    { passive: false },
  );

  stage.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    dragging = true;
    lastX = ev.clientX;
    lastY = ev.clientY;
    stage.classList.add("is-panning");
    stage.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });

  stage.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    tx += ev.clientX - lastX;
    ty += ev.clientY - lastY;
    lastX = ev.clientX;
    lastY = ev.clientY;
    canvas.style.transform = `translate(${tx}px, ${ty}px)`;
  });

  const endPan = (ev: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    stage.classList.remove("is-panning");
    try {
      stage.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
  };
  stage.addEventListener("pointerup", endPan);
  stage.addEventListener("pointercancel", endPan);

  return { centerContent };
}

function openMermaidLightbox(host: HTMLElement, root: HTMLElement) {
  closeMermaidLightbox();
  const existingSvg = root.querySelector(".mermaid-preview svg");
  const fallback = readMermaidSource(host, "");
  const code = prepareMermaidSource(fallback);

  const overlay = document.createElement("div");
  overlay.className = "mermaid-lightbox";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "流程图放大查看");

  const panel = document.createElement("div");
  panel.className = "mermaid-lightbox-panel";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "mermaid-lightbox-close";
  closeBtn.setAttribute("aria-label", "关闭");
  closeBtn.textContent = "×";

  const body = document.createElement("div");
  body.className = "mermaid-lightbox-body";

  const stage = document.createElement("div");
  stage.className = "mermaid-lightbox-stage";

  const canvas = document.createElement("div");
  canvas.className = "mermaid-lightbox-canvas";
  canvas.textContent = "正在渲染…";

  stage.append(canvas);
  body.append(stage);
  panel.append(closeBtn, body);
  overlay.append(panel);
  document.body.append(overlay);

  const { centerContent } = attachLightboxPanZoom(stage, canvas);

  const showSvg = (svgHtml: string) => {
    canvas.innerHTML = svgHtml;
    const svg = canvas.querySelector("svg");
    if (svg) {
      const stageW = Math.max(stage.clientWidth || 800, 320);
      const stageH = Math.max(stage.clientHeight || 480, 240);
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      svg.style.display = "block";
      svg.style.width = `${Math.min(stageW * 0.92, 1000)}px`;
      svg.style.height = "auto";
      svg.style.maxWidth = "none";
      svg.style.maxHeight = `${Math.min(stageH * 0.92, 860)}px`;
    }
    requestAnimationFrame(() => {
      centerContent();
      requestAnimationFrame(() => centerContent());
    });
  };

  if (existingSvg) {
    showSvg(existingSvg.outerHTML);
  } else if (!code) {
    canvas.textContent = "无可显示的流程图";
  }

  if (code) {
    ensureMermaid();
    const id = `mmd-lb-${Math.random().toString(36).slice(2, 10)}`;
    void mermaid
      .render(id, code)
      .then(({ svg }) => {
        if (!document.body.contains(overlay)) return;
        showSvg(svg);
      })
      .catch((e) => {
        if (!document.body.contains(overlay)) return;
        if (!canvas.querySelector("svg")) {
          canvas.textContent = String(
            e instanceof Error ? e.message : "流程图渲染失败",
          );
        }
      });
  }
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
      if (isFlowchartSource(code)) root.dataset.mmdFlow = "1";

      const toolbar = buildToolbarMarkup(code);
      const zoomBtn = document.createElement("button");
      zoomBtn.type = "button";
      zoomBtn.className = "mermaid-zoom-btn";
      zoomBtn.dataset.mmdAction = "zoom";
      zoomBtn.title = "放大查看";
      zoomBtn.setAttribute("aria-label", "放大查看");
      zoomBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5"/><path d="M15 4h5v5"/><path d="M20 15v5h-5"/><path d="M9 20H4v-5"/></svg>`;

      const preview = document.createElement("div");
      preview.className = "mermaid-preview";
      preview.innerHTML = svg;

      root.append(toolbar, zoomBtn, preview);
      if (isFlowchartSource(code)) {
        decorateMermaidSvgPorts(root);
      }
      applyPreview(root);
      // Milkdown sanitize 进 DOM 后需再装饰一次
      scheduleDecoratePorts();
    })
    .catch((e) => {
      const err = document.createElement("pre");
      err.className = "mermaid-error";
      err.textContent = String(e instanceof Error ? e.message : e);
      applyPreview(err);
    });
  return undefined;
}

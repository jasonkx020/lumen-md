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
      // 放大按钮：只拦选中，打开放到 click（避免 mousedown 打开后 overlay 吃掉同一次 click 立刻关闭）
      const zoomBtn = target.closest('[data-mmd-action="zoom"]');
      if (zoomBtn instanceof HTMLElement) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      // 灯箱内按下：不传给编辑器
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
    true,
  );

  document.addEventListener(
    "click",
    (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;

      // 仅关闭按钮可关灯箱（遮罩 / 内容区点击不关）
      if (target.closest(".mermaid-lightbox-close")) {
        ev.preventDefault();
        ev.stopPropagation();
        closeMermaidLightbox();
        return;
      }
      // 灯箱内其它点击：吞掉，避免误触编辑器
      if (target.closest(".mermaid-lightbox")) {
        ev.stopPropagation();
        return;
      }

      const root = target.closest(".mermaid-preview-root");
      if (!(root instanceof HTMLElement)) return;
      const host = findCodeBlockHost(root);
      if (!host) return;

      const actionBtn = target.closest(
        "[data-mmd-action]",
      ) as HTMLElement | null;
      // 放大：不进入编辑态
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

      const wasEditing = host.classList.contains("mermaid-editing");
      // 点到图即进入编辑态（显示工具条）
      setMermaidEditing(host, true);

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
    // 灯箱打开时 Esc 不关闭（须点关闭按钮）；仅挡住编辑态 Esc
    if (document.querySelector(".mermaid-lightbox")) {
      ev.preventDefault();
      return;
    }
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

function closeMermaidLightbox() {
  document.querySelectorAll(".mermaid-lightbox").forEach((el) => el.remove());
}

const LB_SCALE_MIN = 0.4;
const LB_SCALE_MAX = 6;

function attachLightboxPanZoom(stage: HTMLElement, canvas: HTMLElement) {
  let scale = 1;
  let tx = 0;
  let ty = 0;
  /** scale=1 时 SVG 的显示宽度；用改 width 缩放，避免 transform:scale 栅格化发糊 */
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

  /** 在 showSvg 设好初始宽度后记录 baseW 并居中 */
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
      // 以当前视野中心为锚点，避免跟鼠标缩放导致画面跳动
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
      // 保留 viewBox，去掉固定尺寸，按舞台可用宽度适配
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

  // 再渲染一版，放大后更清晰
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

/** Mermaid flowchart 源码轻量编辑：读写 CodeMirror + 纯函数片段变换。 */

import { EditorView } from "@codemirror/view";

const NODE_EDGE_LEFT_RE = /\b([A-Za-z][\w]*)\s*(?:-->|---|-\.-|==>|->>|-->>)/g;

/** 与 collectNodeIds 对齐；含历史 `-.-` 与标准 `-.->` */
const EDGE_OPS = "(?:-->|---|-.->|-\\.-|==>|->>|-->>)";

/** 匹配节点形状声明 open/body/close */
const NODE_SHAPE_CAP =
  "(\\[\\[|\\[\\(|\\[\\(\\(|\\(\\[|\\[|\\{|\\(\\(|\\()([^\\n]*?)(\\]\\]|\\)\\]|\\]\\)|\\]|\\}|\\)\\)|\\))";

export type NodeShape = "rect" | "diamond";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeNodeLabel(label: string): string {
  return label
    .replace(/"/g, "＂")
    .replace(/\[/g, "［")
    .replace(/\]/g, "］")
    .replace(/\{/g, "｛")
    .replace(/\}/g, "｝");
}

function nodeDeclRe(id: string): RegExp {
  return new RegExp(`\\b(${escapeRe(id)})\\s*${NODE_SHAPE_CAP}`, "g");
}

export function isFlowchartSource(source: string): boolean {
  const first = source
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return !!first && /^(flowchart|graph)\b/i.test(first);
}

/** 收集源码中出现过的节点 ID。 */
export function collectNodeIds(source: string): string[] {
  const ids = new Set<string>();
  for (const m of source.matchAll(NODE_EDGE_LEFT_RE)) {
    ids.add(m[1]!);
  }
  for (const m of source.matchAll(
    /\b([A-Za-z][\w]*)\s*(?:\[\[|\[\(|\[\(\(|\(\[|\[|\{|\(\(|\()/g,
  )) {
    ids.add(m[1]!);
  }
  for (const m of source.matchAll(
    /(?:-->|---|-\.-|==>|->>|-->>)\s*([A-Za-z][\w]*)/g,
  )) {
    ids.add(m[1]!);
  }
  return [...ids];
}

export function nextNodeId(source: string): string {
  const used = new Set(collectNodeIds(source));
  let n = 1;
  while (used.has(`N${n}`)) n += 1;
  return `N${n}`;
}

function nextSubgraphId(source: string): string {
  let n = 1;
  while (new RegExp(`\\bsubgraph\\s+S${n}\\b`).test(source)) n += 1;
  return `S${n}`;
}

/** 在文件末尾追加一行（保证末尾换行）。 */
function appendLine(source: string, line: string): string {
  const base = source.replace(/\s*$/, "");
  return `${base}\n${line}\n`;
}

export function insertNode(
  source: string,
  id: string,
  label = "新节点",
  shape: NodeShape = "rect",
): string {
  const safe = escapeNodeLabel(label);
  const decl =
    shape === "diamond" ? `  ${id}{"${safe}"}` : `  ${id}["${safe}"]`;
  return appendLine(source, decl);
}

/** 读取节点当前标签；无声明则返回 id。 */
export function getNodeLabel(source: string, id: string): string {
  const re = nodeDeclRe(id);
  const m = re.exec(source);
  if (!m) return id;
  const body = (m[3] ?? "").trim();
  const unquoted = /^"(.*)"$/.exec(body);
  return unquoted ? unquoted[1]! : body || id;
}

/** 改节点形状，尽量保留标签。 */
export function setNodeShape(
  source: string,
  id: string,
  shape: NodeShape,
): string {
  if (!id) return source;
  const label = getNodeLabel(source, id);
  const safe = escapeNodeLabel(label);
  const nextDecl =
    shape === "diamond" ? `${id}{"${safe}"}` : `${id}["${safe}"]`;
  const re = nodeDeclRe(id);
  if (re.test(source)) {
    re.lastIndex = 0;
    return source.replace(re, nextDecl);
  }
  return appendLine(source, `  ${nextDecl}`);
}

export function insertEdge(source: string, from: string, to: string): string {
  if (!from || !to || from === to) return source;
  const fromId = resolveSourceNodeId(source, from) || from;
  const toId = resolveSourceNodeId(source, to) || to;
  if (fromId === toId) return source;
  const edge = `  ${fromId} --> ${toId}`;
  const exists = new RegExp(
    `\\b${escapeRe(fromId)}\\s*${EDGE_OPS}\\s*${escapeRe(toId)}\\b`,
  ).test(source);
  if (exists || source.includes(`${fromId} --> ${toId}`)) return source;
  return appendLine(source, edge);
}

/** 删除 from→to 的边（匹配常见箭头语法）；不存在则原样返回。 */
export function removeEdge(source: string, from: string, to: string): string {
  if (!from || !to || from === to) return source;
  const re = new RegExp(
    `^[ \\t]*${escapeRe(from)}\\s*${EDGE_OPS}\\s*${escapeRe(to)}\\b[^\\n]*\\r?\\n?`,
    "gm",
  );
  const next = source.replace(re, "");
  return next === source ? source : next;
}

/** 行首节点记号：`ID` 或 `ID[标签]` / `ID{x}` 等 */
const LINE_NODE_TOKEN = new RegExp(
  `^([A-Za-z][\\w]*)(\\s*${NODE_SHAPE_CAP})?`,
);

/**
 * 删除节点声明及所有以该 id 为端点的边。
 * 支持默认模板这种同行写法：`A[开始] --> B[结束]`（删一侧时保留另一侧声明）。
 */
export function removeNode(source: string, id: string): string {
  if (!id) return source;
  const opRe = new RegExp(`^\\s*(${EDGE_OPS})\\s*`);
  // 形状体内禁止 ] } )，避免把 `A[x] --> B[y]` 整行误判成 A 的声明
  const tightShape =
    "(?:\\[\\[[^\\]\\n]*\\]\\]|\\[[^\\]\\n]*\\]|\\{[^{}\\n]*\\}|\\(\\([^)\\n]*\\)\\)|\\([^)\\n]*\\))";
  const pureDecl = new RegExp(`^${escapeRe(id)}(?:\\s*${tightShape})?\\s*$`);
  const lines = source.split(/\r?\n/);
  const out: string[] = [];

  for (const line of lines) {
    const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
    const rest = line.slice(indent.length);
    const trimmed = rest.trim();

    const leftM = LINE_NODE_TOKEN.exec(rest);
    if (leftM) {
      const leftId = leftM[1]!;
      const leftTok = leftM[0];
      const afterLeft = rest.slice(leftTok.length);
      const opM = opRe.exec(afterLeft);
      if (opM) {
        const afterOp = afterLeft.slice(opM[0].length);
        const rightM = LINE_NODE_TOKEN.exec(afterOp);
        if (rightM) {
          const rightId = rightM[1]!;
          const rightTok = rightM[0];
          // 本行是边
          if (leftId !== id && rightId !== id) {
            out.push(line);
            continue;
          }
          if (leftId === id && rightId === id) continue; // 自环
          // 删边；另一端若在本行带形状，保留为独立声明
          if (leftId === id) {
            if (rightTok.length > rightId.length) {
              out.push(`${indent}${rightTok}`);
            }
            continue;
          }
          if (leftTok.length > leftId.length) {
            out.push(`${indent}${leftTok}`);
          }
          continue;
        }
      }
    }

    // 单独的节点声明 / 子图成员裸 id（放在边解析之后）
    if (pureDecl.test(trimmed)) continue;

    out.push(line);
  }

  const joined = out.join("\n");
  const cleaned = joined.replace(/\n{3,}/g, "\n\n");
  return cleaned === source ? source : cleaned;
}

/**
 * 添加子图。空子图在 Mermaid 里常导致原节点“消失”，因此会把成员节点写进子图：
 * - 传入 wrapNodeIds：仅这些已存在的 id
 * - 未传 / 无效：纳入当前源码中全部节点
 * - 图中尚无节点：放一个占位节点，避免空 subgraph
 */
export function insertSubgraph(
  source: string,
  wrapNodeIds?: string[],
): string {
  const sid = nextSubgraphId(source);
  const existing = collectNodeIds(source);
  let members = (wrapNodeIds ?? []).filter((id) => existing.includes(id));
  if (members.length === 0) {
    members = existing;
  }
  const body =
    members.length > 0
      ? members.map((id) => `    ${id}`).join("\n")
      : `    ${sid}_n["子图节点"]`;
  const block = `  subgraph ${sid} ["分组"]\n${body}\n  end`;
  return appendLine(source, block);
}

export function setFlowchartDirection(
  source: string,
  dir: "TB" | "LR",
): string {
  const lines = source.split(/\r?\n/);
  let changed = false;
  const next = lines.map((line) => {
    const m = /^(flowchart|graph)(\s+)(TB|BT|LR|RL|TD)(\b.*)$/i.exec(line);
    if (!m) return line;
    changed = true;
    return `${m[1]}${m[2]}${dir}${m[4]}`;
  });
  if (changed) return next.join("\n");
  for (let i = 0; i < next.length; i++) {
    const m = /^(flowchart|graph)(\s*)$/i.exec(next[i]!.trimEnd());
    if (m) {
      next[i] = `${m[1]} ${dir}`;
      return next.join("\n");
    }
    const m2 = /^(flowchart|graph)(\s+)(\S.*)$/i.exec(next[i]!);
    if (m2 && !/^(TB|BT|LR|RL|TD)\b/i.test(m2[3]!)) {
      next[i] = `${m2[1]} ${dir} ${m2[3]}`;
      return next.join("\n");
    }
  }
  return source;
}

function escapeLabelForShape(label: string, open: string): string {
  if (
    open.includes('"') ||
    open === "[" ||
    open === "[[" ||
    open.startsWith("[")
  ) {
    return label.replace(/"/g, "＂");
  }
  return label;
}

/**
 * 把 SVG/解析得到的 id 对齐到源码里真实存在的节点 id。
 * 避免改文案时写错 id 而「多出」一个新节点。
 */
export function resolveSourceNodeId(
  source: string,
  rawId: string,
  labelHint = "",
): string | null {
  if (!rawId && !labelHint) return null;
  const ids = collectNodeIds(source);
  if (rawId && ids.includes(rawId)) return rawId;

  // flowchart-A-12 / A-12 → A
  const stripped = rawId
    .replace(/^flowchart-/, "")
    .replace(/-\d+$/, "");
  if (stripped && ids.includes(stripped)) return stripped;

  const sorted = [...ids].sort((a, b) => b.length - a.length);
  for (const id of sorted) {
    if (
      rawId === id ||
      rawId.startsWith(`${id}-`) ||
      rawId.endsWith(`-${id}`) ||
      rawId.includes(`-${id}-`)
    ) {
      return id;
    }
  }

  const hint = labelHint.trim();
  if (hint) {
    for (const id of ids) {
      if (getNodeLabel(source, id) === hint) return id;
    }
  }
  return ids.includes(rawId) ? rawId : null;
}

/**
 * 重命名节点标签。匹配 `ID[...]` / `ID(...)` / `ID{...}` 及带引号变体。
 * 仅改已有声明；没有形状声明时，把该 id 在边里的首次出现写成带标签形式（不新增节点）。
 */
export function renameNodeLabel(
  source: string,
  id: string,
  newLabel: string,
): string {
  if (!id) return source;
  const resolved = resolveSourceNodeId(source, id) ?? id;
  const re = nodeDeclRe(resolved);
  let hit = false;
  const out = source.replace(re, (_full, nodeId, open, _old, close) => {
    hit = true;
    const body = escapeLabelForShape(newLabel, open);
    if (open === "[" || open === "[[") {
      return `${nodeId}${open === "[[" ? "[[" : "["}"${body.replace(/"/g, "＂")}"${open === "[[" ? "]]" : "]"}`;
    }
    if (open === "(" || open === "((") {
      return `${nodeId}${open}"${body.replace(/"/g, "＂")}"${close}`;
    }
    if (open === "{") {
      return `${nodeId}{"${body.replace(/"/g, "＂")}"${close}`;
    }
    return `${nodeId}${open}${body}${close}`;
  });
  if (hit) return out;

  // 边上的裸 id：A --> B  →  A["新"] --> B（同一节点，不追加新行）
  if (!collectNodeIds(source).includes(resolved)) return source;
  const safe = escapeNodeLabel(newLabel);
  const labeled = `${resolved}["${safe}"]`;
  const edgeLeft = new RegExp(`\\b${escapeRe(resolved)}(\\s*${EDGE_OPS})`);
  if (edgeLeft.test(source)) {
    return source.replace(edgeLeft, `${labeled}$1`);
  }
  const edgeRight = new RegExp(
    `(${EDGE_OPS}\\s*)${escapeRe(resolved)}\\b`,
  );
  if (edgeRight.test(source)) {
    return source.replace(edgeRight, `$1${labeled}`);
  }
  return source;
}

export function findCodeBlockHost(from: HTMLElement): HTMLElement | null {
  return from.closest(".milkdown-code-block");
}

export function readMermaidSource(
  host: HTMLElement,
  fallback = "",
): string {
  const cmRoot =
    host.querySelector<HTMLElement>(".cm-editor") ||
    host.querySelector<HTMLElement>(".codemirror-host");
  if (cmRoot) {
    const view = EditorView.findFromDOM(cmRoot);
    if (view) return view.state.doc.toString();
  }
  return fallback;
}

export function writeMermaidSource(host: HTMLElement, text: string): boolean {
  const cmRoot =
    host.querySelector<HTMLElement>(".cm-editor") ||
    host.querySelector<HTMLElement>(".codemirror-host");
  if (!cmRoot) return false;
  const view = EditorView.findFromDOM(cmRoot);
  if (!view) return false;
  const len = view.state.doc.length;
  view.dispatch({
    changes: { from: 0, to: len, insert: text },
  });
  return true;
}

/** 判断是否为 flowchart 节点 g（兼容 `node` / `flowchart-node`）。 */
export function isSvgFlowNode(el: Element): boolean {
  const tag = el.tagName?.toLowerCase?.();
  if (tag && tag !== "g") return false;
  const cls = el.getAttribute("class") || "";
  if (/\b(cluster|edgePath|edgeLabel|label-container)\b/.test(cls)) {
    return false;
  }
  if (/\bflowchart-node\b/.test(cls)) return true;
  if (/\bnode\b/.test(cls) && !/\bedge\b/.test(cls)) return true;
  const idAttr = el.getAttribute("id") || "";
  return (
    /^flowchart-/.test(idAttr) &&
    !/(edge|label|cluster|root)/i.test(idAttr)
  );
}

function extractFlowchartIdFromAttrs(el: Element): string | null {
  const stamped = el.getAttribute("data-mmd-id");
  if (stamped) return stamped;

  const idAttr = el.getAttribute("id") || "";
  // flowchart-A-12 / flowchart-N1-3
  let m = /^flowchart-([A-Za-z][\w]*)-\d+$/.exec(idAttr);
  if (m) return m[1]!;
  m = /^flowchart-([A-Za-z][\w]*)$/.exec(idAttr);
  if (m && m[1] !== "node") return m[1]!;
  // 编码后的 id：flowchart-xxx-12
  m = /^flowchart-(.+)-(\d+)$/.exec(idAttr);
  if (m && m[1] && m[1] !== "node") return m[1]!;
  // 无前缀的裸 id（少数主题）
  if (/^[A-Za-z][\w]*$/.test(idAttr)) return idAttr;

  const cls = el.getAttribute("class") || "";
  for (const part of cls.split(/\s+/)) {
    if (
      !part ||
      part === "node" ||
      part === "default" ||
      part === "flowchart-node" ||
      part === "label-container"
    ) {
      continue;
    }
    m = /^flowchart-([A-Za-z][\w]*)$/.exec(part);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * 从 Mermaid SVG 节点元素解析 flowchart 节点 ID。
 * 典型 id：`flowchart-A-123` / `flowchart-N1-xxx`
 */
export function parseSvgNodeId(el: Element): string | null {
  const stamped = el.closest?.("[data-mmd-id]")?.getAttribute("data-mmd-id");
  if (stamped) return stamped;

  let target: Element = el;
  if (!isSvgFlowNode(el)) {
    let cur: Element | null = el.parentElement;
    while (cur) {
      if (isSvgFlowNode(cur)) {
        target = cur;
        break;
      }
      cur = cur.parentElement;
    }
  }
  return extractFlowchartIdFromAttrs(target);
}

export function findSvgNodeElement(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  let cur: Element | null = target;
  // 含 foreignObject 内 HTML：沿 parentElement 上溯（比 closest 更稳）
  for (let i = 0; i < 24 && cur; i++) {
    if (isSvgFlowNode(cur)) return cur;
    cur = cur.parentElement;
  }
  const g = target.closest("g.node, g[class*='flowchart-node'], g[id^='flowchart-']");
  if (g && isSvgFlowNode(g)) return g;
  return null;
}

/** 在预览根内按坐标命中节点（不依赖 event.target / foreignObject）。 */
export function findSvgNodeAtPoint(
  root: ParentNode,
  clientX: number,
  clientY: number,
  pad = 0,
): Element | null {
  let best: Element | null = null;
  let bestArea = Infinity;
  const nodes = Array.from(
    root.querySelectorAll(
      "g.node, g[class*='flowchart-node'], g[id^='flowchart-']",
    ),
  );
  for (const n of nodes) {
    if (!isSvgFlowNode(n)) continue;
    if (!parseSvgNodeId(n)) continue;
    const r = n.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (
      clientX >= r.left - pad &&
      clientX <= r.right + pad &&
      clientY >= r.top - pad &&
      clientY <= r.bottom + pad
    ) {
      const area = r.width * r.height;
      if (area < bestArea) {
        bestArea = area;
        best = n;
      }
    }
  }
  return best;
}

/** 从 Mermaid 边 path id 解析两端，如 `L-A-B-0`。 */
export function parseSvgEdgeEndpoints(
  el: Element,
): { from: string; to: string } | null {
  let cur: Element | null = el;
  for (let i = 0; i < 6 && cur; i++) {
    const idAttr = cur.getAttribute("id") || "";
    let m = /^L-([A-Za-z][\w]*)-([A-Za-z][\w]*)(?:-|$)/.exec(idAttr);
    if (m) return { from: m[1]!, to: m[2]! };
    m = /^(?:flowchart-)?LS-([A-Za-z][\w]*)-([A-Za-z][\w]*)(?:-|$)/.exec(
      idAttr,
    );
    if (m) return { from: m[1]!, to: m[2]! };
    const cls = cur.getAttribute("class") || "";
    m = /\bLS-([A-Za-z][\w]*)-([A-Za-z][\w]*)\b/.exec(cls);
    if (m) return { from: m[1]!, to: m[2]! };
    cur = cur.parentElement;
  }
  return null;
}

/** Mermaid flowchart 源码轻量编辑：读写 CodeMirror + 纯函数片段变换。 */

import { EditorView } from "@codemirror/view";

const NODE_EDGE_LEFT_RE = /\b([A-Za-z][\w]*)\s*(?:-->|---|-\.-|==>|->>|-->>)/g;

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
  // 边的右侧 ID：A --> B
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
): string {
  const safe = label.replace(/]/g, "＂").replace(/\[/g, "［").replace(/\]/g, "］");
  return appendLine(source, `  ${id}["${safe}"]`);
}

export function insertEdge(source: string, from: string, to: string): string {
  if (!from || !to || from === to) return source;
  const edge = `  ${from} --> ${to}`;
  if (source.includes(`${from} --> ${to}`)) return source;
  return appendLine(source, edge);
}

export function insertSubgraph(source: string): string {
  const sid = nextSubgraphId(source);
  const block = `  subgraph ${sid} ["分组"]\n    \n  end`;
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
  // 无方向时在首个 flowchart/graph 行补上
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
  if (open.includes('"') || open === "[" || open === "[[" || open.startsWith("[")) {
    return label.replace(/"/g, "＂");
  }
  return label;
}

/**
 * 重命名节点标签。匹配 `ID[...]` / `ID(...)` / `ID{...}` 及带引号变体。
 */
export function renameNodeLabel(
  source: string,
  id: string,
  newLabel: string,
): string {
  const idRe = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `\\b(${idRe})\\s*(\\[\\[|\\[\\(|\\[\\(\\(|\\(\\[|\\[|\\{|\\(\\(|\\()([^\\n]*?)(\\]\\]|\\)\\]|\\]\\)|\\]|\\}|\\)\\)|\\))`,
    "g",
  );
  let hit = false;
  const out = source.replace(re, (_full, nodeId, open, _old, close) => {
    hit = true;
    const body = escapeLabelForShape(newLabel, open);
    // 统一写成 ["label"] / ("label") 更稳
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
  return hit ? out : source;
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

/**
 * 从 Mermaid SVG 节点元素解析 flowchart 节点 ID。
 * 典型 id：`flowchart-A-123` / `flowchart-N1-xxx`
 */
export function parseSvgNodeId(el: Element): string | null {
  const g = el.closest("g.node");
  const target = g ?? el;
  const idAttr = target.getAttribute("id") || "";
  // flowchart-ID-number 或 flowchart-ID
  let m = /^flowchart-([A-Za-z][\w]*)(?:-|$)/.exec(idAttr);
  if (m) return m[1]!;
  m = /^flowchart-([A-Za-z][\w]*)-/.exec(idAttr);
  if (m) return m[1]!;
  // class 里偶尔带
  const cls = target.getAttribute("class") || "";
  m = /\bflowchart-([A-Za-z][\w]*)\b/.exec(cls);
  if (m) return m[1]!;
  return null;
}

export function findSvgNodeElement(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest("g.node");
}

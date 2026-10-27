/**
 * Mermaid 轻量编辑纯函数自检（无需 DOM / CodeMirror）。
 */
import {
  collectNodeIds,
  insertEdge,
  insertNode,
  insertSubgraph,
  isFlowchartSource,
  nextNodeId,
  parseSvgNodeId,
  removeEdge,
  removeNode,
  renameNodeLabel,
  setFlowchartDirection,
  setNodeShape,
} from "./mermaidEdit";

export function runMermaidEditSelfCheck(): string[] {
  const errors: string[] = [];

  if (!isFlowchartSource("flowchart TB\nA-->B")) {
    errors.push("isFlowchartSource flowchart");
  }
  if (!isFlowchartSource("graph LR\nA-->B")) {
    errors.push("isFlowchartSource graph");
  }
  if (isFlowchartSource("sequenceDiagram\nA->>B: hi")) {
    errors.push("isFlowchartSource should reject sequence");
  }

  const base = "flowchart TB\n  A[开始] --> B[结束]\n";
  const ids = collectNodeIds(base);
  if (!ids.includes("A") || !ids.includes("B")) {
    errors.push(`collectNodeIds missing A/B: ${ids.join(",")}`);
  }

  if (nextNodeId(base) !== "N1") {
    errors.push(`nextNodeId expected N1 got ${nextNodeId(base)}`);
  }
  if (nextNodeId(base + "  N1[x]\n  N2[y]\n") !== "N3") {
    errors.push("nextNodeId should skip N1/N2");
  }

  const withNode = insertNode(base, "N1", "新节点");
  if (!withNode.includes('N1["新节点"]')) {
    errors.push("insertNode missing declaration");
  }
  const diamond = insertNode(base, "D1", "判断", "diamond");
  if (!diamond.includes('D1{"判断"}')) {
    errors.push(`insertNode diamond: ${diamond}`);
  }

  const shaped = setNodeShape(withNode, "N1", "diamond");
  if (!shaped.includes('N1{"新节点"}')) {
    errors.push(`setNodeShape diamond: ${shaped}`);
  }
  const backRect = setNodeShape(shaped, "N1", "rect");
  if (!backRect.includes('N1["新节点"]')) {
    errors.push(`setNodeShape rect: ${backRect}`);
  }

  const withEdge = insertEdge(withNode, "B", "N1");
  if (!withEdge.includes("B --> N1")) {
    errors.push("insertEdge missing edge");
  }
  if (insertEdge(withEdge, "B", "N1") !== withEdge) {
    errors.push("insertEdge should be idempotent");
  }
  const dotted = "flowchart TB\n  A -.-> B\n";
  if (insertEdge(dotted, "A", "B") !== dotted) {
    errors.push("insertEdge should detect existing -.->");
  }

  const removed = removeEdge(withEdge, "B", "N1");
  if (removed.includes("B --> N1")) {
    errors.push("removeEdge should delete B --> N1");
  }
  if (removeEdge(removed, "B", "N1") !== removed) {
    errors.push("removeEdge should be idempotent");
  }
  const multi = "flowchart TB\n  A --> B\n  A --> C\n  B --> C\n";
  const rmAC = removeEdge(multi, "A", "C");
  if (
    rmAC.includes("A --> C") ||
    !rmAC.includes("A --> B") ||
    !rmAC.includes("B --> C")
  ) {
    errors.push("removeEdge should only remove matching edge");
  }

  const graph =
    "flowchart TB\n  A[\"a\"]\n  B[\"b\"]\n  A --> B\n  B --> C\n  C[\"c\"]\n";
  const noB = removeNode(graph, "B");
  if (
    noB.includes("B[") ||
    noB.includes("A --> B") ||
    noB.includes("B --> C") ||
    !noB.includes('A["a"]') ||
    !noB.includes('C["c"]')
  ) {
    errors.push(`removeNode B failed: ${noB}`);
  }
  if (removeNode(noB, "B") !== noB) {
    errors.push("removeNode should be idempotent");
  }
  // 默认模板：同行带形状的边
  const defTpl = "flowchart TB\n  A[开始] --> B[结束]\n";
  const noStart = removeNode(defTpl, "A");
  if (
    noStart.includes("A[") ||
    noStart.includes("-->") ||
    !noStart.includes("B[结束]")
  ) {
    errors.push(`removeNode default A failed: ${noStart}`);
  }
  const noEnd = removeNode(defTpl, "B");
  if (
    noEnd.includes("B[") ||
    noEnd.includes("-->") ||
    !noEnd.includes("A[开始]")
  ) {
    errors.push(`removeNode default B failed: ${noEnd}`);
  }

  const withSub = insertSubgraph(base);
  if (
    !/subgraph S1 \["分组"\]/.test(withSub) ||
    !withSub.includes("\n  end\n") ||
    !withSub.includes("    A\n") ||
    !withSub.includes("    B\n")
  ) {
    errors.push(`insertSubgraph should wrap existing nodes: ${withSub}`);
  }
  const wrapOne = insertSubgraph(base, ["A"]);
  if (!wrapOne.includes("    A\n") || wrapOne.includes("    B\n")) {
    errors.push(`insertSubgraph wrap one: ${wrapOne}`);
  }
  const emptyGraph = insertSubgraph("flowchart TB\n");
  if (!/S1_n\["子图节点"\]/.test(emptyGraph)) {
    errors.push(`insertSubgraph empty placeholder: ${emptyGraph}`);
  }

  const lr = setFlowchartDirection(base, "LR");
  if (!/^flowchart LR\b/m.test(lr)) {
    errors.push("setFlowchartDirection LR");
  }
  const tb = setFlowchartDirection(lr, "TB");
  if (!/^flowchart TB\b/m.test(tb)) {
    errors.push("setFlowchartDirection TB");
  }

  const renamed = renameNodeLabel(base, "A", "启动");
  if (!renamed.includes('A["启动"]')) {
    errors.push(`renameNodeLabel bracket: ${renamed}`);
  }
  const quoted = renameNodeLabel(
    'flowchart TB\n  X["旧标签"]\n',
    "X",
    "新标签",
  );
  if (!quoted.includes('X["新标签"]')) {
    errors.push(`renameNodeLabel quoted: ${quoted}`);
  }
  const round = renameNodeLabel("flowchart TB\n  Y(圆角)\n", "Y", "胶囊");
  if (!round.includes('Y("胶囊")')) {
    errors.push(`renameNodeLabel round: ${round}`);
  }
  const edgeOnly = renameNodeLabel(
    "flowchart TB\n  P --> Q\n",
    "P",
    "起点",
  );
  if (
    !edgeOnly.includes('P["起点"] --> Q') ||
    (edgeOnly.match(/P\[/g) || []).length !== 1
  ) {
    errors.push(`renameNodeLabel edge-only: ${edgeOnly}`);
  }
  const noGhost = renameNodeLabel(
    'flowchart TB\n  A["甲"] --> B["乙"]\n',
    "flowchart-A-99",
    "甲改",
  );
  if (
    !noGhost.includes('A["甲改"]') ||
    noGhost.includes("flowchart-A") ||
    (noGhost.match(/^\s*\w+\["/gm) || []).length > 2
  ) {
    errors.push(`renameNodeLabel must not spawn ghost node: ${noGhost}`);
  }

  const fake = {
    getAttribute: (k: string) =>
      k === "id" ? "flowchart-N1-42" : k === "class" ? "node" : null,
    closest: () => null,
  } as unknown as Element;
  if (parseSvgNodeId(fake) !== "N1") {
    errors.push(`parseSvgNodeId expected N1 got ${parseSvgNodeId(fake)}`);
  }

  return errors;
}

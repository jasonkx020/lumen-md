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
  renameNodeLabel,
  setFlowchartDirection,
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

  const withEdge = insertEdge(withNode, "B", "N1");
  if (!withEdge.includes("B --> N1")) {
    errors.push("insertEdge missing edge");
  }
  if (insertEdge(withEdge, "B", "N1") !== withEdge) {
    errors.push("insertEdge should be idempotent");
  }

  const withSub = insertSubgraph(base);
  if (!/subgraph S1 \["分组"\]/.test(withSub) || !withSub.includes("\n  end\n")) {
    errors.push("insertSubgraph template");
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
  const quoted = renameNodeLabel('flowchart TB\n  X["旧标签"]\n', "X", "新标签");
  if (!quoted.includes('X["新标签"]')) {
    errors.push(`renameNodeLabel quoted: ${quoted}`);
  }
  const round = renameNodeLabel("flowchart TB\n  Y(圆角)\n", "Y", "胶囊");
  if (!round.includes('Y("胶囊")')) {
    errors.push(`renameNodeLabel round: ${round}`);
  }

  const fake = { getAttribute: (k: string) => (k === "id" ? "flowchart-N1-42" : k === "class" ? "node" : null), closest: () => null } as unknown as Element;
  if (parseSvgNodeId(fake) !== "N1") {
    errors.push(`parseSvgNodeId expected N1 got ${parseSvgNodeId(fake)}`);
  }

  return errors;
}

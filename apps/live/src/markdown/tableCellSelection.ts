/** 表格单元格内选区：检测 / 钳制 / 行内写回，避免 AI 结果拆表。 */

import type { EditorView } from "@milkdown/prose/view";
import type { Node as ProseNode, ResolvedPos, Schema } from "@milkdown/prose/model";
import { Fragment, Slice } from "@milkdown/prose/model";

const CELL_TYPES = new Set(["table_cell", "table_header"]);

export type TableCellSpan = {
  /** 单元格节点在文档中的起点 */
  cellPos: number;
  /** 可编辑内容 [contentFrom, contentTo) */
  contentFrom: number;
  contentTo: number;
};

function findCellAt($pos: ResolvedPos): TableCellSpan | null {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (!CELL_TYPES.has(node.type.name)) continue;
    const cellPos = $pos.before(d);
    // 单元格内容在打开 token 之后
    const contentFrom = cellPos + 1;
    const contentTo = cellPos + node.nodeSize - 1;
    return { cellPos, contentFrom, contentTo };
  }
  return null;
}

/** 选区是否完全落在同一 table_cell / table_header 内。 */
export function getSameTableCell(
  doc: ProseNode,
  from: number,
  to: number,
): TableCellSpan | null {
  if (from > to) return null;
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  const a = findCellAt($from);
  const b = findCellAt($to);
  if (!a || !b) return null;
  if (a.cellPos !== b.cellPos) return null;
  return a;
}

/** 去掉围栏、压平换行、去掉管道符，适合写入单元格。 */
export function prepareCellInlineText(raw: string): string {
  let t = raw.trim();
  const fence = /^```(?:[\w-]+)?\r?\n([\s\S]*?)\r?\n```$/;
  const m = fence.exec(t);
  if (m) t = m[1]!.trim();
  // 单元格不接受多段落 / 管道表语法
  t = t.replace(/\r\n|\r|\n/g, " ").replace(/\|/g, " ").replace(/\s+/g, " ").trim();
  return t;
}

type Parser = (markdown: string) => ProseNode;

/**
 * 将 Markdown 尽量解析为行内 Fragment（取首个段落的 inline children）。
 * 失败则返回纯文本 Fragment。
 */
export function markdownToInlineFragment(
  schema: Schema,
  parser: Parser | undefined,
  markdown: string,
): Fragment {
  const flat = prepareCellInlineText(markdown);
  if (!flat) return Fragment.empty;

  if (parser) {
    try {
      const doc = parser(flat);
      // 找第一个含 inline 的块
      let inline: Fragment | null = null;
      doc.descendants((node) => {
        if (inline) return false;
        if (node.isTextblock && node.content.size > 0) {
          inline = node.content;
          return false;
        }
      });
      if (inline && (inline as Fragment).size > 0) {
        // 若解析结果又变回多块，仅用文本
        const onlyInline = Array.from(
          { length: (inline as Fragment).childCount },
          (_, i) => (inline as Fragment).child(i),
        ).every((n) => n.isInline || n.isText);
        if (onlyInline) return inline as Fragment;
      }
    } catch {
      /* fall through */
    }
  }

  return Fragment.from(schema.text(flat));
}

/**
 * 在单元格内替换 [from,to)。若选区跨格返回 false。
 * from/to 会钳制到单元格内容范围。
 */
export function replaceTableCellInline(
  view: EditorView,
  text: string,
  from: number,
  to: number,
  parser?: Parser,
): boolean {
  const cell = getSameTableCell(view.state.doc, from, to);
  if (!cell) return false;

  const lo = Math.max(from, cell.contentFrom);
  const hi = Math.min(to, cell.contentTo);
  if (lo > hi) return false;

  const frag = markdownToInlineFragment(view.state.schema, parser, text);
  const tr = view.state.tr.replace(lo, hi, new Slice(frag, 0, 0));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** 选区是否落在表格内（任一端在 cell 中）。用于提示跨格失败。 */
export function selectionTouchesTable(
  doc: ProseNode,
  from: number,
  to: number,
): boolean {
  return (
    findCellAt(doc.resolve(from)) != null ||
    findCellAt(doc.resolve(Math.max(from, to - 1))) != null ||
    findCellAt(doc.resolve(to)) != null
  );
}

/** HTML `<table>` ↔ ProseMirror table（保留 rowspan/colspan），供提升编辑与 HTML 回写。 */

import type { Node as ProseNode, Schema } from "@milkdown/prose/model";
import { Fragment } from "@milkdown/prose/model";
import { sanitizeHtml } from "./sanitizeHtml";

export function isTableHtml(value: string): boolean {
  return /<\s*table\b/i.test(value);
}

export function tableHasMerge(node: ProseNode): boolean {
  let merged = false;
  node.descendants((child) => {
    if (
      child.type.name === "table_cell" ||
      child.type.name === "table_header"
    ) {
      const rs = Number(child.attrs.rowspan ?? 1);
      const cs = Number(child.attrs.colspan ?? 1);
      if (rs > 1 || cs > 1) {
        merged = true;
        return false;
      }
    }
    return undefined;
  });
  return merged;
}

type ParsedCell = {
  rowspan: number;
  colspan: number;
  align: string;
  /** 单元格内 HTML（已消毒片段，可含 br） */
  innerHtml: string;
  isHeader: boolean;
};

type ParsedRow = ParsedCell[];

function parseAlign(el: Element): string {
  const style = el.getAttribute("style") ?? "";
  const m = /text-align\s*:\s*(left|right|center|justify)/i.exec(style);
  if (m) return m[1]!.toLowerCase();
  const align = (el.getAttribute("align") ?? "").toLowerCase();
  if (align === "left" || align === "right" || align === "center") return align;
  return "left";
}

function parseSpan(el: Element, name: "rowspan" | "colspan"): number {
  const n = Number.parseInt(el.getAttribute(name) ?? "1", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** 将 HTML table 解析为行单元格（已按 HTML 规则展开占用，后续行不含被 rowspan 占住的格）。 */
export function parseHtmlTable(raw: string): ParsedRow[] | null {
  const safe = sanitizeHtml(raw.trim());
  if (!safe || !/<\s*table\b/i.test(safe)) return null;

  const template = document.createElement("template");
  template.innerHTML = safe;
  const table = template.content.querySelector("table");
  if (!table) return null;

  const trs = Array.from(table.querySelectorAll("tr"));
  if (trs.length === 0) return null;

  const rows: ParsedRow[] = [];
  for (const tr of trs) {
    const cells: ParsedCell[] = [];
    for (const cell of Array.from(tr.children)) {
      const tag = cell.tagName.toLowerCase();
      if (tag !== "td" && tag !== "th") continue;
      cells.push({
        rowspan: parseSpan(cell, "rowspan"),
        colspan: parseSpan(cell, "colspan"),
        align: parseAlign(cell),
        innerHtml: cell.innerHTML,
        isHeader: tag === "th",
      });
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows.length > 0 ? rows : null;
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 把单元格 innerHTML 转成段落子节点（文本 + hardbreak）。 */
function cellContentFromHtml(schema: Schema, innerHtml: string): Fragment {
  const wrap = document.createElement("div");
  wrap.innerHTML = innerHtml;
  const nodes: ProseNode[] = [];
  const hardbreak = schema.nodes.hardbreak;
  const walk = (n: ChildNode) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = n.textContent ?? "";
      if (t) nodes.push(schema.text(t));
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === "br") {
      if (hardbreak) nodes.push(hardbreak.create());
      return;
    }
    // 块级换行：前后各插 hardbreak（简化）
    if (tag === "p" || tag === "div") {
      if (nodes.length > 0 && hardbreak) nodes.push(hardbreak.create());
      Array.from(el.childNodes).forEach(walk);
      return;
    }
    Array.from(el.childNodes).forEach(walk);
  };
  Array.from(wrap.childNodes).forEach(walk);
  return Fragment.from(nodes);
}

function paragraphWithHtml(schema: Schema, innerHtml: string): ProseNode {
  const para = schema.nodes.paragraph;
  if (!para) throw new Error("schema missing paragraph");
  const content = cellContentFromHtml(schema, innerHtml);
  return para.create(null, content.size ? content : undefined);
}

/**
 * HTML table → ProseMirror table。
 * 无 `<th>` 时将首行提升为 table_header_row（满足 Crepe schema）。
 */
export function htmlToPmTable(schema: Schema, raw: string): ProseNode | null {
  const tableType = schema.nodes.table;
  const headerRowType = schema.nodes.table_header_row;
  const rowType = schema.nodes.table_row;
  const headerType = schema.nodes.table_header;
  const cellType = schema.nodes.table_cell;
  if (!tableType || !headerRowType || !rowType || !headerType || !cellType) {
    return null;
  }

  const parsed = parseHtmlTable(raw);
  if (!parsed) return null;

  const hasExplicitHeader = parsed.some((r) => r.some((c) => c.isHeader));
  const rows = parsed.map((r, i) =>
    r.map((c) => ({
      ...c,
      isHeader: hasExplicitHeader ? c.isHeader : i === 0,
    })),
  );

  const makeCell = (c: ParsedCell, asHeader: boolean) => {
    const type = asHeader ? headerType : cellType;
    return type.create(
      {
        alignment: c.align,
        rowspan: c.rowspan,
        colspan: c.colspan,
      },
      paragraphWithHtml(schema, c.innerHtml),
    );
  };

  const pmRows: ProseNode[] = [];
  // 首行必须是 header row
  const first = rows[0]!;
  pmRows.push(
    headerRowType.create(
      null,
      first.map((c) => makeCell(c, true)),
    ),
  );

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    // body 行：若该行全是 header（少见），仍用 table_cell
    pmRows.push(
      rowType.create(
        null,
        row.map((c) => makeCell(c, false)),
      ),
    );
  }

  // Crepe 要求至少一行 body；若只有表头，补空行
  if (pmRows.length === 1) {
    const colCount = first.reduce((n, c) => n + c.colspan, 0);
    const emptyCells = Array.from({ length: Math.max(colCount, 1) }, () =>
      cellType.create(
        { alignment: "left", rowspan: 1, colspan: 1 },
        paragraphWithHtml(schema, ""),
      ),
    );
    pmRows.push(rowType.create(null, emptyCells));
  }

  return tableType.create(null, pmRows);
}

function cellInnerToHtml(cell: ProseNode): string {
  const paras: string[] = [];
  cell.forEach((child) => {
    if (child.type.name !== "paragraph") {
      if (child.isText) {
        paras.push(escapeText(child.text ?? ""));
      }
      return;
    }
    const buf: string[] = [];
    child.forEach((n) => {
      if (n.isText) buf.push(escapeText(n.text ?? ""));
      else if (n.type.name === "hardbreak") buf.push("<br>");
    });
    paras.push(buf.join(""));
  });
  return paras.join("<br>");
}

/** ProseMirror table → HTML（保留 rowspan/colspan）。 */
export function pmTableToHtml(node: ProseNode): string {
  const lines: string[] = ["<table>"];
  node.forEach((row) => {
    if (
      row.type.name !== "table_row" &&
      row.type.name !== "table_header_row"
    ) {
      return;
    }
    lines.push("  <tr>");
    row.forEach((cell) => {
      const isHeader =
        cell.type.name === "table_header" ||
        row.type.name === "table_header_row";
      const tag = isHeader ? "th" : "td";
      const rs = Number(cell.attrs.rowspan ?? 1);
      const cs = Number(cell.attrs.colspan ?? 1);
      const align = String(cell.attrs.alignment ?? "left");
      const attrs: string[] = [];
      if (rs > 1) attrs.push(`rowspan="${rs}"`);
      if (cs > 1) attrs.push(`colspan="${cs}"`);
      if (align && align !== "left") {
        attrs.push(`style="text-align: ${align}"`);
      }
      const attrStr = attrs.length ? ` ${attrs.join(" ")}` : "";
      const inner = cellInnerToHtml(cell);
      lines.push(`    <${tag}${attrStr}>${inner}</${tag}>`);
    });
    lines.push("  </tr>");
  });
  lines.push("</table>");
  return lines.join("\n");
}

/**
 * 将文档中带合并单元格的 table 临时替换为 html 段落，再交给 Milkdown serializer，
 * 从而把 rowspan/colspan 写回原始 HTML 而非 GFM 管道表。
 */
export function replaceMergedTablesWithHtml(
  doc: ProseNode,
  schema: Schema,
): ProseNode {
  if (!schema.nodes.html || !schema.nodes.paragraph) return doc;

  const mapNode = (n: ProseNode): ProseNode => {
    if (n.type.name === "table" && tableHasMerge(n)) {
      const html = pmTableToHtml(n);
      const atom = schema.nodes.html!.create({ value: html });
      return schema.nodes.paragraph!.create(null, atom);
    }
    if (n.isText || n.childCount === 0) return n;
    const children: ProseNode[] = [];
    let changed = false;
    n.forEach((child) => {
      const next = mapNode(child);
      if (next !== child) changed = true;
      children.push(next);
    });
    return changed ? n.copy(Fragment.from(children)) : n;
  };

  return mapNode(doc);
}

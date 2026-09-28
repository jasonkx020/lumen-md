/**
 * HTML table promote / serialize 自检（需在浏览器 DOM 环境）。
 * 可在 Vite 开发页控制台调用，或后续接入 vitest。
 */
import {
  htmlToPmTable,
  isTableHtml,
  parseHtmlTable,
  pmTableToHtml,
  tableHasMerge,
} from "./htmlTable";

const SAMPLE = `<table border="1">
  <tr>
    <td rowspan="5">文件状态：草稿<br>保密级别：绝密</td>
    <td>文件标识：</td>
    <td>需求开发整个流程步骤简介</td>
  </tr>
  <tr>
    <td>当前版本：</td>
    <td>1.0</td>
  </tr>
  <tr>
    <td>作者：</td>
    <td>王跃林</td>
  </tr>
  <tr>
    <td>审核：</td>
    <td>刘永红</td>
  </tr>
  <tr>
    <td>完成日期：</td>
    <td>2024.06</td>
  </tr>
</table>`;

export function runHtmlTableSelfCheck(schema?: {
  nodes: Record<string, { create: (...args: unknown[]) => unknown }>;
}): string[] {
  const errors: string[] = [];

  if (!isTableHtml(SAMPLE)) errors.push("isTableHtml failed");

  const parsed = parseHtmlTable(SAMPLE);
  if (!parsed) {
    errors.push("parseHtmlTable returned null");
    return errors;
  }
  if (parsed.length !== 5) errors.push(`expected 5 rows, got ${parsed.length}`);
  if (parsed[0]?.[0]?.rowspan !== 5) {
    errors.push(`expected rowspan 5, got ${parsed[0]?.[0]?.rowspan}`);
  }
  if ((parsed[0]?.length ?? 0) !== 3) {
    errors.push(`row0 expected 3 cells, got ${parsed[0]?.length}`);
  }
  if ((parsed[1]?.length ?? 0) !== 2) {
    errors.push(`row1 expected 2 cells (rowspan occupied), got ${parsed[1]?.length}`);
  }

  // 无 schema 时只测解析；有 schema 再测往返
  if (schema?.nodes?.table) {
    try {
      const pm = htmlToPmTable(schema as never, SAMPLE);
      if (!pm) {
        errors.push("htmlToPmTable returned null");
      } else {
        if (!tableHasMerge(pm as never)) errors.push("tableHasMerge false");
        const html = pmTableToHtml(pm as never);
        if (!html.includes("rowspan")) errors.push("pmTableToHtml lost rowspan");
        if (!html.includes("王跃林")) errors.push("pmTableToHtml lost cell text");
      }
    } catch (e) {
      errors.push(`pm roundtrip threw: ${e}`);
    }
  }

  return errors;
}

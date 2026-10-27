/** GFM 表格规范化自检（AI 常见坏输入）。 */
import { normalizeGfmTables } from "./normalizeGfmTables";

export function runNormalizeGfmTablesSelfCheck(): string[] {
  const errors: string[] = [];

  // 全角竖线
  const fullwidth = normalizeGfmTables(
    "｜列一｜列二｜\n｜---｜---｜\n｜a｜b｜\n",
  );
  if (!fullwidth.includes("|列一|") || fullwidth.includes("\uFF5C")) {
    errors.push(`fullwidth pipes: ${JSON.stringify(fullwidth)}`);
  }

  // 表前缺空行（上一行非空）
  const noBlank = normalizeGfmTables(
    "前文\n| A | B |\n| --- | --- |\n| 1 | 2 |\n",
  );
  if (!noBlank.includes("前文\n\n| A | B |")) {
    errors.push(`leading blank before table: ${JSON.stringify(noBlank)}`);
  }

  // en-dash 分隔行
  const enDash = normalizeGfmTables("| A | B |\n| ––– | ––– |\n| 1 | 2 |\n");
  if (/[\u2013\u2014]/.test(enDash)) {
    errors.push(`en-dash sep left: ${JSON.stringify(enDash)}`);
  }
  if (!enDash.includes("---")) {
    errors.push(`en-dash not normalized to ---: ${JSON.stringify(enDash)}`);
  }

  return errors;
}

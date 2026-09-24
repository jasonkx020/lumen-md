/**
 * 规范化 GFM 表格，避免因全角竖线、异常分隔符或缺空行导致解析失败。
 */
export function normalizeGfmTables(markdown: string): string {
  if (!markdown) return markdown;

  // 全角竖线 → ASCII，避免「看起来像表格」却解析成段落
  let text = markdown.replace(/\uFF5C/g, "|");

  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  const isSep = (line: string) => {
    const t = line.trim();
    if (!t.includes("|")) return false;
    // 允许 :--- ---: 等对齐语法；把 en/em dash 也当成 -
    const normalized = t.replace(/[\u2013\u2014\u2212]/g, "-");
    const cells = normalized.split("|").filter((_, i, arr) => {
      // 忽略首尾空段（|aaa|bbb| 形式）
      return !(i === 0 && arr[i] === "") && !(i === arr.length - 1 && arr[i] === "");
    });
    if (cells.length < 2) return false;
    return cells.every((c) => /^\s*:?-{1,}:?\s*$/.test(c));
  };
  const isRow = (line: string) => {
    const t = line.trim();
    return t.startsWith("|") && t.includes("|", 1);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    // 表头行 + 下一行是分隔行 → 表格开始；若上一行非空，插入空行
    if (
      next !== undefined &&
      isRow(line) &&
      isSep(next) &&
      out.length > 0 &&
      out[out.length - 1].trim() !== ""
    ) {
      out.push("");
    }
    // 规范化分隔行里的 dash
    if (isSep(line)) {
      out.push(line.replace(/[\u2013\u2014\u2212]/g, "-"));
    } else {
      out.push(line);
    }
  }

  return out.join("\n");
}

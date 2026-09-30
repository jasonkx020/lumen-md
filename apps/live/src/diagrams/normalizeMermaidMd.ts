/** Mermaid 源码规范化：去掉 Typora/Markdown 残留的括号转义，识别图类型。 */

const MERMAID_DIAGRAM_RE =
  /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|sankey-beta|xychart-beta|block-beta)\b/i;

/** Typora / MD 残留：`\[` → `[`，`\]` → `]`（不碰其它反斜杠）。 */
export function unescapeMermaidBrackets(code: string): string {
  return code.replace(/\\([\[\]])/g, "$1");
}

export function looksLikeMermaidDiagram(code: string): boolean {
  const first = code
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return false;
  return MERMAID_DIAGRAM_RE.test(first);
}

/** 渲染前：去 BOM、括号转义、首尾空白。 */
export function prepareMermaidSource(code: string): string {
  return unescapeMermaidBrackets(code.replace(/^\uFEFF/, "")).trim();
}

/**
 * 对 markdown 中的 fenced code：
 * - lang=mermaid：去掉 body 内 `\[` `\]`
 * - 无 lang / text / txt：若 body 像图，同样 unescape，并补上 `mermaid` 语言标签
 */
export function normalizeMermaidFencesInMarkdown(md: string): string {
  // ```lang?\n...\n```  （允许围栏 3+ 反引号）
  return md.replace(
    /(^|\n)([ \t]*)(```|~~~)([^\n`]*)\n([\s\S]*?)\n([ \t]*)\3[ \t]*(?=\n|$)/g,
    (full, lead, indent, fence, info, body, closeIndent) => {
      const lang = String(info ?? "")
        .trim()
        .split(/\s+/)[0]
        ?.toLowerCase() ?? "";
      const isMermaidLang = lang === "mermaid";
      const isBlankOrText =
        !lang || lang === "text" || lang === "txt" || lang === "plain";
      if (!isMermaidLang && !isBlankOrText) {
        return full;
      }
      if (!isMermaidLang && !looksLikeMermaidDiagram(body)) {
        return full;
      }
      const nextBody = unescapeMermaidBrackets(body);
      const nextInfo = isMermaidLang ? String(info ?? "").trimEnd() : "mermaid";
      return `${lead}${indent}${fence}${nextInfo}\n${nextBody}\n${closeIndent}${fence}`;
    },
  );
}

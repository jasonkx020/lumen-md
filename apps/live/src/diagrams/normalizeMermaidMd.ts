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
 * 从 AI/粘贴文本中抽出 Mermaid 源码（允许围栏前后有说明文字）。
 * Diff 预览与「启用结果」插入必须共用此逻辑，避免识别不一致。
 */
export function extractMermaidSource(text: string): string | null {
  const t = text.trim().replace(/\r\n/g, "\n");
  if (!t) return null;
  const fence = t.match(/```\s*mermaid[^\n]*\r?\n([\s\S]*?)(?:\r?\n)```/i);
  if (fence) {
    const body = prepareMermaidSource(fence[1] ?? "");
    return body || null;
  }
  // 闭合围栏前缺换行：```mermaid\n...\```
  const loose = t.match(/```\s*mermaid[^\n]*\r?\n([\s\S]*?)```/i);
  if (loose) {
    const body = prepareMermaidSource(loose[1] ?? "");
    if (body && looksLikeMermaidDiagram(body)) return body;
  }
  const bare = t.replace(/^mermaid\s*\n/i, "").trim();
  if (looksLikeMermaidDiagram(bare)) return prepareMermaidSource(bare);
  if (looksLikeMermaidDiagram(t)) return prepareMermaidSource(t);
  return null;
}

/**
 * 确保结果为单一 ```mermaid 围栏（与 Diff 的 extractMermaidSource 对齐）。
 * 可吃掉前言说明；抽不出图源则原样返回。
 */
export function ensureMermaidFence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const extracted = extractMermaidSource(t);
  if (extracted) {
    return "```mermaid\n" + extracted + "\n```";
  }
  if (/^```\s*mermaid\b/i.test(t)) return t;
  return t;
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

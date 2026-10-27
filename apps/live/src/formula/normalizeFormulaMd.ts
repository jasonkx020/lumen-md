/**
 * AI / 粘贴公式规范化：裸 LaTeX 包成 $$ 或抽出源码，供 Diff 预览与插入共用。
 * Crepe 块级公式依赖 `$$…$$`（转 LaTeX code_block）或 ```latex 围栏。
 */

const LATEX_CMD_RE =
  /\\(begin|end|frac|mathrm|operatorname|text|textbf|textit|sqrt|sum|int|prod|left|right|alpha|beta|gamma|delta|theta|lambda|pi|sigma|omega|cdot|times|div|pm|mp|leq|geq|neq|approx|infty|partial|nabla|vec|hat|bar|dot|ddot|overline|underline|mathbf|mathsf|mathit|mathbb|boldsymbol|binom|dbinom|tfrac|dfrac|overset|underset|xrightarrow|xleftarrow)\b/;

const ENV_RE = /\\begin\{([a-zA-Z*]+)\}([\s\S]*?)\\end\{\1\}/;

export function stripOuterFormulaFence(text: string): string {
  const t = text.trim().replace(/\r\n/g, "\n");
  const fence = t.match(
    /^```\s*(?:latex|tex|math)[^\n]*\n([\s\S]*?)\n```\s*$/i,
  );
  return fence ? (fence[1] ?? "").trim() : t;
}

/** 是否已是可被 Markdown/Crepe 识别的公式包裹。 */
export function isFormulaMarkdownWrapped(text: string): boolean {
  const t = text.trim().replace(/\r\n/g, "\n");
  if (!t) return false;
  if (/^\$\$[\s\S]+\$\$\s*$/.test(t)) return true;
  if (/^\$[^$\n]+\$\s*$/.test(t)) return true;
  if (/^\\\[[\s\S]+\\\]\s*$/.test(t)) return true;
  if (/^```\s*(?:latex|tex|math)\b/i.test(t) && /```\s*$/.test(t)) return true;
  return false;
}

/** 文本是否像裸 LaTeX（无 $ / 围栏）。 */
export function looksLikeBareLatex(text: string): boolean {
  const t = text.trim().replace(/\r\n/g, "\n");
  if (!t || isFormulaMarkdownWrapped(t)) return false;
  if (/^```/.test(t)) return false;
  if (ENV_RE.test(t)) return true;
  if (/^\\[a-zA-Z]+/.test(t)) return true;
  const cmds = t.match(/\\[a-zA-Z]+/g)?.length ?? 0;
  if (cmds >= 2 && LATEX_CMD_RE.test(t)) return true;
  if (cmds >= 1 && /[=^_{}]/.test(t) && t.length < 800) return true;
  return false;
}

/**
 * 从 AI/粘贴文本抽出公式源码（允许围栏、$$、\[\]，及几乎整段的裸 LaTeX）。
 * 含中文的 \mathrm{…} / \text{…} 也视为公式。
 */
export function extractFormulaLatex(text: string): string | null {
  const raw = text.trim().replace(/\r\n/g, "\n");
  if (!raw) return null;

  const fenced = raw.match(
    /```\s*(?:latex|tex|math)[^\n]*\r?\n([\s\S]*?)(?:\r?\n)```/i,
  );
  if (fenced) {
    const body = (fenced[1] ?? "").trim();
    return body || null;
  }

  const displays = [...raw.matchAll(/\$\$([\s\S]+?)\$\$/g)].map((m) =>
    (m[1] ?? "").trim(),
  );
  if (displays.length === 1) {
    const rest = raw
      .replace(/\$\$[\s\S]+?\$\$/g, "")
      .replace(/\$[^$\n]+\$/g, "")
      .trim();
    if (rest.length < 48) return displays[0] || null;
  }
  if (displays.length > 1) {
    const rest = raw
      .replace(/\$\$[\s\S]+?\$\$/g, "")
      .replace(/\$[^$\n]+\$/g, "")
      .trim();
    if (rest.length < 24) return displays.join("\n");
  }

  const bracket = raw.match(/^\\\[([\s\S]+?)\\\]\s*$/);
  if (bracket) return (bracket[1] ?? "").trim() || null;

  const onlyInline = raw.match(/^\$([^$\n]+)\$\s*$/);
  if (onlyInline) return (onlyInline[1] ?? "").trim() || null;

  const env = raw.match(ENV_RE);
  if (env) {
    const body = env[0]!;
    const rest = raw.replace(body, "").trim();
    if (rest.length < 48 || looksLikeBareLatex(raw)) return body;
  }

  const stripped = stripOuterFormulaFence(raw);
  if (looksLikeBareLatex(stripped)) return stripped;

  return null;
}

/**
 * 保证输出可写入 Markdown 并被 Crepe 渲染：
 * - 已有 $$ / $ / ```latex → 原样（\[\] 转 $$）
 * - 裸 LaTeX → 包成 $$…$$
 */
export function ensureFormulaMarkdown(text: string): string {
  const t = text.trim().replace(/\r\n/g, "\n");
  if (!t) return t;

  if (/^```\s*(?:latex|tex|math)\b/i.test(t) && /```\s*$/.test(t)) {
    return t;
  }
  if (/^\$\$[\s\S]+\$\$\s*$/.test(t)) return t;
  if (/^\$[^$\n]+\$\s*$/.test(t)) return t;

  const bracket = t.match(/^\\\[([\s\S]+?)\\\]\s*$/);
  if (bracket) {
    return `$$\n${(bracket[1] ?? "").trim()}\n$$`;
  }

  const latex = extractFormulaLatex(t);
  if (!latex) return t;

  // 已是「几乎整段公式」但带短前言：只保留公式体并包 $$
  if (latex !== t && t.includes(latex)) {
    const rest = t.replace(latex, "").trim();
    if (rest.length < 48) {
      return wrapDisplay(latex);
    }
  }

  if (looksLikeBareLatex(t) || latex === t) {
    return wrapDisplay(latex);
  }

  return t;
}

function wrapDisplay(latex: string): string {
  const body = latex.trim();
  if (!body) return body;
  if (/^\$\$/.test(body)) return body;
  // 短单行无环境 → 行内；否则块级
  if (!/\n/.test(body) && !ENV_RE.test(body) && body.length <= 48) {
    return `$${body}$`;
  }
  return `$$\n${body}\n$$`;
}

/** TOC 插入 / 更新；front matter 解析；字数统计。 */

import { extractOutline, slugifyHeading } from "../markdown/extractOutline";

const TOC_START = "<!-- lumen-toc -->";
const TOC_END = "<!-- /lumen-toc -->";

export function buildTocMarkdown(markdown: string): string {
  const outline = extractOutline(markdown);
  if (outline.length === 0) {
    return `${TOC_START}\n\n*（暂无标题）*\n\n${TOC_END}`;
  }
  const lines = outline.map((h) => {
    const indent = "  ".repeat(Math.max(0, h.level - 1));
    const slug = slugifyHeading(h.text);
    return `${indent}- [${h.text}](#${slug})`;
  });
  return `${TOC_START}\n\n## 目录\n\n${lines.join("\n")}\n\n${TOC_END}`;
}

/** 插入或替换文档中的 TOC 锚块。 */
export function upsertToc(markdown: string): string {
  const block = buildTocMarkdown(markdown);
  const start = markdown.indexOf(TOC_START);
  const end = markdown.indexOf(TOC_END);
  if (start >= 0 && end > start) {
    return (
      markdown.slice(0, start) +
      block +
      markdown.slice(end + TOC_END.length)
    );
  }
  // 插在 front matter 之后或文首
  const fm = splitFrontMatter(markdown);
  if (fm) {
    return `${fm.raw}\n\n${block}\n\n${fm.body}`;
  }
  return `${block}\n\n${markdown}`;
}

export type FrontMatter = {
  raw: string;
  body: string;
  title?: string;
  tags?: string;
};

export function splitFrontMatter(markdown: string): FrontMatter | null {
  if (!markdown.startsWith("---")) return null;
  const end = markdown.indexOf("\n---", 3);
  if (end < 0) return null;
  const raw = markdown.slice(0, end + 4);
  const body = markdown.slice(end + 4).replace(/^\r?\n/, "");
  const yaml = markdown.slice(3, end).trim();
  let title: string | undefined;
  let tags: string | undefined;
  for (const line of yaml.split(/\r?\n/)) {
    const m = /^(\w+)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === "title") title = m[2]?.replace(/^["']|["']$/g, "");
    if (m[1] === "tags") tags = m[2];
  }
  return { raw, body, title, tags };
}

export function countWords(markdown: string): {
  chars: number;
  words: number;
  readingMin: number;
} {
  const fm = splitFrontMatter(markdown);
  const text = (fm?.body ?? markdown)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/[#>*_`~\-|]/g, " ");
  const chars = text.replace(/\s/g, "").length;
  const en = (text.match(/[A-Za-z0-9]+/g) ?? []).length;
  const zh = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const words = en + zh;
  const readingMin = Math.max(1, Math.ceil(words / 400));
  return { chars, words, readingMin };
}

/** 在文末追加脚注定义，并返回引用标记文本。 */
export function nextFootnoteRef(markdown: string): { ref: string; def: string } {
  let max = 0;
  const re = /\[\^(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  const id = String(max + 1);
  return {
    ref: `[^${id}]`,
    def: `[^${id}]: 脚注内容`,
  };
}

/** 脚注：将 `[^id]` / `[^id]:` 做简单 HTML 提示（导出用增强可另做）。 */
export function footnoteHintCss(): string {
  return `
.footnote-ref { font-size: 0.75em; vertical-align: super; }
.footnotes { margin-top: 2em; border-top: 1px solid var(--border); padding-top: 0.5em; font-size: 0.9em; }
`;
}

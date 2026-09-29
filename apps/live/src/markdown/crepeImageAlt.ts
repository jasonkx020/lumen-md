/**
 * Crepe image-block 的已知问题：
 * - parse 时把 mdast `alt` 当成 ratio（缩放），`title` 当成 caption
 * - serialize 时写出 `![1.00](url "caption")`，原 alt 文本丢失
 *
 * 打开前把 alt 挪到 title；写出后再还原为 `![alt](url)`。
 */

const IMAGE_RE =
  /!\[([^\]]*)\]\((<?[^)\s>]+>?)(?:\s+"((?:\\.|[^"\\])*)")?\)/g;

function unescapeTitle(s: string): string {
  return s.replace(/\\([\\"])/g, "$1");
}

function escapeTitle(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isRatioAlt(alt: string): boolean {
  return /^\d+(\.\d+)?$/.test(alt.trim());
}

/** 读入 Crepe 前：`![alt](url)` → `![1](url "alt")` */
export function encodeImageAltForCrepe(markdown: string): string {
  if (!markdown || !markdown.includes("![")) return markdown;
  return markdown.replace(IMAGE_RE, (full, alt: string, url: string, title?: string) => {
    const titleText = title ? unescapeTitle(title) : "";
    // 已是 Crepe 形态（数字 alt + title）则保持
    if (isRatioAlt(alt) && titleText) return full;
    const cap = (alt || titleText).trim();
    if (cap) return `![1](${url} "${escapeTitle(cap)}")`;
    return `![](${url})`;
  });
}

/** 从 Crepe 写出后：`![1.00](url "caption")` → `![caption](url)` */
export function decodeImageAltFromCrepe(markdown: string): string {
  if (!markdown || !markdown.includes("![")) return markdown;
  return markdown.replace(IMAGE_RE, (full, alt: string, url: string, title?: string) => {
    if (!isRatioAlt(alt)) return full;
    const cap = title ? unescapeTitle(title).trim() : "";
    if (cap) return `![${cap}](${url})`;
    return `![](${url})`;
  });
}

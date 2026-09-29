/**
 * GitHub README 兼容：保证块级 HTML（独立 img / 多行 div）前后有空行，
 * 避免被 Markdown 吃进段落导致无法成为 html_block。
 */

import { isBlockHtml } from "./htmlBlockNodes";

const BLOCK_OPEN =
  /^\s*<(div|img|table|details|section|center|blockquote|ul|ol|pre|p|h[1-6]|hr|figure|figcaption|a)\b/i;

function ensureBlankBefore(out: string[]) {
  if (out.length > 0 && out[out.length - 1]!.trim() !== "") {
    out.push("");
  }
}

function ensureBlankAfter(out: string[], hasMore: boolean, nextNonEmpty: boolean) {
  if (hasMore && nextNonEmpty) {
    if (out.length === 0 || out[out.length - 1]!.trim() !== "") {
      out.push("");
    }
  }
}

function peekNextNonEmpty(lines: string[], from: number): boolean {
  for (let j = from; j < lines.length; j++) {
    if (lines[j]!.trim() !== "") return true;
  }
  return false;
}

/** 从 start 取一块 HTML；失败返回 null。 */
function takeHtmlBlock(
  lines: string[],
  start: number,
): { end: number; text: string } | null {
  const first = lines[start];
  if (first === undefined || !BLOCK_OPEN.test(first)) return null;

  const tagMatch = /^\s*<([a-zA-Z][\w:-]*)\b/.exec(first);
  if (!tagMatch) return null;
  const tag = tagMatch[1]!.toLowerCase();

  // void / 单行
  const trimmed = first.trim();
  if (
    tag === "img" ||
    tag === "hr" ||
    /\/\s*>\s*$/.test(trimmed) ||
    new RegExp(`^<${tag}\\b[^>]*>.*</${tag}>\\s*$`, "is").test(trimmed)
  ) {
    // img 可能属性折行到 `>`
    if (!/>/.test(first) && (tag === "img" || tag === "hr")) {
      const parts = [first];
      let i = start;
      while (i + 1 < lines.length) {
        i += 1;
        parts.push(lines[i]!);
        if (/>/.test(lines[i]!)) break;
        if (i - start > 20) break;
      }
      const text = parts.join("\n");
      if (isBlockHtml(text) || tag === "img") {
        return { end: i, text };
      }
      return null;
    }
    if (isBlockHtml(trimmed) || tag === "img") {
      return { end: start, text: first };
    }
    return null;
  }

  const openRe = new RegExp(`<${tag}\\b`, "gi");
  const closeRe = new RegExp(`</${tag}\\s*>`, "gi");
  const selfRe = new RegExp(`<${tag}\\b[^>]*\\/\\s*>`, "gi");
  let depth = 0;
  const parts: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    parts.push(line);
    const selfs = line.match(selfRe)?.length ?? 0;
    const opens = (line.match(openRe)?.length ?? 0) - selfs;
    const closes = line.match(closeRe)?.length ?? 0;
    depth += opens - closes;
    if (i === start && depth <= 0 && closes === 0) {
      depth = 1;
    }
    if (depth <= 0) {
      const text = parts.join("\n");
      if (isBlockHtml(text)) return { end: i, text };
      return null;
    }
    if (i - start > 500) break;
  }
  const text = parts.join("\n");
  if (isBlockHtml(text)) return { end: start + parts.length - 1, text };
  return null;
}

export function normalizeGithubHtml(markdown: string): string {
  if (!markdown || !markdown.includes("<")) return markdown;
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const block = takeHtmlBlock(lines, i);
    if (!block) {
      out.push(lines[i]!);
      i += 1;
      continue;
    }
    ensureBlankBefore(out);
    out.push(block.text);
    const next = block.end + 1;
    ensureBlankAfter(out, next < lines.length, peekNextNonEmpty(lines, next));
    // 跳过块后已有的空行，避免双空行过多
    i = next;
    while (i < lines.length && lines[i]!.trim() === "") i += 1;
  }
  return out.join("\n");
}

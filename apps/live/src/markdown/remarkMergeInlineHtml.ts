/**
 * CommonMark 会把 `<a ...>text</a>` 拆成 html/text/html 三个节点，
 * 导致预览里锚点无文本、无法点击。合并为单个 html 节点后再渲染。
 */

import { $remark } from "@milkdown/kit/utils";

type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
};

const VOID_OR_SELF =
  /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;

function openTagName(html: string): string | null {
  const m = /^<([a-zA-Z][\w:-]*)\b[^>]*\/?>\s*$/.exec(html.trim());
  if (!m) return null;
  if (/\/\s*>$/.test(html.trim())) return null;
  const tag = m[1]!.toLowerCase();
  if (VOID_OR_SELF.test(tag)) return null;
  if (html.trim().startsWith("</")) return null;
  return tag;
}

function closeTagName(html: string): string | null {
  const m = /^<\/([a-zA-Z][\w:-]*)\s*>\s*$/.exec(html.trim());
  return m?.[1]?.toLowerCase() ?? null;
}

function mergeChildren(children: MdastNode[]): MdastNode[] {
  const out: MdastNode[] = [];
  let i = 0;
  while (i < children.length) {
    const node = children[i]!;
    if (node.children) {
      node.children = mergeChildren(node.children);
    }

    const tag =
      node.type === "html" && typeof node.value === "string"
        ? openTagName(node.value)
        : null;

    if (!tag) {
      out.push(node);
      i += 1;
      continue;
    }

    const parts: string[] = [node.value!];
    let depth = 1;
    let j = i + 1;
    let ok = false;
    while (j < children.length && depth > 0) {
      const cur = children[j]!;
      if (cur.type === "html" && typeof cur.value === "string") {
        const open = openTagName(cur.value);
        const close = closeTagName(cur.value);
        if (open === tag) depth += 1;
        else if (close === tag) depth -= 1;
        parts.push(cur.value);
        j += 1;
        if (depth === 0) {
          ok = true;
          break;
        }
        continue;
      }
      if (cur.type === "text" && typeof cur.value === "string") {
        parts.push(cur.value);
        j += 1;
        continue;
      }
      // 夹杂强调等 Markdown 节点时放弃本次合并
      break;
    }

    if (ok) {
      out.push({ type: "html", value: parts.join("") });
      i = j;
      continue;
    }

    out.push(node);
    i += 1;
  }
  return out;
}

/** 供自检 / 测试直接调用。 */
export function mergeInlineHtmlTree(tree: MdastNode): void {
  if (tree.children) {
    tree.children = mergeChildren(tree.children);
    for (const child of tree.children) mergeInlineHtmlTree(child);
  }
}

export const remarkMergeInlineHtml = $remark(
  "remarkMergeInlineHtml",
  () => () => (tree) => {
    mergeInlineHtmlTree(tree as MdastNode);
  },
);

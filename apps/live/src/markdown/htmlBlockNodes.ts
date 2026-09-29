/** GitHub 风格块级 HTML：schema + remark 分流（与 inline html 并存）。 */

import { $nodeSchema, $remark } from "@milkdown/kit/utils";

/** 视为块级的 HTML 根标签（对齐 GitHub README 常见用法）。 */
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "center",
  "details",
  "div",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "img",
  "main",
  "nav",
  "ol",
  "p",
  "picture",
  "pre",
  "section",
  "table",
  "ul",
]);

const INLINE_ONLY_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "br",
  "code",
  "em",
  "i",
  "kbd",
  "mark",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "u",
]);

function firstTagName(html: string): string | null {
  const m = /^\s*<([a-zA-Z][\w:-]*)\b/.exec(html);
  return m?.[1]?.toLowerCase() ?? null;
}

/** 判断 mdast html.value 是否应按块级节点处理。 */
export function isBlockHtml(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!v.startsWith("<")) return false;
  // HTML 注释当块
  if (v.startsWith("<!--")) return true;
  const tag = firstTagName(v);
  if (!tag) return false;
  if (INLINE_ONLY_TAGS.has(tag)) {
    // 多行且含块级/图片子标签（GitHub star-history 等）→ 仍作块
    if (
      v.includes("\n") &&
      /<(div|table|p|ul|ol|section|details|img)\b/i.test(v)
    ) {
      return true;
    }
    return false;
  }
  if (BLOCK_TAGS.has(tag)) return true;
  // 未知标签：多行则按块，避免顶层落不进 doc
  return v.includes("\n");
}

type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
};

function walk(node: MdastNode, fn: (n: MdastNode, parent: MdastNode | null) => void, parent: MdastNode | null = null) {
  fn(node, parent);
  if (!node.children) return;
  for (const child of node.children) {
    walk(child, fn, node);
  }
}

/**
 * 将块级 mdast `html` 改为 `html_block`。
 * 须在 commonmark 的 remarkHtmlTransformer 之后注册：该插件会把根级 html
 * 包进 paragraph，本插件再把「仅含块级 html」的 paragraph 提升为 html_block。
 */
export const remarkHtmlBlock = $remark("remarkHtmlBlock", () => () => (tree) => {
  walk(tree as MdastNode, (node) => {
    if (node.type === "html" && isBlockHtml(node.value)) {
      node.type = "html_block";
    }
  });
  walk(tree as MdastNode, (node) => {
    if (node.type !== "paragraph" || !node.children || node.children.length !== 1) {
      return;
    }
    const only = node.children[0]!;
    const value =
      only.type === "html_block" || only.type === "html" ? only.value : undefined;
    if (typeof value !== "string" || !isBlockHtml(value)) return;
    node.type = "html_block";
    node.value = value;
    delete node.children;
  });
});

export const htmlBlockSchema = $nodeSchema("html_block", () => ({
  atom: true,
  group: "block",
  isolating: true,
  marks: "",
  attrs: {
    value: {
      default: "",
      validate: "string",
    },
  },
  parseDOM: [
    {
      tag: 'div[data-type="html-block"]',
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false;
        return { value: dom.dataset.value ?? dom.getAttribute("data-value") ?? "" };
      },
    },
  ],
  toDOM: (node) => [
    "div",
    {
      "data-type": "html-block",
      "data-value": node.attrs.value,
    },
  ],
  parseMarkdown: {
    match: ({ type }) => type === "html_block",
    runner: (state, node, type) => {
      state.addNode(type, { value: String(node.value ?? "") });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "html_block",
    runner: (state, node) => {
      // 写回标准 mdast html，保证源码往返
      state.addNode("html", undefined, String(node.attrs.value ?? ""));
    },
  },
}));

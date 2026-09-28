/** Typora 风格 HTML-in-MD 消毒：白名单标签/属性，剥离脚本与事件。 */

const ALLOWED_TAGS = new Set([
  "br",
  "p",
  "div",
  "span",
  "section",
  "details",
  "summary",
  "kbd",
  "mark",
  "u",
  "sub",
  "sup",
  "font",
  "center",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "img",
  "a",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "hr",
  "pre",
  "code",
  "em",
  "strong",
  "b",
  "i",
  "small",
]);

const VOID_TAGS = new Set(["br", "hr", "img"]);

const ALLOWED_ATTRS = new Set([
  "href",
  "src",
  "alt",
  "title",
  "class",
  "id",
  "style",
  "colspan",
  "rowspan",
  "open",
  "color",
  "size",
  "align",
  "width",
  "height",
]);

function isSafeUrl(value: string, kind: "href" | "src"): boolean {
  const v = value.trim();
  if (!v) return false;
  const lower = v.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("vbscript:") ||
    lower.startsWith("data:text/html")
  ) {
    return false;
  }
  if (kind === "src") {
    if (lower.startsWith("data:image/")) return true;
    if (lower.startsWith("http://") || lower.startsWith("https://")) return false;
    return !lower.includes("://") || lower.startsWith("asset:");
  }
  // href
  if (lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:")) {
    return true;
  }
  if (lower.startsWith("#")) return true;
  return !lower.includes("://");
}

function sanitizeStyle(style: string): string {
  // 去掉 expression / url(javascript) 等
  const cleaned = style
    .replace(/expression\s*\(/gi, "")
    .replace(/url\s*\(\s*['"]?\s*javascript:/gi, "url(")
    .replace(/-moz-binding/gi, "");
  return cleaned.slice(0, 400);
}

function sanitizeElement(el: Element): void {
  const tag = el.tagName.toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) {
    // 用文本内容替换危险节点
    const text = document.createTextNode(el.textContent ?? "");
    el.replaceWith(text);
    return;
  }

  // 去掉事件与未知属性
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith("on") || name === "srcdoc") {
      el.removeAttribute(attr.name);
      continue;
    }
    if (!ALLOWED_ATTRS.has(name)) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (name === "href" && !isSafeUrl(attr.value, "href")) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (name === "src" && !isSafeUrl(attr.value, "src")) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (name === "style") {
      el.setAttribute("style", sanitizeStyle(attr.value));
    }
  }

  for (const child of Array.from(el.children)) {
    sanitizeElement(child);
  }
}

/** 将原始 HTML 消毒为可安全 innerHTML 的字符串。 */
export function sanitizeHtml(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  // 单独 void 标签
  const voidOnly = /^<(br|hr)\s*\/?>$/i.exec(trimmed);
  if (voidOnly) {
    return `<${voidOnly[1]!.toLowerCase()}>`;
  }

  const template = document.createElement("template");
  template.innerHTML = trimmed;

  for (const child of Array.from(template.content.children)) {
    sanitizeElement(child);
  }

  // 清理残留 script/style/iframe
  template.content
    .querySelectorAll("script,iframe,object,embed,link,meta")
    .forEach((n) => n.remove());

  return template.innerHTML;
}

export function isLikelyHtmlSnippet(value: string): boolean {
  return /<\/?[a-zA-Z][^>]*>/.test(value);
}

export { VOID_TAGS };

/**
 * HTML-in-MD 消毒：以 WebView2 原生解析为准。
 * 仅剥离 XSS 向量（script/事件/javascript:），不把合法标签/属性砍成窄白名单。
 */

import { markFlexContainers } from "./enhanceHtml";

const VOID_TAGS = new Set(["br", "hr", "img", "source", "wbr", "col", "area", "base", "meta", "link"]);

/** 绝对禁止：可执行 / 导航劫持 / 表单控件（编辑器内不当） */
const FORBIDDEN_TAGS = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "style", // 外联/内联 <style> 块；元素 style 属性仍保留
  "base",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "svg", // 简化：避免 foreignObject/script；GitHub README 图墙不依赖 svg 标签
  "math",
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
    if (lower.startsWith("http://") || lower.startsWith("https://")) return true;
    if (lower.startsWith("blob:")) return true;
    return !lower.includes("://") || lower.startsWith("asset:");
  }
  if (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("mailto:")
  ) {
    return true;
  }
  if (lower.startsWith("#")) return true;
  return !lower.includes("://");
}

function sanitizeStyle(style: string): string {
  // 只去掉可执行 CSS；完整保留 flex/grid/writing-mode 等布局声明（交给 WebView2）
  return style
    .replace(/expression\s*\(/gi, "")
    .replace(/url\s*\(\s*['"]?\s*javascript:/gi, "url(")
    .replace(/-moz-binding/gi, "")
    .replace(/behavior\s*:/gi, "")
    .replace(/-o-link\s*:/gi, "")
    .slice(0, 4000);
}

function sanitizeElement(el: Element): void {
  const tag = el.tagName.toLowerCase();
  if (FORBIDDEN_TAGS.has(tag)) {
    el.remove();
    return;
  }

  // 保留 WebView2 能解析的任意安全标签；只清危险属性
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith("on") || name === "srcdoc" || name === "xlink:href") {
      el.removeAttribute(attr.name);
      continue;
    }
    if (name === "href" && !isSafeUrl(attr.value, "href")) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (
      (name === "src" || name === "srcset") &&
      !isSafeUrl(attr.value.split(/[\s,]+/)[0] ?? "", "src")
    ) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (name === "style") {
      el.setAttribute("style", sanitizeStyle(attr.value));
    }
    // 其它属性（class/id/width/target/data-* / aria-* …）原样保留
  }

  for (const child of Array.from(el.children)) {
    sanitizeElement(child);
  }
}

/**
 * 用 WebView2/Chromium 的 HTML 解析器（template.innerHTML）解析，
 * 仅做 XSS 擦除后写回。
 */
export function sanitizeHtml(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const voidOnly = /^<(br|hr)\s*\/?>$/i.exec(trimmed);
  if (voidOnly) {
    return `<${voidOnly[1]!.toLowerCase()}>`;
  }

  // WebView2 原生解析
  const template = document.createElement("template");
  template.innerHTML = trimmed;

  for (const child of Array.from(template.content.children)) {
    sanitizeElement(child);
  }

  template.content
    .querySelectorAll("script,iframe,object,embed,link,meta,base,style")
    .forEach((n) => n.remove());

  markFlexContainers(template.content);

  return template.innerHTML;
}

export function isLikelyHtmlSnippet(value: string): boolean {
  return /<\/?[a-zA-Z][^>]*>/.test(value);
}

export { VOID_TAGS };

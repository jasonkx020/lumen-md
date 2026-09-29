/** 强化 HTML 片段：识别 flex 容器并打稳定 class，便于预览/导出 CSS。 */

const FLEX_CLASS = "lumen-html-flex";

function styleLooksFlex(style: string): boolean {
  const s = style.replace(/\s+/g, "").toLowerCase();
  return (
    s.includes("display:flex") ||
    s.includes("display:inline-flex") ||
    /display:(-webkit-)?flex/.test(s)
  );
}

/** 在 DOM 根下为 flex 容器打 class（不改原有 style）。 */
export function markFlexContainers(root: ParentNode): void {
  const els = root.querySelectorAll
    ? root.querySelectorAll<HTMLElement>("[style]")
    : [];
  for (const el of Array.from(els)) {
    const style = el.getAttribute("style") ?? "";
    if (!styleLooksFlex(style)) continue;
    el.classList.add(FLEX_CLASS);
    // 确保 display 不会被主题 CSS 冲掉：写回规范化 style（保留其它声明）
    if (!/display\s*:\s*[^;]*flex/i.test(style)) {
      el.style.display = "flex";
    }
  }
}

/** 对 HTML 字符串消毒后增强，返回可 innerHTML 的片段。 */
export function enhanceHtmlFragment(html: string): string {
  if (!html || !html.includes("<")) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  markFlexContainers(template.content);
  return template.innerHTML;
}

export { FLEX_CLASS };

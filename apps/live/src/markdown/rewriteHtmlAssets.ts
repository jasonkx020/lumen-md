/** 将 HTML 预览节点内的相对路径 img/src 解析为可显示的 data URL。 */

import { resolveAssetUrl } from "../assets/saveAsset";
import { getHtmlAssetDocAbs } from "./htmlAssetContext";

const ORIGIN_ATTR = "data-md-src";

function needsResolve(src: string): boolean {
  const s = src.trim();
  if (!s) return false;
  if (
    s.startsWith("data:") ||
    s.startsWith("blob:") ||
    s.startsWith("http://") ||
    s.startsWith("https://") ||
    s.startsWith("asset:")
  ) {
    return false;
  }
  return true;
}

function collectImgs(root: ParentNode): HTMLImageElement[] {
  const out: HTMLImageElement[] = [];
  const visit = (node: ParentNode) => {
    if (node instanceof Element || node instanceof DocumentFragment) {
      out.push(
        ...Array.from(
          node.querySelectorAll<HTMLImageElement>("img[src], img[data-md-src]"),
        ),
      );
    }
    // 穿透 open shadow（块级 HTML NodeView）
    const kids =
      node instanceof Element || node instanceof DocumentFragment
        ? Array.from(node.querySelectorAll("*"))
        : [];
    for (const el of kids) {
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(root);
  return out;
}

/** 异步改写 root（含 open shadow）下 img[src]；失败则保留原 src。 */
export async function rewriteHtmlImgSrcs(
  root: HTMLElement | ParentNode,
  docAbs?: string | null,
): Promise<void> {
  const imgs = collectImgs(root);
  if (imgs.length === 0) return;
  const base = docAbs !== undefined ? docAbs : getHtmlAssetDocAbs();
  await Promise.all(
    imgs.map(async (img) => {
      const origin = img.getAttribute(ORIGIN_ATTR);
      const current = img.getAttribute("src") ?? "";
      const src = origin || current;
      if (!src) return;
      if (!needsResolve(src)) return;
      if (!origin) img.setAttribute(ORIGIN_ATTR, src);
      try {
        const url = await resolveAssetUrl(src, base);
        if (url) img.setAttribute("src", url);
      } catch {
        /* 保留原路径 */
      }
    }),
  );
}

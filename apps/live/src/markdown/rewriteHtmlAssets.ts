/** 将 HTML 预览节点内的相对路径 / 远程 img 解析为可显示的同源 URL。 */

import { cacheRemoteImage, resolveAssetUrl } from "../assets/saveAsset";
import { getHtmlAssetDocAbs } from "./htmlAssetContext";
import { applyPictureTheme, isAppThemeDark } from "./pictureTheme";

export const ORIGIN_ATTR = "data-md-src";

function needsLocalResolve(src: string): boolean {
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

function isRemoteHttp(src: string): boolean {
  const s = src.trim().toLowerCase();
  return s.startsWith("http://") || s.startsWith("https://");
}

export function collectImgs(root: ParentNode): HTMLImageElement[] {
  const out: HTMLImageElement[] = [];
  const visit = (node: ParentNode) => {
    if (node instanceof Element || node instanceof DocumentFragment) {
      out.push(
        ...Array.from(
          node.querySelectorAll<HTMLImageElement>("img[src], img[data-md-src]"),
        ),
      );
    }
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

/**
 * 先按应用主题解析 picture，再把本地相对路径 / 远程 http(s) 换成同源 data URL。
 */
export async function rewriteHtmlImgSrcs(
  root: HTMLElement | ParentNode,
  docAbs?: string | null,
  isDark?: boolean,
): Promise<void> {
  const dark = isDark ?? isAppThemeDark();
  applyPictureTheme(root, dark);

  const imgs = collectImgs(root);
  if (imgs.length === 0) return;
  const base = docAbs !== undefined ? docAbs : getHtmlAssetDocAbs();
  await Promise.all(
    imgs.map(async (img) => {
      const origin = img.getAttribute(ORIGIN_ATTR);
      const current = img.getAttribute("src") ?? "";
      const src = (origin || current).trim();
      if (!src) return;

      if (needsLocalResolve(src)) {
        if (!origin) img.setAttribute(ORIGIN_ATTR, src);
        try {
          const url = await resolveAssetUrl(src, base);
          if (url) img.setAttribute("src", url);
        } catch {
          /* 保留原路径 */
        }
        return;
      }

      if (isRemoteHttp(src)) {
        if (!origin) img.setAttribute(ORIGIN_ATTR, src);
        // 已是同源 data URL 且 origin 未变则跳过
        if (current.startsWith("data:") && origin === src) return;
        try {
          const dataUrl = await cacheRemoteImage(src);
          if (dataUrl) img.setAttribute("src", dataUrl);
        } catch {
          /* 保留 https，由 WebView 直拉 */
        }
      }
    }),
  );
}

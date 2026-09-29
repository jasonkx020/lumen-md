/** 从编辑器 DOM（含 shadow）抓取已渲染图片为 PNG data URL，供 DOCX 与预览对齐。 */

import { collectImgs, ORIGIN_ATTR } from "../markdown/rewriteHtmlAssets";
import { firstSrcsetUrl } from "../markdown/pictureTheme";

function exportKeysForImg(img: HTMLImageElement): string[] {
  const keys = new Set<string>();
  const origin = img.getAttribute(ORIGIN_ATTR)?.trim();
  if (origin) keys.add(origin);

  const picture = img.closest("picture");
  if (picture) {
    for (const source of Array.from(
      picture.querySelectorAll<HTMLSourceElement>("source[srcset]"),
    )) {
      const u = firstSrcsetUrl(source.getAttribute("srcset") ?? "");
      if (u) keys.add(u);
    }
  }

  const rawSrc = img.getAttribute("src")?.trim() ?? "";
  if (
    rawSrc &&
    !rawSrc.startsWith("data:") &&
    !rawSrc.startsWith("blob:") &&
    !rawSrc.startsWith("asset:")
  ) {
    keys.add(rawSrc);
  }

  return [...keys];
}

function imgToPngDataUrl(img: HTMLImageElement): string | null {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return null;
  const canvas = document.createElement("canvas");
  const maxEdge = 1600;
  let cw = w;
  let ch = h;
  if (cw > maxEdge || ch > maxEdge) {
    const scale = maxEdge / Math.max(cw, ch);
    cw = Math.max(1, Math.round(cw * scale));
    ch = Math.max(1, Math.round(ch * scale));
  }
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(img, 0, 0, cw, ch);
    return canvas.toDataURL("image/png");
  } catch {
    // 跨域污染等
    return null;
  }
}

/**
 * 返回 URL → PNG data URL。同一 picture 的多个 source URL 会映射到同一张已显示图。
 */
export async function captureRenderedImages(
  root: ParentNode | null | undefined,
): Promise<Record<string, string>> {
  if (!root) return {};
  const imgs = collectImgs(root);
  const out: Record<string, string> = {};

  await Promise.all(
    imgs.map(async (img) => {
      try {
        if (!img.complete || img.naturalWidth === 0) {
          await img.decode().catch(() => undefined);
        }
      } catch {
        /* ignore */
      }
      const png = imgToPngDataUrl(img);
      if (!png) return;
      for (const key of exportKeysForImg(img)) {
        if (key.startsWith("http://") || key.startsWith("https://") || key.startsWith("data:")) {
          out[key] = png;
        }
      }
    }),
  );

  return out;
}

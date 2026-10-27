/**
 * DOCX 导出前：把 Markdown 中的 LaTeX 公式栅格化为 PNG，
 * 并以相对路径占位 + imageOverrides 交给 Rust（避免 ammonia 剥掉 data: URL）。
 */

import katex from "katex";
import { getFontEmbedCSS, toPng } from "html-to-image";
import "katex/dist/katex.min.css";
import { collectMathSpans } from "./mathSpans";

export type { MathSpan } from "./mathSpans";
export { collectMathSpans } from "./mathSpans";

export type MathForDocx = {
  markdown: string;
  /** 占位 src → PNG data URL */
  imageOverrides: Record<string, string>;
};

function sleepFrame(): Promise<void> {
  return new Promise<void>((r) => requestAnimationFrame(() => r()));
}

async function captureKatexPng(target: HTMLElement): Promise<string | null> {
  try {
    let fontEmbedCSS: string | undefined;
    try {
      fontEmbedCSS = await getFontEmbedCSS(target);
    } catch {
      fontEmbedCSS = undefined;
    }
    const dataUrl = await toPng(target, {
      pixelRatio: 2,
      backgroundColor: "#ffffff",
      cacheBust: true,
      ...(fontEmbedCSS ? { fontEmbedCSS } : {}),
    });
    return dataUrl || null;
  } catch {
    return null;
  }
}

async function texToPngDataUrl(
  tex: string,
  displayMode: boolean,
): Promise<string | null> {
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:-100000px;top:0;padding:6px 8px;background:#ffffff;color:#24292f;z-index:-1;";
  document.body.appendChild(host);
  try {
    katex.render(tex.trim(), host, {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      output: "html",
    });
    await document.fonts.ready;
    await sleepFrame();
    await sleepFrame();

    const katexEl = host.querySelector(".katex") as HTMLElement | null;
    if (katexEl) {
      const first = await captureKatexPng(katexEl);
      if (first) return first;
    }

    // 简化再试：去掉多余 padding，整宿主栅格
    host.style.padding = "2px 4px";
    await sleepFrame();
    const second = await captureKatexPng(katexEl || host);
    return second;
  } catch {
    return null;
  } finally {
    host.remove();
  }
}

function imgHtml(src: string, tex: string, display: boolean): string {
  const alt = tex.replace(/"/g, "'").slice(0, 120);
  if (display) {
    return `<p align="center"><img src="${src}" alt="${alt}" /></p>\n\n`;
  }
  return `<img src="${src}" alt="${alt}" style="vertical-align:middle;height:1.2em;" />`;
}

/** PNG 失败时：换成可读 `$…$` / `$$…$$`，避免 ```LaTeX 围栏落成普通代码块。 */
function textFallbackHtml(tex: string, display: boolean): string {
  const t = tex.trim();
  if (display) {
    return `\n\n$$${t}$$\n\n`;
  }
  return `$${t}$`;
}

/**
 * 将 markdown 中的公式替换为占位图 HTML，并返回 PNG overrides。
 */
export async function renderMathForDocx(markdown: string): Promise<MathForDocx> {
  const spans = collectMathSpans(markdown);
  if (spans.length === 0) {
    return { markdown, imageOverrides: {} };
  }

  const imageOverrides: Record<string, string> = {};
  let out = markdown;
  let seq = 0;

  for (let k = spans.length - 1; k >= 0; k--) {
    const span = spans[k]!;
    const png = await texToPngDataUrl(span.tex, span.display);
    if (png) {
      const key = `__lumen_math__/${seq}.png`;
      seq += 1;
      imageOverrides[key] = png;
      out =
        out.slice(0, span.start) +
        imgHtml(key, span.tex, span.display) +
        out.slice(span.end);
    } else {
      out =
        out.slice(0, span.start) +
        textFallbackHtml(span.tex, span.display) +
        out.slice(span.end);
    }
  }

  return { markdown: out, imageOverrides };
}

/** 按应用主题（非系统 prefers-color-scheme）解析 `<picture>` / `<source>`。 */

const ORIGIN_ATTR = "data-md-src";

function collectPictures(root: ParentNode): HTMLPictureElement[] {
  const out: HTMLPictureElement[] = [];
  const visit = (node: ParentNode) => {
    if (node instanceof Element || node instanceof DocumentFragment) {
      out.push(...Array.from(node.querySelectorAll("picture")));
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

/** 取 srcset 中第一个 URL（忽略 descriptor）。 */
export function firstSrcsetUrl(srcset: string): string | null {
  const part = srcset.split(",")[0]?.trim();
  if (!part) return null;
  const url = part.split(/\s+/)[0]?.trim();
  return url || null;
}

function sourceMatchesScheme(media: string, wantDark: boolean): boolean {
  const m = media.toLowerCase();
  if (!m.includes("prefers-color-scheme")) return false;
  if (wantDark) {
    return m.includes("dark") && !m.includes("light");
  }
  return m.includes("light") && !m.includes("dark");
}

/**
 * 用应用 isDark 强制选择 picture 内对应 source，写入 img.src / data-md-src。
 * 浏览器原生 media 只认系统偏好，与 Live 的 data-theme 无关。
 */
export function applyPictureTheme(
  root: HTMLElement | ParentNode,
  isDark: boolean,
): void {
  for (const picture of collectPictures(root)) {
    const sources = Array.from(
      picture.querySelectorAll<HTMLSourceElement>("source[srcset]"),
    );
    let chosen: string | null = null;
    for (const source of sources) {
      const media = source.getAttribute("media") ?? "";
      if (!media) continue;
      if (sourceMatchesScheme(media, isDark)) {
        chosen = firstSrcsetUrl(source.getAttribute("srcset") ?? "");
        if (chosen) break;
      }
    }
    if (!chosen) {
      // 无 media 匹配时：优先无 media 的 source，再回退 img[src]
      for (const source of sources) {
        const media = (source.getAttribute("media") ?? "").trim();
        if (media) continue;
        chosen = firstSrcsetUrl(source.getAttribute("srcset") ?? "");
        if (chosen) break;
      }
    }
    const img = picture.querySelector("img");
    if (!img) continue;
    if (!chosen) {
      const fallback = img.getAttribute(ORIGIN_ATTR) || img.getAttribute("src");
      if (!fallback) continue;
      chosen = fallback;
    }
    const prevOrigin = img.getAttribute(ORIGIN_ATTR);
    if (prevOrigin !== chosen) {
      img.setAttribute(ORIGIN_ATTR, chosen);
    }
    if (img.getAttribute("src") !== chosen) {
      img.setAttribute("src", chosen);
    }
  }
}

/** 从 documentElement.dataset.theme 推断是否暗色（与 App 写入约定一致）。 */
export function isAppThemeDark(): boolean {
  const id = document.documentElement.dataset.theme ?? "";
  return (
    id === "as-dark" ||
    id === "as-darcula" ||
    id === "as-high-contrast" ||
    id === "dark"
  );
}

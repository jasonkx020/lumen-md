import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import {
  extractOutline,
  findHeadingByAnchor,
  type OutlineHeading,
} from "../markdown/extractOutline";

export type ResolveDocLinkResult = {
  kind: "anchor" | "local" | "external" | "missing" | "denied";
  rel_path: string | null;
  abs_path: string | null;
  exists: boolean;
  open_url: string | null;
  message: string | null;
};

export type LinkOpenHandlers = {
  markdown: string;
  baseRel?: string | null;
  baseAbs?: string | null;
  onAnchor: (heading: OutlineHeading) => void;
  onOpenLocal: (opts: {
    relPath?: string;
    absPath?: string;
  }) => void | Promise<void>;
  onStatus: (msg: string) => void;
};

export async function resolveDocLink(args: {
  href: string;
  baseRel?: string | null;
  baseAbs?: string | null;
}): Promise<ResolveDocLinkResult> {
  return invoke("resolve_doc_link", {
    href: args.href,
    baseRel: args.baseRel ?? null,
    baseAbs: args.baseAbs ?? null,
  });
}

/** 处理文档内链接：锚点 → 本地 md → http(s) 浏览器。 */
export async function handleDocLinkClick(
  href: string,
  handlers: LinkOpenHandlers,
): Promise<void> {
  const trimmed = href.trim();
  if (!trimmed || trimmed === "#") return;

  if (trimmed.startsWith("#")) {
    const headings = extractOutline(handlers.markdown);
    const hit = findHeadingByAnchor(headings, trimmed);
    if (hit) {
      handlers.onAnchor(hit);
      handlers.onStatus(`跳转到「${hit.text}」`);
    } else {
      handlers.onStatus(`未找到锚点: ${trimmed}`);
    }
    return;
  }

  let result: ResolveDocLinkResult;
  try {
    result = await resolveDocLink({
      href: trimmed,
      baseRel: handlers.baseRel,
      baseAbs: handlers.baseAbs,
    });
  } catch (e) {
    handlers.onStatus(`链接解析失败: ${e}`);
    return;
  }

  switch (result.kind) {
    case "anchor": {
      const headings = extractOutline(handlers.markdown);
      const hit = findHeadingByAnchor(headings, trimmed);
      if (hit) handlers.onAnchor(hit);
      break;
    }
    case "local":
      await handlers.onOpenLocal({
        relPath: result.rel_path ?? undefined,
        absPath: result.abs_path ?? undefined,
      });
      handlers.onStatus(
        `已打开本地文档 ${result.rel_path ?? result.abs_path ?? ""}`,
      );
      break;
    case "external":
      if (result.open_url) {
        try {
          await openUrl(result.open_url);
          handlers.onStatus(`已在浏览器打开`);
        } catch (e) {
          handlers.onStatus(`打开浏览器失败: ${e}`);
        }
      }
      break;
    case "missing":
      handlers.onStatus(
        result.message ?? `未找到本地文档: ${trimmed}`,
      );
      break;
    case "denied":
      handlers.onStatus(result.message ?? "链接路径被拒绝");
      break;
    default:
      handlers.onStatus(`无法处理链接: ${trimmed}`);
  }
}

export function findAnchorFromEvent(target: EventTarget | null): string | null {
  let el = target as HTMLElement | null;
  while (el && el !== document.body) {
    if (el.tagName === "A") {
      const a = el as HTMLAnchorElement;
      const href =
        a.getAttribute("href") ||
        a.dataset.href ||
        a.getAttribute("data-link") ||
        "";
      return href || null;
    }
    el = el.parentElement;
  }
  return null;
}

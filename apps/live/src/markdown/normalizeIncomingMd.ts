/**
 * 进入 Crepe / AI 写回前的 Markdown 规范化（与全文插入路径一致）。
 */
import { normalizeMermaidFencesInMarkdown } from "../diagrams/normalizeMermaidMd";
import { encodeImageAltForCrepe } from "./crepeImageAlt";
import { normalizeGfmTables } from "./normalizeGfmTables";
import { normalizeGithubHtml } from "./normalizeGithubHtml";

/** GFM 表 / GitHub HTML / Mermaid 围栏 / image-block alt 编码。 */
export function normalizeIncomingMarkdown(md: string): string {
  return encodeImageAltForCrepe(
    normalizeMermaidFencesInMarkdown(
      normalizeGithubHtml(normalizeGfmTables(md)),
    ),
  );
}

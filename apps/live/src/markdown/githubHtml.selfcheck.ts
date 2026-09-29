/**
 * GitHub README HTML-in-MD 自检（块级分流 + 规范化）。
 * 在有 DOM 的环境运行，或与 sanitize selfcheck 一并调用。
 */
import { isBlockHtml } from "./htmlBlockNodes";
import { normalizeGithubHtml } from "./normalizeGithubHtml";
import { mergeInlineHtmlTree } from "./remarkMergeInlineHtml";
import { sanitizeHtml } from "./sanitizeHtml";

/** xiaozhi-esp32 README 代表性片段 */
const XIAOZHI_FRAGMENTS = {
  heroImg: `<img src="docs/mcp-based-graph.jpg" alt="MCP" width="600">`,
  flexWall: `<div style="display: flex;">
  <img src="docs/v2/atom1.jpg" alt="atom1" height="200">
  <img src="docs/v2/atom2.jpg" alt="atom2" height="200">
</div>`,
  listLink: `- <a href="https://example.com" target="_blank">文档</a>`,
  starHistory: `<a href="https://star-history.com/#78/xiaozhi-esp32&Date">
  <img src="https://api.star-history.com/svg?repos=78/xiaozhi-esp32&type=Date" alt="Star History Chart">
</a>`,
};

export function runGithubHtmlSelfCheck(): string[] {
  const errors: string[] = [];

  if (!isBlockHtml(XIAOZHI_FRAGMENTS.heroImg)) {
    errors.push("hero img should be block html");
  }
  if (!isBlockHtml(XIAOZHI_FRAGMENTS.flexWall)) {
    errors.push("flex div should be block html");
  }
  if (isBlockHtml('<br>')) {
    errors.push("br should stay inline");
  }
  if (isBlockHtml('<span style="color:red">x</span>')) {
    errors.push("span should stay inline");
  }
  if (!isBlockHtml(XIAOZHI_FRAGMENTS.starHistory)) {
    errors.push("star-history anchor block should be block (multiline)");
  }

  const md = [
    "# Title",
    XIAOZHI_FRAGMENTS.heroImg,
    "",
    "## Hardware",
    XIAOZHI_FRAGMENTS.flexWall,
    "",
    XIAOZHI_FRAGMENTS.listLink,
    "",
    XIAOZHI_FRAGMENTS.starHistory,
  ].join("\n");

  const normalized = normalizeGithubHtml(md);
  // 独立 img 前后应有空行分隔（不与 # Title 粘连）
  if (!/# Title\n\n<img/.test(normalized) && !/# Title\r?\n\r?\n<img/.test(normalized)) {
    // 允许 Title 后已有空行被 normalize 保持
    if (!normalized.includes("\n\n<img src=\"docs/mcp-based-graph.jpg\"")) {
      errors.push("hero img not blank-line isolated");
    }
  }
  if (!normalized.includes("display: flex")) {
    errors.push("flex wall lost in normalize");
  }

  const safeHero = sanitizeHtml(XIAOZHI_FRAGMENTS.heroImg);
  if (!safeHero.includes("docs/mcp-based-graph.jpg")) {
    errors.push("sanitize strips relative hero img");
  }
  const safeFlex = sanitizeHtml(XIAOZHI_FRAGMENTS.flexWall);
  if (!safeFlex.includes("docs/v2/atom1.jpg")) {
    errors.push("sanitize strips flex wall imgs");
  }
  const safeStar = sanitizeHtml(
    `<img src="https://api.star-history.com/svg?repos=78/xiaozhi-esp32&type=Date" alt="x">`,
  );
  if (!safeStar.includes("https://api.star-history.com")) {
    errors.push("sanitize strips star-history https img");
  }

  // 往返：规范化不应把 HTML 改成 MD 图片语法
  if (normalized.includes("![") && normalized.includes("](docs/mcp")) {
    errors.push("normalize rewrote HTML img to markdown image");
  }

  // 行内 <a>text</a> 必须合并，否则预览锚点无文本/不可点
  const linkTree = {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [
          {
            type: "html",
            value: '<a href="https://example.com" target="_blank">',
          },
          { type: "text", value: "LiChuang" },
          { type: "html", value: "</a>" },
        ],
      },
    ],
  };
  mergeInlineHtmlTree(linkTree);
  const merged = linkTree.children[0]?.children;
  if (
    !merged ||
    merged.length !== 1 ||
    merged[0]?.type !== "html" ||
    !String(merged[0]?.value).includes("LiChuang") ||
    !String(merged[0]?.value).includes("https://example.com")
  ) {
    errors.push("inline <a>text</a> not merged into one html node");
  }

  return errors;
}

/**
 * 轻量自检：在浏览器/DOM 环境下验证消毒结果。
 * 运行：在 Vite 开发页控制台粘贴，或后续接入 vitest。
 */
import { sanitizeHtml } from "./sanitizeHtml";
import { extractOutline } from "./extractOutline";
import { isTableHtml, parseHtmlTable } from "./htmlTable";
import { runGithubHtmlSelfCheck } from "./githubHtml.selfcheck";
import { runPictureThemeSelfCheck } from "./pictureTheme.selfcheck";

export function runSanitizeSelfCheck(): string[] {
  const errors: string[] = [];
  const br = sanitizeHtml("<br>");
  if (!br.toLowerCase().includes("br")) errors.push("br not kept");

  const details = sanitizeHtml(
    "<details><summary>x</summary><p>y</p></details>",
  );
  if (!details.includes("details")) errors.push("details not kept");

  const colored = sanitizeHtml('<span style="color: #0f766e">teal text</span>');
  if (!colored.includes("teal")) errors.push("span text lost");

  const danger = sanitizeHtml('<script>alert(1)</script><p>ok</p>');
  if (danger.toLowerCase().includes("script")) errors.push("script leaked");
  if (!danger.includes("ok")) errors.push("safe p lost");

  const table = sanitizeHtml(
    '<table style="writing-mode: vertical-rl"><tr><th>甲</th><td>一</td></tr></table>',
  );
  if (!table.toLowerCase().includes("<table")) errors.push("table not kept");
  if (!table.includes("甲")) errors.push("table cell text lost");

  const localImg = sanitizeHtml(
    '<img src="docs/mcp-based-graph.jpg" alt="x" width="320">',
  );
  if (!localImg.includes("docs/mcp-based-graph.jpg")) {
    errors.push("relative img src stripped");
  }

  const remoteImg = sanitizeHtml(
    '<img src="https://api.star-history.com/svg?repos=78/xiaozhi-esp32&type=Date" alt="stars">',
  );
  if (!remoteImg.includes("https://api.star-history.com")) {
    errors.push("https img src stripped");
  }

  const linkTarget = sanitizeHtml(
    '<a href="https://example.com" target="_blank" rel="noopener">x</a>',
  );
  if (!linkTarget.includes('target="_blank"')) {
    errors.push("target attr stripped");
  }

  const flexGallery = sanitizeHtml(
    '<div style="display: flex"><img src="docs/a.jpg"><img src="docs/b.jpg"></div>',
  );
  if (!flexGallery.includes("docs/a.jpg") || !flexGallery.includes("docs/b.jpg")) {
    errors.push("flex gallery img src stripped");
  }
  if (!flexGallery.includes("lumen-html-flex")) {
    errors.push("flex gallery missing lumen-html-flex class");
  }

  const sample = `<table><tr><td rowspan="2">A</td><td>B</td></tr><tr><td>C</td></tr></table>`;
  if (!isTableHtml(sample)) errors.push("isTableHtml failed");
  const parsed = parseHtmlTable(sample);
  if (!parsed || parsed.length !== 2) errors.push("parseHtmlTable rows");
  if (parsed?.[0]?.[0]?.rowspan !== 2) errors.push("parseHtmlTable rowspan");

  const outline = extractOutline(
    "# A\n```\n# not\n```\n## B\n",
  );
  if (outline.length !== 2) errors.push("outline fence skip failed");
  if (outline[0]?.text !== "A" || outline[1]?.text !== "B") {
    errors.push("outline titles wrong");
  }

  const picture = sanitizeHtml(
    `<a href="https://star-history.com">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=78/xiaozhi-esp32&type=Date&theme=dark" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=78/xiaozhi-esp32&type=Date" />
 </picture>
</a>`,
  );
  if (!picture.includes("api.star-history.com")) {
    errors.push("star-history picture/img stripped");
  }

  errors.push(...runGithubHtmlSelfCheck().map((e) => `githubHtml:${e}`));
  errors.push(...runPictureThemeSelfCheck().map((e) => `pictureTheme:${e}`));

  return errors;
}

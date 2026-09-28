/**
 * 轻量自检：在浏览器/DOM 环境下验证消毒结果。
 * 运行：在 Vite 开发页控制台粘贴，或后续接入 vitest。
 */
import { sanitizeHtml } from "./sanitizeHtml";
import { extractOutline } from "./extractOutline";

export function runSanitizeSelfCheck(): string[] {
  const errors: string[] = [];
  const br = sanitizeHtml("<br>");
  if (!br.toLowerCase().includes("br")) errors.push("br not kept");

  const details = sanitizeHtml(
    "<details><summary>x</summary><p>y</p></details>",
  );
  if (!details.includes("details")) errors.push("details not kept");

  const colored = sanitizeHtml('<span style="color: #0f766e">teal</span>');
  if (!colored.includes("teal")) errors.push("span text lost");

  const danger = sanitizeHtml('<script>alert(1)</script><p>ok</p>');
  if (danger.toLowerCase().includes("script")) errors.push("script leaked");
  if (!danger.includes("ok")) errors.push("safe p lost");

  const table = sanitizeHtml(
    '<table style="writing-mode: vertical-rl"><tr><th>甲</th><td>一</td></tr></table>',
  );
  if (!table.toLowerCase().includes("<table")) errors.push("table not kept");
  if (!table.includes("甲")) errors.push("table cell text lost");

  const outline = extractOutline(
    "# A\n```\n# not\n```\n## B\n",
  );
  if (outline.length !== 2) errors.push("outline fence skip failed");
  if (outline[0]?.text !== "A" || outline[1]?.text !== "B") {
    errors.push("outline titles wrong");
  }

  return errors;
}

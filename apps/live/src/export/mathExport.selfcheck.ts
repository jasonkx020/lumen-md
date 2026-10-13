/** 公式导出：解析区间自检（无需 DOM / KaTeX 栅格）。 */
import { collectMathSpans } from "./mathSpans";

export function runMathExportSelfCheck(): string[] {
  const errors: string[] = [];

  const inline = collectMathSpans("a $E=mc^2$ b");
  if (inline.length !== 1 || inline[0]?.tex !== "E=mc^2" || inline[0]?.display) {
    errors.push(`inline math: ${JSON.stringify(inline)}`);
  }

  const display = collectMathSpans("x\n\n$$a^2+b^2$$\n\ny");
  if (
    display.length !== 1 ||
    display[0]?.tex.trim() !== "a^2+b^2" ||
    !display[0]?.display
  ) {
    errors.push(`display math: ${JSON.stringify(display)}`);
  }

  const fenced = collectMathSpans("```math\n\\frac{1}{2}\n```\n");
  if (
    fenced.length !== 1 ||
    !fenced[0]?.tex.includes("\\frac{1}{2}") ||
    !fenced[0]?.display
  ) {
    errors.push(`fenced math: ${JSON.stringify(fenced)}`);
  }

  const skipCode = collectMathSpans("```js\nconst x = '$not$'\n```\nreal $ok$\n");
  if (skipCode.length !== 1 || skipCode[0]?.tex !== "ok") {
    errors.push(`should skip code fence dollars: ${JSON.stringify(skipCode)}`);
  }

  return errors;
}

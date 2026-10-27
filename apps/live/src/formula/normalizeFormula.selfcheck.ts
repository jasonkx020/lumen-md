/** 公式规范化纯函数自检（无需 DOM / KaTeX）。 */
import {
  ensureFormulaMarkdown,
  extractFormulaLatex,
  looksLikeBareLatex,
} from "./normalizeFormulaMd";

export function runNormalizeFormulaSelfcheck(): string[] {
  const errors: string[] = [];

  const aligned = [
    "\\begin{aligned}",
    "&\\mathrm{鲜到家} \\\\",
    "&\\mathrm{村口新鲜} \\\\",
    "&\\mathrm{乡鲜生} \\\\",
    "&\\mathrm{田间直达}",
    "\\end{aligned}",
  ].join("\n");

  if (!looksLikeBareLatex(aligned)) {
    errors.push("looksLikeBareLatex should accept aligned+Chinese");
  }

  const extracted = extractFormulaLatex(aligned);
  if (extracted !== aligned) {
    errors.push(`extract bare aligned failed: ${JSON.stringify(extracted)}`);
  }

  const ensured = ensureFormulaMarkdown(aligned);
  if (!ensured.startsWith("$$") || !ensured.includes("鲜到家")) {
    errors.push(`ensure wrap failed: ${JSON.stringify(ensured)}`);
  }

  const already = `$$\n${aligned}\n$$`;
  if (ensureFormulaMarkdown(already) !== already.trim()) {
    errors.push("ensure should be idempotent for $$");
  }

  const fenced = "```latex\n\\frac{1}{2}\n```";
  if (extractFormulaLatex(fenced) !== "\\frac{1}{2}") {
    errors.push("extract latex fence failed");
  }

  const bracket = "\\[a^2+b^2\\]";
  const bracketOut = ensureFormulaMarkdown(bracket);
  if (!bracketOut.includes("a^2+b^2") || !bracketOut.includes("$$")) {
    errors.push(`\\[\\] convert failed: ${bracketOut}`);
  }

  const withProse = `品牌名：\n${aligned}\n`;
  const fromProse = extractFormulaLatex(withProse);
  if (!fromProse || !fromProse.includes("\\begin{aligned}")) {
    errors.push("extract from short prose failed");
  }

  const notFormula = "请帮我写一段产品介绍，包含鲜到家四个字。";
  if (looksLikeBareLatex(notFormula) || extractFormulaLatex(notFormula)) {
    errors.push("should not treat Chinese prose as latex");
  }

  // 幂等：ensure 后再 extract
  const round = extractFormulaLatex(ensureFormulaMarkdown(aligned));
  if (!round || !round.includes("田间直达")) {
    errors.push("roundtrip extract after ensure failed");
  }

  return errors;
}

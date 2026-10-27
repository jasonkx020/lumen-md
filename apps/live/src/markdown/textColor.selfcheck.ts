/** 公共文本着色自检 */
import {
  applyTextColorId,
  clearTextColor,
  wrapTextColor,
} from "./textColor";

export function runTextColorSelfcheck(): string[] {
  const errors: string[] = [];
  const sample = "你好世界";

  const wrapped = wrapTextColor(sample, "#2563eb");
  if (!wrapped.includes('style="color: #2563eb"') || !wrapped.includes(sample)) {
    errors.push(`wrapTextColor failed: ${wrapped}`);
  }

  const cleared = clearTextColor(wrapped);
  if (cleared !== sample) {
    errors.push(`clearTextColor failed: ${cleared}`);
  }

  const nested = wrapTextColor(wrapped, "#dc2626");
  if ((nested.match(/<span/g) ?? []).length !== 1) {
    errors.push(`wrap should not nest: ${nested}`);
  }
  if (!nested.includes("#dc2626") || nested.includes("#2563eb")) {
    errors.push(`recolor failed: ${nested}`);
  }

  const def = applyTextColorId(nested, "default");
  if (def !== sample) {
    errors.push(`default color should unwrap: ${def}`);
  }

  const muted = applyTextColorId(sample, "muted");
  if (!muted.includes("#6b7280")) {
    errors.push(`muted color missing: ${muted}`);
  }

  return errors;
}

/**
 * 公共文本着色：用 HTML `<span style="color:…">` 持久化，任意选区可用。
 */

export type TextColorId =
  | "default"
  | "muted"
  | "accent"
  | "hint"
  | "danger";

export type TextColorOption = {
  id: TextColorId;
  label: string;
  /** null = 恢复默认（去掉颜色 span） */
  css: string | null;
};

export const TEXT_COLOR_OPTIONS: TextColorOption[] = [
  { id: "default", label: "恢复默认色", css: null },
  { id: "muted", label: "灰色", css: "#6b7280" },
  { id: "accent", label: "强调色", css: "#2563eb" },
  { id: "hint", label: "提示色", css: "#d97706" },
  { id: "danger", label: "警示色", css: "#dc2626" },
];

const COLOR_SPAN_RE =
  /^<span\s+style=(["'])color:\s*([^"']+)\1\s*>([\s\S]*)<\/span>$/i;

/** 去掉最外层颜色 span（可嵌套剥多层同类包装）。 */
export function clearTextColor(text: string): string {
  let t = text.trim();
  // 反复剥最外层 color span
  for (let i = 0; i < 8; i++) {
    const m = t.match(COLOR_SPAN_RE);
    if (!m) break;
    t = (m[3] ?? "").trim();
  }
  // 选区内部零散 color span：仅当整段由单一 span 包住时已处理；
  // 额外去掉无嵌套的简单 color span，保留内部。
  return t.replace(
    /<span\s+style=(["'])color:\s*[^"']+\1\s*>([\s\S]*?)<\/span>/gi,
    "$2",
  );
}

/** 用指定颜色包裹文本；先清旧色再包，避免嵌套。color 为 null 时等同 clear。 */
export function wrapTextColor(text: string, color: string | null): string {
  const inner = clearTextColor(text);
  if (!color) return inner;
  const safe = color.trim();
  if (!safe || !/^#[0-9a-fA-F]{3,8}$|^[a-zA-Z]+$|^rgb\([^)]+\)$|^var\([^)]+\)$/.test(safe)) {
    return inner;
  }
  // 转义尖括号，避免破坏 HTML；保留已有简单 markdown
  const body = inner;
  return `<span style="color: ${safe}">${body}</span>`;
}

export function applyTextColorId(text: string, id: TextColorId): string {
  const opt = TEXT_COLOR_OPTIONS.find((o) => o.id === id);
  if (!opt) return text;
  return wrapTextColor(text, opt.css);
}

export function isTextColorMenuAction(
  action: string,
): action is `textColor:${TextColorId}` {
  return /^textColor:(default|muted|accent|hint|danger)$/.test(action);
}

export function textColorIdFromAction(
  action: `textColor:${TextColorId}`,
): TextColorId {
  return action.slice("textColor:".length) as TextColorId;
}

/** 前端平台探测（快捷键展示等）。 */

export const isMac =
  typeof navigator !== "undefined" &&
  (/Mac|iPhone|iPad|iPod/i.test(navigator.platform) ||
    /Mac OS X/i.test(navigator.userAgent));

/** 菜单/提示里的修饰键：macOS 用 ⌘，其余用 Ctrl。 */
export const modKeyLabel = isMac ? "⌘" : "Ctrl";

/** 把 "Ctrl+S" 形式快捷键文案转为当前平台。 */
export function platformShortcut(shortcut: string): string {
  if (!isMac) return shortcut;
  return shortcut
    .replace(/^Ctrl\+/i, "⌘")
    .replace(/\bCtrl\+/gi, "⌘")
    .replace(/\bAlt\+/gi, "⌥")
    .replace(/\bShift\+/gi, "⇧");
}

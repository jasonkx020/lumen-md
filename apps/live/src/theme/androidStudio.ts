export type ThemeId =
  | "as-light"
  | "as-dark"
  | "as-darcula"
  | "as-high-contrast";

export type ThemeDef = {
  id: ThemeId;
  label: string;
  isDark: boolean;
};

export const DEFAULT_THEME: ThemeId = "as-light";

export const THEMES: ThemeDef[] = [
  { id: "as-light", label: "Light", isDark: false },
  { id: "as-dark", label: "Dark", isDark: true },
  { id: "as-darcula", label: "Darcula", isDark: true },
  { id: "as-high-contrast", label: "High contrast", isDark: true },
];

export function isThemeId(v: string): v is ThemeId {
  return THEMES.some((t) => t.id === v);
}

export function parseThemeId(v: string | null | undefined): ThemeId {
  if (v && isThemeId(v)) return v;
  if (v === "dark") return "as-dark";
  if (v === "light") return "as-light";
  return DEFAULT_THEME;
}

export function themeIsDark(id: ThemeId): boolean {
  return THEMES.find((t) => t.id === id)?.isDark ?? false;
}

export function themeMenuAction(id: ThemeId): `theme:${ThemeId}` {
  return `theme:${id}`;
}

export function themeIdFromAction(action: string): ThemeId | null {
  if (!action.startsWith("theme:")) return null;
  const id = action.slice("theme:".length);
  return isThemeId(id) ? id : null;
}

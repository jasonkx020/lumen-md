export type DocKind = "markdown" | "json" | "yaml" | "ini" | "plain";

/** 源码高亮/补全用的细粒度语言（plain 可再按扩展细分）。 */
export type SourceLanguage =
  | "markdown"
  | "json"
  | "yaml"
  | "ini"
  | "javascript"
  | "typescript"
  | "html"
  | "css"
  | "xml"
  | "python"
  | "sql"
  | "shell"
  | "toml"
  | "plain";

export function extOf(path?: string | null): string {
  if (!path) return "";
  const base = path.replace(/^["']|["']$/g, "").split(/[/\\]/).pop() ?? "";
  const lower = base.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0 || dot === lower.length - 1) return "";
  return lower.slice(dot + 1);
}

/** 无路径未命名 → markdown；md/markdown → markdown；json/yml/yaml/ini → 对应；其余 plain。 */
export function docKindFromPath(path?: string | null): DocKind {
  const ext = extOf(path);
  if (!ext) return path ? "plain" : "markdown";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "json") return "json";
  if (ext === "yml" || ext === "yaml") return "yaml";
  if (ext === "ini") return "ini";
  return "plain";
}

export function isStructuredKind(kind: DocKind): boolean {
  return kind === "json" || kind === "yaml" || kind === "ini";
}

export function usesCrepe(kind: DocKind): boolean {
  return kind === "markdown";
}

/** 按路径扩展名解析源码语言（用于语法提示）。 */
export function sourceLanguageFromPath(path?: string | null): SourceLanguage {
  const ext = extOf(path);
  switch (ext) {
    case "md":
    case "markdown":
      return "markdown";
    case "json":
      return "json";
    case "yml":
    case "yaml":
      return "yaml";
    case "ini":
    case "cfg":
    case "conf":
      return "ini";
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return "javascript";
    case "ts":
    case "tsx":
      return "typescript";
    case "html":
    case "htm":
      return "html";
    case "css":
    case "scss":
      return "css";
    case "xml":
      return "xml";
    case "py":
      return "python";
    case "sql":
      return "sql";
    case "sh":
    case "bash":
    case "zsh":
    case "bat":
    case "cmd":
    case "ps1":
      return "shell";
    case "toml":
      return "toml";
    default:
      return "plain";
  }
}

export function sourceLanguage(kind: DocKind, path?: string | null): SourceLanguage {
  switch (kind) {
    case "markdown":
      return "markdown";
    case "json":
      return "json";
    case "yaml":
      return "yaml";
    case "ini":
      return "ini";
    default:
      return sourceLanguageFromPath(path);
  }
}

export function tabDocKind(tab: {
  docKind?: DocKind;
  relPath?: string;
  absPath?: string;
}): DocKind {
  if (tab.docKind) return tab.docKind;
  return docKindFromPath(tab.absPath ?? tab.relPath);
}

export function tabPath(tab: {
  relPath?: string;
  absPath?: string;
}): string | undefined {
  return tab.absPath ?? tab.relPath;
}

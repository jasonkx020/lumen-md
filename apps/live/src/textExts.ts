/** 与 Rust `ALLOWED_TEXT_EXTS` 对齐：可按纯文本打开/编辑/保存。 */
export const EDITABLE_TEXT_EXTS = [
  "md",
  "markdown",
  "txt",
  "log",
  "csv",
  "tsv",
  "json",
  "yml",
  "yaml",
  "xml",
  "toml",
  "ini",
  "conf",
  "cfg",
  "env",
  "bat",
  "cmd",
  "ps1",
  "sh",
  "bash",
  "zsh",
  "py",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "css",
  "scss",
  "html",
  "htm",
  "rs",
  "go",
  "java",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "php",
  "rb",
  "lua",
  "sql",
] as const;

const EXT_SET = new Set<string>(EDITABLE_TEXT_EXTS);

export function isEditableTextPath(p: string): boolean {
  const base = p.replace(/^["']|["']$/g, "").split(/[/\\]/).pop() ?? "";
  const lower = base.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0 || dot === lower.length - 1) return false;
  return EXT_SET.has(lower.slice(dot + 1));
}

/** 打开/另存对话框：Markdown 组 + 全部可编辑文本组 */
export const TEXT_DIALOG_FILTERS: { name: string; extensions: string[] }[] = [
  { name: "Markdown", extensions: ["md", "markdown", "txt"] },
  { name: "文本文件", extensions: [...EDITABLE_TEXT_EXTS] },
];

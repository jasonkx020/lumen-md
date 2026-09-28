export type FileEntry = {
  name: string;
  rel_path: string;
  is_dir: boolean;
};

export type OpenFileResult = {
  mode: "workspace" | "standalone";
  workspace_root: string | null;
  rel_path: string | null;
  abs_path: string | null;
  content: string;
};

import { invoke } from "@tauri-apps/api/core";

export async function openWorkspace(path: string): Promise<string> {
  return invoke("open_workspace", { path });
}

export async function getWorkspaceRoot(): Promise<string | null> {
  return invoke("get_workspace_root");
}

export async function listDir(rel = ""): Promise<FileEntry[]> {
  return invoke("list_dir", { rel });
}

export async function fsRead(rel: string): Promise<string> {
  return invoke("fs_read", { rel });
}

export async function fsWrite(rel: string, content: string): Promise<void> {
  return invoke("fs_write", { rel, content });
}

export async function fsCreate(rel: string): Promise<void> {
  return invoke("fs_create", { rel });
}

export async function openAbsoluteFile(path: string): Promise<OpenFileResult> {
  return invoke("open_absolute_file", { path });
}

/** 取走启动命令行中的待打开文件路径（只取一次）。 */
export async function takeStartupFiles(): Promise<string[]> {
  return invoke("take_startup_files");
}

export async function fsWriteAbs(path: string, content: string): Promise<void> {
  return invoke("fs_write_abs", { path, content });
}

export async function registerAndWriteAbs(
  path: string,
  content: string,
): Promise<string> {
  return invoke("register_and_write_abs", { path, content });
}

export type ResolveDocLinkResult = {
  kind: "anchor" | "local" | "external" | "missing" | "denied";
  rel_path: string | null;
  abs_path: string | null;
  exists: boolean;
  open_url: string | null;
  message: string | null;
};

export async function resolveDocLinkApi(args: {
  href: string;
  baseRel?: string | null;
  baseAbs?: string | null;
}): Promise<ResolveDocLinkResult> {
  return invoke("resolve_doc_link", {
    href: args.href,
    baseRel: args.baseRel ?? null,
    baseAbs: args.baseAbs ?? null,
  });
}

export type SettingsView = {
  htmlEnabled: boolean;
  platform: string;
  model: string;
  hasKey: boolean;
  keyHint: string | null;
  baseUrl: string;
  theme: string;
  requiresApiKey: boolean;
};

export async function settingsGet(): Promise<SettingsView> {
  return invoke("settings_get");
}

export async function settingsSet(args: {
  htmlEnabled?: boolean;
  platform?: string;
  model?: string;
  apiKey?: string | null;
  theme?: string;
  baseUrl?: string | null;
}): Promise<SettingsView> {
  // 单一 req 对象，避免 Optional 扁平参数在 IPC 中丢失 apiKey
  return invoke("settings_set", {
    req: {
      htmlEnabled: args.htmlEnabled ?? null,
      platform: args.platform ?? null,
      model: args.model ?? null,
      apiKey: args.apiKey ?? null,
      theme: args.theme ?? null,
      baseUrl: args.baseUrl ?? null,
    },
  });
}

export async function settingsClearKey(): Promise<SettingsView> {
  return invoke("settings_clear_key");
}

export async function llmTest(): Promise<string> {
  return invoke("llm_test");
}

export async function exportMdToDocx(
  markdown: string,
  path: string,
): Promise<void> {
  return invoke("export_md_to_docx", { markdown, path });
}

/** 返回转换模式：github-html | libreoffice | word | html-fallback */
export async function exportMdToPdf(
  markdown: string,
  path: string,
): Promise<string> {
  return invoke("export_md_to_pdf", { markdown, path });
}

export async function llmComplete(args: {
  system: string;
  user: string;
  temperature?: number;
}): Promise<string> {
  return invoke("llm_complete", {
    system: args.system,
    user: args.user,
    temperature: args.temperature ?? null,
  });
}

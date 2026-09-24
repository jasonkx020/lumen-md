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

export async function fsWriteAbs(path: string, content: string): Promise<void> {
  return invoke("fs_write_abs", { path, content });
}

export async function registerAndWriteAbs(
  path: string,
  content: string,
): Promise<string> {
  return invoke("register_and_write_abs", { path, content });
}

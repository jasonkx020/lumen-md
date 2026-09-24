export type FileEntry = {
  name: string;
  rel_path: string;
  is_dir: boolean;
};

export type OpenFileResult = {
  workspace_root: string;
  rel_path: string;
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

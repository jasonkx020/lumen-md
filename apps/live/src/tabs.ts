export type EditorTab = {
  id: string;
  key: string;
  title: string;
  content: string;
  savedContent: string;
  dirty: boolean;
  relPath?: string;
  absPath?: string;
};

export function fileTitle(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

export function wsKey(rel: string): string {
  return `ws:${rel.replace(/\\/g, "/")}`;
}

export function absKey(abs: string): string {
  return `abs:${abs}`;
}

export function untitledKey(id: string): string {
  return `untitled:${id}`;
}

export function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createUntitledTab(content = ""): EditorTab {
  const id = makeId();
  return {
    id,
    key: untitledKey(id),
    title: "未命名",
    content,
    savedContent: content,
    dirty: content.length > 0,
  };
}

export function createWorkspaceTab(
  rel: string,
  content: string,
): EditorTab {
  const id = makeId();
  const norm = rel.replace(/\\/g, "/");
  return {
    id,
    key: wsKey(norm),
    title: fileTitle(norm),
    content,
    savedContent: content,
    dirty: false,
    relPath: norm,
  };
}

export function createStandaloneTab(
  abs: string,
  content: string,
): EditorTab {
  const id = makeId();
  return {
    id,
    key: absKey(abs),
    title: fileTitle(abs),
    content,
    savedContent: content,
    dirty: false,
    absPath: abs,
  };
}

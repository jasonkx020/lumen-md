import type { EditorTab } from "../tabs";
import { createUntitledTab } from "../tabs";

const STORAGE_KEY = "lumen-live.untitled-drafts";

export type UntitledDraft = {
  id: string;
  title: string;
  content: string;
  dirty: boolean;
};

function isUntitled(tab: EditorTab): boolean {
  return !tab.relPath && !tab.absPath;
}

/** 欢迎页：不作为可恢复草稿。 */
export function isWelcomeTab(tab: EditorTab): boolean {
  return isUntitled(tab) && tab.title === "欢迎" && !tab.dirty;
}

export function draftsFromTabs(tabs: EditorTab[]): UntitledDraft[] {
  return tabs
    .filter((t) => isUntitled(t) && !isWelcomeTab(t))
    .map((t) => ({
      id: t.id,
      title: t.title || "未命名",
      content: t.content,
      dirty: t.dirty,
    }));
}

export function loadDrafts(): UntitledDraft[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (d): d is UntitledDraft =>
          !!d &&
          typeof d === "object" &&
          typeof (d as UntitledDraft).id === "string" &&
          typeof (d as UntitledDraft).content === "string",
      )
      .map((d) => ({
        id: d.id,
        title: typeof d.title === "string" && d.title ? d.title : "未命名",
        content: d.content,
        dirty: Boolean(d.dirty),
      }));
  } catch {
    return [];
  }
}

export function saveDrafts(drafts: UntitledDraft[]): void {
  try {
    if (drafts.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    /* quota / private mode */
  }
}

export function persistUntitledFromTabs(tabs: EditorTab[]): void {
  saveDrafts(draftsFromTabs(tabs));
}

export function removeDraft(id: string): void {
  const next = loadDrafts().filter((d) => d.id !== id);
  saveDrafts(next);
}

export function clearDrafts(): void {
  saveDrafts([]);
}

export function draftToTab(draft: UntitledDraft): EditorTab {
  const tab = createUntitledTab(draft.content);
  // 保留草稿 id，便于关闭/保存时对上缓存项
  tab.id = draft.id;
  tab.key = `untitled:${draft.id}`;
  tab.title = draft.title || "未命名";
  // 未落盘：视为相对空磁盘基线的脏内容
  const dirty = draft.dirty || draft.content.length > 0;
  tab.dirty = dirty;
  tab.savedContent = dirty ? "" : draft.content;
  return tab;
}

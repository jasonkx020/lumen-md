import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  fsCreate,
  fsRead,
  fsWrite,
  fsWriteAbs,
  openAbsoluteFile,
  openWorkspace,
  registerAndWriteAbs,
} from "./api";
import { CrepeEditor, type CrepeEditorHandle } from "./components/CrepeEditor";
import { FileTree } from "./components/FileTree";
import {
  MenuBar,
  Outline,
  type MenuAction,
} from "./components/MenuBar";
import { runFormatAction } from "./components/editorCommands";
import { SourceEditor } from "./components/SourceEditor";
import { TabBar } from "./components/TabBar";
import {
  absKey,
  createStandaloneTab,
  createUntitledTab,
  createWorkspaceTab,
  type EditorTab,
  wsKey,
} from "./tabs";
import "./App.css";

const WELCOME = `# Lumen MD Live

在渲染结果里直接写作——标题、**加粗**、*斜体*、列表、表格与代码。

## 版本历史
| 版本 | 变更 |
|------|------|
| 1.0 | 初始完整设计方案 |
| 1.1 | Session 安全隔离：SessionManager、EditorFingerprint、一框一会话 |
| 1.2 | 核心模块确定为 Rust: ime-ffi、Cargo workspace、cbindgen、Tokio 冷路径 |

- 段落 → 表格，或 \`/\` → 表格，或输入 \`|3x3|\` 后空格
- \`Ctrl+S\` 保存 · \`Ctrl+/\` 切换源代码 · \`Ctrl+W\` 关闭标签
`;

function isMdPath(p: string) {
  const lower = p.toLowerCase();
  return (
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    lower.endsWith(".txt")
  );
}

function bootstrapTab(): EditorTab {
  const t = createUntitledTab(WELCOME);
  t.title = "欢迎";
  t.dirty = false;
  t.savedContent = WELCOME;
  return t;
}

export default function App() {
  const editorRef = useRef<CrepeEditorHandle>(null);
  const markdownRef = useRef(WELCOME);
  const tabsRef = useRef<EditorTab[]>([]);
  const activeIdRef = useRef<string | null>(null);

  const initial = bootstrapTab();
  const [tabs, setTabs] = useState<EditorTab[]>([initial]);
  const [activeId, setActiveId] = useState<string | null>(initial.id);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState(WELCOME);
  const [sourceMode, setSourceMode] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showOutline, setShowOutline] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [treeKey, setTreeKey] = useState(0);
  const [status, setStatus] = useState("就绪");

  tabsRef.current = tabs;
  activeIdRef.current = activeId;

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const dirty = activeTab?.dirty ?? false;
  const title = activeTab?.title ?? "未命名";
  const activeRel = activeTab?.relPath ?? null;

  const currentEditorMarkdown = useCallback(() => {
    if (sourceMode) return markdownRef.current;
    return editorRef.current?.getMarkdown() ?? markdownRef.current;
  }, [sourceMode]);

  const flushActiveToTabs = useCallback((): EditorTab[] => {
    const id = activeIdRef.current;
    const md = currentEditorMarkdown();
    markdownRef.current = md;
    const next = tabsRef.current.map((t) => {
      if (t.id !== id) return t;
      return {
        ...t,
        content: md,
        dirty: md !== t.savedContent,
      };
    });
    tabsRef.current = next;
    setTabs(next);
    setMarkdown(md);
    return next;
  }, [currentEditorMarkdown]);

  const loadTabIntoEditor = useCallback((tab: EditorTab) => {
    markdownRef.current = tab.content;
    setMarkdown(tab.content);
    editorRef.current?.setMarkdown(tab.content);
  }, []);

  const markDirtyFrom = useCallback((md: string) => {
    markdownRef.current = md;
    setMarkdown(md);
    const id = activeIdRef.current;
    setTabs((prev) => {
      const next = prev.map((t) =>
        t.id === id
          ? { ...t, content: md, dirty: md !== t.savedContent }
          : t,
      );
      tabsRef.current = next;
      return next;
    });
  }, []);

  const focusTab = useCallback(
    (id: string) => {
      if (id === activeIdRef.current) return;
      flushActiveToTabs();
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab) return;
      setActiveId(id);
      activeIdRef.current = id;
      loadTabIntoEditor(tab);
      setStatus(`已切换 ${tab.title}`);
    },
    [flushActiveToTabs, loadTabIntoEditor],
  );

  const openOrFocusTab = useCallback(
    (tab: EditorTab) => {
      flushActiveToTabs();
      const existing = tabsRef.current.find((t) => t.key === tab.key);
      if (existing) {
        setActiveId(existing.id);
        activeIdRef.current = existing.id;
        // 脏 Tab 不强制用磁盘覆盖
        if (!existing.dirty) {
          const updated = {
            ...existing,
            content: tab.content,
            savedContent: tab.savedContent,
            dirty: false,
          };
          const next = tabsRef.current.map((t) =>
            t.id === existing.id ? updated : t,
          );
          tabsRef.current = next;
          setTabs(next);
          loadTabIntoEditor(updated);
        } else {
          loadTabIntoEditor(existing);
        }
        setStatus(`已打开 ${existing.title}`);
        return;
      }
      const next = [...tabsRef.current, tab];
      tabsRef.current = next;
      setTabs(next);
      setActiveId(tab.id);
      activeIdRef.current = tab.id;
      loadTabIntoEditor(tab);
      setStatus(`已打开 ${tab.title}`);
    },
    [flushActiveToTabs, loadTabIntoEditor],
  );

  const closeTab = useCallback(
    (id: string) => {
      flushActiveToTabs();
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab) return;
      if (tab.dirty) {
        const ok = window.confirm(`「${tab.title}」尚未保存，确定关闭？`);
        if (!ok) return;
      }
      let next = tabsRef.current.filter((t) => t.id !== id);
      if (next.length === 0) {
        next = [bootstrapTab()];
      }
      tabsRef.current = next;
      setTabs(next);
      if (activeIdRef.current === id) {
        const fallback = next[next.length - 1]!;
        setActiveId(fallback.id);
        activeIdRef.current = fallback.id;
        loadTabIntoEditor(fallback);
      }
      setStatus(`已关闭 ${tab.title}`);
    },
    [flushActiveToTabs, loadTabIntoEditor],
  );

  const doSave = useCallback(async () => {
    flushActiveToTabs();
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
    if (!tab) return;
    const md = tab.content;

    try {
      if (tab.relPath) {
        await fsWrite(tab.relPath, md);
        const next = tabsRef.current.map((t) =>
          t.id === tab.id
            ? { ...t, content: md, savedContent: md, dirty: false }
            : t,
        );
        tabsRef.current = next;
        setTabs(next);
        setStatus(`已保存 ${tab.relPath}`);
        return;
      }
      if (tab.absPath) {
        await fsWriteAbs(tab.absPath, md);
        const next = tabsRef.current.map((t) =>
          t.id === tab.id
            ? { ...t, content: md, savedContent: md, dirty: false }
            : t,
        );
        tabsRef.current = next;
        setTabs(next);
        setStatus(`已保存 ${tab.title}`);
        return;
      }

      // untitled → 另存为
      const selected = await save({
        filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
        defaultPath: `${tab.title === "欢迎" ? "untitled" : tab.title}.md`,
      });
      if (!selected) return;
      const abs = await registerAndWriteAbs(selected, md);
      const upgraded: EditorTab = {
        ...tab,
        key: absKey(abs),
        title: abs.replace(/\\/g, "/").split("/").pop() || tab.title,
        content: md,
        savedContent: md,
        dirty: false,
        absPath: abs,
        relPath: undefined,
      };
      const next = tabsRef.current.map((t) =>
        t.id === tab.id ? upgraded : t,
      );
      tabsRef.current = next;
      setTabs(next);
      setStatus(`已保存 ${upgraded.title}`);
    } catch (e) {
      setStatus(`保存失败: ${e}`);
    }
  }, [flushActiveToTabs]);

  const openFolderDialog = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false });
    if (!selected || Array.isArray(selected)) return;
    try {
      const root = await openWorkspace(selected);
      setWorkspaceRoot(root);
      setTreeKey((k) => k + 1);
      setStatus(`工作区: ${root}`);
    } catch (e) {
      setStatus(`打开文件夹失败: ${e}`);
    }
  }, []);

  const openFileDialog = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
    });
    if (!selected || Array.isArray(selected)) return;
    try {
      const res = await openAbsoluteFile(selected);
      if (res.mode === "workspace" && res.rel_path) {
        openOrFocusTab(createWorkspaceTab(res.rel_path, res.content));
      } else if (res.abs_path) {
        // 独立文件：不 setWorkspaceRoot(parent)
        openOrFocusTab(createStandaloneTab(res.abs_path, res.content));
      }
    } catch (e) {
      setStatus(`打开文件失败: ${e}`);
    }
  }, [openOrFocusTab]);

  const openWorkspaceFile = useCallback(
    async (rel: string) => {
      const key = wsKey(rel);
      const existing = tabsRef.current.find((t) => t.key === key);
      if (existing?.dirty) {
        focusTab(existing.id);
        return;
      }
      try {
        const content = await fsRead(rel);
        openOrFocusTab(createWorkspaceTab(rel, content));
      } catch (e) {
        setStatus(`打开失败: ${e}`);
      }
    },
    [focusTab, openOrFocusTab],
  );

  const newFile = useCallback(async () => {
    if (workspaceRoot) {
      const name = window.prompt("文件名（相对路径）", "untitled.md");
      if (!name) return;
      const rel = name.replace(/\\/g, "/");
      try {
        await fsCreate(rel);
        setTreeKey((k) => k + 1);
        await openWorkspaceFile(rel);
      } catch (e) {
        setStatus(`新建失败: ${e}`);
      }
      return;
    }
    openOrFocusTab(createUntitledTab(""));
    setStatus("已新建未命名文件");
  }, [workspaceRoot, openOrFocusTab, openWorkspaceFile]);

  const handleDropPath = useCallback(
    async (path: string) => {
      try {
        if (isMdPath(path)) {
          const res = await openAbsoluteFile(path);
          if (res.mode === "workspace" && res.rel_path) {
            openOrFocusTab(createWorkspaceTab(res.rel_path, res.content));
          } else if (res.abs_path) {
            openOrFocusTab(createStandaloneTab(res.abs_path, res.content));
          }
        } else {
          const root = await openWorkspace(path);
          setWorkspaceRoot(root);
          setTreeKey((k) => k + 1);
          setStatus(`工作区: ${root}`);
        }
      } catch (e) {
        setStatus(`拖放打开失败: ${e}`);
      }
    },
    [openOrFocusTab],
  );

  const toggleSourceMode = useCallback(() => {
    setSourceMode((prev) => {
      if (!prev) {
        const md = editorRef.current?.getMarkdown() ?? markdownRef.current;
        markdownRef.current = md;
        setMarkdown(md);
        setStatus("源代码模式 — 可直接编辑 Markdown");
        return true;
      }
      const md = markdownRef.current;
      queueMicrotask(() => {
        editorRef.current?.setMarkdown(md);
        editorRef.current?.focus();
      });
      setStatus("Live 预览模式");
      return false;
    });
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      return;
    }
    void getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop" && event.payload.paths?.[0]) {
          void handleDropPath(event.payload.paths[0]);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* not in tauri */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [handleDropPath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void doSave();
      }
      if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openFolderDialog();
      }
      if (mod && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (activeIdRef.current) closeTab(activeIdRef.current);
      }
      if (mod && (e.key === "/" || e.code === "Slash" || e.key === "?")) {
        e.preventDefault();
        toggleSourceMode();
      }
      if (!sourceMode) {
        if (mod && e.key === "1") {
          e.preventDefault();
          runFormatAction(editorRef.current?.getCrepe() ?? null, "heading1");
        }
        if (mod && e.key === "2") {
          e.preventDefault();
          runFormatAction(editorRef.current?.getCrepe() ?? null, "heading2");
        }
        if (mod && e.key === "3") {
          e.preventDefault();
          runFormatAction(editorRef.current?.getCrepe() ?? null, "heading3");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeTab, doSave, openFolderDialog, sourceMode, toggleSourceMode]);

  const onAction = useCallback(
    (action: MenuAction) => {
      switch (action) {
        case "openFolder":
          void openFolderDialog();
          break;
        case "openFile":
          void openFileDialog();
          break;
        case "save":
          void doSave();
          break;
        case "newFile":
          void newFile();
          break;
        case "quit":
          void getCurrentWindow().close();
          break;
        case "toggleSource":
          toggleSourceMode();
          break;
        case "toggleSidebar":
          setShowSidebar((s) => !s);
          break;
        case "toggleOutline":
          setShowOutline((s) => !s);
          break;
        case "themeLight":
          setTheme("light");
          break;
        case "themeDark":
          setTheme("dark");
          break;
        case "about":
          window.alert(
            "Lumen MD Live 0.1\n真所见即所得（Milkdown Crepe）\n需要 Windows 10/11 + WebView2\nCtrl+/ 源码 · Ctrl+W 关闭标签",
          );
          break;
        default:
          if (!sourceMode) {
            runFormatAction(editorRef.current?.getCrepe() ?? null, action);
          }
          break;
      }
    },
    [
      doSave,
      newFile,
      openFileDialog,
      openFolderDialog,
      sourceMode,
      toggleSourceMode,
    ],
  );

  return (
    <div className="app-shell">
      <MenuBar
        onAction={onAction}
        dirty={dirty}
        title={title}
        sourceMode={sourceMode}
      />
      <TabBar
        tabs={tabs}
        activeId={activeId}
        onSelect={focusTab}
        onClose={closeTab}
      />
      <div className="main-row">
        {showSidebar ? (
          <aside className="sidebar left">
            <FileTree
              workspaceRoot={workspaceRoot}
              activeRel={activeRel}
              onOpenFile={(rel) => void openWorkspaceFile(rel)}
              refreshKey={treeKey}
            />
          </aside>
        ) : null}
        <main className="editor-pane">
          <div
            className={sourceMode ? "editor-layer is-hidden" : "editor-layer"}
          >
            <CrepeEditor
              ref={editorRef}
              initialMarkdown={WELCOME}
              onChange={markDirtyFrom}
              className="crepe-host"
            />
          </div>
          <SourceEditor
            value={markdown}
            onChange={markDirtyFrom}
            theme={theme}
            active={sourceMode}
          />
        </main>
        {showOutline ? (
          <aside className="sidebar right">
            <div className="panel-title">大纲</div>
            <Outline markdown={markdown} />
          </aside>
        ) : null}
      </div>
      <footer className="status-bar">
        <span>{status}</span>
        <span className="status-mode">
          {sourceMode ? "源代码" : "Live"}
          {tabs.length > 1 ? ` · ${tabs.length} 标签` : ""}
        </span>
      </footer>
    </div>
  );
}

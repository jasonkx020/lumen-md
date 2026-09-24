import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  fsCreate,
  fsRead,
  fsWrite,
  openAbsoluteFile,
  openWorkspace,
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
- \`Ctrl+S\` 保存 · \`Ctrl+/\` 切换源代码
`;

function isMdPath(p: string) {
  const lower = p.toLowerCase();
  return (
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    lower.endsWith(".txt")
  );
}

export default function App() {
  const editorRef = useRef<CrepeEditorHandle>(null);
  const markdownRef = useRef(WELCOME);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [activeRel, setActiveRel] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState(WELCOME);
  const [savedMarkdown, setSavedMarkdown] = useState(WELCOME);
  const [dirty, setDirty] = useState(false);
  const [sourceMode, setSourceMode] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showOutline, setShowOutline] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [treeKey, setTreeKey] = useState(0);
  const [status, setStatus] = useState("就绪");

  const title = activeRel ?? "未命名";

  const updateMarkdown = useCallback(
    (md: string, markDirty = true) => {
      markdownRef.current = md;
      setMarkdown(md);
      if (markDirty) setDirty(md !== savedMarkdown);
    },
    [savedMarkdown],
  );

  const markDirtyFrom = useCallback(
    (md: string) => updateMarkdown(md, true),
    [updateMarkdown],
  );

  const applyToEditors = useCallback((content: string) => {
    markdownRef.current = content;
    setMarkdown(content);
    editorRef.current?.setMarkdown(content);
  }, []);

  const loadFile = useCallback(
    async (rel: string) => {
      try {
        const content = await fsRead(rel);
        setActiveRel(rel);
        setSavedMarkdown(content);
        setDirty(false);
        applyToEditors(content);
        setStatus(`已打开 ${rel}`);
      } catch (e) {
        setStatus(`打开失败: ${e}`);
      }
    },
    [applyToEditors],
  );

  const doSave = useCallback(async () => {
    const md = sourceMode
      ? markdownRef.current
      : (editorRef.current?.getMarkdown() ?? markdownRef.current);
    if (!activeRel) {
      setStatus("请先打开或新建文件");
      return;
    }
    try {
      await fsWrite(activeRel, md);
      markdownRef.current = md;
      setMarkdown(md);
      setSavedMarkdown(md);
      setDirty(false);
      setStatus(`已保存 ${activeRel}`);
    } catch (e) {
      setStatus(`保存失败: ${e}`);
    }
  }, [activeRel, sourceMode]);

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
      setWorkspaceRoot(res.workspace_root);
      setActiveRel(res.rel_path);
      setSavedMarkdown(res.content);
      setDirty(false);
      applyToEditors(res.content);
      setTreeKey((k) => k + 1);
      setStatus(`已打开 ${res.rel_path}`);
    } catch (e) {
      setStatus(`打开文件失败: ${e}`);
    }
  }, [applyToEditors]);

  const newFile = useCallback(async () => {
    if (!workspaceRoot) {
      setStatus("请先打开文件夹");
      return;
    }
    const name = window.prompt("文件名（相对路径）", "untitled.md");
    if (!name) return;
    try {
      await fsCreate(name.replace(/\\/g, "/"));
      setTreeKey((k) => k + 1);
      await loadFile(name.replace(/\\/g, "/"));
    } catch (e) {
      setStatus(`新建失败: ${e}`);
    }
  }, [workspaceRoot, loadFile]);

  const handleDropPath = useCallback(
    async (path: string) => {
      try {
        if (isMdPath(path)) {
          const res = await openAbsoluteFile(path);
          setWorkspaceRoot(res.workspace_root);
          setActiveRel(res.rel_path);
          setSavedMarkdown(res.content);
          setDirty(false);
          applyToEditors(res.content);
          setTreeKey((k) => k + 1);
          setStatus(`已打开 ${res.rel_path}`);
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
    [applyToEditors],
  );

  const toggleSourceMode = useCallback(() => {
    setSourceMode((prev) => {
      if (!prev) {
        // 进入源代码：从 Live 拉取最新 Markdown
        const md = editorRef.current?.getMarkdown() ?? markdownRef.current;
        markdownRef.current = md;
        setMarkdown(md);
        setStatus("源代码模式 — 可直接编辑 Markdown");
        return true;
      }
      // 回到 Live：把源码写回 Crepe
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
      // Ctrl+/ 或 Ctrl+Shift+/（部分键盘布局）
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
  }, [doSave, openFolderDialog, sourceMode, toggleSourceMode]);

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
            "Lumen MD Live 0.1\n真所见即所得（Milkdown Crepe）\n需要 Windows 10/11 + WebView2\nCtrl+/ 切换源代码模式",
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
      <div className="main-row">
        {showSidebar ? (
          <aside className="sidebar left">
            <FileTree
              workspaceRoot={workspaceRoot}
              activeRel={activeRel}
              onOpenFile={(rel) => void loadFile(rel)}
              refreshKey={treeKey}
            />
          </aside>
        ) : null}
        <main className="editor-pane">
          {/* 双编辑器常驻，避免切换时丢失内容 */}
          <div className={sourceMode ? "editor-layer is-hidden" : "editor-layer"}>
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
        </span>
      </footer>
    </div>
  );
}

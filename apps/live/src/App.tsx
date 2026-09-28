import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
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
  settingsGet,
  settingsSet,
  takeStartupFiles,
  type SettingsView,
} from "./api";
import type { AiCapabilityId } from "./ai/capabilities";
import { runAiCapability } from "./ai/runAi";
import {
  DEFAULT_THEME,
  parseThemeId,
  themeIdFromAction,
  type ThemeId,
} from "./theme/androidStudio";
import { AiContextMenu } from "./components/AiContextMenu";
import {
  AiDiffModal,
  type AiDiffPreview,
} from "./components/AiDiffModal";
import { AiPanel, type AiPanelHandle } from "./components/AiPanel";
import { CrepeEditor, type CrepeEditorHandle } from "./components/CrepeEditor";
import { FileTree } from "./components/FileTree";
import {
  MenuBar,
  Outline,
  type MenuAction,
} from "./components/MenuBar";
import { runFormatAction } from "./components/editorCommands";
import { SettingsModal } from "./components/SettingsModal";
import {
  SourceEditor,
  type SourceEditorHandle,
} from "./components/SourceEditor";
import { TabBar } from "./components/TabBar";
import { ExportProgress } from "./components/ExportProgress";
import { runExport } from "./export/runExport";
import { useSimulatedProgress } from "./export/useSimulatedProgress";
import { handleDocLinkClick } from "./links/resolveLink";
import type { OutlineHeading } from "./markdown/extractOutline";
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
  const sourceRef = useRef<SourceEditorHandle>(null);
  const aiPanelRef = useRef<AiPanelHandle>(null);
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
  const [showAiPanel, setShowAiPanel] = useState(true);
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME);
  const [treeKey, setTreeKey] = useState(0);
  const [status, setStatus] = useState("就绪");
  const [showSettings, setShowSettings] = useState(false);
  const [htmlEnabled, setHtmlEnabled] = useState(true);
  const [hasAiKey, setHasAiKey] = useState(false);
  const [aiKeyInvalid, setAiKeyInvalid] = useState(false);
  const [supportsMultimodal, setSupportsMultimodal] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiSelected, setAiSelected] =
    useState<AiCapabilityId>("optimize_document");
  const [aiNote, setAiNote] = useState("");
  const [aiImages, setAiImages] = useState<string[]>([]);
  const [aiPanelStatus, setAiPanelStatus] = useState("");
  const [aiDiff, setAiDiff] = useState<AiDiffPreview | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    open: boolean;
    hasSelection: boolean;
  }>({ x: 0, y: 0, open: false, hasSelection: false });
  const exportProgress = useSimulatedProgress();

  tabsRef.current = tabs;
  activeIdRef.current = activeId;

  const applySettingsView = useCallback((v: SettingsView) => {
    setHtmlEnabled(v.htmlEnabled);
    // Ollama 等本地平台无需 Key；云平台仍要求 Key
    setHasAiKey(v.requiresApiKey ? v.hasKey : true);
    if (!v.requiresApiKey || v.hasKey) setAiKeyInvalid(false);
    setSupportsMultimodal(!!v.supportsMultimodal);
    if (!v.supportsMultimodal) {
      setAiImages([]);
      setAiSelected((id) => (id === "image_to_md" ? "optimize_document" : id));
    }
    if (v.theme) setTheme(parseThemeId(v.theme));
  }, []);

  const applyTheme = useCallback((id: ThemeId) => {
    setTheme(id);
    void settingsSet({ theme: id }).catch(() => {
      /* 非 tauri 预览 */
    });
  }, []);

  useEffect(() => {
    void settingsGet()
      .then(applySettingsView)
      .catch(() => {
        /* 非 tauri 预览 */
      });
  }, [applySettingsView]);

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

  const getEditorSelection = useCallback(() => {
    if (sourceMode) return sourceRef.current?.getSelection() ?? null;
    return editorRef.current?.getSelection() ?? null;
  }, [sourceMode]);

  const applyAiResult = useCallback(
    (text: string, replaceSelection: boolean, before?: string): boolean => {
      if (replaceSelection) {
        const ok = sourceMode
          ? sourceRef.current?.replaceSelection(text)
          : editorRef.current?.replaceSelection(text);
        if (ok) {
          markDirtyFrom(currentEditorMarkdown());
          return true;
        }
        // 对比弹窗会丢失选区：用原文首次匹配回退写回
        if (before) {
          const md = currentEditorMarkdown();
          const idx = md.indexOf(before);
          if (idx >= 0) {
            const next =
              md.slice(0, idx) + text + md.slice(idx + before.length);
            if (!sourceMode) editorRef.current?.setMarkdown(next);
            markDirtyFrom(next);
            return true;
          }
        }
        return false;
      }
      if (sourceMode) {
        markDirtyFrom(text);
      } else {
        editorRef.current?.setMarkdown(text);
        markDirtyFrom(text);
      }
      return true;
    },
    [currentEditorMarkdown, markDirtyFrom, sourceMode],
  );

  const runAi = useCallback(
    async (id: AiCapabilityId, note?: string) => {
      if (!hasAiKey || aiKeyInvalid) {
        setStatus("请先在 设置 → AI 中配置 API Key");
        setShowSettings(true);
        return;
      }
      setAiBusy(true);
      setAiPanelStatus("正在请求模型…");
      setAiSelected(id);
      try {
        const md = currentEditorMarkdown();
        const selection = getEditorSelection();
        const result = await runAiCapability({
          id,
          markdown: md,
          selection,
          note: note ?? aiNote,
          images: aiImages,
          supportsMultimodal,
        });
        setAiDiff({
          label: result.label,
          before: result.before,
          after: result.text,
          replaceSelection: result.replaceSelection,
          warn: result.warn,
        });
        setAiImages([]);
        const msg = result.warn
          ? `待确认：${result.label}（${result.warn}）`
          : `待确认：${result.label} — 请对比后选择是否启用`;
        setStatus(msg);
        setAiPanelStatus(msg);
      } catch (e) {
        const err = String(e);
        if (/API Key|401|403|鉴权|权限/i.test(err)) {
          setAiKeyInvalid(true);
          setAiPanelStatus("Key 不可用，请重新配置");
          setStatus("API Key 无效，请到设置中检查");
        } else {
          setAiPanelStatus(`失败: ${err}`);
          setStatus(`AI 失败: ${err}`);
        }
      } finally {
        setAiBusy(false);
      }
    },
    [
      aiImages,
      aiKeyInvalid,
      aiNote,
      currentEditorMarkdown,
      getEditorSelection,
      hasAiKey,
      supportsMultimodal,
    ],
  );

  const onEditorContextMenu = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      const sel = sourceMode
        ? sourceRef.current?.getSelection() ?? null
        : editorRef.current?.getSelection() ?? null;
      setCtxMenu({
        x: e.clientX,
        y: e.clientY,
        open: true,
        hasSelection: !!sel,
      });
    },
    [sourceMode],
  );

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
      const name = window.prompt("文件名（相对路径，默认 .md）", "untitled.md");
      if (!name) return;
      let rel = name.replace(/\\/g, "/").trim();
      // 新建标签默认 CommonMark/GFM（.md），不默认 .html
      if (!/\.(md|markdown|txt)$/i.test(rel)) {
        rel = `${rel.replace(/\.(html?|htm)$/i, "")}.md`;
      }
      try {
        await fsCreate(rel);
        setTreeKey((k) => k + 1);
        await openWorkspaceFile(rel);
        setStatus(`已新建 Markdown：${rel}`);
      } catch (e) {
        setStatus(`新建失败: ${e}`);
      }
      return;
    }
    openOrFocusTab(createUntitledTab(""));
    setStatus("已新建未命名 Markdown");
  }, [workspaceRoot, openOrFocusTab, openWorkspaceFile]);

  const jumpOutline = useCallback(
    (heading: OutlineHeading) => {
      if (sourceMode) {
        sourceRef.current?.scrollToLine(heading.line);
        setStatus(`大纲 → 第 ${heading.line} 行`);
        return;
      }
      editorRef.current?.scrollToHeading(heading.index);
      setStatus(`大纲 → ${heading.text}`);
    },
    [sourceMode],
  );

  const onEditorLinkClick = useCallback(
    (href: string) => {
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
      void handleDocLinkClick(href, {
        markdown: currentEditorMarkdown(),
        baseRel: tab?.relPath ?? null,
        baseAbs: tab?.absPath ?? null,
        onAnchor: (heading) => jumpOutline(heading),
        onOpenLocal: async ({ relPath, absPath }) => {
          if (relPath) {
            await openWorkspaceFile(relPath);
            return;
          }
          if (absPath) {
            try {
              const res = await openAbsoluteFile(absPath);
              if (res.mode === "workspace" && res.rel_path) {
                openOrFocusTab(createWorkspaceTab(res.rel_path, res.content));
              } else if (res.abs_path) {
                openOrFocusTab(createStandaloneTab(res.abs_path, res.content));
              }
            } catch (e) {
              setStatus(`打开链接失败: ${e}`);
            }
          }
        },
        onStatus: setStatus,
      });
    },
    [
      currentEditorMarkdown,
      jumpOutline,
      openOrFocusTab,
      openWorkspaceFile,
    ],
  );

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
          setStatus(`已打开 ${path.split(/[/\\]/).pop() ?? path}`);
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

  // 系统「打开方式」/ 命令行传入的文件：冷启动 + 二次实例
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const openPaths = async (paths: string[]) => {
      for (const p of paths) {
        if (disposed) return;
        if (!isMdPath(p)) continue;
        await handleDropPath(p);
      }
    };

    void (async () => {
      try {
        const startup = await takeStartupFiles();
        if (!disposed && startup.length > 0) {
          await openPaths(startup);
        }
      } catch {
        /* 非 Tauri / 命令未注册 */
      }
    })();

    void listen<string[]>("open-files", (event) => {
      void openPaths(event.payload ?? []);
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

  const doExport = useCallback(async (kind: "pdf" | "docx") => {
    try {
      const md = currentEditorMarkdown();
      markdownRef.current = md;
      setStatus(kind === "pdf" ? "正在导出 PDF…" : "正在导出 Word…");
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
      const label =
        kind === "pdf" ? "正在导出 PDF…" : "正在导出 Word…";
      const result = await runExport({
        kind,
        markdown: md,
        defaultName: tab?.title ?? "export",
        onWorkStart: () => exportProgress.start(label),
      });
      if (result === "cancelled") {
        exportProgress.fail();
        setStatus("已取消导出");
        return;
      }
      await exportProgress.finish();
      if (kind === "docx") {
        setStatus("已导出 Word (.docx)");
        return;
      }
      setStatus("已导出 PDF");
    } catch (e) {
      exportProgress.fail();
      setStatus(`导出失败: ${e}`);
    }
  }, [currentEditorMarkdown, exportProgress.start, exportProgress.finish, exportProgress.fail]);

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
        case "exportPdf":
          void doExport("pdf");
          break;
        case "exportDoc":
          void doExport("docx");
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
        case "toggleAiPanel":
          setShowAiPanel((s) => !s);
          break;
        case "openSettings":
          setShowSettings(true);
          break;
        case "about":
          window.alert(
            "Lumen MD Live 0.1\n真所见即所得 Markdown 编辑器\n需要 Windows 10/11\nCtrl+/ 源码 · Ctrl+W 关闭标签",
          );
          break;
        default: {
          const themeId = themeIdFromAction(action);
          if (themeId) {
            applyTheme(themeId);
            break;
          }
          if (!sourceMode) {
            runFormatAction(editorRef.current?.getCrepe() ?? null, action);
          }
          break;
        }
      }
    },
    [
      applyTheme,
      doExport,
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
              key={htmlEnabled ? "html-on" : "html-off"}
              ref={editorRef}
              initialMarkdown={markdownRef.current}
              onChange={markDirtyFrom}
              onLinkClick={onEditorLinkClick}
              onContextMenu={onEditorContextMenu}
              htmlEnabled={htmlEnabled}
              className="crepe-host"
            />
          </div>
          <SourceEditor
            ref={sourceRef}
            value={markdown}
            onChange={markDirtyFrom}
            theme={theme}
            active={sourceMode}
            onContextMenu={onEditorContextMenu}
          />
        </main>
        {showOutline || showAiPanel ? (
          <aside className="sidebar right sidebar-right-stack">
            {showOutline ? (
              <div className="outline-pane">
                <div className="panel-title">大纲</div>
                <Outline markdown={markdown} onJump={jumpOutline} />
              </div>
            ) : null}
            {showAiPanel ? (
              <AiPanel
                ref={aiPanelRef}
                hasKey={hasAiKey}
                keyInvalid={aiKeyInvalid}
                busy={aiBusy}
                selectedId={aiSelected}
                note={aiNote}
                supportsMultimodal={supportsMultimodal}
                images={aiImages}
                onSelect={setAiSelected}
                onNoteChange={setAiNote}
                onImagesChange={setAiImages}
                onRun={() => void runAi(aiSelected)}
                onOpenSettings={() => setShowSettings(true)}
                statusText={aiPanelStatus}
              />
            ) : null}
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
      <ExportProgress
        visible={exportProgress.visible}
        percent={exportProgress.percent}
        label={exportProgress.label}
      />
      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        onChanged={applySettingsView}
      />
      <AiDiffModal
        preview={aiDiff}
        onAccept={() => {
          if (!aiDiff) return;
          const ok = applyAiResult(
            aiDiff.after,
            aiDiff.replaceSelection,
            aiDiff.before,
          );
          if (!ok) {
            const msg =
              "启用失败：原文已变化或找不到选区，请手动复制「处理后」内容";
            setStatus(msg);
            setAiPanelStatus(msg);
            return;
          }
          const msg = `已启用：${aiDiff.label}`;
          setStatus(msg);
          setAiPanelStatus(msg);
          setAiDiff(null);
        }}
        onDiscard={() => {
          if (aiDiff) {
            const msg = `已丢弃：${aiDiff.label}`;
            setStatus(msg);
            setAiPanelStatus(msg);
          }
          setAiDiff(null);
        }}
      />
      <AiContextMenu
        open={ctxMenu.open}
        x={ctxMenu.x}
        y={ctxMenu.y}
        hasKey={hasAiKey && !aiKeyInvalid}
        hasSelection={ctxMenu.hasSelection}
        onRun={(id) => void runAi(id, "")}
        onOpenAiPanel={() => {
          setShowAiPanel(true);
          window.setTimeout(() => aiPanelRef.current?.focusNote(), 50);
        }}
        onEdit={(action) => {
          if (!sourceMode) {
            editorRef.current?.focus();
            runFormatAction(editorRef.current?.getCrepe() ?? null, action);
            return;
          }
          sourceRef.current?.focus();
          const cmd =
            action === "cut"
              ? "cut"
              : action === "copy"
                ? "copy"
                : action === "paste"
                  ? "paste"
                  : "selectAll";
          try {
            document.execCommand(cmd);
          } catch {
            /* ignore */
          }
        }}
        onOpenSettings={() => setShowSettings(true)}
        onClose={() => setCtxMenu((m) => ({ ...m, open: false }))}
      />
    </div>
  );
}

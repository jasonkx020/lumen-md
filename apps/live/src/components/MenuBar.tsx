import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  extractOutline,
  type OutlineHeading,
} from "../markdown/extractOutline";
import { platformShortcut } from "../platform";
import { THEMES, themeMenuAction, type ThemeId } from "../theme/androidStudio";

export type MenuAction =
  | "openFolder"
  | "openFile"
  | "save"
  | "saveAsHint"
  | "exportPdf"
  | "exportDoc"
  | "newFile"
  | "quit"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "heading1"
  | "heading2"
  | "heading3"
  | "paragraph"
  | "bulletList"
  | "orderedList"
  | "blockquote"
  | "codeBlock"
  | "table"
  | "hr"
  | "bold"
  | "italic"
  | "inlineCode"
  | "link"
  | "strikethrough"
  | "toggleSource"
  | "toggleSidebar"
  | "toggleOutline"
  | "toggleAiPanel"
  | `theme:${ThemeId}`
  | "openSettings"
  | "about";

type Item =
  | { type: "item"; label: string; action: MenuAction; shortcut?: string }
  | { type: "sep" };

type MenuDef = { id: string; label: string; items: Item[] };

const MENUS: MenuDef[] = [
  {
    id: "file",
    label: "文件",
    items: [
      { type: "item", label: "打开文件夹…", action: "openFolder", shortcut: "Ctrl+O" },
      { type: "item", label: "打开文件…", action: "openFile" },
      { type: "item", label: "新建 Markdown", action: "newFile" },
      { type: "sep" },
      { type: "item", label: "保存", action: "save", shortcut: "Ctrl+S" },
      { type: "sep" },
      { type: "item", label: "导出为 PDF…", action: "exportPdf" },
      { type: "item", label: "导出为 Word (.docx)…", action: "exportDoc" },
      { type: "sep" },
      { type: "item", label: "退出", action: "quit" },
    ],
  },
  {
    id: "edit",
    label: "编辑",
    items: [
      { type: "item", label: "撤销", action: "undo", shortcut: "Ctrl+Z" },
      { type: "item", label: "重做", action: "redo", shortcut: "Ctrl+Y" },
      { type: "sep" },
      { type: "item", label: "剪切", action: "cut", shortcut: "Ctrl+X" },
      { type: "item", label: "复制", action: "copy", shortcut: "Ctrl+C" },
      { type: "item", label: "粘贴", action: "paste", shortcut: "Ctrl+V" },
      { type: "item", label: "全选", action: "selectAll", shortcut: "Ctrl+A" },
    ],
  },
  {
    id: "para",
    label: "段落",
    items: [
      { type: "item", label: "正文", action: "paragraph" },
      { type: "item", label: "一级标题", action: "heading1", shortcut: "Ctrl+1" },
      { type: "item", label: "二级标题", action: "heading2", shortcut: "Ctrl+2" },
      { type: "item", label: "三级标题", action: "heading3", shortcut: "Ctrl+3" },
      { type: "sep" },
      { type: "item", label: "无序列表", action: "bulletList" },
      { type: "item", label: "有序列表", action: "orderedList" },
      { type: "item", label: "引用", action: "blockquote" },
      { type: "item", label: "代码块", action: "codeBlock" },
      { type: "item", label: "表格", action: "table" },
      { type: "item", label: "分隔线", action: "hr" },
    ],
  },
  {
    id: "fmt",
    label: "格式",
    items: [
      { type: "item", label: "加粗", action: "bold", shortcut: "Ctrl+B" },
      { type: "item", label: "斜体", action: "italic", shortcut: "Ctrl+I" },
      { type: "item", label: "删除线", action: "strikethrough" },
      { type: "item", label: "行内代码", action: "inlineCode" },
      { type: "item", label: "链接", action: "link", shortcut: "Ctrl+K" },
    ],
  },
  {
    id: "view",
    label: "视图",
    items: [
      { type: "item", label: "源代码", action: "toggleSource", shortcut: "Ctrl+/" },
      { type: "item", label: "侧边栏", action: "toggleSidebar" },
      { type: "item", label: "大纲", action: "toggleOutline" },
      { type: "item", label: "AI 助手", action: "toggleAiPanel" },
    ],
  },
  {
    id: "theme",
    label: "主题",
    items: THEMES.map((t) => ({
      type: "item" as const,
      label: t.label,
      action: themeMenuAction(t.id),
    })),
  },
  {
    id: "settings",
    label: "设置",
    items: [
      { type: "item", label: "首选项…", action: "openSettings" },
    ],
  },
  {
    id: "help",
    label: "帮助",
    items: [{ type: "item", label: "关于 Lumen MD Live", action: "about" }],
  },
];

type Props = {
  onAction: (action: MenuAction) => void;
  dirty: boolean;
  title: string;
  sourceMode: boolean;
};

export function MenuBar({ onAction, dirty, title, sourceMode }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const menusRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!openId) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (menusRef.current?.contains(t)) return;
      setOpenId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenId(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [openId]);

  const runItem = (action: MenuAction) => {
    setOpenId(null);
    onAction(action);
  };

  return (
    <header className="menu-bar">
      <nav className="menus" aria-label="主菜单" ref={menusRef}>
        {MENUS.map((m) => {
          const open = openId === m.id;
          return (
            <div
              className={"menu" + (open ? " is-open" : "")}
              key={m.id}
              onMouseEnter={() => {
                // 已有菜单打开时，滑过其它顶栏项切换（经典菜单栏）
                if (openId) setOpenId(m.id);
              }}
            >
              <button
                type="button"
                className="menu-label"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() =>
                  setOpenId((cur) => (cur === m.id ? null : m.id))
                }
              >
                {m.label}
              </button>
              {open ? (
                <div className="menu-dropdown" role="menu">
                  {m.items.map((it, i) =>
                    it.type === "sep" ? (
                      <div className="menu-sep" key={`s-${i}`} />
                    ) : (
                      <button
                        type="button"
                        className={
                          "menu-item" +
                          (it.action === "toggleSource" && sourceMode
                            ? " is-checked"
                            : "")
                        }
                        key={it.action + it.label}
                        role="menuitem"
                        onClick={() => runItem(it.action)}
                      >
                        <span>
                          {it.action === "toggleSource" && sourceMode
                            ? "✓ "
                            : ""}
                          {it.label}
                        </span>
                        {it.shortcut ? (
                          <span className="shortcut">
                            {platformShortcut(it.shortcut)}
                          </span>
                        ) : null}
                      </button>
                    ),
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </nav>
      <div className="title-chip" title={title}>
        {dirty ? "• " : ""}
        {title}
        {sourceMode ? " · 源代码" : ""}
      </div>
      <div className="menu-actions">
        <button
          type="button"
          className={"mode-toggle" + (sourceMode ? " is-on" : "")}
          title={`切换源代码模式 (${platformShortcut("Ctrl+/")})`}
          onClick={() => onAction("toggleSource")}
        >
          {sourceMode ? "Live 预览" : "源代码"}
        </button>
      </div>
    </header>
  );
}

export function Outline({
  markdown,
  onJump,
}: {
  markdown: string;
  onJump?: (heading: OutlineHeading) => void;
}): ReactNode {
  const headings = extractOutline(markdown);

  if (!headings.length) {
    return <div className="outline empty">暂无标题</div>;
  }
  return (
    <ul className="outline-list">
      {headings.map((h) => (
        <li
          key={`${h.line}-${h.text}`}
          className={`outline-h${h.level}`}
          style={{ paddingLeft: (h.level - 1) * 10 }}
        >
          <button
            type="button"
            title={`跳转到第 ${h.line} 行`}
            onClick={() => onJump?.(h)}
          >
            {h.text}
          </button>
        </li>
      ))}
    </ul>
  );
}

import type { ReactNode } from "react";

export type MenuAction =
  | "openFolder"
  | "openFile"
  | "save"
  | "saveAsHint"
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
  | "themeLight"
  | "themeDark"
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
    ],
  },
  {
    id: "theme",
    label: "主题",
    items: [
      { type: "item", label: "浅色", action: "themeLight" },
      { type: "item", label: "深色", action: "themeDark" },
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
  return (
    <header className="menu-bar">
      <nav className="menus" aria-label="主菜单">
        {MENUS.map((m) => (
          <div className="menu" key={m.id}>
            <button type="button" className="menu-label">
              {m.label}
            </button>
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
                    role="menuitemcheckbox"
                    aria-checked={
                      it.action === "toggleSource" ? sourceMode : undefined
                    }
                    onClick={() => onAction(it.action)}
                  >
                    <span>
                      {it.action === "toggleSource" && sourceMode ? "✓ " : ""}
                      {it.label}
                    </span>
                    {it.shortcut ? (
                      <span className="shortcut">{it.shortcut}</span>
                    ) : null}
                  </button>
                ),
              )}
            </div>
          </div>
        ))}
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
          title="切换源代码模式 (Ctrl+/)"
          onClick={() => onAction("toggleSource")}
        >
          {sourceMode ? "Live 预览" : "源代码"}
        </button>
      </div>
    </header>
  );
}

export function Outline({ markdown }: { markdown: string }): ReactNode {
  const headings = markdown
    .split("\n")
    .map((line, i) => {
      const m = /^(#{1,6})\s+(.+)$/.exec(line);
      if (!m) return null;
      return { level: m[1].length, text: m[2], line: i + 1 };
    })
    .filter(Boolean) as { level: number; text: string; line: number }[];

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
          {h.text}
        </li>
      ))}
    </ul>
  );
}

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { TextSelection } from "@milkdown/kit/prose/state";
import { replaceAll, replaceRange } from "@milkdown/kit/utils";
import { normalizeGfmTables } from "../markdown/normalizeGfmTables";
import { htmlPreviewView } from "../markdown/htmlNodes";
import {
  htmlTablePromotePlugin,
  serializeMarkdownPreservingHtmlTables,
} from "../markdown/htmlTablePromote";
import { findAnchorFromEvent } from "../links/resolveLink";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "@milkdown/prose/tables/style/tables.css";

export type CrepeEditorHandle = {
  getMarkdown: () => string;
  setMarkdown: (md: string) => void;
  focus: () => void;
  runAction: (fn: (ctx: unknown) => void) => void;
  getCrepe: () => Crepe | null;
  scrollToHeading: (index: number) => void;
  getSelection: () => string | null;
  replaceSelection: (text: string) => boolean;
  getHost: () => HTMLElement | null;
};

type Props = {
  initialMarkdown?: string;
  onChange?: (md: string) => void;
  onLinkClick?: (href: string) => void;
  onContextMenu?: (e: MouseEvent) => void;
  htmlEnabled?: boolean;
  className?: string;
};

function applyMarkdown(crepe: Crepe, md: string) {
  crepe.editor.action(replaceAll(normalizeGfmTables(md), true));
}

export const CrepeEditor = forwardRef<CrepeEditorHandle, Props>(
  function CrepeEditor(
    {
      initialMarkdown = "",
      onChange,
      onLinkClick,
      onContextMenu,
      htmlEnabled = true,
      className,
    },
    ref,
  ) {
    const rootRef = useRef<HTMLDivElement>(null);
    const crepeRef = useRef<Crepe | null>(null);
    const readyRef = useRef(false);
    const lastMdRef = useRef(normalizeGfmTables(initialMarkdown));
    const onChangeRef = useRef(onChange);
    const onLinkClickRef = useRef(onLinkClick);
    const onContextMenuRef = useRef(onContextMenu);
    const suppressRef = useRef(0);
    onChangeRef.current = onChange;
    onLinkClickRef.current = onLinkClick;
    onContextMenuRef.current = onContextMenu;

    useImperativeHandle(ref, () => ({
      getMarkdown: () => {
        const c = crepeRef.current;
        if (c && readyRef.current) {
          try {
            if (htmlEnabled) {
              c.editor.action((ctx: Ctx) => {
                lastMdRef.current = serializeMarkdownPreservingHtmlTables(ctx);
              });
            } else {
              lastMdRef.current = c.getMarkdown();
            }
          } catch {
            /* keep last */
          }
        }
        return lastMdRef.current;
      },
      setMarkdown: (md: string) => {
        const normalized = normalizeGfmTables(md);
        lastMdRef.current = normalized;
        const c = crepeRef.current;
        if (!c || !readyRef.current) return;
        suppressRef.current += 1;
        try {
          applyMarkdown(c, normalized);
        } finally {
          setTimeout(() => {
            suppressRef.current = Math.max(0, suppressRef.current - 1);
          }, 0);
        }
      },
      focus: () => {
        rootRef.current
          ?.querySelector<HTMLElement>(".ProseMirror")
          ?.focus();
      },
      runAction: (fn) => {
        const c = crepeRef.current;
        if (!c || !readyRef.current) return;
        c.editor.action(fn as never);
      },
      getCrepe: () => crepeRef.current,
      getHost: () => rootRef.current,
      getSelection: () => {
        const c = crepeRef.current;
        if (!c || !readyRef.current) return null;
        try {
          let text = "";
          c.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { from, to, empty } = view.state.selection;
            if (!empty) {
              text = view.state.doc.textBetween(from, to, "\n");
            }
          });
          const t = text.trim();
          return t ? text : null;
        } catch {
          return null;
        }
      },
      replaceSelection: (text: string) => {
        const c = crepeRef.current;
        if (!c || !readyRef.current) return false;
        try {
          let ok = false;
          c.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { from, to, empty } = view.state.selection;
            if (empty) return;
            // 按 Markdown 解析后替换选区，避免 **/# 等被当成纯文本
            replaceRange(text, { from, to })(ctx);
            ok = true;
          });
          return ok;
        } catch {
          return false;
        }
      },
      scrollToHeading: (index: number) => {
        const c = crepeRef.current;
        if (!c || !readyRef.current) return;
        try {
          c.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { state } = view;
            let headingIdx = -1;
            let foundPos: number | null = null;
            state.doc.descendants((node, pos) => {
              if (node.type.name !== "heading") return;
              headingIdx += 1;
              if (headingIdx === index) {
                foundPos = pos;
                return false;
              }
            });
            if (foundPos == null) {
              // DOM fallback
              const heads = rootRef.current?.querySelectorAll(
                ".ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6",
              );
              const el = heads?.[index] as HTMLElement | undefined;
              el?.scrollIntoView({ behavior: "smooth", block: "start" });
              return;
            }
            const $pos = state.doc.resolve(foundPos + 1);
            const sel = TextSelection.near($pos);
            view.dispatch(state.tr.setSelection(sel).scrollIntoView());
            view.focus();
            const dom = view.nodeDOM(foundPos);
            if (dom instanceof HTMLElement) {
              dom.scrollIntoView({ behavior: "smooth", block: "start" });
            }
          });
        } catch {
          const heads = rootRef.current?.querySelectorAll(
            ".ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6",
          );
          const el = heads?.[index] as HTMLElement | undefined;
          el?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      },
    }));

    useEffect(() => {
      const el = rootRef.current;
      if (!el) return;
      let disposed = false;
      const crepe = new Crepe({
        root: el,
        defaultValue: lastMdRef.current || initialMarkdown,
        features: {
          [Crepe.Feature.Table]: true,
        },
        featureConfigs: {
          [Crepe.Feature.Cursor]: {
            virtual: false,
          },
          [Crepe.Feature.Placeholder]: {
            text: "开始写作…",
            mode: "block",
          },
          [Crepe.Feature.BlockEdit]: {
            textGroup: {
              label: "文本",
              text: { label: "正文" },
              h1: { label: "一级标题" },
              h2: { label: "二级标题" },
              h3: { label: "三级标题" },
              h4: { label: "四级标题" },
              h5: { label: "五级标题" },
              h6: { label: "六级标题" },
              quote: { label: "引用" },
              divider: { label: "分隔线" },
            },
            listGroup: {
              label: "列表",
              bulletList: { label: "无序列表" },
              orderedList: { label: "有序列表" },
              taskList: { label: "任务列表" },
            },
            advancedGroup: {
              label: "高级",
              image: { label: "图片" },
              codeBlock: { label: "代码块" },
              table: { label: "表格" },
              math: { label: "公式" },
            },
          },
        },
      });
      if (htmlEnabled) {
        crepe.editor.use(htmlPreviewView).use(htmlTablePromotePlugin);
      }
      crepe.on((listener) => {
        listener.markdownUpdated((ctx, markdown) => {
          if (suppressRef.current > 0) return;
          let next = markdown;
          if (htmlEnabled) {
            try {
              next = serializeMarkdownPreservingHtmlTables(ctx as Ctx);
            } catch {
              /* fall back to milkdown markdown */
            }
          }
          lastMdRef.current = next;
          onChangeRef.current?.(next);
        });
      });
      crepeRef.current = crepe;
      void crepe.create().then(() => {
        if (disposed) return;
        readyRef.current = true;
        suppressRef.current += 1;
        try {
          applyMarkdown(crepe, lastMdRef.current);
        } finally {
          setTimeout(() => {
            suppressRef.current = Math.max(0, suppressRef.current - 1);
          }, 0);
        }
      });
      return () => {
        disposed = true;
        readyRef.current = false;
        void crepe.destroy();
        crepeRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [htmlEnabled]);

    useEffect(() => {
      const el = rootRef.current;
      if (!el) return;
      const onClick = (e: MouseEvent) => {
        if (e.defaultPrevented) return;
        if (e.button !== 0) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        // 仅拦截真实 <a href>，避免影响 Crepe 工具条 / 按钮
        const t = e.target as HTMLElement | null;
        if (t?.closest?.(".milkdown-toolbar, .milkdown-slash-menu, .crepe-menu")) {
          return;
        }
        const href = findAnchorFromEvent(e.target);
        if (!href) return;
        e.preventDefault();
        onLinkClickRef.current?.(href);
      };
      const onCtx = (e: MouseEvent) => {
        const t = e.target as HTMLElement | null;
        // 工具条等区域保留默认/组件自身菜单
        if (t?.closest?.(".milkdown-toolbar, .milkdown-slash-menu, .crepe-menu")) {
          return;
        }
        onContextMenuRef.current?.(e);
      };
      el.addEventListener("click", onClick, true);
      el.addEventListener("contextmenu", onCtx);
      return () => {
        el.removeEventListener("click", onClick, true);
        el.removeEventListener("contextmenu", onCtx);
      };
    }, []);

    return <div ref={rootRef} className={className ?? "crepe-host"} />;
  },
);

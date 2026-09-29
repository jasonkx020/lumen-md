import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { Crepe } from "@milkdown/crepe";
import { editorViewCtx, parserCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import type { Node as PmNode, Schema } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import { replaceAll, replaceRange } from "@milkdown/kit/utils";
import { upload, uploadConfig } from "@milkdown/kit/plugin/upload";
import { normalizeGfmTables } from "../markdown/normalizeGfmTables";
import { normalizeGithubHtml } from "../markdown/normalizeGithubHtml";
import {
  decodeImageAltFromCrepe,
  encodeImageAltForCrepe,
} from "../markdown/crepeImageAlt";
import {
  htmlBlockPreviewView,
  htmlPreviewView,
} from "../markdown/htmlNodes";
import {
  htmlBlockSchema,
  remarkHtmlBlock,
} from "../markdown/htmlBlockNodes";
import { remarkMergeInlineHtml } from "../markdown/remarkMergeInlineHtml";
import {
  htmlTablePromotePlugin,
  serializeMarkdownPreservingHtmlTables,
} from "../markdown/htmlTablePromote";
import { rewriteHtmlImgSrcs } from "../markdown/rewriteHtmlAssets";
import {
  getSameTableCell,
  replaceTableCellInline,
  selectionTouchesTable,
} from "../markdown/tableCellSelection";
import { resolveAssetUrl, saveAssetFile } from "../assets/saveAsset";
import { setHtmlAssetDocAbs } from "../markdown/htmlAssetContext";
import { attachMermaidRenderer } from "../diagrams/mermaidView";
import { findAnchorFromMouseEvent } from "../links/resolveLink";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "@milkdown/prose/tables/style/tables.css";

export type SelectionMeta = {
  text: string;
  from: number;
  to: number;
  /** 选区完全落在同一单元格内 */
  inTableCell: boolean;
  /** 选区触及表格但跨格/不完整 */
  tableSelectionBlocked: boolean;
};

export type CrepeEditorHandle = {
  getMarkdown: () => string;
  setMarkdown: (md: string) => void;
  focus: () => void;
  runAction: (fn: (ctx: unknown) => void) => void;
  getCrepe: () => Crepe | null;
  scrollToHeading: (index: number) => void;
  getSelection: () => string | null;
  getSelectionMeta: () => SelectionMeta | null;
  replaceSelection: (text: string) => boolean;
  /** 用保存的 from/to 写回（对比弹窗会丢掉选区） */
  replaceRangeAt: (from: number, to: number, text: string) => boolean;
  /** 按纯文本偏移近似选中（查找用） */
  selectTextNear: (index: number, len: number) => void;
  /** 在光标处插入相对路径图片（拖入用） */
  insertImageSrc: (src: string, alt?: string) => boolean;
  getHost: () => HTMLElement | null;
};

type Props = {
  initialMarkdown?: string;
  onChange?: (md: string) => void;
  onLinkClick?: (href: string) => void;
  onContextMenu?: (e: MouseEvent) => void;
  /** 图片落盘/解析失败时回调（状态栏） */
  onAssetError?: (msg: string) => void;
  htmlEnabled?: boolean;
  /** 当前文档绝对路径（图片 beside 模式 / 资源解析） */
  docAbsPath?: string | null;
  focusMode?: boolean;
  typewriterMode?: boolean;
  className?: string;
};

function createImageNodes(schema: Schema, src: string, alt: string): PmNode[] {
  const block = schema.nodes["image-block"];
  if (block) {
    const n = block.createAndFill({ src, caption: alt || "", ratio: 1 });
    if (n) return [n];
  }
  const image = schema.nodes.image;
  if (image) {
    const n = image.createAndFill({ src, alt: alt || "" });
    if (n) return [n];
  }
  return [];
}

function normalizeIncomingMarkdown(md: string): string {
  return encodeImageAltForCrepe(
    normalizeGithubHtml(normalizeGfmTables(md)),
  );
}

/** 面向源码/保存的 Markdown（还原 image-block 弄丢的 alt） */
function normalizeOutgoingMarkdown(md: string): string {
  return decodeImageAltFromCrepe(md);
}

function applyMarkdown(crepe: Crepe, md: string) {
  crepe.editor.action(replaceAll(normalizeIncomingMarkdown(md), true));
}

export const CrepeEditor = forwardRef<CrepeEditorHandle, Props>(
  function CrepeEditor(
    {
      initialMarkdown = "",
      onChange,
      onLinkClick,
      onContextMenu,
      onAssetError,
      htmlEnabled = true,
      docAbsPath = null,
      focusMode = false,
      typewriterMode = false,
      className,
    },
    ref,
  ) {
    const rootRef = useRef<HTMLDivElement>(null);
    const crepeRef = useRef<Crepe | null>(null);
    const readyRef = useRef(false);
    const lastMdRef = useRef(
      normalizeGithubHtml(normalizeGfmTables(initialMarkdown)),
    );
    const onChangeRef = useRef(onChange);
    const onLinkClickRef = useRef(onLinkClick);
    const onContextMenuRef = useRef(onContextMenu);
    const onAssetErrorRef = useRef(onAssetError);
    const docAbsRef = useRef(docAbsPath);
    const suppressRef = useRef(0);
    onChangeRef.current = onChange;
    onLinkClickRef.current = onLinkClick;
    onContextMenuRef.current = onContextMenu;
    onAssetErrorRef.current = onAssetError;
    docAbsRef.current = docAbsPath;
    setHtmlAssetDocAbs(docAbsPath);

    const uploadFileRef = useRef<(file: File) => Promise<string>>(async () => {
      throw new Error("upload not ready");
    });
    uploadFileRef.current = async (file: File): Promise<string> => {
      try {
        return await saveAssetFile(file, { docAbs: docAbsRef.current });
      } catch (e) {
        onAssetErrorRef.current?.(String(e));
        throw e;
      }
    };

    useImperativeHandle(ref, () => ({
      getMarkdown: () => {
        const c = crepeRef.current;
        if (c && readyRef.current) {
          try {
            let raw: string;
            if (htmlEnabled) {
              c.editor.action((ctx: Ctx) => {
                raw = serializeMarkdownPreservingHtmlTables(ctx);
              });
            } else {
              raw = c.getMarkdown();
            }
            lastMdRef.current = normalizeOutgoingMarkdown(raw!);
          } catch {
            /* keep last */
          }
        }
        return lastMdRef.current;
      },
      setMarkdown: (md: string) => {
        // 打开文件时父组件可能同步调用 setMarkdown，早于本次 render；
        // 用 ref 再刷一次上下文，避免相对图片按错误/空文档路径解析。
        setHtmlAssetDocAbs(docAbsRef.current);
        const base = normalizeGithubHtml(normalizeGfmTables(md));
        lastMdRef.current = base;
        const c = crepeRef.current;
        if (!c || !readyRef.current) return;
        suppressRef.current += 1;
        try {
          applyMarkdown(c, base);
        } finally {
          setTimeout(() => {
            suppressRef.current = Math.max(0, suppressRef.current - 1);
            const host = rootRef.current;
            if (host) void rewriteHtmlImgSrcs(host, docAbsRef.current);
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
      getSelectionMeta: () => {
        const c = crepeRef.current;
        if (!c || !readyRef.current) return null;
        try {
          let meta: SelectionMeta | null = null;
          c.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { from, to, empty } = view.state.selection;
            if (empty) return;
            const text = view.state.doc.textBetween(from, to, "\n");
            if (!text.trim()) return;
            const cell = getSameTableCell(view.state.doc, from, to);
            const touches = selectionTouchesTable(view.state.doc, from, to);
            meta = {
              text,
              from,
              to,
              inTableCell: !!cell,
              tableSelectionBlocked: touches && !cell,
            };
          });
          return meta;
        } catch {
          return null;
        }
      },
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
            const cell = getSameTableCell(view.state.doc, from, to);
            if (cell) {
              let parser: ((md: string) => never) | undefined;
              try {
                parser = ctx.get(parserCtx) as never;
              } catch {
                parser = undefined;
              }
              ok = replaceTableCellInline(view, text, from, to, parser);
              return;
            }
            if (selectionTouchesTable(view.state.doc, from, to)) {
              ok = false;
              return;
            }
            replaceRange(text, { from, to })(ctx);
            ok = true;
          });
          return ok;
        } catch {
          return false;
        }
      },
      replaceRangeAt: (from: number, to: number, text: string) => {
        const c = crepeRef.current;
        if (!c || !readyRef.current) return false;
        if (from >= to) return false;
        try {
          let ok = false;
          c.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const max = view.state.doc.content.size;
            if (from < 0 || to > max + 2) return;
            const cell = getSameTableCell(view.state.doc, from, to);
            if (cell) {
              let parser: ((md: string) => never) | undefined;
              try {
                parser = ctx.get(parserCtx) as never;
              } catch {
                parser = undefined;
              }
              ok = replaceTableCellInline(view, text, from, to, parser);
              return;
            }
            if (selectionTouchesTable(view.state.doc, from, to)) {
              ok = false;
              return;
            }
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
      selectTextNear: (index: number, len: number) => {
        const c = crepeRef.current;
        if (!c || !readyRef.current) return;
        try {
          c.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { state } = view;
            const text = state.doc.textContent;
            const start = Math.max(0, Math.min(index, text.length));
            const end = Math.max(start, Math.min(start + Math.max(0, len), text.length));
            // map plain offsets → doc positions
            let plain = 0;
            let fromPos: number | null = null;
            let toPos: number | null = null;
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;
              const next = plain + node.text.length;
              if (fromPos == null && start >= plain && start <= next) {
                fromPos = pos + (start - plain);
              }
              if (toPos == null && end >= plain && end <= next) {
                toPos = pos + (end - plain);
              }
              plain = next;
              if (fromPos != null && toPos != null) return false;
            });
            if (fromPos == null) return;
            const $from = state.doc.resolve(fromPos);
            const $to = state.doc.resolve(toPos ?? fromPos);
            const sel = TextSelection.between($from, $to);
            view.dispatch(state.tr.setSelection(sel).scrollIntoView());
            view.focus();
          });
        } catch {
          /* ignore */
        }
      },
      insertImageSrc: (src: string, alt = "") => {
        const c = crepeRef.current;
        if (!c || !readyRef.current) return false;
        try {
          let ok = false;
          c.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const nodes = createImageNodes(view.state.schema, src, alt);
            if (nodes.length === 0) return;
            const { from } = view.state.selection;
            const tr = view.state.tr.replaceWith(from, from, nodes);
            view.dispatch(tr.scrollIntoView());
            view.focus();
            ok = true;
          });
          return ok;
        } catch {
          return false;
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
          [Crepe.Feature.ImageBlock]: {
            onUpload: async (file: File) => uploadFileRef.current(file),
            inlineOnUpload: async (file: File) => uploadFileRef.current(file),
            blockOnUpload: async (file: File) => uploadFileRef.current(file),
            proxyDomURL: async (url: string) => {
              if (
                !url ||
                url.startsWith("data:") ||
                url.startsWith("http://") ||
                url.startsWith("https://") ||
                url.startsWith("blob:")
              ) {
                return url;
              }
              try {
                return await resolveAssetUrl(url, docAbsRef.current);
              } catch (e) {
                onAssetErrorRef.current?.(String(e));
                return url;
              }
            },
            blockUploadPlaceholderText: "上传图片到 assets/",
            inlineUploadPlaceholderText: "上传图片",
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
      crepe.editor
        .config((ctx) => {
          ctx.update(uploadConfig.key, (prev) => ({
            ...prev,
            enableHtmlFileUploader: true,
            uploader: async (files, schema) => {
              const imgs: File[] = [];
              for (let i = 0; i < files.length; i++) {
                const f = files.item(i);
                if (f && f.type.includes("image")) imgs.push(f);
              }
              const nodes: PmNode[] = [];
              for (const file of imgs) {
                try {
                  const src = await uploadFileRef.current(file);
                  nodes.push(
                    ...createImageNodes(
                      schema,
                      src,
                      file.name.replace(/\.[^.]+$/, "") || "image",
                    ),
                  );
                } catch {
                  /* onAssetError already notified */
                }
              }
              return nodes;
            },
          }));
        })
        .use(upload);
      if (htmlEnabled) {
        crepe.editor
          .use(htmlBlockSchema)
          .use(remarkMergeInlineHtml)
          .use(remarkHtmlBlock)
          .use(htmlPreviewView)
          .use(htmlBlockPreviewView)
          .use(htmlTablePromotePlugin);
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
          next = normalizeOutgoingMarkdown(next);
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
      const detachMermaid = attachMermaidRenderer(el);
      return () => {
        disposed = true;
        readyRef.current = false;
        detachMermaid();
        void crepe.destroy();
        crepeRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [htmlEnabled]);

    // 文档路径变化后重写相对图片（打开文件 / 切换 Tab）
    useEffect(() => {
      setHtmlAssetDocAbs(docAbsPath);
      docAbsRef.current = docAbsPath;
      const host = rootRef.current;
      if (!host || !readyRef.current) return;
      void rewriteHtmlImgSrcs(host, docAbsPath);
    }, [docAbsPath]);

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
        const href = findAnchorFromMouseEvent(e);
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

    useEffect(() => {
      if (!typewriterMode) return;
      const c = crepeRef.current;
      if (!c || !readyRef.current) return;
      let last = -1;
      const tick = () => {
        try {
          c.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const head = view.state.selection.head;
            if (head === last) return;
            last = head;
            const coords = view.coordsAtPos(head);
            if (!coords) return;
            const host = rootRef.current;
            if (!host) return;
            const rect = host.getBoundingClientRect();
            const targetY = rect.top + rect.height * 0.4;
            const delta = coords.top - targetY;
            if (Math.abs(delta) > 8) {
              host.scrollTop += delta;
            }
          });
        } catch {
          /* ignore */
        }
      };
      const id = window.setInterval(tick, 120);
      return () => window.clearInterval(id);
    }, [typewriterMode]);

    return (
      <div
        ref={rootRef}
        className={[
          className ?? "crepe-host",
          focusMode ? "is-focus" : "",
          typewriterMode ? "is-typewriter" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      />
    );
  },
);

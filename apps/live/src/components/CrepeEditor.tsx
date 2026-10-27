import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Crepe } from "@milkdown/crepe";
import {
  commandsCtx,
  editorViewCtx,
  parserCtx,
} from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import type { Node as PmNode, Schema } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import {
  clearTextInCurrentBlockCommand,
  codeBlockSchema,
  setBlockTypeCommand,
} from "@milkdown/kit/preset/commonmark";
import { replaceAll, replaceRange } from "@milkdown/kit/utils";
import { upload, uploadConfig } from "@milkdown/kit/plugin/upload";
import { codeBlockConfig } from "@milkdown/kit/component/code-block";
import {
  extractMermaidSource,
  prepareMermaidSource,
} from "../diagrams/normalizeMermaidMd";
import {
  ensureFormulaMarkdown,
  extractFormulaLatex,
} from "../formula/normalizeFormulaMd";
import {
  DEFAULT_MERMAID_TEMPLATE,
  mermaidMenuIcon,
} from "../diagrams/mermaidIcon";
import {
  renderMermaidPreview,
  shouldRenderMermaid,
} from "../diagrams/mermaidPreview";
import { decodeImageAltFromCrepe } from "../markdown/crepeImageAlt";
import { normalizeIncomingMarkdown } from "../markdown/normalizeIncomingMd";
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
import { findAnchorFromMouseEvent } from "../links/resolveLink";
import {
  FormulaVisualEditor,
  type FormulaDisplayKind,
} from "../formula/FormulaVisualEditor";
import {
  applyFormulaLatex,
  attachFormulaVisualEdit,
  formulaRequestDisplayKind,
  isFormulaInsertRequest,
  type FormulaEditRequest,
} from "../formula/attachFormulaVisualEdit";
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
  /** 打开文件 / 切 Tab：flush 重建 state（不进入撤销栈） */
  setMarkdown: (md: string) => void;
  /**
   * 用 Markdown 替换全文，但保留 ProseMirror history（可 Ctrl+Z）。
   * AI 整篇写回、就地改写等应走此路径，勿用 setMarkdown。
   */
  replaceDocumentMarkdown: (md: string) => void;
  focus: () => void;
  runAction: (fn: (ctx: unknown) => void) => void;
  getCrepe: () => Crepe | null;
  scrollToHeading: (index: number) => void;
  getSelection: () => string | null;
  getSelectionMeta: () => SelectionMeta | null;
  replaceSelection: (text: string) => boolean;
  /** 在光标处插入 Markdown；afterSelection 时保留选区、在终点后插入 */
  insertMarkdownAtCursor: (
    md: string,
    opts?: { afterSelection?: boolean },
  ) => boolean;
  /** 用保存的 from/to 写回（对比弹窗会丢掉选区） */
  replaceRangeAt: (from: number, to: number, text: string) => boolean;
  /** 按纯文本偏移近似选中（查找用） */
  selectTextNear: (index: number, len: number) => void;
  /** 在光标处插入相对路径图片（拖入用） */
  insertImageSrc: (src: string, alt?: string) => boolean;
  /** 打开可视化公式编辑器以在光标处新建 */
  openFormulaInsert: (kind?: FormulaDisplayKind) => void;
  /** 在光标处插入 Mermaid 代码块（与斜杠菜单一致） */
  insertMermaidAtCursor: () => boolean;
  /** 在光标处插入指定源码的 Mermaid 块；afterSelection 保留选区 */
  insertMermaidSourceAtCursor: (
    source: string,
    opts?: { afterSelection?: boolean },
  ) => boolean;
  /** 在光标处插入 LaTeX 公式块；afterSelection 保留选区 */
  insertLatexSourceAtCursor: (
    source: string,
    opts?: { afterSelection?: boolean },
  ) => boolean;
  /** 恢复 ProseMirror 文档坐标选区（对比弹窗启用前调用） */
  restoreSelection: (from: number, to: number) => boolean;
  /** 折叠选区到终点（不删内容），供 insert_after_selection 使用 */
  collapseSelectionToEnd: () => boolean;
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

/** 面向源码/保存的 Markdown（还原 image-block 弄丢的 alt） */
function normalizeOutgoingMarkdown(md: string): string {
  return decodeImageAltFromCrepe(md);
}

function applyMarkdown(crepe: Crepe, md: string, flush = true) {
  crepe.editor.action(replaceAll(normalizeIncomingMarkdown(md), flush));
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
    const formulaDisposeRef = useRef<(() => void) | null>(null);
    const [formulaReq, setFormulaReq] = useState<FormulaEditRequest | null>(
      null,
    );
    const lastMdRef = useRef(normalizeIncomingMarkdown(initialMarkdown));
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
        const base = normalizeIncomingMarkdown(md);
        lastMdRef.current = base;
        const c = crepeRef.current;
        if (!c || !readyRef.current) return;
        suppressRef.current += 1;
        try {
          applyMarkdown(c, base, true);
        } finally {
          setTimeout(() => {
            suppressRef.current = Math.max(0, suppressRef.current - 1);
            const host = rootRef.current;
            if (host) void rewriteHtmlImgSrcs(host, docAbsRef.current);
          }, 0);
        }
      },
      replaceDocumentMarkdown: (md: string) => {
        setHtmlAssetDocAbs(docAbsRef.current);
        const base = normalizeIncomingMarkdown(md);
        lastMdRef.current = base;
        const c = crepeRef.current;
        if (!c || !readyRef.current) return;
        // 不 suppress：让 change 正常进入 history，便于撤销 AI 结果
        applyMarkdown(c, base, false);
        const host = rootRef.current;
        if (host) void rewriteHtmlImgSrcs(host, docAbsRef.current);
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
            // 空选区也保存光标，供 insert_at_cursor 在 Diff 关闭后恢复
            if (empty) {
              meta = {
                text: "",
                from,
                to,
                inTableCell: false,
                tableSelectionBlocked: false,
              };
              return;
            }
            const text = view.state.doc.textBetween(from, to, "\n");
            if (!text.trim()) {
              meta = {
                text: "",
                from,
                to,
                inTableCell: false,
                tableSelectionBlocked: false,
              };
              return;
            }
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
      collapseSelectionToEnd: () => {
        const c = crepeRef.current;
        if (!c || !readyRef.current) return false;
        try {
          let ok = false;
          c.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { to } = view.state.selection;
            const max = view.state.doc.content.size;
            const pos = Math.max(1, Math.min(to, max));
            try {
              const sel = TextSelection.create(view.state.doc, pos);
              view.dispatch(view.state.tr.setSelection(sel));
              ok = true;
            } catch {
              const sel = TextSelection.near(view.state.doc.resolve(pos));
              view.dispatch(view.state.tr.setSelection(sel));
              ok = true;
            }
          });
          return ok;
        } catch {
          return false;
        }
      },
      insertMarkdownAtCursor: (md: string, opts?: { afterSelection?: boolean }) => {
        const c = crepeRef.current;
        if (!c || !readyRef.current) return false;
        const after = !!opts?.afterSelection;
        if (after) {
          // 先折叠到选区终点，后续插入不再覆盖原文
          try {
            c.editor.action((ctx) => {
              const view = ctx.get(editorViewCtx);
              const { to } = view.state.selection;
              const max = view.state.doc.content.size;
              const pos = Math.max(1, Math.min(to, max));
              try {
                view.dispatch(
                  view.state.tr.setSelection(
                    TextSelection.create(view.state.doc, pos),
                  ),
                );
              } catch {
                view.dispatch(
                  view.state.tr.setSelection(
                    TextSelection.near(view.state.doc.resolve(pos)),
                  ),
                );
              }
            });
          } catch {
            /* continue */
          }
        }
        // Mermaid：replaceRange 无法稳定得到可预览 code_block，改走围栏追加（与菜单一致）
        const mermaidBody = extractMermaidSource(md);
        if (mermaidBody) {
          try {
            const cur = c.getMarkdown();
            applyMarkdown(
              c,
              `${cur.trimEnd()}\n\n\`\`\`mermaid\n${mermaidBody}\n\`\`\`\n`,
              false,
            );
            return true;
          } catch {
            return false;
          }
        }
        // 公式：裸 LaTeX / $$ 统一抽出后走 LaTeX code_block（与块级公式预览一致）
        const latexBody = extractFormulaLatex(md);
        if (latexBody) {
          try {
            const cur = c.getMarkdown();
            applyMarkdown(
              c,
              `${cur.trimEnd()}\n\n${ensureFormulaMarkdown(latexBody)}\n`,
              false,
            );
            return true;
          } catch {
            /* fall through to generic insert */
          }
        }
        const normalized = normalizeIncomingMarkdown(
          ensureFormulaMarkdown(md.trim().replace(/\r\n/g, "\n")),
        );
        const payload = normalized ? `\n\n${normalized}\n\n` : md;
        try {
          let ok = false;
          c.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { from, to } = view.state.selection;
            // afterSelection 时 from===to（已折叠），插入不删字
            const insertFrom = after ? to : from;
            const insertTo = after ? to : to;
            if (selectionTouchesTable(view.state.doc, insertFrom, insertTo)) {
              view.dispatch(
                view.state.tr.insertText(
                  md.replace(/\n+/g, " "),
                  insertFrom,
                  insertTo,
                ),
              );
              ok = true;
              return;
            }
            replaceRange(payload, { from: insertFrom, to: insertTo })(ctx);
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
      openFormulaInsert: (kind: FormulaDisplayKind = "inline") => {
        const c = crepeRef.current;
        if (!c || !readyRef.current) return;
        try {
          c.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const from = view.state.selection.from;
            setFormulaReq({
              kind: kind === "block" ? "insert-block" : "insert-inline",
              pos: from,
              latex: "",
            });
          });
        } catch {
          setFormulaReq({
            kind: kind === "block" ? "insert-block" : "insert-inline",
            pos: 0,
            latex: "",
          });
        }
      },
      insertMermaidAtCursor: () => {
        const c = crepeRef.current;
        if (!c || !readyRef.current) return false;
        try {
          c.editor.action((ctx) => {
            const commands = ctx.get(commandsCtx);
            const view = ctx.get(editorViewCtx);
            const codeBlock = codeBlockSchema.type(ctx);
            commands.call(clearTextInCurrentBlockCommand.key);
            commands.call(setBlockTypeCommand.key, {
              nodeType: codeBlock,
              attrs: { language: "mermaid" },
            });
            const { state, dispatch } = view;
            const { from } = state.selection;
            dispatch(state.tr.insertText(DEFAULT_MERMAID_TEMPLATE, from));
          });
          return true;
        } catch {
          return false;
        }
      },
      restoreSelection: (from: number, to: number) => {
        const c = crepeRef.current;
        if (!c || !readyRef.current) return false;
        try {
          let ok = false;
          c.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const max = view.state.doc.content.size;
            const f = Math.max(1, Math.min(from, max));
            const t = Math.max(f, Math.min(to, max));
            try {
              const sel = TextSelection.create(view.state.doc, f, t);
              view.dispatch(view.state.tr.setSelection(sel));
              ok = true;
            } catch {
              const sel = TextSelection.near(view.state.doc.resolve(f));
              view.dispatch(view.state.tr.setSelection(sel));
              ok = true;
            }
            view.focus();
          });
          return ok;
        } catch {
          return false;
        }
      },
      insertLatexSourceAtCursor: (
        source: string,
        opts?: { afterSelection?: boolean },
      ) => {
        const c = crepeRef.current;
        if (!c || !readyRef.current) return false;
        const body = extractFormulaLatex(source) || source.trim();
        if (!body) return false;
        const after = !!opts?.afterSelection;
        try {
          let ok = false;
          c.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const codeBlock = codeBlockSchema.type(ctx);
            const { state } = view;
            const node = codeBlock.create(
              { language: "LaTeX" },
              state.schema.text(body),
            );
            let tr = state.tr;
            if (!state.selection.empty) {
              if (after) {
                // 保留选区：折叠到终点再插入
                const end = state.selection.to;
                tr = tr.setSelection(TextSelection.create(state.doc, end));
              } else {
                tr = tr.deleteSelection();
              }
            }
            const $ = tr.selection.$from;
            if (
              $.depth === 1 &&
              $.parent.type.name === "paragraph" &&
              $.parent.content.size === 0
            ) {
              tr = tr.replaceWith($.before(), $.after(), node);
              view.dispatch(tr.scrollIntoView());
              view.focus();
              ok = true;
              return;
            }
            let insertPos: number | null = null;
            for (let d = $.depth; d >= 1; d--) {
              const parent = $.node(d);
              const index = $.index(d);
              if (parent.canReplaceWith(index + 1, index + 1, codeBlock)) {
                insertPos = $.after(d);
                break;
              }
            }
            if (insertPos == null) {
              const end = tr.doc.content.size;
              if (
                tr.doc.canReplaceWith(
                  tr.doc.childCount,
                  tr.doc.childCount,
                  codeBlock,
                )
              ) {
                insertPos = end;
              }
            }
            if (insertPos == null) return;
            tr = tr.insert(insertPos, node);
            tr = tr.setSelection(
              TextSelection.near(tr.doc.resolve(insertPos + 1)),
            );
            view.dispatch(tr.scrollIntoView());
            view.focus();
            ok = true;
          });
          if (ok) return true;
        } catch {
          /* fall through */
        }
        try {
          const md = c.getMarkdown();
          applyMarkdown(
            c,
            `${md.trimEnd()}\n\n${ensureFormulaMarkdown(body)}\n`,
            false,
          );
          return true;
        } catch {
          return false;
        }
      },
      insertMermaidSourceAtCursor: (
        source: string,
        opts?: { afterSelection?: boolean },
      ) => {
        const c = crepeRef.current;
        if (!c || !readyRef.current) return false;
        // 入参可以是纯源码或带围栏/前言的 AI 全文
        const body =
          extractMermaidSource(source) ||
          prepareMermaidSource(source) ||
          DEFAULT_MERMAID_TEMPLATE;
        const after = !!opts?.afterSelection;
        try {
          let ok = false;
          c.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const codeBlock = codeBlockSchema.type(ctx);
            const { state } = view;
            const node = codeBlock.create(
              { language: "mermaid" },
              state.schema.text(body),
            );
            let tr = state.tr;
            if (!state.selection.empty) {
              if (after) {
                const end = state.selection.to;
                tr = tr.setSelection(TextSelection.create(state.doc, end));
              } else {
                tr = tr.deleteSelection();
              }
            }
            const $ = tr.selection.$from;
            // 空顶层段落：直接替换为 code_block
            if (
              $.depth === 1 &&
              $.parent.type.name === "paragraph" &&
              $.parent.content.size === 0 &&
              $.parent.type !== codeBlock
            ) {
              tr = tr.replaceWith($.before(), $.after(), node);
              view.dispatch(tr.scrollIntoView());
              view.focus();
              ok = true;
              return;
            }
            // 向上找到允许插入 code_block 的父级（避开 list_item / table 等）
            let insertPos: number | null = null;
            for (let d = $.depth; d >= 1; d--) {
              const parent = $.node(d);
              const index = $.index(d);
              if (parent.canReplaceWith(index + 1, index + 1, codeBlock)) {
                insertPos = $.after(d);
                break;
              }
              if (parent.canReplaceWith(index, index, codeBlock) && d === 1) {
                // 当前顶层块可被替换（少见）
                insertPos = $.before(d);
                tr = tr.replaceWith($.before(d), $.after(d), node);
                view.dispatch(tr.scrollIntoView());
                view.focus();
                ok = true;
                return;
              }
            }
            if (insertPos == null) {
              // 文档末尾
              const end = tr.doc.content.size;
              if (tr.doc.canReplaceWith(tr.doc.childCount, tr.doc.childCount, codeBlock)) {
                insertPos = end;
              }
            }
            if (insertPos == null) return;
            tr = tr.insert(insertPos, node);
            tr = tr.setSelection(
              TextSelection.near(tr.doc.resolve(insertPos + 1)),
            );
            view.dispatch(tr.scrollIntoView());
            view.focus();
            ok = true;
          });
          if (ok) return true;
        } catch {
          /* fall through */
        }
        // 回退：与菜单栏「Mermaid 图」相同，整篇 replaceAll 追加围栏（可稳定触发预览）
        try {
          const md = c.getMarkdown();
          applyMarkdown(
            c,
            `${md.trimEnd()}\n\n\`\`\`mermaid\n${body}\n\`\`\`\n`,
            false,
          );
          return true;
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
            buildMenu: (builder) => {
              const advanced = builder.getGroup("advanced");
              advanced.addItem("mermaid", {
                label: "Mermaid 图",
                icon: mermaidMenuIcon,
                onRun: (ctx: Ctx) => {
                  const commands = ctx.get(commandsCtx);
                  const view = ctx.get(editorViewCtx);
                  const codeBlock = codeBlockSchema.type(ctx);
                  commands.call(clearTextInCurrentBlockCommand.key);
                  commands.call(setBlockTypeCommand.key, {
                    nodeType: codeBlock,
                    attrs: { language: "mermaid" },
                  });
                  const { state, dispatch } = view;
                  const { from } = state.selection;
                  dispatch(state.tr.insertText(DEFAULT_MERMAID_TEMPLATE, from));
                },
              });
            },
          },
        },
      });
      crepe.editor
        .config((ctx) => {
          ctx.update(codeBlockConfig.key, (prev) => ({
            ...prev,
            renderPreview: (language, content, applyPreview) => {
              if (shouldRenderMermaid(language, content)) {
                return renderMermaidPreview(content, applyPreview);
              }
              return prev.renderPreview(language, content, applyPreview);
            },
            previewOnlyByDefault: true,
            previewToggleButton: (previewOnlyMode) =>
              previewOnlyMode ? "编辑源码" : "隐藏源码",
            previewLabel: "预览",
            previewLoading: "正在渲染 Mermaid…",
          }));
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
        const host = rootRef.current;
        if (host) {
          formulaDisposeRef.current?.();
          formulaDisposeRef.current = attachFormulaVisualEdit(
            host,
            crepe,
            (req) => setFormulaReq(req),
          );
        }
      });
      return () => {
        disposed = true;
        readyRef.current = false;
        formulaDisposeRef.current?.();
        formulaDisposeRef.current = null;
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
      <>
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
        <FormulaVisualEditor
          open={!!formulaReq}
          initialLatex={formulaReq?.latex ?? ""}
          initialKind={
            formulaReq ? formulaRequestDisplayKind(formulaReq) : "inline"
          }
          isInsert={formulaReq ? isFormulaInsertRequest(formulaReq) : false}
          title={
            formulaReq &&
            (formulaReq.kind === "block" ||
              formulaReq.kind === "insert-block")
              ? "可视化公式（块级）"
              : "可视化公式"
          }
          onCancel={() => setFormulaReq(null)}
          onConfirm={(latex, kind) => {
            const crepe = crepeRef.current;
            const req = formulaReq;
            setFormulaReq(null);
            if (!crepe || !req) return;
            applyFormulaLatex(crepe, req, latex, kind);
          }}
        />
      </>
    );
  },
);

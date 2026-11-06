import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  EditorView,
  keymap,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  lineNumbers,
} from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
} from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches, search } from "@codemirror/search";
import {
  DEFAULT_THEME,
  themeIsDark,
  type ThemeId,
} from "../theme/androidStudio";
import { syntaxHighlightExtension } from "../editors/highlightStyles";

export type SourceEditorHandle = {
  scrollToLine: (line: number) => void;
  selectRange: (from: number, to: number) => void;
  focus: () => void;
  getSelection: () => string | null;
  getSelectionRange: () => { from: number; to: number; text: string } | null;
  replaceSelection: (text: string) => boolean;
  insertAtCursor: (
    text: string,
    opts?: { afterSelection?: boolean },
  ) => boolean;
  getHost: () => HTMLElement | null;
};

type Props = {
  value: string;
  onChange: (v: string) => void;
  theme?: ThemeId;
  active?: boolean;
  /** 语言/补全/lint 等，由编辑器模块提供 */
  extensions?: Extension[];
  /** 语言标识，变化时重建编辑器 */
  extensionsKey?: string;
  onContextMenu?: (e: MouseEvent) => void;
};

export const SourceEditor = forwardRef<SourceEditorHandle, Props>(
  function SourceEditor(
    {
      value,
      onChange,
      theme = DEFAULT_THEME,
      active = true,
      extensions = [],
      extensionsKey = "default",
      onContextMenu,
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const onContextMenuRef = useRef(onContextMenu);
    onChangeRef.current = onChange;
    onContextMenuRef.current = onContextMenu;
    const suppressRef = useRef(false);
    const extKey = extensionsKey;

    useImperativeHandle(ref, () => ({
      scrollToLine: (line: number) => {
        const view = viewRef.current;
        if (!view) return;
        const doc = view.state.doc;
        const target = Math.max(1, Math.min(line, doc.lines));
        const lineObj = doc.line(target);
        view.dispatch({
          selection: { anchor: lineObj.from },
          effects: EditorView.scrollIntoView(lineObj.from, { y: "start" }),
        });
        view.focus();
      },
      selectRange: (from: number, to: number) => {
        const view = viewRef.current;
        if (!view) return;
        const max = view.state.doc.length;
        const a = Math.max(0, Math.min(from, max));
        const b = Math.max(a, Math.min(to, max));
        view.dispatch({
          selection: { anchor: a, head: b },
          effects: EditorView.scrollIntoView(a, { y: "center" }),
        });
        view.focus();
      },
      focus: () => viewRef.current?.focus(),
      getHost: () => hostRef.current,
      getSelection: () => {
        const view = viewRef.current;
        if (!view) return null;
        const { from, to } = view.state.selection.main;
        if (from === to) return null;
        const text = view.state.sliceDoc(from, to);
        return text.trim() ? text : null;
      },
      getSelectionRange: () => {
        const view = viewRef.current;
        if (!view) return null;
        const { from, to } = view.state.selection.main;
        if (from === to) return null;
        const text = view.state.sliceDoc(from, to);
        if (!text.trim()) return null;
        return { from, to, text };
      },
      replaceSelection: (text: string) => {
        const view = viewRef.current;
        if (!view) return false;
        const { from, to } = view.state.selection.main;
        if (from === to) return false;
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
        });
        return true;
      },
      insertAtCursor: (text: string, opts?: { afterSelection?: boolean }) => {
        const view = viewRef.current;
        if (!view) return false;
        const { from, to } = view.state.selection.main;
        const insert = text.trim() ? `\n\n${text.trim()}\n\n` : text;
        if (opts?.afterSelection) {
          view.dispatch({
            changes: { from: to, to, insert },
            selection: { anchor: to + insert.length },
          });
          return true;
        }
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
        });
        return true;
      },
    }));

    useEffect(() => {
      const el = hostRef.current;
      if (!el) return;

      const onUpdate = EditorView.updateListener.of((u) => {
        if (suppressRef.current) return;
        if (u.docChanged) onChangeRef.current(u.state.doc.toString());
      });

      const dark = themeIsDark(theme);
      const themeExt = EditorView.theme(
        {
          "&": {
            height: "100%",
            fontSize: "14px",
            backgroundColor: "var(--editor-bg)",
            // 基底色；词法 token 由 HighlightStyle 单独着色，勿写到 .cm-content
            color: "var(--text)",
          },
          ".cm-content": {
            fontFamily: "var(--font-editor)",
            caretColor: "var(--editor-caret)",
            padding: "20px 0",
            // 不设 color，避免盖住 HighlightStyle 的 JSON/代码 token 着色
          },
          ".cm-gutters": {
            backgroundColor: "var(--editor-gutter)",
            color: "var(--muted)",
            border: "none",
          },
          ".cm-activeLine, .cm-activeLineGutter": {
            backgroundColor: "transparent",
          },
          "&.cm-focused .cm-activeLine, &.cm-focused .cm-activeLineGutter": {
            backgroundColor: "var(--editor-active-line)",
          },
          "&.cm-focused .cm-cursor": {
            borderLeftColor: "var(--editor-caret)",
          },
          "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
            backgroundColor: "var(--editor-selection)",
          },
        },
        { dark },
      );

      const state = EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          foldGutter(),
          drawSelection(),
          history(),
          bracketMatching(),
          ...extensions,
          syntaxHighlightExtension(dark),
          search(),
          highlightSelectionMatches(),
          EditorView.lineWrapping,
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          onUpdate,
          themeExt,
        ],
      });
      const view = new EditorView({ state, parent: el });
      viewRef.current = view;
      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [theme, extKey]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const cur = view.state.doc.toString();
      if (cur === value) return;
      suppressRef.current = true;
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: value },
      });
      suppressRef.current = false;
    }, [value]);

    useEffect(() => {
      if (active) {
        viewRef.current?.focus();
      }
    }, [active]);

    useEffect(() => {
      const el = hostRef.current;
      if (!el) return;
      const onCtx = (e: MouseEvent) => onContextMenuRef.current?.(e);
      el.addEventListener("contextmenu", onCtx);
      return () => el.removeEventListener("contextmenu", onCtx);
    }, []);

    return (
      <div
        className={"source-host" + (active ? " is-active" : "")}
        ref={hostRef}
        hidden={!active}
        aria-hidden={!active}
      />
    );
  },
);

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  EditorView,
  keymap,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  lineNumbers,
} from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  bracketMatching,
  defaultHighlightStyle,
  syntaxHighlighting,
  foldGutter,
  foldKeymap,
} from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches, search } from "@codemirror/search";
import {
  DEFAULT_THEME,
  themeIsDark,
  type ThemeId,
} from "../theme/androidStudio";

export type SourceEditorHandle = {
  scrollToLine: (line: number) => void;
  selectRange: (from: number, to: number) => void;
  focus: () => void;
  getSelection: () => string | null;
  replaceSelection: (text: string) => boolean;
  getHost: () => HTMLElement | null;
};

type Props = {
  value: string;
  onChange: (v: string) => void;
  theme?: ThemeId;
  active?: boolean;
  onContextMenu?: (e: MouseEvent) => void;
};

export const SourceEditor = forwardRef<SourceEditorHandle, Props>(
  function SourceEditor(
    { value, onChange, theme = DEFAULT_THEME, active = true, onContextMenu },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const onContextMenuRef = useRef(onContextMenu);
    onChangeRef.current = onChange;
    onContextMenuRef.current = onContextMenu;
    const suppressRef = useRef(false);

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
    }));

    useEffect(() => {
      const el = hostRef.current;
      if (!el) return;

      const onUpdate = EditorView.updateListener.of((u) => {
        if (suppressRef.current) return;
        if (u.docChanged) onChangeRef.current(u.state.doc.toString());
      });

      const themeExt = EditorView.theme(
        {
          "&": {
            height: "100%",
            fontSize: "14px",
            backgroundColor: "var(--editor-bg)",
            color: "var(--text)",
          },
          ".cm-content": {
            fontFamily: "var(--font-editor)",
            caretColor: "var(--editor-caret)",
            padding: "20px 0",
          },
          ".cm-gutters": {
            backgroundColor: "var(--editor-gutter)",
            color: "var(--muted)",
            border: "none",
          },
          ".cm-activeLine": {
            backgroundColor: "var(--editor-active-line)",
          },
          ".cm-activeLineGutter": {
            backgroundColor: "var(--editor-active-line)",
          },
          "&.cm-focused .cm-cursor": {
            borderLeftColor: "var(--editor-caret)",
          },
          "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
            backgroundColor: "var(--editor-selection)",
          },
        },
        { dark: themeIsDark(theme) },
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
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          markdown(),
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
    }, [theme]);

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

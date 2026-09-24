import { useEffect, useRef } from "react";
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

type Props = {
  value: string;
  onChange: (v: string) => void;
  theme?: "light" | "dark";
  active?: boolean;
};

export function SourceEditor({
  value,
  onChange,
  theme = "light",
  active = true,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const suppressRef = useRef(false);

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
          backgroundColor: theme === "dark" ? "#1c1917" : "#ffffff",
          color: theme === "dark" ? "#fafaf9" : "#1c1917",
        },
        ".cm-content": {
          fontFamily:
            'Consolas, "Cascadia Code", "Sarasa Mono SC", monospace',
          caretColor: theme === "dark" ? "#2dd4bf" : "#0f766e",
          padding: "20px 0",
        },
        ".cm-gutters": {
          backgroundColor: theme === "dark" ? "#231f1d" : "#f0ebe3",
          color: theme === "dark" ? "#a8a29e" : "#78716c",
          border: "none",
        },
        ".cm-activeLine": {
          backgroundColor:
            theme === "dark"
              ? "rgba(45, 212, 191, 0.08)"
              : "rgba(15, 118, 110, 0.06)",
        },
        ".cm-activeLineGutter": {
          backgroundColor:
            theme === "dark"
              ? "rgba(45, 212, 191, 0.12)"
              : "rgba(15, 118, 110, 0.1)",
        },
        "&.cm-focused .cm-cursor": {
          borderLeftColor: theme === "dark" ? "#2dd4bf" : "#0f766e",
        },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
          backgroundColor:
            theme === "dark"
              ? "rgba(45, 212, 191, 0.28)"
              : "rgba(15, 118, 110, 0.2)",
        },
      },
      { dark: theme === "dark" },
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
        EditorView.lineWrapping,
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
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
    // remount when theme changes for clean theme swap
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

  return (
    <div
      className={"source-host" + (active ? " is-active" : "")}
      ref={hostRef}
      hidden={!active}
      aria-hidden={!active}
    />
  );
}

import type { Extension } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { xml } from "@codemirror/lang-xml";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { StreamLanguage } from "@codemirror/language";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { keymap } from "@codemirror/view";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { load as yamlLoad } from "js-yaml";
import { parse as parseToml, TomlError } from "smol-toml";
import type { SourceLanguage } from "../docKind";

function iniLanguage(): Extension {
  // legacy-modes 与 language 包偶有类型冲突，运行时可用
  return StreamLanguage.define(properties as never);
}

function shellLanguage(): Extension {
  return StreamLanguage.define(shell as never);
}

function tomlLanguage(): Extension {
  return StreamLanguage.define(toml as never);
}

function tomlLinter() {
  return linter((view) => {
    const text = view.state.doc.toString();
    if (!text.trim()) return [];
    try {
      parseToml(text);
      return [];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      let from = 0;
      let to = Math.min(view.state.doc.length, 1);
      if (e instanceof TomlError) {
        const lineNo = Math.max(1, e.line);
        const line = view.state.doc.line(
          Math.min(lineNo, view.state.doc.lines),
        );
        const col = Math.max(0, (e.column || 1) - 1);
        from = Math.min(line.from + col, line.to);
        to = line.to;
      } else {
        const m =
          msg.match(/line\s+(\d+)/i) ||
          msg.match(/\((\d+):(\d+)\)/);
        if (m) {
          const lineNo = Math.max(1, Number(m[1]));
          const line = view.state.doc.line(
            Math.min(lineNo, view.state.doc.lines),
          );
          from = line.from;
          to = line.to;
        }
      }
      const diag: Diagnostic = {
        from,
        to: Math.max(to, from + 1),
        severity: "error",
        message: msg,
      };
      return [diag];
    }
  });
}

function yamlLinter() {
  return linter((view) => {
    const text = view.state.doc.toString();
    if (!text.trim()) return [];
    try {
      yamlLoad(text);
      return [];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      let from = 0;
      let to = Math.min(view.state.doc.length, 1);
      const m = msg.match(/line\s+(\d+)/i);
      if (m) {
        const lineNo = Math.max(1, Number(m[1]));
        const line = view.state.doc.line(
          Math.min(lineNo, view.state.doc.lines),
        );
        from = line.from;
        to = line.to;
      }
      const diag: Diagnostic = {
        from,
        to,
        severity: "error",
        message: msg,
      };
      return [diag];
    }
  });
}

function iniCompletions(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/\S*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const doc = context.state.doc.toString();
  const sections = [...doc.matchAll(/^\[([^\]]*)\]/gm)].map((m) => m[1] ?? "");
  const keys = [...doc.matchAll(/^([A-Za-z0-9_.-]+)\s*=/gm)].map(
    (m) => m[1] ?? "",
  );
  const options = [
    ...new Set([
      ...sections.map((s) => `[${s}]`),
      ...keys,
      "[section]",
      "key=value",
    ]),
  ].map((label) => ({ label, type: "keyword" as const }));
  return { from: word.from, options, validFor: /\S*/ };
}

function iniLinter() {
  return linter((view) => {
    const diags: Diagnostic[] = [];
    const seen = new Map<string, number>();
    let section = "";
    for (let i = 1; i <= view.state.doc.lines; i++) {
      const line = view.state.doc.line(i);
      const t = line.text.trim();
      if (!t || t.startsWith("#") || t.startsWith(";")) continue;
      const sec = t.match(/^\[([^\]]*)\]$/);
      if (sec) {
        section = sec[1] ?? "";
        if (!section) {
          diags.push({
            from: line.from,
            to: line.to,
            severity: "warning",
            message: "空节名",
          });
        }
        continue;
      }
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      const id = `${section}::${key}`;
      if (seen.has(id)) {
        diags.push({
          from: line.from,
          to: line.to,
          severity: "warning",
          message: `重复键「${key}」`,
        });
      } else {
        seen.set(id, i);
      }
    }
    return diags;
  });
}

function languageCore(lang: SourceLanguage): Extension[] {
  switch (lang) {
    case "markdown":
      return [markdown()];
    case "json":
      return [json(), linter(jsonParseLinter()), lintGutter()];
    case "yaml":
      return [yaml(), yamlLinter(), lintGutter()];
    case "ini":
      return [
        iniLanguage(),
        autocompletion({ override: [iniCompletions] }),
        iniLinter(),
        lintGutter(),
      ];
    case "javascript":
      return [javascript()];
    case "typescript":
      return [javascript({ typescript: true })];
    case "html":
      return [html()];
    case "css":
      return [css()];
    case "xml":
      return [xml()];
    case "python":
      return [python()];
    case "sql":
      return [sql()];
    case "shell":
      return [shellLanguage()];
    case "toml":
      return [tomlLanguage(), tomlLinter(), lintGutter()];
    default:
      return [];
  }
}

/** 源码侧：语言 + 通用自动补全快捷键。 */
export function buildSourceExtensions(lang: SourceLanguage): Extension[] {
  return [
    ...languageCore(lang),
    autocompletion(),
    keymap.of(completionKeymap),
  ];
}

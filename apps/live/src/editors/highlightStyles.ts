import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/** 亮色：JSON/YAML/代码等可读着色 */
const lightHighlight = HighlightStyle.define([
  { tag: t.propertyName, color: "#0550ae" },
  { tag: t.string, color: "#0a3069" },
  { tag: t.number, color: "#0550ae" },
  { tag: t.bool, color: "#cf222e" },
  { tag: t.null, color: "#cf222e" },
  { tag: t.keyword, color: "#cf222e" },
  { tag: t.operator, color: "#0550ae" },
  { tag: t.punctuation, color: "#6e7781" },
  { tag: t.bracket, color: "#24292f" },
  { tag: t.comment, color: "#6e7781", fontStyle: "italic" },
  { tag: t.variableName, color: "#953800" },
  { tag: t.definition(t.variableName), color: "#953800" },
  { tag: t.typeName, color: "#116329" },
  { tag: t.className, color: "#116329" },
  { tag: t.function(t.variableName), color: "#8250df" },
  { tag: t.tagName, color: "#116329" },
  { tag: t.attributeName, color: "#0550ae" },
  { tag: t.heading, color: "#0550ae", fontWeight: "bold" },
  { tag: t.link, color: "#0969da" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.invalid, color: "#cf222e" },
  { tag: t.meta, color: "#6e7781" },
]);

/** 暗色 */
const darkHighlight = HighlightStyle.define([
  { tag: t.propertyName, color: "#79c0ff" },
  { tag: t.string, color: "#a5d6ff" },
  { tag: t.number, color: "#79c0ff" },
  { tag: t.bool, color: "#ff7b72" },
  { tag: t.null, color: "#ff7b72" },
  { tag: t.keyword, color: "#ff7b72" },
  { tag: t.operator, color: "#79c0ff" },
  { tag: t.punctuation, color: "#8b949e" },
  { tag: t.bracket, color: "#e6edf3" },
  { tag: t.comment, color: "#8b949e", fontStyle: "italic" },
  { tag: t.variableName, color: "#ffa657" },
  { tag: t.definition(t.variableName), color: "#ffa657" },
  { tag: t.typeName, color: "#7ee787" },
  { tag: t.className, color: "#7ee787" },
  { tag: t.function(t.variableName), color: "#d2a8ff" },
  { tag: t.tagName, color: "#7ee787" },
  { tag: t.attributeName, color: "#79c0ff" },
  { tag: t.heading, color: "#79c0ff", fontWeight: "bold" },
  { tag: t.link, color: "#a5d6ff" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.invalid, color: "#ff7b72" },
  { tag: t.meta, color: "#8b949e" },
]);

export function syntaxHighlightExtension(dark: boolean): Extension {
  return syntaxHighlighting(dark ? darkHighlight : lightHighlight, {
    fallback: true,
  });
}

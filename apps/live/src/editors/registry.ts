import type { DocKind } from "../docKind";
import { sourceLanguage, tabDocKind, tabPath } from "../docKind";
import { buildSourceExtensions } from "./sourceSupport";
import type { EditorModule } from "./types";

function moduleFor(
  kind: DocKind,
  path?: string | null,
): EditorModule {
  const lang = sourceLanguage(kind, path);
  if (kind === "markdown") {
    return {
      id: "markdown",
      kind,
      live: "crepe",
      sourceLanguage: "markdown",
      sourceExtensions: () => buildSourceExtensions("markdown"),
      allowToggleSource: true,
    };
  }
  if (kind === "json") {
    return {
      id: "json",
      kind,
      live: "structured",
      structuredKind: "json",
      sourceLanguage: "json",
      sourceExtensions: () => buildSourceExtensions("json"),
      allowToggleSource: true,
    };
  }
  if (kind === "yaml") {
    return {
      id: "yaml",
      kind,
      live: "structured",
      structuredKind: "yaml",
      sourceLanguage: "yaml",
      sourceExtensions: () => buildSourceExtensions("yaml"),
      allowToggleSource: true,
    };
  }
  if (kind === "ini") {
    return {
      id: "ini",
      kind,
      live: "structured",
      structuredKind: "ini",
      sourceLanguage: "ini",
      sourceExtensions: () => buildSourceExtensions("ini"),
      allowToggleSource: true,
    };
  }
  return {
    id: `plain:${lang}`,
    kind: "plain",
    live: "source",
    sourceLanguage: lang,
    sourceExtensions: () => buildSourceExtensions(lang),
    allowToggleSource: false,
  };
}

export function getEditorModule(
  kindOrTab:
    | DocKind
    | {
        docKind?: DocKind;
        relPath?: string;
        absPath?: string;
      },
  pathHint?: string | null,
): EditorModule {
  if (typeof kindOrTab === "string") {
    return moduleFor(kindOrTab, pathHint);
  }
  const kind = tabDocKind(kindOrTab);
  const path = pathHint ?? tabPath(kindOrTab);
  return moduleFor(kind, path);
}

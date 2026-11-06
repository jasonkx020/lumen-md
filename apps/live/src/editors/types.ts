import type { Extension } from "@codemirror/state";
import type { DocKind, SourceLanguage } from "../docKind";

export type LiveMode = "crepe" | "structured" | "source";

export type StructuredKind = "json" | "yaml" | "ini";

export type EditorModule = {
  id: string;
  kind: DocKind;
  live: LiveMode;
  structuredKind?: StructuredKind;
  sourceLanguage: SourceLanguage;
  /** 语言高亮 + 补全 + lint（不含主题/基础编辑器外壳） */
  sourceExtensions: () => Extension[];
  allowToggleSource: boolean;
};

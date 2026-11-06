import { dump as yamlDump, load as yamlLoad } from "js-yaml";
import type { DocKind } from "../docKind";
import { parseIni, serializeIni, type IniDoc } from "./ini";

export type StructuredValue = unknown;

export type ParseOk = {
  ok: true;
  value: StructuredValue;
};

export type ParseErr = {
  ok: false;
  error: string;
};

export type ParseResult = ParseOk | ParseErr;

export function parseStructured(
  kind: "json" | "yaml" | "ini",
  text: string,
): ParseResult {
  try {
    if (kind === "json") {
      if (!text.trim()) return { ok: true, value: {} };
      return { ok: true, value: JSON.parse(text) as StructuredValue };
    }
    if (kind === "yaml") {
      if (!text.trim()) return { ok: true, value: {} };
      const v = yamlLoad(text);
      return { ok: true, value: v ?? {} };
    }
    return { ok: true, value: parseIni(text) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function serializeStructured(
  kind: "json" | "yaml" | "ini",
  value: StructuredValue,
): string {
  if (kind === "json") {
    return JSON.stringify(value, null, 2) + "\n";
  }
  if (kind === "yaml") {
    return yamlDump(value, {
      indent: 2,
      lineWidth: 100,
      noRefs: true,
      sortKeys: false,
    });
  }
  return serializeIni(value as IniDoc);
}

export function isStructuredDocKind(
  kind: DocKind,
): kind is "json" | "yaml" | "ini" {
  return kind === "json" || kind === "yaml" || kind === "ini";
}

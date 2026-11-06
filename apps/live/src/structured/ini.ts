export type IniSection = {
  name: string;
  entries: { key: string; value: string }[];
};

export type IniDoc = {
  sections: IniSection[];
};

/** 轻量 INI：`[section]` + `key=value`；`#`/`;` 行在序列化时不保真。 */
export function parseIni(text: string): IniDoc {
  const sections: IniSection[] = [];
  let current: IniSection = { name: "", entries: [] };
  sections.push(current);

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sec = line.match(/^\[([^\]]*)\]$/);
    if (sec) {
      current = { name: sec[1] ?? "", entries: [] };
      sections.push(current);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      current.entries.push({ key: line, value: "" });
    } else {
      current.entries.push({
        key: line.slice(0, eq).trim(),
        value: line.slice(eq + 1).trim(),
      });
    }
  }

  // 去掉空的默认节（无条目）
  const cleaned = sections.filter(
    (s, i) => !(i === 0 && s.name === "" && s.entries.length === 0),
  );
  return { sections: cleaned.length ? cleaned : [{ name: "", entries: [] }] };
}

export function serializeIni(doc: IniDoc): string {
  const lines: string[] = [];
  for (const sec of doc.sections) {
    if (sec.name !== "" || lines.length > 0) {
      if (lines.length) lines.push("");
      lines.push(`[${sec.name}]`);
    }
    for (const e of sec.entries) {
      lines.push(`${e.key}=${e.value}`);
    }
  }
  return lines.join("\n") + (lines.length ? "\n" : "");
}

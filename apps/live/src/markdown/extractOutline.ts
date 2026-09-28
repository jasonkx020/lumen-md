export type OutlineHeading = {
  level: number;
  text: string;
  line: number;
  index: number;
};

/** 解析 ATX 标题，跳过围栏代码块内的 #。 */
export function extractOutline(markdown: string): OutlineHeading[] {
  const lines = markdown.split("\n");
  const out: OutlineHeading[] = [];
  let inFence = false;
  let fenceMarker = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^(```|~~~)/.exec(line);
    if (fence) {
      const marker = fence[1]!;
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (line.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (inFence) continue;

    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    out.push({
      level: m[1]!.length,
      text: m[2]!.replace(/\s+#+\s*$/, "").trim(),
      line: i + 1,
      index: out.length,
    });
  }
  return out;
}

/** 将标题文本规范化为可匹配锚点（简化 Typora/GFM 风格）。 */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-_/]/gu, "")
    .replace(/\s+/g, "-");
}

export function findHeadingByAnchor(
  headings: OutlineHeading[],
  anchor: string,
): OutlineHeading | undefined {
  const raw = anchor.replace(/^#/, "").trim();
  if (!raw) return headings[0];
  const slug = slugifyHeading(decodeURIComponent(raw));
  return (
    headings.find((h) => slugifyHeading(h.text) === slug) ??
    headings.find((h) => h.text === raw) ??
    headings.find((h) => h.text.includes(raw))
  );
}

/** Markdown 公式区间解析（无 DOM / KaTeX 依赖）。 */

export type MathSpan = {
  start: number;
  end: number;
  tex: string;
  display: boolean;
};

function isEscaped(src: string, i: number): boolean {
  let n = 0;
  for (let k = i - 1; k >= 0 && src[k] === "\\"; k--) n += 1;
  return n % 2 === 1;
}

function atLineStart(src: string, i: number): boolean {
  return i === 0 || src[i - 1] === "\n";
}

function isMathFenceInfo(info: string): boolean {
  const lang = info.split(/\s+/)[0] ?? "";
  return lang === "math" || lang === "latex" || lang === "tex";
}

/** 收集 `$…$` / `$$…$$` / ```math|latex|tex 公式区间（跳过普通代码围栏）。 */
export function collectMathSpans(src: string): MathSpan[] {
  const out: MathSpan[] = [];
  let i = 0;
  while (i < src.length) {
    if (atLineStart(src, i) && (src.startsWith("```", i) || src.startsWith("~~~", i))) {
      const fenceChar = src[i]!;
      let fenceLen = 0;
      while (i + fenceLen < src.length && src[i + fenceLen] === fenceChar) {
        fenceLen += 1;
      }
      const firstNl = src.indexOf("\n", i);
      if (firstNl < 0) break;
      const info = src.slice(i + fenceLen, firstNl).trim().toLowerCase();
      const bodyStart = firstNl + 1;
      const closeRe = new RegExp(
        `\\n${fenceChar}{${fenceLen},}[ \\t]*(?:\\n|$)`,
      );
      const rest = src.slice(bodyStart - 1);
      const m = closeRe.exec(rest);
      const fenceEnd = m
        ? bodyStart - 1 + m.index + m[0].length
        : src.length;
      const bodyEnd = m ? bodyStart - 1 + m.index : src.length;
      if (isMathFenceInfo(info)) {
        const tex = src.slice(bodyStart, bodyEnd).replace(/^\n+|\n+$/g, "");
        if (tex.trim()) {
          out.push({ start: i, end: fenceEnd, tex, display: true });
        }
      }
      i = fenceEnd;
      continue;
    }

    if (src.startsWith("$$", i) && !isEscaped(src, i)) {
      let c = src.indexOf("$$", i + 2);
      while (c >= 0 && isEscaped(src, c)) {
        c = src.indexOf("$$", c + 2);
      }
      if (c < 0) break;
      out.push({
        start: i,
        end: c + 2,
        tex: src.slice(i + 2, c),
        display: true,
      });
      i = c + 2;
      continue;
    }

    if (src[i] === "$" && !isEscaped(src, i) && src[i + 1] !== "$") {
      let j = i + 1;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "$" && !isEscaped(src, j) && src[j + 1] !== "$") {
          const tex = src.slice(i + 1, j);
          if (tex.trim()) {
            out.push({ start: i, end: j + 1, tex, display: false });
          }
          i = j + 1;
          j = -1;
          break;
        }
        j += 1;
      }
      if (j === -1) continue;
      i += 1;
      continue;
    }

    i += 1;
  }
  return out;
}

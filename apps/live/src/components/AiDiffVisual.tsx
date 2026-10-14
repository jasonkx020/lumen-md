import { useEffect, useId, useMemo, useState } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import mermaid from "mermaid";
import { extractMermaidSource } from "../diagrams/normalizeMermaidMd";
import { markdownToHtmlString } from "../api";

export type DiffVisualKind = "mermaid" | "formula" | "markdown" | "plain";
export { extractMermaidSource } from "../diagrams/normalizeMermaidMd";

let mermaidReady = false;
function ensureMermaid() {
  if (mermaidReady) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    theme: "neutral",
  });
  mermaidReady = true;
}

function stripOuterLatexFence(text: string): string {
  const t = text.trim().replace(/\r\n/g, "\n");
  const fence = t.match(/^```\s*(?:latex|tex|math)[^\n]*\n([\s\S]*?)\n```\s*$/i);
  return fence ? (fence[1] ?? "").trim() : t;
}

/** 几乎整段都是公式时走 KaTeX */
export function extractFormulaBlocks(text: string): string[] | null {
  const t = stripOuterLatexFence(text);
  if (!t) return null;
  const display = [...t.matchAll(/\$\$([\s\S]+?)\$\$/g)].map((m) =>
    (m[1] ?? "").trim(),
  );
  if (display.length > 0) {
    const rest = t.replace(/\$\$[\s\S]+?\$\$/g, "").replace(/\$[^$\n]+\$/g, "").trim();
    if (rest.length < 24) return display;
  }
  // 单行裸公式或整段 LaTeX
  if (
    /^\\[a-zA-Z{]/.test(t) ||
    (/[=\\^_{}]/.test(t) && !/[一-龥]/.test(t) && t.length < 400)
  ) {
    return [t];
  }
  const onlyInline = t.match(/^\$([^$\n]+)\$\s*$/);
  if (onlyInline) return [(onlyInline[1] ?? "").trim()];
  return null;
}

export function classifyDiffContent(text: string): DiffVisualKind {
  if (extractMermaidSource(text)) return "mermaid";
  if (extractFormulaBlocks(text)) return "formula";
  const t = text.trim();
  if (!t) return "plain";
  // 表格 / 标题 / 列表 / 代码围栏 → 富文本预览
  if (
    /^\|.+\|/m.test(t) ||
    /^#{1,6}\s/m.test(t) ||
    /^[-*+]\s/m.test(t) ||
    /^\d+\.\s/m.test(t) ||
    /```/.test(t) ||
    /\$\$/.test(t) ||
    /<\/?(?:table|tr|td|th|p|h[1-6])\b/i.test(t)
  ) {
    return "markdown";
  }
  return "plain";
}

type PaneProps = {
  text: string;
  variant: "before" | "after";
  /** 插入类任务的「处理前」多为提示语，默认源码即可 */
  defaultVisual?: boolean;
  /** 识图：左侧直接展示用户上传图 */
  inputImages?: string[];
  beforeTitle?: string;
};

export function AiDiffPane({
  text,
  variant,
  defaultVisual,
  inputImages,
  beforeTitle,
}: PaneProps) {
  const kind = useMemo(() => classifyDiffContent(text), [text]);
  const showInputImages =
    variant === "before" && (inputImages?.length ?? 0) > 0;
  const canVisual = showInputImages || kind !== "plain";
  const [mode, setMode] = useState<"visual" | "source">(() =>
    showInputImages ||
    (canVisual && (defaultVisual ?? variant === "after"))
      ? "visual"
      : "source",
  );

  // 内容变化时，若可预览则回到可视化
  useEffect(() => {
    if (
      showInputImages ||
      (canVisual && (defaultVisual ?? variant === "after"))
    ) {
      setMode("visual");
    } else {
      setMode("source");
    }
  }, [text, canVisual, defaultVisual, variant, showInputImages]);

  const title =
    variant === "before"
      ? (beforeTitle ?? "处理前")
      : "处理后";

  return (
    <section className={`ai-diff-col${variant === "after" ? " is-after" : ""}`}>
      <div className="ai-diff-col-head">
        <h3>{title}</h3>
        {canVisual && !showInputImages ? (
          <div className="ai-diff-view-toggle" role="group" aria-label="查看方式">
            <button
              type="button"
              className={mode === "visual" ? "is-active" : undefined}
              onClick={() => setMode("visual")}
            >
              预览
            </button>
            <button
              type="button"
              className={mode === "source" ? "is-active" : undefined}
              onClick={() => setMode("source")}
            >
              源码
            </button>
          </div>
        ) : null}
      </div>
      {showInputImages && mode === "visual" ? (
        <div className="ai-diff-visual ai-diff-input-images">
          {(inputImages ?? []).map((src, i) => (
            <figure key={`${i}-${src.slice(0, 48)}`} className="ai-diff-input-fig">
              <img src={src} alt={`输入图片 ${i + 1}`} />
            </figure>
          ))}
        </div>
      ) : mode === "visual" && canVisual ? (
        <DiffVisualBody text={text} kind={kind} />
      ) : (
        <pre className={`ai-diff-pre${variant === "after" ? " is-after" : ""}`}>
          {text}
        </pre>
      )}
    </section>
  );
}

function DiffVisualBody({
  text,
  kind,
}: {
  text: string;
  kind: DiffVisualKind;
}) {
  if (kind === "mermaid") {
    return <MermaidVisual text={text} />;
  }
  if (kind === "formula") {
    return <FormulaVisual text={text} />;
  }
  return <MarkdownVisual text={text} />;
}

function MermaidVisual({ text }: { text: string }) {
  const reactId = useId().replace(/:/g, "");
  const [err, setErr] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const source = useMemo(() => extractMermaidSource(text), [text]);

  useEffect(() => {
    if (!source) {
      setErr("无法识别流程图源码");
      setSvg(null);
      return;
    }
    let cancelled = false;
    setErr(null);
    setSvg(null);
    ensureMermaid();
    const id = `ai-diff-mmd-${reactId}-${Math.random().toString(36).slice(2, 7)}`;
    void mermaid
      .render(id, source)
      .then((r) => {
        if (!cancelled) setSvg(r.svg);
      })
      .catch((e) => {
        if (!cancelled) {
          setErr(String(e instanceof Error ? e.message : e));
          setSvg(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [source, reactId]);

  if (err) {
    return (
      <div className="ai-diff-visual">
        <pre className="ai-diff-visual-error">{err}</pre>
        <pre className="ai-diff-pre is-after">{text}</pre>
      </div>
    );
  }
  if (!svg) {
    return (
      <div className="ai-diff-visual ai-diff-visual-loading">正在渲染流程图…</div>
    );
  }
  return (
    <div
      className="ai-diff-visual ai-diff-mermaid"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function FormulaVisual({ text }: { text: string }) {
  const blocks = useMemo(() => extractFormulaBlocks(text) ?? [], [text]);
  const html = useMemo(() => {
    return blocks
      .map((tex) => {
        try {
          return katex.renderToString(tex, {
            displayMode: true,
            throwOnError: false,
            strict: "ignore",
            output: "html",
          });
        } catch (e) {
          return `<pre class="ai-diff-visual-error">${String(e)}</pre>`;
        }
      })
      .join("");
  }, [blocks]);

  if (!blocks.length) {
    return <pre className="ai-diff-pre is-after">{text}</pre>;
  }
  return (
    <div
      className="ai-diff-visual ai-diff-formula"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function MarkdownVisual({ text }: { text: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setErr(null);
    void markdownToHtmlString(text)
      .then((h) => {
        if (!cancelled) setHtml(h);
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e instanceof Error ? e.message : e));
      });
    return () => {
      cancelled = true;
    };
  }, [text]);

  if (err) {
    return (
      <div className="ai-diff-visual">
        <pre className="ai-diff-visual-error">{err}</pre>
        <pre className="ai-diff-pre is-after">{text}</pre>
      </div>
    );
  }
  if (!html) {
    return (
      <div className="ai-diff-visual ai-diff-visual-loading">正在渲染预览…</div>
    );
  }
  return (
    <div
      className="ai-diff-visual ai-diff-md"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

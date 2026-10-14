import { llmComplete } from "../api";
import {
  looksLikeMermaidDiagram,
} from "../diagrams/normalizeMermaidMd";
import {
  buildUserMessage,
  getCapability,
  resolveCapabilityContent,
  type AiCapabilityId,
  type AiWriteMode,
} from "./capabilities";

/** 确保流程图结果带 ```mermaid 围栏，否则 Live 不会走预览。 */
function ensureMermaidFence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  if (/^```\s*mermaid\b/i.test(t)) return t;
  // 被剥成「mermaid\nflowchart…」或纯图源
  const body = t.replace(/^mermaid\s*\n/i, "").trim();
  if (looksLikeMermaidDiagram(body) || looksLikeMermaidDiagram(t)) {
    const src = looksLikeMermaidDiagram(body) ? body : t;
    return "```mermaid\n" + src + "\n```";
  }
  return t;
}

export type RunAiInput = {
  id: AiCapabilityId;
  markdown: string;
  selection: string | null;
  note?: string;
  images?: string[];
  supportsMultimodal?: boolean;
  paperStyle?: string;
  paperLayout?: string;
};

export type RunAiResult = {
  before: string;
  text: string;
  writeMode: AiWriteMode;
  /** @deprecated 用 writeMode；保留给 Diff 兼容 */
  replaceSelection: boolean;
  warn?: string;
  label: string;
};

export async function runAiCapability(input: RunAiInput): Promise<RunAiResult> {
  const cap = getCapability(input.id);
  const images = (input.images ?? []).filter((u) => u.trim().length > 0);

  if (cap.requiresMultimodal) {
    if (!input.supportsMultimodal) {
      throw new Error(
        "未启用多模态。请到「设置 → 大模型配置」勾选启用多模态，并确认模型支持视觉。",
      );
    }
    if (images.length === 0) {
      throw new Error("请先在「交付 → 识图入库」中添加图片");
    }
  }

  const scoped = resolveCapabilityContent(input.id, {
    markdown: input.markdown,
    selection: input.selection,
    note: input.note,
    paperStyle: input.paperStyle,
    paperLayout: input.paperLayout,
  });

  // 学科类：note 已并入 content，避免重复
  const noteForMsg =
    cap.scope === "note_or_selection" ? undefined : input.note;
  // 识图：只发短指令 + 可选补充，绝不附带当前文档全文
  const user =
    input.id === "image_to_md"
      ? [
          scoped.content,
          noteForMsg?.trim() ? `【用户补充】${noteForMsg.trim()}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : buildUserMessage(scoped.content, noteForMsg);
  let text = await llmComplete({
    system: cap.systemPrompt,
    user,
    images: images.length > 0 ? images : undefined,
  });
  if (input.id === "gen_mermaid") {
    text = ensureMermaidFence(text);
  }
  return {
    before: scoped.content,
    text,
    writeMode: scoped.writeMode,
    replaceSelection: scoped.writeMode === "replace_selection",
    warn: scoped.warn,
    label: cap.label,
  };
}

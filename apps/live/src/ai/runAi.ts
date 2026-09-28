import { llmComplete } from "../api";
import {
  buildUserMessage,
  getCapability,
  resolveCapabilityContent,
  type AiCapabilityId,
} from "./capabilities";

export type RunAiInput = {
  id: AiCapabilityId;
  markdown: string;
  selection: string | null;
  note?: string;
  /** data URL 图片，需视觉模型 */
  images?: string[];
  supportsMultimodal?: boolean;
};

export type RunAiResult = {
  /** 送入模型的原文（选区或全文），用于对比 */
  before: string;
  text: string;
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
        "当前模型不支持多模态，请在设置中更换视觉模型（如 gpt-4o-mini、glm-4v-flash、qwen-vl-plus、llava）",
      );
    }
    if (images.length === 0) {
      throw new Error("请先在 AI 面板中添加图片");
    }
  }

  const scoped = resolveCapabilityContent(input.id, {
    markdown: input.markdown,
    selection: input.selection,
  });
  const user = buildUserMessage(scoped.content, input.note);
  const text = await llmComplete({
    system: cap.systemPrompt,
    user,
    images: images.length > 0 ? images : undefined,
  });
  return {
    before: scoped.content,
    text,
    replaceSelection: scoped.replaceSelection,
    warn: scoped.warn,
    label: cap.label,
  };
}

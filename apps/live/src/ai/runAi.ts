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
  const scoped = resolveCapabilityContent(input.id, {
    markdown: input.markdown,
    selection: input.selection,
  });
  const user = buildUserMessage(scoped.content, input.note);
  const text = await llmComplete({
    system: cap.systemPrompt,
    user,
  });
  return {
    before: scoped.content,
    text,
    replaceSelection: scoped.replaceSelection,
    warn: scoped.warn,
    label: cap.label,
  };
}

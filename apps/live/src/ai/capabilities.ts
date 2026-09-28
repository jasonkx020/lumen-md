export type AiCapabilityId =
  | "html_to_md"
  | "polish"
  | "rewrite_selection"
  | "optimize_document";

export type AiScope = "full" | "selection_preferred" | "selection_required";

export type AiCapability = {
  id: AiCapabilityId;
  label: string;
  description: string;
  scope: AiScope;
  systemPrompt: string;
};

const COMMON_TAIL = `
输出要求：
- 只输出结果正文，不要解释、前言或后记
- 不要用 markdown 代码围栏包裹整篇输出（除非原文本身是独立代码块）
- 保持简体中文写作习惯（原文为外文且未要求翻译时保持原文语言）
`.trim();

export const AI_CAPABILITIES: AiCapability[] = [
  {
    id: "html_to_md",
    label: "HTML 转 Markdown",
    description: "适合含 HTML 的文档，转为标准 MD",
    scope: "full",
    systemPrompt: `你是 Markdown 转换助手。将用户给出的内容中的 HTML 转为等价的标准 Markdown。
规则：
- 保留标题、列表、表格、链接、强调等语义
- 去除 script、iframe、onclick 等危险内容
- 无法安全表示的标签可降级为纯文本
- 若几乎没有 HTML，做轻度 Markdown 规范化
${COMMON_TAIL}`,
  },
  {
    id: "polish",
    label: "润色",
    description: "润色选中文本（需选区）",
    scope: "selection_preferred",
    systemPrompt: `你是中文润色助手。在不改变事实与原意的前提下，让表达更通顺、专业、简洁。
规则：
- 不编造信息，不擅自增减关键论点
- 尽量保持原有段落与标题层级
- 只输出润色后的文本
${COMMON_TAIL}`,
  },
  {
    id: "rewrite_selection",
    label: "优化重写选中部分",
    description: "重写选中段落（必须选区）",
    scope: "selection_required",
    systemPrompt: `你是文档改写助手。在保留原意的前提下，优化重写用户选中的段落：改进条理、用词与可读性。
规则：
- 不改变核心事实
- 可调整句式与小标题（若选区内有）
- 只输出重写后的文本，不要复述未选中部分
${COMMON_TAIL}`,
  },
  {
    id: "optimize_document",
    label: "优化整个文档",
    description: "优化全文格式与结构",
    scope: "full",
    systemPrompt: `你是 Markdown 文档优化助手。优化整篇文档的格式与结构：标题层级、列表、空行、表格与可读性；可做轻度润色。
规则：
- 输出完整文档的标准 Markdown
- 不删减重要信息，不编造新事实
- 保留代码块与必要链接
${COMMON_TAIL}`,
  },
];

export function getCapability(id: AiCapabilityId): AiCapability {
  const c = AI_CAPABILITIES.find((x) => x.id === id);
  if (!c) throw new Error(`未知 AI 能力: ${id}`);
  return c;
}

export function detectHtml(text: string): boolean {
  return /<\/?[a-zA-Z][^>]*>/.test(text);
}

export type ResolveScopeInput = {
  markdown: string;
  selection: string | null;
};

export type ResolveScopeResult = {
  content: string;
  replaceSelection: boolean;
  warn?: string;
};

/** 按能力作用域决定送入模型的文本与写回方式。 */
export function resolveCapabilityContent(
  id: AiCapabilityId,
  input: ResolveScopeInput,
): ResolveScopeResult {
  const sel = input.selection?.trim() ? input.selection : null;
  switch (id) {
    case "html_to_md": {
      if (sel && detectHtml(sel)) {
        return { content: sel, replaceSelection: true };
      }
      const warn = detectHtml(input.markdown)
        ? undefined
        : "未检测到明显 HTML，仍将尝试规范化";
      return { content: input.markdown, replaceSelection: false, warn };
    }
    case "polish": {
      if (!sel) {
        throw new Error("请先选中要润色的文本");
      }
      return { content: sel, replaceSelection: true };
    }
    case "rewrite_selection": {
      if (!sel) {
        throw new Error("请先选中要重写的部分");
      }
      return { content: sel, replaceSelection: true };
    }
    case "optimize_document":
      return { content: input.markdown, replaceSelection: false };
  }
}

export function buildUserMessage(content: string, note?: string): string {
  const n = note?.trim() || "（无）";
  return `【用户补充】${n}\n【待处理内容】\n${content}`;
}

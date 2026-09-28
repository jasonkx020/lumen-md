export type AiCapabilityId =
  | "html_to_md"
  | "polish"
  | "rewrite_selection"
  | "optimize_document"
  | "translate"
  | "summarize"
  | "expand"
  | "change_tone"
  | "image_to_md";

export type AiScope = "full" | "selection_preferred" | "selection_required";

export type AiCapability = {
  id: AiCapabilityId;
  label: string;
  description: string;
  scope: AiScope;
  systemPrompt: string;
  /**
   * 右键菜单即时动作：无需补充说明即可一键跑。
   * 其余能力只在 AI 面板完整列出。
   */
  quickAction?: boolean;
  /** 需要视觉多模态模型；无图时不可运行 */
  requiresMultimodal?: boolean;
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
    scope: "selection_required",
    quickAction: true,
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
    quickAction: true,
    systemPrompt: `你是文档改写助手。在保留原意的前提下，优化重写用户选中的段落：改进条理、用词与可读性。
规则：
- 不改变核心事实
- 可调整句式与小标题（若选区内有）
- 只输出重写后的文本，不要复述未选中部分
${COMMON_TAIL}`,
  },
  {
    id: "expand",
    label: "扩写",
    description: "把选中要点扩成完整段落（需选区）",
    scope: "selection_required",
    quickAction: true,
    systemPrompt: `你是 Markdown 扩写助手。将用户选中的提纲、要点或短句扩展为完整、可读的段落。
规则：
- 紧扣选区原意，不编造事实性细节
- 保持 Markdown 结构；若选区是列表可扩成带说明的列表或连贯段落
- 只输出扩写后的文本
${COMMON_TAIL}`,
  },
  {
    id: "translate",
    label: "翻译",
    description: "翻译选区或全文（可在补充说明中指定目标语言）",
    scope: "selection_preferred",
    systemPrompt: `你是翻译助手。将用户给出的内容翻译为通顺、准确的目标语言。
规则：
- 默认译为简体中文；若用户补充说明指定了目标语言则遵从
- 保留 Markdown 结构（标题、列表、链接、代码块不译或仅译说明性文字）
- 代码块内容保持原样
- 只输出译文
${COMMON_TAIL}`,
  },
  {
    id: "summarize",
    label: "摘要",
    description: "生成选区或全文摘要",
    scope: "selection_preferred",
    systemPrompt: `你是摘要助手。为用户给出的内容生成简洁、信息完整的摘要。
规则：
- 抓住主要论点与结构，不编造原文没有的信息
- 默认用简体中文；可用短列表或短段落
- 只输出摘要正文
${COMMON_TAIL}`,
  },
  {
    id: "change_tone",
    label: "改语气",
    description: "调整语气（在补充说明中写明：正式/口语/技术等）",
    scope: "selection_preferred",
    systemPrompt: `你是文风调整助手。按用户补充说明中的语气要求改写文本（如正式、口语、技术文档、对外公告）。
规则：
- 不改变事实与核心信息
- 未指定语气时，改为清晰专业的书面语
- 保留 Markdown 结构
- 只输出改写后的文本
${COMMON_TAIL}`,
  },
  {
    id: "image_to_md",
    label: "图片转 Markdown",
    description: "根据附图识别为标准 Markdown（需视觉模型）",
    scope: "full",
    requiresMultimodal: true,
    systemPrompt: `你是图片转 Markdown 助手。根据用户附带的图片（截图、扫描件、表格照片等）输出等价的标准 Markdown。
规则：
- 尽量还原标题层级、列表、表格、代码块与强调
- 看不清的内容用 […] 标注，不编造
- 若用户补充了上下文或待处理文本，可作辅助参考，但以图片内容为准
- 输出完整可用的 Markdown 正文
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

/** 右键菜单即时能力（可按是否有选区过滤禁用态由 UI 处理）。 */
export function getQuickCapabilities(): AiCapability[] {
  return AI_CAPABILITIES.filter((c) => c.quickAction);
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

function selectionOrThrow(
  sel: string | null,
  msg: string,
): { content: string; replaceSelection: true } {
  if (!sel) throw new Error(msg);
  return { content: sel, replaceSelection: true };
}

function selectionPreferred(
  input: ResolveScopeInput,
): ResolveScopeResult {
  const sel = input.selection?.trim() ? input.selection : null;
  if (sel) return { content: sel, replaceSelection: true };
  return { content: input.markdown, replaceSelection: false };
}

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
    case "polish":
      return selectionOrThrow(sel, "请先选中要润色的文本");
    case "rewrite_selection":
      return selectionOrThrow(sel, "请先选中要重写的部分");
    case "expand":
      return selectionOrThrow(sel, "请先选中要扩写的要点或段落");
    case "translate":
    case "summarize":
    case "change_tone":
      return selectionPreferred(input);
    case "image_to_md":
      // 正文以图为准；可选把当前全文作参考上下文，写回替换全文
      return {
        content: input.markdown.trim()
          ? input.markdown
          : "（无正文上下文，请仅根据附图生成 Markdown）",
        replaceSelection: false,
      };
    case "optimize_document":
      return { content: input.markdown, replaceSelection: false };
  }
}

export function buildUserMessage(content: string, note?: string): string {
  const n = note?.trim() || "（无）";
  return `【用户补充】${n}\n【待处理内容】\n${content}`;
}

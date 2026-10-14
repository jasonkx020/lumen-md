export type AiCapabilityId =
  | "polish"
  | "expand"
  | "exam_stem"
  | "gen_formula"
  | "gen_mermaid"
  | "gen_table"
  | "exam_skeleton"
  | "export_review"
  | "image_to_md"
  | "translate"
  | "summarize"
  | "change_tone";

export type AiMode = "write" | "subject" | "delivery";

export type AiScope =
  | "full"
  | "selection_preferred"
  | "selection_required"
  | "note_or_selection";

/** 写回策略 */
export type AiWriteMode =
  | "replace_selection"
  | "replace_document"
  | "insert_at_cursor";

export type AiCapability = {
  id: AiCapabilityId;
  label: string;
  description: string;
  mode: AiMode;
  scope: AiScope;
  writeMode: AiWriteMode;
  systemPrompt: string;
  /** 右键一键（写作） */
  quickAction?: boolean;
  /** 主面板「更多」折叠 */
  more?: boolean;
  requiresMultimodal?: boolean;
};

const COMMON_TAIL = `
输出要求：
- 只输出结果正文，不要解释、前言或后记
- 不要用 markdown 代码围栏包裹整篇输出（除非结果本身必须是独立代码块，如 mermaid）
- 保持简体中文写作习惯（原文为外文且未要求翻译时保持原文语言）
`.trim();

export const AI_CAPABILITIES: AiCapability[] = [
  {
    id: "polish",
    label: "润色",
    description: "润色选中文本",
    mode: "write",
    scope: "selection_required",
    writeMode: "replace_selection",
    quickAction: true,
    systemPrompt: `你是中文教学文稿润色助手。在不改变事实与原意的前提下，让表达更通顺、适合学生阅读。
规则：
- 不编造信息，不擅自增减关键论点
- 尽量保持原有段落与标题层级
- 若输入是表格单元格内的片段：只输出单行行内文本，不要空行、列表、标题或 \`|\` 管道符
- 只输出润色后的文本
${COMMON_TAIL}`,
  },
  {
    id: "expand",
    label: "扩写",
    description: "把选中要点扩成完整段落",
    mode: "write",
    scope: "selection_required",
    writeMode: "replace_selection",
    quickAction: true,
    systemPrompt: `你是 Markdown 扩写助手。将用户选中的提纲、要点或短句扩展为完整、可读的段落。
规则：
- 紧扣选区原意，不编造事实性细节
- 保持 Markdown 结构
- 若输入是表格单元格内的片段：只输出单行行内文本（可稍长），不要空行、列表、标题或 \`|\` 管道符
- 只输出扩写后的文本
${COMMON_TAIL}`,
  },
  {
    id: "exam_stem",
    label: "规范题干",
    description: "改成规范题干/选项体例（需选区）",
    mode: "write",
    scope: "selection_required",
    writeMode: "replace_selection",
    quickAction: true,
    systemPrompt: `你是出题助手。将用户选中的内容改写成规范的试题题干体例（中小学/教辅常用）。
规则：
- 保留原意与考点，不编造新知识点
- 选择题：题干清晰，选项用 A. B. C. D. 分行；可留「（　）」作答空
- 填空/简答：题号可用「1.」「（1）」；分值可用「（　分）」占位
- 只输出改写后的 Markdown，不要解析说明
${COMMON_TAIL}`,
  },
  {
    id: "gen_formula",
    label: "生成公式",
    description: "根据说明或选区生成 LaTeX（插入光标）",
    mode: "subject",
    scope: "note_or_selection",
    writeMode: "insert_at_cursor",
    systemPrompt: `你是 LaTeX 公式助手。根据用户描述或选中文本，输出可直接写入 Markdown 的公式。
规则：
- 行内公式用 $...$；独立公式用单独一行的 $$...$$ 或 \`\`\`LaTeX 围栏
- 只输出公式相关 Markdown，不要解释
- 化学式优先用 \\mathrm{} / 常见 mhchem 风格命令（若适用）
${COMMON_TAIL}`,
  },
  {
    id: "gen_mermaid",
    label: "生成流程图",
    description: "根据步骤生成 Mermaid flowchart",
    mode: "subject",
    scope: "note_or_selection",
    writeMode: "insert_at_cursor",
    systemPrompt: `你是 Mermaid 流程图助手。根据用户给出的步骤或说明，输出一个完整的 Mermaid 代码块。
规则：
- 使用 \`\`\`mermaid 围栏，默认 flowchart TB 或 LR
- 节点 ID 用简单英文字母数字；标签可用中文（用方括号或引号）
- 只输出代码块，不要解释
${COMMON_TAIL}`,
  },
  {
    id: "gen_table",
    label: "生成表格",
    description: "根据说明生成 Markdown 表格",
    mode: "subject",
    scope: "note_or_selection",
    writeMode: "insert_at_cursor",
    systemPrompt: `你是 Markdown 表格助手。根据用户列说明或数据，输出标准 GFM 管道表格。
规则：
- 必须包含表头分隔行 |---|
- 单元格内不要换行；合并单元格需求可改用简洁 HTML <table>，但优先 GFM
- 只输出表格 Markdown，不要解释
${COMMON_TAIL}`,
  },
  {
    id: "exam_skeleton",
    label: "试卷/作业骨架",
    description: "按当前纸张样式生成文稿骨架",
    mode: "delivery",
    scope: "full",
    writeMode: "replace_document",
    systemPrompt: `你是教辅排版助手。根据用户补充中的「纸张样式」生成可直接使用的 Markdown 骨架。
规则：
- exam：大题分区（一、选择题 二、填空题 三、解答题），预留题号与分值占位；不要写学校名/密封线（应用内已有）
- homework：练习标题 + 若干练习题位 + 可选「解答过程」小标题
- document：普通文稿大纲（标题、导语、分节）
- 若已有正文，在保留重要内容前提下重组结构；空文档则生成空白骨架
- 只输出完整 Markdown 正文
${COMMON_TAIL}`,
  },
  {
    id: "export_review",
    label: "导出前检查",
    description: "检查结构与常见问题，输出检查清单",
    mode: "delivery",
    scope: "full",
    writeMode: "insert_at_cursor",
    systemPrompt: `你是 Markdown 文稿交付检查助手。阅读全文与用户补充中的版式信息，输出一份简洁的检查清单。
规则：
- 用 Markdown 标题「## 导出前检查」开头
- 用列表列出：已通过项、待修复项（缺图、公式 \`$\` 未闭合、标题层级跳级、题号不连续、建议开 A4/试卷样式等）
- 不编造原文没有的问题；看不清则写「建议人工确认」
- 不要改写原文正文，只输出检查清单
${COMMON_TAIL}`,
  },
  {
    id: "image_to_md",
    label: "识图入库",
    description: "把附图识别为 Markdown 并插入光标处（需开启多模态）",
    mode: "delivery",
    scope: "full",
    writeMode: "insert_at_cursor",
    requiresMultimodal: true,
    systemPrompt: `你是图片转 Markdown 助手。必须只根据用户附带的图片（试卷、板书、表格、截图、照片等）输出等价的标准 Markdown。
规则：
- 唯一信息源是附图；禁止复述、改写、续写或引用「当前文档」中已有的任何正文、流程图、表格
- 尽量还原标题层级、列表、表格、公式（用 $...$）与强调；截图/日志类按可见文字忠实转写
- 看不清的内容用 […] 标注，不编造
- 用户补充说明仅作格式/范围提示，不得压过附图内容
- 只输出完整可用的 Markdown 正文，不要解释
${COMMON_TAIL}`,
  },
  {
    id: "translate",
    label: "翻译",
    description: "点击选择目标语言并翻译",
    mode: "write",
    scope: "selection_preferred",
    writeMode: "replace_selection",
    more: true,
    systemPrompt: `你是翻译助手。将用户给出的内容翻译为通顺、准确的目标语言。
规则：
- 用户补充说明中的「目标语言：…」必须严格遵从；未写明时译为简体中文
- 保留 Markdown 结构；代码块内容保持原样
- 只输出译文
${COMMON_TAIL}`,
  },
  {
    id: "summarize",
    label: "摘要",
    description: "生成选区或全文摘要",
    mode: "write",
    scope: "selection_preferred",
    writeMode: "insert_at_cursor",
    more: true,
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
    description: "点击选择目标语气并改写",
    mode: "write",
    scope: "selection_preferred",
    writeMode: "replace_selection",
    more: true,
    systemPrompt: `你是文风调整助手。按用户补充说明中的语气要求改写文本。
规则：
- 用户补充说明中的「目标语气：…」必须严格遵从；未写明时改为清晰专业的书面语
- 不改变事实与核心信息
- 保留 Markdown 结构
- 只输出改写后的文本
${COMMON_TAIL}`,
  },
];

export const AI_MODES: { id: AiMode; label: string }[] = [
  { id: "write", label: "写作" },
  { id: "subject", label: "学科" },
  { id: "delivery", label: "交付" },
];

export function getCapability(id: AiCapabilityId): AiCapability {
  const c = AI_CAPABILITIES.find((x) => x.id === id);
  if (!c) throw new Error(`未知 AI 能力: ${id}`);
  return c;
}

export function getCapabilitiesByMode(
  mode: AiMode,
  opts?: { includeMore?: boolean },
): AiCapability[] {
  return AI_CAPABILITIES.filter(
    (c) =>
      c.mode === mode && (opts?.includeMore ? true : !c.more),
  );
}

export function getMoreCapabilities(): AiCapability[] {
  return AI_CAPABILITIES.filter((c) => c.more);
}

/** 右键即时能力（写作主路径）。 */
export function getQuickCapabilities(): AiCapability[] {
  return AI_CAPABILITIES.filter((c) => c.quickAction);
}

export type ResolveScopeInput = {
  markdown: string;
  selection: string | null;
  note?: string;
  paperStyle?: string;
  paperLayout?: string;
};

export type ResolveScopeResult = {
  content: string;
  writeMode: AiWriteMode;
  /** 兼容旧字段：是否替换选区 */
  replaceSelection: boolean;
  warn?: string;
};

function selectionOrThrow(
  sel: string | null,
  msg: string,
): ResolveScopeResult {
  if (!sel) throw new Error(msg);
  return {
    content: sel,
    writeMode: "replace_selection",
    replaceSelection: true,
  };
}

function noteOrSelection(
  input: ResolveScopeInput,
  emptyMsg: string,
): ResolveScopeResult {
  const sel = input.selection?.trim() ? input.selection.trim() : "";
  const note = input.note?.trim() ? input.note.trim() : "";
  if (sel) {
    return {
      content: note ? `${note}\n\n${sel}` : sel,
      writeMode: "insert_at_cursor",
      replaceSelection: false,
    };
  }
  if (note) {
    return {
      content: note,
      writeMode: "insert_at_cursor",
      replaceSelection: false,
    };
  }
  throw new Error(emptyMsg);
}

function withPaperMeta(content: string, input: ResolveScopeInput): string {
  const style = input.paperStyle || "document";
  const layout = input.paperLayout || "fluid";
  return `【纸张样式】${style}\n【纸张布局】${layout}\n\n${content}`;
}

/** 按能力作用域决定送入模型的文本与写回方式。 */
export function resolveCapabilityContent(
  id: AiCapabilityId,
  input: ResolveScopeInput,
): ResolveScopeResult {
  const sel = input.selection?.trim() ? input.selection : null;
  const cap = getCapability(id);

  switch (id) {
    case "polish":
      return selectionOrThrow(sel, "请先选中要润色的文本");
    case "expand":
      return selectionOrThrow(sel, "请先选中要扩写的要点或段落");
    case "exam_stem":
      return selectionOrThrow(sel, "请先选中要改成题干的文本");
    case "gen_formula":
      return noteOrSelection(
        input,
        "请先选中文本，或在补充说明中写清公式含义",
      );
    case "gen_mermaid":
      return noteOrSelection(
        input,
        "请先选中步骤说明，或在补充说明中描述流程",
      );
    case "gen_table":
      return noteOrSelection(
        input,
        "请先选中内容，或在补充说明中描述表格列与数据",
      );
    case "exam_skeleton":
      return {
        content: withPaperMeta(
          input.markdown.trim() || "（空文档，请生成骨架）",
          input,
        ),
        writeMode: "replace_document",
        replaceSelection: false,
        warn: input.markdown.trim().length > 80
          ? "将替换整篇文档，请先确认 Diff"
          : undefined,
      };
    case "export_review":
      return {
        content: withPaperMeta(
          input.markdown.trim() || "（空文档）",
          input,
        ),
        writeMode: "insert_at_cursor",
        replaceSelection: false,
      };
    case "image_to_md":
      // 不把全文塞进请求，否则模型易忽略附图、复述文档已有内容
      return {
        content:
          "请仅根据附图识别并输出 Markdown。不要使用、复述或改写当前文档中的任何内容。",
        writeMode: "insert_at_cursor",
        replaceSelection: false,
      };
    case "translate":
    case "change_tone": {
      if (sel) {
        return {
          content: sel,
          writeMode: "replace_selection",
          replaceSelection: true,
        };
      }
      return {
        content: input.markdown,
        writeMode: "replace_document",
        replaceSelection: false,
      };
    }
    case "summarize":
      if (sel) {
        return {
          content: sel,
          writeMode: "insert_at_cursor",
          replaceSelection: false,
        };
      }
      return {
        content: input.markdown,
        writeMode: "insert_at_cursor",
        replaceSelection: false,
      };
    default: {
      const _exhaustive: never = id;
      void _exhaustive;
      return {
        content: input.markdown,
        writeMode: cap.writeMode,
        replaceSelection: cap.writeMode === "replace_selection",
      };
    }
  }
}

export function buildUserMessage(content: string, note?: string): string {
  const n = note?.trim() || "（无）";
  return `【用户补充】${n}\n【待处理内容】\n${content}`;
}

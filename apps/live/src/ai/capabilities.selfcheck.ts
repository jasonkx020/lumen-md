/** AI 写回模式 / 作用域解析自检 */
import {
  resolveCapabilityContent,
  type AiCapabilityId,
} from "./capabilities";

export function runCapabilitiesWriteModeSelfcheck(): string[] {
  const errors: string[] = [];
  const md = "全文示例";
  const sel = "选中片段";

  const writeIds: AiCapabilityId[] = [
    "polish",
    "expand",
    "exam_stem",
    "translate",
    "change_tone",
    "summarize",
  ];

  // 默认 / 空 map：有选区 → replace_selection
  for (const id of writeIds) {
    const r = resolveCapabilityContent(id, {
      markdown: md,
      selection: sel,
    });
    if (r.writeMode !== "replace_selection") {
      errors.push(
        `${id} default should be replace_selection, got ${r.writeMode}`,
      );
    }
    if (!r.replaceSelection) {
      errors.push(`${id} default should set replaceSelection`);
    }
  }

  // 单项关掉：仅 polish 变为 insert_after_selection
  const polishOff = resolveCapabilityContent(
    "polish",
    { markdown: md, selection: sel },
    { aiReplaceByCapability: { polish: false } },
  );
  if (polishOff.writeMode !== "insert_after_selection") {
    errors.push(
      `polish with false should be insert_after_selection, got ${polishOff.writeMode}`,
    );
  }
  const expandStill = resolveCapabilityContent(
    "expand",
    { markdown: md, selection: sel },
    { aiReplaceByCapability: { polish: false } },
  );
  if (expandStill.writeMode !== "replace_selection") {
    errors.push(
      `expand should stay replace when only polish=false, got ${expandStill.writeMode}`,
    );
  }

  const subjectIds: AiCapabilityId[] = [
    "gen_formula",
    "gen_mermaid",
    "gen_table",
  ];
  for (const id of subjectIds) {
    const withSel = resolveCapabilityContent(id, {
      markdown: md,
      selection: sel,
    });
    if (withSel.writeMode !== "replace_selection") {
      errors.push(
        `${id} with selection default should be replace_selection, got ${withSel.writeMode}`,
      );
    }
    const after = resolveCapabilityContent(
      id,
      { markdown: md, selection: sel },
      { aiReplaceByCapability: { [id]: false } },
    );
    if (after.writeMode !== "insert_after_selection") {
      errors.push(
        `${id} with false should be insert_after_selection, got ${after.writeMode}`,
      );
    }
    const noteOnly = resolveCapabilityContent(id, {
      markdown: md,
      selection: null,
      note: "只写说明",
    });
    if (noteOnly.writeMode !== "insert_at_cursor") {
      errors.push(
        `${id} note-only should be insert_at_cursor, got ${noteOnly.writeMode}`,
      );
    }
  }

  const skeleton = resolveCapabilityContent("exam_skeleton", {
    markdown: md,
    selection: null,
  });
  if (skeleton.writeMode !== "replace_document") {
    errors.push(`exam_skeleton should replace_document`);
  }

  return errors;
}

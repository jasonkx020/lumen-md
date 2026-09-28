import {
  AI_CAPABILITIES,
  type AiCapabilityId,
} from "../ai/capabilities";

type Props = {
  hasKey: boolean;
  keyInvalid?: boolean;
  busy: boolean;
  selectedId: AiCapabilityId;
  note: string;
  onSelect: (id: AiCapabilityId) => void;
  onNoteChange: (note: string) => void;
  onRun: () => void;
  onOpenSettings: () => void;
  statusText?: string;
};

export function AiPanel({
  hasKey,
  keyInvalid,
  busy,
  selectedId,
  note,
  onSelect,
  onNoteChange,
  onRun,
  onOpenSettings,
  statusText,
}: Props) {
  const blocked = !hasKey || !!keyInvalid;

  return (
    <div className="ai-pane">
      <div className="panel-title">AI 助手</div>
      {blocked ? (
        <div className="ai-cta">
          <p>
            {keyInvalid
              ? "API Key 不可用或已失效。"
              : "尚未配置可用的 API Key。"}
          </p>
          <p className="ai-cta-hint">
            请到菜单「设置 → AI 平台」中配置 Key 后使用。
          </p>
          <button type="button" className="primary" onClick={onOpenSettings}>
            去设置中配置
          </button>
        </div>
      ) : (
        <>
          <div className="ai-caps">
            {AI_CAPABILITIES.map((c) => (
              <button
                key={c.id}
                type="button"
                className={
                  "ai-cap-btn" + (selectedId === c.id ? " is-active" : "")
                }
                title={c.description}
                disabled={busy}
                onClick={() => onSelect(c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <p className="ai-cap-desc">
            {AI_CAPABILITIES.find((c) => c.id === selectedId)?.description}
          </p>
          <label className="ai-note-label">
            用户补充说明（可选）
            <textarea
              value={note}
              onChange={(e) => onNoteChange(e.target.value)}
              rows={3}
              disabled={busy}
              placeholder="例如：语气更正式、保留英文术语…"
            />
          </label>
          <button
            type="button"
            className="primary ai-run"
            disabled={busy}
            onClick={onRun}
          >
            {busy ? "运行中…" : "运行"}
          </button>
        </>
      )}
      {statusText ? <p className="ai-status">{statusText}</p> : null}
    </div>
  );
}

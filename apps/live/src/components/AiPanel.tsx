import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
} from "react";
import {
  AI_CAPABILITIES,
  type AiCapabilityId,
} from "../ai/capabilities";

export type AiPanelHandle = {
  focusNote: () => void;
};

const MAX_IMAGES = 3;

type Props = {
  hasKey: boolean;
  keyInvalid?: boolean;
  busy: boolean;
  selectedId: AiCapabilityId;
  note: string;
  supportsMultimodal: boolean;
  images: string[];
  onSelect: (id: AiCapabilityId) => void;
  onNoteChange: (note: string) => void;
  onImagesChange: (images: string[]) => void;
  onRun: () => void;
  onOpenSettings: () => void;
  statusText?: string;
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

export const AiPanel = forwardRef<AiPanelHandle, Props>(function AiPanel(
  {
    hasKey,
    keyInvalid,
    busy,
    selectedId,
    note,
    supportsMultimodal,
    images,
    onSelect,
    onNoteChange,
    onImagesChange,
    onRun,
    onOpenSettings,
    statusText,
  },
  ref,
) {
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const blocked = !hasKey || !!keyInvalid;
  const caps = AI_CAPABILITIES.filter(
    (c) => !c.requiresMultimodal || supportsMultimodal,
  );
  const selected = AI_CAPABILITIES.find((c) => c.id === selectedId);
  const needsImage = !!selected?.requiresMultimodal;

  useImperativeHandle(ref, () => ({
    focusNote: () => {
      noteRef.current?.focus();
      noteRef.current?.scrollIntoView({ block: "nearest" });
    },
  }));

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (list.length === 0) return;
      const next = [...images];
      for (const f of list) {
        if (next.length >= MAX_IMAGES) break;
        try {
          const url = await readFileAsDataUrl(f);
          if (url) next.push(url);
        } catch {
          /* skip */
        }
      }
      onImagesChange(next.slice(0, MAX_IMAGES));
    },
    [images, onImagesChange],
  );

  const onPasteImages = useCallback(
    (e: React.ClipboardEvent) => {
      if (!supportsMultimodal || busy) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const it of Array.from(items)) {
        if (it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length === 0) return;
      e.preventDefault();
      void addFiles(files);
    },
    [addFiles, busy, supportsMultimodal],
  );

  return (
    <div className="ai-pane" onPaste={onPasteImages}>
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
            {caps.map((c) => (
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
          <p className="ai-cap-desc">{selected?.description}</p>
          {supportsMultimodal ? (
            <div className="ai-images">
              <div className="ai-images-head">
                <span>附图（可选，最多 {MAX_IMAGES} 张）</span>
                <button
                  type="button"
                  className="ai-images-add"
                  disabled={busy || images.length >= MAX_IMAGES}
                  onClick={() => fileRef.current?.click()}
                >
                  添加图片
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files) void addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
              </div>
              <p className="ai-images-hint">
                可在本面板内粘贴截图；当前模型支持多模态
              </p>
              {images.length > 0 ? (
                <ul className="ai-image-list">
                  {images.map((src, i) => (
                    <li key={`${i}-${src.slice(0, 32)}`}>
                      <img src={src} alt={`附图 ${i + 1}`} />
                      <button
                        type="button"
                        className="ai-image-remove"
                        disabled={busy}
                        title="移除"
                        onClick={() =>
                          onImagesChange(images.filter((_, j) => j !== i))
                        }
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <p className="ai-mm-off">
              当前模型为纯文本，贴图已关闭。可在设置中换用视觉模型（如
              gpt-4o-mini、glm-4v-flash、qwen-vl-plus、llava）。
            </p>
          )}
          <label className="ai-note-label">
            用户补充说明（可选）
            <textarea
              ref={noteRef}
              value={note}
              onChange={(e) => onNoteChange(e.target.value)}
              rows={3}
              disabled={busy}
              placeholder="例如：语气更正式、译为英文、保留英文术语…"
            />
          </label>
          {needsImage && images.length === 0 ? (
            <p className="ai-status">请先添加至少一张图片</p>
          ) : null}
          <button
            type="button"
            className="primary ai-run"
            disabled={busy || (needsImage && images.length === 0)}
            onClick={onRun}
          >
            {busy ? "处理中…" : "运行"}
          </button>
          {statusText ? <p className="ai-status">{statusText}</p> : null}
        </>
      )}
    </div>
  );
});

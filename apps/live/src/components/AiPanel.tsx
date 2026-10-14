import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  AI_MODES,
  getCapabilitiesByMode,
  getMoreCapabilities,
  type AiCapabilityId,
  type AiMode,
} from "../ai/capabilities";
import {
  CHANGE_TONES,
  getDefaultChangeTone,
  getDefaultTranslateLang,
  setDefaultChangeTone,
  setDefaultTranslateLang,
  toneChoiceNote,
  translateChoiceNote,
  TRANSLATE_LANGS,
} from "../ai/choiceOptions";

export type AiPanelHandle = {
  focusNote: () => void;
  setMode: (mode: AiMode) => void;
};

const MAX_IMAGES = 3;

type Props = {
  hasKey: boolean;
  keyInvalid?: boolean;
  busy: boolean;
  mode: AiMode;
  note: string;
  supportsMultimodal: boolean;
  images: string[];
  onModeChange: (mode: AiMode) => void;
  onNoteChange: (note: string) => void;
  onImagesChange: (images: string[]) => void;
  /** 一点即跑；翻译/改语气会带上选项 note */
  onRun: (id: AiCapabilityId, note?: string) => void;
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

type ChoiceMenu = "translate" | "change_tone" | null;

export const AiPanel = forwardRef<AiPanelHandle, Props>(function AiPanel(
  {
    hasKey,
    keyInvalid,
    busy,
    mode,
    note,
    supportsMultimodal,
    images,
    onModeChange,
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
  const moreRef = useRef<HTMLDivElement>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [choiceMenu, setChoiceMenu] = useState<ChoiceMenu>(null);
  const [translateLang, setTranslateLang] = useState(getDefaultTranslateLang);
  const [changeTone, setChangeTone] = useState(getDefaultChangeTone);
  const blocked = !hasKey || !!keyInvalid;

  const mainCaps = getCapabilitiesByMode(mode);
  const moreCaps = mode === "write" ? getMoreCapabilities() : [];

  useImperativeHandle(ref, () => ({
    focusNote: () => {
      setNoteOpen(true);
      requestAnimationFrame(() => {
        noteRef.current?.focus();
        noteRef.current?.scrollIntoView({ block: "nearest" });
      });
    },
    setMode: (m) => onModeChange(m),
  }));

  useEffect(() => {
    if (!choiceMenu) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (moreRef.current?.contains(t)) return;
      setChoiceMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setChoiceMenu(null);
    };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [choiceMenu]);

  useEffect(() => {
    if (busy) setChoiceMenu(null);
  }, [busy]);

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
      if (!supportsMultimodal || busy || mode !== "delivery") return;
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
    [addFiles, busy, mode, supportsMultimodal],
  );

  const pickTranslate = (lang: string) => {
    setDefaultTranslateLang(lang);
    setTranslateLang(lang);
    setChoiceMenu(null);
    const choice = translateChoiceNote(lang);
    const merged = [choice, note.trim()].filter(Boolean).join("\n");
    onRun("translate", merged);
  };

  const pickTone = (tone: string) => {
    setDefaultChangeTone(tone);
    setChangeTone(tone);
    setChoiceMenu(null);
    const choice = toneChoiceNote(tone);
    const merged = [choice, note.trim()].filter(Boolean).join("\n");
    onRun("change_tone", merged);
  };

  const onMoreCapClick = (id: AiCapabilityId) => {
    if (id === "translate") {
      setChoiceMenu((m) => (m === "translate" ? null : "translate"));
      return;
    }
    if (id === "change_tone") {
      setChoiceMenu((m) => (m === "change_tone" ? null : "change_tone"));
      return;
    }
    setChoiceMenu(null);
    onRun(id);
  };

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
            请到菜单「设置 → 大模型配置」中配置 Key 后使用。
          </p>
          <button type="button" className="primary" onClick={onOpenSettings}>
            去配置大模型
          </button>
        </div>
      ) : (
        <>
          <div className="ai-mode-tabs" role="tablist" aria-label="助手模式">
            {AI_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="tab"
                aria-selected={mode === m.id}
                className={"ai-mode-tab" + (mode === m.id ? " is-active" : "")}
                disabled={busy}
                onClick={() => onModeChange(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div className="ai-caps">
            {mainCaps.map((c) => {
              const needsImage = !!c.requiresMultimodal;
              const imageBlocked = needsImage && images.length === 0;
              const mmBlocked = needsImage && !supportsMultimodal;
              return (
                <button
                  key={c.id}
                  type="button"
                  className="ai-cap-btn ai-cap-run"
                  title={c.description}
                  disabled={busy || imageBlocked || mmBlocked}
                  onClick={() => onRun(c.id)}
                >
                  <span className="ai-cap-run-label">{c.label}</span>
                  <span className="ai-cap-run-hint">{c.description}</span>
                </button>
              );
            })}
          </div>

          {moreCaps.length > 0 ? (
            <div className="ai-more" ref={moreRef}>
              <button
                type="button"
                className="ai-more-toggle"
                disabled={busy}
                onClick={() => {
                  setMoreOpen((v) => !v);
                  setChoiceMenu(null);
                }}
              >
                {moreOpen ? "收起更多文本工具" : "更多文本工具"}
              </button>
              {moreOpen
                ? moreCaps.map((c) => {
                    const isTranslate = c.id === "translate";
                    const isTone = c.id === "change_tone";
                    const meta = isTranslate
                      ? translateLang
                      : isTone
                        ? changeTone
                        : null;
                    const menuOpen =
                      (isTranslate && choiceMenu === "translate") ||
                      (isTone && choiceMenu === "change_tone");
                    return (
                      <div key={c.id} className="ai-cap-choice-wrap">
                        <button
                          type="button"
                          className={
                            "ai-cap-btn ai-cap-choice" +
                            (menuOpen ? " is-open" : "")
                          }
                          title={c.description}
                          disabled={busy}
                          aria-expanded={menuOpen}
                          aria-haspopup="listbox"
                          onClick={() => onMoreCapClick(c.id)}
                        >
                          <span className="ai-cap-choice-label">{c.label}</span>
                          {meta ? (
                            <span className="ai-cap-choice-meta">{meta}</span>
                          ) : null}
                        </button>
                        {menuOpen ? (
                          <div
                            className="ai-cap-dropdown"
                            role="listbox"
                            aria-label={
                              isTranslate ? "目标语言" : "目标语气"
                            }
                          >
                            {(isTranslate ? TRANSLATE_LANGS : CHANGE_TONES).map(
                              (opt) => (
                                <button
                                  key={opt}
                                  type="button"
                                  role="option"
                                  className={
                                    "ai-cap-dropdown-item" +
                                    (opt === meta ? " is-active" : "")
                                  }
                                  aria-selected={opt === meta}
                                  onClick={() =>
                                    isTranslate
                                      ? pickTranslate(opt)
                                      : pickTone(opt)
                                  }
                                >
                                  {opt}
                                </button>
                              ),
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                : null}
            </div>
          ) : null}

          {mode === "delivery" ? (
            supportsMultimodal ? (
              <div className="ai-images">
                <div className="ai-images-head">
                  <span>识图附图（最多 {MAX_IMAGES} 张）</span>
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
                <p className="ai-images-hint">可在本面板内粘贴截图</p>
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
                识图需在「大模型配置」中勾选启用多模态。
              </p>
            )
          ) : null}

          <div className="ai-note-block">
            <button
              type="button"
              className="ai-more-toggle"
              disabled={busy}
              onClick={() => setNoteOpen((v) => !v)}
            >
              {noteOpen ? "收起补充说明" : "补充说明（可选）"}
            </button>
            {noteOpen ? (
              <label className="ai-note-label">
                <textarea
                  ref={noteRef}
                  value={note}
                  onChange={(e) => onNoteChange(e.target.value)}
                  rows={3}
                  disabled={busy}
                  placeholder={
                    mode === "subject"
                      ? "描述公式/流程/表格列…（无选区时必填）"
                      : "可选：额外要求…"
                  }
                />
              </label>
            ) : null}
          </div>

          {statusText ? <p className="ai-status">{statusText}</p> : null}
          {busy ? <p className="ai-status">处理中…</p> : null}
        </>
      )}
    </div>
  );
});

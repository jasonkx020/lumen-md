/** 查找替换面板（Live 对 markdown 文本操作；源码模式交由 CodeMirror）。 */

import { useEffect, useState } from "react";

type Props = {
  open: boolean;
  replaceMode: boolean;
  onClose: () => void;
  /** 当前全文 */
  getText: () => string;
  /** 跳到某处（字符偏移） */
  onJump: (index: number, len: number) => void;
  /** 整篇替换后写回 */
  onReplaceAll: (next: string) => void;
  /** 单次替换：from-to 字符偏移 */
  onReplaceOne: (from: number, to: number, text: string) => void;
};

export function FindReplace({
  open,
  replaceMode,
  onClose,
  getText,
  onJump,
  onReplaceAll,
  onReplaceOne,
}: Props) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [hits, setHits] = useState<number[]>([]);
  const [cursor, setCursor] = useState(0);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !query) {
      setHits([]);
      setCursor(0);
      setMsg("");
      return;
    }
    const text = getText();
    const q = caseSensitive ? query : query.toLowerCase();
    const hay = caseSensitive ? text : text.toLowerCase();
    const next: number[] = [];
    let from = 0;
    while (from <= hay.length) {
      const i = hay.indexOf(q, from);
      if (i < 0) break;
      next.push(i);
      from = i + Math.max(1, q.length);
      if (next.length > 2000) break;
    }
    setHits(next);
    setCursor(0);
    setMsg(next.length ? `${next.length} 处` : "无匹配");
    if (next[0] != null) onJump(next[0], query.length);
  }, [query, caseSensitive, open, getText, onJump]);

  if (!open) return null;

  const jump = (dir: 1 | -1) => {
    if (hits.length === 0) return;
    const next = (cursor + dir + hits.length) % hits.length;
    setCursor(next);
    const at = hits[next]!;
    onJump(at, query.length);
    setMsg(`${next + 1}/${hits.length}`);
  };

  const doReplaceOne = () => {
    if (hits.length === 0 || !query) return;
    const at = hits[cursor] ?? hits[0];
    if (at == null) return;
    onReplaceOne(at, at + query.length, replacement);
    setMsg("已替换 1 处");
  };

  const doReplaceAll = () => {
    if (!query) return;
    const text = getText();
    if (caseSensitive) {
      onReplaceAll(text.split(query).join(replacement));
    } else {
      const re = new RegExp(
        query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "gi",
      );
      onReplaceAll(text.replace(re, replacement));
    }
    setMsg("已全部替换");
  };

  return (
    <div className="find-replace" role="dialog" aria-label="查找替换">
      <div className="find-replace-row">
        <input
          autoFocus
          placeholder="查找"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              jump(e.shiftKey ? -1 : 1);
            }
          }}
        />
        <button type="button" onClick={() => jump(-1)} title="上一个">
          ↑
        </button>
        <button type="button" onClick={() => jump(1)} title="下一个">
          ↓
        </button>
        <button type="button" className="find-close" onClick={onClose}>
          ×
        </button>
      </div>
      {replaceMode ? (
        <div className="find-replace-row">
          <input
            placeholder="替换为"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
          />
          <button type="button" onClick={doReplaceOne}>
            替换
          </button>
          <button type="button" onClick={doReplaceAll}>
            全部
          </button>
        </div>
      ) : null}
      <div className="find-replace-meta">
        <label>
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
          />
          区分大小写
        </label>
        <span>{msg}</span>
      </div>
    </div>
  );
}

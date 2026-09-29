/** 工作区全文搜索结果面板。 */

import { useState } from "react";
import { workspaceSearch, type SearchHit } from "../api";

type Props = {
  open: boolean;
  onClose: () => void;
  onOpen: (rel: string, line: number) => void;
};

export function WorkspaceSearchModal({ open, onClose, onOpen }: Props) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  if (!open) return null;

  const run = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await workspaceSearch(q.trim());
      setHits(r);
      if (r.length === 0) setErr("无结果");
    } catch (e) {
      setErr(String(e));
      setHits([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-dialog" role="presentation" onClick={onClose}>
      <div
        className="settings-dialog-panel"
        role="dialog"
        aria-label="工作区搜索"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-header">
          <h2>工作区搜索</h2>
          <button type="button" className="settings-close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="find-replace-row" style={{ marginBottom: 8 }}>
          <input
            autoFocus
            placeholder="关键词"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
            }}
          />
          <button type="button" className="primary" disabled={busy} onClick={() => void run()}>
            搜索
          </button>
        </div>
        {err ? <p className="settings-msg">{err}</p> : null}
        <ul className="ws-search-list">
          {hits.map((h, i) => (
            <li key={`${h.relPath}-${h.line}-${i}`}>
              <button
                type="button"
                className="ws-search-hit"
                onClick={() => {
                  onOpen(h.relPath, h.line);
                  onClose();
                }}
              >
                <strong>
                  {h.relPath}:{h.line}
                </strong>
                <span>{h.preview}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseStructured,
  serializeStructured,
  type StructuredValue,
} from "../structured/codec";
import type { IniDoc, IniSection } from "../structured/ini";

type Kind = "json" | "yaml" | "ini";

type Props = {
  kind: Kind;
  value: string;
  onChange: (text: string) => void;
  active?: boolean;
};

function cloneValue(v: StructuredValue): StructuredValue {
  if (Array.isArray(v)) return v.map(cloneValue);
  if (v && typeof v === "object") {
    const o: Record<string, StructuredValue> = {};
    for (const [k, val] of Object.entries(v as object)) {
      o[k] = cloneValue(val as StructuredValue);
    }
    return o;
  }
  return v;
}

function setByPath(
  root: StructuredValue,
  parts: (string | number)[],
  next: StructuredValue,
): StructuredValue {
  if (parts.length === 0) return next;
  const out = cloneValue(root);
  let cur: StructuredValue = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (Array.isArray(cur)) cur = cur[p as number] as StructuredValue;
    else cur = (cur as Record<string, StructuredValue>)[p as string];
  }
  const last = parts[parts.length - 1]!;
  if (Array.isArray(cur)) cur[last as number] = next;
  else (cur as Record<string, StructuredValue>)[last as string] = next;
  return out;
}

function ValueEditor({
  data,
  path,
  onSet,
}: {
  data: StructuredValue;
  path: (string | number)[];
  onSet: (path: (string | number)[], next: StructuredValue) => void;
}) {
  const [open, setOpen] = useState(true);

  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, StructuredValue>;
    const keys = Object.keys(obj);
    return (
      <div className="struct-node">
        <div className="struct-row">
          <button
            type="button"
            className="struct-toggle"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "▾" : "▸"}
          </button>
          <span className="struct-type">object · {keys.length}</span>
          <button
            type="button"
            className="struct-btn"
            onClick={() => {
              let i = 1;
              let k = `key${i}`;
              while (k in obj) {
                i += 1;
                k = `key${i}`;
              }
              onSet(path, { ...obj, [k]: "" });
            }}
          >
            +键
          </button>
        </div>
        {open
          ? keys.map((k) => (
              <div key={k} className="struct-child">
                <div className="struct-row">
                  <input
                    className="struct-input struct-key-input"
                    value={k}
                    onChange={(e) => {
                      const nk = e.target.value;
                      if (!nk || nk === k || nk in obj) return;
                      const next: Record<string, StructuredValue> = {};
                      for (const [ok, ov] of Object.entries(obj)) {
                        next[ok === k ? nk : ok] = ov;
                      }
                      onSet(path, next);
                    }}
                  />
                  <button
                    type="button"
                    className="struct-btn danger"
                    onClick={() => {
                      const next = { ...obj };
                      delete next[k];
                      onSet(path, next);
                    }}
                  >
                    删
                  </button>
                </div>
                <ValueEditor
                  data={obj[k]}
                  path={[...path, k]}
                  onSet={onSet}
                />
              </div>
            ))
          : null}
      </div>
    );
  }

  if (Array.isArray(data)) {
    return (
      <div className="struct-node">
        <div className="struct-row">
          <button
            type="button"
            className="struct-toggle"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "▾" : "▸"}
          </button>
          <span className="struct-type">array · {data.length}</span>
          <button
            type="button"
            className="struct-btn"
            onClick={() => onSet(path, [...data, ""])}
          >
            +项
          </button>
        </div>
        {open
          ? data.map((item, i) => (
              <div key={i} className="struct-child">
                <div className="struct-row">
                  <span className="struct-key">[{i}]</span>
                  <button
                    type="button"
                    className="struct-btn danger"
                    onClick={() =>
                      onSet(
                        path,
                        data.filter((_, j) => j !== i),
                      )
                    }
                  >
                    删
                  </button>
                </div>
                <ValueEditor
                  data={item}
                  path={[...path, i]}
                  onSet={onSet}
                />
              </div>
            ))
          : null}
      </div>
    );
  }

  const t =
    data === null ? "null" : typeof data === "boolean" ? "boolean" : typeof data;

  return (
    <div className="struct-row">
      <select
        className="struct-select"
        value={t}
        onChange={(e) => {
          const nt = e.target.value;
          if (nt === "string") onSet(path, "");
          else if (nt === "number") onSet(path, 0);
          else if (nt === "boolean") onSet(path, false);
          else if (nt === "null") onSet(path, null);
          else if (nt === "object") onSet(path, {});
          else if (nt === "array") onSet(path, []);
        }}
      >
        <option value="string">string</option>
        <option value="number">number</option>
        <option value="boolean">boolean</option>
        <option value="null">null</option>
        <option value="object">object</option>
        <option value="array">array</option>
      </select>
      {t === "boolean" ? (
        <input
          type="checkbox"
          checked={Boolean(data)}
          onChange={(e) => onSet(path, e.target.checked)}
        />
      ) : t === "null" ? (
        <span className="struct-muted">null</span>
      ) : (
        <input
          className="struct-input"
          value={data === null || data === undefined ? "" : String(data)}
          onChange={(e) => {
            const raw = e.target.value;
            if (t === "number") {
              const n = Number(raw);
              onSet(path, Number.isFinite(n) ? n : 0);
            } else {
              onSet(path, raw);
            }
          }}
        />
      )}
    </div>
  );
}

function IniEditor({
  doc,
  onChange,
}: {
  doc: IniDoc;
  onChange: (d: IniDoc) => void;
}) {
  const updateSection = (i: number, sec: IniSection) => {
    onChange({ sections: doc.sections.map((s, j) => (j === i ? sec : s)) });
  };

  return (
    <div className="struct-ini">
      {doc.sections.map((sec, si) => (
        <div key={si} className="struct-ini-sec">
          <div className="struct-row">
            <span className="struct-key">节</span>
            <input
              className="struct-input"
              value={sec.name}
              placeholder="(默认)"
              onChange={(e) =>
                updateSection(si, { ...sec, name: e.target.value })
              }
            />
            <button
              type="button"
              className="struct-btn"
              onClick={() =>
                updateSection(si, {
                  ...sec,
                  entries: [...sec.entries, { key: "key", value: "" }],
                })
              }
            >
              +键
            </button>
            <button
              type="button"
              className="struct-btn danger"
              onClick={() =>
                onChange({
                  sections: doc.sections.filter((_, j) => j !== si),
                })
              }
            >
              删节
            </button>
          </div>
          {sec.entries.map((e, ei) => (
            <div key={ei} className="struct-row struct-child">
              <input
                className="struct-input struct-key-input"
                value={e.key}
                onChange={(ev) => {
                  const entries = sec.entries.map((x, j) =>
                    j === ei ? { ...x, key: ev.target.value } : x,
                  );
                  updateSection(si, { ...sec, entries });
                }}
              />
              <span className="struct-eq">=</span>
              <input
                className="struct-input"
                value={e.value}
                onChange={(ev) => {
                  const entries = sec.entries.map((x, j) =>
                    j === ei ? { ...x, value: ev.target.value } : x,
                  );
                  updateSection(si, { ...sec, entries });
                }}
              />
              <button
                type="button"
                className="struct-btn danger"
                onClick={() => {
                  const entries = sec.entries.filter((_, j) => j !== ei);
                  updateSection(si, { ...sec, entries });
                }}
              >
                删
              </button>
            </div>
          ))}
        </div>
      ))}
      <button
        type="button"
        className="struct-btn"
        onClick={() =>
          onChange({
            sections: [
              ...doc.sections,
              { name: `section${doc.sections.length + 1}`, entries: [] },
            ],
          })
        }
      >
        +分节
      </button>
    </div>
  );
}

export function StructuredDocEditor({
  kind,
  value,
  onChange,
  active = true,
}: Props) {
  const fromUs = useRef(false);
  const [local, setLocal] = useState<StructuredValue | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (fromUs.current) {
      fromUs.current = false;
      return;
    }
    const r = parseStructured(kind, value);
    if (r.ok) {
      setLocal(r.value);
      setError(null);
    } else {
      setError(r.error);
    }
  }, [kind, value]);

  const commit = useCallback(
    (next: StructuredValue) => {
      setLocal(next);
      setError(null);
      fromUs.current = true;
      onChange(serializeStructured(kind, next));
    },
    [kind, onChange],
  );

  const onSet = useCallback(
    (path: (string | number)[], next: StructuredValue) => {
      if (local == null) return;
      commit(setByPath(local, path, next));
    },
    [commit, local],
  );

  if (!active) return null;

  return (
    <div className={"struct-host" + (active ? " is-active" : "")}>
      <div className="struct-toolbar">
        <span className="struct-badge">{kind.toUpperCase()}</span>
        <span className="struct-hint">所见即所得 · 与源码双向同步</span>
      </div>
      {error ? (
        <div className="struct-error">
          无法解析：{error}（请切到源码修复）
        </div>
      ) : null}
      {!error && local != null && kind === "ini" ? (
        <IniEditor doc={local as IniDoc} onChange={(d) => commit(d)} />
      ) : null}
      {!error && local != null && kind !== "ini" ? (
        <div className="struct-tree">
          <ValueEditor data={local} path={[]} onSet={onSet} />
        </div>
      ) : null}
    </div>
  );
}

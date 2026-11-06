import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { FileEntry } from "../api";
import { listDir } from "../api";

type Props = {
  workspaceRoot: string | null;
  activeRel: string | null;
  onOpenFile: (rel: string) => void;
  refreshKey: number;
};

type CtxMenu = {
  x: number;
  y: number;
  absPath: string;
};

function joinAbs(root: string, rel: string): string {
  const base = root.replace(/[/\\]+$/, "");
  const part = rel.replace(/^[/\\]+/, "").replace(/\//g, "\\");
  return `${base}\\${part}`;
}

export function FileTree({
  workspaceRoot,
  activeRel,
  onOpenFile,
  refreshKey,
}: Props) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [ctx, setCtx] = useState<CtxMenu | null>(null);

  const loadRoot = useCallback(async () => {
    if (!workspaceRoot) {
      setEntries([]);
      return;
    }
    try {
      setError(null);
      setEntries(await listDir(""));
    } catch (e) {
      setError(String(e));
    }
  }, [workspaceRoot]);

  useEffect(() => {
    void loadRoot();
  }, [loadRoot, refreshKey]);

  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctx]);

  const toggleDir = async (rel: string) => {
    const next = !expanded[rel];
    setExpanded((s) => ({ ...s, [rel]: next }));
    if (next && !children[rel]) {
      try {
        const list = await listDir(rel);
        setChildren((c) => ({ ...c, [rel]: list }));
      } catch (e) {
        setError(String(e));
      }
    }
  };

  const onFileContextMenu = (e: MouseEvent, rel: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!workspaceRoot) return;
    setCtx({
      x: e.clientX,
      y: e.clientY,
      absPath: joinAbs(workspaceRoot, rel),
    });
  };

  const revealInFolder = async () => {
    if (!ctx) return;
    const path = ctx.absPath;
    setCtx(null);
    try {
      await revealItemInDir(path);
    } catch (e) {
      setError(`无法打开所在目录: ${e}`);
    }
  };

  if (!workspaceRoot) {
    return (
      <div className="file-tree empty">
        <p>打开文件夹以浏览文件</p>
      </div>
    );
  }

  const renderList = (items: FileEntry[], depth: number) => (
    <ul className="tree-list" style={{ paddingLeft: depth ? 12 : 0 }}>
      {items.map((ent) => (
        <li key={ent.rel_path}>
          {ent.is_dir ? (
            <>
              <button
                type="button"
                className="tree-item dir"
                onClick={() => void toggleDir(ent.rel_path)}
              >
                <span className="chevron">{expanded[ent.rel_path] ? "▾" : "▸"}</span>
                {ent.name}
              </button>
              {expanded[ent.rel_path] && children[ent.rel_path]
                ? renderList(children[ent.rel_path], depth + 1)
                : null}
            </>
          ) : (
            <button
              type="button"
              className={
                "tree-item file" +
                (activeRel === ent.rel_path ? " active" : "")
              }
              onClick={() => onOpenFile(ent.rel_path)}
              onContextMenu={(e) => onFileContextMenu(e, ent.rel_path)}
            >
              {ent.name}
            </button>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="file-tree">
      <div className="tree-root-label" title={workspaceRoot}>
        {workspaceRoot.split(/[/\\]/).pop()}
      </div>
      {error ? <div className="tree-error">{error}</div> : null}
      {renderList(entries, 0)}
      {ctx ? (
        <div
          className="tree-ctx-menu"
          style={{ left: ctx.x, top: ctx.y }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="tree-ctx-item"
            role="menuitem"
            onClick={() => void revealInFolder()}
          >
            打开所在目录
          </button>
        </div>
      ) : null}
    </div>
  );
}

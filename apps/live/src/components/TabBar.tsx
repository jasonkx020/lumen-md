import type { EditorTab } from "../tabs";

type Props = {
  tabs: EditorTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
};

export function TabBar({ tabs, activeId, onSelect, onClose }: Props) {
  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="tab-bar" role="tablist" aria-label="打开的文件">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            className={"tab-item" + (active ? " is-active" : "")}
            role="tab"
            aria-selected={active}
            title={tab.absPath ?? tab.relPath ?? tab.title}
          >
            <button
              type="button"
              className="tab-label"
              onClick={() => onSelect(tab.id)}
            >
              {tab.dirty ? "• " : ""}
              {tab.title}
            </button>
            <button
              type="button"
              className="tab-close"
              aria-label={`关闭 ${tab.title}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

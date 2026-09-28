type Props = {
  visible: boolean;
  percent: number;
  label: string;
};

/** 导出中全屏遮罩 + 模拟进度条（仅在可见时渲染）。 */
export function ExportProgress({ visible, percent, label }: Props) {
  if (!visible) return null;
  const pct = Math.max(0, Math.min(100, percent));
  return (
    <div className="export-progress-overlay" role="dialog" aria-busy="true" aria-label={label}>
      <div className="export-progress-panel">
        <h3>{label || "正在导出…"}</h3>
        <div className="export-progress-track">
          <div
            className="export-progress-fill"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="export-progress-pct">{pct}%</p>
      </div>
    </div>
  );
}

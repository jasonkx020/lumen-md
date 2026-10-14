type Props = {
  school: string;
  title: string;
  headerEnabled: boolean;
  sealEnabled: boolean;
  onSchoolChange: (v: string) => void;
  onTitleChange: (v: string) => void;
};

export function ExamPaperChrome({
  school,
  title,
  headerEnabled,
  sealEnabled,
  onSchoolChange,
  onTitleChange,
}: Props) {
  if (!headerEnabled && !sealEnabled) return null;

  return (
    <div
      className={
        "exam-paper-chrome" +
        (headerEnabled ? " has-header" : "") +
        (sealEnabled ? " has-seal" : "")
      }
      contentEditable={false}
      suppressContentEditableWarning
    >
      {sealEnabled ? (
        <div className="exam-seal" aria-hidden="true">
          <span className="exam-seal-text">密封线内不得答题</span>
        </div>
      ) : null}
      {headerEnabled ? (
        <div className="exam-header">
          <input
            className="exam-school"
            type="text"
            value={school}
            onChange={(e) => onSchoolChange(e.target.value)}
            placeholder="学校名称"
            aria-label="学校名称"
          />
          <input
            className="exam-exam-title"
            type="text"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="考试名称"
            aria-label="考试名称"
          />
          <div className="exam-info-row">
            <span>
              姓名
              <span className="exam-blank" />
            </span>
            <span>
              班级
              <span className="exam-blank" />
            </span>
            <span>
              考号
              <span className="exam-blank exam-blank-wide" />
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

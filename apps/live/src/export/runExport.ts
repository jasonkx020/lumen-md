import { save } from "@tauri-apps/plugin-dialog";
import { exportMdToDocx, exportMdToHtml, exportMdToPdf } from "../api";

export type ExportKind = "pdf" | "docx" | "html";

export type ExportOk = {
  status: "ok";
  /** PDF 时：github-html | libreoffice | word | html-fallback */
  pdfMode?: string;
};

export async function runExport(args: {
  kind: ExportKind;
  markdown: string;
  defaultName: string;
  /** 当前文档绝对路径，用于解析相对图片 */
  docAbs?: string | null;
  /** 用户确认保存路径后、真正开始 IPC 导出前调用（用于显示进度条） */
  onWorkStart?: () => void;
}): Promise<ExportOk | "cancelled"> {
  const base = args.defaultName.replace(/\.(md|markdown|txt)$/i, "") || "export";
  const docAbs = args.docAbs ?? null;

  if (args.kind === "pdf") {
    const path = await save({
      filters: [{ name: "PDF", extensions: ["pdf"] }],
      defaultPath: `${base}.pdf`,
    });
    if (!path) return "cancelled";
    args.onWorkStart?.();
    const pdfMode = await exportMdToPdf(args.markdown, path, docAbs);
    return { status: "ok", pdfMode };
  }

  if (args.kind === "html") {
    const path = await save({
      filters: [{ name: "HTML", extensions: ["html", "htm"] }],
      defaultPath: `${base}.html`,
    });
    if (!path) return "cancelled";
    args.onWorkStart?.();
    await exportMdToHtml(args.markdown, path, docAbs);
    return { status: "ok" };
  }

  const path = await save({
    filters: [{ name: "Word 文档", extensions: ["docx"] }],
    defaultPath: `${base}.docx`,
  });
  if (!path) return "cancelled";
  args.onWorkStart?.();
  await exportMdToDocx(args.markdown, path, docAbs);
  return { status: "ok" };
}

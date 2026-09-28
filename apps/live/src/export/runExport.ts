import { save } from "@tauri-apps/plugin-dialog";
import { exportMdToDocx, exportMdToPdf } from "../api";

export type ExportKind = "pdf" | "docx";

export type ExportOk = {
  status: "ok";
  /** PDF 时：github-html | libreoffice | word | html-fallback */
  pdfMode?: string;
};

export async function runExport(args: {
  kind: ExportKind;
  markdown: string;
  defaultName: string;
}): Promise<ExportOk | "cancelled"> {
  const base = args.defaultName.replace(/\.(md|markdown|txt)$/i, "") || "export";

  if (args.kind === "pdf") {
    const path = await save({
      filters: [{ name: "PDF", extensions: ["pdf"] }],
      defaultPath: `${base}.pdf`,
    });
    if (!path) return "cancelled";
    const pdfMode = await exportMdToPdf(args.markdown, path);
    return { status: "ok", pdfMode };
  }

  const path = await save({
    filters: [{ name: "Word 文档", extensions: ["docx"] }],
    defaultPath: `${base}.docx`,
  });
  if (!path) return "cancelled";
  await exportMdToDocx(args.markdown, path);
  return { status: "ok" };
}

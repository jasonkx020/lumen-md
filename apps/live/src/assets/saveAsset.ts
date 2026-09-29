/** 将 File/Blob 落盘到工作区或文档旁 assets，返回相对路径。 */

import { invoke } from "@tauri-apps/api/core";

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = String(reader.result ?? "");
      const i = r.indexOf(",");
      resolve(i >= 0 ? r.slice(i + 1) : r);
    };
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

export async function saveAssetFile(
  file: File | Blob,
  opts?: {
    preferredName?: string;
    mimeHint?: string;
    docAbs?: string | null;
  },
): Promise<string> {
  const bytesBase64 = await fileToBase64(file);
  const name =
    opts?.preferredName ??
    (file instanceof File ? file.name : undefined);
  const mime =
    opts?.mimeHint ??
    (file instanceof File ? file.type : file.type) ??
    undefined;
  return invoke("fs_save_asset", {
    bytesBase64,
    preferredName: name ?? null,
    mimeHint: mime || null,
    docAbs: opts?.docAbs ?? null,
  });
}

export async function resolveAssetUrl(
  src: string,
  docAbs?: string | null,
): Promise<string> {
  return invoke("resolve_asset_url", {
    src,
    docAbs: docAbs ?? null,
  });
}

/** 从本机绝对路径导入图片到 assets，返回相对路径。 */
export async function importAssetPath(
  absPath: string,
  docAbs?: string | null,
): Promise<string> {
  return invoke("fs_import_asset_path", {
    absPath,
    docAbs: docAbs ?? null,
  });
}

export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(path.trim());
}

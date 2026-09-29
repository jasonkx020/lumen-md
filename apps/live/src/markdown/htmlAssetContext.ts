/** HTML-in-MD 预览解析相对图片时使用的文档绝对路径。 */

let docAbsPath: string | null = null;

export function setHtmlAssetDocAbs(abs: string | null | undefined) {
  docAbsPath = abs?.trim() ? abs : null;
}

export function getHtmlAssetDocAbs(): string | null {
  return docAbsPath;
}

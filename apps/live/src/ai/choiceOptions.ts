/** 翻译目标语言 / 改语气选项，以及本地默认值持久化。 */

const LANG_KEY = "lumen.ai.defaultTranslateLang";
const TONE_KEY = "lumen.ai.defaultTone";

export const TRANSLATE_LANGS = [
  "英语",
  "简体中文",
  "繁体中文",
  "日语",
  "韩语",
  "法语",
  "德语",
  "西班牙语",
  "俄语",
] as const;

export const CHANGE_TONES = [
  "专业书面",
  "通俗易懂",
  "正式公文",
  "口语轻松",
  "学术严谨",
  "简洁精炼",
  "友好亲切",
] as const;

export type TranslateLang = (typeof TRANSLATE_LANGS)[number] | string;
export type ChangeTone = (typeof CHANGE_TONES)[number] | string;

/** 首次/未设置时默认英语 */
const DEFAULT_LANG: TranslateLang = "英语";
const DEFAULT_TONE: ChangeTone = "专业书面";

function readStore(key: string, fallback: string): string {
  try {
    const v = localStorage.getItem(key)?.trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore quota / private mode */
  }
}

export function getDefaultTranslateLang(): TranslateLang {
  return readStore(LANG_KEY, DEFAULT_LANG);
}

export function setDefaultTranslateLang(lang: TranslateLang) {
  const t = lang.trim();
  if (t) writeStore(LANG_KEY, t);
}

export function getDefaultChangeTone(): ChangeTone {
  return readStore(TONE_KEY, DEFAULT_TONE);
}

export function setDefaultChangeTone(tone: ChangeTone) {
  const t = tone.trim();
  if (t) writeStore(TONE_KEY, t);
}

export function translateChoiceNote(lang: string): string {
  return `目标语言：${lang.trim()}`;
}

export function toneChoiceNote(tone: string): string {
  return `目标语气：${tone.trim()}`;
}

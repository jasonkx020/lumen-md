/**
 * MathLive 虚拟键盘布局：显示 Shift 角标。
 *
 * 官方数字/字母键常带 hide-shift，角标被藏掉。
 * 这里只去掉 hide-shift，保留官方原有 shift，使右上角与按住 Shift 后一致。
 */

import type { VirtualKeyboardKeycap, VirtualKeyboardLayout } from "mathlive";

/** 引用官方快捷键，仅去掉 hide-shift */
function showShift(shortcut: string, className = ""): {
  label: string;
  class: string;
} {
  return { label: shortcut, class: className };
}

/** 与 MathLive VARIANTS 中有条目的字母对齐，避免长按空面板 */
const LETTERS_WITH_VARIANTS = new Set([
  "a",
  "A",
  "b",
  "c",
  "d",
  "e",
  "E",
  "g",
  "h",
  "i",
  "I",
  "j",
  "l",
  "n",
  "o",
  "O",
  "p",
  "q",
  "r",
  "u",
  "U",
  "y",
  "Y",
  "z",
]);

type Keycap = string | Partial<VirtualKeyboardKeycap>;

function letterKey(ch: string): Keycap {
  const upper = ch.toUpperCase();
  const key: Partial<VirtualKeyboardKeycap> = {
    label: ch,
    // 不加 hide-shift：角标显示大写（与 Shift 后一致）
    shift: {
      label: upper,
      ...(LETTERS_WITH_VARIANTS.has(upper) ? { variants: upper } : {}),
    },
  };
  if (LETTERS_WITH_VARIANTS.has(ch)) key.variants = ch;
  return key;
}

function rowFromTemplate(template: string): Keycap[] {
  const row: Keycap[] = [];
  for (const k of template) {
    if (/[a-z]/.test(k)) row.push(letterKey(k));
    else if (k === "~") row.push("[backspace]");
    else if (k === "^") row.push("[shift]");
    else if (k === " ") row.push("[separator-5]");
  }
  return row;
}

/**
 * 「abc」字母布局（qwerty）：去掉 hide-shift。
 * 数字行 / 底栏运算符同样露出官方 shift 角标。
 */
export function buildAlphabeticLayoutShowShift(): VirtualKeyboardLayout {
  // 与官方非 azerty 数字行一致（中文等 locale 走 qwerty）
  const numberRow: Keycap[] = [
    { label: "1", variants: "1" },
    { label: "2", variants: "2" },
    { label: "3", variants: "3" },
    { label: "4", variants: "4" },
    { label: "5", shift: { latex: "\\frac{#@}{#?}" }, variants: "5" },
    { label: "6", shift: { latex: "#@^#?" }, variants: "6" },
    { label: "7", variants: "7" },
    { label: "8", shift: { latex: "\\times" }, variants: "8" },
    { label: "9", shift: { label: "(", latex: "(" }, variants: "9" },
    { label: "0", shift: { label: ")", latex: ")" }, variants: "0" },
  ];

  return {
    label: "abc",
    labelClass: "MLK__tex-math",
    tooltip: "keyboard.tooltip.alphabetic",
    displayShiftedKeycaps: true,
    rows: [
      numberRow,
      rowFromTemplate("qwertyuiop"),
      rowFromTemplate(" asdfghjkl "),
      rowFromTemplate("^zxcvbnm~"),
      [
        showShift("[-]", "big-op"),
        showShift("[+]", "big-op"),
        showShift("[=]", "big-op"),
        { label: " ", width: 1.5 },
        // 官方为 hide-shift；Shift 后为 ;
        { label: ",", shift: ";", variants: "." },
        showShift("[.]", "big-op"),
        "[left]",
        "[right]",
        { label: "[action]", width: 1.5 },
      ],
    ],
  };
}

export const NUMERIC_LAYOUT_SHOW_SHIFT: VirtualKeyboardLayout = {
  label: "123",
  labelClass: "MLK__tex-math",
  tooltip: "keyboard.tooltip.numeric",
  displayShiftedKeycaps: true,
  rows: [
    [
      {
        latex: "x",
        shift: "y",
        variants: [
          "y",
          "z",
          "t",
          "r",
          "x^2",
          "x^n",
          "x^{#?}",
          "x_n",
          "x_i",
          "x_{#?}",
          { latex: "f(#?)", class: "small" },
          { latex: "g(#?)", class: "small" },
        ],
      },
      { latex: "n", shift: "a", variants: ["i", "j", "p", "k", "a", "u"] },
      "[separator-5]",
      showShift("[7]"),
      showShift("[8]"),
      showShift("[9]"),
      showShift("[/]", "big-op"),
      "[separator-5]",
      {
        latex: "\\exponentialE",
        shift: "\\ln",
        variants: [
          "\\exp",
          "\\times 10^{#?}",
          "\\ln",
          "\\log_{10}",
          "\\log",
          "\\lg",
          "\\operatorname{lb}",
        ],
      },
      {
        latex: "\\imaginaryI",
        variants: ["\\Re", "\\Im", "\\imaginaryJ", "\\Vert #0 \\Vert"],
      },
      {
        latex: "\\pi",
        shift: "\\sin",
        variants: [
          "\\prod",
          { latex: "\\theta", aside: "theta" },
          { latex: "\\rho", aside: "rho" },
          { latex: "\\tau", aside: "tau" },
          "\\sin",
          "\\cos",
          "\\tan",
        ],
      },
    ],
    [
      {
        label: "<",
        latex: "<",
        shift: { latex: "\\le", label: "\u2264" },
      },
      {
        label: ">",
        latex: ">",
        shift: { latex: "\\ge", label: "\u2265" },
      },
      "[separator-5]",
      showShift("[4]"),
      showShift("[5]"),
      showShift("[6]"),
      showShift("[*]", "big-op"),
      "[separator-5]",
      {
        // 去掉 hide-shift，角标即官方 shift 的 latex 渲染
        latex: "#@^2}",
        shift: "#@^{\\prime}}",
      },
      {
        latex: "#@^{#0}}",
        shift: "#@_{#?}",
      },
      {
        latex: "\\sqrt{#0}",
        shift: { latex: "\\sqrt[#0]{#?}}" },
      },
    ],
    [
      showShift("[(]"),
      showShift("[)]"),
      "[separator-5]",
      showShift("[1]"),
      showShift("[2]"),
      showShift("[3]"),
      showShift("[-]", "big-op"),
      "[separator-5]",
      {
        latex: "\\int^{\\infty}_{0}\\!#?\\,\\mathrm{d}x",
        class: "small",
        shift: "\\int",
        variants: [
          { latex: "\\int_{#?}^{#?}", class: "small" },
          { latex: "\\int", class: "small" },
          { latex: "\\iint", class: "small" },
          { latex: "\\iiint", class: "small" },
          { latex: "\\oint", class: "small" },
          "\\mathrm{d}x",
          { latex: "\\dfrac{\\mathrm{d}}{\\mathrm{d} x}", class: "small" },
          { latex: "\\frac{\\partial}{\\partial x}", class: "small" },
          "\\partial",
        ],
      },
      {
        latex: "\\forall",
        shift: "\\exists",
      },
      { label: "[backspace]", width: 1 },
    ],
    [
      { label: "[shift]", width: 2 },
      "[separator-5]",
      showShift("[0]"),
      showShift("[.]", "big-op"),
      showShift("[=]", "big-op"),
      showShift("[+]", "big-op"),
      "[separator-5]",
      "[left]",
      "[right]",
      { label: "[action]", width: 1 },
    ],
  ],
};

/** 公式编辑器关闭后恢复的默认布局列表 */
export const DEFAULT_MATHLIVE_LAYOUTS = [
  "numeric",
  "symbols",
  "alphabetic",
  "greek",
] as const;

/** 打开公式编辑器时使用的布局（数字/字母带 Shift 角标） */
export function getFormulaEditorLayouts(): (
  | VirtualKeyboardLayout
  | "symbols"
  | "greek"
)[] {
  return [
    NUMERIC_LAYOUT_SHOW_SHIFT,
    "symbols",
    buildAlphabeticLayoutShowShift(),
    "greek",
  ];
}

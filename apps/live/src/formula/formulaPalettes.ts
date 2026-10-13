/** 可视化公式面板：常用数学 / 化学 / 物理插入片段（写入 MathLive / LaTeX）。 */

export type FormulaChip = {
  label: string;
  /** 插入到光标处的 LaTeX 片段 */
  latex: string;
  title?: string;
};

export type FormulaPalette = {
  id: "math" | "chem" | "physics";
  label: string;
  groups: { name: string; chips: FormulaChip[] }[];
};

export const FORMULA_PALETTES: FormulaPalette[] = [
  {
    id: "math",
    label: "数学",
    groups: [
      {
        name: "结构",
        chips: [
          { label: "分数", latex: "\\frac{a}{b}" },
          { label: "根号", latex: "\\sqrt{x}" },
          { label: "n次根", latex: "\\sqrt[n]{x}" },
          { label: "上标", latex: "x^{2}" },
          { label: "下标", latex: "x_{i}" },
          { label: "上下标", latex: "x_{i}^{2}" },
          { label: "求和", latex: "\\sum_{i=1}^{n}" },
          { label: "积分", latex: "\\int_{a}^{b}" },
          { label: "极限", latex: "\\lim_{x\\to 0}" },
          { label: "矩阵", latex: "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}" },
        ],
      },
      {
        name: "符号",
        chips: [
          { label: "±", latex: "\\pm" },
          { label: "×", latex: "\\times" },
          { label: "÷", latex: "\\div" },
          { label: "≠", latex: "\\neq" },
          { label: "≤", latex: "\\leq" },
          { label: "≥", latex: "\\geq" },
          { label: "≈", latex: "\\approx" },
          { label: "∞", latex: "\\infty" },
          { label: "∈", latex: "\\in" },
          { label: "→", latex: "\\to" },
          { label: "⇒", latex: "\\Rightarrow" },
          { label: "α", latex: "\\alpha" },
          { label: "β", latex: "\\beta" },
          { label: "π", latex: "\\pi" },
          { label: "θ", latex: "\\theta" },
          { label: "Δ", latex: "\\Delta" },
        ],
      },
    ],
  },
  {
    id: "chem",
    label: "化学",
    groups: [
      {
        name: "分子与反应",
        chips: [
          {
            label: "葡萄糖发酵",
            latex:
              "\\mathrm{C_6H_{12}O_6 \\xrightarrow{酶} 2C_2H_5OH + 2CO_2}",
            title: "酒精发酵",
          },
          {
            label: "水",
            latex: "\\mathrm{H_2O}",
          },
          {
            label: "二氧化碳",
            latex: "\\mathrm{CO_2}",
          },
          {
            label: "硫酸",
            latex: "\\mathrm{H_2SO_4}",
          },
          {
            label: "反应箭头",
            latex: "\\xrightarrow{}",
          },
          {
            label: "可逆箭头",
            latex: "\\xrightleftharpoons{}",
          },
          {
            label: "加热△",
            latex: "\\xrightarrow{\\Delta}",
          },
          {
            label: "离子电荷",
            latex: "\\mathrm{Fe^{3+}}",
          },
          {
            label: "同位素",
            latex: "{}^{14}_{6}\\mathrm{C}",
          },
          {
            label: "沉淀↓",
            latex: "\\downarrow",
          },
          {
            label: "气体↑",
            latex: "\\uparrow",
          },
        ],
      },
    ],
  },
  {
    id: "physics",
    label: "物理",
    groups: [
      {
        name: "常用式",
        chips: [
          { label: "牛顿第二定律", latex: "F=ma" },
          { label: "动能", latex: "E_k=\\frac{1}{2}mv^{2}" },
          { label: "重力势能", latex: "E_p=mgh" },
          { label: "欧姆定律", latex: "U=IR" },
          { label: "库仑定律", latex: "F=k\\frac{q_1q_2}{r^{2}}" },
          { label: "质能方程", latex: "E=mc^{2}" },
          { label: "波速", latex: "v=f\\lambda" },
          { label: "理想气体", latex: "pV=nRT" },
          { label: "矢量", latex: "\\vec{F}" },
          { label: "偏导", latex: "\\frac{\\partial f}{\\partial x}" },
          { label: "单位N", latex: "\\mathrm{N}" },
          { label: "单位m/s", latex: "\\mathrm{m/s}" },
        ],
      },
    ],
  },
];

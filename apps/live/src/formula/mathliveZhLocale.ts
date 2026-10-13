/**
 * MathLive 官方 zh-cn 缺少「插入」子菜单文案，补丁覆盖。
 * 模板类 key 保持 LaTeX，不翻译。
 */
import { MathfieldElement } from "mathlive";

const ZH_CN_INSERT_MENU: Record<string, string> = {
  "menu.insert": "插入",
  "menu.insert.abs": "绝对值",
  "menu.insert.nth-root": "n 次根",
  "menu.insert.log-base": "以 a 为底的对数",
  "menu.insert.heading-calculus": "微积分",
  "menu.insert.derivative": "导数",
  "menu.insert.nth-derivative": "n 阶导数",
  "menu.insert.integral": "积分",
  "menu.insert.sum": "求和",
  "menu.insert.product": "求积",
  "menu.insert.heading-complex-numbers": "复数",
  "menu.insert.modulus": "模",
  "menu.insert.argument": "辐角",
  "menu.insert.real-part": "实部",
  "menu.insert.imaginary-part": "虚部",
  "menu.insert.conjugate": "共轭",
  // 顺带修正官方包个别笔误/未译项
  "menu.array.add column after": "在后面添加列",
  "tooltip.fraktur": "哥特体",
};

export function applyMathliveZhLocale(): void {
  MathfieldElement.locale = "zh-cn";
  MathfieldElement.strings = {
    "zh-cn": ZH_CN_INSERT_MENU,
  };
}

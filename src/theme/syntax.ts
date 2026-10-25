// VS Code 默认主题的**语法配色表**（B377）。
//
// 源码编辑区（src/editor/theme.ts 的 CM6 HighlightStyle）与预览代码块
// （src/markdown/shiki-themes.ts 的 Shiki ThemeRegistration）共用这一份 ——
// 同一个主题族下，源码与预览里的代码必须长成同一种颜色。
//
// 取色出处：本机 checkout E:\Project\vscode 的 extensions/theme-defaults/themes/：
//   2026-*.json / dark_modern.json / dark_plus.json / dark_vs.json / hc_*.json
// 解析规则照 TextMate：最长 scope 优先，同深度后来者胜；include 链已经合并好。
import type { ThemeFamily } from "./theme";

export interface SyntaxPalette {
  comment: string;
  keyword: string;
  control: string;
  string: string;
  number: string;
  languageConst: string;
  atom: string;
  function: string;
  variable: string;
  property: string;
  type: string;
  tag: string;
  attribute: string;
  operator: string;
  modifier: string;
  regexp: string;
  escape: string;
  link: string;
  heading: string;
  strong: string;
  emphasis: string;
  inserted: string;
  deleted: string;
  changed: string;
  invalid: string;
}

/** Dark+ / Light+：Modern 与 Plus 共用（Modern 只是 include 了 Plus）。 */
const plusDark: SyntaxPalette = {
  comment: "#6a9955",
  keyword: "#569cd6",
  control: "#c586c0",
  string: "#ce9178",
  number: "#b5cea8",
  languageConst: "#569cd6",
  atom: "#569cd6",
  function: "#dcdcaa",
  variable: "#9cdcfe",
  property: "#9cdcfe",
  type: "#4ec9b0",
  tag: "#569cd6",
  attribute: "#9cdcfe",
  operator: "#d4d4d4",
  modifier: "#569cd6",
  regexp: "#d16969",
  escape: "#d7ba7d",
  link: "#4daafc",
  heading: "#569cd6",
  strong: "#569cd6",
  emphasis: "#c586c0",
  inserted: "#b5cea8",
  deleted: "#ce9178",
  changed: "#569cd6",
  invalid: "#f44747",
};

const plusLight: SyntaxPalette = {
  comment: "#008000",
  keyword: "#0000ff",
  control: "#af00db",
  string: "#a31515",
  number: "#098658",
  languageConst: "#0000ff",
  atom: "#0000ff",
  function: "#795e26",
  variable: "#001080",
  property: "#001080",
  type: "#267f99",
  tag: "#800000",
  attribute: "#e50000",
  operator: "#000000",
  modifier: "#0000ff",
  regexp: "#811f3f",
  escape: "#ee0000",
  link: "#005fb8",
  heading: "#800000",
  strong: "#000080",
  emphasis: "#800080",
  inserted: "#098658",
  deleted: "#a31515",
  changed: "#0451a5",
  invalid: "#cd3131",
};

/** 2026 Dark：GitHub Dark 系配色 —— 关键字红、变量橙、函数紫。 */
const y2026Dark: SyntaxPalette = {
  comment: "#8b949e",
  keyword: "#ff7b72",
  control: "#c586c0",
  string: "#a5d6ff",
  number: "#b5cea8",
  languageConst: "#569cd6",
  atom: "#79c0ff",
  function: "#d2a8ff",
  // 2026 的 `variable`（#ffa657）只覆盖参数一类；普通标识符是 `variable.other`
  // #c9d1d9。CM6 的 variableName 分不出这两档，取占多数的那一档 —— 否则整篇标识符
  // 都是橙色（B380 对照 VS Code 2026 Dark 后修正）。
  variable: "#c9d1d9",
  property: "#c9d1d9",
  type: "#4ec9b0",
  tag: "#7ee787",
  attribute: "#9cdcfe",
  operator: "#d4d4d4",
  modifier: "#569cd6",
  regexp: "#a5d6ff",
  escape: "#7ee787",
  link: "#48a0c7",
  heading: "#79c0ff",
  strong: "#c9d1d9",
  emphasis: "#c9d1d9",
  inserted: "#7ee787",
  deleted: "#ffa198",
  changed: "#ffa657",
  invalid: "#ffa198",
};

const y2026Light: SyntaxPalette = {
  comment: "#6e7781",
  keyword: "#cf222e",
  control: "#af00db",
  string: "#0a3069",
  number: "#098658",
  languageConst: "#0000ff",
  atom: "#0550ae",
  function: "#8250df",
  // 同深色档：`variable` #953800 是参数；普通标识符 `variable.other` #1f2328。
  variable: "#1f2328",
  property: "#1f2328",
  type: "#267f99",
  tag: "#116329",
  attribute: "#e50000",
  operator: "#000000",
  modifier: "#0000ff",
  regexp: "#0a3069",
  escape: "#116329",
  link: "#0069cc",
  heading: "#0550ae",
  strong: "#1f2328",
  emphasis: "#1f2328",
  inserted: "#116329",
  deleted: "#82071e",
  changed: "#953800",
  invalid: "#82071e",
};

/** 经典 VS 主题：legacy tokenColors 不单独给函数 / 类型着色。 */
const classicDark: SyntaxPalette = {
  ...plusDark,
  control: "#569cd6",
  atom: "#d4d4d4",
  function: "#d4d4d4",
  // dark_vs 不单独给变量 / 属性着色 ⇒ TextMate 回落到 editor.foreground #D4D4D4
  // （B380 修：原先从 Dark+ 继承了 #9CDCFE，整篇标识符偏蓝）。
  variable: "#d4d4d4",
  property: "#d4d4d4",
  type: "#d4d4d4",
  escape: "#d4d4d4",
  link: "#3794ff",
};

const classicLight: SyntaxPalette = {
  ...plusLight,
  control: "#0000ff",
  atom: "#000000",
  function: "#000000",
  // light_vs 的回落前景是 #000000（B380 修：原先继承的 #E50000 是属性选择器那一档）。
  variable: "#000000",
  property: "#000000",
  type: "#000000",
  escape: "#000000",
  link: "#006ab1",
};

const hcDark: SyntaxPalette = {
  ...plusDark,
  comment: "#7ca668",
  // hc_black 的 constant.language / storage / keyword 都是 #569cd6；
  // B380 修：原先的 #FFFFFF 把 true/false/null 与常量混成了正文色。
  atom: "#569cd6",
  escape: "#569cd6",
  link: "#6fc3df",
  heading: "#6796e6",
  strong: "#ffffff",
  emphasis: "#ffffff",
};

const hcLight: SyntaxPalette = {
  ...plusLight,
  comment: "#515151",
  keyword: "#0f4a85",
  control: "#b5200d",
  string: "#0f4a85",
  number: "#096d48",
  languageConst: "#0f4a85",
  atom: "#292929",
  function: "#5e2cbc",
  variable: "#001080",
  property: "#001080",
  type: "#185e73",
  tag: "#0f4a85",
  attribute: "#264f78",
  modifier: "#0f4a85",
  regexp: "#811f3f",
  escape: "#ee0000",
  link: "#0f4a85",
  heading: "#0f4a85",
  inserted: "#096d48",
  deleted: "#5a5a5a",
  changed: "#0451a5",
  invalid: "#b5200d",
};

const TABLE: Record<ThemeFamily, { dark: SyntaxPalette; light: SyntaxPalette }> = {
  "2026": { dark: y2026Dark, light: y2026Light },
  modern: { dark: plusDark, light: plusLight },
  plus: { dark: plusDark, light: plusLight },
  classic: { dark: classicDark, light: classicLight },
  hc: { dark: hcDark, light: hcLight },
};

export function syntaxPalette(family: ThemeFamily, dark: boolean): SyntaxPalette {
  return TABLE[family][dark ? "dark" : "light"];
}

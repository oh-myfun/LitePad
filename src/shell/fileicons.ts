import { CODICONS, type CodiconName } from "./codicons";

/**
 * 标签上的**文件类型图标**（B57）。
 *
 * 参考 VS Code：标签在名字前放一个 16px 的类型图标，标签带 `has-icon` 类，
 * 有图标时左侧内边距从 8px 收到 6px（图标自己撑出视觉留白）。
 *
 * 差别在于图标从哪来：VS Code 有一整套「文件图标主题」（Seti 等，按文件名匹配几千个后缀），
 * LitePad 没有图标主题，于是按**语言家族**给 10 个字形。
 *
 * 字形一律取 VS Code codicon（`./codicons`：短名 → 官方 `codicon-<id>` 的映射层）。
 * 🚩 红线：消费方**禁止手绘 SVG**（docs/conventions.md「图标」节）。
 * 10 个家族必须对 10 颗**互不相同**的 codicon ——
 * `tests/fileicons.test.ts` 的「十个家族应有十个不同字形」守着撞车。
 *
 * ⚠️ 家族仍按**语义最近**挑字形：codicon 没有「Python」「Rust」这类语言字形（那是文件图标
 *    主题的活），只有通用符号字形，所以映射是「家族 → 最像的通用符号」，不追求一一对应。
 *    家族配色（`.tab-icon[data-fam]` 的 CSS 变量，浅深两套）承担「哪一类」的辨识，
 *    字形承担「像什么」——两者合起来才是完整信息。
 *
 * ⚠️ 尺寸依据（VS Code 源码 `editorTabsControl.ts` 的原话）：
 *     modernUICompact: 28  // 20px tab + 4px top + 4px bottom padding
 *                          // (20px = minimum to fit 16px icon + 2px padding)
 * 即「16px 图标 + 上下各 2px = 20px」是**刚够放图标的下限**，24px（modernUI 常规档）
 * 才从容。B57 因此把药丸从 20px 提到 24px，标签栏 28 → 32px。
 */

/** 语言家族。字形负责「像什么」，配色负责「哪一类」。 */
export type FileFamily =
  "md" | "code" | "brace" | "hash" | "tag" | "brk" | "db" | "diff" | "build" | "txt";

/**
 * 家族 → codicon 名（10 颗必须互不相同，见文件头）。
 *
 * 挑法（code / brace / brk 三兄弟最容易撞车，这里刻意拉开）：
 *   md    → markdown      官方就是 Markdown 记号
 *   code  → code          尖括号，动态语言（JS / TS / Vue）
 *   brace → json          花括号，结构化配置（JSON / YAML / CSS / TOML…）
 *   hash  → terminal      命令行框，脚本语言（Python / Shell / Ruby / Lua…）
 *   tag   → tag           标签，标记语言（HTML / XML / PHP）
 *   brk   → symbolClass   类符号，编译型 / 静态语言（C / C++ / Java / Rust…）
 *   db    → database      数据库圆柱（SQL）
 *   diff  → diff          左右两栏对照（Diff）
 *   build → tools         工具（Dockerfile / Makefile / CMake / Nginx…）
 *   txt   → fileText      纯文本
 */
const FAM_ICON: Record<FileFamily, CodiconName> = {
  md: "markdown",
  code: "code",
  brace: "json",
  hash: "terminal",
  tag: "tag",
  brk: "symbolClass",
  db: "database",
  diff: "diff",
  build: "tools",
  txt: "fileText",
};

/**
 * 语言标签 → 家族。键必须覆盖 `src/editor/language.ts` 注册表里的**全部** label，
 * 漏掉的会落到 `txt`（有 `fileicons.test.ts` 这样的用例守着，见回归测试）。
 */
const FAMILY_OF: Record<FileFamily, string[]> = {
  md: ["Markdown"],
  code: ["JavaScript", "TypeScript", "Vue"],
  brace: ["JSON", "CSS", "Sass", "LESS", "YAML", "TOML", "INI", "Properties"],
  hash: [
    "Python",
    "Shell",
    "PowerShell",
    "Ruby",
    "Perl",
    "Lua",
    "CoffeeScript",
    "R",
    "Octave",
    "Julia",
    "Batch",
  ],
  tag: ["HTML", "XML", "PHP"],
  brk: [
    "C",
    "C++",
    "Java",
    "C#",
    "Kotlin",
    "Scala",
    "Objective-C",
    "Swift",
    "Dart",
    "Go",
    "Rust",
    "Groovy",
    "Erlang",
    "Tcl",
    "VB.NET",
    "VBScript",
    "Scheme",
    "Common Lisp",
    "Haskell",
    "Pascal",
    "Fortran",
    "Clojure",
    "Assembly",
  ],
  db: ["SQL"],
  diff: ["Diff"],
  build: ["Dockerfile", "CMake", "Nginx", "NSIS", "Makefile"],
  txt: ["Plain Text"],
};

/** 反查表：语言标签 → 家族（模块加载时建一次） */
const LOOKUP = new Map<string, FileFamily>();
for (const fam of Object.keys(FAMILY_OF) as FileFamily[]) {
  for (const label of FAMILY_OF[fam]) LOOKUP.set(label, fam);
}

/** 语言标签 → 家族。未知语言（含 null）回落到 txt。 */
export function familyOf(langLabel: string | null | undefined): FileFamily {
  if (!langLabel) return "txt";
  return LOOKUP.get(langLabel) ?? "txt";
}

/**
 * 家族 → 16px 的字形元素（`<i class="codicon codicon-…">` 的 HTML）。
 *
 * 颜色不由这里管：codicon 字形的 `::before` 继承 `color`，配色仍走 `.tab-icon[data-fam]`
 * 的 CSS 变量（浅深两套）。
 *
 * ⚠️ 尺寸也不由这里管：codicon.css 统一给 16px（`font: 16px/1 codicon`），
 *    要别的尺寸就在 CSS 里覆盖字号（B102 之前是给内联 SVG 改 width/height，已成历史）。
 */
export function fileIconHtml(fam: FileFamily): string {
  return CODICONS[FAM_ICON[fam]];
}

/** 供测试断言「家族覆盖了多少种语言」用 */
export function knownLabels(): string[] {
  return [...LOOKUP.keys()];
}

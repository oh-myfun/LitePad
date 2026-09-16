import { strokeIcon } from "./icons";

/**
 * 标签上的**文件类型图标**（B57）。
 *
 * 参考 VS Code：标签在名字前放一个 16px 的类型图标，标签带 `has-icon` 类，
 * 有图标时左侧内边距从 8px 收到 6px（图标自己撑出视觉留白）。
 *
 * 差别在于图标从哪来：VS Code 有一整套「文件图标主题」（Seti 等，按文件名匹配几千个后缀），
 * LitePad 既没有图标主题、也不引图标库（项目约定：零依赖 + 内联 SVG），
 * 所以这里按**语言家族**给 10 个字形，家族配色走 CSS 变量（浅深两套）。
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

/** 家族字形（24×24 视图框，与工具栏图标同参数，实际渲染 16px） */
const GLYPHS: Record<FileFamily, string> = {
  /** Markdown：文档 + 向下箭头（Markdown 的经典记号），也是本应用的主力类型 */
  md:
    '<path d="M13.5 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7.5z"/>' +
    '<path d="M13.5 3v4.5H18"/>' +
    '<path d="M12 11.5v5.5"/>' +
    '<path d="M9.6 14.6L12 17l2.4-2.4"/>',
  /** 动态语言：尖括号 < > */
  code: '<path d="M9 7l-5 5 5 5"/><path d="M15 7l5 5-5 5"/>',
  /** 结构化配置：花括号 { } */
  brace:
    '<path d="M10 4c-2.2 0-2.6 1.2-2.6 2.7v2.3c0 1.6-.9 2.6-2.9 2.8 2 .2 2.9 1.2 2.9 2.8v2.3c0 1.5.4 2.7 2.6 2.7"/>' +
    '<path d="M14 4c2.2 0 2.6 1.2 2.6 2.7v2.3c0 1.6.9 2.6 2.9 2.8-2 .2-2.9 1.2-2.9 2.8v2.3c0 1.5-.4 2.7-2.6 2.7"/>',
  /** 脚本语言：# */
  hash: '<path d="M9.5 4L7.5 20"/><path d="M16.5 4l-2 16"/><path d="M4.5 9h15"/><path d="M3.5 15h15"/>',
  /** 标记语言：</> */
  tag: '<path d="M9.5 8L4 12l5.5 4"/><path d="M14.5 8L20 12l-5.5 4"/><path d="M13.2 6.5l-2.4 11"/>',
  /** 编译型 / 静态语言：方括号 [ ] */
  brk:
    '<path d="M9.5 4H7.5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h2"/>' +
    '<path d="M14.5 4h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-2"/>',
  /** 数据库：圆柱 */
  db:
    '<ellipse cx="12" cy="6" rx="7" ry="2.6"/>' +
    '<path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6"/>' +
    '<path d="M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6"/>',
  /** 差异：加号 + 减号 */
  diff: '<path d="M4 7h6"/><path d="M7 4v6"/><path d="M14 17h6"/>',
  /** 构建 / 部署：六角螺母（比扳手在 16px 下更干净） */
  build: '<path d="M12 3l7.5 4.3v8.4L12 20l-7.5-4.3V7.3z"/><circle cx="12" cy="11.6" r="2.6"/>',
  /** 纯文本：三条横线 */
  txt: '<path d="M5 6.5h14"/><path d="M5 12h14"/><path d="M5 17.5h9"/>',
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

/** 家族 → 16px 内联 SVG（颜色由 `.tab-icon[data-fam]` 的 CSS 变量给，这里只描边） */
export function fileIconSvg(fam: FileFamily, size = 16): string {
  return strokeIcon(GLYPHS[fam], size);
}

/** 供测试断言「家族覆盖了多少种语言」用 */
export function knownLabels(): string[] {
  return [...LOOKUP.keys()];
}

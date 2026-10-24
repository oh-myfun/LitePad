/**
 * 文件类型图标（B57 → B367）：直接用 VS Code 默认的 **Seti 文件图标主题**。
 *
 * 来源：VS Code 1.143.0 的 `extensions/theme-seti/icons/vs-seti-icon-theme.json`
 * 与同目录 `seti.woff`（Seti UI，MIT，见 `assets/fonts/seti-ui-LICENSE.txt`）。
 * 每个语言取的是 VS Code 按 languageId / 文件后缀查到的**同一颗字形和颜色**；
 * Seti 没有专属图标的语言（Diff / Pascal / Fortran…）保留其缺省文件图标 `_default`。
 *
 * 字形是图标字体的码位（`&#xE060;` 这类 HTML 实体），不是手绘 SVG；
 * `tests/fileicons.test.ts` 守着「注册表里每个语言都有条目」与字体/许可文件存在。
 *
 * 消费方：标签（`tabstrip.ts`）与状态栏语言浮层（`language-mode.ts`）共用本出口。
 * 尺寸与配色都由 `.seti-icon` 的 CSS 统一给（`font-size: 150%`，与 VS Code 同口径）。
 */

/** Seti 的九档色调。深浅主题各一套色值，字形不随主题变。 */
export type IconTone =
  "blue" | "yellow" | "gray" | "red" | "orange" | "green" | "pink" | "purple" | "default";

export interface SetiIcon {
  /** Seti 字体码位（十六进制，不含 `&#x;` 包装） */
  ch: string;
  tone: IconTone;
}

/** VS Code Seti 的 `_default`：没有专属图标的语言用它。 */
const DEFAULT_ICON: SetiIcon = { ch: "E023", tone: "default" };

/**
 * 语言标签 → Seti 图标。
 *
 * VS Code 是按 languageId（以及少量文件后缀）查主题表；这里按 LitePad 的语言标签存一份
 * 等价的摊平结果。`CMake` 取 `_makefile_3`（VS Code 对 `CMakeLists.txt` 的映射），
 * `TOML` / `INI` / `Properties` 取 `_config`，`Scala` 取后缀映射的 `_scala`。
 */
const ICON_OF: Record<string, SetiIcon> = {
  Markdown: { ch: "E060", tone: "blue" },
  JSON: { ch: "E055", tone: "yellow" },
  JavaScript: { ch: "E051", tone: "yellow" },
  TypeScript: { ch: "E099", tone: "blue" },
  Python: { ch: "E07B", tone: "blue" },
  Rust: { ch: "E082", tone: "gray" },
  Go: { ch: "E03A", tone: "blue" },
  C: { ch: "E00C", tone: "blue" },
  "C++": { ch: "E01A", tone: "blue" },
  Java: { ch: "E050", tone: "red" },
  "C#": { ch: "E00B", tone: "blue" },
  Kotlin: { ch: "E058", tone: "orange" },
  Scala: { ch: "E086", tone: "red" },
  "Objective-C": { ch: "E00C", tone: "yellow" },
  Swift: { ch: "E092", tone: "orange" },
  Dart: { ch: "E021", tone: "blue" },
  Ruby: { ch: "E081", tone: "red" },
  Perl: { ch: "E06E", tone: "blue" },
  Lua: { ch: "E05E", tone: "blue" },
  Shell: { ch: "E089", tone: "green" },
  PowerShell: { ch: "E074", tone: "blue" },
  SQL: { ch: "E022", tone: "pink" },
  XML: { ch: "E0A5", tone: "orange" },
  HTML: { ch: "E048", tone: "orange" },
  CSS: { ch: "E01D", tone: "blue" },
  Sass: { ch: "E084", tone: "pink" },
  LESS: { ch: "E059", tone: "blue" },
  YAML: { ch: "E0A7", tone: "purple" },
  TOML: { ch: "E019", tone: "gray" },
  INI: { ch: "E019", tone: "gray" },
  Properties: { ch: "E019", tone: "gray" },
  Dockerfile: { ch: "E025", tone: "blue" },
  CMake: { ch: "E05F", tone: "blue" },
  Nginx: { ch: "E023", tone: "default" },
  NSIS: { ch: "E023", tone: "default" },
  Diff: { ch: "E023", tone: "default" },
  Haskell: { ch: "E044", tone: "purple" },
  Pascal: { ch: "E023", tone: "default" },
  Fortran: { ch: "E023", tone: "default" },
  Julia: { ch: "E056", tone: "purple" },
  Clojure: { ch: "E013", tone: "green" },
  Groovy: { ch: "E03D", tone: "green" },
  Erlang: { ch: "E023", tone: "default" },
  Tcl: { ch: "E023", tone: "default" },
  "VB.NET": { ch: "E023", tone: "default" },
  VBScript: { ch: "E023", tone: "default" },
  Scheme: { ch: "E023", tone: "default" },
  "Common Lisp": { ch: "E023", tone: "default" },
  CoffeeScript: { ch: "E016", tone: "yellow" },
  Octave: { ch: "E023", tone: "default" },
  R: { ch: "E001", tone: "blue" },
  Assembly: { ch: "E004", tone: "red" },
  PHP: { ch: "E070", tone: "purple" },
  Batch: { ch: "E0A2", tone: "blue" },
  Makefile: { ch: "E05F", tone: "orange" },
  Vue: { ch: "E09D", tone: "green" },
  "Plain Text": { ch: "E023", tone: "default" },
};

/** 语言标签 → 图标。未知语言（含 null）回落到 Seti 缺省文件图标。 */
export function iconOf(langLabel: string | null | undefined): SetiIcon {
  if (!langLabel) return DEFAULT_ICON;
  return ICON_OF[langLabel] ?? DEFAULT_ICON;
}

/**
 * 16px 的 Seti 字形元素。颜色走 `data-tone`（`.seti-icon[data-tone]` 取 `--seti-*`），
 * 尺寸走 `.seti-icon` 的 `font-size: 150%`（VS Code 图标主题同款）。
 */
export function fileIconHtml(langLabel: string | null | undefined): string {
  const icon = iconOf(langLabel);
  return `<i class="seti-icon" data-tone="${icon.tone}" aria-hidden="true">&#x${icon.ch};</i>`;
}

/** 有专属条目的语言（供测试核对注册表覆盖度） */
export function knownLabels(): string[] {
  return Object.keys(ICON_OF);
}

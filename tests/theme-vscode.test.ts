// @vitest-environment jsdom
// B376 · 深浅主题照 VS Code Dark Modern / Light Modern 取色。
//
// 用户点名：「复刻一下 vscode 的深浅主题颜色，尤其激活标签、编辑区背景（包括预览和
// 源码模式）」。这组用例钉住那张复刻表里的**字面值**，而不是「跟某颗变量走」——
// 后者证明不了复刻到位，只能证明两处一起错。
//
// 取色出处（本机 checkout E:\Project\vscode）：
//   · UI / 底色：extensions/theme-defaults/themes/dark_modern.json / light_modern.json
//   · 语法色：  dark_plus.json / light_plus.json（Modern 主题 include 的那两份 tokenColors）
//   · 编辑器版式色：src/vs/editor/common/core/editorColorRegistry.ts
//
// 三块链路要一起对：
//   源码（CM6 `backgroundColor: var(--bg)`）
//   ＝ 活动标签（`--tab-bg-active: var(--bg)`）
//   ＝ 预览（`--md-bg` 取同一字面值）—— 换模式不跳色。
import { readFileSync } from "node:fs";

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { vscodeEditorTheme } from "../src/editor/theme";
import { readJson, ruleBlock, stripCssComments, stripLineComments, themeBlock } from "./static";

const CSS = "src/styles/global.css";
const PREVIEW = "src/styles/preview.css";
const THEME = "src/editor/theme.ts";

const css = () => readFileSync(CSS, "utf-8");
const preview = () => readFileSync(PREVIEW, "utf-8");
const themeSrc = () => readFileSync(THEME, "utf-8");

/** 取块体里某条声明的值（先剥注释，避免散文里的旧值顶包）。 */
function decl(block: string, name: string): string {
  const re = new RegExp(`${name}\\s*:\\s*([^;]+);`);
  return re.exec(stripCssComments(block))?.[1]?.trim() ?? "";
}

/** 两套主题的 UI / 标签 token 复刻表（值来自 dark_modern.json / light_modern.json）。 */
const TOKENS = {
  dark: {
    "--bg": "#1f1f1f", // editor.background
    "--bg-toolbar": "#181818", // titleBar/statusBar/sideBar.background
    "--bg-elevated": "#1f1f1f", // menu.background
    "--bg-hover": "#2a2d2e", // list.hoverBackground
    "--border": "#2b2b2b", // editorGroupHeader.tabsBorder
    "--fg": "#cccccc", // editor.foreground
    "--fg-muted": "#9d9d9d",
    "--tab-strip-bg": "#181818", // editorGroupHeader.tabsBackground
    "--tab-fg-inactive": "#9d9d9d", // tab.inactiveForeground
    "--tab-fg-active": "#ffffff", // tab.activeForeground
  },
  light: {
    "--bg": "#ffffff",
    "--bg-toolbar": "#f8f8f8",
    "--bg-elevated": "#ffffff",
    "--bg-hover": "#f2f2f2",
    "--border": "#e5e5e5",
    "--fg": "#3b3b3b", // editor.foreground
    "--fg-muted": "#616161",
    "--tab-strip-bg": "#f8f8f8",
    "--tab-fg-inactive": "#616161",
    "--tab-fg-active": "#3b3b3b",
  },
} as const;

/** 编辑器版式色（editorColorRegistry 的默认档）。 */
const EDITOR = {
  dark: {
    "--editor-cursor": "#aeafad", // editorCursor.foreground
    "--editor-selection": "#264f78", // editor.selectionBackground
    "--editor-line-highlight-border": "#282828", // editor.lineHighlightBorder
    "--editor-line-number": "#6e7681", // editorLineNumber.foreground
    "--editor-line-number-active": "#cccccc", // editorLineNumber.activeForeground
  },
  light: {
    "--editor-cursor": "#000000",
    "--editor-selection": "#add6ff",
    "--editor-line-highlight-border": "#eeeeee",
    "--editor-line-number": "#6e7681",
    "--editor-line-number-active": "#171184",
  },
} as const;

describe("B376 · UI / 标签底色照 Dark Modern / Light Modern", () => {
  it("两套主题的 token 一字不差", () => {
    const source = css();
    for (const name of ["dark", "light"] as const) {
      const block = themeBlock(source, name);
      expect(block, `${name} 主题块必须取到`).toBeTruthy();
      for (const [token, value] of Object.entries(TOKENS[name])) {
        expect(block, `${name} 主题的 ${token} 必须是 ${value}`).toContain(`${token}: ${value};`);
      }
    }
  });

  it("活动标签 = 编辑器底色（--tab-bg-active: var(--bg)），两套主题都同源", () => {
    const source = css();
    for (const name of ["dark", "light"] as const) {
      const block = themeBlock(source, name);
      expect(block, `${name} 活动标签必须取编辑器底色`).toContain("--tab-bg-active: var(--bg);");
    }
    // 读它的人：fill 的局部变量。两个环节任一断开，标签就和编辑区裂开。
    expect(
      stripCssComments(ruleBlock(source, ".tab-active .tab-fill", "--tab-fill-bg")),
      "活动 fill 必须消费 --tab-bg-active",
    ).toContain("--tab-fill-bg: var(--tab-bg-active)");
  });

  it("源码模式底色取 var(--bg)（CM6 壳层），不是写死的旧 One Dark 色", () => {
    const src = stripLineComments(themeSrc());
    expect(src, "CM6 根壳层底色必须跟主题 token 走").toContain('backgroundColor: "var(--bg)"');
    // `&` 那条规则里同时给前景，两样都得在
    expect(src, "前景同取 --fg").toContain('color: "var(--fg)"');
    expect(src, "光标取 --editor-cursor").toContain('caretColor: "var(--editor-cursor)"');
    expect(src, "选区取 --editor-selection").toContain(
      'backgroundColor: "var(--editor-selection)"',
    );
  });

  it("dark 标志真的进了 CM6 的 darkTheme facet（换主题时所有面板一起翻转）", () => {
    // smoke.bootstrap 的「所有面板一起变」读的就是这个 facet：
    // 只把颜色写深、不把 dark 传给 EditorView.theme 的话，facet 恒为 false ——
    // 外观看着变了，CM6 内部的明暗判断（原生控件 / 默认样式）却没变。
    for (const dark of [true, false]) {
      const state = EditorState.create({ extensions: vscodeEditorTheme(dark) });
      expect(state.facet(EditorView.darkTheme), `dark=${dark} 时 facet 必须一致`).toBe(dark);
    }
  });

  it("预览底色与源码同值：--md-bg = 对应主题的 --bg", () => {
    const source = css();
    const per = preview();
    const mdLight = ruleBlock(per, ".md-rendered", "--md-bg");
    const mdDark = ruleBlock(per, ':root[data-theme="dark"] .md-rendered', "--md-bg");
    expect(decl(mdLight, "--md-bg"), "浅色预览底色 = 浅色编辑区底色").toBe(
      decl(themeBlock(source, "light"), "--bg"),
    );
    expect(decl(mdDark, "--md-bg"), "深色预览底色 = 深色编辑区底色").toBe(
      decl(themeBlock(source, "dark"), "--bg"),
    );
    // 文字 / 次要文字 / 分隔线同源，预览与源码读起来才是同一套纸
    for (const [md, global] of [
      ["--md-fg", "--fg"],
      ["--md-muted", "--fg-muted"],
      ["--md-border", "--border"],
    ] as const) {
      expect(decl(mdLight, md), `浅色 ${md} 必须与 ${global} 同值`).toBe(
        decl(themeBlock(source, "light"), global),
      );
      expect(decl(mdDark, md), `深色 ${md} 必须与 ${global} 同值`).toBe(
        decl(themeBlock(source, "dark"), global),
      );
    }
  });

  it("预览的代码块 / 引用 / 链接也换成 VS Code 对应色", () => {
    const per = preview();
    const light = ruleBlock(per, ".md-rendered", "--md-code-bg");
    const dark = ruleBlock(per, ':root[data-theme="dark"] .md-rendered', "--md-code-bg");
    // textCodeBlock.background / textLink.foreground
    expect(decl(light, "--md-code-bg")).toBe("#f8f8f8");
    expect(decl(light, "--md-quote-bg")).toBe("#f8f8f8");
    expect(decl(light, "--md-link")).toBe("#005fb8");
    expect(decl(dark, "--md-code-bg")).toBe("#2b2b2b");
    expect(decl(dark, "--md-quote-bg")).toBe("#2b2b2b");
    expect(decl(dark, "--md-link")).toBe("#4daafc");
  });
});

describe("B376 · 源码编辑区版式色（光标 / 选区 / 行号 / 当前行）", () => {
  it("两套主题都定义了这些 token，且值照 editorColorRegistry", () => {
    const source = css();
    for (const name of ["dark", "light"] as const) {
      const block = themeBlock(source, name);
      for (const [token, value] of Object.entries(EDITOR[name])) {
        expect(block, `${name} 主题的 ${token} 必须是 ${value}`).toContain(`${token}: ${value};`);
      }
    }
  });

  it("主题源码引用的每一颗 --editor-* 两套主题都有定义（别让某主题落到空值）", () => {
    const src = stripLineComments(themeSrc());
    const referenced = [
      ...new Set([...src.matchAll(/var\((--editor-[\w-]+)\)/g)].map((m) => m[1])),
    ];
    expect(
      referenced.length,
      "主题里应引用多颗编辑器 token（探针空转会假绿）",
    ).toBeGreaterThanOrEqual(4);
    for (const name of ["dark", "light"] as const) {
      const block = themeBlock(css(), name);
      for (const token of referenced) {
        expect(block, `${name} 主题必须定义 ${token}`).toContain(`${token}:`);
      }
    }
  });

  it("当前行是 VS Code 的 1px 边框（不是整行铺底色）", () => {
    const rule = stripCssComments(ruleBlock(css(), ".panel-host .cm-editor .cm-activeLine"));
    expect(rule, "当前行边框必须用 box-shadow 画在行盒内（不吃布局）").toMatch(
      /box-shadow:\s*inset 0 0 0 1px var\(--editor-line-highlight-border\)/,
    );
    const src = stripLineComments(themeSrc());
    // CM6 自带 activeLine 底色；不压掉的话「边框 + 底色」两层都出现，不再是 VS Code 的观感
    expect(src, "CM 默认当前行底色必须压成透明").toMatch(
      /"\.cm-activeLine":\s*\{\s*backgroundColor:\s*"transparent"/,
    );
  });

  it("行号两档：常态 --editor-line-number、当前行 --editor-line-number-active", () => {
    const source = css();
    const gutters = stripCssComments(ruleBlock(source, ".panel-host .cm-editor .cm-gutters"));
    expect(gutters, "行号槽与编辑区同底色").toContain("background: var(--bg)");
    expect(gutters, "常态行号取 token").toContain("color: var(--editor-line-number)");
    const active = stripCssComments(
      ruleBlock(source, ".panel-host .cm-editor .cm-activeLineGutter"),
    );
    expect(active, "当前行行号提亮，但不另铺底色").toContain("background: transparent");
    expect(active, "当前行行号取 active token").toContain(
      "color: var(--editor-line-number-active)",
    );
    // CM6 自己的 gutter 壳层也得跟 --bg 走，否则外侧会留一条别的底色
    const src = stripLineComments(themeSrc());
    expect(src, "CM 的 .cm-gutters 底色必须 var(--bg)").toMatch(
      /"\.cm-gutters":\s*\{[^}]*backgroundColor:\s*"var\(--bg\)"/,
    );
  });
});

describe("B376 · 语法配色换回 VS Code Dark+ / Light+", () => {
  const DARK: ReadonlyArray<readonly [string, string]> = [
    ["注释", "#6a9955"],
    ["关键字", "#569cd6"],
    ["控制关键字", "#c586c0"],
    ["字符串", "#ce9178"],
    ["数字", "#b5cea8"],
    ["函数", "#dcdcaa"],
    ["变量", "#9cdcfe"],
    ["类型", "#4ec9b0"],
    ["标签名", "#569cd6"],
    ["属性名", "#9cdcfe"],
    ["运算符", "#d4d4d4"],
    ["正则", "#d16969"],
    ["非法", "#f44747"],
  ];
  const LIGHT: ReadonlyArray<readonly [string, string]> = [
    ["注释", "#008000"],
    ["关键字", "#0000ff"],
    ["控制关键字", "#af00db"],
    ["字符串", "#a31515"],
    ["数字", "#098658"],
    ["函数", "#795e26"],
    ["变量", "#001080"],
    ["类型", "#267f99"],
    ["标签名", "#800000"],
    ["属性名", "#e50000"],
    ["运算符", "#000000"],
    ["正则", "#811f3f"],
    ["非法", "#cd3131"],
  ];
  /** 返回缺失的色，供真实态（应为空）与退化替身（必须非空）两头使用。 */
  function paletteViolations(darkPart: string, lightPart: string): string[] {
    const out: string[] = [];
    for (const [label, value] of DARK) {
      if (!darkPart.includes(value)) out.push(`深色${label} ${value}`);
    }
    for (const [label, value] of LIGHT) {
      if (!lightPart.includes(value)) out.push(`浅色${label} ${value}`);
    }
    return out;
  }
  const split = (src: string) => {
    const lightAt = src.indexOf("const lightHighlight");
    return [src.slice(src.indexOf("const darkHighlight"), lightAt), src.slice(lightAt)] as const;
  };

  it("Dark+ / Light+ 的 13 组签名色两档都在", () => {
    const [darkPart, lightPart] = split(stripLineComments(themeSrc()));
    expect(darkPart, "必须取到深色配色段").toContain("const darkHighlight");
    expect(lightPart, "必须取到浅色配色段").toContain("const lightHighlight");
    expect(paletteViolations(darkPart, lightPart), "缺失的 VS Code 签名色").toEqual([]);
  });

  it("反向验证：换回 One Dark 的注释色必须被咬住（防恒真）", () => {
    const [darkPart, lightPart] = split(stripLineComments(themeSrc()));
    const bad = darkPart.replace("#6a9955", "#7f848e");
    expect(bad, "前置条件：替身确实改掉了").not.toBe(darkPart);
    expect(paletteViolations(bad, lightPart), "退化替身必须被抓到").toContain("深色注释 #6a9955");
  });

  it("One Dark 的签名色与 import 都已退场", () => {
    // 注释里会复述旧色值（文件头有交代），所以只比对代码
    const src = stripLineComments(themeSrc());
    for (const color of ["#282c34", "#abb2bf", "#61afef", "#98c379", "#e06c75", "#c678dd"]) {
      expect(src, `主题代码里不得再出现 One Dark 的 ${color}`).not.toContain(color);
    }
    for (const file of ["src/editor/editor.ts", "src/appearance.ts"]) {
      const code = stripLineComments(readFileSync(file, "utf-8"));
      expect(code, `${file} 不得再挂 One Dark`).not.toContain("@codemirror/theme-one-dark");
      expect(code, `${file} 必须挂新的 VS Code 主题`).toContain("vscodeEditorTheme");
    }
    // 直接 import 的 @lezer/highlight 必须是显式依赖，不能只靠提上来（幽灵依赖）
    expect(readJson("package.json").dependencies["@lezer/highlight"]).toBeTruthy();
  });

  it("预览代码块的高亮主题也换成 VS Code 的 Dark+ / Light+", () => {
    const src = stripLineComments(readFileSync("src/markdown/enhance.ts", "utf-8"));
    expect(src, "Shiki 必须挂 VS Code 的两套主题").toContain(
      'themes: { light: "light-plus", dark: "dark-plus" }',
    );
    // 换主题必须换掉主题名；留着 GitHub 那两套就还是两套语法色并存
    expect(src, "不得再挂 GitHub 的浅色主题").not.toContain("github-light");
    expect(src, "不得再挂 GitHub 的深色主题").not.toContain("github-dark");
  });
});

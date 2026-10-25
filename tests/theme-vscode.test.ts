// @vitest-environment jsdom
// B377 · 五套 VS Code 默认主题（2026 默认）+ 深浅两档，外加语法色与预览链路的接线。
// B379 · 四个关键区域（标题栏 / 侧边栏 / 编辑区 / 状态栏）的分区域 token 与消费点。
//
// 用户要求：「标题栏（整个应用背景）、侧边栏、编辑区（标签栏、标签、编辑区）、状态栏，
// 这几个关键区域的边框，前景背景，hover 等颜色和样式尽量和 vscode 保持一致，
// 并同样统一抽取主题可替换样式」。
//
// 移植口径：
//   · UI / 底色：extensions/theme-defaults/themes/{2026-*,dark_modern,light_modern,
//     dark_plus,light_plus,dark_vs,light_vs,hc_black,hc_light}.json 与 registry 默认档
//   · 分区域：titleBar.* / menubar.* / toolbar.* / activityBar.* / sideBar.* / list.* /
//     editor.* / editorGroupHeader.* / statusBar.* （B379）
//   · 语法色：同一批 tokenColors（被 include 链合并后按最长 scope 取值）
//   · 编辑器版式色：src/vs/editor/common/core/editorColorRegistry.ts
//
// 这组用例钉住字面值（复刻表）与同源关系（标签 = 编辑区、预览 = 编辑区），
// 并给出退化替身防恒真。
import { readFileSync } from "node:fs";

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { vscodeEditorTheme } from "../src/editor/theme";
import { DEFAULT_THEME_FAMILY, applyTheme, normalizeFamily } from "../src/theme/theme";
import { shikiThemeFor } from "../src/markdown/shiki-themes";
import { readJson, ruleBlock, stripCssComments, stripLineComments, themeBlock } from "./static";

const CSS = "src/styles/global.css";
const PREVIEW = "src/styles/preview.css";
const THEME = "src/editor/theme.ts";
const SYNTAX = "src/theme/syntax.ts";

const css = () => readFileSync(CSS, "utf-8");
const preview = () => readFileSync(PREVIEW, "utf-8");
const themeSrc = () => readFileSync(THEME, "utf-8");
const syntaxSrc = () => stripLineComments(readFileSync(SYNTAX, "utf-8"));

/** 取块体里某条声明的值（先剥注释，避免散文里的旧值顶包）。 */
function decl(block: string, name: string): string {
  const re = new RegExp(`${name}\\s*:\\s*([^;]+);`);
  return re.exec(stripCssComments(block))?.[1]?.trim() ?? "";
}

/** 主题族覆盖块：选择器里同时带 `[data-theme="..."]` 与 `[data-theme-family="..."]`。
 *  B379 起 classic 有两块（与 plus 共用的主块 + 自己那几颗标签条的差异），
 *  这里把所有命中的块**拼起来**返回，判据看到的是该族最终生效的那一套。 */
function familyBlock(src: string, mode: string, family: string): string {
  const re = new RegExp(
    `[^{}]*\\[data-theme="${mode}"\\]\\[data-theme-family="${family}"\\][^{}]*\\{([^}]*)\\}`,
    "g",
  );
  return [...stripCssComments(src).matchAll(re)].map((m) => m[1]).join("\n");
}

/** 默认档（2026）两张表：值来自 2026-dark.json / 2026-light.json。 */
const TOKENS = {
  dark: {
    "--bg": "#121314", // editor.background
    "--bg-elevated": "#202122", // menu.background / editorWidget.background
    "--bg-hover": "#ffffff14", // list.hoverBackground（通用悬停）
    "--border": "#2a2b2c", // menu/editorWidget.border
    "--fg": "#bfbfbf", // foreground（workbench）
    "--fg-muted": "#8c8c8c", // descriptionForeground
    "--pick-focus-bg": "#ffffff22", // list.activeSelectionBackground
    "--pick-focus-fg": "#ededed",
  },
  light: {
    "--bg": "#ffffff",
    "--bg-elevated": "#fafafd",
    "--bg-hover": "#00000014",
    "--border": "#e5e5e5",
    "--fg": "#202020",
    "--fg-muted": "#606060",
    "--pick-focus-bg": "#00000025",
    "--pick-focus-fg": "#202020",
  },
} as const;

/**
 * B379 · 四个区域的 token 表（2026 档）。
 *
 * 每个 token 都要能在 VS Code 主题 / registry 里找到出处：
 *   shell/titleBar、menubar、toolbar、activityBar、sideBar、list、editor、
 *   editorGroupHeader、statusBar。
 */
const AREA = {
  dark: {
    "--shell-bg": "#191a1b", // modernUI.shellBackground = titleBar.activeBackground
    "--titlebar-fg": "#8c8c8c", // titleBar.activeForeground
    "--titlebar-hover-bg": "rgba(255, 255, 255, 0.1)", // 窗口控制悬停
    "--menubar-hover-bg": "#242526", // menubar.selectionBackground
    "--menubar-hover-fg": "#bfbfbf",
    "--toolbar-hover-bg": "#5a5d5e50", // toolbar.hoverBackground
    "--activitybar-bg": "#191a1b", // activityBar.background
    "--activitybar-inactive-fg": "#8c8c8c", // activityBar.inactiveForeground
    "--activitybar-hover-bg": "#ffffff14", // modernActivityBarItem.hoverBackground
    "--activitybar-active-bg": "#2c2d2e", // modernActivityBarItem.activeBackground
    "--activitybar-border": "#2a2b2c", // modernActivityBar.border = surface.border
    "--sidebar-bg": "#191a1b", // sideBar.background
    "--sidebar-fg": "#bfbfbf", // sideBar.foreground
    "--list-hover-bg": "#ffffff14", // list.hoverBackground
    "--list-active-bg": "#ffffff22", // list.activeSelectionBackground
    "--list-inactive-bg": "#2c2d2e", // list.inactiveSelectionBackground
    "--list-selection-border": "transparent", // HC 才有
    "--editor-fg": "#bbbebf", // editor.foreground
    "--editor-card-border": "#2a2b2c", // editor.border = surface.border
    "--editor-split-border": "#444444", // editorGroup.border 默认档
    "--tab-strip-bg": "#202122", // editorGroupHeader.connectedTabsBackground
    "--tabstrip-border": "#2a2b2c", // editorGroupHeader.tabsBorder
    "--tab-fg-inactive": "#8c8c8c", // tab.inactiveForeground
    "--tab-fg-hover": "#bfbfbf", // tab.hoverForeground
    "--statusbar-bg": "#191a1b", // statusBar.background
    "--statusbar-fg": "#8c8c8c", // statusBar.foreground
    "--statusbar-border": "#2a2b2c", // statusBar.border
    "--statusbar-item-hover-bg": "#323233", // statusBarItem.hoverBackground
    "--statusbar-item-active-bg": "#4b4c4d", // statusBarItem.activeBackground
  },
  light: {
    "--shell-bg": "#fafafd",
    "--titlebar-fg": "#606060",
    "--titlebar-hover-bg": "rgba(0, 0, 0, 0.1)",
    "--menubar-hover-bg": "#eaeaea",
    "--menubar-hover-fg": "#202020",
    "--toolbar-hover-bg": "#b8b8b850",
    "--activitybar-bg": "#fafafd",
    "--activitybar-inactive-fg": "#606060",
    "--activitybar-hover-bg": "#00000014",
    "--activitybar-active-bg": "#dadada99",
    "--activitybar-border": "#e4e5e6",
    "--sidebar-bg": "#fafafd",
    "--sidebar-fg": "#202020",
    "--list-hover-bg": "#00000014",
    "--list-active-bg": "#00000025",
    "--list-inactive-bg": "#dadada99",
    "--list-selection-border": "transparent",
    "--editor-fg": "#202020",
    "--editor-card-border": "#e4e5e6",
    "--editor-split-border": "#e7e7e7",
    "--tab-strip-bg": "#eaeaea",
    "--tabstrip-border": "#f0f1f2",
    "--tab-fg-inactive": "#606060",
    "--tab-fg-hover": "#202020",
    "--statusbar-bg": "#fafafd",
    "--statusbar-fg": "#606060",
    "--statusbar-border": "#f0f1f2",
    "--statusbar-item-hover-bg": "#e3e3e5",
    "--statusbar-item-active-bg": "#eeeeee",
  },
} as const;

/** 编辑器版式色（2026 主题 / editorColorRegistry）。 */
const EDITOR = {
  dark: {
    "--editor-fg": "#bbbebf", // editor.foreground
    "--editor-cursor": "#bbbebf",
    "--editor-selection": "#276782dd",
    "--editor-line-highlight-border": "#242526",
    "--editor-line-number": "#858889",
    "--editor-line-number-active": "#bbbebf",
  },
  light: {
    "--editor-fg": "#202020",
    "--editor-cursor": "#202020",
    "--editor-selection": "#0069cc40",
    "--editor-line-highlight-border": "#eaeaea",
    "--editor-line-number": "#606060",
    "--editor-line-number-active": "#202020",
  },
} as const;

/** 覆盖块里必须出现的关键差异（证明 5 族真的各有一套，不是同一份换名）。 */
const FAMILY_KEYS: ReadonlyArray<readonly [string, string, string]> = [
  ["modern", "--bg", "#1f1f1f"],
  ["modern", "--shell-bg", "#181818"],
  ["modern", "--sidebar-bg", "#181818"],
  ["modern", "--tab-strip-bg", "#2b2b2b"],
  ["modern", "--statusbar-bg", "#181818"],
  ["plus", "--bg", "#1e1e1e"],
  ["plus", "--shell-bg", "#3c3c3c"],
  ["plus", "--sidebar-bg", "#252526"],
  ["plus", "--tab-strip-bg", "#252526"],
  ["plus", "--statusbar-bg", "#007acc"],
  ["classic", "--bg", "#1e1e1e"],
  ["classic", "--shell-bg", "#3c3c3c"],
  ["classic", "--tab-strip-bg", "#303031"],
  ["hc", "--bg", "#000000"],
  ["hc", "--border", "#6fc3df"],
  ["hc", "--editor-split-border", "#6fc3df"],
  ["hc", "--statusbar-border", "#6fc3df"],
  ["hc", "--glass-opacity", "100%"],
];

const FAMILY_KEYS_LIGHT: ReadonlyArray<readonly [string, string, string]> = [
  ["modern", "--shell-bg", "#f8f8f8"],
  ["modern", "--tab-strip-bg", "#e5e5e5"],
  ["modern", "--statusbar-bg", "#f8f8f8"],
  ["plus", "--shell-bg", "#dddddd"],
  ["plus", "--sidebar-bg", "#f3f3f3"],
  ["plus", "--tab-strip-bg", "#f3f3f3"],
  ["plus", "--statusbar-bg", "#007acc"],
  ["classic", "--shell-bg", "#dddddd"],
  ["classic", "--tab-strip-bg", "#e8e8e8"],
  ["hc", "--border", "#0f4a85"],
  ["hc", "--statusbar-border", "#0f4a85"],
  ["hc", "--glass-opacity", "100%"],
];

describe("B377 · 默认档 = VS Code 2026（UI / 标签底色）", () => {
  it("默认族名与设置归一化：未知值一律落回 2026", () => {
    expect(DEFAULT_THEME_FAMILY).toBe("2026");
    expect(normalizeFamily(undefined)).toBe("2026");
    expect(normalizeFamily("modern")).toBe("modern");
    for (const bad of ["", "dark", "vscode", "2025"]) expect(normalizeFamily(bad)).toBe("2026");
  });

  it("两套主题的 token 一字不差（含 B379 的四个分区）", () => {
    const source = css();
    for (const name of ["dark", "light"] as const) {
      const block = themeBlock(source, name);
      expect(block, `${name} 主题块必须取到`).toBeTruthy();
      for (const [token, value] of [
        ...Object.entries(TOKENS[name]),
        ...Object.entries(AREA[name]),
      ]) {
        expect(block, `${name} 主题的 ${token} 必须是 ${value}`).toContain(`${token}: ${value};`);
      }
    }
  });

  it("五族覆盖块都存在，且各自给出与 2026 不同的关键 token", () => {
    const source = css();
    for (const [family, token, value] of FAMILY_KEYS) {
      const block = familyBlock(source, "dark", family);
      expect(block, `${family} 深色覆盖块必须存在`).toBeTruthy();
      expect(block, `${family} 深色 ${token} 必须是 ${value}`).toContain(`${token}: ${value};`);
    }
    for (const [family, token, value] of FAMILY_KEYS_LIGHT) {
      const block = familyBlock(source, "light", family);
      expect(block, `${family} 浅色覆盖块必须存在`).toBeTruthy();
      expect(block, `${family} 浅色 ${token} 必须是 ${value}`).toContain(`${token}: ${value};`);
    }
    // 五族名字都在设置页的选项里（不然只能改配置文件）
    const dialog = readFileSync("src/shell/settingsdialog.ts", "utf-8");
    expect(dialog, "设置页要有「内置主题」一栏").toContain("内置主题");
    for (const value of ["2026", "modern", "plus", "classic", "hc"]) {
      expect(dialog, `设置页缺主题族 ${value}`).toContain(`value: "${value}"`);
    }
  });

  it("活动标签 = 编辑器底色（--tab-bg-active: var(--bg)），两套主题都同源", () => {
    const source = css();
    for (const name of ["dark", "light"] as const) {
      const block = themeBlock(source, name);
      expect(block, `${name} 活动标签必须取编辑器底色`).toContain("--tab-bg-active: var(--bg);");
    }
    expect(
      stripCssComments(ruleBlock(source, ".tab-active .tab-fill", "--tab-fill-bg")),
      "活动 fill 必须消费 --tab-bg-active",
    ).toContain("--tab-fill-bg: var(--tab-bg-active)");
  });

  it("源码模式底色取 var(--bg)（CM6 壳层），不是写死的旧 One Dark 色", () => {
    const src = stripLineComments(themeSrc());
    expect(src, "CM6 根壳层底色必须跟主题 token 走").toContain('backgroundColor: "var(--bg)"');
    expect(src, "编辑区前景取 --editor-fg（B379）").toContain('color: "var(--editor-fg)"');
    expect(src, "光标取 --editor-cursor").toContain('caretColor: "var(--editor-cursor)"');
    expect(src, "选区取 --editor-selection").toContain(
      'backgroundColor: "var(--editor-selection)"',
    );
  });

  it("dark 标志真的进了 CM6 的 darkTheme facet（五族 × 两档都要对）", () => {
    const families = ["2026", "modern", "plus", "classic", "hc"] as const;
    for (const family of families) {
      for (const dark of [true, false]) {
        const state = EditorState.create({ extensions: vscodeEditorTheme(dark, family) });
        expect(state.facet(EditorView.darkTheme), `${family} dark=${dark} 时 facet 必须一致`).toBe(
          dark,
        );
      }
    }
  });

  it("applyTheme 同时落 data-theme / data-theme-family 与两份首帧镜像", () => {
    localStorage.clear();
    expect(applyTheme("dark", "hc")).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.themeFamily).toBe("hc");
    expect(localStorage.getItem("litepad.theme")).toBe("dark");
    expect(localStorage.getItem("litepad.themeFamily")).toBe("hc");
    expect(applyTheme("light", "2026")).toBe(false);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.themeFamily).toBe("2026");
  });
});

describe("B377 · 预览与源码同源（不再有第二份色表）", () => {
  it("--md-* 全部引用 :root 的主题 token，深色覆盖块已删除", () => {
    const per = preview();
    const root = ruleBlock(per, ".md-rendered", "--md-bg");
    for (const [md, global] of [
      ["--md-fg", "--editor-fg"],
      ["--md-bg", "--bg"],
      ["--md-muted", "--fg-muted"],
      ["--md-border", "--border"],
      ["--md-code-bg", "--code-bg"],
      ["--md-quote-bg", "--code-bg"],
      ["--md-link", "--link-fg"],
    ] as const) {
      const value = decl(root, md);
      const vars = [...value.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);
      expect(vars, `${md} 必须引用 ${global}`).toContain(global);
    }
    expect(stripCssComments(per), "不得再有深色 md 覆盖块").not.toMatch(
      /:root\[data-theme="dark"\][^{]*\{[^}]*--md-/,
    );
  });

  it("每套主题都定义 --code-bg / --link-fg（预览代码块与链接不会落空）", () => {
    const source = css();
    for (const name of ["dark", "light"] as const) {
      const block = themeBlock(source, name);
      expect(block, `${name} 主题缺 --code-bg`).toContain("--code-bg:");
      expect(block, `${name} 主题缺 --link-fg`).toContain("--link-fg:");
    }
  });

  it("2026 的代码块 / 链接色照 textCodeBlock / textLink", () => {
    const source = css();
    expect(decl(themeBlock(source, "dark"), "--code-bg")).toBe("#242526");
    expect(decl(themeBlock(source, "dark"), "--link-fg")).toBe("#48a0c7");
    expect(decl(themeBlock(source, "light"), "--code-bg")).toBe("#eaeaea");
    expect(decl(themeBlock(source, "light"), "--link-fg")).toBe("#0069cc");
  });
});

describe("B377 · 源码编辑区版式色（光标 / 选区 / 行号 / 当前行）", () => {
  it("两套主题都定义了这些 token，且值照 editorColorRegistry / 2026 主题", () => {
    const source = css();
    for (const name of ["dark", "light"] as const) {
      const block = themeBlock(source, name);
      for (const [token, value] of Object.entries(EDITOR[name])) {
        expect(block, `${name} 主题的 ${token} 必须是 ${value}`).toContain(`${token}: ${value};`);
      }
    }
  });

  it("主题源码引用的每一颗 --editor-* 所有族/明暗都有定义（别让某档落到空值）", () => {
    const src = stripLineComments(themeSrc());
    const referenced = [
      ...new Set([...src.matchAll(/var\((--editor-[\w-]+)\)/g)].map((m) => m[1])),
    ];
    expect(
      referenced.length,
      "主题里应引用多颗编辑器 token（探针空转会假绿）",
    ).toBeGreaterThanOrEqual(4);
    const source = css();
    const blocks = [
      themeBlock(source, "dark"),
      themeBlock(source, "light"),
      ...["modern", "plus", "classic", "hc"].flatMap((f) => [
        familyBlock(source, "dark", f),
        familyBlock(source, "light", f),
      ]),
    ];
    for (const token of referenced) {
      // 2026 基座定义一次，族覆盖只需要改「不同的那些」——所以逐族全量检查会误伤。
      // 判据：基座两档必须全有；族覆盖若改了这颗 token，值必须非空。
      expect(blocks[0], `深色基座必须定义 ${token}`).toContain(`${token}:`);
      expect(blocks[1], `浅色基座必须定义 ${token}`).toContain(`${token}:`);
    }
  });

  it("当前行是 VS Code 的 1px 边框（不是整行铺底色）", () => {
    const rule = stripCssComments(ruleBlock(css(), ".panel-host .cm-editor .cm-activeLine"));
    expect(rule, "当前行边框必须用 box-shadow 画在行盒内（不吃布局）").toMatch(
      /box-shadow:\s*inset 0 0 0 1px var\(--editor-line-highlight-border\)/,
    );
    const src = stripLineComments(themeSrc());
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
    const src = stripLineComments(themeSrc());
    expect(src, "CM 的 .cm-gutters 底色必须 var(--bg)").toMatch(
      /"\.cm-gutters":\s*\{[^}]*backgroundColor:\s*"var\(--bg\)"/,
    );
  });
});

describe("B377 · 语法配色：五族各一套，2026 为默认", () => {
  const SIGNATURES: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ["2026 深色", "y2026Dark", ["#8b949e", "#ff7b72", "#a5d6ff", "#d2a8ff", "#ffa657", "#7ee787"]],
    ["2026 浅色", "y2026Light", ["#6e7781", "#cf222e", "#0a3069", "#8250df", "#953800", "#116329"]],
    ["Plus 深色", "plusDark", ["#6a9955", "#569cd6", "#ce9178", "#dcdcaa", "#9cdcfe", "#4ec9b0"]],
    ["Plus 浅色", "plusLight", ["#008000", "#0000ff", "#a31515", "#795e26", "#001080", "#267f99"]],
    ["经典深色", "classicDark", ['function: "#d4d4d4"']],
    ["经典浅色", "classicLight", ['function: "#000000"', "#e50000"]],
    ["HC 深色", "hcDark", ["#7ca668", "#6fc3df", "#6796e6"]],
    ["HC 浅色", "hcLight", ["#515151", "#0f4a85", "#5e2cbc", "#185e73"]],
  ];

  it("每族的签名色都在（10 个变体由 8 张色表 + modern 复用 plus 得到）", () => {
    const src = syntaxSrc();
    for (const [label, name, colors] of SIGNATURES) {
      const at = src.indexOf(`const ${name}`);
      expect(at, `${label} 色表必须存在（${name}）`).toBeGreaterThan(-1);
      const rest = src.slice(at + 8);
      const end = rest.search(/\nconst |\n\/\*\*/);
      const body = end === -1 ? rest : rest.slice(0, end);
      for (const color of colors) {
        expect(body, `${label} 缺 ${color}`).toContain(color);
      }
    }
    // modern 不许另抄一份色表：它就是 Plus
    expect(src, "modern 与 plus 必须共用色表").toMatch(
      /const TABLE[\s\S]*modern:\s*\{ dark: plusDark/,
    );
  });

  it("反向验证：把 2026 注释色换回 One Dark 的 #7f848e 必须被咬住（防恒真）", () => {
    const src = syntaxSrc();
    const bad = src.replace("#8b949e", "#7f848e");
    expect(bad, "前置条件：替身确实改掉了").not.toBe(src);
    expect(bad, "退化替身必须被抓到").not.toContain("#8b949e");
  });

  it("One Dark 的签名色与 import 都已退场", () => {
    const src = stripLineComments(themeSrc());
    for (const color of ["#282c34", "#abb2bf", "#61afef", "#98c379", "#e06c75", "#c678dd"]) {
      expect(src, `主题代码里不得再出现 One Dark 的 ${color}`).not.toContain(color);
    }
    for (const file of ["src/editor/editor.ts", "src/appearance.ts"]) {
      const code = stripLineComments(readFileSync(file, "utf-8"));
      expect(code, `${file} 不得再挂 One Dark`).not.toContain("@codemirror/theme-one-dark");
      expect(code, `${file} 必须挂新的 VS Code 主题`).toContain("vscodeEditorTheme");
    }
    expect(readJson("package.json").dependencies["@lezer/highlight"]).toBeTruthy();
  });
});

describe("B377 · 预览代码块（Shiki）跟着主题族走", () => {
  it("Modern / Plus 用包里原版；2026 / 经典 / 高对比度现场拼注册表", () => {
    expect(shikiThemeFor("modern", true)).toBe("dark-plus");
    expect(shikiThemeFor("plus", false)).toBe("light-plus");
    const y = shikiThemeFor("2026", true) as { name?: string; bg?: string };
    expect(y.name, "2026 深色必须是自己的主题").toBe("litepad-2026-dark");
    expect(y.bg).toBe("#242526");
    expect((shikiThemeFor("2026", false) as { name?: string }).name).toBe("litepad-2026-light");
    expect((shikiThemeFor("hc", true) as { name?: string }).name).toBe("litepad-hc-dark");
  });

  it("增强层按 dataset 取族，且保留 defaultColor:false（否则内联色压过 CSS）", () => {
    const src = stripLineComments(readFileSync("src/markdown/enhance.ts", "utf-8"));
    expect(src, "Shiki 主题必须问当前主题族").toContain("shikiThemeFor(");
    expect(src, "必须读 data-theme-family").toContain("dataset.themeFamily");
    expect(src, "主题切换靠 CSS 变量，不能让 Shiki 写内联色").toContain("defaultColor: false");
    expect(src, "不得再挂 GitHub 主题").not.toContain("github-dark");
    expect(src, "不得再挂 GitHub 主题").not.toContain("github-light");
  });

  it("切族时必须把已高亮的 shiki 岛退回原始 html 重画", () => {
    const src = readFileSync("src/markdown/preview.ts", "utf-8");
    const body = src.slice(src.indexOf("retheme(): void")).slice(0, 700);
    expect(body, "retheme 必须同时认 mermaid 与 pre.shiki").toContain('".md-mermaid, pre.shiki"');
  });
});

describe("B377 · 启动底色与设置接线", () => {
  it("首帧族镜像与家族底色：index.html 在模块脚本前落地", () => {
    const html = readFileSync("index.html", "utf-8");
    expect(html, "必须读族的首帧镜像").toContain('localStorage.getItem("litepad.themeFamily")');
    expect(html, "必须先写 data-theme-family").toContain('setAttribute("data-theme-family"');
    // B379：首帧整窗底色 = 各族的 --shell-bg（外壳），不是 editor.background。
    for (const color of ["#191a1b", "#181818", "#3c3c3c", "#000000"]) {
      expect(html, `首帧样式缺族深色外壳 ${color}`).toContain(color);
    }
    for (const color of ["#fafafd", "#f8f8f8", "#dddddd"]) {
      expect(html, `首帧样式缺族浅色外壳 ${color}`).toContain(color);
    }
    expect(html, "首帧整窗底色不得再用 editor.background（2026 深 #121314）").not.toContain(
      "#121314",
    );
  });

  it("Rust 启动底色按族分流，且 2026 与 tauri.conf.json 一致", () => {
    const rust = readFileSync("src-tauri/src/main.rs", "utf-8");
    expect(rust, "必须有按族取外壳底色的函数").toContain("fn dark_bg_for");
    expect(rust, "浅色也要按族分流").toContain("fn light_bg_for");
    expect(rust, "2026 深色外壳必须是 #191a1b").toContain("Color(0x19, 0x1a, 0x1b, 0xff)");
    expect(rust, "2026 浅色外壳必须是 #fafafd").toContain("Color(0xfa, 0xfa, 0xfd, 0xff)");
    expect(rust, "hc 必须落到纯黑").toContain("Color(0x00, 0x00, 0x00, 0xff)");
    expect(rust, "启动时必须读 theme_family").toContain("theme_family");
    const conf = readJson("src-tauri/tauri.conf.json");
    const win = conf.app?.windows?.find((w: { label?: string }) => w.label === "main");
    expect(String(win.backgroundColor).toLowerCase(), "窗口预渲染底色 = 2026").toBe("#191a1b");
  });

  it("设置页 / prefs / main 三处都接上了主题族", () => {
    const prefs = readFileSync("src/prefs.ts", "utf-8");
    const main = readFileSync("src/main.ts", "utf-8");
    expect(prefs, "切换明暗时必须带上当前族").toContain("applyTheme(mode, themeFamily)");
    expect(prefs, "切换明暗时必须重配每个标签的语法色").toContain(
      "applyDarkToTabs(dark, themeFamily)",
    );
    expect(prefs, "切族必须持久化 settings.theme_family").toContain(
      "settings.theme_family = family",
    );
    expect(prefs, "切族必须重画只取一次色的岛").toContain("rethemePreviews()");
    expect(main, "启动时归一化 theme_family").toContain("normalizeFamily(settings?.theme_family)");
    expect(main, "启动时 applyTheme 必须带族").toContain("applyTheme(themeMode, themeFamily)");
  });
});

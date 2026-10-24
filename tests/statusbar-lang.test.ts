// @vitest-environment jsdom
// B365：状态栏「文件类型」恢复可点（用户点名，推翻 B233 的纯展示口径）。
//
// B233 里**仍然成立**的部分：这颗不是视图切换器 —— 不显示「M↓」徽标、不随 viewMode
// 点亮、不掺预览切换。B365 只新增一件事：点开居顶快速选择切语言模式。
//
// 这份契约盯五件容易悄悄回退的事：
//   ① refreshViewModeButton 只显示语言名 + 禁用态，不掺视图模式；
//   ② main.ts 的 click 接到 showLanguagePicker，不许接成 toggleViewMode；
//   ③ HTML 是 button + .sb-btn + data-tip（不再是 span）；
//   ④ CSS 里「恒不可点」的 .sb-lang 覆盖已撤，B233 清掉的死类不许回来；
//   ⑤ language-mode.ts 的落地纪律：全部实例热换语言、离开 md 把预览实例退回源码。
//
// ⚠️ 「监听器有没有挂」只能在这里判（真实 bootstrap 的用例抓不到 bindEvents），
//    别挪到 statusbar-lang-behavior.test.ts 去 —— 那边实测连 encoding 的监听也抓不到。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { cssDecls, fnBody, ruleBlock, stripCssComments, stripLineComments } from "./static";

const main = readFileSync("src/main.ts", "utf8");
const ui = readFileSync("src/ui.ts", "utf8");
const markdown = readFileSync("src/markdown.ts", "utf8");
const languageMode = readFileSync("src/language-mode.ts", "utf8");
const css = readFileSync("src/styles/global.css", "utf8");
const html = readFileSync("index.html", "utf8");

function refreshBody(): string {
  return fnBody(markdown, "refreshViewModeButton");
}

describe("B365 状态栏文件类型：可点开语言浮层（不是视图切换器）", () => {
  it("锚点都能取到（工具与被测文本没走偏）", () => {
    expect(refreshBody().length, "取不到 refreshViewModeButton 的函数体").toBeGreaterThan(0);
    expect(html).toContain('id="sb-lang"');
    expect(languageMode.length).toBeGreaterThan(0);
  });

  it("refreshViewModeButton：只显示语言名 + 禁用态，不掺视图模式", () => {
    const body = refreshBody();
    // 反向闸在前
    expect(body, "不再随 viewMode 变文案").not.toContain("viewMode");
    expect(body, "「M↓」徽标不许回来").not.toContain("sb-md-badge");
    expect(body, "预览态点亮类不许回来").not.toContain("sb-btn-active");
    expect(body, "不许在这颗上挂切换提示").not.toContain("setTip");
    expect(body, "不许在这颗上切视图").not.toContain("toggleViewMode");
    // 正向：显示语言名，没有文档时按不动（与编码/行尾同口径）
    expect(body).toContain("langLabel");
    expect(body).toContain("sbLang.disabled");
  });

  it("click 接线：main → showLanguagePicker，不许接成切视图", () => {
    const clickLine = (src: string) =>
      src
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("sbLang.addEventListener"));
    expect(clickLine(main), "main 必须给语言项挂 click").toBeTruthy();
    expect(clickLine(main)).toContain("showLanguagePicker");
    expect(clickLine(main), "不许在这颗上切视图").not.toContain("toggleViewMode");
    expect(clickLine(main)).not.toContain("viewMode");
    // 反向对照：把接线换成切视图的替身，同一条判据必须咬住
    const BAD = main.replace(
      /sbLang\.addEventListener\("click", \(\) => showLanguagePicker\(\)\);/,
      'sbLang.addEventListener("click", () => toggleViewMode());',
    );
    expect(BAD, "替身必须真的改到接线").not.toBe(main);
    expect(clickLine(BAD)).not.toContain("showLanguagePicker");
    expect(clickLine(BAD)).toContain("toggleViewMode");

    expect(ui, "sbLang 的类型标注应随 <button> 改成 HTMLButtonElement").toContain(
      'el<HTMLButtonElement>("sb-lang")',
    );
  });

  it("HTML：button + .sb-btn + data-tip（不再是 span）", () => {
    expect(html, '不许再用 <span id="sb-lang"').not.toMatch(/<span[^>]*id="sb-lang"/);
    const tag = html.match(/<button[^>]*id="sb-lang"[^>]*>/)?.[0] ?? "";
    expect(tag, "语言项应是 button").toBeTruthy();
    expect(tag, "语言项应带 .sb-btn（和编码键同款可点样式）").toContain("sb-btn");
    expect(tag, "要有提示文案").toContain('data-tip="选择语言模式"');
    // 编码 / 行尾两颗仍是按钮（别一起改掉）
    expect(html).toMatch(/<button[^>]*id="sb-encoding"/);
    expect(html).toMatch(/<button[^>]*id="sb-eol"/);
  });

  it("CSS：旧的「恒不可点」覆盖已撤，B233 清掉的死类不许回来", () => {
    expect(cssDecls(ruleBlock(css, ".sb-lang")), "不许再有 .sb-lang 的不可点覆盖").toBe("");
    const code = stripCssComments(css);
    expect(code, ".sb-btn-active 规则已删").not.toContain(".sb-btn-active");
    expect(code, ".sb-md-badge 规则已删").not.toContain(".sb-md-badge");
  });

  it("B366 语言列表带文件类型图标（与标签同源；自动检测不挂图标）", () => {
    const lm = stripLineComments(languageMode);
    expect(lm, "图标必须从 fileicons 的共用出口取得").toContain("fileIconHtml(choice.label)");
    expect(lm, "不许在语言浮层里手写字形").not.toContain("codicon-");
    expect(lm, "旧家族映射已撤").not.toContain("familyOf(");
    expect(lm, "自动检测不是语言，不挂图标").toMatch(/AUTO_LANGUAGE\)\s*return/);

    // 反向对照：把图标映射删掉，同一条判据必须咬住。
    const BAD = languageMode.replace("icon: fileIconHtml(choice.label)", "icon: undefined");
    expect(BAD, "替身必须真的改到图标映射").not.toBe(languageMode);
    expect(stripLineComments(BAD)).not.toContain("icon: fileIconHtml(choice.label)");
  });

  it("language-mode 落地纪律：全部实例热换语言，离开 md 退回源码", () => {
    const lm = stripLineComments(languageMode);
    expect(lm, "要遍历该文档的全部实例（分屏/隐藏实例都要换高亮）").toContain(
      "for (const inst of instancesOfDoc(docId))",
    );
    expect(lm, "语言走 Compartment 热替换（不重建状态）").toContain(
      "inst.comps.lang.reconfigure(extension)",
    );
    expect(lm, "离开 Markdown 时预览实例必须退回源码").toContain('viewMode !== "source"');
    expect(lm, "面板形态要按新语言重算").toContain("applyPanelMode(panel)");
    expect(lm, "最后刷新状态栏/标签/操作键").toContain("refreshAll()");
    expect(lm, "语言解析只走 languageOfDoc 这一份口径").toContain("languageOfDoc(doc");
    expect(lm, "不许另写一份自动检测").not.toContain("detectLanguage");
    expect(lm, "浮层走公共 QuickPick 组件").toContain("showQuickPick");
    // 反向对照：只换第一个实例（漏掉分屏）必须被咬住
    const BAD_ONE = languageMode.replace(
      "for (const inst of instancesOfDoc(docId))",
      "for (const inst of [instancesOfDoc(docId)[0]])",
    );
    expect(BAD_ONE, "替身必须真的改成只换一个实例").not.toBe(languageMode);
    expect(stripLineComments(BAD_ONE)).not.toContain("for (const inst of instancesOfDoc(docId))");
  });
});

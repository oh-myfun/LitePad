// @vitest-environment jsdom
// B233：状态栏语言/格式项**纯展示**，md 也不再来回切视图。
//
// 原状：一颗元素两用 —— md 时挂 `.sb-btn` 变可按钮、显示「M↓ Markdown 语法/预览」、
// 预览态点亮 `.sb-btn-active`、挂「切换到源码/预览」提示、click 里切视图。
// 用户要求：「和其他格式显示一样即可」，且**预览态也不加任何额外标记**。
//
// 这份契约盯三件容易悄悄回退的事：
//   ① `refreshViewModeButton` 里不许再出现 `.sb-btn` / `sb-md-badge` /
//      `viewMode` / `setTip` 任一个（每个都会让那颗「看起来可点」或随模式变）；
//   ② 那个 click 监听不许回来，且**不许**换成别的形式挂在 sbLang 上；
//   ③ CSS / HTML 侧的配套：徽标与激活态规则已删、元素是 <span> 不是 <button>。
//
// ⚠️ 反向闸（not.*）都排在正向断言之前 —— 否则被正向断言抢先报错，反向闸等于没验。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripCssComments, cssDecls, ruleBlock, fnBody } from "./static";

const main = readFileSync("src/main.ts", "utf8");
const css = readFileSync("src/styles/global.css", "utf8");
const html = readFileSync("index.html", "utf8");

/**
 * `refreshViewModeButton` 的函数体。
 * ⚠️ 必须用 `fnBody`（只认 `function <name>(`）而不是 `topLevelFnBody`：
 *    这函数有三处**调用点排在声明之前**（928/963/5105 行 vs 声明 5181 行），
 *    `topLevelFnBody` 的 `indexOf(name)` 会截到 `refreshViewModeButton();\n}`。
 */
function refreshBody(): string {
  return fnBody(main, "refreshViewModeButton");
}

describe("B233 状态栏语言项：纯展示，md 也不切视图", () => {
  it("三处锚点都能取到（工具与被测文本没走偏）", () => {
    // 反向闸在前：锚点失效时 slice 会返回空串，后续 toContain 全是假绿。
    expect(refreshBody().length, "取不到 refreshViewModeButton 的函数体").toBeGreaterThan(0);
    expect(css.length).toBeGreaterThan(0);
    expect(html).toContain("sb-lang");
    // 正向：函数体确实是「取语言名」那段
    expect(refreshBody()).toContain("langLabel");
  });

  it("refreshViewModeButton：不再有可点/随模式变的痕迹", () => {
    const body = refreshBody();
    // ⚠️ 反向闸必须在正向断言之前
    expect(body, "不许再挂 .sb-btn（会让那颗看起来可点）").not.toContain("sb-btn");
    expect(body, "不许再挂预览态激活类").not.toContain("sb-btn-active");
    expect(body, "「M↓」徽标已随纯展示化删除").not.toContain("sb-md-badge");
    expect(body, "不再随 viewMode 变文案").not.toContain("viewMode");
    expect(body, "不再挂切换提示").not.toContain("setTip");
    expect(body, "innerHTML 通道已不需要（只剩纯文本）").not.toContain("innerHTML");
    // 正向：清提示 + 显示语言名，这就是全部逻辑
    expect(body, "仍要清掉可能残留的提示").toContain("clearTip");
    expect(body, "显示的仍是高亮语言名").toContain("langLabel");
  });

  it("sbLang 上不许再挂任何 click 监听", () => {
    // 反向闸在前
    expect(main, "那个切视图的 click 监听不许回来").not.toMatch(/sbLang\.addEventListener/);
    // 正向：sbLang 只剩「显示 + 清提示」两处使用，类型已改成 span
    expect(main, "sbLang 的类型标注应随 <span> 改成 HTMLSpanElement").toContain(
      'el<HTMLSpanElement>("sb-lang")',
    );
    // ⚠️ 判据按「**含 sbLang 的行**」数，且排除 `const sbLang = …` 那行声明 ——
    //    别用 `/sbLang\.\w+/`（属性访问）：`clearTip(sbLang)` 里 sbLang 是裸传参，
    //    那个正则抓不到，会误报「只有 textContent 一处」。也别只匹配行首，
    //    同理漏掉 clearTip 那行。
    const uses = main
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes("sbLang") && !l.startsWith("const sbLang"));
    expect(uses, "sbLang 只该出现在「显示语言名」与「clearTip(sbLang)」两处").toHaveLength(2);
    expect(uses[0], "第一处应是显示语言名").toContain("textContent");
    expect(uses[1], "第二处应是清提示（裸传参）").toBe("clearTip(sbLang);");
  });

  it("CSS：徽标与激活态规则已删，语言项恒为纯展示", () => {
    const code = stripCssComments(css);
    // 反向闸在前
    expect(code, ".sb-btn-active 规则已删").not.toContain(".sb-btn-active");
    expect(code, ".sb-md-badge 规则已删").not.toContain(".sb-md-badge");
    expect(code, "不再有 :not(.sb-btn) 那套「仅非 md 才纯展示」的分支").not.toContain(
      ".sb-lang:not(.sb-btn)",
    );
    // 正向：`.sb-lang` 本体带 default 光标（恒不可点）
    expect(cssDecls(ruleBlock(css, ".sb-lang")), "语言项应是手型之外的光标").toContain(
      "cursor: default",
    );
  });

  it("HTML：元素是 <span> 而非 <button>（不留不可点的按钮语义）", () => {
    // 反向闸在前
    expect(html, '不许再用 <button id="sb-lang"').not.toMatch(/<button[^>]*id="sb-lang"/);
    // 正向
    expect(html).toMatch(/<span[^>]*id="sb-lang"/);
    // 编码 / 行尾两颗仍是按钮（它们确实可点，别一起改掉）
    expect(html).toMatch(/<button[^>]*id="sb-encoding"/);
    expect(html).toMatch(/<button[^>]*id="sb-eol"/);
  });
});

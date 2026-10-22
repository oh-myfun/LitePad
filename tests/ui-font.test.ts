// @vitest-environment jsdom
/**
 * B347 · 界面字体：内嵌「度量别名」默认 face + 可配的「界面字体」设置项。
 *
 * 两条主线：
 *  1. **默认 face 不许再靠抬升 hack 居中**。做法是同一份思源 woff2 再挂一条
 *     `@font-face`，只改 used metrics（`ascent-override` / `descent-override`），
 *     字形与文件都不变（零新增字节）。判据按**实测事实**写，不按「有个 override 声明」写：
 *     A+D 必须等于这份字体自己的 used 行盒（否则行高一跳，B328/B329/B334 那一族全中招），
 *     A−D 必须等于墨迹带的偏心量（否则没居中，白改）。
 *  2. **这一项只管窗口外壳**（用户裁决）：`--font-ui` 吃别名，`--font-body`（预览正文）
 *     与 `--font-code` 一律不动。
 *
 * 实测来源：`.tmp` 量测台（dev server + 真 Chromium，dsf 1.5）——
 *   · 墨迹 @100px：基线上方 85 / 下方 9 ⇒ 墨迹中心 = 基线上方 (85-9)/2 = 38 = 0.38em；
 *   · used 行盒 @100px：A=116 / D=29 ⇒ 总高 1.45em（`line-height: normal` 的实测盒高与之一致）。
 *   ⇒ 要「总高不变 + 墨迹居中」：A = 1.45/2 + 0.38 = 1.105em，D = 1.45/2 − 0.38 = 0.345em。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as appearance from "../src/appearance";
import { cssDecls, fnBody, ruleBlock, stripCssComments, topLevelFnBody } from "./static";

const FONTS = readFileSync("src/styles/fonts.css", "utf-8");
const GLOBAL = readFileSync("src/styles/global.css", "utf-8");
const APPEARANCE = readFileSync("src/appearance.ts", "utf-8");
const PREFS = readFileSync("src/prefs.ts", "utf-8");
const API = readFileSync("src/ipc/api.ts", "utf-8");
const RUST = readFileSync("src-tauri/src/session/mod.rs", "utf-8");
const DIALOG = readFileSync("src/shell/settingsdialog.ts", "utf-8");
const MAIN = readFileSync("src/main.ts", "utf-8");

/** 实测常量（上面注释那两处）。 */
const INK_TOP = 0.85; // em，基线上方
const INK_BOT = 0.09; // em，基线下方
const STRUT = 1.45; // em，这份字体自己的 used 行盒（A+D）

/** 取 `@font-face` 块里那条族名声明的那一块（同族名可能有多条 unicode-range 分层）。 */
function face(name: string): string {
  return cssDecls(ruleBlock(FONTS, "@font-face", `font-family: "${name}"`));
}

/** 读出一块里的 `ascent-override:NN%` / `descent-override:NN%`（没有就返回 null）。 */
function pct(block: string, prop: string): number | null {
  const m = block.match(new RegExp(`${prop}:\\s*([0-9.]+)%`));
  return m ? Number(m[1]) : null;
}

describe("B347 · 界面字体默认 face = 同一份思源 + 度量别名", () => {
  it("别名 face 存在，且 src 与「Noto Sans SC」那条指向同一个文件（零新增字节）", () => {
    const alias = face("Noto Sans SC UI");
    expect(alias, 'fonts.css 里必须有 @font-face { font-family: "Noto Sans SC UI" }').toBeTruthy();
    const orig = face("Noto Sans SC");
    const urlOf = (b: string): string => b.match(/src:\s*url\("([^"]+)"\)/)?.[1] ?? "";
    expect(urlOf(alias), "别名那条要复用现有 woff2，不许再塞一份字体文件").toBeTruthy();
    expect(urlOf(alias), "别名与原本必须指向同一份文件").toBe(urlOf(orig));
  });

  it("override 的算法要自证：总高不变（A+D=strut）且墨迹居中（A−D=2×墨迹偏心）", () => {
    const alias = face("Noto Sans SC UI");
    const a = pct(alias, "ascent-override");
    const d = pct(alias, "descent-override");
    expect(a, "别名 face 必须声明 ascent-override").not.toBeNull();
    expect(d, "别名 face 必须声明 descent-override").not.toBeNull();
    // 行盒总高：动了它，22px 标签 / 28px 条带 / 侧栏行高那一族预算全要重算
    expect((a! + d!) / 100, `A+D 要等于这份字体自己的 ${STRUT}em`).toBeCloseTo(STRUT, 3);
    // 居中条件：盒中心 = 墨迹中心 ⇒ (A-D)/2 = (INK_TOP-INK_BOT)/2
    expect(
      (a! - d!) / 100,
      "A−D 要等于墨迹带的偏心量，否则只是把行盒挪了个位置、字还是偏的",
    ).toBeCloseTo(INK_TOP - INK_BOT, 3);
    // 反向对照（防恒真）：把 D 挪 5 个点 ⇒ 两条判据必须同时不成立
    const degraded = alias.replace(/descent-override:\s*[0-9.]+%/, "descent-override: 20%");
    expect(degraded, "退化串要先自证真的动到了").not.toBe(alias);
    const da = pct(degraded, "ascent-override")!;
    const dd = pct(degraded, "descent-override")!;
    expect((da + dd) / 100).not.toBeCloseTo(STRUT, 3);
    expect((da - dd) / 100).not.toBeCloseTo(INK_TOP - INK_BOT, 3);
  });

  it("抬升 hack 退休：--cjk-lift 既不再定义、也没人引用", () => {
    const sheet = stripCssComments(GLOBAL);
    expect(sheet, ":root 里不该再留 --cjk-lift（默认 face 已原生居中）").not.toMatch(
      /--cjk-lift\s*:/,
    );
    expect(sheet, "任何规则都不许再引用 --cjk-lift").not.toMatch(/var\(--cjk-lift\)/);
  });
});

describe("B347 · 这一项只管窗口外壳", () => {
  it("--font-ui 的首选族名是那颗别名；--font-body 与 --font-code 一律不吃", () => {
    const root = cssDecls(ruleBlock(GLOBAL, ":root"));
    const ui = root.match(/--font-ui:\s*([^;]+);/)?.[1] ?? "";
    const body = root.match(/--font-body:\s*([^;]+);/)?.[1] ?? "";
    const code = root.match(/--font-code:\s*([^;]+);/)?.[1] ?? "";
    expect(ui.trim().split(",")[0], "--font-ui 首选要那颗度量别名").toBe('"Noto Sans SC UI"');
    expect(body, "预览正文保持原本那颗 face（用户裁决：只管外壳）").not.toContain(
      "Noto Sans SC UI",
    );
    expect(code, "代码字体与本项无关").not.toContain("Noto Sans SC UI");
  });

  it("applyUiFontFamily：空串回落内联变量之外的默认栈，带空格的族名要加引号，且只动 --font-ui", () => {
    const apply = (appearance as Record<string, unknown>).applyUiFontFamily;
    expect(typeof apply, "appearance.ts 必须导出 applyUiFontFamily").toBe("function");
    const root = document.documentElement.style;
    (apply as (f: string) => void)("Microsoft YaHei UI");
    expect(root.getPropertyValue("--font-ui"), "族名带空格必须加引号").toBe('"Microsoft YaHei UI"');
    expect(root.getPropertyValue("--font-body"), "不许顺手改正文").toBe("");
    expect(root.getPropertyValue("--font-code"), "不许顺手改代码").toBe("");
    (apply as (f: string) => void)("");
    expect(root.getPropertyValue("--font-ui"), "空串要移除内联变量，回落到 :root 那份别名栈").toBe(
      "",
    );
    root.removeProperty("--font-ui");
  });

  it("setter 只有一处写点：apply → 写字段 → 落盘（B304 那一族的口径）", () => {
    const body = topLevelFnBody(PREFS, "setUiFontFamily");
    expect(body, "prefs.ts 必须有 setUiFontFamily").toBeTruthy();
    expect(body).toContain("applyUiFontFamily(");
    expect(body).toContain("settings.ui_font_family");
    expect(body).toContain("persistSettings()");
    expect(fnBody(APPEARANCE, "applyUiFontFamily"), "生效口只准写 --font-ui").toMatch(
      /setProperty\("--font-ui"/,
    );
  });

  it("设置项前后端成对存在（漏一头就是「改了不落盘」）", () => {
    expect(API, "前端 Settings 要有 ui_font_family").toMatch(/ui_font_family\s*:\s*string/);
    expect(RUST, "Rust Settings 要有 ui_font_family").toMatch(/pub\s+ui_font_family\s*:\s*String/);
    expect(RUST, "Rust 侧默认值要空串（空 = 用内嵌别名）").toMatch(
      /ui_font_family:\s*String::new\(\)/,
    );
  });

  it("设置页有第三栏「界面字体」，且默认档说的是内嵌那份", () => {
    const at = DIALOG.indexOf('"界面字体"');
    expect(at, "设置页必须建这一栏").toBeGreaterThan(-1);
    const row = DIALOG.slice(at, at + 600);
    expect(row, "这一栏要走 fontRow（与正文/代码同款控件）").toContain("fontRow(");
    expect(row, "回调要接到 onUiFontFamily").toContain("opts.onUiFontFamily(");
    expect(row, "默认档 label 要指向那颗内嵌别名").toContain("DEFAULT_UI_FONT_LABEL");
    expect(DIALOG, "默认档 label 要说清「内嵌」").toMatch(
      /DEFAULT_UI_FONT_LABEL\s*=\s*"默认（内嵌[^"]*）"/,
    );
  });

  it("启动回放要把它算进去（否则设置只在改的那一刻生效）", () => {
    expect(MAIN, "main.ts 启动装配要回放界面字体").toContain("applyUiFontFamily(");
  });
});

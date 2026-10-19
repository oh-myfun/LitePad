// @vitest-environment node
// B305 Task 7 · 上限项与启动装配的跨文件形状。
//
// 这些都不是「行为」（行为在 settingsdialog / store / panel 那三份用例里），而是**谁有权写**：
// 上限的读口只能有一个（store）、装配只能装一次且只装主窗口、面板只能自己订阅重画。
// 这一类形状走偏了，两侧单测照样全绿 —— B304 那次「开关显示与行为两套口径」就是这么来的。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("B305 上限项与启动装配", () => {
  const prefs = readFileSync("src/prefs.ts", "utf-8");
  const main = readFileSync("src/main.ts", "utf-8");

  it("设置页那一项读的是 recents 那份缓存，不读 settings", () => {
    expect(prefs).toContain("recentLimit: () => getRecentLimit()");
    // 名单与上限存 `recents.json`（Rust 单点持有）。要是哪天有人把它塞回 settings.json，
    // 每扇窗口那次「整表覆写」（点一下侧栏开关就写一发）就会把名单冲掉。
    expect(prefs, "上限不许住进 settings.json").not.toMatch(/settings\?\.[a-z_]*recent/);
  });

  it("改上限只经 store；prefs 不伸手画面板（第二个写点 = 迟早错开）", () => {
    expect(prefs).toContain("onRecentLimit: (v) => void applyRecentLimit(v)");
    expect(prefs, "面板由 store 的订阅自己重画").not.toContain("renderRecents");
  });

  it("装配只给主窗口，且排在会话恢复之后", () => {
    const atPanel = main.indexOf("setupRecentsPanel()");
    expect(atPanel, "没装配 ⇒ 左栏那颗键点了没东西").toBeGreaterThan(-1);
    expect(
      main.slice(atPanel - 500, atPanel),
      "子窗口没有左边栏，装上去只有一份看不见的缓存",
    ).toContain('windowKind === "main"');
    expect(
      main.indexOf("restoreSession("),
      "名单必须在会话恢复之后才取：恢复会开一批标签，先取名单就把刚打开的文件当成已关闭",
    ).toBeLessThan(main.indexOf("initRecentsStore()"));
    expect(main.indexOf("initRecentsStore()")).toBeLessThan(atPanel);
  });

  it("互斥改成结构性的：外壳按「轮到我没」写两块面板，反向注入整个不许存在（B307）", () => {
    // 旧形状是两块面板互相打电话（`setSideOpen` 叫 `closeRecentDrawer`，反过来再叫一次），
    // 两条方向各写一半 ⇒ 只要漏一条就能同时露两块。新形状只有一句：轮不到我的都得收起。
    // B312 起那一段叫 `applyView`（切换时整表循环 + 登记时补写迟到那块，两个调用者共用一段）。
    const d = readFileSync("src/shell/drawer.ts", "utf-8");
    const body = d.slice(
      d.indexOf("export function setDrawer("),
      d.indexOf("\nexport function setupSideResizer"),
    );
    expect(body, "找不到 setDrawer 这个唯一出口").toContain("applyView(name, spec)");
    const apply = d.slice(
      d.indexOf("function applyView("),
      d.indexOf("export function setDrawer("),
    );
    expect(apply, "面板显隐与点亮态必须同一段（否则又长出「键灭了还摊着」）").toContain(
      "spec.panel.hidden = name !== active;",
    );
    expect(apply, "键的点亮态读的是同一个 active").toContain(
      'spec.button.classList.toggle("is-on", name === active)',
    );
    // 反向闸：那条注入通道必须已经删干净（留着就是第二个出口）。
    expect(readFileSync("src/ui.ts", "utf-8")).not.toContain("closeRecentDrawer");
    expect(readFileSync("src/toc.ts", "utf-8")).not.toContain("closeRecentDrawer");
  });
});

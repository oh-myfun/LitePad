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

  it("没装面板时 closeRecentDrawer 是空操作（大纲那条路不许因为缺接线而炸）", () => {
    const ui = readFileSync("src/ui.ts", "utf-8");
    expect(ui).toMatch(/let closeRecentDrawerRef: \(\) => void = \(\) => \{\};/);
  });

  it("大纲那块摊开时必须叫面板收起（互斥的两个方向，缺一边就能同时露两块）", () => {
    const toc = readFileSync("src/toc.ts", "utf-8");
    const body = toc.slice(toc.indexOf("function setSideOpen("));
    expect(body.slice(0, 1400), "setSideOpen 没叫最近打开收起").toContain("closeRecentDrawer()");
  });
});

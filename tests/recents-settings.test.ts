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

  it("默认档三处同口径：Rust 的 DEFAULT_LIMIT == 设置页标（默认）那一档 == store 占位值（B323）", () => {
    const rust = readFileSync("src-tauri/src/session/recent.rs", "utf-8");
    const dialog = readFileSync("src/shell/settingsdialog.ts", "utf-8");
    const store = readFileSync("src/recents/store.ts", "utf-8");

    const rustDefault = Number(rust.match(/pub const DEFAULT_LIMIT: usize = (\d+);/)?.[1]);
    expect(rustDefault, "Rust 侧找不到默认档").toBeGreaterThan(0);
    expect(rustDefault, "用户口径：默认保留 50 条").toBe(50);

    // 只看「最近打开保留数量」那一行的档位数组（取带引号的那一处，文件头的注释里也有这个词）：
    // 全文件数「（默认）」没意义，别的行（标签样式「相连（默认）」）也各自标着自己的默认档。
    const at = dialog.indexOf('"最近打开保留数量"');
    expect(at, "设置页里找不到那一行").toBeGreaterThan(-1);
    const row = dialog.slice(at, at + 1200);
    const marked = row.match(/\{ label: "(\d+) 条（默认）", value: "(\d+)" \}/);
    expect(marked, "那一行必须恰有一档写着（默认）").toBeTruthy();
    expect([...row.matchAll(/（默认）/g)], "一行里两处标默认等于没标").toHaveLength(1);
    expect(Number(marked![2]), "label 写的条数与 value 必须同一个数").toBe(Number(marked![1]));
    expect(Number(marked![2]), "设置页的默认档要跟 Rust 一致").toBe(rustDefault);

    const placeholder = Number(store.match(/^let limit = (\d+);/m)?.[1]);
    expect(
      placeholder,
      "store 的占位值要跟 Rust 一致（首帧 aria-label「N 条，上限 M」与「上限 0 收起入口」都读它）",
    ).toBe(rustDefault);
  });
});

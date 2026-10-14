// @vitest-environment jsdom
// B288 · 回归契约：`rememberViewScroll` 不得在「容器未测量却读到 0、槽里已有真值」时
//   把真实滚动位置抹成 0（拖标签把源面板摘空 / 摘出渲染树后的零尺寸窗口，真实浏览器
//   会把 detached / 零尺寸容器的 `scrollTop` 钳成 0）。
//
//   这一条锁的是**守卫的存在与位置**：源码支与预览支在写槽之前必须有一道
//   「`scrollHeight <= 0` 且读到 0 且槽里确有真值 ⇒ 跳过」的闸口（B130/B162 纪律：
//   宁留死格、不许拿 0 抹真位置）。jsdom 造不出这个真机窗口（桩不钳 0、`scrollHeight`
//   恒为 0、detached 容器仍读桩里存的非零值），所以这里走静态契约 + 反向验证，
//   与 B126 那批同口径。真机行为由用户复现 + trace 坐实（见 `litepad.log` 行 195）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const RAW = readFileSync("src/sync-scroll.ts", "utf-8").replace(/\r\n/g, "\n");

/** 取出 `rememberViewScroll` 的函数体（首次出现，避免被 import 块截歪）。 */
function rememberBody(): string {
  const start = RAW.indexOf("export function rememberViewScroll(panel: Panel): void {");
  if (start < 0) throw new Error("应能定位 rememberViewScroll");
  const next = RAW.indexOf("\nexport function", start + 10);
  const end = next < 0 ? RAW.length : next;
  return RAW.slice(start, end);
}

/** 单道 `if` 闸口：三个判据同句出现。 */
const GUARD =
  /if\s*\([^;]*scrollHeight\s*<=\s*0[^;]*scrollTop\s*===\s*0[^;]*t\.scrollTop\s*!==\s*null[^;]*\)/;

describe("B288 rememberViewScroll 不许拿未测量的 0 抹真值", () => {
  it("源码支：写槽前必须有「未测量且读到 0 且槽有真值 ⇒ 跳过」的闸口", () => {
    const body = rememberBody();
    const rec = body.indexOf("recordScroll(t.tabId, scroller.scrollTop);");
    expect(rec, "应能定位源码支写槽语句").toBeGreaterThan(-1);
    const before = body.slice(0, rec);
    expect(before, "守卫要认「容器未测量」(scrollHeight <= 0)").toContain("scrollHeight <= 0");
    expect(before, "守卫要认「读到的是 0」(scroller.scrollTop === 0)").toContain(
      "scroller.scrollTop === 0",
    );
    expect(before, "守卫要认「槽里确有真值」(t.scrollTop !== null)").toContain(
      "t.scrollTop !== null",
    );
    expect(before, "三个判据必须同属一道 `if` 闸口").toMatch(GUARD);
  });

  it("反向验证：删掉这道闸口，上面的断言必须失败（否则锁形同虚设）", () => {
    const body = rememberBody();
    // 摘掉源码支那道 `if (scroller.scrollHeight <= 0 && ...) { ... return; }` 闸口。
    const degraded = body.replace(
      /if\s*\(scroller\.scrollHeight\s*<=\s*0[\s\S]*?return;\s*\n\s*\}/,
      "// 已删除未测量守卫",
    );
    expect(degraded, "退化：应真的摘掉了那道闸口").not.toBe(body);
    // `scroller.scrollTop === 0` 是源码支闸口独有的判据（预览支是 `root.scrollTop === 0`），
    // 摘掉后必须消失；否则上面的「源码支」断言就会形同虚设（永远真）。
    expect(degraded, "退化后源码支那道闸口的判据 scroller.scrollTop === 0 必须消失").not.toContain(
      "scroller.scrollTop === 0",
    );
  });

  it("预览支：同样要有「未测量且读到 0 且槽有真值 ⇒ 跳过」的闸口", () => {
    const body = rememberBody();
    const rec = body.indexOf("recordScroll(t.tabId, root ? root.scrollTop : null);");
    expect(rec, "应能定位预览支写槽语句").toBeGreaterThan(-1);
    const before = body.slice(0, rec);
    expect(before, "预览支守卫要认「容器未测量」").toContain("scrollHeight <= 0");
    expect(before, "预览支守卫要认「读到的是 0」").toContain("root.scrollTop === 0");
    expect(before, "预览支守卫要认「槽里确有真值」").toContain("t.scrollTop !== null");
  });

  it("B288 前置采集点：splitPanelWithTab 在 setLayout 摘空源面板之前要先 rememberViewScroll(src)", () => {
    // 拖分屏把源面板摘空时，源视图在 `setLayout` 之后才被 `disposePanel` 采，那时已
    // 零尺寸 / detached、读到 0；所以必须在摘面板**之前**先采一眼（满尺寸、真值）。
    const split = readFileSync("src/tabs/split.ts", "utf-8").replace(/\r\n/g, "\n");
    const fnStart = split.indexOf("export function splitPanelWithTab(");
    expect(fnStart, "应能定位 splitPanelWithTab").toBeGreaterThan(-1);
    const nextFn = split.indexOf("\nexport function", fnStart + 10);
    const fnEnd = nextFn < 0 ? split.length : nextFn;
    const fn = split.slice(fnStart, fnEnd);
    // 该函数内 `copy` 分支与主流程各有一处同款 `setLayout(...)`；要锁的是紧邻
    // `disposePanel(src.panelId)` 那一处（主流程），故取最后一个。
    const setLayout = fn.lastIndexOf(
      "setLayout(splitPanelAt(layout, targetId, dir, newId, newFirst));",
    );
    expect(setLayout, "应能定位拖分屏主流程的 setLayout").toBeGreaterThan(-1);
    const before = fn.slice(0, setLayout);
    expect(before, "setLayout 摘空源面板之前必须先 rememberViewScroll(src) 采真值").toContain(
      "rememberViewScroll(src)",
    );
  });
});

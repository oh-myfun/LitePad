// B393 · `scheduleFrame` 的合并语义契约：那一发帧是**被推迟**，不是被丢掉。
//
// 为什么要钉这一层：`coordinator.ts:377` 在 `rafId !== null` 时直接 return（同一帧内多次滚动
// 合并成 last-writer-wins）。页面被 Chromium 判成后台时 RAF 是**暂停**而不是丢弃，于是那一发
// 晚点才跑 —— 「晚点」要成立，前提是**帧体读的是当下的读数**：用户在后台期间滚了三下，
// 恢复可见时那一发必须广播最后落定的那一个值。这条一旦被改坏（最自然的改坏法是把 `v` 在排程
// 时就取好、关进闭包），线上表现就是「最小化之前滚了一段，还原后对栏被拽回中间某处」，
// 而且落盘通知（`coordinator.ts:390`，B302 那条）会把同一个错值写进会话记忆。
//
// 同一条用例还钉住反面：那一发**永不 fire** 时（renderer 被丢弃那一族，未复现，真机侧见
// `.tmp/b393-raf.py`），整条联动与落盘一起静默停住，但**不会永久中毒** —— 帧体开头就把
// `rafId` 清成 null，下一次驱动照样排得出新帧。
//
// ⚠️ 诚实标注：**这一份是契约钉（回归钉），不是 RED→GREEN** —— 它对着现网行为写，今天
// 就该绿；它管的是以后谁把这段语义改坏。判据用注入的假 `schedule`（`SyncScrollCoordinator`
// 的第一个参数），所以不需要真窗口，也不 mock RAF。
import { describe, it, expect } from "vitest";
import { SyncScrollCoordinator } from "../src/sync-scroll/coordinator";
import type { ScrollAnchor } from "../src/sync-scroll/anchor";

/** 一扇只有两格的窗口：`driver` 是用户正在滚的那一格，`other` 是被扶的那一格。 */
function makeWorld() {
  const frames: Array<() => void> = [];
  const coord = new SyncScrollCoordinator(
    (fn) => {
      frames.push(fn);
      return frames.length; // 协调器只拿它判「有没有在途的帧」，非 null 即算有
    },
    () => {},
  );
  const state = { driverV: 1 };
  const driver: ScrollAnchor = {
    getV: () => state.driverV,
    setV: (v) => v,
    topPos: () => Math.round(state.driverV * 100),
  };
  const written: number[] = [];
  // 被扶那一格故意**不实现** `setVAt` ⇒ 走 `setV(v)` 那条分支（跨窗口才有逐行对齐）
  const other: ScrollAnchor = {
    getV: () => 1,
    setV: (v) => {
      written.push(v);
      return v;
    },
  };
  coord.register(other, "doc1", { events: new EventTarget(), label: "P2:preview" });
  coord.register(driver, "doc1", { events: new EventTarget(), label: "P1:editor" });
  const persisted: number[] = [];
  coord.setOnUserScroll((_docId, v) => persisted.push(v));
  const runFrames = () => frames.splice(0, frames.length).forEach((f) => f());
  return { coord, frames, driver, written, persisted, runFrames, state };
}

describe("B393 · 帧合并：被推迟的那一发读的是当下的位置", () => {
  it("同一格连着滚三下只排一发帧（合并，不是三发各写一次）", () => {
    const w = makeWorld();
    w.state.driverV = 40;
    w.coord.syncFromDriver("doc1", w.driver);
    w.state.driverV = 90;
    w.coord.syncFromDriver("doc1", w.driver);
    w.state.driverV = 120;
    w.coord.syncFromDriver("doc1", w.driver);

    expect(w.frames.length, "三次驱动合并成一发").toBe(1);
    expect(w.written, "帧还没跑 ⇒ 对栏一格都没被扶").toEqual([]);
    expect(w.persisted, "落盘通知骑在同一发帧上（coordinator.ts:390）").toEqual([]);
  });

  it("那发被推迟的帧跑起来时，广播与落盘用的都是**当下**读数，不是排程那一刻的旧值", () => {
    const w = makeWorld();
    for (const v of [40, 90, 120]) {
      w.state.driverV = v;
      w.coord.syncFromDriver("doc1", w.driver);
    }
    w.runFrames();

    expect(w.written, "对栏被扶到 120 —— 记成 40 就是「还原后被拽回中间」").toEqual([120]);
    expect(w.persisted, "落盘同样落 120，不能把中间值存进会话记忆").toEqual([120]);
  });

  it("现状记录（**不是期望**）：那一发帧永不 fire 时，后续驱动全被合并掉", () => {
    // 这一条钉的是**现有行为**，写法刻意与上面两条不同 —— 它读起来像缺陷，因为它就是：
    // `rafId` 若非 null 就永远不排新帧（coordinator.ts:377），于是联动与 B302 落盘一起静默停住。
    // 之所以没按缺陷修：本机构造不出「RAF 永不 fire」那个触发态 —— `SW_MINIMIZE` 与 `SW_HIDE`
    // 两挡下 `document.hidden` 都还是 False、帧照跑（`.tmp/b393-raf.py` 的 M1/M2 两节），
    // 也就是「推迟」这条路根本没能演示出来，而「丢弃」只能靠合成前提。
    // 真机侧那条 tripwire（R③：恢复后新驱动必须排得出帧）留在台子里，WebView2 哪天改了
    // 后台策略会当场报警。改坏/修好这一条语义时，这个用例必须跟着翻，不许默默改绿。
    const w = makeWorld();
    w.state.driverV = 40;
    w.coord.syncFromDriver("doc1", w.driver); // 这一发永远不会跑
    w.state.driverV = 150;
    w.coord.syncFromDriver("doc1", w.driver);
    expect(w.frames.length, "现状：第二发排不出来（= 挂死形状），修它之前先复现触发态").toBe(1);
    expect(w.written, "现状：对栏一格都没被扶").toEqual([]);
  });
});

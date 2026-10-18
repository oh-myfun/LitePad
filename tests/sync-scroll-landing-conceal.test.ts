// @vitest-environment jsdom
// B295 · 落位收口之前不要画出来（用户报的「位置对齐前会闪动」）。
//
// 真机取证（08:14:45 那一轮，重建路径）把中间态的形状写得很清楚：
//   登记[?]      意图=17.33 落点=1.00  落点px=0.00     ← 挂载那一发被裁到顶部，还派发不出 scroll
//   落位没进去，下一帧重试#1
//   登记[P1:editor] 意图=17.33 落点=13.56 落点px=410.67 ← 重试按**估算**高度落位（差 200px）
//   →判=没兑现·补写#1 新落点=17.33/608.00              ← 回声驱动补写，这才是定局位置
// 三帧各有 16ms 的绘制机会 ⇒ 用户看到「先跳到顶部、再跳到中段、最后才对齐」。
//
// 这里钉的是**绘制时机**这条规则：链条还没收口时，那一侧的滚动面必须处于不绘制的状态；
// 收口（或到重试上限）必须在**写下这一位的同一个同步栈里**把它露出来 —— 藏/露之间没有
// 绘制机会，于是用户看到的第一帧就是收口后的位置。
// 判据不靠时间窗、不靠帧计数猜测：只认「读回的 v 是否等于意图」。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { panels, tabs, type Panel } from "../src/core/app-state";
import {
  landVisibleSideAtV,
  readVisibleV,
  reconcileSyncRegistrations,
  sharedVByDoc,
  syncCoordinator,
} from "../src/sync-scroll/wire";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve({ unlisten: () => {} }),
  emit: () => Promise.resolve(),
  emitTo: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTitle: () => Promise.resolve() }),
}));

/** 一帧的真实几何：`px` = 这一帧写下去真实停留的像素，`v` = 该像素在这一帧高度图里算出的行坐标。 */
interface Frame {
  px: number;
  v: number;
}

/** 真机那三帧（意图 17.33）。 */
const MOUNT_FRAMES: Frame[] = [
  { px: 0, v: 1.0 }, // 挂载帧：内容高度还没建起来 ⇒ 写入被裁到顶部
  { px: 410.67, v: 13.56 }, // 估算帧：软折行的真实行高还没量出来 ⇒ 按估算落位
  { px: 608, v: 17.33 }, // 定局帧：量完了 ⇒ 这一位才是对的
];

/** 第 0 帧就落定的面（正常切标签 / 切模式那一类：布局早就定局了）。 */
const SETTLED_FRAMES: Frame[] = [{ px: 608, v: 17.33 }];

/** 永远进不去一帧的面（被藏着、或内容高度一直是 0）——用来钉「到上限也必须露出来」。 */
const STUCK_FRAMES: Frame[] = [{ px: 0, v: 1.0 }];

/**
 * 按脚本逐帧回报几何的假编辑器面。
 *
 * 每次**写入** `scrollTop` 消费一帧（值本身忽略：真机那儿的裁剪与高度图滞后不是我们能
 * 在 jsdom 里算出来的，只能按真机读数脚本化）。读回走同一帧，所以 `setV` 回报的就是
 * 「那一帧真实落到哪一行」。`put()` 用来模拟链条结束之后**用户自己**把视口挪到别处。
 */
function lagView(frames: Frame[]) {
  let frame = 0;
  let cur: Frame = frames[0];
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollTop", {
    get: () => cur.px,
    set: () => {
      cur = frames[Math.min(frame, frames.length - 1)];
      frame += 1;
    },
  });
  const view = {
    scrollDOM: el,
    lineBlockAtHeight: () => {
      const v = cur.v;
      return {
        from: (Math.floor(v) - 1) * 10,
        top: cur.px - (v - Math.floor(v)) * 100,
        height: 100,
      };
    },
    lineBlockAt: (from: number) => ({ from, top: 0, height: 0 }),
    state: {
      doc: {
        lines: 40,
        line: (n: number) => ({ from: (n - 1) * 10 }),
        lineAt: (pos: number) => ({ number: Math.floor(pos / 10) + 1 }),
      },
    },
  };
  return { el, view, put: (px: number, v: number) => (cur = { px, v }) };
}

/** 挂一个「显示着非 md 文档 ⇒ 可见侧就是编辑器」的面板（非 md 时 viewMode 一律算 source）。 */
function mountPanel(panelId: number, tabId: number, frames: Frame[], docId = 1) {
  tabs.set(tabId, { tabId, docId, panelId, viewMode: "source", scrollV: 1 } as unknown as never);
  const { el, view, put } = lagView(frames);
  const panel = {
    panelId,
    tabs: [tabId],
    activeTabId: tabId,
    viewTabId: tabId,
    view: { view },
    preview: null,
    previewTimer: null,
    bodyEl: el,
  } as unknown as Panel;
  panels.set(panelId, panel);
  return { panel, el, put };
}

/** 走一拍：`tests/setup.ts` 把 rAF 换成 setTimeout(0)，所以这一拍就是「下一帧」。 */
const nextFrame = () => new Promise((r) => setTimeout(r, 0));

describe("落位收口前的中间帧 · 不画出来（B295）", () => {
  beforeEach(() => {
    panels.clear();
    tabs.clear();
  });

  afterEach(() => {
    panels.clear();
    tabs.clear();
  });

  it("挂载那一发完全没进去 ⇒ 先藏起来，别把顶部画出来", () => {
    const { panel, el } = mountPanel(31, 11, MOUNT_FRAMES);
    expect(landVisibleSideAtV(panel, 17.33)).toBe(true);
    expect(el.style.visibility).toBe("hidden");
  });

  it("重试按估算高度落位（还没收口）⇒ 继续藏，中段位置也不许画", () => {
    const { panel, el } = mountPanel(32, 11, MOUNT_FRAMES);
    landVisibleSideAtV(panel, 17.33);
    return nextFrame().then(() => {
      expect(el.scrollTop).toBeCloseTo(410.67, 2); // 确实重试过，落在估算位置
      expect(el.style.visibility).toBe("hidden"); // 但那一帧用户看不见
    });
  });

  it("定局那一帧同栈收口 ⇒ 立刻露出来，于是露出来的第一帧就是对的", () => {
    const { panel, el } = mountPanel(33, 11, MOUNT_FRAMES);
    landVisibleSideAtV(panel, 17.33);
    return nextFrame()
      .then(() => nextFrame())
      .then(() => {
        expect(el.scrollTop).toBeCloseTo(608, 2);
        expect(el.style.visibility).toBe("");
      });
  });

  it("永远收不了口也得露出来（重试到上限就认现状，不能把内容藏死）", () => {
    const { panel, el } = mountPanel(34, 12, STUCK_FRAMES);
    landVisibleSideAtV(panel, 17.33);
    expect(el.style.visibility).toBe("hidden");
    return nextFrame()
      .then(() => nextFrame())
      .then(() => nextFrame())
      .then(() => nextFrame())
      .then(() => {
        expect(el.style.visibility).toBe("");
      });
  });

  it("第 0 帧就落准（切标签 / 切模式那一类）⇒ 一次都不许藏", () => {
    const { panel, el } = mountPanel(35, 13, SETTLED_FRAMES);
    expect(landVisibleSideAtV(panel, 17.33)).toBe(true);
    expect(el.style.visibility).toBe("");
    return nextFrame().then(() => {
      expect(el.style.visibility).toBe("");
      expect(el.scrollTop).toBeCloseTo(608, 2);
    });
  });

  it("链条结束时向账本登记的仍是收口那一点的意图与落点（回声照旧被吞掉）", () => {
    const { panel, el } = mountPanel(36, 14, MOUNT_FRAMES);
    landVisibleSideAtV(panel, 17.33);
    return nextFrame()
      .then(() => nextFrame())
      .then(() => {
        // `pendingExpectation` 非 null = 还有一笔在途承诺；收口后登记的就是这一发，
        // 所以紧随其后的回声会被判成「兑现·吞掉」而不是「用户滚动·广播」。
        expect(syncCoordinator.pendingExpectation(el)).toBeCloseTo(17.33, 2);
      });
  });
});

describe("落位链在途时，DOM 读数不是位置的家（B296 · 跨窗口双重建）", () => {
  // 真机 14:19:51（拖标签出新窗口那一段）主窗口在 16ms 内被 `rebuildLayout` 了**两轮**：
  //   .548 第一轮：快照 17.33 → 落位链起来（DOM 还停在 0px，写入被裁）
  //   .568 第二轮：`readVisibleV` 读的是 DOM ⇒ **1.00** ⇒ `重建前快照 存=1.00 doc共享=1.00`
  //   .572 第二轮就按 1.00 落位：新建的元素没被藏着（链藏的是上一轮的旧节点），于是**文档顶部
  //        被画出来**；而 `tab.scrollV` 被写坏成 1.00 —— 位置的家就这么塌了，随后原样落进会话。
  //   .596 是第一轮那条链还在重试（意图仍是 17.33）才把位置救回来 —— 靠运气，不是设计。
  // 判据：落位链在途时，这一格的「现在的位置」认那笔在途意图；链一结束就交还给 DOM。
  // 「快照必须在 destroy 之前读」那条纪律不改 —— 改的是**读谁**：账本在前，DOM 兜底。

  it("链刚起（DOM 还在 0px）⇒ readVisibleV 认在途意图", () => {
    const { panel } = mountPanel(41, 21, MOUNT_FRAMES);
    landVisibleSideAtV(panel, 17.33);
    expect(readVisibleV(panel)).toBeCloseTo(17.33, 2);
  });

  it("链在途时 sharedVByDoc 也不许报 1.00（否则同文档的接班全被钉回第一行）", () => {
    const { panel } = mountPanel(42, 22, MOUNT_FRAMES, 7);
    reconcileSyncRegistrations(); // 把这一格的假面注册进协调器：`currentV` 读的就是 DOM 的 1.00
    landVisibleSideAtV(panel, 17.33);
    expect(sharedVByDoc().get("7")).toBeCloseTo(17.33, 2);
  });

  it("链一结束就交还给 DOM 读数（不许把在途值焊死，用户随后滚到哪儿快照就得记哪儿）", () => {
    const { panel, put } = mountPanel(43, 23, MOUNT_FRAMES);
    landVisibleSideAtV(panel, 17.33);
    return nextFrame()
      .then(() => nextFrame())
      .then(() => {
        put(300, 9.5); // 用户自己滚到 9.5 行
        expect(readVisibleV(panel)).toBeCloseTo(9.5, 2);
      });
  });

  it("一次就落准的落位不留任何在途记录", () => {
    const { panel, put } = mountPanel(44, 24, SETTLED_FRAMES);
    landVisibleSideAtV(panel, 17.33);
    put(200, 7.5);
    expect(readVisibleV(panel)).toBeCloseTo(7.5, 2);
  });
});

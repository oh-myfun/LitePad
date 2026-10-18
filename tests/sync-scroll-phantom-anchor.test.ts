// @vitest-environment jsdom
// B299 · 报不出位置的锚点，不许当共享位置的权威。
//
// 病形（用户报：把标签拖出窗口自动建新窗口，新窗口那份跳回顶部；同轮里拖进主窗口、
// 窗内跨面板拖拽都正常）：新窗口是**冷启动**——它是那份文档在本机唯一的一个在册视口，
// 而它此刻是预览态、块还没铺开。`PreviewScrollAnchor.getV()` 在这种状态下写死返回 1.0
// （不是「量到停在顶部」，是「量不出来」），于是：
//
//   adopt：inst.scrollV = 载荷 39.09                     ← 位置是对的
//   rebuild #1：落位 → setV(39.09) → 没铺开 ⇒ 只排下一帧、把 39.09 当**承诺**返回
//              ⇒ 没有重试链、没有欠账、DOM 仍是 0
//   rebuild #2（卫星窗口启动路径紧接着还有一发）：sharedVByDoc → currentV → 那个锚点
//              报 1.0 ⇒ 「该文档现在的共享位置 = 顶部」⇒ tab.scrollV = 1.00（记忆被改写）
//
// 之后的补定位就落在顶部。老窗口不出事是因为那份文档在那儿另有一个**量得出位置**的面。
//
// 这里钉的是判据本身：一个锚点只有在自己说「我量得出来」时，它报的数才有权威。
// 注意 1.0 对编辑器锚点是**诚实读数**（真的停在顶部），所以修法不是「过滤 1.0」，
// 而是把「量不出来」这个事实由锚点自己讲出来（`hasPosition`）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { docSyncModes, docs, panels, tabs, type Panel, type Tab } from "../src/core/app-state";
import {
  PreviewScrollAnchor,
  type PreviewBlockGeom,
  type PreviewScrollSurface,
} from "../src/sync-scroll/preview";
import {
  landVisibleSideAtV,
  readVisibleV,
  reconcileSyncRegistrations,
  sharedVByDoc,
  syncCoordinator,
} from "../src/sync-scroll/wire";

/** 走一拍：`tests/setup.ts` 把 rAF 换成 setTimeout(0)，所以这一拍就是「下一帧」。 */
const nextFrame = () => new Promise((r) => setTimeout(r, 0));

/** 可控块几何的假预览表面（与 `sync-scroll-preview.test.ts` 同一条口径）。 */
function fakePreview() {
  const root = document.createElement("div");
  let blocks: Array<{ lineStart: number; lineEnd: number; top: number; height: number }> = [];
  const queue: Array<() => void> = [];
  const surface: PreviewScrollSurface = {
    root,
    blocks: () => blocks,
    schedule: (fn) => queue.push(fn),
  };
  Object.defineProperty(root, "clientHeight", { value: 600, configurable: true });
  return {
    root,
    surface,
    layOut(next: typeof blocks) {
      blocks = next;
    },
    flush() {
      for (const fn of queue.splice(0, queue.length)) fn();
    },
    queued: () => queue.length,
  };
}

describe("PreviewScrollAnchor.hasPosition：量得出来才算数", () => {
  it("一块都没有 ⇒ 量不出来（此时 getV() 那个 1.0 是编的，不是读数）", () => {
    const f = fakePreview();
    expect(new PreviewScrollAnchor(f.surface).hasPosition()).toBe(false);
  });

  it("块在但几何还没量出来（top/height 全 0）⇒ 同样量不出来", () => {
    const f = fakePreview();
    f.layOut([{ lineStart: 1, lineEnd: 3, top: 0, height: 0 }]);
    expect(new PreviewScrollAnchor(f.surface).hasPosition()).toBe(false);
  });

  it("铺开并且量过几何 ⇒ 报得出位置", () => {
    const f = fakePreview();
    f.layOut([
      { lineStart: 1, lineEnd: 3, top: 0, height: 30 },
      { lineStart: 4, lineEnd: 6, top: 30, height: 30 },
    ]);
    expect(new PreviewScrollAnchor(f.surface).hasPosition()).toBe(true);
  });

  it("排着补定位（那一发还只是承诺）⇒ 位置不算数，哪怕块已经铺开", () => {
    const f = fakePreview();
    const anchor = new PreviewScrollAnchor(f.surface);
    anchor.setV(20); // 没铺开 ⇒ 只排下一帧
    f.layOut([
      { lineStart: 1, lineEnd: 3, top: 0, height: 30 },
      { lineStart: 4, lineEnd: 6, top: 30, height: 30 },
    ]);
    expect(anchor.hasPosition()).toBe(false);
    f.flush(); // 补定位真写下去了
    expect(anchor.hasPosition()).toBe(true);
  });
});

describe("协调器：共享位置只认报得出位置的面", () => {
  const doc = "9";

  beforeEach(() => {
    syncCoordinator.setEnabled(doc, true);
  });
  afterEach(() => {
    docSyncModes.clear();
  });

  it("该文档唯一在册的面量不出来 ⇒ currentV 给 null，而不是那个编出来的 1.0", () => {
    const f = fakePreview();
    const h = syncCoordinator.register(new PreviewScrollAnchor(f.surface), doc, {
      events: f.root,
    });
    expect(syncCoordinator.currentV(doc)).toBeNull();
    syncCoordinator.unregister(h);
  });

  it("量不出来的面排在前面也不挡路：读的是那个量得出位置的面的数", () => {
    const f = fakePreview();
    const phantom = syncCoordinator.register(new PreviewScrollAnchor(f.surface), doc, {
      events: f.root,
    });
    const honest = syncCoordinator.register({ getV: () => 20, setV: (v: number) => v }, doc, {
      events: new EventTarget(),
    });
    expect(syncCoordinator.currentV(doc)).toBeCloseTo(20, 5);
    syncCoordinator.unregister(phantom);
    syncCoordinator.unregister(honest);
  });
});

describe("重建前的共享快照：没铺开的预览格不该留下条目", () => {
  beforeEach(() => {
    panels.clear();
    tabs.clear();
    docs.clear();
    docSyncModes.clear();
  });
  afterEach(() => {
    panels.clear();
    tabs.clear();
    docs.clear();
    docSyncModes.clear();
  });

  /** 一格 md 文档、预览态、块还没铺开 —— 正是新窗口第一帧的形状。 */
  function coldPreviewPanel(panelId: number, tabId: number, docId: number, scrollV: number) {
    docs.set(docId, { docId, name: `doc${docId}.md`, path: `/tmp/doc${docId}.md` } as never);
    tabs.set(tabId, {
      tabId,
      docId,
      panelId,
      viewMode: "preview",
      scrollV,
    } as unknown as Tab);
    const f = fakePreview();
    const panel = {
      panelId,
      tabs: [tabId],
      activeTabId: tabId,
      viewTabId: tabId,
      view: null,
      preview: { root: f.root, scrollSurface: () => f.surface },
      previewTimer: null,
      bodyEl: f.root,
    } as unknown as Panel;
    panels.set(panelId, panel);
    return { panel, f };
  }

  it("该文档在这窗口只有这一个没铺开的预览面 ⇒ 共享快照报的是在途意图，绝不报那个 1.00", () => {
    const { panel, f } = coldPreviewPanel(41, 11, 5, 39.09);
    reconcileSyncRegistrations();
    // 新窗口第一帧的真实顺序：注册 → 落位（没铺开 ⇒ 只排下一帧，DOM 一个像素都没动）→
    // 紧接着一发重建要抄共享位置。上一轮就是抄在这一发上塌的：那个面报 1.0。
    expect(landVisibleSideAtV(panel, 39.09)).toBe(true);
    expect(f.queued()).toBeGreaterThan(0);
    // 这一发只是承诺 ⇒ 它记进在途落位（B296 那同一条规矩），共享快照因此报意图而不是顶部。
    expect(sharedVByDoc().get("5")).toBeCloseTo(39.09, 5);
  });

  it("同一文档另有一格量得出来 ⇒ 取那个真读数，不被没铺开的那格带成顶部", () => {
    coldPreviewPanel(42, 11, 6, 39.09);
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollTop", { value: 200, configurable: true });
    const view = {
      scrollDOM: el,
      // 一行 10px 的线性自洽映射：200px ⇒ v=21
      lineBlockAtHeight: (h: number) => {
        const from = Math.floor(h / 10) * 10;
        return { from, top: from, height: 10 };
      },
      lineBlockAt: (from: number) => ({ from, top: from, height: 10 }),
      state: {
        doc: {
          lines: 40,
          line: (n: number) => ({ from: (n - 1) * 10 }),
          lineAt: (p: number) => ({ number: Math.floor(p / 10) + 1 }),
        },
      },
    };
    docs.set(6, { docId: 6, name: "doc6.md", path: "/tmp/doc6.md" } as never);
    tabs.set(12, {
      tabId: 12,
      docId: 6,
      panelId: 43,
      viewMode: "source",
      scrollV: 1,
    } as unknown as Tab);
    panels.set(43, {
      panelId: 43,
      tabs: [12],
      activeTabId: 12,
      viewTabId: 12,
      view: { view },
      preview: null,
      previewTimer: null,
      bodyEl: el,
    } as unknown as Panel);
    reconcileSyncRegistrations();
    expect(sharedVByDoc().get("6")).toBeCloseTo(21, 2);
  });
});

describe("预览那句「下一帧补定位」只是承诺，不算落定（B299 · sat-3 那一发）", () => {
  // 真机 18:35:34 sat-3 的形状（拖出预览标签 → 新窗口复位到顶部）：
  //   接手 tab=1 载荷v=6.84 记下=6.84                     ← 载荷是对的
  //   重建落位 记忆=6.84 无共享值 ⇒ 登记 意图=6.84 落点=6.84 落点px=0.00
  //                                             ↑ 块还没铺开：`setV` 不写像素，只排下一帧，
  //                                               并把**承诺**原样返回当成落点
  //   （40ms 后）读可见侧[P0:preview] v=1.00 ⇒ 重建前快照 存=1.00 ⇒ 重建落位 记忆=1.00 跟随共享=1.00
  //   ⇒ 记忆被写坏、补定位落在顶部。
  // 那一发补定位随后被还不敷高的容器裁回 0；而**像素没变就不派发 `scroll`** ⇒ 没有回声、
  // 账本的补写兑现一次都不触发（B294 那一族的病），承诺被消费掉、位置静默丢掉，而这笔欠账
  // 谁都没记。这一组钉的是：**只是承诺就不算收口** —— 欠账要记下、链要自己续跑。
  const DOC = 7;

  /** 建模「写入按可滚范围被裁」的预览面：`grow()` 之前容器根本滚不动。 */
  function clippingPreview() {
    const root = document.createElement("div");
    const writes: number[] = [];
    let top = 0;
    let maxScroll = 0;
    let blocks: PreviewBlockGeom[] = [];
    Object.defineProperty(root, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (x: number) => {
        writes.push(x);
        top = Math.max(0, Math.min(x, maxScroll));
      },
    });
    Object.defineProperty(root, "clientHeight", { value: 600, configurable: true });
    const queue: Array<() => void> = [];
    const surface: PreviewScrollSurface = {
      root,
      blocks: () => blocks,
      schedule: (fn) => queue.push(fn),
    };
    return {
      root,
      writes,
      surface,
      /** 块几何与可滚范围一起长起来（真机里那是渲染 + 图片撑高的效果）。 */
      grow(next: PreviewBlockGeom[], scrollable: number) {
        blocks = next;
        maxScroll = scrollable;
      },
      flush() {
        for (const fn of queue.splice(0, queue.length)) fn();
      },
      queued: () => queue.length,
    };
  }

  /** 一格 md、预览态的面板（`faceOf` 走预览那条支线：锚点由生产自己 new）。 */
  function previewPanel(panelId: number, tabId: number, docId: number, scrollV: number) {
    docs.set(docId, { docId, name: `doc${docId}.md`, path: `/tmp/doc${docId}.md` } as never);
    tabs.set(tabId, {
      tabId,
      docId,
      panelId,
      viewMode: "preview",
      scrollV,
    } as unknown as Tab);
    const f = clippingPreview();
    const panel = {
      panelId,
      tabs: [tabId],
      activeTabId: tabId,
      viewTabId: tabId,
      view: null,
      preview: { root: f.root, scrollSurface: () => f.surface },
      previewTimer: null,
      bodyEl: f.root,
    } as unknown as Panel;
    panels.set(panelId, panel);
    return { panel, f };
  }

  /** 一套自洽几何：v=20 写下去是 550px、读回也是 20（末块按块内源行均分）。 */
  const TALL: PreviewBlockGeom[] = [
    { lineStart: 1, lineEnd: 10, top: 0, height: 100 },
    { lineStart: 11, lineEnd: 30, top: 100, height: 1000 },
  ];

  beforeEach(() => {
    panels.clear();
    tabs.clear();
    docs.clear();
    docSyncModes.clear();
  });
  afterEach(() => {
    panels.clear();
    tabs.clear();
    docs.clear();
    docSyncModes.clear();
  });

  it("块还没铺开 ⇒ 这一发只是承诺：欠账必须记下，DOM/共享都不许报顶部", () => {
    const { panel } = previewPanel(51, 61, DOC, 20);
    reconcileSyncRegistrations();
    expect(landVisibleSideAtV(panel, 20)).toBe(true);
    expect(readVisibleV(panel)).toBeCloseTo(20, 5);
    expect(sharedVByDoc().get(String(DOC))).toBeCloseTo(20, 5);
  });

  it("块有了但容器还不够高 ⇒ 写下去被裁到 0，同样不许认收口：下一帧继续写", () => {
    const { panel, f } = previewPanel(52, 62, DOC, 20);
    reconcileSyncRegistrations();
    landVisibleSideAtV(panel, 20);
    const before = f.writes.length;
    f.grow(TALL, 0); // 渲染好了，可滚范围还是 0 ⇒ 任何写入都停在顶部
    return nextFrame().then(() => {
      expect(f.writes.length).toBeGreaterThan(before); // 链自己又补了一发
      expect(readVisibleV(panel)).toBeCloseTo(20, 5); // 而这格仍然欠在 20
    });
  });

  it("容器长够 ⇒ 链落准、同栈露出来、欠账销掉（此后 DOM 读数才重新作准）", () => {
    const { panel, f } = previewPanel(53, 63, DOC, 20);
    reconcileSyncRegistrations();
    landVisibleSideAtV(panel, 20);
    f.grow(TALL, 900);
    return nextFrame()
      .then(() => nextFrame())
      .then(() => {
        expect(f.root.scrollTop).toBeCloseTo(550, 0);
        expect(f.root.style.visibility).toBe("");
        expect(readVisibleV(panel)).toBeCloseTo(20, 5);
      });
  });

  it("到重试上限仍落不进去 ⇒ 认现状：不许留在藏着，也不许一直压着这笔欠账", () => {
    const { panel, f } = previewPanel(54, 64, DOC, 20);
    reconcileSyncRegistrations();
    landVisibleSideAtV(panel, 20);
    f.grow(TALL, 0); // 永远滚不动
    return nextFrame()
      .then(() => nextFrame())
      .then(() => nextFrame())
      .then(() => nextFrame())
      .then(() => {
        expect(f.root.style.visibility).toBe("");
        expect(readVisibleV(panel)).toBeCloseTo(1, 0); // 欠账已销 ⇒ 读的是 DOM 现状
      });
  });
});

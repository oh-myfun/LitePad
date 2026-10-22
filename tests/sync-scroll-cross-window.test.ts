// @vitest-environment jsdom
// B297 · 跨窗口同步滚动：开着同步的那份文件，滚一个窗口 ⇒ 所有窗口滚到同一处。
//
// 语义（用户 2026-10-18 拍板）：
//   · 「同步滚动」开关是**那份文档**的属性，不是这个窗口的属性 ⇒ 开关状态也跨窗口联动；
//   · 开着时，任何窗口里那份文档的**可见面**都被扶到同一个共享坐标 `v`（源码/预览、
//     不同宽度的窗口各自换算，像素不同而 `v` 相同）；
//   · 没在显示的那些实例（旁边的标签、被 CSS 藏起来那一侧）写不进滚动位置，只**记账**，
//     现形时落在同一处 —— 已拍板的「方案 A（接班跟随共享 v）」的跨窗口版；
//   · 只有**用户真的滚了一下**才外发（账本判成用户滚动那两支 + 程序化跳转），自己的回声 /
//     补写 / 落位链 / 远端套用一律不外发 ⇒ 不会 A 推 B、B 又推回 A。
//
// 两个窗口之间真实的 IPC 只有真机能验（jsdom 与台子都只有一个 JS 上下文）；
// 这里钉的是**接线本身**：外发口在哪些判定上被叫、收端把远端 `v` 落到哪、开关的口径。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { docSyncModes, docSyncOn, panels, tabs, type Panel, type Tab } from "../src/core/app-state";
import {
  applySharedVFromRemote,
  memoVToHiddenInstances,
  readVisibleV,
  setDocSyncMode,
  syncCoordinator,
} from "../src/sync-scroll/wire";
import { sessionStore } from "../src/session/store";
import { SyncScrollCoordinator } from "../src/sync-scroll/coordinator";
import type { ScrollAnchor } from "../src/sync-scroll/anchor";

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
  getCurrentWindow: () => ({ label: "main", setTitle: () => Promise.resolve() }),
}));

/** 会记住位置的假锚点：`setV` 原样收下，`getV` 报最后一次收到的值。 */
function memoryAnchor(start = 1) {
  const a: ScrollAnchor & { v: number; writes: number[] } = {
    v: start,
    writes: [] as number[],
    getV: () => a.v,
    setV: (v: number) => {
      a.writes.push(v);
      a.v = v;
      return v;
    },
  };
  return a;
}

/** 一帧一帧自己驱动的协调器（不靠 rAF：外发的时机本身就是判据）。 */
function manual() {
  let queued: (() => void) | null = null;
  const co = new SyncScrollCoordinator(
    (fn) => {
      queued = fn;
      return 1;
    },
    () => {},
  );
  return {
    co,
    flush() {
      const q = queued;
      queued = null;
      q?.();
    },
  };
}

describe("外发口：只有「这一发是用户滚的 / 有人主动跳」才告诉别的窗口", () => {
  it("账本无承诺的那一发（= 用户滚动）⇒ 兄弟面被扶齐，并外发一次落定后的 v", () => {
    const { co, flush } = manual();
    const sent: [string, number][] = [];
    co.setOutbound((docId, v) => sent.push([docId, v]));
    const driver = memoryAnchor(30);
    const peer = memoryAnchor(1);
    const dSurf = new EventTarget();
    const pSurf = new EventTarget();
    const dh = co.register(driver, "9", { events: dSurf });
    const ph = co.register(peer, "9", { events: pSurf });
    dSurf.dispatchEvent(new Event("scroll")); // 没有任何登记 ⇒ 判成用户滚动
    expect(sent).toEqual([]); // 还没到帧：合并进同一帧那一发
    flush();
    expect(peer.getV()).toBeCloseTo(30, 5);
    expect(sent).toEqual([["9", 30]]);
    co.unregister(dh);
    co.unregister(ph);
  });

  it("登记过、且真的落到了承诺位置的那一发（回声·兑现）⇒ 一律不外发", () => {
    const { co, flush } = manual();
    const sent: string[] = [];
    co.setOutbound((docId) => sent.push(docId));
    const peer = memoryAnchor(20);
    const pSurf = new EventTarget();
    const ph = co.register(peer, "8", { events: pSurf });
    co.expectSurfaceV(pSurf, 20, 20); // 是我们自己写下去的
    pSurf.dispatchEvent(new Event("scroll"));
    flush();
    expect(sent).toEqual([]);
    co.unregister(ph);
  });

  it("同步关着的文档 ⇒ 兄弟面不动，也不外发（开关 gate 的是整条联动）", () => {
    const { co, flush } = manual();
    const sent: string[] = [];
    co.setEnabled("7", false);
    co.setOutbound((docId) => sent.push(docId));
    const driver = memoryAnchor(15);
    const peer = memoryAnchor(1);
    const dSurf = new EventTarget();
    const dh = co.register(driver, "7", { events: dSurf });
    co.register(peer, "7", { events: new EventTarget() });
    dSurf.dispatchEvent(new Event("scroll"));
    flush();
    expect(sent).toEqual([]);
    expect(peer.getV()).toBe(1);
    co.unregister(dh);
  });

  it("同一帧内用户连滚两下 ⇒ 只外发一版（合并、后写赢，与窗内广播同一口径）", () => {
    const { co, flush } = manual();
    const sent: number[] = [];
    co.setOutbound((_docId, v) => sent.push(v));
    const driver = memoryAnchor(1);
    const dSurf = new EventTarget();
    co.register(driver, "6", { events: dSurf });
    dSurf.dispatchEvent(new Event("scroll"));
    driver.v = 42; // 同一帧内又滚了一次：读数变了，但只该发一版
    flush();
    expect(sent).toEqual([42]);
  });

  it("程序化跳转（TOC / 查找 / 转到行）也算「这一份跳了」⇒ 外发", () => {
    const { co, flush } = manual();
    const sent: number[] = [];
    co.setOutbound((_docId, v) => sent.push(v));
    const driver = memoryAnchor(50);
    const h = co.register(driver, "4", { events: new EventTarget() });
    co.syncFrom(h);
    flush();
    expect(sent).toEqual([50]);
  });

  it("没装外发口时窗内行为一字不变（跨窗口是可选端口，不是新的必经点）", () => {
    const { co, flush } = manual();
    const driver = memoryAnchor(11);
    const peer = memoryAnchor(1);
    const dSurf = new EventTarget();
    const dh = co.register(driver, "5", { events: dSurf });
    const ph = co.register(peer, "5", { events: new EventTarget() });
    dSurf.dispatchEvent(new Event("scroll"));
    flush();
    expect(peer.getV()).toBeCloseTo(11, 5);
    co.unregister(dh);
    co.unregister(ph);
  });
});

// 假的 CM6 面刻意用「一行 10px、第 n 行起点 (n-1)*10」这条**线性且自洽**的映射：
// 于是 `v=25.5` 写下去就是 245px、读回也是 25.5（不会假称落准，也不会自己触发重试链）。
function panelWith(panelId: number, tabId: number, docId: number) {
  const tab = { tabId, docId, panelId, viewMode: "source", scrollV: 1 } as unknown as Tab;
  tabs.set(tabId, tab);
  const el = document.createElement("div");
  const writes: number[] = [];
  let top = 0;
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    set: (x: number) => {
      writes.push(x);
      top = x;
    },
  });
  const view = {
    scrollDOM: el,
    lineBlockAt: (from: number) => ({ from, top: from, height: 10 }),
    lineBlockAtHeight: (h: number) => {
      const from = Math.floor(h / 10) * 10;
      return { from, top: from, height: 10 };
    },
    state: {
      doc: {
        lines: 40,
        line: (n: number) => ({ from: (n - 1) * 10 }),
        lineAt: (p: number) => ({ number: Math.floor(p / 10) + 1 }),
      },
    },
  };
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
  return { panel, writes, el };
}

describe("收端：把对端推来的 v 落到本窗口", () => {
  beforeEach(() => {
    panels.clear();
    tabs.clear();
    docSyncModes.clear();
  });

  it("本窗口该文档的每个可见面都被扶到那个 v（各自换算：这里都是 245px）", () => {
    const a = panelWith(0, 11, 3);
    const b = panelWith(1, 12, 3);
    applySharedVFromRemote("3", 25.5);
    expect(a.writes).toContain(245);
    expect(b.writes).toContain(245);
    expect(readVisibleV(a.panel)).toBeCloseTo(25.5, 5);
  });

  it("另一份文档的面一个字节都不动", () => {
    const other = panelWith(0, 11, 4);
    applySharedVFromRemote("3", 25.5);
    expect(other.writes).toEqual([]);
  });

  it("没在显示的同一文档实例：写不进去，但把位置记进 tab.scrollV（现形即落在同一处）", () => {
    panelWith(0, 11, 3);
    const hidden = {
      tabId: 13,
      docId: 3,
      panelId: -1, // 借给别的窗口之后本地留的那份隐藏实例
      viewMode: "source",
      scrollV: 1,
    } as unknown as Tab;
    tabs.set(13, hidden);
    applySharedVFromRemote("3", 25.5);
    expect(hidden.scrollV).toBeCloseTo(25.5, 5);
  });

  it("正在显示的那一张也记账：切走再切回仍停在同一处", () => {
    panelWith(0, 11, 3);
    applySharedVFromRemote("3", 25.5);
    expect(tabs.get(11)!.scrollV).toBeCloseTo(25.5, 5);
  });

  it("这份文档的同步关着 ⇒ 远端推来的 v 被丢掉（开关 gate 收端，不只是发端）", () => {
    const p = panelWith(0, 11, 3);
    setDocSyncMode(3, false);
    applySharedVFromRemote("3", 25.5);
    expect(p.writes).toEqual([]);
  });

  it("收端这一发不再往外发（防回环：写入走落位纪律，不走窗内广播）", () => {
    panelWith(0, 11, 3);
    const seen: string[] = [];
    syncCoordinator.setOutbound((docId) => seen.push(docId));
    try {
      applySharedVFromRemote("3", 25.5);
      expect(seen).toEqual([]);
    } finally {
      syncCoordinator.setOutbound(null);
    }
  });
});

describe("本地滚动也要给「没在显示的那一份」记账（B344）", () => {
  beforeEach(() => {
    panels.clear();
    tabs.clear();
    // ⚠️ 只清 `docSyncModes` 不够：上面那条「开关关着」的用例把协调器自己那份也关了（走的是
    // 单一写点），不复位的话这个口第一发就被 gate 掉，红在「没记账」上看着像功能坏。
    docSyncModes.clear();
    setDocSyncMode(3, true);
    sessionStore.reset();
  });

  it("开着同步：隐藏实例的 tab.scrollV 与会话记录都刷成本帧落定后的 v", () => {
    panelWith(0, 11, 3); // 正在显示的那一张归落位/现采管，不由这个口写
    const hidden = {
      tabId: 13,
      docId: 3,
      panelId: 0, // 同一条标签带里那张**没在显示**的标签（B344 用户拖的就是它）
      viewMode: "source",
      scrollV: 7,
    } as unknown as Tab;
    tabs.set(13, hidden);
    sessionStore.register(13, 3);
    sessionStore.setScrollV(13, 7);
    memoVToHiddenInstances("3", 25.5);
    expect(hidden.scrollV, "现形/拖出时读的就是这份记忆，它必须是最新的").toBeCloseTo(25.5, 5);
    expect(sessionStore.get(13)?.scrollV, "会话记录跟着走，否则关窗再开又是旧位置").toBeCloseTo(
      25.5,
      5,
    );
  });

  it("关着同步：一个字都不改（B303「每格各存各的」不许被这条新通道破掉）", () => {
    panelWith(0, 11, 3);
    const hidden = {
      tabId: 13,
      docId: 3,
      panelId: 0,
      viewMode: "source",
      scrollV: 7,
    } as unknown as Tab;
    tabs.set(13, hidden);
    sessionStore.register(13, 3);
    sessionStore.setScrollV(13, 7);
    setDocSyncMode(3, false);
    memoVToHiddenInstances("3", 25.5);
    expect(hidden.scrollV).toBe(7);
    expect(sessionStore.get(13)?.scrollV).toBe(7);
  });

  it("正在显示的那一张不由这个口写（同一状态两个写点 = B304 的病）", () => {
    panelWith(0, 11, 3);
    tabs.get(11)!.scrollV = 7;
    memoVToHiddenInstances("3", 25.5);
    expect(
      tabs.get(11)!.scrollV,
      "可见面的位置由落位链与落盘现采写，这里再写一遍就会有两套口径",
    ).toBe(7);
  });
});

describe("开关的口径：默认开、单一真值", () => {
  beforeEach(() => docSyncModes.clear());

  it("没记过的文档 = 开（与协调器 isOn 同一缺省 ⇒ 按钮不再显示成灭的而实际还在同步）", () => {
    expect(docSyncOn(99)).toBe(true);
    expect(syncCoordinator.isOn("99")).toBe(true);
  });

  it("setDocSyncMode 同时改持久层的 map 与协调器：只改一边就是「按钮灭着却还在同步」", () => {
    setDocSyncMode(5, false);
    expect(docSyncModes.get(5)).toBe(false);
    expect(syncCoordinator.isOn("5")).toBe(false);
    setDocSyncMode(5, true);
    expect(docSyncOn(5)).toBe(true);
    expect(syncCoordinator.isOn("5")).toBe(true);
  });

  it("开关只有一个写点：走 `setDocSyncMode` 就两边一致（B304）", () => {
    // 这一条原先断言的是「恢复只写 map，引导末尾由 `pushDocSyncModes` 整表补推」—— 用例照着
    // 设计的说法自己调一遍 push 就绿，看不见真实接线的顺序，而线上那一发排在
    // `restoreSession()` **之前**、推的是空表 ⇒ 真机 23:23:01「键灭着却还在同步」。
    // 写点合并之后不需要补推，也就不存在「推早了」这种病。
    setDocSyncMode(12, false);
    expect(docSyncModes.get(12)).toBe(false);
    expect(syncCoordinator.isOn("12"), "只写 map 就会分裂：协调器仍按缺省「开」").toBe(false);
    setDocSyncMode(12, true);
  });
});

describe("带视觉行位置的远端推（B300 · 逐行对齐）", () => {
  // 上面那条「开关关着」的用例把 doc 3 关掉了；不清一遍的话这里第一条就会被 gate 掉，
  // 红在「writes 是空的」上 —— 看着像落位坏了，其实是上一格的状态漏过来。
  const reset = () => {
    panels.clear();
    tabs.clear();
    // ⚠️ 只清 `docSyncModes` 不够：协调器自己那份 `docEnabled` 还在（上一格把 doc 3 关了），
    // 于是收端 gate 掉、writes 空 —— 看着像落位坏了，其实是状态漏过来。走单一写点两边一起复位。
    docSyncModes.clear();
    setDocSyncMode(3, true);
  };
  beforeEach(reset);
  afterEach(reset);

  // 假视图是「一行 10px、第 n 行起点 (n-1)*10」的线性映射，且不提坐标 API ⇒
  // `setVAt` 走**块顶兜底**分支：把该字符所在逻辑行的块顶贴到容器顶。
  it("有 pos ⇒ 编辑器面按 pos 落（这块 fake 里是 200px），而不是按对端的 v 换算出的 245px", () => {
    const p = panelWith(0, 11, 3);
    applySharedVFromRemote("3", 25.5, 200);
    expect(p.writes).toContain(200);
    expect(p.writes).not.toContain(245);
    // 而共享坐标仍然记的是 `v`：记忆是这份文档层面的位置，不是某一格的像素
    expect(tabs.get(11)!.scrollV).toBeCloseTo(25.5, 5);
  });

  it("按 pos 那一发向账本登记的是**自己读回的 v**（21），不是对方的 25.5 —— 否则回声会被判成没兑现而补写回去", () => {
    const p = panelWith(0, 11, 3);
    applySharedVFromRemote("3", 25.5, 200);
    // scrollTop=200 ⇒ 这块 fake 算出的 v 是 21.0（第 21 行行首）
    expect(syncCoordinator.pendingExpectation(p.el)).toBeCloseTo(21, 5);
  });

  it("pos 缺省（老对端）⇒ 照旧按 v 落位", () => {
    const p = panelWith(0, 11, 3);
    applySharedVFromRemote("3", 25.5);
    expect(p.writes).toContain(245);
    expect(syncCoordinator.pendingExpectation(p.el)).toBeCloseTo(25.5, 5);
  });
});

// @vitest-environment jsdom
// B302 · 滚动位置的持久化与恢复。
//
// 用户拍板的四条口径（2026-10-18）：
//   · **每格各存各的**：会话里每个标签实例记自己那一份 `v`；
//   · **文档级兜底**：这一格从没被看到过（记录里是 `null`）才借同文档别的实例记的那份
//     （恢复侧的用例在 `session-restore-state.test.ts`，那份文件跑得动真的恢复流程）；
//   · **每个窗口各存各的**：主窗口采自己屏上的格，卫星那一份走交还；
//   · **卫星窗口的位置交给主窗口落盘**（卫星自己不写会话，见 `scheduleSessionSave` 闸门）。
//
// ⚠️ `null`（从没记过）与 `1`（就停在顶部）必须在数据里分得开 —— 这是 B299 的教训：
// 「量不出来」和「量出来就是那个值」写成同一个样，恢复时就会把对的记忆覆盖成顶部。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  docs,
  panels,
  remotedTabs,
  tabs,
  type Doc,
  type Panel,
  type Tab,
} from "../src/core/app-state";
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
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve({ unlisten: () => {} }),
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
  open: () => Promise.resolve(null),
  save: () => Promise.resolve(null),
}));

// `persist` 这条 import 链会去取 `#layout-area` 这些真 DOM 节点（模块级 `el()`），
// 所以先把 index.html 的 body 摆好，再动态 import。
document.body.innerHTML = (
  readFileSync("index.html", "utf-8").match(/<body>([\s\S]*)<\/body>/)?.[1] ?? ""
).replace(/<script[\s\S]*?<\/script>/g, "");

const { samplePanelScrollV } = await import("../src/session/persist");
const { collectWindowPositions, applyHandedBackPositions } =
  await import("../src/sync-scroll/wire");

/**
 * 确定几何的编辑器视图替身：`heights[i]` 是第 i+1 行（0-based）的块高，每行 100 个字符。
 * jsdom 没有布局，真实 CM6 会退回估算行高，所以这里喂 `EditorScrollAnchor` 的结构子集。
 */
function fakeEditor(heights: number[], scrollTop: number) {
  const tops: number[] = [];
  let acc = 0;
  for (const h of heights) {
    tops.push(acc);
    acc += h;
  }
  const total = acc;
  const scrollDOM = { scrollTop } as unknown as HTMLElement;
  const view = {
    scrollDOM,
    lineBlockAtHeight(h: number) {
      const hh = Math.max(0, Math.min(h, Math.max(0, total - 1)));
      for (let i = 0; i < heights.length; i++) {
        if (hh >= tops[i] && hh < tops[i] + heights[i]) {
          return { top: tops[i], height: heights[i], from: i * 100 };
        }
      }
      const last = heights.length - 1;
      return { top: tops[last], height: heights[last], from: last * 100 };
    },
    lineBlockAt(pos: number) {
      const i = Math.min(heights.length - 1, Math.max(0, Math.floor(pos / 100)));
      return { top: tops[i], height: heights[i], from: i * 100 };
    },
    state: {
      doc: {
        lines: heights.length,
        line(n: number) {
          return { from: (n - 1) * 100 };
        },
        lineAt(pos: number) {
          return { number: Math.floor(pos / 100) + 1 };
        },
      },
      selection: { main: { head: 0 } },
    },
  };
  return { view, scrollDOM };
}

function mdDoc(docId: number, name: string): Doc {
  return {
    tabId: docId,
    id: docId,
    path: name,
    name,
    encoding: "UTF-8",
    eol: "LF",
    mixedEol: false,
    readonly: false,
    dirty: false,
    baseline: "",
    baselineEncoding: "UTF-8",
    baselineEol: "LF",
    external: false,
    langLabel: "",
    diskMtimeMs: 0,
    diskSize: 0,
    sizeClass: "normal",
    backupId: null,
    backedUp: false,
  } as unknown as Doc;
}

function inst(
  tabId: number,
  docId: number,
  panelId: number,
  viewMode: "source" | "preview" = "source",
): Tab {
  return {
    tabId,
    docId,
    panelId,
    viewMode,
    scrollV: 1,
    comps: {},
    state: {} as never,
  } as unknown as Tab;
}

/** 挂一个看得见源码侧的面板：行高由 `heights` 定，顶边停在 `scrollTop`。 */
function panelWith(panelId: number, tab: Tab, heights: number[], scrollTop: number): Panel {
  const { view } = fakeEditor(heights, scrollTop);
  const p: Panel = {
    panelId,
    tabs: [tab.tabId],
    activeTabId: tab.tabId,
    viewTabId: tab.tabId,
    view: { view } as never,
    preview: null,
    previewTimer: null,
    bodyEl: null,
  };
  panels.set(panelId, p);
  tabs.set(tab.tabId, tab);
  return p;
}

/** 没有布局盒的那一格（还没挂载 / 已经拆掉）：`readVisibleV` 对它只能报 null。 */
function emptyPanel(panelId: number, tab: Tab): Panel {
  const p: Panel = {
    panelId,
    tabs: [tab.tabId],
    activeTabId: tab.tabId,
    viewTabId: tab.tabId,
    view: null,
    preview: null,
    previewTimer: null,
    bodyEl: null,
  };
  panels.set(panelId, p);
  tabs.set(tab.tabId, tab);
  return p;
}

/** 会记住位置的假锚点：`setV` 原样收下（= 一写就落地）。 */
function memoryAnchor(start = 1) {
  const a: ScrollAnchor & { v: number } = {
    v: start,
    getV: () => a.v,
    setV: (v: number) => {
      a.v = v;
      return v;
    },
  };
  return a;
}

/** 写不动的锚点（容器还不敷高 / 布局没定局那一形）：`setV` 回报的仍是原地。 */
function stubbornAnchor(at: number): ScrollAnchor {
  return { getV: () => at, setV: () => at };
}

/** 一帧一帧自己驱动的协调器：通知的**次数**本身就是判据，不能靠 rAF 猜。 */
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

beforeEach(() => {
  panels.clear();
  tabs.clear();
  docs.clear();
  remotedTabs.clear();
  sessionStore.reset();
});

describe("落盘前把屏上那一格的位置认账进记录（samplePanelScrollV）", () => {
  it("看得见那一侧的 v 同时写进标签记忆与会话记录", () => {
    docs.set(1, mdDoc(1, "a.md"));
    const t = inst(10, 1, 0);
    // 行高 20、顶边在 840 ⇒ tops[42]=840 是第 43 行的行首 ⇒ v=43
    const p = panelWith(0, t, new Array(50).fill(20), 840);
    sessionStore.register(t.tabId, t.docId);
    samplePanelScrollV(p);
    expect(t.scrollV).toBeCloseTo(43, 5);
    expect(sessionStore.get(t.tabId)?.scrollV).toBeCloseTo(43, 5);
  });

  it("量不出位置 ⇒ 一个字节都不改（B299 那条纪律不许在持久化上复发）", () => {
    docs.set(1, mdDoc(1, "a.md"));
    const t = inst(10, 1, -1);
    t.scrollV = 33;
    sessionStore.register(10, 1);
    sessionStore.setScrollV(10, 33);
    // 这一格连编辑器都还没有 ⇒ `readVisibleV` 报 null。此时若把兜底读数当位置写下去，
    // 恢复时那份 33 就被覆盖成顶部 —— 与拖出新窗口跳顶同一族。
    samplePanelScrollV(emptyPanel(1, t));
    expect(t.scrollV).toBe(33);
    expect(sessionStore.get(10)?.scrollV).toBe(33);
  });

  it("每格各存各的：两格看同一份文档，各自的 v 进各自的记录", () => {
    docs.set(1, mdDoc(1, "a.md"));
    const tA = inst(11, 1, 0);
    const tB = inst(12, 1, 1);
    const pA = panelWith(0, tA, new Array(50).fill(20), 400); // v = 21
    const pB = panelWith(1, tB, new Array(50).fill(20), 840); // v = 43
    sessionStore.register(11, 1);
    sessionStore.register(12, 1);
    sessionStore.setPanel(0, [11], 11);
    sessionStore.setPanel(1, [12], 12);
    samplePanelScrollV(pA);
    samplePanelScrollV(pB);
    const state = sessionStore.toSessionState(() => true);
    expect(state.panels[0].tabs[0].scrollV).toBeCloseTo(21, 5);
    expect(state.panels[1].tabs[0].scrollV).toBeCloseTo(43, 5);
  });

  it("从没被看到过的那一格记的是 null，不是 1（磁盘形状必须分得开）", () => {
    docs.set(1, mdDoc(1, "a.md"));
    const shown = inst(13, 1, 0);
    const never = inst(14, 1, 2);
    const p = panelWith(0, shown, new Array(50).fill(20), 400);
    emptyPanel(2, never);
    sessionStore.register(13, 1);
    sessionStore.register(14, 1);
    sessionStore.setPanel(0, [13], 13);
    sessionStore.setPanel(2, [14], 14);
    samplePanelScrollV(p);
    const state = sessionStore.toSessionState(() => true);
    expect(state.panels[0].tabs[0].scrollV).toBeCloseTo(21, 5);
    expect(
      state.panels[1].tabs[0].scrollV,
      "没采到的那格留 null，恢复时才轮得到文档级兜底",
    ).toBeNull();
  });
});

describe("落盘通知（setOnUserScroll）：与同步开关无关，但一次手势只报一帧", () => {
  it("账本无承诺那一发（= 用户滚动）⇒ 到帧才通知一次，报的是落定后的读数", () => {
    const { co, flush } = manual();
    const notes: [string, number][] = [];
    co.setOnUserScroll((docId, v) => notes.push([docId, v]));
    const driver = memoryAnchor(30);
    const surf = new EventTarget();
    const h = co.register(driver, "9", { events: surf });
    surf.dispatchEvent(new Event("scroll"));
    expect(notes, "还没到帧就不该通知（一次手势几十发 scroll 只汇成一发）").toEqual([]);
    driver.v = 31; // 同一帧内又滚了一点：落定读数才是该落盘的那一个
    flush();
    expect(notes).toEqual([["9", 31]]);
    co.unregister(h);
  });

  it("同步开关关着 ⇒ 照样落盘通知，但一个字都不外发、本窗口兄弟面也不动", () => {
    const { co, flush } = manual();
    const notes: number[] = [];
    const sent: number[] = [];
    co.setEnabled("7", false);
    co.setOnUserScroll((_d, v) => notes.push(v));
    co.setOutbound((_d, v) => sent.push(v));
    const driver = memoryAnchor(15);
    const peer = memoryAnchor(1);
    const dSurf = new EventTarget();
    const dh = co.register(driver, "7", { events: dSurf });
    const ph = co.register(peer, "7", { events: new EventTarget() });
    dSurf.dispatchEvent(new Event("scroll"));
    flush();
    expect(notes, "「我滚到了 15」与联动开关无关，会话要记住它").toEqual([15]);
    expect(sent, "关着的文档不许推给别的窗口").toEqual([]);
    expect(peer.getV(), "关着的文档连本窗口兄弟面都不该动").toBe(1);
    co.unregister(dh);
    co.unregister(ph);
  });

  it("回声（承诺兑现）不算「有人滚了」⇒ 不通知（否则对端推回来的位置会被记成本地滚动）", () => {
    const { co, flush } = manual();
    const notes: number[] = [];
    co.setOnUserScroll((_d, v) => notes.push(v));
    const a = memoryAnchor(20);
    const surf = new EventTarget();
    const h = co.register(a, "8", { events: surf });
    co.expectSurfaceV(surf, 20, 20); // 是我们自己写下去的那一发
    surf.dispatchEvent(new Event("scroll"));
    flush();
    expect(notes).toEqual([]);
    co.unregister(h);
  });

  it("没兑现·补写那一发同样不算用户滚动 ⇒ 不许把还没落地的读数落进会话", () => {
    const { co, flush } = manual();
    const notes: number[] = [];
    co.setOnUserScroll((_d, v) => notes.push(v));
    const stuck = stubbornAnchor(1);
    const surf = new EventTarget();
    const h = co.register(stuck, "5", { events: surf });
    // 承诺在 20、那一发**真实只落到 1**（被还不敷高的容器裁住）：下一发 scroll 的像素/读数
    // 与落点一致 ⇒ 账本认它是自己人，走补写，不该把途中那个 1.00 报上去覆盖会话里的真位置。
    co.expectSurfaceV(surf, 20, 1);
    surf.dispatchEvent(new Event("scroll"));
    flush();
    expect(notes, "补写途中报上来的 1.00 会把会话里的真位置覆盖成顶部").toEqual([]);
    co.unregister(h);
  });

  it("主动跳转（TOC / 转到行）⇒ 通知，且关着同步也通知", () => {
    const { co, flush } = manual();
    const notes: number[] = [];
    co.setOnUserScroll((_d, v) => notes.push(v));
    co.setEnabled("3", false);
    co.syncTo("3", 12.5);
    flush();
    expect(notes).toEqual([12.5]);
  });
});

describe("卫星窗口那份位置交还主窗口（每个窗口各存各的 ⇒ 主窗口替它落盘）", () => {
  it("采集只收「本窗口屏上量得出位置」的那些文档", () => {
    docs.set(1, mdDoc(1, "a.md"));
    docs.set(2, mdDoc(2, "b.md"));
    const tA = inst(21, 1, 0);
    const tB = inst(22, 2, 1);
    panelWith(0, tA, new Array(50).fill(20), 400);
    panelWith(1, tB, new Array(50).fill(20), 840);
    // 第三格连视图都没挂 ⇒ 交还清单里不许出现它（更不许带兜底的 1.00）
    const tC = inst(23, 3, 2);
    docs.set(3, mdDoc(3, "c.md"));
    emptyPanel(2, tC);
    const out = collectWindowPositions();
    expect(out.map((x) => x.docId).sort()).toEqual([1, 2]);
    expect(out.find((x) => x.docId === 1)?.v).toBeCloseTo(21, 5);
    expect(out.find((x) => x.docId === 2)?.v).toBeCloseTo(43, 5);
  });

  it("采集顺手把标签记忆认账：交还的那一份与本地记忆必须是同一个值", () => {
    docs.set(1, mdDoc(1, "a.md"));
    const t = inst(24, 1, 0);
    panelWith(0, t, new Array(50).fill(20), 840);
    expect(collectWindowPositions()[0].v).toBeCloseTo(43, 5);
    expect(t.scrollV).toBeCloseTo(43, 5);
  });

  it("主窗口收下交还的位置：写进那份隐藏实例的记忆与会话记录", () => {
    const hidden = inst(31, 7, -1);
    hidden.scrollV = 1;
    tabs.set(31, hidden);
    remotedTabs.set(7, { tabId: 31, owner: "sat-1" });
    sessionStore.register(31, 7);
    applyHandedBackPositions("sat-1", [{ docId: 7, v: 25.5 }]);
    expect(hidden.scrollV).toBeCloseTo(25.5, 5);
    expect(sessionStore.get(31)?.scrollV).toBeCloseTo(25.5, 5);
  });

  it("对不上 owner 的交还一声不响（别的窗口那份不能顶替）", () => {
    const hidden = inst(32, 8, -1);
    hidden.scrollV = 12;
    tabs.set(32, hidden);
    remotedTabs.set(8, { tabId: 32, owner: "sat-2" });
    sessionStore.register(32, 8);
    sessionStore.setScrollV(32, 12);
    applyHandedBackPositions("sat-1", [{ docId: 8, v: 40 }]);
    expect(hidden.scrollV).toBe(12);
    expect(sessionStore.get(32)?.scrollV).toBe(12);
  });
});

// @vitest-environment jsdom
// B293 · 方案 A 的跨重建版：`sharedVByDoc()` 抄的是「各文档**此刻**的共享位置」。
//
// 为什么单独钉这一层：`rebuildLayout` → `mountView` 这条重建路径落位读的是
// `tab.scrollV`，而同一文档的第二张/第三张在被显示之前**从不注册**进协调器（B285 幽灵
// 锚点的取舍），收不到任何广播 ⇒ 它记的是缺省 1 或上一次显示时的陈值。真机取证：
// 复制一张标签后 `P0 ed=1.00/0px`、`currentV(X)=1`，切回原来那张也落到 1.00 ——
// 停在顶部的新标签成了该文档第一个在册视口，方案 A 把整份文档拽上顶。
// 修法是在**销毁任何 view 之前**把共享位置抄一份交给 mountView。
//
// 「抄的时机必须在销毁前」这条只有真机能判（jsdom 没有布局，销毁前后读数一样），
// 由 `sync-scroll-sequence.test.ts` 的序列契约钉；本文件钉的是这份抄录本身的语义：
// 按文档给值、同步关着不给值、没视口不给值。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { panels, tabs, type Panel, type Tab } from "../src/core/app-state";
import { sharedVByDoc, syncCoordinator } from "../src/sync-scroll/wire";
import type { AnchorHandle } from "../src/sync-scroll/coordinator";
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
  getCurrentWindow: () => ({ setTitle: () => Promise.resolve() }),
}));

/** 只懂读数、不会动的假锚点：`sharedVByDoc` 只要 `getV()`，一个像素都不写。 */
function fakeAnchor(v: number): ScrollAnchor {
  return { getV: () => v, setV: (x: number) => x };
}

function addPanel(panelId: number, tabId: number, docId: number): Tab {
  const tab = { tabId, docId, panelId, viewMode: "source", scrollV: 1 } as unknown as Tab;
  tabs.set(tabId, tab);
  const panel = {
    panelId,
    tabs: [tabId],
    activeTabId: tabId,
    view: null,
    viewTabId: tabId,
    preview: null,
    previewTimer: null,
    bodyEl: null,
  } as unknown as Panel;
  panels.set(panelId, panel);
  return tab;
}

describe("sharedVByDoc · 重建前抄的那一份共享位置", () => {
  /** 协调器是应用级单例：用例注册进去的锚点必须自己收干净，否则下一发读到的共享值
   *  是上一轮的残留（`currentV` 取的正是「第一个在册视口」）。 */
  const live: AnchorHandle[] = [];
  const reg = (v: number, docId: string): AnchorHandle => {
    const h = syncCoordinator.register(fakeAnchor(v), docId, { events: new EventTarget() });
    live.push(h);
    return h;
  };

  beforeEach(() => {
    panels.clear();
    tabs.clear();
    syncCoordinator.setEnabled("1", true);
    syncCoordinator.setEnabled("2", true);
  });

  afterEach(() => {
    while (live.length) syncCoordinator.unregister(live.pop()!);
  });

  it("同文档多个在册视口 → 给回那个共享值，key 是 String(docId)", () => {
    const a = addPanel(0, 11, 1);
    const b = addPanel(1, 12, 1);
    reg(43.5, "1");
    reg(43.6, "1");
    const map = sharedVByDoc();
    // 同文档的在册视口本来就互相跟齐，取第一个就是那个共享值（与 currentV 同口径）。
    expect(map.get(String(a.docId))).toBeCloseTo(43.5, 5);
    expect(map.get(String(b.docId))).toBeCloseTo(43.5, 5);
  });

  it("每份文档各记各的：两份文档两个值", () => {
    addPanel(0, 11, 1);
    addPanel(1, 12, 2);
    reg(20, "1");
    reg(70, "2");
    const map = sharedVByDoc();
    expect(map.get("1")).toBeCloseTo(20, 5);
    expect(map.get("2")).toBeCloseTo(70, 5);
  });

  it("该文档的同步关着（B152 关）⇒ 不给值，调用方回落到标签自己的记忆", () => {
    addPanel(0, 11, 1);
    reg(43.5, "1");
    syncCoordinator.setEnabled("1", false);
    expect(sharedVByDoc().has("1")).toBe(false);
    syncCoordinator.setEnabled("1", true);
    expect(sharedVByDoc().get("1")).toBeCloseTo(43.5, 5);
  });

  it("一个视口都不在册（从没显示过）⇒ 不给值 ⇒ 新标签的缺省 1 不会被冒充成共享位置", () => {
    addPanel(0, 11, 1);
    expect([...sharedVByDoc().keys()]).toEqual([]);
  });

  it("面板没有对应标签 ⇒ 跳过这一格，不产出 undefined 条目", () => {
    panels.set(0, { panelId: 0, tabs: [], activeTabId: -1, viewTabId: null } as unknown as Panel);
    reg(9, "9");
    expect([...sharedVByDoc().keys()]).toEqual([]);
  });
});

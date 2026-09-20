// @vitest-environment jsdom
// B89：跨窗口拖拽 = **拖拽途中只预览，松手才提交**。
//
// 这条边界是用户报出来的：旧实现（B71 ④）在拖拽途中一判定出界就立刻把标签送走，
// 于是「想把窗口 A 的标签拖到窗口 B 的面板 A，路过面板 B 就被合入」，而且主窗口拖出时
// 鼠标还没松手就弹出了新窗口。
//
// 本文件锁的是拖拽层这一侧的契约：
//   · 出界的判据仍带余量（擦边不能误触）；
//   · 出界**只通知**（onDragOutside，宿主据此广播指针位置），不得收尾、不得搬运；
//   · **松手**才上报一次 onDropOutOfWindow，且带松手坐标；
//   · 出界期间本窗口的落点痕迹要清掉（否则会和目标窗口的预览同时亮着）。
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  outsideWindow,
  renderSplitview,
  type PanelRenderData,
  type SplitviewCallbacks,
} from "../src/shell/splitview";
import { hitTest, clientToScreen, screenToClient } from "../src/shell/windowdrag";
import { leaf, type LayoutNode } from "../src/shell/layout";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON() {},
  } as DOMRect;
}

/** jsdom 的客户区默认 1024×768（用例里依赖这个尺寸算出界坐标）。 */
const W = 1024;
const H = 768;

function mount(withTab = false) {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  document.body.appendChild(root);

  const onDragOutside = vi.fn();
  const onDropOutOfWindow = vi.fn();
  const onDropTabToPanel = vi.fn();
  const onMergeGroup = vi.fn();
  const onMoveTabToStrip = vi.fn();
  const cb = {
    onActivatePanel: () => {},
    onActivateTab: () => {},
    onCloseTab: () => {},
    onClosePanel: () => {},
    onRatioChange: () => {},
    onMoveTabToStrip,
    onDropTabToPanel,
    onMergeGroup,
    onDragOutside,
    onDropOutOfWindow,
    mountView: () => {},
  } as unknown as SplitviewCallbacks;

  const tree: LayoutNode = { kind: "split", dir: "h", ratio: 0.5, a: leaf(1), b: leaf(2) };
  const data = new Map<number, PanelRenderData>();
  data.set(1, {
    panelId: 1,
    active: true,
    canClose: true,
    tabs: withTab ? [{ tabId: 11, name: "a.md", dirty: false, readonly: false, active: true }] : [],
  });
  data.set(2, { panelId: 2, active: false, canClose: true, tabs: [] });
  renderSplitview(root, tree, data, cb);

  const panels = root.querySelectorAll<HTMLElement>(".layout-panel");
  panels[0].getBoundingClientRect = () => rect(0, 0, 400, 300);
  panels[1].getBoundingClientRect = () => rect(400, 0, 400, 300);
  const strips = root.querySelectorAll<HTMLElement>(".panel-tabstrip");
  strips[0].getBoundingClientRect = () => rect(0, 0, 400, 28);
  strips[1].getBoundingClientRect = () => rect(400, 0, 400, 28);

  return {
    root,
    panels,
    strips,
    onDragOutside,
    onDropOutOfWindow,
    onDropTabToPanel,
    onMergeGroup,
    onMoveTabToStrip,
  };
}

function down(el: HTMLElement, x: number, y: number): void {
  el.dispatchEvent(
    new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: x,
      clientY: y,
    }),
  );
}

function move(x: number, y: number): void {
  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
}

function up(x: number, y: number, init: MouseEventInit = {}): void {
  document.dispatchEvent(
    new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y, ...init }),
  );
}

describe("B89 拖出窗口：途中只通知，松手才提交", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.body.className = "";
  });

  it("出界判据要留余量：贴着边缘擦出去不算，明确拖出去才算", () => {
    expect(outsideWindow(W / 2, H / 2)).toBe(false);
    expect(outsideWindow(0, 0)).toBe(false);
    expect(outsideWindow(W, H)).toBe(false);
    // 出界但在余量内 → 视为擦边，不算（否则最大化窗口贴边拖动会莫名弹出新窗口）
    expect(outsideWindow(-8, H / 2), "左侧擦边").toBe(false);
    expect(outsideWindow(W / 2, H + 8), "底部擦边").toBe(false);
    expect(outsideWindow(W + 8, H / 2)).toBe(false);
    // 明确出界
    expect(outsideWindow(-40, H / 2), "左侧拖出").toBe(true);
    expect(outsideWindow(W / 2, -40), "顶部拖出").toBe(true);
    expect(outsideWindow(W + 40, H / 2), "右侧拖出").toBe(true);
    expect(outsideWindow(W / 2, H + 40), "底部拖出").toBe(true);
  });

  it("拖出后一路经过窗外：只通知位置，绝不提交（用户报的『路过就被合入』）", () => {
    const m = mount(true);
    const tab = m.strips[0].querySelector<HTMLElement>(".tab")!;
    down(tab, 20, 14);
    // 一路在窗外挪动：模拟「擦过另一个窗口的好几块面板」
    move(W + 60, 200);
    move(W + 120, 260);
    move(W + 180, 320);
    expect(m.onDragOutside.mock.calls.length, "每次移动都要通知（宿主据此广播）").toBeGreaterThan(
      1,
    );
    expect(m.onDropOutOfWindow, "拖拽途中一律不提交").not.toHaveBeenCalled();
    expect(m.onDropTabToPanel).not.toHaveBeenCalled();
    expect(m.onMoveTabToStrip).not.toHaveBeenCalled();
    // 影像要跟着走（用户得看见自己拖着什么），不能中途被收尾清掉
    expect(document.querySelector(".tab-drag-ghost")).not.toBeNull();
  });

  it("松手才上报一次，且带的是松手坐标", () => {
    const m = mount(true);
    const tab = m.strips[0].querySelector<HTMLElement>(".tab")!;
    down(tab, 20, 14);
    move(W + 60, 200);
    move(W + 180, 320);
    up(W + 180, 320);
    expect(m.onDropOutOfWindow).toHaveBeenCalledTimes(1);
    expect(m.onDropOutOfWindow.mock.calls[0][0]).toMatchObject({
      tabId: 11,
      groupPanelId: null,
      clientX: W + 180,
      clientY: 320,
    });
    // 松手后照常收尾：影像与拖拽类都要清掉
    expect(document.querySelector(".tab-drag-ghost")).toBeNull();
    expect(document.body.classList.contains("tab-drag-active")).toBe(false);
  });

  it("整组拖出（从标签栏空白处起手）：松手时 groupPanelId 非 null，tabId 是占位 -1", () => {
    const m = mount(true);
    down(m.strips[0], 350, 14);
    move(-60, 200);
    expect(m.onDropOutOfWindow, "途中不提交").not.toHaveBeenCalled();
    up(-60, 200);
    expect(m.onDropOutOfWindow.mock.calls[0][0]).toMatchObject({
      groupPanelId: 1,
      tabId: -1,
    });
    expect(m.onMergeGroup).not.toHaveBeenCalled();
    expect(m.onMoveTabToStrip).not.toHaveBeenCalled();
  });

  it("出界又拖回来松手：走普通落点，绝不触发跨窗口", () => {
    const m = mount(true);
    const tab = m.strips[0].querySelector<HTMLElement>(".tab")!;
    down(tab, 20, 14);
    move(W + 60, 200); // 出界
    expect(m.onDragOutside).toHaveBeenCalled();
    move(600, 150); // 又拖回窗口内的另一块面板
    up(600, 150);
    expect(m.onDropOutOfWindow, "松手时在窗口内 = 普通分屏落点").not.toHaveBeenCalled();
    expect(m.onDropTabToPanel).toHaveBeenCalled();
  });

  it("只越阈值不出界：照常走落点判定", () => {
    const m = mount(true);
    const tab = m.strips[0].querySelector<HTMLElement>(".tab")!;
    down(tab, 20, 14);
    move(600, 150);
    expect(m.onDragOutside).not.toHaveBeenCalled();
    up(600, 150);
    expect(m.onDropTabToPanel).toHaveBeenCalled();
  });

  it("擦边出界再拖回来：不触发跨窗口（余量的意义）", () => {
    const m = mount(true);
    const tab = m.strips[0].querySelector<HTMLElement>(".tab")!;
    down(tab, 20, 14);
    move(-8, 150); // 出界但在余量内
    move(600, 150); // 又拖回面板上
    up(600, 150);
    expect(m.onDropOutOfWindow).not.toHaveBeenCalled();
    expect(m.onDropTabToPanel).toHaveBeenCalled();
  });

  it("出界时本窗口的落点痕迹要清掉（不能和目标窗口的预览同时亮着）", () => {
    const m = mount(true);
    const tab = m.strips[0].querySelector<HTMLElement>(".tab")!;
    down(tab, 20, 14);
    move(600, 150); // 先在窗口内 → 该面板亮起分屏预览
    expect(m.root.querySelectorAll(".split-preview.show").length).toBe(1);
    move(W + 60, 200); // 再拖出去
    expect(m.root.querySelectorAll(".split-preview.show").length, "预览要收掉").toBe(0);
    expect(m.root.querySelectorAll(".tab-insert").length, "插入线也要收掉").toBe(0);
    up(W + 60, 200);
  });

  it("宿主没接回调时什么也不发生（不抛错，松手后照常清场）", () => {
    document.body.innerHTML = "";
    const root = document.createElement("div");
    document.body.appendChild(root);
    const data = new Map<number, PanelRenderData>();
    data.set(1, {
      panelId: 1,
      active: true,
      canClose: true,
      tabs: [{ tabId: 11, name: "a.md", dirty: false, readonly: false, active: true }],
    });
    renderSplitview(root, leaf(1), data, {
      onActivatePanel: () => {},
      onActivateTab: () => {},
      onCloseTab: () => {},
      onClosePanel: () => {},
      onRatioChange: () => {},
      onMoveTabToStrip: () => {},
      mountView: () => {},
    } as unknown as SplitviewCallbacks);
    const strip = root.querySelector<HTMLElement>(".panel-tabstrip")!;
    strip.getBoundingClientRect = () => rect(0, 0, 400, 28);
    down(strip, 350, 14);
    expect(() => move(W + 80, 200)).not.toThrow();
    expect(() => up(W + 80, 200)).not.toThrow();
    expect(document.querySelector(".tab-drag-ghost"), "松手后照常清场").toBeNull();
  });
});

describe("B89 跨窗口落点：屏幕坐标 ⇄ 客户坐标", () => {
  // 一个 1000×800 客户区的窗口，左上角在虚拟桌面的 (80, 60)
  const g = { originX: 80, originY: 60, width: 1000, height: 800 };

  it("命中判定：客户区矩形内才算（含边界）", () => {
    expect(hitTest(g, { x: 80, y: 60 }), "左上角").toBe(true);
    expect(hitTest(g, { x: 1080, y: 860 }), "右下角").toBe(true);
    expect(hitTest(g, { x: 500, y: 400 }), "正中").toBe(true);
    expect(hitTest(g, { x: 79, y: 400 }), "左边差一格").toBe(false);
    expect(hitTest(g, { x: 1081, y: 400 }), "右边差一格").toBe(false);
    expect(hitTest(g, { x: 500, y: 59 }), "上方差一格").toBe(false);
    expect(hitTest(g, { x: 500, y: 861 }), "下方差一格").toBe(false);
  });

  it("几何拿不到时一律判不命中（宁可不亮预览，也不能送错窗口）", () => {
    expect(hitTest(null, { x: 500, y: 400 })).toBe(false);
    expect(hitTest(g, null)).toBe(false);
  });

  it("两个方向的换算互为逆运算（坐标口径一致才不会整体偏移）", () => {
    for (const [cx, cy] of [
      [0, 0],
      [12, 34],
      [999, 799],
    ]) {
      const s = clientToScreen(g, cx, cy);
      const c = screenToClient(g, s);
      expect(c.x).toBe(cx);
      expect(c.y).toBe(cy);
    }
  });

  it("换算带上了客户区原点（漏掉原点 = 预览整体偏移一个窗口）", () => {
    const s = clientToScreen(g, 100, 200);
    expect(s).toEqual({ x: 180, y: 260 });
  });
});

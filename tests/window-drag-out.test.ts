// @vitest-environment jsdom
// B71 ④：把标签**拖出窗口边界** = 让它去另一个窗口活着（主窗口开新窗、卫星窗口还回主窗口）。
//
// 拖拽层只负责判定与上报，不关心「另一个窗口」是谁 —— 这套用例锁的正是这条边界：
//   · 出界的判据带余量（擦边不能误触）；
//   · 命中就**立刻**收尾并上报，不能继续走落点判定（否则指针在客户区外，
//     panelAt 必然为 null，白跑一趟还留着浮动影像）；
//   · 上报里要带松手坐标（新窗口落在松手处）。
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  outsideWindow,
  renderSplitview,
  type PanelRenderData,
  type SplitviewCallbacks,
} from "../src/shell/splitview";
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

  const onDragOutOfWindow = vi.fn();
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
    onDragOutOfWindow,
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
    onDragOutOfWindow,
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

describe("B71 拖出窗口边界 = 送到另一个窗口", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.body.className = "";
  });

  it("出界判据要留余量：贴着边缘擦出去不算，明确拖出去才算", () => {
    // 客户区内
    expect(outsideWindow(W / 2, H / 2)).toBe(false);
    // 刚好在边界上（含边界本身）不算出界
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

  it("单个标签拖出：上报 tabId 与松手坐标，且不再走落点判定", () => {
    const m = mount(true);
    const tab = m.strips[0].querySelector<HTMLElement>(".tab")!;
    down(tab, 20, 14);
    move(W + 60, 200);
    expect(m.onDragOutOfWindow).toHaveBeenCalledTimes(1);
    expect(m.onDragOutOfWindow.mock.calls[0][0]).toMatchObject({
      tabId: 11,
      groupPanelId: null,
      clientX: W + 60,
      clientY: 200,
    });
    // 拖出后立刻收尾：落点判定与浮动影像都不该再参与
    expect(m.onDropTabToPanel, "出界就不该再判落点").not.toHaveBeenCalled();
    expect(document.querySelector(".tab-drag-ghost"), "影像要被清掉").toBeNull();
    up(W + 60, 200);
    expect(m.onDropTabToPanel, "松手时也不能补一次落点").not.toHaveBeenCalled();
  });

  it("整组拖出（从标签栏空白处起手）：groupPanelId 非 null，tabId 是占位 -1", () => {
    const m = mount(true);
    down(m.strips[0], 350, 14);
    move(-60, 200);
    expect(m.onDragOutOfWindow).toHaveBeenCalledTimes(1);
    expect(m.onDragOutOfWindow.mock.calls[0][0]).toMatchObject({
      groupPanelId: 1,
      tabId: -1,
    });
    expect(m.onMergeGroup).not.toHaveBeenCalled();
    expect(m.onMoveTabToStrip).not.toHaveBeenCalled();
  });

  it("只越阈值不出界：照常走落点判定，绝不触发开窗", () => {
    const m = mount(true);
    const tab = m.strips[0].querySelector<HTMLElement>(".tab")!;
    down(tab, 20, 14);
    move(600, 150);
    expect(m.onDragOutOfWindow, "面板之间挪动不算出界").not.toHaveBeenCalled();
    up(600, 150);
    expect(m.onDropTabToPanel).toHaveBeenCalled();
  });

  it("擦边出界再拖回来：不触发开窗（余量的意义）", () => {
    const m = mount(true);
    const tab = m.strips[0].querySelector<HTMLElement>(".tab")!;
    down(tab, 20, 14);
    move(-8, 150); // 出界但在余量内
    move(600, 150); // 又拖回面板上
    up(600, 150);
    expect(m.onDragOutOfWindow).not.toHaveBeenCalled();
    expect(m.onDropTabToPanel).toHaveBeenCalled();
  });

  it("宿主没接拖出回调时什么也不发生（不抛错，也不残留影像）", () => {
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
    expect(document.querySelector(".tab-drag-ghost"), "收尾照常清场").toBeNull();
    up(W + 80, 200);
  });
});

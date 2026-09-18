// @vitest-environment jsdom
// B71：拖标签栏**空白处** = 拖整组（对标 VS Code `editorTabsControl.onGroupDragStart`
// 的 `e.target === tabsContainer` 判据）。落点只有两种语义：
//   落在别的面板的标签区 / 中心 → 整组并入；落在边缘 → 整组搬到该侧新分屏。
// 拖回自己所在面板 = 无操作。
//
// ⚠️ 与单标签拖拽的分界必须锁住：命中任何 .tab 都只能拖那一个标签 ——
// 判据写反的话「拖标签」会变成「拖整组」，用户会莫名其妙丢掉一个分屏。
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
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

/** 左右两个面板：左 [0..400)，右 [400..800)，标签栏各占顶部 28px。 */
function mount(withTab = false) {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  document.body.appendChild(root);

  const onMergeGroup = vi.fn();
  const onMoveGroupToPanel = vi.fn();
  const onDropTabToPanel = vi.fn();
  const cb = {
    onActivatePanel: () => {},
    onActivateTab: () => {},
    onCloseTab: () => {},
    onClosePanel: () => {},
    onRatioChange: () => {},
    onMoveTabToStrip: () => {},
    onDropTabToPanel,
    onMergeGroup,
    onMoveGroupToPanel,
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

  return { root, panels, strips, onMergeGroup, onMoveGroupToPanel, onDropTabToPanel };
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

describe("B71 拖标签栏空白处 = 拖整组", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.body.className = "";
  });

  it("落在另一个面板的中心 → 整组并入（源面板消失）", () => {
    const m = mount();
    down(m.strips[0], 350, 14); // 空白处：事件目标就是 strip 本身
    move(600, 150); // 越过阈值
    expect(document.querySelector(".tab-drag-ghost-group"), "整组影像要出现").not.toBeNull();
    up(600, 150);
    expect(m.onMergeGroup).toHaveBeenCalledWith(1, 2);
    expect(m.onMoveGroupToPanel).not.toHaveBeenCalled();
  });

  it("落在另一个面板的右缘 → 整组搬到右侧新分屏", () => {
    const m = mount();
    down(m.strips[0], 350, 14);
    move(790, 150);
    up(790, 150);
    expect(m.onMoveGroupToPanel).toHaveBeenCalledWith(1, 2, "h", false);
    expect(m.onMergeGroup).not.toHaveBeenCalled();
  });

  it("落点在上/下缘 → 垂直分屏", () => {
    const m = mount();
    down(m.strips[0], 350, 14);
    move(600, 295); // rx 居中、ry 接近底部 → bottom
    up(600, 295);
    expect(m.onMoveGroupToPanel).toHaveBeenCalledWith(1, 2, "v", false);
  });

  it("Alt = 临时取消分屏：边缘落点也按并入处理（与单标签拖拽一致）", () => {
    const m = mount();
    down(m.strips[0], 350, 14);
    move(790, 150);
    up(790, 150, { altKey: true });
    expect(m.onMergeGroup).toHaveBeenCalledWith(1, 2);
    expect(m.onMoveGroupToPanel).not.toHaveBeenCalled();
  });

  it("拖回自己所在的面板 = 无操作（不做原地重排）", () => {
    const m = mount();
    down(m.strips[0], 350, 14);
    move(200, 150);
    up(200, 150);
    expect(m.onMergeGroup).not.toHaveBeenCalled();
    expect(m.onMoveGroupToPanel).not.toHaveBeenCalled();
  });

  it("⚠️ 命中 .tab 时绝不能变成整组拖拽（分界判据）", () => {
    const m = mount(true);
    const tab = m.strips[0].querySelector<HTMLElement>(".tab")!;
    expect(tab, "这条用例必须先有标签").not.toBeNull();
    down(tab, 20, 14);
    move(600, 150);
    up(600, 150);
    expect(m.onDropTabToPanel, "单标签拖拽走老路径").toHaveBeenCalled();
    expect(m.onMergeGroup, "不许整组消失").not.toHaveBeenCalled();
    expect(m.onMoveGroupToPanel).not.toHaveBeenCalled();
  });

  it("未越过阈值（只是点了一下空白）不产生任何拖拽", () => {
    const m = mount();
    down(m.strips[0], 350, 14);
    move(352, 15);
    up(352, 15);
    expect(m.onMergeGroup).not.toHaveBeenCalled();
    expect(m.onMoveGroupToPanel).not.toHaveBeenCalled();
    expect(document.querySelector(".tab-drag-ghost"), "不该闪出影像").toBeNull();
  });

  it("整组影像不带任何 data-tab-id（否则「按 tabId 查元素」会命中副本）", () => {
    const m = mount(true);
    down(m.strips[0], 350, 14);
    move(600, 150);
    const ghost = document.querySelector<HTMLElement>(".tab-drag-ghost");
    expect(ghost).not.toBeNull();
    expect(ghost!.querySelectorAll("[data-tab-id]").length).toBe(0);
    up(600, 150);
  });
});

// @vitest-environment jsdom
// B59：分屏操作与样式对齐 VS Code —— 分隔条双击复位 / 极限光标 / 方向光标 /
// 正交角手柄 / 落点 1/3 方向优先 / Alt 临时取消分屏。
// 参考源码见 docs/vscode-reference/（sash.ts/css、splitview.css、editorDropTarget.ts）。
import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  beginTabDrag,
  renderSplitview,
  zoneOf,
  type PanelRenderData,
  type SplitviewCallbacks,
} from "../src/shell/splitview";
import { eachLeaf, leaf, type LayoutNode } from "../src/shell/layout";

function rect(left = 0, top = 0, width = 400, height = 300): DOMRect {
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

interface Mounted {
  root: HTMLElement;
  cb: SplitviewCallbacks;
  onDrop: ReturnType<typeof vi.fn>;
  onRatioChange: ReturnType<typeof vi.fn>;
}

function mount(tree: LayoutNode, overrides: Partial<SplitviewCallbacks> = {}): Mounted {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const onDrop = vi.fn();
  const onRatioChange = vi.fn();
  const cb = {
    onActivatePanel: () => {},
    onActivateTab: () => {},
    onCloseTab: () => {},
    onClosePanel: () => {},
    onRatioChange,
    onDropTabToPanel: onDrop,
    mountView: () => {},
    ...overrides,
  } as SplitviewCallbacks;
  const data = new Map<number, PanelRenderData>();
  eachLeaf(tree, (id) => data.set(id, { panelId: id, active: id === 1, tabs: [], canClose: true }));
  renderSplitview(root, tree, data, cb);
  return { root, cb, onDrop, onRatioChange };
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.className = "";
});

const H2: LayoutNode = { kind: "split", dir: "h", ratio: 0.7, a: leaf(1), b: leaf(2) };
const V2: LayoutNode = { kind: "split", dir: "v", ratio: 0.5, a: leaf(1), b: leaf(2) };

describe("zoneOf（B59 O6：边缘 28% 带 + 1/3 方向优先）", () => {
  it("两轴都在 28% 带以内 = center（移入/排序）", () => {
    expect(zoneOf(rect(), 200, 150)).toBe("center");
  });

  it("左右外侧 1/3 优先左右分屏", () => {
    expect(zoneOf(rect(), 20, 150)).toBe("left");
    expect(zoneOf(rect(), 380, 150)).toBe("right");
  });

  it("中 1/3 的上/下带才轮到上/下分屏", () => {
    expect(zoneOf(rect(), 200, 20)).toBe("top");
    expect(zoneOf(rect(), 200, 280)).toBe("bottom");
  });

  it("角部归左右（1/3 判定先于上下）—— 与旧实现一致，锁住契约", () => {
    expect(zoneOf(rect(), 100, 20)).toBe("left"); // rx=0.25 < 1/3
    expect(zoneOf(rect(), 300, 20)).toBe("right"); // rx=0.75 > 2/3
  });

  it("jsdom 无布局（宽高为 0）回 center，避免 NaN 落到意外分支", () => {
    expect(zoneOf(rect(0, 0, 0, 0), 0, 0)).toBe("center");
  });
});

describe("分隔条缩放（B59 O1/O2/O3/S1）", () => {
  it("O1 双击分隔条复位到 50% 并回写比例", () => {
    const { root, onRatioChange } = mount(H2);
    const sep = root.querySelector<HTMLElement>(".layout-sep")!;
    const aEl = root.querySelector<HTMLElement>(".layout-panel")!;
    expect(aEl.style.flexBasis).toBe("70%");

    sep.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    expect(aEl.style.flexBasis).toBe("50%");
    expect(onRatioChange).toHaveBeenCalledWith([], 0.5);
  });

  it("O3 垂直分隔条拖拽 → body 加 layout-dragging-v（上下分屏光标应为 row-resize）", () => {
    const { root } = mount(V2);
    const sep = root.querySelector<HTMLElement>(".layout-sep-v")!;
    sep.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(document.body.classList.contains("layout-dragging")).toBe(true);
    expect(document.body.classList.contains("layout-dragging-v")).toBe(true);
    expect(sep.classList.contains("resizing"), "S1 拖拽中保持高亮").toBe(true);

    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(document.body.classList.contains("layout-dragging")).toBe(false);
    expect(document.body.classList.contains("layout-dragging-v")).toBe(false);
    expect(sep.classList.contains("resizing")).toBe(false);
  });

  it("O3 水平分隔条拖拽不得加 layout-dragging-v（保持 col-resize）", () => {
    const { root } = mount(H2);
    const sep = root.querySelector<HTMLElement>(".layout-sep-h")!;
    sep.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(document.body.classList.contains("layout-dragging")).toBe(true);
    expect(document.body.classList.contains("layout-dragging-v")).toBe(false);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });

  it("O2 拖到 10%/90% 极限时给出手柄加 .at-min / .at-max", () => {
    const { root, onRatioChange } = mount(H2);
    const container = root.querySelector<HTMLElement>(".layout-split")!;
    container.getBoundingClientRect = () => rect(0, 0, 400, 300);
    const sep = root.querySelector<HTMLElement>(".layout-sep")!;

    sep.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 0, clientY: 0 }));
    expect(sep.classList.contains("at-min")).toBe(true);
    expect(sep.classList.contains("at-max")).toBe(false);

    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 400, clientY: 0 }),
    );
    expect(sep.classList.contains("at-min")).toBe(false);
    expect(sep.classList.contains("at-max")).toBe(true);

    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 400, clientY: 0 }));
    expect(onRatioChange).toHaveBeenCalledWith([], 0.9); // 收敛到上限
  });
});

describe("正交角手柄（B59 O7）", () => {
  // 左 | 右(上下)：右子树的根分隔条是横线，其左端贴中间竖线 → start 端手柄
  const TREE: LayoutNode = {
    kind: "split",
    dir: "h",
    ratio: 0.5,
    a: leaf(1),
    b: { kind: "split", dir: "v", ratio: 0.5, a: leaf(2), b: leaf(3) },
  };

  it("仅在相垂直的相接端生成角手柄，且挂在子分隔条上", () => {
    const { root } = mount(TREE);
    const corners = root.querySelectorAll<HTMLElement>(".layout-corner");
    expect(corners.length, "只有一处 T 型相接").toBe(1);
    const c = corners[0];
    expect(c.parentElement?.classList.contains("layout-sep-v"), "挂在横线上").toBe(true);
    expect(c.classList.contains("start"), "右子树的分隔条首端贴父").toBe(true);
  });

  it("左子树的相接端是 end（镜像）", () => {
    const mirrored: LayoutNode = {
      kind: "split",
      dir: "h",
      ratio: 0.5,
      a: { kind: "split", dir: "v", ratio: 0.5, a: leaf(2), b: leaf(3) },
      b: leaf(1),
    };
    const { root } = mount(mirrored);
    const c = root.querySelector<HTMLElement>(".layout-corner")!;
    expect(c.classList.contains("end")).toBe(true);
    expect(c.parentElement?.classList.contains("layout-sep-v")).toBe(true);
  });

  it("同向嵌套（两条竖线）不生成角手柄", () => {
    const sameDir: LayoutNode = {
      kind: "split",
      dir: "h",
      ratio: 0.5,
      a: leaf(1),
      b: { kind: "split", dir: "h", ratio: 0.5, a: leaf(2), b: leaf(3) },
    };
    const { root } = mount(sameDir);
    expect(root.querySelectorAll(".layout-corner").length).toBe(0);
  });

  it("斜向拖角手柄 = 同时改父（x 轴）与子（y 轴）两条比例", () => {
    const { root, onRatioChange } = mount(TREE);
    const containers = root.querySelectorAll<HTMLElement>(".layout-split");
    const rootContainer = containers[0];
    const childContainer = containers[1];
    rootContainer.getBoundingClientRect = () => rect(0, 0, 400, 300);
    childContainer.getBoundingClientRect = () => rect(200, 0, 200, 300);

    const corner = root.querySelector<HTMLElement>(".layout-corner")!;
    corner.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(document.body.classList.contains("layout-dragging-corner")).toBe(true);
    // 角手柄是分隔条的子元素：mousedown 必须被 stopPropagation 截住，
    // 否则父分隔条也会同时开一次拖拽（重复监听 + 重复 commit）。
    const parentSep = corner.parentElement as HTMLElement;
    expect(parentSep.classList.contains("resizing"), "父分隔条不得被连带激活").toBe(false);
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 300, clientY: 150 }),
    );
    document.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, clientX: 300, clientY: 150 }),
    );

    // 父：x=300/400 → 0.75；子：y=150/300 → 0.5（子容器 rect 的 top=0, height=300）
    expect(onRatioChange).toHaveBeenCalledWith([], 0.75);
    expect(onRatioChange).toHaveBeenCalledWith([1], 0.5);
    expect(document.body.classList.contains("layout-dragging-corner")).toBe(false);
  });
});

describe("拖拽落点 Alt（B59 O5）", () => {
  function dragTo(x: number, y: number, altKey: boolean): Mounted {
    const m = mount(leaf(1));
    const panel = m.root.querySelector<HTMLElement>(".layout-panel")!;
    const strip = m.root.querySelector<HTMLElement>(".panel-tabstrip")!;
    panel.getBoundingClientRect = () => rect(0, 0, 400, 300);
    strip.getBoundingClientRect = () => rect(0, 0, 400, 28); // 顶部 28px 是标签栏
    const start = new MouseEvent("mousedown", { bubbles: true, clientX: 10, clientY: 150 });
    beginTabDrag(7, start);
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y, altKey }),
    );
    document.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y, altKey }),
    );
    return m;
  }

  it("落左边缘 → left（分屏）", () => {
    const { onDrop } = dragTo(10, 160, false);
    expect(onDrop).toHaveBeenCalledWith(7, 1, "left", null, false);
  });

  it("按住 Alt 落同一位置 → center（临时取消分屏）", () => {
    const { onDrop } = dragTo(10, 160, true);
    expect(onDrop).toHaveBeenCalledWith(7, 1, "center", null, false);
  });
});

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

describe("对齐联动（B60：对标 VS Code 2x2 的 linkedSash）", () => {
  // 2x2：上下两行，每行左右两栏 → 两条**竖**分隔条在同一 x 上
  const GRID: LayoutNode = {
    kind: "split",
    dir: "v",
    ratio: 0.5,
    a: { kind: "split", dir: "h", ratio: 0.5, a: leaf(1), b: leaf(2) },
    b: { kind: "split", dir: "h", ratio: 0.5, a: leaf(3), b: leaf(4) },
  };

  function stub(el: HTMLElement, r: DOMRect): void {
    el.getBoundingClientRect = () => r;
  }

  /** 上下两行容器 + 两条竖分隔条；secondX = null 表示第二条错开（不联动） */
  function mountGrid(secondX: number | null = 200) {
    const m = mount(GRID);
    // 只取两个「行容器」（.layout-h）；外层 .layout-v 是它们的父，排在文档序最前
    const [top, bottom] = Array.from(
      m.root.querySelectorAll<HTMLElement>(".layout-split.layout-h"),
    ) as [HTMLElement, HTMLElement];
    stub(top, rect(0, 0, 400, 150));
    stub(bottom, rect(0, 150, 400, 150));
    const [sep1, sep2] = Array.from(
      m.root.querySelectorAll<HTMLElement>(".layout-sep-h"),
    ) as HTMLElement[];
    // ⚠️ 桩必须**忠实于 B60 的真实几何**：分隔条是不占布局的浮层，**主轴尺寸为 0**
    // （宽 0），只有交叉轴（高）是 stretch 出来的满长 —— 界线位置就是 r.left。
    // 早先把这里桩成 4px 宽（= B60 之前的几何），正好掩盖了
    // 「centerOf 按主轴判空 → 恒 null → 联动从未生效」这个真机 bug。
    stub(sep1, rect(200, 0, 0, 150)); // 竖线：宽 0、高 150 → 界线 x=200
    stub(sep2, rect(secondX ?? 200, 150, 0, 150));
    return { ...m, sep1, sep2 };
  }

  it("分隔条主轴尺寸为 0（B60 不占布局）也必须能判定对齐", () => {
    // 「联动不生效」的回归用例：判空只能看**交叉轴**。
    // 若改回按主轴判空（len > 0），links 恒为空，本用例立刻失败。
    const { sep1, sep2 } = mountGrid();
    for (const sep of [sep1, sep2]) {
      const r = sep.getBoundingClientRect();
      expect(r.width, "竖线的主轴（宽）必须是 0").toBe(0);
      expect(r.height, "交叉轴（高）必须有跨度，才说明真的摆了盘").toBeGreaterThan(0);
    }
    sep1.dispatchEvent(new MouseEvent("mouseenter"));
    expect(sep2.classList.contains("linked"), "主轴为 0 也要认得出对齐").toBe(true);
  });

  it("完全没有布局（交叉轴也为 0）时不得联动 —— 否则全部零值会被当成「都在 0 点」", () => {
    const m = mount(GRID); // 不桩任何 rect：jsdom 下全是 0
    const [sep1, sep2] = Array.from(
      m.root.querySelectorAll<HTMLElement>(".layout-sep-h"),
    ) as HTMLElement[];
    sep1.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(sep2.classList.contains("resizing")).toBe(false);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });

  it("两条竖线位置一致 → 拖一条，另一条跟着走并各自回写比例", () => {
    const { root, sep1, sep2, onRatioChange } = mountGrid();
    sep1.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(sep2.classList.contains("resizing"), "联动的那条也要高亮").toBe(true);

    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 300, clientY: 0 }),
    );
    const panels = Array.from(root.querySelectorAll<HTMLElement>(".layout-panel"));
    expect(panels[0].style.flexBasis, "上行左栏跟到 75%").toBe("75%");
    expect(panels[2].style.flexBasis, "下行左栏同步跟到 75%").toBe("75%");

    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 300, clientY: 0 }));
    expect(onRatioChange).toHaveBeenCalledWith([0], 0.75);
    expect(onRatioChange).toHaveBeenCalledWith([1], 0.75);
    expect(sep2.classList.contains("resizing"), "松手后清高亮").toBe(false);
  });

  it("位置错开（中线差 > 2px）的两条不联动", () => {
    const { root, sep1, onRatioChange } = mountGrid(300);
    sep1.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 300, clientY: 0 }),
    );
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 300, clientY: 0 }));

    const panels = Array.from(root.querySelectorAll<HTMLElement>(".layout-panel"));
    expect(panels[0].style.flexBasis).toBe("75%");
    expect(panels[2].style.flexBasis, "错开的一条保持原比例").toBe("50%");
    expect(onRatioChange).toHaveBeenCalledWith([0], 0.75);
    for (const call of onRatioChange.mock.calls) {
      expect(call[0], "不得回写错开分隔条的路径").not.toEqual([1]);
    }
  });

  it("悬停一条 → 对齐的另一条也高亮（.linked），移开即撤", () => {
    const { sep1, sep2 } = mountGrid();
    sep1.dispatchEvent(new MouseEvent("mouseenter"));
    expect(sep2.classList.contains("linked")).toBe(true);
    sep1.dispatchEvent(new MouseEvent("mouseleave"));
    expect(sep2.classList.contains("linked")).toBe(false);
  });

  it("双击复位联动（对标 sash.ts:622 —— onDidReset 转发给 linkedSash）", () => {
    const { sep1, onRatioChange } = mountGrid();
    sep1.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(onRatioChange).toHaveBeenCalledWith([0], 0.5);
    expect(onRatioChange).toHaveBeenCalledWith([1], 0.5);
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

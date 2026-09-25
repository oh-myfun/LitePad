// @vitest-environment jsdom
// B59：分屏操作与样式对齐 VS Code —— 分隔条双击复位 / 极限光标 / 方向光标 /
// 正交角手柄 / 落点 1/3 方向优先 / Alt 临时取消分屏。
// 参考源码见 docs/vscode-reference/（sash.ts/css、splitview.css、editorDropTarget.ts）。
import { describe, expect, it, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { themeBlock } from "./static";

// B91-2：标签拖拽走 HTML5 DnD，影像交给 `dataTransfer.setDragImage` 由系统绘制。
// 本文件要验「tabstrip 确实造了影像并交给了系统」，因此需要一个装着传输层的环境；
// 事件通道给个空壳即可（jsdom 里没有 Tauri，真 `listen` 会抛）。
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: () => Promise.resolve(),
  listen: () => Promise.resolve(() => {}),
}));

import {
  commitTabDrop,
  renderSplitview,
  zoneOf,
  type PanelRenderData,
  type SplitviewCallbacks,
} from "../src/shell/splitview";
import { eachLeaf, leaf, type LayoutNode } from "../src/shell/layout";
import { renderTabstrip } from "../src/shell/tabstrip";
import { installTabDnd } from "../src/shell/tabdnd";
import { fireDrag, makeDataTransfer } from "./dnd";

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

  it("O3 垂直分隔条拖拽 → body 加 layout-dragging-v（上下分屏光标应为 ns-resize）", () => {
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

  it("O3 水平分隔条拖拽不得加 layout-dragging-v（保持 ew-resize）", () => {
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
    // B63：角手柄挂在子分隔条上，拖它两条轴上的线**都要动** → 两条都要高亮。
    // （B59 只把角手柄自己标成拖拽态，用户看不出「这两条会一起走」。）
    const childSep = corner.parentElement as HTMLElement;
    expect(childSep.classList.contains("resizing"), "子轴的线也要高亮").toBe(true);
    expect(
      root.querySelector<HTMLElement>(".layout-sep-h")!.classList.contains("resizing"),
      "父轴的线也要高亮",
    ).toBe(true);
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 300, clientY: 150 }),
    );
    document.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, clientX: 300, clientY: 150 }),
    );

    // 父：x=300/400 → 0.75；子：y=150/300 → 0.5（子容器 rect 的 top=0, height=300）
    expect(onRatioChange).toHaveBeenCalledWith([], 0.75);
    expect(onRatioChange).toHaveBeenCalledWith([1], 0.5);
    // ⚠️ 角手柄是分隔条的子元素，mousedown 必须被 stopPropagation 截住，
    // 否则子分隔条会**再开一次拖拽**（重复监听 + 重复 commit）。
    // B63 起不能再用「子分隔条有没有 resizing」当判据（它现在**本该**高亮），
    // 改为数回写次数：一次斜拖恰好 2 条（父 + 子），多一条就说明注册了两次。
    expect(onRatioChange, "恰好回写 2 条，不得重复注册").toHaveBeenCalledTimes(2);
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

  // 两行都停在 30% —— 仍算对齐（界线都在 x=120），用来验证「双击一起居中」
  const GRID_30: LayoutNode = {
    kind: "split",
    dir: "v",
    ratio: 0.5,
    a: { kind: "split", dir: "h", ratio: 0.3, a: leaf(1), b: leaf(2) },
    b: { kind: "split", dir: "h", ratio: 0.3, a: leaf(3), b: leaf(4) },
  };

  function stub(el: HTMLElement, r: DOMRect): void {
    el.getBoundingClientRect = () => r;
  }

  /**
   * 竖分隔条的 rect **随左栏的 inline flexBasis 实时变化** —— 忠实于浏览器。
   *
   * ⚠️ 这一步是必须的：早先的桩返回**常量** rect，于是「先 applyTarget(self, 50)
   * 再求联动集合」这种次序 bug 完全不会暴露（常量几何永远认为两条仍对齐）。
   * 而真机上 getBoundingClientRect 会立刻反映刚写下的 inline 样式。
   */
  function stubVerticalSash(sep: HTMLElement, box: DOMRect): void {
    sep.getBoundingClientRect = () => {
      const a = sep.previousElementSibling as HTMLElement;
      const pct = Number.parseFloat(a.style.flexBasis) || 0;
      return rect(box.left + (box.width * pct) / 100, box.top, 0, box.height);
    };
  }

  /** 上下两行容器 + 两条竖分隔条；secondOffset 非 0 时把第二条错开（不联动） */
  function mountGrid(secondOffset = 0, tree: LayoutNode = GRID) {
    const m = mount(tree);
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
    stubVerticalSash(sep1, rect(0, 0, 400, 150));
    stubVerticalSash(sep2, rect(0, 150, 400, 150));
    if (secondOffset !== 0) {
      // 强行给第二条加偏移（模拟两条本来就没对齐）
      const [p3] = Array.from(m.root.querySelectorAll<HTMLElement>(".layout-panel")).slice(2);
      const pct = (Number.parseFloat(p3.style.flexBasis) || 0) + (secondOffset / 400) * 100;
      p3.style.flexBasis = `${pct}%`;
    }
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

  it("位置错开（界线差 > 2px）的两条不联动", () => {
    const { root, sep1, onRatioChange } = mountGrid(20);
    const panels = Array.from(root.querySelectorAll<HTMLElement>(".layout-panel"));
    const before = panels[2].style.flexBasis;
    expect(before, "前置：下行左栏与上行错开 20px").toBe("55%");

    sep1.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 300, clientY: 0 }),
    );
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 300, clientY: 0 }));

    expect(panels[0].style.flexBasis).toBe("75%");
    expect(panels[2].style.flexBasis, "错开的一条保持原比例").toBe(before);
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

  it("双击任意一条 → 联动的两条**一起**居中（联动集合必须先于改比例求出）", () => {
    // B62 用户反馈：「分割条联动时双击任意一条，所有的都应该居中」。
    // 真机 bug：老代码先 `applyTarget(self, 50)` 再调 `alignedSashesOf`，
    // 而后者读的是**实时几何** —— 本条已经挪到中间、联动条还停在 30%，
    // 两者差了 80px ≫ ALIGN_TOL，集合为空 → 只有点中的那条居中。
    // 两行都在 30%（= 界线 x=120），仍算对齐，所以能触发联动。
    const { root, sep1, onRatioChange } = mountGrid(0, GRID_30);
    const panels = Array.from(root.querySelectorAll<HTMLElement>(".layout-panel"));
    expect(panels[0].style.flexBasis, "前置：上行左栏 30%").toBe("30%");
    expect(panels[2].style.flexBasis, "前置：下行左栏 30%（两条对齐）").toBe("30%");

    sep1.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    expect(panels[0].style.flexBasis, "点中的那条居中").toBe("50%");
    expect(panels[2].style.flexBasis, "联动的另一条也必须居中").toBe("50%");
    expect(onRatioChange).toHaveBeenCalledWith([0], 0.5);
    expect(onRatioChange).toHaveBeenCalledWith([1], 0.5);
  });

  it("纯点击（全程无 mousemove）不得回写比例 —— 否则点一下就把对齐推歪", () => {
    // 命中区有 7px 宽，指针常落在离界线几个像素处；若点击也回写，
    // 一次点击就能把两条对齐的线推到 2px 容差之外 → 之后拖谁都不再联动。
    const { sep1, onRatioChange } = mountGrid();
    sep1.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 204, clientY: 0 }));

    expect(onRatioChange, "没拖动就不该有任何回写").not.toHaveBeenCalled();
    expect(document.body.classList.contains("layout-dragging"), "拖拽态要正常清掉").toBe(false);
    expect(sep1.classList.contains("resizing")).toBe(false);
  });

  it("B63 在交叉点（角手柄）拖动 → 双轴各自的联动组都要高亮并一起走", () => {
    // 用户要求：「在交叉点拖动时，也要支持联动（高亮和一起拖动）」。
    // 角手柄有 2 个目标、轴互相垂直 → 移动组 = x 轴的线 + 它的联动伙伴 + y 轴的线。
    // 本用例：2x2 网格，两行的竖线都停在 50%（对齐）。
    const m = mountGrid();
    // 根容器（上下分屏）也要桩上，交叉点拖动会用它的 rect 换算 x 轴比例
    stub(m.root.querySelector<HTMLElement>(".layout-split.layout-v")!, rect(0, 0, 400, 300));

    const corners = Array.from(m.root.querySelectorAll<HTMLElement>(".layout-corner"));
    expect(corners.length, "两行各有一个相接端").toBe(2);
    // 上行的相接端在其竖线的下端 → end；下行的在上端 → start
    expect(corners[0].classList.contains("end"), "上行角手柄贴在下端").toBe(true);
    expect(corners[1].classList.contains("start"), "下行角手柄贴在上端").toBe(true);

    corners[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(m.sep1.classList.contains("resizing"), "x 轴本线高亮").toBe(true);
    expect(m.sep2.classList.contains("resizing"), "x 轴的联动伙伴也要高亮").toBe(true);
    expect(
      m.root.querySelector<HTMLElement>(".layout-sep-v")!.classList.contains("resizing"),
      "y 轴那条线也要高亮",
    ).toBe(true);

    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 300, clientY: 150 }),
    );
    const panels = Array.from(m.root.querySelectorAll<HTMLElement>(".layout-panel"));
    expect(panels[0].style.flexBasis, "上行左栏跟到 75%").toBe("75%");
    expect(panels[2].style.flexBasis, "下行左栏也跟到 75%（同轴联动）").toBe("75%");

    document.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, clientX: 300, clientY: 150 }),
    );
    expect(m.onRatioChange).toHaveBeenCalledWith([0], 0.75);
    expect(m.onRatioChange).toHaveBeenCalledWith([1], 0.75);
    expect(m.onRatioChange).toHaveBeenCalledWith([], 0.5); // y 轴：150/300
    const hSep = m.root.querySelector<HTMLElement>(".layout-sep-v")!;
    for (const sep of [m.sep1, m.sep2, hSep]) {
      expect(sep.classList.contains("resizing"), "松手后全部清高亮").toBe(false);
    }
  });

  it("B63 交叉点悬停即预告：两条轴上的联动组一起亮", () => {
    const m = mountGrid();
    stub(m.root.querySelector<HTMLElement>(".layout-split.layout-v")!, rect(0, 0, 400, 300));
    const corner = m.root.querySelector<HTMLElement>(".layout-corner")!;
    corner.dispatchEvent(new MouseEvent("mouseenter"));
    expect(m.sep1.classList.contains("linked"), "x 轴本线").toBe(true);
    expect(m.sep2.classList.contains("linked"), "x 轴的联动伙伴").toBe(true);
    expect(
      m.root.querySelector<HTMLElement>(".layout-sep-v")!.classList.contains("linked"),
      "y 轴那条线也要预告",
    ).toBe(true);
    corner.dispatchEvent(new MouseEvent("mouseleave"));
    expect(m.sep1.classList.contains("linked")).toBe(false);
    expect(m.root.querySelector<HTMLElement>(".layout-sep-v")!.classList.contains("linked")).toBe(
      false,
    );
  });
});

describe("B63 双击按分割数量均分（不是一律 50%）", () => {
  const chain3: LayoutNode = {
    kind: "split",
    dir: "h",
    ratio: 0.7,
    a: leaf(1),
    b: { kind: "split", dir: "h", ratio: 0.3, a: leaf(2), b: leaf(3) },
  };
  const chain4: LayoutNode = {
    kind: "split",
    dir: "h",
    ratio: 0.7,
    a: leaf(1),
    b: {
      kind: "split",
      dir: "h",
      ratio: 0.5,
      a: leaf(2),
      b: { kind: "split", dir: "h", ratio: 0.4, a: leaf(3), b: leaf(4) },
    },
  };

  /** 每条分隔条两侧的**同轴段数**相等 —— 即「按分割数量均分」。 */
  function expectEven(root: HTMLElement, count: number): void {
    const panels = Array.from(root.querySelectorAll<HTMLElement>(".layout-panel"));
    expect(panels.length).toBe(count);
    // 面板的 flexBasis 是相对**各自父容器**的，逐层累乘才是占整条轴的比例：
    // 只要「本元素」的父是分屏容器，就把本元素的 flexBasis 乘进去，然后上移一层。
    const share = panels.map((p) => {
      let v = 1;
      let el: HTMLElement | null = p;
      while (el && el !== root) {
        const parent: HTMLElement | null = el.parentElement;
        if (!parent) break;
        if (parent.classList.contains("layout-split")) {
          v *= (Number.parseFloat(el.style.flexBasis) || 0) / 100;
        }
        el = parent;
      }
      return v * 100;
    });
    for (const s of share) expect(s).toBeCloseTo(100 / count, 5);
  }

  it("三栏：双击任意一条 → 三条等分（1/3），不是「本条 50%」", () => {
    // 老行为（B62）：双击哪条，哪条 + 联动条一起回 50% —— 三栏时仍然是一大两小。
    const { root, onRatioChange } = mount(chain3);
    const seps = Array.from(root.querySelectorAll<HTMLElement>(".layout-sep"));
    expect(seps.length).toBe(2);

    seps[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expectEven(root, 3);
    expect(onRatioChange).toHaveBeenCalledWith([], 1 / 3);
    expect(onRatioChange).toHaveBeenCalledWith([1], 0.5);

    // 换点第二条，结果必须完全一致（「对应的所有分割线一起调整」）
    onRatioChange.mockClear();
    // 先打乱，确认不是「碰巧本来就是等分」
    seps[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 5, clientY: 0 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 5, clientY: 0 }));
    seps[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expectEven(root, 3);
    expect(onRatioChange).toHaveBeenCalledWith([], 1 / 3);
    expect(onRatioChange).toHaveBeenCalledWith([1], 0.5);
  });

  it("四栏：双击任意一条 → 四条等分（1/4），整链逐级收敛", () => {
    const { root, onRatioChange } = mount(chain4);
    const seps = Array.from(root.querySelectorAll<HTMLElement>(".layout-sep"));
    expect(seps.length).toBe(3);

    seps[2].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expectEven(root, 4);
    expect(onRatioChange).toHaveBeenCalledWith([], 1 / 4);
    expect(onRatioChange).toHaveBeenCalledWith([1], 1 / 3);
    expect(onRatioChange).toHaveBeenCalledWith([1, 1], 0.5);
  });

  it("不同向的嵌套各自成链：双击横线不得动到竖线", () => {
    // 左 | 右(上下)：横向那条（x 轴）与纵向那条（y 轴）不是同一条链。
    const tree: LayoutNode = {
      kind: "split",
      dir: "h",
      ratio: 0.4,
      a: leaf(1),
      b: { kind: "split", dir: "v", ratio: 0.3, a: leaf(2), b: leaf(3) },
    };
    const { root, onRatioChange } = mount(tree);
    const childSep = root.querySelector<HTMLElement>(".layout-sep-v")!;
    childSep.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    // 纵向两条各占一半 → 50%；横向那条（40%）纹丝不动
    expect(onRatioChange).toHaveBeenCalledWith([1], 0.5);
    for (const call of onRatioChange.mock.calls) {
      expect(call[0], "不得动到另一条链").not.toEqual([]);
    }
    expect(root.querySelector<HTMLElement>(".layout-panel")!.style.flexBasis).toBe("40%");
  });
});

describe("拖拽落点 Alt（B59 O5）", () => {
  function dragTo(x: number, y: number, altKey: boolean): Mounted {
    const m = mount(leaf(1));
    const panel = m.root.querySelector<HTMLElement>(".layout-panel")!;
    const strip = m.root.querySelector<HTMLElement>(".panel-tabstrip")!;
    panel.getBoundingClientRect = () => rect(0, 0, 400, 300);
    strip.getBoundingClientRect = () => rect(0, 0, 400, 28); // 顶部 28px 是标签栏
    // B91-2：落点提交走 `commitTabDrop` —— HTML5 drop 处理器调的就是它，
    // 因此这条用例测的仍是「松手落到哪儿 → 走哪个回调」这层语义。
    commitTabDrop({
      payload: { v: 1, from: "main", tabId: 7, groupPanelId: null, count: 1, dragId: "d1" },
      x,
      y,
      altKey,
      ctrlKey: false,
    });
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

describe("B64/B91-2 拖拽影像：造出来交给系统绘制", () => {
  // 用户反馈（B64）：「标签拖动时，要像 vscode 那样有一个 tab 随光标移动的效果。」
  // 出处 `multiEditorTabsControl.ts:1295`：拖单个标签且 tabSizing 非 shrink 时
  //   e.dataTransfer.setDragImage(tab, 0, 0);  // 被拖标签的左上角放到光标处
  //
  // B91-2 起了本质变化：影像不再是我们自己在页面里跟着光标摆的一个浮层，而是交给
  // `setDragImage` 由**系统**绘制 —— 于是它能跟出窗口、压在别的应用上（用户诉求）。
  // 所以这里锁的不再是「left/top 有没有跟着 clientX/clientY」，而是：
  //   · 影像本体克隆得全不全、该剥的有没有剥；
  //   · 有没有**真的交给系统**（setDragImage 的入参与锚点）；
  //   · 拍快照那一刻是不是「挂着 + 离屏」（拍空图的写法都要躲开），以及**推一帧再摘**
  //     （同步摘会让系统拍不到图 —— 用户报过「拖标签完全没有影像」）。
  // 用例走**真实 tabstrip 渲染 + 真实 dragstart**，顺带验证 tabstrip 确实造了影像并
  // 交给了传输层（只测传输层的入参会漏掉这层接线）。

  let uninstall: (() => void) | null = null;
  beforeEach(async () => {
    // 上一个用例的接收侧先拆掉，免得 document 上的监听叠加（文件末尾那一份无需回收：
    // vitest 每个测试文件各有一份 jsdom，不会漏到别的文件）。
    uninstall?.();
    uninstall = await installTabDnd({
      selfLabel: "main",
      preview: () => null,
      clear: () => {},
      commitLocal: () => true,
      snapshot: () => null,
      relinquish: () => {},
      adopt: () => false,
      onFallback: () => {},
    });
  });

  /** 渲染一个真标签栏，返回第一个标签元素。 */
  function mountStrip(): HTMLElement {
    const host = document.createElement("div");
    host.className = "panel-tabstrip";
    document.body.appendChild(host);
    renderTabstrip(
      host,
      [
        {
          tabId: 11,
          name: "README.md",
          dirty: false,
          readonly: false,
          active: true,
          lang: "Markdown",
        },
        {
          tabId: 12,
          name: "main.ts",
          dirty: true,
          readonly: false,
          active: false,
          lang: "TypeScript",
        },
      ],
      { onActivate: () => {}, onClose: () => {} },
    );
    return host.querySelectorAll<HTMLElement>(".tab")[0];
  }

  /** 起一次拖拽，返回交给系统的影像（`setDragImage` 的第一个入参）。 */
  function dragImageOf(tab: HTMLElement): HTMLElement {
    const dt = makeDataTransfer();
    fireDrag("dragstart", tab, dt);
    expect(dt.images.length, "必须把影像交给系统").toBe(1);
    return dt.images[0].el as HTMLElement;
  }

  it("影像是原标签的克隆：文件名 / 类型图标 / 活动态一并带过来", () => {
    const tab = mountStrip();
    const image = dragImageOf(tab);
    expect(image.getAttribute("aria-hidden"), "影像不该进可访问树").toBe("true");
    const copy = image.querySelector<HTMLElement>(".tab")!;
    expect(copy, "影像里必须有一个标签副本").not.toBeNull();
    expect(copy.querySelector(".tab-name")!.textContent, "文件名照搬").toBe("README.md");
    expect(copy.querySelector<HTMLElement>(".tab-icon")!.dataset.fam, "类型图标照搬").toBe("md");
    expect(copy.classList.contains("tab-active"), "活动态配色照搬").toBe(true);
    // 副本必须与真标签可区分：留着 tabId 会让「按 tabId 查元素」的逻辑命中副本
    expect(copy.dataset.tabId, "副本不得保留 tabId").toBeUndefined();
    expect(tab.dataset.tabId, "原标签原地不动（影像期间它是参照物）").toBe("11");
    expect(copy.querySelectorAll("button[tabindex='-1']").length, "副本里的按钮不可聚焦").toBe(1);
    expect(copy.querySelectorAll("[data-tip]").length, "副本不该带提示接线").toBe(0);
  });

  it("B65/B66 影像克隆的是「未保存 + 当前」标签：副本里 ● 与 × 都在，显示只能靠 CSS", () => {
    // 影像里的标签永不 :hover，所以「悬停时把 ● 压回 0」那种单点补丁在影像里完全
    // 失效。B66 起判据是「关闭区未命中 → ●」，副本既然永远命中不了关闭区，
    // 拖动未保存标签时影像就稳定显示 ●（静息态）。
    // 这条用例锁的是前提：两个 glyph 与两个状态类都在副本里。
    const host = document.createElement("div");
    host.className = "panel-tabstrip";
    document.body.appendChild(host);
    renderTabstrip(
      host,
      [
        {
          tabId: 31,
          name: "editor.ts",
          dirty: true,
          readonly: false,
          active: true,
          lang: "TypeScript",
        },
      ],
      { onActivate: () => {}, onClose: () => {} },
    );
    const tab = host.querySelector<HTMLElement>(".tab")!;
    const copy = dragImageOf(tab).querySelector<HTMLElement>(".tab")!;
    expect(copy.classList.contains("tab-dirty"), "副本带未保存态（● 的判据靠它）").toBe(true);
    expect(
      copy.classList.contains("tab-active"),
      "副本带活动态（配色照搬；B66 起活动态不再给脏标签点亮 ×）",
    ).toBe(true);
    expect(copy.querySelector(".tab-action .tab-mark"), "● 在副本里照样常驻 DOM").toBeTruthy();
    expect(copy.querySelector(".tab-action .tab-close"), "× 在副本里照样常驻 DOM").toBeTruthy();
  });

  it("锚点是左上角（= setDragImage(tab, 0, 0) 的语义，给落点边框让位）", () => {
    const dt = makeDataTransfer();
    fireDrag("dragstart", mountStrip(), dt);
    expect(dt.images[0]).toMatchObject({ x: 0, y: 0 });
  });

  it("拍快照那一刻影像「挂着 + 离屏」，**推一帧再摘**（同步摘会让系统拍不到图）", async () => {
    // ⚠️ 三个坑，各踩一次就废：
    //    · detached 或 display:none 的元素渲染不出来 → Chromium 拍出一张**空图**；
    //    · **同步 remove()** → 快照时元素已 detached → 系统拿不到图（用户报「拖标签
    //      完全没有影像」），所以摘除必须推到下一轮宏任务；
    //    · 不摘 → 拖拽期间跟系统画的那一份叠成两层。
    const dt = makeDataTransfer();
    fireDrag("dragstart", mountStrip(), dt);
    expect(dt.images[0].inDom, "必须在文档里").toBe(true);
    expect(dt.images[0].offscreen, "而且要离屏摆（可见，只是不在屏内）").toBe(true);
    expect(document.querySelector(".tab-drag-ghost"), "快照当刻绝不能提前摘").not.toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector(".tab-drag-ghost"), "快照拍完就摘，不留浮层").toBeNull();
  });

  it("拖拽期间 body 带标记，dragend 收掉（CSS 据此禁文本选区）", async () => {
    const dt = makeDataTransfer();
    fireDrag("dragstart", mountStrip(), dt);
    expect(document.body.classList.contains("tab-drag-active")).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector(".tab-drag-ghost"), "影像只活一帧，之后不留浮层").toBeNull();
    fireDrag("dragend", document, dt);
    expect(document.body.classList.contains("tab-drag-active")).toBe(false);
    expect(document.querySelector(".tab-drag-ghost"), "收尾后照样没有浮层").toBeNull();
  });

  it("两次拖拽各拍各的影像，不留残影（不再有「上一次的浮层没收掉」这种失败模式）", async () => {
    const tab = mountStrip();
    dragImageOf(tab);
    const dt2 = makeDataTransfer();
    fireDrag("dragstart", tab, dt2);
    expect(dt2.images.length, "第二次照样把影像交给系统").toBe(1);
    // 起手时会先把上一轮的残影清掉，所以页面上任何时刻最多只有一张影像
    expect(
      document.querySelectorAll(".tab-drag-ghost").length,
      "不跟上一轮叠层",
    ).toBeLessThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelectorAll(".tab-drag-ghost").length, "拍完都不留").toBe(0);
  });
});

describe("分屏 / 分隔条静态契约（从 regressions 拆出）", () => {
  it("B28 大纲分隔条必须与分屏分割条同款（细线 + 宽命中区 + hover accent，无双线）", () => {
    // 用户要求：大纲区分隔条样式与面板分割条保持一致。
    // 旧样式是 4px 透明细条，与 .layout-sep 不统一；
    // 且 .toc-panel 自带 border-right 会与分隔条叠成双线。
    // B53 起两者统一升级为「透明命中区 + ::after 细线」——改一处必须改另一处。
    const previewCss = readFileSync("src/styles/preview.css", "utf-8");
    const resizer = previewCss.match(/\.toc-resizer\s*\{[^}]*\}/)?.[0] ?? "";
    expect(resizer, "应有 .toc-resizer 规则块").toBeTruthy();
    const globalCss = readFileSync("src/styles/global.css", "utf-8");
    const sep = globalCss.match(/\.layout-sep\s*\{[^}]*\}/)?.[0] ?? "";
    expect(sep, "分屏分割条基准样式应存在").toBeTruthy();

    // B60：两条分隔条都改为**不占布局**（flex 基准 0），命中区改由 ::before 向两侧溢出。
    // 原先 7px 的透明占位会把两侧内容撑开、中间露出祖先底色 —— 用户看到的就是「粗带」。
    expect(resizer, "大纲分隔条不得占布局宽度").toMatch(/flex:\s*0 0 0/);
    expect(sep, "分屏分隔条不得占布局宽度").toMatch(/flex:\s*0 0 0/);

    // 命中区宽度必须一致（B53 起的「细线 + 宽命中区」约定；宽度从元素搬到 ::before）
    const hitResizer = previewCss.match(/\.toc-resizer::before\s*\{[^}]*width:\s*(\d+)px/)?.[1];
    const hitSep = globalCss.match(/\.layout-sep-h::before\s*\{[^}]*width:\s*(\d+)px/)?.[1];
    expect(hitResizer, "大纲分隔条命中区宽度必须显式给出").toBeTruthy();
    expect(hitResizer, "大纲与分屏分隔条命中区宽度必须一致").toBe(hitSep);
    const line = previewCss.match(/\.toc-resizer::after\s*\{[^}]*\}/)?.[0] ?? "";
    expect(line, "大纲分隔条细线必须由伪元素画").toContain("background: var(--sep-line)");
    // 分屏分隔条：颜色在共享的 .layout-sep::after，几何按方向类定位
    // （B59 S5：线色从通用 --border 抽成 --sep-line；B122 起分屏侧静息透明 ——
    //   面板本身是带边框的圆角卡片，相邻卡片边框即分界，静息再画线就是三线叠粗；
    //   --sep-line 只剩大纲分隔条（.toc-resizer）沿用）
    const sepLine = globalCss.match(/\.layout-sep::after\s*\{[^}]*\}/)?.[0] ?? "";
    expect(sepLine, "分屏分隔条静息必须透明（B122 卡片边框替代细线）").toContain(
      "background: transparent",
    );
    expect(globalCss, "横向分隔条的细线几何").toMatch(/\.layout-sep-h::after\s*\{/);
    expect(globalCss, "纵向分隔条的细线几何").toMatch(/\.layout-sep-v::after\s*\{/);

    const highlight =
      previewCss.match(
        /\.toc-resizer:hover::after,\s*body\.layout-dragging \.toc-resizer::after\s*\{[^}]*\}/,
      )?.[0] ?? "";
    expect(highlight, "悬停/拖拽高亮必须是 accent（允许带回退值）").toMatch(/var\(--accent[,)]/);

    const panel = previewCss.match(/\.toc-panel\s*\{[^}]*\}/)?.[0] ?? "";
    expect(panel, ".toc-panel 不得自带 border-right（与分隔条叠成双线）").not.toContain(
      "border-right",
    );
  });
  it("B59 分屏对齐 VS Code：复位/极限光标/方向光标/角手柄/落点高亮（静态契约）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const previewCss = readFileSync("src/styles/preview.css", "utf-8");
    const sv = readFileSync("src/shell/splitview.ts", "utf-8");

    // S1 拖拽中必须与 hover 同色（只写 :hover 时鼠标滑出 7px 细线就失色）
    const sepHL = css.match(/\.layout-sep:hover::after,[\s\S]{0,80}?\{[^}]*\}/)?.[0] ?? "";
    expect(sepHL, "拖拽中要加 .resizing 并保持高亮").toMatch(/\.layout-sep\.resizing::after/);
    expect(sepHL, "高亮色为 accent").toMatch(/var\(--accent/);

    // O2 极限光标（对标 sash.css 的 .minimum/.maximum）
    expect(css, "水平分隔条到极限的光标").toMatch(/\.layout-sep-h\.at-min\s*\{[^}]*e-resize/);
    expect(css, "水平分隔条到极限的光标").toMatch(/\.layout-sep-h\.at-max\s*\{[^}]*w-resize/);
    expect(css, "垂直分隔条到极限的光标").toMatch(/\.layout-sep-v\.at-min\s*\{[^}]*s-resize/);
    expect(css, "垂直分隔条到极限的光标").toMatch(/\.layout-sep-v\.at-max\s*\{[^}]*n-resize/);

    // O7 角手柄：绝对定位的 8px 命中块，按分隔条朝向摆在两端
    expect(css, "角手柄基准样式").toMatch(/\.layout-corner\s*\{[^}]*position:\s*absolute/);
    expect(css, "横线上的角手柄在左右端").toMatch(
      /\.layout-sep-v\s*>\s*\.layout-corner\.start\s*\{/,
    );
    expect(css, "横线上的角手柄在左右端").toMatch(/\.layout-sep-v\s*>\s*\.layout-corner\.end\s*\{/);
    expect(css, "竖线上的角手柄在上下端").toMatch(
      /\.layout-sep-h\s*>\s*\.layout-corner\.start\s*\{/,
    );
    expect(css, "竖线上的角手柄在上下端").toMatch(/\.layout-sep-h\s*>\s*\.layout-corner\.end\s*\{/);

    // O3 方向光标：默认 ew-resize（大纲/查找栏/水平分隔条都靠它），
    // 只有垂直分隔条叠加 -v → ns-resize（原实现恒为 col-resize，是 bug）
    expect(css, "垂直分隔条拖拽时 ns-resize").toMatch(
      /body\.layout-dragging\.layout-dragging-v\s*\{[^}]*ns-resize/,
    );
    expect(css, "角手柄拖拽时光标").toMatch(
      /body\.layout-dragging\.layout-dragging-corner\s*\{[^}]*all-scroll/,
    );

    // S4 缩放期间抑制面板内过渡（拖动不发飘）
    expect(css, "缩放期间抑制过渡").toMatch(/body\.layout-dragging \.layout-panel \*/);

    // S5 线色抽成 --sep-line（B59）；B122 起分屏侧静息透明（卡片边框替代细线），
    // --sep-line 只剩大纲分隔条沿用，两套主题仍须保留定义
    expect(css, "分屏分隔条静息必须透明（B122 卡片边框替代细线）").toMatch(
      /\.layout-sep::after\s*\{[^}]*background:\s*transparent/,
    );
    expect(previewCss, "大纲分隔条线色同款").toMatch(
      /\.toc-resizer::after\s*\{[^}]*background:\s*var\(--sep-line\)/,
    );
    const darkTheme = themeBlock(css, "dark");
    const lightTheme = themeBlock(css, "light");
    expect(darkTheme, "深色主题块必须找到").toBeTruthy();
    expect(lightTheme, "浅色主题块必须找到").toBeTruthy();
    for (const [name, block] of [
      ["dark", darkTheme],
      ["light", lightTheme],
    ] as const) {
      expect(block, `${name} 主题必须有 --sep-line`).toContain("--sep-line:");
      expect(block, `${name} 主题必须有 --drop-fill`).toContain("--drop-fill:");
    }

    // S3 落点高亮过渡（B60 保留）：70ms 位移 / 150ms opacity（VS Code editordroptarget.css）
    const preview = css.match(/\.split-preview::after\s*\{[^}]*\}/)?.[0] ?? "";
    expect(preview, "填充走 --drop-fill").toContain("background: var(--drop-fill)");
    // B60：填充与描边同源（都走 --drop-fill），叠加成约 @0.39，改主题不会只改一半。
    // B60 二次反馈：用户明确「不用描边」—— 填充值保持不动，只去掉那圈 2px 边。
    expect(preview, "用户要求落点预览不描边").not.toMatch(/border:\s*\d+px/);
    expect(preview, "圆角 4px 保留").toMatch(/border-radius:\s*4px/);
    expect(preview, "位移过渡 70ms").toMatch(/70ms/);
    expect(preview, "不透明度过渡 150ms").toMatch(/150ms/);
    expect(css, "基础态 opacity:0，靠 .show 点亮").toMatch(
      /\.split-preview\.show::after\s*\{[^}]*opacity:\s*1/,
    );

    // 接线：统一走 attachResize（双击复位 + 指针捕获 + 方向修饰类），角手柄双类写法
    expect(sv, "双击复位接线").toMatch(/addEventListener\("dblclick"/);
    expect(sv, "指针捕获（移出窗口不丢事件）").toMatch(/setPointerCapture/);
    expect(sv, "垂直分隔条加方向修饰类").toMatch(/layout-dragging-v/);
    expect(sv, "角手柄双类 start/end（对齐 VS Code）").toMatch(
      /layout-corner \$\{atStart \? "start" : "end"\}/,
    );
  });
  it("B60 分隔条改细 + 落点回退浅蓝 + 对齐联动（静态契约）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const previewCss = readFileSync("src/styles/preview.css", "utf-8");
    const sv = readFileSync("src/shell/splitview.ts", "utf-8");

    // ① 分隔条不占布局（对齐 VS Code sash 的浮层做法）。
    // B59 的 flex:0 0 7px 透明占位会撑开两侧内容、露出祖先底色 = 视觉上的粗带。
    expect(css, "分屏分隔条不占布局").toMatch(/\.layout-sep\s*\{[^}]*flex:\s*0 0 0/);
    expect(previewCss, "大纲分隔条同款（B28）").toMatch(/\.toc-resizer\s*\{[^}]*flex:\s*0 0 0/);
    // 命中区搬到 ::before，向两侧各溢出 3.5px（共 7px）
    expect(css, "竖线命中区 7px 宽").toMatch(/\.layout-sep-h::before\s*\{[^}]*width:\s*7px/);
    expect(css, "横线命中区 7px 高").toMatch(/\.layout-sep-v::before\s*\{[^}]*height:\s*7px/);
    expect(previewCss, "大纲命中区 7px 宽（同款）").toMatch(
      /\.toc-resizer::before\s*\{[^}]*width:\s*7px/,
    );
    // 视觉线：静息 1px（VS Code editorGroup.border），激活 4px（--vscode-sash-size）
    expect(css, "静息线 1px").toMatch(/\.layout-sep-h::after\s*\{[^}]*width:\s*1px/);
    expect(css, "静息线 1px（横线）").toMatch(/\.layout-sep-v::after\s*\{[^}]*height:\s*1px/);
    expect(css, "激活涨到 4px").toMatch(
      /\.layout-sep-h:hover::after,[\s\S]{0,160}?\{\s*width:\s*4px/,
    );
    expect(css, "激活涨到 4px（横线）").toMatch(
      /\.layout-sep-v:hover::after,[\s\S]{0,160}?\{\s*height:\s*4px/,
    );
    expect(previewCss, "大纲分隔条同款涨到 4px").toMatch(
      /\.toc-resizer:hover::after,[\s\S]{0,120}?width:\s*4px/,
    );
    // 角手柄改为骑在界线上（分隔条主轴尺寸已为 0，原先 top:0/left:0 会偏到一侧）
    expect(css, "横线上的角手柄骑线").toMatch(
      /\.layout-sep-v\s*>\s*\.layout-corner\s*\{[^}]*top:\s*-4px/,
    );
    expect(css, "竖线上的角手柄骑线").toMatch(
      /\.layout-sep-h\s*>\s*\.layout-corner\s*\{[^}]*left:\s*-4px/,
    );

    // ② 落点回退浅蓝：accent 系（深 #4c9ffe / 浅 #0969da）@0.22，不再用 VS Code 的灰
    const darkTheme = themeBlock(css, "dark");
    const lightTheme = themeBlock(css, "light");
    expect(darkTheme, "深色落点为 accent 浅蓝").toContain("--drop-fill: rgba(76, 159, 254, 0.22)");
    expect(lightTheme, "浅色落点为 accent 浅蓝").toContain("--drop-fill: rgba(9, 105, 218, 0.22)");
    expect(darkTheme, "不得残留 VS Code 的深灰落点").not.toContain("rgba(83, 89, 93, 0.5)");

    // ③ 对齐联动：注册表 + 查找 + 双击复位转发（对标 sash.ts 的 linkedSash）
    expect(sv, "登记真实分隔条").toMatch(/sashRegistry\.push\(/);
    expect(sv, "按同向 + 中线容差查找对齐项").toMatch(/function alignedSashesOf/);
    expect(sv, "拖拽中同步联动目标").toMatch(/for \(const l of links\) applyTarget/);
    expect(sv, "松手回写联动目标").toMatch(/for \(const l of links\) l\.target\.commit/);
    // 双击复位要转发给联动条，且**联动集合必须先求**——centerOf 读的是实时几何，
    // 先 applyTarget 把本条挪到 50% 就会让集合变空（B62 用户反馈的真机 bug）
    const dblStart = sv.indexOf('addEventListener("dblclick"');
    expect(dblStart, "应能定位 dblclick 处理器").toBeGreaterThan(-1);
    const dbl = sv.slice(dblStart);
    expect(dbl, "双击按链整条一起调整").toMatch(
      /movingGroupOf\(targets\)\.map\(\(s\) => s\.chainId\)/,
    );
    expect(
      dbl.indexOf("movingGroupOf(targets)"),
      "联动集合必须先于改比例求出（否则只剩点中的那条居中）",
    ).toBeLessThan(dbl.indexOf("applyTarget"));
    expect(dbl, "整链按均分比例回写（不是一律 50%）").toMatch(/s\.target\.commit\(s\.equalRatio\)/);
    // 纯点击（无 mousemove）不得回写比例：命中区 7px 宽，点一下就能把两条对齐推到容差外
    expect(sv, "没有拖动就不回写比例").toMatch(/if \(!moved\) return;/);
    expect(css, ".linked 高亮（悬停可见的联动提示）").toMatch(/\.layout-sep\.linked::after/);
  });
  it("B63 交叉点联动 + 双击按分割数量均分（静态契约）", () => {
    const sv = readFileSync("src/shell/splitview.ts", "utf-8");
    const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");
    const code = stripComments(sv);

    // ① 「一起动的那一组」统一入口：每个拖拽目标自身 + 它同向对齐的伙伴。
    // 角手柄有 2 个目标（轴互相垂直）→ 两条轴各自的联动组都会被带进来。
    expect(code, "统一的移动组入口").toMatch(/function movingGroupOf\(targets: ResizeTarget\[\]\)/);
    expect(code, "组 = 自身 + 同向对齐伙伴").toMatch(
      /out\.push\(self\)[\s\S]{0,220}?alignedSashesOf\(self\)/,
    );
    expect(code, "按 target 身份反查注册项（交叉点两端都要查得到）").toMatch(
      /function sashOfTarget\(t: ResizeTarget\)/,
    );

    // ② 悬停/按下/拖动/松手都必须走这个组 —— 不能再有「corner 不联动」的分支。
    expect(code, "悬停高亮走移动组").toMatch(/mouseenter"[\s\S]{0,120}?movingGroupOf\(targets\)/);
    expect(code, "按下时求整组与联动条").toMatch(
      /const group = movingGroupOf\(targets\);[\s\S]{0,140}?const links = group\.filter/,
    );
    expect(code, "不得残留「角手柄不参与联动」分支").not.toMatch(/mode === "corner" \? \[\]/);

    // ③ 角手柄必须**复用子分隔条已注册的 target 对象**：注册表按 target 身份查伙伴，
    // 另造对象会让 sashOfTarget 找不到它，交叉点拖动时子轴一侧的联动失效。
    expect(code, "角手柄挂在子分隔条上").toMatch(/child\.sep\.appendChild\(cHandle\)/);
    expect(code, "角手柄复用子分隔条的 target").toMatch(
      /attachResize\(cHandle, \[self, child\.target\], "corner"\)/,
    );

    // ④ 同轴链 + 均分比例：沿轴向数段数，两侧段数相等即为均分点。
    expect(code, "链号随父沿用（同向才同链）").toMatch(
      /parent\.dir === node\.dir \? parent\.chainId : \+\+chainSeq/,
    );
    expect(code, "轴向段数递归").toMatch(
      /function segmentsAlong\(node: LayoutNode, d: "h" \| "v"\)/,
    );
    expect(code, "均分比例 = segA / (segA + segB)").toMatch(/equalRatio: segA \/ \(segA \+ segB\)/);
    // 链号自增源必须每次重绘归零（与注册表一同清），否则渲染结果不可复现
    expect(code, "chainSeq 随 sashRegistry 一同重置").toMatch(
      /sashRegistry = \[\];[\s\S]{0,240}?chainSeq = 0;/,
    );
    expect(code, "注册表登记链号与均分比例").toMatch(/chainId,\s*\n\s*equalRatio:/);
  });
  it("B67 方案文档不得再断言「双击复位到 50%」（与代码的均分语义冲突）", () => {
    // 用户按 `docs/split-view-plan.md` 的清单核对进度，而 O1 行与状态表还写着 B59 的
    // 旧语义（「双击分隔条复位到 50%」）→ 得出「这条还没做」的结论（实为文档没跟上 B63）。
    // 行为契约在代码与测试里（本文件 B63 块 + `splitview.test.ts` 的均分用例）；
    // 这条只挡「文档与代码说法冲突」这一种误导，不去锁文档的其他措辞。
    const doc = readFileSync("docs/split-view-plan.md", "utf-8");
    const sv = readFileSync("src/shell/splitview.ts", "utf-8");
    const code = sv.replace(/\/\*[\s\S]*?\*\//g, "");

    expect(code, "双击的语义取自 equalRatio（均分），不是常数").toMatch(
      /addEventListener\("dblclick"[\s\S]{0,400}?equalRatio/,
    );
    expect(code, "双击不得再写回常数 0.5").not.toMatch(
      /addEventListener\("dblclick"[\s\S]{0,400}?commit\(0\.5\)/,
    );

    const o1 = doc.split("\n").find((l) => l.startsWith("| **O1**")) ?? "";
    expect(o1, "改进项清单里有 O1 行").not.toBe("");
    expect(o1, "O1 行要写明按分割数量均分").toMatch(/按分割数量均分/);
    expect(o1, "O1 行不得再是「复位到 50%」").not.toMatch(/复位到\s*50%/);

    const status = doc.split("\n").find((l) => l.startsWith("| O1 双击复位")) ?? "";
    expect(status, "实施记录里有 O1 行").not.toBe("");
    expect(status, "状态表要指向 B63 改语义后的说明").toMatch(/B63|第十节/);
  });
  it("B61 分隔条光标与 VS Code 非 mac 档一致（ew/ns，不是 col/row）", () => {
    // 用户反馈「分割条拖动光标和 vscode 不一样」。
    // 根因：我们用的是 VS Code 的 **mac 档** cursor（sash.css）
    //   .monaco-sash.mac.vertical   { cursor: col-resize }
    //   .monaco-sash.mac.horizontal { cursor: row-resize }
    // Windows/Linux 走的是基础档：
    //   .monaco-sash.vertical   { cursor: ew-resize }
    //   .monaco-sash.horizontal { cursor: ns-resize }
    // Windows 上 col-resize 会渲染成「箭头中间多一根竖杠」，一眼就能看出不同。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const previewCss = readFileSync("src/styles/preview.css", "utf-8");
    // ⚠️ 「不得残留」类断言必须先把注释剥掉 —— 注释里恰恰要写清「为什么不用 col-row」
    // （含这两个词），直接对全文断言会把说明文字当成违规。
    const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");
    const cssCode = stripComments(css);

    expect(css, "竖线（左右分屏）走非 mac 档 ew-resize").toMatch(
      /\.layout-sep-h\s*\{[^}]*cursor:\s*ew-resize/,
    );
    expect(css, "横线（上下分屏）走非 mac 档 ns-resize").toMatch(
      /\.layout-sep-v\s*\{[^}]*cursor:\s*ns-resize/,
    );
    // 极限档两平台一致（e/w/s/n-resize），不得被顺手改成 col/row
    expect(css, ".layout-sep-h.at-min 保持 e-resize").toMatch(
      /\.layout-sep-h\.at-min\s*\{[^}]*e-resize/,
    );
    expect(css, ".layout-sep-v.at-min 保持 s-resize").toMatch(
      /\.layout-sep-v\.at-min\s*\{[^}]*s-resize/,
    );

    // 拖拽期间由 body 兜住光标（命中区只有 7px，指针一离开就没了），三档值必须与上面一致
    const drag = css.match(/body\.layout-dragging\s*\{[^}]*\}/)?.[0] ?? "";
    expect(drag, "拖拽默认光标与竖线一致").toMatch(/cursor:\s*ew-resize/);
    expect(cssCode, "不得残留 mac 档 col-resize").not.toContain("col-resize");
    expect(cssCode, "不得残留 mac 档 row-resize").not.toContain("row-resize");
    expect(cssCode, "不得残留 nwse-resize（角手柄改用 all-scroll）").not.toContain("nwse-resize");
    expect(css, "上下分屏拖拽光标与横线一致").toMatch(
      /body\.layout-dragging\.layout-dragging-v\s*\{[^}]*ns-resize/,
    );

    // 正交角手柄：VS Code 的 .orthogonal-drag-handle 基础光标是 all-scroll；
    // 那几条 nwse/nesw 覆盖规则要求 .orthogonal-edge-north/south（只有 resizable.ts 设），
    // gridview 的 2x2 从不设 → 网格里的角手柄恒为 all-scroll。
    expect(css, "角手柄用 all-scroll（VS Code 基础档）").toMatch(
      /\.layout-corner\s*\{[^}]*cursor:\s*all-scroll/,
    );
    // 大纲分隔条与分屏分隔条同款（B28 约定）
    expect(previewCss, "大纲分隔条光标同款").toMatch(/\.toc-resizer\s*\{[^}]*cursor:\s*ew-resize/);
  });
});

describe("分屏：面板操作栏与分隔条（B54）", () => {
  it("面板操作栏只剩「移除分屏」，分屏按钮已去掉（分屏仍走拖拽与菜单）", () => {
    const sv = readFileSync("src/shell/splitview.ts", "utf-8");
    expect(sv, "不得再用 ⨯ 文本字形").not.toContain('textContent = "⨯"');
    expect(sv, "必须保留移除分屏按钮").toContain("CODICONS.close");
    expect(sv, "不得再有左右分屏按钮").not.toContain("splitH");
    expect(sv, "不得再有上下分屏按钮").not.toContain("splitV");
    expect(sv, "面板渲染不得再调 onSplitPanel").not.toContain("onSplitPanel");

    // 删按钮 ≠ 删功能：菜单 / 快捷键的分屏入口必须还在（B53 之前就有）
    const main = readFileSync("src/main.ts", "utf-8");
    expect(main, "菜单左右分屏处理必须保留").toContain('splitActivePanel(activePanelId, "h")');
    expect(main, "菜单上下分屏处理必须保留").toContain('splitActivePanel(activePanelId, "v")');
    const km = readFileSync("src/shell/keymap.ts", "utf-8");
    expect(km, "分屏快捷键必须保留").toContain("panel.splitH");
    expect(km, "分屏快捷键必须保留").toContain("panel.splitV");
  });
  it("分隔条：视觉细线 + 更宽命中区（原先 5px 可视条兼当命中区，容易抓空）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const sep = css.match(/\n\.layout-sep\s*\{[^}]*\}/)?.[0] ?? "";
    expect(sep, "应有 .layout-sep 规则").toBeTruthy();
    // B60：分隔条本身改为**不占布局**（flex 基准 0）—— 原先 7px 的透明占位会撑开
    // 两侧内容、露出祖先底色，视觉上就是一条粗带；命中区搬到 ::before 向两侧溢出。
    expect(sep, "分隔条不得占布局宽度").toMatch(/flex:\s*0 0 0/);
    const m = css.match(/\.layout-sep-h::before\s*\{[^}]*width:\s*(\d+)px/);
    expect(m, "命中区宽度必须显式给出").toBeTruthy();
    expect(Number(m![1]), "命中区至少 7px（原先是 5px 兼当视觉条）").toBeGreaterThanOrEqual(7);
    expect(css, "悬停高亮落在伪元素上").toMatch(/\.layout-sep:hover::after/);
    expect(css, "细线由伪元素画").toMatch(/\.layout-sep-h::after\s*\{/);
  });
});

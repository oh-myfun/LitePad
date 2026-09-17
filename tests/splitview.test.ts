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
import { renderTabstrip } from "../src/shell/tabstrip";

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

describe("B64 拖拽标签的浮动影像（对齐 VS Code 的 drag image）", () => {
  // 用户反馈：「标签拖动时，要像 vscode 那样有一个 tab 随光标移动的效果。」
  // VS Code 出处：`multiEditorTabsControl.ts:1295`，拖单个标签且 tabSizing 非 shrink 时
  //   e.dataTransfer.setDragImage(tab, 0, 0);  // 被拖标签的左上角放到光标处
  // 本项目拿不到浏览器的拖拽影像（指针事件自编排），只能自己造一个浮层。
  //
  // 用例走**真实 tabstrip 渲染 + 真实 mousedown**，顺带验证 tabstrip 确实把
  // 标签元素交给了 beginTabDrag（只测 splitview 的入参会漏掉这层接线）。

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

  const ghost = (): HTMLElement | null => document.querySelector<HTMLElement>(".tab-drag-ghost");

  /** 从标签上按下左键，再移动到 (x, y)。 */
  function startDrag(tab: HTMLElement, x: number, y: number): void {
    tab.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      }),
    );
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
  }

  it("未越过拖拽阈值时不得亮出影像（纯点击不该闪出一个副本）", () => {
    const tab = mountStrip();
    startDrag(tab, 12, 11); // 距离 ≈ 2.2 < DRAG_THRESHOLD(5)
    expect(ghost()).toBeNull();
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 12, clientY: 11 }));
    expect(ghost()).toBeNull();
  });

  it("越过阈值后挂到 body 上，且是原标签的克隆（文件名/图标/未保存点一并带过来）", () => {
    const tab = mountStrip();
    startDrag(tab, 100, 60);
    const g = ghost();
    expect(g, "必须有跟随光标的影像").not.toBeNull();
    expect(g!.parentElement, "fixed 定位挂 body（面板会被 overflow 裁掉）").toBe(document.body);
    expect(g!.getAttribute("aria-hidden"), "影像不该进可访问树").toBe("true");

    const copy = g!.querySelector<HTMLElement>(".tab")!;
    expect(copy).not.toBeNull();
    expect(copy.querySelector(".tab-name")!.textContent, "文件名照搬").toBe("README.md");
    expect(copy.querySelector<HTMLElement>(".tab-icon")!.dataset.fam, "类型图标照搬").toBe("md");
    expect(copy.classList.contains("tab-active"), "活动态配色照搬").toBe(true);
    // 副本必须与真标签可区分：留着 tabId 会让「按 tabId 查元素」的逻辑命中副本
    expect(copy.dataset.tabId, "副本不得保留 tabId").toBeUndefined();
    expect(tab.dataset.tabId, "原标签原地不动（影像期间它是参照物）").toBe("11");
    expect(copy.querySelectorAll("button[tabindex='-1']").length, "副本里的按钮不可聚焦").toBe(1);
  });

  it("影像左上角跟到光标处（= setDragImage(tab, 0, 0) 的锚点），并随移动更新", () => {
    const tab = mountStrip();
    startDrag(tab, 100, 60);
    expect(ghost()!.style.left).toBe("100px");
    expect(ghost()!.style.top).toBe("60px");

    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 251, clientY: 133 }),
    );
    expect(ghost()!.style.left).toBe("251px");
    expect(ghost()!.style.top).toBe("133px");
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });

  it("拖到面板之外影像照样跟随（不得僵在最后一个面板上）", () => {
    const tab = mountStrip(); // 本例没有任何 .layout-panel：全程都在「面板之外」
    startDrag(tab, 400, 500);
    expect(ghost(), "没有面板时更要靠影像给出反馈").not.toBeNull();
    expect(ghost()!.style.left).toBe("400px");
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 420, clientY: 520 }),
    );
    expect(ghost()!.style.left).toBe("420px");
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });

  it("松手即移除影像（落到任何面板之外也一样）", () => {
    const tab = mountStrip();
    startDrag(tab, 300, 200);
    expect(ghost()).not.toBeNull();
    document.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, clientX: 300, clientY: 200 }),
    );
    expect(ghost(), "松手后不得残留").toBeNull();
    expect(document.body.classList.contains("tab-drag-active")).toBe(false);
  });

  it("中途窗口失焦（拖到窗口外松手收不到 mouseup）也要清掉影像", () => {
    const tab = mountStrip();
    startDrag(tab, 300, 200);
    expect(ghost()).not.toBeNull();
    window.dispatchEvent(new Event("blur"));
    expect(ghost(), "缺这条兜底就会留下一个跟不动的幽灵标签").toBeNull();
  });

  it("连续第二次拖拽不得叠加影像（上一次的残留必须先被清掉）", () => {
    const tab = mountStrip();
    startDrag(tab, 300, 200);
    startDrag(tab, 120, 90); // 未松手就再次按下
    expect(document.querySelectorAll(".tab-drag-ghost").length).toBe(1);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(ghost()).toBeNull();
  });
});

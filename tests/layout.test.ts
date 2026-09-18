import { describe, expect, it } from "vitest";
import {
  countLeaves,
  eachLeaf,
  hasPanel,
  leaf,
  maximizePanel,
  pathToPanel,
  removePanel,
  restoreRatios,
  siblingLeafOf,
  splitPanel,
  splitPanelAt,
  type LayoutNode,
  updateRatio,
} from "../src/shell/layout";

const tree: LayoutNode = {
  kind: "split",
  dir: "h",
  ratio: 0.5,
  a: leaf(1),
  b: {
    kind: "split",
    dir: "v",
    ratio: 0.6,
    a: leaf(2),
    b: leaf(3),
  },
};

describe("layout tree", () => {
  it("countLeaves", () => {
    expect(countLeaves(leaf(1))).toBe(1);
    expect(countLeaves(tree)).toBe(3);
  });

  it("hasPanel / eachLeaf", () => {
    expect(hasPanel(tree, 3)).toBe(true);
    expect(hasPanel(tree, 9)).toBe(false);
    const ids: number[] = [];
    eachLeaf(tree, (id) => ids.push(id));
    expect(ids).toEqual([1, 2, 3]);
  });

  it("splitPanel 在目标旁插入", () => {
    const t = splitPanel(leaf(1), 1, "v", 2);
    expect(countLeaves(t)).toBe(2);
    const ids: number[] = [];
    eachLeaf(t, (id) => ids.push(id));
    expect(ids).toEqual([1, 2]);
  });

  it("splitPanel 目标不存在时原样返回", () => {
    const t = splitPanel(leaf(1), 99, "v", 2);
    expect(countLeaves(t)).toBe(1);
  });

  it("removePanel 规约：叶子摘除后兄弟上提", () => {
    const t = removePanel(tree, 2);
    expect(t).not.toBeNull();
    if (t && t.kind === "split") {
      // 面板 2 的父 split 被规约，b 侧应为 leaf(3)
      expect(t.b).toEqual({ kind: "leaf", panelId: 3 });
    } else {
      throw new Error("expected split node");
    }
    expect(countLeaves(t)).toBe(2);
  });

  it("removePanel 比例补偿：关闭外侧面板时，存活子树的分隔线不得大幅跳动（回归：关闭面板影响其他分割位置）", () => {
    // [P1 40% | P2 35% | P3 25%]，关闭 P1：
    // 旧行为 → P2|P3 分隔线从 75% 跳到 53.8%（两个面板都翻倍）；
    // 补偿后 → 紧邻 P1 的 P2 吸收释放空间，P3 保持绝对尺寸（25% → 27.7%，微调）。
    const t: LayoutNode = {
      kind: "split",
      dir: "h",
      ratio: 0.4,
      a: leaf(1),
      b: { kind: "split", dir: "h", ratio: 35 / 65, a: leaf(2), b: leaf(3) },
    };
    const after = removePanel(t, 1);
    expect(after).not.toBeNull();
    if (after && after.kind === "split") {
      const s = 35 / 65,
        r = 0.4;
      const expected = s + r - s * r; // ≈ 0.723：P2 保持相邻、P3 绝对尺寸近似不变
      expect(after.ratio).toBeCloseTo(expected, 6);
    } else {
      throw new Error("expected split node");
    }
  });

  it("removePanel 比例补偿：关闭内侧叶子时，兄弟子树首子区域保持绝对尺寸", () => {
    // [ [A 30% | B 30%] | P3 40% ]，关闭 P3：A 的绝对尺寸 30% 必须不变，
    // 释放空间流向紧邻 P3 的 B 侧（30% → 70%）。
    const t: LayoutNode = {
      kind: "split",
      dir: "h",
      ratio: 0.6,
      a: { kind: "split", dir: "h", ratio: 0.5, a: leaf(1), b: leaf(2) },
      b: leaf(3),
    };
    const after = removePanel(t, 3);
    expect(after).not.toBeNull();
    if (after && after.kind === "split") {
      expect(after.ratio, "A 的绝对尺寸应保持 0.6 * 0.5 = 0.3").toBeCloseTo(0.3, 6);
    } else {
      throw new Error("expected split node");
    }
  });

  it("removePanel 跨方向子树不补偿：分割轴不同，子区域尺寸天然不变", () => {
    // 根 h-split，右子树是 v-split：关闭左叶，右子树 ratio（纵向）原样保留
    const t: LayoutNode = {
      kind: "split",
      dir: "h",
      ratio: 0.5,
      a: leaf(1),
      b: { kind: "split", dir: "v", ratio: 0.6, a: leaf(2), b: leaf(3) },
    };
    const after = removePanel(t, 1);
    expect(after).not.toBeNull();
    if (after && after.kind === "split") {
      expect(after.ratio).toBe(0.6);
    } else {
      throw new Error("expected split node");
    }
  });

  it("removePanel 移除后树规约为单叶子", () => {
    const three = splitPanel(splitPanel(leaf(1), 1, "h", 2), 2, "v", 3);
    const t = removePanel(removePanel(three, 3), 2);
    expect(t).toEqual({ kind: "leaf", panelId: 1 });
  });

  it("removePanel 最后一个面板返回 null", () => {
    expect(removePanel(leaf(1), 1)).toBeNull();
  });

  it("siblingLeafOf 返回视觉相邻叶子", () => {
    // tree = h[ leaf(1), v[ leaf(2), leaf(3) ] ]
    expect(siblingLeafOf(tree, 1)).toBe(2); // 1 的兄弟是 b 侧第一个叶子
    expect(siblingLeafOf(tree, 2)).toBe(3); // v 内左右相邻
    expect(siblingLeafOf(tree, 3)).toBe(2); // v 内左右相邻
    expect(siblingLeafOf(leaf(1), 1)).toBeNull(); // 单面板无邻居
    expect(siblingLeafOf(tree, 9)).toBeNull(); // 不存在的面板
  });

  it("splitPanelAt 按 side 在目标旁插入新面板", () => {
    // 在面板 1 右侧（newFirst=false）分屏新面板 9
    const t1 = splitPanelAt(leaf(1), 1, "h", 9, false);
    expect(t1.kind).toBe("split");
    if (t1.kind === "split") {
      expect(t1.a).toEqual({ kind: "leaf", panelId: 1 });
      expect(t1.b).toEqual({ kind: "leaf", panelId: 9 });
    }
    // 在面板 1 左侧（newFirst=true）分屏新面板 9
    const t2 = splitPanelAt(leaf(1), 1, "v", 9, true);
    expect(t2.kind).toBe("split");
    if (t2.kind === "split") {
      expect(t2.a).toEqual({ kind: "leaf", panelId: 9 });
      expect(t2.b).toEqual({ kind: "leaf", panelId: 1 });
    }
    // 目标不存在时原样返回
    expect(splitPanelAt(leaf(1), 42, "h", 9, false)).toEqual({ kind: "leaf", panelId: 1 });
  });
});

describe("updateRatio 路径约定（B26 回归：分割条位置随开/关文档跳变）", () => {
  // build() 传给 onRatioChange 的 path 是「分割节点自身」的树路径：
  // 根分割 = []，根的 a 子树里的分割 = [0]，b 子树里 = [1]……
  const nested = (): LayoutNode => ({
    kind: "split",
    dir: "h",
    ratio: 0.5,
    a: { kind: "split", dir: "v", ratio: 0.5, a: leaf(1), b: leaf(2) },
    b: { kind: "split", dir: "v", ratio: 0.5, a: leaf(3), b: leaf(4) },
  });

  it("根分割用空路径写入（旧实现永远写不进 → 开/关文档后跳位）", () => {
    const t = nested();
    updateRatio(t, [], 0.3);
    expect(t.ratio).toBe(0.3);
  });

  it("嵌套分割写到对应子节点，而不是父节点", () => {
    const t = nested();
    updateRatio(t, [0], 0.25);
    expect(t.a.kind === "split" && t.a.ratio).toBe(0.25);
    expect(t.ratio, "父节点比例不得被误改").toBe(0.5);
    updateRatio(t, [1], 0.8);
    expect(t.b.kind === "split" && t.b.ratio).toBe(0.8);
    // [1,0] 指向 b.a（叶子）→ 安全无操作，b 的比例不变
    updateRatio(t, [1, 0], 0.6);
    expect(t.b.kind === "split" && t.b.ratio).toBe(0.8);
  });

  it("叶子节点与非法下标安全无操作；比例收敛到合法区间", () => {
    const t = nested();
    updateRatio(t, [0, 1, 2], 0.7); // 指向叶子 → 无操作
    expect(t.ratio).toBe(0.5);
    updateRatio(t, [], 5); // 越界值收敛
    expect(t.ratio).toBeLessThanOrEqual(0.95);
    expect(t.ratio).toBeGreaterThanOrEqual(0.05);
  });
});

describe("B71 最大化 / 还原面板（只改比例，不动结构）", () => {
  // 用户：VS Code 的面板还能最大化/还原，LitePad 没有。
  // 取舍：不新增「隐藏面板」的渲染分支 —— 最大化只是把「根 → 该叶子」路径上
  // 每一层的比例推到 0/1，面板、标签、编辑器实例全都留着（另一侧渲染成 0 宽）。
  // 这样拖分隔条、保存会话、序列化都仍然只认识 ratio 一种状态。
  const sample = (): LayoutNode => ({
    kind: "split",
    dir: "h",
    ratio: 0.4,
    a: leaf(1),
    b: { kind: "split", dir: "v", ratio: 0.7, a: leaf(2), b: leaf(3) },
  });

  const shape = (n: LayoutNode): string =>
    n.kind === "leaf"
      ? "leaf:" + n.panelId
      : "split:" + n.dir + "(" + shape(n.a) + "," + shape(n.b) + ")";

  it("pathToPanel 给出根到叶子的下标序列；不存在时为 null", () => {
    expect(pathToPanel(leaf(1), 1)).toEqual([]);
    expect(pathToPanel(sample(), 1)).toEqual([0]);
    expect(pathToPanel(sample(), 2)).toEqual([1, 0]);
    expect(pathToPanel(sample(), 3)).toEqual([1, 1]);
    expect(pathToPanel(sample(), 99)).toBeNull();
  });

  it("最大化 = 沿路径把比例推到 0/1（A 侧占 1，B 侧占 0）", () => {
    const t = sample();
    const snap = maximizePanel(t, 3);
    expect(snap).not.toBeNull();
    if (t.kind !== "split" || !snap) return;
    // 3 在 b 侧 → 根比例推到 0；它又在 b 的 b 侧 → 内层也推到 0
    expect(t.ratio, "根：目标在 b → 0").toBe(0);
    expect(t.b.kind === "split" && t.b.ratio, "内层：目标在 b → 0").toBe(0);
    expect(snap.path).toEqual([1, 1]);
    expect(snap.ratios, "快照记的是**原**比例").toEqual([0.4, 0.7]);
  });

  it("最大化最左侧面板时根比例推到 1", () => {
    const t = sample();
    maximizePanel(t, 1);
    expect(t.kind === "split" && t.ratio).toBe(1);
  });

  it("还原把各层比例原样写回", () => {
    const t = sample();
    const snap = maximizePanel(t, 2);
    expect(snap).not.toBeNull();
    // 2 在 b.a → 根 0、内层 1
    expect(t.kind === "split" && t.ratio).toBe(0);
    expect(t.b.kind === "split" && t.b.ratio).toBe(1);
    if (!snap) return;
    restoreRatios(t, snap);
    expect(t.kind === "split" && t.ratio).toBe(0.4);
    expect(t.b.kind === "split" && t.b.ratio).toBe(0.7);
  });

  it("唯一面板 / 不存在的面板：返回 null（调用方据此什么都不做）", () => {
    // 单叶子时路径是 []，最大化没有意义 —— 若返回非 null，UI 会进入「最大化态」
    // 却看不出任何变化，还原按钮也变得莫名其妙。
    expect(maximizePanel(leaf(1), 1)).toBeNull();
    expect(maximizePanel(sample(), 42)).toBeNull();
  });

  it("树结构在最大化前后完全一致（只有 ratio 变了）", () => {
    const t = sample();
    const before = shape(t);
    maximizePanel(t, 2);
    expect(shape(t), "面板与分割方向都不许变").toBe(before);
    expect(countLeaves(t)).toBe(3);
  });

  it("还原快照对已变化的树是容错的（路径走不通就停在原地，不写坏比例）", () => {
    const t = sample();
    const snap = maximizePanel(t, 3); // path = [1,1]
    if (!snap) return;
    // 最大化期间内层面板被关掉 → [1] 那一层塌成叶子
    const shrunk = removePanel(t, 2);
    expect(shrunk).not.toBeNull();
    if (!shrunk) return;
    expect(shrunk.kind === "split" && shrunk.ratio, "前置：仍是最大化态的 0").toBe(0);
    restoreRatios(shrunk, snap);
    expect(shrunk.kind === "split" && shrunk.ratio, "根比例仍被还原").toBe(0.4);
  });
});

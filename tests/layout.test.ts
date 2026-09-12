import { describe, expect, it } from "vitest";
import {
  countLeaves,
  eachLeaf,
  hasPanel,
  leaf,
  removePanel,
  siblingLeafOf,
  splitPanel,
  splitPanelAt,
  type LayoutNode,
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
      const s = 35 / 65, r = 0.4;
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

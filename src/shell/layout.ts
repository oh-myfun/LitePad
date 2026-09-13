/**
 * 分屏布局树（方案 4.2）：二叉树，叶子 = 面板，内部节点 = 分割。
 * 结构变化（开/关面板）通过纯函数规约，UI 渲染层只消费树。
 */

export type LayoutNode =
  | { kind: "leaf"; panelId: number }
  | { kind: "split"; dir: "h" | "v"; ratio: number; a: LayoutNode; b: LayoutNode };

export function leaf(panelId: number): LayoutNode {
  return { kind: "leaf", panelId };
}

/** 统计叶子（面板）数。 */
export function countLeaves(n: LayoutNode): number {
  return n.kind === "leaf" ? 1 : countLeaves(n.a) + countLeaves(n.b);
}

/** 树中是否存在某面板。 */
export function hasPanel(n: LayoutNode, panelId: number): boolean {
  return n.kind === "leaf"
    ? n.panelId === panelId
    : hasPanel(n.a, panelId) || hasPanel(n.b, panelId);
}

/** 遍历全部面板 id（中序）。 */
export function eachLeaf(n: LayoutNode, fn: (panelId: number) => void): void {
  if (n.kind === "leaf") {
    fn(n.panelId);
    return;
  }
  eachLeaf(n.a, fn);
  eachLeaf(n.b, fn);
}

/**
 * 移除面板并规约树：叶子摘除后，若其兄弟也是叶子/子树，则兄弟上提占据父位置。
 * 返回 null 表示整棵树只剩这个面板（调用方应阻止关闭最后一个面板）。
 */
export function removePanel(n: LayoutNode, panelId: number): LayoutNode | null {
  if (n.kind === "leaf") {
    return n.panelId === panelId ? null : n;
  }
  const a = removePanel(n.a, panelId);
  const b = removePanel(n.b, panelId);
  if (a === null) return b === null ? null : promoteSibling(b, n, "a");
  if (b === null) return a === null ? null : promoteSibling(a, n, "b");
  return { ...n, a, b };
}

/**
 * 子树接替被移除兄弟的父槽位时补偿自身 ratio。
 * 直接上提会让存活子树整体放大（紧邻分隔线大幅跳动）；这里调整子树自身的
 * 分割点，让「紧邻被移除侧」的子区域保持绝对尺寸，释放的空间流向相邻边
 * （与 VS Code 关闭分组的观感一致）。跨方向子树（dir 不同）无需补偿：
 * 其分割轴不与释放空间同轴，子区域绝对尺寸天然不变。
 */
function promoteSibling(
  s: LayoutNode,
  parent: { dir: "h" | "v"; ratio: number },
  removedSide: "a" | "b",
): LayoutNode {
  if (s.kind !== "split" || s.dir !== parent.dir) return s;
  const r = parent.ratio;
  // 被移除的在 b 侧 → 接替者是 a 子树：保持 a 的绝对尺寸 → s' = s·r（b 侧吸收释放空间）
  // 被移除的在 a 侧 → 接替者是 b 子树：保持 b 的绝对尺寸 → s' = s + r − s·r（a 侧吸收释放空间）
  const ratio = removedSide === "b" ? s.ratio * r : s.ratio + r - s.ratio * r;
  return { ...s, ratio: Math.min(0.95, Math.max(0.05, ratio)) };
}

/** 在某面板旁分割出新面板：返回新树。目标不存在时返回原树。 */
export function splitPanel(
  n: LayoutNode,
  targetPanelId: number,
  dir: "h" | "v",
  newPanelId: number,
): LayoutNode {
  if (n.kind === "leaf") {
    if (n.panelId !== targetPanelId) return n;
    return { kind: "split", dir, ratio: 0.5, a: n, b: leaf(newPanelId) };
  }
  return {
    ...n,
    a: splitPanel(n.a, targetPanelId, dir, newPanelId),
    b: splitPanel(n.b, targetPanelId, dir, newPanelId),
  };
}

/** 面板移动（M2 简化：关闭侧重开，标签并入目标面板由调用方处理）。 */
export function cloneTree(n: LayoutNode): LayoutNode {
  return n.kind === "leaf" ? { ...n } : { ...n, a: cloneTree(n.a), b: cloneTree(n.b) };
}

/**
 * 在 target 面板旁分割出新面板，新面板位置由 newFirst 决定：
 * true → 新面板在 target 之前（左/上），false → 之后（右/下）。
 * 用于「拖拽标签到某区域进行分屏」。
 */
export function splitPanelAt(
  n: LayoutNode,
  target: number,
  dir: "h" | "v",
  newId: number,
  newFirst: boolean,
): LayoutNode {
  if (n.kind === "leaf") {
    if (n.panelId !== target) return n;
    const a = { kind: "leaf", panelId: target } as LayoutNode;
    const b = { kind: "leaf", panelId: newId } as LayoutNode;
    return { kind: "split", dir, ratio: 0.5, a: newFirst ? b : a, b: newFirst ? a : b };
  }
  return {
    ...n,
    a: splitPanelAt(n.a, target, dir, newId, newFirst),
    b: splitPanelAt(n.b, target, dir, newId, newFirst),
  };
}

/** 取子树的第一个叶子（中序）。 */
function firstLeaf(n: LayoutNode): number {
  return n.kind === "leaf" ? n.panelId : firstLeaf(n.a);
}

/**
 * 找到 panelId 叶子在树中的视觉相邻叶子（其兄弟子树的第一个叶子）。
 * 优先取最深一层 split 的邻居（真正视觉相邻）；单面板或面板不存在返回 null。
 */
export function siblingLeafOf(n: LayoutNode, panelId: number): number | null {
  if (n.kind === "leaf") return null;
  if (hasPanel(n.a, panelId)) {
    return siblingLeafOf(n.a, panelId) ?? firstLeaf(n.b);
  }
  if (hasPanel(n.b, panelId)) {
    return siblingLeafOf(n.b, panelId) ?? firstLeaf(n.a);
  }
  return null;
}

/**
 * 把拖拽后的分割比例写回树中 path 指向的分割节点。
 *
 * 路径约定与 splitview.build 一致：path 是**从根到该分割节点**的子树下标序列
 * （根分割 = []，根分割的 a 子树里的分割 = [0]……）。
 *
 * B26 回归：旧实现按「寻址子节点」解释（要求 path 末位是 0/1 才写 ratio），
 * 与 build 传参错位一层——根分割的比例永远写不进树、嵌套分割写到父节点上。
 * 平时看不出（拖拽只改了内联样式），任何 rebuildLayout（开/关文档等）都会用
 * 旧 ratio 重排 → 分割条跳位。
 */
export function updateRatio(node: LayoutNode, path: number[], ratio: number): void {
  if (node.kind !== "split") return;
  if (path.length === 0) {
    node.ratio = Math.min(0.95, Math.max(0.05, ratio));
    return;
  }
  const [head, ...rest] = path;
  if (head === 0) updateRatio(node.a, rest, ratio);
  else if (head === 1) updateRatio(node.b, rest, ratio);
}

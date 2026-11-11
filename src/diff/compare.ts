// B461 · B 档「选择以进行比较」的窗口级状态与那一对菜单标签。
//
// 两击手势：先在一条上点「选择以进行比较」把它设成**对照物（左栏）**，再到另一条上点
// 「与 X 比较」开一张差异 —— 两侧都是普通标签，都可编辑（用户口径 2026-11）；
// 旧会话恢复出来、左栏没有文档可落的才退成只读快照。
// ⚠️ 谁先点只是这一层的手势约定，设计稿 ⑩·1 里**没有**这一条（它只定死「左栏是对照物、
//    右栏就是那份文档本身」）⇒ 别把次序安到它名下，也别按注释改代码里的左右。
// 这一模块只管两件事，且都跟渲染层无关（纯状态 + 标签文案），所以能进 node 环境单测：
//   1) 一个模块级的「当前选中路径」小状态机（选/换/取消）；
//   2) 「选择以进行比较」/「与 X 比较」这一对条目的**标签与显隐**逻辑 —— explorer 树与
//      标签右键两处共用这一颗真相，避免「四处各写一遍其中一处算歪」（模型层同一口径）。
//
// 侧效应（真的去 `openFileDiff`、真的 `toggleCompareSelection`）由调用方通过 `actions` 注入：
// compare.ts 不 import model / io，于是既不拖渲染层进 node，也不与 model 成环。

import type { MenuItem } from "../shell/menu";

/** 「当前选作**左栏对照物**的那条路径」；null = 没选中。整个窗口一份（模块级，与 app-state 那几颗同形）。 */
let selected: string | null = null;

/** 现在选中作为对照左栏的那条路径（未选中 ⇒ null）。 */
export function compareSelection(): string | null {
  return selected;
}

/** 选中某条；再次点同一条 = 取消选择（VS Code 那一手：toggle）。 */
export function toggleCompareSelection(path: string): void {
  selected = selected === path ? null : path;
}

/** 清掉选中（开成差异标签之后调用，别让用户下次右键还莫名其妙对着这一条）。 */
export function clearCompareSelection(): void {
  selected = null;
}

/** 取路径末段做菜单文案（对 `/` 与 `\` 都成立；explorer 与 tabstrip 传进来的写法不一律）。 */
export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * 那一对条目落下去时要做的两件侧效应（由 explorer / tabstrip 注入，compare.ts 自己不碰模型层）。
 * - `onSelectToCompare`：把这条设成**左栏对照物**（走 `toggleCompareSelection`）。
 * - `onCompareWith`：`leftPath`（就是上面选中的那条）当左栏、`rightPath`（被点的这条）当
 *   右栏，开一张 B 档差异。
 */
export interface CompareActions {
  onSelectToCompare(path: string): void;
  onCompareWith(leftPath: string, rightPath: string): void;
}

/**
 * 按当前选中态给出那一组（最多一条）「比较」菜单条目。
 *
 * 规则（VS Code 的一对）：
 * - 未选中，或选中的就是**这一行本身** ⇒ 只给「选择以进行比较」（同一行不能给自己当对照物）。
 * - 已选中别处 ⇒ 给「与 X 比较」，且不再给「选择以进行比较」（别留着两条入口让用户误选）。
 * 点击态判定在这里按**当前** `selected` 求值 —— 弹层每次展开重算，不是建数组那一次的旧值。
 */
export function compareMenuItems(path: string, actions: CompareActions): MenuItem[] {
  const sel = compareSelection();
  if (sel && sel !== path) {
    return [
      { label: `与 ${baseName(sel)} 比较`, onSelect: () => actions.onCompareWith(sel, path) },
    ];
  }
  return [{ label: "选择以进行比较", onSelect: () => actions.onSelectToCompare(path) }];
}

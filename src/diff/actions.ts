// B461 · Task 8 —— 差异标题栏那十条动作的**唯一**落点。
//
// 为什么要有这一颗独立的模块：三条入口都指向同一件事 ——
//   · 图标键（`shell/splitview.ts` 的 `onDiffAction`，由 `tabs/lifecycle.ts` 接线）；
//   · 命令与命令面板（`main.ts` 的 `runShortcut`，按 `keymap.ts` 里那些 id）；
//   · 组菜单「⋯」里那三条（`tabs/render.ts` 的 `groupMenuOf`）。
// 两处各写一份 switch 就会漂移（Task 6 那条「三个 producer 逐字复制」的教训同形），
// 所以这里只留一份，别处只转调。
//
// ⚠️ 本模块与 `tabs/render.ts` 互为引用（这里要刷那一格的操作区，那边要点这颗动作）：
// 两边都只在**函数体里**用对方，模块求值期谁也不碰谁 —— 与 `render.ts` 文件头记过的
// 「运行期安全的循环引用」同一形。真把它拆平得先给渲染层做一层注册口，本轮不值。

import { docs, tabs, type Panel } from "../core/app-state";
import { getPanel } from "../core/panels";
import { renderPanelOps } from "../tabs/render";
import type { DiffAction } from "../shell/splitview";
import { openFileDiff } from "./model";
import { diffSurfaceOf, type DiffSurface } from "./surface";

/**
 * 命令 id → 动作（`keymap.ts` 那六条与命令面板共用的**唯一一份**对照）。
 *
 * 键位那两颗（`diff.nextChange` / `diff.prevChange`）不在这张表里：它们走的是
 * `surface.step(±1)` 那两条既有分发（Task 4），与这里同为「一条动作一个出口」。
 */
const DIFF_COMMAND_ACTION: Record<string, DiffAction> = {
  "diff.toggleWhitespace": "whitespace",
  "diff.toggleCollapse": "collapse",
  "diff.collapseAll": "collapseAll",
  "diff.showAll": "showAll",
  "diff.swapSides": "swap",
  "diff.toggleWrap": "wrap",
  "diff.toggleSyncScroll": "syncScroll",
  "diff.refresh": "refresh",
};

/** 命令 id 是不是差异动作（`main.ts` 的上下文闸按这颗判，别处不再抄一份清单）。 */
export function isDiffActionCommand(id: string): boolean {
  return id in DIFF_COMMAND_ACTION;
}

/** 按命令 id 执行一条差异动作（`main.ts` 的分发口）。 */
export function applyDiffCommand(panelId: number, id: string): void {
  const action = DIFF_COMMAND_ACTION[id];
  if (action) applyDiffAction(panelId, action);
}

/**
 * 八条动作落到 surface 的对应方法上，末尾**只刷那一格**的操作区。
 *
 * ⚠️ 不是 `rebuildLayout`：B226 那条还挂着 —— 重建 ops 会把按钮节点换掉，浏览器合成的
 * 那一次 click 派发不到（真机抓到过「点了没反应」）。
 * ⚠️ 没有旁路就整条不做事：图标键与菜单条目本来就只在挂着旁路那一格才画出来（`panelDataOf`
 * 给的是 `undefined`），这一发兜的是命令面板那一路（面板里点得到，当时那一格可能已经换了标签）。
 */
export function applyDiffAction(panelId: number, action: DiffAction): void {
  const panel = getPanel(panelId);
  const surface = diffSurfaceOf(panel);
  if (!panel || !surface) return;
  switch (action) {
    case "prev":
      surface.step(-1);
      break;
    case "next":
      surface.step(1);
      break;
    case "whitespace":
      surface.setIgnoreTrimWhitespace(!surface.ignoreTrimWhitespace());
      break;
    case "collapse":
      surface.setCollapseUnchanged(!surface.collapseUnchanged());
      break;
    case "collapseAll":
      surface.collapseAllUnchanged();
      break;
    case "showAll":
      surface.showAllUnchanged();
      break;
    case "wrap":
      surface.setWrapEnabled(!surface.wrapEnabled());
      break;
    case "syncScroll":
      surface.setSyncScrollEnabled(!surface.syncScrollEnabled());
      break;
    case "refresh":
      void refreshDiff(surface);
      break;
    case "swap":
      void swapSides(panel, surface);
      break;
  }
  renderPanelOps(panelId);
}

/**
 * 「刷新」= 把左栏那份对照物补回最新，再按现在的两份正文重算一次块表。
 *
 * 三条左栏的路各有各的「最新」：A 档读的是活的 `doc.baseline`、B 档那份文件已经开着时读的
 * 是那份文档的现值 —— 两条都不用重读盘，`leftReload` 自然缺席。剩下的那一路（B 档左栏没开着
 * ⇒ 打开那一刻抄下的只读对比缓冲）才是这颗键真正吃劲的地方：不重读，它就是「什么都没刷」。
 *
 * 重算之前必须先 `reassert()`：那颗把「左栏那份**文档**跟不跟得上对照物」补上的手（R20 ③）
 * 只在 `syncDiffSurface` 那条路上跑，而这里刚把 holder 换成新的一份正文。
 */
async function refreshDiff(surface: DiffSurface): Promise<void> {
  await surface.spec().leftReload?.();
  surface.reassert();
  surface.syncBlocks();
}

/**
 * 「交换左右」：用**反过来的那一对**重开一张，再把这一张关掉。
 *
 * 为什么不是「就地换 spec」（Task 6 那颗 `swapDiffInputs` 的设想）：右栏那颗 view 就是
 * `Panel.view` = 那份文档本身（Task 1 定死的落点），`retarget` 只换得动左栏 ⇒ 两栏读同一份
 * 内容、差异清零。真要就地换，得把 `tab.docId` / `tab.state` / `panel.view` 一起搬到另一份
 * 文档上（脏标记、存盘、撤销栈、孤儿 doc 那一大片记账重接一遍）—— 那是一条独立的活。
 *
 * ⚠️ 先开后关：新那一张的左栏读的是**原右栏那份文档**的现值，先关会让它读到一份已经被注销的
 * doc（右栏那份文档此刻还剩那颗普通实例 ⇒ 关掉差异标签不会把文档一起带走）。
 * ⚠️ `openFileDiff` 把新那一张开到**活动面板**：这一发的三条入口都只在点着那一格时才够得到
 * （面板的 `mousedown` 先把它自己切成活动，见 `splitview.ts` 那一发）⇒ 这里就是同一格。
 */
async function swapSides(panel: Panel, surface: DiffSurface): Promise<void> {
  const spec = surface.spec();
  if (spec.tier !== "files" || !spec.leftPath) return;
  const rightPath = docs.get(spec.docId)?.path ?? "";
  if (!rightPath) return;
  const oldDiffTabId = panel.viewTabId ?? panel.activeTabId;
  const nextTabId = await openFileDiff(rightPath, spec.leftPath);
  if (nextTabId === null) return;
  const { closeTabById } = await import("../tabs/lifecycle");
  const old = tabs.get(oldDiffTabId);
  if (old && old.kind === "diff") await closeTabById(oldDiffTabId);
  renderPanelOps(panel.panelId);
}

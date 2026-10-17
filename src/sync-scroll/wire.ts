/**
 * 同步滚动 v1 —— 运行时接线（T4）。
 *
 * 单一协调器单例 + 一个 reconciler：每次面板/标签/视图模式变化后，把当前**看得见**的
 * 编辑器与预览按各自文档 id 注册进协调器（同 docId 的 editor+preview+其它面板
 * 共享一组锚点）。reconciler 先解绑旧句柄再重注册，是唯一的注册 chokepoint，避免去
 * 改动每处创建/销毁 EditorView / PreviewPane 的站点。
 *
 * ⚠️ 只注册看得见的那一侧。生产里每个面板同时挂着 `.panel-editor` 与 `.md-preview`，
 * 靠 `.panel-host.mode-*` 的 CSS 藏掉其中一个（`src/styles/preview.css:632-640`），
 * 而那个类名由 `tab.viewMode` 决定。被藏起来的那一侧 `getV()` 只能报 1.0、`setV()`
 * 只能挂 pending：注册进去等于引入一个「永远读不准、现形时又补发滚动」的幽灵锚点
 * —— B285 那类「没显示的预览标签与显示的标签位置不一致」就是它。
 * 可见性按**状态**判（与 `applyPanelMode` 同源那条规则），不按 DOM 矩形判，理由写在
 * `reconcileSyncRegistrations` 的注释里。
 *
 * 抑制策略不在本文件：结构性写入由调用方在写完的同一同步栈内经
 * `syncCoordinator.expectSurfaceV(滚动面, 意图 v, 那一写的真实落点)` 登记进账本
 * （见 coordinator.ts）。
 * 本文件**不再**上任何锁——上一版在这里给每个 docId 上结构性锁，那是「猜时间」的一部分，
 * 已由期望账本取代。
 *
 * 依赖方向：本模块只 import core/app-state、doc-model 与同目录 sync-scroll/*
 * （功能模块 → core/*，不反向依赖 main.ts），各功能模块（main / commands / toc /
 * lifecycle）按需 import 本模块。
 */

import { panels, tabs, type Panel } from "../core/app-state";
import { isMdTab } from "../doc-model";
import { logger } from "../core/logger";
import { EditorScrollAnchor, type ScrollAnchor } from "./anchor";
import { PreviewScrollAnchor } from "./preview";
import { SyncScrollCoordinator, type AnchorHandle, type CoordinatedSurface } from "./coordinator";

/**
 * 应用级协调器单例（B152 按文档开关挂在其上）。
 *
 * 第二个参数是 TRACE 出口：账本每次 `scroll` 的**判定结果**（判成用户滚动 / 吞掉回声 /
 * 补写兑现 / 认账）只有打在真机日志里才能分辨「哪一步没落地」。协调器本身保持零依赖
 * （纯逻辑 + 注入），所以这里注入而不是在 coordinator 里 import 日志模块。
 */
export const syncCoordinator = new SyncScrollCoordinator(undefined, (m) => logger.trace("sync", m));

/** 当前在册的锚点句柄（reconcile 时先全解绑再重注册）。 */
let handles: AnchorHandle[] = [];

function surfaceOf(el: HTMLElement, label: string): CoordinatedSurface {
  return { events: el, label };
}

/** 面板的两侧之一。`viewMode` 只有 source / preview 两档 ⇒ 一格同时只有一侧看得见。 */
export type SyncSide = "editor" | "preview";

/**
 * 这一格**当前看得见**的是哪一侧。唯一口径：按应用状态判（`isMdTab` + `viewMode`），
 * 与 `applyPanelMode` 写 `mode-*` 类那条规则同源；不按 DOM 矩形判（理由见
 * `reconcileSyncRegistrations` 的注释）。
 */
export function sideOfPanel(panel: Panel): SyncSide {
  const tab = tabs.get(panel.viewTabId ?? panel.activeTabId);
  const mode = tab && isMdTab(tab) ? tab.viewMode : "source";
  return mode === "preview" ? "preview" : "editor";
}

/**
 * 某一侧的滚动面：一个锚点 + 真正会派发 `scroll` 的那个 DOM 节点。
 * 结构上不管显隐 —— **读**要赶在它还给用户看的时候读，**写**是给刚现形那一侧扶位置。
 */
export function faceOf(
  panel: Panel,
  side: SyncSide,
): { anchor: ScrollAnchor; el: HTMLElement; label: string } | null {
  const label = `P${panel.panelId}:${side}`;
  if (side === "editor") {
    const view = panel.view?.view;
    if (!view) return null;
    return { anchor: new EditorScrollAnchor(view), el: view.scrollDOM, label };
  }
  const preview = panel.preview;
  if (!preview) return null;
  const root = preview.root;
  return {
    anchor: new PreviewScrollAnchor(preview.scrollSurface(), (intent, landed) =>
      // 「没铺开 ⇒ 下一帧补定位」这条异步支线写在协调器调用栈之外，落定后回登记，
      // 否则那一发 `scroll` 无人认领 ⇒ 被判成用户滚动广播出去。
      syncCoordinator.expectSurfaceV(root, intent, landed),
    ),
    el: root,
    label,
  };
}

/** 这一格当前可见面的共享坐标 `v`；量不到（还没挂载 / 没有该侧）⇒ null。 */
export function readVisibleV(panel: Panel): number | null {
  const face = faceOf(panel, sideOfPanel(panel));
  if (!face) return null;
  const v = face.anchor.getV();
  logger.trace("sync", `读可见侧[${face.label}] v=${v.toFixed(2)}`);
  return v;
}

/**
 * 「这一格现在就停在这儿，而那是**我**造成的」——结构性写入之后就地认领当前位置。
 *
 * 用在协调器之外那些会改内容高度、却没打算移动视口的写入：远端正文增量 / 整段纠错
 * （浏览器会按新的 `scrollHeight` 裁掉 `scrollTop`）、文件重载后的 `setState`。
 * 不认领，那一发裁剪就被协调器当作用户滚动广播给同文档的其它视口 ⇒ 本窗口对栏跟着跳。
 *
 * 认领的是**看得见那一侧**：隐藏侧此刻恒 0，按它认领等于把「现形后被扶到的那一发」
 * 提前吞掉。量不到（还没挂载）⇒ null。
 */
export function claimVisibleHere(panel: Panel): number | null {
  const face = faceOf(panel, sideOfPanel(panel));
  if (!face) return null;
  const here = face.anchor.getV();
  syncCoordinator.expectSurfaceV(face.el, here, here);
  logger.trace("sync", `认领[${face.label}] here=${here.toFixed(2)}`);
  return here;
}

/**
 * 把这一格**当前看得见**那一侧扶到共享坐标 `v`，并向账本认领这一写（意图 + 真实落点）。
 *
 * 谁需要它：一切「让这一格换了一侧显示」的操作 —— 同格 source↔preview 切换
 * （`markdown.ts:toggleViewMode`）、布局销毁重建后重新挂载（`rebuildLayout` → `mountView`）。
 * 被 `display:none` 藏起来的一侧现形时持有的是残值：预览被归零（弹回文档开头），源码被
 * `focus()` 滚到**光标**那一行 —— 都不是用户切走之前看到的那一行。写完不认领，这一发还会
 * 被协调器当作用户滚动广播给同文档的其它视口，把别处一起拽走。
 */
export function landVisibleSideAtV(panel: Panel, v: number): boolean {
  const face = faceOf(panel, sideOfPanel(panel));
  // 这一条是「静默空操作」唯一的可见证据：找不到面（还没挂载 / 这一格没有该侧）时
  // 位置恢复整个没发生，而调用方拿到的只有一个 false —— 不打日志就只能看到「位置最终不对」，
  // 看不出是**没人写过**。
  if (!face) {
    logger.trace(
      "sync",
      `落位跳过[P${panel.panelId}:${sideOfPanel(panel)}] 意图=${v.toFixed(2)} 无滚动面`,
    );
    return false;
  }
  const landed = face.anchor.setV(v);
  syncCoordinator.expectSurfaceV(face.el, v, landed);
  return true;
}

/**
 * 解绑旧锚点、按当前可见视口重注册。应在以下时机调用：面板挂载（mountView）、
 * 切换标签（switchTab，docId 会变）、视图模式切换、分屏/关闭、文件打开/会话恢复。
 *
 * ⚠️ 「这一格看得见吗」按**应用状态**判（`isMdTab` + `viewMode`，与 `applyPanelMode`
 * 写 `mode-*` 类那条规则同源），不按 DOM 矩形判。两个原因：
 *   1. 状态才是显隐的**因**，CSS 只是它的果——按果判会随样式表改动而漂。
 *   2. 按矩形判在单测环境里恒为「不可见」（jsdom 无布局，`getClientRects()` 恒空），
 *      于是协调器在测试里一个锚点都不注册，同步相关用例会集体空转绿灯。
 * 取标签用 `viewTabId ?? activeTabId`（这一格 EditorView 当前挂着的那张），比
 * `applyPanelMode` 的 `activeTabId` 更贴「实际显示的是谁」；两者在所有写点上是一起赋的
 * （`switchTab` / `mountView` / `splitActivePanel` / 重载），所以显隐与内容不会错档。
 * 被藏起来的那一侧不注册：它的 `getV()` 只能报 1.0、`setV()` 只能挂 pending，
 * 注册进去等于引入一个「永远读不准、现形时又补发滚动」的幽灵锚点（B285 那一族）。
 */
export function reconcileSyncRegistrations(): void {
  for (const h of handles) syncCoordinator.unregister(h);
  handles = [];
  const registered: string[] = [];
  for (const p of panels.values()) {
    const tab = tabs.get(p.viewTabId ?? p.activeTabId);
    if (!tab) continue;
    const docId = String(tab.docId);
    // 走 `faceOf` 而不是在这里自己 new 锚点：预览锚点那条「未铺开 ⇒ 下一帧补定位」的异步
    // 支线需要回登记口，两处必须用同一个构造方式，否则注册出来的锚点没有这个口。
    const face = faceOf(p, sideOfPanel(p));
    if (!face) continue;
    handles.push(syncCoordinator.register(face.anchor, docId, surfaceOf(face.el, face.label)));
    registered.push(`${face.label}/doc${docId}`);
  }
  // 「对栏怎么没跟着动」的第一现场：这一格到底在册没有。
  logger.trace("sync", `reconcile 在册=${registered.length ? registered.join(", ") : "（空）"}`);
}

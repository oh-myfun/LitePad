// 面板分屏 / 最大化 / 标签移动（从 tabs.ts 拆出，P3 批次）。
//
// 职责：splitActivePanel / moveTabToPanel / moveActiveTabByDelta / focusPanelByDelta /
// exitMaximize / toggleMaximizePanel / layoutForSession / moveGroupToPanel /
// duplicateTabToPanel / duplicateTabToSibling / splitPanelWithTab / onDropTabToPanel /
// reorderTabInPanel，以及最大化态私有状态（maximizedPanelId / maximizeSnapshot）。
// 只依赖 core/* + ui + doc-model + 下游模块（render / lifecycle / deps），
// 对 main.ts 零反向依赖。与 render / lifecycle 形成（运行期安全的）循环引用。

import {
  tabs,
  docs,
  panels,
  layout,
  activePanelId,
  setLayout,
  setActivePanelId,
  takePanelId,
  setSuppressDirty,
  settings,
} from "../core/app-state";
import { getPanel, activePanel, panelOfTab } from "../core/panels";
import {
  countLeaves,
  maximizePanel,
  restoreRatios,
  cloneTree,
  siblingLeafOf,
  splitPanelAt,
  splitPanel as treeSplitPanel,
  type MaximizeSnapshot,
  type LayoutNode,
} from "../core/layout";
import {
  makeDoc,
  makeInstance,
  registerDoc,
  attachTabToPanel,
  panelIdsInOrder,
} from "../doc-model";
import { updateTocDrawer } from "../toc";
import { markActivePanel, refreshAll, refreshTitle, refreshStatus, showMessage } from "../ui";
import { logger } from "../core/logger";
import { retargetFindBar } from "../find/findbar";
import { keyHint } from "../prefs";
import { newTab as ipcNewTab } from "../ipc/api";
import { markProgrammatic } from "../core/scroll-guard";
import { renderPanelTabs } from "./render";
import { rebuildLayout, disposePanel, freshTextOfDoc, pruneEmptyPanels } from "./lifecycle";
import { scheduleSessionSave } from "./deps";

/**
 * 最大化中的面板 id；null = 没有。
 *
 * 最大化**只改比例**（沿路径推到 0/1），不动树结构、不销毁面板：
 * 标签、编辑器实例、会话全都照旧，只是被挤的那一侧渲染成 0 宽（见
 * `.layout-panel-collapsed`，`.layout-panel` 有 min-width: 120px，只推比例收不掉）。
 */
export let maximizedPanelId: number | null = null;
/** 最大化前的各层比例快照（路径 + 原比例），用于原样还原。 */
export let maximizeSnapshot: MaximizeSnapshot | null = null;

/** 在指定面板旁分屏，新面板沿用当前活动标签。 */
export function splitActivePanel(panelId: number, dir: "h" | "v"): void {
  const panel = getPanel(panelId);
  if (!panel) return;
  exitMaximize(); // 同 splitPanelWithTab：最大化态下不先还原就会分出 0 宽的新面板
  const newId = takePanelId();
  setLayout(treeSplitPanel(layout, panelId, dir, newId));
  const currentTabId = panel.activeTabId;
  const tab = tabs.get(currentTabId);
  panels.set(newId, {
    panelId: newId,
    tabs: [],
    activeTabId: -1,
    view: null,
    viewTabId: null,
    preview: null,
    previewTimer: null,
    bodyEl: null,
  });
  if (tab) {
    tab.panelId = newId;
    const p = panels.get(newId)!;
    p.tabs.push(tab.tabId);
    p.activeTabId = tab.tabId;
    // 原面板移除该标签，激活相邻
    panel.tabs = panel.tabs.filter((id) => id !== currentTabId);
    if (panel.tabs.length > 0) {
      panel.activeTabId = panel.tabs[panel.tabs.length - 1];
      const prev = tabs.get(panel.activeTabId);
      if (panel.view && prev) {
        // 同 switchTab（B146）：CM6 的 setState 会归零 / 重排 scrollTop，那一发若不标记
        // 会被当成用户滚动落进记录。`viewTabId` 先认下接班标签（否则记到被移走那张头上），
        // 换文档前先标程序来源，`restoreViewScroll` 的 `pinScrollTop` 继续标覆盖补钉回执。
        panel.viewTabId = prev.tabId;
        const view = panel.view; // 闭包里不保留对 `panel.view` 的收窄，先取一份
        markProgrammatic(view.view.scrollDOM);
        setSuppressDirty(true);
        view.setState(prev.state);
        setSuppressDirty(false);
      }
    } else {
      // 原面板空了：清悬挂引用，同步一个新标签过去（异步完成后重建挂载视图）
      panel.activeTabId = -1;
      void (async () => {
        const info = await ipcNewTab(settings?.default_encoding ?? "UTF-8");
        const doc = makeDoc(
          info.tabId,
          "",
          info.name,
          null,
          settings?.default_encoding ?? info.encoding,
          settings?.default_eol ?? info.eol,
          info.readonly,
        );
        registerDoc(doc);
        const t = makeInstance(doc, panel.panelId, "");
        attachTabToPanel(t, panel);
        rebuildLayout();
        refreshAll();
      })();
    }
  }
  setActivePanelId(newId);
  rebuildLayout();
  refreshAll();
}

/** 把标签移入目标面板（追加为最后一个标签）。源面板清空且非唯一时一并移除。
 *  copy=true 时改为同源复制：源面板不动，目标面板获得该文档的新实例。 */
export function moveTabToPanel(tabId: number, hostId: number, copy = false): void {
  if (copy) {
    duplicateTabToPanel(tabId, hostId);
    return;
  }
  const tab = tabs.get(tabId);
  const src = panelOfTab(tabId);
  const host = getPanel(hostId);
  if (!tab || !src || !host || src.panelId === hostId) return;
  // 最大化时把标签挪到「看不见的那一侧」等于让它凭空消失 → 先还原再挪
  exitMaximize();
  src.tabs = src.tabs.filter((id) => id !== tabId);
  tab.panelId = hostId;
  host.tabs.push(tabId);
  host.activeTabId = tabId;
  if (activePanelId === src.panelId) setActivePanelId(hostId);
  if (src.tabs.length === 0 && countLeaves(layout) > 1) {
    disposePanel(src.panelId);
  } else {
    if (src.tabs.length > 0) src.activeTabId = src.tabs[src.tabs.length - 1];
    rebuildLayout();
    refreshAll();
  }
}

/**
 * 布局树叶子的面板 id（深度优先、左→右），作为「上一个 / 下一个面板」的稳定顺序。
 *
 * 网格布局里「相邻」没有唯一答案，所以走**叶子顺序**而不是几何位置：
 * 它与分屏树一致、顺序稳定，环状回绕后也总能回到起点。
 */

/** 把活动标签移到「下一个 / 上一个」面板（VS Code: Move Editor into Next/Previous Group）。 */
export function moveActiveTabByDelta(delta: number): void {
  const panel = activePanel();
  if (!panel || panel.activeTabId < 0) return;
  const ids = panelIdsInOrder();
  if (ids.length < 2) return;
  const i = ids.indexOf(panel.panelId);
  if (i < 0) return;
  moveTabToPanel(panel.activeTabId, ids[(i + delta + ids.length) % ids.length]);
}

/** 切换活动面板焦点（F6 / Shift+F6；VS Code 的 F6 就是「下一个窗格」）。 */
export function focusPanelByDelta(delta: number): void {
  const ids = panelIdsInOrder();
  if (ids.length < 2) return;
  const i = ids.indexOf(activePanelId);
  if (i < 0) return;
  const next = ids[(i + delta + ids.length) % ids.length];
  // 与「点面板」走同一套收尾（见 renderSplitview 的 onActivatePanel）：
  // 标题 / 状态栏 / 大纲 / 查找栏的目标都跟着活动面板走，少一个就会残留上一份文档。
  markActivePanel(next);
  refreshTitle();
  refreshStatus();
  updateTocDrawer();
  panels.get(next)?.view?.focus();
  retargetFindBar();
}

/**
 * 取消最大化：把比例还原回去，**不重绘**（调用方负责）。
 *
 * 任何改布局的操作（分屏 / 关面板 / 拖分隔条 / 把标签挪到别的面板）前都要先调它：
 * 最大化下的比例是 0/1，直接在上面改结构会得到「一半是 0 宽」的怪布局，
 * 而且还原快照的路径也会失效。先还原再改，用户看到的始终是真实布局。
 */
export function exitMaximize(): void {
  if (maximizedPanelId === null || !maximizeSnapshot) return;
  restoreRatios(layout, maximizeSnapshot);
  maximizedPanelId = null;
  maximizeSnapshot = null;
}

/** 最大化 / 还原某个面板（默认活动面板）。已在最大化态时一律还原。 */
export function toggleMaximizePanel(panelId: number = activePanelId): void {
  if (maximizedPanelId !== null) {
    exitMaximize();
    rebuildLayout();
    scheduleSessionSave();
    return;
  }
  if (countLeaves(layout) < 2) return; // 只有一个面板：无事可做（快捷键也不该抢键）
  const snap = maximizePanel(layout, panelId);
  if (!snap) return;
  maximizedPanelId = panelId;
  maximizeSnapshot = snap;
  markActivePanel(panelId);
  rebuildLayout();
  // 另一侧被挤成 0，必须明确告诉用户怎么回来（操作栏那个「还原」按钮是第二条退路）
  const hint = keyHint("panel.toggleMaximize");
  showMessage(hint ? `已最大化该面板，${hint} 还原` : "已最大化该面板");
  scheduleSessionSave();
}

/** 会话里存**未最大化**的比例：0/1 存进 session 会让下次启动只剩一块面板。 */
export function layoutForSession(): LayoutNode {
  if (maximizedPanelId === null || !maximizeSnapshot) return layout;
  const c = cloneTree(layout);
  restoreRatios(c, maximizeSnapshot);
  return c;
}

/**
 * B71 整组拖拽：把 src 面板的**全部标签**搬到目标面板旁的新分屏位置。
 *
 * 与「拖单个标签到边缘」的区别是源面板整体消失（而不是留下一个空面板），
 * 所以这里不能复用 splitPanelWithTab —— 它只搬一个标签，源面板空了才顺手摘除。
 */
export function moveGroupToPanel(
  srcId: number,
  targetId: number,
  dir: "h" | "v",
  newFirst: boolean,
): void {
  const src = getPanel(srcId);
  if (!src || srcId === targetId || countLeaves(layout) < 2) return;
  exitMaximize();
  const newId = takePanelId();
  const moved = [...src.tabs];
  panels.set(newId, {
    panelId: newId,
    tabs: moved,
    activeTabId: src.activeTabId,
    view: null,
    viewTabId: null,
    preview: null,
    previewTimer: null,
    bodyEl: null,
  });
  for (const id of moved) {
    const t = tabs.get(id);
    if (t) t.panelId = newId;
  }
  src.tabs = [];
  src.activeTabId = -1;
  setLayout(splitPanelAt(layout, targetId, dir, newId, newFirst));
  setActivePanelId(newId);
  // 源面板已空 → 摘除（内部会 rebuild + refreshAll）
  disposePanel(srcId);
}

/** 取文档当前最新文本：优先回写活动实例的视图快照，否则任一实例快照。 */
export function duplicateTabToPanel(tabId: number, hostPanelId: number): void {
  const src = tabs.get(tabId);
  const doc = src ? docs.get(src.docId) : undefined;
  const host = getPanel(hostPanelId);
  if (!src || !doc || !host) return;
  const text = freshTextOfDoc(doc);
  if (text === null) return;
  const inst = makeInstance(doc, hostPanelId, text);
  inst.viewMode = src.viewMode;
  const sel = src.state.selection.main;
  inst.state = inst.state.update({ selection: { anchor: sel.anchor, head: sel.head } }).state;
  attachTabToPanel(inst, host);
  setActivePanelId(hostPanelId);
  rebuildLayout();
  refreshAll();
  scheduleSessionSave();
}

/** 同源复制到视觉相邻面板（左右分屏对照源码/预览的快捷入口）。 */
export function duplicateTabToSibling(tabId: number): void {
  const src = panelOfTab(tabId);
  if (!src) return;
  const sibId = siblingLeafOf(layout, src.panelId);
  if (sibId === null) return;
  duplicateTabToPanel(tabId, sibId);
}

/** 拖拽标签到目标面板某区域：在目标旁分屏出新面板并放入该标签。
 *  copy=true 时新面板获得同源新实例，源面板不动。 */
export function splitPanelWithTab(
  targetId: number,
  dir: "h" | "v",
  tabId: number,
  newFirst: boolean,
  copy = false,
): void {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const doc = docs.get(tab.docId);
  if (!doc) return;
  // 最大化态下分屏会得到「一半 0 宽」的怪布局 → 先还原再分（见 exitMaximize）
  exitMaximize();

  if (copy) {
    // 同源复制分屏：回写源实例快照（按视图实际显示的实例判定，防止串档）
    const srcPanel = panels.get(tab.panelId);
    if (srcPanel?.view && srcPanel.viewTabId === tab.tabId) {
      tab.state = srcPanel.view.view.state;
    }
    const inst = makeInstance(doc, -1, tab.state.doc.toString());
    inst.viewMode = tab.viewMode;
    const sel = tab.state.selection.main;
    inst.state = inst.state.update({ selection: { anchor: sel.anchor, head: sel.head } }).state;
    const newId = takePanelId();
    inst.panelId = newId;
    panels.set(newId, {
      panelId: newId,
      tabs: [inst.tabId],
      activeTabId: inst.tabId,
      view: null,
      viewTabId: null,
      preview: null,
      previewTimer: null,
      bodyEl: null,
    });
    tabs.set(inst.tabId, inst);
    // ⚠️⚠️ **B261**：复制出来的这一份是**空档实例**（`makeInstance` ⇒ `scrollTop: null`，
    //    编辑器视口 scrollTop 恒 0），而下面 `refreshAll()` 尾那趟 `pushSyncToSiblings` 是以
    //    **它**（此刻的活动标签）为源往外推的 —— 源没有位置，`syncSourceV` 只能退读 DOM
    //    ⇒ 推出 `v = 1`（文档开头）⇒ 同文档的**原标签**被 `applySyncToSibling` 记成
    //    `top = 0` 并钉进 DOM ⇒ 用户报的「新建分屏时原标签内滚动位置出现变化（顶到 0）」。
    //    与 B254 / B259 同型：**「位置归零（或从没存在过）的那一瞬间产生的推播，不能拿它
    //    当源坐标」**。三方入口（右键分屏 / Alt+Shift+方向键 / Ctrl 拖拽复制）都直接调这里，
    //    只有 `openPreviewToSide` 在外面夹了 `suppressSyncPush` ⇒ 同一条病根只在「开侧边
    //    预览」上被挡住，在别处照旧发作（用户：两个问题都还在）。
    //
    //    ⚠️ 上面那句「落位排在 `rebuildLayout()` 之前」的**结论已被第四轮推翻**（见下面
    //       那一大段）：分屏那一刻左栏立刻**变窄**、编辑器重排 ⇒ 必须**之后**落。
    //
    setLayout(splitPanelAt(layout, targetId, dir, newId, newFirst));
    setActivePanelId(newId);
    rebuildLayout();
    refreshAll();
    scheduleSessionSave();
    return;
  }

  const src = panelOfTab(tabId);
  if (!src) return;
  // ⚠️⚠️⚠️ **B264（用户：同文件 2 个标签、初始未分屏，把其中一个标签**拖**成第二个分屏
  //    ⇒ 滚动位置偏移、且两个标签滚动位置出现差异）—— 这里补的不是「再打一针」，是
  //    copy 支那半套**本来就该在 move 支上也有一份**的东西。**
  //
  //    病型（与 B254 / B261 同族，但病位在**这里**，两边症状叠加）：
  //    ① **游标采错了锚**。单栏里只有一个宿主，同文档的「源码标签 + 预览标签」只能
  //       亮一个 —— 拖走的那份（本例预览标签 tab2）此刻是**离屏**的，屏幕上真在滚的是
  //       另一份（源码标签 tab1，槽里 px=100）。照抄 copy 支那句 `syncSourceV(tab)`
  //       采的是**被拖那份的隐藏侧**（预览离屏 ⇒ 0 ⇒ v=1），把这个假游标当成分屏后
  //       两格的共同落点 ⇒ 老那一格被钉回文档开头（桩实测：100 ⇒ 0，会话落盘 `0|0`，
  //       即**永久**丢了，不只是闪一下）。
  //    ② **没有「按新几何重落」**。分屏那一刻老栏从整宽变半宽 ⇒ word_wrap 重排 ⇒
  //       `rebuildLayout → restoreViewScroll` 拿槽里**旧像素**去钉**新几何**的编辑器
  //       ⇒ 跨几何的旧像素是另一行。copy 支有 `vCopy` + 两格 `landOnFrameGeometry`
  //       兜住，move 支一个都没有 ⇒ 分离的那半病就只在这里发作。
  //
  const newId = takePanelId();
  panels.set(newId, {
    panelId: newId,
    tabs: [tabId],
    activeTabId: tabId,
    view: null,
    viewTabId: null,
    preview: null,
    previewTimer: null,
    bodyEl: null,
  });
  const rest = src.tabs.filter((id) => id !== tabId);
  src.tabs = rest;
  tab.panelId = newId;
  setLayout(splitPanelAt(layout, targetId, dir, newId, newFirst));
  setActivePanelId(newId);

  if (src.tabs.length === 0 && countLeaves(layout) > 1 && src.panelId !== targetId) {
    logger.trace("tabs", `拖拽(分屏) · 源面板 ${src.panelId} 被拖空 ⇒ disposePanel tab=${tabId}`);
    // 源面板已空且非唯一：移交给 disposePanel 统一摘除（会再次 rebuild）
    disposePanel(src.panelId);
  } else {
    if (src.tabs.length > 0) src.activeTabId = src.tabs[src.tabs.length - 1];
    else src.activeTabId = -1;
    // B90：**同面板**分屏把唯一标签挪走后，原面板就空了 —— 以前这里留着一个空框。
    // 交给 pruneEmptyPanels 统一摘掉（摘掉后新面板正好落在原位置，等价于「没动」）。
    if (!pruneEmptyPanels()) {
      rebuildLayout();
      refreshAll();
    }
  }
}

/** 拖拽标签落点：center 为移入（跨面板）或排序（同面板落在其他标签上）；
 *  left/right/top/bottom 边缘一律分屏——同面板边缘拖拽也分屏（与落点预览一致）。
 *  copy（按住 Ctrl 拖拽）时全部改为同源复制。 */
export function onDropTabToPanel(
  tabId: number,
  targetPanelId: number,
  zone: "left" | "right" | "top" | "bottom" | "center",
  overTabId: number | null,
  copy = false,
): void {
  const src = panelOfTab(tabId);
  if (!src) return;
  if (!copy && src.panelId === targetPanelId) {
    // 同面板：落在其他标签上 = 排序到该位置；其余边缘区域 = 按方向分屏
    if (overTabId && overTabId !== tabId) {
      reorderTabInPanel(targetPanelId, tabId, overTabId);
      return;
    }
    if (zone === "center") return;
    const dir = zone === "left" || zone === "right" ? "h" : "v";
    const newFirst = zone === "left" || zone === "top";
    splitPanelWithTab(targetPanelId, dir, tabId, newFirst, false);
    return;
  }
  if (zone === "center") {
    moveTabToPanel(tabId, targetPanelId, copy);
    return;
  }
  const dir = zone === "left" || zone === "right" ? "h" : "v";
  const newFirst = zone === "left" || zone === "top";
  splitPanelWithTab(targetPanelId, dir, tabId, newFirst, copy);
}

/** 面板内标签排序（from 移动到 to 的位置）。 */
export function reorderTabInPanel(panelId: number, from: number, to: number): void {
  const p = getPanel(panelId);
  if (!p) return;
  const fi = p.tabs.indexOf(from);
  const ti = p.tabs.indexOf(to);
  if (fi < 0 || ti < 0) return;
  p.tabs.splice(fi, 1);
  p.tabs.splice(p.tabs.indexOf(to) + (fi < ti ? 1 : 0), 0, from);
  renderPanelTabs(panelId);
  scheduleSessionSave();
}

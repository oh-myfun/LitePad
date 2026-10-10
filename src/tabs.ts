// 标签 / 面板 / 布局操作（从 main.ts 拆出，解耦第八步）。
//
// 职责：标签操作（switchTab / closeTabById / 移动 / 复制 / 分屏拖拽）、面板最大化、
// 标签栏与操作区渲染（renderPanelTabs / renderPanelOps）、布局树重建（rebuildLayout）。
// 只依赖 core/* + sync-scroll + ui + shell/* + doc-model，对 main.ts 零反向依赖。
//
// ⚠️ 过渡期 DI：本模块会调用尚未拆出的下游模块函数（session / markdown / find / io /
//    multiwindow / image-paste），经 installTabDeps 在启动时注入（TabDeps）。
//    等 #410–#415 各模块拆出后，逐个换成直接 import 并删掉对应 ref —— 注释里标了去向。

import {
  type Doc,
  type Panel,
  type Tab,
  tabs,
  docs,
  panels,
  layout,
  activePanelId,
  settings,
  windowKind,
  loanedDocIds,
  unmeasuredPanels,
  setLayout,
  setActivePanelId,
  setNextPanelId,
  setSuppressDirty,
  setSuppressSyncPush,
  takePanelId,
} from "./core/app-state";
import { activeTab, activePanel, getPanel, panelOfTab, docOf, instancesOfDoc } from "./core/panels";
import {
  pushSyncToSiblings,
  restoreViewScroll,
  restorePreviewScroll,
  rememberViewScroll,
  measureAndKeepScroll,
  reassertViewScroll,
  syncSourceV,
  flushPendingSyncCursor,
  alignShownToSyncSource,
  landOnFrameGeometry,
  landPreviewAtSource,
  syncSourceSnapshot,
  topVisibleLineFrac,
} from "./sync-scroll";
import {
  showMessage,
  markActivePanel,
  refreshAll,
  updatePositionOf,
  layoutArea,
  refreshStatus,
  refreshTitle,
  broadcastDocPresence,
} from "./ui";
import { renderTabstrip, type TabViewData, type TabstripCallbacks } from "./shell/tabstrip";
import { renderSplitview, refreshPanelOps, type PanelRenderData } from "./shell/splitview";
import {
  attachTabToPanel,
  makeDoc,
  makeInstance,
  registerDoc,
  isMdTab,
  panelIdsInOrder,
} from "./doc-model";
import { applyPanelMode, openPreviewToSide, toggleViewMode } from "./markdown";
import { updateTocDrawer } from "./toc";
import { attachUserScrollClear, isProgrammatic, markProgrammatic } from "./scroll-guard";
import { closeTab as ipcCloseTab, newTab as ipcNewTab } from "./ipc/api";
import { invoke } from "@tauri-apps/api/core";
import { showSaveConfirmDialog } from "./shell/saveconfirm";
import { createEditor } from "./editor/editor";
import { PreviewPane } from "./markdown/preview";
import { logViewport, recordScroll } from "./core/viewport";
import {
  countLeaves,
  leaf,
  type LayoutNode,
  cloneTree,
  maximizePanel,
  removePanel,
  restoreRatios,
  siblingLeafOf,
  splitPanelAt,
  splitPanel as treeSplitPanel,
  updateRatio,
  type MaximizeSnapshot,
} from "./shell/layout";

/** 过渡期依赖注入（见文件头注释）。main 在启动时调用一次 installTabDeps。 */
export interface TabDeps {
  scheduleSessionSave(): void; // → src/session/（#412）
  retargetFindBar(): void; // → src/find/（#413）
  applyPanelMode(panel: Panel): void; // → src/markdown.ts（#410）
  toggleViewMode(target?: Tab): void; // → src/markdown.ts（#410）
  openPreviewToSide(panelId: number): void; // → src/markdown.ts（#410）
  attachPasteHandler(panel: Panel): void; // → src/image-paste/（#416）
  openTabsInNewWindow(tabIds: number[]): Promise<void>; // → src/multiwindow/（#415）
  returnTabToMain(tabId: number): void; // → src/multiwindow/（#415）
  requestSatelliteClose(): void; // → src/multiwindow/（#415）
  saveDocCore(doc: Doc, inst: Tab, forceDialog: boolean): Promise<boolean>; // → src/io/（#414）
  discardBackupFor(doc: Doc): void; // → src/session/（#412）
  docHeldElsewhere(docId: number, waitMs?: number): Promise<boolean>; // → src/multiwindow/（#415）
  keyHint(id: string): string; // → 随命令/菜单拆分（#416）
}

let scheduleSessionSaveRef: TabDeps["scheduleSessionSave"] = () => {};
let retargetFindBarRef: TabDeps["retargetFindBar"] = () => {};
let attachPasteHandlerRef: TabDeps["attachPasteHandler"] = () => {};
let openTabsInNewWindowRef: TabDeps["openTabsInNewWindow"] = async () => {};
let returnTabToMainRef: TabDeps["returnTabToMain"] = () => {};
let requestSatelliteCloseRef: TabDeps["requestSatelliteClose"] = () => {};
let saveDocCoreRef: TabDeps["saveDocCore"] = async () => false;
let discardBackupForRef: TabDeps["discardBackupFor"] = () => {};
let docHeldElsewhereRef: TabDeps["docHeldElsewhere"] = async () => false;
let keyHintRef: TabDeps["keyHint"] = (id) => id;

export function installTabDeps(deps: TabDeps): void {
  scheduleSessionSaveRef = deps.scheduleSessionSave;
  retargetFindBarRef = deps.retargetFindBar;
  attachPasteHandlerRef = deps.attachPasteHandler;
  openTabsInNewWindowRef = deps.openTabsInNewWindow;
  returnTabToMainRef = deps.returnTabToMain;
  requestSatelliteCloseRef = deps.requestSatelliteClose;
  saveDocCoreRef = deps.saveDocCore;
  discardBackupForRef = deps.discardBackupFor;
  docHeldElsewhereRef = deps.docHeldElsewhere;
  keyHintRef = deps.keyHint;
}

function renderPanelTabs(onlyPanelId?: number): void {
  for (const p of panels.values()) {
    if (onlyPanelId !== undefined && p.panelId !== onlyPanelId) continue;
    const strip = layoutArea.querySelector<HTMLElement>(
      `.layout-panel[data-panel-id="${p.panelId}"] .panel-tabstrip`,
    );
    if (!strip) continue;
    renderTabstrip(strip, tabViewDataOf(p), tabstripCallbacks(p));
  }
}

function tabViewDataOf(p: Panel): TabViewData[] {
  return p.tabs
    .map((id) => tabs.get(id))
    .filter((t): t is Tab => !!t)
    .map((t) => {
      const doc = docs.get(t.docId);
      return {
        tabId: t.tabId,
        name: doc?.name ?? "?",
        dirty: doc?.dirty ?? false,
        readonly: doc?.readonly ?? false,
        active: t.tabId === p.activeTabId,
        // B57：标签类型图标按语言选字形/配色；langLabel 由 detectLanguage 维护，
        // 改名、重载编码时都会同步（见 rebuildDocInstances / 另存为分支）。
        lang: doc?.langLabel,
        path: doc?.path ?? undefined,
        hasSibling: countLeaves(layout) > 1,
      };
    });
}

/** 面板标签栏交互回调（激活/关闭/右键菜单/拖拽排序/双击新建）。 */
function tabstripCallbacks(p: Panel): TabstripCallbacks {
  return {
    onActivate: (tabId) => switchTab(p.panelId, tabId),
    onClose: (tabId) => void closeTabById(tabId),
    onCloseOther: (tabId) => {
      const ids = p.tabs.filter((id) => id !== tabId);
      void closeTabsSequentially(ids);
    },
    onCloseRight: (tabId) => {
      const idx = p.tabs.indexOf(tabId);
      const ids = p.tabs.slice(idx + 1);
      void closeTabsSequentially(ids);
    },
    onCopyPath: (tabId) => {
      const t = tabs.get(tabId);
      const doc = t && docs.get(t.docId);
      if (doc?.path) {
        void navigator.clipboard.writeText(doc.path);
        showMessage(`已复制路径：${doc.path}`);
      }
    },
    // B123-7：在资源管理器中打开文件所在目录并选中该文件
    onRevealInFolder: (tabId) => {
      const t = tabs.get(tabId);
      const doc = t && docs.get(t.docId);
      if (doc?.path) void invoke("reveal_in_folder", { path: doc.path });
    },
    onDuplicateTab: (tabId) => duplicateTabToPanel(tabId, p.panelId),
    onDuplicateToSibling: (tabId) => duplicateTabToSibling(tabId),
    // 左右 / 上下分屏：**复制**而非移动（与 VS Code 一致 —— Split 是同一文档开两份，
    // 移动另有 "Move Editor into Next Group"）。用 copy=true 也顺带避开了
    // splitPanelWithTab 在「源面板只剩这一个标签」时留下空面板的问题。
    onSplitH: (tabId) => splitPanelWithTab(p.panelId, "h", tabId, false, true),
    onSplitV: (tabId) => splitPanelWithTab(p.panelId, "v", tabId, false, true),
    // 双击标签 = 最大化/还原。仅多面板时给（单面板给了就是个永远没反应的手势）。
    onToggleMaximize: countLeaves(layout) > 1 ? () => toggleMaximizePanel(p.panelId) : undefined,
    // B71 ④：把标签交给新窗口。主窗口与卫星窗口都可用 —— 卫星窗口里再开一个窗口，
    // 对用户来说就是「再拎出去一份」，没有理由禁止。
    onOpenInNewWindow: (tabId) => void openTabsInNewWindowRef([tabId]),
    onReturnToMain: windowKind === "satellite" ? (tabId) => returnTabToMainRef(tabId) : undefined,
    onReorder: (from, to) => {
      const fi = p.tabs.indexOf(from);
      const ti = p.tabs.indexOf(to);
      if (fi < 0 || ti < 0) return;
      p.tabs.splice(fi, 1);
      p.tabs.splice(p.tabs.indexOf(to) + (fi < ti ? 1 : 0), 0, from);
      renderPanelTabs(p.panelId);
      scheduleSessionSaveRef();
    },
    onNew: () => void newUntitled(),
  };
}

/**
 * 面板渲染快照（B224 起含 Markdown 键的显隐 / 字形标记）。
 * `rebuildLayout`（整树重建）与 `renderPanelOps`（只刷操作区）共用这一份口径 ——
 * 两边各写一遍必然漂移，操作区那两颗键就会跟标签条各说各话。
 */
function panelDataOf(p: Panel): PanelRenderData {
  // md 两颗键只给**活动面板**（用户拍定，对齐 VS Code 的 editor/title 动作只出现在
  // 活动组）：非活动面板不给 md 标记，splitview 那边就一颗都不建。
  const act = p.panelId === activePanelId ? activeTab() : undefined;
  const md = !!act && isMdTab(act);
  return {
    panelId: p.panelId,
    active: p.panelId === activePanelId,
    tabs: tabViewDataOf(p),
    // B161：卫星窗口唯一的面板**可以**关 —— 关面板 = 关窗（B188 起不再把标签交回主窗口，
    // 文档由主窗口那份隐藏实例接着管，未保存内容靠热退出副本兜住）。主窗口仍然不许关唯一
    // 面板（关了就没地方放标签）。
    canClose: countLeaves(layout) > 1 || windowKind === "satellite",
    closeDetail:
      windowKind === "satellite" && countLeaves(layout) <= 1
        ? "关闭该子窗口（其中的文件不会交回主窗口）"
        : undefined,
    // B71：被最大化挤扁的一侧要真的收成 0（CSS 里 .layout-panel 有 min-width）
    maximized: maximizedPanelId === p.panelId,
    collapsed: maximizedPanelId !== null && maximizedPanelId !== p.panelId,
    // B224：标签区右侧那两颗 Markdown 键。mdPreview 决定切换键的字形与文案。
    md,
    mdPreview: md && act!.viewMode === "preview",
  };
}

/** 只重建各面板的操作区（B224）：md 两颗键跟着活动面板与视图模式走，
 *  标签条与编辑器都不动（重建标签条会销毁光标下的 `.tab`，见 markActivePanel）。 */
function renderPanelOps(onlyPanelId?: number): void {
  for (const p of panels.values()) {
    if (onlyPanelId !== undefined && p.panelId !== onlyPanelId) continue;
    refreshPanelOps(p.panelId, panelDataOf(p));
  }
}

/** 顺序关闭一组标签（跳过被用户取消的）。 */
async function closeTabsSequentially(ids: number[]): Promise<void> {
  for (const id of ids) {
    if (!tabs.has(id)) continue; // 可能已被前面的关闭连带处理
    await closeTabById(id);
  }
}

// ---------------------------------------------------------------- 布局渲染

/** 结构变化后全量重建布局区（面板 view 销毁重建，状态都在 Tab 快照里）。 */
function rebuildLayout(): void {
  // 同步所有面板的当前 view 状态到标签快照。
  // 必须按 viewTabId（视图实际显示的实例）回写：调用方可能已改 activeTabId
  // 而视图仍显示旧标签——按 activeTabId 回写会把旧文档串进新活动标签。
  for (const p of panels.values()) {
    if (p.view) {
      const shown = p.viewTabId !== null ? tabs.get(p.viewTabId) : undefined;
      if (shown) shown.state = p.view.view.state;
      rememberViewScroll(p);
      p.view.view.destroy();
      p.view = null;
      p.viewTabId = null;
    }
  }

  const data = new Map<number, PanelRenderData>();
  for (const p of panels.values()) {
    data.set(p.panelId, panelDataOf(p));
  }

  renderSplitview(layoutArea, layout, data, {
    onActivatePanel: (panelId) => {
      // 由面板 mousedown 触发。注意：这里绝不能重绘标签条——
      // 重绘会销毁光标下的 .tab，click 永远不会落在原元素上
      // （同面板点标签、跨面板点标签"要点两下"都是这么来的）。
      // 焦点面板的视觉走 class 切换（markActivePanel），同样不重建 DOM。
      const changed = activePanelId !== panelId;
      markActivePanel(panelId);
      if (!changed) {
        // 幂等兜底（B33）：即使面板没变也要刷大纲——桌面实测存在
        // activePanelId 已是目标面板但大纲仍残留上一份文档的路径，
        // 早退会跳过清空。updateTocDrawer 幂等且开销小。
        updateTocDrawer();
        return;
      }
      refreshTitle();
      refreshStatus();
      // 大纲跟随**活动面板**的活动文档：分屏下点另一块面板（文本 ↔ md）若不刷新，
      // 大纲会一直停在上一份 md 的大纲上（B23）。这里不重绘标签条（会吞掉 click）。
      updateTocDrawer();
      // B189：跨面板激活要把焦点给到目标面板的编辑区（用户原话「切激活标签只要把焦点
      // 给到对应编辑区就行」）。只 focus 一次不够：WebView2 在整次鼠标手势结束时会把焦点
      // 重新定到 body（同 B183 切标签那条），不延迟一拍补回、`cm-focused` 就被失焦兜底摘掉、
      // 光标一闪而过。这里与 switchTab 末尾同款处理，对抗同一类焦点被偷。
      const activatedView = getPanel(panelId)?.view;
      if (activatedView) {
        activatedView.focus();
        setTimeout(() => activatedView.focus(), 0);
      }
      retargetFindBarRef();
    },
    onActivateTab: (panelId, tabId) => switchTab(panelId, tabId),
    onCloseTab: (tabId) => void closeTabById(tabId),
    onClosePanel: (panelId) => void closePanelById(panelId),
    onRatioChange: (path, ratio) => {
      // 拖分隔条 = 用户要自己摆布局 → 退出最大化（否则快照与手摆的比例互相打架）
      exitMaximize();
      updateRatio(layout, path, ratio);
      scheduleSessionSaveRef();
    },
    onCloseOtherTab: (panelId, tabId) => {
      const p = getPanel(panelId);
      if (p) void closeTabsSequentially(p.tabs.filter((id) => id !== tabId));
    },
    onCloseRightTabs: (panelId, tabId) => {
      const p = getPanel(panelId);
      if (!p) return;
      const idx = p.tabs.indexOf(tabId);
      void closeTabsSequentially(p.tabs.slice(idx + 1));
    },
    onCopyTabPath: (tabId) => {
      const t = tabs.get(tabId);
      const doc = t && docs.get(t.docId);
      if (doc?.path) {
        void navigator.clipboard.writeText(doc.path);
        showMessage(`已复制路径：${doc.path}`);
      }
    },
    onDuplicateTab: (tabId) => {
      const inst = tabs.get(tabId);
      if (inst) duplicateTabToPanel(tabId, inst.panelId);
    },
    onDuplicateToSibling: (tabId) => duplicateTabToSibling(tabId),
    onReorderTab: (panelId, from, to) => reorderTabInPanel(panelId, from, to),
    // B71：右键「左右/上下分屏」与双击标签最大化（splitview 首次构建标签栏时也要有）
    onSplitTab: (panelId, tabId, dir) => splitPanelWithTab(panelId, dir, tabId, false, true),
    onToggleMaximizePanel: (panelId) => toggleMaximizePanel(panelId),
    onOpenTabInNewWindow: (tabId) => void openTabsInNewWindowRef([tabId]),
    onReturnTabToMain:
      windowKind === "satellite" ? (tabId) => returnTabToMainRef(tabId) : undefined,
    // B71：拖标签栏空白处 = 拖整组。并入 = 「关掉这个分屏但指定并入目标」
    onMergeGroup: (srcId, targetId) => closePanelById(srcId, targetId),
    onMoveGroupToPanel: (srcId, targetId, dir, newFirst) =>
      moveGroupToPanel(srcId, targetId, dir, newFirst),
    // 拖拽标签落在 tab 区：调整顺序（同面板）或移动到目标面板该位置（B27）
    onMoveTabToStrip: (panelId, tabId, beforeTabId) => moveTabToStrip(panelId, tabId, beforeTabId),
    onDropTabToPanel: (tabId, targetPanelId, zone, overTabId, copy) =>
      onDropTabToPanel(tabId, targetPanelId, zone, overTabId, copy),
    onNewTab: (panelId) => {
      markActivePanel(panelId);
      void newUntitled();
    },
    // B224：标签区右侧那两颗 Markdown 键（只在活动面板渲染，见 panelDataOf）
    onOpenPreviewToSide: (panelId) => openPreviewToSide(panelId),
    onTogglePreview: (panelId) => {
      // B228：先取**这颗键自己那一栏**的标签再切，别碰全局活动面板。
      // ⚠️ 以前这里是「面板不是活动的就先把活动面板拽过去，然后无参切换」两步 ——
      //    那等于把落点交给全局活动态：开侧边预览之后，DOM 里那颗键还带着左面板的
      //    panelId，一点就把左面板打开的文档切去源码（用户报的那条）。
      //    md 两颗键本就只挂在活动面板上，能点到 ⇒ 目标面板就是它自己，不需要再拽一次。
      const own = getPanel(panelId);
      const ownTab = own ? tabs.get(own.activeTabId) : undefined;
      if (!own || !ownTab) return;
      toggleViewMode(ownTab);
    },
    mountView: (panelId, hostEl) => {
      const p = getPanel(panelId);
      if (!p) return;
      const tab = tabs.get(p.activeTabId);

      // 编辑器 + 预览 双栏结构（空面板也创建，后续 switchTab 会填充）
      const editorEl = document.createElement("div");
      editorEl.className = "panel-editor";
      hostEl.appendChild(editorEl);
      p.bodyEl = hostEl;

      if (tab) {
        setSuppressDirty(true);
        p.view = createEditor(editorEl, tab.state);
        setSuppressDirty(false);
        p.viewTabId = tab.tabId;
        // B271：新建视图同样从估算行高起步（heightMap 要等第一帧 measure 才实测）
        unmeasuredPanels.add(p);
        // 同 switchTab：焦点先给、还原排在后面（focus 会把光标滚进视野，反过来就白钉了）
        if (panelId === activePanelId) p.view.focus();
        // B126：视图是新建的，滚动位置只活在标签快照里 → 显式还给 DOM
        restoreViewScroll(p);
      }

      const preview = new PreviewPane();
      p.preview = preview;
      hostEl.appendChild(preview.root);
      preview.setHost({
        topVisibleLine: () => {
          const v = p.view?.view;
          if (!v) return 1;
          // B175：跟随用**带行内比例的小数**（与 `pushSyncToSiblings` / 切模式交接取的坐标
          // 同口径，见 `topVisibleLineFrac`）。原来返回的整数行号 ⇒ 编辑器在一行内滚动时
          // 预览那份不动、跨行才跳一格，连续跟随就成了「卡一下、跳一下」的阶梯，看着就像
          // 「预览整页重渲染」（用户反复报的同步抖动）。⚠️ B257：整数档（`topVisibleLineOf`）
          //    整个删了 —— 切模式交接走同一条小数口径，取整数会留半个行高的残差。
          return topVisibleLineFrac(v);
        },
        scrollToLine: (line: number) => {
          const v = p.view?.view;
          if (!v) return;
          const l = v.state.doc.line(Math.min(Math.max(1, line), v.state.doc.lines));
          const top = v.lineBlockAt(l.from).top;
          v.scrollDOM.scrollTop = top;
          // B169/B170：预览驱动编辑器滚动属程序摆位（点 block 跳转 / 预览→编辑器跟随），
          // 其回执 scroll 必须被编辑器监听经 scroll-guard 标记吞掉 —— 否则这份没标记的位置
          // 会被当作用户滚动反推预览，预览再被推回编辑器，闭环成拉锯 / 抖动
          // （用户报的「非激活文档滚动抖」「预览跟随整文档重渲染」同源）。
          markProgrammatic(v.scrollDOM);
        },
        lineCount: () => p.view?.view.state.doc.lines ?? 0,
      });
      if (p.view) {
        const shownView = p.view.view;
        shownView.scrollDOM.addEventListener("scroll", () => {
          const t = p.viewTabId !== null ? tabs.get(p.viewTabId) : undefined;
          // ⚠️⚠️ **B271：对称的 B129 闸** —— 预览侧那条监听早有 `t.viewMode !== "preview"`
          //    ⇒ return，**编辑器侧漏了**。面板正显示纯预览标签时编辑器整格 `display:none`，
          //    此刻编辑器的 scroll 只可能是浏览器重置 / CM6 测量补偿 / 程序性扰动 —— 把
          //    编辑器像素写进预览标签的槽（那份槽的语义是**预览**像素，B129）再把它当源
          //    推给兄弟 = 用幽灵坐标污染全部分屏（金标准验证台 S9 实测：隐藏编辑器一发
          //    scroll ⇒ 同文档源码标签的挂起游标被毒成旧值，切回去整格停在旧位置，
          //    用户报的「反复修了很多轮还有问题」的最后一条病根）。
          //    mode-split（viewMode="split"）编辑器可见，照常记录与推播，不受此闸影响。
          if (!t || !isMdTab(t) || t.viewMode === "preview") return;
          // B170：程序钉位置的回执由 scroll-guard 标记认领、直接吞（见 src/scroll-guard.ts）：
          // 不比位置、不赌时序、不靠还原窗口，渲染扰动（setBlocks 归零再拉回、图片加载重排）
          // 也免疫。用户接管滚动时标记被清，随后的 scroll 才是真用户。
          if (isProgrammatic(shownView.scrollDOM)) return;
          // B126：滚动位置只活在 DOM 上，随滚动即时记进标签快照（赋值极廉价，
          // 不排程）。快照是与视图生命周期解耦的全局记录，所以「滚过但没切走就
          // 重建布局 / 销毁面板」也不会丢。
          if (t) {
            t.scrollTop = shownView.scrollDOM.scrollTop;
            recordScroll(t.tabId, t.scrollTop);
          }
          // B132：写进快照还不算数 —— 得落盘。滚动本身**不触发**任何排程，用户
          // 滚到中段、没干别的事就关窗，会话里留下的还是上一次（滚之前那份），
          // 重启就回到老位置（B132）。防抖 800ms：滚动停下才写，不会每帧落盘。
          scheduleSessionSaveRef();
          // B152 / B154：滚的是谁，谁就是源 —— 兄弟跟着同一个位置走。
          // ⚠️ 这里**不再**前置 `isSyncSource`：用户明确要求「窗口没有激活时，鼠标放在
          //    一个视口中也能滚动，这时同步滚动也要生效」（B154）。回环不是靠「只有
          //    激活的那份能当源」挡的，而是靠 scroll-guard 的 `isProgrammatic` 标记：
          //    程序钉位置的回执在更前面就被吞掉了，到不了这一路。
          // 排在排程之后：本条监听的活儿跟它是两件事，别为 B132 那条契约挤在一起。
          // B159：跨窗口那一路也在这里开 —— 「谁滚谁当源」在别的窗口同样算数。
          // ⚠️ 别把下面那句推同步的 `if (t) …` 包进新块里：好几条老契约认的就是
          //   它这一行的原样写法（B154 / B159），也别在注释里抄它的完整字面量 ——
          //   反向验证那条退化用的是字面量 replace，注释里出现同串会被先替换掉。
          if (t) pushSyncToSiblings(t, true);
          // B271：原尾部的 `preview.syncFromEditor()` 已删 —— `viewMode` 只有
          // "source" | "preview" 两档，那支只在**纯预览**（编辑器 display:none）时可达，
          // 正是上面新闸拦掉的幽灵路径；编辑器可见时预览跟随走别的水路（同面板分屏），
          // 这条监听里从来没有它的合法工况。
        });
        attachUserScrollClear(shownView.scrollDOM);
        attachPasteHandlerRef(p);
      }
      // B137：预览滚动和编辑器滚动是同一件事 —— 位置只活在 DOM 上，随滚动即时
      // 记进它**自己那份**快照（后台预览标签没有滚动事件，全靠这里补记）。
      // 同 B132：写完还得排程落盘，否则「滚过预览就关窗」留下的还是滚之前那份。
      preview.root.addEventListener("scroll", () => {
        const t = p.viewTabId !== null ? tabs.get(p.viewTabId) : undefined;
        if (!t || t.viewMode !== "preview") return;
        // B170：程序钉位置的回执由 scroll-guard 标记认领、直接吞（见 src/scroll-guard.ts），
        // 不写快照、不推兄弟；落盘排程照旧（位置本身没变）。渲染扰动（图片·公式增强二次
        // 定位、setBlocks 重排）也一并免疫。用户接管时标记被清。
        if (isProgrammatic(preview.root)) {
          scheduleSessionSaveRef();
          return;
        }
        // B154：与编辑器那侧同口径 —— **谁滚谁当源**，用户手指还在预览上、窗口也没
        //   激活，源码那份也要跟着走。
        // B159：预览侧这一路同样往外广播 —— 纯预览态那份就是它的源，别的窗口也该跟上。
        //
        // ⚠️ B240 二轮：**顺序与编辑器侧对齐（先写快照、后推兄弟）**。原先是反的
        //   （先 push 再 recordScroll），而 `pushSyncToSiblings` 取 px 读的是快照槽
        //   ⇒ 推给兄弟的是**上一次**的位置（实测真实 260 时只推出 100）。离屏兄弟
        //   的槽位被写进这个过期值，切过去就对不上（用户报的位置不一致）。
        //   编辑器侧那条监听一直是「先写后推」（见 mountView 里那段），别把它也翻过来。
        t.scrollTop = preview.root.scrollTop;
        recordScroll(t.tabId, t.scrollTop);
        pushSyncToSiblings(t, true);
        scheduleSessionSaveRef();
      });

      applyPanelMode(p);
      // 纯预览实例的视图位置在预览那一侧，渲染完再钉回去（B129）
      restorePreviewScroll(p);
      // CM6 测量（含它的滚动锚点补偿）排在下一帧，位置得在补偿之后收回来（B146）
      measureAndKeepScroll(p);
      if (panelId === activePanelId && p.view) {
        updatePositionOf(panelId, p.view.view);
      }
    },
  });
}

// updateRatio 已移到 src/shell/layout.ts（与 build 的路径约定对齐，B26 修复）

// ---------------------------------------------------------------- 标签操作

function switchTab(panelId: number, tabId: number): void {
  const panel = getPanel(panelId);
  if (!panel) return;
  // 面板未挂载（空面板补标签、会话恢复等）→ 全量重建后再走正常路径
  if (!panel.view || !panel.bodyEl) {
    panel.activeTabId = tabId;
    rebuildLayout();
    refreshAll();
    return;
  }
  // ⚠️ B232：早退判据必须看**视图实际显示的标签**（`viewTabId`），不是 `activeTabId`。
  // 下面 1398 行那句注释已经点明了这件事（「调用方可能已改 activeTabId 而视图仍显示
  // 旧标签」），但这条早退自己却按 `activeTabId` 判 —— 于是**调用方只要先改了
  // `activeTabId` 就会必然早退**，而早退发生在换文档**之前**。
  // 用户报的就是这个：右面板已有 json 时点「打开侧边预览」，调用方把 `activeTabId`
  // 指向新加的 md 标签再调本函数 ⇒ 早退 ⇒ 标签条显示 md、编辑器里还是 json，
  // 点「切换到源码」看到的就是 json。补 applyPanelMode 只能改 class、改不了内容。
  //
  // `viewTabId` 为 null（视图还没挂载）时不能早退 —— 那正是「该换文档」的状态。
  if (panel.viewTabId === tabId) return;
  // 旧 tab 快照写回：必须按视图实际显示的实例（viewTabId）寻址。
  // 调用方可能已改 activeTabId 而视图仍显示旧标签——按 activeTabId 回写
  // 会把视图当前内容写进错误的标签（内容串档/被覆写为空白的同源缺陷）。
  const shownTab = tabs.get(panel.viewTabId ?? panel.activeTabId);
  if (shownTab) shownTab.state = panel.view.view.state;
  // B126：setState 会重建 ViewState 并把视口拉回开头，采完这一眼再切换
  rememberViewScroll(panel);
  logViewport("切换 · 采旧位置后", panel);
  // B240 三轮：同步开着时，先把**源（刚显示的这一份）**的坐标就地采下来 —— 它马上要
  // 离屏，离屏之后就再也读不到它自己的实时 DOM 了（见下面 alignShownToSyncSource）。
  const syncSrc = syncSourceSnapshot(shownTab, tabId);
  const tab = tabs.get(tabId);
  if (!tab) return;
  panel.activeTabId = tabId;
  // ⚠️ 下面这三步（改 `viewTabId` → 换文档 → 还原）的顺序是 B146 二轮改出来的，
  // 别再随手调回去。CM6 的 `setState` 末尾是：
  //     if (hadFocus) this.focus();   // 换完文档自己把光标滚进视野
  //     this.requestMeasure();
  // 加上浏览器按**新内容长度**裁剪 scrollTop —— 换文档必然自己动一下 scrollTop 并
  // 派发 scroll。用户报的「切换标签，md 文档的滚动位置会不断往下移」就是这个：
  // 那几下滚动既不是用户造成的，`viewTabId` 当时还指着旧标签（守卫按它寻址），
  // 一不留神就被记成「用户停过的位置」。
  //   ① `viewTabId` **先于** setState 改：滚动监听靠它寻址，晚一步就记到旧标签头上；
  //   ② 换文档前先给编辑器标「程序来源」：CM6 的 `setState` 会把 scrollTop 归零再
  //      重排，那一发 scroll 若不标记就会被当成用户滚动、写进接班标签的记录（B134/B146）。
  //      `restoreViewScroll` 里的 `pinScrollTop` 也会继续标，覆盖随后的补钉回执。
  panel.viewTabId = tabId;
  const view = panel.view; // 闭包里不保留对 `panel.view` 的收窄，先取一份
  markProgrammatic(view.view.scrollDOM);
  setSuppressDirty(true);
  // ⚠️ B254：这一发 `setState` 把编辑器 scrollTop 归零并**同步**派发 update ⇒
  //    `handleUpdate` 那一轮拿到的源位置是 0，推兄弟等于把所有同文档预览钉回开头
  //    （「切标签后另一个预览向上偏移、之后永远不动」）。切标签的收口已经在上面
  //    `syncSourceSnapshot` 里采下源的真实位置，这一发推播没信息、只有害处。
  setSuppressSyncPush(true);
  view.setState(tab.state);
  setSuppressSyncPush(false);
  // B271：从这一刻到 measure 帧，heightMap 是估算行高 —— 换算窗口开启（见 unmeasuredPanels）
  unmeasuredPanels.add(panel);
  setSuppressDirty(false);
  // ⚠️ 焦点必须排在钉位置**之前**（B145）：`focus()` 会把光标滚进视野，而光标往往
  // 不在刚还原出来的可视区里 —— 排在后面等于把刚钉好的位置顶掉。
  view.focus();
  logViewport("切换 · 还原窗口内", panel);
  // B126：setState 重建了 ViewState 并把视口拉回开头，这里把滚动位置还回去。
  // ⚠️ 必须排在 applyPanelMode **之后**：applyPanelMode 才把 `mode-preview` 摘掉，而
  //   `.panel-host.mode-preview .panel-editor { display: none }`（styles/preview.css）
  //   ⇒ display:none 期间写 scrollTop 浏览器不认、class 一切还清零。
  applyPanelMode(panel);
  // B263：编辑器刚从 `display:none` 放出来 ⇒ 这一刻才量得准 —— 补写挂起的那手游标，
  //    ⚠️ 必须排在下面 `restoreViewScroll` **之前**：还原是读槽钉视口，补写晚一步就来不及。
  //    ⚠️ B270：此刻 heightMap 还是估算行高（setState 刚跑完、measure 还没来），这一趟
  //    换出来的是「估算空间」的像素 —— 只当**占位值**用（保 B263 语义），`keepPending`
  //    不删挂起；measure 完成后 `measureAndKeepScroll` 的 rAF 里按实测几何**再补一次**。
  flushPendingSyncCursor(panel, tabId, true);
  // applyPanelMode 已经让编辑器重新可见 ⇒ 这一趟还原**现在才钉得进去**。
  restoreViewScroll(panel);
  logViewport("切换 · 还原后", panel);
  // B181：类切完**再补一次焦点** —— 否则「从预览态的标签切走」之后编辑器没有焦点。
  //
  // ⚠️ 上面那次 `view.focus()` 排在 `applyPanelMode` **之前**，而 `mode-preview` 会把
  //    `.panel-editor` 设成 `display:none`（preview.css）—— 上一份标签是预览态时，
  //    那一刻编辑器还是隐藏的，对隐藏元素调 `contentDOM.focus()` **静默失败**：
  //    不报错、也不聚焦。等 `applyPanelMode` 把类切回 `mode-source`，编辑器可见了
  //    却没人聚焦 ⇒ 用户看到「光标消失了、按方向键没反应、得先点一下编辑区才能输入」。
  //
  // ⚠️ 那第一次 focus **不能删也不能挪**：它排在 `restoreViewScroll` 之前是 B145 的要求
  //    （焦点先把光标滚进视野，随后的钉位置才盖得住）。所以这里是**补第二次** ——
  //    此刻类已切好、编辑器可见，`focus()` 才真能拿到焦点。
  //    `focus()` 内部走 `focusPreventScroll`（`preventScroll: true`，拿不到就回滚滚动栈），
  //    不会把刚钉好的视口位置顶掉；已经聚焦过时它就是个空操作。
  view.focus();
  // ⚠️⚠️ **B274**：预览还原（`restorePreviewScroll`）从这儿挪到**收口之后** —— 见下面
  //    `alignShownToSyncSource` 后那一行。原位置在收口之前 ⇒ 切到预览标签时先被钉回
  //    **旧槽**（真机日志 04:04:28.142：视图先到 3014 = 上一轮的旧位置），下一拍才被
  //    收口修正到 2249 —— 765px 的"先错后跳"就是这么来的。
  logViewport("切换 · 预览还原前", panel);
  // B240 三轮：同步开着 ⇒ 切过去的位置由**源**给定（离屏那份算不出自己的位置，
  // 见 alignShownToSyncSource）。排在最后那次补焦点之后 —— 焦点会把光标滚进视野，
  // 排在它之前会被顶掉（B145 那套顺序纪律）。
  // ⚠️ B266：B265 已让两侧末行/末块都能滚到视口顶，两侧 floor 游标都 = 文档末行 `v`，
  //    自然上限不再错配，故不再需要「顶没顶上限」的 `atFloor` / `handoverV` 特判。
  //    收口直接用源的真实 `v`（由 `syncSourceSnapshot` 在离屏前采下）；必须排在
  //    预览还原**之后**（B274）—— 见下面那一行。
  const handV = tab ? syncSrc : null;
  const aligned = tab ? alignShownToSyncSource(panel, shownTab, handV) : false;
  // ⚠️⚠️ **B274**：纯预览实例的位置**排在收口之后**再钉（B130 的「必须排在
  //    `applyPanelMode` 之后」照样满足）。理由：收口（`applySyncToSibling` 的预览支）
  //    落位成功会 `recordScroll` 把**新落点写进槽** ⇒ 这里钉的就是同步后的位置；
  //    收口没落位（预览还没渲染 / 行号找不到块）时槽还是旧值 ⇒ 这里照旧兜底钉旧值。
  //    ⇒ 消除「先钉旧槽、下一拍再跳到同步位置」的中间态。
  restorePreviewScroll(panel);
  logViewport("切换 · 预览还原后", panel);
  // CM6 测量（含它的滚动锚点补偿）排在下一帧，位置得在补偿之后收回来（B146）
  measureAndKeepScroll(panel);
  logViewport("切换 · 测量收尾后", panel);
  if (panelId === activePanelId) {
    refreshTitle();
    refreshStatus();
    updateTocDrawer();
    // B152：切到新激活的那份之后，兄弟立刻按**新的源**对齐一次 —— 用户说得很明确：
    // 「切换激活文档时则根据新的激活文档进行同步」。同步状态本身不动（按钮不复位）。
    // 排在 refreshTitle 之后：显隐与点亮态在这一帧已经就绪。
    //
    // ⚠️ B241：没收口（同步关 / 源没位置）时才需要它补一次对齐 —— 推播会把「接班这份的
    //    落位值」写进兄弟（此刻正是源）的槽，跨侧换算每轮都不等值，照推就是把源也带歪
    //    （来回切换位置会变化）。
    //
    // ⚠️⚠️ **B258 补这一格**：收口（aligned）时**也不能整趟跳过**。收口只写**接班那一份**
    //    一个格子，而同一时刻可能还有其他分屏挂着**同文档的预览**；那一趟跳过的推播正是
    //    唯一能把兄弟按源坐标对齐的机会 ⇒ 兄弟永远停在「上一次被推到的值」上，与接班那
    //    份错位（用户报：预览滚到底 → 切源码 → 切回预览，只有这一格跟着走，其他分屏的
    //    预览没同步）。桩上实测 `左 882 / 右 966`（差 84px = 两个块高，日志里两趟的 `v`
    //    分别是 24 与 21 —— 源码那一格被自然上限裁过，真值回不来了）。
    //    ⇒ 收口生效时照样补推，但只推**其余兄弟**，且用 `syncSrc`（收口同一口径的那个
    //    `v`），保证兄弟与接班那一份落在同一个数上。
    //
    // ⚠️⚠️ **B266**：`handV` 就是 `syncSourceSnapshot` 在离屏前从**源**采的真实 `v`
    //    （B265 已让两侧末行/末块都能滚到视口顶，两侧 floor 游标都 = 文档末行 `v`，
    //    自然上限不再错配，故不再需要 B260 的 `handoverV` / `atFloor`「谁也不许被截小」特判）。
    //    落点照旧由 `applySyncToSibling` 按目标那侧的几何裁（裁的是 DOM 写入，不是记录值）。
    //    这一趟两分支都用它，保证「接班」与「其余兄弟」是同一个数（B258 的要求）。
    if (tab && !aligned) {
      pushSyncToSiblings(tab, false, { v: handV });
    } else if (tab && handV !== null && shownTab) {
      pushSyncToSiblings(tab, false, {
        v: handV,
        skipTabIds: [shownTab.tabId, tab.tabId], // 源与接班都已被收口写好，谁也不许再动
      });
    }
  }
  renderPanelTabs(panelId);
  // B224：该面板活动标签 md 与否可能变了（md ↔ 非 md 切换），操作区跟着刷一遍
  renderPanelOps(panelId);
  // 悬浮查找栏不随标签切换关闭——只把查询重新应用到新的活动视图
  retargetFindBarRef();
  // B182（续）：左键 mousedown 不再拦默认焦点（那会连带废掉原生拖拽，标签拖不动），
  // 改为切完标签后**延迟一拍**再补一次焦点。WebView2 在整次手势结束后会把焦点重新定到
  // body（CM6 的 10ms 失焦兜底随之摘掉 `cm-focused`，光标一闪而过）；这里在切标签的焦点
  // 之后排一个 macrotask 再 focus 一次，既赶在 10ms 兜底生效前把焦点钉回编辑器，又能盖过
  // 任意时机的手势结束回焦，光标不再闪。
  // ⚠️⚠️ **B277：延迟补焦点这一拍不许滚动**。
  //    CM6 的 `view.focus()` 内部走 `focusPreventScroll(contentDOM)`，而 WebView2 上它的
  //    支持性检测可能失败、**回滚成普通 focus** ⇒ 浏览器把**光标所在行**滚进视野（源码
  //    光标停在上次编辑的地方）⇒ 把刚收口钉好的位置悄悄盖掉 —— 真机 trace
  //    （08:17:53.294 收口钉 2478 之后，中间零日志，54.081 保存时 DOM 已经是 1922.67
  //    ≈ 光标行 80）⇒ 用户看到的「切回去位置对不上/弹回老地方」的最后一块拼图。
  //    ⇒ ①原生 `preventScroll: true`（Chromium/WebView2 原生支持，绕过 CM6 的检测）；
  //    ②下一帧 `reassertViewScroll` 复核：DOM 被谁拉走了都钉回槽（用户已滚则槽=用户
  //    位置，钉回去无害；被 focus 拉走则槽仍是收口值，钉回正确）。
  setTimeout(() => {
    view.view.contentDOM.focus({ preventScroll: true });
    view.view.update([]); // B182：同步补 `cm-focused` 类（同 EditorHandle.focus 的收尾）
    requestAnimationFrame(() => reassertViewScroll(panel));
  }, 0);
}

/** 新建未命名标签（开到活动面板）。 */
async function newUntitled(): Promise<void> {
  let panel = activePanel();
  if (!panel) {
    // 无面板（全部关闭的极端情况）→ 重建单面板
    setLayout(leaf(0));
    setNextPanelId(1);
    setActivePanelId(0);
    panels.set(0, {
      panelId: 0,
      tabs: [],
      activeTabId: -1,
      view: null,
      viewTabId: null,
      preview: null,
      previewTimer: null,
      bodyEl: null,
    });
    panel = panels.get(0);
  }
  try {
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
    const tab = makeInstance(doc, panel!.panelId, "");
    attachTabToPanel(tab, panel!);
    // 挂载真实编辑器/预览结构（mountView 内会 setState 新标签并聚焦）
    rebuildLayout();
    refreshAll();
    renderPanelTabs(panel!.panelId);
  } catch (err) {
    showMessage(String(err), true);
  }
}

async function closeTabById(tabId: number): Promise<void> {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const panel = panelOfTab(tabId);
  if (!panel) return;
  const doc = docOf(tab);
  // 同文档的其他实例数：仅最后一个实例关闭时才需要保存确认 + 关闭 Rust 文档
  const siblings = instancesOfDoc(doc.tabId).filter((t) => t.tabId !== tabId);
  /** 本标签是不是该面板正显示的那一个（决定关闭后要不要换显示内容） */
  const wasShown = panel.viewTabId === tabId || panel.activeTabId === tabId;

  // B45：不再为了保存而先把待关闭标签切成活动标签。
  // 原实现关闭非活动标签时会「切到待关文件 → 关掉 → 再切回原来的文件」闪一下；
  // 保存确认的 await 会让这个中间态真的绘制出来，所以肉眼可见。
  // saveDocCore 本身就是按**指定实例**保存（实例正显示在面板上才从视图写回，
  // 否则用标签快照），并不需要先把待关标签激活。同理也不必切 activePanelId。
  if (doc.dirty && siblings.length === 0) {
    // B236：VS Code 的 confirmBeforeClose 三选一（保存 / 不保存 / 取消），
    // 不再是原来那个只有「确定 / 取消」的原生 ask() —— 原来那版没法表达
    // 「不保存直接关」，用户想放弃改动只能先取消、手动去改文件。
    const choice = await showSaveConfirmDialog({ title: "关闭标签", names: [doc.name] });
    if (choice === "cancel") return;
    if (choice === "save") {
      const ok = await saveDocCoreRef(doc, tab, false);
      if (!ok) return;
    }
  }

  if (siblings.length === 0) {
    // 该文档要彻底离开了：无论是「已保存」还是「用户选了不保存」，
    // 备份区里的副本都不该再留着——热退出的承诺是「关窗才还原」，不是
    // 「关标签也还原」。用户明确丢弃的内容必须真的丢弃。
    discardBackupForRef(doc);
    // B161：**Rust 那侧的文档是进程级的**（`state.docs` 只有一份），本窗口这是最后一个
    // 实例，不等于别的窗口没有 —— 主窗口那份隐藏实例、另一个卫星窗口的可见标签都算
    // 有人拿着。直接 `close_tab` 会把别人手上那份一起废掉（正是对端保存时报「文档不
    // 存在」、看起来像「同文件的标签被一起关掉」的原因）。所以先问一圈，有人应答就
    // 只摘本地。单窗口（没有外借、自己也不是卫星）不必问，省掉这 150ms。
    const maybeShared = windowKind === "satellite" || loanedDocIds.has(doc.tabId);
    const held = maybeShared ? await docHeldElsewhereRef(doc.tabId) : false;
    if (!held) {
      try {
        await ipcCloseTab(doc.tabId);
      } catch (err) {
        showMessage(String(err), true);
        return;
      }
    }
    docs.delete(doc.tabId);
  }

  const idx = panel.tabs.indexOf(tabId);
  panel.tabs = panel.tabs.filter((id) => id !== tabId);
  tabs.delete(tabId);
  // B178：本地这份没了（可能是该文档在本窗口的最后一个可见实例），别的窗口要能据此
  // 把自己的同步键收起。放在 tab 真正摘除之后，diff 才能算出「这份文档不再可见」。
  broadcastDocPresence();

  if (panel.tabs.length === 0) {
    if (windowKind === "satellite") {
      if (countLeaves(layout) > 1) {
        // B161：还有别的面板，就只摘这一块（与主窗口同款）—— 原来这里会整窗关掉、
        // 顺手把其它面板的标签一并交回主窗口 ⇒ 用户关的明明是一个标签，看到的却是
        // 别的标签跑去了主窗口。
        disposePanel(panel.panelId);
        return;
      }
      // B155：卫星窗口没有「再开一个未命名文档」这条退路 —— 它存在的意义就是
      // 承载从主窗口分出去的那几个文件，关空了就该关掉自己（用户原话：
      // 「子窗口支持关闭最后一个文件和面板，此时相当于关闭子窗口」）。
      // 走 `close()` 而不是直接 destroy：与用户点 X 完全同一条链
      // （CloseRequested → registerSatelliteClose → finishSatelliteClose）。
      // B188：关窗即真关，**不把标签交回主窗口**（与点 X 同款口径，见 `requestSatelliteClose`
      // 注释）。没关的文件标签由主窗口那份隐藏实例接着管，未保存内容靠热退出副本兜住。
      requestSatelliteCloseRef();
      return;
    }
    if (countLeaves(layout) <= 1) {
      // 最后一个面板：新建未命名标签，保持窗口不空
      void newUntitled();
    } else {
      // 区域内文档已全部关闭 → 移除该分屏区域（树规约）
      disposePanel(panel.panelId);
    }
    return;
  }
  // B45：关掉的是**后台标签**时不要动显示内容——原实现会把面板切到它的邻居标签，
  // 表现为「平白跳到另一个文件」（这正是用户看到的「闪一下」的后半段）。
  // 只重绘标签栏即可；「关闭其他/关闭右侧」批量关闭同样受益，不再逐个切换。
  if (!wasShown) {
    renderPanelTabs(panel.panelId);
    scheduleSessionSaveRef();
    return;
  }
  // 激活相邻标签
  const nextId = panel.tabs[Math.min(idx, panel.tabs.length - 1)];
  panel.activeTabId = nextId;
  const nextTab = tabs.get(nextId);
  if (panel.view && nextTab) {
    const view = panel.view; // 闭包里不保留对 `panel.view` 的收窄，先取一份
    // 同 switchTab（B146）：CM6 的 setState 自己会再 focus / 重排，把 scrollTop 归零
    // 那一发若不标记就会被当成用户滚动写进接班标签记录。换文档前先标程序来源，
    // `restoreViewScroll` 的 `pinScrollTop` 继续标，覆盖补钉回执。
    panel.viewTabId = nextId;
    markProgrammatic(view.view.scrollDOM);
    setSuppressDirty(true);
    view.setState(nextTab.state);
    setSuppressDirty(false);
    // B271：估算窗口开启（measureAndKeepScroll 的 rAF 关闭）
    unmeasuredPanels.add(panel);
    // B126：接班的标签沿用**它自己**上次的位置（光标随 state，视口随 scrollTop）
    restoreViewScroll(panel);
  }
  applyPanelMode(panel);
  // 同上：接班的是纯预览实例时，位置在预览那侧，applyPanelMode 的 syncToLine
  // 会把预览按编辑器顶行顶掉一次，得在它之后钉回来（B129 同款）
  restorePreviewScroll(panel);
  // CM6 测量（含它的滚动锚点补偿）排在下一帧，位置得在补偿之后收回来（B146）
  measureAndKeepScroll(panel);
  if (panel.panelId === activePanelId) {
    refreshTitle();
    refreshStatus();
    updateTocDrawer();
  }
  renderPanelTabs(panel.panelId);
  scheduleSessionSaveRef();
}

/** 移除分屏区域并销毁其资源（不并入其他面板的标签）。 */
function disposePanel(panelId: number): void {
  const panel = getPanel(panelId);
  if (!panel) return;
  // 在旧树上取视觉相邻面板，作为关闭后的活动面板
  const sibling = siblingLeafOf(layout, panelId);
  const newTree = removePanel(layout, panelId);
  if (newTree) setLayout(newTree);

  // 销毁残留的编辑器视图（预览 DOM 随 rebuildLayout 清空，监听器一并回收）
  if (panel.view) {
    const t = panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
    if (t) t.state = panel.view.view.state;
    rememberViewScroll(panel);
    panel.view.view.destroy();
  }
  panel.view = null;
  panel.viewTabId = null;
  panel.preview = null;
  panels.delete(panelId);

  if (activePanelId === panelId) {
    setActivePanelId(sibling ?? [...panels.keys()][0] ?? 0);
  }
  // ⚠️⚠️ **B261 第七轮（用户点名要端到端验「新增 / 减少分屏」时翻出来的）**：关掉一个
  //    分屏 ⇒ 剩下那格**变宽**、编辑器（word_wrap 开着）重排 ⇒ **同一个 `scrollTop` 像素
  //    在宽栏里是另一行**，而槽（`t.scrollTop`）里存的是**窄栏**像素 —— `rebuildLayout`
  //    → `restoreViewScroll` 拿它去钉**已变宽**的面板 ⇒ 位置被钉到另一行，而且
  //    **`pushSyncToSiblings` 救不了**：关完只剩一个面板、同文档再没有兄弟实例可推
  //    （`sibs.length === 0` ⇒ 推播入口就 return），所以**同步开着也照样错**
  //    （`tests/sync-split-close.test.ts` 实测：该落 287，实际停在 95.67 = 窄栏像素）。
  //
  //    这正是 S11（新建分屏）的**反向半边**：那边几何**变窄**、这里**变宽**，病一样是
  //    「跨几何的像素当尺子」，尺子只有游标 `v`。⇒ 落位纪律照抄那一轮，只是取反方向：
  //    **先采后落**，`syncSourceV` 排在最前（旧几何）、`landOnFrameGeometry` 排在
  //    `rebuildLayout()` 之后（本帧几何）。⚠️ B262 修正了一句旧口径：排在之后 ≠ 用
  //    **新**几何换算 —— CM6 的 heightMap 要到那一帧的 measure 才更新（见
  //    `landOnFrameGeometry`），当场换算等于拿旧尺子量新位置。
  //
  //    ⚠️ **采的是「所有还显示着的东西」**，不是只采宿主那一个：面板数一变，留存面板的
  //       几何都会跟着变（三格布局里关掉中间那格，左右两格宽度都不再是关之前的）⇒
  //       谁显着谁就得按旧游标重落一遍。
  //
  //    ⚠️ 顺带说一下「并入宿主的那些标签」（`closePanelById` 把关闭面板的标签搬到宿主）
  //       **为什么不用管**：这一刻它们没显示 ⇒ `syncSourceV` 采不出游标（它只认「面板此刻
  //       显示的那一份」），但也不需要 —— 重落那一下走的 `applySyncToSibling` 即使是
  //       `shown=false`，也会把同一游标写进它的槽（`recordScroll`）⇒ 之后点它，落点照样
  //       是对的（自测台实测：关完分屏再点并入的那份副本，落 287 = 整宽同一行）。
  //       ⚠️ 这条是靠 `applySyncToSibling` 的「落位也写槽」兜住的，**不要**因为它看着
  //          「没重落」就以为漏了；真改了那条的写法，这里就得补一块。
  const reland: Array<{ tab: Tab; v: number | null }> = [];
  for (const p of panels.values()) {
    if (!p.view || p.viewTabId === null) continue;
    const t = tabs.get(p.viewTabId);
    if (t) reland.push({ tab: t, v: syncSourceV(t) });
  }
  rebuildLayout();
  // ⚠️ B262：这里原先是 `landPreviewAtSource`（**当场**落）⇒ 那一刻 CM6 的 heightMap
  //    还是旧的，`sourceTopOfV` 拿旧尺子量新位置 ⇒ 落到另一行（用户报「加/删分屏之后原
  //    标签滚动位置跳行」）。改成 `landOnFrameGeometry`：换算排到这一帧的 measure 之后。
  //    ⚠️ 「先采后落」的纪律没变 —— 变的只是**落那一半的尺子**：原来以为「排在
  //       `rebuildLayout()` 之后」就等于「用新几何」，其实不是（heightMap 要到那一帧的
  //       measure 才刷），现在换尺子这一半被显式排到了帧上，见 `landOnFrameGeometry`。
  for (const r of reland) landOnFrameGeometry(r.tab, r.v);
  refreshAll();
  scheduleSessionSaveRef();
}

/**
 * 摘掉所有**一个标签都没有**的面板（B90）。
 *
 * 什么时候会空：把面板里最后一个标签挪走 —— 移到别的面板、在自家边缘分屏出去、
 * 整组搬到另一个窗口。留着它就是一个占着位置、什么也没有的空框，和「窗口内移动后
 * 合并分屏」的既有行为不一致（`moveTabToStrip` / `moveTabToPanel` / `moveGroupToPanel`
 * 各自都写了这个判据，但总有路径漏掉：同面板分屏、跨窗口拖走）。
 *
 * ⚠️ 唯一面板不摘：摘了就没地方放标签了（关面板那条路径也是同一个判据）。
 *
 * @returns 是否真的摘掉了。调用方据此决定要不要自己 rebuild —— `disposePanel` 内部已刷过。
 */
function pruneEmptyPanels(): boolean {
  if (countLeaves(layout) <= 1) return false;
  const empties = [...panels.values()].filter((p) => p.tabs.length === 0);
  if (empties.length === 0) return false;
  exitMaximize(); // 同上：最大化态下摘面板会留下「0 宽但还在树里」的怪布局
  let removed = false;
  for (const p of empties) {
    if (countLeaves(layout) <= 1) break; // 摘到只剩一个为止
    if (!panels.has(p.panelId)) continue; // 可能已被前一轮连带摘掉
    disposePanel(p.panelId);
    removed = true;
  }
  return removed;
}

/** 关闭面板（VS Code 式）：仅移除该分屏，标签整体并入视觉相邻面板，不关文档。
 *  唯一面板时为空操作（⨯ 已禁用；退出走窗口关闭 / 菜单「退出」）。
 *  `hostId` 指定并入目标（B71 整组拖拽落到哪个面板就并入哪个），缺省按视觉相邻。 */
function closePanelById(panelId: number, hostId?: number): void {
  const panel = getPanel(panelId);
  if (!panel) return;
  if (windowKind === "satellite" && countLeaves(layout) <= 1) {
    // B161：子窗口**唯一的面板也能关** —— 它没有「并入相邻面板」这条退路，关掉这块
    // 就等于关掉这个窗口。里面还开着的标签**不交回主窗口**（B188：关窗即真关，与点 X
    // 同款口径；文档由主窗口那份隐藏实例接着管，未保存内容靠热退出副本兜住）。
    requestSatelliteCloseRef();
    return;
  }
  if (countLeaves(layout) <= 1) return;
  exitMaximize(); // 最大化态下关面板会留下「0 宽但还在树里」的怪布局
  const sibId = hostId ?? siblingLeafOf(layout, panelId);
  const host = sibId !== null ? getPanel(sibId) : null;
  if (!host) return;
  for (const id of panel.tabs) {
    const t = tabs.get(id);
    if (t) t.panelId = host.panelId;
    host.tabs.push(id);
  }
  // 宿主面板没有活动标签（空面板）时，激活并入的第一个标签
  if (host.activeTabId === -1 && panel.tabs.length > 0) {
    host.activeTabId = panel.tabs[0];
  }
  if (activePanelId === panelId) setActivePanelId(host.panelId);
  disposePanel(panelId);
}

/** 在指定面板旁分屏，新面板沿用当前活动标签。 */
function splitActivePanel(panelId: number, dir: "h" | "v"): void {
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
        // B271：估算窗口开启（本支原本没有 measureAndKeepScroll，下面补上）
        unmeasuredPanels.add(panel);
        // B126：原位剩下的标签也要拿回自己的视口位置
        restoreViewScroll(panel);
      }
      // B271：估算窗口必须由 measureAndKeepScroll 的 rAF 关闭 —— 本支原本没有，
      // 不补的话挂起的游标永远等不到实测补写
      measureAndKeepScroll(panel);
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
function moveTabToPanel(tabId: number, hostId: number, copy = false): void {
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
function moveActiveTabByDelta(delta: number): void {
  const panel = activePanel();
  if (!panel || panel.activeTabId < 0) return;
  const ids = panelIdsInOrder();
  if (ids.length < 2) return;
  const i = ids.indexOf(panel.panelId);
  if (i < 0) return;
  moveTabToPanel(panel.activeTabId, ids[(i + delta + ids.length) % ids.length]);
}

/** 切换活动面板焦点（F6 / Shift+F6；VS Code 的 F6 就是「下一个窗格」）。 */
function focusPanelByDelta(delta: number): void {
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
  retargetFindBarRef();
}

// ---------------------------------------------------------------- 面板最大化（B71）

/**
 * 最大化中的面板 id；null = 没有。
 *
 * 最大化**只改比例**（沿路径推到 0/1），不动树结构、不销毁面板：
 * 标签、编辑器实例、会话全都照旧，只是被挤的那一侧渲染成 0 宽（见
 * `.layout-panel-collapsed`，`.layout-panel` 有 min-width: 120px，只推比例收不掉）。
 */
let maximizedPanelId: number | null = null;
/** 最大化前的各层比例快照（路径 + 原比例），用于原样还原。 */
let maximizeSnapshot: MaximizeSnapshot | null = null;

/**
 * 取消最大化：把比例还原回去，**不重绘**（调用方负责）。
 *
 * 任何改布局的操作（分屏 / 关面板 / 拖分隔条 / 把标签挪到别的面板）前都要先调它：
 * 最大化下的比例是 0/1，直接在上面改结构会得到「一半是 0 宽」的怪布局，
 * 而且还原快照的路径也会失效。先还原再改，用户看到的始终是真实布局。
 */
function exitMaximize(): void {
  if (maximizedPanelId === null || !maximizeSnapshot) return;
  restoreRatios(layout, maximizeSnapshot);
  maximizedPanelId = null;
  maximizeSnapshot = null;
}

/** 最大化 / 还原某个面板（默认活动面板）。已在最大化态时一律还原。 */
function toggleMaximizePanel(panelId: number = activePanelId): void {
  if (maximizedPanelId !== null) {
    exitMaximize();
    rebuildLayout();
    scheduleSessionSaveRef();
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
  const hint = keyHintRef("panel.toggleMaximize");
  showMessage(hint ? `已最大化该面板，${hint} 还原` : "已最大化该面板");
  scheduleSessionSaveRef();
}

/** 会话里存**未最大化**的比例：0/1 存进 session 会让下次启动只剩一块面板。 */
function layoutForSession(): LayoutNode {
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
function moveGroupToPanel(
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
function freshTextOfDoc(doc: Doc): string | null {
  for (const inst of tabs.values()) {
    if (inst.docId !== doc.tabId) continue;
    const p = panels.get(inst.panelId);
    if (p?.view && p.viewTabId === inst.tabId) {
      inst.state = p.view.view.state;
      return inst.state.doc.toString();
    }
  }
  const any = instancesOfDoc(doc.tabId)[0];
  return any ? any.state.doc.toString() : null;
}

/** 同源复制：为文档在目标面板创建一个新实例（内容/光标/视图模式继承源实例）。
 *  两个实例独立编辑，内容通过变更集实时同步。 */
function duplicateTabToPanel(tabId: number, hostPanelId: number): void {
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
  // ⚠️⚠️ **B261 第三处同型缺口**：`duplicateTabToPanel`（右键「复制标签」/「复制到相邻
  //    面板」/ Ctrl 拖到面板中心 = `moveTabToPanel(copy=true)`）造出的这份 `makeInstance`
  //    同样是**空档**（`scrollTop: null`、编辑器视口恒 0），而这条路径**从来没有任何落位**
  //    —— 前两轮修的是 `splitPanelWithTab` 的 copy 分支与 `openPreviewToSide`，都没盖到它。
  //    ⇒ 两面受害：· 新副本自己停在文档开头（用户报「复制标签滚动位置没有复制」）；
  //                · `refreshAll` 尾那趟 `pushSyncToSiblings(activeTab())` 正好以这份空档
  //                  为源往外推（B152）⇒ 同文档的原标签被记成 `top = 0` 钉进 DOM。
  //    修法与 copy 分支**同口径**：`rebuildLayout()` 之前先落位，落的是**槽**
  //    （此刻新实例还没进面板，没有容器可钉；槽会被 `restoreViewScroll` 带走）。
  //    ⚠️ 顺序不能反：`syncSourceV` 必须在源**还在屏上**（位置真实）时采；
  //       ⚠️ 变量名刻意**不叫 `v`**：`tests/view-mode-scroll.test.ts` 里 B148 那两条退化
  //          契约盯的整句是 `const v = syncSourceV(tab);`，退化的摘句按**首次出现**定位 ——
  //          这一处行号更靠前，同名会让退化 `replace` 摘到这里 ⇒ 退化变成「没改」⇒ 假绿。
  // ⚠️⚠️ `syncSourceV` 排在 attach **之前**（源此刻还在屏上、位置是真的），落位排在 attach
  //    **之后**（见下面那条）—— 两件事必须拆开，顺序写反这一份就仍然停在文档开头。
  const vDup = syncSourceV(src);
  attachTabToPanel(inst, host);
  setActivePanelId(hostPanelId);
  // ⚠️⚠️ 落位必须在 `attachTabToPanel` **之后**：`recordScroll` 是靠 `tabs.get(tabId)`
  //    把位置写进这份实例的槽的，而 `makeInstance` **不落表**、`attachTabToPanel` 内部那句
  //    `tabs.set(...)` 才是它进表的那一刻。排在前面 ⇒ 写槽时压根查不到这份 ⇒ **静默空转**
  //    （探针实测：落位完 `inst.scrollTop` 还是 `null`，新副本照样顶到 0）。
  //    ⚠️ 反过来说 `syncSourceV` 也不能挪到 attach 之后太远 —— 它读的是源那一格，
  //       attach 一下手 host 的 `activeTabId` 就换成这份新副本了。
  if (vDup !== null) landPreviewAtSource(inst, vDup);
  rebuildLayout();
  refreshAll();
  scheduleSessionSaveRef();
}

/** 同源复制到视觉相邻面板（左右分屏对照源码/预览的快捷入口）。 */
function duplicateTabToSibling(tabId: number): void {
  const src = panelOfTab(tabId);
  if (!src) return;
  const sibId = siblingLeafOf(layout, src.panelId);
  if (sibId === null) return;
  duplicateTabToPanel(tabId, sibId);
}

/** 拖拽标签到目标面板某区域：在目标旁分屏出新面板并放入该标签。
 *  copy=true 时新面板获得同源新实例，源面板不动。 */
function splitPanelWithTab(
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
    //    ⚠️ `syncSourceV` 仍然必须排在最前（先于任何重建采）：源此刻还在屏上、位置是真的，
    //       一旦被 `rebuildLayout` 摘下来换别的标签，采到的就是接班那份的坐标。
    // ⚠️ 变量名刻意**不叫 `v`**：`tests/view-mode-scroll.test.ts` 里 B148 那两条退化契约盯的
    //    整句就是 `const v = syncSourceV(tab);`，而退化的摘句是按**首次出现**定位的 ——
    //    这一处行号更靠前，同名会让退化 `replace` 摘到**这里**而不是切模式那一处 ⇒
    //    退化变成了「没改」，两条判据（ASK 被摘 / 顺序契约）双双假绿。
    const vCopy = syncSourceV(tab);
    setLayout(splitPanelAt(layout, targetId, dir, newId, newFirst));
    setActivePanelId(newId);
    rebuildLayout();
    // ⚠️⚠️⚠️ **B261 第四轮（用户：「新建分屏时原标签内滚动位置出现了变化，
    //    可能跟面板宽度变化有关」）—— 落位必须排在 `rebuildLayout()` 之后，而且
    //    **源那一格也得重落**（只落新副本是上一轮漏的那一半）。**
    //
    //    分屏那一刻左栏从「整宽」变成「半宽」⇒ 编辑器（word_wrap 开着）**重排 / 折行** ⇒
    //    **同一个 `scrollTop` 像素在新几何下是另一行**；而这份实例的槽里存的**只有像素**
    //    （`recordScroll` 直接写 px），跨宽度的尺子只有**游标 `v`**。
    //    ⇒ `restoreViewScroll` 拿旧像素（分屏前量出来的 287）去钉**已变窄**的左栏 ⇒
    //      源被钉到「新宽度的 287px」⇒ 看着就是「原标签滚动位置出现变化」；而之前那两轮
    //      的修法只把 `v` 落给了**新副本**，左栏那份压根没人重落 ⇒ 真机上症状②从来没修好过
    //      （jsdom 桩**没有布局、没有宽度** ⇒ 这条在桩里根本测不出来 —— 典型的假绿）。
    //
    //    ⇒ 两个面板都按**新几何**挂好之后，按同一个 `vCopy` 把**两格**都重落一遍：
    //      源（左栏）与新副本（右栏）。谁后谁赢：落位要盖过 `rebuildLayout` 那一钉。
    //
    //    ⚠️ 顺序不能反：`syncSourceV` 在最前采（旧几何）；`landPreviewAtSource` 在
    //       `rebuildLayout` 之后落（新几何）—— 用错一边换算，落点就带着旧/新宽度的量。
    // ⚠️ **落位不许跨帧**（B262 把第五轮那句「同步落位，不许异步」收窄成这一条）：
    //    第四轮被撤的是**跨过一帧**去落（`landAfterMeasure` = rAF + setTimeout(0)），
    //    病在**帧边界**上（那一帧里切标签 / 切模式 / 再 rebuild ⇒ 拿分屏前的 `vCopy`
    //    把用户刚切好的位置钉回去），不在「晚一步落」这件事本身；本轮因此把落点换算
    //    挪到 CM6 measure 的 **write 阶段**（`landOnFrameGeometry`）—— 仍与几何变化
    //    **同一帧**，帧边界那类回归照旧堵着，而换算的尺子换成了这一帧的实测几何。
    // ⚠️ 第五轮那次回归（用户：「这次修改，之前标签切换的不同步问题又出现了」）出自
    //    第四轮这里走的是 `landAfterMeasure`（rAF + setTimeout(0)），
    //    本意是等 CM6 量出新几何；但一次性落位一旦跨过一帧，那一帧里**任何**事都会
    //    先把位置改掉，而这一拍还拿着**分屏前采的 `vCopy`** ⇒ 下一帧落下去时
    //    `displayedPanelOfTab(other.tabId)` 可能已经指向**别的面板/别的标签**
    //    （用户切了标签、切了模式、或者 rebuildLayout 又跑了一轮）—— `applySyncToSibling`
    //    于是按**陈旧游标**把那份**刚被用户切好的位置**硬钉回 `vCopy` 那一行，
    //    表现就是「切标签不同步 / 位置对不上」。这正是 `landPreviewAtSource` 上那段
    //    「跟随时每帧更正、一次性落位必须**当场**落下去」要防的那一类。
    //    ⚠️ 真机上 CM6 的 `lineBlock` 那一轮 measure 确实会晚，但**晚一帧落错的代价**
    //       （把用户切好的位置钉歪）远大于「按尚未 measure 的几何落一次、随后被
    //       `measureAndKeepScroll` / 用户下一滚带走」—— 后者只会偏一点，前者是**不同步**。
    //    ⇒ 落位回同步；「用新几何换算」靠**排在 `rebuildLayout()` 之后**这一条守住
    //      （窄栏用例 `tests/sync-split-narrow.test.ts` 守的就是这条顺序）。
    //
    //    ⚠️⚠️ **B261 第六轮：两格都得显式落 —— 只落新副本这一条是净负债，第四轮那句
    //       「显式落源是净负债、谁都别再加回来」的**推论错了**，本轮订正。**
    //
    //       上面那些「显式落源没用、被推播覆盖了」的实测**只在同步开着时成立**：
    //       `pushSyncToSiblings` 入口那句 `docSyncModes.get(src.docId) !== true ⇒ return`
    //       ⇒ **同步关着时根本没有推播**。而左栏那份是 `rebuildLayout()` → `restoreViewScroll`
    //       用**槽里那份分屏前按整宽量出来的旧像素**（`t.scrollTop`）还原进**已变窄**的
    //       编辑器 ⇒ 旧像素在新几何下是**另一行**，而且**再也没人把它扳回来** ——
    //       这正是用户报的「新建分屏时原标签内滚动位置出现了变化（可能跟面板宽度有关）」
    //       在真机上的**稳态形态**：同步开着只闪一下就被推播扳回来，同步关着是**一直错**
    //       （`tests/sync-split-narrow-off.test.ts` 实测左栏停在 287 而不是 95.67）。
    //
    //       ⇒ 本轮把源（左栏）也按同一个 `vCopy` 在**新几何**下重落一遍。走
    //         `landOnFrameGeometry` 而不是 `pushSyncToSiblings`：前者**不看 `docSyncModes` 闸**，
    //         同步关着也照样生效 —— 那正是它存在的意义（B259 开侧边预览那一路同理，
    //         也是「一次性落位」这个用途，见 `landPreviewAtSource` 的注释）。
    //
    //       ⚠️ 顺序纪律：两格都排在 `rebuildLayout()` **之后**（这帧几何才量得对）、都用最前
    //         采到的 `vCopy`（分屏前按**旧**几何采的游标）。退化「摘掉源那格这一行」
    //         ⇒ `tests/sync-split-narrow-off.test.ts` **立刻红**（左栏停在旧像素 287，
    //         而不是新几何的 95.67）；同步开着时红不红**不能拿来当事** —— 推播会把左栏
    //         扳回来，那条工况由 `tests/sync-split-narrow.test.ts` 守「两格落点一致」的结果。
    landOnFrameGeometry(tab, vCopy);
    landOnFrameGeometry(inst, vCopy);
    refreshAll();
    scheduleSessionSaveRef();
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
  //    ⚠️ ① 的锚必须取 **`viewTabId`（视图实际显示谁）**，不能取 `activeTabId`（那是要
  //       被搬走的那个），也不能取被拖的 `tab`；view 还没建时回退 `activeTabId`。
  //       这跟 `switchTab` 收口那条「采坐标必须离屏前」是同一条律，只是这次的病是
  //       「采的是离屏的那一份」而不是「采的时刻不对」。
  const anchor =
    (src.viewTabId !== null && src.viewTabId !== undefined ? tabs.get(src.viewTabId) : undefined) ??
    tabs.get(src.activeTabId) ??
    tab;
  const vDrop = syncSourceV(anchor);
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
    // 源面板已空且非唯一：移交给 disposePanel 统一摘除（会再次 rebuild）
    disposePanel(src.panelId);
  } else {
    if (src.tabs.length > 0) src.activeTabId = src.tabs[src.tabs.length - 1];
    else src.activeTabId = -1;
    // B90：**同面板**分屏把唯一标签挪走后，原面板就空了 —— 以前这里留着一个空框。
    // 交给 pruneEmptyPanels 统一摘掉（摘掉后新面板正好落在原位置，等价于「没动」）。
    if (!pruneEmptyPanels()) {
      rebuildLayout();
      // ⚠️⚠️ **B264：两格都要按新几何重落（B262 口径，与 copy 支 `landOnFrameGeometry`
      //    那一对对称）。这里跨两格是因为 move 支**没有新实例**：被拖的那份（tab）落在
      //    新面板，老面板剩下的那几份（rest）留在原格 —— copy 支是 `tab` + 新副本两个
      //    对象，move 支是 `tab` + `rest` 的并集。**
      //    ⚠️ 顺序同 copy 支：重落排 `rebuildLayout()` **之后**（这一帧的几何才量得对），
      //       游标用**离屏前**采的 `vDrop`；`refreshAll()` 排最后（它尾那趟
      //       `pushSyncToSiblings(activeTab())` 的源此刻是**刚归零的新面板**，本例会把
      //       老格钉回 v=1 —— 重落正是用来盖这一下的，与 copy 支那半边完全同型）。
      for (const t of [tab, ...rest.map((id) => tabs.get(id)).filter((x): x is Tab => !!x)]) {
        landOnFrameGeometry(t, vDrop);
      }
      refreshAll();
    }
  }
}

/** 拖拽标签落点：center 为移入（跨面板）或排序（同面板落在其他标签上）；
 *  left/right/top/bottom 边缘一律分屏——同面板边缘拖拽也分屏（与落点预览一致）。
 *  copy（按住 Ctrl 拖拽）时全部改为同源复制。 */
function onDropTabToPanel(
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
function reorderTabInPanel(panelId: number, from: number, to: number): void {
  const p = getPanel(panelId);
  if (!p) return;
  const fi = p.tabs.indexOf(from);
  const ti = p.tabs.indexOf(to);
  if (fi < 0 || ti < 0) return;
  p.tabs.splice(fi, 1);
  p.tabs.splice(p.tabs.indexOf(to) + (fi < ti ? 1 : 0), 0, from);
  renderPanelTabs(panelId);
  scheduleSessionSaveRef();
}

/** 拖拽标签落在 tab 区（B27）：同面板调整顺序，跨面板移动到该插入位置。
 *  beforeTabId=null 表示追加到末尾。不会分屏。 */
function moveTabToStrip(panelId: number, tabId: number, beforeTabId: number | null): void {
  const dst = getPanel(panelId);
  const tab = tabs.get(tabId);
  const src = panelOfTab(tabId);
  if (!dst || !tab || !src) return;
  exitMaximize(); // 同 moveTabToPanel：跨面板移动前先退出最大化
  const from = src.tabs.indexOf(tabId);
  if (from < 0) return;

  let idx = beforeTabId !== null ? dst.tabs.indexOf(beforeTabId) : dst.tabs.length;
  if (idx < 0) idx = dst.tabs.length;
  if (src.panelId === panelId) {
    if (from < idx) idx -= 1; // 先移除再插入，插到原位置右侧时索引左移
    if (idx === from) return; // 位置没变：不重建（避免无谓闪烁）
    // 同面板排序：只移动数组重绘标签条，不改激活标签——
    // 若在此改 activeTabId 而不重挂视图，会破坏 panel.viewTabId 不变量
    // （状态显示新标签、编辑器仍是旧内容），后续激活早退无法恢复。
    src.tabs.splice(from, 1);
    src.tabs.splice(idx, 0, tabId);
    renderPanelTabs(panelId);
    refreshTitle();
    refreshStatus();
    scheduleSessionSaveRef();
    return;
  }

  src.tabs.splice(from, 1);
  dst.tabs.splice(idx, 0, tabId);
  tab.panelId = panelId;
  dst.activeTabId = tabId;
  setActivePanelId(panelId);

  if (src.tabs.length === 0 && countLeaves(layout) > 1) {
    // 源面板被拖空：统一交给 disposePanel（内部会 rebuild）
    disposePanel(src.panelId);
  } else {
    if (src.activeTabId === tabId) {
      src.activeTabId = src.tabs[Math.min(from, src.tabs.length - 1)] ?? -1;
    }
    rebuildLayout();
    refreshAll();
  }
  scheduleSessionSaveRef();
}

export {
  renderPanelTabs,
  tabViewDataOf,
  tabstripCallbacks,
  panelDataOf,
  renderPanelOps,
  closeTabsSequentially,
  rebuildLayout,
  switchTab,
  newUntitled,
  closeTabById,
  disposePanel,
  pruneEmptyPanels,
  closePanelById,
  splitActivePanel,
  moveTabToPanel,
  moveActiveTabByDelta,
  focusPanelByDelta,
  exitMaximize,
  toggleMaximizePanel,
  layoutForSession,
  moveGroupToPanel,
  freshTextOfDoc,
  duplicateTabToPanel,
  duplicateTabToSibling,
  splitPanelWithTab,
  onDropTabToPanel,
  reorderTabInPanel,
  moveTabToStrip,
};

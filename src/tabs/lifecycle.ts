// 标签 / 面板生命周期操作（从 tabs.ts 拆出，P3 批次）。
//
// 职责：switchTab / closeTabById / newUntitled / rebuildLayout / disposePanel /
// pruneEmptyPanels / closePanelById / freshTextOfDoc / moveTabToStrip / closeTabsSequentially。
// 只依赖 core/* + ui + shell/* + doc-model + 下游模块（render / split / deps /
// windows），对 main.ts 零反向依赖。render / split 与本项目形成（运行期安全的）循环引用。

import {
  type Doc,
  tabs,
  docs,
  panels,
  layout,
  activePanelId,
  windowKind,
  loanedDocIds,
  setLayout,
  setActivePanelId,
  setNextPanelId,
  setSuppressDirty,
  settings,
} from "../core/app-state";
import { getPanel, activePanel, panelOfTab, docOf, instancesOfDoc } from "../core/panels";
import {
  landVisibleSideAtV,
  readVisibleV,
  reconcileSyncRegistrations,
  sharedVByDoc,
  syncCoordinator,
  syncTrace,
} from "../sync-scroll/wire";
import { countLeaves, leaf, siblingLeafOf, removePanel, updateRatio } from "../core/layout";
import { logger } from "../core/logger";
import {
  showMessage,
  markActivePanel,
  refreshAll,
  updatePositionOf,
  refreshTitle,
  refreshStatus,
  broadcastDocPresence,
  layoutArea,
} from "../ui";
import { renderSplitview, type PanelRenderData } from "../shell/splitview";
import { attachTabToPanel, makeDoc, makeInstance, registerDoc } from "../doc-model";
import { updateTocDrawer } from "../toc";
import { retargetFindBar } from "../find/findbar";
import { saveDocCore } from "../io/files";
import { attachPasteHandler } from "../io/export";
import { showSaveConfirmDialog } from "../shell/saveconfirm";
import { createEditor } from "../editor/editor";
import { PreviewPane } from "../markdown/preview";
import { logViewport } from "../core/viewport";
import { closeTab as ipcCloseTab, newTab as ipcNewTab } from "../ipc/api";
import { renderPanelTabs, renderPanelOps, panelDataOf } from "./render";
import {
  exitMaximize,
  toggleMaximizePanel,
  moveGroupToPanel,
  duplicateTabToPanel,
  splitPanelWithTab,
  reorderTabInPanel,
  duplicateTabToSibling,
  onDropTabToPanel,
} from "./split";
// 注：pruneEmptyPanels 由 split.ts 内部（splitPanelWithTab）消费，本模块不引用，故不引入。
import {
  scheduleSessionSave,
  applyPanelMode,
  openPreviewToSide,
  toggleViewMode,
  discardBackupFor,
} from "./deps";
import {
  docHeldElsewhere,
  requestSatelliteClose,
  openTabsInNewWindow,
  returnTabToMain,
} from "../multiwindow/windows";

/** 顺序关闭一组标签（跳过被用户取消的）。 */
export async function closeTabsSequentially(ids: number[]): Promise<void> {
  for (const id of ids) {
    if (!tabs.has(id)) continue; // 可能已被前面的关闭连带处理
    await closeTabById(id);
  }
}

// ---------------------------------------------------------------- 布局渲染

/**
 * 本轮重建期间「各文档此刻的共享位置」（B293 · 方案 A 的跨重建版），由 `rebuildLayout`
 * 在销毁任何 view **之前**刷新、由 `mountView` 在落位之前消费。
 *
 * 为什么要有这个一次性的手递手：`switchTab` 那条「接班标签跟随当前共享 v」读得到在册锚点，
 * 因为那条路的 EditorView 还活着；而重建这一路等 `mountView` 跑起来时，上一轮的锚点指向的
 * DOM 已经被拆掉了（`currentV` 那时读回来的是 0/1.0 的垃圾）。所以**共享位置必须在还读得
 * 到的那一刻抄一份**，传给落位那一步。
 */
let rebuildSharedV = new Map<string, number>();

/** 结构变化后全量重建布局区（面板 view 销毁重建，状态都在 Tab 快照里）。 */
export function rebuildLayout(): void {
  // ⚠️ 这一发必须排在下面那个销毁循环**之前**（见 `sharedVByDoc` 的注释）：view 一拆，
  // 在册锚点就只会报顶部，届时再取共享位置等于亲手把整份文档钉回第一行。
  rebuildSharedV = sharedVByDoc();
  // 同步所有面板的当前 view 状态到标签快照。
  // 必须按 viewTabId（视图实际显示的实例）回写：调用方可能已改 activeTabId
  // 而视图仍显示旧标签——按 activeTabId 回写会把旧文档串进新活动标签。
  for (const p of panels.values()) {
    if (p.view) {
      const shown = p.viewTabId !== null ? tabs.get(p.viewTabId) : undefined;
      if (shown) {
        shown.state = p.view.view.state;
        // 位置也得赶在 destroy **之前**取。只回写 state 的话，重建出来的 view 从
        // `scrollTop = 0` 起步，再被 `mountView` 里那发 `focus()` 按游标滚一位 ——
        // 用户看到的就是「只是拖走了**没在显示**的另一张标签，这一格的位置却没了」
        //（B281 / B288；真机台 S17 钉的正是这一步）。
        // 取的是**当前看得见那一侧**的 v：预览态那一格显示的是预览，它的编辑器早就被
        // `display:none` 归零了，按编辑器读只会存下一个假的 1.0。
        const v = readVisibleV(p);
        if (v !== null) shown.scrollV = v;
        syncTrace(
          `重建前快照 tab=${shown.tabId} 存=${v === null ? "读不到" : v.toFixed(2)} doc共享=${
            rebuildSharedV.get(String(shown.docId))?.toFixed(2) ?? "无"
          }`,
        );
      }
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
      retargetFindBar();
    },
    onActivateTab: (panelId, tabId) => switchTab(panelId, tabId),
    onCloseTab: (tabId) => void closeTabById(tabId),
    onClosePanel: (panelId) => void closePanelById(panelId),
    onRatioChange: (path, ratio) => {
      // 拖分隔条 = 用户要自己摆布局 → 退出最大化（否则快照与手摆的比例互相打架）
      exitMaximize();
      updateRatio(layout, path, ratio);
      scheduleSessionSave();
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
    onOpenTabInNewWindow: (tabId) => void openTabsInNewWindow([tabId]),
    onReturnTabToMain: windowKind === "satellite" ? (tabId) => returnTabToMain(tabId) : undefined,
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
        if (panelId === activePanelId) p.view.focus();
      }

      const preview = new PreviewPane();
      p.preview = preview;
      hostEl.appendChild(preview.root);
      preview.setHost({
        lineCount: () => p.view?.view.state.doc.lines ?? 0,
      });
      if (p.view) attachPasteHandler(p);

      applyPanelMode(p);
      // —— 同步滚动 v1 · 重建后的落位（与 `rebuildLayout` 销毁前那次快照配成一对）————————
      // 必须排在 `applyPanelMode` 之后：类换完才知道这一格此刻露的是哪一侧，而隐藏那一侧
      // 写不进去（`display:none` 下 `scrollTop` 恒 0）。扶回之后由 `reconcileSyncRegistrations`
      // 重挂监听，`landVisibleSideAtV` 已同栈向账本认领，所以这一发不会被广播给同文档的其它视口。
      //
      // ⚠️ **无条件**落位（原来这里带着「scrollV 大于一行才写」的守卫）。`scrollV` 的缺省值就是 1，
      // 于是「这张标签的位置 = 文档顶部」与「这张标签从来没记过位置」在数据里长得一样，
      // 守卫把它们一起跳过 ⇒ 视口留在 `setState` + `focus()` 带过去的那一格（上一张标签的
      // 位置，或这张标签的光标行），用户看到的就是「切过去位置不对、也不归位」。
      // 真机 03:24:59：`切入 tab=2 意图=1.00` 之后没有任何登记，`视图=800`（= 上一张的 20.67 行）。
      //
      // —— 同步滚动 v1 · 方案 A 的跨重建版（B293）————————————————————————————————————
      // 这一格现在显示的是 `p.activeTabId` 那一张（被拖进来的、同源复制出来的、接班的）。
      // 同一文档在它**没被显示**的那段时间里不注册进协调器、一个字都收不到 ⇒ 它记的
      // `scrollV` 是陈值（新实例干脆就是缺省 1）。照它落位就把这一格弹到顶部，而它随即成为
      // 该文档第一个在册视口 ⇒ 之后的接班全跟着上顶（真机取证：复制一张后
      // `P0 ed=1.00`、`currentV(X)=1`，切回原来那张也落到 1.00）。
      // 所以：先跟随重建前抄下的共享位置，取不到（该文档同步关着 / 一个视口都不在册）才
      // 回落到这张标签自己的记忆 —— 与 `switchTab` 那条判据同一个口径。
      if (tab) {
        const shared = rebuildSharedV.get(String(tab.docId));
        if (shared !== undefined) {
          syncTrace(
            `重建落位 tab=${tab.tabId} 记忆=${tab.scrollV.toFixed(2)} 跟随共享=${shared.toFixed(2)}`,
          );
          tab.scrollV = shared;
        } else {
          syncTrace(`重建落位 tab=${tab.tabId} 记忆=${tab.scrollV.toFixed(2)} 无共享值`);
        }
        landVisibleSideAtV(p, tab.scrollV);
      }
      if (panelId === activePanelId && p.view) {
        updatePositionOf(panelId, p.view.view);
      }
      // 同步滚动 v1：本面板编辑器+预览已就绪，纳入协调器（reconcile 会先解绑旧句柄）。
      reconcileSyncRegistrations();
    },
  });
}

// updateRatio 已移到 src/core/layout.ts（与 build 的路径约定对齐，B26 修复）

// ---------------------------------------------------------------- 标签操作

export function switchTab(panelId: number, tabId: number): void {
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
  if (shownTab) {
    // 换走之前先把**这一份**的视口位置按 `v`（源码行轴，宽度无关）快照下来，
    // 切回来时原样扶回去。必须在读 `getV()` 之后才写 state：两者取的是同一个当前视图。
    //
    // ⚠️ 读的是**当前看得见那一侧**，不是编辑器：预览态的标签里 `.panel-editor` 是
    // `display:none`（preview.css:635-637），它的 `scrollTop` 恒 0 ⇒ 按编辑器读会把
    // 「1.0」当成这份标签的位置存起来，切回来自然弹回顶部（真机日志：
    // `切换 · 还原窗口内 tab=4 模式=preview 视图=0`；台子 S19 钉的就是这一条）。
    const live = readVisibleV(panel);
    if (live !== null) shownTab.scrollV = live;
    shownTab.state = panel.view.view.state;
    syncTrace(`切出 tab=${shownTab.tabId} 快照=${live === null ? "读不到" : live.toFixed(2)}`);
  }
  const tab = tabs.get(tabId);
  if (!tab) return;
  // B292 · 方案 A：接班标签跟随**当前共享 v**，而不是它自己那份陈值。被藏着的那张不注册进
  // 协调器（B285「幽灵锚点」的取舍），所以同步走过的这一段它一个字都没收到，`scrollV` 停在
  // 上一次被显示时的位置 ⇒ 真机 03:45:43：`切入 tab=3 意图=1.00`，而右栏预览那侧已经在 20.67。
  // 取不到共享值（同文档没有别的视口在册 / 该文档的同步关着）⇒ 回落到这张标签自己的记忆。
  const followV = syncCoordinator.currentV(String(tab.docId));
  if (followV !== null) tab.scrollV = followV;
  panel.activeTabId = tabId;
  // ⚠️ 下面几步的顺序是 B146 二轮改出来的，别再随手调回去。CM6 的 `setState` 末尾
  // 会自己 `focus()`（hadFocus 时）—— 换完文档把光标滚进视野。`viewTabId` 必须
  // **先于** setState 改：视口日志与各处寻址都按它认「视图正显示哪份」，晚一步就
  // 找到旧标签头上。setState 还会把 scrollTop 归零再按新内容长度重排，那几下滚动
  // 不是用户造成的（同步滚动与位置记忆已整体移除，这里只余寻址 / 焦点顺序纪律）。
  // —— 同步滚动 v1：归零重排的那几下由**下面的位置恢复 + 账本登记**认领，不再上锁。
  panel.viewTabId = tabId;
  const view = panel.view; // 闭包里不保留对 `panel.view` 的收窄，先取一份
  setSuppressDirty(true);
  view.setState(tab.state);
  setSuppressDirty(false);
  // ⚠️ 焦点必须排在钉位置**之前**（B145）：`focus()` 会把光标滚进视野，而光标往往
  // 不在刚还原出来的可视区里 —— 排在后面等于把刚钉好的位置顶掉。
  view.focus();
  applyPanelMode(panel);
  // B181：类切完**再补一次焦点** —— 否则「从预览态的标签切走」之后编辑器没有焦点。
  //
  // ⚠️ 上面那次 `view.focus()` 排在 `applyPanelMode` **之前**，而 `mode-preview` 会把
  //    `.panel-editor` 设成 `display:none`（preview.css）—— 上一份标签是预览态时，
  //    那一刻编辑器还是隐藏的，对隐藏元素调 `contentDOM.focus()` **静默失败**：
  //    不报错、也不聚焦。等 `applyPanelMode` 把类切回 `mode-source`，编辑器可见了
  //    却没人聚焦 ⇒ 用户看到「光标消失了、按方向键没反应、得先点一下编辑区才能输入」。
  //
  // ⚠️ 那第一次 focus **不能删也不能挪**：它紧跟着 setState —— 换完文档立刻把焦点
  //    拉回编辑器（B145 立下的顺序：先聚焦、后切视图模式）。所以这里是**补第二次**
  //    —— 此刻类已切好、编辑器可见，`focus()` 才真能拿到焦点。
  //    `focus()` 内部走 `focusPreventScroll`（`preventScroll: true`，拿不到就回滚滚动栈），
  //    不会把刚钉好的视口位置顶掉；已经聚焦过时它就是个空操作。
  view.focus();
  // —— 同步滚动 v1 · 位置恢复（必须**同栈**，且排在两次 focus 之后）————————————————
  // `setState` 把 scrollTop 归零了；这里立刻把该标签自己的 `scrollV` 扶回去。
  //
  // 为什么必须同栈：浏览器每个元素每帧只派发**一发** `scroll`，读的是那一帧的最终值。
  // 同栈里「归零 → 扶回」会被合并成一发、报的是扶回后的位置；一旦把扶回推到下一帧，
  // 中间那发「归零」就会独立派发出去。而协调器只听 `scroll`，没有登记过的滚动一律算
  // 用户滚的 ⇒ 同 docId 的其它视口跟着跳回顶部。这就是 B254/B277/B288 那一路的根。
  //
  // `landVisibleSideAtV` 扶的是**现在看得见那一侧**，并向账本同栈登记（意图 + 真实落点）。
  // 两端都必须按可见侧走：只写编辑器的话，接班标签若是预览态，`applyPanelMode` 刚把
  // `.panel-editor` 藏起来 ⇒ 那一写是空操作，预览停在 `setBlocks` 复原出来的 0 ⇒
  // 「预览态标签之间互切，每次都没回到自己那一份的位置」（台子 S19 / 真机 视图=0）。
  landVisibleSideAtV(panel, tab.scrollV);
  // 「切标签位置跳」的判定证据必须取在**落位之后**。上一版这条诊断打在 `applyPanelMode`
  // 之前，那会儿这一格还在旧文档旧侧上 ⇒ 预览态恒打 `视图=0`，连续两轮把它读成
  // 「修复没生效」，其实是探针放错了地方。
  logViewport("切换 · 落位后", panel);
  syncTrace(`切入 tab=${tab.tabId} 意图=${tab.scrollV.toFixed(2)}`);
  if (panelId === activePanelId) {
    refreshTitle();
    refreshStatus();
    updateTocDrawer();
  }
  renderPanelTabs(panelId);
  // B224：该面板活动标签 md 与否可能变了（md ↔ 非 md 切换），操作区跟着刷一遍
  renderPanelOps(panelId);
  // 悬浮查找栏不随标签切换关闭——只把查询重新应用到新的活动视图
  retargetFindBar();
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
  //    ⇒ 原生 `preventScroll: true`（Chromium/WebView2 原生支持，绕过 CM6 的检测）
  //    即可把焦点钉回编辑器，不必再靠「下一帧重还原」补救。
  setTimeout(() => {
    view.view.contentDOM.focus({ preventScroll: true });
    view.view.update([]); // B182：同步补 `cm-focused` 类（同 EditorHandle.focus 的收尾）
    // 同步滚动 v1：这里**只补焦点、绝不允许滚动**（B277）——它会盖掉上面同栈扶好的位置。
  }, 0);
  // 同步滚动 v1：显示的标签（docId）变了，重注册本面板锚点到新文档下。
  reconcileSyncRegistrations();
}

/** 新建未命名标签（开到活动面板）。 */
export async function newUntitled(): Promise<void> {
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

export async function closeTabById(tabId: number): Promise<void> {
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
      const ok = await saveDocCore(doc, tab, false);
      if (!ok) return;
    }
  }

  if (siblings.length === 0) {
    // 该文档要彻底离开了：无论是「已保存」还是「用户选了不保存」，
    // 备份区里的副本都不该再留着——热退出的承诺是「关窗才还原」，不是
    // 「关标签也还原」。用户明确丢弃的内容必须真的丢弃。
    discardBackupFor(doc);
    // B161：**Rust 那侧的文档是进程级的**（`state.docs` 只有一份），本窗口这是最后一个
    // 实例，不等于别的窗口没有 —— 主窗口那份隐藏实例、另一个卫星窗口的可见标签都算
    // 有人拿着。直接 `close_tab` 会把别人手上那份一起废掉（正是对端保存时报「文档不
    // 存在」、看起来像「同文件的标签被一起关掉」的原因）。所以先问一圈，有人应答就
    // 只摘本地。单窗口（没有外借、自己也不是卫星）不必问，省掉这 150ms。
    const maybeShared = windowKind === "satellite" || loanedDocIds.has(doc.tabId);
    const held = maybeShared ? await docHeldElsewhere(doc.tabId) : false;
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
      requestSatelliteClose();
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
    scheduleSessionSave();
    return;
  }
  // 激活相邻标签
  const nextId = panel.tabs[Math.min(idx, panel.tabs.length - 1)];
  panel.activeTabId = nextId;
  const nextTab = tabs.get(nextId);
  if (panel.view && nextTab) {
    const view = panel.view; // 闭包里不保留对 `panel.view` 的收窄，先取一份
    // 同步滚动 v1：关闭正在显示的标签后，`setState` 把视图切到相邻标签，归零重排的滚动
    // 不是用户造成的。不在此手动上锁：视图此刻仍挂在被关标签的 docId 下，手动锁会误伤
    // 后续用户滚动。改由末尾 reconcileSyncRegistrations 按新活动标签重注册并上锁
    // （与 switchTab 同口径），正确覆盖 setState 异步重排 scroll，锁随用户手势即时解除。
    // 同 switchTab：`viewTabId` 先认下接班标签再 setState（寻址按它），CM6 的
    // setState 会自己 focus / 重排，scrollTop 归零那几下不是用户造成的。
    panel.viewTabId = nextId;
    setSuppressDirty(true);
    view.setState(nextTab.state);
    setSuppressDirty(false);
    // 末尾统一重注册锚点并按新 docId 上锁（见上方注释）；覆盖本函数未显式上锁的空档。
    reconcileSyncRegistrations();
  }
  applyPanelMode(panel);
  // —— 同步滚动 v1 · 位置恢复（B355）——————————————————————————————————————————————
  // 上面那次 `setState` 把 scrollTop 归零了，而这一支原先到此为止 —— 用户看到的正是
  // 「关掉旁边那张标签，原来那份文档跳回顶部」。三条「让这一格换一张标签显示」的同形路径
  // （`switchTab`、`split.ts` 移走后的接班、这一支）里只有这里缺这一发。
  //
  // ⚠️ 必须排在 `applyPanelMode` **之后**：`landVisibleSideAtV` 扶的是「此刻看得见那一侧」，
  //    而可见性由 applyPanelMode 刚写下的 `mode-*` 类决定（排在前面时，接班标签若是预览态，
  //    那一写落在还被藏着的一侧上 = 空操作）。同 `switchTab` / `split.ts` 的次序。
  if (panel.view && nextTab) landVisibleSideAtV(panel, nextTab.scrollV);
  if (panel.panelId === activePanelId) {
    refreshTitle();
    refreshStatus();
    updateTocDrawer();
  }
  renderPanelTabs(panel.panelId);
  scheduleSessionSave();
}

/** 移除分屏区域并销毁其资源（不并入其他面板的标签）。 */
export function disposePanel(panelId: number): void {
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
    panel.view.view.destroy();
  }
  panel.view = null;
  panel.viewTabId = null;
  panel.preview = null;
  panels.delete(panelId);

  if (activePanelId === panelId) {
    setActivePanelId(sibling ?? [...panels.keys()][0] ?? 0);
  }
  rebuildLayout();
  refreshAll();
  scheduleSessionSave();
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
export function pruneEmptyPanels(): boolean {
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
export function closePanelById(panelId: number, hostId?: number): void {
  const panel = getPanel(panelId);
  if (!panel) return;
  if (windowKind === "satellite" && countLeaves(layout) <= 1) {
    // B161：子窗口**唯一的面板也能关** —— 它没有「并入相邻面板」这条退路，关掉这块
    // 就等于关掉这个窗口。里面还开着的标签**不交回主窗口**（B188：关窗即真关，与点 X
    // 同款口径；文档由主窗口那份隐藏实例接着管，未保存内容靠热退出副本兜住）。
    requestSatelliteClose();
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

/** 取文档当前最新文本：优先回写活动实例的视图快照，否则任一实例快照。 */
export function freshTextOfDoc(doc: Doc): string | null {
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

/** 拖拽标签落在 tab 区（B27）：同面板调整顺序，跨面板移动到该插入位置。
 *  beforeTabId=null 表示追加到末尾。不会分屏。 */
export function moveTabToStrip(panelId: number, tabId: number, beforeTabId: number | null): void {
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
    scheduleSessionSave();
    return;
  }

  src.tabs.splice(from, 1);
  dst.tabs.splice(idx, 0, tabId);
  tab.panelId = panelId;
  dst.activeTabId = tabId;
  setActivePanelId(panelId);

  if (src.tabs.length === 0 && countLeaves(layout) > 1) {
    // 源面板被拖空 vs 仍有标签：两条分支各留一条 trace，排查重建类问题时
    // 先看走的是哪一条（disposePanel 内部会再 rebuild）。
    logger.trace(
      "tabs",
      `拖拽(标签条) · 源面板 ${src.panelId} 被拖空 ⇒ disposePanel tab=${tabId} → 面板 ${panelId}`,
    );
    // 源面板被拖空：统一交给 disposePanel（内部会 rebuild）
    disposePanel(src.panelId);
  } else {
    logger.trace(
      "tabs",
      `拖拽(标签条) · 源面板 ${src.panelId} 仍有标签 ⇒ rebuild tab=${tabId} → 面板 ${panelId}`,
    );
    if (src.activeTabId === tabId) {
      src.activeTabId = src.tabs[Math.min(from, src.tabs.length - 1)] ?? -1;
    }
    rebuildLayout();
    refreshAll();
  }
  scheduleSessionSave();
}

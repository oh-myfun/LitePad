// 标签 / 面板生命周期操作（从 tabs.ts 拆出，P3 批次）。
//
// 职责：switchTab / closeTabById / newUntitled / rebuildLayout / disposePanel /
// pruneEmptyPanels / closePanelById / freshTextOfDoc / moveTabToStrip / closeTabsSequentially。
// 只依赖 core/* + sync-scroll + ui + shell/* + doc-model + 下游模块（render / split / deps /
// windows），对 main.ts 零反向依赖。render / split 与本项目形成（运行期安全的）循环引用。

import {
  type Doc,
  type Tab,
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
  setSuppressSyncPush,
  unmeasuredPanels,
  settings,
} from "../core/app-state";
import { getPanel, activePanel, panelOfTab, docOf, instancesOfDoc } from "../core/panels";
import { countLeaves, leaf, siblingLeafOf, removePanel, updateRatio } from "../core/layout";
import { logger } from "../core/logger";
import {
  pushSyncToSiblings,
  restoreViewScroll,
  restorePreviewScroll,
  rememberViewScroll,
  measureAndKeepScroll,
  reassertViewScroll,
  syncSourceV,
  alignShownToSyncSource,
  syncSourceSnapshot,
  tabAtOwnFloor,
  topVisibleLineFrac,
  sourceTopOfV,
  landOnFrameGeometry,
} from "../sync-scroll";
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
import { attachTabToPanel, makeDoc, makeInstance, registerDoc, isMdTab } from "../doc-model";
import { updateTocDrawer } from "../toc";
import { retargetFindBar } from "../find/findbar";
import { saveDocCore } from "../io/files";
import { attachPasteHandler } from "../io/export";
import { showSaveConfirmDialog } from "../shell/saveconfirm";
import { createEditor } from "../editor/editor";
import { PreviewPane } from "../markdown/preview";
import { logViewport, recordScroll } from "../core/viewport";
import { attachUserScrollClear, isProgrammatic, markProgrammatic } from "../core/scroll-guard";
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

/** 结构变化后全量重建布局区（面板 view 销毁重建，状态都在 Tab 快照里）。 */
export function rebuildLayout(): void {
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
          // ⚠️ 落点走 `sourceTopOfV`（与跨侧同步 / 切模式交接同一个换算出口）：支持**小数**
          //    行号（块内比例），且末行按整行高落点（软折行也贴顶）。旧写法 `lineBlockAt(l.from).top`
          //    只认整数行首、又只取首视觉块高，预览→编辑器跟随时把末块取整到块首 ⇒ 兄弟格
          //    跟不到末块底（用户报：预览滚到底、源码停在上一个块首，差末块那几行）。
          const top = sourceTopOfV(v, Math.min(Math.max(line, 1), v.state.doc.lines));
          if (top === null) return;
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
            // ⚠️ **顺序**：必须先更新 `syncV` **再** `recordScroll` —— 后者内部会把
            //   `t.syncV` 落进会话记录（`sessionStore.setSyncV`），写反了落盘的就是**上一次**
            //   的游标（滞后一次滚动），重启后按陈旧 v 还原。
            const v = syncSourceV(t);
            if (v !== null) t.syncV = v;
            recordScroll(t.tabId, t.scrollTop);
          }
          // B132：写进快照还不算数 —— 得落盘。滚动本身**不触发**任何排程，用户
          // 滚到中段、没干别的事就关窗，会话里留下的还是上一次（滚之前那份），
          // 重启就回到老位置（B132）。防抖 800ms：滚动停下才写，不会每帧落盘。
          scheduleSessionSave();
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
        attachPasteHandler(p);
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
          scheduleSessionSave();
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
        // 同编辑器侧：先更新 `syncV` **再** `recordScroll`（后者会把 v 落盘，写反了滞后一次滚动）。
        //   v 无条件维护 —— 同步关着的预览标签此前也拿不到 v，1c 删掉像素轨后就没法还原位置了。
        const pv = syncSourceV(t);
        if (pv !== null) t.syncV = pv;
        recordScroll(t.tabId, t.scrollTop);
        pushSyncToSiblings(t, true);
        scheduleSessionSave();
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
  if (shownTab) shownTab.state = panel.view.view.state;
  // B126：setState 会重建 ViewState 并把视口拉回开头，采完这一眼再切换
  rememberViewScroll(panel);
  logViewport("切换 · 采旧位置后", panel);
  // B240 三轮：同步开着时，先把**源（刚显示的这一份）**的坐标就地采下来 —— 它马上要
  // 离屏，离屏之后就再也读不到它自己的实时 DOM 了（见下面 alignShownToSyncSource）。
  const syncSrc = syncSourceSnapshot(shownTab, tabId);
  // ⚠️ B284：与 `syncSrc` **同帧**把「源顶没顶到自己的底」一起采下 —— 此刻源还在屏、
  //    `tabAtOwnFloor` 问得出真话；再晚一步源已离屏（`clientHeight = 0`）⇒ 恒答「没到底」。
  const srcAtFloor = tabAtOwnFloor(shownTab);
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
  // B288⑤-4：原先这里有一条 `flushPendingSyncCursor(panel, tabId, true)`（B263 挂起补写，
  //  写「估算空间」的占位 px 进槽）。单轨下 `restoreViewScroll` 的 v 分支直接按 syncV
  //  现算落位（1b），占位值无用；measure 后的 rAF 会再按实测几何重落 —— 整条挂起机制
  //  （pendingSyncCursor / flushPendingSyncCursor）已删。
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
  // ⚠️ B284：撤掉留白后两侧 `maxScroll` 重新错配 ⇒ 收口需要「源顶没顶到自己的底」
  //    （`srcAtFloor`，在上面与 `syncSrc` 同帧采下）：到底 ⇒ 接班这份落到**它自己那一侧的
  //    底**，不再按游标换算（B266 当初是因为留白才把这层判据删掉的）。必须排在
  //    预览还原**之后**（B274）—— 见下面那一行。
  const handV = tab ? syncSrc : null;
  const aligned = tab ? alignShownToSyncSource(panel, shownTab, handV, srcAtFloor) : false;
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
    // ⚠️⚠️ **B284**：`handV` 是 `syncSourceSnapshot` 在离屏前从**源**采的真实 `v`，
    //    `srcAtFloor` 是同帧采下的「源到底了吗」。到底 ⇒ 兄弟各自落到**自己那一侧的底**
    //    （撤留白后两侧 maxScroll 错配，照游标换算会把对方拽离它的底 ⇒ 到底后来回滚会跳）。
    //    落点照旧由 `applySyncToSibling` 按目标那侧的几何裁（裁的是 DOM 写入，不是记录值）。
    //    这一趟两分支都用它，保证「接班」与「其余兄弟」是同一个数（B258 的要求）。
    if (tab && !aligned) {
      pushSyncToSiblings(tab, false, { v: handV, atFloor: srcAtFloor });
    } else if (tab && handV !== null && shownTab) {
      pushSyncToSiblings(tab, false, {
        v: handV,
        atFloor: srcAtFloor,
        skipTabIds: [shownTab.tabId, tab.tabId], // 源与接班都已被收口写好，谁也不许再动
      });
    }
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
    // ⚠️ B288 诊断：**这两条分支的 trace 是定位「拖完位置回顶」的关键** ——
    //    `disposePanel` 这条**没有** `splitPanelWithTab` 里 else 支那套按离屏前游标
    //    重落（`landOnFrameGeometry`），被拖标签在新面板重建后容易停在 0。
    //    复现时先看走的是哪一条，再对上 viewport 那几条「记忆 / 还原」trace。
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

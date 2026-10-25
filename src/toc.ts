// 大纲 TOC / 侧栏（从 main.ts 拆出，解耦第十步 / #411）。
//
// 职责：大纲视图（updateTocDrawer / refreshTocAtCursor / refreshTocToggleAll / toggleToc
// / tocListView 控制器与 tocEntries 状态）+ 左栏**整栏**可见性（applySidebarVisible /
// isSidebarOff / toggleSidebar / setupSideBar）。
// B307：展开区的开合、宽度与分隔条都搬到 `src/shell/drawer.ts`（外壳），这里只留
// 「整栏在不在」这一层和大纲这一块视图自己。
// 零外部函数依赖——只依赖 core/* + ui + shell/* + markdown/pipeline（TocEntry 类型），
// 对 main.ts 零反向依赖。

import { docs, settings, windowKind } from "./core/app-state";
import { activeTab, activePanel } from "./core/panels";
import { CODICONS } from "./shell/codicons";
import { activeDrawer, registerDrawerView, setDrawer } from "./shell/drawer";
import { setTip } from "./shell/tooltip";
import { saveSettings } from "./ipc/api";
import { extractOutline } from "./markdown/outline";
import { syncCoordinator } from "./sync-scroll/wire";
import { EditorView } from "@codemirror/view";
import {
  mainRow,
  sideOutline,
  sidebarToggle,
  tocGrip,
  tocList,
  tocPanel,
  tocToggleAll,
} from "./ui";
import { createTocList, activeOutlineLine, type TocListHandle } from "./markdown/toc";
import type { TocEntry } from "./markdown/pipeline";
// ---------------------------------------------------------------- 大纲 TOC（M3）

let tocEntries: TocEntry[] = [];

/**
 * B388：上一次重绘点亮的高亮行（`0` = 列表里没有任何一条是活动项）。
 * 光标移动只在这个数**变了**的时候才值得重绘 —— 见 `refreshTocAtCursor`。
 */
let renderedActiveLine = 0;

/**
 * B205：大纲列表控制器（**只建这一次**）。
 *
 * 折叠态在它里面，所以 `updateTocDrawer` 每次重绘都不能重新建一个 —— 光标一动就重绘，
 * 重建会把用户折的节冲回全展开。index.html 那两颗全量键（全部折叠 / 全部展开）也直接
 * 调它，不用再绕一层。
 *
 * B214（用户点名「手动折叠部分或全部元素时，顶部的按钮也要同步变化」）：把刷按钮的
 * `refreshTocToggleAll` 交给它当折叠变化通知 —— 于是**点扭角折一节、折完最后一节、
 * 点全量键**三条路都汇到这一处，按钮不会出现「手动折了、图标还停在旧的样子」。
 */
const tocListView: TocListHandle = createTocList(tocList, refreshTocToggleAll);

/**
 * B195：装配侧栏按钮列（字形 + 点击）+ 空隙里的三点把手 + B205 展开区那两颗全量键。
 *
 * 与 `setDrawer` 的分工：这里只管「装上 + 把大纲这一块登记进外壳」，开合态一律由
 * `src/shell/drawer.ts` 收口（面板 `hidden`、键的 `is-on` / `aria-pressed` 都在那一处写，
 * 免得两处各写一半不同步）。
 *
 * ⚠️ 全量键**不落盘**（折叠状态不写设置）：大纲是「当前这份文档」的一次性视图，
 *    跟置顶（窗口瞬时态）、大纲宽度（偏好）不是一个层级的东西。
 */
function setupSideBar(): void {
  sideOutline.innerHTML = CODICONS.outline;
  tocGrip.innerHTML = CODICONS.grip;
  sideOutline.addEventListener("click", () => toggleToc());
  sidebarToggle.addEventListener("click", () => toggleSidebar());
  // B307：把大纲这一块**登记进外壳**。点亮态与 `hidden` 都由 `setDrawer` 写，这里只交
  // 「面板 / 键 / 摊开时重绘什么」三样 —— 启动回放（`setDrawer(..., false)`）排在装配之后，
  // 登记早于回放才不会回放到一个不存在的视图。
  registerDrawerView("toc", { panel: tocPanel, button: sideOutline, onShow: updateTocDrawer });
  // B209：一颗键在「全部折叠 ⇄ 全部展开」之间切换。字形 / aria-label / 提示 / 按下态
  // **四处同源**（都在下面这一个函数里），免得出现「图标已经是展开、读屏器还念折叠」。
  tocToggleAll.addEventListener("click", () => {
    if (tocListView.allCollapsed()) tocListView.expandAll();
    else tocListView.collapseAll();
    refreshTocToggleAll();
  });
  refreshTocToggleAll();
}

/**
 * B209：把那颗合并键刷成「当前这一下会做什么」的样子 —— 还没全折 ⇒ 显示折叠，
 * 已经全折 ⇒ 显示展开。
 *
 * ⚠️ 每次重绘列表都要跟着刷：`branchIds` 是随文档变的（换了一份没有子标题的文档，
 *    分支数变 0），只看按钮自己的点击会停在过期状态上。
 */
function refreshTocToggleAll(): void {
  const willCollapse = !tocListView.allCollapsed();
  tocToggleAll.innerHTML = willCollapse ? CODICONS.collapseAll : CODICONS.expandAll;
  const label = willCollapse ? "全部折叠" : "全部展开";
  tocToggleAll.setAttribute("aria-label", label);
  tocToggleAll.setAttribute("data-tip", label);
  // 按下态 = 「当前是全折着」，与置顶 / 同步那两颗同口径（状态落在 aria-pressed 上）
  tocToggleAll.setAttribute("aria-pressed", String(!willCollapse));
}

/**
 * B198：左栏**整栏**显隐（标题栏那颗 layout-sidebar-left / -off）。
 *
 * 与外壳的 `setDrawer` 是**两层、互不撤销**：
 *   · 这一处管「左栏在不在」—— 侧栏卡片、中间缝一起收光（用户点名「直接隐藏整个左边栏」）；
 *   · `setDrawer` 管「卡片里的展开区开没开」。
 * 整栏收着时展开区的开合值照旧留在设置里，重新露出时回到用户上次的样子 —— 谁也不替
 * 对方清状态。
 *
 * ⚠️ 与 VS Code 的差别只在**生效范围**：那边折的只是展开区、活动栏仍在（按钮一直显示），
 *   本软件收的是整张卡片；但**这颗键本身**两边都一样始终显示 —— 它是左栏唯一的开关入口，
 *   跟着一起收就没法再点回来了。
 *
 * `persist = false` 用于**启动时回放**（口径同 `setDrawer`）。
 */
function applySidebarVisible(off: boolean, persist = true): void {
  mainRow.classList.toggle("is-sidebar-off", off);
  // 双字形：左栏在画 layout-sidebar-left，收起画 layout-sidebar-left-off —— 与置顶键
  // （pinned / pin）、同步滚动键（link / unlink）同款，状态全落在字形上，不靠配色。
  sidebarToggle.innerHTML = off ? CODICONS.layoutSidebarLeftOff : CODICONS.layoutSidebarLeft;
  sidebarToggle.classList.toggle("is-on", !off);
  sidebarToggle.setAttribute("aria-pressed", String(!off));
  // 开与关两句都要改：tooltip / aria-label / 读屏器读的是同一个 label。
  const label = off ? "显示左栏" : "隐藏左栏";
  sidebarToggle.setAttribute("aria-label", label);
  setTip(sidebarToggle, label);
  if (!persist || !settings) return;
  settings.sidebar_off = off;
  void saveSettings(settings).catch(() => {
    // 持久化失败不影响本次生效（与分隔条回写宽度同一口径）
  });
}

/** 左栏当前是不是整栏收着（判据只有一处：#main-row 上的那个类）。 */
function isSidebarOff(): boolean {
  return mainRow.classList.contains("is-sidebar-off");
}

function toggleSidebar(): void {
  // 当前「整栏收着」取反 =「接下来是否该收」。
  applySidebarVisible(!isSidebarOff());
}

/**
 * 摊开 / 收起大纲这一块。
 *
 * B307：开合本身归外壳（`src/shell/drawer.ts` 的 `setDrawer` 是唯一出口，面板 `hidden`、
 * 卡片 `is-collapsed`、分隔条 `is-off`、两颗键的点亮态与 `toc_open` 落盘都在那一处写完），
 * 这里只留「大纲这一块要不要轮到」和它前面那两道闸。
 */
function toggleToc(): void {
  // B305：子窗口没有左边栏（CSS 收掉了整张卡片）。快捷键 / 命令面板那一路不打这条例子
  // 就会「打开一块看不见的面板」，顺带把 `toc_open` 写成 true 落盘 —— 下次到主窗口里
  // 就表现为「也没点它，大纲自己开起来了」。
  if (windowKind === "satellite") return;
  // B198：整栏收着时，「大纲」这条命令（菜单 / 快捷键入口）先把它整栏放出来 ——
  // 展开区藏在 display:none 的容器里，光切开合等于点了没反应（死键）。
  if (isSidebarOff()) applySidebarVisible(false);
  // 已经是当前视图 ⇒ 收起外壳；否则把外壳摊开并切到大纲（互斥由外壳一处保证）。
  setDrawer(activeDrawer() === "toc" ? null : "toc");
}

function updateTocDrawer(): void {
  if (tocPanel.hidden) return;
  const tab = activeTab();
  if (!tab) {
    tocEntries = [];
    renderedActiveLine = 0;
    tocListView.render(null, -1, { onJump: () => {} });
    // B209：分支列表随文档变，那颗合并键要跟着刷（换到没有标题的文档 ⇒ 回到「折叠」那一支）
    refreshTocToggleAll();
    return;
  }
  // 多格式大纲（B33）：md 之外 toml/ini/yaml/json/py 也有大纲；
  // null = 格式不支持 → 空态文案不同
  const doc = docs.get(tab.docId);
  const result = doc ? extractOutline(doc.name, tab.state.doc.toString()) : null;
  if (result === null) {
    tocEntries = [];
    renderedActiveLine = 0;
    tocListView.render(null, -1, { onJump: () => {} });
    refreshTocToggleAll();
    return;
  }
  tocEntries = result;
  const cursorLine = tab.state.doc.lineAt(tab.state.selection.main.head).number;
  // B388：记下「这一次点亮的是哪一行」，光标移动的兜底闸（refreshTocAtCursor）拿它比。
  renderedActiveLine = activeOutlineLine(tocEntries, cursorLine) ?? 0;
  // B205：`createTocList` **只建一次**（建表那一刻它记下折叠态的容器），重绘只走
  //       render —— 光标一动就重绘，每次重建控制器会把用户折的节冲回全展开。
  //       ⚠️ `onJump` 保持内联在 render 的这一份参数里：tests/static.ts 的静态契约
  //           按 `onJump: (entry) => {` 这句原文切片，提成具名函数会整段失配。
  tocListView.render(tocEntries, cursorLine, {
    onJump: (entry) => {
      const panel = activePanel();
      const tab2 = activeTab();
      if (!panel?.view || !tab2) return;
      const line = Math.min(Math.max(1, entry.line), tab2.state.doc.lines);
      const pos = tab2.state.doc.line(line).from;
      // 活动实例：视图定位 + 聚焦（y:"start" 把标题行顶到视口顶部；
      // scrollIntoView:true 是最小滚动，行在视口下方时会贴底）
      panel.view.view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 0 }),
      });
      tab2.state = panel.view.view.state;
      // v1：编辑器已 scrollIntoView 定位，把落点广播给同文档预览/其它面板
      // （取代旧的 preview.syncToLine；B152 关则不广播）。
      // ⚠️ 坐标由这一跳自己给（`line`），不把编辑器锚点交给协调器去读：这一格处于**预览态**时
      // 编辑器是隐藏的，它的 `scrollTop` 恒 0、下一帧只会报出兜底的 1.00 ⇒ 所有窗口一起复位到
      // 顶部（B301，真机 19:23:27 / 19:23:33 两轮 `外发 doc=1 v=1.00 驱动=[?]` 就是这么来的）。
      syncCoordinator.syncTo(String(tab2.docId), line);
      panel.view.focus();
      updateTocDrawer();
    },
  });
  // B209：重绘后 `branchIds` 是新的（换文档/改标题都会变），合并键要按新分支表刷一次，
  // 否则它会停在上一份文档的「已全折」状态上（图标显示展开，点下去却还是折叠）。
  refreshTocToggleAll();
}

/**
 * B388（用户点名「光标没有正好处在标题上时，大纲也要能高亮对应段落所在的标题项」）：
 * 光标一动就问一声 —— 但**只有跨过章节边界**才真的重绘。
 *
 * 为什么不无条件重绘：`updateTocDrawer` 干的是「整份文档重取大纲 + 整个列表重建 DOM」，
 * 而方向键每按一下都会走到这里（CM6 的 updateListener 认 `selectionSet`）。长文档里
 * 那就是每键一次全量重算，而高亮行没变时重绘出来的样子与现在**一模一样**，纯属白做。
 *
 * ⚠️ 只许**活动面板**上报（main 的 handleUpdate 那一档）：`tocEntries` 是活动面板那份
 *    文档的大纲，拿别的面板的光标行去比会误判成「跨了章节」，把大纲抢画成不相干的位置。
 */
function refreshTocAtCursor(line: number): void {
  if (tocPanel.hidden) return;
  if ((activeOutlineLine(tocEntries, line) ?? 0) !== renderedActiveLine) updateTocDrawer();
}

export {
  setupSideBar,
  refreshTocToggleAll,
  applySidebarVisible,
  isSidebarOff,
  toggleSidebar,
  toggleToc,
  updateTocDrawer,
  refreshTocAtCursor,
};

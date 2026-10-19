// 大纲 TOC / 侧栏（从 main.ts 拆出，解耦第十步 / #411）。
//
// 职责：大纲抽屉（updateTocDrawer / refreshTocToggleAll / toggleToc / tocListView
// 控制器与 tocEntries 状态）、侧栏可见性与宽度（applySidebarVisible / isSidebarOff /
// toggleSidebar / setSideOpen / setupSideBar / setupSideResizer / sideWidth）。
// 零外部函数依赖——只依赖 core/* + ui + shell/* + markdown/pipeline（TocEntry 类型），
// 对 main.ts 零反向依赖。

import { docs, settings, windowKind } from "./core/app-state";
import { activeTab, activePanel } from "./core/panels";
import { CODICONS } from "./shell/codicons";
import { setTip } from "./shell/tooltip";
import { saveSettings } from "./ipc/api";
import { extractOutline } from "./markdown/outline";
import { syncCoordinator } from "./sync-scroll/wire";
import { EditorView } from "@codemirror/view";
import {
  mainRow,
  recentPanel,
  sideOutline,
  sideShell,
  sidebarToggle,
  closeRecentDrawer,
  tocGrip,
  tocList,
  tocPanel,
  tocResizer,
  tocToggleAll,
} from "./ui";
import {
  attachSideResizer,
  clampSideWidth,
  createTocList,
  type TocListHandle,
} from "./markdown/toc";
import type { TocEntry } from "./markdown/pipeline";
// ---------------------------------------------------------------- 大纲 TOC（M3）

let tocEntries: TocEntry[] = [];

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

/** 大纲宽度（由设置载入、拖拽后回写设置；160–640px） */
let sideWidth = 240;

/**
 * B235：`sideResizerHandle` 这个句柄已删 —— 设置页那个「大纲宽度」下拉移除后，
 * 它唯一的读者（`setTocWidthValue` 里那句 `setWidth`）没了，`tsc` 的
 * `noUnusedLocals` 会拦这种「只赋值不读取」的变量。
 * ⚠️ `attachSideResizer(...)` 的调用本身必须留着 —— 它才是真正注册拖拽监听、
 *    并把 `onChange` 接上「夹取 → 回写设置」的那一步。返回值直接丢弃即可。
 */

/**
 * B305：两块展开区（大纲 / 最近打开）共用同一档抽屉宽度。
 *
 * 分隔条的 inline 宽度只写在 `#toc-panel` 上（`attachSideResizer` 里那一发 `apply`），
 * 这里把同一份数抄给 `#recent-panel`。漏了这一步：拖完分隔条再点「最近打开」，抽屉会
 * 跳回 CSS 里那个默认 240px —— 用户读作「宽度设置丢了」。
 * 省略 `w` 时抄 `#toc-panel` 上现有的那一份（打开最近面板那一路走这一支）。
 */
function applyDrawerWidth(w?: number): void {
  const width = w ?? Number.parseFloat(tocPanel.style.width);
  if (!Number.isFinite(width)) return;
  for (const panel of [tocPanel, recentPanel]) {
    panel.style.width = `${width}px`;
    panel.style.minWidth = `${width}px`;
  }
}

/** 挂载大纲宽度分隔条。设置未就绪（settings 为 null）时只生效不持久化。 */
function setupSideResizer(): void {
  sideWidth = clampSideWidth(settings?.toc_width ?? 240);
  attachSideResizer(tocResizer, tocPanel, {
    initial: sideWidth,
    // B207（用户点名「拖到最小后再往左拖就隐藏展开区，隐藏后分割线仍可拖回来」）：把
    // 收放的两个口子接到 `setSideOpen` —— 拖分隔条和点那颗「大纲」键走**同一条**路，
    // 键的点亮态 / 落盘都在 `setSideOpen` 一处收着，这里只当传声筒。
    // ⚠️ `isOpen` 问的是面板自己（`tocPanel.hidden`）而不是另存一个布尔：显隐的唯一
    //    出口是 `setSideOpen`，复制一份状态迟早跟它错开。
    isOpen: () => !tocPanel.hidden,
    onOpenChange: (open) => {
      setSideOpen(open);
    },
    onChange: (w) => {
      sideWidth = w;
      // 拖到哪，两块展开区都跟到哪（最近打开那块平时藏着，藏着也得跟着改宽度）。
      applyDrawerWidth(w);
      if (!settings) return;
      settings.toc_width = w;
      void saveSettings(settings).catch(() => {
        // 持久化失败不影响本次生效
      });
    },
  });
}

/**
 * B195：装配侧栏按钮列（字形 + 点击）+ 空隙里的三点把手 + B205 展开区那两颗全量键。
 *
 * 与 `setSideOpen` 的分工：这里只管「装上」，开合态一律由 `setSideOpen` 收口
 * （按钮的 `is-on` / `aria-pressed` 也在那儿写，免得两处各写一半不同步）。
 *
 * ⚠️ 全量键**不落盘**（折叠状态不写设置）：大纲是「当前这份文档」的一次性视图，
 *    跟置顶（窗口瞬时态）、大纲宽度（偏好）不是一个层级的东西。
 */
function setupSideBar(): void {
  sideOutline.innerHTML = CODICONS.outline;
  tocGrip.innerHTML = CODICONS.grip;
  sideOutline.addEventListener("click", () => toggleToc());
  sidebarToggle.addEventListener("click", () => toggleSidebar());
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
 * 与 `setSideOpen` 是**两层、互不撤销**：
 *   · 这一处管「左栏在不在」—— 侧栏卡片、中间缝一起收光（用户点名「直接隐藏整个左边栏」）；
 *   · `setSideOpen` 管「卡片里的展开区开没开」。
 * 整栏收着时展开区的开合值照旧留在设置里，重新露出时回到用户上次的样子 —— 谁也不替
 * 对方清状态。
 *
 * ⚠️ 与 VS Code 的差别只在**生效范围**：那边折的只是展开区、活动栏仍在（按钮一直显示），
 *   本软件收的是整张卡片；但**这颗键本身**两边都一样始终显示 —— 它是左栏唯一的开关入口，
 *   跟着一起收就没法再点回来了。
 *
 * `persist = false` 用于**启动时回放**（口径同 `setSideOpen`）。
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
 * B194：开/关左侧栏（大纲），并把状态写进设置。
 *
 * `persist = false` 用于**启动时回放**：那时只是把盘上的值搬到 DOM，不该反过来再写一次盘
 * （写回去会把「加载失败 → 用默认值」那次的值固化成用户设置）。
 *
 * B195：这里同时是**按钮列点亮态的唯一出口** —— 面板显隐、空隙把手、按钮 `is-on` /
 * `aria-pressed` 四件事一处收口，避免「面板开了但键没亮」这类半同步。
 *
 * B201 补第五件：卡片自身的 `is-collapsed`（按钮列 ↔ 展开区那条内部竖线的显隐）。
 * 收着时按钮列右缘那条线与卡片自己的右缘线会挨在一起变成 2px 粗的一条，所以得一起收。
 */
function setSideOpen(open: boolean, persist = true): void {
  tocPanel.hidden = !open;
  // 空隙（分隔条）**不跟着隐藏**：它是侧栏卡片与编辑区卡片之间的固定间距，
  // 收起时只是展开区折起来 —— 这条缝本身**照样能抓**（B207：旧口径在这里连缝一起掐了
  // 指针、把手也隐身，往左拖到底就成了一条死带，往右拖也拖不回来），收起态唯一的意义
  // 就是「缝还在、间距不跳变」。收**整张卡片**那一档才连缝一起不占位。
  tocResizer.classList.toggle("is-off", !open);
  // 卡片上的这条同类名：内部那条竖线只在「展开区确实摊开着」时才值得画。
  sideShell.classList.toggle("is-collapsed", !open);
  sideOutline.classList.toggle("is-on", open);
  sideOutline.setAttribute("aria-pressed", String(open));
  if (open) updateTocDrawer();
  // B305：两块展开区互斥 —— 大纲摊开时把「最近打开」收起来。收的动作仍由面板自己那一个
  // 出口做（连键的点亮态一起翻），这里只负责「叫它收」；反向那一半在 `setRecentOpen` 里。
  if (open) closeRecentDrawer();
  if (!persist || !settings) return;
  settings.toc_open = open;
  void saveSettings(settings).catch(() => {
    // 持久化失败不影响本次生效（与分隔条回写宽度同一口径）
  });
}

function toggleToc(): void {
  // B305：子窗口没有左边栏（CSS 收掉了整张卡片）。快捷键 / 命令面板那一路不打这条例子
  // 就会「打开一块看不见的面板」，顺带把 `toc_open` 写成 true 落盘 —— 下次到主窗口里
  // 就表现为「也没点它，大纲自己开起来了」。
  if (windowKind === "satellite") return;
  // B198：整栏收着时，「大纲」这条命令（菜单 / 快捷键入口）先把它整栏放出来 ——
  // 展开区藏在 display:none 的容器里，光切开合等于点了没反应（死键）。
  if (isSidebarOff()) applySidebarVisible(false);
  // 当前 hidden 取反即「接下来是否展开」
  setSideOpen(tocPanel.hidden);
}

function updateTocDrawer(): void {
  if (tocPanel.hidden) return;
  const tab = activeTab();
  if (!tab) {
    tocEntries = [];
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
    tocListView.render(null, -1, { onJump: () => {} });
    refreshTocToggleAll();
    return;
  }
  tocEntries = result;
  const cursorLine = tab.state.doc.lineAt(tab.state.selection.main.head).number;
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

export {
  setupSideResizer,
  setupSideBar,
  refreshTocToggleAll,
  applySidebarVisible,
  isSidebarOff,
  toggleSidebar,
  setSideOpen,
  toggleToc,
  updateTocDrawer,
  applyDrawerWidth,
};

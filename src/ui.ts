// src/ui.ts —— 启动计时 / DOM 句柄 / 基础访问 / 状态呈现
//
// 从 main.ts 抽出的共享 UI 服务簇：持有标题栏与状态栏的 DOM 句柄、编辑器/预览的
// 基础访问器，以及标题/状态刷新、同步滚动按钮、全局刷新、活动面板标记等纯呈现逻辑。
// 这些函数彼此耦合且都依赖同一批 DOM 句柄，故整体搬家，main.ts 通过本模块导出的
// 句柄与函数复用，不再各自持有副本。
//
// 解耦纪律：本模块只依赖 shell/*、core/*，绝不 import main.ts；
// 反过来 main.ts 在 bootstrap 期通过四个 DI setter 把本模块需要的渲染回调
// （视图模式键 / 大纲抽屉 / 标签条 / 面板操作键）注入进来，避免 main ↔ ui 循环依赖。

import { invoke } from "@tauri-apps/api/core";
import { emitCrossWindow } from "./ipc/api";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { EditorView } from "@codemirror/view";
import { CODICONS } from "./shell/codicons";
import { setTip } from "./shell/tooltip";
import { EVT_DOC_OPEN, EVT_DOC_CLOSE_NOTIFY } from "./core/events";
import { activeTab, getPanel, visibleInstancesOfDoc } from "./core/panels";
import {
  Tab,
  Panel,
  panels,
  docs,
  tabs,
  docSyncOn,
  setActivePanelId,
  activePanelId,
  remoteOpenByWindow,
} from "./core/app-state";
import { el } from "./dom";

// ------------------------------------------------------------------ 启动计时（B50）

/** 模块脚本执行到本文件首行的时刻（相对 navigationStart）。 */
const BOOT_T0 = performance.now();
const BOOT_MARKS: string[] = [];

/**
 * 记录一个启动阶段的耗时（从 `from` 到现在），并返回当前时刻以便串成链。
 * 只进诊断日志（`frontend_ready` 的 detail），失败也不影响启动。
 */
function bootMark(name: string, from = BOOT_T0): number {
  const now = performance.now();
  BOOT_MARKS.push(`${name}=${Math.round(now - from)}ms`);
  return now;
}

/**
 * 上报一条启动阶段的诊断（写进 Rust 侧 `%TEMP%\litepad-smoke.log`）。
 *
 * B50 备注：窗口不再先隐藏再显形——那样「窗口是否出现」就完全取决于前端
 * 能否跑完 bootstrap，一旦前端卡住用户就是「点了图标什么都没有」。
 * 现在窗口照常可见、底色由 Rust 刷成主题色（`main.rs` 的
 * `set_background_color`），这里只负责回传各阶段耗时，方便定位启动慢在哪段。
 */
function reportBoot(stage: string): void {
  void invoke("frontend_ready", { detail: `${stage} [${BOOT_MARKS.join(" ")}]` }).catch(() => {
    /* 诊断上报失败不阻塞启动 */
  });
}

const layoutArea = el("layout-area");
const menuBar = el("menu-bar");
// 自定义标题栏（B97）：左侧软件图标 + 菜单，中间显示文档名，右侧工具键 + 三颗窗口控制键。
// 原来那 8 颗快捷键按钮（新建/打开/保存/另存/查找/大纲/导出/主题）已移除，
// 前六个本就在菜单里，导出与主题分别回到「文件 → 导出」「设置 → 首选项」。
// B192：标题栏本体 —— 拖动与双击最大化都由 setupTitleBar 自己接（见那里）：
// ⚠️ 不用 Tauri 的 `data-tauri-drag-region`（吞 mouseup、会卡在移动循环，Tauri #10767），
//    也不用 WebView2 原生 `app-region: drag`（第一下移动发涩，B191 试过已否掉）。
const titleBar = el("title-bar");
const appMark = el("app-mark");
const titleText = el("title-text");
// B152：同步滚动开关（同一文档开着多份时才出现，显隐与点亮态见 refreshSyncButton）。
// 初值由 index.html 给成 hidden —— 单次打开时不该有一颗点不动的键占着标题栏。
const syncScrollBtn = el<HTMLButtonElement>("sync-scroll");
const winMinimize = el<HTMLButtonElement>("win-minimize");
const winMaximize = el<HTMLButtonElement>("win-maximize");
const winClose = el<HTMLButtonElement>("win-close");
// 「钉在顶部」（B99）：切换当前窗口的置顶态。**不落盘** —— 置顶是窗口的瞬时状态，
// 而 settings.json 存的全是偏好（主题/字号/行距/键位…），窗口几何与最大化态都没存过，
// 这里跟着同一口径走：重启后回到不置顶。
const winPin = el<HTMLButtonElement>("win-pin");
const tocPanel = el("toc-panel");
// B205：展开区拆成「标题栏 + 列表」两条 —— 重绘只清列表，标题栏是静态结构
// （renderToc 时代清的是整个 #toc-panel，标题栏会被一起抹掉）。
const tocList = el("toc-list");
// B209：全量折叠/展开合并成**一颗**键（原 #toc-collapse-all / #toc-expand-all 两颗）。
const tocToggleAll = el<HTMLButtonElement>("toc-toggle-all");
// B307：分隔条调的是**外壳**的宽度，名字跟着元素走（`#side-resizer`），不再挂在「大纲」名下。
const sideResizer = el("side-resizer");
// B201：左栏**卡片**（按钮列 + 展开区），展开区折起时它挂 `is-collapsed`
// —— 那条内部竖线（按钮列 ↔ 展开区）要跟着收，见 preview.css / global.css 的同款说明。
const sideShell = el("side-shell");
// B195：侧栏按钮列里的「大纲」键（常驻，收起展开区时列本身还在）与空隙里的三点把手。
const sideOutline = el<HTMLButtonElement>("side-outline");
// B305：侧栏第二颗键（最近打开）与它的展开区。B307 起显隐归外壳（`shell/drawer.ts` 的
// `setDrawer`），这两颗键的 `is-on` / `aria-pressed` 也在那一处跟着当前视图一起翻。
const sideRecent = el<HTMLButtonElement>("side-recent");
const recentPanel = el("recent-panel");
// B307（方案乙）：两块展开区共用的**外壳**。宽度、显隐、按钮列那条内部竖线都写在它身上，
// 唯一出口是 `src/shell/drawer.ts` 的 `setDrawer`。
const sideDrawer = el("side-drawer");
const recentList = el("recent-list");
const recentCount = el<HTMLSpanElement>("recent-count");
const recentClear = el<HTMLButtonElement>("recent-clear");
const tocGrip = el("toc-grip");
// B198：标题栏那颗整栏显隐键，与它收放的是 #main-row 这一整行（侧栏卡片 → 缝 → 编辑区）。
const sidebarToggle = el<HTMLButtonElement>("sidebar-toggle");
const mainRow = el("main-row");
const sbMessage = el("sb-message");
const sbPos = el("sb-pos");
const sbCount = el("sb-count");
const sbEncoding = el<HTMLButtonElement>("sb-encoding");
const sbEol = el<HTMLButtonElement>("sb-eol");
// B233：状态栏语言项是**纯展示**（md 也不再来回切视图）⇒ HTML 侧已改成 <span>。
const sbLang = el<HTMLSpanElement>("sb-lang");

const LOSSY_ABORT = Symbol("lossy-abort");

// ---------------------------------------------------------------- 基础访问

/**
 * B178：某个**别的窗口**也开着这份文档（可见实例）吗？
 *
 * 跨窗口「多开」的判据只认「别的窗口可见地开着」—— 隐藏实例（`panelId < 0`）不算，
 * 与 `visibleInstancesOfDoc` 同口径。任一远端窗口开着就算 1（不关心具体开了几份）。
 */
function remoteHasDoc(docId: number): boolean {
  for (const set of remoteOpenByWindow.values()) {
    if (set.has(docId)) return true;
  }
  return false;
}

/** 由编辑器视图反查所属面板（不依赖创建期闭包，实例跨面板移动后依然正确）。 */
function panelOfView(view: EditorView): Panel | undefined {
  for (const p of panels.values()) {
    if (p.view && p.view.view === view) return p;
  }
  return undefined;
}

// ---------------------------------------------------------------- 状态呈现

function showMessage(text: string, isError = false): void {
  sbMessage.textContent = text;
  sbMessage.classList.toggle("sb-message-error", isError);
}

function updatePositionOf(panelId: number, view: EditorView): void {
  if (panelId !== activePanelId) return;
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  sbPos.textContent = `行 ${line.number}, 列 ${head - line.from + 1}`;
  sbCount.textContent = `${view.state.doc.length} 个字符`;
}

let diagSetTitle = "skipped";

function refreshTitle(): void {
  const tab = activeTab();
  const doc = tab ? docs.get(tab.docId) : undefined;
  // 用 `•`（U+2022）而不是标签栏那个 `●`（U+25CF）：后者是按整个 em 画的几何实心圆，
  // 在 12.5px 的标题字号下几乎与文字等高，用户报「太大了」。标签栏那颗不受影响 ——
  // 它坐在固定尺寸槽位里、由 CSS 控大小（见 global.css 的 `.tab-mark`）。
  const mark = doc?.dirty ? " •" : "";
  const suffix = doc?.readonly ? " [只读]" : "";
  // 软件名在前，文件名在后：无文档时只有 LitePad
  const title = doc ? `LitePad - ${doc.name}${mark}${suffix}` : "LitePad";
  // 自建标题栏（B97）中间那一行只放文档名：应用名已由窗口/任务栏承担，再写一遍是噪声
  // （VS Code 同款取舍）。无文档时留空，而不是回落到「LitePad」。
  titleText.textContent = doc ? `${doc.name}${mark}${suffix}` : "";
  void getCurrentWindow()
    .setTitle(title)
    .then(() => {
      diagSetTitle = "ok";
    })
    .catch((err) => {
      diagSetTitle = String(err);
    });
  // B152：按钮的显隐与点亮态跟文档名一起刷新（切标签、脏态变化都走这里）。
  refreshSyncButton(tab);
}

/**
 * B152：同步滚动按钮的显隐与点亮态。
 *
 * 显隐条件是「**当前激活文档开着多份**」—— 只有一份时根本无从「同步」，摆一颗点不动
 * 的键，用户只会以为坏了。
 *
 * B171：「多份」只数**本窗口内**的实例，主窗口与子窗口同口径。
 * B164 曾让子窗口额外认「这份文档在别的窗口也有」，结果是同文件
 * 只开一份时子窗口也露出这颗键 —— 而它对应的那份是主窗口的**隐藏实例**，主窗口
 * 自己数也只算 1 份、同样不显示。口径不一致，且同步到一个看不见的实例没有意义。
 * B173：再多滤一层 —— 本窗口内**隐藏**实例（`panelId < 0`，标签搬到别的窗口后留下的
 * 那份）也不算数。它进不了任何面板，用户看不见，按它凑出「第 2 份」就会让「只开了
 * 一份」的窗口露出这颗键。
 *
 * ⚠️ 状态读的是 `docSyncModes`（按**文档**记），所以切换激活文档时这里读出来的仍是
 *    那份文档自己的开关值 —— 按钮不复位，这正是「一个文档有一个同步滚动状态」。
 */
function refreshSyncButton(tab: Tab | undefined): void {
  // 图标在启动时给过一次（见图标初始化那批），这里只管显隐与点亮态。
  // 无文档 ⇒ 藏；数量是一个便宜的循环（实例数很小），不用缓存。
  // ⚠️ 先算出布尔量：直接写 `hidden = !tab || …` 是收窄不了 `tab` 的，后面那句
  //    `if (hidden) return` 挡不住「tab 可能是 undefined」这条报错。
  // B178：跨窗口多开也算「多份」—— 本窗口可见实例 > 1，或任一别的窗口也可见地开着这份。
  // 状态一致性随卫星标签载荷一起搬运（`syncMode`，见 multiwindow/windows.ts），这里只补
  // 显隐：两个窗口都数到 ≥2 份，同步键就都露脸。仍只数**可见**实例（B171/B173 口径不变）。
  const multi = !!tab && (visibleInstancesOfDoc(tab.docId).length > 1 || remoteHasDoc(tab.docId));
  syncScrollBtn.hidden = !multi;
  if (!multi) return;
  const on = docSyncOn(tab.docId);
  // B166：字形随开关切换 —— 开 = link（连着）、关 = unlink（链环分开的那颗）。
  // 状态全落在字形上（与置顶键同口径），不再靠配色；`.is-on` 只留给 aria /
  // tooltip 那层语义，视觉上与常态无差。
  syncScrollBtn.innerHTML = on ? CODICONS.link : CODICONS.unlink;
  syncScrollBtn.classList.toggle("is-on", on);
  // 开关的状态要用 aria-pressed 报给读屏器，光靠配色等于没报。
  syncScrollBtn.setAttribute("aria-pressed", String(on));
  const label = on ? "取消同步滚动" : "同步滚动";
  syncScrollBtn.setAttribute("aria-label", label);
  // B297：这颗键重新是真的开关 —— 翻转会驱动本窗口的联动并广播给装着同一份文档的
  //    其它窗口（开关是那份文档的属性，不是这个窗口的属性）。
  setTip(
    syncScrollBtn,
    on
      ? "取消同步滚动（同一份文件在所有窗口同步滚动位置）"
      : "同步滚动（同一份文件在所有窗口同步滚动位置）",
  );
}

function refreshStatus(): void {
  const tab = activeTab();
  const doc = tab ? docs.get(tab.docId) : undefined;
  sbEncoding.textContent = doc?.encoding ?? "UTF-8";
  sbEol.textContent = doc?.mixedEol ? "Mixed" : (doc?.eol ?? "CRLF");
  // B58：提示走自绘层（原生 title 的配色/键帽都不可控）
  if (doc?.mixedEol) {
    setTip(sbEol, "行尾混用", { detail: `保存时将统一为 ${doc.eol}` });
  } else {
    setTip(sbEol, "点击切换行尾", { detail: "保存时生效" });
  }
  sbCount.textContent = `${tab?.state.doc.length ?? 0} 个字符`;
  sbEncoding.disabled = !tab;
  sbEol.disabled = !tab;
  // B180：光标位置（行/列）也必须归这里刷 —— 否则「切换激活文件时底部光标位置不刷新」。
  //
  // ⚠️ 千万别指望 `handleUpdate` 里那句 `updatePositionOf` 顺带覆盖到：整态切换
  //    （`EditorView` 的那个同名方法）**不触发 updateListener** —— 它把插件 `destroy`
  //    掉再整个重建，压根不走 `update()` 循环，而切标签 / 换文档走的正是这条路。
  //    于是切换之后没人更新 `sbPos`，状态栏会一直挂着**上一个文件**的行号，
  //    看着就像「光标位置没恢复」。
  //
  // ⚠️ 取「活动面板的活视图」而不是标签快照：视图才是当前真正显示的那一眼；取不到
  //    （面板未挂载 / 还没建视图）再回落到标签快照，至少别留在上一个文件的行号上。
  const activePanel = getPanel(activePanelId);
  if (activePanel?.view) {
    updatePositionOf(activePanel.panelId, activePanel.view.view);
  } else if (tab) {
    const head = tab.state.selection.main.head;
    const line = tab.state.doc.lineAt(head);
    sbPos.textContent = `行 ${line.number}, 列 ${head - line.from + 1}`;
  }
  // 状态栏视图切换按钮跟随活动标签（切面板/切标签都经过这里）
  refreshViewModeButtonRef();
}

/**
 * B178：把本窗口「有可见实例的 docId 集合」广播给别的窗口，并维护回声过滤的 diff 基准。
 *
 * 只数 `panelId >= 0` 的实例（隐藏实例不算，B171/B173 同口径）。与上次的集合 diff：
 * 新增的文档广播 `EVT_DOC_OPEN`，消失的广播 `EVT_DOC_CLOSE_NOTIFY`；没变就不发，避免
 * `refreshAll` 每轮都刷屏。对端收到后写进 `remoteOpenByWindow`，按钮显隐据此对齐。
 *
 * ⚠️ 这是「本窗口文档集合变了」的唯一广播点：开标签走 `refreshAll`、关标签走
 *     `closeTabById`，两条路径都调它，覆盖全（含标签搬到别的窗口后本地留隐藏实例那种
 *     「可见集合缩水」的情况）。
 */
let lastBroadcastDocIds = new Set<number>();

function broadcastDocPresence(): void {
  const now = new Set<number>();
  for (const t of tabs.values()) {
    if (t.panelId >= 0) now.add(t.docId);
  }
  for (const docId of now) {
    if (!lastBroadcastDocIds.has(docId)) {
      void emitCrossWindow(EVT_DOC_OPEN, { docId }).catch(() => {});
    }
  }
  for (const docId of lastBroadcastDocIds) {
    if (!now.has(docId)) {
      void emitCrossWindow(EVT_DOC_CLOSE_NOTIFY, { docId }).catch(() => {});
    }
  }
  lastBroadcastDocIds = now;
}

function refreshAll(): void {
  refreshTitle();
  refreshStatus();
  refreshViewModeButtonRef();
  updateTocDrawerRef();
  renderPanelTabsRef();
  // B224：md 两颗键跟着活动面板 / 活动标签走，任何全局刷新都要同步一遍
  // （开/关标签、复制实例、会话恢复都可能改变「活动面板的标签是不是 md」）。
  renderPanelOpsRef();
  // B178：本窗口可见文档集合变了，通知别的窗口（开/关标签、认领、搬移都进这里）。
  broadcastDocPresence();
}

/**
 * 切活动面板，并**就地**同步 `.layout-panel-active`（不重建任何 DOM）。
 *
 * 为什么需要它：焦点面板的视觉表达（非活动分屏里活动标签降亮度）依赖这个 class
 * 实时正确，而 `renderSplitview` 只在布局结构变化时整体重建；单纯点击切换面板
 * 走的是这里。
 *
 * ⚠️ 绝不能用「重绘标签条」来同步 —— 重绘会销毁光标下的 `.tab`，
 * 导致点标签「要点两下」（见 onActivatePanel 里的详细注释）。
 */
function markActivePanel(panelId: number): void {
  const changed = panelId !== activePanelId;
  setActivePanelId(panelId);
  for (const el of layoutArea.querySelectorAll<HTMLElement>(".layout-panel")) {
    el.classList.toggle("layout-panel-active", Number(el.dataset.panelId) === panelId);
  }
  // ⚠️ B226：活动面板**没变**就必须早退、一个字都不重建 —— 这个函数由面板的
  // `mousedown` 触发，而用户点操作键（md 两颗 / ⨯ / 还原）时，那次 mousedown 的目标
  // 本身就是 `.panel-op`。若在这里同步 `renderPanelOps()`，按钮被 `replaceWith` 换掉、
  // 节点脱链 ⇒ 浏览器**合成**的那个 click 派发不到它上（真机 CDP 实测：mousedown /
  // mouseup 都照常到，click 根本不派发），表现就是「操作键点了完全没反应」。
  // 而活动面板没变时，ops 本来就是为这个面板建的（最新），重建纯属自伤。
  if (!changed) return;
  // B224：md 两颗键只挂在活动面板上 —— 活动面板变了键就得搬家。只重建 `.panel-ops`
  // 这一小块，标签条与编辑器都不碰（本函数的红线是「不重建标签条」，ops 不在红线内）。
  renderPanelOpsRef();
}

// ---------------------------------------------------------------- 依赖注入
// main.ts 在 bootstrap 期把下面四个渲染回调注入进来（它们定义在 main.ts 更靠后的段落，
// 此处只持有引用），避免 ui ↔ main 循环依赖。
let refreshViewModeButtonRef: () => void = () => {};
let updateTocDrawerRef: () => void = () => {};
let renderPanelTabsRef: (onlyPanelId?: number) => void = () => {};
let renderPanelOpsRef: (onlyPanelId?: number) => void = () => {};

export function setRefreshViewModeButton(fn: () => void): void {
  refreshViewModeButtonRef = fn;
}

export function setUpdateTocDrawer(fn: () => void): void {
  updateTocDrawerRef = fn;
}

export function setRenderPanelTabs(fn: (onlyPanelId?: number) => void): void {
  renderPanelTabsRef = fn;
}

export function setRenderPanelOps(fn: (onlyPanelId?: number) => void): void {
  renderPanelOpsRef = fn;
}

export {
  BOOT_T0,
  BOOT_MARKS,
  LOSSY_ABORT,
  bootMark,
  reportBoot,
  el,
  layoutArea,
  menuBar,
  titleBar,
  appMark,
  titleText,
  syncScrollBtn,
  winMinimize,
  winMaximize,
  winClose,
  winPin,
  tocPanel,
  tocList,
  tocToggleAll,
  sideResizer,
  sideShell,
  sideDrawer,
  sideOutline,
  sideRecent,
  recentPanel,
  recentList,
  recentCount,
  recentClear,
  tocGrip,
  sidebarToggle,
  mainRow,
  sbMessage,
  sbPos,
  sbCount,
  sbEncoding,
  sbEol,
  sbLang,
  remoteHasDoc,
  panelOfView,
  showMessage,
  updatePositionOf,
  refreshTitle,
  refreshSyncButton,
  refreshStatus,
  refreshAll,
  markActivePanel,
  broadcastDocPresence,
  diagSetTitle,
};

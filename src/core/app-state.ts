// 应用共享状态（从 main.ts 拆出）。
//
// ⚠️ 为什么单独一个文件：这些量被 main.ts 与各功能模块共用，而且**会被整体重新赋值**
//    （`tabs = …`、`activePanelId = …`、`suppressDirty = …`）。ES import 绑定是只读的 ——
//    状态若留在 main.ts、再由别的模块 import，那些赋值点会直接撞 TS2632
//    「Cannot assign to import」（上一轮 `landRound` / `syncingCursorDocId` 已踩过同一个坑）。
//
//    所以状态**归本文件所有**：读走 `export let/const` 绑定，写走 setter。
//    ⇒ 模块之间不必再经 main.ts 转手状态，循环依赖的根子拔掉了。

import type { EditorState } from "@codemirror/state";
import type { EditorHandle, TabCompartments } from "../editor/editor";
import type { SizeClass } from "../editor/perf";
import type { EncodingItem, Settings } from "../ipc/api";
import type { PreviewPane } from "../markdown/preview";
import type { KeymapOverrides } from "../shell/keymap";
import { leaf, type LayoutNode } from "./layout";
import type { ThemeMode } from "../theme/theme";

/** 面板：布局树叶子，持有独立 EditorView 与自己的标签列表。 */
export interface Panel {
  panelId: number;
  tabs: number[];
  activeTabId: number;
  view: EditorHandle | null;
  /** 视图当前实际显示的实例 id（与 activeTabId 可能短暂不一致：
   *  调用方先改 activeTabId 再 rebuild 时，快照回写必须按它寻址，防串档） */
  viewTabId: number | null;
  /** Markdown 预览（面板挂载后创建） */
  preview: PreviewPane | null;
  /** 预览渲染防抖定时器 */
  previewTimer: number | null;
  /** splitview 传入的宿主元素（.panel-host） */
  bodyEl: HTMLElement | null;
}

/** 标签实例：文档在某面板中的一份视图（独立光标/撤销历史/视图模式）。
 *  同一文档可在多个面板各有一个实例，编辑内容通过变更集实时同步，
 *  内存中的文档数据只有一份（docs）。 */
export interface Tab {
  /** 实例 id（UI 层标签标识，与 Rust tabId 无关） */
  tabId: number;
  /** 所属文档（Rust tabId） */
  docId: number;
  panelId: number;
  comps: TabCompartments;
  state: EditorState;
  /** Markdown 视图（仅 .md 有效）：源码 / 预览（实例独立，可左源码右预览对照） */
  viewMode: "source" | "preview";
  /**
   * 该标签上次显示时的视口滚动位置（px，B126）。
   *
   * 滚动位置只活在 DOM（`scrollDOM.scrollTop`）上，**不进 EditorState** ——
   * 切标签（setState 重建 ViewState）、重建布局（视图销毁重建）都会把它清零。
   * 所以要自己记一份：切走之前存、切回之后还。
   *
   * `null` = 这份实例还从没显示过（新建 / 会话恢复后还没切到过）。此时不能硬钉 0：
   * 会话只带了 cursorLine/cursorCol，光标可能在屏幕外，钉 0 看着就是「光标丢了」，
   * 于是退化为「保证光标可见」（见 restoreViewScroll）。
   *
   * ⚠️ **纯预览态（B129）下这个槽位记的是预览那一侧的滚动位置**：编辑器此时是
   * `display:none`，浏览器会把它的 scrollTop 清零，真正承载「视图位置」的是
   * 预览容器。所以存取两端都按 `viewMode === "preview"` 分流，别死盯编辑器。
   */
  scrollTop: number | null;
  /** 规范游标 `v`（实数行号，带行内/块内比例的小数）：与视图模式无关、无需测量的
   * 同源实例对齐基准（B273）。
   *
   * 它记录「同一份文档在所有实例里应该停在哪个规范位置」，不区分源码 px / 预览 px、
   * 也不依赖任何一侧的 DOM 测量 —— 因而**离屏实例（没有视图可借）也能持有准确位置**。
   *
   * 跟随滚动 / 收口时由 `pushSyncToSiblings` + `applySyncToSibling` 写入所有兄弟
   * （含离屏源码、离屏预览）；`restoreViewScroll` / `restorePreviewScroll` 切回时按
   * 各自模式从 `v` 派生像素，保证「已经同步好的实例切回来不跳」。
   *
   * `null` = 这份实例还没被任何一次同步定位过（与 scrollTop 的 null 语义对齐）。
   *
   * ⚠️ **运行时缓存，不入会话落盘** —— 它是从 DOM 实时位置反推的，会话恢复时重新从
   * `scrollTop` 走老路径即可（模式相关的 px 才需要落盘）。 */
  syncV: number | null;
}

/** 文档级记录：与 Rust Doc 一一对应（tabId 唯一）。元数据与脏标记由所有实例共享。 */
export interface Doc {
  tabId: number;
  path: string | null;
  name: string;
  encoding: string;
  eol: string;
  mixedEol: boolean;
  readonly: boolean;
  /**
   * 有未保存的修改（标签上那个 ●）。
   *
   * B112 起它是**算出来的**（见 `isDirtyVsBaseline`），而不是「一改过就永远脏」：
   * 编辑后撤销回原样、或者改了又手动改回来，都会自然转回不脏 —— 用户要的正是
   * 「内容回到修改前状态就不该显示待保存」。
   */
  dirty: boolean;
  /**
   * 判脏的基线：正文与它完全一致、且编码/行尾也没动过 ⇒ 干净。
   * `null` = 基线未知（热退出副本还原、跨窗口认领一类「只知道它脏、不知道原样是啥」
   * 的情形），此时只能靠保存 / 重新载入显式转干净。
   */
  baseline: string | null;
  baselineEncoding: string;
  baselineEol: string;
  /** 磁盘文件在会话期间被外部修改（状态栏提示，标记被保存动作清除） */
  external: boolean;
  langLabel: string;
  /**
   * 已知磁盘版本：`file-changed` 事件里的 (mtimeMs, size) 与它相同 ⇒ 那次事件是
   * **自己保存激起的回声**，必须忽略；不同 ⇒ 真的被外部改了（VS Code 的 etag 同理）。
   *
   * 只有关联了磁盘路径的文档才有意义；未命名文档恒为 0/0，不会收到事件。
   */
  diskMtimeMs: number;
  diskSize: number;
  /**
   * M4 大文件档位：由 Rust 按文件字节数判定（OpenedFile.sizeClass），
   * 决定该文档关闭哪些昂贵编辑器特性；未命名文档恒为 normal。
   */
  sizeClass: SizeClass;
  /**
   * 热退出副本 ID（B68）：首次需要写副本时生成一次，此后跨会话稳定。
   * 它是副本的唯一身份——副本文件本身不含「属于哪个标签」的索引，
   * 全靠会话里的这个 ID 把副本认领回来。
   */
  backupId: string | null;
  /** 磁盘备份区里当前确实存在该文档的副本（决定关窗能否跳过确认框） */
  backedUp: boolean;
}

/** 本窗口 label（"main" / "sat-1"…）：定向投递事件要用。 */
export let windowLabel = "main";

/** 本窗口种类（B71）：主窗口 / 卫星窗口。卫星窗口的面板可以关（=关窗）、
 *  标签可以「回到主窗口」，主窗口不行。启动时由 bootstrap 按身份回读写入。 */
export let windowKind: "main" | "satellite" = "main";

export function setWindowKind(k: "main" | "satellite"): void {
  windowKind = k;
}

/**
 * B178：别的窗口也开着哪些文档（窗口 label → 可见 docId 集合）。
 *
 * 跨窗口「多开」判据只认「别的窗口可见地开着」—— 隐藏实例不算，与
 * `visibleInstancesOfDoc` 同口径。本窗口广播 `EVT_DOC_OPEN`/`EVT_DOC_CLOSE_NOTIFY`
 * 时对端据此更新；同步滚动按钮显隐据此对齐。
 */
export const remoteOpenByWindow = new Map<string, Set<number>>();

/** 主窗口 label。与 Rust `windows::MAIN_LABEL`、capabilities 的 `main` 三处必须一致。 */
export const MAIN_WINDOW_LABEL = "main";

/**
 * 已搬到别的窗口的文档：docId → { 本地隐藏实例的 tabId, 承载它的窗口 label }。
 *
 * 隐藏实例（panelId = -1）继续留在 `tabs` 里，但不属于任何面板 —— 它承担两件事：
 * 会话快照能带上这些标签（见 snapshotSession 的 satelliteTabs）、卫星窗口异常消失时
 * 还能把标签恢复成可见的。
 */
export const remotedTabs = new Map<number, { tabId: number; owner: string }>();

/**
 * B188：已「借出」给卫星窗口的文档 id（借出期间主窗口隐藏实例继续持有正文，
 * 卫星窗关闭后归还）。跨窗口拖拽认领 / 归还链路读写。
 */
export const loanedDocIds = new Set<number>();

/**
 * 按**文档**记的同步滚动开关（`docId → 是否开启`）。
 *
 * 默认一律关闭 —— B149 定的基线照旧：同源多实例各记各的光标与滚动位置。只有用户
 * 按下标题栏那颗键才联动，并且**一个文档一份状态**：在几份之间切来切去，按钮**不
 * 复位** —— 联动方向跟着激活态走，开关本身属于这个文档。
 *
 * 方向是**单向**的：永远「激活文档 → 其它实例」。反向同步（兄弟抢着当源）会让两份
 * 滚动互相拉扯，用户看到的就是抖。
 *
 * ⚠️ 不落盘：会话结构动一次代价不小（B141 那批 `Tab` 字段还没迁进 session store），
 *    而「默认不关联」本来就是保守口径 —— 重启回到关闭，按一下即可。
 */
export const docSyncModes = new Map<number, boolean>();

/** 同源同步回环抑制：向兄弟实例分发变更期间，其 updateListener 不再二次广播。 */
export let syncingDocId: number | null = null;

/**
 * B271：「尺子未测」窗口标记 —— `setState` / 新建视图之后、measure 帧之前，CM6 的
 * heightMap 还是**估算行高**（B256 已证真机 estimate ≠ 实测），这个窗口里一切
 * `sourceTopOfV` 换算都落在「估算空间」，写出去的 px 在 measure 换成实测排版后对应的
 * 是**另一行**（用例几何：v=9.5 实测 119px、估算 170px —— 收口把它写进槽，
 * `reassertViewScroll` 再钉回 DOM，歪值就此锁死并经同步传染全部同文档实例，
 * 用户报的「切源码对不上 / 切回预览跳变」的完整病根）。
 *
 * 窗口内的 v→px 换算一律**不写**（落槽支兜底），等 `measureAndKeepScroll` 的 rAF
 * （此刻 measure 已完成、heightMap 已是实测）调 `restoreViewScroll` 按实测几何重落
 * （B288⑤-4：挂起补写 `pendingSyncCursor` 已删 —— 单轨下还原走 v，重落就是重还原，
 * 与 B263 的「display:none 量不成 ⇒ 跳过」同一个纪律，只是判据从「藏没藏」换成「测没测」）。
 *
 * ⚠️⚠️ **语义边界（B288⑤-3）**：本集合是**编辑器 CM6 measure** 的窗口标记，**不是**
 *    预览的信号 —— 预览块几何由 `setBlocks` 自己的链路铺开，与 measure 不是同一拍
 *    （B288 三轮：拿它挡预览会在 jsdom 下误杀有用的补落）。预览侧借它做保守挡板的
 *    两处调用**必须**走 `previewGeometryUnready`（见 `sync-scroll.ts`）收口，不许各自
 *    内联 `has` —— 预览几何的**真判据**在换算点自检（`applySyncToLine` 块 rect 全 0
 *    ⇒ null），本集合只是「拖分屏刚重挂」那一拍的第二道挡板。
 */
export const unmeasuredPanels = new WeakSet<Panel>();

/**
 * ⚠️ B254：切换标签那一刻，抑制 `handleUpdate` 里那句「推兄弟」。
 *
 * `switchTab` 里整态换文档那一次（`setState`）是**同步**派发 update 的，而 CM6 按
 * `setState` 的语义会把编辑器 scrollTop 归零再重排 ⇒ 那一轮 `handleUpdate` 读到的
 * 源位置是「刚被归零的 0」，不是用户停的地方。而此刻 `activeTabId` 已经改成新标签、
 * `isSyncSource` 已经为真 ⇒ 539 那句会拿 0 当源 `pushSyncToSiblings`：
 *    · 源是刚切过去的源码 ⇒ 跨侧交整数顶行 1 ⇒ 所有**同文档兄弟的预览**（分屏另一半、
 *      另一个面板那份）被 `syncToLineProgrammatic(1)` 拉回**文档开头**，落点还被
 *      `recordScroll` 写进它们自己的槽；
 *    · 源是刚切过去的预览（另一端）⇒ `topVisibleLine()` 在隐藏容器上读回 0 ⇒ 同一个病。
 * 收尾时 `switchTab` 因为「收口已对齐」跳过推播（B241）⇒ **没人把兄弟救回来**。
 * 用户报的就是这两半连起来：「切标签后另一个预览向上偏移，且之后切换标签不再变化」
 * —— 每次切都推同一发 0，看起来就是位置被钉死在顶上。
 *
 * 切标签本身有自己的收口（`syncSourceSnapshot` 在 setState 之前就采下了源的真实位置），
 * 这一发推播**不携带任何有效信息**，只留害处 ⇒ 与 `suppressDirty` 同一路数，置位包住
 * `setState` 即可（B145 那条顺序纪律不受影响：还原 `restoreViewScroll` 排在后面）。
 */
export let suppressSyncPush = false;

/** 载入文件时抑制脏标记（setState/dispatch 会触发 updateListener） */
export let suppressDirty = false;

export let isWrap = true;

export let isDark = false;

export let themeMode: ThemeMode = "system";

/**
 * 编码候选（B218）：`label` 原样传回后端，`group` 是它所属的语言组名
 * （菜单按这个 `group` 切块：首块内联铺开，之后的每组收成一条子菜单入口）。
 * 启动预取之前是空列表 —— 空着就空着，绝不在前端手抄一份兜底清单
 * （那份迟早和后端差一条，而差的那一条表现就是「菜单里有、功能没接上」）。
 */
export let encodingOptions: EncodingItem[] = [];

/** 「首选项 → 新建默认行尾/编码」的候选：启动预取，供子菜单同步渲染。 */
export let eolOptions: string[] = ["CRLF", "LF", "CR"];

/** 快捷键用户覆盖的前端镜像（与 settings.keymap 同步，改完立即持久化）。 */
export let keymapOverrides: KeymapOverrides = {};

export let settings: Settings | null = null;

export let activePanelId = 0;

export let nextInstId = 1;

export let nextPanelId = 1;

export let layout: LayoutNode = leaf(0);

export const panels = new Map<number, Panel>();

export let docs = new Map<number, Doc>();

export let tabs = new Map<number, Tab>();

export function setTabs(v: typeof tabs): void {
  tabs = v;
}

export function setDocs(v: typeof docs): void {
  docs = v;
}

export function setLayout(v: typeof layout): void {
  layout = v;
}

export function setNextPanelId(v: typeof nextPanelId): void {
  nextPanelId = v;
}

export function setNextInstId(v: typeof nextInstId): void {
  nextInstId = v;
}

export function setActivePanelId(v: typeof activePanelId): void {
  activePanelId = v;
}

export function setSettings(v: typeof settings): void {
  settings = v;
}

export function setKeymapOverrides(v: typeof keymapOverrides): void {
  keymapOverrides = v;
}

export function setEolOptions(v: typeof eolOptions): void {
  eolOptions = v;
}

export function setEncodingOptions(v: typeof encodingOptions): void {
  encodingOptions = v;
}

export function setThemeModeState(v: typeof themeMode): void {
  themeMode = v;
}

export function setIsDark(v: typeof isDark): void {
  isDark = v;
}

export function setIsWrap(v: typeof isWrap): void {
  isWrap = v;
}

export function setSuppressDirty(v: typeof suppressDirty): void {
  suppressDirty = v;
}

export function setSuppressSyncPush(v: typeof suppressSyncPush): void {
  suppressSyncPush = v;
}

export function setWindowLabel(v: typeof windowLabel): void {
  windowLabel = v;
}

export function setSyncingDocId(v: typeof syncingDocId): void {
  syncingDocId = v;
}

/** 取一个未使用的 id 并自增（原位等价于 `nextPanelId++`）。 */
export function takePanelId(): number {
  return nextPanelId++;
}

/** 取一个未使用的 id 并自增（原位等价于 `nextInstId++`）。 */
export function takeInstId(): number {
  return nextInstId++;
}

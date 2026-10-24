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
import type { ThemeFamily, ThemeMode } from "../theme/theme";

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
   * 这份实例自己的视口位置，用同步滚动的共享坐标 `v`（源码行号 + 小数）。
   *
   * 为什么存 `v` 而不是 `scrollTop` 像素：面板宽度会被拖分屏改变、字体与字号也会改行高，
   * 像素值在这些情况下不再指向同一处内容；`v` 与宽度无关，切回来才落在同一行。
   * 谁写它：`switchTab` 在 `setState` 之前把**被换走那份**的当前 `v` 快照进来。
   * 谁读它：`switchTab` 在 `setState` 之后**同一同步调用栈内**把它恢复回去 ——
   * 恢复必须同栈，否则浏览器会先派发一发「归零」的 scroll，那发没人认领就被当作用户
   * 滚动广播出去，同文档的其它视口跟着跳（这就是历代 B254/B277/B288 的病灶）。
   */
  scrollV: number;
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
   * B365：用户手动指定的语言（语言注册表里的标签，如 "Markdown"）。
   * `null` = 自动：按文件名 / 首行推断（见 `languageOfDoc`）。
   * 与 `langLabel` 分工：这个记「用户选了什么」，`langLabel` 记「当前生效显示什么」。
   */
  langOverride: string | null;
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
 * B297（2026-10-18）起它重新是**行为**的开关，不只是按键的状态存储：`sync-scroll/wire.ts`
 * 的 `setDocSyncMode` 是唯一的写点（同时驱动协调器），并跨窗口广播（`sync-mode`）。
 * 读的一律走下面的 `docSyncOn` —— 缺省是「开」，与协调器同一口径；直接写 `=== true`
 * 会让从没点过的键显示成灭的而实际还在同步（这正是清除那一轮留下的分裂）。
 * 值随会话落盘与卫星标签载荷搬运（B169），为的是「点亮态跨会话 / 跨窗口一致」。
 */
export const docSyncModes = new Map<number, boolean>();

/** 某文档的同步滚动开关（缺省开）。⚠️ 读开关只走这里，别在调用处再写一遍 `=== true`。 */
export function docSyncOn(docId: number): boolean {
  return docSyncModes.get(docId) !== false;
}

/** 同源同步回环抑制：向兄弟实例分发变更期间，其 updateListener 不再二次广播。 */
export let syncingDocId: number | null = null;

/** 载入文件时抑制脏标记（setState/dispatch 会触发 updateListener） */
export let suppressDirty = false;

export let isWrap = true;

export let isDark = false;

export let themeMode: ThemeMode = "system";

/** B377：VS Code 默认主题族（2026 / modern / plus / classic / hc）。 */
export let themeFamily: ThemeFamily = "2026";

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

export function setThemeFamilyState(v: typeof themeFamily): void {
  themeFamily = v;
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

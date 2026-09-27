// ⚠️ 官方 codicon 图标字体必须**排在本项目样式之前**：codicon.css 的
//    `.codicon[class*='codicon-']` 与本项目的 `.xxx .codicon` 特异性相同（都是 0-2-0），
//    谁在后谁生效 —— 先引它，才能让 global.css 里的字号覆盖说了算（如 `.panel-op .codicon`）。
//    字体文件（codicon.ttf）由 vite 打进 dist/assets，取用层见 src/shell/codicons.ts。
import "@vscode/codicons/dist/codicon.css";
import "./styles/global.css";

// ChangeSet 既要当类型又要用运行时的 `ChangeSet.fromJSON`（跨窗口同步要还原对端的
// 变更集），所以这里不能写成 `type ChangeSet`。
import { ChangeSet, EditorState } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { redo, selectAll, undo } from "@codemirror/commands";
import { foldAll, foldCode, unfoldAll, unfoldCode } from "@codemirror/language";
import { convertFileSrc } from "@tauri-apps/api/core";
import { oneDark as oneDarkTheme } from "@codemirror/theme-one-dark";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import "katex/dist/katex.min.css";
import "./styles/preview.css";

// 标题栏左上角的软件图标（B99）：**直接引 exe 用的那份源图**，不往前端目录另存副本 ——
// 应用图标只有一个真相（scripts/gen_icons.py → src-tauri/icons/，bundle.icon 也取它），
// 复制一份出来迟早走样，而且没人会记得同步。Vite 会把它作为资源打进 dist 并给出 URL。
// 取 32×32（四张里最小，1.2KB）：标题栏显示 16px，正好 2× 覆盖 HiDPI 缩放。
import appMarkUrl from "../src-tauri/icons/32x32.png";

import {
  createEditor,
  makeTabState,
  type EditorHandle,
  type TabCompartments,
} from "./editor/editor";
import {
  buildFindQuery,
  clearFindQuery,
  type FindMatch,
  findMatches,
  nextMatchIndex,
  preserveCase,
  restrictToRange,
  setFindQuery,
} from "./editor/find";
import { detectLanguage } from "./editor/language";
import { normalizeSizeClass, perfProfileFor, type SizeClass } from "./editor/perf";
import {
  checkEncodable,
  closeTab as ipcCloseTab,
  discardBackup,
  discardOrphanBackups,
  exportFile,
  isUnicodeEncoding,
  listEncodings,
  listEols,
  loadSession,
  loadSettings,
  newTab as ipcNewTab,
  openFile,
  openSatelliteWindow,
  takePendingFiles,
  reloadFile,
  restoreBackup,
  saveFile,
  savePasteImage,
  saveSession,
  saveSettings,
  windowPayload,
  writeBackup,
  type LossyChar,
  type FileChangedPayload,
  type OpenedFile,
  type RestoredBackup,
  type SaveConflict,
  type SatellitePayload,
  type SatelliteTab,
  type SessionState,
  type Settings,
  type WindowPayload,
  type WindowSpot,
} from "./ipc/api";
import { buildExportHtml, printToPdf } from "./markdown/exporter";
import { renderBlocks, renderFull, type TocEntry } from "./markdown/pipeline";
import { extractOutline } from "./markdown/outline";
import { PreviewPane } from "./markdown/preview";
import { logger, syncLevel } from "./core/logger";
import { sessionStore } from "./session/store";
import { renderToc, attachTocResizer, clampTocWidth, type TocResizerHandle } from "./markdown/toc";
import { attachWheelZoom } from "./shell/zoom";
import {
  createFindBar,
  type FindBarHandle,
  type FindBarQuery,
  type FindHit,
} from "./shell/findbar";
import { showExternalConflictDialog, showSaveConflictDialog } from "./shell/conflictdialog";
import { CODICONS, type CodiconName } from "./shell/codicons";
import { clearTip, initTooltips, setTip } from "./shell/tooltip";
import { paletteOpen, showCommandPalette } from "./shell/commandpalette";
import { createMenuBar, openMenuByIndex } from "./shell/menubar";
import { showPopupMenu } from "./shell/menu";
import {
  countLeaves,
  eachLeaf,
  leaf,
  maximizePanel,
  removePanel,
  restoreRatios,
  siblingLeafOf,
  splitPanel as treeSplitPanel,
  splitPanelAt,
  cloneTree,
  updateRatio,
  type LayoutNode,
  type MaximizeSnapshot,
} from "./shell/layout";
import {
  commandById,
  effectiveKeys,
  formatBinding,
  getKeymapPreset,
  normalizePresetId,
  parseKey,
  resolveCommand,
  setKeymapPreset,
  type KeymapOverrides,
} from "./shell/keymap";
import { KEYMAP_RECORDING_CLASS } from "./shell/keymapdialog";
import { showSettingsDialog } from "./shell/settingsdialog";
import { initUpdater, type UpdaterHandle } from "./shell/updater";
import { showAbout } from "./shell/about";
import {
  renderSplitview,
  panelAt,
  zoneOf,
  clearAllDropPreviews,
  clearDropIndicators,
  commitTabDrop,
  previewDropAt,
  type DropSpot,
  type PanelRenderData,
} from "./shell/splitview";
import { installTabDnd, type TabDragPayload } from "./shell/tabdnd";
import {
  hasFileDropBridge,
  installFileDropTarget,
  needsChoice,
  showFileDropChoice,
  type FileDropTarget,
} from "./shell/filedrop";
import { renderTabstrip, type TabViewData, type TabstripCallbacks } from "./shell/tabstrip";
import { applyTheme, normalizeMode, watchSystemTheme, type ThemeMode } from "./theme/theme";

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

const TEXT_FILTERS = [
  {
    name: "文本文件",
    extensions: [
      "txt",
      "md",
      "markdown",
      "json",
      "js",
      "ts",
      "rs",
      "py",
      "html",
      "css",
      "xml",
      "yml",
      "yaml",
      "ini",
      "bat",
      "sh",
      "sql",
      "log",
    ],
  },
  { name: "所有文件", extensions: ["*"] },
];

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少 DOM 节点：#${id}`);
  return node as T;
}

const layoutArea = el("layout-area");
const menuBar = el("menu-bar");
// 自定义标题栏（B97）：左侧软件图标 + 菜单，中间显示文档名，右侧工具键 + 三颗窗口控制键。
// 原来那 8 颗快捷键按钮（新建/打开/保存/另存/查找/大纲/导出/主题）已移除，
// 前六个本就在菜单里，导出与主题分别回到「文件 → 导出」「设置 → 首选项」。
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
const tocResizer = el("toc-resizer");
const sbMessage = el("sb-message");
const sbPos = el("sb-pos");
const sbCount = el("sb-count");
const sbEncoding = el<HTMLButtonElement>("sb-encoding");
const sbEol = el<HTMLButtonElement>("sb-eol");
const sbLang = el<HTMLButtonElement>("sb-lang");

/** 文档级记录：与 Rust Doc 一一对应（tabId 唯一）。元数据与脏标记由所有实例共享。 */
interface Doc {
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

/** 标签实例：文档在某面板中的一份视图（独立光标/撤销历史/视图模式）。
 *  同一文档可在多个面板各有一个实例，编辑内容通过变更集实时同步，
 *  内存中的文档数据只有一份（docs）。 */
interface Tab {
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
}

/** 面板：布局树叶子，持有独立 EditorView 与自己的标签列表。 */
interface Panel {
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

let tabs = new Map<number, Tab>();
let docs = new Map<number, Doc>();
const panels = new Map<number, Panel>();
let layout: LayoutNode = leaf(0);
let nextPanelId = 1;
let nextInstId = 1;
let activePanelId = 0;

let settings: Settings | null = null;
/** 快捷键用户覆盖的前端镜像（与 settings.keymap 同步，改完立即持久化）。 */
let keymapOverrides: KeymapOverrides = {};
/** 「首选项 → 新建默认行尾/编码」的候选：启动预取，供子菜单同步渲染。 */
let eolOptions: string[] = ["CRLF", "LF", "CR"];
let encodingOptions: string[] = ["UTF-8"];
let themeMode: ThemeMode = "system";
let isDark = false;
let isWrap = true;
/** 载入文件时抑制脏标记（setState/dispatch 会触发 updateListener） */
let suppressDirty = false;

const LOSSY_ABORT = Symbol("lossy-abort");

// ---------------------------------------------------------------- 基础访问

function getPanel(panelId: number): Panel | undefined {
  return panels.get(panelId);
}

function activePanel(): Panel | undefined {
  return panels.get(activePanelId);
}

function activeTab(): Tab | undefined {
  const p = activePanel();
  return p ? tabs.get(p.activeTabId) : undefined;
}

function panelOfTab(tabId: number): Panel | undefined {
  for (const p of panels.values()) {
    if (p.tabs.includes(tabId)) return p;
  }
  return undefined;
}

/** 实例所属文档（实例必然已注册文档；缺失视为不变量破坏，抛错暴露）。 */
function docOf(tab: Tab): Doc {
  const doc = docs.get(tab.docId);
  if (!doc) throw new Error(`文档记录缺失：docId=${tab.docId}`);
  return doc;
}

/** 文档的全部实例（跨面板）。 */
function instancesOfDoc(docId: number): Tab[] {
  const out: Tab[] = [];
  for (const t of tabs.values()) {
    if (t.docId === docId) out.push(t);
  }
  return out;
}

/** 由编辑器视图反查所属面板（不依赖创建期闭包，实例跨面板移动后依然正确）。 */
function panelOfView(view: EditorView): Panel | undefined {
  for (const p of panels.values()) {
    if (p.view && p.view.view === view) return p;
  }
  return undefined;
}

/** 同源同步回环抑制：向兄弟实例分发变更期间，其 updateListener 不再二次广播。 */
let syncingDocId: number | null = null;

/** 编辑事务（来自任意面板的 view）：快照写回 + 脏标记 + 同源实例同步。 */
function handleUpdate(view: EditorView, update: ViewUpdate): void {
  const panel = panelOfView(view);
  if (!panel) return;
  const tab = tabs.get(panel.viewTabId ?? panel.activeTabId);
  if (!tab) return;
  const doc = docs.get(tab.docId);
  if (!doc) return;
  tab.state = view.state;
  // B141：光标即时进会话记录（不等落盘那一刻才采集）。这里只记行列 —— EditorState
  // 不可序列化，进不了会话，也不需要。
  const caretPos = view.state.selection.main.head;
  const caretLine = view.state.doc.lineAt(caretPos);
  sessionStore.setCursor(tab.tabId, caretLine.number, caretPos - caretLine.from + 1);
  updatePositionOf(panel.panelId, view);
  // B152：同步滚动模式下，激活文档这边一动光标（移动、输入都是 update）就带着
  // 兄弟一起走。`isSyncSource` 保证只有「激活的那份」当源，兄弟自己被推时不会
  // 反过来再推一次（见它的注释）。
  if (isSyncSource(tab, panel)) pushSyncToSiblings(tab);
  // 文本是否真的变了：点击内容区、移动光标、切换视图、重新测量都会产生
  // update 但前后文本完全一致——那不是编辑。
  // 关键：md 预览重渲染**只**在文本真变化时才排程。若按「任意 update」排程，
  // 大纲跳转的 dispatch（仅改选区）也会在 120ms 后全量重渲染预览 →
  // replaceChildren 把 scrollTop 清零，跳转落点被冲掉（B23「跳转位置不准」）。
  const before = update.startState.doc.toString();
  const now = update.state.doc.toString();
  const textChanged = update.docChanged && before !== now;
  if (textChanged && isMdTab(tab)) scheduleMdRender(panel.panelId);
  if (update.docChanged && syncingDocId !== tab.docId) {
    // 只有**文本内容真的变了**才算用户修改。
    // 切换 源码/预览（编辑器被隐藏再显示）、点击内容区、重新测量等场景，
    // CM6 可能产生 docChanged 但前后文本完全一致的事务——那不是编辑，
    // 据此置脏会自动保存改写磁盘文件（用户没改过却被写盘）。
    if (textChanged && !suppressDirty) {
      // B112：脏不脏由「内容是否偏离基线」**算**出来（见 isDirtyVsBaseline），
      // 而不是「一改过就永远脏」——撤销回原样、改了又手动改回来，都会自然转干净。
      const shouldDirty = isDirtyVsBaseline(doc, now);
      if (shouldDirty !== doc.dirty) {
        doc.dirty = shouldDirty;
        // 刚转干净：备份区那份副本现在存的是「与磁盘一致的内容」，留着会让下次启动
        // 拿它冒充未保存修改（与保存成功后丢弃副本是同一个道理）。
        if (!shouldDirty) discardBackupFor(doc);
        refreshTitle();
        renderPanelTabs();
      }
      // 自动保存只在内容真的变化时才排程：单纯点一下/移动光标不写盘
      scheduleAutosave();
      // 热退出同理：内容一变就防抖写一次副本，不等关窗。
      // 这样强杀进程也能捞回未保存内容。
      scheduleBackup();
    }
    syncDocInstances(tab, update.changes);
    // B71 ④：同一文档可能同时挂在另一个窗口上（拖出去过、或两个窗口各开了一份），
    // 变更要广播过去，否则两个窗口各编各的、最后谁保存谁赢。
    if (textChanged) broadcastDocChange(tab.docId, update.changes, update.startState.doc.length);
  }
  if (!suppressDirty) {
    scheduleSessionSave();
  }
  logViewport("更新 · handleUpdate 后", panel);
}

/** 把某实例的内容变更广播到同文档的其他实例（内容同源，内存一份）。 */
function syncDocInstances(src: Tab, changes: ChangeSet): void {
  if (changes.empty) return;
  syncingDocId = src.docId;
  try {
    for (const other of tabs.values()) {
      if (other.docId !== src.docId || other.tabId === src.tabId) continue;
      const p = panels.get(other.panelId);
      if (p?.view && p.viewTabId === other.tabId) {
        // 兄弟实例正挂在视图上：直接派发事务（回环由 syncingDocId 抑制）
        p.view.view.dispatch({ changes });
      } else {
        // 离屏实例：离线更新快照
        other.state = other.state.update({ changes }).state;
      }
    }
  } finally {
    syncingDocId = null;
  }
}

// ------------------------------------------------------- B152 同步滚动模式
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
const docSyncModes = new Map<number, boolean>();

/**
 * B164：这份文档在**别的窗口**还有实例（进程级同源，docId 全窗口一致）。
 *
 * 卫星窗口收下的每份标签，主窗口手上都还攥着隐藏实例（B157 起「谁关的谁负责」，
 * 那份不会被回收）——卫星里 `instancesOfDoc` 只有 1 份，「开着多份」的显隐判据
 * 必须认这条，否则子窗口永远看不到同步滚动键。主窗口不用它：借出后本地留的
 * 隐藏实例本身就计进 `instancesOfDoc`。
 *
 * 只在卫星窗口采纳标签时 add、从不删 —— 与 `loanedDocIds` 同一取舍：持有关系
 * 会一直成立到窗口销毁，多记不会错，漏记就是按钮该出现时没出现。
 */
const sharedDocIds = new Set<number>();

/**
 * 这个实例此刻是不是它那个文档在同步模式下的**源**。
 *
 * 只有**激活面板里激活的那一份**算 —— 这正是「切换激活文档时按新的激活文档同步」
 * 的实现方式：源换人，兄弟跟着新源走，而开关状态不动。
 *
 * ⚠️ 它同时是**回环闸门**：把值推给兄弟时，兄弟自己也会派发 update（光标）与 scroll，
 *    若那时又推一次就成了 A→B→A 来回拉。兄弟恰好是激活标签的情况不存在（源才是），
 *    所以这一句就掐断了回环 —— 别再叠一层多余的守卫去挡（B146 删过 `swappingView`，
 *    挡掉的并不只是程序滚动）。
 *
 * ⚠️ B154 起它**只守光标那一半**：两条滚动监听已经改成「谁滚谁当源」（用户要求窗口
 *    没激活、面板没点过时也能同步），位置同步的回环由 `viewportWriteDepth` 与
 *    `restoringViewport` 的两帧窗口自限。选区不同 —— 移动鼠标不改变激活面板，非激活
 *    那份的光标本来就是被同步推过去的结果，让它也能当源就会跟「谁在编辑」打起来。
 */
function isSyncSource(tab: Tab, panel: Panel): boolean {
  return (
    docSyncModes.get(tab.docId) === true &&
    panel.panelId === activePanelId &&
    panel.activeTabId === tab.tabId
  );
}

/** 这个实例此刻是否被某个面板的视图**正显示着**（不是「它的标签挂在那儿」）。 */
function displayedPanelOfTab(tabId: number): Panel | undefined {
  for (const p of panels.values()) {
    if (p.view && p.viewTabId === tabId) return p;
  }
  return undefined;
}

/**
 * 把源的**位置**落到一份兄弟上（B152 位置那一路的四条纪律全在这一个函数里）。
 *
 * 本窗口那一路和跨窗口那一路调用的是**同一个**函数 —— 纪律只有一份，抄成两份
 * 迟早有一份漏掉「跨视图模式只能换算」那一条（B154 就栽在复制粘贴上）。
 */
function applySyncToSibling(other: Tab, px: number | null, line: number | null): void {
  const shown = displayedPanelOfTab(other.tabId);
  // 兄弟是预览态 ⇒ 它只认行：编辑器像素塞不进它的槽（纪律 2）。换算只能从源那侧
  // 的**顶行**来，所以跨视图模式这一路必须走 `line`；离屏的预览兄弟没有容器可算，
  // 只能靠它的槽自己那份记录，这里不写任何东西（写了就是污染）。
  if (other.viewMode === "preview") {
    if (line === null || !shown?.preview) return;
    // ⚠️ 立刻摘成局部：`restoringViewport` 那几笔要进闭包，属性上的收窄在闭包里会丢。
    const preview = shown.preview;
    // B160：程序落点要套进按标签的还原窗口（纪律 3 的同一条），与源码分支同源。
    // 少了这层，B 容器那一发 scroll 会被 main 的预览监听当成「用户停过的位置」，
    // 顺手再 `pushSyncToSiblings` 推回来一轮 —— 落点是程序算的，不是用户停的。
    // B162：改走**程序定位**入口（`syncToLineProgrammatic`）—— 它自带两帧的程序定位
    //    窗口、也不留 `pendingSyncLine` 尾巴。预览的程序定位不走 `pinScrollTop`（跨视图
    //    只能按行），`viewportWriteDepth` 盖不住它：没有那道窗口，就只剩 120ms 锁赌时序，
    //    锁一过期连 `programmaticTop` 都被清空，逃过去的那发 scroll 会被当成「用户在滚
    //    预览」反推编辑器，源码再跟着动 ⇒ A→B→A 来回拉锯（用户报的抖动）。
    restoringViewport(other.tabId, () => preview.syncToLineProgrammatic(line));
    // `syncToLine` 是同步落地的，容器里的值可以直接读；这一发 scroll 拦不住
    // （还原窗口挡的是 main 那条监听，不是 preview 自己的回执判定），所以显式补记。
    // ⚠️ 必须留在还原窗口**外**：窗口期内 `recordScroll` 是拒写的。
    //    这笔不用局部 `preview`：它不在闭包里，属性收窄还在，原样读更直白。
    recordScroll(other.tabId, shown.preview.root.scrollTop);
    return;
  }
  const shownView = shown?.view?.view;
  if (!shownView) return;
  if (px !== null) {
    recordScroll(other.tabId, px);
    // 派发选区**在先**、钉位置在后：CM6 为了让光标可见可能自己滚一下，钉在后面
    // 才能把它盖掉 —— 顺序反了就变成「位置被光标拽走」。
    restoringViewport(other.tabId, () => pinScrollTop(shownView.scrollDOM, px));
    return;
  }
  // B160：源是**预览**侧 ⇒ 按纪律 2 它交不出编辑器像素，`px` 恒为 `null`。旧写法是
  //    在 `px === null` 时直接 return —— 而 `line` 早就算好了，只是没人用，于是
  //    「滚预览，源码兄弟一动不动」。换算只能从行号来：行首对齐的像素坐标与
  //    `SyncHost.scrollToLine` 是同一套（纪律 4：中间只许出现「行号」这一种换算）。
  if (line === null) return;
  const target = shownView.state.doc.line(Math.min(Math.max(1, line), shownView.state.doc.lines));
  // 纪律 3：钉 DOM 要套在还原窗口里、并复用 `pinScrollTop` 的抑制区间 ——
  // 否则兄弟那一发 scroll 会被记成「用户停过的位置」，再顺着它的监听推回源。
  restoringViewport(other.tabId, () => {
    pinScrollTop(shownView.scrollDOM, shownView.lineBlockAt(target.from).top);
  });
  // 落点得记，否则兄弟这份的位置只活在 DOM 上：离屏前没人补记，重启就丢了。
  recordScroll(other.tabId, shownView.scrollDOM.scrollTop);
}

/**
 * B159：把源这份位置广播给**别的窗口**（谁滚谁当源，双向 —— 用户拍板）。
 *
 * ⚠️ 只对「用户滚动」那几路开（`crossWindow`）：光标 / 输入那一路不广播 —— 在
 *    主窗口敲一个字就带着子窗口跳，不是「同步滚动」，是「打字干扰」。
 */
function broadcastSyncPos(src: Tab, px: number | null, line: number | null): void {
  const payload: SyncPosPayload = {
    from: windowLabel,
    docId: src.docId,
    srcTabId: src.tabId,
    px,
    line,
  };
  void emit(EVT_SYNC_POS, payload).catch(() => {
    // 没有别的窗口（绝大多数时候）不是错误，本窗口照常工作
  });
}

/**
 * 把源实例的**光标 + 滚动位置**推给同文档的其它实例（B152）。
 *
 * 兄弟分两种处理：
 *   · 正挂在某个面板视图上的 —— 直接派发选区 / 钉滚动，用户才看得见「跟着动了」；
 *   · 离屏的 —— 只改它自己的快照（`state` 的选区 + 位置），等切过去时自然生效。
 *
 * ⚠️ 位置这一路有四条纪律，踩任一条都会污染兄弟自己的记录：
 *   1. 写快照只能走 `recordScroll`（B145 定的唯一闸口，还原期还会拒）；
 *   2. 纯预览实例那个槽装的是**预览**侧的像素（B129），把编辑器侧的 px 塞进去只会
 *      污染它 —— 那类实例只跟光标；反过来，**预览态那份的槽里是预览像素，也不能被
 *      当成编辑器像素拿去推源码兄弟**（B154：这正是「一个预览一个源码」原先不生效的
 *      根因之一）；
 *   3. 钉 DOM 要套在 `restoringViewport` 里、并复用 `pinScrollTop` 的抑制区间，
 *      否则兄弟那一发 scroll 会被记成「用户停过的位置」，再顺着它的滚动监听推回源；
 *   4. **跨视图模式只能换算，不能直倒**（B154）：预览那侧只认**行号**，编辑器那侧才
 *      认像素。所以坐标要从**源**当前显示的那一侧取、按**兄弟**那一侧的意义落 ——
 *      中间那次换算（顶行 ⇄ 行号）是唯一允许出现的两种坐标系。
 *
 * B154 起「谁滚谁当源」：位置同步不再要求源是激活面板的激活标签 —— **窗口没激活、
 * 面板没点过、鼠标直接放上去滚的那一份也能带着兄弟走**（两条滚动监听直接调这里，
 * 不带 `isSyncSource` 前置）。但**光标**那一半仍然单源（只看 `isSyncSource`）：
 * 选区互推会互相抢，而移动鼠标并不改变激活面板，非激活那份的光标本来就是被同步
 * 推过去的结果 —— 让它也能当源，等于给「谁推谁」多留一个不确定的入口。
 *
 * B159 加了一个开关 `crossWindow`：只有「用户滚动」那几路会打开它 —— 广播给别的
 * 窗口。光标 / 输入那一路**不**播：在窗口里敲一个字就带着另一个窗口跳，那不叫
 * 同步滚动，叫打字干扰。
 */
function pushSyncToSiblings(src: Tab, crossWindow = false): void {
  if (docSyncModes.get(src.docId) !== true) return;
  const sibs = instancesOfDoc(src.docId).filter((t) => t.tabId !== src.tabId);
  // B164：本地没有兄弟**不代表**没人跟着 —— 卫星窗口里那份是「主窗口还攥着一份」的
  // 唯一本地实例，从这里 return 会把末尾的跨窗口广播一并跳过（用户报：子窗口滚动
  // 带不动主窗口同一文件的其他标签）。光标那一路（`crossWindow=false`）没有广播可发，
  // 维持原判；广播那半段见函数末尾的 `if (crossWindow)`。
  if (sibs.length === 0 && !crossWindow) return;
  // 光标位置取源的 `head`。同源内容一致，但离线那一份可能还没追上最新正文
  // （`syncDocInstances` 对它是离线更新），所以要夹回它自己的行数再落。
  const head = src.state.selection.main.head;
  // 源此刻显示在哪一侧，就取那一侧的坐标（纪律 2 / 4）。先取局部变量：后面是同步
  // 代码块，收窄不跨块保留。
  const srcPanel = panelOfTab(src.tabId);
  const srcPreview = src.viewMode === "preview" ? srcPanel?.preview : undefined;
  const srcView = srcPreview ? undefined : srcPanel?.view?.view;
  const line = srcPreview
    ? srcPreview.topVisibleLine()
    : srcView
      ? topVisibleLineOf(srcView)
      : null;
  const px = srcPreview ? null : src.scrollTop;
  for (const other of sibs) {
    const line2 = other.state.doc.lineAt(Math.min(head, other.state.doc.length));
    const pos = Math.min(head, line2.to);
    const shownView = displayedPanelOfTab(other.tabId)?.view?.view;
    if (shownView) {
      shownView.dispatch({ selection: { anchor: pos } });
    } else {
      other.state = other.state.update({ selection: { anchor: pos } }).state;
    }
    // 位置那一路（跨视图模式的换算都关在这一函数里）
    applySyncToSibling(other, px, line);
  }
  // B159：位置广播排在最后 —— 本地兄弟已经对齐过一次，别人接手时看到的是同一个落点。
  if (crossWindow) broadcastSyncPos(src, px, line);
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
  const mark = doc?.dirty ? " ●" : "";
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
 * B164：「多份」要算上**别的窗口** —— 卫星窗口里那份是唯一的本地实例，但主窗口
 * 还攥着隐藏实例（`sharedDocIds`，采纳标签时记下）。只数本地 ⇒ 子窗口永远看不到
 * 这颗键，也就没法在子窗口开启同步滚动。
 *
 * ⚠️ 状态读的是 `docSyncModes`（按**文档**记），所以切换激活文档时这里读出来的仍是
 *    那份文档自己的开关值 —— 按钮不复位，这正是「一个文档有一个同步滚动状态」。
 */
function refreshSyncButton(tab: Tab | undefined): void {
  // 图标在启动时给过一次（见图标初始化那批），这里只管显隐与点亮态。
  // 无文档 ⇒ 藏；数量是一个便宜的循环（实例数很小），不用缓存。
  // ⚠️ 先算出布尔量：直接写 `hidden = !tab || …` 是收窄不了 `tab` 的，后面那句
  //    `if (hidden) return` 挡不住「tab 可能是 undefined」这条报错。
  const multi = !!tab && (instancesOfDoc(tab.docId).length > 1 || sharedDocIds.has(tab.docId));
  syncScrollBtn.hidden = !multi;
  if (!multi) return;
  const on = docSyncModes.get(tab.docId) === true;
  // B166：字形随开关切换 —— 开 = link（连着）、关 = unlink（链环分开的那颗）。
  // 状态全落在字形上（与置顶键同口径），不再靠配色；`.is-on` 只留给 aria /
  // tooltip 那层语义，视觉上与常态无差。
  syncScrollBtn.innerHTML = on ? CODICONS.link : CODICONS.unlink;
  syncScrollBtn.classList.toggle("is-on", on);
  // 开关的状态要用 aria-pressed 报给读屏器，光靠配色等于没报。
  syncScrollBtn.setAttribute("aria-pressed", String(on));
  const label = on ? "取消同步滚动" : "同步滚动";
  syncScrollBtn.setAttribute("aria-label", label);
  setTip(syncScrollBtn, on ? "同步滚动（已开启，其它份跟着这份走）" : "同步滚动（点击开启）");
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
  // 状态栏视图切换按钮跟随活动标签（切面板/切标签都经过这里）
  refreshViewModeButton();
}

function refreshAll(): void {
  refreshTitle();
  refreshStatus();
  refreshViewModeButton();
  updateTocDrawer();
  renderPanelTabs();
  // B152：任何一次全局刷新（复制标签 / 分裂面板 / 认领标签 / 会话恢复…）之后，兄弟
  // 实例都要对齐到当前激活文档 —— 新出现的那一份不该停在「还没同步过」的老位置上。
  // 放在最后：这一轮该重建的 DOM 都落定了，钉下去不会被随后而来的还原盖掉。
  const act = activeTab();
  if (act) pushSyncToSiblings(act);
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
  activePanelId = panelId;
  for (const el of layoutArea.querySelectorAll<HTMLElement>(".layout-panel")) {
    el.classList.toggle("layout-panel-active", Number(el.dataset.panelId) === panelId);
  }
}

/** 渲染全部面板标签栏（轻量：不动 EditorView）。 */
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
    onOpenInNewWindow: (tabId) => void openTabsInNewWindow([tabId]),
    onReturnToMain: windowKind === "satellite" ? (tabId) => returnTabToMain(tabId) : undefined,
    onReorder: (from, to) => {
      const fi = p.tabs.indexOf(from);
      const ti = p.tabs.indexOf(to);
      if (fi < 0 || ti < 0) return;
      p.tabs.splice(fi, 1);
      p.tabs.splice(p.tabs.indexOf(to) + (fi < ti ? 1 : 0), 0, from);
      renderPanelTabs(p.panelId);
      scheduleSessionSave();
    },
    onNew: () => void newUntitled(),
  };
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
    data.set(p.panelId, {
      panelId: p.panelId,
      active: p.panelId === activePanelId,
      tabs: tabViewDataOf(p),
      // B161：卫星窗口唯一的面板**可以**关 —— 关面板 = 关窗 + 标签交回主窗口。
      // 主窗口仍然不许关唯一面板（关了就没地方放标签）。
      canClose: countLeaves(layout) > 1 || windowKind === "satellite",
      closeDetail:
        windowKind === "satellite" && countLeaves(layout) <= 1
          ? "关闭该子窗口，标签交回主窗口"
          : undefined,
      // B71：被最大化挤扁的一侧要真的收成 0（CSS 里 .layout-panel 有 min-width）
      maximized: maximizedPanelId === p.panelId,
      collapsed: maximizedPanelId !== null && maximizedPanelId !== p.panelId,
    });
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
      getPanel(panelId)?.view?.focus();
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
        suppressDirty = true;
        p.view = createEditor(editorEl, tab.state);
        suppressDirty = false;
        p.viewTabId = tab.tabId;
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
          return topVisibleLineOf(v);
        },
        scrollToLine: (line: number) => {
          const v = p.view?.view;
          if (!v) return;
          const l = v.state.doc.line(Math.min(Math.max(1, line), v.state.doc.lines));
          v.scrollDOM.scrollTop = v.lineBlockAt(l.from).top;
        },
        lineCount: () => p.view?.view.state.doc.lines ?? 0,
      });
      if (p.view) {
        const shownView = p.view.view;
        shownView.scrollDOM.addEventListener("scroll", () => {
          const t = p.viewTabId !== null ? tabs.get(p.viewTabId) : undefined;
          // B139：程序滚动期间（还原钉位置）别写 —— 那时容器里摆的是**还原的目标值**，
          // 顺着事件写回去就是把「我们要去的地方」当成「用户停过的位置」。
          if (viewportWriteDepth > 0) return;
          // B142：位置还原还没立住（补钉在下一帧）—— 这期间容器里是被裁过的 0，
          // 写进去就是把「还原前的空窗期」当成用户停过的位置，还会顺带排程落盘。
          if (t && restoringViewports.has(t.tabId)) return;
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
          scheduleSessionSave();
          // B152 / B154：滚的是谁，谁就是源 —— 兄弟跟着同一个位置走。
          // ⚠️ 这里**不再**前置 `isSyncSource`：用户明确要求「窗口没有激活时，鼠标放在
          //    一个视口中也能滚动，这时同步滚动也要生效」（B154）。回环不是靠「只有
          //    激活的那份能当源」挡的，而是靠下面两条前置守卫：
          //      · `viewportWriteDepth > 0` —— 这一发 scroll 是程序钉位置派发的；
          //      · `restoringViewports.has(t.tabId)` —— 被推动的兄弟在那两帧里不许回推
          //        （`restoringViewport` 是两帧窗口，盖得住下一帧才到的 scroll）。
          //    光标那一半仍走 `handleUpdate` 里那条单源判定，理由见 pushSyncToSiblings。
          // 排在排程之后：本条监听的活儿跟它是两件事，别为 B132 那条契约挤在一起。
          // B159：跨窗口那一路也在这里开 —— 「谁滚谁当源」在别的窗口同样算数。
          if (t) pushSyncToSiblings(t, true);
          // 预览→编辑器方向程序滚动期间忽略，防止回环抖动
          if (!t || !isMdTab(t) || t.viewMode !== "preview") return;
          if (preview.isSyncing()) return;
          preview.syncFromEditor();
        });
        attachPasteHandler(p);
      }
      // B137：预览滚动和编辑器滚动是同一件事 —— 位置只活在 DOM 上，随滚动即时
      // 记进它**自己那份**快照（后台预览标签没有滚动事件，全靠这里补记）。
      // 同 B132：写完还得排程落盘，否则「滚过预览就关窗」留下的还是滚之前那份。
      preview.root.addEventListener("scroll", () => {
        const t = p.viewTabId !== null ? tabs.get(p.viewTabId) : undefined;
        if (!t || t.viewMode !== "preview") return;
        // B139：程序滚动期间（还原钉回 / 图片·公式增强后的二次定位）不写快照 ——
        // 这两种落点都是**程序算出来的**，不是这个标签停过的位置；照写回去就是
        // 「预览落点在 960 / 952 之间抖」的根。落盘排程照旧：位置本身没变。
        // B162：跨面板同步的程序定位（`syncToLineProgrammatic`）也在这个窗口里 ——
        //   它不走 `pinScrollTop`，`viewportWriteDepth` 盖不住；漏出去就会推回源、
        //   源再推回来，闭环成拉锯。
        if (
          viewportWriteDepth > 0 ||
          preview.isSuppressingScrollWrite() ||
          preview.isProgrammaticScrolling()
        ) {
          scheduleSessionSave();
          return;
        }
        if (restoringViewports.has(t.tabId)) return;
        // B154：与编辑器那侧同口径 —— **谁滚谁当源**，用户手指还在预览上、窗口也没
        //   激活，源码那份也要跟着走。同样挂在 `restoringViewports` 之后：兄弟被
        //   定位后那两帧里不许回推（与 `pushSyncToSiblings` 里那对守卫同源）。
        // B159：预览侧这一路同样往外广播 —— 纯预览态那份就是它的源，别的窗口也该跟上。
        pushSyncToSiblings(t, true);
        // ⚠️ 这里**不要**用 `preview.isSyncing()` 当守卫：`isSyncing()` 认的是
        // `syncLock === "preview"`，即**预览→编辑器**方向（用户正在翻预览）；而
        // 预览容器自己的监听器（构造函数里注册、比这里先跑）一收到滚动就会
        // `acquireLock("preview")` —— 照它挡下去，等于把**用户自己的滚动**全吞了
        // （B137：滚过的预览既不记位置也不排程落盘，重启必回顶部）。编辑器带过来
        // 的同步滚动反而不会命中这里：那种标签是源码态（`viewMode === "source"`），
        // 早在上一行 return 了；真到了纯预览态，预览本来就该跟着编辑器走。
        t.scrollTop = preview.root.scrollTop;
        recordScroll(t.tabId, t.scrollTop);
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
  if (panel.activeTabId === tabId) return;
  // 旧 tab 快照写回：必须按视图实际显示的实例（viewTabId）寻址。
  // 调用方可能已改 activeTabId 而视图仍显示旧标签——按 activeTabId 回写
  // 会把视图当前内容写进错误的标签（内容串档/被覆写为空白的同源缺陷）。
  const shownTab = tabs.get(panel.viewTabId ?? panel.activeTabId);
  if (shownTab) shownTab.state = panel.view.view.state;
  // B126：setState 会重建 ViewState 并把视口拉回开头，采完这一眼再切换
  rememberViewScroll(panel);
  logViewport("切换 · 采旧位置后", panel);
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
  //   ② 整个换文档罩进 `restoringViewport`：还原窗口从 setState 之前就开着，两帧后才
  //      解锁 —— 浏览器 scroll 事件下一帧才派发，那一下正落在窗口里。（试过再叠一层
  //      「换文档也算程序滚动」的计数器，结果把切完标签同一帧内的**用户滚动**也丢了，
  //      见下方 `viewportWriteDepth` 的说明。）
  panel.viewTabId = tabId;
  const view = panel.view; // 闭包里不保留对 `panel.view` 的收窄，先取一份
  restoringViewport(tabId, () => {
    suppressDirty = true;
    view.setState(tab.state);
    suppressDirty = false;
    // ⚠️ 焦点必须排在钉位置**之前**（B145）：`focus()` 会把光标滚进视野，而光标往往
    // 不在刚还原出来的可视区里 —— 排在后面等于把刚钉好的位置顶掉。
    view.focus();
    logViewport("切换 · 还原窗口内", panel);
    // B126：setState 重建了 ViewState 并把视口拉回开头，这里把滚动位置还回去。
    // 必须排在 applyPanelMode 之前——它要按当前顶行把预览对齐到同一区域。
    restoreViewScroll(panel);
  });
  logViewport("切换 · 还原后", panel);
  applyPanelMode(panel);
  // applyPanelMode 里的 syncToLine 会把预览按「编辑器顶行」重新定位一次，
  // 纯预览实例的位置得在它之后再钉回来（B130）
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
    if (tab) pushSyncToSiblings(tab);
  }
  renderPanelTabs(panelId);
  // 悬浮查找栏不随标签切换关闭——只把查询重新应用到新的活动视图
  retargetFindBar();
}

function makeDoc(
  tabId: number,
  text: string,
  name: string,
  path: string | null,
  encoding: string,
  eol: string,
  readonly: boolean,
  /** M4 大文件档位；缺省 normal（新建 / 未命名 / 会话里没带档位的旧数据） */
  sizeClass: SizeClass = "normal",
  /** 热退出副本 ID；恢复会话时沿用，其余情况留空等首次写副本时再生成 */
  backupId: string | null = null,
): Doc {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const lang =
    name === "未命名" && !text
      ? { label: "Plain Text", extension: null }
      : detectLanguage(name === "未命名" ? null : name, firstLine);
  return {
    tabId,
    path,
    name,
    encoding,
    eol,
    mixedEol: false,
    readonly,
    dirty: false,
    // 刚打开 / 刚新建：正文就是基线（B112），此时不脏
    baseline: text,
    baselineEncoding: encoding,
    baselineEol: eol,
    external: false,
    langLabel: lang.label,
    sizeClass,
    backupId,
    backedUp: false,
    diskMtimeMs: 0,
    diskSize: 0,
  };
}

/** 为文档在指定面板创建一个实例（独立 CM6 状态，内容同源）。 */
function makeInstance(doc: Doc, panelId: number, text: string): Tab {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const lang =
    doc.name === "未命名" && !text
      ? { label: "Plain Text", extension: null }
      : detectLanguage(doc.name === "未命名" ? null : doc.name, firstLine);
  const perf = perfProfileFor(doc.sizeClass);
  const { state, comps } = makeTabState(
    text,
    lang.extension,
    { dark: isDark, wrap: isWrap, perf },
    handleUpdate,
  );
  return {
    tabId: nextInstId++,
    docId: doc.tabId,
    panelId,
    comps,
    state,
    viewMode: "source",
    scrollTop: null,
  };
}

/**
 * 文档当前**应当**是脏的吗（B112）。
 *
 * 「改过就永远脏」是错的：用户改了几个字又撤销回去、或者手动改回原文，内容已经
 * 和磁盘上一模一样，却一直挂着 ●、关窗还要弹确认框、自动保存还要再写一次盘。
 * 所以脏不脏由**比较**得出：正文偏离基线 ⇒ 脏；正好等于基线 ⇒ 干净。
 *
 * 编码 / 行尾也算进判据：切换行尾本身不改内存正文（保存时才落盘），
 * 若只看正文，切了行尾再编辑又撤销就会把「行尾还没写盘」这件事悄悄抹掉。
 *
 * ⚠️ 先比长度再比内容：绝大多数编辑都会改变长度，长度不同可以直接判脏，
 * 免去大文件上每次按键都做一次 O(n) 全文比较。
 */
function isDirtyVsBaseline(doc: Doc, text: string | null): boolean {
  const base = doc.baseline;
  if (base === null || text === null) return true;
  if (text.length !== base.length) return true;
  if (text !== base) return true;
  return doc.encoding !== doc.baselineEncoding || doc.eol !== doc.baselineEol;
}

/**
 * 把「当前正文 + 当前编码/行尾」钉成新的基线，文档随之转干净。
 *
 * 保存成功、重新载入、以磁盘版本为准 —— 凡是「内容已经与磁盘一致」的时刻都走它，
 * 不要单独写 `doc.dirty = false`：那会让 dirty 与基线脱节，下一次编辑就再也判不准。
 */
function markClean(doc: Doc, text: string): void {
  doc.baseline = text;
  doc.baselineEncoding = doc.encoding;
  doc.baselineEol = doc.eol;
  doc.dirty = false;
}

/**
 * 记下「已知磁盘版本」。
 *
 * 每次从磁盘读/写之后都要更新：它是 `file-changed` 事件里区分「外部改动」与
 * 「自己刚写盘激起的回声」的唯一依据。漏更新一次，用户保存完就会立刻被弹一次
 * 「文件已在外部被修改」。
 */
function markDiskVersion(doc: Doc, mtimeMs: number, size: number): void {
  doc.diskMtimeMs = mtimeMs;
  doc.diskSize = size;
}

function registerDoc(doc: Doc): void {
  docs.set(doc.tabId, doc);
}

function attachTabToPanel(tab: Tab, panel: Panel): void {
  tabs.set(tab.tabId, tab);
  panel.tabs.push(tab.tabId);
  panel.activeTabId = tab.tabId;
}

/** 新建未命名标签（开到活动面板）。 */
async function newUntitled(): Promise<void> {
  let panel = activePanel();
  if (!panel) {
    // 无面板（全部关闭的极端情况）→ 重建单面板
    layout = leaf(0);
    nextPanelId = 1;
    activePanelId = 0;
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
    const save = await ask(`${doc.name} 有未保存的修改，保存后关闭吗？`, {
      title: "关闭标签",
      kind: "warning",
    });
    if (save) {
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
      // B157：**这是「窗口自己关空」那一档，手上没关的标签要先交回主窗口**
      // （`returnTabs = true`）—— 与点 X 那档的区别就在这个参数。
      requestSatelliteClose(true);
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
    // 同 switchTab：CM6 的 setState 自己会再 focus 一次（把光标滚进视野），加上浏览器
    // 按新内容裁剪 scrollTop —— 还原窗口要从 setState 之前就开着，否则这几下滚动会被
    // 当成「用户停过的位置」写进接班标签的记录（B146）
    panel.viewTabId = nextId;
    restoringViewport(nextId, () => {
      suppressDirty = true;
      view.setState(nextTab.state);
      suppressDirty = false;
      // B126：接班的标签沿用**它自己**上次的位置（光标随 state，视口随 scrollTop）
      restoreViewScroll(panel);
    });
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
function disposePanel(panelId: number): void {
  const panel = getPanel(panelId);
  if (!panel) return;
  // 在旧树上取视觉相邻面板，作为关闭后的活动面板
  const sibling = siblingLeafOf(layout, panelId);
  const newTree = removePanel(layout, panelId);
  if (newTree) layout = newTree;

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
    activePanelId = sibling ?? [...panels.keys()][0] ?? 0;
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
    // 就等于关掉这个窗口；里面还开着的标签交回主窗口（主窗口关面板是把标签并入相邻
    // 面板，子窗口那个「相邻面板」就是主窗口本身）。
    requestSatelliteClose(true);
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
  if (activePanelId === panelId) activePanelId = host.panelId;
  disposePanel(panelId);
}

/** 在指定面板旁分屏，新面板沿用当前活动标签。 */
function splitActivePanel(panelId: number, dir: "h" | "v"): void {
  const panel = getPanel(panelId);
  if (!panel) return;
  exitMaximize(); // 同 splitPanelWithTab：最大化态下不先还原就会分出 0 宽的新面板
  const newId = nextPanelId++;
  layout = treeSplitPanel(layout, panelId, dir, newId);
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
        // 同 switchTab（B146）：CM6 的 setState 自己会再 focus / 测量、并派发滚动。
        // `viewTabId` 得先认下接班标签（否则那几下滚动记到**被移走的那张**头上），
        // 整段换文档也要罩进还原窗口，否则那几下滚动会当成「用户停过的位置」落进记录。
        panel.viewTabId = prev.tabId;
        const view = panel.view; // 闭包里不保留对 `panel.view` 的收窄，先取一份
        restoringViewport(prev.tabId, () => {
          suppressDirty = true;
          view.setState(prev.state);
          suppressDirty = false;
          // B126：原位剩下的标签也要拿回自己的视口位置
          restoreViewScroll(panel);
        });
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
  activePanelId = newId;
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
  if (activePanelId === src.panelId) activePanelId = hostId;
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
function panelIdsInOrder(): number[] {
  const ids: number[] = [];
  eachLeaf(layout, (id) => ids.push(id));
  return ids;
}

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
  retargetFindBar();
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
  const newId = nextPanelId++;
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
  layout = splitPanelAt(layout, targetId, dir, newId, newFirst);
  activePanelId = newId;
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
  attachTabToPanel(inst, host);
  activePanelId = hostPanelId;
  rebuildLayout();
  refreshAll();
  scheduleSessionSave();
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
    const newId = nextPanelId++;
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
    layout = splitPanelAt(layout, targetId, dir, newId, newFirst);
    activePanelId = newId;
    rebuildLayout();
    refreshAll();
    scheduleSessionSave();
    return;
  }

  const src = panelOfTab(tabId);
  if (!src) return;
  const newId = nextPanelId++;
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
  src.tabs = src.tabs.filter((id) => id !== tabId);
  tab.panelId = newId;
  layout = splitPanelAt(layout, targetId, dir, newId, newFirst);
  activePanelId = newId;

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
  scheduleSessionSave();
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
    scheduleSessionSave();
    return;
  }

  src.tabs.splice(from, 1);
  dst.tabs.splice(idx, 0, tabId);
  tab.panelId = panelId;
  dst.activeTabId = tabId;
  activePanelId = panelId;

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
  scheduleSessionSave();
}

// ---------------------------------------------------------------- 打开 / 保存

/**
 * 重载 / 外部刷新 / 编码切换后重建文档全部实例的编辑器状态，并刷新挂载中的视图。
 *
 * `keepCursor`：尽量把光标留在原来的字符偏移上（外部刷新时内容可能变了，
 * 所以按新长度裁剪）。**默认 false** —— 换编码重载这类场景内容已经不是原来那份，
 * 保留一个「指到别处」的光标没有意义。
 */
function rebuildDocInstances(doc: Doc, text: string, keepCursor = false): void {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const lang = detectLanguage(doc.name === "未命名" ? null : doc.name, firstLine);
  doc.langLabel = lang.label;
  // 档位必须跟着 doc 走：不传就回落 normal，大文件重载一次就把降级特性全开了
  const perf = perfProfileFor(doc.sizeClass);
  for (const inst of instancesOfDoc(doc.tabId)) {
    const head = keepCursor ? inst.state.selection.main.head : 0;
    const made = makeTabState(
      text,
      lang.extension,
      { dark: isDark, wrap: isWrap, perf },
      handleUpdate,
    );
    inst.state = made.state;
    inst.comps = made.comps;
    if (keepCursor && head > 0) {
      const pos = Math.min(head, inst.state.doc.length);
      inst.state = inst.state.update({ selection: { anchor: pos } }).state;
    }
    const panel = panels.get(inst.panelId);
    if (panel?.view && panel.viewTabId === inst.tabId) {
      suppressDirty = true;
      panel.view.setState(inst.state);
      suppressDirty = false;
      panel.viewTabId = inst.tabId;
      // B126：整态重建把视口清零；保光标的场合（外部刷新）顺带把视口也保住
      if (keepCursor) restoreViewScroll(panel);
    }
  }
}

/** 打开文件。targetPanelId 指定落点面板（文件拖入分屏用）；返回新开/激活的 tabId。 */
async function doOpen(
  presetPath?: string,
  encoding?: string,
  targetPanelId?: number,
): Promise<number | null> {
  let target = presetPath;
  if (!target) {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: TEXT_FILTERS,
    });
    if (!picked || Array.isArray(picked)) return null;
    target = picked;
  }

  try {
    const file = await openFile(target, encoding ?? null);
    const existingDoc = docs.get(file.tabId);

    if (file.reused && existingDoc) {
      // 已在标签中：默认切到其实例所在面板并激活（保留编辑状态）。
      //
      // ⚠️ 但**指定了落点面板、而这份文件原本并不开在那儿**时不能这么干（B131）：
      //    那样等于把用户拖到 B 区的文件硬拽回 A 区，看起来就是「拖了没反应」，
      //    而且原来那个标签会被顺手切走。这种情形改为在落点**另开一个同源实例**，
      //    原有的照旧留在原地（内容仍然实时同步，关掉一个也不影响另一个）。
      const all = instancesOfDoc(existingDoc.tabId);
      const inTarget =
        targetPanelId !== undefined ? all.find((t) => t.panelId === targetPanelId) : undefined;
      const inst = inTarget ?? all[0];
      const instPanel = inst ? panelOfTab(inst.tabId) : undefined;
      // 只有「本来就开在这个面板」或「压根没指定落点」才算复用成功
      if (inst && instPanel && (inTarget !== undefined || targetPanelId === undefined)) {
        activePanelId = instPanel.panelId;
        switchTab(instPanel.panelId, inst.tabId);
        rebuildLayout();
        refreshAll();
        scheduleSessionSave();
        showMessage(`${file.name} 已在标签中打开`);
        return inst.tabId;
      }
      // B71 ④：这份文档正挂在**另一个窗口**上（本地只剩隐藏实例，panelId = -1）。
      // 直接往下走会为同一个 docId 再建一个实例 —— 隐藏那份的正文停在载荷时的样子，
      // 新建这份来自磁盘，两份共用一条 docs 记录却各说各话，正是「同源多实例」最怕的
      // 状态。所以先把它**取回**本窗口（隐藏实例在那边一直跟着远端编辑同步，内容是最新的）。
      const remoted = remotedTabs.get(existingDoc.tabId);
      if (inst && remoted !== undefined) {
        const host =
          (targetPanelId !== undefined ? getPanel(targetPanelId) : undefined)?.panelId ??
          activePanelId;
        reclaimRemoted(inst.tabId, host);
        rebuildLayout();
        refreshAll();
        scheduleSessionSave();
        showMessage(`${file.name} 已从另一个窗口取回`);
        return inst.tabId;
      }
    }

    const panel =
      (targetPanelId !== undefined ? getPanel(targetPanelId) : undefined) ??
      activePanel() ??
      [...panels.values()][0];
    if (!panel) return null;
    const doc = makeDoc(
      file.tabId,
      file.text,
      file.name,
      file.path,
      file.encoding,
      file.eol,
      file.readonly,
      normalizeSizeClass(file.sizeClass),
    );
    doc.mixedEol = file.mixedEol;
    markDiskVersion(doc, file.mtimeMs, file.size);
    registerDoc(doc);
    const tab = makeInstance(doc, panel.panelId, file.text);
    attachTabToPanel(tab, panel);
    if (panel.panelId !== activePanelId) activePanelId = panel.panelId;
    // 重建挂载（应用 md 视图模式 + 预览）并聚焦
    rebuildLayout();
    refreshAll();
    getPanel(panel.panelId)?.view?.focus();
    renderPanelTabs(panel.panelId);

    showMessage(
      file.sizeHint ||
        (file.lossy
          ? `已打开 ${file.name}（部分字节无法用 ${file.encoding} 解码，建议在状态栏手动指定编码）`
          : `已打开 ${file.name}`),
      file.lossy,
    );
    logger.info(
      "open",
      `${file.name} ${file.size}B ${file.encoding}${file.lossy ? " lossy" : ""} size=${doc.sizeClass}`,
    );
    scheduleSessionSave();
    logViewport("加载 · 打开文件后", getPanel(panel.panelId) ?? undefined);
    return tab.tabId;
  } catch (err) {
    showMessage(String(err), true);
    return null;
  }
}

// ---------------------------------------------------------------- 文件拖入（B24）

/** Tauri 拖放事件坐标是物理像素，DOM 布局用逻辑像素，按缩放比例换算。 */
function dropPosOf(p: { x: number; y: number }): { x: number; y: number } {
  const scale = window.devicePixelRatio || 1;
  return { x: p.x / scale, y: p.y / scale };
}

/** 悬停高亮：复用标签拖拽的落点预览层，指明会落到哪个面板的哪个分区。 */
function showFileDropPreview(x: number, y: number): void {
  clearAllDropPreviews();
  const el = panelAt(x, y);
  if (!el) return;
  const preview = el.querySelector(".split-preview");
  if (preview)
    preview.className = `split-preview show zone-${zoneOf(el.getBoundingClientRect(), x, y)}`;
}

/** 指针位置 → 落点面板与分区（不在任何面板内为 null，回落到活动面板打开）。 */
function fileDropTargetAt(x: number, y: number): FileDropTarget | null {
  const el = panelAt(x, y);
  if (!el) return null;
  const id = Number(el.dataset.panelId);
  if (!Number.isFinite(id)) return null;
  return { panelId: id, zone: zoneOf(el.getBoundingClientRect(), x, y) };
}

/**
 * 落点面板的**活动文档**是不是 Markdown（拖放选择菜单的判据，见 `needsChoice`）。
 *
 * 拖到面板外（target 为 null）时不问：那时用户没瞄准任何文档，谈不上「插到哪儿」，
 * 直接按原来的兜底行为打开即可。
 */
function panelDocIsMarkdown(panelId: number): boolean {
  const p = panels.get(panelId);
  const t = p ? tabs.get(p.activeTabId) : undefined;
  return !!t && isMdTab(t);
}

/** 按落点打开：中央 = 落进该面板；边缘 = 在该面板旁分屏打开。 */
async function openDroppedAt(path: string, target: FileDropTarget | null): Promise<void> {
  const tabId = await doOpen(path, undefined, target?.panelId);
  if (tabId === null || !target || target.zone === "center") return;
  const dir = target.zone === "left" || target.zone === "right" ? "h" : "v";
  const newFirst = target.zone === "left" || target.zone === "top";
  splitPanelWithTab(target.panelId, dir, tabId, newFirst, false);
}

/** 「插入文件路径」：把路径文本插到当前活动编辑器光标处（无编辑器则回落为打开）。 */
function insertDroppedPath(path: string): void {
  const panel = activePanel();
  if (!panel?.view) {
    void doOpen(path);
    return;
  }
  const view = panel.view.view;
  const pos = view.state.selection.main.head;
  view.dispatch({
    changes: { from: pos, insert: path },
    selection: { anchor: pos + path.length },
    scrollIntoView: true,
  });
  panel.view.focus();
  showMessage(`已插入路径 ${path}`);
}

async function confirmLossy(chars: LossyChar[], encoding: string): Promise<void> {
  const preview = chars
    .slice(0, 5)
    .map((c) => `第 ${c.line} 行 ${c.col} 列的 “${c.ch}”`)
    .join("、");
  const more = chars.length > 5 ? " 等 " + chars.length + " 处" : "";
  const ok = await ask(
    `有 ${chars.length} 个字符无法用 ${encoding} 表示（${preview}${more}）。\n` +
      `保存后它们会被替换为数字字符引用，且不可逆。\n\n` +
      `建议改用「UTF-8」保存。仍要继续吗？`,
    { title: "编码转换不可逆", kind: "warning" },
  );
  if (!ok) throw LOSSY_ABORT;
}

/** 保存活动标签。返回 true 表示已写入磁盘。 */
async function doSave(forceDialog: boolean): Promise<boolean> {
  const panel = activePanel();
  const tab = activeTab();
  if (!panel || !tab) return false;
  return saveDocCore(docOf(tab), tab, forceDialog);
}

/**
 * 保存指定文档（供菜单「全部保存」复用）。
 * 文本取该实例快照；若实例正显示在所属面板上则先从视图写回。
 */
async function saveDocCore(doc: Doc, inst: Tab, forceDialog: boolean): Promise<boolean> {
  const panel = panels.get(inst.panelId);
  if (panel?.view && panel.viewTabId === inst.tabId) inst.state = panel.view.view.state;

  let target = doc.path;
  if (forceDialog || !target) {
    const picked = await saveDialog({
      defaultPath: target ?? doc.name,
      filters: TEXT_FILTERS,
    });
    if (!picked) return false;
    target = picked;
  }

  const text = inst.state.doc.toString();
  try {
    if (!isUnicodeEncoding(doc.encoding)) {
      const bad = await checkEncodable(text, doc.encoding);
      if (bad.length > 0) await confirmLossy(bad, doc.encoding);
    }

    // 「已知磁盘版本」只在**原地保存**时才有意义：另存为的目标可能是另一个文件，
    // 拿旧文件的版本号去比对会凭空报冲突。
    const inPlace = !forceDialog && !!doc.path && target === doc.path;
    const hasBaseline = inPlace && doc.diskMtimeMs > 0;

    let outcome = await saveFile({
      tabId: doc.tabId,
      text,
      encoding: doc.encoding,
      eol: doc.eol,
      path: target,
      // 带基线 = 让 Rust 在写盘前比对磁盘版本，不一致就一个字节都不写
      // （VS Code 的 FILE_MODIFIED_SINCE）。没有基线（未命名 / 另存 / 备份恢复）时传 null。
      expectMtimeMs: hasBaseline ? doc.diskMtimeMs : null,
      expectSize: hasBaseline ? doc.diskSize : null,
    });

    if (outcome.kind === "conflict") {
      // 磁盘上的版本比我们知道的新 —— 此时**还没写盘**，把选择权交回用户
      if ((await resolveSaveConflict(doc, outcome.value)) !== "overwrite") return false;
      // 用户明确选了「覆盖保存」→ 跳过版本检查重存一次
      outcome = await saveFile({
        tabId: doc.tabId,
        text,
        encoding: doc.encoding,
        eol: doc.eol,
        path: target,
        force: true,
      });
    }
    if (outcome.kind !== "saved") {
      showMessage(`保存 ${doc.name} 失败`, true);
      return false;
    }
    const saved = outcome.value;

    doc.path = saved.path;
    doc.name = saved.name;
    doc.encoding = saved.encoding;
    doc.mixedEol = false;
    // 已落盘 → 这份正文（连同当前编码/行尾）就是新的基线
    markClean(doc, text);
    doc.external = false;
    // 写盘之后磁盘版本变了：记下来，否则这次保存自己激起的 file-changed 会被当成外部修改
    markDiskVersion(doc, saved.mtimeMs, saved.size);
    // 已落盘 → 副本失去意义，删掉它（否则下次启动会拿旧快照顶掉刚保存的内容）
    discardBackupFor(doc);
    scheduleSessionSave();

    const lang = detectLanguage(saved.name, text.split("\n", 1)[0]);
    if (lang.label !== doc.langLabel) {
      doc.langLabel = lang.label;
      // 语言变化广播到该文档的全部实例
      for (const inst of instancesOfDoc(doc.tabId)) {
        const effect = inst.comps.lang.reconfigure(lang.extension ?? []);
        const p = panels.get(inst.panelId);
        if (p?.view && p.activeTabId === inst.tabId) {
          p.view.view.dispatch({ effects: effect });
          inst.state = p.view.view.state;
        } else {
          inst.state = inst.state.update({ effects: effect }).state;
        }
      }
    }

    refreshAll();
    showMessage(`已保存 ${saved.name}（${saved.size} 字节）`);
    logger.info("save", `${saved.name} ${saved.size}B ${saved.encoding}/${saved.eol}`);
    return true;
  } catch (err) {
    if (err === LOSSY_ABORT) {
      showMessage("已取消保存，未写入磁盘");
      return false;
    }
    showMessage(String(err), true);
    return false;
  }
}

/**
 * 保存时撞上「磁盘版本更新」：把选择权交回用户（VS Code 的 FILE_MODIFIED_SINCE）。
 *
 * ⚠️ 只在**手动保存**时调用。自动保存遇到冲突是静默跳过的（见 `scheduleAutosave`）：
 *    用户正打字时弹个模态框出来，体验上是灾难；而替他盖掉外部的新版本，数据上是灾难。
 *
 * @returns `"overwrite"` 让调用方用 force 重存一次；`"abort"` 这次不写盘。
 */
async function resolveSaveConflict(
  doc: Doc,
  conflict: SaveConflict,
): Promise<"overwrite" | "abort"> {
  // 磁盘当前内容要么给弹框显示两边字数，要么 revert / 对照时直接要用，先读一次
  let file: OpenedFile;
  try {
    file = await reloadFile(doc.tabId, doc.encoding);
  } catch {
    // 读不出来（被别的进程独占 / 刚被删）→ 不替用户决定，这次不写
    showMessage(`${doc.name} 的磁盘版本读不出来，已取消本次保存`, true);
    return "abort";
  }
  const mine = freshTextOfDoc(doc);
  if (mine === null) return "abort";

  const choice = await showSaveConflictDialog({
    name: doc.name,
    diskChars: file.text.length,
    mineChars: mine.length,
  });

  if (choice === "overwrite") return "overwrite";

  if (choice === "revert") {
    applyDiskContent(
      doc,
      file,
      file.mtimeMs || conflict.diskMtimeMs,
      file.size || conflict.diskSize,
    );
    showMessage(`已放弃你的修改，载入 ${doc.name} 的磁盘版本`);
    return "abort";
  }
  if (choice === "compare") {
    // 已知版本刷新成磁盘这份：用户已经看过对照，之后再保存就是「看过之后的有意覆盖」，
    // 不该再弹一次框（与监听器那条路径的 compare 行为保持一致）。
    markDiskVersion(doc, file.mtimeMs || conflict.diskMtimeMs, file.size || conflict.diskSize);
    await openDiskCopyForCompare(doc, file);
    return "abort";
  }
  // cancel：既没写盘也没丢改动，文档仍然脏，下次保存会再问一次
  showMessage(`已取消保存 ${doc.name}（磁盘上的新版本未被覆盖）`);
  return "abort";
}

/** 全部保存（Ctrl+Alt+S）：有路径的脏文档直接写盘；未命名文档保留，汇总提示。 */
async function doSaveAll(): Promise<void> {
  const dirty = [...docs.values()].filter((d) => d.dirty);
  if (dirty.length === 0) {
    showMessage("没有需要保存的修改");
    return;
  }
  const named = dirty.filter((d) => d.path);
  const untitled = dirty.filter((d) => !d.path);
  let ok = 0;
  const failed: string[] = [];
  for (const doc of named) {
    const inst = instancesOfDoc(doc.tabId)[0];
    if (!inst) continue;
    try {
      if (await saveDocCore(doc, inst, false)) ok++;
      else failed.push(doc.name);
    } catch (err) {
      if (err !== LOSSY_ABORT) logger.error("save-all", `fail ${doc.name}: ${String(err)}`);
      failed.push(doc.name);
    }
  }
  const parts: string[] = [];
  if (ok > 0) parts.push(`已保存 ${ok} 个文档`);
  if (untitled.length > 0) {
    parts.push(
      `${untitled.length} 个未命名文档需手动保存（${untitled.map((d) => d.name).join("、")}）`,
    );
  }
  if (failed.length > 0) parts.push(`${failed.length} 个保存失败（${failed.join("、")}）`);
  showMessage(parts.length > 0 ? parts.join("；") : "没有需要保存的修改");
}

// ---------------------------------------------------------------- 状态栏菜单

async function showEncodingMenu(): Promise<void> {
  let encodings: string[];
  try {
    encodings = await listEncodings();
  } catch {
    encodings = ["UTF-8", "UTF-8 with BOM", "UTF-16LE", "GB18030"];
  }
  const tab = activeTab();
  const doc = tab ? docOf(tab) : undefined;
  if (!doc) return;

  showPopupMenu(
    sbEncoding,
    encodings.map((label) => ({
      label,
      checked: label === doc.encoding,
      onSelect: () => void switchEncoding(label),
    })),
  );
}

async function switchEncoding(label: string): Promise<void> {
  const tab = activeTab();
  const doc = tab ? docOf(tab) : undefined;
  if (!doc || label === doc.encoding) return;

  if (!doc.path) {
    doc.encoding = label;
    doc.dirty = true;
    refreshAll();
    showMessage(`新建文件的保存编码已设为 ${label}`);
    return;
  }

  if (doc.dirty) {
    const ok = await ask("文件有未保存的修改，重新载入会丢失这些修改。继续吗？", {
      title: "以指定编码重新载入",
      kind: "warning",
    });
    if (!ok) return;
  }

  try {
    const file = await reloadFile(doc.tabId, label);
    suppressDirty = true;
    doc.encoding = file.encoding;
    doc.eol = file.eol;
    doc.mixedEol = file.mixedEol;
    doc.readonly = file.readonly;
    doc.name = file.name;
    // 重新载入 = 内容以磁盘为准：正文、编码、行尾一起钉成新基线
    markClean(doc, file.text);
    markDiskVersion(doc, file.mtimeMs, file.size);
    // 重新载入 = 内容以磁盘为准，此前的未保存副本必须作废
    discardBackupFor(doc);
    // 重载替换内容：重建该文档全部实例并刷新挂载中的视图
    rebuildDocInstances(doc, file.text);
    suppressDirty = false;
    refreshAll();
    showMessage(`已用 ${label} 重新载入 ${file.name}`);
  } catch (err) {
    showMessage(String(err), true);
  }
}

function showEolMenu(): void {
  void (async () => {
    let eols: string[];
    try {
      eols = await listEols();
    } catch {
      eols = ["CRLF", "LF", "CR"];
    }
    const tab = activeTab();
    const doc = tab ? docOf(tab) : undefined;
    if (!doc) return;
    showPopupMenu(
      sbEol,
      eols.map((value) => ({
        label: value,
        checked: value === doc.eol,
        onSelect: () => {
          doc.eol = value;
          doc.mixedEol = false;
          doc.dirty = true;
          refreshAll();
          showMessage(`行尾已切换为 ${value}，保存时生效`);
        },
      })),
    );
  })();
}

// ---------------------------------------------------------------- 会话 / 自动保存（M2）

function scheduleSessionSave(): void {
  // 卫星窗口不碰 session.json：会话只有一份，两个窗口都写就是互相覆盖
  // （表现为「另一个窗口的标签时有时无」）。卫星窗口承载的标签由主窗口兜底持有。
  if (windowKind !== "main") {
    // 卫星窗口每次打字 / 滚动都会走到这儿，所以压到 trace（B147）。
    // 「卫星窗口怎么不写会话」要看的就是这一条 —— 它一直在跳，但主窗口的日志里
    // 一条都不该出现。
    logger.trace("session", "排程落盘 · 卫星窗口不写会话");
    return;
  }
  if (sessionTimer !== null) {
    // B147：连打十几个字就是十几次重排。没有这条，日志上只剩「800ms 后落了一次」，
    // 看着像丢了数据，其实是防抖在正常工作 —— 反而更容易误判。
    logger.trace("session", "排程落盘 · 取消并重排");
    clearTimeout(sessionTimer);
  }
  sessionTimer = setTimeout(() => {
    sessionTimer = null;
    logger.debug("session", "排程落盘 · 800ms 到，开始写");
    void persistSession();
  }, 800) as unknown as number;
}

let sessionTimer: number | null = null;

/**
 * 落盘前把**当前视图**的最新状态回写进标签快照（B140）。
 *
 * 光标与视口都只活在视图 / DOM 上，而 `t.state` 只在切标签、重建布局、拖标签那几处
 * 被回写过（`switchTab` / `rebuildLayout` / `disposePanel`…）。于是「打开 → 编辑 → 移
 * 光标 → 滚动 → 直接关窗」落下去的还是**打开时**那份 —— 重启后光标与位置都回到开头。
 *
 * 放在 `snapshotSession` 开头而不是关窗那一处：防抖的 800ms 落盘、热退出、装更新前的
 * persist 走的都是这条出口，一次同步全照顾到。回写是幂等的（值就来自当下这个视图）。
 */
/**
 * 把活动态的**全部**会话信息刷进 store（B141）。
 *
 * 分两段：
 *  ① 结构 —— 面板的标签顺序 / 活动标签 / 布局 / 活动面板 / 跨窗口标签。这些变化集中在
 *     少数函数里，但落点分散（拖拽、分屏、关闭…），逐个挂 setter 容易漏，所以落盘前
 *     统一同步一次，保证**绝不**拿旧结构写盘。
 *  ② 标签记录 —— 文档字段（path / encoding / eol / backupId）从 `Doc` 取；光标与视口
 *     只活在视图 / DOM 上，从**当前正显示**的那个视图采集（同 `syncShownViewToTab`）。
 *
 * 高频又最容易丢的光标 / 视口 / 视图模式另有即时写入口（`sessionStore.setCursor` 等，
 * 挂在 `handleUpdate` 与滚动监听上）；这里是兜底，两者不冲突 —— setter 写的是同一份记录。
 */
function refreshSession(): void {
  const panelIndex = new Map<number, number>();
  [...panels.keys()].forEach((id, i) => panelIndex.set(id, i));

  // 清理上一轮留下、这轮已经不存在的面板与跨窗口登记
  const gonePanels: string[] = [];
  for (const id of sessionStore.panelIds()) {
    if (!panels.has(id)) {
      sessionStore.dropPanel(id);
      gonePanels.push(String(id));
    }
  }
  for (const p of panels.values()) {
    sessionStore.setPanel(p.panelId, p.tabs, p.activeTabId);
  }
  sessionStore.setLayout(convertLayoutForSession(layoutForSession(), panelIndex));
  sessionStore.setActivePanel(activePanelId);

  // 跨窗口标签：卫星窗口不写会话，这些由主窗口代登记
  const liveRemoted = new Set<number>();
  for (const [docId, r] of remotedTabs) {
    if (!tabs.has(r.tabId)) continue;
    sessionStore.setSatellite(docId, r.tabId, r.owner);
    liveRemoted.add(docId);
  }
  const goneSats: string[] = [];
  for (const docId of sessionStore.satelliteDocIds()) {
    if (!liveRemoted.has(docId)) {
      sessionStore.dropSatellite(docId);
      goneSats.push(String(docId));
    }
  }
  // B147：摘掉登记是正常的（面板被合并 / 标签被别的窗口收走），但「上一次的登记
  // 这轮一个都没对上」值得看一眼 —— 那往往说明有地方改了结构却忘了同步 store。
  if (gonePanels.length > 0 || goneSats.length > 0) {
    logger.trace(
      "session",
      `同步结构 · 摘掉面板 ${gonePanels.join(",") || "无"} / 跨窗口 ${goneSats.join(",") || "无"}`,
    );
  }

  for (const t of tabs.values()) {
    const d = docs.get(t.docId);
    if (!d) continue;
    if (!sessionStore.get(t.tabId)) {
      // ⚠️ 新登记的记录要**带着** `t` 里已有的视口位置进来（B145）：会话恢复的标签在
      // `restoreSession` 里已经把位置读进 `t.scrollTop`，登记成空白的话，下面那条写入
      // 又会被还原期的闸口挡掉 —— 「刚恢复出来的位置」这一轮就白恢复了。
      sessionStore.register(t.tabId, t.docId, { scrollTop: t.scrollTop });
    }
    sessionStore.setDoc(t.tabId, {
      path: d.path ?? "",
      encoding: d.encoding,
      eol: d.eol,
      backupId: d.backupId,
    });
    sessionStore.setViewMode(t.tabId, isMdTab(t) ? t.viewMode : null);
    // 正显示在面板上的那个：光标与视口都在视图 / DOM 上，先采一次再写进记录
    // （同 B140 的「消失前看最后一眼」，只不过现在写的是 store 而不是 Tab）。
    // 其余标签的光标在 `handleUpdate` 里就已经即时写进来了，这里不动它。
    //
    // ⚠️ 读容器的那一下由 `rememberViewScroll` 自己把关（B145）：它认 `pinInFlight`，
    // 钉位置还在重试时一个字都不采；写记录走 `recordScroll`，还原期一律挡掉。
    const p = panels.get(t.panelId);
    if (p?.view && p.viewTabId === t.tabId) {
      t.state = p.view.view.state;
      const pos = t.state.selection.main.head;
      const line = t.state.doc.lineAt(pos);
      sessionStore.setCursor(t.tabId, line.number, pos - line.from + 1);
      rememberViewScroll(p);
    }
    // ⚠️ 这一条走 `recordScroll` 而不是直连 store（B145 单一闸口）：落盘前的这次刷新
    // 读的是 `t`，而 `t` 里的位置可能正好来自「刚钉、还没立住」的容器。
    recordScroll(t.tabId, viewportOfTab(t));
  }
}

// B141：`sessionTabRecordOf` 已删除 —— 标签的会话记录现在由 `sessionStore`（`src/session/store.ts`
// 的 `toDisk`）产出，会话只有一个出口。面板标签与跨窗口标签共用同一份记录，不再各拼一次。

/**
 * 这个标签**为什么**没进会话（进了返回 null）（B147）。
 *
 * 「我的标签怎么重启后没了」只有一种答案：这里的某一条判据拦下了它。以前这个判定
 * 是纯布尔的、一个字都不留 —— 于是文件被删了、热退出没开、文档正脏着，三种情况
 * 全都是「消失了」，查起来只能靠猜。现在判断与**理由**分开，理由进日志。
 */
function sessionRejectReason(t: Tab): string | null {
  const d = docs.get(t.docId);
  if (!d) return "文档已不存在";
  // B68：有磁盘路径的照旧入会话；没有路径的未命名文档，只有在
  // 备份区里确实存着副本时才值得留住（否则恢复时无据可依，只会白占一行）。
  if (d.path) return null;
  if (d.backedUp) return null;
  // B69：热退出开着时，**空的**未命名文档也要留住。它没有内容要救，
  // 但标签本身该原样回来——「新建了还没开始打字」不该重启后凭空消失。
  //
  // ⚠️ 判定必须是「无路径 **且 不脏**」：脏、却又没备份成功的未命名文档
  // 绝不能按空文档恢复，那会把用户打的字真的丢掉。那种情况只能走
  // 关窗确认框（快照里没有它 → 恢复时也不会被当成空文档）。
  if (settings?.hot_exit !== true) return "无路径且无副本（热退出未开）";
  if (d.dirty) return "无路径且脏（不进会话，避免被当成空文档丢掉内容）";
  return null;
}

/** 该文档值不值得进会话（B68/B69 的判据；面板标签与隐藏实例共用）。 */
function sessionWorthy(t: Tab): boolean {
  return sessionRejectReason(t) === null;
}

/**
 * 会话摘要（B147，一行装完）。
 *
 * 「会话写不进去」「会话里少了标签」这两类问题最难查的地方在于：日志上只留一句
 * `save failed: …`，要写的是什么、少了谁全看不出来。所以落盘前后各记一次 ——
 * 前后一比就知道内容压根有没有进去。标签多的会话只打前 8 个：一行几十 KB
 * 会把 2MB 的日志冲掉。
 */
function sessionSummary(s: SessionState, skipped: string[] = []): string {
  const all = s.panels.flatMap((p) => p.tabs);
  const total = all.length + (s.satelliteTabs?.length ?? 0);
  const shown = all.slice(0, 8);
  const body = shown
    .map(
      (t) =>
        `${t.path || "(未命名)"}|行${t.cursorLine}:${t.cursorCol}|位${t.scrollTop ?? "-"}${
          t.viewMode ? `|${t.viewMode}` : ""
        }`,
    )
    .join("  ");
  const rest = total - shown.length;
  return [
    `面板=${s.panels.length} 标签=${total}`,
    `活动面板=${s.activePanel}`,
    body,
    rest > 0 ? `…另 ${rest} 个` : "",
    skipped.length > 0
      ? `未入会话 ${skipped.length}：${skipped.slice(0, 4).join("，")}${
          skipped.length > 4 ? "…" : ""
        }`
      : "",
  ]
    .filter((x) => x !== "")
    .join(" ");
}

function snapshotSession(): Parameters<typeof saveSession>[0] {
  // B141：会话不再现场拼装 —— 先把活动态刷进 store，再把那份记录序列化出去。
  refreshSession();
  const skipped: string[] = [];
  const s = sessionStore.toSessionState((tabId) => {
    const t = tabs.get(tabId);
    if (!t) return false;
    if (sessionWorthy(t)) return true;
    const why = sessionRejectReason(t);
    skipped.push(`${docs.get(t.docId)?.name ?? `#${t.docId}`}${why ? `（${why}）` : ""}`);
    return false;
  });
  // 「标签一个都没进会话」是「重启后全没了」的唯一成因，以前完全静默（B147）。
  if (skipped.length > 0 && s.panels.every((p) => p.tabs.length === 0)) {
    logger.warn(
      "session",
      `快照里一个标签都留不下（${skipped.length} 个被拦下：${skipped
        .slice(0, 4)
        .join("；")}）→ 下次启动会回到空白窗口`,
    );
  }
  logger.debug("session", `快照 · ${sessionSummary(s, skipped)}`);
  return s;
}

/** 布局树叶子 panelId → 会话面板索引（JSON 深拷贝）。 */
function convertLayoutForSession(node: LayoutNode, panelIndex: Map<number, number>): unknown {
  if (node.kind === "leaf") {
    return { kind: "leaf", panelId: panelIndex.get(node.panelId) ?? 0 };
  }
  return {
    kind: "split",
    dir: node.dir,
    ratio: node.ratio,
    a: convertLayoutForSession(node.a, panelIndex),
    b: convertLayoutForSession(node.b, panelIndex),
  };
}

async function persistSession(): Promise<void> {
  try {
    // 落盘前看一眼：写进去的位置是哪一步留下的，下次启动会照这个回来
    logViewport("保存 · 快照前", activePanel() ?? undefined);
    const s = snapshotSession();
    // 写出前先记一份：失败时才有「本来要写的是什么」可对（B147）。
    logger.debug("session", `保存 · 写出 ${sessionSummary(s)}`);
    await saveSession(s);
    logger.trace("session", "保存 · 已交给后端");
  } catch (e) {
    // B143：这里原来是**静默**吞掉的。整份会话写不进去时界面上一点迹象都没有
    // （只表现为「位置/光标不再刷新」），排查只能靠猜 —— 小数 scrollTop 让 Rust 侧
    // 反序列化失败那次就是这么被藏起来的。至少留一条日志。
    logger.warn("session", `保存失败：${String(e)}`);
  }
}

/** 启动时恢复上次会话：按保存的布局树重建面板，逐个打开文件并恢复光标。失败返回 false（退回空白标签）。 */
async function restoreSession(): Promise<boolean> {
  let sess: SessionState | null;
  try {
    sess = await loadSession();
  } catch (e) {
    // B147：这里是整条恢复链的第一道口子，以前却是纯静默 —— 「重启后什么都没恢复」
    // 只能靠猜到底是盘坏了还是路径不对。
    logger.warn("session", `读盘失败 · 按空会话启动：${String(e)}`);
    return false;
  }
  const sp = sess?.panels;
  if (!sess || !sp || sp.length === 0) {
    // 「没恢复」有两种完全不同的成因，日志上必须分得开（B147）：盘上压根没有
    // 会话文件（首次启动，或上次关窗时会话本来就是空的），和读得到但解析不出来。
    logger.info(
      "session",
      sp?.length ? "会话里没有标签 · 按空白标签启动" : "没有会话文件 · 按空白标签启动",
    );
    return false;
  }
  logger.debug(
    "session",
    `读盘 · 面板=${sp.length} 标签=${sp.reduce((n, p) => n + p.tabs.length, 0)} 卫星=${
      sess.satelliteTabs?.length ?? 0
    } 活动面板=${sess.activePanel}`,
  );
  // B71 ④：被搬到其他窗口的标签并回主窗口（v1 不回放多窗口布局）。
  // 追加到**第一个面板**而不是新建分屏：这些标签本来就不属于本窗口的某块分屏，
  // 让它们和主窗口的标签待在一起，比凭空多出一块空面板好理解。
  //
  // 插在这里（而不是在恢复流程末尾单独走一遍）是为了复用同一条恢复链路：
  // 副本优先/文件兜底、按文档身份去重、光标与视图模式恢复都在下面那套里。
  if (sess.satelliteTabs?.length) {
    sp[0].tabs = [...sp[0].tabs, ...sess.satelliteTabs];
  }
  if (!sp.some((p) => p.tabs.length > 0)) return false;
  const panels0 = sp;

  panels.clear();
  tabs = new Map();
  docs = new Map();
  nextPanelId = 1;
  nextInstId = 1;

  // 会话面板索引 → 真实面板 id（随布局树叶子创建）
  const idMap = new Map<number, number>();

  function ensurePanel(idx: number): LayoutNode {
    let realId = idMap.get(idx);
    if (realId === undefined) {
      realId = nextPanelId++;
      panels.set(realId, {
        panelId: realId,
        tabs: [],
        activeTabId: -1,
        view: null,
        viewTabId: null,
        preview: null,
        previewTimer: null,
        bodyEl: null,
      });
      idMap.set(idx, realId);
    }
    return leaf(realId);
  }

  function buildTree(node: unknown): LayoutNode {
    const n = node as {
      kind?: string;
      dir?: string;
      ratio?: number;
      a?: unknown;
      b?: unknown;
      panelId?: number;
    } | null;
    if (n && n.kind === "split") {
      return {
        kind: "split",
        dir: n.dir === "v" ? "v" : "h",
        ratio: typeof n.ratio === "number" && n.ratio > 0 && n.ratio < 1 ? n.ratio : 0.5,
        a: buildTree(n.a),
        b: buildTree(n.b),
      };
    }
    if (n && typeof n.panelId === "number" && n.panelId >= 0 && n.panelId < panels0.length) {
      return ensurePanel(n.panelId);
    }
    // 无效叶子：用尚未分配的会话面板索引补位
    for (let i = 0; i < panels0.length; i++) {
      if (!idMap.has(i)) return ensurePanel(i);
    }
    return ensurePanel(0);
  }

  try {
    layout = buildTree(sess.layout);
  } catch (e) {
    // 布局树解析失败 = 整个会话没法照原样摆回去，此时继续恢复标签只会得到一堆
    // 位置错乱的面板 —— 退回空白标签。但「为什么整份都不要了」必须留下来（B147）。
    logger.warn("session", `布局树解析失败 · 整份会话作废：${String(e)}`);
    return false;
  }
  // 会话面板没全部落到布局树（索引越界等）→ 追加水平分屏兜底
  for (let i = 0; i < panels0.length; i++) {
    if (!idMap.has(i)) {
      layout = { kind: "split", dir: "h", ratio: 0.5, a: layout, b: ensurePanel(i) };
    }
  }

  // 预取：并行发起所有标签的读取。
  //
  // B68 起是「**副本优先、文件兜底**」：备份区里还留着副本，就说明上次关窗时
  // 该文档是脏的，副本内容才是用户最后看到的东西；副本不在（已保存 / 已被丢弃 /
  // 写失败）才按路径读原文件。未命名文档没有路径，只能靠副本。
  //
  // 去重按**文档身份**（有 path 就是 path；未命名但有副本的用副本 ID；
  // 空的未命名文档用 B69 的 docId），**不带面板索引**：
  // 同一个文件可以同时在多个面板打开并共用同一份 doc（同源多实例），只该读一次盘。
  // ⚠️ 这里必须跨面板去重，而不能每个面板各取一次——`restore_backup` 每次都新建
  // 一个标签，取两次就会得到两份**互不同步**的文档，把「同源多实例」悄悄破坏掉。
  type Restored =
    | { kind: "backup"; data: RestoredBackup }
    | { kind: "file"; data: OpenedFile }
    /** B69：空的未命名文档——会话里既没路径也没副本，内容本来就是空的 */
    | { kind: "empty"; data: OpenedFile };
  /** 认不出身份返回空串（旧版本落盘的会话不会写出这种标签，直接跳过）。 */
  const identityOf = (st: {
    path: string;
    backupId?: string | null;
    docId?: number | null;
  }): string =>
    st.path || (st.backupId ? `#${st.backupId}` : st.docId != null ? `#doc:${st.docId}` : "");

  const pending: Array<{
    key: string;
    path: string;
    encoding: string | null;
    eol: string | null;
    backupId: string | null;
  }> = [];
  for (const spanel of panels0) {
    for (const st of spanel.tabs) {
      const backupId = st.backupId ?? null;
      const key = identityOf(st);
      if (!key) continue; // 认不出身份 → 跳过（见 identityOf 注释）
      if (!pending.some((p) => p.key === key)) {
        pending.push({
          key,
          path: st.path,
          encoding: st.encoding ?? null,
          eol: st.eol ?? null,
          backupId,
        });
      }
    }
  }
  const restoredCache = new Map<string, Restored>();
  /** 被跳过的标签（带上原因），收尾时一次打出来（B147）。 */
  const dropped: string[] = [];
  await Promise.all(
    pending.map(async (p) => {
      if (p.backupId) {
        try {
          const backup = await restoreBackup(p.backupId);
          if (backup) {
            restoredCache.set(p.key, { kind: "backup", data: backup });
            return;
          }
          dropped.push(`${p.path || "未命名"}：副本读出来是空的，改按路径打开`);
        } catch (e) {
          dropped.push(`${p.path || "未命名"}：副本读不了（${String(e)}），改按路径打开`);
        }
      }
      // B69：既没有路径、又没有副本 ⇒ 上次关窗时这是一个**空的**未命名文档。
      // 内容本来就是空的，不需要副本（也没东西可写），直接开一个空白文档即可。
      //
      // ⚠️ 走到这里的前提是「不脏」——快照只在 `!d.dirty` 时才写这种标签，
      // 所以不存在「有内容却被当成空文档恢复」的风险（那会真的丢字）。
      if (!p.path) {
        try {
          const info = await ipcNewTab(p.encoding);
          restoredCache.set(p.key, {
            kind: "empty",
            data: {
              tabId: info.tabId,
              reused: false,
              path: "",
              name: info.name,
              text: "",
              encoding: info.encoding,
              eol: p.eol || info.eol,
              mixedEol: false,
              readonly: info.readonly,
              size: 0,
              lossy: false,
              sizeClass: "normal",
              sizeHint: "",
              mtimeMs: 0,
            },
          });
        } catch (e) {
          dropped.push(`未命名#${p.key}：建不出空白文档（${String(e)}）`);
        }
        return;
      }
      try {
        restoredCache.set(p.key, { kind: "file", data: await openFile(p.path, p.encoding) });
      } catch (e) {
        dropped.push(`${p.path}：文件读不了（${String(e)}）`);
      }
    }),
  );
  if (dropped.length > 0) {
    // 预取阶段的失败**不致命**（会退回按路径打开），所以只是 debug（B147）。
    // 但「副本没生效 / 文件被删了」这种正是用户报症状的起点，不能一句话不留。
    logger.debug("session", `预取跳过 ${dropped.length} 项：${dropped.slice(0, 4).join("；")}`);
  }

  // 逐面板恢复标签
  let opened = 0;
  for (let i = 0; i < panels0.length; i++) {
    const spanel = panels0[i];
    const panel = panels.get(idMap.get(i)!);
    if (!panel) continue;
    for (const st of spanel.tabs) {
      const hit = restoredCache.get(identityOf(st));
      if (!hit) continue;
      try {
        const src = hit.data;
        let doc = docs.get(src.tabId);
        if (!doc) {
          doc = makeDoc(
            src.tabId,
            src.text,
            src.name,
            src.path || null,
            src.encoding,
            src.eol,
            src.readonly,
            normalizeSizeClass(src.sizeClass),
            st.backupId ?? null,
          );
          doc.mixedEol = src.mixedEol;
          if (hit.kind === "backup") {
            // 副本还原 = 原样回到「有未保存修改」的状态：
            // 脏 + 已知副本存在，于是关窗依旧不需要确认框。
            doc.dirty = true;
            doc.backedUp = true;
            // 副本里只有「改过之后」的正文，**原文件长什么样并不知道** ⇒ 没有基线，
            // 只能等用户保存时重新钉（在此之前撤销多少次都不会自己转干净）。
            doc.baseline = null;
            // 已知版本无从得知（副本里不存 mtime），留 0：于是接下来的第一个
            // file-changed 一定被判成外部改动 —— 这份本来就脏，正是要弹冲突框的情形。
          } else if (hit.kind === "file") {
            markDiskVersion(doc, hit.data.mtimeMs, hit.data.size);
          }
          registerDoc(doc);
        }
        // 同一路径出现在多个面板：各建一个同源实例（内容自动同步）
        const inst = makeInstance(doc, panel.panelId, src.text);
        tabs.set(inst.tabId, inst);
        panel.tabs.push(inst.tabId);
        // 恢复 Markdown 视图模式（旧版 "split" 映射回 source）
        if (isMdTab(inst) && (st.viewMode === "source" || st.viewMode === "preview")) {
          inst.viewMode = st.viewMode;
        }
        // 恢复光标（实例独立）
        const lineNo = Math.min(Math.max(1, st.cursorLine || 1), inst.state.doc.lines);
        const line = inst.state.doc.line(lineNo);
        const pos = line.from + Math.min(Math.max(0, (st.cursorCol || 1) - 1), line.length);
        inst.state = inst.state.update({ selection: { anchor: pos } }).state;
        // B126：视口位置一并带回（null = 旧会话没有这个字段 → 切过去时保证光标可见）
        inst.scrollTop = st.scrollTop ?? null;
        opened++;
      } catch (e) {
        // 文件已被删除/无法读取 → 跳过该标签。静默过（B143 那类帮凶）：跳了几个、
        // 为什么跳，日志上完全看不出来，重启后就只剩「我的文件没了」。
        dropped.push(`${st.path || "未命名"}：恢复实例失败（${String(e)}）`);
      }
    }
    if (panel.tabs.length > 0) {
      const active = Math.min(Math.max(0, spanel.active), panel.tabs.length - 1);
      panel.activeTabId = panel.tabs[active];
    }
  }

  if (opened === 0) {
    // B147：一个都没恢复出来时，前面攒下的 every 条跳过原因全在这一刻才有意义 ——
    // 「文件全被删了」和「会话格式不对」看起来都是空白窗口，只有这一条分得开。
    logger.warn(
      "session",
      `一个标签都没恢复 · 退回空白窗口（跳过 ${dropped.length} 项：${
        dropped.slice(0, 4).join("；") || "无"
      }）`,
    );
    panels.clear();
    tabs = new Map();
    docs = new Map();
    return false;
  }

  activePanelId = idMap.get(sess.activePanel) ?? [...panels.keys()][0];
  if (!panels.has(activePanelId)) activePanelId = [...panels.keys()][0];
  // 恢复完看一眼：盘上的位置是怎么落到视图上的（「滚到一半闪回开头」要看这里）
  logViewport("加载 · 会话恢复后", getPanel(activePanelId) ?? undefined);
  // B147：这里给出「恢复了什么、丢了什么」的整体结论。上游 bootstrap 那一条 info
  // 只报数量，报不出「丢了哪个文件」—— 而那正是用户报症状时唯一想知道的。
  logger.debug(
    "session",
    `恢复完成 · 打开 ${opened} 个标签 / ${panels.size} 个面板，跳过 ${dropped.length} 项：${
      dropped.slice(0, 4).join("；") || "无"
    }`,
  );
  return true;
}

let autosaveTimer: number | null = null;

/** 自动保存：仅对已关联磁盘且 Unicode 编码的脏文档（无 lossy 风险），1.5s 防抖。 */
function scheduleAutosave(): void {
  if (!settings?.autosave) return;
  if (autosaveTimer !== null) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void (async () => {
      let savedAny = false;
      for (const doc of docs.values()) {
        if (!doc.dirty || !doc.path || doc.readonly) continue;
        if (!isUnicodeEncoding(doc.encoding)) continue;
        const text = freshTextOfDoc(doc);
        if (text === null) continue;
        try {
          const outcome = await saveFile({
            tabId: doc.tabId,
            text,
            encoding: doc.encoding,
            eol: doc.eol,
            path: null,
            expectMtimeMs: doc.diskMtimeMs > 0 ? doc.diskMtimeMs : null,
            expectSize: doc.diskMtimeMs > 0 ? doc.diskSize : null,
          });
          // 撞冲突（磁盘版本被外部改过）→ **静默跳过**：自动保存既不能在用户打字时
          // 弹模态框，也不能替他盖掉外部的新版本。文档保持脏，手动保存时会再问一次。
          if (outcome.kind === "conflict") continue;
          const saved = outcome.value;
          // 写出去的就是新的基线（正文 + 编码 + 行尾）
          markClean(doc, text);
          doc.external = false;
          markDiskVersion(doc, saved.mtimeMs, saved.size);
          // 内容已经落盘，备份区里的副本就成了「过期快照」——留着会让下次启动
          // 拿旧内容顶掉用户的已保存版本。必须在转干净的同时丢弃。
          discardBackupFor(doc);
          savedAny = true;
        } catch (e) {
          // 单个文档保存失败不打断其余。⚠️ 静默过（B147）：自动保存是**用户以为存了**
          // 的那条路径，写失败却一声不响，等于把「没存上」伪装成「存好了」。
          logger.warn("save", `自动保存失败（${doc.name}）：${String(e)}`);
        }
      }
      if (savedAny) {
        refreshAll();
        showMessage("已自动保存");
      }
    })();
  }, 1500) as unknown as number;
}

// ---------------------------------------------------------------- 热退出（B68）
//
// 与自动保存是两件事，别混：
//   自动保存 → 写**原文件**，脏标记随之清除；
//   热退出  → 写 %APPDATA%\LitePad\backups 里的**独立副本**，原文件一个字节不动。
// 正因为原文件不动，「关窗」才有了另一种处理方式：内容没丢，不必再问
// 「未保存的内容将丢失」。VS Code 里这个职责属于 files.hotExit 而不是 autoSave。
//
// 对应 VS Code 的 WorkingCopyBackupTracker：内容一变就防抖排一次备份，
// 而不是攒到关窗才写——这样强杀进程（任务管理器 / 断电）也能捞回未保存内容。

/**
 * 单个副本的体积上限（字符数）。
 *
 * 超过 2 MB 的文档不写副本：这类文档每次按键都要重写几 MB 到几十 MB，
 * 副本本身也极占地方（备份区落在 %APPDATA% 这个用户配置目录里）。
 * 它们关窗时退回确认框，行为与 B68 之前一致——宁可多问一句，不要拖垮交互。
 */
const BACKUP_MAX_CHARS = 2 * 1024 * 1024;

/**
 * 副本 ID：32 位十六进制 + 连字符。
 *
 * ⚠️ 字符集必须与 Rust `backup::is_valid_id` 的白名单一致（ASCII 字母数字与连字符）。
 * 这个 ID 由前端生成后直接参与拼路径，一旦掺进 `/` 或 `..` 就能写到备份区之外。
 */
function newBackupId(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  const hex = [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

let backupTimer: number | null = null;

/** 热退出：把脏文档排进副本队列（1s 防抖，与 VS Code 的备份节奏一致）。 */
function scheduleBackup(): void {
  if (!settings?.hot_exit) return;
  if (backupTimer !== null) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    backupTimer = null;
    void flushBackups();
  }, 1000) as unknown as number;
}

/** 取消排队的备份（关窗前要换成「立刻写」）。 */
function cancelPendingBackup(): void {
  if (backupTimer !== null) {
    clearTimeout(backupTimer);
    backupTimer = null;
  }
}

/**
 * 立刻把所有脏文档写进备份区，返回**没能备份成功**的文档数。
 *
 * 返回值 0 是「关窗可以不弹确认框」的唯一充分条件，所以判定必须严格：
 * 正文取不到、体积超限、写盘失败都计入失败，绝不假装成功——
 * 一旦这里虚报成功，用户的未保存内容就真的没了。
 */
async function flushBackups(): Promise<number> {
  if (!settings?.hot_exit) return 0;
  let failed = 0;
  let assignedNewId = false;
  const jobs: Promise<void>[] = [];

  for (const doc of docs.values()) {
    if (!doc.dirty) continue;
    const text = freshTextOfDoc(doc);
    if (text === null || text.length > BACKUP_MAX_CHARS) {
      failed++;
      // ⚠️ 这里静默过（B147）：撑爆体积上限 / 正文取不到，都是「这份内容这次没兜住」，
      // 归到 failed 里行为是对的（关窗会弹确认框），但没留痕就等于让排查的人去猜。
      logger.warn(
        "hot-exit",
        text === null
          ? `副本未写：取不到正文（${doc.name}）`
          : `副本未写：超过 ${BACKUP_MAX_CHARS} 字符上限（${doc.name}，${text.length} 字）`,
      );
      continue;
    }
    if (!doc.backupId) {
      doc.backupId = newBackupId();
      assignedNewId = true;
    }
    const id = doc.backupId;
    jobs.push(
      writeBackup({
        id,
        text,
        path: doc.path ?? "",
        name: doc.name,
        encoding: doc.encoding,
        eol: doc.eol,
        mixedEol: doc.mixedEol,
      })
        .then(() => {
          doc.backedUp = true;
        })
        .catch((e) => {
          failed++;
          // B147：副本写失败 = 这份未保存内容**一点兜底都没有**。上面 `failed++`
          // 让关窗时该弹的确认框照弹（行为是对的），可「为什么没备上」一个字都留不下。
          logger.warn("hot-exit", `副本写入失败（${doc.name}）：${String(e)}`);
        }),
    );
  }

  // 新分配的 ID 要尽快落到会话里：强杀进程时全靠会话把副本认领回来，
  // 晚一步落盘就等于白写了一份没人认领的副本。
  if (assignedNewId) {
    scheduleSessionSave();
    // B71 ④：卫星窗口新分配的副本 ID 必须同步给主窗口 —— 会话只有主窗口在写，
    // 主窗口不知道这个 ID 的话，重启时会拿**旧的** backupId（或干脆没有）去恢复，
    // 用户真正最后看到的内容反而成了没人认领的孤儿副本被清掉。
    if (windowKind === "satellite") {
      const assigned = [...docs.values()]
        .filter((d) => d.backupId)
        .map((d) => ({ docId: d.tabId, backupId: d.backupId, backedUp: d.backedUp }));
      void emitTo(MAIN_WINDOW_LABEL, "backup-ids", { from: windowLabel, docs: assigned }).catch(
        (e: unknown) => {
          // 交不出去不影响安全（副本已经写好了，下次启动靠会话认领），
          // 但主窗口的会话会记着旧的 backupId —— 这条值得留痕（B147）。
          logger.debug("hot-exit", `副本 ID 没交给主窗口：${String(e)}`);
        },
      );
    }
  }
  await Promise.all(jobs);
  return failed;
}

/**
 * 丢弃某文档的副本（保存成功 / 内容转干净 / 重载 / 关闭标签选「不保存」）。
 *
 * 「备份区里存着副本」≡「该文档有未保存内容」，这是恢复时唯一的判据，
 * 所以内容一旦与磁盘一致就必须立刻丢弃，否则下次启动会拿旧快照
 * 冒充用户的修改。
 */
function discardBackupFor(doc: Doc): void {
  if (!doc.backedUp || !doc.backupId) return;
  const id = doc.backupId;
  doc.backedUp = false;
  void discardBackup(id).catch(() => {
    // 删不掉不阻塞任何事：最坏只是下次启动多还原一个陈旧副本
  });
}

/** 丢弃全部副本（用户关掉热退出开关 / 应用启动后的孤儿清理之外的重置场景）。 */
function discardAllBackups(): void {
  for (const doc of docs.values()) discardBackupFor(doc);
}

/**
 * 外部修改事件的防抖窗口（ms）。
 *
 * notify（ReadDirectoryChangesW）一次保存常常连着给好几个 Modify 事件，
 * 写内容、写属性、目录项变更都会各来一次，全落在几十毫秒内。
 * 攒一下再读盘，省掉一串无意义的读盘（以及随之而来的弹框）。
 */
const EXTERNAL_DEBOUNCE_MS = 150;

/** 防抖窗口内最后一次事件的磁盘版本（以最后一次为准，中间的作废）。 */
const externalPending = new Map<number, FileChangedPayload>();
/** 每文档的防抖定时器。 */
const externalTimers = new Map<number, number>();
/** 正在处理中的文档：读盘 / 等用户选择期间不重入。 */
const externalBusy = new Set<number>();

/**
 * 外部修改事件：磁盘内容变了，把编辑器里这份同步过去（VS Code 的三态模型）。
 *
 * 三种情形：
 *   1. 磁盘内容与内存**完全一致** → 静默（外部只是重写了同样的字节）。
 *   2. 编辑器**没改过**（clean） → 直接以磁盘为准，自动重新载入（保留光标）。
 *   3. 两边**都改过** → 弹三选一：保留我的修改 / 载入磁盘版本 / 打开磁盘版本对照。
 *
 * ⚠️ 回声抑制：保存也会激起 file-changed（watcher 看的是同一个文件）。
 * 判据是「已知磁盘版本」（mtime+size），与事件里的一致就说明是自己的写入，忽略。
 */
function handleFileChanged(payload: FileChangedPayload): void {
  const doc = docs.get(payload.tabId);
  if (!doc || !doc.path) return;
  // 这份文档的正主在另一个窗口（本窗口只剩一个隐藏实例，跟着远端同步走）。
  // 两个窗口都会收到同一个事件，让对面去处理：否则会各弹一个冲突框。
  if (remotedTabs.has(payload.tabId)) return;
  if (payload.mtimeMs === doc.diskMtimeMs && payload.size === doc.diskSize) return;

  // 一次保存往往会连着给好几个 Modify 事件，攒一下再读盘
  externalPending.set(doc.tabId, payload);
  const timer = externalTimers.get(doc.tabId);
  if (timer !== undefined) clearTimeout(timer);
  externalTimers.set(
    doc.tabId,
    window.setTimeout(() => {
      externalTimers.delete(doc.tabId);
      void resolveExternalChange(doc.tabId);
    }, EXTERNAL_DEBOUNCE_MS),
  );
}

async function resolveExternalChange(tabId: number): Promise<void> {
  // 读盘 / 等用户选的过程里不许重入：否则同一个冲突会叠出好几个弹框
  if (externalBusy.has(tabId)) return;
  const payload = externalPending.get(tabId);
  if (!payload) return;
  externalPending.delete(tabId);
  const doc = docs.get(tabId);
  if (!doc || !doc.path) return;

  externalBusy.add(tabId);
  try {
    await resolveExternalChangeCore(doc, payload);
  } finally {
    externalBusy.delete(tabId);
  }
  // 处理期间又来了新事件（用户对着一个过期的弹框做了决定 / 外部又写了一次）→ 接着处理
  if (externalPending.has(tabId)) void resolveExternalChange(tabId);
}

async function resolveExternalChangeCore(doc: Doc, payload: FileChangedPayload): Promise<void> {
  // 带上当前编码：不指定时 open_file 会重新探测编码，那会把用户手动选定的编码冲掉
  // —— 外部刷新只该换内容，不该顺手改掉用户的编码/行尾选择。
  let file: OpenedFile;
  try {
    file = await reloadFile(doc.tabId, doc.encoding);
  } catch {
    // 文件正被别的进程独占 / 刚被删 → 这次跳过，下一个事件还会再来
    return;
  }
  // 已知版本按「实际读到的那一份」记（事件与读盘之间可能又变了一次），
  // 这样「已知版本」与「编辑器里的内容」永远是一一对应的。
  const mtimeMs = file.mtimeMs || payload.mtimeMs;
  const size = file.size || payload.size;

  const mine = freshTextOfDoc(doc);
  if (mine === null) return;

  if (file.text === mine) {
    // 情形 1：内容一致 → 静默，连提示都不给（提示会让人以为丢了什么）
    markDiskVersion(doc, mtimeMs, size);
    doc.external = false;
    return;
  }

  if (!doc.dirty) {
    // 情形 2：编辑器没动过 → 自动以磁盘为准
    applyDiskContent(doc, file, mtimeMs, size);
    showMessage(`${doc.name} 已在外部被修改，已自动载入最新内容`);
    return;
  }

  // 情形 3：两边都改过 → 交给用户决定
  const choice = await showExternalConflictDialog({
    name: doc.name,
    diskChars: file.text.length,
    mineChars: mine.length,
  });
  if (choice === "take-disk") {
    applyDiskContent(doc, file, mtimeMs, size);
    showMessage(`已载入 ${doc.name} 的磁盘版本`);
    return;
  }
  if (choice === "compare") {
    markDiskVersion(doc, mtimeMs, size);
    await openDiskCopyForCompare(doc, file);
    return;
  }
  // keep-mine：内容一字不动，只记下「磁盘上有一份更新的版本」，保存时覆盖它是用户刚做的选择
  markDiskVersion(doc, mtimeMs, size);
  doc.external = true;
  refreshAll();
  for (const inst of instancesOfDoc(doc.tabId)) renderPanelTabs(inst.panelId);
  showMessage(`保留你的修改：保存 ${doc.name} 时会覆盖磁盘上的外部版本`);
}

/** 用磁盘内容替换整个文档（自动刷新 / 用户选择「载入磁盘版本」）。 */
function applyDiskContent(doc: Doc, file: OpenedFile, mtimeMs: number, size: number): void {
  const eol = doc.eol;
  doc.name = file.name;
  doc.mixedEol = file.mixedEol;
  doc.readonly = file.readonly;
  // 外部那一下可能把文件撑大了：档位跟着变，否则重载完反而少了降级
  doc.sizeClass = normalizeSizeClass(file.sizeClass);
  doc.eol = eol;
  markDiskVersion(doc, mtimeMs, size);
  // 内容以磁盘为准 → 磁盘这份就是新基线（不只是「清掉脏标记」，
  // 否则下一次编辑就无从判断「是否已经回到和磁盘一致」）
  markClean(doc, file.text);
  doc.external = false;
  // 内容以磁盘为准 → 此前那份未保存副本作废（留着会让下次启动拿它顶掉刚载入的内容）
  discardBackupFor(doc);
  rebuildDocInstances(doc, file.text, true);
  refreshAll();
}

/** 把磁盘版本开成一个新的未命名标签（对照用），当前文档一字不动。 */
async function openDiskCopyForCompare(doc: Doc, file: OpenedFile): Promise<void> {
  try {
    const info = await ipcNewTab(file.encoding);
    // 后缀插在扩展名**之前**（`a（磁盘版本）.md`）：语言判定与 Markdown 预览
    // 都认扩展名，把它盖掉的话这份对照就只是纯文本了。
    const dot = doc.name.lastIndexOf(".");
    const copyName =
      dot > 0
        ? `${doc.name.slice(0, dot)}（磁盘版本）${doc.name.slice(dot)}`
        : `${doc.name}（磁盘版本）`;
    const copy = makeDoc(
      info.tabId,
      file.text,
      copyName,
      null,
      file.encoding,
      file.eol,
      false,
      normalizeSizeClass(file.sizeClass),
    );
    copy.mixedEol = file.mixedEol;
    registerDoc(copy);
    const panel = activePanel() ?? [...panels.values()][0];
    if (!panel) return;
    const inst = makeInstance(copy, panel.panelId, file.text);
    attachTabToPanel(inst, panel);
    rebuildLayout();
    refreshAll();
    getPanel(panel.panelId)?.view?.focus();
    renderPanelTabs(panel.panelId);
    showMessage(`已在新标签中打开磁盘版本，${doc.name} 未改动`);
  } catch (err) {
    showMessage(String(err), true);
  }
}

// ---------------------------------------------------------------- 悬浮查找 / 替换栏

/**
 * 查找入口：编辑器内不再嵌 CM6 搜索面板，查找/替换统一收敛到这一个应用级浮层
 * （不绑定文件/面板，切换标签、分屏都不会自动关闭）。
 * 按用户要求：范围不用下拉菜单——跨文档能力做成一个「所有打开的文档」勾选框；
 * 文件夹搜索整体不做（不读盘）。
 */
let findBar: FindBarHandle | null = null;

/**
 * 跨文档查找的命中表与游标（B80）。
 *
 * ⚠️ 命中表必须由主程序持有，不能放回查找栏：只有这里才知道怎么切标签、怎么把
 * 命中处选中并滚到视野中间（`openFindHit`）。查找栏那边只落一个**总数**，
 * 用来渲染文档图标右上角的徽标。
 *
 * 既然不再有结果列表，`findHits` 就只服务于**步进**：Enter / 上下箭头在跨文档范围下
 * 逐条跳转（VS Code 的多文件结果在侧边栏搜索视图里，我们这一栏等价于「按顺序走」）。
 */
let findHits: FindHit[] = [];
/** 当前停留的命中下标；-1 = 还没定位（下一次步进从表头/表尾开始） */
let findHitIndex = -1;

/** 清空跨文档命中（查询变了、关栏、熄掉跨文档开关时都要调）。 */
function resetFindAll(bar: FindBarHandle | null = findBar): void {
  findHits = [];
  findHitIndex = -1;
  bar?.setDocIndex(0, 0);
}

function ensureFindBar(): FindBarHandle {
  if (findBar) return findBar;
  findBar = createFindBar(el("app"), {
    onQueryChange: (q) => applyFindQuery(q),
    onStep: (dir, q) => stepFind(dir, q),
    onReplace: (q) => replaceCurrent(q),
    onReplaceAll: (q) => replaceAllInScope(q),
    onClose: () => {
      clearFindHighlight();
      resetFindAll();
    },
  });
  return findBar;
}

/** 打开查找栏（种子一般为当前选中的文本）。 */
function openFindBar(focus: "find" | "replace" = "find"): void {
  const bar = ensureFindBar();
  // 重开时按当前选区重新播种（用户可能刚重新选了一段）
  if (findSelectionOn) seedFindSelectionAnchor();
  bar.open(selectedTextInActiveView(), focus === "replace");
  if (focus === "replace") bar.focusReplace();
  else bar.focusFind();
}

/** 活动视图当前选中的文本（单行且非空才作为查找种子）。 */
function selectedTextInActiveView(): string {
  const view = activePanel()?.view?.view;
  if (!view) return "";
  const sel = view.state.selection.main;
  if (sel.empty) return "";
  const text = view.state.sliceDoc(sel.from, sel.to);
  return text.includes("\n") ? "" : text;
}

function findOptionsOf(q: FindBarQuery) {
  return {
    search: q.text,
    caseSensitive: q.caseSensitive,
    wholeWord: q.wholeWord,
    regexp: q.regexp,
  };
}

/**
 * 活动视图当前选区（非空）起点/终点。
 * ⚠️ **只在播种锚点时调用**（见 `seedFindSelectionAnchor`）。判断作用范围一律读冻结的
 * 锚点 —— 别在这里实时读：步进会把选区换成命中本身。
 */
function activeSelectionRange(): { from: number; to: number } | null {
  const view = activePanel()?.view?.view;
  if (!view) return null;
  const sel = view.state.selection.main;
  if (sel.empty) return null;
  return { from: Math.min(sel.from, sel.to), to: Math.max(sel.from, sel.to) };
}

/** 活动编辑器所属标签 id（`tabs` 的 key）；没有活动视图时返回 null。 */
function activeTabIdOf(): number | null {
  const p = activePanel();
  return p && p.viewTabId !== null ? p.viewTabId : null;
}

/**
 * 「在选区中查找」的**冻结**选区锚点。
 *
 * ⚠️ 为什么不能每次实时读选区：`stepFind()` 步进时会把编辑器选区设成**命中本身**，
 * 于是第二次点「下一个」时范围就塌缩成「只剩这一个命中」（用户实测反馈）。
 * 因此锚点只在**用户动作**时播种：开关由关→开、重开查找栏、切换文档；
 * 导航（上/下一个、替换）全程只读，不改。
 *
 * 同时记住所属标签 id：切文档后旧偏移量没有意义，必须重取。
 */
let findSelectionAnchor: { docId: number; from: number; to: number } | null = null;
/** 上一轮的「在选区中查找」开关值，用于识别「刚被打开」这一瞬间。 */
let findSelectionOn = false;

/** 用当前选区播种锚点（只在用户动作时调用）。 */
function seedFindSelectionAnchor(): void {
  const range = activeSelectionRange();
  const docId = activeTabIdOf();
  findSelectionAnchor = range && docId !== null ? { docId, from: range.from, to: range.to } : null;
}

/**
 * 当前生效的选区限制（**只读**，绝不改锚点）。
 * 锚点为空、或它属于别的文档时返回 null（= 不限制）。
 */
function currentFindRestrict(q: FindBarQuery): { from: number; to: number } | null {
  if (!q.inSelection) return null;
  const a = findSelectionAnchor;
  if (!a || a.docId !== activeTabIdOf()) return null;
  return { from: a.from, to: a.to };
}

/** 把查询写到全部可见视图（高亮同步；离屏实例不参与高亮）。 */
function applyFindQuery(q: FindBarQuery): void {
  const query = buildFindQuery(findOptionsOf(q));
  // 开关刚被打开 / 关掉 → 播种或清除锚点。只有用户点开关会改 inSelection，
  // 导航不会，所以冻结的锚点不会被步进改掉的选区带偏。
  if (q.inSelection !== findSelectionOn) {
    findSelectionOn = q.inSelection;
    if (q.inSelection) seedFindSelectionAnchor();
    else findSelectionAnchor = null;
  }
  const restrict = currentFindRestrict(q);
  const active = activePanel();
  for (const p of panels.values()) {
    if (!p.view) continue;
    // 选区限制只作用于活动编辑器（其余面板没有这份选区，按全文高亮）
    const r = p === active ? restrict : null;
    p.view.view.dispatch({ effects: setFindQuery.of({ query, activeFrom: null, restrict: r }) });
  }
  applyPreviewFindEverywhere(q);
  // 跨文档范围：查询一变，上一次的命中表就作废 —— 这里直接重搜一次，
  // 让文档图标右上角的总数跟着实时走（与 VS Code 搜索视图「改选项即重跑」一致）。
  // 非跨文档范围则把旧的命中表清掉，免得下次点亮开关时徽标挂着一个过期的数字。
  if (q.allDocs) runFindInDocs(q);
  else resetFindAll();
  refreshFindCount();
}

/** 预览态查找高亮：md 预览面板（源码模式由编辑器装饰覆盖）。 */
function applyPreviewFindEverywhere(q: FindBarQuery): void {
  const spec = findSpecOf(q);
  for (const p of panels.values()) {
    applyPreviewFindToPanel(p, spec);
  }
}

type PreviewFindSpec = {
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
} | null;

function findSpecOf(q: FindBarQuery): PreviewFindSpec {
  return q.text
    ? { text: q.text, caseSensitive: q.caseSensitive, wholeWord: q.wholeWord, regexp: q.regexp }
    : null;
}

function applyPreviewFindToPanel(p: Panel, spec: PreviewFindSpec): void {
  if (!p.preview) return;
  const tab = tabs.get(p.activeTabId);
  if (!tab || !isMdTab(tab) || tab.viewMode === "source") return;
  p.preview.applyFind(spec);
}

function clearFindHighlight(): void {
  for (const p of panels.values()) {
    if (p.view) clearFindQuery(p.view.view);
    p.preview?.applyFind(null);
  }
}

/** 保留大小写：复用 find.ts 的纯函数（VS Code 同款算法）。 */
function applyPreserveCase(matchText: string, replacement: string): string {
  return preserveCase(matchText, replacement);
}

/**
 * 把命中集合按「在选区中查找」限制到**锚定**的选区内（复用 find.ts 的纯函数）。
 * ⚠️ 读的是冻结锚点而非实时选区 —— 否则步进一次就只剩一个命中。
 */
function restrictMatches(matches: FindMatch[], q: FindBarQuery): FindMatch[] {
  return restrictToRange(matches, currentFindRestrict(q));
}

function refreshFindCount(): void {
  const bar = findBar;
  if (!bar) return;
  const q = bar.getQuery();
  // 跨文档范围：计数口径与「当前文档 / 选区」**完全一致** —— 有文本没命中 = 「无匹配」，
  // 有命中 = 「当前序号 / 总数」（总数来自跨文档命中表，序号即 findHitIndex）。
  // ⚠️ 早先这里一律写「无内容」（当时认为总数已在徽标上，会误导），副作用是
  //    prev/next 被置灰、结果区看起来没更新 —— 用户反馈「激活多文件搜索没反应」的根因。
  //    命中总数是「几个文档有结果」另有徽标 a/b，与这里的「第几个命中」不冲突。
  if (q.allDocs) {
    if (findHits.length === 0) bar.setCount(q.text ? "无匹配" : "");
    else bar.setCount(`${(findHitIndex >= 0 ? findHitIndex : 0) + 1} / ${findHits.length}`);
    return;
  }
  // 预览态：计数与当前项来自预览高亮（预览可见文本与源码一一对应，步进以它为准）
  const panel = activePanel();
  const tab = panel ? tabs.get(panel.activeTabId) : undefined;
  if (panel && tab && isMdTab(tab) && tab.viewMode === "preview" && panel.preview) {
    const st = panel.preview.findState();
    if (st.count === 0) {
      bar.setCount(q.text ? "无匹配" : "无内容");
    } else {
      const cur = st.active >= 0 ? st.active : 0;
      bar.setCount(`${cur + 1} / ${st.count}`);
    }
    return;
  }
  const view = panel?.view?.view;
  if (!view) return;
  const query = buildFindQuery(findOptionsOf(q));
  const matches = restrictMatches(findMatches(view.state, query), q);
  if (matches.length === 0) {
    bar.setCount(q.text ? "无匹配" : "");
    return;
  }
  const idx = nextMatchIndex(matches, view.state.selection.main.head, 1);
  bar.setCount(`${idx + 1} / ${matches.length}`);
}

/**
 * 步进：当前文档范围内跳到上一个 / 下一个命中（到头环绕）。
 * ⚠️ 跨文档范围（点亮了文档图标）要转给 `stepFindInDocs` —— 命中表在主程序手里，
 * 这里的 `view` 只是活动编辑器，走不到别的文档去。
 */
function stepFind(dir: 1 | -1, q: FindBarQuery): void {
  if (q.allDocs) {
    stepFindInDocs(dir, q);
    return;
  }
  const panel = activePanel();
  if (!panel) return;
  const tab = panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
  // 预览态：在预览高亮里步进 + 滚动到命中处（隐藏编辑器收不到滚动）
  if (tab && isMdTab(tab) && tab.viewMode === "preview" && panel.preview) {
    if (!q.text) {
      findBar?.setCount("");
      return;
    }
    panel.preview.stepFind(dir);
    refreshFindCount();
    return;
  }
  const view = panel.view?.view;
  if (!view) return;
  const query = buildFindQuery(findOptionsOf(q));
  const matches = restrictMatches(findMatches(view.state, query), q);
  if (matches.length === 0) {
    findBar?.setCount(q.text ? "无匹配" : "");
    return;
  }
  const idx = nextMatchIndex(matches, view.state.selection.main.head, dir);
  const m = matches[idx];
  view.dispatch({
    selection: { anchor: m.from, head: m.to },
    effects: [
      EditorView.scrollIntoView(m.from, { y: "center" }),
      setFindQuery.of({
        query,
        activeFrom: m.from,
        // 冻结锚点：步进刚把选区换成了命中本身，这里若实时读选区就会自我塌缩
        restrict: currentFindRestrict(q),
      }),
    ],
  });
  if (tab) tab.state = view.state;
  findBar?.setCount(`${idx + 1} / ${matches.length}`);
}

/** 替换当前命中（没有选中命中时，先跳到下一个再替换下一次点击生效）。 */
function replaceCurrent(q: FindBarQuery): void {
  const panel = activePanel();
  const view = panel?.view?.view;
  if (!panel || !view) return;
  const query = buildFindQuery(findOptionsOf(q));
  const matches = restrictMatches(findMatches(view.state, query), q);
  const sel = view.state.selection.main;
  const target =
    matches.find((m) => m.from === sel.from && m.to === sel.to) ??
    (matches.length ? matches[nextMatchIndex(matches, sel.head, 1)] : undefined);
  if (!target) {
    findBar?.setStatus("没有可替换的匹配");
    return;
  }
  const matched = view.state.sliceDoc(target.from, target.to);
  const insert = q.preserveCase ? applyPreserveCase(matched, q.replace) : q.replace;
  const nextFrom = target.from + insert.length;
  view.dispatch({
    changes: { from: target.from, to: target.to, insert },
    selection: { anchor: nextFrom },
    effects: [
      EditorView.scrollIntoView(nextFrom, { y: "center" }),
      setFindQuery.of({
        query,
        activeFrom: target.from,
        restrict: currentFindRestrict(q),
      }),
    ],
  });
  const tab = panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
  if (tab) tab.state = view.state;
  refreshFindCount();
  findBar?.setStatus("已替换 1 处");
}

/**
 * 全部替换。勾选「所有打开的文档」时遍历全部已打开文档（只改内存快照，
 * 落盘仍由各自的保存流程负责）；否则只改当前活动文档。
 */
function replaceAllInScope(q: FindBarQuery): void {
  if (!q.text) {
    findBar?.setStatus("请输入查找内容");
    return;
  }
  const query = buildFindQuery(findOptionsOf(q));
  if (!query) {
    findBar?.setStatus("查找内容无效（正则语法错误？）");
    return;
  }

  if (!q.allDocs) {
    const panel = activePanel();
    const view = panel?.view?.view;
    if (!panel || !view) return;
    const matches = restrictMatches(findMatches(view.state, query), q);
    if (matches.length === 0) {
      findBar?.setStatus("无匹配");
      return;
    }
    const changes = matches.map((m) => ({
      from: m.from,
      to: m.to,
      insert: q.preserveCase
        ? applyPreserveCase(view.state.sliceDoc(m.from, m.to), q.replace)
        : q.replace,
    }));
    view.dispatch({ changes });
    const tab = panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
    if (tab) tab.state = view.state;
    findBar?.setStatus(`已替换 ${matches.length} 处`);
    refreshFindCount();
    return;
  }

  let files = 0;
  let total = 0;
  for (const doc of docs.values()) {
    if (doc.readonly) continue;
    const insts = instancesOfDoc(doc.tabId);
    if (insts.length === 0) continue;
    const matches = findMatches(insts[0].state, query);
    if (matches.length === 0) continue;
    const changes = matches.map((m) => ({
      from: m.from,
      to: m.to,
      insert: q.preserveCase
        ? applyPreserveCase(insts[0].state.sliceDoc(m.from, m.to), q.replace)
        : q.replace,
    }));
    // 优先派发给正挂在视图上的实例——由 syncDocInstances 广播到兄弟实例并置脏；
    // 全部离屏时才直接改快照，并手动置脏
    const visible = insts.find((t) => {
      const p = panels.get(t.panelId);
      return !!p?.view && p.viewTabId === t.tabId;
    });
    if (visible) {
      const p = panels.get(visible.panelId)!;
      p.view!.view.dispatch({ changes });
      visible.state = p.view!.view.state;
    } else {
      for (const t of insts) t.state = t.state.update({ changes }).state;
      // 离屏实例改完快照后同样按「是否偏离基线」判（B112）：替换词与被替换词恰好
      // 相同时内容一字未变，不该挂上 ●。
      if (!doc.dirty && isDirtyVsBaseline(doc, freshTextOfDoc(doc))) {
        doc.dirty = true;
        refreshTitle();
        renderPanelTabs();
      }
    }
    files++;
    total += matches.length;
  }
  findBar?.setStatus(total === 0 ? "无匹配" : `已在 ${files} 个文档中替换 ${total} 处`);
  refreshFindCount();
}

/**
 * 在所有已打开的文档中查找（直接扫内存里的标签快照，不读盘）。
 *
 * ⚠️ **不设条数上限**（B80 去掉结果列表后，原先那个「最多 300 条」的保护就没意义了）：
 * 返回数组既是步进的命中表，也是徽标上「总匹配数」的来源 —— 截断会让徽标少报数。
 */
function searchOpenDocs(q: FindBarQuery): FindHit[] {
  const query = buildFindQuery(findOptionsOf(q));
  if (!query) return [];
  const out: FindHit[] = [];
  for (const doc of docs.values()) {
    const inst = instancesOfDoc(doc.tabId)[0];
    if (!inst) continue;
    const state = inst.state;
    for (const m of findMatches(state, query)) {
      const line = state.doc.lineAt(m.from);
      out.push({
        docId: doc.tabId,
        path: doc.path ?? "",
        name: doc.name,
        line: line.number,
        col: m.from - line.from + 1,
        text: line.text.trim().slice(0, 200),
        from: m.from,
        to: m.to,
      });
    }
  }
  return out;
}

/** 含结果的文档（按首次出现顺序去重），用于跨文档徽标的 b。 */
function docsWithHits(): number[] {
  const order: number[] = [];
  for (const h of findHits) if (!order.includes(h.docId)) order.push(h.docId);
  return order;
}

/** 跨文档徽标：a = 当前命中（findHitIndex）所属文档的序号，b = 含结果的文档数。 */
function updateDocBadge(): void {
  const docs = docsWithHits();
  const b = docs.length;
  let a = 0;
  if (findHitIndex >= 0 && findHits[findHitIndex]) {
    a = docs.indexOf(findHits[findHitIndex].docId) + 1;
  } else if (b > 0) {
    a = 1;
  }
  findBar?.setDocIndex(a, b);
}

/**
 * 跨文档查找：重算命中表 → 刷新徽标（`a/b`）。
 *
 * ⚠️ 09-20 起**只负责算，不负责显示**：计数与按钮状态一律交给 `refreshFindCount()`，
 * 与「当前文档」「选区」两种范围走同一个出口 —— 早先这里会顺手写 `setCount` 并播报一行
 * 「共 N 处匹配…」那条成功播报，结果 ① 那行提示在另外两种范围里都没有（不一致，已按用户
 * 要求删除）；② 写完还被紧随其后的 `refreshFindCount()` 覆盖成「无内容」，
 * 于是 prev/next 被置灰 —— 表现就是「点亮多文件搜索没反应」。
 */
function runFindInDocs(q: FindBarQuery): void {
  findHits = q.text ? searchOpenDocs(q) : [];
  findHitIndex = -1;
  updateDocBadge();
}

/**
 * 跨文档步进：在命中表里往前走 / 往后走（到头环绕），并把该命中处选中、滚到视野中间。
 *
 * 命中表为空有两种可能：①真的没命中；②用户没按回车、直接点箭头进来的。
 * 后者要先补搜一次 —— 否则「勾了文档图标点下一个没反应」。
 */
function stepFindInDocs(dir: 1 | -1, q: FindBarQuery): void {
  if (!q.text) {
    refreshFindCount();
    return;
  }
  if (findHits.length === 0) {
    // 补搜一次：查询/范围变化时主程序已经搜过，这里兜的是「命中表被清掉又直接点箭头」的路径
    runFindInDocs(q);
    if (findHits.length === 0) {
      refreshFindCount();
      return;
    }
    findHitIndex = dir > 0 ? 0 : findHits.length - 1;
  } else {
    findHitIndex = (findHitIndex + dir + findHits.length) % findHits.length;
  }
  updateDocBadge();
  openFindHit(findHits[findHitIndex]);
  refreshFindCount();
}

/** 跳到某条命中：切到该文档并把命中处选中、滚到视野中间。 */
function openFindHit(hit: FindHit): void {
  const insts = instancesOfDoc(hit.docId);
  if (insts.length === 0) return;
  const target = insts[0];
  switchTab(target.panelId, target.tabId);
  for (const inst of insts) {
    const p = panels.get(inst.panelId);
    if (p?.view && p.viewTabId === inst.tabId) {
      p.view.view.dispatch({
        selection: { anchor: hit.from, head: hit.to },
        effects: EditorView.scrollIntoView(hit.from, { y: "center" }),
      });
      inst.state = p.view.view.state;
    } else {
      inst.state = inst.state.update({ selection: { anchor: hit.from, head: hit.to } }).state;
    }
  }
  activePanel()?.view?.focus();
}

/** 标签/面板切换后：浮层保持打开，把当前查询重新应用到新的活动视图。 */
function retargetFindBar(): void {
  // 换了文档 → 旧锚点的偏移量作废，按新文档的选区重取；
  // 同一文档时**不动**锚点（否则 F3 步进后的「命中选区」会被当成新锚点）。
  if (findSelectionOn && findSelectionAnchor?.docId !== activeTabIdOf()) seedFindSelectionAnchor();
  if (findBar?.isOpen()) findBar.retarget();
}

// ---------------------------------------------------------------- Markdown 预览（M3）

function isMdDoc(doc: Doc | undefined | null): boolean {
  return !!doc && /\.(md|markdown|mdown|mkd)$/i.test(doc.name);
}

function isMdTab(tab: Tab): boolean {
  return isMdDoc(docs.get(tab.docId));
}

function isMdActive(): boolean {
  const t = activeTab();
  return !!t && isMdTab(t);
}

/** 编辑器可视区顶行（1-based）。预览态编辑器是 display:none，scrollTop 会被重置，
 *  所以必须在隐藏**之前**取值（切视图时据此把预览定位到同一区域）。 */
function topVisibleLineOf(view: EditorView): number {
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop + 1);
  return view.state.doc.lineAt(block.from).number;
}

/**
 * 标签当前的视口滚动位置（B126 + B129）。
 *
 * 正显示在面板上的实例要取视图的**实时值**（用户刚滚过但还没切走，快照还没更新）；
 * 离屏实例只能取上次记下的快照。
 *
 * 纯预览态取**预览那一侧**（B129）：编辑器是 `display:none`，它的 scrollTop 被
 * 浏览器清零，记下来只会把「视图位置」写成 0 —— 于是重启后预览每次都弹回开头。
 */
function viewportOfTab(t: Tab): number | null {
  // 快照就是 `Tab.scrollTop` 这一处全局记录（B139）：按 tabId 索引、与视图生命周期
  // 解耦，**绝不回头读容器**。读容器等于把「谁最后摆过它」混进来 —— 预览容器是
  // 面板级的、所有标签共用，编辑器里摆的还可能是刚被清零的 0。
  return t.scrollTop;
}

/**
 * 程序滚动期间禁止写快照（B139）。
 *
 * 滚动位置只活在 DOM 上，但**快照不跟着 DOM 走**（见 `viewportOfTab` 的语义）。
 * 于是会出现一类情况：我们自己的还原赋值（`pinScrollTop` 钉位置、`applyPending`
 * 的二次定位）会派发 scroll 事件，而那时容器里摆的是**程序算出来的中间态或落点**，
 * 不是这个标签真正的位置 —— 顺着事件写回去就把快照覆盖掉。
 * 典型症状：预览落点在 960 / 952 之间抖（jsdom 里肉眼可见，真机上就是
 * 「重启后位置差几行」）。
 *
 * 区间覆盖「赋值本身 + 它派发的那一发 scroll」，以及 `pinScrollTop` **逐帧补钉的
 * 整段**：浏览器的 scroll 事件在下一帧的 scroll steps 才派发，所以计数器必须活到
 * 最后一次补钉之后才降，中途降下来的话，补钉途中的中间值就会被当成用户停过的位置。
 * （B145 起补钉不再只做一帧。）
 */
let viewportWriteDepth = 0;

/**
 * ⚠️ 这里**曾经**另起过一个 `swappingView`：`setState` 前后也把 `viewportWriteDepth`
 * +1 一帧，想连「浏览器下一帧才派发的那发 scroll」一起挡住。已删（B146 二轮定稿）——
 * 它挡掉的并不只有换文档那两下自动滚动，**切完标签同一帧内的用户滚动也一并丢了**
 * （`session-restore-state` 的 B129 用例因此变红），而那本来就该记。
 * `restoringViewport` 的两帧窗口已经够用：换文档那几下自动滚动落在它是拦得住的，
 * 实测退回修复前后行为用例照样精确变红。想再加保险，得先能说清「丢掉的那一下
 * 一定是程序造成的」，现在说不清。
 */

/**
 * 在视图消失**之前**把此刻的位置采进快照（B126，B139 保留但换了理由）。
 *
 * 快照是与 DOM 解耦的全局记录（见 `viewportOfTab`），`setState` / `view.destroy()`
 * 清不掉它 —— 但**读不到**：位置变化不一定派发 scroll 事件，最典型的是程序里的裸写
 * （预览→编辑器同步的 `host.scrollToLine()`、用例里的直接赋值）。最后一次变化若不采，
 * 这份快照就一直停在更早的位置上。
 *
 * 所以这里不是「随 DOM 刷新」，而是「DOM 消失前看最后一眼」：读的是清零**之前**
 * 的容器，采完立刻就销毁。两件事各管一段 —— 滚动采样覆盖「用户滚过」，这里覆盖
 * 「最后的落点是程序摆的、且没发过事件」。
 */
function rememberViewScroll(panel: Panel): void {
  if (!panel.view || panel.viewTabId === null) return;
  const t = tabs.get(panel.viewTabId);
  if (!t) return;
  // 纯预览实例：编辑器是 display:none、scrollDOM.scrollTop 恒为 0，照常写回来
  // 就等于「切走的一刻把上次的位置抹平」（B130）。这类实例的位置归预览那一侧。
  // B145：钉位置**还在重试**的那一刻，容器里摆的是没立住的值（多半是被裁成的 0）。
  // 这段空窗期归还原管，「消失前看最后一眼」看出来的会是一份假位置，采进去就等于
  // 把「还原没成功」记成「用户停在这里」—— 于是落盘成 0、重启回顶部。
  if (pinInFlight(panel.view.view.scrollDOM)) return;
  if (t.viewMode === "preview") {
    const mode = panel.bodyEl?.classList;
    if (mode?.contains("mode-preview") || mode?.contains("mode-split")) {
      const root = panel.preview?.root ?? null;
      if (root === null || !pinInFlight(root)) {
        recordScroll(t.tabId, root ? root.scrollTop : null);
      }
    }
    return;
  }
  recordScroll(t.tabId, panel.view.view.scrollDOM.scrollTop);
}

/**
/**
 * 正在还原视图位置的标签（B142）。
 *
 * 视图刚建好、内容还没撑开的那一会儿，浏览器会按「当前可滚动范围」把我们赋的值
 * 裁成 0，并派发一发值为 0 的 scroll；真正的位置要靠下一帧补钉才立住。于是：
 *   · 那发 0 值事件会把 0 写进会话记录**并排程落盘**；
 *   · 补钉那一下又在 `pinScrollTop` 的抑制区间里（按 B139 不该写）；
 *   ⇒ 盘上留下的是 0，重启回到顶部（用户报的症状）。
 *
 * 所以还原期间把这个标签自己发的所有 scroll 一并挡掉：等位置真正立住再解锁。
 */
const restoringViewports = new Set<number>();

/** 在「还原这一个标签的位置」期间跑一段代码：期间它派发的 scroll 一律不写快照。 */
function restoringViewport(tabId: number, run: () => void): void {
  restoringViewports.add(tabId);
  run();
  // 解锁要等两帧：补钉在下一帧、补钉派发的事件再下一帧。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      restoringViewports.delete(tabId);
    });
  });
}

/**
 * 正在重试「钉稳」的容器（B145）。
 *
 * 位置还没立住的容器是不可信的：里面的值随时会被下一次补钉改写。所以别的模块
 * （`rememberViewScroll`）看见这个集合里有它就别采 —— 采一份半路的中间值，等于把
 * 一个还没生效的落点当成用户停过的位置。
 */
const pinningContainers = new WeakSet<HTMLElement>();

function pinInFlight(el: HTMLElement): boolean {
  return pinningContainers.has(el);
}

/**
 * 视口调试日志（B146）。
 *
 * 用户报「切换标签时 md 文档的滚动位置会不断往下移」，而位置只在 DOM 上、写进记录的
 * 路径有好几条（切标签、滚动采样、刷新会话、预览二次定位…）。想知道**哪一步**把手
 * 放歪了，就得在每一步都留一条：快照值 / 编辑器实际值 / 预览实际值 / 视图模式。
 *
 * 默认级别是 info，这一条打开看不到 —— 要看就把设置里的日志级别调到 debug（或 trace）。
 * 别为了「always on」把它提到 info：滚动采样一秒能打几十条，会把 2MB 的日志冲掉。
 */
function logViewport(where: string, panel?: Panel): void {
  const p = panel ?? activePanel();
  if (!p) return;
  const view = p.view?.view;
  const t = p.viewTabId !== null ? tabs.get(p.viewTabId) : undefined;
  const mode = t?.viewMode ?? "-";
  const root = p.preview?.root;
  const shown = mode === "preview" ? root?.scrollTop : view?.scrollDOM.scrollTop;
  logger.debug(
    "viewport",
    `${where} tab=${t?.tabId ?? "-"} 模式=${mode} 快照=${t?.scrollTop ?? "null"} 视图=${shown ?? "-"}`,
  );
}

/**
 * 写标签的滚动位置到会话记录 —— **唯一闸口**（B145）。
 *
 * `restoringViewports` 原来只被两个 scroll 监听认，于是还有几条旁路能绕过去：
 * `rememberViewScroll`（重建布局 / 关面板 / 落盘前刷新时读容器）、`refreshSession`
 * 的兜底写入。那几条恰好都发生在「还原刚起步、容器还是被裁过的 0」的窗口里 ——
 * 用户报的「打开窗口后位置刷新并落盘成 0」就是从这儿出去的。
 *
 * 把守卫挪到这一个出口上：还原期间，任何来源都不许写这条记录的 scrollTop。
 */
function recordScroll(tabId: number, px: number | null): void {
  if (restoringViewports.has(tabId)) {
    logger.trace("viewport", `还原期拒绝写位置 tab=${tabId} px=${px}`);
    return;
  }
  // `t.scrollTop` 与记录是同一份东西（`viewportOfTab` 只读它），一并写过去别让两边分叉；
  // `null` 表示「这份实例从没显示过」，是有意义的空值，不往活动态里倒灌。
  if (px !== null) {
    const t = tabs.get(tabId);
    if (t) t.scrollTop = px;
  }
  // 记录被写进去的那一条（trace）：滚一下就有几十条，所以级别压到 trace 而不是 debug。
  // 「哪一步把手放歪了」要看的就是这一串 —— 相邻两条之间差了多少，就是那一步改的量。
  logger.trace("viewport", `写入位置 tab=${tabId} px=${px}`);
  sessionStore.setScroll(tabId, px);
}

/**
 * 把标签快照里的滚动位置还给视图（B126）。
 *
 * 必须在 setState / 新建视图**之后**调：先有对的内容，滚动位置才有意义（浏览器
 * 会按新内容长度自动裁剪）。
 *
 * `scrollTop === null`（这份实例从没显示过）时退化为「保证光标可见」——
 * 会话恢复只带了 cursorLine/cursorCol，没有视口信息，硬钉 0 会让光标停在屏幕外。
 */
/**
 * 把滚动位置**钉稳**（B134）。
 *
 * 赋值那一刻容器往往还没布局完（编辑器刚从 `display:none` 出来、预览刚 `setBlocks`），
 * 浏览器按规范会把超出可滚动范围的赋值**裁掉** —— 内容高度还没撑开时裁成 0，
 * 位置就等于没设。更糟的是这次赋值会派发 scroll 事件，把「0」写回标签快照，
 * 于是下一次保存下来的也是 0（B134：重启后每次都回到顶部）。
 *
 * 所以：先按老办法写；写进去的值没被裁（读回来对得上）就收工，被裁了就**逐帧补钉**，
 * 一直补到立住为止。
 *
 * ⚠️ 只补一帧是不够的（B145）：窗口刚打开时布局可能连着好几帧都没稳 —— 窗口还没
 * 显示、大文件刚把内容撑开、预览的一次 setBlocks 还没落地。差那么一帧，位置就永久
 * 停在被裁掉的 0 上，然后被落盘、被下次启动读回来（用户报的「打开恢复位置时落盘成
 * 0」）。所以这里一直重试到立住，中途的值一个都不信。
 */
const PIN_MAX_FRAMES = 12;

/**
 * 判定「立住」的位置容差（px）。
 *
 * ⚠️ 必须留容差：浏览器 `scrollTop` 是 **double**，缩放不是 100% 时（125% / 150%）
 * 它天然带小数 —— 「钉上去的目标值」与「读回来的落点」差零点几 px 是**正常结果**
 * （B143 那条线索就是从这类小数开始的）。拿精确相等判「钉上了没」，小数永远对不上，
 * 结果就是每次补钉都一路重试到 `PIN_MAX_FRAMES`、甩一条「没立住」出来（满屏都是
 * 这条 WARN，真出问题时反而看不见）。只有差距**明显**才算钉不进去。
 */
const PIN_EPSILON_PX = 1;

/** 落点打印：493.3333435058594 这种没必要整串塞进日志。 */
function fmtPx(v: number): string {
  return v.toFixed(2);
}

function pinScrollTop(el: HTMLElement, px: number): void {
  pinningContainers.add(el);
  // 整段都在「程序滚动」区间里：赋值派发的那次事件不该把位置写回快照（B139）。
  // ⚠️ 区间要活到**最后一次补钉之后**才降（不能像 `suppressViewportWrite` 那样下一帧
  // 就还）：布局可能连着好几帧都没稳，中途降下来的话，补钉途中的中间值就会被当成
  // 「用户停过的位置」写进记录。
  viewportWriteDepth++;
  const release = (): void => {
    requestAnimationFrame(() => {
      viewportWriteDepth = Math.max(0, viewportWriteDepth - 1);
    });
  };
  const retry = (frame: number): void => {
    el.scrollTop = px;
    const landed = el.scrollTop;
    // 立住了。或者被**文档长度**夹住（短文档，px 本来就超出可滚动范围）也算立住 ——
    // 那种情况下 0 是合法的落点，不该误判成「没布局」而继续重试。
    //
    // ⚠️ 两支都留容差（用户反馈）：落点与目标**差一点**（缩放下的小数，甚至反超一点）
    // 就是钉上了，别再重试；只有落后**明显**超过容差，才是「文档短、被夹住」。
    // 原来写 `landed === px || landed < px`，小数落点两边都落空 ⇒ 每回都报「没立住」。
    const diff = landed - px;
    const stuck =
      Math.abs(diff) <= PIN_EPSILON_PX || (px > 0 && landed > 0 && diff < -PIN_EPSILON_PX);
    if (stuck) {
      pinningContainers.delete(el);
      release();
      return;
    }
    if (frame + 1 >= PIN_MAX_FRAMES) {
      pinningContainers.delete(el);
      release();
      // 尺寸早就有、却始终钉不进去 ⇒ 真出问题了（面板还是 0 宽、内容始终没撑开）。
      // 留一条：这正是「重启后位置回到顶部」那类症状要看的东西。
      // ⚠️ 这里出现才说明容差没兜住 —— 差个零点几 px 的缩放小数不该走到这行。
      logger.warn(
        "viewport",
        `pin ${px} 没立住（${frame + 1} 帧后 scrollTop=${fmtPx(landed)}，差 ${fmtPx(diff)}px）`,
      );
      return;
    }
    logger.trace("viewport", `pin ${px} 被裁（第 ${frame + 1} 帧，scrollTop=${fmtPx(landed)}）`);
    requestAnimationFrame(() => retry(frame + 1));
  };
  retry(0);
}

function restoreViewScroll(panel: Panel): void {
  if (!panel.view || panel.viewTabId === null) return;
  const t = tabs.get(panel.viewTabId);
  if (!t) return;
  // 纯预览实例：这个槽位里记的是**预览**的滚动位置（B129），编辑器此时是
  // display:none，把像素值塞给它只会污染「编辑器顶行」，预览那边反而没人管。
  if (t.viewMode === "preview") return;
  const view = panel.view.view;
  restoringViewport(t.tabId, () => {
    if (t.scrollTop !== null) {
      pinScrollTop(view.scrollDOM, t.scrollTop);
      return;
    }
    // 快照里没有位置（这份实例从没显示过）：退化为「保证光标可见」
    const head = view.state.selection.main.head;
    if (head <= 0) return;
    view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "nearest" }) });
  });
}

/**
 * 把「纯预览实例」的视图位置还给预览容器（B129）。
 *
 * 与 `restoreViewScroll` 是一对、但要**单独调**：纯预览下值记在预览那一侧，
 * 而 `applyPanelMode` 会按编辑器顶行把预览 `syncToLine` 一次，不补这一下，
 * 用户上次翻到的位置就被行定位顶掉了（B130 实测：存 300、回来变成 284）。
 *
 * 必须在 `applyPanelMode` **之后**：预览那一次 `setBlocks` 才把内容撑开，
 * 早一步设浏览器会裁成 0。
 */
function restorePreviewScroll(panel: Panel): void {
  if (panel.viewTabId === null || !panel.preview) return;
  const t = tabs.get(panel.viewTabId);
  if (!t || t.viewMode !== "preview" || t.scrollTop === null) return;
  // 预览那一次 `setBlocks` 刚把内容撑开，同一帧内赋值会被裁成 0（B134），
  // 所以走同一套「钉稳」：写不进去就下一帧再钉。（钉的两发都在「程序滚动」
  // 区间内，不会反过来写脏这份快照 —— B139）
  // 先取局部变量：闭包里 TS 不保留对 `panel.preview` / `t.scrollTop` 的收窄
  const root = panel.preview.root as HTMLElement;
  const px = t.scrollTop;
  restoringViewport(t.tabId, () => {
    pinScrollTop(root, px);
  });
  // 位置已按像素钉死，待重定位行号就是过期的了：留着它，下一次图片/公式增强的
  // 二次定位（`applyPending`）会把预览从我们钉的落点拽回那一行（B146）。
  panel.preview.clearPendingSync();
}

/** 应用面板视图模式：源码 / 分屏 / 纯预览（非 md 标签强制源码）。 */
function applyPanelMode(panel: Panel): void {
  if (!panel.bodyEl) return;
  const tab = tabs.get(panel.activeTabId);
  const mode = tab && isMdTab(tab) ? tab.viewMode : "source";
  // 先取顶行：下面的 class 切换会把编辑器 display:none，scrollTop 随之归零
  const anchorLine = panel.view ? topVisibleLineOf(panel.view.view) : 0;
  panel.bodyEl.classList.remove("mode-source", "mode-split", "mode-preview");
  panel.bodyEl.classList.add("mode-" + mode);
  if (mode !== "source") {
    // 用户主动切模式 → force，大文件也要渲染一次（降级不是禁用）
    renderMarkdownFor(panel, true);
    // 预览从零开始渲染（scrollTop=0），按编辑器当前可见位置对齐，
    // 否则切到预览/切标签时永远停在文档开头。
    if (anchorLine > 1) panel.preview?.syncToLine(anchorLine);
  }
  // ⚠️ 这里**不要**直接 `requestMeasure()`：测量排在下一帧，而 CM6 在测量结束时会
  // 做「滚动锚点补偿」把位置往下推（见 `measureAndKeepScroll`）。测量统一走那里，
  // 顺便在补偿之后把位置收回来。
}

/**
 * 切换标签 / 切换源码↔预览之后让 CM6 重新测量，并把视口位置**收回来**（B146）。
 *
 * ⚠️ CM6 在 measure 结束时会做「滚动锚点补偿」（`@codemirror/view` 内部逻辑）：
 * 它拿视口顶行那块的高度和上次记下的锚点比，差超过 1px 就 `scrollTop += diff`，
 * 目的是编辑时内容别乱跳。而 `setState` 换文档后 heightMap 是拿 `HeightOracle`
 * 按**估算行高**建的，measure 一跑换成**实测行高** —— 软换行、中英文混排下实测
 * 普遍比估算高，`diff` 就恒为正 ⇒ 于是「切一次标签，视口再多挪一点」，切十次
 * 偏出好几屏。源码 / 预览（分屏）都中。
 *
 * ⚠️ 不过这只是**次要**成因（B146 二轮修订）：`setState` 末尾那句
 * `if (hadFocus) this.focus(); this.requestMeasure();` 换完文档会自己再滚一次，
 * 才是「位置不断往下移」的主因。真正的修法在 `switchTab` —— 把 `viewTabId` 提前到
 * `setState` 之前、整个换文档过程罩进还原窗口，让那几下自动滚动进不了记录。
 * 这一手只是把测量顺带挪走的量收回来，别拿它当主修复。
 *
 * 时序上很难躲开：`requestMeasure()` 排的是**下一帧**的 rAF，而 `pinScrollTop`
 * 第一次就「立住」了、不再补钉，中间没人把关 —— 补偿改完位置就永久生效。
 *
 * 所以在这里补一道：测量（同帧、rAF 队列靠后）跑完再确认一次，位置被挪走了就
 * 钉回来。`pinScrollTop` 的逐帧补钉是第二道保险 —— 补偿若拖到更后面的帧，
 * 它的 `stuck` 判定会认出「值不是我们设的那个」并继续补钉。
 */
function measureAndKeepScroll(panel: Panel): void {
  if (!panel.view) return;
  panel.view.view.requestMeasure();
  requestAnimationFrame(() => {
    reassertViewScroll(panel);
  });
}

/** 测量后的滚动锚点补偿把位置挪走了 → 钉回标签自己那份快照（B146）。 */
function reassertViewScroll(panel: Panel): void {
  if (!panel.view || panel.viewTabId === null) return;
  const t = tabs.get(panel.viewTabId);
  if (!t || t.viewMode === "preview") return;
  const px = t.scrollTop;
  if (px === null) return;
  const view = panel.view.view;
  // 没被动过就别碰：钉一次会占用 `pinningContainers` / 抑制区间，白白干扰
  // 随后可能发生的「视图消失前看最后一眼」。
  if (view.scrollDOM.scrollTop === px) return;
  logger.trace(
    "viewport",
    `锚点补偿挪走了位置 tab=${t.tabId} 实际 ${view.scrollDOM.scrollTop} → 钉回 ${px}`,
  );
  restoringViewport(t.tabId, () => {
    pinScrollTop(view.scrollDOM, px);
  });
}

/**
 * 全量重渲染某面板预览（增量 patch 由 PreviewPane 内部处理）。
 *
 * M4：`force = false`（输入防抖触发的自动渲染）时，大文件档位会直接跳过——
 * 每敲一个字就重渲染几十 MB 的 Markdown 会把界面拖死。
 * 用户**显式**切到预览/分屏模式时传 `force = true`，仍然照常渲染：
 * 降级不等于禁用，用户明确要看的时候必须给得出来。
 */
function renderMarkdownFor(panel: Panel, force = false): void {
  const preview = panel.preview;
  const tab = tabs.get(panel.activeTabId);
  if (!preview || !tab || !isMdTab(tab)) return;
  const doc = docOf(tab);
  preview.setBaseDir(doc.path ? dirname(doc.path) : null);

  if (!force && !perfProfileFor(doc.sizeClass).autoPreview) {
    // 「预览怎么不跟着更新」是最常被问的一类问题。这里留一条（info 而非 debug：
    // 触发条件是大文件，不是每次敲键），下次看日志就知道是档位把渲染挡住了。
    logger.info("preview", `auto preview off for ${doc.sizeClass} (${doc.name})`);
    preview.setBlocks([]);
    preview.setNotice(
      doc.sizeClass === "huge"
        ? "文件很大（>20 MB）：已停用自动预览。切到「预览」模式可手动渲染一次。"
        : "文件较大（>2 MB）：已停用自动预览。切到「预览」模式可手动渲染一次。",
    );
    return;
  }
  preview.setNotice(null);

  preview.setBlocks(renderBlocks(tab.state.doc.toString()));
  // 重渲染重建了 block DOM，查找高亮随之丢失——重放当前查询（B30）
  if (findBar?.isOpen()) applyPreviewFindToPanel(panel, findSpecOf(findBar.getQuery()));
}

function scheduleMdRender(panelId: number): void {
  const panel = getPanel(panelId);
  if (!panel) return;
  if (panel.previewTimer !== null) clearTimeout(panel.previewTimer);
  panel.previewTimer = setTimeout(() => {
    panel.previewTimer = null;
    renderMarkdownFor(panel);
    if (panel.panelId === activePanelId && !tocPanel.hidden) updateTocDrawer();
  }, 120) as unknown as number;
}

function dirname(p: string): string {
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return idx > 0 ? p.slice(0, idx) : p;
}

/** 切换 Markdown 源码 / 预览（Ctrl+/、工具栏与菜单共用）。 */
function toggleViewMode(): void {
  const panel = activePanel();
  const tab = activeTab();
  if (!panel || !tab || !isMdTab(tab)) return;
  const toPreview = tab.viewMode !== "preview";
  // 纯预览 → 源码是一次**交接**，不是各认各的：`t.scrollTop` 只有一个槽，装的是
  // 「当前这一侧」的像素（B139）。纯预览期间编辑器被 `display:none` 清零，它那份
  // 位置已经没了，而预览的滚动监听把**预览的像素**写进了同一个槽 —— 直接拿去钉
  // 编辑器，就是「反复切换源码/预览，位置持续偏移」（B148）。
  // 所以先把「预览此刻停在哪一行」换成**编辑器侧**的像素写进这个槽，之后这一侧认的就是它。
  let handoff: number | null = null;
  if (!toPreview && panel.view) {
    // ⚠️ 必须在改 viewMode **之前**问：切换后编辑器是 display:none，问不出顶行
    const line = panel.preview?.topVisibleLine() ?? null;
    const view = panel.view.view;
    if (line !== null) {
      const n = Math.min(Math.max(1, line), view.state.doc.lines);
      handoff = Math.max(0, view.lineBlockAt(view.state.doc.line(n).from).top);
    } else {
      // 预览一份都没渲染出来（大文件降级就是这样）：拿不到顶行，也就**无从**反推
      // 编辑器该停在哪。这时宁可不动编辑器（让它按 CM6 自己的还原来），也别把预览的
      // 像素原样钉过去 —— 后者跳到的位置没有任何依据，比停在开头更像 bug。
      logger.debug("viewport", `切回源码但预览没内容，无从交接位置（${tab.docId}）`);
    }
  }
  if (handoff !== null) recordScroll(tab.tabId, handoff);
  tab.viewMode = toPreview ? "preview" : "source";
  // 切换视图本身不是编辑：隐藏/恢复编辑器可能让 CM6 产生事务，这里一律不置脏
  suppressDirty = true;
  try {
    applyPanelMode(panel);
    // 刚从纯预览回来：编辑器刚从 display:none 出来、被清零了，把交接过来的那份钉回去
    if (handoff !== null) restoreViewScroll(panel);
  } finally {
    suppressDirty = false;
  }
  // 隐藏 / 恢复编辑器会改变尺寸，CM6 随之测量，而它的滚动锚点补偿会把视口往下
  // 推一点 —— 位置得在补偿之后收回来（B146）
  measureAndKeepScroll(panel);
  refreshViewModeButton();
  scheduleSessionSave();
}

/** 状态栏语言/格式项（记事本式，一个元素两用）：
 *  md 文件 → 「M↓ Markdown 语法/预览」可点击切换视图；其他类型 → 仅显示高亮语言名。 */
function refreshViewModeButton(): void {
  const tab = activeTab();
  const md = !!tab && isMdTab(tab);
  sbLang.classList.toggle("sb-btn", md);
  sbLang.classList.toggle("sb-btn-active", md && tab!.viewMode === "preview");
  if (md) {
    const preview = tab!.viewMode === "preview";
    sbLang.innerHTML = `<span class="sb-md-badge">M↓</span> Markdown ${preview ? "预览" : "语法"}`;
    setTip(sbLang, preview ? "切换到源码" : "切换到预览", { key: "Ctrl+/" });
  } else {
    const doc = tab ? docs.get(tab.docId) : undefined;
    sbLang.textContent = doc?.langLabel ?? "Plain Text";
    clearTip(sbLang);
  }
}

/**
 * 把当前主题档位写到 `<html data-theme-mode>`（light / dark / system）。
 *
 * B97 之前这里刷的是顶栏那颗主题按钮的图标（三态循环：sun / moon / color-mode）。
 * 顶栏快捷按钮整排移除后，主题只从「设置」页「外观」分类的下拉进出，
 * 循环按钮与那三颗图标一并退役。留下这个 data 属性是因为档位仍是**跨模块状态**：
 * 换档要联动 CodeMirror 的明暗，样式与回归测试也都靠它读当前档位。
 */
function publishThemeMode(): void {
  document.documentElement.dataset.themeMode = themeMode;
}

/**
 * 把本窗口的身份写到 `<html data-window-kind>`（main / satellite）。
 *
 * 卫星窗口要**比主窗口简洁**：菜单条这类只属于主窗口的部件，由这条属性在 CSS 里收掉。
 *
 * ⚠️ 必须在 `setupShell()` 之前落 —— 卫星窗口冷启动要先问 Rust 拿身份，这段时间里外壳
 *    已经画出来了，晚一步就会看到「菜单条闪一下再消失」。
 * 其余按窗口身份分流的行为（会话读写、关窗收尾、事件监听）读的是 `windowKind` 变量
 * 本身，不靠这个属性 —— 属性只管"长什么样"，语义判断仍然走代码里的那个值。
 */
function publishWindowKind(): void {
  document.documentElement.dataset.windowKind = windowKind;
}

// ---------------------------------------------------------------- 大纲 TOC（M3）

let tocEntries: TocEntry[] = [];

/** 大纲宽度（由设置载入、拖拽后回写设置；160–640px） */
let tocWidth = 240;
let tocResizerHandle: TocResizerHandle | null = null;

/** 挂载大纲宽度分隔条。设置未就绪（settings 为 null）时只生效不持久化。 */
function setupTocResizer(): void {
  tocWidth = clampTocWidth(settings?.toc_width ?? 240);
  tocResizerHandle = attachTocResizer(tocResizer, tocPanel, {
    initial: tocWidth,
    onChange: (w) => {
      tocWidth = w;
      if (!settings) return;
      settings.toc_width = w;
      void saveSettings(settings).catch(() => {
        // 持久化失败不影响本次生效
      });
    },
  });
}

function toggleToc(): void {
  tocPanel.hidden = !tocPanel.hidden;
  tocResizer.hidden = tocPanel.hidden;
  if (!tocPanel.hidden) updateTocDrawer();
}

function updateTocDrawer(): void {
  if (tocPanel.hidden) return;
  const tab = activeTab();
  if (!tab) {
    tocEntries = [];
    renderToc(tocPanel, null, -1, { onJump: () => {} });
    return;
  }
  // 多格式大纲（B33）：md 之外 toml/ini/yaml/json/py 也有大纲；
  // null = 格式不支持 → 空态文案不同
  const doc = docs.get(tab.docId);
  const result = doc ? extractOutline(doc.name, tab.state.doc.toString()) : null;
  if (result === null) {
    tocEntries = [];
    renderToc(tocPanel, null, -1, { onJump: () => {} });
    return;
  }
  tocEntries = result;
  const cursorLine = tab.state.doc.lineAt(tab.state.selection.main.head).number;
  renderToc(tocPanel, tocEntries, cursorLine, {
    onJump: (entry) => {
      const panel = activePanel();
      const tab2 = activeTab();
      if (!panel?.view || !tab2) return;
      const doc = docOf(tab2);
      const line = Math.min(Math.max(1, entry.line), tab2.state.doc.lines);
      const pos = tab2.state.doc.line(line).from;
      // 活动实例：视图定位 + 聚焦（y:"start" 把标题行顶到视口顶部；
      // scrollIntoView:true 是最小滚动，行在视口下方时会贴底）
      panel.view.view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 0 }),
      });
      tab2.state = panel.view.view.state;
      if (tab2.viewMode === "preview") panel.preview?.syncToLine(line);
      // 同文件的其他实例：选区同步写进快照（内容经 ChangeSet 广播保持一致，
      // 位置对全部实例有效）；可见实例同时滚动定位
      for (const inst of instancesOfDoc(doc.tabId)) {
        if (inst.tabId === tab2.tabId) continue;
        const p = panels.get(inst.panelId);
        if (p?.view && p.viewTabId === inst.tabId) {
          p.view.view.dispatch({
            selection: { anchor: pos },
            effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 0 }),
          });
          inst.state = p.view.view.state;
          // 预览态面板编辑器是隐藏的，收不到滚动事件——显式按行定位预览
          if (inst.viewMode === "preview") p.preview?.syncToLine(line);
        } else {
          inst.state = inst.state.update({ selection: { anchor: pos } }).state;
        }
      }
      panel.view.focus();
      updateTocDrawer();
    },
  });
}

// ---------------------------------------------------------------- 导出（M3）

async function exportHtml(): Promise<void> {
  const tab = activeTab();
  if (!tab || !isMdTab(tab)) return;
  const doc = docOf(tab);
  const srcPanel = panelOfTab(tab.tabId);
  if (srcPanel?.view && srcPanel.viewTabId === tab.tabId) {
    tab.state = srcPanel.view.view.state;
  }
  const picked = await saveDialog({
    defaultPath: doc.name.replace(/\.(md|markdown|mdown|mkd)$/i, "") + ".html",
    filters: [{ name: "HTML", extensions: ["html"] }],
  });
  if (!picked) return;
  try {
    const html = buildExportHtml(doc.name, renderFull(tab.state.doc.toString()));
    await exportFile(picked, html);
    showMessage(`已导出 ${picked}`);
    logger.info("export", `html ${doc.name}`);
  } catch (err) {
    showMessage(String(err), true);
  }
}

function exportPdf(): void {
  const tab = activeTab();
  if (!tab || !isMdTab(tab)) return;
  const doc = docOf(tab);
  const bodyHtml = renderFull(tab.state.doc.toString());
  // 打印 DOM 中的相对路径图片重写为 asset 协议地址
  const dir = doc.path ? dirname(doc.path) : null;
  const docEl = new DOMParser().parseFromString(bodyHtml, "text/html");
  if (dir) {
    for (const img of docEl.querySelectorAll("img[src]")) {
      const src = img.getAttribute("src") ?? "";
      if (/^(https?:|data:|#|\/)/i.test(src)) continue;
      const abs = dir.replace(/[\\/]+$/, "") + "\\" + src;
      img.setAttribute("src", convertFileSrc(abs));
    }
  }
  const wrapped = docEl.body.innerHTML;
  printToPdf(doc.name, wrapped);
  logger.info("export", `pdf ${doc.name}`);
}

// ---------------------------------------------------------------- 图片粘贴（M3）

function attachPasteHandler(panel: Panel): void {
  if (!panel.view) return;
  panel.view.view.dom.addEventListener("paste", (e: ClipboardEvent) => {
    const tab = panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
    const doc = tab ? docs.get(tab.docId) : undefined;
    if (!tab || !doc || !isMdTab(tab) || !doc.path) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (!file) continue;
        e.preventDefault();
        void pasteImageToAssets(panel, tab, file);
        return;
      }
    }
  });
}

async function pasteImageToAssets(panel: Panel, tab: Tab, file: File): Promise<void> {
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const ext = (file.type.split("/")[1] ?? "png").toLowerCase();
    const img = await savePasteImage(docOf(tab).tabId, b64, ext);
    const view = panel.view!.view;
    const pos = view.state.selection.main.head;
    view.dispatch({
      changes: { from: pos, insert: `![](${img.rel})` },
      selection: { anchor: pos + img.rel.length + 4 },
    });
    tab.state = view.state;
    showMessage(`图片已保存到 ${img.rel}`);
    logger.info("paste", `image ${img.rel} ${file.size}B`);
  } catch (err) {
    showMessage(String(err), true);
  }
}

// ---------------------------------------------------------------- 主题 / 换行 / 字号

function applyDarkToTabs(dark: boolean): void {
  for (const tab of tabs.values()) {
    const effect = tab.comps.theme.reconfigure(dark ? oneDarkTheme : []);
    const panel = panels.get(tab.panelId);
    if (panel?.view && panel.viewTabId === tab.tabId) {
      panel.view.view.dispatch({ effects: effect });
      tab.state = panel.view.view.state;
    } else {
      tab.state = tab.state.update({ effects: effect }).state;
    }
  }
}

function applyWrapToTabs(wrap: boolean): void {
  isWrap = wrap;
  for (const tab of tabs.values()) {
    const effect = tab.comps.wrap.reconfigure(wrap ? EditorView.lineWrapping : []);
    const panel = panels.get(tab.panelId);
    if (panel?.view && panel.viewTabId === tab.tabId) {
      panel.view.view.dispatch({ effects: effect });
      tab.state = panel.view.view.state;
    } else {
      tab.state = tab.state.update({ effects: effect }).state;
    }
  }
}

function applyFontSize(px: number): void {
  document.documentElement.style.setProperty("--font-size", `${px}px`);
  // 字号变化后 CM6 要重新测量，否则行号/光标定位会短暂错位
  for (const p of panels.values()) p.view?.view.requestMeasure();
}

/** 字号持久化防抖：Ctrl+滚轮/连续按 Ctrl+= 会触发很多次，攒一起写盘。 */
let fontSizeSaveTimer: number | null = null;
function scheduleFontSizeSave(): void {
  if (fontSizeSaveTimer !== null) clearTimeout(fontSizeSaveTimer);
  fontSizeSaveTimer = setTimeout(() => {
    fontSizeSaveTimer = null;
    void persistSettings();
  }, 400);
}

/** 预览行距：写 :root 上的 --md-line-height，.md-preview 通过 var() 生效。 */
function applyPreviewLineHeight(value: number): void {
  const v = Math.min(2.5, Math.max(1, Number(value) || 1.7));
  document.documentElement.style.setProperty("--md-line-height", String(v));
}

/**
 * 编辑器字体：写 :root 上的 --font-editor，.cm-editor 优先取它；
 * 空串（默认）则移除内联变量，回落到内置等宽栈。状态栏 kbd 等仍用 --font-mono。
 */
function applyFontFamily(family: string): void {
  const root = document.documentElement.style;
  const f = family.trim();
  if (!f) {
    root.removeProperty("--font-editor");
  } else {
    // 族名带空格时必须加引号，否则 CSS 解析会当成多个族名
    root.setProperty("--font-editor", f.includes(" ") ? `"${f}"` : f);
  }
  for (const p of panels.values()) p.view?.view.requestMeasure();
}

/** 编辑器行距：写 :root 上的 --editor-line-height，.cm-content 通过 var() 生效。 */
function applyEditorLineHeight(value: number): void {
  const v = Math.min(2.5, Math.max(1, Number(value) || 1.5));
  document.documentElement.style.setProperty("--editor-line-height", String(v));
  for (const p of panels.values()) p.view?.view.requestMeasure();
}

// ---------------------------------------------------------------- 偏好（文件 → 设置）

/**
 * 过滤从磁盘读回的快捷键覆盖表：
 * 丢掉未知命令、无法解析的键位，以及抄了默认值的冗余项。
 * 让配置文件被手改坏时也只影响个别命令，而不是整张键位表。
 */
function sanitizeKeymap(raw: Record<string, string>): KeymapOverrides {
  const out: KeymapOverrides = {};
  for (const [id, spec] of Object.entries(raw)) {
    const cmd = commandById(id);
    if (!cmd || cmd.editable === false) continue;
    if (spec === "") {
      out[id] = "";
      continue;
    }
    if (!parseKey(spec)) continue;
    out[id] = formatBinding(parseKey(spec)!);
  }
  return out;
}

/** 预取行尾/编码候选，供「设置」页同步渲染（IPC 失败则用内置兜底）。 */
async function loadPreferenceOptions(): Promise<void> {
  try {
    const list = await listEols();
    if (list.length > 0) eolOptions = list;
  } catch {
    // 保持内置三档
  }
  try {
    const list = await listEncodings();
    if (list.length > 0) encodingOptions = list;
  } catch {
    // 保持 UTF-8 兜底
  }
}

/** 菜单右侧显示的当前生效键位（可用 `\t` 拼进菜单项）。 */
function keyHint(id: string): string {
  const keys = effectiveKeys(id, keymapOverrides);
  if (keys.length === 0) return "";
  return keys
    .map((k) => formatBinding(parseKey(k) ?? { ctrl: false, alt: false, shift: false, key: k }))
    .join(" / ");
}

/** 标签样式（设置页「外观 → 标签样式」的下拉）：立即生效。 */
function applyTabStyle(style: string): void {
  // 写进 <html data-tab-style>；未知值一律按 "connected" 处理（与 Rust 回落一致）。
  document.documentElement.dataset.tabStyle = style === "pill" ? "pill" : "connected";
}

/** 标签样式切换（设置页）：立即生效 + 持久化。 */
async function setTabStyle(style: string): Promise<void> {
  applyTabStyle(style);
  if (settings) {
    settings.tab_style = style === "pill" ? "pill" : "connected";
    await persistSettings();
  }
  showMessage(style === "pill" ? "标签样式：药丸" : "标签样式：相连");
}

/** 标签操作槽位空位（设置页「外观」开关）：立即生效。 */
function applyTabActionReserve(on: boolean): void {
  document.documentElement.dataset.tabReserve = on ? "on" : "off";
}

/** 标签操作槽位空位切换（设置页）：立即生效 + 持久化。 */
async function setTabActionReserve(on: boolean): Promise<void> {
  applyTabActionReserve(on);
  if (settings) {
    settings.tab_action_reserve_space = on;
    await persistSettings();
  }
  showMessage(on ? "标签按钮：预留空位" : "标签按钮：紧凑");
}

/** 主题档位（设置页「外观」分类的下拉）：立即生效 + 持久化。 */
async function setThemeMode(mode: ThemeMode): Promise<void> {
  themeMode = mode;
  // ⚠️ **必须写回 settings，否则根本存不下来**（B79 用户实测：每次打开都是深色）。
  // 根因：persistSettings() 存的是整个 settings 对象，而启动时读的是 `settings.theme`
  // （main 里 `themeMode = normalizeMode(settings?.theme)`）。其它每一项设置都会在这里写回
  // 自己的字段，唯独主题漏了 —— 于是落盘永远是启动时那个 "system"，深色系统上解析成深色，
  // 表现为「主题设了、重启就丢」。写回之后紧跟的 persistSettings() 才真正把它存下去。
  if (settings) settings.theme = mode;
  const dark = applyTheme(mode);
  if (dark !== isDark) applyDarkToTabs(dark);
  isDark = dark;
  publishThemeMode();
  await persistSettings();
  showMessage(mode === "system" ? "主题：跟随系统" : mode === "dark" ? "主题：深色" : "主题：浅色");
}

/** 新建文件的默认行尾（设置页「新建文件」分类）。 */
async function setDefaultEol(value: string): Promise<void> {
  if (!settings) return;
  settings.default_eol = value;
  await persistSettings();
  showMessage(`新建文件默认行尾：${value}`);
}

/** 新建文件的默认编码（设置页「新建文件」分类）。 */
async function setDefaultEncoding(value: string): Promise<void> {
  if (!settings) return;
  settings.default_encoding = value;
  await persistSettings();
  showMessage(`新建文件默认编码：${value}`);
}

/** 快捷键覆盖表变更（快捷键对话框 → 立即持久化）。 */
async function applyKeymapOverrides(next: KeymapOverrides): Promise<void> {
  keymapOverrides = next;
  if (settings) {
    settings.keymap = { ...next };
    await persistSettings();
  }
}

/**
 * 切换键位预设（快捷键对话框下拉 → 立即生效 + 持久化）。
 *
 * 预设是「基线」，切换时前端已把旧的自定义覆盖清空（见 keymapdialog），
 * 这里跟着落盘，避免重启后覆盖表残留成旧预设的差异项。
 */
async function applyKeymapPreset(id: string): Promise<void> {
  if (!settings) return;
  settings.keymap_preset = normalizePresetId(id);
  await persistSettings();
  showMessage(`键位预设：${getKeymapPreset().label}`);
}

// 快捷键不再单独弹窗：它作为「设置」页里的一个分类（见 src/shell/settingsdialog.ts）。

/**
 * 自动保存开关（绝对值；由设置页「通用」分类的开关切换）。
 *
 * 写的是**原文件**——这正是它与热退出的分野，提示语必须说清，
 * 否则用户以为开了自动保存就不会有未保存状态（B68 把默认值改成了关）。
 */
async function setAutosave(on: boolean): Promise<void> {
  if (!settings || settings.autosave === on) return;
  settings.autosave = on;
  await persistSettings();
  showMessage(on ? "已启用自动保存（修改会直接写入原文件）" : "已停用自动保存");
}

/**
 * 热退出开关（绝对值）。
 *
 * 关掉时要一并丢弃现存副本：留着的话，下次启动仍会拿旧快照还原出「未保存标签」，
 * 那就成了「关了还生效」。同时清空排程，避免关闭瞬间又写出几份新的。
 */
async function setHotExit(on: boolean): Promise<void> {
  if (!settings || settings.hot_exit === on) return;
  settings.hot_exit = on;
  cancelPendingBackup();
  if (!on) discardAllBackups();
  await persistSettings();
  showMessage(on ? "已启用热退出（关窗不再询问，未保存内容下次启动还原）" : "已停用热退出");
}

/** Markdown 预览行距（查看菜单三档）。 */
async function setPreviewLineHeight(value: number): Promise<void> {
  applyPreviewLineHeight(value);
  if (settings) {
    settings.preview_line_height = value;
    await persistSettings();
  }
  showMessage(`预览行距 ${value}`);
}

/** 大纲宽度（查看菜单三档；也可直接拖动大纲右侧分隔条）。 */
async function setTocWidthValue(width: number): Promise<void> {
  tocWidth = clampTocWidth(width);
  tocResizerHandle?.setWidth(tocWidth);
  if (settings) {
    settings.toc_width = tocWidth;
    await persistSettings();
  }
  showMessage(`大纲宽度 ${tocWidth}px`);
}

/** 编辑器字体族（设置页；空串 = 内置默认栈）。 */
async function setFontFamily(family: string): Promise<void> {
  applyFontFamily(family);
  if (settings) {
    settings.font_family = family.trim();
    await persistSettings();
  }
  showMessage(family.trim() ? `编辑器字体 ${family.trim()}` : "编辑器字体：默认");
}

/** 编辑器行距（设置页，1.0–2.5 倍）。 */
async function setEditorLineHeight(value: number): Promise<void> {
  applyEditorLineHeight(value);
  if (settings) {
    settings.editor_line_height = applyClamp(value);
    await persistSettings();
  }
  showMessage(`编辑器行距 ${applyClamp(value)}`);
}

/** 行距落盘值与生效值共用同一夹取范围（1.0–2.5）。 */
function applyClamp(value: number): number {
  return Math.min(2.5, Math.max(1, Number(value) || 1.5));
}

/** 字号绝对值设置（设置页；快捷键缩放走 changeFontSize 增量链路）。 */
async function setFontSizeValue(px: number): Promise<void> {
  const next = Math.min(28, Math.max(10, Math.round(px)));
  if (next === currentFontSize()) return;
  applyFontSize(next);
  if (settings) {
    settings.font_size = next;
    await persistSettings();
  }
  showMessage(`字号 ${next}px`);
}

/** 自动换行开关（绝对值；由「查看」菜单的勾选项切换）。 */
async function setWordWrap(on: boolean): Promise<void> {
  if (isWrap === on) return;
  isWrap = on;
  applyWrapToTabs(on);
  if (settings) {
    settings.word_wrap = on;
    await persistSettings();
  }
}

/** 打开统一设置页（文件 → 设置…）。 */
function openSettingsDialog(): void {
  showSettingsDialog({
    theme: () => themeMode,
    onTheme: (mode) => void setThemeMode(mode),
    fontFamily: () => settings?.font_family ?? "",
    onFontFamily: (family) => void setFontFamily(family),
    fontSize: () => currentFontSize(),
    onFontSize: (px) => void setFontSizeValue(px),
    editorLineHeight: () => settings?.editor_line_height ?? 1.5,
    onEditorLineHeight: (v) => void setEditorLineHeight(v),
    previewLineHeight: () => settings?.preview_line_height ?? 1.7,
    onPreviewLineHeight: (v) => void setPreviewLineHeight(v),
    tocWidth: () => tocWidth,
    onTocWidth: (px) => void setTocWidthValue(px),
    defaultEol: () => settings?.default_eol ?? "CRLF",
    eolOptions: () => eolOptions,
    onDefaultEol: (v) => void setDefaultEol(v),
    defaultEncoding: () => settings?.default_encoding ?? "UTF-8",
    encodingOptions: () => encodingOptions,
    onDefaultEncoding: (v) => void setDefaultEncoding(v),
    // 「通用」分类：自动保存 / 热退出（原「文件」菜单的勾选项，B108 搬进设置页）
    autosave: () => settings?.autosave ?? false,
    onAutosave: (v) => void setAutosave(v),
    hotExit: () => settings?.hot_exit ?? true,
    onHotExit: (v) => void setHotExit(v),
    tabStyle: () => settings?.tab_style ?? "connected",
    onTabStyle: (v) => void setTabStyle(v),
    tabActionReserveSpace: () => settings?.tab_action_reserve_space ?? true,
    onTabActionReserveSpace: (v) => void setTabActionReserve(v),
    keymap: {
      overrides: keymapOverrides,
      onChange: (next) => void applyKeymapOverrides(next),
      preset: getKeymapPreset().id,
      onPresetChange: (id) => void applyKeymapPreset(id),
    },
  });
}

async function persistSettings(): Promise<void> {
  if (!settings) return;
  try {
    await saveSettings(settings);
  } catch {
    // 配置写失败不应影响使用
  }
}

// ---------------------------------------------------------------- 事件绑定

function bindEvents(): void {
  // 自建标题栏（B97）右侧三颗窗口控制键。关闭键走 close() 而不是 destroy()：
  // 前者会先过 onCloseRequested 的「脏文档确认 / 热退出」流程，后者直接销毁窗口。
  winMinimize.addEventListener("click", () => void getCurrentWindow().minimize());
  winMaximize.addEventListener("click", () => void getCurrentWindow().toggleMaximize());
  winClose.addEventListener("click", () => void getCurrentWindow().close());
  // 「钉在顶部」开关（B99）：都是「切换 + 回读」，逻辑见 togglePin。
  winPin.addEventListener("click", () => void togglePin());
  // B152：同步滚动开关。按下就**立刻**推一次 —— 不用等用户再滚一下才看到「跟着动了」。
  // 关闭则什么都不做（各回各的，与 B149 的基线一致）。
  syncScrollBtn.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab) return;
    const on = docSyncModes.get(tab.docId) !== true;
    docSyncModes.set(tab.docId, on);
    logger.debug("sync", `同步滚动 → ${on ? "开" : "关"} docId=${tab.docId}`);
    refreshSyncButton(tab);
    // B159：这两条**一起**发。只发开关，另一窗口的按钮亮着却不动 = 更迷惑；
    //   只发位置，另一窗口压根不知道这份文档开着同步滚动。
    void emit<SyncModePayload>(EVT_SYNC_MODE, { from: windowLabel, docId: tab.docId, on }).catch(
      () => {},
    );
    if (on) pushSyncToSiblings(tab, true);
  });

  sbLang.addEventListener("click", () => {
    if (isMdActive()) toggleViewMode();
  });
  sbEncoding.addEventListener("click", () => void showEncodingMenu());
  sbEol.addEventListener("click", () => showEolMenu());

  // 全局快捷键：统一走 keymap 注册表（设置 → 快捷键 里可浏览 / 改键）。
  // 见 onGlobalKeydown 的注释：必须挂捕获阶段。
  window.addEventListener("keydown", onGlobalKeydown, true);

  // 屏蔽 WebView2 的**默认网页右键菜单**（B104）：编辑器应用里右键弹「刷新 / 检查」
  // 既出戏又危险（刷新会丢掉整个会话外观）。暂不做自定义右键菜单 —— 有需求再立项；
  // ⚠️ 挂 document 冒泡阶段即可：标签条的自定义右键菜单在目标元素上就 preventDefault +
  //    stopPropagation 了，根本到不了这里；就算到了，重复 preventDefault 也无害。
  document.addEventListener("contextmenu", (e) => e.preventDefault());
}

/**
 * 全局快捷键分发（注册在 window 捕获阶段）。
 *
 * 为什么要捕获阶段：CodeMirror 的 keymap 处理器挂在编辑器 DOM 上，等到冒泡到 window
 * 已经晚了——CM 的 defaultKeymap 里有 `Mod-/`（切换注释）与 `Shift-Alt-ArrowDown`
 * （向下复制行），会分别抢走「切换源码/预览」和「上下分屏」，并顺手改坏文档。
 * 捕获阶段命中后 `stopPropagation`，编辑器就完全收不到这个事件。
 */
function onGlobalKeydown(e: KeyboardEvent): void {
  // 设置对话框打开时整体让路：模态层上的按键不该再去触发「新建 / 保存」。
  if (document.querySelector(".settings-overlay")) return;
  if (document.body.classList.contains(KEYMAP_RECORDING_CLASS)) return;
  // 命令面板打开时同理：面板的输入框要吃下 ↑↓/Enter/Esc，
  // 且 win 捕获阶段先于 document，这里不让路面板就收不到方向键。
  if (paletteOpen()) return;

  const id = resolveCommand(e, keymapOverrides);
  if (id && shortcutApplies(id)) {
    const def = commandById(id);
    // 编辑器内部已消化的组合键不再重复处理（F5 除外——必须拦住 WebView2 刷新）
    if (e.defaultPrevented && !def?.force) return;
    e.preventDefault();
    e.stopPropagation();
    runShortcut(id);
    return;
  }

  // Alt 菜单助记符：与菜单名绑定，属于只读项，这里单独兜底
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    const idx = ALT_MENU_INDEX[e.code];
    if (idx !== undefined) {
      e.preventDefault();
      openMenuByIndex(idx);
    }
  }
}

/**
 * 少数命令只在特定上下文成立；不成立时**不抢键**，把事件还给编辑器。
 * 典型是 Ctrl+/：CodeMirror 用它切换注释（JSON/JS 等格式很有用），
 * 只有 Markdown 才把它当「源码 / 预览切换」。
 */
function shortcutApplies(id: string): boolean {
  switch (id) {
    case "view.toggle":
      return isMdActive();
    case "panel.splitH":
    case "panel.splitV":
    case "panel.close":
      return !!activePanel();
    case "panel.moveTabNext":
    case "panel.moveTabPrev":
    case "panel.focusNext":
    case "panel.focusPrev":
    case "panel.toggleMaximize":
      // 只有一个面板时这些命令无事可做 —— 不抢键，把事件还给编辑器
      return countLeaves(layout) > 1;
    default:
      return true;
  }
}

/** Alt 助记符 → 菜单索引（Alt+S = 设置菜单）。 */
const ALT_MENU_INDEX: Record<string, number> = {
  KeyF: 0,
  KeyE: 1,
  KeyV: 2,
  KeyH: 3,
};

/** 快捷键命令 → 动作。id 与 keymap.ts 的 COMMANDS 一一对应。 */
function runShortcut(id: string): void {
  switch (id) {
    case "file.new":
      void newUntitled();
      break;
    case "file.open":
      void doOpen();
      break;
    case "file.save":
      void doSave(false);
      break;
    case "file.saveAs":
      void doSave(true);
      break;
    case "file.saveAll":
      void doSaveAll();
      break;
    case "file.close": {
      const tab = activeTab();
      if (tab) void closeTabById(tab.tabId);
      break;
    }
    case "tab.next":
      cycleTabInPanel(1);
      break;
    case "tab.prev":
      cycleTabInPanel(-1);
      break;
    case "edit.find":
      openFindReplace();
      break;
    case "edit.replace":
      openFindBar("replace");
      break;
    case "edit.findNext":
      findStep(1);
      break;
    case "edit.findPrev":
      findStep(-1);
      break;
    case "edit.goto":
      openGotoLine();
      break;
    case "edit.timeDate":
      insertTimeDate();
      break;
    case "view.toggle":
      toggleViewMode();
      break;
    case "view.outline":
      toggleToc();
      break;
    case "view.foldCode":
      foldCodeOperation(true);
      break;
    case "view.unfoldCode":
      foldCodeOperation(false);
      break;
    case "view.foldAll":
      foldOperation(true);
      break;
    case "view.unfoldAll":
      foldOperation(false);
      break;
    case "view.zoomIn":
      void changeFontSize(1);
      break;
    case "view.zoomOut":
      void changeFontSize(-1);
      break;
    case "view.zoomReset":
      void changeFontSize(null);
      break;
    case "panel.splitH":
      if (activePanel()) void splitActivePanel(activePanelId, "h");
      break;
    case "panel.splitV":
      if (activePanel()) void splitActivePanel(activePanelId, "v");
      break;
    case "panel.close":
      if (activePanel()) closePanelById(activePanelId);
      break;
    case "panel.moveTabNext":
      moveActiveTabByDelta(1);
      break;
    case "panel.moveTabPrev":
      moveActiveTabByDelta(-1);
      break;
    case "panel.focusNext":
      focusPanelByDelta(1);
      break;
    case "panel.focusPrev":
      focusPanelByDelta(-1);
      break;
    case "panel.toggleMaximize":
      toggleMaximizePanel();
      break;
    case "palette.open":
      openCommandPalette();
      break;
    default:
      break;
  }
}

/**
 * 命令面板（M4，Ctrl+Shift+P）。
 *
 * 数据源直接取 keymap 的命令注册表，选中的 id 走同一条 runShortcut，
 * 因此面板与菜单/快捷键永远执行同一份动作，不会出现「面板能跑、快捷键不行」。
 */
function openCommandPalette(): void {
  showCommandPalette({
    overrides: keymapOverrides,
    onRun: (id) => runShortcut(id),
    // 关闭后把焦点还给编辑器：否则光标还在文档里，却敲不动字
    onClose: () => activePanel()?.view?.focus(),
  });
}

// 导出（HTML / PDF）原先挂在顶栏那颗导出按钮上，锚点是按钮本身。B97 移走顶栏后
// 改成「文件 → 导出 ▸」的子菜单，锚点由菜单系统自己管，这里不再需要 showExportMenu。

/** 打开悬浮查找栏（Ctrl+F / 工具栏「查找」）。 */
function openFindReplace(): void {
  openFindBar();
}

// ---------------------------------------------------------------- 编辑菜单操作

/**
 * 在活动面板“当前显示的实例”上执行编辑操作，然后写回快照并聚焦。
 * 注意必须用 panel.viewTabId（视图实际显示的实例），不能用 activeTabId
 * ——同文件多实例时二者可能不同（viewTabId 不变量，见 switchTab）。
 */
function withView(fn: (view: EditorView) => void): void {
  const panel = activePanel();
  const view = panel?.view?.view;
  if (!panel || !view) return;
  const tab = panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
  if (!tab) return;
  fn(view);
  tab.state = view.state;
  view.focus();
}

/** 查找下一个/上一个（F3 / 菜单）：查找栏未开则先打开（参考记事本 F3 行为）。 */
function findStep(dir: 1 | -1): void {
  const bar = ensureFindBar();
  if (!bar.isOpen()) openFindBar();
  else retargetFindBar();
  bar.step(dir);
}

/** 时间/日期（F5，参考记事本）：在光标处插入 「HH:MM YYYY/M/D」。 */
function insertTimeDate(): void {
  withView((view) => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const text = `${pad(d.getHours())}:${pad(d.getMinutes())} ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
    });
  });
}

/** 剪切/复制：聚焦编辑器内容区后走浏览器原生命令（WebView2 支持且写入系统剪贴板）。 */ function clipboardOp(
  op: "cut" | "copy",
): void {
  const view = activePanel()?.view?.view;
  if (!view) return;
  view.focus();
  if (!view.state.selection.main.empty) document.execCommand(op);
}

/** 粘贴：读系统剪贴板文本，替换当前选区。 */
async function pasteClipboard(): Promise<void> {
  const panel = activePanel();
  const view = panel?.view?.view;
  if (!panel || !view) return;
  const tab = panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
  if (!tab) return;
  try {
    const text = await navigator.clipboard.readText();
    if (!view.dom.isConnected) return; // 异步间隙面板可能已关闭
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
    });
    tab.state = view.state;
    view.focus();
  } catch {
    showMessage("读取剪贴板失败", true);
  }
}

/** 删除选区（Del）。 */
function deleteSelection(): void {
  withView((view) => {
    const sel = view.state.selection.main;
    if (sel.empty) return;
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: "" } });
  });
}

// ---------------------------------------------------------------- 折叠全部 / 展开全部

/**
 * 对活动实例与同文件的其他可见实例执行折叠/展开全部。
 * 折叠状态存在 EditorState 里但不随同源广播——这里对可见实例显式同步；
 * 离屏实例无法运行命令（@codemirror/language 未导出折叠状态字段），保持各自状态。
 */
function foldOperation(all: boolean): void {
  const panel = activePanel();
  const view = panel?.view?.view;
  if (!panel || !view) return;
  const tab = panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
  if (!tab) return;
  const run = (v: EditorView) => {
    if (all) foldAll(v);
    else unfoldAll(v);
  };
  run(view);
  tab.state = view.state;
  for (const inst of instancesOfDoc(docOf(tab).tabId)) {
    if (inst.tabId === tab.tabId) continue;
    const p = panels.get(inst.panelId);
    if (p?.view && p.viewTabId === inst.tabId) {
      run(p.view.view);
      inst.state = p.view.view.state;
    }
  }
  view.focus();
}

/**
 * 折叠 / 展开光标所在的块（CM foldCode/unfoldCode）。
 * 与 foldOperation 同源：只作用于活动实例，折叠状态不随同源广播。
 */
function foldCodeOperation(fold: boolean): void {
  const panel = activePanel();
  const view = panel?.view?.view;
  if (!panel || !view) return;
  const tab = panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
  if (!tab) return;
  if (fold) foldCode(view);
  else unfoldCode(view);
  tab.state = view.state;
  view.focus();
}

// ---------------------------------------------------------------- 转到行

/** 轻量「转到行」浮层：输入行号回车定位（Esc 取消）。 */
function openGotoLine(): void {
  const panel = activePanel();
  const view = panel?.view?.view;
  if (!panel || !view) return;
  if (document.querySelector(".goto-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "goto-overlay";
  const box = document.createElement("div");
  box.className = "goto-box";
  const label = document.createElement("span");
  label.className = "goto-label";
  label.textContent = "转到行：";
  const input = document.createElement("input");
  input.className = "goto-input";
  input.type = "text";
  input.inputMode = "numeric";
  input.spellcheck = false;
  box.append(label, input);
  overlay.appendChild(box);

  const close = () => overlay.remove();
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      view.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const line = Number.parseInt(input.value, 10);
      close();
      if (Number.isFinite(line) && line >= 1) {
        const target = Math.min(line, view.state.doc.lines);
        const pos = view.state.doc.line(target).from;
        // 顶部对齐（与大纲跳转一致；scrollIntoView:true 最小滚动会贴底）
        view.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 0 }),
        });
        const t = tabStateWriteBack(view);
        // 活动面板是预览态时编辑器隐藏、收不到滚动事件，显式定位预览
        if (t?.viewMode === "preview") panel.preview?.syncToLine(target);
        view.focus();
      }
    }
  });
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) {
      close();
      view.focus();
    }
  });
  document.body.appendChild(overlay);
  input.focus();
}

/** 把视图当前状态写回其显示的实例（viewTabId 不变量），返回该实例。 */
function tabStateWriteBack(view: EditorView): Tab | null {
  const panel = activePanel();
  const tab = panel && panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
  if (tab && panel?.view?.view === view) tab.state = view.state;
  return tab ?? null;
}

// ---------------------------------------------------------------- 查看：缩放 / 换行 / 状态栏

function currentFontSize(): number {
  return settings?.font_size ?? 14;
}

async function changeFontSize(delta: number | null): Promise<void> {
  // delta=null 表示重置
  const next = delta === null ? 14 : Math.min(28, Math.max(10, currentFontSize() + delta));
  if (next === currentFontSize()) return;
  applyFontSize(next);
  if (settings) {
    settings.font_size = next;
    scheduleFontSizeSave();
  }
  showMessage(`字号 ${next}px`);
}

async function toggleWrapSetting(): Promise<void> {
  await setWordWrap(!isWrap);
}

let statusbarVisible = true;

function toggleStatusbar(): void {
  statusbarVisible = !statusbarVisible;
  document.querySelector(".statusbar")?.classList.toggle("statusbar-hidden", !statusbarVisible);
}

/**
 * 自建标题栏（B97）的图标与状态；B99 起左侧还多一颗软件图标、右侧多一个置顶开关。
 *
 * 窗口控制三颗键一律取 codicon（见 docs/conventions.md「图标」节）。最大化键是**双态**的：
 * 普通态画 chrome-maximize（空心方框），已最大化时换 chrome-restore（叠两层），与原生
 * 标题栏、VS Code 的观感一致。
 *
 * 拖动与双击最大化不在这里接线 —— header 上那个 `data-tauri-drag-region="deep"` 由
 * Tauri 内置的 drag.js 接管（见 src-tauri/capabilities/default.json 的说明）。
 */

/** 右上角更新键句柄（setupTitleBar 初始化；帮助菜单「检查更新…」经它手动检查）。 */
let updaterHandle: UpdaterHandle | null = null;

function setupTitleBar(): void {
  // 左上角软件图标：纯标识，位图来自打包进 dist 的应用图标源（见文件头的 import 说明）。
  appMark.style.backgroundImage = `url("${appMarkUrl}")`;
  const icons: [HTMLButtonElement, CodiconName][] = [
    [winMinimize, "chromeMinimize"],
    [winMaximize, "chromeMaximize"],
    [winClose, "chromeClose"],
  ];
  for (const [btn, name] of icons) btn.innerHTML = CODICONS[name];
  // 置顶键的字形随置顶态在 pinned / pin 之间切换（见 refreshPinButton）。
  // 这里先给「未置顶」那颗兜底，免得回读失败时按钮是个空块。
  winPin.innerHTML = CODICONS.pin;
  // B152 / B154 / B166：同步滚动键是双字形开关 —— 开 = link（连着）、关 = unlink
  // （官方 link 字形 + CSS 抹掉中间连接杆，见 global.css 的 .codicon-unlink）。
  // 启动先给「未开启」那颗兜底；refreshSyncButton 每次显形都会按状态重设。
  syncScrollBtn.innerHTML = CODICONS.unlink;
  // 窗口的最大化态可能在别处变化（双击拖动区、Win+↑、右键系统菜单），统一靠 resize 回读。
  void getCurrentWindow()
    .onResized(() => void refreshMaximizeButton())
    .catch(() => {});
  void refreshMaximizeButton();
  void refreshPinButton();
  // B107：右上角更新键（无更新时不可见；静默检查失败不打扰，见 src/shell/updater.ts）。
  // 安装会杀进程，persist 走热退出同款 persistSession，重启后靠会话恢复回到原样。
  const titleActions = document.querySelector(".title-actions");
  if (titleActions) {
    updaterHandle = initUpdater({
      host: titleActions as HTMLElement,
      showMessage,
      persist: () => persistSession(),
      initialDelayMs: 8000,
      intervalMs: 6 * 60 * 60 * 1000,
    });
  }
  // 状态栏的语言/格式项按活动标签刷新（原先顺带在这条启动链上初始化）
  refreshViewModeButton();
}

/**
 * 置顶开关的点击处理：set → **回读** → 按回读值刷新按钮。
 *
 * ⚠️ 必须回读（`isAlwaysOnTop`）而不是把目标值直接当成新状态：ACL 拒了、窗口刚销毁、
 * 系统侧没接受，这几种情况下 `setAlwaysOnTop` 都可能「没生效但不报错」，自己记一份
 * 乐观状态就会和界面长期不一致。回读拿到的是**窗口真实的置顶态**，与最大化键靠
 * `isMaximized()` 回读是同一个道理。
 */
async function togglePin(): Promise<void> {
  const win = getCurrentWindow();
  try {
    await win.setAlwaysOnTop(!(await win.isAlwaysOnTop()));
  } catch {
    // 窗口已销毁 / IPC 不可用：下面照旧回读一次，读不到就保持原样
  }
  await refreshPinButton();
}

/** 置顶开关的双态呈现（点亮 = 当前已置顶）。 */
async function refreshPinButton(): Promise<void> {
  // 初值不必给：读失败就直接 return，赋值只可能发生在 try 里。
  let pinned: boolean;
  try {
    pinned = await getCurrentWindow().isAlwaysOnTop();
  } catch {
    return;
  }
  // 字形直接反映**当前状态**：已置顶 = pinned（斜图钉），未置顶 = pin（空心图钉）。
  // B166：未置顶那颗从 unpin（斜杠）换成 pin —— 用户点名「pinned 和 pin 图标切换」；
  //   同时不再靠 `.is-on` 配色（那套强调色已从 CSS 删掉），状态全落在字形上。
  winPin.innerHTML = pinned ? CODICONS.pinned : CODICONS.pin;
  winPin.classList.toggle("is-on", pinned);
  // 开关型控件的状态要用 aria-pressed 报给读屏器，光靠配色等于没报。
  winPin.setAttribute("aria-pressed", pinned ? "true" : "false");
  // B157：改名叫「始终在最前」（旧称「钉在顶部」，措辞与窗口置顶的实际语义更贴）。
  // 开与关两句都要改，tooltip / aria-label / 读屏器读的是同一个 label。
  const label = pinned ? "取消始终在最前" : "始终在最前";
  winPin.setAttribute("aria-label", label);
  setTip(winPin, label);
}

/** 最大化键的双态图标与提示（已最大化时是「向下还原」）。 */
async function refreshMaximizeButton(): Promise<void> {
  // 初值不必给：拿到之前就 return 了，赋值只可能发生在 try 里。
  let maximized: boolean;
  try {
    maximized = await getCurrentWindow().isMaximized();
  } catch {
    // 窗口已销毁 / IPC 不可用：保持现有图标，不打断其它流程
    return;
  }
  winMaximize.innerHTML = maximized ? CODICONS.chromeRestore : CODICONS.chromeMaximize;
  winMaximize.setAttribute("aria-label", maximized ? "向下还原" : "最大化");
  setTip(winMaximize, maximized ? "向下还原" : "最大化");
}

/**
 * 菜单栏初始化（文件 / 编辑 / 查看 / 设置 / 帮助，结构参考 Win11 记事本）。
 *
 * ⚠️ 卫星窗口**不建**菜单栏（用户要求子窗口比主窗口简洁）：那五个顶层里没有一项是
 *    「卫星窗口用不上」，全都是好选项 —— 但子窗口的入口是标签右键与命令面板，
 *    摆一排菜单既不简洁，又会让人以为关不掉。
 *    不画由**两道**兜住：`setupShell` 两个窗口共用，所以这里在入口 early return；
 *    外加 CSS 的 `html[data-window-kind="satellite"] .menu-bar`（见 global.css）。
 */
function setupMenuBar(): void {
  // 卫星窗口装配外壳时也会走到这儿（见 initSatelliteWindow → setupShell），入口先挡掉，
  // 免得菜单按钮、快捷键与那批主窗口专属回调一起被挂上去。
  if (windowKind !== "main") return;
  createMenuBar(menuBar, {
    onNew: () => void newUntitled(),
    onOpen: () => void doOpen(),
    onSave: () => void doSave(false),
    onSaveAs: () => void doSave(true),
    onSaveAll: () => void doSaveAll(),
    // 导出原先只有顶栏那颗按钮一个入口（B97 移走后补进「文件 → 导出 ▸」）。
    // 菜单每次展开都重新求值，所以「当前文档能不能导出」取的是**展开那一刻**的状态。
    onExportHtml: () => void exportHtml(),
    onExportPdf: () => exportPdf(),
    exportable: () => isMdActive(),
    onCloseTab: () => {
      const tab = activeTab();
      if (tab) void closeTabById(tab.tabId);
    },
    onExit: () => void getCurrentWindow().close(),
    onUndo: () => withView((v) => undo(v)),
    onRedo: () => withView((v) => redo(v)),
    onCut: () => clipboardOp("cut"),
    onCopy: () => clipboardOp("copy"),
    onPaste: () => void pasteClipboard(),
    onDelete: () => deleteSelection(),
    onFind: () => openFindReplace(),
    onFindNext: () => findStep(1),
    onFindPrev: () => findStep(-1),
    onReplace: () => openFindBar("replace"),
    onGoto: () => openGotoLine(),
    onSelectAll: () => withView((v) => selectAll(v)),
    onTimeDate: () => insertTimeDate(),
    onToggleView: () => toggleViewMode(),
    onOutline: () => toggleToc(),
    tocChecked: () => !tocPanel.hidden,
    onFoldAll: () => foldOperation(true),
    onUnfoldAll: () => foldOperation(false),
    onZoomIn: () => void changeFontSize(1),
    onZoomOut: () => void changeFontSize(-1),
    onZoomReset: () => void changeFontSize(null),
    onToggleWrap: () => void toggleWrapSetting(),
    wrapChecked: () => isWrap,
    onToggleStatusbar: () => toggleStatusbar(),
    statusbarChecked: () => statusbarVisible,
    // ---- 设置（B106：统一设置页，含原首选项与快捷键分类） ----
    onSettings: () => openSettingsDialog(),
    // ---- 帮助 ----
    // B107：手动检查更新（结果走状态栏；静默检查失败不打扰，见 src/shell/updater.ts）
    onCheckUpdate: () => void updaterHandle?.checkNow(),
    onAbout: () => {
      void showAbout();
    },
    keyHint,
  });
}

/** 在活动面板内循环切换标签（dir=1 向右 / -1 向左）。 */
function cycleTabInPanel(dir: 1 | -1): void {
  const panel = activePanel();
  if (!panel || panel.tabs.length < 2) return;
  const idx = panel.tabs.indexOf(panel.activeTabId);
  const next = panel.tabs[(idx + dir + panel.tabs.length) % panel.tabs.length];
  switchTab(panel.panelId, next);
}

// ---------------------------------------------------------------- 启动

/** 把致命启动错误渲染到屏幕可见的覆盖层（同时回传 Rust 日志），避免静默白屏。 */
function showFatalError(err: unknown): void {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  console.error("[LitePad] 启动错误：", err);
  try {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__?: { invoke(cmd: string, args?: unknown): Promise<unknown> };
      }
    ).__TAURI_INTERNALS__;
    internals?.invoke("frontend_ready", { detail: "fatal: " + msg }).catch(() => {});
  } catch {
    /* ignore */
  }
  try {
    let box = document.getElementById("boot-error-overlay");
    if (!box) {
      box = document.createElement("div");
      box.id = "boot-error-overlay";
      box.style.cssText =
        "position:fixed;left:0;top:0;right:0;z-index:2147483647;max-height:60vh;overflow:auto;" +
        "padding:12px 16px;background:#1a0000;color:#ffb3b3;border-bottom:2px solid #ff4d4d;" +
        "font:13px/1.5 Consolas,Menlo,monospace;white-space:pre-wrap;";
      document.body.appendChild(box);
    }
    box.textContent += "⚠ LitePad 启动出错：\n" + msg + "\n\n";
  } catch {
    /* ignore */
  }
}

/**
 * 始终注册窗口关闭：脏文档确认 + 立即持久化会话。
 * 放在最前，保证即使后续渲染失败窗口也能关闭。
 *
 * B68 起多了一条快路径：**热退出开着且副本全部写成功**时不再弹确认框。
 * 这不是「跳过确认」，而是「确认的前提已经不存在了」——内容已经落到备份区，
 * 下次启动会原样还原成未保存标签，没有东西会丢。
 */
// ---------------------------------------------------------------- 多窗口（B71 ④）
//
// 一个 LitePad 进程可以开多个窗口：`main` 是主窗口（会话、设置、自动保存的持有者），
// `sat-<n>` 是**卫星窗口**（承载用户拎出去的几个标签）。
//
// 设计要点（都是踩过或差点踩到的点）：
//   · 文档 id 是**进程级**的，两个窗口共用同一批 id，卫星窗口不重新分配 —— 于是
//     `save_file` / `write_backup` 这些按 id 寻址的命令天然通用。
//   · 正文**随载荷一起传**：未保存的修改、未命名的文档都只存在于源窗口的内存里，
//     让新窗口自己去读盘会拿到旧内容。
//   · 源窗口必须等新窗口**确认拿到载荷**才敢把标签摘掉 —— 建窗失败（内存不足等）
//     时若已经摘了，用户看到的就是「标签没了，新窗口也没出来」。
//   · 会话始终由**主窗口**持有：卫星窗口不读也不写 session.json，否则两个窗口会
//     互相覆盖（见 scheduleSessionSave 的闸门）。

/** 本窗口的身份。启动时问一次 Rust，之后不再变。 */
let windowKind: "main" | "satellite" = "main";
/** 本窗口 label（"main" / "sat-1"…）：定向投递事件要用。 */
let windowLabel = "main";

/** 主窗口 label。与 Rust `windows::MAIN_LABEL`、capabilities 的 `main` 三处必须一致。 */
const MAIN_WINDOW_LABEL = "main";

/** 等新窗口「已就绪」的上限。超时按没开起来处理（源窗口保留标签，只提示一句）。 */
const SATELLITE_READY_TIMEOUT_MS = 6000;

/**
 * 已搬到别的窗口的文档：docId → { 本地隐藏实例的 tabId, 承载它的窗口 label }。
 *
 * 隐藏实例（panelId = -1）继续留在 `tabs` 里，但不属于任何面板 —— 它承担两件事：
 * 会话快照能带上这些标签（见 snapshotSession 的 satelliteTabs）、卫星窗口异常消失时
 * 还能把标签恢复成可见的。
 */
const remotedTabs = new Map<number, { tabId: number; owner: string }>();

/**
 * B161：**曾经借出去过**的文档 id（只在 `remoteTabLocally` 里加，从不删）。
 *
 * 与 `remotedTabs` 的区别：那份隐藏实例被「在本窗口重新打开同一文件」回收后就从
 * `remotedTabs` 里消失了，可**别的窗口手上那份还在** —— 只认 `remotedTabs` 会在这种
 * 情况下误判成「没人拿着」，主窗口关标签时又把别人那份一起关掉。
 * 判据宁粗勿细：多问一圈只是多 150ms，漏问就是别人的文档变成空壳。
 */
const loanedDocIds = new Set<number>();

/** 把某实例摊平成可跨窗口传输的快照（正文取实例状态，不需要回写磁盘）。 */
function transferSnapshotOf(tabId: number): SatelliteTab | null {
  const tab = tabs.get(tabId);
  if (!tab) return null;
  const doc = docs.get(tab.docId);
  if (!doc) return null;
  const text = tab.state.doc.toString();
  const pos = Math.min(tab.state.selection.main.head, text.length);
  const line = tab.state.doc.lineAt(pos);
  return {
    docId: doc.tabId,
    path: doc.path,
    name: doc.name,
    text,
    encoding: doc.encoding,
    eol: doc.eol,
    readonly: doc.readonly,
    dirty: doc.dirty,
    viewMode: isMdTab(tab) ? tab.viewMode : "source",
    cursorLine: line.number,
    cursorCol: pos - line.from + 1,
    // B126：视口位置一起带走，接手的窗口才是「接着看」而不是「从头看」
    scrollTop: viewportOfTab(tab),
    sizeClass: doc.sizeClass,
    backupId: doc.backupId,
    backedUp: doc.backedUp,
  };
}

/**
 * 标签被搬到别的窗口后，本地要留一个**隐藏实例**（panelId = -1）。
 *
 * 为什么不留着不管、直接删掉：会话与热退出都靠「本地还认得这个文档」才能把它的
 * 内容写进 session.json。卫星窗口自己不写会话（见 scheduleSessionSave 闸门），
 * 如果这里删干净，用户把一份未保存文档拖到新窗口、然后用任务管理器结束进程，
 * 那份文档就再也没人记得 —— 副本会变成孤儿被清理掉。
 *
 * 隐藏实例不进任何面板（标签条上看不到），只用于：
 *   · snapshotSession 把它写进会话的 `satelliteTabs` 段
 *   · 卫星窗口异常消失（崩溃/被杀）时把它**恢复成可见标签**当作兜底
 */
function remoteTabLocally(tabId: number, owner: string): void {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const panel = panels.get(tab.panelId);
  if (panel) {
    const idx = panel.tabs.indexOf(tabId);
    if (idx >= 0) panel.tabs.splice(idx, 1);
    if (panel.activeTabId === tabId)
      panel.activeTabId = panel.tabs[idx] ?? panel.tabs[idx - 1] ?? -1;
    if (panel.viewTabId === tabId) panel.viewTabId = null;
  }
  tab.panelId = -1;
  remotedTabs.set(tab.docId, { tabId, owner });
  // B161：记一笔「这份文档借出去过」—— 隐藏实例被回收后仍要当作「可能在别人手上」
  loanedDocIds.add(tab.docId);
}

/** 把隐藏实例恢复成可见标签（卫星窗口消失、或用户点「移回主窗口」时用）。 */
function reclaimRemoted(tabId: number, panelId = activePanelId): void {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const panel = panels.get(panelId) ?? panels.get([...panels.keys()][0]);
  if (!panel) return;
  remotedTabs.delete(tab.docId);
  tab.panelId = panel.panelId;
  panel.tabs.push(tabId);
  panel.activeTabId = tabId;
}

/**
 * 把指定标签搬到新窗口。
 *
 * 顺序是刻意的：先挂「就绪 / 失败」监听 → 建窗 → 等到应答 → 才摘本地标签。
 * 反向（先摘再建）在建窗失败时会让标签凭空消失，用户没有任何补救手段。
 */
async function openTabsInNewWindow(tabIds: number[], spot?: WindowSpot | null): Promise<void> {
  const snapshots = tabIds
    .map((id) => transferSnapshotOf(id))
    .filter((s): s is SatelliteTab => s !== null);
  if (snapshots.length === 0) return;

  const title = snapshots.length === 1 ? snapshots[0].name : `LitePad — ${snapshots.length} 个标签`;
  const payload: SatellitePayload = { tabs: snapshots };

  // 新窗口冷启可能比一次 IPC 往返还快 → 监听必须先挂上，且不能假设「label 已拿到」
  const readyLabels = new Set<string>();
  // label → 失败原因。B72 起必须**带出原因**：原先两种情况（建窗失败 / 就绪超时）都
  // 只报一句「没能打开」，把 WebView2 拒绝创建这种可诊断的错误信息一起吞掉了。
  const failedLabels = new Map<string, string>();
  let notify: ((label: string) => void) | null = null;
  const onReady = await listen<{ label: string }>("satellite-ready", (e) => {
    const l = e.payload?.label;
    if (!l) return;
    readyLabels.add(l);
    notify?.(l);
  });
  const onFailed = await listen<{ label: string; message?: string }>("satellite-failed", (e) => {
    const l = e.payload?.label;
    if (!l) return;
    failedLabels.set(l, e.payload?.message ?? "");
    notify?.(l);
  });

  let label: string;
  try {
    label = await openSatelliteWindow(title, payload, spot);
    const ok = await new Promise<boolean>((resolve) => {
      if (readyLabels.has(label)) return resolve(true);
      if (failedLabels.has(label)) return resolve(false);
      const timer = setTimeout(() => resolve(false), SATELLITE_READY_TIMEOUT_MS);
      notify = (l) => {
        if (l !== label) return;
        clearTimeout(timer);
        resolve(readyLabels.has(label));
      };
    });
    if (!ok) {
      const why = failedLabels.get(label);
      const detail = why ? `：${why}` : "：等待新窗口就绪超时";
      logger.error("window", `satellite ${label} failed${detail}`);
      showMessage(`新窗口没能打开${detail}，标签保留在原窗口`, true);
      return;
    }
  } catch (err) {
    showMessage(`新窗口打开失败：${err}`, true);
    return;
  } finally {
    notify = null;
    onReady();
    onFailed();
  }

  // 面板结构变了（标签被摘走）→ 最大化态必须先还原，否则会留下「0 宽但还在树里」
  // 的面板（同 splitPanelWithTab / closePanelById 的处理）
  exitMaximize();
  for (const id of tabIds) remoteTabLocally(id, label);
  // B90：最后一个标签被送到新窗口后原面板会空 —— 摘掉，别留一个空框
  pruneEmptyPanels();
  rebuildLayout();
  refreshAll();
  scheduleSessionSave();
}

/**
 * 接管一批从别的窗口交过来的标签（主窗口的 `docs-return`、或卫星窗口启动时自带的载荷）。
 *
 * 文档已在本窗口存在时**只加实例**：同一文档在两个窗口各有一份实例是允许的，
 * 但 `docs` 镜像必须只有一份（同源多实例的唯一真相）。
 */
function adoptTransferredTabs(incoming: SatelliteTab[], panelId = activePanelId): number[] {
  const panel = panels.get(panelId) ?? panels.get([...panels.keys()][0]);
  if (!panel) return [];
  const adopted: number[] = [];
  for (const st of incoming) {
    // B164：卫星窗口收下的每份文档，主窗口手上都还攥着隐藏实例（B157 起「谁关的谁
    // 负责」，那份不会被回收）—— 记进 `sharedDocIds`，同步滚动键的显隐判据才认它。
    // ⚠️ 只在卫星侧记：主窗口那条 `adoptTransferredTabs`（卫星交还标签）收的是
    //    自己的文档，本地不见得还有第二份，记了就会挂一颗点不动的键。
    if (windowKind === "satellite") sharedDocIds.add(st.docId);
    // 该文档在本地还留着隐藏实例（刚从别的窗口交回来）→ 先把它摘掉，避免出现
    // 「两份实例同源但互不同步」——同源多实例的前提是同一窗口内共用一个 docs 条目，
    // 而隐藏实例的正文可能与交回来的最新正文不一致。
    const remoted = remotedTabs.get(st.docId);
    if (remoted !== undefined) {
      const hidden = tabs.get(remoted.tabId);
      if (hidden && hidden !== tabs.get(st.docId)) tabs.delete(remoted.tabId);
      remotedTabs.delete(st.docId);
    }
    let doc = docs.get(st.docId);
    if (!doc) {
      doc = makeDoc(
        st.docId,
        st.text,
        st.name,
        st.path,
        st.encoding,
        st.eol,
        st.readonly,
        normalizeSizeClass(st.sizeClass),
        st.backupId ?? null,
      );
      registerDoc(doc);
    }
    doc.dirty = st.dirty;
    // 认领来的文档里，脏的那份**没有基线** —— 只继承到「它脏」，不知道原样是啥，
    // 所以不能拿 st.text 当基线（那是改过之后的内容）；干净的那份正文即基线
    // （makeDoc 已按 st.text 设好）。
    if (st.dirty) doc.baseline = null;
    else {
      doc.baseline = st.text;
      doc.baselineEncoding = st.encoding;
      doc.baselineEol = st.eol;
    }
    doc.backedUp = st.backedUp;
    const inst = makeInstance(doc, panel.panelId, st.text);
    if (isMdTab(inst) && st.viewMode === "preview") inst.viewMode = "preview";
    const lineNo = Math.min(Math.max(1, st.cursorLine || 1), inst.state.doc.lines);
    const line = inst.state.doc.line(lineNo);
    const pos = line.from + Math.min(Math.max(0, (st.cursorCol || 1) - 1), line.length);
    inst.state = inst.state.update({ selection: { anchor: pos } }).state;
    inst.scrollTop = st.scrollTop ?? null;
    attachTabToPanel(inst, panel);
    adopted.push(inst.tabId);
  }
  if (adopted.length === 0) return [];
  rebuildLayout();
  refreshAll();
  scheduleSessionSave();
  return adopted;
}

/** 卫星窗口：把手上的标签交还主窗口（定向投递，主窗口那边 applyTabsReturn）。 */
function returnTabsToMain(tabIds: number[]): void {
  const snapshots = tabIds
    .map((id) => transferSnapshotOf(id))
    .filter((s): s is SatelliteTab => s !== null);
  if (snapshots.length === 0) return;
  void emitTo(MAIN_WINDOW_LABEL, "tabs-return", {
    from: windowLabel,
    tabs: snapshots,
  }).catch((e: unknown) => {
    // 主窗口没在（正在退出）→ 未保存内容仍由热退出副本兜底。
    // 兜底是好的，但「标签没交回去」本身要留痕（B147）：下次启动它会以「隐藏实例」
    // 的形式出现在主窗口，用户看到的是「标签回来了、却不能编辑」。
    logger.debug("window", `标签没交回主窗口：${String(e)}`);
  });
}

/** 卫星窗口：把单个标签交回主窗口（标签右键「移回主窗口」）。 */
function returnTabToMain(tabId: number): void {
  returnTabsToMain([tabId]);
  detachLocally([tabId]);
}

/**
 * 把本窗口的若干标签「摘掉」（交出去之后）。
 *
 * ⚠️ 不能走 `closeTabById` —— 那会连 Rust 侧的文档一起删掉，接手的窗口拿到的
 * 就只剩一个空壳（首次保存会报「文档不存在」）。这里只动本窗口的内存视图，
 * 文档本体留在 Rust 等对方认领。
 */
function detachLocally(tabIds: number[]): void {
  for (const tabId of tabIds) {
    const tab = tabs.get(tabId);
    if (!tab) continue;
    const panel = panels.get(tab.panelId);
    tabs.delete(tabId);
    if (panel) {
      panel.tabs = panel.tabs.filter((id) => id !== tabId);
      if (panel.activeTabId === tabId) panel.activeTabId = panel.tabs[0] ?? -1;
      if (panel.viewTabId === tabId) panel.viewTabId = null;
    }
    if (![...tabs.values()].some((t) => t.docId === tab.docId)) docs.delete(tab.docId);
  }
  // 空了的卫星窗口自己关掉：留一个没有标签的窗口没有意义。
  // 摘空了自然没得交还，所以这里不需要 `returnTabs`（B157 交还是给「还剩几个」那档用的）。
  if (windowKind === "satellite" && tabs.size === 0) {
    requestSatelliteClose();
    return;
  }
  rebuildLayout();
  refreshAll();
  scheduleSessionSave();
}

// ------------------------------------------------- 卫星窗口怎么关（B155 / B157）

/**
 * 请求关掉卫星窗口。
 *
 * 刻意的「绕一圈」：走 `close()` 而**不是**直接 `destroy()`，为的是与用户点 X 走同一条
 * 链（CloseRequested → `registerSatelliteClose` → `finishSatelliteClose`）—— 热退出
 * 副本的收尾（cancelPendingBackup / flushBackups）就在那条链上，跳过去会漏掉。
 *
 * ⚠️ `returnTabs` 这两档**不是**同一个意思，别合并（B157 用户逐条钉死的口径）：
 *   · `false`（用户点 X / 主窗口退出带走的那个）：**不交还**。子窗口关掉就是真关，
 *     主窗口手里那份（隐藏实例）本来就没动过，不会「关了又冒回来」；反过来把标签
 *     交回去才是坏味道 —— 交回去的这批在子窗口里可都是没关的。
 *   · `true`（本窗口因为「最后一个文件 / 最后一个面板被关掉」而**自己**要关）：
 *     先把手上**剩的**交回主窗口再关。这是用户明确要的：「没有关闭的文件标签还是
 *     加回主窗口」—— 窗口是它自己关空的，那些文件本来就从主窗口分出去的，不留。
 * 交还必须先于 `close()`：`emitTo` 是 fire-and-forget，窗口一旦销毁回包就没了。
 */
function requestSatelliteClose(returnTabs = false): void {
  if (returnTabs && windowKind === "satellite") returnTabsToMain([...tabs.keys()]);
  void getCurrentWindow()
    .close()
    .catch((e: unknown) => {
      logger.debug("window", `请求关子窗口失败：${String(e)}`);
    });
}

/**
 * 一次拖拽涉及哪些标签实例（整组 = 该面板的全部标签）。
 *
 * 从载荷反推而不是随拖拽携带 id 列表：整组拖拽期间面板的标签集合可能被别的操作
 * 改动，**以松手那一刻的实际状态为准**才不会漏掉或多带。
 */
function dragTabIds(payload: TabDragPayload): number[] {
  if (payload.groupPanelId === null) return [payload.tabId];
  return [...(panels.get(payload.groupPanelId)?.tabs ?? [])];
}

/** 别的窗口来认领标签：把这次拖拽涉及的标签全部摊平成快照（正文一起带走）。 */
function snapshotDrag(payload: TabDragPayload): SatelliteTab[] | null {
  const snapshots = dragTabIds(payload)
    .map((id) => transferSnapshotOf(id))
    .filter((s): s is SatelliteTab => s !== null);
  return snapshots.length > 0 ? snapshots : null;
}

/**
 * 标签已经交给**另一个窗口**了，本窗口收干净（B91-2）。
 *
 * 与「交回主窗口」分成两条路径，差别只在本地留不留隐藏实例：
 *   · 主窗口 → 留隐藏实例（`remoteTabLocally`）：会话与热退出靠它记住这份文档的
 *     正文，卫星窗口被任务管理器结束时还能把标签恢复成可见的；
 *   · 卫星窗口 → 直接摘掉（`detachLocally`，摘空了它自己关窗）。
 */
function relinquishDrag(payload: TabDragPayload, toLabel: string): void {
  const ids = dragTabIds(payload);
  if (ids.length === 0) return;
  if (windowKind === "satellite") {
    // 卫星窗口不留隐藏实例：它被摘空了就自己关掉（detachLocally 里处理）
    detachLocally(ids);
    pruneEmptyPanels(); // B90：被拖走的那一组留下的空面板要摘掉
  } else {
    exitMaximize();
    for (const id of ids) remoteTabLocally(id, toLabel);
    // B90：整组（或最后一个标签）被拖走后那个面板就空了 —— 摘掉，别留一个空框。
    pruneEmptyPanels();
    rebuildLayout();
    refreshAll();
    scheduleSessionSave();
  }
  showMessage(`已移到另一个窗口 ${ids.length} 个标签`);
}

/**
 * 拖拽落在**窗口外**、且没有别的 LitePad 窗口接手（扔在桌面上）：源窗口的回落。
 *
 * B89 定下的语义一字未改：主窗口 → 在落点处开一个新窗口；卫星窗口 → 交回主窗口。
 * 区别只在「有没有别的窗口接手」不再靠源窗口猜（B89 是广播指针坐标 + 200ms 抢单），
 * 而是 `tabdnd.ts` 观察对方发来的认领 —— 走到这里就说明确实没人接。
 */
async function dropOnDesktop(
  payload: TabDragPayload,
  screenX: number,
  screenY: number,
): Promise<void> {
  const ids = dragTabIds(payload);
  if (ids.length === 0) return;
  if (windowKind === "satellite") {
    returnTabsToMain(ids);
    detachLocally(ids);
    pruneEmptyPanels(); // B90：同上，交回主窗口后不留空面板
    showMessage(`已交回主窗口 ${ids.length} 个标签`);
    return;
  }
  await openTabsInNewWindow(ids, desktopSpotOf(screenX, screenY));
}

/**
 * 桌面松手处的屏幕坐标（逻辑像素，虚拟桌面口径）。
 *
 * 用 `dragend` 的 `screenX/screenY`：整段拖拽手势被系统交给了拖放循环，页面在此期间
 * 收不到任何指针事件，`dragend` 是唯一还带着最后位置的时机。
 *
 * ⚠️ 多显示器不同缩放时这两个值会有偏差（它们按当前显示器的缩放折算）。所以拿不到
 * （0,0）就返回 null，让系统自己摆窗口 —— 摆错位置比不摆更让人困惑。
 */
function desktopSpotOf(screenX: number, screenY: number): WindowSpot | null {
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return null;
  if (screenX === 0 && screenY === 0) return null;
  return { x: screenX, y: screenY };
}

/**
 * 别的窗口把标签拖到本窗口、并在这里松手（B89）。
 *
 * `spot` 是**本窗口**在对方悬停时算好的落点（哪块面板、分屏还是并入、插到哪个标签
 * 之前）。拖拽期间用户看到的就是这块预览，所以提交必须严格照它来，绝不能重新猜一个
 * ——那会让「预览在这、落下在那」。
 */
function acceptDroppedTabs(raw: unknown, spot: DropSpot | null): boolean {
  const incoming = Array.isArray(raw) ? (raw as SatelliteTab[]) : [];
  const valid = incoming.filter(
    (s) => s && typeof s.docId === "number" && typeof s.text === "string",
  );
  if (valid.length === 0) return false;
  const panelId = spot?.panelId ?? activePanelId;
  const adopted = adoptTransferredTabs(valid, panelId);
  if (adopted.length === 0) return false;
  const first = adopted[0];
  if (spot && spot.zone !== "center") {
    // 落在面板边缘 = 分屏（与窗口内拖拽同一套语义：左右成 h、上下成 v）
    const dir = spot.zone === "left" || spot.zone === "right" ? "h" : "v";
    splitPanelWithTab(panelId, dir, first, spot.zone === "left" || spot.zone === "top");
  } else if (spot?.beforeTabId != null && spot.beforeTabId !== first) {
    moveTabToStrip(panelId, first, spot.beforeTabId);
  }
  showMessage(`已从另一个窗口接来 ${adopted.length} 个标签`);
  return true;
}

/** 主窗口：接住卫星窗口交回来的标签。 */
function applyTabsReturn(payload: { from?: string; tabs?: SatelliteTab[] } | null): void {
  if (windowKind !== "main") return;
  const incoming = payload?.tabs;
  if (!incoming || incoming.length === 0) return;
  adoptTransferredTabs(incoming);
  showMessage(`已从另一个窗口接回 ${incoming.length} 个标签`);
}

/**
 * 主窗口：接收卫星窗口新分配的副本 ID。
 *
 * 会话只有主窗口在写（卫星窗口的 scheduleSessionSave 是空操作），而热退出副本是
 * 卫星窗口自己写的 —— 不回传这个 ID，主窗口的会话就会记着一个旧的（或空的）副本号，
 * 重启时用户真正看到的内容反而成了没人认领的孤儿副本被清掉。
 */
function applyBackupIds(
  payload: { docs?: Array<{ docId: number; backupId: string | null; backedUp: boolean }> } | null,
): void {
  if (windowKind !== "main") return;
  let touched = false;
  for (const d of payload?.docs ?? []) {
    const doc = docs.get(d.docId);
    if (!doc) continue;
    doc.backupId = d.backupId;
    doc.backedUp = d.backedUp;
    touched = true;
  }
  if (touched) scheduleSessionSave();
}

/**
 * 主窗口：卫星窗口**异常消失**（崩溃 / 被任务管理器结束）时的兜底。
 *
 * 正常关闭走的是「先交还标签再 destroy」，到这里 remotedTabs 里已经空了，本函数
 * 自然成为空操作。真正命中只有异常路径 —— 那时把隐藏实例恢复成可见标签，
 * 至少让用户看得见、能继续编辑（代价是最后一次未交还的编辑不在，副本仍能兜住）。
 */
function reclaimFromVanished(label: string): void {
  if (windowKind !== "main") return;
  const orphans = [...remotedTabs.entries()].filter(([, v]) => v.owner === label);
  if (orphans.length === 0) return;
  for (const [docId, v] of orphans) {
    remotedTabs.delete(docId);
    reclaimRemoted(v.tabId);
  }
  rebuildLayout();
  refreshAll();
  scheduleSessionSave();
  showMessage(`另一个窗口已关闭，接回 ${orphans.length} 个标签`);
}

// --------------------------------------------- B161 关标签：只关自己这一份

/** 本窗口还**看得见**这份文档吗（隐藏实例不算 —— 它只是借出去那一份的副本）。 */
function hasVisibleInstanceOf(docId: number): boolean {
  for (const t of tabs.values()) {
    if (t.docId === docId && t.panelId !== -1) return true;
  }
  return false;
}

/**
 * 主窗口：把「借给卫星窗口那份的隐藏实例」作废旧账。
 *
 * 人家已经把标签关掉了，这份副本再留着就是 B155 那个「关了又冒回来」—— 等卫星窗口
 * 一关，`reclaimFromVanished` 会把它恢复成可见标签，用户看到的就是「我在子窗口关掉的
 * 文件跑到主窗口来了」。
 */
function dropRemotedDoc(docId: number): void {
  const v = remotedTabs.get(docId);
  if (!v) return;
  remotedTabs.delete(docId);
  tabs.delete(v.tabId);
  if (instancesOfDoc(docId).length === 0) docs.delete(docId);
  scheduleSessionSave();
}

/**
 * 收到别人的「我要关这份文档了，还有人拿着吗」。
 *
 * 两种答法：
 *   · 本窗口还有**可见**标签 → 回一条 `doc-close-held`，让对方别动 Rust 那一侧；
 *   · 没有可见标签 → 主窗口顺手把那份隐藏实例摘掉，并且**不吭声**：那只是一份副本，
 *     不算「有人拿着」（留着它才是「关了又冒回来」的根）。
 */
function handleDocCloseQuery(docId: number, from: string): void {
  if (hasVisibleInstanceOf(docId)) {
    void emitTo<DocClosePayload>(from, EVT_DOC_CLOSE_HELD, { from: windowLabel, docId }).catch(
      (e: unknown) => {
        logger.debug("window", `未能回告「仍持有文档」：${String(e)}`);
      },
    );
    return;
  }
  if (windowKind === "main" && remotedTabs.has(docId)) dropRemotedDoc(docId);
}

/**
 * 广播问一圈「这份文档还有没有别人拿着」，等一小会儿；有人应答就算有。
 *
 * ⚠️ 先装监听**再**广播：反过来的话，回得快的一方会在监听就位之前就把应答发出来，
 *    发起方一条都收不到 ⇒ 判定成「没人拿着」⇒ 又把别人的那份一起关掉（假绿）。
 * ⚠️ 应答要认 `from !== windowLabel`：广播本机也收得到自己的回声（B159 同款）。
 */
function docHeldElsewhere(docId: number, waitMs = 150): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unlisten: (() => void) | null = null;
    const finish = (held: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      unlisten?.();
      resolve(held);
    };
    void listen<DocClosePayload>(EVT_DOC_CLOSE_HELD, (e) => {
      const p = e.payload;
      if (p?.docId === docId && p.from !== undefined && p.from !== windowLabel) finish(true);
    })
      .then((un) => {
        if (settled) {
          un();
          return;
        }
        unlisten = un;
        void emit<DocClosePayload>(EVT_DOC_CLOSE_QUERY, { from: windowLabel, docId }).catch(
          () => {},
        );
        // 没人应答也算数：等过了这阵就当「没人拿着」。
        timer = setTimeout(() => finish(false), waitMs);
      })
      .catch(() => finish(false));
  });
}

// ------------------------------------------------------------ 跨窗口同源同步

/**
 * 同一文档同时挂在两个窗口上时，正文必须双向实时同步。
 *
 * 什么情况下会同时挂两个窗口：
 *   · 一个窗口把标签拖出去，又在原窗口重新打开了同一个文件（本地会先取回隐藏实例）；
 *   · 两个窗口各用「打开文件」打开了同一个路径（Rust 侧是同一条文档记录）。
 * 这时如果不同步，两边各编各的，最后谁按保存谁赢 —— 另一边的编辑无声消失。
 *
 * 只传变更集，不传全文：CM6 的 ChangeSet 本身就是可 JSON 化的位置增量，几百字节，
 * 每次按键发一份也不心疼；传全文在几十 MB 的文件上会把 IPC 打爆。
 *
 * 三层保护，缺一不可：
 *   1. 发送侧 `applyingRemote` —— 正在套用远端变更时产生的 update 不再广播，
 *      否则 A 改 → B 广播 → A 广播 …… 无穷弹；
 *   2. 接收侧复用 `syncingDocId` —— 让 handleUpdate 不把远端变更当用户编辑，
 *      否则两个窗口会各排一份自动保存与热退出副本，对着同一个文件写盘打架；
 *   3. 基准校验 —— 变更集自带 baseLen，对端长度对不上说明两边**已经分叉**
 *      （对端从磁盘重载过、或中间丢过一次事件）。此时硬套位置增量就会在错误的
 *      位置插入文本，属于静默改坏用户内容，绝不接受 → 转为要一份全文（见下）。
 */
interface DocChangePayload {
  from?: string;
  docId?: number;
  /** 变更前的文档长度（两个窗口必须一致，否则视为分叉） */
  baseLen?: number;
  changes?: unknown;
}

/** 事件名三兄弟：常规变更、分叉纠错请求、分叉纠错应答。 */
const EVT_DOC_CHANGE = "doc-change";
const EVT_DOC_RESYNC_REQ = "doc-resync-request";
const EVT_DOC_RESYNC_FULL = "doc-resync-full";

/**
 * 跨窗口同步滚动的两条（B159：`pushSyncToSiblings` 原来只扫本窗口 `tabs`，
 * 「新建窗口」拎出去的那份完全收不到通知 —— 用户报的就是这个）。
 *
 *   · `sync-scroll-mode` —— 开关状态（`docId → on`）。**必须先于位置到达**：
 *     对端靠它知道自己该不该跟着动。
 *   · `sync-scroll-pos` —— 源那份的位置（`px` 与 `line` 一起带，坐标属于**源那一侧**，
 *     由对端按自己 `viewMode` 挑一个用，跨视图模式的换算从不到网络上）。
 *
 * ⚠️ `from` 是**必填**的自证字段：tauri 的广播本机也会收到自己的回声，
 *    各处一律 `from === windowLabel → return`（与文档同步那三条同口径）。
 */
const EVT_SYNC_MODE = "sync-scroll-mode";
const EVT_SYNC_POS = "sync-scroll-pos";

/** 跨窗口同步滚动的载荷（`px` 为编辑器侧像素，`line` 为源那一侧的顶行）。 */
interface SyncPosPayload {
  from?: string;
  docId?: number;
  srcTabId?: number;
  px?: number | null;
  line?: number | null;
}
interface SyncModePayload {
  from?: string;
  docId?: number;
  on?: boolean;
}

/**
 * B161：关标签之前先问一圈「这份文档还有没有人拿着」。
 *
 * Rust 侧的文档是**进程级**的（`state.docs` 一份），而标签是每个窗口各持一份 ——
 * 本窗口这是最后一个实例，不等于别的窗口没有：主窗口那份**隐藏实例**（借给卫星
 * 窗口的副本）、另一个卫星窗口的可见标签，都算「有人拿着」。直接 `close_tab` 会把
 * 别人手上那份一起废掉（保存时报「文档不存在」）—— 用户看到的正是「在子窗口关一个
 * 文件，主窗口同文件的标签也被关了」。
 *
 * 所以关之前广播一次 `doc-close-query`；还在拿着的窗口回一条 `doc-close-held`，
 * 发起方等一小会儿，有人应答就只摘本地、不动 Rust 那一侧。
 *
 * ⚠️ `from` 同样是自证字段：tauri 的广播本机也会收到自己的回声（与上面几条同口径）。
 */
const EVT_DOC_CLOSE_QUERY = "doc-close-query";
const EVT_DOC_CLOSE_HELD = "doc-close-held";
interface DocClosePayload {
  from?: string;
  docId?: number;
}

/** 主窗口要销毁了（B155）：在场的卫星窗口收到这条就得自己收场。 */
// ⚠️ 这里**没有**「谁关了文档就广播给别的窗口」那条事件（B155 加过、B157 删掉）：
//    标签是每个窗口各持一份，但**关标签只有发起窗口说了算** —— 让对端跟着摘的结果是
//    「在子窗口关个文件，主窗口的同名标签也被关掉」，用户明确否掉。参见
//    `requestSatelliteClose` 里那两档 `returnTabs` 的取舍。
const EVT_APP_QUIT = "app-quit";

/** 正在套用远端变更：期间本窗口产生的 update 不再广播。 */
let applyingRemote = false;
/** 已发出、还没等到应答的重同步请求（同一文档不重复发）。 */
const resyncPending = new Set<number>();

/** 把本地编辑广播给其他窗口（自己也会收到这份事件，靠 payload.from 过滤掉）。 */
function broadcastDocChange(docId: number, changes: ChangeSet, baseLen: number): void {
  if (applyingRemote || changes.empty) return;
  void emit(EVT_DOC_CHANGE, {
    from: windowLabel,
    docId,
    baseLen,
    changes: changes.toJSON(),
  }).catch(() => {
    // 没有别的窗口 / 事件系统不可用：本窗口照常工作，不是错误
  });
}

/** 本窗口某文档的当前正文（取挂载中的实例，与 freshTextOfDoc 同一口径）。 */
function textOfDocId(docId: number): string | null {
  const doc = docs.get(docId);
  return doc ? freshTextOfDoc(doc) : null;
}

/** 收到远端变更：按「同源多实例」的方式落到本窗口该文档的每个实例上。 */
function applyRemoteDocChange(payload: DocChangePayload | null): void {
  const docId = payload?.docId;
  if (!payload || payload.from === windowLabel || typeof docId !== "number") return;
  const instances = [...tabs.values()].filter((t) => t.docId === docId);
  if (instances.length === 0) return; // 本窗口没这份文档：谁显示谁同步，无需理会

  let changes: ChangeSet;
  try {
    changes = ChangeSet.fromJSON(payload.changes);
  } catch {
    requestDocResync(docId);
    return;
  }
  if (changes.empty) return;

  const baseLen = payload.baseLen;
  if (typeof baseLen === "number" && instances.some((t) => t.state.doc.length !== baseLen)) {
    // 分叉了：宁可要一份全文，也不在错的基准上套增量
    requestDocResync(docId);
    return;
  }

  applyingRemote = true;
  syncingDocId = docId; // 与窗口内同源同步共用同一个回环闸门
  try {
    for (const inst of instances) {
      const p = panels.get(inst.panelId);
      if (p?.view && p.viewTabId === inst.tabId) {
        p.view.view.dispatch({ changes });
      } else {
        inst.state = inst.state.update({ changes }).state;
      }
    }
  } catch {
    // 位置越界（理论上过不了 baseLen 校验才会到这里）→ 退回全文纠错
    requestDocResync(docId);
    return;
  } finally {
    syncingDocId = null;
    applyingRemote = false;
  }

  // 同一个文档、同一份磁盘文件：远端改了内容，本窗口这份同样算「有未保存修改」。
  // 不能指望 handleUpdate —— 远端变更被 syncingDocId 抑制，走不到置脏那一段。
  // ⚠️ 也不在这里排自动保存/热退出：那些由**动手编辑的那个窗口**负责，两边都写
  // 同一个文件只会互相触发 file-changed。
  const doc = docs.get(docId);
  if (doc && !doc.dirty) {
    // 同样按「是否偏离基线」判（B112）：远端恰好把内容改回原样时就不该变脏。
    // ⚠️ 保留 `doc.dirty = true` 直写——这里只是补上被 syncingDocId 抑制的置脏，
    // 不是内容回到基线的场景，用不着走 refreshTitle/renderPanelTabs 之外的逻辑。
    if (isDirtyVsBaseline(doc, freshTextOfDoc(doc))) {
      doc.dirty = true;
      refreshTitle();
      renderPanelTabs();
    }
  }
  scheduleSessionSave();
}

/** 请对端把全文发过来：只在侦测到分叉时的一次性纠错，不是常规路径。 */
function requestDocResync(docId: number): void {
  if (resyncPending.has(docId)) return;
  resyncPending.add(docId);
  window.setTimeout(() => resyncPending.delete(docId), 2000);
  void emit(EVT_DOC_RESYNC_REQ, { from: windowLabel, docId }).catch(() => {});
}

/** 收到全文纠错请求：本窗口持有该文档就回一份全文（两边取到的内容相同）。 */
function answerDocResync(payload: DocChangePayload | null): void {
  const docId = payload?.docId;
  if (!payload?.from || payload.from === windowLabel || typeof docId !== "number") return;
  const text = textOfDocId(docId);
  if (text === null) return;
  void emitTo(payload.from, EVT_DOC_RESYNC_FULL, {
    from: windowLabel,
    docId,
    text,
  }).catch(() => {});
}

/**
 * 收到全文纠错应答：把本窗口该文档的正文换成对端的。
 *
 * ⚠️ 这一步会**丢弃本窗口的正文**，所以加了闸门：本地有未保存修改时自动纠正可能
 * 正好把用户刚敲的东西抹掉（分叉意味着谁更新已经无从判断）。这时只提示、不动手，
 * 把选择权交回用户。
 */
function applyDocResyncFull(
  payload: { from?: string; docId?: number; text?: string } | null,
): void {
  const { from, docId, text } = payload ?? {};
  if (!from || from === windowLabel || typeof docId !== "number" || typeof text !== "string") {
    return;
  }
  const instances = [...tabs.values()].filter((t) => t.docId === docId);
  if (instances.length === 0) return;
  const doc = docs.get(docId);
  if (doc?.dirty) {
    showMessage(`${doc.name} 在两个窗口的内容已不一致，为避免覆盖未保存的修改请手动处理`, true);
    return;
  }
  applyingRemote = true;
  syncingDocId = docId;
  try {
    for (const inst of instances) {
      const p = panels.get(inst.panelId);
      const view = p && p.viewTabId === inst.tabId ? p.view : null;
      // 基准取**挂载中的视图状态**（同 freshTextOfDoc 的口径）：快照与视图万一短暂不一致，
      // 按快照算出的整段替换会把视图拽回旧长度。
      const base = view ? view.view.state : inst.state;
      const whole = base.update({
        changes: { from: 0, to: base.doc.length, insert: text },
      }).state;
      // 整态重建：只 dispatch changes 的话 tab.state 与视图会不同步（后续切标签立刻串档）
      if (view) view.setState(whole);
      inst.state = whole;
      // B126：整段替换后视图被拉回开头，按旧视口位置还回去（浏览器自动裁剪）
      if (view && p) restoreViewScroll(p);
    }
  } finally {
    syncingDocId = null;
    applyingRemote = false;
  }
  if (doc) {
    showMessage(`${doc.name} 已按另一个窗口的内容重新同步`);
    refreshTitle();
    renderPanelTabs();
  }
}

/**
 * B159：收到别的窗口的同步滚动开关 —— 本窗口那份文档跟着开 / 关。
 *
 * ⚠️ 不落盘也不改写 `docSyncModes` 的所有权：开关仍然「一个文档一份」，只是这份
 *    状态在两个窗口里保持一致（否则主窗口按下后子窗口压根不知道自己该跟着动）。
 * ⚠️ 这里**要**刷新按钮的显隐与点亮态（B164 起子窗口也看得到这颗键）：主窗口按下后
 *    子窗口的按钮要跟着点亮；反过来子窗口按下时主窗口也一样。显隐判据已含
 *    `sharedDocIds`（B164），收到开关事件的窗口只要持有这份文档，按钮就在该在的状态。
 */
function applySyncMode(payload: SyncModePayload | null): void {
  const { from, docId, on } = payload ?? {};
  if (!from || from === windowLabel || typeof docId !== "number" || typeof on !== "boolean") {
    return;
  }
  if (docSyncModes.get(docId) === on) return;
  docSyncModes.set(docId, on);
  logger.debug("sync", `同步滚动 ← 远端 ${on ? "开" : "关"} docId=${docId} from=${from}`);
  refreshSyncButton(activeTab());
}

/**
 * B159：收到别的窗口滚过来的位置 —— 在本窗口**自己那份**同源实例上落一次。
 *
 * ⚠️ 收这边**绝不回推**：`applySyncToSibling` 里钉位置是套在 `restoringViewport`
 *    里的，它那两帧恰好盖住下一帧才到的 scroll，而两条滚动监听的首行都认这个集合
 *    （B142）—— 所以「谁滚谁当源」在跨窗口这一侧依然成立，不用另加闸门。
 * ⚠️ 只扫 `docId` 的全部实例并跳过 `srcTabId`：源那个 tabId 在别的窗口不重复出现，
 *    跳过它是防御（回声过滤与 `from` 那条是两回事，`from` 只保证不是自己发的）。
 */
function applyRemoteSyncPos(payload: SyncPosPayload | null): void {
  const { from, docId, srcTabId, px, line } = payload ?? {};
  if (!from || from === windowLabel || typeof docId !== "number" || typeof srcTabId !== "number") {
    return;
  }
  // 本窗口没开这份文档的同步滚动（开关那一条还没轮到，或用户在这边关过）⇒ 不动。
  if (docSyncModes.get(docId) !== true) return;
  for (const other of instancesOfDoc(docId)) {
    if (other.tabId === srcTabId) continue;
    applySyncToSibling(
      other,
      typeof px === "number" ? px : null,
      typeof line === "number" ? line : null,
    );
  }
}

/** 注册跨窗口同步的监听（两种窗口都要装，见 listenDocSync 的调用点）。 */
function listenDocSync(): void {
  void listen<DocChangePayload>("doc-change", (e) => applyRemoteDocChange(e.payload ?? null)).catch(
    () => {},
  );
  void listen<DocChangePayload>("doc-resync-request", (e) =>
    answerDocResync(e.payload ?? null),
  ).catch(() => {});
  void listen<{ from?: string; docId?: number; text?: string }>("doc-resync-full", (e) =>
    applyDocResyncFull(e.payload ?? null),
  ).catch(() => {});
  // B159：同步滚动那两条也挂在这同一个函数里 —— 「两种窗口都要装」这条契约本来就
  // 由 `listenDocSync();` 那句断言看着，拆到别处就得再写一份同样的断言。
  void listen<SyncModePayload>(EVT_SYNC_MODE, (e) => applySyncMode(e.payload ?? null)).catch(
    () => {},
  );
  void listen<SyncPosPayload>(EVT_SYNC_POS, (e) => applyRemoteSyncPos(e.payload ?? null)).catch(
    () => {},
  );
  // B161：关标签前那句「还有人拿着这份文档吗」—— 两种窗口都要接。
  // 应答由 `handleDocCloseQuery` 直接 emitTo 给发起方，所以这里只装监听、不回包。
  void listen<DocClosePayload>(EVT_DOC_CLOSE_QUERY, (e) => {
    const p = e.payload;
    // 自己的回声：广播本机也收得到（与上面几条同口径）
    if (!p?.docId || !p.from || p.from === windowLabel) return;
    handleDocCloseQuery(p.docId, p.from);
  }).catch(() => {});
}

// ---------------------------------------------------------------- 卫星窗口引导

/**
 * 卫星窗口的引导：只画一个面板，承载主窗口交过来的标签。
 *
 * 与主窗口的三处**刻意不同**：
 *   1. 不读也不写 session.json（会话归主窗口，两个窗口写同一份就是互相覆盖）；
 *   2. 关窗不问「是否保存」—— B155 起也不再把标签交回主窗口（那样「关掉的文件」
 *      会以隐藏实例的形式原地复活），内容改由热退出副本兜住（见 `finishSatelliteClose`）；
 *   3. 没有任何「保持窗口不空」的兜底 —— 关掉最后一个标签就等于关掉这个窗口。
 */
async function initSatelliteWindow(me: WindowPayload | null): Promise<void> {
  registerSatelliteClose();

  // B155：主窗口关了（点了退出 / 关了窗口 / 崩了）就跟着走。
  // 监听只装在卫星窗口这一侧 —— 发出广播的是主窗口，收的却是别人。
  // 这里与「点 X 关卫星窗口」刻意不同：不做备份收尾（`finishSatelliteClose`），
  // 只销毁。主窗口都走了，本窗口的未保存内容本来也随它一起进热退出副本。
  void listen(EVT_APP_QUIT, () => {
    void destroySelf().catch(() => {});
  }).catch(() => {});

  const payload = me?.payload;
  const incoming = payload?.tabs ?? [];
  if (incoming.length === 0) {
    // 载荷丢了（正常情况下不会）：宁可明确报错，也不要留一个空白窗口让人以为文档没了
    showFatalError(new Error("新窗口没有拿到要打开的文档，请回原窗口重新打开一次"));
    return;
  }

  await setupShell();

  panels.clear();
  tabs = new Map();
  docs = new Map();
  nextPanelId = 1;
  nextInstId = 1;
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
  activePanelId = 0;

  // 承载标签（内部会 rebuildLayout / refreshAll；scheduleSessionSave 在卫星窗口是空操作）
  adoptTransferredTabs(incoming, 0);

  bindEvents();
  rebuildLayout();
  refreshAll();
  panels.get(0)?.view?.focus();
  const only = incoming.length === 1 ? incoming[0].name : `${incoming.length} 个标签`;
  showMessage(`${only} · 已在新窗口打开（关闭本窗口会连同这些文件一起关掉）`);

  // 告诉源窗口「载荷已到手」——它据此才敢把原标签摘掉（见 openTabsInNewWindow）
  void emit("satellite-ready", { label: windowLabel }).catch(() => {});
}

/**
 * 卫星窗口的关窗流程：先把未保存内容落进热退出副本，再销毁自己。
 *
 * 🔒 这条是卫星窗口**唯一**的关窗处理器。主窗口那套（`registerWindowClose` →
 *    `finishAndDestroy`）在 `bootstrap` 里只属于主窗口那条分支，卫星窗口一条都装不上 ——
 *    所以关掉子窗口永远不会写 `session.json`、不会跑热退出备份、也不会弹「确定退出吗？」。
 *    ⚠️ 要加收尾只要往这条链上挂；千万别把 `registerWindowClose` / `finishAndDestroy`
 *    挪进来，那等于把整个应用退出流程塞进子窗口的关闭键里（B153）。
 */
function registerSatelliteClose(): void {
  void getCurrentWindow()
    .onCloseRequested((event) => {
      // 同 B135：这条回调是同步等 promise 的，里面 await IPC 会永久死锁。
      // 只拦窗 + 同步广播，备份与销毁挂到没人 await 的链上（见 finishSatelliteClose 注释）。
      event.preventDefault();
      // B155：**不再把标签交还主窗口** —— 子窗口关掉就是真关。
      //
      // 之前这里会把手上全部标签交回主窗口，于是「在子窗口关掉的文件」会以
      // 「主窗口里那个隐藏实例」的形式原样回来，用户看到的就是「关了又冒出来」。
      // 内容不丢的承诺改由热退出副本承担：`finishSatelliteClose` 里的
      // `cancelPendingBackup` + `flushBackups` 把未保存的那份写下来，副本号随后
      // 经 `backup-ids` 交给主窗口（主窗口下次启动照它认领）。
      // B157：**这里连「文档关掉了」的广播也一起不要了**（B155 加过，用户否掉）。
      // 主窗口那份同文档实例**本来就由它自己管**，跟着摘是「替别人关文件」，用户要的
      // 恰恰是「主窗口中同一个文件的打开标签不能被关闭」。
      // ⚠️ 取舍要说清：代价是「主窗口 / 另一个卫星窗口」那份同文档实例会留到下次
      //    启动才被认领（它本来就是隐藏实例，不会挡视线）。换来的是语义干净 ——
      //    「谁关的谁负责」：用户点 X 关子窗口 = 这批文件是他关掉的。
      void finishSatelliteClose();
    })
    .catch(() => {});
}

function registerWindowClose(): void {
  void getCurrentWindow()
    .onCloseRequested((event) => {
      // ⚠️⚠️ 这个回调里**绝不能 await 任何 IPC**（B135 死锁，实测 60s 窗口纹丝不动）：
      // `tauri::manager::window::on_window_event` 收到 CloseRequested 后，只要 WebView
      // 上挂了 JS 监听就会先 `api.prevent_close()`，再把事件同步投递给这条回调，
      // 并**等它的 promise 完成**。于是回调里一 `await` 某个 invoke，main thread 就被
      // 占住 —— 而那个 invoke 的回包要靠同一个 main thread 泵消息才能收到 ⇒ 死锁。
      // 保存、热退出备份、确认框三条都走的是同一个通道，一起卡死（所以确认框也不弹）。
      //
      // 正确姿势：回调只负责「拦住窗口」，真正的收尾挂在一条**没人 await 的链**上
      // （`finishAndDestroy`）—— 它会在本回调返回、main thread 重新泵消息后才继续跑。
      event.preventDefault();
      const dirty = [...docs.values()].filter((d) => d.dirty);
      void finishAndDestroy(dirty);
    })
    .catch(() => {});
}

/**
 * 卫星窗口的关窗收尾：交还已完成，这里只剩备份 + 销毁。
 *
 * ⚠️ **不许**在这里调 `finishAndDestroy`（写会话 / 热退出备份 / 未保存确认框）——
 *    那是主窗口的关停逻辑，归 `registerWindowClose` 那条链。这里的内容靠「标签交还」保住：
 *    主窗口拿到副本后，未保存的编辑随主窗口自己的自动保存落地。
 * 顺序也有讲究：先 `cancelPendingBackup()` 收掉本窗口那支排程（否则定时器会追着已销毁的
 * WebView 跑），再 `flushBackups()` 把手上已有的副本补齐。
 */
async function finishSatelliteClose(): Promise<void> {
  try {
    cancelPendingBackup();
    await flushBackups();
  } catch {
    // 备份失败也照关：内容没能进副本就只能丢，把窗口吊在这儿更糟
    // （以前这里写的是「标签已经交回主窗口」，B155 起那条路没有了，注释一并改掉）
  }
  await destroySelf();
}

/**
 * 关窗收尾（保存 / 备份 / 确认）→ 销毁窗口。
 *
 * ⚠️ 调用方**不能 await 它**（会一起卡死，见 `registerWindowClose` 的注释）。
 * 它自己内部 await 是安全的：那时 CloseRequested 的回调早已返回，main thread 空闲。
 *
 * 收尾一律用 `destroy()` 而不是 `close()`：close() 会再发一次 CloseRequested，
 * 而 `preventDefault()` 那次的标记还挂着，容易绕回来。destroy() 不发事件，干净收场。
 */
async function finishAndDestroy(dirty: Doc[]): Promise<void> {
  // B155：主窗口要走了 —— 通知还在的卫星窗口自己收场。
  // 卫星窗口没有独立生命周期（它承载的就是主窗口分出去的那几个文件），主窗口一没
  // 它就变成「打不开也关不掉」的孤儿窗口。这里只广播不等回话：后面还有会话落盘，
  // 等子窗口回一条 destroy 的应答反而会把主窗口的退出拖住。
  void emit(EVT_APP_QUIT, { from: windowLabel }).catch((e: unknown) => {
    logger.debug("window", `退出广播没发出去：${String(e)}`);
  });
  if (dirty.length === 0) {
    logger.debug("session", "收尾 · 没有脏文档，直接落会话");
    try {
      await persistSession();
    } catch (e) {
      // 会话保存失败不影响退出
      logger.debug("session", `收尾时落会话失败（不阻塞退出）：${String(e)}`);
    }
  } else {
    // ---- 有脏文档：热退出先试一把 ----
    // 排程中的备份作废，改成此刻同步写完（防抖窗口里关窗是最常见的丢数据场景）
    cancelPendingBackup();
    if (settings?.hot_exit) {
      try {
        await flushBackups();
      } catch (e) {
        // 备份整体抛错按「没备成」处理，落到下面的确认框
        logger.warn("hot-exit", `备份队列整体失败，落到确认框：${String(e)}`);
      }
      // 判定必须逐个文档查 backedUp，不能只看 flushBackups 的返回值：
      // 万一某个文档被中途改动/关闭，返回值就不可靠了。
      const unbacked = [...docs.values()].filter((d) => d.dirty && !d.backedUp);
      if (unbacked.length === 0) {
        try {
          await saveSession(snapshotSession());
        } catch (e) {
          // 会话写失败不阻塞退出；但别静默（B143：静默会让「会话写不进去」无从察觉）
          logger.warn("session", `会话写失败（热退出收尾）：${String(e)}`);
        }
        await destroySelf();
        return;
      }
    }

    // ---- 兜底：确认框（B67 及更早的行为） ----
    const names = dirty.map((d) => d.name).join("、");
    const quit = await ask(
      `${dirty.length} 个文档有未保存的修改（${names}），未保存的内容将丢失。\n确定退出吗？`,
      { title: "退出 LitePad", kind: "warning" },
    );
    if (!quit) {
      // 用户取消退出：把刚才为了 flush 而取消的排程还回去（内容还是脏的）
      scheduleBackup();
      return;
    }
    try {
      await saveSession(snapshotSession());
    } catch (e) {
      // 会话写失败不阻塞退出；但别静默（B143：静默会让「会话写不进去」无从察觉）
      logger.warn("session", `会话写失败（用户放弃退出后收尾）：${String(e)}`);
    }
  }
  await destroySelf();
}

/** 销毁当前窗口。destroy() 不发 CloseRequested，不会绕回来。 */
async function destroySelf(): Promise<void> {
  try {
    await getCurrentWindow().destroy();
  } catch (e) {
    // 已经销毁 / 参数异常都按「关了」处理
    logger.debug("window", `destroy 报错（按已关处理）：${String(e)}`);
  }
}

/**
 * 外壳装配：主题 / 字体 / 提示层 / 工具栏 / 菜单 / 滚轮缩放 / 全局监听。
 *
 * 主窗口与卫星窗口**必须走同一套** —— 两个窗口长得不一样（字体大小、主题、
 * 缩进行距有一个没跟上）会让用户以为是两个应用。所以这段从 bootstrap 里提出来共用，
 * 窗口**身份相关**的部分（会话恢复、关窗流程、会话保存）留在各自的 bootstrap 里。
 */
async function setupShell(): Promise<void> {
  try {
    settings = await loadSettings();
  } catch {
    settings = null;
  }
  bootMark("settings");

  keymapOverrides = sanitizeKeymap(settings?.keymap ?? {});
  // 预设必须在任何 effectiveKeys / resolveCommand 之前落地：它是键位基线，
  // 晚设置会让菜单、命令面板先按默认键位渲染一遍，表现为「预设没生效」。
  setKeymapPreset(normalizePresetId(settings?.keymap_preset));
  void loadPreferenceOptions();

  themeMode = normalizeMode(settings?.theme);
  isDark = applyTheme(themeMode);
  // 档位写进 <html data-theme-mode>（B97 前由顶栏那颗主题按钮承担）
  publishThemeMode();
  // 标签样式写进 <html data-tab-style>（B114；必须在任何标签渲染前落地）
  applyTabStyle(settings?.tab_style ?? "connected");
  // 标签操作槽位空位写进 <html data-tab-reserve>（B115，同上）
  applyTabActionReserve(settings?.tab_action_reserve_space ?? true);
  isWrap = settings?.word_wrap ?? true;
  applyFontSize(settings?.font_size ?? 14);
  applyFontFamily(settings?.font_family ?? "");
  applyPreviewLineHeight(settings?.preview_line_height ?? 1.7);
  applyEditorLineHeight(settings?.editor_line_height ?? 1.5);
  setupTocResizer();
  // B58：装配自绘提示层。必须**早于任何控件创建**地委托一次——
  // 它靠全局事件委托工作，控件只需带 data-tip，不需要逐个挂钩子。
  initTooltips();
  setupTitleBar();
  setupMenuBar();
  // Ctrl + 滚轮缩放字号（Ctrl+= / Ctrl+- 走同一条 changeFontSize 链路）
  attachWheelZoom((dir) => void changeFontSize(dir));

  watchSystemTheme(
    () => themeMode,
    (dark) => {
      if (dark !== isDark) {
        isDark = dark;
        applyDarkToTabs(dark);
      }
    },
  );

  // 外部修改事件：Rust watcher → file-changed → 自动刷新 / 冲突三选一
  void listen<FileChangedPayload>("file-changed", (e) => {
    const p = e.payload;
    if (p && typeof p.tabId === "number") handleFileChanged(p);
  }).catch(() => {});

  // B71 ④：跨窗口同源正文同步（主窗口与卫星窗口都要装，见 listenDocSync）
  listenDocSync();

  // 从资源管理器拖入文件（B91 改造）：wry 的原生拖放处理器已关闭（它做的两处劫持会把
  // 页面内 HTML5 拖放一起废掉，详见 `src-tauri/src/dropbridge.rs` 模块头），改由两层拼：
  //   · 悬停高亮：页面内 dragover 驱动（原生没了就没有 enter/over/leave 事件），
  //     坐标直接用 clientX/clientY；
  //   · 落地路径：页面把 File 对象交给 Rust，Rust 取回真实路径后 emit
  //     `tauri://drag-drop` —— 也就是下面这个 onDragDropEvent，载荷与原生逐字一致。
  //     （HTML5 file drop 本身只有内容没有路径，所以这一段必须过桥。）
  installFileDropTarget({
    preview: (x, y) => showFileDropPreview(x, y),
    clear: () => clearAllDropPreviews(),
  });
  if (!hasFileDropBridge()) logger.warn("drop", "path bridge unavailable");

  // B24：落地按分区打开（中央=该面板，边缘=分屏）；单个 Markdown 弹菜单选「打开文档 /
  // 插入文件路径」。这里只处理 drop —— enter/over/leave 已由上面的页面内监听接管。
  void getCurrentWebview()
    .onDragDropEvent((ev) => {
      const p = ev.payload;
      if (p.type !== "drop") return;
      const pos = dropPosOf(p.position);
      const target = fileDropTargetAt(pos.x, pos.y);
      clearAllDropPreviews();
      // B70 B 档：问「打开 / 插入路径」的前提是**落点是一份 Markdown**，
      // 而不是「拖进来的文件是 Markdown」。
      if (needsChoice(p.paths, target !== null && panelDocIsMarkdown(target.panelId))) {
        const path = p.paths[0];
        const name = path.split(/[\\/]/).pop() ?? path;
        showFileDropChoice(name, pos, {
          onOpen: () => void openDroppedAt(path, target),
          onInsert: () => insertDroppedPath(path),
        });
        return;
      }
      for (const path of p.paths) void openDroppedAt(path, target);
    })
    .catch(() => {});

  // 文件关联（单实例）：应用已运行时双击 .md/.markdown → Rust 转发 open-file 事件到主窗口。
  // 事件只作「来活了」的信号，真正要开的路径在 Rust 待打开队列里，这里取走打开。
  // ⚠️ 仅主窗口处理：事件经全局 listen 会广播到所有窗口，卫星窗口必须跳过。
  void listen("open-file", () => {
    if (windowKind !== "main") return;
    void takePendingFiles()
      .then((ps) => {
        for (const p of ps) void doOpen(p);
      })
      .catch(() => {});
  }).catch(() => {});
}

async function bootstrap(): Promise<void> {
  // B71 ④：第一件事就是问 Rust「我是谁」。必须是**第一个** IPC —— 卫星窗口不能
  // 先跑主窗口那套（读会话、注册关窗确认、写 session.json），否则两个窗口会抢同一份会话。
  let me: WindowPayload | null = null;
  try {
    me = await windowPayload();
    windowKind = me.kind;
    windowLabel = me.label;
  } catch {
    // 老版本后端 / 单窗口环境下拿不到身份应答：按主窗口走（退回 B71 之前的行为）
    windowKind = "main";
  }
  // 身份一确定就落 CSS，赶在外壳绘制之前（见 publishWindowKind 的注释）。
  // ⚠️ 这条 fallback 意味着「拿不到身份的卫星窗口会按主窗口行事」——关窗时也会装上
  //    `registerWindowClose`。那是刻意退回 B71 之前的行为，不是新口径。
  publishWindowKind();

  // B91-2：标签拖拽走 HTML5 DnD（影像是系统绘制的，能跟出窗口）。**两个窗口都要装**
  // —— 谁都可能成为落点（主窗口能接卫星窗口的，卫星窗口之间也能互拖）。
  // 这里把四件事接到宿主状态上：落点怎么算、窗口内松手怎么办、跨窗口怎么交接、
  // 扔在桌面上怎么回落。
  void installTabDnd({
    selfLabel: windowLabel,
    preview: (x, y, altKey) => previewDropAt(x, y, altKey),
    clear: () => clearDropIndicators(),
    commitLocal: (req) => commitTabDrop(req),
    snapshot: (payload) => snapshotDrag(payload),
    relinquish: (payload, toLabel) => relinquishDrag(payload, toLabel),
    adopt: (tabs, spot) => acceptDroppedTabs(tabs, spot as DropSpot | null),
    onFallback: (payload, sx, sy) => void dropOnDesktop(payload, sx, sy),
    // 自定义 MIME 没能跨过进程边界时记一行：否则跨窗口拖拽会「静默无效」，无从排查
    onWarn: (what) => logger.warn("drop", what),
  }).catch(() => {});

  if (windowKind === "satellite") {
    await initSatelliteWindow(me);
    return;
  }

  // 先注册关闭处理器：即使后续渲染抛错，窗口也能正常关闭（避免“点 X 无反应”）
  registerWindowClose();

  await setupShell();

  // B71 ④：接住卫星窗口交回来的标签 / 副本 ID；卫星窗口异常消失时兜底恢复
  void listen<{ from?: string; tabs?: SatelliteTab[] }>("tabs-return", (e) =>
    applyTabsReturn(e.payload ?? null),
  ).catch(() => {});
  void listen<{ docs?: Array<{ docId: number; backupId: string | null; backedUp: boolean }> }>(
    "backup-ids",
    (e) => applyBackupIds(e.payload ?? null),
  ).catch(() => {});
  void listen<{ label?: string }>("satellite-closed", (e) => {
    if (e.payload?.label) reclaimFromVanished(e.payload.label);
  }).catch(() => {});

  // 主题、菜单、工具栏全部就绪。此刻 DOM 已是正确配色的界面外壳，后面的会话
  // 恢复（读盘）再久也只是「内容晚一点出现」，不会让用户盯着一块空板。
  bootMark("shell");
  reportBoot("shell");

  // 尝试恢复上次会话；失败则退回空白未命名标签
  let t = bootMark("session-start");
  const restored = await restoreSession().catch(() => false);
  t = bootMark("session", t);
  if (!restored) {
    panels.clear();
    tabs = new Map();
    docs = new Map();
    nextPanelId = 1;
    nextInstId = 1;
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
    const defEncoding = settings?.default_encoding ?? "UTF-8";
    const defEol = settings?.default_eol ?? "CRLF";
    try {
      const info = await ipcNewTab(defEncoding);
      const doc = makeDoc(info.tabId, "", info.name, null, defEncoding, defEol, info.readonly);
      registerDoc(doc);
      const tab = makeInstance(doc, 0, "");
      attachTabToPanel(tab, panels.get(0)!);
      activePanelId = 0;
    } catch (err) {
      // 起不来 = 后面全白搭，这里必须留一条（B144）。
      logger.error("new-tab", String(err));
      showMessage(String(err), true);
      return;
    }
  } else {
    logger.info(
      "session",
      `restored ${docs.size} docs / ${tabs.size} instances / ${panels.size} panels`,
    );
  }

  // 文件关联：首次启动带 .md/.markdown 参数时，Rust 已把路径放进待打开队列，
  // 此处（外壳与会话都就绪后）取走打开。应用已运行时的实时路径走 open-file 事件监听。
  try {
    const pending = await takePendingFiles();
    for (const p of pending) void doOpen(p);
  } catch (e) {
    // B144：以前是空的。取队列失败不影响主流程，但「双击 .md 没反应」这类
    // 报告靠它是唯一线索（Rust 侧已经把入队记下来了）。
    logger.warn("pending", `take failed: ${String(e)}`);
  }

  // 备份区孤儿清理：副本文件本身不含「属于哪个标签」的索引，认领全靠会话，
  // 所以「会话里没人引用」就是「永远还原不了」，留着只会越积越多。
  //
  // ⚠️ 只在 `restored === true`（会话确实读成功并恢复了标签）时才敢清。
  // 会话文件损坏 / 读不出来时 restored 也是 false，这时 keep 会是空表，
  // 一刀切清理就等于把用户全部未保存内容删掉——宁可漏删，不可错删，
  // 漏掉的那些等下次成功启动再说。
  if (restored) {
    const keep = [...docs.values()].filter((d) => d.backedUp && d.backupId).map((d) => d.backupId!);
    void discardOrphanBackups(keep)
      .then((n) => {
        if (n > 0) logger.info("hot-exit", `discarded ${n} orphan backups`);
      })
      .catch((e) => {
        // ⚠️ 这里静默过：漏删会让副本无限堆积，但至少要保证「下次启动接着清」——
        // 所以除了记一条，什么也不改（别在这里顺手兜底删文件）。
        logger.warn("hot-exit", `orphan cleanup failed: ${String(e)}`);
      });
  }

  try {
    rebuildLayout();
    bindEvents();
    refreshAll();
    const p = activePanel();
    p?.view?.focus();
    // B104：状态栏不再挂快捷键提示 —— 快捷键有自己的入口（菜单、设置 → 快捷键），
    // 状态栏的本职是「当前状态」；一长串 Ctrl+… 是记不住的人才看的装饰，还占掉整条左栏。
    showMessage(restored ? "已恢复上次会话" : "就绪");
    bootMark("render", t);
    void persistSession();

    // B144：级别以后端为准（它决定要不要落盘）。不 await —— 这是启动收尾，
    // 日志拿不到就按默认 info 继续，绝不能反过来卡住启动。
    void syncLevel();

    reportBoot(`ready set_title=${diagSetTitle} tabs=${tabs.size} panels=${panels.size}`);
  } catch (err) {
    // 渲染期异常不应让整个应用静默白屏：显示错误，且关闭处理器已提前注册
    showFatalError(err);
  }
}

void bootstrap();

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
  logEvent,
  newTab as ipcNewTab,
  openFile,
  openSatelliteWindow,
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
import { renderToc, attachTocResizer, clampTocWidth, type TocResizerHandle } from "./markdown/toc";
import { attachWheelZoom } from "./shell/zoom";
import {
  createFindBar,
  type FindBarHandle,
  type FindBarQuery,
  type FindHit,
} from "./shell/findbar";
import { ICONS } from "./shell/icons";
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
import { KEYMAP_RECORDING_CLASS, showKeymapDialog } from "./shell/keymapdialog";
import { showPreferencesDialog } from "./shell/preferencesdialog";
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
const btnNew = el<HTMLButtonElement>("btn-new");
const btnOpen = el<HTMLButtonElement>("btn-open");
const btnSave = el<HTMLButtonElement>("btn-save");
const btnSaveAs = el<HTMLButtonElement>("btn-save-as");
const btnFind = el<HTMLButtonElement>("btn-find");
const btnOutline = el<HTMLButtonElement>("btn-outline");
const btnExport = el<HTMLButtonElement>("btn-export");
const btnTheme = el<HTMLButtonElement>("btn-theme");
const menuBar = el("menu-bar");
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
  dirty: boolean;
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
  updatePositionOf(panel.panelId, view);
  // 文本是否真的变了：点击内容区、移动光标、切换视图、重新测量都会产生
  // update 但前后文本完全一致——那不是编辑。
  // 关键：md 预览重渲染**只**在文本真变化时才排程。若按「任意 update」排程，
  // 大纲跳转的 dispatch（仅改选区）也会在 120ms 后全量重渲染预览 →
  // replaceChildren 把 scrollTop 清零，跳转落点被冲掉（B23「跳转位置不准」）。
  const textChanged =
    update.docChanged && update.startState.doc.toString() !== update.state.doc.toString();
  if (textChanged && isMdTab(tab)) scheduleMdRender(panel.panelId);
  if (update.docChanged && syncingDocId !== tab.docId) {
    // 只有**文本内容真的变了**才算用户修改。
    // 切换 源码/预览（编辑器被隐藏再显示）、点击内容区、重新测量等场景，
    // CM6 可能产生 docChanged 但前后文本完全一致的事务——那不是编辑，
    // 据此置脏会自动保存改写磁盘文件（用户没改过却被写盘）。
    if (textChanged && !suppressDirty && !doc.dirty) {
      doc.dirty = true;
      refreshTitle();
      renderPanelTabs();
    }
    // 自动保存只在内容真的变化时才排程：单纯点一下/移动光标不写盘
    if (textChanged && !suppressDirty) {
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
  void getCurrentWindow()
    .setTitle(title)
    .then(() => {
      diagSetTitle = "ok";
    })
    .catch((err) => {
      diagSetTitle = String(err);
    });
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
      canClose: countLeaves(layout) > 1,
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
        p.view.view.scrollDOM.addEventListener("scroll", () => {
          const t = p.viewTabId !== null ? tabs.get(p.viewTabId) : undefined;
          // 预览→编辑器方向程序滚动期间忽略，防止回环抖动
          if (!t || !isMdTab(t) || t.viewMode !== "preview") return;
          if (preview.isSyncing()) return;
          preview.syncFromEditor();
        });
        attachPasteHandler(p);
      }

      applyPanelMode(p);
      if (panelId === activePanelId && p.view) {
        p.view.focus();
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
  const tab = tabs.get(tabId);
  if (!tab) return;
  panel.activeTabId = tabId;
  suppressDirty = true;
  panel.view.setState(tab.state);
  suppressDirty = false;
  panel.viewTabId = tabId;
  panel.view.focus();
  applyPanelMode(panel);
  if (panelId === activePanelId) {
    refreshTitle();
    refreshStatus();
    updateTocDrawer();
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
  };
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
    try {
      await ipcCloseTab(doc.tabId);
    } catch (err) {
      showMessage(String(err), true);
      return;
    }
    docs.delete(doc.tabId);
  }

  const idx = panel.tabs.indexOf(tabId);
  panel.tabs = panel.tabs.filter((id) => id !== tabId);
  tabs.delete(tabId);

  if (panel.tabs.length === 0) {
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
    suppressDirty = true;
    panel.view.setState(nextTab.state);
    suppressDirty = false;
    panel.viewTabId = nextId;
  }
  applyPanelMode(panel);
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
  if (!panel || countLeaves(layout) <= 1) return;
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
        suppressDirty = true;
        panel.view.setState(prev.state);
        suppressDirty = false;
        panel.viewTabId = prev.tabId;
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
      // 已在标签中：切到其实例所在面板并激活（保留编辑状态）
      const inst = instancesOfDoc(existingDoc.tabId)[0];
      const instPanel = inst ? panelOfTab(inst.tabId) : undefined;
      if (inst && instPanel) {
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
    logEvent(
      "open",
      `${file.name} ${file.size}B ${file.encoding}${file.lossy ? " lossy" : ""} size=${doc.sizeClass}`,
    );
    scheduleSessionSave();
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
    doc.dirty = false;
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
    logEvent("save", `${saved.name} ${saved.size}B ${saved.encoding}/${saved.eol}`);
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
      if (err !== LOSSY_ABORT) logEvent("save-all", `fail ${doc.name}: ${String(err)}`);
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
    doc.dirty = false;
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
  if (windowKind !== "main") return;
  if (sessionTimer !== null) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    sessionTimer = null;
    void persistSession();
  }, 800) as unknown as number;
}

let sessionTimer: number | null = null;

/** 一个标签的会话记录（面板内标签与 `satelliteTabs` 共用同一形状）。 */
function sessionTabRecordOf(t: Tab): {
  path: string;
  encoding: string;
  eol: string;
  cursorLine: number;
  cursorCol: number;
  viewMode: string | null;
  backupId: string | null;
  docId: number;
} {
  const d = docs.get(t.docId)!;
  const pos = t.state.selection.main.head;
  const line = t.state.doc.lineAt(pos);
  return {
    path: d.path ?? "",
    encoding: d.encoding,
    eol: d.eol,
    cursorLine: line.number,
    cursorCol: pos - line.from + 1,
    viewMode: isMdTab(t) ? t.viewMode : null,
    backupId: d.backupId,
    // B69：空未命名文档的认领凭据（见 TabSession.docId 注释）
    docId: d.tabId,
  };
}

/** 该文档值不值得进会话（B68/B69 的判据；面板标签与隐藏实例共用）。 */
function sessionWorthy(t: Tab): boolean {
  const d = docs.get(t.docId);
  if (!d) return false;
  // B68：有磁盘路径的照旧入会话；没有路径的未命名文档，只有在
  // 备份区里确实存着副本时才值得留住（否则恢复时无据可依，只会白占一行）。
  if (d.path || d.backedUp) return true;
  // B69：热退出开着时，**空的**未命名文档也要留住。它没有内容要救，
  // 但标签本身该原样回来——「新建了还没开始打字」不该重启后凭空消失。
  //
  // ⚠️ 判定必须是「无路径 **且 不脏**」：脏、却又没备份成功的未命名文档
  // 绝不能按空文档恢复，那会把用户打的字真的丢掉。那种情况只能走
  // 关窗确认框（快照里没有它 → 恢复时也不会被当成空文档）。
  return settings?.hot_exit === true && !d.dirty;
}

function snapshotSession(): Parameters<typeof saveSession>[0] {
  const panelIndex = new Map<number, number>();
  const ordered = [...panels.keys()];
  ordered.forEach((id, i) => panelIndex.set(id, i));

  return {
    panels: ordered.map((id) => {
      const p = panels.get(id)!;
      const tabList = p.tabs
        .map((tid) => tabs.get(tid))
        .filter((t): t is Tab => !!t && sessionWorthy(t));
      return {
        tabs: tabList.map((t) => sessionTabRecordOf(t)),
        active: Math.max(
          0,
          tabList.findIndex((t) => t.tabId === p.activeTabId),
        ),
      };
    }),
    // B71 ④：搬到其他窗口的标签也要进会话（它们在本窗口是隐藏实例，见 remoteTabLocally）。
    // 卫星窗口自己不写会话，这里是这些标签唯一的兜底——不然「拖到新窗口 + 强杀进程」
    // 会让未保存内容变成没人认领的孤儿副本。
    satelliteTabs: [...remotedTabs.values()]
      .map((r) => tabs.get(r.tabId))
      .filter((t): t is Tab => !!t && sessionWorthy(t))
      .map((t) => sessionTabRecordOf(t)),
    // 最大化不进会话：0/1 的比例存下来会让下次启动只剩一块面板（见 layoutForSession）
    layout: convertLayoutForSession(layoutForSession(), panelIndex),
    activePanel: panelIndex.get(activePanelId) ?? 0,
  };
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
    await saveSession(snapshotSession());
  } catch {
    // 会话保存失败不影响使用
  }
}

/** 启动时恢复上次会话：按保存的布局树重建面板，逐个打开文件并恢复光标。失败返回 false（退回空白标签）。 */
async function restoreSession(): Promise<boolean> {
  let sess: SessionState | null;
  try {
    sess = await loadSession();
  } catch {
    return false;
  }
  const sp = sess?.panels;
  if (!sess || !sp || sp.length === 0) return false;
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
  } catch {
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
  await Promise.all(
    pending.map(async (p) => {
      if (p.backupId) {
        try {
          const backup = await restoreBackup(p.backupId);
          if (backup) {
            restoredCache.set(p.key, { kind: "backup", data: backup });
            return;
          }
        } catch {
          /* 副本读不了 / 格式坏了 → 退回按路径打开原文件 */
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
        } catch {
          /* 建不出来就跳过该标签 */
        }
        return;
      }
      try {
        restoredCache.set(p.key, { kind: "file", data: await openFile(p.path, p.encoding) });
      } catch {
        /* 文件已删除 / 读不了 → 该标签跳过 */
      }
    }),
  );

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
        opened++;
      } catch {
        // 文件已被删除/无法读取 → 跳过该标签
      }
    }
    if (panel.tabs.length > 0) {
      const active = Math.min(Math.max(0, spanel.active), panel.tabs.length - 1);
      panel.activeTabId = panel.tabs[active];
    }
  }

  if (opened === 0) {
    panels.clear();
    tabs = new Map();
    docs = new Map();
    return false;
  }

  activePanelId = idMap.get(sess.activePanel) ?? [...panels.keys()][0];
  if (!panels.has(activePanelId)) activePanelId = [...panels.keys()][0];
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
          doc.dirty = false;
          doc.external = false;
          markDiskVersion(doc, saved.mtimeMs, saved.size);
          // 内容已经落盘，备份区里的副本就成了「过期快照」——留着会让下次启动
          // 拿旧内容顶掉用户的已保存版本。必须在转干净的同时丢弃。
          discardBackupFor(doc);
          savedAny = true;
        } catch {
          // 单个文档保存失败不打断其余
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
        .catch(() => {
          failed++;
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
        () => {},
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
  doc.dirty = false;
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
      if (!doc.dirty) {
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
  // 从 display:none 恢复后 CM6 需要重新测量，否则编辑区空白
  panel.view?.view.requestMeasure();
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
  tab.viewMode = tab.viewMode === "source" ? "preview" : "source";
  // 切换视图本身不是编辑：隐藏/恢复编辑器可能让 CM6 产生事务，这里一律不置脏
  suppressDirty = true;
  try {
    applyPanelMode(panel);
  } finally {
    suppressDirty = false;
  }
  refreshViewModeButton();
  scheduleSessionSave();
}

/** 状态栏语言/格式项（记事本式，一个元素两用）：
 *  md 文件 → 「M↓ Markdown 语法/预览」可点击切换视图；其他类型 → 仅显示高亮语言名。 */
function refreshViewModeButton(): void {
  const tab = activeTab();
  const md = !!tab && isMdTab(tab);
  btnExport.disabled = !md;
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
 * 主题按钮的三态循环顺序（浅色 / 深色 / 跟随系统）。
 *
 * 顺序**跟着系统偏好走**：默认档是 system，若固定成 system→浅色→深色，
 * 在浅色系统上第一下点击（system→浅色）外观毫无变化——正是之前的
 * 「深浅色按钮要点两下才生效」。让 system 的下一档取「与当前生效相反」的显式档，
 * 保证从默认档出发的第一次点击必定翻转明暗；浅色⇄深色之间也必定翻转。
 * 唯一可能不翻转的一条边是「显式档 → system」（当二者恰好一致），这是三态的固有限制，
 * 此时按钮图标与状态栏提示仍会变化，不会出现「点了没反应」。
 */
function themeCycle(): ThemeMode[] {
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return systemDark ? ["system", "light", "dark"] : ["system", "dark", "light"];
}

/**
 * 三态各自的图标与名称。
 *
 * ⚠️ icon 直接存**画好的 SVG 字符串**，三档可以来自不同源：浅/深是 `icons.ts` 里唯二
 * 手绘的（官方 codicon 没有 sun / moon 字形，经用户确认豁免），跟随系统取官方的
 * `color-mode`（半明半暗的圆）。存字符串比存「图标名」少一层转发。
 */
const THEME_STATES: Record<ThemeMode, { icon: string; label: string }> = {
  light: { icon: ICONS.sun, label: "浅色" },
  dark: { icon: ICONS.moon, label: "深色" },
  system: { icon: CODICONS.colorMode, label: "跟随系统" },
};

/** 当前档位的下一档（循环闭合）。 */
function nextThemeMode(): ThemeMode {
  const cycle = themeCycle();
  const idx = cycle.indexOf(themeMode);
  return cycle[(idx + 1) % cycle.length];
}

/**
 * 主题按钮：图标随三态变化（太阳 / 月亮 / 半明半暗的圆）。
 *
 * ⚠️ **三档一律不点亮**（B79）：它是**循环按钮**，不是开关 —— 「激活态」在这里没有语义，
 * 而旧代码写的是 `themeMode === "dark"` 才点亮，于是深色档顶着一块实蓝底、浅色与
 * 跟随系统却是平的，三档观感各不相同（用户实测反馈）。当前档位由图标 + 悬停提示
 * 「主题：X」表达，底色三档统一。
 */
function refreshThemeButton(): void {
  const state = THEME_STATES[themeMode];
  const next = THEME_STATES[nextThemeMode()].label;
  btnTheme.innerHTML = state.icon;
  // B58：提示走自绘层，文案随三态变化
  setTip(btnTheme, `主题：${state.label}`, { detail: `点击切换为${next}` });
  btnTheme.setAttribute("aria-label", `主题：${state.label}，点击切换为${next}`);
  // 测试与样式钩子：当前处于哪一档
  btnTheme.dataset.themeMode = themeMode;
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
    logEvent("export", `html ${doc.name}`);
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
  logEvent("export", `pdf ${doc.name}`);
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
    logEvent("paste", `image ${img.rel} ${file.size}B`);
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

/**
 * 工具栏主题按钮：三态循环 跟随系统 / 浅色 / 深色（顺序见 `themeCycle`）。
 *
 * 与老实现的区别：老版只在明暗之间二选一，system 只能去首选项里选；
 * 现在三档都能从按钮点到，且每次点击都会在状态栏给出「主题：X」的回执，
 * 不会出现「点了不知道有没有生效」。
 */
async function cycleTheme(): Promise<void> {
  await setThemeMode(nextThemeMode());
}

// ---------------------------------------------------------------- 偏好（设置 → 首选项）

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

/** 预取行尾/编码候选，供「首选项」子菜单同步渲染（IPC 失败则用内置兜底）。 */
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

/** 主题三态（设置 → 首选项）：立即生效 + 持久化。 */
async function setThemeMode(mode: ThemeMode): Promise<void> {
  themeMode = mode;
  // ⚠️ **必须写回 settings，否则根本存不下来**（B79 用户实测：每次打开都是深色）。
  // 根因：persistSettings() 存的是整个 settings 对象，而启动时读的是 `settings.theme`
  // （main 里 `themeMode = normalizeMode(settings?.theme)`）。其它每一项设置都会在这里写回自己的字段，
  // 唯独主题漏了 —— 于是落盘永远是启动时的初始值 "system"，深色系统上解析成深色，表现为「设了重启就丢」。
  if (settings) settings.theme = mode;
  // ⚠️ 写回之后必须落盘（下面这行 persistSettings 存的是整个 settings 对象，含刚改的 theme）。
  // 根因：`persistSettings()` 存的是这整个 settings 对象，而启动时读的是
  // `settings.theme`（main 里 `themeMode = normalizeMode(settings?.theme)`）。
  // 其它每一项设置（`word_wrap` / `font_size` / `keymap`…）都会在这里写回自己的字段，
  // 唯独主题漏了 —— 于是落盘的永远是启动时的初始值 "system"，
  // 而 system 在深色系统的机器上解析成深色，表现为「主题设了、重启就丢」。
  const dark = applyTheme(mode);
  if (dark !== isDark) applyDarkToTabs(dark);
  isDark = dark;
  refreshThemeButton();
  await persistSettings();
  showMessage(mode === "system" ? "主题：跟随系统" : mode === "dark" ? "主题：深色" : "主题：浅色");
}

/** 新建文件的默认行尾（设置 → 首选项）。 */
async function setDefaultEol(value: string): Promise<void> {
  if (!settings) return;
  settings.default_eol = value;
  await persistSettings();
  showMessage(`新建文件默认行尾：${value}`);
}

/** 新建文件的默认编码（设置 → 首选项）。 */
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

/** 打开快捷键对话框（设置 → 快捷键）。 */
function openKeymapDialog(): void {
  showKeymapDialog({
    overrides: keymapOverrides,
    onChange: (next) => void applyKeymapOverrides(next),
    preset: getKeymapPreset().id,
    onPresetChange: (id) => void applyKeymapPreset(id),
  });
}

/**
 * 自动保存开关（绝对值；由「文件」菜单的勾选项切换）。
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

async function toggleAutosave(): Promise<void> {
  await setAutosave(!(settings?.autosave ?? false));
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

async function toggleHotExit(): Promise<void> {
  await setHotExit(!(settings?.hot_exit ?? true));
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

/** 编辑器字体族（首选项弹窗；空串 = 内置默认栈）。 */
async function setFontFamily(family: string): Promise<void> {
  applyFontFamily(family);
  if (settings) {
    settings.font_family = family.trim();
    await persistSettings();
  }
  showMessage(family.trim() ? `编辑器字体 ${family.trim()}` : "编辑器字体：默认");
}

/** 编辑器行距（首选项弹窗，1.0–2.5 倍）。 */
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

/** 字号绝对值设置（首选项弹窗；快捷键缩放走 changeFontSize 增量链路）。 */
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

/** 打开首选项弹窗（设置 → 首选项…）。 */
function openPreferencesDialog(): void {
  showPreferencesDialog({
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
  btnNew.addEventListener("click", () => void newUntitled());
  btnOpen.addEventListener("click", () => void doOpen());
  btnSave.addEventListener("click", () => void doSave(false));
  btnSaveAs.addEventListener("click", () => void doSave(true));
  btnFind.addEventListener("click", () => openFindReplace());
  btnOutline.addEventListener("click", () => toggleToc());
  btnExport.addEventListener("click", () => showExportMenu());
  btnTheme.addEventListener("click", () => void cycleTheme());

  sbLang.addEventListener("click", () => {
    if (isMdActive()) toggleViewMode();
  });
  sbEncoding.addEventListener("click", () => void showEncodingMenu());
  sbEol.addEventListener("click", () => showEolMenu());

  // 全局快捷键：统一走 keymap 注册表（设置 → 快捷键 里可浏览 / 改键）。
  // 见 onGlobalKeydown 的注释：必须挂捕获阶段。
  window.addEventListener("keydown", onGlobalKeydown, true);
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
  KeyS: 3,
  KeyH: 4,
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

function showExportMenu(): void {
  if (!isMdActive()) return;
  showPopupMenu(btnExport, [
    { label: "导出 HTML（自包含单文件）", onSelect: () => void exportHtml() },
    { label: "导出 PDF（系统打印对话框）", onSelect: () => exportPdf() },
  ]);
}

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

/** 工具栏图标填充（一律来自 official codicon，见 docs/conventions.md「图标」节）。 */
function setupToolbar(): void {
  const icons: [HTMLButtonElement, CodiconName][] = [
    [btnNew, "newFile"],
    [btnOpen, "folderOpened"],
    [btnSave, "save"],
    [btnSaveAs, "saveAs"],
    [btnFind, "search"],
    [btnOutline, "listTree"],
    [btnExport, "export"],
  ];
  for (const [btn, name] of icons) btn.innerHTML = CODICONS[name];
  refreshViewModeButton();
  // 主题按钮的图标由 refreshThemeButton 按当前档位（浅色/深色/跟随系统）决定
  refreshThemeButton();
}

/** 菜单栏初始化（文件 / 编辑 / 查看 / 设置 / 帮助，结构参考 Win11 记事本）。 */
function setupMenuBar(): void {
  createMenuBar(menuBar, {
    onNew: () => void newUntitled(),
    onOpen: () => void doOpen(),
    onSave: () => void doSave(false),
    onSaveAs: () => void doSave(true),
    onSaveAll: () => void doSaveAll(),
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
    onToggleAutosave: () => void toggleAutosave(),
    autosaveChecked: () => settings?.autosave ?? false,
    onToggleHotExit: () => void toggleHotExit(),
    hotExitChecked: () => settings?.hot_exit ?? true,
    // ---- 设置（B46：首选项弹窗化，子菜单的偏好回调全部移入弹窗 setter） ----
    onPreferences: () => openPreferencesDialog(),
    onKeymap: () => openKeymapDialog(),
    // ---- 帮助 ----
    onAbout: () => {
      void ask(
        "LitePad v0.1.0\n轻量级 Markdown / 文本编辑器（Tauri 2 + CodeMirror 6）\n\n仅 Windows 平台。",
        {
          title: "关于 LitePad",
          kind: "info",
          okLabel: "确定",
          cancelLabel: "关闭",
        },
      );
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
      logEvent("window", `satellite ${label} failed${detail}`);
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
    doc.backedUp = st.backedUp;
    const inst = makeInstance(doc, panel.panelId, st.text);
    if (isMdTab(inst) && st.viewMode === "preview") inst.viewMode = "preview";
    const lineNo = Math.min(Math.max(1, st.cursorLine || 1), inst.state.doc.lines);
    const line = inst.state.doc.line(lineNo);
    const pos = line.from + Math.min(Math.max(0, (st.cursorCol || 1) - 1), line.length);
    inst.state = inst.state.update({ selection: { anchor: pos } }).state;
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
  }).catch(() => {
    // 主窗口没在（正在退出）→ 未保存内容仍由热退出副本兜底
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
  // 空了的卫星窗口自己关掉：留一个没有标签的窗口没有意义
  if (windowKind === "satellite" && tabs.size === 0) {
    void getCurrentWindow().close();
    return;
  }
  rebuildLayout();
  refreshAll();
  scheduleSessionSave();
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
    doc.dirty = true;
    refreshTitle();
    renderPanelTabs();
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

/** 注册跨窗口同步的三个事件监听（两种窗口都要装）。 */
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
}

// ---------------------------------------------------------------- 卫星窗口引导

/**
 * 卫星窗口的引导：只画一个面板，承载主窗口交过来的标签。
 *
 * 与主窗口的三处**刻意不同**：
 *   1. 不读也不写 session.json（会话归主窗口，两个窗口写同一份就是互相覆盖）；
 *   2. 关窗不问「是否保存」—— 标签会交回主窗口，内容并没有消失；
 *   3. 没有「恢复上次会话」这一步，内容全部来自载荷。
 */
async function initSatelliteWindow(me: WindowPayload | null): Promise<void> {
  registerSatelliteClose();

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
  showMessage(`${only} · 已在新窗口打开（关闭本窗口会把它交回主窗口）`);

  // 告诉源窗口「载荷已到手」——它据此才敢把原标签摘掉（见 openTabsInNewWindow）
  void emit("satellite-ready", { label: windowLabel }).catch(() => {});
}

/** 卫星窗口的关窗流程：先把标签与副本号交还主窗口，再销毁自己。 */
function registerSatelliteClose(): void {
  let confirmed = false;
  void getCurrentWindow().onCloseRequested(async (event) => {
    if (confirmed) return;
    confirmed = true;
    event.preventDefault();
    // 交还优先于关窗：主窗口会把标签重新变成可见标签，用户不会觉得东西丢了
    returnTabsToMain([...tabs.values()].map((t) => t.tabId));
    try {
      cancelPendingBackup();
      await flushBackups();
    } catch {
      // 备份失败也照关：标签已经交回主窗口，内容在那边还活着
    }
    await getCurrentWindow().destroy();
  });
}

function registerWindowClose(): void {
  let windowCloseConfirmed = false;
  void getCurrentWindow()
    .onCloseRequested(async (event) => {
      // 已确认退出：放行默认关闭，避免 close() 二次触发本事件导致死循环
      if (windowCloseConfirmed) return;
      const dirty = [...docs.values()].filter((d) => d.dirty);
      if (dirty.length === 0) return; // 无脏文档：允许默认关闭
      event.preventDefault();

      // ---- 快路径：热退出 ----
      // 排程中的备份作废，改成此刻同步写完（防抖窗口里关窗是最常见的丢数据场景）
      cancelPendingBackup();
      if (settings?.hot_exit) {
        try {
          await flushBackups();
        } catch {
          // 备份整体抛错按「没备成」处理，落到下面的确认框
        }
        // 判定必须逐个文档查 backedUp，不能只看 flushBackups 的返回值：
        // 万一某个文档被中途改动/关闭，返回值就不可靠了。
        const unbacked = [...docs.values()].filter((d) => d.dirty && !d.backedUp);
        if (unbacked.length === 0) {
          try {
            await saveSession(snapshotSession());
          } catch {
            // 会话写失败不阻塞退出
          }
          windowCloseConfirmed = true;
          await getCurrentWindow().close();
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
      } catch {
        // 会话写失败不阻塞退出
      }
      windowCloseConfirmed = true;
      await getCurrentWindow().close();
    })
    .catch(() => {});
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
  isWrap = settings?.word_wrap ?? true;
  applyFontSize(settings?.font_size ?? 14);
  applyFontFamily(settings?.font_family ?? "");
  applyPreviewLineHeight(settings?.preview_line_height ?? 1.7);
  applyEditorLineHeight(settings?.editor_line_height ?? 1.5);
  setupTocResizer();
  // B58：装配自绘提示层。必须**早于任何控件创建**地委托一次——
  // 它靠全局事件委托工作，控件只需带 data-tip，不需要逐个挂钩子。
  initTooltips();
  setupToolbar();
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
  if (!hasFileDropBridge()) logEvent("drop", "path bridge unavailable");

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
    onWarn: (what) => logEvent("drop", what),
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
      showMessage(String(err), true);
      return;
    }
  } else {
    logEvent(
      "session",
      `restored ${docs.size} docs / ${tabs.size} instances / ${panels.size} panels`,
    );
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
        if (n > 0) logEvent("hot-exit", `discarded ${n} orphan backups`);
      })
      .catch(() => {
        // 清理失败不影响使用
      });
  }

  try {
    rebuildLayout();
    bindEvents();
    refreshAll();
    const p = activePanel();
    p?.view?.focus();
    showMessage(
      restored
        ? "已恢复上次会话 · Ctrl+N 新建，Ctrl+O 打开，Ctrl+F 查找"
        : "就绪 · Ctrl+N 新建，Ctrl+O 打开，Ctrl+S 保存，Ctrl+F 查找",
    );
    bootMark("render", t);
    void persistSession();

    reportBoot(`ready set_title=${diagSetTitle} tabs=${tabs.size} panels=${panels.size}`);
  } catch (err) {
    // 渲染期异常不应让整个应用静默白屏：显示错误，且关闭处理器已提前注册
    showFatalError(err);
  }
}

void bootstrap();

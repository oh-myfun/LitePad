import "./styles/global.css";

import { EditorState, type ChangeSet } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { redo, selectAll, undo } from "@codemirror/commands";
import { foldAll, foldCode, unfoldAll, unfoldCode } from "@codemirror/language";
import { convertFileSrc } from "@tauri-apps/api/core";
import { oneDark as oneDarkTheme } from "@codemirror/theme-one-dark";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  findMatches,
  nextMatchIndex,
  setFindQuery,
} from "./editor/find";
import { detectLanguage } from "./editor/language";
import { normalizeSizeClass, perfProfileFor, type SizeClass } from "./editor/perf";
import {
  checkEncodable,
  closeTab as ipcCloseTab,
  exportFile,
  isUnicodeEncoding,
  listEncodings,
  listEols,
  loadSession,
  loadSettings,
  logEvent,
  newTab as ipcNewTab,
  openFile,
  reloadFile,
  saveFile,
  savePasteImage,
  saveSession,
  saveSettings,
  type LossyChar,
  type SessionState,
  type Settings,
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
import { ICONS, type IconName } from "./shell/icons";
import { clearTip, initTooltips, setTip } from "./shell/tooltip";
import { paletteOpen, showCommandPalette } from "./shell/commandpalette";
import { createMenuBar, openMenuByIndex } from "./shell/menubar";
import { showPopupMenu } from "./shell/menu";
import {
  countLeaves,
  leaf,
  removePanel,
  siblingLeafOf,
  splitPanel as treeSplitPanel,
  splitPanelAt,
  updateRatio,
  type LayoutNode,
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
  type PanelRenderData,
} from "./shell/splitview";
import { needsChoice, showFileDropChoice, type FileDropTarget } from "./shell/filedrop";
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
   * M4 大文件档位：由 Rust 按文件字节数判定（OpenedFile.sizeClass），
   * 决定该文档关闭哪些昂贵编辑器特性；未命名文档恒为 normal。
   */
  sizeClass: SizeClass;
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
    if (textChanged && !suppressDirty) scheduleAutosave();
    syncDocInstances(tab, update.changes);
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

/** 关闭面板（VS Code 式）：仅移除该分屏，标签整体并入视觉相邻面板，不关文档。
 *  唯一面板时为空操作（⨯ 已禁用；退出走窗口关闭 / 菜单「退出」）。 */
function closePanelById(panelId: number): void {
  const panel = getPanel(panelId);
  if (!panel || countLeaves(layout) <= 1) return;
  const sibId = siblingLeafOf(layout, panelId);
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
    else src.activeTabId = -1; // 同面板分屏移出唯一标签：原面板留空
    rebuildLayout();
    refreshAll();
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

/** 重载（编码切换等）后重建文档全部实例的编辑器状态，并刷新挂载中的视图。 */
function rebuildDocInstances(doc: Doc, text: string): void {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const lang = detectLanguage(doc.name === "未命名" ? null : doc.name, firstLine);
  doc.langLabel = lang.label;
  for (const inst of instancesOfDoc(doc.tabId)) {
    const made = makeTabState(text, lang.extension, { dark: isDark, wrap: isWrap }, handleUpdate);
    inst.state = made.state;
    inst.comps = made.comps;
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
      normalizeSizeClass(file.size_class),
    );
    doc.mixedEol = file.mixedEol;
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
      file.size_hint ||
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

    const saved = await saveFile({
      tabId: doc.tabId,
      text,
      encoding: doc.encoding,
      eol: doc.eol,
      path: target,
    });

    doc.path = saved.path;
    doc.name = saved.name;
    doc.encoding = saved.encoding;
    doc.mixedEol = false;
    doc.dirty = false;
    doc.external = false;
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
  if (sessionTimer !== null) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    sessionTimer = null;
    void persistSession();
  }, 800) as unknown as number;
}

let sessionTimer: number | null = null;

function snapshotSession(): Parameters<typeof saveSession>[0] {
  const panelIndex = new Map<number, number>();
  const ordered = [...panels.keys()];
  ordered.forEach((id, i) => panelIndex.set(id, i));

  return {
    panels: ordered.map((id) => {
      const p = panels.get(id)!;
      const tabList = p.tabs
        .map((tid) => tabs.get(tid))
        .filter((t): t is Tab => !!t && !!docs.get(t.docId)?.path);
      return {
        tabs: tabList.map((t) => {
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
          };
        }),
        active: Math.max(
          0,
          tabList.findIndex((t) => t.tabId === p.activeTabId),
        ),
      };
    }),
    layout: convertLayoutForSession(layout, panelIndex),
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

  // 预取：并行发起所有文件的读取。按「面板索引|路径」去重——同一文件在多个面板
  // 打开时共用同一份 doc（同源多实例），本来也只需读一次盘。
  const pending: Array<{ key: string; path: string; encoding: string | null }> = [];
  for (let i = 0; i < panels0.length; i++) {
    for (const st of panels0[i].tabs) {
      if (!st.path) continue;
      const key = `${i}|${st.path}`;
      if (!pending.some((p) => p.key === key)) {
        pending.push({ key, path: st.path, encoding: st.encoding ?? null });
      }
    }
  }
  const openedCache = new Map<string, Awaited<ReturnType<typeof openFile>>>();
  await Promise.all(
    pending.map(async (p) => {
      try {
        openedCache.set(p.key, await openFile(p.path, p.encoding));
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
      if (!st.path) continue;
      const file = openedCache.get(`${i}|${st.path}`);
      if (!file) continue;
      try {
        let doc = docs.get(file.tabId);
        if (!doc) {
          doc = makeDoc(
            file.tabId,
            file.text,
            file.name,
            file.path,
            file.encoding,
            file.eol,
            file.readonly,
            normalizeSizeClass(file.size_class),
          );
          doc.mixedEol = file.mixedEol;
          registerDoc(doc);
        }
        // 同一路径出现在多个面板：各建一个同源实例（内容自动同步）
        const inst = makeInstance(doc, panel.panelId, file.text);
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
          await saveFile({
            tabId: doc.tabId,
            text,
            encoding: doc.encoding,
            eol: doc.eol,
            path: null,
          });
          doc.dirty = false;
          doc.external = false;
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

/** 外部修改事件：匹配打开的文档，标记 + 提示（影响该文档全部实例）。 */
function handleFileChanged(path: string): void {
  for (const doc of docs.values()) {
    if (!doc.path || doc.path.toLowerCase() !== path.toLowerCase()) continue;
    doc.external = true;
    for (const inst of instancesOfDoc(doc.tabId)) {
      const panel = panels.get(inst.panelId);
      if (panel?.view && panel.viewTabId === inst.tabId) {
        panel.view.view.dispatch({
          effects: [],
        }); // 触发标签栏刷新
      }
      renderPanelTabs(inst.panelId);
    }
    if (activeTab()?.docId === doc.tabId) {
      showMessage(`${doc.name} 已被外部修改（保存时将覆盖外部内容）`, true);
    }
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

function ensureFindBar(): FindBarHandle {
  if (findBar) return findBar;
  findBar = createFindBar(el("app"), {
    onQueryChange: (q) => applyFindQuery(q),
    onStep: (dir, q) => stepFind(dir, q),
    onReplace: (q) => replaceCurrent(q),
    onReplaceAll: (q) => replaceAllInScope(q),
    onSearchAll: (q) => searchOpenDocs(q),
    onOpenHit: (hit) => openFindHit(hit),
    onClose: () => clearFindHighlight(),
  });
  return findBar;
}

/** 打开查找栏（种子一般为当前选中的文本）。 */
function openFindBar(focus: "find" | "replace" = "find"): void {
  const bar = ensureFindBar();
  bar.open(selectedTextInActiveView());
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

/** 把查询写到全部可见视图（高亮同步；离屏实例不参与高亮）。 */
function applyFindQuery(q: FindBarQuery): void {
  const query = buildFindQuery(findOptionsOf(q));
  for (const p of panels.values()) {
    if (p.view) p.view.view.dispatch({ effects: setFindQuery.of({ query, activeFrom: null }) });
  }
  applyPreviewFindEverywhere(q);
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

function refreshFindCount(): void {
  const bar = findBar;
  if (!bar) return;
  const q = bar.getQuery();
  // 跨文档范围由结果列表给出「N 条结果（M 个文档）」，单文档的「第 n/m 处」会误导
  if (q.allDocs) {
    bar.setCount("");
    return;
  }
  // 预览态：计数与当前项来自预览高亮（预览可见文本与源码一一对应，步进以它为准）
  const panel = activePanel();
  const tab = panel ? tabs.get(panel.activeTabId) : undefined;
  if (panel && tab && isMdTab(tab) && tab.viewMode === "preview" && panel.preview) {
    const st = panel.preview.findState();
    if (st.count === 0) {
      bar.setCount(q.text ? "无匹配" : "");
    } else if (st.active < 0) {
      bar.setCount(`共 ${st.count} 处`);
    } else {
      bar.setCount(`第 ${st.active + 1}/${st.count} 处`);
    }
    return;
  }
  const view = panel?.view?.view;
  if (!view) return;
  const query = buildFindQuery(findOptionsOf(q));
  const matches = findMatches(view.state, query);
  if (matches.length === 0) {
    bar.setCount(q.text ? "无匹配" : "");
    return;
  }
  const idx = nextMatchIndex(matches, view.state.selection.main.head, 1);
  bar.setCount(`第 ${idx + 1}/${matches.length} 处`);
}

/** 当前文档范围：跳到上一个 / 下一个命中（到头环绕）。 */
function stepFind(dir: 1 | -1, q: FindBarQuery): void {
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
  const matches = findMatches(view.state, query);
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
      setFindQuery.of({ query, activeFrom: m.from }),
    ],
  });
  if (tab) tab.state = view.state;
  findBar?.setCount(`第 ${idx + 1}/${matches.length} 处`);
}

/** 替换当前命中（没有选中命中时，先跳到下一个再替换下一次点击生效）。 */
function replaceCurrent(q: FindBarQuery): void {
  const panel = activePanel();
  const view = panel?.view?.view;
  if (!panel || !view) return;
  const query = buildFindQuery(findOptionsOf(q));
  const matches = findMatches(view.state, query);
  const sel = view.state.selection.main;
  const target =
    matches.find((m) => m.from === sel.from && m.to === sel.to) ??
    (matches.length ? matches[nextMatchIndex(matches, sel.head, 1)] : undefined);
  if (!target) {
    findBar?.setStatus("没有可替换的匹配");
    return;
  }
  const insert = q.replace;
  const nextFrom = target.from + insert.length;
  view.dispatch({
    changes: { from: target.from, to: target.to, insert },
    selection: { anchor: nextFrom },
    effects: [
      EditorView.scrollIntoView(nextFrom, { y: "center" }),
      setFindQuery.of({ query, activeFrom: target.from }),
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
    const matches = findMatches(view.state, query);
    if (matches.length === 0) {
      findBar?.setStatus("无匹配");
      return;
    }
    view.dispatch({
      changes: matches.map((m) => ({ from: m.from, to: m.to, insert: q.replace })),
    });
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
    const changes = matches.map((m) => ({ from: m.from, to: m.to, insert: q.replace }));
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

/** 在所有已打开的文档中查找（直接扫内存里的标签快照，不读盘）。 */
function searchOpenDocs(q: FindBarQuery): FindHit[] {
  const query = buildFindQuery(findOptionsOf(q));
  if (!query) return [];
  const out: FindHit[] = [];
  for (const doc of [...docs.values()]) {
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
      if (out.length >= 300) break;
    }
    if (out.length >= 300) break;
  }
  return out;
}

/** 结果列表点击：切到该文档并把命中处选中、滚到视野中间。 */
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

/** 三态各自的图标与名称。 */
const THEME_STATES: Record<ThemeMode, { icon: IconName; label: string }> = {
  light: { icon: "sun", label: "浅色" },
  dark: { icon: "moon", label: "深色" },
  system: { icon: "followSystem", label: "跟随系统" },
};

/** 当前档位的下一档（循环闭合）。 */
function nextThemeMode(): ThemeMode {
  const cycle = themeCycle();
  const idx = cycle.indexOf(themeMode);
  return cycle[(idx + 1) % cycle.length];
}

/** 主题按钮：图标随三态变化；仅「显式深色」点亮，与改动前的观感一致。 */
function refreshThemeButton(): void {
  const state = THEME_STATES[themeMode];
  const next = THEME_STATES[nextThemeMode()].label;
  btnTheme.innerHTML = ICONS[state.icon];
  // B58：提示走自绘层，文案随三态变化
  setTip(btnTheme, `主题：${state.label}`, { detail: `点击切换为${next}` });
  btnTheme.setAttribute("aria-label", `主题：${state.label}，点击切换为${next}`);
  // 测试与样式钩子：当前处于哪一档
  btnTheme.dataset.themeMode = themeMode;
  btnTheme.classList.toggle("tool-btn-active", themeMode === "dark");
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

/** 自动保存开关（绝对值；由「设置」菜单的勾选项切换）。 */
async function setAutosave(on: boolean): Promise<void> {
  if (!settings || settings.autosave === on) return;
  settings.autosave = on;
  await persistSettings();
  showMessage(on ? "已启用自动保存" : "已停用自动保存");
}

async function toggleAutosave(): Promise<void> {
  await setAutosave(!(settings?.autosave ?? true));
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
  else bar.retarget();
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

/** 工具栏图标填充。 */
function setupToolbar(): void {
  const icons: [HTMLButtonElement, IconName][] = [
    [btnNew, "new"],
    [btnOpen, "open"],
    [btnSave, "save"],
    [btnSaveAs, "saveAs"],
    [btnFind, "find"],
    [btnOutline, "outline"],
    [btnExport, "export"],
  ];
  for (const [btn, name] of icons) btn.innerHTML = ICONS[name];
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
    autosaveChecked: () => settings?.autosave ?? true,
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

/** 始终注册窗口关闭：脏文档确认 + 立即持久化会话。放在最前，保证即使后续渲染失败窗口也能关闭。 */
function registerWindowClose(): void {
  let windowCloseConfirmed = false;
  void getCurrentWindow()
    .onCloseRequested(async (event) => {
      // 已确认退出：放行默认关闭，避免 close() 二次触发本事件导致死循环
      if (windowCloseConfirmed) return;
      const dirty = [...docs.values()].filter((d) => d.dirty);
      if (dirty.length === 0) return; // 无脏文档：允许默认关闭
      event.preventDefault();
      const names = dirty.map((d) => d.name).join("、");
      const quit = await ask(
        `${dirty.length} 个文档有未保存的修改（${names}），未保存的内容将丢失。\n确定退出吗？`,
        { title: "退出 LitePad", kind: "warning" },
      );
      if (!quit) return;
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

async function bootstrap(): Promise<void> {
  // 先注册关闭处理器：即使后续渲染抛错，窗口也能正常关闭（避免“点 X 无反应”）
  registerWindowClose();

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

  // 外部修改事件：Rust watcher → file-changed → 标记脏文件
  void listen<{ path: string }>("file-changed", (e) => {
    if (e.payload?.path) handleFileChanged(e.payload.path);
  }).catch(() => {});

  // 从资源管理器拖入文件：WebView2 原生拖放（dragDropEnabled: true）→ 这是拿到
  // 真实文件路径的唯一方式（HTML5 file drop 只有内容没有路径），打开后保留磁盘关联
  // （监听外部修改 / 会话恢复 / 直接保存）。
  // B24：悬停时高亮落点面板/分区；落地按分区打开（中央=该面板，边缘=分屏）；
  //      单个 Markdown 弹菜单选「打开文档 / 插入文件路径」。
  void getCurrentWebview()
    .onDragDropEvent((ev) => {
      const p = ev.payload;
      if (p.type === "enter" || p.type === "over") {
        const pos = dropPosOf(p.position);
        showFileDropPreview(pos.x, pos.y);
        return;
      }
      if (p.type === "leave") {
        clearAllDropPreviews();
        return;
      }
      // drop
      const pos = dropPosOf(p.position);
      const target = fileDropTargetAt(pos.x, pos.y);
      clearAllDropPreviews();
      if (needsChoice(p.paths)) {
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

import "./styles/global.css";

import { EditorState, type ChangeSet } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { redo, selectAll, undo } from "@codemirror/commands";
import { foldAll, unfoldAll } from "@codemirror/language";
import { convertFileSrc } from "@tauri-apps/api/core";
import { oneDark as oneDarkTheme } from "@codemirror/theme-one-dark";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import "katex/dist/katex.min.css";
import "./styles/preview.css";

import { createEditor, makeTabState, type EditorHandle, type TabCompartments } from "./editor/editor";
import { buildFindQuery, clearFindQuery, findMatches, nextMatchIndex, setFindQuery } from "./editor/find";
import { detectLanguage } from "./editor/language";
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
  searchFiles,
  type LossyChar,
  type SearchHit,
  type SessionState,
  type Settings,
} from "./ipc/api";
import { buildExportHtml, printToPdf } from "./markdown/exporter";
import { extractToc, renderBlocks, renderFull, type TocEntry } from "./markdown/pipeline";
import { PreviewPane } from "./markdown/preview";
import { renderToc, attachTocResizer, clampTocWidth, type TocResizerHandle } from "./markdown/toc";
import { attachWheelZoom } from "./shell/zoom";
import { createFindBar, type FindBarHandle, type FindHit, type FindBarQuery, type FindScope } from "./shell/findbar";
import { ICONS, type IconName } from "./shell/icons";
import { createMenuBar, openMenuByIndex } from "./shell/menubar";
import { showPopupMenu } from "./shell/menu";
import {
  countLeaves,
  leaf,
  removePanel,
  siblingLeafOf,
  splitPanel as treeSplitPanel,
  splitPanelAt,
  type LayoutNode,
} from "./shell/layout";
import { showKeymapDialog } from "./shell/keymapdialog";
import { renderSplitview, type PanelRenderData } from "./shell/splitview";
import { renderTabstrip, type TabViewData, type TabstripCallbacks } from "./shell/tabstrip";
import {
  applyTheme,
  normalizeMode,
  watchSystemTheme,
  type ThemeMode,
} from "./theme/theme";

const TEXT_FILTERS = [
  {
    name: "文本文件",
    extensions: [
      "txt", "md", "markdown", "json", "js", "ts", "rs", "py", "html",
      "css", "xml", "yml", "yaml", "ini", "bat", "sh", "sql", "log",
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
let panels = new Map<number, Panel>();
let layout: LayoutNode = leaf(0);
let nextPanelId = 1;
let nextInstId = 1;
let activePanelId = 0;

let settings: Settings | null = null;
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
  // 软件名在前，文件名在后：无文档时只有 LiteMD
  const title = doc ? `LiteMD - ${doc.name}${mark}${suffix}` : "LiteMD";
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
  sbEol.title = doc?.mixedEol
    ? `文件中混用了多种行尾，保存时将统一为 ${doc.eol}`
    : "点击切换行尾（保存时生效）";
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
      // 活动面板的视觉差异（标题/状态栏）由 refreshTitle/refreshStatus 覆盖；
      // .layout-panel-active 当前无视觉样式，无需同步。
      if (activePanelId === panelId) return;
      activePanelId = panelId;
      refreshTitle();
      refreshStatus();
      // 大纲跟随**活动面板**的活动文档：分屏下点另一块面板（文本 ↔ md）若不刷新，
      // 大纲会一直停在上一份 md 的大纲上（B23）。这里不重绘标签条（会吞掉 click）。
      updateTocDrawer();
      const p = getPanel(panelId);
      p?.view?.focus();
      retargetFindBar();
    },
    onActivateTab: (panelId, tabId) => switchTab(panelId, tabId),
    onCloseTab: (tabId) => void closeTabById(tabId),
    onClosePanel: (panelId) => void closePanelById(panelId),
    onSplitPanel: (panelId, dir) => void splitActivePanel(panelId, dir),
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
    onDropTabToPanel: (tabId, targetPanelId, zone, overTabId, copy) =>
      onDropTabToPanel(tabId, targetPanelId, zone, overTabId, copy),
    onNewTab: (panelId) => {
      activePanelId = panelId;
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

function updateRatio(node: LayoutNode, path: number[], ratio: number): void {
  if (node.kind !== "split") return;
  const [head, ...rest] = path;
  if (rest.length === 0 && (head === 0 || head === 1)) {
    node.ratio = ratio;
    return;
  }
  if (head === 0) updateRatio(node.a, rest, ratio);
  else updateRatio(node.b, rest, ratio);
}

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
  };
}

/** 为文档在指定面板创建一个实例（独立 CM6 状态，内容同源）。 */
function makeInstance(doc: Doc, panelId: number, text: string): Tab {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const lang =
    doc.name === "未命名" && !text
      ? { label: "Plain Text", extension: null }
      : detectLanguage(doc.name === "未命名" ? null : doc.name, firstLine);
  const { state, comps } = makeTabState(text, lang.extension, { dark: isDark, wrap: isWrap }, handleUpdate);
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
    panels.set(0, { panelId: 0, tabs: [], activeTabId: -1, view: null, viewTabId: null, preview: null, previewTimer: null, bodyEl: null });
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

  // 保存确认只针对该标签内容：切到该标签并激活其所在面板
  if (panel.activeTabId !== tabId) switchTab(panel.panelId, tabId);
  if (activePanelId !== panel.panelId) {
    activePanelId = panel.panelId;
    refreshTitle();
    refreshStatus();
    renderPanelTabs();
  }
  if (doc.dirty && siblings.length === 0) {
    const save = await ask(`${doc.name} 有未保存的修改，保存后关闭吗？`, {
      title: "关闭标签",
      kind: "warning",
    });
    if (save) {
      const ok = await doSave(false);
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
  panels.set(newId, { panelId: newId, tabs: [], activeTabId: -1, view: null, viewTabId: null, preview: null, previewTimer: null, bodyEl: null });
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
        const doc = makeDoc(info.tabId, "", info.name, null, settings?.default_encoding ?? info.encoding, settings?.default_eol ?? info.eol, info.readonly);
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

async function doOpen(presetPath?: string, encoding?: string): Promise<void> {
  let target = presetPath;
  if (!target) {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: TEXT_FILTERS,
    });
    if (!picked || Array.isArray(picked)) return;
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
        return;
      }
    }

    const panel = activePanel() ?? [...panels.values()][0];
    if (!panel) return;
    const doc = makeDoc(
      file.tabId,
      file.text,
      file.name,
      file.path,
      file.encoding,
      file.eol,
      file.readonly,
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
      file.lossy
        ? `已打开 ${file.name}（部分字节无法用 ${file.encoding} 解码，建议在状态栏手动指定编码）`
        : `已打开 ${file.name}`,
      file.lossy,
    );
    logEvent("open", `${file.name} ${file.size}B ${file.encoding}${file.lossy ? " lossy" : ""}`);
    scheduleSessionSave();
  } catch (err) {
    showMessage(String(err), true);
  }
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
    parts.push(`${untitled.length} 个未命名文档需手动保存（${untitled.map((d) => d.name).join("、")}）`);
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
function convertLayoutForSession(
  node: LayoutNode,
  panelIndex: Map<number, number>,
): unknown {
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
  let sess: SessionState | null = null;
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
      panels.set(realId, { panelId: realId, tabs: [], activeTabId: -1, view: null, viewTabId: null, preview: null, previewTimer: null, bodyEl: null });
      idMap.set(idx, realId);
    }
    return leaf(realId);
  }

  function buildTree(node: unknown): LayoutNode {
    const n = node as
      | { kind?: string; dir?: string; ratio?: number; a?: unknown; b?: unknown; panelId?: number }
      | null;
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

  // 逐面板恢复标签
  let opened = 0;
  for (let i = 0; i < panels0.length; i++) {
    const spanel = panels0[i];
    const panel = panels.get(idMap.get(i)!);
    if (!panel) continue;
    for (const st of spanel.tabs) {
      if (!st.path) continue;
      try {
        const file = await openFile(st.path, st.encoding ?? null);
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
        const pos =
          line.from + Math.min(Math.max(0, (st.cursorCol || 1) - 1), line.length);
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
        panel.view.view
          .dispatch({
            effects: [],
          })
          ; // 触发标签栏刷新
      }
      renderPanelTabs(inst.panelId);
    }
    if (activeTab()?.docId === doc.tabId) {
      showMessage(`${doc.name} 已被外部修改（保存时将覆盖外部内容）`, true);
    }
  }
}

// ---------------------------------------------------------------- 在文件中查找（M2）

function defaultSearchDir(): string {
  const t = activeTab();
  const doc = t ? docs.get(t.docId) : undefined;
  if (doc?.path) {
    const idx = doc.path.lastIndexOf("\\");
    return idx > 0 ? doc.path.slice(0, idx) : doc.path;
  }
  return "";
}

async function jumpToHit(hit: SearchHit): Promise<void> {
  await doOpen(hit.path);
  const panel = activePanel();
  const tab = activeTab();
  if (!panel?.view || !tab) return;
  const doc = docs.get(tab.docId);
  if (!doc?.path || doc.path.toLowerCase() !== hit.path.toLowerCase()) return;
  const line = Math.min(Math.max(1, hit.line), tab.state.doc.lines);
  const pos = tab.state.doc.line(line).from + Math.max(0, hit.col - 1);
  panel.view.view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
  tab.state = panel.view.view.state;
}

// ---------------------------------------------------------------- 悬浮查找 / 替换栏

/**
 * 统一查找入口：编辑器内不再嵌 CM6 搜索面板，「在文件中查找」也不再是独立窗口，
 * 全部收敛到这一个应用级浮层（不绑定文件/面板，切换标签、分屏都不会自动关闭）。
 */
let findBar: FindBarHandle | null = null;

function ensureFindBar(): FindBarHandle {
  if (findBar) return findBar;
  findBar = createFindBar(el("app"), {
    onQueryChange: (q) => applyFindQuery(q),
    onStep: (dir, q) => stepFind(dir, q),
    onReplace: (q) => replaceCurrent(q),
    onReplaceAll: (q) => void replaceAllInScope(q),
    onSearchAll: (q) => searchAllInScope(q),
    onOpenHit: (hit) => void openFindHit(hit),
    onPickFolder: async () => {
      const picked = await openDialog({ directory: true, multiple: false, title: "选择搜索目录" });
      return typeof picked === "string" ? picked : null;
    },
    onClose: () => clearFindHighlight(),
  });
  return findBar;
}

/** 打开查找栏（scope 省略时保持上次范围）。seed 一般为当前选中的文本。 */
function openFindBar(scope?: FindScope, focus: "find" | "replace" = "find"): void {
  const bar = ensureFindBar();
  const seed = selectedTextInActiveView();
  bar.open(scope, seed);
  if (scope === "folder") bar.setFolder(defaultSearchDir());
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
  return { search: q.text, caseSensitive: q.caseSensitive, wholeWord: q.wholeWord, regexp: q.regexp };
}

/** 把查询写到全部可见视图（高亮同步；离屏实例不参与高亮）。 */
function applyFindQuery(q: FindBarQuery): void {
  const query = buildFindQuery(findOptionsOf(q));
  for (const p of panels.values()) {
    if (p.view) p.view.view.dispatch({ effects: setFindQuery.of({ query, activeFrom: null }) });
  }
  refreshFindCount();
}

function clearFindHighlight(): void {
  for (const p of panels.values()) {
    if (p.view) clearFindQuery(p.view.view);
  }
}

function refreshFindCount(): void {
  const bar = findBar;
  const view = activePanel()?.view?.view;
  if (!bar || !view) return;
  const q = bar.getQuery();
  if (q.scope !== "doc") return;
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
  const view = panel?.view?.view;
  if (!panel || !view) return;
  const query = buildFindQuery(findOptionsOf(q));
  const matches = findMatches(view.state, query);
  if (matches.length === 0) {
    findBar?.setCount(q.text ? "无匹配" : "");
    return;
  }
  const tab = panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
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

/** 当前文档或所有打开的文档范围内的全部替换（文件夹范围不支持写回）。 */
async function replaceAllInScope(q: FindBarQuery): Promise<void> {
  if (q.scope === "folder") {
    findBar?.setStatus("文件夹范围不支持替换");
    return;
  }
  if (!q.text) {
    findBar?.setStatus("请输入查找内容");
    return;
  }
  const query = buildFindQuery(findOptionsOf(q));
  if (!query) {
    findBar?.setStatus("查找内容无效（正则语法错误？）");
    return;
  }
  let files = 0;
  let total = 0;
  if (q.scope === "doc") {
    const panel = activePanel();
    const view = panel?.view?.view;
    if (!panel || !view) return;
    const matches = findMatches(view.state, query);
    if (matches.length === 0) {
      findBar?.setStatus("无匹配");
      return;
    }
    view.dispatch({ changes: matches.map((m) => ({ from: m.from, to: m.to, insert: q.replace })) });
    const tab = panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
    if (tab) tab.state = view.state;
    files = 1;
    total = matches.length;
  } else {
    for (const doc of docs.values()) {
      if (doc.readonly) continue;
      const insts = instancesOfDoc(doc.tabId);
      if (insts.length === 0) continue;
      const state = insts[0].state;
      const matches = findMatches(state, query);
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
  }
  findBar?.setStatus(total === 0 ? "无匹配" : `已在 ${files} 个文档中替换 ${total} 处`);
  refreshFindCount();
}

/** 所有打开的文档 / 文件夹 范围搜索。 */
async function searchAllInScope(q: FindBarQuery): Promise<FindHit[]> {
  if (q.scope === "folder") {
    const hits = await searchFiles({
      root: q.folder,
      query: q.text,
      caseSensitive: q.caseSensitive,
      regex: q.regexp,
      maxResults: 300,
    });
    return hits.map((h) => ({
      kind: "file" as const,
      path: h.path,
      name: h.name,
      line: h.line,
      col: h.col,
      text: h.text,
      from: 0,
      to: 0,
    }));
  }
  // 所有打开的文档：直接扫描内存中的标签快照（无需读盘）
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
        kind: "doc",
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

/** 结果列表点击：已打开文档直接切过去定位；磁盘文件先打开再定位。 */
async function openFindHit(hit: FindHit): Promise<void> {
  if (hit.kind === "file") {
    await jumpToHit({
      path: hit.path,
      name: hit.name,
      line: hit.line,
      col: hit.col,
      text: hit.text,
    });
    return;
  }
  const insts = instancesOfDoc(hit.docId ?? -1);
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
    renderMarkdownFor(panel);
    // 预览从零开始渲染（scrollTop=0），按编辑器当前可见位置对齐，
    // 否则切到预览/切标签时永远停在文档开头。
    if (anchorLine > 1) panel.preview?.syncToLine(anchorLine);
  }
  // 从 display:none 恢复后 CM6 需要重新测量，否则编辑区空白
  panel.view?.view.requestMeasure();
}

/** 全量重渲染某面板预览（增量 patch 由 PreviewPane 内部处理）。 */
function renderMarkdownFor(panel: Panel): void {
  const preview = panel.preview;
  const tab = tabs.get(panel.activeTabId);
  if (!preview || !tab || !isMdTab(tab)) return;
  const doc = docOf(tab);
  preview.setBaseDir(doc.path ? dirname(doc.path) : null);
  preview.setBlocks(renderBlocks(tab.state.doc.toString()));
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
    sbLang.title = preview ? "切换到源码 (Ctrl+/)" : "切换到预览 (Ctrl+/)";
  } else {
    const doc = tab ? docs.get(tab.docId) : undefined;
    sbLang.textContent = doc?.langLabel ?? "Plain Text";
    sbLang.title = "";
  }
}

/** 主题按钮的活动态与日/月图标（深色→月亮，浅色→太阳）。 */
function refreshThemeButton(): void {
  btnTheme.classList.toggle("tool-btn-active", isDark);
  btnTheme.innerHTML = isDark ? ICONS.moon : ICONS.sun;
  btnTheme.title = isDark ? "切换为浅色主题" : "切换为深色主题";
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
  if (!tab || !isMdTab(tab)) {
    tocEntries = [];
    renderToc(tocPanel, [], -1, { onJump: () => {} });
    return;
  }
  tocEntries = extractToc(tab.state.doc.toString());
  const cursorLine = tab.state.doc.lineAt(tab.state.selection.main.head).number;
  renderToc(tocPanel, tocEntries, cursorLine, {
    onJump: (entry) => {
      const panel = activePanel();
      const tab2 = activeTab();
      if (!panel?.view || !tab2) return;
      const doc = docOf(tab2);
      const line = Math.min(Math.max(1, entry.line), tab2.state.doc.lines);
      const pos = tab2.state.doc.line(line).from;
      // 活动实例：视图定位 + 聚焦
      panel.view.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      tab2.state = panel.view.view.state;
      if (tab2.viewMode === "preview") panel.preview?.syncToLine(line);
      // 同文件的其他实例：选区同步写进快照（内容经 ChangeSet 广播保持一致，
      // 位置对全部实例有效）；可见实例同时滚动定位
      for (const inst of instancesOfDoc(doc.tabId)) {
        if (inst.tabId === tab2.tabId) continue;
        const p = panels.get(inst.panelId);
        if (p?.view && p.viewTabId === inst.tabId) {
          p.view.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
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

async function toggleTheme(): Promise<void> {
  // 直接在当前“已生效”的明暗之间切换：点一下必定改变外观。
  // 不再走 system→light→dark 循环——否则当系统偏好与当前态一致时，
  // system 这一档视觉无变化，表现为“要点两下才生效”。system 模式仍可在设置里选择。
  const nextMode: ThemeMode = isDark ? "light" : "dark";
  themeMode = nextMode;
  const dark = applyTheme(themeMode);
  if (dark !== isDark) applyDarkToTabs(dark);
  isDark = dark;
  refreshThemeButton();

  if (settings) {
    settings.theme = themeMode;
    try {
      await saveSettings(settings);
    } catch {
      // 配置写失败不应影响使用
    }
  }
}

// ---------------------------------------------------------------- 偏好（原设置对话框已分散到各菜单）

/** 主题三态（文件/查看菜单）：立即生效 + 持久化。 */
async function setThemeMode(mode: ThemeMode): Promise<void> {
  themeMode = mode;
  const dark = applyTheme(mode);
  if (dark !== isDark) applyDarkToTabs(dark);
  isDark = dark;
  refreshThemeButton();
  await persistSettings();
  showMessage(mode === "system" ? "主题：跟随系统" : mode === "dark" ? "主题：深色" : "主题：浅色");
}

/** 新建文件的默认行尾：以菜单按钮为锚点就地弹列表。 */
async function showDefaultEolMenu(anchor: HTMLElement): Promise<void> {
  let eols: string[] = [];
  try {
    eols = await listEols();
  } catch {
    // 取不到就用内置三档
  }
  if (eols.length === 0) eols = ["CRLF", "LF", "CR"];
  const current = settings?.default_eol ?? "CRLF";
  showPopupMenu(
    anchor,
    eols.map((e) => ({
      label: e,
      checked: e === current,
      onSelect: () => {
        if (!settings) return;
        settings.default_eol = e;
        void persistSettings();
        showMessage(`新建文件默认行尾：${e}`);
      },
    })),
  );
}

/** 新建文件的默认编码：同上，弹编码列表。 */
async function showDefaultEncodingMenu(anchor: HTMLElement): Promise<void> {
  let encodings: string[] = [];
  try {
    encodings = await listEncodings();
  } catch {
    // 取不到就只给 UTF-8
  }
  if (encodings.length === 0) encodings = ["UTF-8"];
  const current = settings?.default_encoding ?? "UTF-8";
  showPopupMenu(
    anchor,
    encodings.map((enc) => ({
      label: enc,
      checked: enc === current,
      onSelect: () => {
        if (!settings) return;
        settings.default_encoding = enc;
        void persistSettings();
        showMessage(`新建文件默认编码：${enc}`);
      },
    })),
  );
}

async function toggleAutosave(): Promise<void> {
  if (!settings) return;
  settings.autosave = !settings.autosave;
  await persistSettings();
  showMessage(settings.autosave ? "已启用自动保存" : "已停用自动保存");
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
  btnTheme.addEventListener("click", () => void toggleTheme());

  sbLang.addEventListener("click", () => {
    if (isMdActive()) toggleViewMode();
  });
  sbEncoding.addEventListener("click", () => void showEncodingMenu());
  sbEol.addEventListener("click", () => showEolMenu());

  window.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return;
    const key = e.key.toLowerCase();
    if (key === "o") {
      e.preventDefault();
      void doOpen();
    } else if (key === "n") {
      e.preventDefault();
      void newUntitled();
    } else if (key === "w") {
      e.preventDefault();
      const tab = activeTab();
      if (tab) void closeTabById(tab.tabId);
    } else if (key === "tab" || key === "pagedown") {
      e.preventDefault();
      cycleTabInPanel(1);
    } else if (key === "pageup") {
      e.preventDefault();
      cycleTabInPanel(-1);
    } else if (key === "/") {
      e.preventDefault();
      toggleViewMode();
    } else if (key === "f" && !e.shiftKey) {
      e.preventDefault();
      openFindReplace();
    } else if (key === "f" && e.shiftKey) {
      e.preventDefault();
      // 在文件中查找：同一个悬浮栏，切到「文件夹…」范围
      openFindBar("folder");
    } else if (key === "h") {
      e.preventDefault();
      openFindBar("doc", "replace");
    } else if (key === "s" && e.shiftKey) {
      e.preventDefault();
      void doSave(true);
    } else if (key === "s" && e.altKey) {
      e.preventDefault();
      void doSaveAll();
    } else if (key === "s") {
      e.preventDefault();
      void doSave(false);
    } else if (key === "g" && !e.defaultPrevented) {
      // 编辑器聚焦时 CM searchKeymap 会把 Ctrl+G 当「查找下一个」吃掉（已 preventDefault），
      // 此时跳过；否则打开「转到行」
      e.preventDefault();
      openGotoLine();
    } else if (e.code === "Equal") {
      e.preventDefault();
      void changeFontSize(1);
    } else if (e.code === "Minus") {
      e.preventDefault();
      void changeFontSize(-1);
    } else if (e.code === "Digit0") {
      e.preventDefault();
      void changeFontSize(null);
    }
  });

  // F3 / F5 / 查找步进：CM 聚焦时 F3/Shift+F3 由 searchKeymap 处理（已 preventDefault），跳过；
  // F5 必须拦截——WebView2 默认 F5 刷新页面
  window.addEventListener("keydown", (e) => {
    if (e.key === "F5") {
      e.preventDefault();
      insertTimeDate();
      return;
    }
    if (e.defaultPrevented) return;
    if (e.key === "F3") {
      e.preventDefault();
      findStep(e.shiftKey ? -1 : 1);
    }
  });

  // Alt 快捷键：菜单栏助记符 + 分屏
  window.addEventListener("keydown", (e) => {
    const combo = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.altKey && !combo && key === "f") { e.preventDefault(); return openMenuByIndex(0); }
    if (e.altKey && !combo && key === "e") { e.preventDefault(); return openMenuByIndex(1); }
    if (e.altKey && !combo && key === "v") { e.preventDefault(); return openMenuByIndex(2); }
    if (e.altKey && !combo && key === "h") { e.preventDefault(); return openMenuByIndex(3); }
    if (e.altKey && e.shiftKey && key === "arrowright") {
      e.preventDefault();
      if (activePanel()) splitActivePanel(activePanelId, "h");
    } else if (e.altKey && e.shiftKey && key === "arrowdown") {
      e.preventDefault();
      if (activePanel()) splitActivePanel(activePanelId, "v");
    }
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
  openFindBar("doc");
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
  if (!bar.isOpen()) openFindBar("doc");
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

/** 剪切/复制：聚焦编辑器内容区后走浏览器原生命令（WebView2 支持且写入系统剪贴板）。 */function clipboardOp(op: "cut" | "copy"): void {
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

// ---------------------------------------------------------------- 转到行（Ctrl+G）

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
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
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
  const next = !isWrap;
  applyWrapToTabs(next);
  if (settings) {
    settings.word_wrap = next;
    try {
      await saveSettings(settings);
    } catch {
      // 持久化失败不影响本次生效
    }
  }
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
    [btnTheme, "theme"],
  ];
  for (const [btn, name] of icons) btn.innerHTML = ICONS[name];
  refreshViewModeButton();
  refreshThemeButton();
}

/** 菜单栏初始化（文件/编辑/查看/帮助，结构参考 Win11 记事本）。 */
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
    onReplace: () => openFindBar("doc", "replace"),
    onFindInFiles: () => openFindBar("folder"),
    onGoto: () => openGotoLine(),
    onSelectAll: () => withView((v) => selectAll(v)),
    onTimeDate: () => insertTimeDate(),
    onToggleView: () => toggleViewMode(),
    onOutline: () => toggleToc(),
    onFoldAll: () => foldOperation(true),
    onUnfoldAll: () => foldOperation(false),
    onZoomIn: () => void changeFontSize(1),
    onZoomOut: () => void changeFontSize(-1),
    onZoomReset: () => void changeFontSize(null),
    onToggleWrap: () => void toggleWrapSetting(),
    wrapChecked: () => isWrap,
    onToggleStatusbar: () => toggleStatusbar(),
    statusbarChecked: () => statusbarVisible,
    onSplitH: () => {
      if (activePanel()) void splitActivePanel(activePanelId, "h");
    },
    onSplitV: () => {
      if (activePanel()) void splitActivePanel(activePanelId, "v");
    },
    onClosePanel: () => {
      if (activePanel()) closePanelById(activePanelId);
    },
    onToggleAutosave: () => void toggleAutosave(),
    autosaveChecked: () => settings?.autosave ?? true,
    onDefaultEol: (anchor) => void showDefaultEolMenu(anchor),
    onDefaultEncoding: (anchor) => void showDefaultEncodingMenu(anchor),
    themeChecked: (mode) => themeMode === mode,
    onSetTheme: (mode) => void setThemeMode(mode),
    lineHeightChecked: (v) => Math.abs((settings?.preview_line_height ?? 1.7) - v) < 0.05,
    onSetLineHeight: (v) => void setPreviewLineHeight(v),
    tocWidthChecked: (w) => tocWidth === w,
    onSetTocWidth: (w) => void setTocWidthValue(w),
    onKeymap: () => showKeymapDialog(),
    onAbout: () => {
      void ask("LiteMD v0.1.0\n轻量级 Markdown / 文本编辑器（Tauri 2 + CodeMirror 6）\n\n仅 Windows 平台。", {
        title: "关于 LiteMD",
        kind: "info",
        okLabel: "确定",
        cancelLabel: "关闭",
      });
    },
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
  console.error("[LiteMD] 启动错误：", err);
  try {
    (window as any).__TAURI_INTERNALS__?.invoke("frontend_ready", { detail: "fatal: " + msg }).catch(() => {});
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
    box.textContent += "⚠ LiteMD 启动出错：\n" + msg + "\n\n";
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
        { title: "退出 LiteMD", kind: "warning" },
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

  themeMode = normalizeMode(settings?.theme);
  isDark = applyTheme(themeMode);
  isWrap = settings?.word_wrap ?? true;
  applyFontSize(settings?.font_size ?? 14);
  applyPreviewLineHeight(settings?.preview_line_height ?? 1.7);
  setupTocResizer();
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

  // 从资源管理器拖入文件：WebView2 原生拖放（dragDropEnabled: true）→ 逐个打开。
  // 这是拿到真实文件路径的唯一方式（HTML5 file drop 只有内容没有路径），
  // 打开后保留磁盘关联（监听外部修改 / 会话恢复 / 直接保存）。
  void getCurrentWebview()
    .onDragDropEvent((ev) => {
      if (ev.payload.type === "drop") {
        for (const p of ev.payload.paths) void doOpen(p);
      }
    })
    .catch(() => {});

  // 尝试恢复上次会话；失败则退回空白未命名标签
  let restored = false;
  try {
    restored = await restoreSession();
  } catch {
    restored = false;
  }
  if (!restored) {
    panels.clear();
    tabs = new Map();
    docs = new Map();
    nextPanelId = 1;
    nextInstId = 1;
    panels.set(0, { panelId: 0, tabs: [], activeTabId: -1, view: null, viewTabId: null, preview: null, previewTimer: null, bodyEl: null });
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
    logEvent("session", `restored ${docs.size} docs / ${tabs.size} instances / ${panels.size} panels`);
  }

  try {
    rebuildLayout();
    bindEvents();
    refreshAll();
    const p = activePanel();
    p?.view?.focus();
    showMessage(
      restored
        ? "已恢复上次会话 · Ctrl+N 新建，Ctrl+O 打开，Ctrl+Shift+F 在文件中查找"
        : "就绪 · Ctrl+N 新建，Ctrl+O 打开，Ctrl+S 保存，Ctrl+Shift+F 在文件中查找",
    );
    void persistSession();

    try {
      await invoke("frontend_ready", {
        detail: `set_title=${diagSetTitle} dom_ok=true tabs=${tabs.size} panels=${panels.size}`,
      });
    } catch {
      // 诊断通道失败不影响正常运行
    }
  } catch (err) {
    // 渲染期异常不应让整个应用静默白屏：显示错误，且关闭处理器已提前注册
    showFatalError(err);
  }
}

void bootstrap();

// ⚠️ 官方 codicon 图标字体必须**排在本项目样式之前**：codicon.css 的
//    `.codicon[class*='codicon-']` 与本项目的 `.xxx .codicon` 特异性相同（都是 0-2-0），
//    谁在后谁生效 —— 先引它，才能让 global.css 里的字号覆盖说了算（如 `.panel-op .codicon`）。
//    字体文件（codicon.ttf）由 vite 打进 dist/assets，取用层见 src/shell/codicons.ts。
import "@vscode/codicons/dist/codicon.css";
// B227：内嵌默认字体的 `@font-face`（家族名 = Cascadia Mono / Noto Sans SC，见 fonts.css 头注）
import "./styles/fonts.css";
import "./styles/global.css";

// ChangeSet 既要当类型又要用运行时的 `ChangeSet.fromJSON`（跨窗口同步要还原对端的
// 变更集），所以这里不能写成 `type ChangeSet`。

import { initTooltips } from "./shell/tooltip";
import { ChangeSet } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitCrossWindow } from "./ipc/api";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import "katex/dist/katex.min.css";
import "./styles/preview.css";

// 标题栏左上角的软件图标（B99）：**直接引 exe 用的那份源图**，不往前端目录另存副本 ——
// 应用图标只有一个真相（scripts/gen_icons.py → src-tauri/icons/，bundle.icon 也取它），
// 复制一份出来迟早走样，而且没人会记得同步。Vite 会把它作为资源打进 dist 并给出 URL。
// ⚠️ B220 定档 24px（标题栏 34px 高，上下各余 5px）。
// B222：位图换成 docs/LitePad.png 的羽毛图（带深色圆角方底），由 scripts/make_icons.py 出图 ——
// 用户拍定标题栏也用带底版，任务栏 / 标题栏风格统一。gen_icons.py 的无底版那条链
// （write_app_mark / --app-mark）按用户要求保留，但不再是当前产物的来源。
// 为什么不用再分带底/无底两版：旧图标（折角文档+钢笔）方底三条边在标题栏上露脏边，
// 才拆出无底版；羽毛图自带圆角方块底且羽身为白色，深底在浅/深两种标题栏上都成立。

import {
  applyCodeFontFamily,
  applyDarkToTabs,
  applyEditorLineHeight,
  applyFontFamily,
  applyFontSize,
  applyPreviewLineHeight,
  applyPreviewWidth,
  applyTabActionReserve,
  applyTabStyle,
  applyUiFontFamily,
  rethemePreviews,
} from "./appearance";

import {
  discardOrphanBackups,
  // B218：编码候选带上语言分组（「中文（简体 / 繁体）」这类组名由后端那份列表带出）
  // B227：本机字体枚举项（Rust list_fonts 的负载）
  loadSettings,
  newTab as ipcNewTab,
  takePendingFiles,
  saveSession,
  windowPayload,
  type FileChangedPayload,
  type SatelliteTab,
  // B193：会话记录类型 —— 卫星标签要按 `owner` 分组还原成独立窗口，得拿到这份类型
  type WindowPayload,
} from "./ipc/api";
import { logger, syncLevel } from "./core/logger";
import { sessionStore } from "./session/store";
import { attachWheelZoom } from "./shell/zoom";
import { showSaveConfirmDialog } from "./shell/saveconfirm";
import { paletteOpen, showCommandPalette } from "./shell/commandpalette";
import { openMenuByIndex } from "./shell/menubar";
import {
  makeDoc,
  makeInstance,
  isDirtyVsBaseline,
  registerDoc,
  attachTabToPanel,
  isMdTab,
  isMdActive,
  setInstanceOnUpdate,
} from "./doc-model";
import {
  renderPanelTabs,
  renderPanelOps,
  rebuildLayout,
  closePanelById,
  splitActivePanel,
  moveActiveTabByDelta,
  focusPanelByDelta,
  toggleMaximizePanel,
  closeTabById,
  newUntitled,
  setApplyPanelMode,
  setOpenPreviewToSide,
  setToggleViewMode,
  setDiscardBackupFor,
  setScheduleSessionSave,
} from "./tabs";
import {
  scheduleMdRender,
  toggleViewMode,
  toggleDecoEdit,
  refreshViewModeButton,
  applyPanelMode,
  openPreviewToSide,
  toggleTaskInTab,
} from "./markdown";
// B397-1：所见即所得档交回宿主的两个动作（点勾 / 许不许写）在这里注入。
import { setDecoHooks } from "./spike/deco/wysiwyg";
import { openFindBar } from "./find/findbar";
import {
  setupSideBar,
  applySidebarVisible,
  toggleToc,
  updateTocDrawer,
  refreshTocAtCursor,
} from "./toc";
import { replayDrawer, setupSideResizer } from "./shell/drawer";
import {
  scheduleSessionSave,
  snapshotSession,
  persistSession,
  restoreSession,
  scheduleAutosave,
  scheduleBackup,
  cancelPendingBackup,
  flushBackups,
  discardBackupFor,
  handleFileChanged,
} from "./session/session";
import {
  doOpen,
  doSave,
  doSaveAll,
  showFileDropPreview,
  fileDropTargetAt,
  dropPosOf,
  landDroppedPaths,
  saveDocCore,
} from "./io/files";
import {
  acceptDroppedTabs,
  adoptTransferredTabs,
  applyBackupIds,
  applyTabsReturn,
  broadcastDocChange,
  broadcastSyncMode,
  dropOnDesktop,
  dropRemotedForOwner,
  listenDocSync,
  reclaimFromVanished,
  relinquishDrag,
  snapshotDrag,
} from "./multiwindow/windows";
import {
  loadPreferenceOptions,
  publishThemeMode,
  publishWindowKind,
  sanitizeKeymap,
  setupSettingsEntry,
  showEncodingPicker,
  showEolPicker,
} from "./prefs";
import { showLanguagePicker } from "./language-mode";
import {
  changeFontSize,
  cycleTabInPanel,
  findStep,
  foldCodeOperation,
  foldOperation,
  insertTimeDate,
  openFindReplace,
  openGotoLine,
  setupMenuBar,
  setupTitleBar,
  togglePin,
} from "./commands";
import { countLeaves } from "./core/layout";
import { commandById, normalizePresetId, resolveCommand, setKeymapPreset } from "./shell/keymap";
import { KEYMAP_RECORDING_CLASS } from "./shell/keymapdialog";
// B235：`PREVIEW_WIDTH_LABELS` 是宽度档的中文标签（提示气泡用），
// 与设置页那份同源 —— 别在手抄第二遍。
import {
  clearDropIndicators,
  commitTabDrop,
  previewDropAt,
  type DropSpot,
} from "./shell/splitview";
import { installTabDnd } from "./shell/tabdnd";
import {
  hasFileDropBridge,
  installFileDropTarget,
  installTreeFileDropTarget,
} from "./shell/filedrop";
import { applyTheme, normalizeFamily, normalizeMode, watchSystemTheme } from "./theme/theme";
import {
  Tab,
  Doc,
  tabs,
  docs,
  panels,
  layout,
  activePanelId,
  settings,
  keymapOverrides,
  themeFamily,
  themeMode,
  isDark,
  suppressDirty,
  docSyncOn,
  windowLabel,
  windowKind,
  syncingDocId,
  setTabs,
  setDocs,
  setNextPanelId,
  setNextInstId,
  setActivePanelId,
  setSettings,
  setKeymapOverrides,
  setThemeFamilyState,
  setThemeModeState,
  setIsDark,
  setIsWrap,
  setWindowLabel,
  setWindowKind,
  setSyncingDocId,
} from "./core/app-state";
import { EVT_APP_QUIT, EVT_DOC_OPEN_RESYNC, EVT_WINDOW_CLOSED } from "./core/events";
// B305：最近打开（store = 与 Rust 之间的那份缓存，panel = 左栏那块展开区）。
import { setupRecentsPanel } from "./recents/panel";
// B314：资源管理器。`setupExplorer` 装键并登记成外壳的第三块；`setRoot` 只把盘上那个根
// 搬进 store（**不走 panel 的 `openFolder`** —— 那条会顺手 saveSettings，而启动回放不该
// 把读到的值再写一遍，口径同 B312 的 `persist = false`）。
import {
  claimExplorerDrop,
  clearExplorerDropHover,
  closeFolder,
  markExplorerDropHover,
  promptOpenFolder,
  setupExplorer,
  toggleExplorer,
} from "./explorer/panel";
import { setupPathRewiring } from "./explorer/paths";
// B389：侧栏搜索视图（第四块展开区）。`setupSearch` 装输入区、结果树，并把自己登记进外壳；
// `openSearchView` 是「在文件中查找 / 替换」那两条命令的落点。
import { openSearchView, setupSearch } from "./search/panel";
import { setRoot as setExplorerRoot } from "./explorer/store";
import { initRecentsStore } from "./recents/store";
import type { WindowScrollPosition } from "./core/events";
import { activePanel, activeTab, instancesOfDoc } from "./core/panels";
import {
  applyHandedBackPositions,
  collectWindowPositions,
  setDocSyncMode,
} from "./sync-scroll/wire";
import { logViewport } from "./core/viewport";
import {
  bootMark,
  reportBoot,
  syncScrollBtn,
  winMinimize,
  winMaximize,
  winClose,
  winPin,
  sbEncoding,
  sbEol,
  sbLang,
  showMessage,
  updatePositionOf,
  refreshTitle,
  refreshSyncButton,
  refreshAll,
  diagSetTitle,
  panelOfView,
  setRefreshViewModeButton,
  setUpdateTocDrawer,
  setRenderPanelTabs,
  setRenderPanelOps,
} from "./ui";

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
  // B388：大纲的活动项跟的是「光标所在那一节」，光标点进正文、方向键走过章节都要跟着亮。
  // 只在活动面板上报，且真跨过章节才会重绘（闸在 toc.ts 的 refreshTocAtCursor）。
  if (update.selectionSet && panel.panelId === activePanelId) {
    refreshTocAtCursor(caretLine.number);
  }
  // 同步滚动不由这里推：位置联动只认 `scroll` 事件 + 期望账本（sync-scroll/coordinator），
  // 跨窗口那一份由协调器的外发口在「判成用户滚动」那一帧末尾发（B297）。
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

// 把编辑器更新回调注入 doc-model（解耦：makeInstance 不再直接依赖 main 的 handleUpdate）
setInstanceOnUpdate(handleUpdate);

// 把 main.ts 负责的四类渲染回调注入 ui.ts（避免 main ↔ ui 循环依赖）：
// 状态刷新（refreshStatus/refreshAll/markActivePanel）会经这些引用回调 main 的实现。
setRefreshViewModeButton(refreshViewModeButton);
setUpdateTocDrawer(updateTocDrawer);
setRenderPanelTabs(renderPanelTabs);
setRenderPanelOps(renderPanelOps);
// 把 markdown / session 的动作注入 tabs（打破 tabs↔markdown / tabs↔session 循环依赖）
setApplyPanelMode(applyPanelMode);
setOpenPreviewToSide(openPreviewToSide);
setToggleViewMode(toggleViewMode);
setDiscardBackupFor(discardBackupFor);
setScheduleSessionSave(scheduleSessionSave);

/**
 * 被点的那一颗 view 属于哪一格显示的实例。
 *
 * 不能拿「活动面板」凑：多面板挂着同一篇文档（分屏 / 拖出去过）时，被点的那一格
 * 未必是活动那一格，写错格 = 勾翻在另一份实例上（那份实例的 view 还会立刻显出来）。
 */
function panelViewTab(view: EditorView): Tab | undefined {
  for (const p of panels.values()) {
    if (p.view?.view === view) return tabs.get(p.viewTabId ?? p.activeTabId);
  }
  return undefined;
}

// B397-1 · 所见即所得档交回宿主的两个动作。装饰扩展活在**标签的 state** 里（一颗 view
// 轮流承载多份实例），所以只能晚绑定，不能在构造期闭包面板引用。
setDecoHooks({
  // 按**文档行号**调（行起=行止、岛内序号 0）：现方案那套「渲染面里第 N 个 `.md-task`」
  // 的换算在 B394-2 上把勾写到了别的行，而行号没有中间量，也就没有换算可错。
  onToggleTask: (view, line) => {
    const t = panelViewTab(view);
    if (t) toggleTaskInTab(t.tabId, line, line, 0);
  },
  canToggleTask: (view) => {
    const t = panelViewTab(view);
    const d = t ? docs.get(t.docId) : undefined;
    // B399：预览档是「禁止编辑的编辑模式」—— 点勾也是一次写，锁着的档位里不许发生。
    // （transactionFilter 会丢掉那一发，但先在这里挡住，免得画一次「点了没反应」。）
    return !!t && !!d && isMdTab(t) && !d.readonly && t.viewMode !== "preview";
  },
});

/** 把某实例的内容变更广播到同文档的其他实例（内容同源，内存一份）。 */
function syncDocInstances(src: Tab, changes: ChangeSet): void {
  if (changes.empty) return;
  setSyncingDocId(src.docId);
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
    // B397-1：这里**不再需要**给装饰预览面补一发桥 —— 所见即所得是每份实例自己的
    // `previewCompartment` 里的一档，跟着上面那个遍历一起变。原先那颗独立的只读镜像
    // 不是 `Tab` 实例、进不了这个遍历，才需要 `syncDecoMirrors` 补第二遍（连同它的
    // 归属闸、回声闸、重新播种），现在那一整类机械没有服务对象了。
  } finally {
    setSyncingDocId(null);
  }
}

// ------------------------------------------------------- 事件绑定

function bindEvents(): void {
  // 自建标题栏（B97）右侧三颗窗口控制键。关闭键走 close() 而不是 destroy()：
  // 前者会先过 onCloseRequested 的「脏文档确认 / 热退出」流程，后者直接销毁窗口。
  winMinimize.addEventListener("click", () => void getCurrentWindow().minimize());
  winMaximize.addEventListener("click", () => void getCurrentWindow().toggleMaximize());
  winClose.addEventListener("click", () => void getCurrentWindow().close());
  // 「钉在顶部」开关（B99）：都是「切换 + 回读」，逻辑见 togglePin。
  winPin.addEventListener("click", () => void togglePin());
  // B152：同步滚动开关（按**文档**记，B152）。B297 起这颗键真的管事：翻转即驱动本窗口的
  // 协调器，并广播给所有装着同一份文档的窗口 —— 开关是那份文档的属性，不是这个窗口的属性，
  // 所以「A 窗口点了关，B 窗口还在跟着滚」这一类分裂从此不成立。
  syncScrollBtn.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab) return;
    const on = !docSyncOn(tab.docId);
    setDocSyncMode(tab.docId, on);
    broadcastSyncMode(tab.docId, on);
    logger.debug("sync", `同步滚动 → ${on ? "开" : "关"} docId=${tab.docId}`);
    refreshSyncButton(tab);
  });

  // B365：状态栏文件类型做成可点（推翻 B233 的纯展示）—— 点开居顶快速选择换语言模式。
  // 仍然**不**在这颗上切视图：预览入口在标签区操作键 / Ctrl+/ / 菜单。
  sbLang.addEventListener("click", () => showLanguagePicker());
  // B366：编码 / 行尾与文件类型同款居顶快速选择（照 VS Code quick input）。
  sbEncoding.addEventListener("click", () => void showEncodingPicker());
  sbEol.addEventListener("click", () => showEolPicker());

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
    // B399：只在「装饰面」里成立（源码档没有预览/编辑之分）；不成时不抢键。
    case "view.toggleEdit": {
      const t = activeTab();
      return !!t && isMdTab(t) && t.viewMode !== "source";
    }
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
    case "file.openFolder":
      void promptOpenFolder();
      break;
    case "file.closeFolder":
      void closeFolder();
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
    case "edit.findInFiles":
      openSearchView();
      break;
    case "edit.replaceInFiles":
      openSearchView(true);
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
    case "view.toggleEdit":
      toggleDecoEdit();
      break;
    case "view.outline":
      toggleToc();
      break;
    case "view.explorer":
      toggleExplorer();
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
  setTabs(new Map());
  setDocs(new Map());
  setNextPanelId(1);
  setNextInstId(1);
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
  setActivePanelId(0);

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
  // B178：卫星干净关窗要告诉对端「本窗口没了」，对端据此把 `remoteOpenByWindow`
  // 里这条清掉 —— 否则主窗口那份同文档的同步键会一直亮着（其实卫星早就关了）。
  // 这一句只广播、不等回话；广播失败（已无对端）按「本来就该清」处理，不阻塞关窗。
  void emitCrossWindow(EVT_WINDOW_CLOSED, {}).catch(() => {});
  // B188：干净关窗要**显式**告诉主窗口「别把借出去的隐藏实例接回来」—— 用户明确不要交还。
  // 主窗口据此把 `remotedTabs` 里 owner=本窗口 的条目作废旧账（dropRemotedForOwner），
  // 而不是走崩溃兜底把它们恢复成可见标签。这条必须先于 `destroySelf()` 发：主窗口的
  // clean-close 处理落定后，Rust 的 `satellite-closed`(Destroyed) 才到，`reclaimFromVanished`
  // 那时已是空操作，不会把「关掉」的子窗口标签又接回主窗口。
  //
  // B302：随同一并发的是**本窗口屏上那份位置**（共享坐标 `v`，不是像素）。会话只有主窗口
  // 在写，卫星自己那些格的位置只能由它落进主窗口那一份记录里 —— 量不出位置的格子不进清单。
  void emit("satellite-clean-close", {
    label: windowLabel,
    positions: collectWindowPositions(),
  }).catch(() => {});
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
  void emitCrossWindow(EVT_APP_QUIT, {}).catch((e: unknown) => {
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

    // ---- 兜底：确认框（B67 及更早的行为，B236 起与关标签共用同一个三按钮框） ----
    // ⚠️ 走到这里时备份已经写过一轮（`flushBackups`），选「保存」仍要真写盘 ——
    // 热退出的承诺是「下次启动还原」，不是「写回磁盘」，两回事。
    const choice = await showSaveConfirmDialog({
      title: "退出 LitePad",
      names: dirty.map((d) => d.name),
    });
    if (choice === "cancel") {
      // 用户取消退出：把刚才为了 flush 而取消的排程还回去（内容还是脏的）
      scheduleBackup();
      return;
    }
    if (choice === "save") {
      // 逐个写盘。任何一个失败/被用户在保存冲突框里取消 ⇒ 整体中止退出，
      // 否则会出现「一半文档存了、一半随窗口一起没了」这种比全丢更难解释的结果。
      for (const d of dirty) {
        const inst =
          instancesOfDoc(d.tabId).find((t) => t.panelId >= 0) ?? instancesOfDoc(d.tabId)[0];
        if (!inst) {
          scheduleBackup();
          return;
        }
        if (!(await saveDocCore(d, inst, false))) {
          scheduleBackup();
          return;
        }
      }
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
    setSettings(await loadSettings());
  } catch {
    setSettings(null);
  }
  bootMark("settings");

  setKeymapOverrides(sanitizeKeymap(settings?.keymap ?? {}));
  // 预设必须在任何 effectiveKeys / resolveCommand 之前落地：它是键位基线，
  // 晚设置会让菜单、命令面板先按默认键位渲染一遍，表现为「预设没生效」。
  setKeymapPreset(normalizePresetId(settings?.keymap_preset));
  void loadPreferenceOptions();

  setThemeModeState(normalizeMode(settings?.theme));
  setThemeFamilyState(normalizeFamily(settings?.theme_family));
  setIsDark(applyTheme(themeMode, themeFamily));
  // 档位写进 <html data-theme-mode>（B97 前由顶栏那颗主题按钮承担）
  publishThemeMode();
  // 标签样式写进 <html data-tab-style>（B114；必须在任何标签渲染前落地）
  applyTabStyle(settings?.tab_style ?? "connected");
  // 标签操作槽位空位写进 <html data-tab-reserve>（B115，同上）
  applyTabActionReserve(settings?.tab_action_reserve_space ?? true);
  setIsWrap(settings?.word_wrap ?? true);
  applyFontSize(settings?.font_size ?? 14);
  applyFontFamily(settings?.font_family ?? "");
  applyCodeFontFamily(settings?.code_font_family ?? "");
  // B347：界面字体（只有外壳）。与另两栏一样必须在首绘前落地 —— 它动的是行盒里
  // 基线的位置，晚一步就是「标题栏/标签先跳一下再对齐」。
  applyUiFontFamily(settings?.ui_font_family ?? "");
  applyPreviewLineHeight(settings?.preview_line_height ?? 1.7);
  // B235：预览正文宽度档（缺省「全宽」）。改了它不影响任何测量 ——
  // 宽度只影响换行位置，不动视口锚点。
  applyPreviewWidth(settings?.preview_width ?? "full");
  applyEditorLineHeight(settings?.editor_line_height ?? 1.5);
  setupSideBar();
  // B353：按钮列底部那颗「设置」（字形 + 点击）。它不是抽屉视图，不参与下面的展开区回放。
  setupSettingsEntry();
  setupSideResizer();
  // B194 / B307 / B312：回放上次的展开区「开没开 + 开着的是哪一块」。
  // `persist = false` —— 只是把盘上的两格搬到 DOM。此刻登记进外壳的只有大纲那一块
  //（`setupRecentsPanel` 排在会话恢复之后），所以「上次开的是最近」这一块要等它自己
  // 登记那一刻由 `registerDrawerView` 补写 —— 见 drawer.ts 里那条 ⚠️。
  replayDrawer();
  // B198：回放整栏去留（同一口径，persist = false 免得把默认值固化成设置）。
  //   排在 setupSideBar 之后：那颗键的字形由 applySidebarVisible 写，先装才装得上。
  applySidebarVisible(settings?.sidebar_off ?? false, false);
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
        setIsDark(dark);
        applyDarkToTabs(dark, themeFamily);
        // mermaid / Shiki 只在渲染那一刻取色；系统明暗翻转也要重画一次
        //（手动换档那条路在 prefs 里已经这么做了，这里补上同款）。
        rethemePreviews();
      }
    },
  );

  // 外部修改事件：Rust watcher → file-changed → 自动刷新 / 冲突三选一
  void listen<FileChangedPayload>("file-changed", (e) => {
    const p = e.payload;
    if (p && typeof p.tabId === "number") handleFileChanged(p);
  }).catch(() => {});

  // B71 ④：跨窗口同源正文同步（主窗口与卫星窗口都要装，见 listenDocSync）
  // B297：同一个函数里还装了跨窗口同步滚动的外发口与两条监听（`sync-pos` / `sync-mode`）。
  // 这里**不再**往协调器推开关表（B304）：会话恢复那一步现在走 `setDocSyncMode` 这个唯一
  // 写点，map 与协调器一起翻 —— 事后补推的那一发排在 `restoreSession()` 之前，推的是空表，
  // 于是真机出现过「键灭着却还在同步」。
  listenDocSync();
  // B315：盘上的路径被资源管理器改了 ⇒ 文档、后端记录、「最近打开」和别的窗口都要跟着改账。
  // 每扇窗口都得装（发起方只有主窗口，但改账是各家内存各自的事），所以排在 windowKind 分支之前。
  setupPathRewiring();
  // B178：引导末尾问一圈「你们都开着哪些可见文档」—— 老窗口把当前集合重播一遍，
  // 新上线的窗口据此补齐 `remoteOpenByWindow`（否则它只知道自己开的，收不到老窗口
  // 已经开着的那些）。只发一次，不进刷新循环，不会形成回声环。
  void emitCrossWindow(EVT_DOC_OPEN_RESYNC, {}).catch(() => {});

  // 从资源管理器拖入文件（B91 改造）：wry 的原生拖放处理器已关闭（它做的两处劫持会把
  // 页面内 HTML5 拖放一起废掉，详见 `src-tauri/src/dropbridge.rs` 模块头），改由两层拼：
  //   · 悬停高亮：页面内 dragover 驱动（原生没了就没有 enter/over/leave 事件），
  //     坐标直接用 clientX/clientY；
  //   · 落地路径：页面把 File 对象交给 Rust，Rust 取回真实路径后 emit
  //     `tauri://drag-drop` —— 也就是下面这个 onDragDropEvent，载荷与原生逐字一致。
  //     （HTML5 file drop 本身只有内容没有路径，所以这一段必须过桥。）
  installFileDropTarget({
    preview: (x, y) => {
      showFileDropPreview(x, y);
      // B333-2：左栏那一块在编辑面板矩形之外，`spotAt` 算不出落点、什么也不画 ⇒ 补一条亮带。
      markExplorerDropHover(x, y);
    },
    // 与标签拖拽同一个清场出口：现在文件悬停也会画标签插入竖线，只清分屏预览会留残影。
    clear: () => {
      clearDropIndicators();
      clearExplorerDropHover();
    },
  });
  if (!hasFileDropBridge()) logger.warn("drop", "path bridge unavailable");

  // B24：落地按分区打开（标签条=在那一格插标签，中央=该面板，边缘=分屏）；单个 Markdown
  // 弹菜单选「打开文档 / 插入文件路径」。这里只处理 drop —— enter/over/leave 已由上面的
  // 页面内监听接管。
  void getCurrentWebview()
    .onDragDropEvent((ev) => {
      const p = ev.payload;
      if (p.type !== "drop") return;
      // 一条路径都没换回来 = 桥把那件事吞了（拖进来的是目录而运行时不给路径正是这一形）。
      // 不记这一行，用户那边只有一句「拖了没反应」，无从结案。
      if (p.paths.length === 0) logger.warn("drop", "桥回了 0 条路径：拖进来的东西没有可信的路径");
      const pos = dropPosOf(p.position);
      // B333：拖进来的是一条**目录**而落点又在资源管理器那一块 ⇒ 换成那个根，不去读盘当文件开。
      // 问的次序要紧：先问资源管理器认不认领，没认领才交回原来那一路（口径同落点判定本身）。
      void claimExplorerDrop(p.paths, pos.x, pos.y).then((taken) => {
        if (!taken) landDroppedPaths(p.paths, pos.x, pos.y);
      });
    })
    .catch(() => {});

  // B316-3：树里拖一条**文件**到面板区 = 与外部拖入完全同一路（打开 / 分屏 / 插标签）。
  // 不走宿主桥 —— 页面内的拖拽没有 `File` 对象，路径本来就在 `dataTransfer` 里。
  installTreeFileDropTarget({
    landable: (x, y) => fileDropTargetAt(x, y) !== null,
    preview: (x, y) => showFileDropPreview(x, y),
    clear: () => clearDropIndicators(),
    land: (path, x, y) => landDroppedPaths([path], x, y),
  });

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
    setWindowKind(me.kind);
    setWindowLabel(me.label);
  } catch {
    // 老版本后端 / 单窗口环境下拿不到身份应答：按主窗口走（退回 B71 之前的行为）
    setWindowKind("main");
  }
  // 身份一确定就落 CSS，赶在外壳绘制之前（见 publishWindowKind 的注释）。
  // ⚠️ 这条 fallback 意味着「拿不到身份的卫星窗口会按主窗口行事」——关窗时也会装上
  //    `registerWindowClose`。那是刻意退回 B71 之前的行为，不是新口径。
  publishWindowKind();

  // B144：级别以后端为准（它决定要不要落盘）。不 await —— 日志拿不到就按默认 info 继续，
  // 绝不能反过来卡住启动。
  // ⚠️ B298：这一句必须排在下面 `windowKind === "satellite"` 那条分支**之前**。卫星窗口在
  // 那条分支里 `return`，把它留在启动收尾等于「子窗口的前端永远停在默认 info」——而过滤
  // 发生在发 IPC 之前，于是子窗口所有 trace/debug 一条都进不了 `litepad.log`。真机
  // 17:39–17:41 那一轮：主窗口 456 行 sync trace、新窗口 0 行，可它明明在往外发位置
  // （主窗口那侧的 `远端推` 就是证据）。「拖出窗口建新窗口」正是只有子窗口看得见的那一段，
  // 缺了这些行就只能猜 —— 这一族因此反复修不动。
  void syncLevel();

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
  // B188：卫星窗口**干净关窗**时，主窗口把借给它那份隐藏实例作废旧账（而不是恢复成
  // 可见标签）。这条先于 Rust 的 `satellite-closed`(Destroyed) 到达，使崩溃兜底
  // `reclaimFromVanished` 落在已清空的 remotedTabs 上、成为空操作。卫星窗口自己的 label
  // 不会收到（事件跨窗口广播、自己那份被 `from === windowLabel` 过滤），故这里只挡回声。
  void listen<{ label?: string; positions?: WindowScrollPosition[] }>(
    "satellite-clean-close",
    (e) => {
      const lbl = e.payload?.label;
      if (!lbl || lbl === windowLabel) return;
      // 顺序要紧：先按 `remotedTabs` 把交还回来的位置落到那份隐藏实例的记录上，再作废旧账
      //（`dropRemotedForOwner` 一跑，那条记录就不存在了，位置也就没地方落了）。
      applyHandedBackPositions(lbl, e.payload?.positions ?? []);
      dropRemotedForOwner(lbl);
    },
  ).catch(() => {});

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
    setTabs(new Map());
    setDocs(new Map());
    setNextPanelId(1);
    setNextInstId(1);
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
      setActivePanelId(0);
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

  // B305 / B308：最近打开。装配的只是**视图**（缓存 + 左栏那块展开区）；记入不在这里，
  // 长在所有打开动作共用的那扇漏斗上（`io/files.ts` 的 `doOpen` → `noteOpened`），
  // 会话恢复走 `session/rebuild` 的 `open_file`、压根不经那扇 ⇒ 「恢复不算打开」。
  // 装配位置排在 `restoreSession()` 之后，与界面同侧、没有别的数据依赖。
  // ⚠️ **不 await**：面板是订阅式的，数据到了自然重画，启动链不必为一次 IPC 多等一拍。
  //    等这一拍会挪动启动期那几次会话落盘的相对次序（`tests/satellite-restore.test.ts`
  //    的落盘回环就是这么被顶偏的）—— 旁路功能不该改主干的时序。
  // 只给主窗口装：子窗口连左边栏都被 CSS 收掉了（Review Focus #5），装上去只有
  // 一份看不见的缓存和一条没人画的名单在跑；子窗口该做的记账在 `doOpen` 那一发，
  // 与本装配无关（每个窗口自己打开的文件自己报）。
  if (windowKind === "main") {
    void initRecentsStore();
    setupRecentsPanel();
    // B314：资源管理器排在同一处（同样只给主窗口，同样是「登记晚于启动回放」那一形 ——
    // 外壳在 `registerDrawerView` 里补写当前开合态，见 drawer.ts 那条 ⚠️）。
    // 根只在盘上真有值时才搬：空串走一遍 setRoot 等于白读一次盘、还留一条「读不了：」的错误。
    setupExplorer();
    const folderRoot = settings?.folder_root ?? "";
    if (folderRoot) setExplorerRoot(folderRoot);
    // B389：搜索排在同一处、同样只给主窗口。它排在 `setExplorerRoot` 之后不是偶然 ——
    // 搜索的范围判据问的就是资源管理器缓存里那个根（`store.ts` 的 `searchRoot`），
    // 根先搬进来，第一次重绘才知道该说「搜文件夹」还是「只搜已打开的文档」。
    setupSearch();
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

    reportBoot(`ready set_title=${diagSetTitle} tabs=${tabs.size} panels=${panels.size}`);
  } catch (err) {
    // 渲染期异常不应让整个应用静默白屏：显示错误，且关闭处理器已提前注册
    showFatalError(err);
  }
}

void bootstrap();

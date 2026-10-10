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
import { ChangeSet } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { redo, selectAll, undo } from "@codemirror/commands";
import { foldAll, foldCode, unfoldAll, unfoldCode } from "@codemirror/language";
import { convertFileSrc } from "@tauri-apps/api/core";
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
// ⚠️ B220 定档 24px（标题栏 34px 高，上下各余 5px）。
// B222：位图换成 docs/LitePad.png 的羽毛图（带深色圆角方底），由 scripts/make_icons.py 出图 ——
// 用户拍定标题栏也用带底版，任务栏 / 标题栏风格统一。gen_icons.py 的无底版那条链
// （write_app_mark / --app-mark）按用户要求保留，但不再是当前产物的来源。
// 为什么不用再分带底/无底两版：旧图标（折角文档+钢笔）方底三条边在标题栏上露脏边，
// 才拆出无底版；羽毛图自带圆角方块底且羽身为白色，深底在浅/深两种标题栏上都成立。
import appMarkUrl from "../src-tauri/icons/app-mark.png";

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
  applyWrapToTabs,
  normalizePreviewWidth,
} from "./appearance";

import { makeTabState } from "./editor/editor";
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
import { normalizeSizeClass, perfProfileFor } from "./editor/perf";
import {
  checkEncodable,
  discardBackup,
  discardOrphanBackups,
  exportFile,
  isUnicodeEncoding,
  listEncodings,
  listEols,
  listFonts,
  // B218：编码候选带上语言分组（「中文（简体 / 繁体）」这类组名由后端那份列表带出）
  // B227：本机字体枚举项（Rust list_fonts 的负载）
  type FontItem,
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
  // B193：会话记录类型 —— 卫星标签要按 `owner` 分组还原成独立窗口，得拿到这份类型
  type TabSession,
  type WindowPayload,
  type WindowSpot,
} from "./ipc/api";
import { buildExportHtml, printToPdf } from "./markdown/exporter";
import { renderFull, type TocEntry } from "./markdown/pipeline";
import { extractOutline } from "./markdown/outline";
import { logger, syncLevel } from "./core/logger";
import { sessionStore } from "./session/store";
import {
  createTocList,
  attachSideResizer,
  clampSideWidth,
  type TocListHandle,
  // B235：`SideResizerHandle` 类型随句柄变量一起删（设置页那个「大纲宽度」下拉
  //   移除后没人持有句柄了；拖拽靠 `attachSideResizer(...)` 的调用本身注册）。
} from "./markdown/toc";
import { attachWheelZoom } from "./shell/zoom";
import {
  createFindBar,
  type FindBarHandle,
  type FindBarQuery,
  type FindHit,
} from "./shell/findbar";
import { showExternalConflictDialog, showSaveConflictDialog } from "./shell/conflictdialog";
import { showSaveConfirmDialog } from "./shell/saveconfirm";
import { CODICONS, type CodiconName } from "./shell/codicons";
import { initTooltips, setTip } from "./shell/tooltip";
import { paletteOpen, showCommandPalette } from "./shell/commandpalette";
import { createMenuBar, openMenuByIndex, type EncodingMenuModel } from "./shell/menubar";
import { showPopupMenu, type MenuItem } from "./shell/menu";
import { bomTarget, withLanguageGroups } from "./encoding";
import {
  makeDoc,
  makeInstance,
  isDirtyVsBaseline,
  markClean,
  markDiskVersion,
  registerDoc,
  attachTabToPanel,
  isMdTab,
  isMdActive,
  setInstanceOnUpdate,
} from "./doc-model";
import {
  installTabDeps,
  renderPanelTabs,
  renderPanelOps,
  rebuildLayout,
  switchTab,
  pruneEmptyPanels,
  closePanelById,
  splitActivePanel,
  moveActiveTabByDelta,
  focusPanelByDelta,
  exitMaximize,
  toggleMaximizePanel,
  layoutForSession,
  freshTextOfDoc,
  splitPanelWithTab,
  moveTabToStrip,
  closeTabById,
  newUntitled,
} from "./tabs";
import {
  applyPanelMode,
  scheduleMdRender,
  toggleViewMode,
  openPreviewToSide,
  refreshViewModeButton,
  dirname,
  installMarkdownDeps,
  type PreviewFindSpec,
} from "./markdown";
import { countLeaves, leaf, type LayoutNode } from "./shell/layout";
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
// B235：`PREVIEW_WIDTH_LABELS` 是宽度档的中文标签（提示气泡用），
// 与设置页那份同源 —— 别在手抄第二遍。
import { showSettingsDialog, PREVIEW_WIDTH_LABELS } from "./shell/settingsdialog";
import { initUpdater, type UpdaterHandle } from "./shell/updater";
import { showAbout } from "./shell/about";
import {
  panelAt,
  zoneOf,
  clearAllDropPreviews,
  clearDropIndicators,
  commitTabDrop,
  previewDropAt,
  type DropSpot,
} from "./shell/splitview";
import { installTabDnd, type TabDragPayload } from "./shell/tabdnd";
import {
  hasFileDropBridge,
  installFileDropTarget,
  needsChoice,
  showFileDropChoice,
  type FileDropTarget,
} from "./shell/filedrop";
import { applyTheme, normalizeMode, watchSystemTheme, type ThemeMode } from "./theme/theme";
import {
  isSyncSource,
  applySyncToSibling,
  pushSyncToSiblings,
  rememberViewScroll,
  restoreViewScroll,
  measureAndKeepScroll,
  syncingCursorDocId,
} from "./sync-scroll";
import {
  Tab,
  Doc,
  Panel,
  tabs,
  docs,
  panels,
  layout,
  activePanelId,
  settings,
  keymapOverrides,
  eolOptions,
  encodingOptions,
  themeMode,
  isDark,
  isWrap,
  suppressDirty,
  suppressSyncPush,
  unmeasuredPanels,
  docSyncModes,
  windowLabel,
  windowKind,
  syncingDocId,
  loanedDocIds,
  setTabs,
  setDocs,
  setLayout,
  setNextPanelId,
  setNextInstId,
  setActivePanelId,
  setSettings,
  setKeymapOverrides,
  setEolOptions,
  setEncodingOptions,
  setThemeModeState,
  setIsDark,
  setIsWrap,
  setSuppressDirty,
  setWindowLabel,
  setWindowKind,
  setSyncingDocId,
  takePanelId,
} from "./core/app-state";
import {
  DocChangePayload,
  EVT_DOC_CHANGE,
  EVT_DOC_RESYNC_REQ,
  EVT_DOC_RESYNC_FULL,
  EVT_SYNC_MODE,
  EVT_SYNC_POS,
  SyncPosPayload,
  SyncModePayload,
  EVT_DOC_CLOSE_QUERY,
  EVT_DOC_CLOSE_HELD,
  DocClosePayload,
  EVT_APP_QUIT,
  EVT_DOC_OPEN,
  EVT_DOC_CLOSE_NOTIFY,
  EVT_DOC_OPEN_RESYNC,
  EVT_WINDOW_CLOSED,
  DocPresencePayload,
} from "./core/events";
import { getPanel, activePanel, activeTab, panelOfTab, docOf, instancesOfDoc } from "./core/panels";
import { viewportOfTab, logViewport, recordScroll } from "./core/viewport";
import {
  TEXT_FILTERS,
  LOSSY_ABORT,
  bootMark,
  reportBoot,
  el,
  menuBar,
  titleBar,
  appMark,
  syncScrollBtn,
  winMinimize,
  winMaximize,
  winClose,
  winPin,
  tocPanel,
  tocList,
  tocToggleAll,
  tocResizer,
  sideShell,
  sideOutline,
  tocGrip,
  sidebarToggle,
  mainRow,
  sbEncoding,
  sbEol,
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
import { remoteOpenByWindow } from "./core/app-state";

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
  // B176：被同源光标同步 dispatch 触发的一轮 `handleUpdate` 不反推 —— 否则非激活源会被
  //   拽回旧位置（A↔B 拉锯 / 非激活文档滚动抖）。光标仍由上面那发 dispatch 落到兄弟。
  if (!suppressSyncPush && isSyncSource(tab, panel) && syncingCursorDocId !== tab.docId)
    pushSyncToSiblings(tab);
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

// 把尚未拆出的下游函数注入 markdown.ts（避免 markdown → import main）：
// session 落盘 / find 预览查找 / toc 抽屉，#411–#413 拆出后逐个换成直接 import。
installMarkdownDeps({
  scheduleSessionSave,
  findSpecOf,
  applyPreviewFindToPanel,
  updateTocDrawer,
  getFindBar: () => findBar,
});

// 把尚未拆出的下游模块函数注入 tabs.ts（过渡期 DI，见 tabs.ts 文件头注释；
// #410–#415 拆出后逐个换成直接 import 并删除对应条目）。
installTabDeps({
  scheduleSessionSave,
  updateTocDrawer,
  retargetFindBar,
  applyPanelMode,
  toggleViewMode,
  openPreviewToSide,
  attachPasteHandler,
  openTabsInNewWindow,
  returnTabToMain,
  requestSatelliteClose,
  saveDocCore,
  discardBackupFor,
  docHeldElsewhere,
  keyHint,
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
  } finally {
    setSyncingDocId(null);
  }
}

// ------------------------------------------------------- B152 同步滚动模式

// B171：这里原先有 `sharedDocIds`（B164 加的），用来把「卫星窗口采纳的文档」也算成
// 「开着多份」，好让子窗口也能看到这颗键。已删 —— 主窗口手上那份是**隐藏实例**，
// 主窗口自己按 `instancesOfDoc` 数也只有 1 份、同样不显示这颗键；子窗口认它，就成了
// 「同文件没多开却显示关联按钮」，与主窗口口径不一致。现在两个窗口同口径：只看
// **本窗口内**这份文档的实例数（跨窗口的开关 / 位置广播不受影响，仍走 EVT_SYNC_*）。

/**
 * 把源的**位置**落到一份兄弟上（B152 位置那一路的四条纪律全在这一个函数里）。
 *
 * 本窗口那一路和跨窗口那一路调用的是**同一个**函数 —— 纪律只有一份，抄成两份
 * 迟早有一份漏掉「跨视图模式只能换算」那一条（B154 就栽在复制粘贴上）。
 */
// B170：滚动来源标记改走 `src/scroll-guard.ts`（合成 VS Code 的 `scrollType`）—— 程序定位
// 前 `markProgrammatic(el)`，scroll 监听见标记即吞，标记靠「用户接管滚动」的真实输入清除，
// 不比位置、不赌时序、无时间窗。下面 `applySyncToSibling` 的落点日志保留为 debug 诊断。

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
      setSuppressDirty(true);
      panel.view.setState(inst.state);
      setSuppressDirty(false);
      // B271：估算窗口开启（见 unmeasuredPanels）
      unmeasuredPanels.add(panel);
      panel.viewTabId = inst.tabId;
      // B126：整态重建把视口清零；保光标的场合（外部刷新）顺带把视口也保住
      if (keepCursor) restoreViewScroll(panel);
      // B271：估算窗口由 measureAndKeepScroll 的 rAF 关闭
      measureAndKeepScroll(panel);
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
        setActivePanelId(instPanel.panelId);
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
    if (panel.panelId !== activePanelId) setActivePanelId(panel.panelId);
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

// ---------------------------------------------------------------- 编码转换（B215）

/**
 * 「转换为…」「添加/移除 BOM」「行尾符转换」三类的共同出口：把目标编码/行尾写进
 * doc，然后走**一次原位保存**。
 *
 * 为什么复用保存、而不是另开一组转换命令：
 *   · 原子写、只读兜底、脏写检查（外部改过就不盖）、保存回声抑制，这些都已经在
 *     `save_file` 里兜住了；转换再自起一套就是把它们抄一遍，抄一次漏一次；
 *   · 不可逆保护同样是保存路径自带的 —— legacy 编码里无法映射的字符，
 *     `saveDocCore` 会自己去 `checkEncodable` 拦下并弹确认。
 *     ⚠️ 所以**必须先写 `doc.encoding` 再调它**：顺序反了等于绕过不可逆保护。
 *
 * @param next 只写要变的那一侧（都不传 = 空操作，调用方不该这么调）。
 * @returns 是否真的启动了保存（false = 被前置条件/用户拒绝挡回，字段没动）。
 */
async function convertDoc(next: { encoding?: string; eol?: string }): Promise<boolean> {
  const tab = activeTab();
  const doc = tab ? docOf(tab) : undefined;
  if (!doc || !tab) return false;

  const enc = next.encoding ?? doc.encoding;
  const eol = next.eol ?? doc.eol;
  if (enc === doc.encoding && eol === doc.eol) return false;

  // 转换 = 写盘，未命名文档没有落点可写
  if (!doc.path) {
    showMessage("该文件还没有关联磁盘路径，请先「另存为」保存一次再转换", true);
    return false;
  }
  // 转换会盖掉没保存的修改：先问一句，别替用户做这个决定
  if (isDirtyVsBaseline(doc, null)) {
    const ok = await ask(
      `有未保存的修改，转换为 ${enc} / ${eol} 会立即写盘并覆盖这些修改。继续吗？`,
      { title: "转换将写入磁盘", kind: "warning" },
    );
    if (!ok) return false;
  }

  const prevEnc = doc.encoding;
  const prevEol = doc.eol;
  doc.encoding = enc;
  doc.eol = eol;
  const ok = await saveDocCore(doc, tab, false);
  if (!ok) {
    // 保存被拒 / 冲突未覆盖 / lossy 取消：字段必须退回，否则状态栏会显示一个
    // 跟磁盘对不上的编码，下一次保存才悄悄写错字节。
    doc.encoding = prevEnc;
    doc.eol = prevEol;
    refreshAll();
    return false;
  }
  showMessage(`已转换为 ${doc.encoding} / ${doc.eol}`);
  logger.info("convert", `${doc.name} ${doc.encoding}/${doc.eol}`);
  return true;
}

/**
 * 主菜单「编码」与状态栏那颗键**共用**的一份菜单模型（B215）。
 *
 * ⚠️ 两边都从这里取，不接受第二份手抄的列表 —— 两份迟早差一项，而差的那一项
 *    表现就是「菜单里有、功能没接上」。
 */
function encodingMenuModel(): EncodingMenuModel {
  const tab = activeTab();
  const doc = tab ? docOf(tab) : undefined;
  const current = doc?.encoding ?? "";
  const currentEol = doc?.eol ?? "";
  // 没有活动文档时只有「解读编码」那一组还能操作，其余全置灰
  const canWrite = !!doc && !!doc.path;

  // 分组名按条目顺序对齐（后端那份列表里 group 排在 label 旁边，同序）
  const groups = encodingOptions.map((it) => it.group);
  const encodedIn = withLanguageGroups(
    encodingOptions.map((it) => ({
      label: it.label,
      checked: it.label === current,
      onSelect: () => void switchEncoding(it.label),
    })),
    groups,
  );
  const convertTo = withLanguageGroups(
    encodingOptions.map((it) => ({
      label: it.label,
      disabled: !canWrite,
      onSelect: () => void convertDoc({ encoding: it.label }),
    })),
    groups,
  );
  const addTarget = bomTarget(current, true);
  const removeTarget = bomTarget(current, false);
  const bom: MenuItem[] = [
    {
      label: "添加 BOM",
      disabled: !canWrite || addTarget === null,
      onSelect: () => void convertDoc({ encoding: addTarget ?? current }),
    },
    {
      label: "移除 BOM",
      disabled: !canWrite || removeTarget === null,
      onSelect: () => void convertDoc({ encoding: removeTarget ?? current }),
    },
  ];
  const eol = eolOptions.map((value) => ({
    label: value,
    checked: value === currentEol,
    disabled: !canWrite,
    onSelect: () => void convertDoc({ eol: value }),
  }));
  return { encodedIn, convertTo, bom, eol };
}

// ---------------------------------------------------------------- 状态栏菜单

/**
 * 状态栏那颗「编码」键的菜单（B219）：只把**常用那几条**平铺在顶层，后面接 BOM 两项
 * 与「转换行尾符▸」。状态栏是「顺手看一眼当前编码 + 切到最常用的那几种」的地方，
 * 摊 40 条全量两级进去反而没人点得到。主菜单「编码」那条**不动**：那里才是全量。
 *
 * ⚠️ 常用集只认后端下发的 `common` 字段（在 `encodingOptions` 上过滤），**不许**在
 *    前端另写一份标签白名单 —— 又一张表，迟早差一条，差的表现就是「菜单里没有它」。
 * ⚠️ 这里也不再复用 `encodingMenuModel().encodedIn / convertTo`：那两路是给主菜单的
 *    摆法（首组内联 + 其余组子菜单），跟这里要的「常用平铺」不是一回事；BOM 与行尾
 *    符仍然同取 `encodingMenuModel()` 那一份，别在两边各写一遍。
 */
function showEncodingMenu(): void {
  const tab = activeTab();
  const doc = tab ? docOf(tab) : undefined;
  if (!doc) return;

  const current = doc.encoding ?? "";
  const common = encodingOptions
    .filter((it) => it.common)
    .map((it) => ({
      label: it.label,
      checked: it.label === current,
      onSelect: () => void switchEncoding(it.label),
    }));
  const model = encodingMenuModel();
  showPopupMenu(sbEncoding, [
    ...common,
    { separator: true },
    ...model.bom,
    { separator: true },
    { label: "转换行尾符", submenu: model.eol },
  ]);
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
    setSuppressDirty(true);
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
    setSuppressDirty(false);
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
    // B169：同步滚动开关是 `docSyncModes`（按文档记，B152）里的值，退出前刷进记录，
    // 落盘后重开时由 `restoreSession` 写回，让同步键点亮态与退出前一致。
    sessionStore.setSyncMode(t.tabId, docSyncModes.get(t.docId) === true);
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
  // B193：卫星标签**不再并回主窗口** —— 按 `owner` 分组，各组还原成一个**真实的卫星
  // 窗口**（分组与开窗见下方 `restoreSatellites`）。v1 把它们 append 进 `sp[0].tabs`，
  // 于是「拖到子窗口的标签」重启后全跑回主窗口，多窗口布局丢得干干净净 —— 那正是
  // 用户报的「satelliteTabs 没有按照卫星窗口方式进行恢复」。
  const satTabs = sess.satelliteTabs ?? [];
  if (!sp.some((p) => p.tabs.length > 0) && satTabs.length === 0) return false;
  const panels0 = sp;

  panels.clear();
  setTabs(new Map());
  setDocs(new Map());
  setNextPanelId(1);
  setNextInstId(1);

  // 会话面板索引 → 真实面板 id（随布局树叶子创建）
  const idMap = new Map<number, number>();

  function ensurePanel(idx: number): LayoutNode {
    let realId = idMap.get(idx);
    if (realId === undefined) {
      realId = takePanelId();
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
    setLayout(buildTree(sess.layout));
  } catch (e) {
    // 布局树解析失败 = 整个会话没法照原样摆回去，此时继续恢复标签只会得到一堆
    // 位置错乱的面板 —— 退回空白标签。但「为什么整份都不要了」必须留下来（B147）。
    logger.warn("session", `布局树解析失败 · 整份会话作废：${String(e)}`);
    return false;
  }
  // 会话面板没全部落到布局树（索引越界等）→ 追加水平分屏兜底
  for (let i = 0; i < panels0.length; i++) {
    if (!idMap.has(i)) {
      setLayout({ kind: "split", dir: "h", ratio: 0.5, a: layout, b: ensurePanel(i) });
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
  // 主窗口各面板的标签 **+ B193 卫星标签**：按身份去重后统一下去预取，两边共用同一份
  // 缓存（同一个文件同时开在主窗口和卫星窗口时只读一次盘）。
  for (const st of [...panels0.flatMap((p) => p.tabs), ...satTabs]) {
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

  /**
   * 按一条会话记录建实例（文档按需创建、同源复用），并把光标 / 视图模式 / 视口 /
   * 同步开关一并带回去。主窗口面板与 B193 卫星标签**共用这一条** —— 副本优先、
   * 按身份去重、光标恢复这些口径必须完全一致，写两遍就会悄悄分叉。
   *
   * `panelId = -1` = **隐藏实例**：不进任何面板（标签条上看不见），是卫星标签
   * 交给窗口前的暂存态；等 `openTabsInNewWindow` 接手后经 `remoteTabLocally`
   * 登记成「已借出」，才会进会话的 `satelliteTabs` 段。
   */
  function buildInstance(st: TabSession, panelId: number): Tab | null {
    const hit = restoredCache.get(identityOf(st));
    if (!hit) return null;
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
    const inst = makeInstance(doc, panelId, src.text);
    tabs.set(inst.tabId, inst);
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
    // B169：同步滚动开关（按文档记）→ 写回 `docSyncModes`，同步键点亮态与退出前一致
    if (st.syncMode) docSyncModes.set(inst.docId, true);
    return inst;
  }

  // 逐面板恢复标签
  let opened = 0;
  for (let i = 0; i < panels0.length; i++) {
    const spanel = panels0[i];
    const panel = panels.get(idMap.get(i)!);
    if (!panel) continue;
    for (const st of spanel.tabs) {
      try {
        const inst = buildInstance(st, panel.panelId);
        if (!inst) continue;
        panel.tabs.push(inst.tabId);
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

  // B193：卫星标签 → 按 `owner` 分组，各组先落成隐藏实例（下一步交给一个真实卫星窗口）
  const satGroups: Array<{ owner: string; tabIds: number[] }> = [];
  {
    const byOwner = new Map<string, number[]>();
    for (const st of satTabs) {
      // 旧会话没有 `owner` 字段 → 整批归到同一组（退回「一个卫星窗口」的口径）
      const key = st.owner ?? "";
      try {
        const inst = buildInstance(st, -1);
        if (!inst) continue;
        const g = byOwner.get(key);
        if (g) g.push(inst.tabId);
        else byOwner.set(key, [inst.tabId]);
        opened++;
      } catch (e) {
        dropped.push(`${st.path || "未命名"}：恢复卫星实例失败（${String(e)}）`);
      }
    }
    for (const [owner, tabIds] of byOwner) satGroups.push({ owner, tabIds });
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
    setTabs(new Map());
    setDocs(new Map());
    return false;
  }

  setActivePanelId(idMap.get(sess.activePanel) ?? [...panels.keys()][0]);
  if (!panels.has(activePanelId)) setActivePanelId([...panels.keys()][0]);
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
  // B193：卫星标签交给真实卫星窗口（一组一个）。**不 await** —— 开窗要等新窗口就绪
  // 应答（每个最长 6s），串行等下去会把主窗口一起拖住；异步起跑，主窗口立即可用。
  if (satGroups.length > 0) {
    logger.info("session", `恢复 ${satGroups.length} 个卫星窗口（${satTabs.length} 个标签）`);
    void restoreSatelliteWindows(satGroups);
  }
  return true;
}

/**
 * B193：把会话里的卫星标签交给**真实的卫星窗口**（一个 owner 组 → 一个窗口）。
 *
 * 标签在 `restoreSession` 里已先落成隐藏实例（`panelId = -1`），这里只负责把它们
 * 送进窗口 —— 走的是和用户手动「拖到新窗口」完全相同的 `openTabsInNewWindow`，
 * 于是快照、跨窗口交接、`remotedTabs` 登记、会话回写这些口径天然一致。
 *
 * ⚠️ **兜底是必须的**：`openTabsInNewWindow` 失败时（建窗被拒 / 就绪超时）它**不会**
 * 摘掉本地标签 —— 那些实例此刻仍是隐藏态（panelId = -1 且没进 `remotedTabs`）：
 * 既不在任何面板里、也写不进会话 ⇒ 用户的字会凭空消失。所以每批跑完必须把
 * 「没被接走」的隐藏实例收回主窗口（退回 v1 的并回口径，至少不丢内容）。
 */
async function restoreSatelliteWindows(
  groups: Array<{ owner: string; tabIds: number[] }>,
): Promise<void> {
  for (const g of groups) {
    try {
      await openTabsInNewWindow(g.tabIds);
    } catch (e) {
      // ⚠️ 必须兜住：这条链上任何一处抛异常都会跳过 `remoteTabLocally`，若不接住，
      // 整批标签就停在隐藏态（不进面板、也不写会话）⇒ 用户的字凭空消失，
      // 而且一组失败会连带拖死后面所有分组。
      logger.error("window", `恢复卫星窗口失败（${g.tabIds.length} 个标签）：${String(e)}`);
    }
    for (const tabId of g.tabIds) {
      const t = tabs.get(tabId);
      // 还挂在 -1 且没被登记成「已借出」⇒ 窗口没接走 → 收回主窗口
      if (t && t.panelId === -1 && !remotedTabs.has(t.docId)) reclaimRemoted(tabId);
    }
  }
  rebuildLayout();
  refreshAll();
  scheduleSessionSave();
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
  if (!persist || !settings) return;
  settings.toc_open = open;
  void saveSettings(settings).catch(() => {
    // 持久化失败不影响本次生效（与分隔条回写宽度同一口径）
  });
}

function toggleToc(): void {
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
  //       ⚠️ `onJump` 保持内联在 render 的这一份参数里：`tests/sync-scroll-mode.test.ts`
  //          的静态契约按 `onJump: (entry) => {` 这句原文切片，提成具名函数会整段失配。
  tocListView.render(tocEntries, cursorLine, {
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
      // 仅当该文档开启了同步滚动（docSyncModes）才把大纲跳转广播给同文档其它实例；
      // 未关联同步滚动时大纲只影响激活实例（用户诉求：多开不同步则各自独立滚动）。
      // 守卫口径与 pushSyncToSiblings 保持一致（tab2.docId）。
      if (docSyncModes.get(tab2.docId) === true) {
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
      }
      panel.view.focus();
      updateTocDrawer();
    },
  });
  // B209：重绘后 `branchIds` 是新的（换文档/改标题都会变），合并键要按新分支表刷一次，
  // 否则它会停在上一份文档的「已全折」状态上（图标显示展开，点下去却还是折叠）。
  refreshTocToggleAll();
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

/** 未知档位一律落「全宽」（B235 的默认口径，也是最不容易显得窄的那档）。 */

/** 预览正文宽度：写 :root 上的 --md-content-max，`.md-preview .md-block` 通过 var() 生效。 */

/** 编辑器行距：写 :root 上的 --editor-line-height，.cm-content 通过 var() 生效。 */

/**
 * B227：本机字体清单缓存（Rust `list_fonts`）。
 *
 * 枚举要走 GDI、返回上百条，**只在打开设置页时取一次**并留着：设置页里来回切
 * 等宽/全部两栏是纯前端过滤，不该反复过 IPC。取不到就留空数组，设置页会退回
 * B225 那份手抄清单（见 `fontOptionsFor`），不会把那一栏变空。
 */
let systemFontsCache: FontItem[] = [];

async function ensureSystemFonts(): Promise<void> {
  if (systemFontsCache.length) return;
  try {
    systemFontsCache = await listFonts();
  } catch (err) {
    logger.warn("settings", `枚举本机字体失败，设置页退回内置清单 ${String(err)}`);
  }
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
    if (list.length > 0) setEolOptions(list);
  } catch {
    // 保持内置三档
  }
  try {
    const list = await listEncodings();
    if (list.length > 0) setEncodingOptions(list);
  } catch {
    // 保持空列表：宁可这一刻菜单里一条不列，也不塞一份自造的兜底清单
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
  setThemeModeState(mode);
  // ⚠️ **必须写回 settings，否则根本存不下来**（B79 用户实测：每次打开都是深色）。
  // 根因：persistSettings() 存的是整个 settings 对象，而启动时读的是 `settings.theme`
  // （main 里 `themeMode = normalizeMode(settings?.theme)`）。其它每一项设置都会在这里写回
  // 自己的字段，唯独主题漏了 —— 于是落盘永远是启动时那个 "system"，深色系统上解析成深色，
  // 表现为「主题设了、重启就丢」。写回之后紧跟的 persistSettings() 才真正把它存下去。
  if (settings) settings.theme = mode;
  const dark = applyTheme(mode);
  if (dark !== isDark) applyDarkToTabs(dark);
  setIsDark(dark);
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
  setKeymapOverrides(next);
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

/** B235：预览正文内容区宽度档（设置页三选）。管的是**正文居中宽度**，不是分屏比例。 */
async function setPreviewWidth(kind: string): Promise<void> {
  const k = normalizePreviewWidth(kind);
  applyPreviewWidth(k);
  if (settings) {
    settings.preview_width = k;
    await persistSettings();
  }
  showMessage(`预览宽度 ${PREVIEW_WIDTH_LABELS[k]}`);
}

// ⚠️ B235：原先这里有个 `setTocWidthValue()`（大纲宽度的「程序化设置」入口，
//    设置页那个三选下拉专用）—— 设置项删除后**没有调用方了，已一并删掉**
//    （`tsc` 的 `noUnusedLocals` 会拦死代码，说明项目不留无主函数）。
//    调大纲宽度现在只有一条路：左侧栏的拖拽分隔条，其 `onChange` 里已经做完
//    「夹取 → 同步 sideWidth → 回写 `settings.toc_width`」这三步
//    （见上面 `setupSideResizer`）。真要加命令入口，从那里复用。

/** B231：正文字体族（设置页；只作用于预览模式正文，空串 = 内置思源黑体）。 */
async function setFontFamily(family: string): Promise<void> {
  applyFontFamily(family);
  if (settings) {
    settings.font_family = family.trim();
    await persistSettings();
  }
  showMessage(family.trim() ? `正文字体 ${family.trim()}` : "正文字体：默认");
}

/**
 * B231：代码字体（设置页「代码字体」那一栏；空串 = 内嵌 Cascadia Mono）。
 * 作用于**编辑器源码区 + 预览里的行内代码/代码块**。
 */
async function setCodeFontFamily(family: string): Promise<void> {
  applyCodeFontFamily(family);
  if (settings) {
    settings.code_font_family = family.trim();
    await persistSettings();
  }
  showMessage(family.trim() ? `代码字体 ${family.trim()}` : "代码字体：默认");
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
  setIsWrap(on);
  applyWrapToTabs(on);
  if (settings) {
    settings.word_wrap = on;
    await persistSettings();
  }
}

/** 打开统一设置页（文件 → 设置…）。 */
async function openSettingsDialog(): Promise<void> {
  // B227：字体两栏的候选来自本机枚举 —— 先取回再开页，免得用户看到空列表。
  //
  // B239：这里原先是「发起枚举但不等它」（`void`）就开页，而设置页是**同步**建好
  // 每一个分类页的（见 settingsdialog 的 buildPage），字体行在那一刻读 `systemFonts()`
  // 读到的还是空数组 ⇒ `fontOptionsFor` 退回 B225 那份**手抄 17 条全等宽**清单，
  // 而缓存回来后没有任何重建机制 ⇒ 整轮会话字体列表都是错的（要关掉设置页再开一次
  // 才对）。**枚举类数据必须在开页前 await 到位**，这一类假绿不会再有第二次。
  // 实测本机枚举 114 条耗时 10ms，等一下完全无感。
  await ensureSystemFonts();
  showSettingsDialog({
    theme: () => themeMode,
    onTheme: (mode) => void setThemeMode(mode),
    fontFamily: () => settings?.font_family ?? "",
    onFontFamily: (family) => void setFontFamily(family),
    // B227：代码字体（预览 code/pre），与正文那条分开设
    codeFontFamily: () => settings?.code_font_family ?? "",
    onCodeFontFamily: (family) => void setCodeFontFamily(family),
    // 本机字体枚举结果（懒取一次，见 ensureSystemFonts）
    systemFonts: () => systemFontsCache,
    fontSize: () => currentFontSize(),
    onFontSize: (px) => void setFontSizeValue(px),
    editorLineHeight: () => settings?.editor_line_height ?? 1.5,
    onEditorLineHeight: (v) => void setEditorLineHeight(v),
    previewLineHeight: () => settings?.preview_line_height ?? 1.7,
    onPreviewLineHeight: (v) => void setPreviewLineHeight(v),
    // B235：预览正文宽度档（顶掉了原先的「大纲宽度」设置项）
    previewWidth: () => normalizePreviewWidth(settings?.preview_width),
    onPreviewWidth: (v) => void setPreviewWidth(v),
    defaultEol: () => settings?.default_eol ?? "CRLF",
    eolOptions: () => eolOptions,
    onDefaultEol: (v) => void setDefaultEol(v),
    defaultEncoding: () => settings?.default_encoding ?? "UTF-8",
    // 设置页那颗下拉只要 label（它是扁平一屏，不需要语言分组）
    encodingOptions: () => encodingOptions.map((e) => e.label),
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

  // B233：状态栏语言项不再兼视图切换器（见 refreshViewModeButton 的注释），
  // 那颗纯展示、不挂 click。切换入口在标签区操作键 / Ctrl+/ / 菜单。
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
 * B192：拖动由 `setupTitleBar` 自己接管（mousedown 记起点 + 首个越过 3px 阈值的 mousemove
 * → `startDragging` 交给系统移动循环），
 * **不**走 Tauri 的 `data-tauri-drag-region`（吞 mouseup ⇒ 窗口卡在移动循环，Tauri #10767），
 * 也**不**走 WebView2 的 `app-region: drag`（第一下移动发涩 —— B191 试过，已否掉）。
 * 双击最大化随之由本文件自己接（原来那份是 drag.js 顺带做的）。
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
  // B192：拖动窗口 —— **自己接管**，按下后一旦真的移动就交给系统模态循环。
  //
  // 为什么不等平台方案，而是自己接：
  //   · Tauri 的 `data-tauri-drag-region` 在 mousedown 当刻就调 startDragging，虽然跟手，
  //     但它会吞掉 mouseup、并把「点一下」也送进系统移动循环 —— 异步下窗口会卡在循环里
  //     跟着鼠标走（Tauri #10767，用户实测复现）；
  //   · WebView2 原生 `app-region: drag`（B191 那版）倒是没这条问题，可 Chromium 要等
  //     检测到移动才把拖动交给窗口、首次还有跨进程开销 ⇒ 体感是「第一下移动发涩」。
  // 于是取两家之长：**纯点击完全不碰拖拽**（绕开 #10767 的触发条件），
  // **而一旦移动就立刻 startDragging**（系统接管，与 B191 之前一样跟手）。
  // ⚠️ 阈值取 3px：鼠标一次正常拖动远大于它，体感无延迟；又能吃掉按下时的手抖，
  //    免得「点一下把窗口挪了 1px」。阈值 0 在真机复现过「窗口粘鼠标」（手抖 1px 就起拖，
  //    而这一次按下的松开早于起拖请求被处理 ⇒ 进移动循环后等不到 WM_LBUTTONUP），故回到 3px。
  const DRAG_THRESHOLD_PX = 3;
  titleBar.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return; // 只认左键
    // 按钮 / 可点元素自己有语义，不能顺带把窗口拖走
    if ((e.target as HTMLElement | null)?.closest("button")) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;
    const cleanup = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    const onMove = (ev: MouseEvent): void => {
      if (started) return;
      // 「位移 ≤ 阈值」= 还没真的开始拖；阈值 0 ⇒ 只要动了哪怕 1px 就往下走。
      if (
        Math.abs(ev.clientX - startX) <= DRAG_THRESHOLD_PX &&
        Math.abs(ev.clientY - startY) <= DRAG_THRESHOLD_PX
      )
        return;
      started = true;
      cleanup();
      // 交给系统：调 Rust 看门狗命令 `watchdog_start_drag` —— 它内部启动系统拖动，
      // 并起一条线程兜底：一旦左键抬起而 OS 模态循环仍卡在「跟随鼠标」状态
      // （Tauri #10767 的残余竞态，3px 阈值封不住的快速移动+抬起场景），就主动
      // 给窗口投 WM_LBUTTONUP 把循环打断。3px 阈值仍是决策门，纯点击零位移不进这里。
      void invoke("watchdog_start_drag").catch((err: unknown) => {
        logger.debug("window", `开始拖动窗口失败：${String(err)}`);
      });
    };
    const onUp = (): void => cleanup();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  // B191：双击标题栏空白处 = 最大化 / 还原。
  //
  // 这条原先是 Tauri 的 drag.js 顺带做的（`data-tauri-drag-region` 那套），拖动改由
  // 上面的 mousedown 自己接管之后没人管了，必须自己接。
  // ⚠️ 落在**按钮上**的双击不算：菜单键 / 置顶键 / 同步键 / 窗口三键自己有 click 语义，
  //    跟着最大化一次就变成「点菜单顺带把窗口最大化了」。
  titleBar.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement | null)?.closest("button")) return;
    void getCurrentWindow().toggleMaximize();
  });
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
    // ---- 编码（B215：主菜单「编码」四组 + 状态栏那颗键同取这一份） ----
    encodingMenu: () => encodingMenuModel(),
    // ---- 设置（B106：统一设置页，含原首选项与快捷键分类） ----
    // B239：开页前要 await 字体枚举，所以这里是 async 包 void（menubar 契约仍是无参无返回）
    onSettings: () => void openSettingsDialog(),
    // ---- 帮助 ----
    // B107：手动检查更新（结果走状态栏；静默检查失败不打扰，见 src/shell/updater.ts）
    onCheckUpdate: () => void updaterHandle?.checkNow(),
    onAbout: () => {
      void showAbout();
    },
    // B211：帮助 → 切换开发人员工具。单键切换由 Rust 侧判（那边才知道窗在不在：
    // WebView2 的 is_devtools_open 恒为假、close_devtools 是空实现，前端问不出状态）。
    onToggleDevtools: () => {
      void invoke("toggle_devtools").catch((err: unknown) => {
        logger.error("menubar", `切换开发人员工具失败 ${String(err)}`);
      });
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
    // B169：同步滚动开关一起带走——否则主窗口开着同步、子窗口收下后按钮还是灭的，
    // 两边状态对不上（用户报「子窗口的同步按钮状态和主窗口的要一致」）。
    syncMode: docSyncModes.get(tab.docId) === true,
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
    // B169：主窗口那份文档若开着同步滚动，接手的卫星窗口也得认这个状态 —— 否则
    // 卫星窗口的同步键灭着、主窗口亮着，状态对不上。这里只改本地 `docSyncModes`
    // （单向，不落盘），跨窗口那一笔仍走 `EVT_SYNC_MODE` 保双方一致。
    if (st.syncMode) docSyncModes.set(st.docId, true);
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
  // 空了的卫星窗口自己关掉：留一个没有标签的窗口没有意义（关窗即真关，不交还，见 B188）。
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
 * ⚠️ 关窗即**真关**：既不把标签交回主窗口，也不广播「文档关掉了」。没关的文件标签本就
 * 在主窗口留着一份隐藏实例（从主窗口分出去时没摘），由它接着管；未保存内容改由热退出
 * 副本兜住（`finishSatelliteClose` 里那两条），不依赖任何交还。这是 B188 起钉死的口径：
 * 用户明确「子窗口关闭时不需要将其中的标签接回」，与 B155 点 X 那档同款（见
 * `registerSatelliteClose` 注释）。
 */
function requestSatelliteClose(): void {
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
 * 命中条件：卫星窗口死了、却没走过 `finishSatelliteClose` 那条干净关窗链（所以
 * `satellite-clean-close` 没发、`remotedTabs` 里还留着这份 owner 的条目）。正常关窗
 * 走 `finishSatelliteClose` → 发 `satellite-clean-close` → 主窗口 `dropRemotedForOwner`
 * 已把 `remotedTabs` 清空，这里落到时就是空操作，不会把用户「关掉」的子窗口标签又接回来
 * （B188）。真正命中只有崩溃 / 被杀这类够不到前端收尾的路径 —— 那时把隐藏实例恢复成
 * 可见标签，至少让用户看得见、能继续编辑（代价是最后一次未交还的编辑不在，副本仍能兜住）。
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
 * 主窗口：卫星窗口**干净关窗**时，把借给它那份隐藏实例作废旧账（B188）。
 *
 * 与 `dropRemotedDoc` 同口径（删标签 + 清 `remotedTabs` + 必要时删 Rust 文档），
 * 但按 owner 批量摘 —— 这样 `reclaimFromVanished`（崩溃兜底，只在 `satellite-closed`
 * 上触发）落到时，`remotedTabs` 里已经没有这份 owner 的条目，自然成为空操作，
 * 不会把用户「关掉」的子窗口标签又恢复回主窗口。
 */
function dropRemotedForOwner(label: string): void {
  if (windowKind !== "main") return;
  const owned = [...remotedTabs.entries()].filter(([, v]) => v.owner === label);
  for (const [docId] of owned) dropRemotedDoc(docId);
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

/** 主窗口要销毁了（B155）：在场的卫星窗口收到这条就得自己收场。 */
// ⚠️ 这里**没有**「谁关了文档就广播给别的窗口」那条事件（B155 加过、B157 删掉）：
//    标签是每个窗口各持一份，但**关标签只有发起窗口说了算** —— 让对端跟着摘的结果是
//    「在子窗口关个文件，主窗口的同名标签也被关掉」，用户明确否掉。卫星窗口无论怎么关
//    （点 X / 关空 / 关唯一面板）都不再把标签交回主窗口（B188，见 `requestSatelliteClose`）。

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
  setSyncingDocId(docId); // 与窗口内同源同步共用同一个回环闸门
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
    setSyncingDocId(null);
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
  setSyncingDocId(docId);
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
      // B271：估算窗口开启（见 unmeasuredPanels）
      if (p) unmeasuredPanels.add(p);
      // B126：整段替换后视图被拉回开头，按旧视口位置还回去（浏览器自动裁剪）
      if (view && p) restoreViewScroll(p);
      // B271：估算窗口由 measureAndKeepScroll 的 rAF 关闭
      if (p) measureAndKeepScroll(p);
    }
  } finally {
    setSyncingDocId(null);
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
 * ⚠️ 这里**要**刷新按钮的显隐与点亮态：主窗口按下后，收到事件的窗口只要这份文档
 *    在自己这儿也是「开着多份」，按钮就跟着点亮；反过来一样。
 *    ⚠️ B171 起两个窗口同口径、显隐只认 `instancesOfDoc`：收到开关事件**不等于**
 *    本窗口该显示这颗键（本窗口可能只开了一份，键仍是 hidden），但状态照写进
 *    `docSyncModes` —— 等本窗口也开成多份，键一露脸就是「已开启」，不会错位。
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
 * ⚠️ 收这边**绝不回推**：`applySyncToSibling` 里钉位置走 `pinScrollTop`（B170 起内部
 *    `markProgrammatic`），那发 scroll 被监听经 scroll-guard 标认识破、直接吞掉 ——
 *    所以「谁滚谁当源」在跨窗口这一侧依然成立，不用另加闸门。
 * ⚠️ 只扫 `docId` 的全部实例并跳过 `srcTabId`：源那个 tabId 在别的窗口不重复出现，
 *    跳过它是防御（回声过滤与 `from` 那条是两回事，`from` 只保证不是自己发的）。
 */
function applyRemoteSyncPos(payload: SyncPosPayload | null): void {
  const { from, docId, srcTabId, v } = payload ?? {};
  if (!from || from === windowLabel || typeof docId !== "number" || typeof srcTabId !== "number") {
    return;
  }
  // 本窗口没开这份文档的同步滚动（开关那一条还没轮到，或用户在这边关过）⇒ 不动。
  if (docSyncModes.get(docId) !== true) return;
  logger.debug("sync", `收 ← ${from} doc=${docId} v=${v} srcTab=${srcTabId}`);
  // ⚠️ B251：落点走的是和本窗口三条路**同一个** `applySyncToSibling(v)` —— 跨窗口不是
  //    「另一套换算」，只是另一批接收者。远端交来的 `v` 与本地自己取出来的 `v` 同口径，
  //    远端那份源码/预览按它自己的几何插 ⇒ 与本窗口盯着同一处（用户报：跨窗口滚不对齐）。
  for (const other of instancesOfDoc(docId)) {
    if (other.tabId === srcTabId) continue;
    applySyncToSibling(other, typeof v === "number" ? v : null);
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
  // B178：跨窗口「这份文档在别的窗口还开着吗」的存在性登记（让同步键在主/子窗口同显隐）。
  // 按 `from`（窗口标签）记进 `remoteOpenByWindow`，自己的回声一律丢（与上面几条同口径）。
  void listen<DocPresencePayload>(EVT_DOC_OPEN, (e) => {
    const p = e.payload;
    if (!p?.docId || !p.from || p.from === windowLabel) return;
    let s = remoteOpenByWindow.get(p.from);
    if (!s) {
      s = new Set<number>();
      remoteOpenByWindow.set(p.from, s);
    }
    s.add(p.docId);
    refreshSyncButton(activeTab());
  }).catch(() => {});
  void listen<DocPresencePayload>(EVT_DOC_CLOSE_NOTIFY, (e) => {
    const p = e.payload;
    if (!p?.docId || !p.from || p.from === windowLabel) return;
    remoteOpenByWindow.get(p.from)?.delete(p.docId);
    refreshSyncButton(activeTab());
  }).catch(() => {});
  // 新窗口上线问了一圈，这里把本窗口当前可见集合重播一遍（idempotent，重复加无害）。
  void listen<{ from?: string }>(EVT_DOC_OPEN_RESYNC, (e) => {
    const p = e.payload;
    if (!p?.from || p.from === windowLabel) return;
    for (const t of tabs.values()) {
      if (t.panelId >= 0) {
        void emit(EVT_DOC_OPEN, { from: windowLabel, docId: t.docId }).catch(() => {});
      }
    }
  }).catch(() => {});
  // 卫星窗口干净关窗通知：清掉它那条，主窗口那份同文档的同步键随之收起。
  void listen<{ from?: string }>(EVT_WINDOW_CLOSED, (e) => {
    const p = e.payload;
    if (!p?.from || p.from === windowLabel) return;
    remoteOpenByWindow.delete(p.from);
    refreshSyncButton(activeTab());
  }).catch(() => {});
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
  void emit(EVT_WINDOW_CLOSED, { from: windowLabel }).catch(() => {});
  // B188：干净关窗要**显式**告诉主窗口「别把借出去的隐藏实例接回来」—— 用户明确不要交还。
  // 主窗口据此把 `remotedTabs` 里 owner=本窗口 的条目作废旧账（dropRemotedForOwner），
  // 而不是走崩溃兜底把它们恢复成可见标签。这条必须先于 `destroySelf()` 发：主窗口的
  // clean-close 处理落定后，Rust 的 `satellite-closed`(Destroyed) 才到，`reclaimFromVanished`
  // 那时已是空操作，不会把「关掉」的子窗口标签又接回主窗口。
  void emit("satellite-clean-close", { label: windowLabel }).catch(() => {});
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
  setIsDark(applyTheme(themeMode));
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
  applyPreviewLineHeight(settings?.preview_line_height ?? 1.7);
  // B235：预览正文宽度档（缺省「全宽」）。改了它不影响任何测量 ——
  // 宽度只影响换行位置，不动视口锚点，所以不必走 measureAndKeepScroll。
  applyPreviewWidth(settings?.preview_width ?? "full");
  applyEditorLineHeight(settings?.editor_line_height ?? 1.5);
  setupSideBar();
  setupSideResizer();
  // B194：回放上次的侧栏开合（`persist = false` —— 只是把盘上的值搬到 DOM）
  setSideOpen(settings?.toc_open ?? false, false);
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
  // B178：引导末尾问一圈「你们都开着哪些可见文档」—— 老窗口把当前集合重播一遍，
  // 新上线的窗口据此补齐 `remoteOpenByWindow`（否则它只知道自己开的，收不到老窗口
  // 已经开着的那些）。只发一次，不进刷新循环，不会形成回声环。
  void emit(EVT_DOC_OPEN_RESYNC, { from: windowLabel }).catch(() => {});

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
  void listen<{ label?: string }>("satellite-clean-close", (e) => {
    const lbl = e.payload?.label;
    if (!lbl || lbl === windowLabel) return;
    dropRemotedForOwner(lbl);
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

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
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask, save as saveDialog } from "@tauri-apps/plugin-dialog";

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

import {
  discardOrphanBackups,
  exportFile,
  listEncodings,
  listEols,
  listFonts,
  // B218：编码候选带上语言分组（「中文（简体 / 繁体）」这类组名由后端那份列表带出）
  // B227：本机字体枚举项（Rust list_fonts 的负载）
  type FontItem,
  loadSettings,
  newTab as ipcNewTab,
  takePendingFiles,
  reloadFile,
  savePasteImage,
  saveSession,
  saveSettings,
  windowPayload,
  type FileChangedPayload,
  type SatelliteTab,
  // B193：会话记录类型 —— 卫星标签要按 `owner` 分组还原成独立窗口，得拿到这份类型
  type WindowPayload,
} from "./ipc/api";
import { buildExportHtml, printToPdf } from "./markdown/exporter";
import { renderFull } from "./markdown/pipeline";
import { logger, syncLevel } from "./core/logger";
import { sessionStore } from "./session/store";
import { attachWheelZoom } from "./shell/zoom";
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
  closePanelById,
  splitActivePanel,
  moveActiveTabByDelta,
  focusPanelByDelta,
  toggleMaximizePanel,
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
} from "./markdown";
import { ensureFindBar, openFindBar, retargetFindBar } from "./find/findbar";
import {
  setupSideResizer,
  setupSideBar,
  applySidebarVisible,
  setSideOpen,
  toggleToc,
  updateTocDrawer,
} from "./toc";
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
  discardAllBackups,
  handleFileChanged,
} from "./session/session";
import {
  doOpen,
  doSave,
  doSaveAll,
  openDroppedAt,
  showFileDropPreview,
  fileDropTargetAt,
  dropPosOf,
  insertDroppedPath,
  panelDocIsMarkdown,
  rebuildDocInstances,
  saveDocCore,
} from "./io/files";
import {
  acceptDroppedTabs,
  adoptTransferredTabs,
  applyBackupIds,
  applyTabsReturn,
  broadcastDocChange,
  dropOnDesktop,
  dropRemotedForOwner,
  listenDocSync,
  reclaimFromVanished,
  relinquishDrag,
  snapshotDrag,
} from "./multiwindow/windows";
import { countLeaves } from "./shell/layout";
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
  clearAllDropPreviews,
  clearDropIndicators,
  commitTabDrop,
  previewDropAt,
  type DropSpot,
} from "./shell/splitview";
import { installTabDnd } from "./shell/tabdnd";
import {
  hasFileDropBridge,
  installFileDropTarget,
  needsChoice,
  showFileDropChoice,
} from "./shell/filedrop";
import { applyTheme, normalizeMode, watchSystemTheme, type ThemeMode } from "./theme/theme";
import { isSyncSource, pushSyncToSiblings, syncingCursorDocId } from "./sync-scroll";
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
  docSyncModes,
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
  setEolOptions,
  setEncodingOptions,
  setThemeModeState,
  setIsDark,
  setIsWrap,
  setSuppressDirty,
  setWindowLabel,
  setWindowKind,
  setSyncingDocId,
} from "./core/app-state";
import {
  EVT_SYNC_MODE,
  SyncModePayload,
  EVT_APP_QUIT,
  EVT_DOC_OPEN_RESYNC,
  EVT_WINDOW_CLOSED,
} from "./core/events";
import { activePanel, activeTab, panelOfTab, docOf, instancesOfDoc } from "./core/panels";
import { logViewport } from "./core/viewport";
import {
  bootMark,
  reportBoot,
  menuBar,
  titleBar,
  appMark,
  syncScrollBtn,
  winMinimize,
  winMaximize,
  winClose,
  winPin,
  tocPanel,
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

// 把尚未拆出的下游模块函数注入 tabs.ts（过渡期 DI，见 tabs.ts 文件头注释；
// #410–#415 拆出后逐个换成直接 import 并删除对应条目）。
installTabDeps({
  applyPanelMode,
  toggleViewMode,
  openPreviewToSide,
  attachPasteHandler,
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

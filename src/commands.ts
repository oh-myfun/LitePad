// 命令层（从 main.ts 拆出，解耦第十七步 / #416-3）。
//
// 职责：编辑菜单动作（deleteSelection / pasteClipboard / insertTimeDate / cycleTabInPanel）、
// 折叠（foldOperation / foldCodeOperation）、转到行（openGotoLine）、查看档位
// （changeFontSize / toggleWrapSetting / toggleStatusbar / togglePin / refreshPinButton /
// refreshMaximizeButton）、标题栏与菜单栏装配（setupTitleBar / setupMenuBar）、
// 查找替换命令入口（openFindReplace）、视图批处理方法（withView / findStep / tabStateWriteBack）。
// 零外部函数依赖（无 DI）——依赖 core/* + ui + tabs + find/findbar + prefs + shell/* + editor/*。

import { isWrap, panels, settings, tabs, windowKind, type Tab } from "./core/app-state";
import { logger } from "./core/logger";
import { redo, selectAll, undo } from "@codemirror/commands";
import { activePanel, activeTab, docOf, instancesOfDoc } from "./core/panels";
import { closeTabById, newUntitled, switchTab } from "./tabs";
import { refreshViewModeButton, toggleViewMode } from "./markdown";
import { doOpen, doSave, doSaveAll } from "./io/files";
import { exportHtml, exportPdf } from "./io/export";
import { ensureFindBar, openFindBar, retargetFindBar } from "./find/findbar";
import {
  currentFontSize,
  encodingMenuModel,
  keyHint,
  openSettingsDialog,
  scheduleFontSizeSave,
  setWordWrap,
} from "./prefs";
import { createMenuBar } from "./shell/menubar";
import { CODICONS, type CodiconName } from "./shell/codicons";
import { setTip } from "./shell/tooltip";
import { showAbout } from "./shell/about";
import { initUpdater, type UpdaterHandle } from "./shell/updater";
import { applyFontSize } from "./appearance";
import { foldAll, foldCode, unfoldAll, unfoldCode } from "@codemirror/language";
import {
  appMark,
  menuBar,
  showMessage,
  syncScrollBtn,
  titleBar,
  tocPanel,
  winClose,
  winMaximize,
  winMinimize,
  winPin,
} from "./ui";
import appMarkUrl from "../src-tauri/icons/app-mark.png";
import { toggleToc } from "./toc";
import { isMdActive } from "./doc-model";
import { EditorView } from "@codemirror/view";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { persistSession } from "./session/session";

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

export {
  openFindReplace,
  deleteSelection,
  pasteClipboard,
  insertTimeDate,
  cycleTabInPanel,
  foldOperation,
  foldCodeOperation,
  openGotoLine,
  changeFontSize,
  toggleWrapSetting,
  toggleStatusbar,
  togglePin,
  refreshPinButton,
  refreshMaximizeButton,
  setupTitleBar,
  setupMenuBar,
  withView,
  findStep,
  tabStateWriteBack,
};

// Markdown 预览（从 main.ts 拆出，解耦第九步 / #410）。
//
// 职责：面板视图模式（源码 / 分屏 / 纯预览）的切换与落点（applyPanelMode / toggleViewMode /
// openPreviewToSide）、Markdown 渲染调度（renderMarkdownFor / scheduleMdRender）、
// 视图模式按钮呈现（refreshViewModeButton）、路径工具（dirname）。
// 只依赖 core/* + ui + shell/* + doc-model + editor/* + markdown/preview，
// 对 main.ts 零反向依赖。
//
// session（#412）/ find（#413）/ toc（#411）拆出后已全部换成直接 import——本模块无 DI。

import {
  activePanelId,
  docs,
  layout,
  panels,
  tabs,
  setSuppressDirty,
  type Panel,
  type Tab,
} from "./core/app-state";
import { activeTab, docOf, getPanel } from "./core/panels";
import { isMdTab, makeInstance } from "./doc-model";
import { markActivePanel, sbLang, showMessage, tocPanel } from "./ui";
import { refreshIrLockKey } from "./shell/irlock";
import { clearTip } from "./shell/tooltip";
import { logger } from "./core/logger";
import { perfProfileFor } from "./editor/perf";
import { renderBlocks } from "./markdown/pipeline";
import { setIrBlocks, liveRenderExtensions } from "./markdown/live-render";
import {
  nextIrState,
  toggleIrLockState,
  toggleIrRenderState,
  type IrState,
} from "./markdown/ir-state";
import { EditorState, Transaction, type Extension, type StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { gutterExtensions } from "./editor/editor";
import { rightNeighborOf } from "./core/layout";
import { renderPanelOps, renderPanelTabs, splitPanelWithTab, switchTab } from "./tabs";
import { updateTocDrawer } from "./toc";
import { landVisibleSideAtV, readVisibleV, reconcileSyncRegistrations } from "./sync-scroll/wire";
import { scheduleSessionSave } from "./session/session";
// #413 find 拆出 ⇒ MarkdownDeps 全清，预览查找桥改直接 import（find/findbar 反向只取本模块的
// PreviewFindSpec 类型——等等，类型已归 find/findbar，这里只取值，无类型回边）
import { applyPreviewFindToPanel, findSpecOf, getFindBar } from "./find/findbar";

// ---------------------------------------------------------------- Markdown 预览（M3）

/** 应用面板视图模式：源码 / 分屏 / 纯预览（非 md 标签强制源码）。 */
function applyPanelMode(panel: Panel): void {
  if (!panel.bodyEl) return;
  const tab = tabs.get(panel.activeTabId);
  const mode = tab && isMdTab(tab) ? tab.viewMode : "source";
  panel.bodyEl.classList.remove("mode-source", "mode-split", "mode-preview");
  panel.bodyEl.classList.add("mode-" + mode);
  if (mode !== "source") {
    // 用户主动切模式 → force，大文件也要渲染一次（降级不是禁用）
    renderMarkdownFor(panel, true);
  }
  // B228：这里是**视图模式落到 DOM 的唯一出口**，所以操作区也在这里刷。
  // 那颗切换键是**双字形开关**（预览态画 edit-code），而字形只在 renderPanelOps 里
  // 算一次 —— 以前 openPreviewToSide 是「先 rebuildLayout（此时标签还是 source）、
  // 后置 preview」，中间没人再刷操作区，新预览分屏那颗键就一直卡在打开侧边之前的
  // 字形上（用户报的就是「显示的还是打开侧边前的切换按钮」）。挂在出口上就不会漏。
  // ⚠️ 别挪到 mousedown 路径上：重建 ops 会把按钮节点换掉，浏览器合成的 click 就
  //    派发不到它身上（B226）。applyPanelMode 的调用点全在 click / 恢复 / 分屏里，安全。
  renderPanelOps(panel.panelId);
  // B352-8：那颗三态悬浮键也在这里呈现 —— 本方法是「视图模式落到 DOM 的唯一出口」，
  // 键的字形/在场判定跟着同一发走，就不会出现「换了类没换键」（B228 那一族）。
  // `applyIrState` 也经这里落 DOM，所以不再单独调一次（写点只留一处，B304 口径）。
  refreshIrLockKey(panel);
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
  // B352：开着即时渲染的那一格不重画整篇预览 —— 预览面本来就是藏的，而「每防抖一拍把整篇
  // 重新 patch 一遍」正是 IR 这条路要避免的反目标。块表由同一条防抖里的 `refreshIr` 喂装饰层。
  if (tab.liveRender === "ir") return;
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
  const fb = getFindBar();
  if (fb?.isOpen()) applyPreviewFindToPanel(panel, findSpecOf(fb.getQuery()));
}

/**
 * 把当前块表灌进这份实例的即时渲染层（B352-6）。
 *
 * 与预览共用**同一个防抖写点**（见 `scheduleMdRender`）：另开一个定时器就是第二个口径，
 * 那族病（B304「显示与行为两套」）本仓已经栽过。
 * 可见实例走 `view.dispatch`（顺带由 `handleUpdate` 回写 `tab.state`）；
 * 没挂 view 的实例改状态快照，切回来就带得上。
 */
function refreshIr(tab: Tab): void {
  if (tab.liveRender === "off" || !isMdTab(tab)) return;
  const blocks = renderBlocks(tab.state.doc.toString());
  const view = getPanel(tab.panelId)?.view?.view;
  // 只造一次事务规格：派发点可能有两个（挂着的 view / 状态快照），但块表只算一遍
  const spec = { effects: setIrBlocks.of(blocks) };
  if (view && view.state === tab.state) view.dispatch(spec);
  else tab.state = tab.state.update(spec).state;
}

/**
 * 锁的真机制（计划增量 1）—— 两层各自成立，缺一不可：
 *
 * · `EditorView.editable.of(false)` 关掉 contenteditable ⇒ 键入、IME、粘贴、拖放都进不来；
 * · `EditorState.changeFilter` 再挡**程序化**派发：只拒「改文本且带 `Transaction.userEvent` 标注」的那一类。
 *
 * 为什么不能只靠 `editable(false)` / `EditorState.readOnly`：那两条只管用户手势与 CM6 自带命令，
 * 挡不住 `dispatch` —— 而 F5「插入时间/日期」（`force: true`）与查找栏「替换全部」正是程序化写
 * （它们自己走 `irEditable` 这道闸，Task 9）。反过来，同源兄弟格的变更集、外部改文件后的重载、
 * 热退出副本还原都**不带** userEvent ⇒ 天然放行，锁不会把这三条一起堵死。
 * 只改选区的事务也放行：锁态下大纲跳转与查找栏移动光标仍然要能用。
 */
export function irExtensionsFor(s: IrState): Extension[] {
  const locked = s.liveRender === "ir" && s.irLocked;
  return [
    EditorView.editable.of(!locked),
    ...(locked
      ? [
          EditorState.changeFilter.of(
            (tr) => !(tr.docChanged && tr.annotation(Transaction.userEvent)),
          ),
        ]
      : []),
  ];
}

/**
 * 换态落地：把 `next` 这套 IR 状态装到这份实例上（悬浮键、直达命令、会话恢复共用这一发）。
 *
 * ⚠️ 顺序本身就是判据（`tests/ir-apply.test.ts` 钉住）：
 *   读 v → 写状态 → 重配扩展 → setState → 换类 → 落位 → 重注册。
 *   读 v 一旦排到写状态之后，`sideOfPanel` 按新状态判「哪一侧看得见」，读到的还是
 *   被 `display:none` 归零的那一侧 ⇒ `keepV` 恒 1.00 ⇒ 落位把刚现形的一侧钉回文档顶部
 *   （B293 那条真机台账，同一族的坑）。
 */
/**
 * 「这一套 IR 状态 ⇒ 两个 Compartment 的重配效果」——`applyIrState`（有 DOM 的那条路）与
 * `restoreIrState`（会话恢复，还没有 DOM）共用这一份算法。
 *
 * 两处分开写就是 B304 那一族：一边改了另一边没改，键显示的状态与画面各说一套。
 * 装饰层与锁的扩展同住 `comps.ir`：`editable` / `changeFilter` 是 facet 扩展，不是事务效果，
 * 塞进 `effects` 里过不了类型；同槽换掉也保证「关态时锁的残留一起没了」。
 */
function irCompsEffects(tab: Tab, next: IrState): StateEffect<unknown>[] {
  const doc = docOf(tab);
  const locked = next.liveRender === "ir" && next.irLocked;
  const baseDir = doc?.path ? dirname(doc.path) : null;
  return [
    tab.comps.ir.reconfigure([
      ...liveRenderExtensions({ ir: next.liveRender === "ir", locked, baseDir }),
      ...irExtensionsFor(next),
    ]),
    // 渲染态关掉整条 gutter（B352-5 裁定：块装饰下被盖住的源行不再发行号，
    // 留着就是一栏说谎的跳号）；回源码态给回 M4 档位那份。
    tab.comps.gutter.reconfigure(
      next.liveRender === "ir" ? [] : gutterExtensions(perfProfileFor(doc?.sizeClass ?? "normal")),
    ),
  ];
}

/**
 * 会话恢复路径：把盘上读到的两个字段装进这份实例。
 *
 * 为什么不能只写字段：`makeTabState` 给的是 `comps.ir.of([])`，扩展没上线时
 * `liveRender = "ir"` 的实例会长出一颗「渲染·锁」的键、画面却是纯源码，而预览又被
 * `renderMarkdownFor` 的 IR 闸门挡住 ⇒ 用户看到一片空白。此刻面板还没建、EditorView
 * 还没挂，所以 `applyIrState` 那一半 DOM（落位 / 重注册 / 刷新键）在这里无从谈起 ——
 * 那些排在 `mountView` 之后，由既有流程接管。
 *
 * 只读文档的 C 不可达：盘上写着「解锁」也按回锁着（与 `nextIrState` 同一条约束）。
 */
function restoreIrState(tab: Tab, next: IrState): void {
  // 只读文档的 C 不可达：钳制必须**一起传进扩展**，只钳字段就是「键显示锁、编辑面还能打字」
  const ir: IrState = {
    liveRender: next.liveRender,
    irLocked: next.irLocked || docOf(tab).readonly,
  };
  tab.liveRender = ir.liveRender;
  tab.irLocked = ir.irLocked;
  tab.state = tab.state.update({ effects: irCompsEffects(tab, ir) }).state;
  // 块表紧跟着喂一发：生产里块表只有两个来源（换态末尾与 120ms 防抖），而防抖只由
  // `textChanged` 排程 ⇒ 恢复既不换态也不改文本，两条都不走。少了这一发，重启后的渲染格
  // 是一篇纯源码 + 一颗画着锁的键，而锁态打不进字 ⇒ 用户在这个状态里没有任何自救手段。
  refreshIr(tab);
}

function applyIrState(panel: Panel, tab: Tab, next: IrState): void {
  if (!panel.bodyEl) return;
  const keepV = readVisibleV(panel);
  // 换态不是编辑：装饰层上线/下线、编辑面开关都可能让 CM6 产生事务，一律不许置脏
  setSuppressDirty(true);
  const sourceEditor = panel.view;
  const locked = next.liveRender === "ir" && next.irLocked;
  try {
    tab.liveRender = next.liveRender;
    tab.irLocked = next.irLocked;
    tab.state = tab.state.update({ effects: irCompsEffects(tab, next) }).state;
    panel.view?.setState(tab.state);
    applyPanelMode(panel);
    // 焦点给回编辑器只在「渲染且可写」那一态要：锁态点它没意义，源码面本来就有焦点。
    // 必须排在 applyPanelMode 之后（隐藏元素 focus 静默失败，B190）。
    if (!locked && next.liveRender === "ir") sourceEditor?.focus();
    if (keepV !== null) landVisibleSideAtV(panel, keepV);
    // 显隐/在册面跟着变了 ⇒ 重注册（B285/B310 那一族：漏了就剩一个被藏起来的锚点在拽对栏）
    reconcileSyncRegistrations();
  } finally {
    setSuppressDirty(false);
  }
  // 块表紧跟着补一发：刚 reconfigure 出来的字段是空的，不喂就出现「按了键但画面不动」
  refreshIr(tab);
  scheduleSessionSave();
}

/**
 * 三条入口（悬浮键的循环、两条直达命令、整态重建之后的重挂）共用的落地前缀。
 *
 * ⚠️ 状态的两个字段只许在 `applyIrState` / `restoreIrState` 里写，而且两者共用同一份
 * 「状态 → 扩展」算法（`irCompsEffects`）—— 少一道判断就会把 `.txt` 标签也拖进渲染态，
 * 少一次档位判断则能让命令面板给 20 MB 的文档打开 IR（B352-11 评审 I6：`renderMarkdownFor`
 * 被闸门早退、`refreshIr` 却每 120ms 整篇重算，那一发本来就是 M4 档位为了停掉它才设的）。
 */
function applyIrToTab(tab: Tab, next: IrState): void {
  const panel = getPanel(tab.panelId);
  const doc = docOf(tab);
  if (!panel || !panel.bodyEl || !isMdTab(tab) || !doc) return;
  if (!perfProfileFor(doc.sizeClass).autoPreview) {
    showMessage("文件较大，未启用即时渲染");
    return;
  }
  applyIrState(panel, tab, next);
}

/** 悬浮锁键的那一下：三态循环的后继由 `nextIrState` 唯一决定，这里只管落地。 */
function cycleIrState(tab: Tab): void {
  const doc = docOf(tab);
  if (!doc) return;
  applyIrToTab(
    tab,
    nextIrState({ liveRender: tab.liveRender, irLocked: tab.irLocked }, { readonly: doc.readonly }),
  );
}

/** 直达命令 `view.liveRender`：进/出渲染、锁态不动（映射住 `toggleIrRenderState`）。 */
function toggleIrRender(tab: Tab): void {
  const doc = docOf(tab);
  if (!doc) return;
  applyIrToTab(
    tab,
    toggleIrRenderState(
      { liveRender: tab.liveRender, irLocked: tab.irLocked },
      { readonly: doc.readonly },
    ),
  );
}

/** 直达命令 `view.toggleLock`：只翻锁（映射住 `toggleIrLockState`）。 */
function toggleIrLock(tab: Tab): void {
  const doc = docOf(tab);
  if (!doc) return;
  applyIrToTab(
    tab,
    toggleIrLockState(
      { liveRender: tab.liveRender, irLocked: tab.irLocked },
      { readonly: doc.readonly },
    ),
  );
}

function scheduleMdRender(panelId: number): void {
  const panel = getPanel(panelId);
  if (!panel) return;
  if (panel.previewTimer !== null) clearTimeout(panel.previewTimer);
  panel.previewTimer = setTimeout(() => {
    panel.previewTimer = null;
    renderMarkdownFor(panel);
    const tab = tabs.get(panel.activeTabId);
    if (tab) refreshIr(tab);
    if (panel.panelId === activePanelId && !tocPanel.hidden) updateTocDrawer();
  }, 120) as unknown as number;
}

function dirname(p: string): string {
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return idx > 0 ? p.slice(0, idx) : p;
}

/**
 * 切换 Markdown 源码 / 预览（Ctrl+/、工具栏与菜单共用）。
 *
 * ⚠️ B228：可以**指定**切哪一份标签，不指定才退回活动标签。切换的落点永远是
 * 「这份标签**所在的那块面板**」，而不是「全局活动面板」 —— 标签区那颗键点的是它自己
 * 那一栏的标签，中间那步 `markActivePanel(panelId)` 会把全局活动面板先拽过去，
 * 于是同一次点击作用到的是**另一份标签**的文档（用户报的就是「切成了别的标签打开的
 * 文档的源码」）。所以这里从 tab 反查所属面板，不信任全局活动态。
 */
function toggleViewMode(target?: Tab): void {
  const tab = target ?? activeTab();
  if (!tab || !isMdTab(tab)) return;
  const panel = getPanel(tab.panelId);
  if (!panel || !panel.bodyEl) return;
  const toPreview = tab.viewMode !== "preview";
  // 切换视图本身不是编辑：隐藏/恢复编辑器可能让 CM6 产生事务，这里一律不置脏
  setSuppressDirty(true);
  // B190：切回源码后要把焦点给回编辑器（预览态期间它是 `display:none`，拿不住焦点，
  // 焦点早已不在它身上）。先取一份局部引用，避免闭包里再去读 `panel.view`。
  const sourceEditor = panel.view;
  // ⚠️⚠️ 这一发读 v **必须排在写 `tab.viewMode` 之前**（B293，真机台 S16/S14/S20 钉住）。
  // `readVisibleV` → `sideOfPanel` 判「哪一侧看得见」用的就是 `tab.viewMode`，而此刻 DOM 上
  // 的 `mode-*` 类还没换（要等下面的 `applyPanelMode`）。所以一旦先写了 viewMode，读到的
  // 就是「将要现形、现在还被 `display:none` 归零」那一侧 ⇒ `keepV` 恒 1.00 ⇒ 下面那一发
  // 落位把刚现形的一侧**钉回文档顶部** —— 用户报的「源码 ↔ 预览切换位置跳变」正是这一条
  //（真机台复刻生产顺序后：切到预览落在 1.00，切走前编辑器在 43.67）。
  // 注释里写的「必须赶在换类之前读」是这个意思，但代码以前只把读放在了换**类**之前、
  // 却排在换**状态**之后，于是这句话一直是空的。
  const keepV = readVisibleV(panel);
  tab.viewMode = toPreview ? "preview" : "source";
  try {
    applyPanelMode(panel);
    // ⚠️ 这一下 focus 的顺序有讲究：必须排在 `applyPanelMode` **之后** —— 之前编辑器
    //     还是 display:none，对隐藏元素 focus 会静默失败（同 B181 那条）。
    // 切到预览不用聚焦 —— 编辑器是隐藏的，focus 无意义且必然失败。
    if (!toPreview) sourceEditor?.focus();
    // —— 同步滚动 v1 · 跨显隐接力落位 ——————————————————————————————————————
    // 刚现形的那一侧此刻持有的是它自己的残值：预览被 `display:none` 归零（弹回文档开头），
    // 源码被上面那发 `focus()` 滚到**光标**那一行 —— 两者都不是用户切走之前看到的那一行，
    // 这就是「预览模式切换位置跳变」。扶回同一个 v，并同栈向账本认领这一写。
    if (keepV !== null) landVisibleSideAtV(panel, keepV);
    // 显隐变了 ⇒ 在册的滚动面也跟着变。这条路以前一次都不重注册：切换后在册的还是
    // **被藏起来**那一侧，它 `getV()` 恒 1.0、现形时又补发滚动 ⇒ 幽灵锚点把对栏拽走
    //（B285 那一族）。
    reconcileSyncRegistrations();
  } finally {
    setSuppressDirty(false);
  }
  // B190（续）：与 B183 同款 —— 状态栏按钮 / 菜单 / 工具栏切换视图都是一次鼠标手势，
  // WebView2 在手势结束时会把焦点重新定到 body，只 focus 一次会被偷走、`cm-focused`
  // 被失焦兜底摘掉、光标一闪而过。延迟一拍再补一次即可；已聚焦时 CM6 的 focus 是空操作，
  // 不会把上面钉好的视口位置顶掉。
  if (!toPreview && sourceEditor) {
    const handle = sourceEditor;
    setTimeout(() => handle.focus(), 0);
  }
  refreshViewModeButton();
  // B224：切换键是双字形开关（预览态画 edit-code），字形必须跟着 viewMode 走
  renderPanelOps();
  scheduleSessionSave();
}

/**
 * 把当前 Markdown 文档的预览开到**右侧分屏**（B224，VS Code `markdown.showPreviewToSide`）。
 *
 * 落点（用户拍定）：右侧已有面板就**复用**它 —— 那边已有这份文档就接管那一份，没有就
 * 复制一份同源实例塞进去；右侧没有面板才在右边新开一个分屏。
 * 复用/复制都走**同源多实例**（B149 基线：多份只同步文本），预览态跟着**那份标签**走，
 * 源面板那一份不受影响 —— 关掉预览分屏时源文档原样还在。
 *
 * ⚠️ 右邻必须用 `rightNeighborOf`（辨方向的右邻），不能拿 `siblingLeafOf`（视觉相邻，
 * 不辨左右）凑合 —— 在最右边的面板上点这颗键时，它会给出**左边**那个面板。
 */
function openPreviewToSide(panelId: number): void {
  const p = getPanel(panelId);
  const tab = p ? tabs.get(p.activeTabId) : undefined;
  if (!p || !tab || !isMdTab(tab)) return; // 键只在 md 活动标签上出现，这里只是兜底
  const doc = docs.get(tab.docId);
  if (!doc) return;
  // 源实例快照回写（与 splitPanelWithTab 的 copy 分支同口径）：
  // 复制出的实例从这份状态起步，别把过期的快照带进预览分屏
  if (p.view && p.viewTabId === tab.tabId) tab.state = p.view.view.state;

  const rightId = rightNeighborOf(layout, panelId);
  if (rightId === null) {
    // 右侧没有面板：新建右分屏放一份副本。splitPanelWithTab 的 copy 分支会把
    // 新面板设为活动面板并 rebuildLayout + refreshAll（副本的 view 在那时挂载）。
    splitPanelWithTab(panelId, "h", tab.tabId, false, true);
    const np = panels.get(activePanelId);
    const nt = np ? tabs.get(np.activeTabId) : undefined;
    if (np && nt && isMdTab(nt)) {
      nt.viewMode = "preview";
      // B228：把「预览分屏是活动面板」这件事显式落一次。splitPanelWithTab 里已经
      // 设过 activePanelId，但那份活动态是**分屏那一刻**的；这里再标一次，用户要的
      // 「新打开的预览标签被激活」才是重建完成后的事实（markActivePanel 里的 class
      // 同步在早退之前，代价只有一次 querySelectorAll）。
      markActivePanel(np.panelId);
      applyPanelMode(np); // 内部会刷操作区 ⇒ 切换键字形当场翻成 edit-code
      // 后置 preview 之后要补的两发（B310，同 `toggleViewMode` 末尾那两步一样的纪律）：
      //   ① 落位 —— 副本那颗 `scrollV` 种子（`split.ts` 为 B259 埋的「新格不许从顶部起步」）
      //      是被 `mountView` 扶到**当时可见**那一侧的，而那一刻还是源码态，扶的是编辑器；
      //      这一换之后看得见的是预览，不补这一发，B259 的承诺在这条分支上一直是空的。
      //   ② 重注册 —— 显隐变了 ⇒ 在册的滚动面跟着变。以前一次都不补：在册的还是那格
      //      刚被藏起来的编辑器（`getV()` 恒 1.0、写得进但用户看不见），预览面一个监听
      //      都没挂 ⇒ 两个方向都不动（真机 00:15：228 发 `广播写[P3:editor] … 落点=1.00`，
      //      而 `读可见侧[P3:preview] v=1.00`）。
      landVisibleSideAtV(np, nt.scrollV);
      reconcileSyncRegistrations();
    }
  } else {
    const rp = panels.get(rightId);
    if (!rp) return;
    const found = rp.tabs.find((id) => tabs.get(id)?.docId === tab.docId);
    let targetId: number;
    if (found !== undefined) {
      targetId = found;
    } else {
      const inst = makeInstance(doc, -1, tab.state.doc.toString());
      const sel = tab.state.selection.main;
      inst.state = inst.state.update({ selection: { anchor: sel.anchor, head: sel.head } }).state;
      inst.panelId = rightId;
      rp.tabs.push(inst.tabId);
      tabs.set(inst.tabId, inst);
      targetId = inst.tabId;
    }
    tabs.get(targetId)!.viewMode = "preview";
    if (activePanelId !== rightId) markActivePanel(rightId);
    // 先落 activeTabId（标签条与状态栏按它显示），再让 switchTab 换文档 ——
    // 它 B232 起的早退判据是 `viewTabId`（视图实际显示的那份），所以这次调用
    // **不会**因为「activeTabId 已经是目标」而早退，视图会真的换成新标签那份文档。
    rp.activeTabId = targetId;
    switchTab(rightId, targetId);
    applyPanelMode(rp);
    renderPanelTabs(rightId);
    renderPanelOps(rightId);
  }
  scheduleSessionSave();
}

/** 状态栏语言/格式项：**纯展示**高亮语言名（记事本式）。
 *
 * B233：md 原先在这颗上兼了「视图切换器」——显示「M↓ Markdown 语法/预览」、
 *  可点击切视图、预览态还点亮 `.sb-btn-active`。现在**一律只显示语言名**
 *  （md 就是 `langLabel` 的 "Markdown"），与其他格式完全一致：不带 `.sb-btn`、
 *  不带 `.sb-md-badge`、不随 `viewMode` 变、不挂切换提示、点了也没反应。
 *  用户明确要的是「和其他格式显示一样」，**预览态也不加任何额外标记**。
 *
 *  视图切换入口仍在别处（标签区操作键、Ctrl+/、菜单），这颗不再承担。
 *  ⚠️ 别再加回 `.sb-btn` / `sb-btn-active` / `sb-md-badge` 任一个 ——
 *     它们唯一的作用就是让这颗看起来可点，有专门的反向契约钉住。 */
function refreshViewModeButton(): void {
  const tab = activeTab();
  const doc = tab ? docs.get(tab.docId) : undefined;
  sbLang.textContent = doc?.langLabel ?? "Plain Text";
  clearTip(sbLang);
}

export {
  applyPanelMode,
  renderMarkdownFor,
  scheduleMdRender,
  refreshIr,
  applyIrState,
  cycleIrState,
  toggleIrRender,
  toggleIrLock,
  restoreIrState,
  toggleViewMode,
  openPreviewToSide,
  refreshViewModeButton,
  dirname,
};
// 写闸门 `irEditable` 的定义住在叶子模块 `markdown/ir-state.ts`（无 DOM）：查找栏与
// commands.ts 都要问它，而本模块反向 import 着 findbar ⇒ 定义放这边就是一张依赖环。
// 这里只转一个出口，既有调用点（含 tests/ir-apply.test.ts）不必改 import。
export { irEditable } from "./markdown/ir-state";

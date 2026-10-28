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
import { markActivePanel, sbLang, tocPanel } from "./ui";
import { logger } from "./core/logger";
import { perfProfileFor } from "./editor/perf";
import { renderBlocks } from "./markdown/pipeline";
import { flippedTaskMark, taskLineAt } from "./markdown/tasks";
import { rightNeighborOf } from "./core/layout";
import {
  ensurePreviewArm,
  renderPanelOps,
  renderPanelTabs,
  splitPanelWithTab,
  switchTab,
} from "./tabs";
import { updateTocDrawer } from "./toc";
import { landVisibleSideAtV, readVisibleV, reconcileSyncRegistrations } from "./sync-scroll/wire";
import { scheduleSessionSave } from "./session/session";
// B397-1：一颗 view 两档 ⇒ 「视图模式落到 DOM 的唯一出口」也是「档位落到 state 的唯一出口」，
// 所以这两个 extension 构造器在这里点名。本模块头部那条「只依赖 core/*+ui+shell/*+doc-model+
// editor/*+markdown/preview」的边界因此多了一个口子 —— 口子只过 `deco_preview` 开关为真的路径。
import { EditorState } from "@codemirror/state";
import { decoFace, decoLock } from "./spike/deco/wysiwyg";
import { shouldMountDecoPreview } from "./spike/deco/eligibility";
import { wysiwygInstalled } from "./spike/deco/livePreview";
import { assetBase, setAssetBase } from "./spike/deco/assets";
// #413 find 拆出 ⇒ MarkdownDeps 全清，预览查找桥改直接 import（find/findbar 反向只取本模块的
// PreviewFindSpec 类型——等等，类型已归 find/findbar，这里只取值，无类型回边）
import { applyPreviewFindToPanel, findSpecOf, getFindBar } from "./find/findbar";
import { CODICONS } from "./shell/codicons";
import { setTip } from "./shell/tooltip";

// ---------------------------------------------------------------- Markdown 预览（M3）

/**
 * B397-1 · 把「这一格是哪一档」落到那颗**唯一**的 view 上。
 *
 * 形态照 InkNote：`previewCompartment.reconfigure(previewExt(mode))`（editor.ts:1370）+
 * 只读是同一颗 view 上的另一把锁（:1391-1399）。**换档不换 view**，所以一格只有一份文档 ——
 * 镜像那颗（以及它的 ChangeSet 桥、归属闸、重新播种）整块没有了，「预览面显示一篇旧文」
 * 这一类病灶连存在的余地都没有。
 *
 * 两道早退各挡什么：
 *   · `panel.preview` 在场 ⇒ 这一格挂的是派生 DOM 那一臂（开关关着，或挂载时文档不 eligible），
 *     档位在它身上没有意义，一行都不许碰；
 *   · `panel.viewTabId !== tab.tabId` ⇒ view 上挂的不是这一份实例（接班在途），
 *     此时改档位会写到别人身上。
 *
 * 已开着就不再 reconfigure：`livePreview` 的 StateField 是模块级单例，reconfigure 等于销毁重建
 * ⇒ 全篇重 parse 一遍，而 applyPanelMode 在每次布局重建、每次换标签都要跑。
 */
function applyDecoFace(panel: Panel, tab: Tab | undefined, mode: string): void {
  const handle = panel.view;
  if (!handle || !tab || panel.viewTabId !== tab.tabId) return;
  // B397-5：`panel.preview` 在场 = 这一格此刻走**派生 DOM 那一臂**（大文件 / 开关关着 /
  // 非 Markdown），装饰档不许装 —— 以前这里是「early return」，改成并进 `on` 的判据：
  // 运行时关掉开关那一发要能把已经装着的装饰摘干净（壬 那条判据量的就是这个）。
  //
  // B399：两种所见即所得档（`preview` / `edit`）是**同一张脸** —— 都装 `decoFace()`，
  // 差别只在锁。用户口径：「预览模式只是禁止编辑的编辑模式」。
  const on = !panel.preview && mode !== "source" && shouldMountDecoPreview(tab);
  // `docs.get` 而不是 `docOf`：孤儿实例不该把这一次换档带崩（与 `shouldMountDecoPreview` 同口径）
  const doc = docs.get(tab.docId);
  const readonly = doc?.readonly === true;
  // 锁 = 文档只读（哪一档都不许写）或预览档（B399：预览 = 禁编辑的编辑模式）
  const locked = readonly || mode === "preview";
  // B397-4c · 图片相对路径的基准：跟着**这一份文档**走，换标签要重发。
  // 传的是文档路径本身而不是目录 —— `resolveAssetPath` 的契约与 InkNote 一致（进来的是 md 文件路径）
  const assetPath = doc?.path ?? null;
  const view = handle.view;
  const installed = wysiwygInstalled(view.state);
  const baseChanged = installed && (view.state.field(assetBase, false) ?? null) !== assetPath;

  const effects = [];
  if (installed !== on) effects.push(tab.comps.preview.reconfigure(on ? decoFace() : []));
  // 锁只挂在装饰面上：离开装饰面必须把锁摘干净 —— B399 起预览档也上锁，切回源码档
  // 不摘就等于把源码档也锁死。源码档自己的只读仍按主干旧口径（这里不新增行为）。
  const hasLock = view.state.facet(EditorState.readOnly) === true;
  if (on ? hasLock !== locked : hasLock) {
    effects.push(tab.comps.lock.reconfigure(on ? decoLock(locked) : []));
  }
  if (effects.length) view.dispatch({ effects });
  // 基准目录单独一发：与 reconfigure 同发时，刚装上的字段收不到这一颗 effect
  if (on && (!installed || baseChanged)) {
    view.dispatch({ effects: setAssetBase.of(assetPath) });
  }
  // 档位跟着这一份实例走（`tab.state` 是下游唯一读源），换标签回来时才是自己那一档
  tab.state = view.state;
}

/**
 * B406 · 文档路径换了（保存 / 另存为 / 资源管理器改名）⇒ 图片相对路径的基准跟着换。
 *
 * 挂在 `refreshAll` 上（ui.ts 的 DI 钩子）：保存与改名两条路都会走它。基准没变就
 * 不 dispatch —— 这一发在每次刷新里是空转，但只有路径真变的那一次才有成本。
 */
export function refreshDecoAssetBases(): void {
  for (const inst of tabs.values()) {
    const panel = panels.get(inst.panelId);
    if (!panel?.view || panel.viewTabId !== inst.tabId) continue;
    const view = panel.view.view;
    if (!wysiwygInstalled(view.state)) continue;
    const assetPath = docs.get(inst.docId)?.path ?? null;
    if ((view.state.field(assetBase, false) ?? null) === assetPath) continue;
    view.dispatch({ effects: setAssetBase.of(assetPath) });
    inst.state = view.state;
  }
}

/** 应用面板视图模式：源码 / 分屏 / 纯预览（非 md 标签强制源码）。 */
function applyPanelMode(panel: Panel): void {
  if (!panel.bodyEl) return;
  const tab = tabs.get(panel.activeTabId);
  const mode = tab && isMdTab(tab) ? tab.viewMode : "source";
  panel.bodyEl.classList.remove("mode-source", "mode-split", "mode-preview");
  // B399：`preview` 与 `edit` 是同一张脸（装饰面），DOM 上都落 `mode-preview`；
  // 两档的差别只在 `tab.comps.lock`（见 applyDecoFace）。
  panel.bodyEl.classList.add("mode-" + (mode === "edit" ? "preview" : mode));
  // B397-5：预览侧用哪一臂按**视图实际显示的那份文档**问（大文件就地换派生 DOM 那一臂）。
  // 必须排在 applyDecoFace 之前：`p.preview` 在场时 applyDecoFace 一行不碰。
  ensurePreviewArm(panel);
  applyDecoFace(panel, tab, mode);
  // B399：页面内那颗悬浮的「预览 ↔ 编辑」切换键，跟着同一份档位状态刷
  syncDecoEditFab(panel, tab, mode);
  if (mode !== "source") {
    // 用户主动切模式 → force，大文件也要渲染一次（降级不是禁用）
    renderMarkdownFor(panel, true);
  }
  renderPanelOps(panel.panelId);
  // B228：这里是**视图模式落到 DOM 的唯一出口**，所以操作区也在这里刷。
  // 那颗切换键是**双字形开关**（预览态画 edit-code），而字形只在 renderPanelOps 里
  // 算一次 —— 以前 openPreviewToSide 是「先 rebuildLayout（此时标签还是 source）、
  // 后置 preview」，中间没人再刷操作区，新预览分屏那颗键就一直卡在打开侧边之前的
  // 字形上（用户报的就是「显示的还是打开侧边前的切换按钮」）。挂在出口上就不会漏。
  // ⚠️ 别挪到 mousedown 路径上：重建 ops 会把按钮节点换掉，浏览器合成的 click 就
  //    派发不到它身上（B226）。applyPanelMode 的调用点全在 click / 恢复 / 分屏里，安全。
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
  const fb = getFindBar();
  if (fb?.isOpen()) applyPreviewFindToPanel(panel, findSpecOf(fb.getQuery()));
}

/**
 * B358：把渲染面点下的第 `index` 个勾选框翻回源码（预览岛的宿主入口）。
 *
 * 直接写文档：预览格是唯一渲染面，这里就是「组件操作」的落笔点；只读文档挡掉。
 */
export function toggleTaskInTab(
  tabId: number,
  lineStart: number,
  lineEnd: number,
  index: number,
): void {
  const tab = tabs.get(tabId);
  const panel = tab ? getPanel(tab.panelId) : undefined;
  const doc = tab ? docOf(tab) : undefined;
  if (!tab || !panel?.view || !doc || doc.readonly || !isMdTab(tab)) return;
  const info = taskLineAt(tab.state.doc, lineStart, lineEnd, index);
  if (!info) return;
  panel.view.view.dispatch({
    changes: { from: info.from, to: info.to, insert: flippedTaskMark(info.checked) },
  });
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
  // B399：三档之后这颗键仍按 InkNote 的口径「源码 ↔ 预览」：
  // 从源码进的是**预览档（禁编辑）**，从预览/编辑都回源码（编辑档的开关在悬浮键 / Ctrl+E）。
  const toPreview = tab.viewMode === "source";
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
 * B399 · 页面内悬浮键：预览档（禁编辑）↔ 编辑档（同一张脸，解掉锁）。
 *
 * 用户口径（2026-10-28）：「预览和编辑态切换通过页面内悬浮按钮，可参考 InkNote 的单按键
 * 切换或者 VS Code 的 switch 切换。」VS Code 那一侧的对应物是富 Markdown 编辑器的
 * `markdown.editor.toggleLocked`（`Toggle Markdown Read-only`，macOS 绑 cmd+e）——
 * 这里也留一颗同键位 Ctrl+E（`view.toggleEdit`）。
 *
 * 只在这两档之间切：源码档不归它管（那颗键在标签区操作区，管的是源码 ↔ 预览）。
 * 换的是 Compartment 不是 view ⇒ 位置要自己扶：先读 `v`、切档、落位、重注册，与
 * `toggleViewMode` 同一套纪律（B293 / B285）。切档本身不是编辑 ⇒ 全程抑制置脏。
 */
function toggleDecoEdit(target?: Tab): void {
  const tab = target ?? activeTab();
  if (!tab || !isMdTab(tab) || tab.viewMode === "source") return;
  const panel = getPanel(tab.panelId);
  if (!panel || !panel.bodyEl) return;
  // 只对装饰那一臂成立：派生 DOM 预览（开关关着 / 非 md / huge）没有可编辑形态
  if (!shouldMountDecoPreview(tab) || panel.preview) return;
  const toEdit = tab.viewMode === "preview";
  if (toEdit && docs.get(tab.docId)?.readonly === true) return; // 只读文档没有编辑档
  setSuppressDirty(true);
  const keepV = readVisibleV(panel);
  tab.viewMode = toEdit ? "edit" : "preview";
  try {
    applyPanelMode(panel);
    if (keepV !== null) landVisibleSideAtV(panel, keepV);
    reconcileSyncRegistrations();
  } finally {
    setSuppressDirty(false);
  }
  // 进入编辑档：焦点直接交给编辑器（用户点这颗键就是要接着写）；补一拍的理由同 B190 ——
  // WebView2 在手势结束时会把焦点收回 body。
  if (toEdit && panel.view) {
    const handle = panel.view;
    handle.focus();
    setTimeout(() => handle.focus(), 0);
  }
  renderPanelOps(panel.panelId);
  scheduleSessionSave();
}

/**
 * B399 · 那颗悬浮键的显隐与字形（唯一刷点是 `applyPanelMode`，与档位同源）。
 *
 * 显隐口径：Markdown + 装饰臂在场（`shouldMountDecoPreview` 且没有派生预览）+ 不在源码档
 * + 文档可写。派生臂那一边（`.md-preview`）不能编辑，留着这颗键等于给用户一个假入口。
 * 字形照本仓的双字形开关口径：**画的是点了会去的那一档** —— 预览档画 `edit`（去编辑），
 * 编辑档画 `eye`（回预览）。B401 起按钮在编辑区**左上角**（用户口径）。
 */
function syncDecoEditFab(panel: Panel, tab: Tab | undefined, mode: string): void {
  const host = panel.bodyEl;
  if (!host) return;
  let fab = host.querySelector<HTMLButtonElement>(".deco-edit-fab");
  if (!fab) {
    fab = document.createElement("button");
    fab.type = "button";
    fab.className = "deco-edit-fab";
    fab.addEventListener("click", (e) => {
      e.stopPropagation();
      const t = tabs.get(panel.viewTabId ?? panel.activeTabId);
      if (t) toggleDecoEdit(t);
    });
    host.appendChild(fab);
  }
  const doc = tab ? docs.get(tab.docId) : undefined;
  const show =
    !!tab &&
    panel.viewTabId === tab.tabId &&
    mode !== "source" &&
    !panel.preview &&
    shouldMountDecoPreview(tab) &&
    doc?.readonly !== true;
  fab.hidden = !show;
  if (!show || !tab) return;
  const editing = tab.viewMode === "edit";
  fab.innerHTML = editing ? CODICONS.eye : CODICONS.edit;
  fab.dataset.mode = tab.viewMode;
  const label = editing ? "预览" : "编辑";
  setTip(fab, label, { key: "Ctrl+E" });
  fab.setAttribute("aria-label", `${label}（Ctrl+E）`);
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

/** 状态栏语言/格式项：显示当前生效的语言名（B365 起可点开浮层切换）。
 *
 * B233 曾把它做成**纯展示**（md 也不再来回切视图），那个口径只管「别在它上面切视图」；
 * B365 用户点名要「像编码键一样可点、切换文件类型」，于是恢复按钮语义 —— 但这里仍
 * **只显示语言名**，不掺视图模式（预览切换仍在标签区操作键 / Ctrl+/ / 菜单）。
 * 禁用态与编码/行尾两颗同口径：没有活动文档就按不动。 */
function refreshViewModeButton(): void {
  const tab = activeTab();
  const doc = tab ? docs.get(tab.docId) : undefined;
  sbLang.textContent = doc?.langLabel ?? "Plain Text";
  sbLang.disabled = !tab;
}

export {
  applyPanelMode,
  renderMarkdownFor,
  scheduleMdRender,
  toggleViewMode,
  toggleDecoEdit,
  openPreviewToSide,
  refreshViewModeButton,
  dirname,
};

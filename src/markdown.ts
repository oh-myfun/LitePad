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
import { clearTip } from "./shell/tooltip";
import { logger } from "./core/logger";
import { perfProfileFor } from "./editor/perf";
import { renderBlocks } from "./markdown/pipeline";
import { rightNeighborOf } from "./core/layout";
import { renderPanelOps, renderPanelTabs, splitPanelWithTab, switchTab } from "./tabs";
import { updateTocDrawer } from "./toc";
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
  const toPreview = tab.viewMode !== "preview";
  tab.viewMode = toPreview ? "preview" : "source";
  // 切换视图本身不是编辑：隐藏/恢复编辑器可能让 CM6 产生事务，这里一律不置脏
  setSuppressDirty(true);
  // B190：切回源码后要把焦点给回编辑器（预览态期间它是 `display:none`，拿不住焦点，
  // 焦点早已不在它身上）。先取一份局部引用，避免闭包里再去读 `panel.view`。
  const sourceEditor = panel.view;
  try {
    applyPanelMode(panel);
    // ⚠️ 这一下 focus 的顺序有讲究：必须排在 `applyPanelMode` **之后** —— 之前编辑器
    //     还是 display:none，对隐藏元素 focus 会静默失败（同 B181 那条）。
    // 切到预览不用聚焦 —— 编辑器是隐藏的，focus 无意义且必然失败。
    if (!toPreview) sourceEditor?.focus();
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
    //
    // ⚠️⚠️ B259：`refreshAll()` 收尾曾以**此刻的活动文档**为源往外推 —— 而此刻活动文档
    //    正是**刚复制出来的那份空档副本**（预览还没排、编辑器视口 scrollTop 恒 0）
    //    ⇒ 推的是「文档开头」，会把左栏那份源码钉到顶（自测台实测 287 ⇒ 0）。
    //    与 B254 同型：位置归零的那个瞬间不能当源坐标。
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
    // ⚠️⚠️ B261：`applyPanelMode` 必须排在这一句**之前**（与右邻居不存在那一支同序）。
    //    它尾上那句 `if (anchorLine > 1) preview.syncToLine(anchorLine)` 读的是**面板那个
    //    EditorView 此刻的 scrollTop** —— 这里它不一定是**空档**：分屏那份实例是
    //    `splitPanelWithTab` 的 copy 分支造出来的，那份槽在 copy 分支里就被落过一次
    //    （B261 底下那两行），面板一挂上编辑器就按槽还原到那个值 ⇒ `anchorLine` 是
    //    一份**陈旧**位置，而这次点击要落的是**源当前**那一格 ⇒ 让 applyPanelMode 先跑，
    //    它那一跳就盖不掉刚落好的位置。反着来（B259 那版）实测：源 290 ⇒ 该落 870，
    //    被陈旧 287 掀回 861 —— 就是用户报的「被打开/激活的预览标签滚动位置和打开的
    //    标签文件滚动位置不一致」。
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
  toggleViewMode,
  openPreviewToSide,
  refreshViewModeButton,
  dirname,
};

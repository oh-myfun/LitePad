/**
 * 同步滚动真机验证台的页内宿主。
 *
 * 它不是 mock：编辑器、预览、协调器、注册接线全部 import 真实生产模块
 * （`src/editor/editor.ts` / `src/markdown/preview.ts` / `src/markdown/pipeline.ts`
 * / `src/sync-scroll/*` / `src/core/app-state.ts`），由 esbuild 打成 IIFE 在真实
 * Chromium 里跑，从而拿到 jsdom 永远拿不到的东西——**真实布局与真实滚动事件**。
 *
 * 为什么不接 Tauri 产物：本仓库已实测记录 WebView2 不吃
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`、Tauri 也不转发 `--remote-debugging-port`
 * （见 `.workbuddy/memory/2026-10-02.md`、`2026-09-14.md`），CDP 接不上被测进程。
 * 「真实浏览器 + CDP 派发真实鼠标」在本仓库已由 `docs/split-view-plan.md` 的取证方法
 * 验证可行，这里沿用它，只把被测面从 splitview 换成滚动同步。
 *
 * DOM 形状刻意复刻生产：`mountView`（`src/tabs/lifecycle.ts:198-219`）给**每个面板**
 * 都同时挂 `.panel-editor` 与 `.md-preview`，再靠 `.panel-host.mode-*` 的 CSS 藏掉
 * 其中一个（`src/styles/preview.css:632-640`）。所以「可见面板里也存在着一个被隐藏的
 * 锚点」是线上真实状态，必须一并复现，否则验证台看不见那一路的失败。
 *
 * 复刻的结构性滚动来源（线上「自动跳变 / 调回顶部」的全部来源）：
 *   1. `view.setState(别的文档)` 归零 `scrollDOM.scrollTop` —— 同 `lifecycle.ts:279`；
 *   2. `PreviewPane.setBlocks()` 的 `replaceChildren` 清零后同栈复原 —— 同 `preview.ts:99-105`；
 *   3. 每次结构性操作后调真实 `reconcileSyncRegistrations()` —— 同 `lifecycle.ts:330`。
 * 没搬过来的是会话 / IPC / 菜单那一圈，它们不参与滚动。
 */

import "../../src/styles/global.css";
import "../../src/styles/preview.css";
import { markdown } from "@codemirror/lang-markdown";
import { createEditor, makeTabState } from "../../src/editor/editor";
import { perfProfileFor } from "../../src/editor/perf";
import { PreviewPane } from "../../src/markdown/preview";
import { renderBlocks } from "../../src/markdown/pipeline";
import { panels, tabs, type Panel, type Tab } from "../../src/core/app-state";
import { isMdTab, makeDoc, registerDoc } from "../../src/doc-model";
import {
  landVisibleSideAtV,
  readVisibleV,
  reconcileSyncRegistrations,
  syncCoordinator,
} from "../../src/sync-scroll/wire";
import { EditorScrollAnchor } from "../../src/sync-scroll/anchor";
import {
  applyCodeFontFamily,
  applyEditorLineHeight,
  applyFontFamily,
  applyFontSize,
  applyPreviewLineHeight,
  applyPreviewWidth,
  applyTabActionReserve,
  applyTabStyle,
} from "../../src/appearance";

declare global {
  interface Window {
    /** 由探针生成的 harness.html 注入，避开 esbuild loader 与 tsc 的交叉配置。 */
    __FIXTURE_LONG__: string;
    __FIXTURE_SHORT__: string;
    __harness: HarnessApi;
  }
}

/** 探针要驱动的页内动作。用户滚动不经这里——那走真实 CDP 输入事件。 */
export interface HarnessApi {
  /** 切到该面板标签条上第 index 个标签（复刻 lifecycle.switchTab 的调用序列）。 */
  switchTab(panelId: number, index: number): void;
  /**
   * 预览整块重渲染（编辑 / 重载触发的那条路径）。
   * 返回同栈前后的 scrollTop 与高度，用来区分「setBlocks 没把位置扶回去」与
   * 「扶回去了、随后被别的什么东西改掉」——这两种的修法完全不同。
   */
  rerenderPreview(panelId: number): {
    before: { top: number; sh: number; ch: number };
    after: { top: number; sh: number; ch: number };
  } | null;
  /** 该文档的 B152 开关。 */
  setSyncEnabled(docId: string, on: boolean): void;
  docIds(): { long: number; short: number };
  /**
   * 新开一格预览面板（复刻「打开侧边预览」的净效果：同文档多一个可见实例 + reconcile）。
   * S11–S13 就是这套结构性操作的回归网：账本重构删掉旧的结构性锁之前，必须先有这几格
   * 绿，否则等于拆保护。
   */
  addPreviewPanel(): number;
  /** 关掉一格面板（复刻 closePanelById / pruneEmptyPanels 的注册注销）。 */
  removePanel(panelId: number): void;
  /**
   * 切该面板的源码/预览模式。⚠️ **忠实**复刻 `toggleViewMode`（`markdown.ts:119-152`）：
   * 写 `viewMode` → `applyPanelMode` 换类 + 重渲染预览 → 切回源码时 `focus()`。
   * 生产这条路径**不调** `reconcileSyncRegistrations()`，这里也不能调 ——
   * 早先的版本调了，于是台子测的是宿主而不是应用（S13/S14 因此在绿着掩盖线上缺陷）。
   */
  setMode(panelId: number, mode: "source" | "preview"): void;
  /**
   * 把标签移入另一格面板。复刻 `tabdnd` drop → `commitTabDrop` → `moveTabToPanel`
   * （`split.ts:140-163`）→ `rebuildLayout`（销毁全部 EditorView）→ `mountView`
   * （`lifecycle.ts:199-232`：从 `tab.state` 新建编辑器 + 活动面板 focus + applyPanelMode
   * + reconcile）。生产这条路**完全不碰 `tab.scrollV`**，镜像也必须不碰，否则又是宿主替
   * 应用把事做了。
   */
  /**
   * 同源复制一张标签进**同一格**面板（复刻 `duplicateTabToPanel`，`split.ts:282-298`：
   * 取当前正文 → 新实例（抄 `viewMode` 与选区）→ 挂到该面板并设为活动 → 重建挂载）。
   * 返回新标签在该面板 `tabs` 里的下标（探针按下标切标签，拿不到 tabId）。
   * S25 需要它：真机那条症状的形状是「同一格里同一文件的第二张源码标签」，而这一张在被显示
   * 之前从不注册进协调器 ⇒ 它记的 `scrollV` 天生是陈值。
   */
  /** 只读取证：该文档当前的共享坐标（`syncCoordinator.currentV`），null = 没有在册视口。 */
  currentV(docId: string): number | null;
  duplicateTab(panelId: number, index: number): number;
  moveTab(tabId: number, hostPanelId: number): void;
  /**
   * 远端文档变更（复刻 `windows.ts:719` 的裸 `view.dispatch({changes})`）。
   * 生产那一发**没有**账本登记 —— 镜像照抄，包括这个缺失。
   */
  remoteDocChange(docId: number, text: string): void;
  /**
   * 远端整段纠错（复刻 `applyDocResyncFull`，`windows.ts:800-818`）：
   * `setState(whole)` 之后读回落点、按「就地认领」登记（意图 = 落点 = 读回值），
   * 且明确**不**把旧视口位置还回去。
   */
  remoteFullResync(docId: number, text: string): void;
}

let nextTabId = 1;
let nextPanelId = 2;
let activePanelId = 0;
const docLongId = 1;
const docShortId = 2;
const fixtureText = () => ({ long: window.__FIXTURE_LONG__, short: window.__FIXTURE_SHORT__ });

function makeTab(
  docId: number,
  text: string,
  panelId: number,
  viewMode: "source" | "preview",
): Tab {
  const env = { dark: false, wrap: true, perf: perfProfileFor("normal") };
  const { state, comps } = makeTabState(text, markdown(), env, () => {});
  // viewMode 必须与面板的 mode-* 类一致：生产的可见性由它决定（applyPanelMode 就是
  // 按它写类名，reconcileSyncRegistrations 也按它决定注册哪一侧）。
  const tab: Tab = { tabId: nextTabId++, docId, panelId, comps, state, viewMode, scrollV: 1 };
  tabs.set(tab.tabId, tab);
  return tab;
}

/**
 * 建一格面板，形状与生产的 `mountView` 一致：
 * `.panel-host.mode-X` > `.panel-head`(`.panel-tabstrip`) + `.panel-editor`(真实 CM6) + `.md-preview`。
 * 两个视口都建，靠 CSS 藏一个——这样「被隐藏但仍被注册的锚点」这个线上状态也被复现。
 */
function createPanel(mode: "source" | "preview", docId: number, label: string): Panel {
  const text = docId === docLongId ? window.__FIXTURE_LONG__ : window.__FIXTURE_SHORT__;
  const panelId = nextPanelId++;
  const host = document.createElement("div");
  host.className = `panel-host mode-${mode}`;
  host.dataset.panelId = String(panelId);

  const head = document.createElement("div");
  head.className = "panel-head";
  const strip = document.createElement("div");
  strip.className = "panel-tabstrip";
  head.append(strip);

  const editorBox = document.createElement("div");
  editorBox.className = "panel-editor";

  const tab = makeTab(docId, text, panelId, mode);
  const view = createEditor(editorBox, tab.state);
  const chip = document.createElement("div");
  chip.className = "tab tab-active";
  chip.dataset.tabId = String(tab.tabId);
  chip.textContent = label;
  strip.append(chip);

  const preview = new PreviewPane();
  preview.setHost({ lineCount: () => text.split("\n").length });
  preview.setBlocks(renderBlocks(text), { enhanced: false });

  host.append(head, editorBox, preview.root);
  document.getElementById("layout")!.append(host);

  const panel: Panel = {
    panelId,
    tabs: [tab.tabId],
    activeTabId: tab.tabId,
    view,
    viewTabId: tab.tabId,
    preview,
    previewTimer: null,
    bodyEl: host,
  };
  panels.set(panelId, panel);
  return panel;
}

/**
 * 生产 `renderMarkdownFor` 的净效果（`markdown.ts:89`：`preview.setBlocks(renderBlocks(正文))`）。
 *
 * ⚠️ 刻意**不传** `{ enhanced: false }`：生产那条路就是默认走 `enhance()`，而 `enhance()`
 * （代码高亮 / mermaid / 图片）是在 `setBlocks` **之后**才异步改变块高的。台子早先为了跑得快
 * 把它关掉，于是「落位发生在块高定局之前」这一族缺陷在台子里根本不存在 —— 用户报的
 * 「跳变从来没被扶回过，最后还是错的」正对着这个盲区（S21 就是来验它的）。
 */
function renderMarkdownMirror(panel: Panel): void {
  if (!panel.preview) return;
  const text = panel.view?.view.state.doc.toString() ?? "";
  panel.preview.setBlocks(renderBlocks(text));
}

/** 生产 `applyPanelMode`（`markdown.ts:39-48`）的镜像：换 `mode-*` 类，非源码态强制重渲染。 */
function applyPanelModeMirror(panel: Panel): void {
  const host = panel.bodyEl;
  if (!host) return;
  const tab = tabs.get(panel.activeTabId);
  const mode = tab && isMdTab(tab) ? tab.viewMode : "source";
  host.classList.remove("mode-source", "mode-split", "mode-preview");
  host.classList.add(`mode-${mode}`);
  if (mode !== "source") renderMarkdownMirror(panel);
}

/**
 * 生产 `rebuildLayout` → `mountView`（`lifecycle.ts`）的净效果：
 * 销毁前按**看得见那一侧**快照 `tab.scrollV`，然后**销毁**旧 EditorView、按 `tab.state`
 * 新建一个（`scrollTop` 从 0 起步）、活动面板 `focus()`（CM6 把光标行滚进视野）、
 * 走 `applyPanelMode`、把 `scrollV` 扶回**现在看得见**那一侧并认领、最后 reconcile。
 *
 * ⚠️ 落位/读取直接 import 生产的 `readVisibleV` / `landVisibleSideAtV`：这两步是应用的事，
 * 宿主抄一份就又会「替应用做事」——抄错还测不出来（本轮已经踩过一次）。
 */
function remountPanel(panel: Panel): void {
  const host = panel.bodyEl;
  const shown = tabs.get(panel.viewTabId ?? panel.activeTabId);
  if (!host || !panel.view || !shown) return;
  const v = readVisibleV(panel);
  if (v !== null) shown.scrollV = v;
  const tab = tabs.get(panel.activeTabId);
  if (!tab) return;
  panel.view.view.destroy();
  host.querySelector(".panel-editor")?.remove();
  const editorBox = document.createElement("div");
  editorBox.className = "panel-editor";
  const head = host.querySelector(".panel-head");
  if (head) host.insertBefore(editorBox, head.nextSibling);
  else host.append(editorBox);
  panel.view = createEditor(editorBox, tab.state);
  panel.viewTabId = tab.tabId;
  if (panel.panelId === activePanelId) panel.view.focus();
  applyPanelModeMirror(panel);
  landVisibleSideAtV(panel, tab.scrollV);
  reconcileSyncRegistrations();
}

/** 标签条高亮（生产经 `renderPanelTabs`）：MEASURE 读 `tab-active` 决定点第几个标签。 */
function renderTabstripMirror(panel: Panel): void {
  panel.bodyEl
    ?.querySelectorAll<HTMLElement>(".tab")
    .forEach((el) =>
      el.classList.toggle("tab-active", Number(el.dataset.tabId) === panel.activeTabId),
    );
}

function install(): void {
  // 文档必须先登记进 `docs`：面板可见性按应用状态判（`isMdTab(tab)` →
  // `docs.get(tab.docId)`，src/doc-model.ts:171-173）。没登记就全都退化成 mode-source，
  // 预览侧锚点一个也不注册 —— 验证台会变成在测一根拔掉的线。
  const fx = fixtureText();
  registerDoc(makeDoc(docLongId, fx.long, "sync-scroll.md", null, "utf-8", "LF", false));
  registerDoc(makeDoc(docShortId, fx.short, "sync-scroll-b.md", null, "utf-8", "LF", false));

  // 排版变量必须按生产缺省落一遍，否则几何对不上：--font-size / --editor-line-height
  // 直接决定 CM6 的行块高度，而 v 的行内小数部分就是从它算出来的。
  // 下面这组值就是 main.ts:892-900 那批 `settings?.x ?? 缺省` 的缺省分支。
  applyTabStyle("connected");
  applyTabActionReserve(true);
  applyFontSize(14);
  applyFontFamily("");
  applyCodeFontFamily("");
  applyPreviewLineHeight(1.7);
  applyPreviewWidth("full");
  applyEditorLineHeight(1.5);

  // 面板 0：源码侧，**两个标签共享同一个 EditorView**（生产的「切标签 = setState」形态）。
  const host0 = document.createElement("div");
  host0.className = "panel-host mode-source";
  host0.dataset.panelId = "0";
  const head = document.createElement("div");
  head.className = "panel-head";
  const strip = document.createElement("div");
  strip.className = "panel-tabstrip";
  head.append(strip);
  const editorBox = document.createElement("div");
  editorBox.className = "panel-editor";
  host0.append(head, editorBox);
  document.getElementById("layout")!.append(host0);

  const tabLong = makeTab(docLongId, window.__FIXTURE_LONG__, 0, "source");
  const tabShort = makeTab(docShortId, window.__FIXTURE_SHORT__, 0, "source");
  const view0 = createEditor(editorBox, tabLong.state);
  for (const [tab, name] of [
    [tabLong, "sync-scroll.md"],
    [tabShort, "sync-scroll-b.md"],
  ] as const) {
    const el = document.createElement("div");
    el.className = "tab" + (tab === tabLong ? " tab-active" : "");
    el.dataset.tabId = String(tab.tabId);
    el.textContent = name;
    strip.append(el);
  }
  const preview0 = new PreviewPane();
  preview0.setHost({ lineCount: () => window.__FIXTURE_LONG__.split("\n").length });
  preview0.setBlocks(renderBlocks(window.__FIXTURE_LONG__), { enhanced: false });
  host0.append(preview0.root); // mode-source ⇒ CSS 隐藏它，但它照样会被注册
  const panel0: Panel = {
    panelId: 0,
    tabs: [tabLong.tabId, tabShort.tabId],
    activeTabId: tabLong.tabId,
    view: view0,
    viewTabId: tabLong.tabId,
    preview: preview0,
    previewTimer: null,
    bodyEl: host0,
  };
  panels.set(0, panel0);

  // 面板 1：侧边预览（同文档的第二份实例；mode-preview ⇒ 它的编辑器被 CSS 隐藏）。
  createPanel("preview", docLongId, "sync-scroll.md");

  // 真实接线：注册锚点 + 在真实滚动容器上挂真实 scroll 监听。
  reconcileSyncRegistrations();

  window.__harness = {
    switchTab(panelId, index) {
      const panel = panels.get(panelId);
      if (!panel?.view) return;
      const nextTab = tabs.get(panel.tabs[index]);
      if (!nextTab) return;
      // ⚠️ 这段是 `src/tabs/lifecycle.ts:switchTab` 的**镜像**（本宿主 import 不动那一圈
      // 会话/IPC/菜单，只能照抄序列）。**改生产切标签的顺序时必须同步改这里**，
      // 否则 S6/S19 测的是宿主、不是应用。
      // 序列：按**当前可见侧**快照被换走那份的 v 与 state → 改 viewTabId → setState →
      // focus → applyPanelMode（切进预览态标签时这是预览唯一的重量级落点）→ 补第二次 focus →
      // 同栈把 scrollV 扶回**现在可见那一侧**并认领 → 刷标签条 → reconcile。
      const shown = tabs.get(panel.viewTabId ?? panel.activeTabId);
      if (shown) {
        const live = readVisibleV(panel);
        if (live !== null) shown.scrollV = live;
        shown.state = panel.view.view.state;
      }
      panel.activeTabId = nextTab.tabId;
      panel.viewTabId = nextTab.tabId;
      panel.view.setState(nextTab.state);
      panel.view.focus();
      applyPanelModeMirror(panel);
      panel.view.focus();
      // B292 · 方案 A 的镜像（与生产 switchTab 同步：接班标签跟随当前共享 v）。
      // B292 · 方案 A 的镜像（与生产 switchTab 同步：接班标签跟随当前共享 v）。
      const followV = syncCoordinator.currentV(String(nextTab.docId));
      if (followV !== null) nextTab.scrollV = followV;
      landVisibleSideAtV(panel, nextTab.scrollV);
      panel.bodyEl
        ?.querySelectorAll<HTMLElement>(".tab")
        .forEach((el) =>
          el.classList.toggle("tab-active", Number(el.dataset.tabId) === nextTab.tabId),
        );
      reconcileSyncRegistrations();
    },
    rerenderPreview(panelId) {
      const panel = panels.get(panelId);
      if (!panel?.preview) return null;
      const root = panel.preview.root;
      const before = { top: root.scrollTop, sh: root.scrollHeight, ch: root.clientHeight };
      const text = panel.view?.view.state.doc.toString() ?? window.__FIXTURE_LONG__;
      panel.preview.setBlocks(renderBlocks(text), { enhanced: false });
      // 同栈读回来：能区分「setBlocks 自己没把位置扶回去」与「扶回去了、随后被人改掉」。
      return {
        before,
        after: { top: root.scrollTop, sh: root.scrollHeight, ch: root.clientHeight },
      };
    },
    addPreviewPanel() {
      // 同 `splitPanelWithTab` 的 copy 分支（split.ts）：副本先继承**源当下可见侧**的 v，
      // 落位再交给「扶回可见侧」。少了这两步，新格只能从顶部起步 —— S18 早先那发绿是
      // 布局挤压引起的一发广播**碰巧**把它带过去的，不是种子，不能当证据。
      const src = panels.get(activePanelId) ?? [...panels.values()][0];
      const live = src ? readVisibleV(src) : null;
      const p = createPanel("preview", docLongId, "sync-scroll.md");
      const tab = tabs.get(p.activeTabId);
      if (tab && live !== null) tab.scrollV = live;
      if (tab) landVisibleSideAtV(p, tab.scrollV);
      reconcileSyncRegistrations();
      return p.panelId;
    },
    removePanel(panelId) {
      const panel = panels.get(panelId);
      if (!panel || panelId === 0) return;
      panel.view?.view.destroy();
      panel.bodyEl?.remove();
      for (const id of panel.tabs) tabs.delete(id);
      panels.delete(panelId);
      reconcileSyncRegistrations();
    },
    setMode(panelId, mode) {
      const panel = panels.get(panelId);
      const tab = panel ? tabs.get(panel.activeTabId) : undefined;
      if (!panel || !tab) return;
      // 同 `toggleViewMode`（markdown.ts）：读切换前那一侧的 v → 写 viewMode → applyPanelMode
      // （换类 + 强制重渲染预览）→ 切回源码才 focus（隐藏元素上 focus 会静默失败，B181/B190）
      // → 把刚现形那一侧扶回同一个 v 并认领 → reconcile。
      const keepV = readVisibleV(panel);
      tab.viewMode = mode;
      const sourceEditor = panel.view;
      applyPanelModeMirror(panel);
      if (mode === "source") sourceEditor?.focus();
      if (keepV !== null) landVisibleSideAtV(panel, keepV);
      reconcileSyncRegistrations();
    },
    currentV(docId) {
      return syncCoordinator.currentV(docId);
    },
    duplicateTab(panelId, index) {
      const host = panels.get(panelId);
      const src = host ? tabs.get(host.tabs[index]) : undefined;
      if (!host || !src) return -1;
      // 生产的正文取自 `freshTextOfDoc(doc)`；这里同一文档当前 state 的文本与之同义。
      const inst = makeTab(src.docId, src.state.doc.toString(), host.panelId, src.viewMode);
      inst.state = inst.state.update({ selection: src.state.selection.main }).state;
      host.tabs.push(inst.tabId);
      host.activeTabId = inst.tabId;
      const chip = document.createElement("div");
      chip.className = "tab";
      chip.dataset.tabId = String(inst.tabId);
      chip.textContent = `copy#${inst.tabId}`;
      host.bodyEl?.querySelector(".panel-tabstrip")?.append(chip);
      renderTabstripMirror(host);
      remountPanel(host);
      return host.tabs.length - 1;
    },
    moveTab(tabId, hostPanelId) {
      const tab = tabs.get(tabId);
      const src = tab ? panels.get(tab.panelId) : undefined;
      const host = panels.get(hostPanelId);
      if (!tab || !src || !host || src.panelId === host.panelId) return;
      // 同 `moveTabToPanel`（split.ts:140-163）：改数组 → 设活动 → 源面板清空则 dispose，
      // 否则 rebuildLayout（两侧 view 全销毁重建）+ refreshAll。
      src.tabs = src.tabs.filter((id) => id !== tabId);
      tab.panelId = host.panelId;
      host.tabs.push(tabId);
      host.activeTabId = tabId;
      if (activePanelId === src.panelId) activePanelId = host.panelId;
      if (src.tabs.length === 0) return; // 本宿主两格起步，S17 不走 dispose 那条分支
      src.activeTabId = src.tabs[src.tabs.length - 1];
      // 标签条上的那颗 chip 跟着搬（生产经 renderPanelTabs 重画，这里直接挪节点）
      const chip = src.bodyEl?.querySelector<HTMLElement>(`.tab[data-tab-id="${tabId}"]`);
      const strip = host.bodyEl?.querySelector(".panel-tabstrip");
      if (chip && strip) strip.append(chip);
      renderTabstripMirror(src);
      renderTabstripMirror(host);
      remountPanel(src);
      remountPanel(host);
    },
    remoteDocChange(docId, insertText) {
      // 同 `applyRemoteDocChange`（windows.ts:719）：直接 dispatch changes。
      // ⚠️ 内容高度一变，浏览器对 `scrollTop` 的裁剪会派出一发 scroll，而生产这一发
      // **没有**任何账本登记 —— 照抄这个缺失。
      for (const p of panels.values()) {
        const t = tabs.get(p.viewTabId ?? -1);
        if (!t || t.docId !== docId || !p.view) continue;
        p.view.view.dispatch({ changes: { from: 0, to: 0, insert: insertText } });
      }
    },
    remoteFullResync(docId, text) {
      // 同 `applyDocResyncFull`（windows.ts:800-818）：setState(whole) 之后只「就地认领」
      // （意图 = 落点 = 读回值），并明确不把旧视口位置还回去。
      for (const p of panels.values()) {
        const t = tabs.get(p.viewTabId ?? -1);
        if (!t || t.docId !== docId || !p.view) continue;
        const base = p.view.view.state;
        const whole = base.update({
          changes: { from: 0, to: base.doc.length, insert: text },
        }).state;
        const anchor = new EditorScrollAnchor(p.view.view);
        p.view.setState(whole);
        const here = anchor.getV();
        syncCoordinator.expectSurfaceV(p.view.view.scrollDOM, here, here);
        t.state = whole;
      }
    },
    setSyncEnabled(docId, on) {
      syncCoordinator.setEnabled(docId, on);
    },
    docIds: () => ({ long: docLongId, short: docShortId }),
  };
}

install();

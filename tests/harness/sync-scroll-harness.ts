/**
 * 同步滚动真机验证台的页内宿主。
 *
 * 它不是 mock：编辑器、预览、协调器、注册接线全部 import 真实生产模块
 * （`src/editor/editor.ts` / `src/markdown/preview.ts` / `src/markdown/pipeline.ts`
 * / `src/sync-scroll/*` / `src/core/app-state.ts`），由 esbuild 打成 IIFE 在真实
 * Chromium 里跑，从而拿到 jsdom 永远拿不到的东西——**真实布局与真实滚动事件**。
 *
 * 为什么不接 Tauri 产物：本仓库已实测记录 WebView2 不接
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`、Tauri 不转发 `--remote-debugging-port`
 * （见 `.workbuddy/memory/2026-10-02.md`、`2026-09-14.md`），CDP 接不上被测进程。
 * 「真浏览器 + CDP 派发真实鼠标」在本仓库已由 `docs/split-view-plan.md` 的取证方法
 * 验证可行，这里沿用它。
 *
 * DOM 形状刻意复刻生产：`mountView`（`src/tabs/lifecycle.ts:198-219`）给**每个面板**
 * 都同时挂 `.panel-editor` 与 `.md-preview`，再靠 `.panel-host.mode-*` 的 CSS 藏掉
 * 其中一个（`src/styles/preview.css:632-640`）。所以「可见面板里也存在着一个被隐藏的
 * 锚点」是线上真实状态，必须一并复现，否则验证台看不到那一路的失败。
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
import { panels, tabs, type Tab } from "../../src/core/app-state";
import { reconcileSyncRegistrations, syncCoordinator } from "../../src/sync-scroll/wire";
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
  /** 预览整块重渲染（编辑 / 重载触发的那条路径）。 */
  rerenderPreview(panelId: number): void;
  /** 该文档的 B152 开关。 */
  setSyncEnabled(docId: string, on: boolean): void;
  docIds(): { long: number; short: number };
}

let nextTabId = 1;

function makeTab(docId: number, text: string, panelId: number): Tab {
  const env = { dark: false, wrap: true, perf: perfProfileFor("normal") };
  const { state, comps } = makeTabState(text, markdown(), env, () => {});
  const tab: Tab = { tabId: nextTabId++, docId, panelId, comps, state, viewMode: "source" };
  tabs.set(tab.tabId, tab);
  return tab;
}

/** 复刻 mountView：panel-host > panel-head(标签条) + panel-editor + md-preview。 */
function makeHost(
  panelId: number,
  mode: "source" | "preview",
): {
  host: HTMLElement;
  editorBox: HTMLElement;
  strip: HTMLElement;
} {
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
  host.append(head, editorBox);
  document.getElementById("layout")!.append(host);
  return { host, editorBox, strip };
}

function addTabChip(strip: HTMLElement, tab: Tab, name: string, active: boolean): void {
  const el = document.createElement("div");
  el.className = "tab" + (active ? " tab-active" : "");
  el.dataset.tabId = String(tab.tabId);
  el.textContent = name;
  strip.append(el);
}

function install(): void {
  const longText = window.__FIXTURE_LONG__;
  const shortText = window.__FIXTURE_SHORT__;

  // 排版变量必须按生产缺省落一遍，否则几何对不上：`--font-size` / `--editor-line-height`
  // 直接决定 CM6 的行块高度，而 `v` 的行内小数部分就是从它算出来的。
  // 下面这组值就是 main.ts:892-900 那批 `settings?.x ?? 缺省` 的缺省分支。
  applyTabStyle("connected");
  applyTabActionReserve(true);
  applyFontSize(14);
  applyFontFamily("");
  applyCodeFontFamily("");
  applyPreviewLineHeight(1.7);
  applyPreviewWidth("full");
  applyEditorLineHeight(1.5);

  // ── 面板 0：源码侧。两个标签共享同一个 EditorView（生产的「切标签 = setState」形态）。
  const a = makeHost(0, "source");
  const tabLongA = makeTab(1, longText, 0);
  const tabShortA = makeTab(2, shortText, 0);
  const viewA = createEditor(a.editorBox, tabLongA.state);
  addTabChip(a.strip, tabLongA, "sync-scroll.md", true);
  addTabChip(a.strip, tabShortA, "sync-scroll-b.md", false);
  const previewA = new PreviewPane();
  previewA.setHost({ lineCount: () => longText.split("\n").length });
  previewA.setBlocks(renderBlocks(longText), { enhanced: false });
  a.host.append(previewA.root); // mode-source ⇒ CSS 隐藏它，但它照样会被注册
  panels.set(0, {
    panelId: 0,
    tabs: [tabLongA.tabId, tabShortA.tabId],
    activeTabId: tabLongA.tabId,
    view: viewA,
    viewTabId: tabLongA.tabId,
    preview: previewA,
    previewTimer: null,
    bodyEl: a.host,
  });

  // ── 面板 1：侧边预览（同文档的第二份实例；mode-preview ⇒ 它的编辑器被 CSS 隐藏）
  const b = makeHost(1, "preview");
  const tabLongB = makeTab(1, longText, 1);
  const viewB = createEditor(b.editorBox, tabLongB.state);
  addTabChip(b.strip, tabLongB, "sync-scroll.md", true);
  const previewB = new PreviewPane();
  previewB.setHost({ lineCount: () => longText.split("\n").length });
  previewB.setBlocks(renderBlocks(longText), { enhanced: false });
  b.host.append(previewB.root);
  panels.set(1, {
    panelId: 1,
    tabs: [tabLongB.tabId],
    activeTabId: tabLongB.tabId,
    view: viewB,
    viewTabId: tabLongB.tabId,
    preview: previewB,
    previewTimer: null,
    bodyEl: b.host,
  });

  // 真实接线：注册锚点 + 在真实滚动容器上挂真实 scroll 监听。
  reconcileSyncRegistrations();

  window.__harness = {
    switchTab(panelId, index) {
      const panel = panels.get(panelId);
      if (!panel?.view) return;
      const nextTab = tabs.get(panel.tabs[index]);
      if (!nextTab) return;
      // 与 src/tabs/lifecycle.ts:260-296 同序：快照回写 → 改 viewTabId → setState
      // → focus → reconcile。那几下 scrollTop 归零不是用户造成的。
      const shown = tabs.get(panel.viewTabId ?? panel.activeTabId);
      if (shown) shown.state = panel.view.view.state;
      panel.activeTabId = nextTab.tabId;
      panel.viewTabId = nextTab.tabId;
      panel.view.setState(nextTab.state);
      panel.view.focus();
      panel.bodyEl
        ?.querySelectorAll<HTMLElement>(".tab")
        .forEach((el) =>
          el.classList.toggle("tab-active", Number(el.dataset.tabId) === nextTab.tabId),
        );
      reconcileSyncRegistrations();
    },
    rerenderPreview(panelId) {
      const panel = panels.get(panelId);
      if (!panel?.preview) return;
      const text = panel.view?.view.state.doc.toString() ?? longText;
      panel.preview.setBlocks(renderBlocks(text), { enhanced: false });
    },
    setSyncEnabled(docId, on) {
      syncCoordinator.setEnabled(docId, on);
    },
    docIds: () => ({ long: tabLongA.docId, short: tabShortA.docId }),
  };
}

install();

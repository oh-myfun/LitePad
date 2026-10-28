// 标签栏与操作区渲染（从 tabs.ts 拆出，P3 批次）。
//
// 职责：renderPanelTabs / tabViewDataOf / tabstripCallbacks / panelDataOf / renderPanelOps。
// 只依赖 core/* + ui + shell/* + doc-model + 下游模块（lifecycle / split / deps / windows），
// 对 main.ts 零反向依赖。tabstripCallbacks 接线时引用 lifecycle / split 的动作函数，
// 与它们形成（运行期安全的）循环引用。

import {
  type Panel,
  type Tab,
  tabs,
  docs,
  panels,
  layout,
  activePanelId,
  windowKind,
} from "../core/app-state";
import { activeTab } from "../core/panels";
import { isMdTab } from "../doc-model";
import { countLeaves } from "../core/layout";
import { renderTabstrip, type TabViewData, type TabstripCallbacks } from "../shell/tabstrip";
import { refreshPanelOps, type PanelRenderData } from "../shell/splitview";
import { showMessage, layoutArea } from "../ui";
import { openTabsInNewWindow, returnTabToMain } from "../multiwindow/windows";
import { scheduleSessionSave } from "./deps";
import { switchTab, closeTabById, closeTabsSequentially, newUntitled } from "./lifecycle";
import {
  duplicateTabToPanel,
  duplicateTabToSibling,
  splitPanelWithTab,
  toggleMaximizePanel,
  maximizedPanelId,
} from "./split";
import { invoke } from "@tauri-apps/api/core";
import { dragTabAsFile } from "../io/filedrag";

export function renderPanelTabs(onlyPanelId?: number): void {
  for (const p of panels.values()) {
    if (onlyPanelId !== undefined && p.panelId !== onlyPanelId) continue;
    const strip = layoutArea.querySelector<HTMLElement>(
      `.layout-panel[data-panel-id="${p.panelId}"] .panel-tabstrip`,
    );
    if (!strip) continue;
    renderTabstrip(strip, tabViewDataOf(p), tabstripCallbacks(p));
  }
}

export function tabViewDataOf(p: Panel): TabViewData[] {
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
        // B57：标签类型图标按语言选字形/配色；langLabel 由 detectLanguage 维护，
        // 改名、重载编码时都会同步（见 rebuildDocInstances / 另存为分支）。
        lang: doc?.langLabel,
        path: doc?.path ?? undefined,
        hasSibling: countLeaves(layout) > 1,
      };
    });
}

/** 面板标签栏交互回调（激活/关闭/右键菜单/拖拽排序/双击新建）。 */
export function tabstripCallbacks(p: Panel): TabstripCallbacks {
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
    // B123-7：在资源管理器中打开文件所在目录并选中该文件
    onRevealInFolder: (tabId) => {
      const t = tabs.get(tabId);
      const doc = t && docs.get(t.docId);
      if (doc?.path) void invoke("reveal_in_folder", { path: doc.path });
    },
    onDuplicateTab: (tabId) => duplicateTabToPanel(tabId, p.panelId),
    onDuplicateToSibling: (tabId) => duplicateTabToSibling(tabId),
    // 左右 / 上下分屏：**复制**而非移动（与 VS Code 一致 —— Split 是同一文档开两份，
    // 移动另有 "Move Editor into Next Group"）。用 copy=true 也顺带避开了
    // splitPanelWithTab 在「源面板只剩这一个标签」时留下空面板的问题。
    onSplitH: (tabId) => splitPanelWithTab(p.panelId, "h", tabId, false, true),
    onSplitV: (tabId) => splitPanelWithTab(p.panelId, "v", tabId, false, true),
    // 双击标签 = 最大化/还原。仅多面板时给（单面板给了就是个永远没反应的手势）。
    onToggleMaximize: countLeaves(layout) > 1 ? () => toggleMaximizePanel(p.panelId) : undefined,
    // B71 ④：把标签交给新窗口。主窗口与卫星窗口都可用 —— 卫星窗口里再开一个窗口，
    // 对用户来说就是「再拎出去一份」，没有理由禁止。
    onOpenInNewWindow: (tabId) => void openTabsInNewWindow([tabId]),
    onReturnToMain: windowKind === "satellite" ? (tabId) => returnTabToMain(tabId) : undefined,
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
    // B400：Ctrl+拖标签 → 原生 OLE 拖拽（CF_HDROP），落点交给外部应用（VS Code 等）。
    onDragFileOut: (tabId) => {
      const t = tabs.get(tabId);
      if (t) void dragTabAsFile(t);
    },
  };
}

/**
 * 面板渲染快照（B224 起含 Markdown 键的显隐 / 字形标记）。
 * `rebuildLayout`（整树重建）与 `renderPanelOps`（只刷操作区）共用这一份口径 ——
 * 两边各写一遍必然漂移，操作区那两颗键就会跟标签条各说各话。
 */
export function panelDataOf(p: Panel): PanelRenderData {
  // md 两颗键只给**活动面板**（用户拍定，对齐 VS Code 的 editor/title 动作只出现在
  // 活动组）：非活动面板不给 md 标记，splitview 那边就一颗都不建。
  const act = p.panelId === activePanelId ? activeTab() : undefined;
  const md = !!act && isMdTab(act);
  return {
    panelId: p.panelId,
    active: p.panelId === activePanelId,
    tabs: tabViewDataOf(p),
    // B161：卫星窗口唯一的面板**可以**关 —— 关面板 = 关窗（B188 起不再把标签交回主窗口，
    // 文档由主窗口那份隐藏实例接着管，未保存内容靠热退出副本兜住）。主窗口仍然不许关唯一
    // 面板（关了就没地方放标签）。
    canClose: countLeaves(layout) > 1 || windowKind === "satellite",
    closeDetail:
      windowKind === "satellite" && countLeaves(layout) <= 1
        ? "关闭该子窗口（其中的文件不会交回主窗口）"
        : undefined,
    // B71：被最大化挤扁的一侧要真的收成 0（CSS 里 .layout-panel 有 min-width）
    maximized: maximizedPanelId === p.panelId,
    collapsed: maximizedPanelId !== null && maximizedPanelId !== p.panelId,
    // B224：标签区右侧那两颗 Markdown 键。mdPreview 决定切换键的字形与文案。
    // B399：预览 / 编辑两档都是装饰面 ⇒ 那颗键都画 `edit-code`（点了回源码）。
    md,
    mdPreview: md && act!.viewMode !== "source",
  };
}

/** 只重建各面板的操作区（B224）：md 两颗键跟着活动面板与视图模式走，
 *  标签条与编辑器都不动（重建标签条会销毁光标下的 `.tab`，见 markActivePanel）。 */
export function renderPanelOps(onlyPanelId?: number): void {
  for (const p of panels.values()) {
    if (onlyPanelId !== undefined && p.panelId !== onlyPanelId) continue;
    refreshPanelOps(p.panelId, panelDataOf(p));
  }
}

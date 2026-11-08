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
import { type MenuItem } from "../shell/menu";
import { showQuickPick } from "../shell/quickpick";
import { showMessage, layoutArea } from "../ui";
import { openTabsInNewWindow, returnTabToMain } from "../multiwindow/windows";
import { scheduleSessionSave } from "./deps";
import {
  switchTab,
  closeTabById,
  closeTabsSequentially,
  closePanelById,
  newUntitled,
} from "./lifecycle";
import {
  duplicateTabToPanel,
  duplicateTabToSibling,
  splitPanelWithTab,
  toggleMaximizePanel,
  maximizedPanelId,
} from "./split";
import { invoke } from "@tauri-apps/api/core";
import { dragTabAsFile } from "../io/filedrag";
// B461：差异面的标题与「与上次保存比较」这条动作（模型在 diff/model，渲染层只问它要判据）。
import { canOpenAgainstBaseline, diffTitleOf, openBaselineDiff, openFileDiff } from "../diff/model";
// B461 Task 8：图标键与组菜单那三条的**唯一**落点（两份 switch 必然漂移 —— Task 6 的教训同形）。
import { applyDiffAction } from "../diff/actions";
import { diffSurfaceOf } from "../diff/surface";
// B461 Task 6：B 档「选择以进行比较」的窗口级状态（标签与显隐的真相在 compare.ts）。
import { clearCompareSelection, compareSelection, toggleCompareSelection } from "../diff/compare";

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
        // B461（裁决 R27）：差异标签的名字必须从它自己的 spec 现拼 —— 它和原文档共用
        // `docId`，照 `doc.name` 画就会出现两张一字不差的标签，谁也数不清哪颗是差异面。
        name:
          t.kind === "diff" && t.diff
            ? diffTitleOf(t.diff, t.diff.leftName === t.diff.rightName)
            : (doc?.name ?? "?"),
        dirty: doc?.dirty ?? false,
        readonly: doc?.readonly ?? false,
        active: t.tabId === p.activeTabId,
        // B57：标签类型图标按语言选字形/配色；langLabel 由 detectLanguage 维护，
        // 改名、重载编码时都会同步（见 rebuildDocInstances / 另存为分支）。
        lang: doc?.langLabel,
        path: doc?.path ?? undefined,
        hasSibling: countLeaves(layout) > 1,
        // B461：右键那条的置灰判据随快照走 —— 菜单点开那一刻的基线才是要显示的基线。
        canDiffAgainstSaved: canOpenAgainstBaseline(doc ?? null),
        // B461 Task 10：搬移那五条与拖拽手势的显隐判据（设计稿 ⑧·3）。
        isDiff: t.kind === "diff",
      };
    });
}

/**
 * B 档「选择以进行比较」那一对回调（**一颗构造器，两个 producer 各展开一次**：本文件的
 * `tabstripCallbacks` 与 `tabs/lifecycle.ts` 供给 splitview 首建那一发的回调组）。
 *
 * 只给主窗口 —— 比较选择是**窗口级**状态，卫星窗口没有资源管理器树跟它配对（两击手势
 * 凑不齐）⇒ 两颗都不给，tabstrip 那一组整条退场（与 A 档 `onDiffAgainstSaved` 同一手法，
 * 判据在 `shell/tabstrip.ts`）。动作与 explorer 右键同源：状态与标签在 `diff/compare.ts`，
 * 开差异在 `diff/model.ts`。
 */
export function compareTabCallbacks(): Pick<
  TabstripCallbacks,
  "onSelectToCompare" | "onCompareWith"
> {
  return {
    onSelectToCompare:
      windowKind === "satellite"
        ? undefined
        : (tabId) => {
            const t = tabs.get(tabId);
            const doc = t && docs.get(t.docId);
            if (doc?.path) toggleCompareSelection(doc.path);
          },
    onCompareWith:
      windowKind === "satellite"
        ? undefined
        : (tabId) => {
            // 点击时刻才取选中态（弹层条目不许吃建数组那一刻的旧值）。
            const sel = compareSelection();
            const t = tabs.get(tabId);
            const doc = t && docs.get(t.docId);
            if (!sel || !doc?.path) return;
            void openFileDiff(sel, doc.path);
            clearCompareSelection();
          },
  };
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
    // B461：右键「与上次保存比较」—— 新那一张开到**活动面板**（模型那一头定的口径）。
    onDiffAgainstSaved: (tabId) => {
      const t = tabs.get(tabId);
      if (t) void openBaselineDiff(t.docId);
    },
    // B461 Task 6：B 档「选择以进行比较」那一对（含卫星窗口那道缺席闸）—— 一颗构造器，
    // 与 splitview 首建那一发（`tabs/lifecycle.ts`）展开的是同一份。
    ...compareTabCallbacks(),
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
  // B461：差异档不给 md 那两颗键 —— 差异视图**恒源码档**（设计稿 ⑥），而它的 `docId`
  // 就是原标签那份文档，`isMdTab` 天然为真 ⇒ 必须另外问一句 kind，否则「查看」那颗键
  // 会在一张差异标签上出现，点下去把这一格换回预览、旁路就悬在半空。
  const md = !!act && isMdTab(act) && act.kind !== "diff";
  // B161 / B422：这一格能不能解散、解散等不等于关窗 —— 口径在 `panelCloseFact`
  // （渲染快照与组菜单同源，别处不再算一遍）。
  const { canClose, closeDetail } = panelCloseFact();
  const data: PanelRenderData = {
    panelId: p.panelId,
    active: p.panelId === activePanelId,
    tabs: tabViewDataOf(p),
    canClose,
    closeDetail,
    // B71：被最大化挤扁的一侧要真的收成 0（CSS 里 .layout-panel 有 min-width）
    maximized: maximizedPanelId === p.panelId,
    collapsed: maximizedPanelId !== null && maximizedPanelId !== p.panelId,
    // B224：标签区右侧那两颗 Markdown 键。mdPreview 决定切换键的字形与文案。
    // B399：预览 / 编辑两档都是装饰面 ⇒ 那颗键都画 `edit-code`（点了回源码）。
    md,
    mdPreview: md && act!.viewMode !== "source",
    // B461 Task 8：差异图标键的三份现值（没有旁路 ⇒ `undefined` ⇒ 那一支一颗都不建）。
    diff: diffKeysOf(p),
  };
  // B422：组菜单送**函数**而不是算好的数组 —— 点「…」那一刻才按模型算（脏标记、组数、
  // 最大化态都在那时候取值）。操作区只在结构变化时重建，快照活不过下一次击键。
  data.groupMenu = () => groupMenuOf(p);
  return data;
}

/**
 * 这一格差异图标键的三份现值（B461 Task 8）。
 *
 * 读的是 **surface** 而不是标签上的 spec：`ignoreTrimWhitespace` / `collapseUnchanged` 是运行时
 * 状态（R24 同口径：只有那一颗持有），`swappable` 问的是档位。没有旁路 ⇒ 交 `undefined`，
 * splitview 那一支一颗都不建 —— 差异标签还在册但这一格没挂对照物时，画一排点不动的键才是真坑。
 */
function diffKeysOf(p: Panel): PanelRenderData["diff"] {
  const surface = diffSurfaceOf(p);
  if (!surface) return undefined;
  return {
    ignoreTrimWhitespace: surface.ignoreTrimWhitespace(),
    collapseUnchanged: surface.collapseUnchanged(),
    wrap: surface.wrapEnabled(),
    syncScroll: surface.syncScrollEnabled(),
    swappable: surface.spec().tier === "files",
  };
}

/**
 * 「这一格能不能被解散 / 解散它等于关窗」两格判据（B161）。
 *
 * `panelDataOf`（渲染快照）与 `groupMenuOf`（点击时算的菜单）都要用 —— 抽出来一处定义，
 * 否则两边各写一遍迟早漂移（菜单说能解散、快照说不能，就是 B224 那条教训的又一形）。
 */
function panelCloseFact(): { canClose: boolean; closeDetail?: string } {
  const canClose = countLeaves(layout) > 1 || windowKind === "satellite";
  const closeDetail =
    windowKind === "satellite" && countLeaves(layout) <= 1
      ? "关闭该子窗口（其中的文件不会交回主窗口）"
      : undefined;
  return { canClose, closeDetail };
}

/**
 * 组标题「…」菜单（B422，用户「标签区右边的关闭按钮改成 vscode 那种菜单按钮」）。
 *
 * 条目与分组顺序照 VS Code `editor.contribution.ts` 的 `MenuId.EditorTitle`：
 * `3_open`（Show Opened Editors）→ `4_split`（Split Editor Right/Down）→
 * `5_close`（Close All / Close Saved）→ `8_group_operations`（Maximize Group / 我们的解散组）。
 * 「解散组」= 旧 × 那条动作（标签并入相邻格后摘掉这一格）；VS Code 的组菜单里没有它
 * （那边叫 Close Group、挂在标签右键），LitePad 把它收进来正好补上那颗被换掉的 ×。
 * 「Unsplit Group」是终端那边的词，编辑器组不用它命名。
 * ⚠️ 本函数由 `panelDataOf` 包成**函数**送给 splitview，点「…」那一刻才跑（口径见
 * `PanelRenderData.groupMenu` 的注释）。
 */
function groupMenuOf(p: Panel): MenuItem[] {
  const dirtyOf = (tabId: number): boolean => !!docs.get(tabs.get(tabId)?.docId ?? -1)?.dirty;
  const items: MenuItem[] = [];
  // 本面板自己的活动标签：分屏动作要以它为源（点的是这一格的菜单，不是全局活动格）
  const own = p.tabs.includes(p.activeTabId) ? p.activeTabId : (p.tabs[0] ?? null);
  const multi = countLeaves(layout) > 1;
  const { canClose, closeDetail } = panelCloseFact();

  if (p.tabs.length > 0) {
    items.push({ label: "显示已打开的编辑器", onSelect: () => showGroupEditors(p) });
    items.push({ separator: true });
  }
  if (own !== null) {
    items.push({
      label: "左右分屏",
      onSelect: () => splitPanelWithTab(p.panelId, "h", own, false, true),
    });
    items.push({
      label: "上下分屏",
      onSelect: () => splitPanelWithTab(p.panelId, "v", own, false, true),
    });
    items.push({ separator: true });
  }
  // 两条关闭动作的名单在**选中那一刻**再取一遍：菜单开着的时候用户还能敲字、还能切标签，
  // 按开菜单时的快照关档就是把「刚改脏的那张」当成已保存关掉了（真机抓到过）。
  const savedNow = (): number[] => p.tabs.filter((id) => !dirtyOf(id));
  items.push({
    label: "全部关闭",
    disabled: p.tabs.length === 0,
    onSelect: () => void closeTabsSequentially([...p.tabs]),
  });
  items.push({
    label: "关闭已保存",
    disabled: savedNow().length === 0,
    onSelect: () => void closeTabsSequentially(savedNow()),
  });
  if (multi || maximizedPanelId === p.panelId) {
    items.push({ separator: true });
    items.push({
      label: maximizedPanelId === p.panelId ? "取消最大化组" : "最大化组",
      onSelect: () => toggleMaximizePanel(p.panelId),
    });
  }
  // B461 Task 8：这一格挂着旁路 ⇒ 「⋯」里多几条（顺序照 VS Code：交换左右 → 折叠一对 →
  // 换行 / 同步滚动两档开关 → 刷新，都排在「解散组」那一节之前）。判据一律**现在**读 surface：
  // 整张菜单在点击那一刻才组装，提前快照会把折叠开关的现状冻在重建操作区的那一刻
  // （B422 那条教训的又一形）。
  const diffSurface = diffSurfaceOf(p);
  if (diffSurface) {
    const swappable = diffSurface.spec().tier === "files";
    const folded = diffSurface.collapseUnchanged();
    items.push({ separator: true });
    items.push({
      // A 档没有「两份文件」可换（左栏是那份文档的上一次保存）⇒ 置灰；`MenuItem` 没有
      // tooltip 字段，那句说法按仓库口径写进标签本身（与「与上次保存比较（基线未知）」同形）。
      label: swappable ? "交换左右" : "交换左右（左栏是上次保存的正文）",
      disabled: !swappable,
      onSelect: () => applyDiffAction(p.panelId, "swap"),
    });
    items.push({
      // 两颗动作共用一颗入口：折着 ⇒「全部展开」，没折 ⇒「全部折叠」（explorer 那颗同口径）。
      label: folded ? "全部展开" : "全部折叠",
      onSelect: () => applyDiffAction(p.panelId, folded ? "showAll" : "collapseAll"),
    });
    // 两颗纯开关：`checked` 照 VS Code 的菜单口径显示当前状态（不是「点下去会怎样」）。
    items.push({
      label: "自动换行",
      checked: diffSurface.wrapEnabled(),
      onSelect: () => applyDiffAction(p.panelId, "wrap"),
    });
    items.push({
      label: "同步滚动",
      checked: diffSurface.syncScrollEnabled(),
      onSelect: () => applyDiffAction(p.panelId, "syncScroll"),
    });
    items.push({ label: "刷新", onSelect: () => applyDiffAction(p.panelId, "refresh") });
  }
  items.push({ separator: true });
  items.push({
    // 卫星窗口只有一格时没有宿主可并 —— 那条路本来就是「关掉这个子窗口」
    // （B161；判据与旧 × 的副标题同源，见 `panelCloseFact`）。
    label: closeDetail ? "关闭子窗口" : "解散组",
    disabled: !canClose,
    onSelect: () => void closePanelById(p.panelId),
  });
  return items;
}

/** 「显示已打开的编辑器」= VS Code 的 `SHOW_EDITORS_IN_GROUP`：本组标签的快速选择。 */
function showGroupEditors(p: Panel): void {
  const list = p.tabs
    .map((id) => tabs.get(id))
    .filter((t): t is Tab => !!t)
    .map((t) => {
      const doc = docs.get(t.docId);
      return {
        tabId: t.tabId,
        label: doc?.name ?? "?",
        description: doc?.path ?? "",
        checked: t.tabId === p.activeTabId,
      };
    });
  showQuickPick({
    placeholder: "显示已打开的编辑器",
    items: list.map((e) => ({ label: e.label, description: e.description, checked: e.checked })),
    onSelect: (index) => {
      const hit = list[index];
      if (hit) switchTab(p.panelId, hit.tabId);
    },
  });
}

/** 只重建各面板的操作区（B224）：md 两颗键跟着活动面板与视图模式走，
 *  标签条与编辑器都不动（重建标签条会销毁光标下的 `.tab`，见 markActivePanel）。 */
export function renderPanelOps(onlyPanelId?: number): void {
  for (const p of panels.values()) {
    if (onlyPanelId !== undefined && p.panelId !== onlyPanelId) continue;
    refreshPanelOps(p.panelId, panelDataOf(p));
  }
}

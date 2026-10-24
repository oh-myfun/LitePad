// B365：状态栏「文件类型」= 语言模式的浮层与落地。
//
// 分工：
//   · 菜单条目（自动检测 + 注册表全量、单项勾选）在 `editor/language.ts` 的 languageChoices（纯函数）；
//   · 这里只负责「取当前文档 → 开浮层 → 把选择落到文档与全部实例 → 刷新界面」。
//
// 落地口径：
//   · `doc.langOverride` 手动值优先，`null` 回到按后缀/首行自动检测（见 doc-model.languageOfDoc）；
//   · 语言扩展走每个实例的 `comps.lang` Compartment 热替换 —— 与保存改名那条路同款，
//     不用重建 EditorState，撤销历史、选区、滚动位置都不动；
//   · 从 Markdown 切走时，把该文档的预览实例退回源码：预览格是 md 专用面，留着会显示旧渲染。

import { activePanelId, docs, panels, tabs } from "./core/app-state";
import { activeTab, docOf, getPanel, instancesOfDoc } from "./core/panels";
import { isMdTab, languageOfDoc } from "./doc-model";
import { perfProfileFor } from "./editor/perf";
import { AUTO_LANGUAGE, languageChoices, languageInfoByLabel } from "./editor/language";
import { applyPanelMode } from "./markdown";
import { showQuickPick, quickPickIsOpen, closeQuickPick } from "./shell/quickpick";
import { fileIconHtml } from "./shell/fileicons";
import { refreshAll, sbLang } from "./ui";

/**
 * 浮层条目：语言名 + Seti 文件图标（与标签上的文件图标同一出口）。
 * 「自动检测」不是一种语言，不挂图标 —— 与 VS Code 语言选择器同款。
 */
function languagePickItems(override: string | null) {
  return languageChoices(override).map((choice) => {
    if (choice.label === AUTO_LANGUAGE) return choice;
    return { ...choice, icon: fileIconHtml(choice.label) };
  });
}

/** 文档第一行（自动检测的 shebang / 魔数要用；会话恢复的文档也走这里）。 */
function firstLineOf(docId: number): string {
  const inst = instancesOfDoc(docId)[0];
  return inst ? inst.state.doc.line(1).text : "";
}

/**
 * 把指定文档的语言切到 `label`（`null` = 自动检测）。
 * 对**全部实例**生效（分屏 / 隐藏实例都要换高亮），然后刷新标签图标、状态栏、操作键与预览面。
 */
export function applyLanguageMode(docId: number, label: string | null): void {
  const doc = docs.get(docId);
  if (!doc) return;
  if (label !== null && !languageInfoByLabel(label)) return;
  if (doc.langOverride === label) return;

  doc.langOverride = label;
  const lang = languageOfDoc(doc, firstLineOf(docId));
  doc.langLabel = lang.label;

  const perf = perfProfileFor(doc.sizeClass);
  const extension = perf.syntax ? (lang.extension ?? []) : [];
  for (const inst of instancesOfDoc(docId)) {
    const effect = inst.comps.lang.reconfigure(extension);
    const panel = panels.get(inst.panelId);
    if (panel?.view && panel.viewTabId === inst.tabId) {
      panel.view.view.dispatch({ effects: effect });
      inst.state = panel.view.view.state;
    } else {
      inst.state = inst.state.update({ effects: effect }).state;
    }
    if (!isMdTab(inst) && inst.viewMode !== "source") inst.viewMode = "source";
  }

  // 面板形态按新语言重算（离开 Markdown 必须退回源码；进入 Markdown 时挂出预览键）
  for (const panel of panels.values()) {
    if (panel.tabs.some((id) => tabs.get(id)?.docId === docId)) applyPanelMode(panel);
  }
  refreshAll();
}

/** 状态栏那颗「文件类型」键：开居顶浮层（VS Code 同款）。再点一下收起。 */
export function showLanguagePicker(): void {
  if (quickPickIsOpen()) {
    closeQuickPick();
    return;
  }
  const tab = activeTab();
  const doc = tab ? docOf(tab) : undefined;
  if (!doc) return; // 无文档时那颗键是 disabled 的，这里兜底

  const docId = doc.tabId;
  const items = languagePickItems(doc.langOverride);
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.checked),
  );
  showQuickPick({
    placeholder: "选择语言模式",
    items,
    activeIndex,
    anchor: sbLang,
    onSelect: (index) => {
      const item = items[index];
      if (!item) return;
      applyLanguageMode(docId, item.label === AUTO_LANGUAGE ? null : item.label);
    },
    onClose: () => {
      // 浮层收起后焦点回编辑区（VS Code quick input 同款）；否则键盘输入落在状态栏按钮上
      getPanel(activePanelId)?.view?.focus();
    },
  });
}

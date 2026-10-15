// 面板 / 文档 / 实例的只读访问器（从 main.ts 拆出的可复用核心模块）。
//
// 拆出来的理由：这几块是**别的模块都要用的公共底座**，留在 main.ts 里就等于
// 逼着每个功能模块反过来 import main.ts（hub 型耦合 + 循环依赖）。
// 归到 core/ 之后，功能模块只依赖 core/*，各自可单独单测。

import { Doc, Panel, Tab, activePanelId, docs, panels, tabs } from "./app-state";

export function getPanel(panelId: number): Panel | undefined {
  return panels.get(panelId);
}

export function activePanel(): Panel | undefined {
  return panels.get(activePanelId);
}

export function activeTab(): Tab | undefined {
  const p = activePanel();
  return p ? tabs.get(p.activeTabId) : undefined;
}

export function panelOfTab(tabId: number): Panel | undefined {
  for (const p of panels.values()) {
    if (p.tabs.includes(tabId)) return p;
  }
  return undefined;
}

/** 实例所属文档（实例必然已注册文档；缺失视为不变量破坏，抛错暴露）。 */
export function docOf(tab: Tab): Doc {
  const doc = docs.get(tab.docId);
  if (!doc) throw new Error(`文档记录缺失：docId=${tab.docId}`);
  return doc;
}

/** 文档的全部实例（跨面板）。 */
export function instancesOfDoc(docId: number): Tab[] {
  const out: Tab[] = [];
  for (const t of tabs.values()) {
    if (t.docId === docId) out.push(t);
  }
  return out;
}

/**
 * 文档在本窗口的**可见**实例（B173）。
 *
 * 与 `instancesOfDoc` 只差一条：滤掉 `panelId < 0` 的隐藏实例（标签搬到别的窗口后本地
 * 留的那份，见 `remoteTabLocally` —— 它不进任何面板、用户在窗口里看不见，只为会话与
 * 热退出兜底而活着）。
 *
 * 同步滚动键对它没有意义（同步到一个看不见的实例，用户看不到任何效果），可它是
 * `tabs` 里的正式成员，按 `instancesOfDoc` 数会被算成第 2 份 ⇒ 窗口里明明只开了一份，
 * 同步键却露脸。子窗口尤其容易撞上：接过标签 → 交还 → 再打开，本地可能残留一份隐藏
 * 实例。显隐一律按**可见**实例数判。
 */
export function visibleInstancesOfDoc(docId: number): Tab[] {
  return instancesOfDoc(docId).filter((t) => t.panelId >= 0);
}

/** 这个实例此刻是否被某个面板的视图**正显示着**（不是「它的标签挂在那儿」）。 */
export function displayedPanelOfTab(tabId: number): Panel | undefined {
  for (const p of panels.values()) {
    if (p.view && p.viewTabId === tabId) return p;
  }
  return undefined;
}

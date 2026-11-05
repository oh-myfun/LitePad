// B461 · 差异标签的数据层（Task 1 只建三件纯事：输入描述、能不能开、块数变化的广播钩子）。
//
// ⚠️ 为什么 `leftText` 是**读取口**而不是字符串：A 档左栏正文就是 `doc.baseline`，而基线在
//    保存 / 以磁盘为准重载 / 换编码这些写点会被**整体换掉**（B458 的既定做法是给它一个读取口，
//    于是「存完盘差异自己清空」不需要任何人记得派发）。快照会把差异冻在打开那一刻，
//    用户按完 Ctrl+S 左右却还是旧的 —— 那就是仓库里第二条「什么算改过」的真相，禁止。
//
// ⚠️ 本模块**不** import 任何渲染层（surface / face / 侧栏面板都往这里长，反向 import 会成环）；
//    块数通知走 `setDiffBlocksListener` 这一格注册槽（预审 R6），布局刷新走下面的
//    `setDiffRenderHooks`（与 `src/ui.ts` 那四颗渲染回调同一手法）。
//
// 分工：`tier: "baseline"` 归 Task 5（与上次保存比较），`tier: "files"` 归 Task 6（任选两文件）；
// 块级计算与对齐归 Task 2；两侧底色与占位块归 Task 3。

import { activePanelId, docs, panels, type Doc, type Tab } from "../core/app-state";
import { activeTab, instancesOfDoc } from "../core/panels";
import { attachTabToPanel, makeDiffInstance } from "../doc-model";

/** 数据来源档位：`baseline` = 文档 vs 它上次保存的正文；`files` = 任选两个文件。 */
export type DiffTier = "baseline" | "files";

/** 一栏的身份（`original` 恒为左、`modified` 恒为右；「交换左右」换的是输入，不换身份）。 */
export type DiffSide = "original" | "modified";

/** 一张差异标签的输入描述 —— 差异标签本身不含正文，只含「怎么取到两侧正文」。 */
export interface DiffSpec {
  tier: DiffTier;
  /** 右栏 = 这份文档的另一个实例（可编辑、脏归它） */
  docId: number;
  /** 左栏正文的读取口。A 档实时读 `doc.baseline`；B 档闭包持有一份只读对比缓冲 */
  leftText: () => string;
  leftName: string;
  rightName: string;
  /** B 档左栏的文件路径（「刷新」要重读盘）；A 档为 null */
  leftPath: string | null;
}

/**
 * A 档能不能开（设计稿 ⑩·3 + Review Focus 1）。
 *
 * `doc.baseline === null` 是「只知道它脏、不知道原样是什么」那一种（热退出副本还原、跨窗口认领），
 * 此时任何一行都无从判增删 —— 打开差异编辑器会把每一行刷成绿色糊用户一脸。
 * 菜单那一项因此要置灰，调用方也必须先问这一句再建标签。
 */
export function canOpenAgainstBaseline(doc: Doc | null): doc is Doc {
  return !!doc && doc.baseline !== null;
}

/**
 * 差异标签的标题：「旧 ↔ 新」（设计稿 ⑥·A 档的措辞）。
 *
 * 两侧同名（A 档恒同名：对照的就是这份文档自己）时左栏补一句描述
 * ——「上次保存的 a.md ↔ a.md」，光看两个一样的名字分不出谁是基线谁是当前。
 * （补描述这一形在 VS Code 里叫 ForceDescription；用户可见文案不提工具名。）
 */
export function diffTitleOf(spec: DiffSpec, sameName: boolean): string {
  const left = sameName ? `上次保存的 ${spec.leftName}` : spec.leftName;
  return `${left} ↔ ${spec.rightName}`;
}

/**
 * 界面那四颗回调（main.ts 在 bootstrap 期注入，与 `src/ui.ts` 的渲染回调同一手法）。
 *
 * 为什么注入而不是直接 import：`src/ui.ts` 在**模块顶层**就取 DOM 节点（`el("#layout-area")`），
 * 而本模块的类型被 `core/app-state` 与 `doc-model` 依赖 ⇒ 一旦 import 它，任何只碰数据层的
 * 单测（`tests/diff-model.test.ts` 是 node 环境）都会在加载阶段炸掉。
 * `tabs/lifecycle` 那一条也同理：它已经 import 了 `diff/surface`，surface 又 import 本模块，
 * 反过来 import lifecycle 就是环（预审 R6 同一口径：本模块不认识渲染层）。
 */
interface DiffRenderHooks {
  rebuildLayout(): void;
  refreshAll(): void;
  renderPanelTabs(panelId: number): void;
  showMessage(text: string, isError?: boolean): void;
}
let hooks: DiffRenderHooks = {
  rebuildLayout: () => {},
  refreshAll: () => {},
  renderPanelTabs: () => {},
  showMessage: () => {},
};

export function setDiffRenderHooks(next: DiffRenderHooks): void {
  hooks = next;
}

/**
 * 把一张差异标签挂到指定面板（Task 6 的「任选两文件」也走这一处，只差 spec）。
 *
 * 顺序照仓库既定的那条「新标签进面板」链路（`src/io/files.ts:227` 同形）：
 * 建实例 → 入面板 → 重排布局 → 全局刷新 → 刷这一格的标签条。
 * `rebuildLayout()` 是关键的那一发：旁路的挂点就在它底下的 `mountView` 里
 * （Task 1 接的那三个点），不重排就只有一颗 view 挂在数据层里、界面上看不见。
 */
export function attachDiffTab(doc: Doc, spec: DiffSpec, panelId: number): Tab {
  // 右栏那份正文取**现有实例的现值**，不是 `doc.baseline`：用户可能改了还没存，
  // 差异标签要显示的就是他屏幕上那一份（脏归文档，Ctrl+S 仍走主干那条链）。
  const text = instancesOfDoc(doc.tabId)[0]?.state.doc.toString() ?? doc.baseline ?? "";
  const tab = makeDiffInstance(doc, panelId, text, spec);
  const panel = panels.get(panelId);
  if (panel) attachTabToPanel(tab, panel);
  hooks.rebuildLayout();
  hooks.refreshAll();
  hooks.renderPanelTabs(panelId);
  return tab;
}

/**
 * 「现在这一刻能不能开 A 档」的唯一一份答案：能 ⇒ 那份文档的 docId；不能 ⇒ `null`。
 *
 * 键盘上下文闸（不抢键）、菜单那一条（置灰）、标签右键那一条（置灰 + 文案说明）与
 * `openBaselineDiff` 的第一行都问这一颗 ⇒ 不会出现四处各算一遍、其中一处算歪。
 */
export function baselineDiffTarget(): number | null {
  const tab = activeTab();
  if (!tab) return null;
  const doc = docs.get(tab.docId) ?? null;
  return canOpenAgainstBaseline(doc) ? doc.tabId : null;
}

/**
 * A 档：与上次保存比较，开到活动面板（设计稿 ⑥·A 档 + 用户拍板 ④·6「新开一张」）。
 *
 * 第一行就是那道闸：`doc.baseline === null` 时任何一行都无从判增删，打开只会把整屏刷成
 * 绿色（Review Focus 1）。菜单/右键那两处也问同一颗 `canOpenAgainstBaseline` ⇒ 置灰与
 * 兜底同源，不会出现「点得动但什么也没有」。
 */
export async function openBaselineDiff(docId: number): Promise<number | null> {
  const doc = docs.get(docId) ?? null;
  if (!canOpenAgainstBaseline(doc)) {
    hooks.showMessage("这份文档还没有可比对的已保存版本", true);
    return null;
  }
  const spec: DiffSpec = {
    tier: "baseline",
    docId,
    // 读取口，不是快照（文件头那条纪律）：基线在保存/重载时被整体换掉，
    // 存完盘这一栏自己就空了，不需要任何一处记得派发。
    leftText: () => docs.get(docId)?.baseline ?? "",
    leftName: doc.name,
    rightName: doc.name,
    leftPath: null,
  };
  return attachDiffTab(doc, spec, activePanelId).tabId;
}

/**
 * 块数变化的唯一通知槽（单槽，不是多播 —— 目前只有侧栏那一块视图消费它）。
 *
 * 谁注册：侧栏差异面板（Task 9）。谁广播：持有 surface 的那一侧（Task 2/4 的重算点）。
 * 传 `null` 是注销（抽屉收起 / 测试收尾），不是「关掉通知」。
 */
let blocksListener: ((spec: DiffSpec) => void) | null = null;

export function setDiffBlocksListener(fn: ((spec: DiffSpec) => void) | null): void {
  blocksListener = fn;
}

/** 广播一次「这张标签的块数/内容变了」。没人注册就是空转，不许抛。 */
export function notifyDiffBlocks(spec: DiffSpec): void {
  blocksListener?.(spec);
}

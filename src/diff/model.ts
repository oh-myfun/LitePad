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

import { activePanelId, docs, panels, tabs, type Doc, type Tab } from "../core/app-state";
import { activeTab, instancesOfDoc } from "../core/panels";
import { attachTabToPanel, makeDiffInstance } from "../doc-model";
import { readCompareText } from "../ipc/api";
import { baseName } from "./compare";

/** 数据来源档位：`baseline` = 文档 vs 它上次保存的正文；`files` = 任选两个文件。 */
export type DiffTier = "baseline" | "files";

/** 一栏的身份（`original` 恒为左、`modified` 恒为右；「交换左右」换的是输入，不换身份）。 */
export type DiffSide = "original" | "modified";

/** 一张差异标签的输入描述 —— 差异标签本身不含正文，只含「怎么取到两侧正文」。 */
export interface DiffSpec {
  tier: DiffTier;
  /** 右栏 = 这份文档的另一个实例（可编辑、脏归它） */
  docId: number;
  /** 左栏正文的读取口。A 档实时读 `doc.baseline`；B 档按设计稿 ⑩·1：那条 path 开着就读
   *  那份文档的现值，没开着才读一次盘（闭包持有的只读对比缓冲）。 */
  leftText: () => string;
  leftName: string;
  rightName: string;
  /** B 档左栏的文件路径；A 档为 null。Task 8 的「刷新」只有**没开着**那一路才有缓冲要重读
   *  —— 开着那一栏就是那份文档自己，跟着它的键入走，没有第二份真相可刷。 */
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
  /** 把已在册的那张差异标签露出来（复用路径；模型不自己写 `activeTabId`，那条顺序纪律在 lifecycle）。 */
  switchTab(panelId: number, tabId: number): void;
}
let hooks: DiffRenderHooks = {
  rebuildLayout: () => {},
  refreshAll: () => {},
  renderPanelTabs: () => {},
  showMessage: () => {},
  switchTab: () => {},
};

export function setDiffRenderHooks(next: DiffRenderHooks): void {
  hooks = next;
}

/**
 * 那份文档**此刻在屏幕上那一份**正文（唯一的一处取法 —— 右栏与「已开着的左栏」都读它）。
 *
 * 取现有实例的现值而不是 `doc.baseline`：用户可能改了还没存，差异面要显示的就是他屏幕上
 * 那一份。包成读取口交给 `spec.leftText`，于是它跟着那一格的键入走，不是打开那一刻的抄本。
 */
function liveTextOf(doc: Doc): string {
  return instancesOfDoc(doc.tabId)[0]?.state.doc.toString() ?? doc.baseline ?? "";
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
  // 右栏那份正文取**现有实例的现值**，不是 `doc.baseline`（脏归文档，Ctrl+S 仍走主干那条链）。
  const tab = makeDiffInstance(doc, panelId, liveTextOf(doc), spec);
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
 * 两张档的「已经开过就复用」共用一颗寻址口（R32：不 copy-paste 两遍循环）。
 * 谓词自己判 tier / docId / leftPath，这里只管扫在册标签。
 */
function findDiffTab(match: (t: Tab) => boolean): Tab | null {
  for (const t of tabs.values()) {
    if (t.kind === "diff" && match(t)) return t;
  }
  return null;
}

/** 这份文档现在那张 A 档差异标签（同一文档只留一张 ⇒ 连按不会在标签条上叠同名标签）。 */
function findBaselineDiffTab(docId: number): Tab | null {
  return findDiffTab((t) => t.docId === docId && t.diff?.tier === "baseline");
}

/** 这对文件现在那张 B 档差异标签（左 = 同一路径归一后相同，右 = 同一份文档）。 */
function findFilesDiffTab(leftNorm: string, rightDocId: number): Tab | null {
  return findDiffTab(
    (t) =>
      t.docId === rightDocId &&
      t.diff?.tier === "files" &&
      normPath(t.diff.leftPath ?? "\u0000") === leftNorm,
  );
}

/**
 * 「开不出 A 档」那句说明。
 *
 * 三处出口共用一句：模型被直接调用时、以及命令面板那一路（它不经过 `shortcutApplies` 闸，
 * `main.ts` 得自己把话说出来）。写两遍同样的中文，就会有一遍改了另一遍没改。
 */
export const BASELINE_UNKNOWN_MESSAGE = "这份文档还没有可比对的已保存版本";

/**
 * A 档：与上次保存比较，开到活动面板（设计稿 ⑥·A 档 + 用户拍板 ④·6「新开一张」）。
 *
 * 第一行就是那道闸：`doc.baseline === null` 时任何一行都无从判增删，打开只会把整屏刷成
 * 绿色（Review Focus 1）。菜单/右键那两处也问同一颗 `canOpenAgainstBaseline` ⇒ 置灰与
 * 兜底同源，不会出现「点得动但什么也没有」。
 *
 * 「新开一张」相对的是**原文标签**，不是每点一次多一张：同一份文档的差异面只留一张，
 * 再点一次就把它露出来（两张一字不差的标签除了占位不携带任何信息）。
 */
export async function openBaselineDiff(docId: number): Promise<number | null> {
  const doc = docs.get(docId) ?? null;
  if (!canOpenAgainstBaseline(doc)) {
    hooks.showMessage(BASELINE_UNKNOWN_MESSAGE, true);
    return null;
  }
  const existing = findBaselineDiffTab(doc.tabId);
  if (existing) {
    const panel = panels.get(existing.panelId);
    if (panel && panel.activeTabId !== existing.tabId)
      hooks.switchTab(existing.panelId, existing.tabId);
    return existing.tabId;
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

/** 「两个路径指的是同一个文件」那句说明（判同看的是归一化后的写法，不是用户点进来的原样）。 */
const SAME_FILES_MESSAGE = "两个文件相同，不必比较";

/**
 * 路径寻址的归一化口径：与 `search/store.ts` / `explorer/panel.ts` 的 `normPath` 同一把尺
 * （分隔符折成 `\`、去尾、折叠大小写）。这三处各留一份一行函数，是仓库既定的口径
 * —— 改口径要三处一起改，比造一个跨模块小工具拖出一条依赖边划算。
 */
function normPath(p: string): string {
  return p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/** 按路径（归一化后）找在册文档；未落盘的文档没有路径，天然不参与。 */
function findDocByPath(pathNorm: string): Doc | null {
  if (!pathNorm) return null;
  for (const d of docs.values()) {
    if (d.path && normPath(d.path) === pathNorm) return d;
  }
  return null;
}

/**
 * 读一次「只读对比缓冲」的正文（B 档左栏那一路）。
 *
 * 读不成把原因原样说出来并交回 `null`，由调用方决定「不开这一张 / 什么都不换」——
 * 两处调用方必须同一个口径：一处闷着不响、一处弹说明，用户学到的就是两套规矩。
 */
async function readCompareSnapshot(path: string): Promise<string | null> {
  try {
    return (await readCompareText(path)).text;
  } catch (e) {
    hooks.showMessage(String(e), true);
    return null;
  }
}

/**
 * 按路径拿到那份文档：在册直接复用，不在册走主干那条 `doOpen`（复用 / 跨窗口取回那些
 * 既有语义全部白送）。`openFileDiff` 的右栏与 `swapDiffInputs` 的新右栏都问这一颗。
 *
 * 拿不到 ⇒ 交回 `null`；`doOpen` 失败时自己已经说过原因，这里不叠第二句。
 */
async function openDocForPath(path: string): Promise<Doc | null> {
  const pathNorm = normPath(path);
  const found = findDocByPath(pathNorm);
  if (found) return found;
  const { doOpen } = await import("../io/files");
  const openedTabId = await doOpen(path);
  if (openedTabId === null) return null;
  const opened = findDocByPath(pathNorm);
  if (opened) return opened;
  // doOpen 报的是**标签** id：复用既有文档那一支时按标签反查那份 doc。
  const t = tabs.get(openedTabId);
  return t ? (docs.get(t.docId) ?? null) : null;
}

/**
 * B 档左栏的正文读取口（设计稿 ⑩·1 那句「若那个 path 恰好已经开着，直接复用它的正文，
 * 不再读一遍盘」在这里落地；裁决 R33）。
 *
 * - 已经开着 ⇒ 交一个读那份文档**现值**的读取口（与右栏同一颗 `liveTextOf`）：屏幕上两侧
 *   显示的就是用户正在看的那两份内容，盘上那份脏改动不会被偷偷当成对照物。
 * - 没开着 ⇒ 读一次盘当只读对比缓冲（不注册监听、不进在场广播、不进最近打开）。
 *
 * 交回 `null` = 盘也读不成（那句说明已由 `readCompareSnapshot` 说过）。
 * Task 8 的「刷新」只需要在**没开着**那一路重读盘换掉这份缓冲；开着那一路跟着那份文档走。
 */
async function compareLeftTextReader(path: string): Promise<(() => string) | null> {
  const openDoc = findDocByPath(normPath(path));
  if (openDoc) return () => liveTextOf(openDoc);
  const snapshot = await readCompareSnapshot(path);
  return snapshot === null ? null : () => snapshot;
}

/**
 * B 档：任选两个文件开一张只读差异（设计稿 ⑩·1）。
 *
 * 口径：
 * - **右栏必须是那份文档本身**：`openDocForPath` —— 在册就复用它的 doc（不重读盘、不另立
 *   文档），不在册走主干那条 `doOpen`。
 * - **左栏是只读对比缓冲**（`compareLeftTextReader`）：那个 path 恰好已经开着就**直接复用
 *   它的正文**（读取口跟着那一格走，不再读一遍盘），没开着才 `readCompareText` 读一次盘。
 *   两条都不进文档登记表、不装监听 ⇒ 没有「外部已修改」那一路弹窗。
 * - 同一对文件只留一张（R32，与 A 档同形）：再点一次把它露出来。
 *
 * `io/files` 用动态 import：它顺着 `ui.ts` 摸 DOM，静态引会把 node 环境的模型层单测炸掉。
 */
export async function openFileDiff(leftPath: string, rightPath: string): Promise<number | null> {
  const leftNorm = normPath(leftPath);
  const rightNorm = normPath(rightPath);
  if (leftNorm === rightNorm) {
    hooks.showMessage(SAME_FILES_MESSAGE, true);
    return null;
  }

  const rightDoc = await openDocForPath(rightPath);
  if (!rightDoc) return null;

  const existing = findFilesDiffTab(leftNorm, rightDoc.tabId);
  if (existing) {
    const panel = panels.get(existing.panelId);
    if (panel && panel.activeTabId !== existing.tabId)
      hooks.switchTab(existing.panelId, existing.tabId);
    return existing.tabId;
  }

  const leftText = await compareLeftTextReader(leftPath);
  if (!leftText) return null;
  const spec: DiffSpec = {
    tier: "files",
    docId: rightDoc.tabId,
    leftText,
    leftName: baseName(leftPath),
    rightName: rightDoc.name,
    leftPath,
  };
  return attachDiffTab(rightDoc, spec, activePanelId).tabId;
}

/**
 * 「交换左右」的换算（Task 8 那颗键调它；A 档那一项置灰不调）。
 *
 * 只对 B 档有意义：A 档交换 = 把「还没存盘的改动」变成对照物，破坏「右栏就是那份
 * 文档本身」这条反目标 ⇒ 原样交回。B 档：拿原左栏路径那份文档当新右栏（`openDocForPath`，
 * 复用主干那条找已有 doc 的路），新左栏走 `compareLeftTextReader`（原右栏那份 doc 就在册
 * ⇒ 交的是它的现值读取口，不读盘），算出一份**新 spec** 交回；`tab.diff` 的落笔与 surface
 * 的 retarget 归调用方（模型不认识渲染层）。
 */
export async function swapDiffInputs(spec: DiffSpec): Promise<DiffSpec> {
  if (spec.tier !== "files" || !spec.leftPath) return spec;
  const oldRightDoc = docs.get(spec.docId);
  const oldRightPath = oldRightDoc?.path ?? "";
  // doc 不在册（标签被拆了）或没落盘 ⇒ 交换无从谈起，原样交回。
  // ⚠️ `!oldRightDoc` 这一问同时是给 tsc 的收窄依据 —— 只判 `oldRightPath` 的话
  // 下面 `oldRightDoc.name` 会带着「possibly null」发红（Task 6 门禁真抓到过）。
  if (!oldRightDoc || !oldRightPath) return spec;

  const newRightDoc = await openDocForPath(spec.leftPath);
  if (!newRightDoc) return spec; // 开不出来 ⇒ 什么都不换（doOpen 已经说过原因）

  const leftText = await compareLeftTextReader(oldRightPath);
  if (!leftText) return spec;
  return {
    tier: "files",
    docId: newRightDoc.tabId,
    leftText,
    leftName: oldRightDoc.name,
    rightName: newRightDoc.name,
    leftPath: oldRightPath,
  };
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

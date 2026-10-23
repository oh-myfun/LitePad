// 悬浮查找 / 替换栏 + 跨文档搜索（从 main.ts 拆出，解耦第十二步 / #413）。
//
// 职责：查找栏句柄与开关（ensureFindBar / openFindBar / resetFindAll）、编辑器查找
// （applyFindQuery / stepFind / replaceCurrent / replaceAllInScope）、预览查找桥
// （findSpecOf / applyPreviewFindToPanel）、跨文档搜索（searchOpenDocs / runFindInDocs /
// openFindHit / updateDocBadge）、重定位（retargetFindBar）。
// 零外部函数依赖——只依赖 core/* + ui + doc-model + tabs + shell/* + editor/*，
// 对 main.ts 零反向依赖。（PreviewFindSpec 类型在此定义；markdown.ts 反向 import 它——
// 仅类型，运行期无环。）

import { docs, panels, tabs, type Panel } from "../core/app-state";
import { activePanel, instancesOfDoc } from "../core/panels";
import {
  buildFindQuery,
  clearFindQuery,
  findMatches,
  nextMatchIndex,
  preserveCase,
  restrictToRange,
  setFindQuery,
  type FindMatch,
} from "../editor/find";
import { isDirtyVsBaseline, isMdTab } from "../doc-model";
// 锁的写闸门取自叶子模块（`src/markdown.ts` 反向 import 着本模块，经它取就成依赖环）
import { irEditable } from "../markdown/ir-state";
import { freshTextOfDoc, renderPanelTabs, switchTab } from "../tabs";
import { el, refreshTitle } from "../ui";
import {
  createFindBar,
  type FindBarHandle,
  type FindBarQuery,
  type FindHit,
} from "../shell/findbar";
import { EditorView } from "@codemirror/view";

/** 预览侧查找规格（M5 预览查找用）。 */
export type PreviewFindSpec = {
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
} | null;

// ---------------------------------------------------------------- 悬浮查找 / 替换栏

/**
 * 查找入口：编辑器内不再嵌 CM6 搜索面板，查找/替换统一收敛到这一个应用级浮层
 * （不绑定文件/面板，切换标签、分屏都不会自动关闭）。
 * 按用户要求：范围不用下拉菜单——跨文档能力做成一个「所有打开的文档」勾选框；
 * 文件夹搜索整体不做（不读盘）。
 */
let findBar: FindBarHandle | null = null;

/**
 * 跨文档查找的命中表与游标（B80）。
 *
 * ⚠️ 命中表必须由主程序持有，不能放回查找栏：只有这里才知道怎么切标签、怎么把
 * 命中处选中并滚到视野中间（`openFindHit`）。查找栏那边只落一个**总数**，
 * 用来渲染文档图标右上角的徽标。
 *
 * 既然不再有结果列表，`findHits` 就只服务于**步进**：Enter / 上下箭头在跨文档范围下
 * 逐条跳转（VS Code 的多文件结果在侧边栏搜索视图里，我们这一栏等价于「按顺序走」）。
 */
let findHits: FindHit[] = [];
/** 当前停留的命中下标；-1 = 还没定位（下一次步进从表头/表尾开始） */
let findHitIndex = -1;

/** 清空跨文档命中（查询变了、关栏、熄掉跨文档开关时都要调）。 */
function resetFindAll(bar: FindBarHandle | null = findBar): void {
  findHits = [];
  findHitIndex = -1;
  bar?.setDocIndex(0, 0);
}

function ensureFindBar(): FindBarHandle {
  if (findBar) return findBar;
  findBar = createFindBar(el("app"), {
    onQueryChange: (q) => applyFindQuery(q),
    onStep: (dir, q) => stepFind(dir, q),
    onReplace: (q) => replaceCurrent(q),
    onReplaceAll: (q) => replaceAllInScope(q),
    onClose: () => {
      clearFindHighlight();
      resetFindAll();
    },
  });
  return findBar;
}

/** 打开查找栏（种子一般为当前选中的文本）。 */
function openFindBar(focus: "find" | "replace" = "find"): void {
  const bar = ensureFindBar();
  // 重开时按当前选区重新播种（用户可能刚重新选了一段）
  if (findSelectionOn) seedFindSelectionAnchor();
  bar.open(selectedTextInActiveView(), focus === "replace");
  if (focus === "replace") bar.focusReplace();
  else bar.focusFind();
}

/** 活动视图当前选中的文本（单行且非空才作为查找种子）。 */
function selectedTextInActiveView(): string {
  const view = activePanel()?.view?.view;
  if (!view) return "";
  const sel = view.state.selection.main;
  if (sel.empty) return "";
  const text = view.state.sliceDoc(sel.from, sel.to);
  return text.includes("\n") ? "" : text;
}

function findOptionsOf(q: FindBarQuery) {
  return {
    search: q.text,
    caseSensitive: q.caseSensitive,
    wholeWord: q.wholeWord,
    regexp: q.regexp,
  };
}

/**
 * 活动视图当前选区（非空）起点/终点。
 * ⚠️ **只在播种锚点时调用**（见 `seedFindSelectionAnchor`）。判断作用范围一律读冻结的
 * 锚点 —— 别在这里实时读：步进会把选区换成命中本身。
 */
function activeSelectionRange(): { from: number; to: number } | null {
  const view = activePanel()?.view?.view;
  if (!view) return null;
  const sel = view.state.selection.main;
  if (sel.empty) return null;
  return { from: Math.min(sel.from, sel.to), to: Math.max(sel.from, sel.to) };
}

/** 活动编辑器所属标签 id（`tabs` 的 key）；没有活动视图时返回 null。 */
function activeTabIdOf(): number | null {
  const p = activePanel();
  return p && p.viewTabId !== null ? p.viewTabId : null;
}

/**
 * 「在选区中查找」的**冻结**选区锚点。
 *
 * ⚠️ 为什么不能每次实时读选区：`stepFind()` 步进时会把编辑器选区设成**命中本身**，
 * 于是第二次点「下一个」时范围就塌缩成「只剩这一个命中」（用户实测反馈）。
 * 因此锚点只在**用户动作**时播种：开关由关→开、重开查找栏、切换文档；
 * 导航（上/下一个、替换）全程只读，不改。
 *
 * 同时记住所属标签 id：切文档后旧偏移量没有意义，必须重取。
 */
let findSelectionAnchor: { docId: number; from: number; to: number } | null = null;
/** 上一轮的「在选区中查找」开关值，用于识别「刚被打开」这一瞬间。 */
let findSelectionOn = false;

/** 用当前选区播种锚点（只在用户动作时调用）。 */
function seedFindSelectionAnchor(): void {
  const range = activeSelectionRange();
  const docId = activeTabIdOf();
  findSelectionAnchor = range && docId !== null ? { docId, from: range.from, to: range.to } : null;
}

/**
 * 当前生效的选区限制（**只读**，绝不改锚点）。
 * 锚点为空、或它属于别的文档时返回 null（= 不限制）。
 */
function currentFindRestrict(q: FindBarQuery): { from: number; to: number } | null {
  if (!q.inSelection) return null;
  const a = findSelectionAnchor;
  if (!a || a.docId !== activeTabIdOf()) return null;
  return { from: a.from, to: a.to };
}

/** 把查询写到全部可见视图（高亮同步；离屏实例不参与高亮）。 */
function applyFindQuery(q: FindBarQuery): void {
  const query = buildFindQuery(findOptionsOf(q));
  // 开关刚被打开 / 关掉 → 播种或清除锚点。只有用户点开关会改 inSelection，
  // 导航不会，所以冻结的锚点不会被步进改掉的选区带偏。
  if (q.inSelection !== findSelectionOn) {
    findSelectionOn = q.inSelection;
    if (q.inSelection) seedFindSelectionAnchor();
    else findSelectionAnchor = null;
  }
  const restrict = currentFindRestrict(q);
  const active = activePanel();
  for (const p of panels.values()) {
    if (!p.view) continue;
    // 选区限制只作用于活动编辑器（其余面板没有这份选区，按全文高亮）
    const r = p === active ? restrict : null;
    p.view.view.dispatch({ effects: setFindQuery.of({ query, activeFrom: null, restrict: r }) });
  }
  applyPreviewFindEverywhere(q);
  // 跨文档范围：查询一变，上一次的命中表就作废 —— 这里直接重搜一次，
  // 让文档图标右上角的总数跟着实时走（与 VS Code 搜索视图「改选项即重跑」一致）。
  // 非跨文档范围则把旧的命中表清掉，免得下次点亮开关时徽标挂着一个过期的数字。
  if (q.allDocs) runFindInDocs(q);
  else resetFindAll();
  refreshFindCount();
}

/** 预览态查找高亮：md 预览面板（源码模式由编辑器装饰覆盖）。 */
function applyPreviewFindEverywhere(q: FindBarQuery): void {
  const spec = findSpecOf(q);
  for (const p of panels.values()) {
    applyPreviewFindToPanel(p, spec);
  }
}

function findSpecOf(q: FindBarQuery): PreviewFindSpec {
  return q.text
    ? { text: q.text, caseSensitive: q.caseSensitive, wholeWord: q.wholeWord, regexp: q.regexp }
    : null;
}

function applyPreviewFindToPanel(p: Panel, spec: PreviewFindSpec): void {
  if (!p.preview) return;
  const tab = tabs.get(p.activeTabId);
  if (!tab || !isMdTab(tab) || tab.viewMode === "source") return;
  p.preview.applyFind(spec);
}

function clearFindHighlight(): void {
  for (const p of panels.values()) {
    if (p.view) clearFindQuery(p.view.view);
    p.preview?.applyFind(null);
  }
}

/** 保留大小写：复用 find.ts 的纯函数（VS Code 同款算法）。 */
function applyPreserveCase(matchText: string, replacement: string): string {
  return preserveCase(matchText, replacement);
}

/**
 * 把命中集合按「在选区中查找」限制到**锚定**的选区内（复用 find.ts 的纯函数）。
 * ⚠️ 读的是冻结锚点而非实时选区 —— 否则步进一次就只剩一个命中。
 */
function restrictMatches(matches: FindMatch[], q: FindBarQuery): FindMatch[] {
  return restrictToRange(matches, currentFindRestrict(q));
}

function refreshFindCount(): void {
  const bar = findBar;
  if (!bar) return;
  const q = bar.getQuery();
  // 跨文档范围：计数口径与「当前文档 / 选区」**完全一致** —— 有文本没命中 = 「无匹配」，
  // 有命中 = 「当前序号 / 总数」（总数来自跨文档命中表，序号即 findHitIndex）。
  // ⚠️ 早先这里一律写「无内容」（当时认为总数已在徽标上，会误导），副作用是
  //    prev/next 被置灰、结果区看起来没更新 —— 用户反馈「激活多文件搜索没反应」的根因。
  //    命中总数是「几个文档有结果」另有徽标 a/b，与这里的「第几个命中」不冲突。
  if (q.allDocs) {
    if (findHits.length === 0) bar.setCount(q.text ? "无匹配" : "");
    else bar.setCount(`${(findHitIndex >= 0 ? findHitIndex : 0) + 1} / ${findHits.length}`);
    return;
  }
  // 预览态：计数与当前项来自预览高亮（预览可见文本与源码一一对应，步进以它为准）
  const panel = activePanel();
  const tab = panel ? tabs.get(panel.activeTabId) : undefined;
  if (panel && tab && isMdTab(tab) && tab.viewMode === "preview" && panel.preview) {
    const st = panel.preview.findState();
    if (st.count === 0) {
      bar.setCount(q.text ? "无匹配" : "无内容");
    } else {
      const cur = st.active >= 0 ? st.active : 0;
      bar.setCount(`${cur + 1} / ${st.count}`);
    }
    return;
  }
  const view = panel?.view?.view;
  if (!view) return;
  const query = buildFindQuery(findOptionsOf(q));
  const matches = restrictMatches(findMatches(view.state, query), q);
  if (matches.length === 0) {
    bar.setCount(q.text ? "无匹配" : "");
    return;
  }
  const idx = nextMatchIndex(matches, view.state.selection.main.head, 1);
  bar.setCount(`${idx + 1} / ${matches.length}`);
}

/**
 * 步进：当前文档范围内跳到上一个 / 下一个命中（到头环绕）。
 * ⚠️ 跨文档范围（点亮了文档图标）要转给 `stepFindInDocs` —— 命中表在主程序手里，
 * 这里的 `view` 只是活动编辑器，走不到别的文档去。
 */
function stepFind(dir: 1 | -1, q: FindBarQuery): void {
  if (q.allDocs) {
    stepFindInDocs(dir, q);
    return;
  }
  const panel = activePanel();
  if (!panel) return;
  const tab = panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
  // 预览态：在预览高亮里步进 + 滚动到命中处（隐藏编辑器收不到滚动）
  if (tab && isMdTab(tab) && tab.viewMode === "preview" && panel.preview) {
    if (!q.text) {
      findBar?.setCount("");
      return;
    }
    panel.preview.stepFind(dir);
    refreshFindCount();
    return;
  }
  const view = panel.view?.view;
  if (!view) return;
  const query = buildFindQuery(findOptionsOf(q));
  const matches = restrictMatches(findMatches(view.state, query), q);
  if (matches.length === 0) {
    findBar?.setCount(q.text ? "无匹配" : "");
    return;
  }
  const idx = nextMatchIndex(matches, view.state.selection.main.head, dir);
  const m = matches[idx];
  view.dispatch({
    selection: { anchor: m.from, head: m.to },
    effects: [
      EditorView.scrollIntoView(m.from, { y: "center" }),
      setFindQuery.of({
        query,
        activeFrom: m.from,
        // 冻结锚点：步进刚把选区换成了命中本身，这里若实时读选区就会自我塌缩
        restrict: currentFindRestrict(q),
      }),
    ],
  });
  if (tab) tab.state = view.state;
  findBar?.setCount(`${idx + 1} / ${matches.length}`);
}

/** 替换当前命中（没有选中命中时，先跳到下一个再替换下一次点击生效）。 */
function replaceCurrent(q: FindBarQuery): void {
  const panel = activePanel();
  const view = panel?.view?.view;
  if (!panel || !view) return;
  const tab = panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
  // B352-9：替换是**程序化** `dispatch`，那一发不带 `Transaction.userEvent` ⇒ 锁的 changeFilter
  // 天然放行它（那条只管键入/粘贴/拖放）。所以这一发必须自己问锁，且闸要排在派发之前。
  if (tab && !irEditable(tab)) {
    findBar?.setStatus("即时渲染已锁定");
    return;
  }
  const query = buildFindQuery(findOptionsOf(q));
  const matches = restrictMatches(findMatches(view.state, query), q);
  const sel = view.state.selection.main;
  const target =
    matches.find((m) => m.from === sel.from && m.to === sel.to) ??
    (matches.length ? matches[nextMatchIndex(matches, sel.head, 1)] : undefined);
  if (!target) {
    findBar?.setStatus("没有可替换的匹配");
    return;
  }
  const matched = view.state.sliceDoc(target.from, target.to);
  const insert = q.preserveCase ? applyPreserveCase(matched, q.replace) : q.replace;
  const nextFrom = target.from + insert.length;
  view.dispatch({
    changes: { from: target.from, to: target.to, insert },
    selection: { anchor: nextFrom },
    effects: [
      EditorView.scrollIntoView(nextFrom, { y: "center" }),
      setFindQuery.of({
        query,
        activeFrom: target.from,
        restrict: currentFindRestrict(q),
      }),
    ],
  });
  if (tab) tab.state = view.state;
  refreshFindCount();
  findBar?.setStatus("已替换 1 处");
}

/**
 * 全部替换。勾选「所有打开的文档」时遍历全部已打开文档（只改内存快照，
 * 落盘仍由各自的保存流程负责）；否则只改当前活动文档。
 */
function replaceAllInScope(q: FindBarQuery): void {
  // B352-9：只问**这一块**的锁一次。同源兄弟格与其它文档的写必须照旧放行（spec 那条
  // 「同源变更集 / 外部重载 ⇒ 放行」），所以不许在下面遍历里逐实例问一遍 —— 那等于把那条堵死。
  const here = activePanel();
  const lockedTab = here && here.viewTabId !== null ? tabs.get(here.viewTabId) : undefined;
  if (lockedTab && !irEditable(lockedTab)) {
    findBar?.setStatus("即时渲染已锁定");
    return;
  }
  if (!q.text) {
    findBar?.setStatus("请输入查找内容");
    return;
  }
  const query = buildFindQuery(findOptionsOf(q));
  if (!query) {
    findBar?.setStatus("查找内容无效（正则语法错误？）");
    return;
  }

  if (!q.allDocs) {
    const panel = activePanel();
    const view = panel?.view?.view;
    if (!panel || !view) return;
    const matches = restrictMatches(findMatches(view.state, query), q);
    if (matches.length === 0) {
      findBar?.setStatus("无匹配");
      return;
    }
    const changes = matches.map((m) => ({
      from: m.from,
      to: m.to,
      insert: q.preserveCase
        ? applyPreserveCase(view.state.sliceDoc(m.from, m.to), q.replace)
        : q.replace,
    }));
    view.dispatch({ changes });
    const tab = panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
    if (tab) tab.state = view.state;
    findBar?.setStatus(`已替换 ${matches.length} 处`);
    refreshFindCount();
    return;
  }

  let files = 0;
  let total = 0;
  for (const doc of docs.values()) {
    if (doc.readonly) continue;
    const insts = instancesOfDoc(doc.tabId);
    if (insts.length === 0) continue;
    const matches = findMatches(insts[0].state, query);
    if (matches.length === 0) continue;
    const changes = matches.map((m) => ({
      from: m.from,
      to: m.to,
      insert: q.preserveCase
        ? applyPreserveCase(insts[0].state.sliceDoc(m.from, m.to), q.replace)
        : q.replace,
    }));
    // 优先派发给正挂在视图上的实例——由 syncDocInstances 广播到兄弟实例并置脏；
    // 全部离屏时才直接改快照，并手动置脏
    const visible = insts.find((t) => {
      const p = panels.get(t.panelId);
      return !!p?.view && p.viewTabId === t.tabId;
    });
    if (visible) {
      const p = panels.get(visible.panelId)!;
      p.view!.view.dispatch({ changes });
      visible.state = p.view!.view.state;
    } else {
      for (const t of insts) t.state = t.state.update({ changes }).state;
      // 离屏实例改完快照后同样按「是否偏离基线」判（B112）：替换词与被替换词恰好
      // 相同时内容一字未变，不该挂上 ●。
      if (!doc.dirty && isDirtyVsBaseline(doc, freshTextOfDoc(doc))) {
        doc.dirty = true;
        refreshTitle();
        renderPanelTabs();
      }
    }
    files++;
    total += matches.length;
  }
  findBar?.setStatus(total === 0 ? "无匹配" : `已在 ${files} 个文档中替换 ${total} 处`);
  refreshFindCount();
}

/**
 * 在所有已打开的文档中查找（直接扫内存里的标签快照，不读盘）。
 *
 * ⚠️ **不设条数上限**（B80 去掉结果列表后，原先那个「最多 300 条」的保护就没意义了）：
 * 返回数组既是步进的命中表，也是徽标上「总匹配数」的来源 —— 截断会让徽标少报数。
 */
function searchOpenDocs(q: FindBarQuery): FindHit[] {
  const query = buildFindQuery(findOptionsOf(q));
  if (!query) return [];
  const out: FindHit[] = [];
  for (const doc of docs.values()) {
    const inst = instancesOfDoc(doc.tabId)[0];
    if (!inst) continue;
    const state = inst.state;
    for (const m of findMatches(state, query)) {
      const line = state.doc.lineAt(m.from);
      out.push({
        docId: doc.tabId,
        path: doc.path ?? "",
        name: doc.name,
        line: line.number,
        col: m.from - line.from + 1,
        text: line.text.trim().slice(0, 200),
        from: m.from,
        to: m.to,
      });
    }
  }
  return out;
}

/** 含结果的文档（按首次出现顺序去重），用于跨文档徽标的 b。 */
function docsWithHits(): number[] {
  const order: number[] = [];
  for (const h of findHits) if (!order.includes(h.docId)) order.push(h.docId);
  return order;
}

/** 跨文档徽标：a = 当前命中（findHitIndex）所属文档的序号，b = 含结果的文档数。 */
function updateDocBadge(): void {
  const docs = docsWithHits();
  const b = docs.length;
  let a = 0;
  if (findHitIndex >= 0 && findHits[findHitIndex]) {
    a = docs.indexOf(findHits[findHitIndex].docId) + 1;
  } else if (b > 0) {
    a = 1;
  }
  findBar?.setDocIndex(a, b);
}

/**
 * 跨文档查找：重算命中表 → 刷新徽标（`a/b`）。
 *
 * ⚠️ 09-20 起**只负责算，不负责显示**：计数与按钮状态一律交给 `refreshFindCount()`，
 * 与「当前文档」「选区」两种范围走同一个出口 —— 早先这里会顺手写 `setCount` 并播报一行
 * 「共 N 处匹配…」那条成功播报，结果 ① 那行提示在另外两种范围里都没有（不一致，已按用户
 * 要求删除）；② 写完还被紧随其后的 `refreshFindCount()` 覆盖成「无内容」，
 * 于是 prev/next 被置灰 —— 表现就是「点亮多文件搜索没反应」。
 */
function runFindInDocs(q: FindBarQuery): void {
  findHits = q.text ? searchOpenDocs(q) : [];
  findHitIndex = -1;
  updateDocBadge();
}

/**
 * 跨文档步进：在命中表里往前走 / 往后走（到头环绕），并把该命中处选中、滚到视野中间。
 *
 * 命中表为空有两种可能：①真的没命中；②用户没按回车、直接点箭头进来的。
 * 后者要先补搜一次 —— 否则「勾了文档图标点下一个没反应」。
 */
function stepFindInDocs(dir: 1 | -1, q: FindBarQuery): void {
  if (!q.text) {
    refreshFindCount();
    return;
  }
  if (findHits.length === 0) {
    // 补搜一次：查询/范围变化时主程序已经搜过，这里兜的是「命中表被清掉又直接点箭头」的路径
    runFindInDocs(q);
    if (findHits.length === 0) {
      refreshFindCount();
      return;
    }
    findHitIndex = dir > 0 ? 0 : findHits.length - 1;
  } else {
    findHitIndex = (findHitIndex + dir + findHits.length) % findHits.length;
  }
  updateDocBadge();
  openFindHit(findHits[findHitIndex]);
  refreshFindCount();
}

/** 跳到某条命中：切到该文档并把命中处选中、滚到视野中间。 */
function openFindHit(hit: FindHit): void {
  const insts = instancesOfDoc(hit.docId);
  if (insts.length === 0) return;
  const target = insts[0];
  switchTab(target.panelId, target.tabId);
  // 活动实例：选中命中区间并滚到视野中间（本地动作，保持 y:"center"）。
  const p = panels.get(target.panelId);
  if (p?.view && p.viewTabId === target.tabId) {
    p.view.view.dispatch({
      selection: { anchor: hit.from, head: hit.to },
      effects: EditorView.scrollIntoView(hit.from, { y: "center" }),
    });
    target.state = p.view.view.state;
  } else {
    target.state = target.state.update({ selection: { anchor: hit.from, head: hit.to } }).state;
  }
  activePanel()?.view?.focus();
}

/** 标签/面板切换后：浮层保持打开，把当前查询重新应用到新的活动视图。 */
function retargetFindBar(): void {
  // 换了文档 → 旧锚点的偏移量作废，按新文档的选区重取；
  // 同一文档时**不动**锚点（否则 F3 步进后的「命中选区」会被当成新锚点）。
  if (findSelectionOn && findSelectionAnchor?.docId !== activeTabIdOf()) seedFindSelectionAnchor();
  if (findBar?.isOpen()) findBar.retarget();
}

/** findBar 是本模块私有可变量（ensureFindBar 会重建）⇒ 以 getter 供外部读。 */
export function getFindBar(): FindBarHandle | null {
  return findBar;
}

export {
  resetFindAll,
  ensureFindBar,
  openFindBar,
  applyFindQuery,
  applyPreviewFindEverywhere,
  findSpecOf,
  applyPreviewFindToPanel,
  clearFindHighlight,
  refreshFindCount,
  stepFind,
  replaceCurrent,
  replaceAllInScope,
  searchOpenDocs,
  openFindHit,
  retargetFindBar,
};

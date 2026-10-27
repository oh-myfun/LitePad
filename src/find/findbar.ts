// 悬浮查找 / 替换栏（从 main.ts 拆出，解耦第十二步 / #413）。
//
// 职责：查找栏句柄与开关（ensureFindBar / openFindBar）、编辑器查找
// （applyFindQuery / stepFind / replaceCurrent / replaceAllInScope）、预览查找桥
// （findSpecOf / applyPreviewFindToPanel）、重定位（retargetFindBar）。
// ⚠️ **只管当前这一份文档**：跨文档 / 跨文件搜索 B389 起在 `src/search/*`（侧栏搜索视图），
// 这里不再持有命中表，也不再扫别的文档 —— 两处各扫一遍就会各报一个总数。
// 零外部函数依赖——只依赖 core/* + ui + doc-model + tabs + shell/* + editor/*，
// 对 main.ts 零反向依赖。（PreviewFindSpec 类型在此定义；markdown.ts 反向 import 它——
// 仅类型，运行期无环。）

import { panels, tabs, type Panel } from "../core/app-state";
import { activePanel } from "../core/panels";
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
import { isMdTab } from "../doc-model";
import { el } from "../ui";
import { createFindBar, type FindBarHandle, type FindBarQuery } from "../shell/findbar";
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
 * 按用户要求：范围不用下拉菜单，也不读盘 —— 跨文件那一条在侧栏搜索视图里（B389）。
 */
let findBar: FindBarHandle | null = null;

function ensureFindBar(): FindBarHandle {
  if (findBar) return findBar;
  findBar = createFindBar(el("app"), {
    onQueryChange: (q) => applyFindQuery(q),
    onStep: (dir, q) => stepFind(dir, q),
    onReplace: (q) => replaceCurrent(q),
    onReplaceAll: (q) => replaceAllInScope(q),
    onClose: () => clearFindHighlight(),
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
  const tab = tabs.get(p.activeTabId);
  if (!tab || !isMdTab(tab) || tab.viewMode === "source") return;
  // B397-1 · 这一条只服务**派生 DOM**那一臂。装饰那一臂（`deco_preview` 开着）预览侧就是
  // `p.view.view` 那颗 view，`applyFindQuery` 上面那个「遍历面板发 `setFindQuery`」的循环
  // 已经把它覆盖了；在这里再发一发给的是同一颗 view，只会把那条循环刚钉上的选区限制
  // （`restrict`）冲掉 ⇒ 选中一段再 Ctrl+F 变成全文高亮。
  if (!p.preview) return;
  p.preview.applyFind(spec);
}

/**
 * 「步进与计数该问哪颗 view」以前要一个 `findFaceOf` 来回答，因为装饰那一臂有第二颗 view，
 * 而隐藏那颗写不进 `scrollTop`（台账：只认 `clientHeight>0` 那一面）。B397-1 之后这个问题
 * 没有了：一格只有一颗 view，档位换的是 Compartment ⇒ 调用点直接读 `panel.view.view`，
 * 它现形时就是看得见的那一面。派生 DOM 那一臂的预览侧仍走 `panel.preview` 那条分支。
 */

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
  const view = panel?.view?.view ?? null;
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

/** 步进：在当前文档范围内跳到上一个 / 下一个命中（到头环绕）。 */
function stepFind(dir: 1 | -1, q: FindBarQuery): void {
  const panel = activePanel();
  if (!panel) return;
  const tab = panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
  // 预览态：在预览高亮里步进 + 滚动到命中处（隐藏编辑器收不到滚动）。
  // 装饰那一臂不走这里 —— 它 `panel.preview === null`，落到下面那颗 view 上，而那颗
  // view 此刻正是**看得见**的一面（B397-1：一格只有一颗 view，档位换的是 Compartment）。
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
  const step = {
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
  };
  view.dispatch(step);
  if (tab) tab.state = view.state;
  findBar?.setCount(`${idx + 1} / ${matches.length}`);
}

/** 替换当前命中（没有选中命中时，先跳到下一个再替换下一次点击生效）。 */
function replaceCurrent(q: FindBarQuery): void {
  const panel = activePanel();
  const view = panel?.view?.view;
  if (!panel || !view) return;
  const tab = panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
  if (!tab) return;
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
 * 全部替换：只改当前活动文档。
 * ⚠️ 跨文档 / 跨文件那一条在侧栏搜索视图里（`src/search/replace.ts`），这里不再管。
 */
function replaceAllInScope(q: FindBarQuery): void {
  if (!q.text) {
    findBar?.setStatus("请输入查找内容");
    return;
  }
  const query = buildFindQuery(findOptionsOf(q));
  if (!query) {
    findBar?.setStatus("查找内容无效（正则语法错误？）");
    return;
  }

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
}

/** 标签/面板切换后：浮层保持打开，把当前查询重新应用到新的活动视图。 */
function retargetFindBar(): void {
  // 换了文档 → 旧锚点的偏移量作废，按新文档的选区重取；
  // 同一文档时**不动**锚点（否则 F3 步进后的「命中选区」会被当成新锚点）。
  if (findSelectionOn && findSelectionAnchor?.docId !== activeTabIdOf()) seedFindSelectionAnchor();
  if (findBar?.isOpen()) findBar.retarget();
}

/**
 * 布局重画后重新钉一次浮层（B389-9）。
 * `renderSplitview` 每次都 `root.textContent = ""` 整棵重建 ⇒ 浮层盯着的那格 `.panel-host`
 * 成了脱离文档的旧元素，它自己那台 ResizeObserver 再也收不到信号。必须由布局重建方在
 * **新树进文档之后**点名一次（放在渲染回调里不够：回调跑在 append 之前，那时量到全是 0）。
 */
function relayoutFindBar(): void {
  findBar?.relayout();
}

/** findBar 是本模块私有可变量（ensureFindBar 会重建）⇒ 以 getter 供外部读。 */
export function getFindBar(): FindBarHandle | null {
  return findBar;
}

export {
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
  retargetFindBar,
  relayoutFindBar,
};

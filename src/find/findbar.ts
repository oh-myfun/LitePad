// 悬浮查找 / 替换栏（从 main.ts 拆出，解耦第十二步 / #413）。
//
// 职责：查找栏句柄与开关（ensureFindBar / openFindBar）、编辑器查找
// （applyFindQuery / stepFind / replaceCurrent / replaceAllInScope）、重定位（retargetFindBar）。
// ⚠️ **只管当前这一份文档**：跨文档 / 跨文件搜索 B389 起在 `src/search/*`（侧栏搜索视图），
// 这里不再持有命中表，也不再扫别的文档 —— 两处各扫一遍就会各报一个总数。
// 零外部函数依赖——只依赖 core/* + ui + doc-model + tabs + shell/* + editor/*，
// 对 main.ts 零反向依赖。B412 起预览/编辑档与源码共用同一颗 view，没有第二颗要单独送高亮。

import { panels, tabs } from "../core/app-state";
import { activePanel } from "../core/panels";
import { diffSurfaceOf } from "../diff/surface";
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
import { el } from "../ui";
import { createFindBar, type FindBarHandle, type FindBarQuery } from "../shell/findbar";
import { EditorView } from "@codemirror/view";

// ---------------------------------------------------------------- 悬浮查找 / 替换栏

/**
 * 查找入口：编辑器内不再嵌 CM6 搜索面板，查找/替换统一收敛到这一个应用级浮层
 * （不绑定文件/面板，切换标签、分屏都不会自动关闭）。
 * 按用户要求：范围不用下拉菜单，也不读盘 —— 跨文件那一条在侧栏搜索视图里（B389）。
 */
let findBar: FindBarHandle | null = null;

/** 差异格里查找**最后聚焦的那一栏**（焦点离开两栏时保持原值，与上游 `getFocusedCodeEditor` 同口径）。 */
let lastFindSide: "original" | "modified" = "modified";

/**
 * 查找/计数/步进/替换该作用在哪颗 view。
 *
 * 差异格里是**当前聚焦的那一栏**：左栏（`surface.left`）与右栏（`panel.view.view`）
 * 是两份不同的正文，上游的查找也挂在 `focusedEditor` 上。其余情况仍是活动面板那一颗。
 */
function findTargetView(): EditorView | null {
  const panel = activePanel();
  if (!panel) return null;
  const surface = diffSurfaceOf(panel);
  if (surface && surface.focusedSide() === "original") return surface.left;
  return panel.view?.view ?? null;
}

/**
 * B419（用户）：本轮「已替换 N 处」的累计数 —— 单次替换连点要累加。
 * 查询 / 替换串 / 搜索范围（选区）/ 当前文档任何一项变了都清零：那时上一发说的
 * 已经不是这一批匹配了。清零点只有 `clearReplaceStatus()` 一个，别分散写。
 */
let replacedCount = 0;

function clearReplaceStatus(): void {
  replacedCount = 0;
  findBar?.setStatus("");
}

function ensureFindBar(): FindBarHandle {
  if (findBar) return findBar;
  findBar = createFindBar(el("app"), {
    onQueryChange: (q) => applyFindQuery(q),
    // B419：替换串一变，累计数就作废（替换串不参与匹配，不必重跑搜索）。
    onReplaceTextChange: () => clearReplaceStatus(),
    onStep: (dir, q) => stepFind(dir, q),
    onReplace: (q) => replaceCurrent(q),
    onReplaceAll: (q) => replaceAllInScope(q),
    onClose: () => clearFindHighlight(),
  });
  // 差异格里「查找作用于当前聚焦的那一栏」：焦点换侧 ⇒ 目标 view、命中高亮、计数与
  // 替换入口一起换（旧侧高亮在 `applyFindQuery` 里清掉）。浮层是单例，监听只挂这一处。
  // `surface` 自己的 `focusin` 监听在 `view.dom` 上、比 document 先跑，读到的已是新的一侧。
  document.addEventListener("focusin", (event) => {
    const bar = findBar;
    if (!bar?.isOpen()) return;
    const panel = activePanel();
    const surface = diffSurfaceOf(panel);
    const right = panel?.view?.view ?? null;
    const target = event.target as Node | null;
    if (!surface || !right || !target) return;
    let side: "original" | "modified" | null = null;
    if (surface.left.dom.contains(target)) side = "original";
    else if (right.dom.contains(target)) side = "modified";
    if (!side || side === lastFindSide) return;
    lastFindSide = side;
    // 两侧不是同一份正文：勾着「在选区中查找」时锚点按文档偏移存，换侧必须重取。
    if (findSelectionOn) seedFindSelectionAnchor();
    syncFindBarReplaceable();
    bar.retarget();
  });
  return findBar;
}

/** 打开查找栏（种子一般为当前选中的文本）。 */
function openFindBar(focus: "find" | "replace" = "find"): void {
  const bar = ensureFindBar();
  const canReplace = replaceAllowedHere();
  bar.setReplaceEnabled(canReplace);
  lastFindSide = diffSurfaceOf(activePanel())?.focusedSide() ?? "modified";
  // 重开时按当前选区重新播种（用户可能刚重新选了一段）
  if (findSelectionOn) seedFindSelectionAnchor();
  bar.open(selectedTextInActiveView(), focus === "replace" && canReplace);
  if (focus === "replace" && canReplace) bar.focusReplace();
  else bar.focusFind();
  // B417：预览档 / 差异格左栏里按「在文件中替换」只能落到查找，并说清楚为什么没掀开替换行
  if (focus === "replace" && !canReplace) bar.setStatus(replaceBlockedReason());
}

/**
 * B417：这一档文档允不允许替换。预览档是「禁编辑的编辑模式」（B399）——文档锁着，
 * 替换没有落点；源码档与非 markdown 文档都照旧。
 * 差异格的**左栏是只读对照**（transforms 被只读过滤挡掉）⇒ 焦点在左栏时同样不给替换。
 */
function replaceAllowedHere(): boolean {
  const p = activePanel();
  const surface = diffSurfaceOf(p);
  if (surface && findTargetView() === surface.left) return false;
  const t = p && p.viewTabId !== null ? tabs.get(p.viewTabId) : undefined;
  return t?.viewMode !== "preview";
}

/** 替换入口为什么收着（写进浮层状态栏；两条禁法给各自的理由，别一律说成预览档）。 */
function replaceBlockedReason(): string {
  const surface = diffSurfaceOf(activePanel());
  if (surface && findTargetView() === surface.left) return "对照栏只读，不能在左侧替换";
  return "预览模式下不可替换";
}

/**
 * 把「当前文档能不能替换」同步到浮层上。三个入口：打开查找栏、换标签 / 换面板
 * （`retargetFindBar`）、档位切换（`markdown.ts` 的 `applyPanelMode` 这一发出口）。
 */
function syncFindBarReplaceable(): void {
  findBar?.setReplaceEnabled(replaceAllowedHere());
}

/** 活动视图当前选中的文本（单行且非空才作为查找种子）。 */
function selectedTextInActiveView(): string {
  const view = findTargetView();
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
  const view = findTargetView();
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
 * 因此锚点只在**用户动作**时播种：开关由关→开、重开查找栏、切换文档，以及 B419 起
 * 用户在编辑器里换了选区（拖选 / 键盘扩选 / Ctrl+A / 大纲跳转后的选段）。
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

/**
 * B419：我们自己发的步进 / 单次替换会把选区换成命中本身 —— 那不是「用户换了搜索范围」，
 * 不许据此重取锚点。dispatch 是同步的（updateListener 就在里面跑），一个布尔够用。
 */
let suppressSelectionRefresh = false;

function dispatchOwn(view: EditorView, spec: Parameters<EditorView["dispatch"]>[0]): void {
  suppressSelectionRefresh = true;
  try {
    view.dispatch(spec);
  } finally {
    suppressSelectionRefresh = false;
  }
}

/** 把查询写到全部可见视图（高亮同步；离屏实例不参与高亮）。 */
function applyFindQuery(q: FindBarQuery): void {
  // B417/B419：任何一次查询变更（打字 / 换选项 / 换文档 / 重开 / 换搜索范围）都让
  // 「已替换 N 处」退场 —— 那句话说的是上一发，留着就成了一条与实际匹配无关的残留。
  clearReplaceStatus();
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
  const target = findTargetView();
  for (const p of panels.values()) {
    if (!p.view) continue;
    const view = p.view.view;
    // 选区限制只作用于活动编辑器（其余面板没有这份选区，按全文高亮）
    const r = p === active ? restrict : null;
    // 差异格里只点亮**当前聚焦的那一栏**：两栏是两份正文，同一份查询派给两栏会让计数与
    // 「当前命中」说不清属于哪一侧（上游 `findController` 也只挂在 `focusedEditor` 上）。
    if (p === active && target && view !== target) {
      clearFindQuery(view);
      continue;
    }
    view.dispatch({ effects: setFindQuery.of({ query, activeFrom: null, restrict: r }) });
  }
  // 左栏不在 `panels` 那张表里（它是挂在右栏旁边的旁路）⇒ 单独按「是不是目标」派发/清除。
  for (const p of panels.values()) {
    const surface = diffSurfaceOf(p);
    if (!surface) continue;
    if (surface.left === target) {
      surface.left.dispatch({
        effects: setFindQuery.of({ query, activeFrom: null, restrict }),
      });
    } else {
      clearFindQuery(surface.left);
    }
  }
  refreshFindCount();
}

/**
 * B419（用户）：活动编辑器的选区**被用户换了**（拖选 / 键盘扩选 / Ctrl+A / 大纲跳转后的选段）。
 *
 * 查找栏开着、有查找内容、且勾着「在选区中查找」时，选区就是搜索范围 —— 范围变了结果
 * 必须跟着刷新，否则计数还是旧选区里那一套。
 *
 * 两条边界：
 *  · 空选区（点一下正文、跳到某行）**不动**：那不是「换了个更小的范围」，把锚点清掉会让
 *    结果突然扩回全文、与亮着的开关对不上（B304 那类「显示与行为两套口径」）。保留上一个
 *    非空选区当范围。
 *  · 我们自己的步进 / 替换也会改选区，那条路已被 `dispatchOwn` 的闸按住（见上）。
 */
function refreshFindOnSelectionChange(): void {
  if (suppressSelectionRefresh) return;
  const bar = findBar;
  if (!bar?.isOpen()) return;
  const q = bar.getQuery();
  if (!q.text || !q.inSelection) return;
  if (!activeSelectionRange()) return;
  seedFindSelectionAnchor();
  applyFindQuery(q);
}

/**
 * 「步进与计数该问哪颗 view」统一走 `findTargetView()`：差异格里是**当前聚焦的那一栏**，
 * 其余情况是活动面板那一颗。两栏是两份正文 ⇒ 计数、当前命中、横跨两侧的写回都要按这一颗分。
 */

function clearFindHighlight(): void {
  for (const p of panels.values()) {
    if (p.view) clearFindQuery(p.view.view);
    // 差异格的左栏不在 `panels` 那张表里（旁路），要单独清 —— 否则关掉查找栏后
    // 左侧那层命中高亮会留在屏幕上，与「查找已关闭」自相矛盾。
    const surface = diffSurfaceOf(p);
    if (surface) clearFindQuery(surface.left);
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
  // 差异格里问的是**当前聚焦的那一栏**：两栏是两份正文，右栏的命中数不能冒充左栏的。
  const view = findTargetView();
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
  const view = findTargetView();
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
  dispatchOwn(view, step);
  // 只有右栏那颗 view 才是标签的正文（左栏是只读对照）⇒ 别把对照文档的 state 写回标签。
  if (panel.view?.view === view) {
    const tab = panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
    if (tab) tab.state = view.state;
  }
  findBar?.setCount(`${idx + 1} / ${matches.length}`);
}

/** 替换当前命中（没有选中命中时，先跳到下一个再替换下一次点击生效）。 */
function replaceCurrent(q: FindBarQuery): void {
  // 左栏是只读对照、预览档文档锁着 —— 两处都改不动，先说清楚为什么不换。
  if (!replaceAllowedHere()) {
    findBar?.setStatus(replaceBlockedReason());
    return;
  }
  const panel = activePanel();
  const view = findTargetView();
  if (!panel || !view) return;
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
  dispatchOwn(view, {
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
  if (panel.view?.view === view) {
    const tab = panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
    if (tab) tab.state = view.state;
  }
  refreshFindCount();
  // B419（用户）：单次替换连点要累计 —— 「已替换 1 处」→「已替换 2 处」…
  // 查询 / 替换串 / 范围 / 文档一变就由 clearReplaceStatus() 清零。
  replacedCount += 1;
  findBar?.setStatus(`已替换 ${replacedCount} 处`);
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
  if (!replaceAllowedHere()) {
    findBar?.setStatus(replaceBlockedReason());
    return;
  }

  const panel = activePanel();
  const view = findTargetView();
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
  dispatchOwn(view, { changes });
  if (panel.view?.view === view) {
    const tab = panel.viewTabId !== null ? tabs.get(panel.viewTabId) : undefined;
    if (tab) tab.state = view.state;
  }
  // B419：与单次替换同一个累计口径（这一发换了几处就加几处）。
  replacedCount += matches.length;
  findBar?.setStatus(`已替换 ${replacedCount} 处`);
  refreshFindCount();
}

/** 标签/面板切换后：浮层保持打开，把当前查询重新应用到新的活动视图。 */
function retargetFindBar(): void {
  // 换了文档 / 换了面板 → 焦点侧可能也变了（差异格换回来时默认右栏），重取一次。
  lastFindSide = diffSurfaceOf(activePanel())?.focusedSide() ?? "modified";
  // 换了文档 → 旧锚点的偏移量作废，按新文档的选区重取；
  // 同一文档时**不动**锚点（否则 F3 步进后的「命中选区」会被当成新锚点）。
  if (findSelectionOn && findSelectionAnchor?.docId !== activeTabIdOf()) seedFindSelectionAnchor();
  // B417：换到预览档的文档 ⇒ 替换入口立即收掉（换回来再放出去）
  syncFindBarReplaceable();
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
  clearFindHighlight,
  refreshFindCount,
  stepFind,
  replaceCurrent,
  replaceAllInScope,
  retargetFindBar,
  relayoutFindBar,
  syncFindBarReplaceable,
  refreshFindOnSelectionChange,
};

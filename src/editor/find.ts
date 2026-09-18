import { SearchQuery } from "@codemirror/search";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

/**
 * 查找内核（悬浮查找栏用）。
 *
 * 不使用 CM6 内置 `search()` 扩展：它自带面板与 Mod-f/F3/Mod-g 快捷键，
 * 会和“一个悬浮查找栏统一入口”的设计打架（两套 UI、两套快捷键）。
 * 这里只借用 `SearchQuery` 做匹配（正则/大小写/全词语义完全一致），
 * 命中扫描、导航、替换、高亮全部自持，跨文档/跨面板才能共用同一套逻辑。
 */

export interface FindOptions {
  search: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
}

export interface FindMatch {
  from: number;
  to: number;
}

/** 单次扫描的命中上限（防止贪婪正则 / 超长文档把 UI 卡住）。 */
const MAX_MATCHES = 5000;

/**
 * 把命中集合限制到选区内（闭区间）。range 为 null 时原样返回（不限）。
 * 用于「在选区中查找」。
 */
export function restrictToRange(
  matches: FindMatch[],
  range: { from: number; to: number } | null,
): FindMatch[] {
  if (!range) return matches;
  return matches.filter((m) => m.from >= range.from && m.to <= range.to);
}

/**
 * 保留大小写：把命中词的大小写迁移到替换串（VS Code 同款算法）。
 * - 命中全小写 → 替换串全小写；全大写 → 全大写；
 * - 命中首字母大写、其余小写（Title Case）→ 对应迁移；否则原样。
 */
export function preserveCase(matchText: string, replacement: string): string {
  if (!replacement) return replacement;
  const hasUpper = matchText !== matchText.toLowerCase();
  const hasLower = matchText !== matchText.toUpperCase();
  if (!hasUpper) return replacement.toLowerCase();
  if (!hasLower) return replacement.toUpperCase();
  // Title Case：首字母大写**且其余全小写**（"ConCat" 这种内部有大写的算混合，原样）
  const first = matchText[0];
  const rest = matchText.slice(1);
  if (
    first === first.toUpperCase() &&
    first !== first.toLowerCase() &&
    rest === rest.toLowerCase()
  ) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase();
  }
  return replacement;
}

/** 构造查询；空串或非法正则返回 null。 */
export function buildFindQuery(o: FindOptions): SearchQuery | null {
  if (!o.search) return null;
  let q: SearchQuery;
  try {
    q = new SearchQuery({
      search: o.search,
      caseSensitive: o.caseSensitive,
      wholeWord: o.wholeWord,
      regexp: o.regexp,
    });
  } catch {
    return null;
  }
  return q.valid ? q : null;
}

/** 扫描文档中的全部命中（按位置升序）。 */
export function findMatches(state: EditorState, q: SearchQuery | null): FindMatch[] {
  if (!q || !q.search) return [];
  const out: FindMatch[] = [];
  try {
    const it = q.getCursor(state);
    for (;;) {
      const step = it.next();
      if (step.done) break;
      out.push({ from: step.value.from, to: step.value.to });
      if (out.length >= MAX_MATCHES) break;
    }
  } catch {
    // 正则匹配过程抛错（如回溯失控）时按无命中处理，不打断 UI
    return [];
  }
  return out;
}

/**
 * 从 pos 出发找下一个（dir=1）/上一个（dir=-1）命中，到头环绕。
 * 返回命中索引；无命中返回 -1。
 */
export function nextMatchIndex(matches: FindMatch[], pos: number, dir: 1 | -1): number {
  if (matches.length === 0) return -1;
  if (dir === 1) {
    for (let i = 0; i < matches.length; i++) if (matches[i].from >= pos) return i;
    return 0;
  }
  for (let i = matches.length - 1; i >= 0; i--) if (matches[i].from < pos) return i;
  return matches.length - 1;
}

// ---------------------------------------------------------------- 命中高亮

interface FindState {
  query: SearchQuery | null;
  /** 当前命中起点，用于区别于其它命中的高亮样式 */
  activeFrom: number | null;
  /** 在选区中查找：高亮只画该范围（含端点）内的命中；null = 不限 */
  restrict: { from: number; to: number } | null;
}

/** 设置/清除查询（传 null 清除高亮）。 */
export const setFindQuery = StateEffect.define<FindState>();

const findField = StateField.define<FindState>({
  create: () => ({ query: null, activeFrom: null, restrict: null }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setFindQuery))
        return {
          query: e.value.query,
          activeFrom: e.value.activeFrom,
          restrict: e.value.restrict ?? null,
        };
    }
    return value;
  },
});

const matchMark = Decoration.mark({ class: "cm-find-match" });
const activeMark = Decoration.mark({ class: "cm-find-match cm-find-match-active" });

function buildDecorations(state: EditorState, f: FindState): DecorationSet {
  const matches = findMatches(state, f.query);
  if (matches.length === 0) return Decoration.none;
  const within = restrictToRange(matches, f.restrict);
  if (within.length === 0) return Decoration.none;
  return Decoration.set(
    within.map((m) => (m.from === f.activeFrom ? activeMark : matchMark).range(m.from, m.to)),
    true,
  );
}

const findDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    const f = tr.state.field(findField);
    if (!f.query) return Decoration.none;
    // 文档变化或查询变化时重算；否则复用映射后的旧装饰（滚动/纯选区变化）
    const queryChanged = tr.effects.some((e) => e.is(setFindQuery));
    if (tr.docChanged || queryChanged) return buildDecorations(tr.state, f);
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** 每个标签的 EditorState 都要挂载本扩展（高亮随快照走）。 */
export function findHighlight(): Extension {
  return [findField, findDecorations];
}

/** 把查询应用到视图（高亮 + 当前项）。 */
export function applyFindQuery(
  view: EditorView,
  o: FindOptions,
  activeFrom: number | null = null,
): void {
  view.dispatch({
    effects: setFindQuery.of({ query: buildFindQuery(o), activeFrom, restrict: null }),
  });
}

/** 清除高亮。 */
export function clearFindQuery(view: EditorView): void {
  view.dispatch({ effects: setFindQuery.of({ query: null, activeFrom: null, restrict: null }) });
}

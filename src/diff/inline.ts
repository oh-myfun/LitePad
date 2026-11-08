// B461 · 行内字符级差异（VS Code 的 inner changes / char-insert / char-delete）。
//
// 行级配对只说明「这两行对得上」，但用户真正想知道的往往是「这一行里改了哪几个词」。
// 上游在行级配对之后还会再跑一次词级 diff（`defaultLinesDiffComputer` 的 `refineDiff`
// → `LinesSliceCharSequence`：逐字符 diff + `optimizeSequenceDiffs` +
// `extendDiffsToEntireWordIfAppropriate` + `removeShortMatches` +
// `removeVeryShortMatchingTextBetweenLongDiffs`），把变化收窄到词/字符，渲染层再按
// `char-insert` / `char-delete` 两侧各标自己那一侧
// （`diffEditor/registrations.contribution.ts` 的 `char-insert` / `char-delete` 装饰）。
//
// 本文件只做「整块正文 → 两侧各自的行内区间 + 块内对齐边界」这一段纯计算，不认识 view、
// 也不画：
//   · 纯数据进出（行文本进、`{line, from, to}` 出），单测直接钉向量；
//   · 落色由 `face.ts` 的装饰层照 `side` 发 `diff-char-insert` / `diff-char-delete`；
//   · 对齐边界交给 `face.ts` 的 `gapZones`（上游 `computeRangeAlignment` 的
//     `innerHunkAlignment` 那一支）；
//   · 「什么时候重算」仍旧归持有两颗 view 的 `surface.ts`（与块表同一发，R24 不动）。
//
// 与上游的两处差别：
//   · diff 用 DP LCS 而不是 Myers —— 上游对短片段本来就走 DP (`refineDiff` 的那一档)，
//     超过 `MAX_CELLS` 放弃细化（上游 `hitTimeout` 同款取舍：整块只留行底色）；
//   · 纯增 / 纯删块不产出 inner change：整行高亮归 `face.ts` 的 `diff-whole-*`
//     （上游的 `diffWholeLineAdd / Delete`），行级配对窗口也不再需要 —— 对齐边界改由
//     字符 diff 的起止行列反推（上游 `innerHunkAlignment`）：改动起始列在两侧都 > 1、
//     或原稿侧改动结束列 < 行尾时，对应的两行就是一个对齐边界。边界之间按实测行高补差，
//     块内因此逐段对齐。
//
// 词界口径照上游 `linesSliceCharSequence.ts` 的 `isWordChar`：只认 `[A-Za-z0-9]`，
// 标点与空白都不是词字符 ⇒ 词界不会把 `foo,` 的逗号吞进改动里。
// 边界分（`getBoundaryScore`）照抄同文件：逗号/分号 30、空格/制表 3、词字符 0、
// 其他 2、端点 10、换行符 10（前一字符是换行时固定 150），小写接大写额外 +1 ——
// `shiftSequenceDiffs` 用它把纯增/纯删挪到更像「词边界 / 行首」的位置。

import type { DiffBlock, LineAlignment } from "./blocks";
import type { DiffSide } from "./model";

/** 一行之内被改动的一段：`line` 1-based；`from` / `to` 是行内 0-based 列，`to` 不含。
 *
 * `from === to` ⇒ 上游 `diff-range-empty` 那个落点：这一段**这一侧**没有字符被改，
 * 渲染层要在该处画一根 3px 细条（见 `face.ts` 的 `buildInner`）。
 */
export interface InnerRange {
  line: number;
  from: number;
  to: number;
  /** 这一段是因为**跨行**改动被切到行尾的（不是真的改到行尾字符）：渲染层要向右填满。 */
  fill?: boolean;
}

/** 两侧各自的行内改动（按行升序、同行内按列升序）。 */
export type InnerChanges = Record<DiffSide, InnerRange[]>;

/** 两侧某一行取文本（越界返回空串，块表可能比视图文档先动一步）。 */
export interface InnerLines {
  original(line: number): string;
  modified(line: number): string;
}

const EMPTY: InnerChanges = { original: [], modified: [] };

/**
 * 块内字符 diff 的输入上限（字符对）。
 *
 * 上游在超时或超长时会放弃细化（`myersDiffing` 的 `hitTimeout` 直接退回整段），这里用
 * 一个确定性的上限代替超时：整块几万个字符的那种（压缩产物 / 整段重写）逐字符跑 DP 只会
 * 把主线程卡住，而整块本来就已经涂着差异色 —— 细化对可读性没有增益。
 */
const MAX_CELLS = 1_000_000;

/** 词字符：上游 `LinesSliceCharSequence.isWordChar` 只认 `[A-Za-z0-9]`。 */
function isWordChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** `SeqDiff`：两侧各自的改动区间（0-based，`a1` / `b1` 不含）。 */
interface SeqDiff {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/** 一块的字符级结果：两侧各自的区间，以及由字符 diff 反推出来的对齐边界。 */
export interface InnerResult {
  changes: InnerChanges;
  /** 与 `blocks` 同下标：块内对齐边界（绝对行号、按行升序；空数组 ⇒ 整块只对齐首尾）。 */
  alignments: LineAlignment[][];
}

/**
 * 块内逐段字符级差异。
 *
 * 上游 `refineDiff` 把整个替换区（连同换行符）当成一条字符序列跑 diff，得到的
 * `RangeMapping` 既给出每行改在哪几列，也隐含两栏哪些行必须同高（`innerHunkAlignment`
 * 的边界）。这里照同一件事做：
 *   · 一侧整段为空（纯增 / 纯删）⇒ 不产出 inner change —— 整行高亮归渲染层的
 *     `diffWholeLine*Decoration`（`face.ts` 按 `SideMark.whole` 发）；
 *   · 两侧都有行 ⇒ 整块拼成一条序列跑 diff，再按行拆回两侧；
 *   · 超过 `MAX_CELLS` ⇒ 只有行底色（上游超时那一档），边界也一并放弃。
 */
export function innerChanges(
  blocks: DiffBlock[],
  lines: InnerLines,
  ignoreTrimWhitespace: boolean,
): InnerResult {
  const result: InnerResult = { changes: { original: [], modified: [] }, alignments: [] };
  for (const b of blocks) {
    const inner = blockInner(b, lines, ignoreTrimWhitespace);
    result.changes.original.push(...inner.changes.original);
    result.changes.modified.push(...inner.changes.modified);
    result.alignments.push(inner.alignments);
  }
  return result;
}

/** 一块：两侧的行内区间与对齐边界。 */
interface BlockInner {
  changes: InnerChanges;
  alignments: LineAlignment[];
}

function blockInner(b: DiffBlock, lines: InnerLines, ignoreTrimWhitespace: boolean): BlockInner {
  const originalCount = Math.max(b.originalEnd - b.originalStart + 1, 0);
  const modifiedCount = Math.max(b.modifiedEnd - b.modifiedStart + 1, 0);
  if (originalCount === 0 || modifiedCount === 0) {
    return { changes: EMPTY, alignments: [] };
  }

  const a = blockText(lines.original, b.originalStart, originalCount, ignoreTrimWhitespace);
  const m = blockText(lines.modified, b.modifiedStart, modifiedCount, ignoreTrimWhitespace);
  if ((a.text.length + 1) * (m.text.length + 1) > MAX_CELLS) {
    return { changes: EMPTY, alignments: [] };
  }

  let diffs = lcsDiff(a.text, m.text);
  if (diffs.length === 0) return { changes: EMPTY, alignments: [] };
  diffs = optimizeSequenceDiffs(a.text, m.text, diffs);
  diffs = extendDiffsToEntireWordIfAppropriate(a.text, m.text, diffs);
  diffs = removeShortMatches(diffs);
  diffs = removeVeryShortMatchingTextBetweenLongDiffs(a.text, m.text, diffs);

  const changes: InnerChanges = { original: [], modified: [] };
  for (const d of diffs) {
    pushMappedRanges(changes.original, a, b.originalStart, d.a0, d.a1);
    pushMappedRanges(changes.modified, m, b.modifiedStart, d.b0, d.b1);
  }
  return {
    changes: { original: mergeRanges(changes.original), modified: mergeRanges(changes.modified) },
    alignments: alignmentsOf(a, m, diffs, b.originalStart, b.modifiedStart),
  };
}

/** 一整块拼成一条字符序列（逐行按 `ignoreTrimWhitespace` 裁首尾空白，行间用 `\n`）。 */
interface BlockText {
  text: string;
  /** 每一行在 `text` 里的起始偏移 */
  starts: number[];
  /** 每一行裁掉的首部空白（列号平移回去用） */
  columns: number[];
  /** 每一行参与比较的长度 */
  lengths: number[];
}

function blockText(
  textAt: (line: number) => string,
  startLine: number,
  count: number,
  ignoreTrimWhitespace: boolean,
): BlockText {
  const starts: number[] = [];
  const columns: number[] = [];
  const lengths: number[] = [];
  const parts: string[] = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const raw = textAt(startLine + i);
    const span = trimSpan(raw, ignoreTrimWhitespace);
    starts.push(offset);
    columns.push(span.from);
    lengths.push(span.to - span.from);
    parts.push(raw.slice(span.from, span.to));
    offset += span.to - span.from;
    if (i + 1 < count) {
      parts.push("\n");
      offset += 1;
    }
  }
  return { text: parts.join(""), starts, columns, lengths };
}

/** 归一化序列里的偏移 ⇒ 这一块里的第几行、行内第几列（0-based）。 */
function positionOf(bt: BlockText, offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = bt.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bt.starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, column: Math.max(0, Math.min(offset - bt.starts[lo], bt.lengths[lo])) };
}

/** 把一条字符区间按行拆开，列号平移回未裁剪的原行。 */
function pushMappedRanges(
  target: InnerRange[],
  bt: BlockText,
  baseLine: number,
  from: number,
  to: number,
): void {
  const start = positionOf(bt, from);
  const startColumn = bt.columns[start.line] + start.column;
  if (from === to) {
    target.push({ line: baseLine + start.line, from: startColumn, to: startColumn });
    return;
  }
  const end = positionOf(bt, to);
  if (start.line === end.line) {
    target.push({
      line: baseLine + start.line,
      from: startColumn,
      to: bt.columns[end.line] + end.column,
    });
    return;
  }
  target.push({
    line: baseLine + start.line,
    from: startColumn,
    to: bt.columns[start.line] + bt.lengths[start.line],
    // 这一段是被**换行**截断的（改动延续到下一行）⇒ 上游 `shouldFillLineOnLineBreak`
    // 会把底色补到视野右缘；末段（`end.column > 0`）是真的改到那一列，不填。
    fill: true,
  });
  for (let line = start.line + 1; line < end.line; line++) {
    target.push({
      line: baseLine + line,
      from: bt.columns[line],
      to: bt.columns[line] + bt.lengths[line],
      fill: true,
    });
  }
  if (end.column > 0) {
    target.push({
      line: baseLine + end.line,
      from: bt.columns[end.line],
      to: bt.columns[end.line] + end.column,
    });
  }
}

/**
 * 照上游 `computeRangeAlignment` 的 `innerHunkAlignment` 反推对齐边界。
 *
 * 一条字符改动的起始列在两侧都 > 1 ⇒ 这一行之前有未改内容，两行可以从这里同高起步；
 * 原稿侧结束列 < 行尾 ⇒ 这一行之后还有未改内容，两行可以到这里同高收口。边界只增不减，
 * 块尾由 `gapZones` 统一收口。
 */
function alignmentsOf(
  a: BlockText,
  m: BlockText,
  diffs: SeqDiff[],
  baseOriginal: number,
  baseModified: number,
): LineAlignment[] {
  const out: LineAlignment[] = [];
  let lastOriginal = baseOriginal;
  let lastModified = baseModified;
  let first = true;
  const emit = (originalLine: number, modifiedLine: number): void => {
    if (originalLine < lastOriginal || modifiedLine < lastModified) return;
    if (first) first = false;
    // 上游 `emitAlignment`：除第一发外，任一侧没有前进就是「给已对齐的行再对一次」，
    // 直接丢掉 —— 留着会造出一段 0 行的区间，补缝在那一侧是空操作但会打乱后续分段。
    else if (originalLine === lastOriginal || modifiedLine === lastModified) return;
    if (originalLine === lastOriginal && modifiedLine === lastModified) return;
    out.push({ originalLine, modifiedLine });
    lastOriginal = originalLine;
    lastModified = modifiedLine;
  };
  for (const d of diffs) {
    const aStart = positionOf(a, d.a0);
    const mStart = positionOf(m, d.b0);
    const aEnd = positionOf(a, d.a1);
    const mEnd = positionOf(m, d.b1);
    if (aStart.column > 0 && mStart.column > 0) {
      emit(baseOriginal + aStart.line, baseModified + mStart.line);
    }
    if (aEnd.column < a.lengths[aEnd.line]) {
      emit(baseOriginal + aEnd.line, baseModified + mEnd.line);
    }
  }
  return out;
}

/** 一行里要参与比较的那一段（忽略 trim 空白时裁掉首尾空白）。 */
function trimSpan(text: string, ignoreTrimWhitespace: boolean): { from: number; to: number } {
  if (!ignoreTrimWhitespace) return { from: 0, to: text.length };
  let from = 0;
  let to = text.length;
  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  return { from, to };
}

/**
 * 逐字符 LCS（动态规划）。
 *
 * 上游 `refineDiff` 对短片段走 `DynamicProgrammingDiffing`；本实现的输入是**一整块**
 * （行间用 `\n`），DP 的常数更小、结果也确定（没有超时导致的不稳定）。
 * 超过 `MAX_CELLS` 直接不做细化（整块已着色），与上游 `hitTimeout` 退回整段同一取舍。
 */
function lcsDiff(a: string, b: string): SeqDiff[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [{ a0: 0, a1: n, b0: 0, b1: m }];
  if ((n + 1) * (m + 1) > MAX_CELLS) return [];
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    const ai = a.charCodeAt(i);
    const row = i * width;
    const next = row + width;
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] =
        ai === b.charCodeAt(j) ? dp[next + j + 1] + 1 : Math.max(dp[next + j], dp[row + j + 1]);
    }
  }
  const out: SeqDiff[] = [];
  let i = 0;
  let j = 0;
  let s0 = 0;
  let s1 = 0;
  while (i < n && j < m) {
    if (a.charCodeAt(i) === b.charCodeAt(j)) {
      if (i !== s0 || j !== s1) out.push({ a0: s0, a1: i, b0: s1, b1: j });
      i++;
      j++;
      s0 = i;
      s1 = j;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  if (i !== n || j !== m) out.push({ a0: s0, a1: n, b0: s1, b1: m });
  return out;
}

// --------------------------------------------------------------- 序列优化（上游 heuristicSequenceOptimizations）

/** 上游 `optimizeSequenceDiffs`：两次 `joinSequenceDiffsByShifting`（上游注明第二次会再改进），再 `shiftSequenceDiffs`。 */
function optimizeSequenceDiffs(a: string, b: string, diffs: SeqDiff[]): SeqDiff[] {
  let result = joinSequenceDiffsByShifting(a, b, diffs);
  result = joinSequenceDiffsByShifting(a, b, result);
  return shiftSequenceDiffs(a, b, result);
}

/**
 * 上游 `joinSequenceDiffsByShifting`：先尽量左移、能并就并；再尽量右移、能并就并。
 * 逐字符场景里没有 trim 与非 trim 两种相等，`stronglyEqual` 就退化成字符相等。
 */
function joinSequenceDiffsByShifting(a: string, b: string, diffs: SeqDiff[]): SeqDiff[] {
  if (diffs.length === 0) return diffs;

  const left: SeqDiff[] = [diffs[0]];
  for (let i = 1; i < diffs.length; i++) {
    const prev = left[left.length - 1];
    let cur = diffs[i];
    if (cur.a0 === cur.a1 || cur.b0 === cur.b1) {
      const length = cur.a0 - prev.a1;
      let d = 1;
      for (; d <= length; d++) {
        if (
          a.charCodeAt(cur.a0 - d) !== a.charCodeAt(cur.a1 - d) ||
          b.charCodeAt(cur.b0 - d) !== b.charCodeAt(cur.b1 - d)
        ) {
          break;
        }
      }
      d--;
      if (d === length) {
        left[left.length - 1] = {
          a0: prev.a0,
          a1: cur.a1 - length,
          b0: prev.b0,
          b1: cur.b1 - length,
        };
        continue;
      }
      cur = deltaDiff(cur, -d);
    }
    left.push(cur);
  }

  const right: SeqDiff[] = [];
  for (let i = 0; i < left.length - 1; i++) {
    const next = left[i + 1];
    let cur = left[i];
    if (cur.a0 === cur.a1 || cur.b0 === cur.b1) {
      const length = next.a0 - cur.a1;
      let d = 0;
      for (; d < length; d++) {
        if (
          a.charCodeAt(cur.a0 + d) !== a.charCodeAt(cur.a1 + d) ||
          b.charCodeAt(cur.b0 + d) !== b.charCodeAt(cur.b1 + d)
        ) {
          break;
        }
      }
      if (d === length) {
        left[i + 1] = {
          a0: cur.a0 + length,
          a1: next.a1,
          b0: cur.b0 + length,
          b1: next.b1,
        };
        continue;
      }
      if (d > 0) cur = deltaDiff(cur, d);
    }
    right.push(cur);
  }
  if (left.length > 0) right.push(left[left.length - 1]);
  return right;
}

/**
 * 上游 `shiftSequenceDiffs`：把纯增 / 纯删挪到边界分更高的位置（逗号旁、空白旁），
 * 并把合法范围收在相邻两段改动之间（不许越过它们）。
 */
function shiftSequenceDiffs(a: string, b: string, diffs: SeqDiff[]): SeqDiff[] {
  for (let i = 0; i < diffs.length; i++) {
    const prev = i > 0 ? diffs[i - 1] : undefined;
    const cur = diffs[i];
    const next = i + 1 < diffs.length ? diffs[i + 1] : undefined;
    const aFrom = prev ? prev.a1 + 1 : 0;
    const aTo = next ? next.a0 - 1 : a.length;
    const bFrom = prev ? prev.b1 + 1 : 0;
    const bTo = next ? next.b0 - 1 : b.length;
    if (cur.a0 === cur.a1) {
      diffs[i] = shiftDiffToBetterPosition(cur, a, b, aFrom, aTo, bFrom, bTo);
    } else if (cur.b0 === cur.b1) {
      // 上游用 `diff.swap()` 把「空的是 seq2」那半边也走同一条路。
      diffs[i] = swapDiff(shiftDiffToBetterPosition(swapDiff(cur), b, a, bFrom, bTo, aFrom, aTo));
    }
  }
  return diffs;
}

/** 上游 `shiftDiffToBetterPosition`（`diff.a` 必须是空区间）。 */
function shiftDiffToBetterPosition(
  diff: SeqDiff,
  s1: string,
  s2: string,
  s1From: number,
  s1To: number,
  s2From: number,
  s2To: number,
): SeqDiff {
  const MAX_SHIFT = 100;

  let before = 1;
  while (
    diff.a0 - before >= s1From &&
    diff.b0 - before >= s2From &&
    s2.charCodeAt(diff.b0 - before) === s2.charCodeAt(diff.b1 - before) &&
    before < MAX_SHIFT
  ) {
    before++;
  }
  before--;

  let after = 0;
  while (
    diff.a0 + after < s1To &&
    diff.b1 + after < s2To &&
    s2.charCodeAt(diff.b0 + after) === s2.charCodeAt(diff.b1 + after) &&
    after < MAX_SHIFT
  ) {
    after++;
  }

  if (before === 0 && after === 0) return diff;

  let best = 0;
  let bestScore = -1;
  for (let d = -before; d <= after; d++) {
    const score =
      boundaryScore(s1, diff.a0 + d) +
      boundaryScore(s2, diff.b0 + d) +
      boundaryScore(s2, diff.b1 + d);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return deltaDiff(diff, best);
}

/** 边界分类的下标（与 `CATEGORY_SCORE` 同序）。 */
const CAT_END = 0;
const CAT_OTHER = 1;
const CAT_SEPARATOR = 2;
const CAT_SPACE = 3;
const CAT_LINEBREAK = 4;
const CAT_LOWER = 5;
const CAT_UPPER = 6;
const CAT_NUMBER = 7;

/** 上游 `score` 表：逗号/分号最像边界，空白次之，换行 10，词字符不是。 */
const CATEGORY_SCORE = [10, 2, 30, 3, 10, 0, 0, 0];

/** 上游 `getCategory`（LF / CR 都算行断开）。 */
function categoryOf(code: number): number {
  if (code === -1) return CAT_END;
  if (code === 10 || code === 13) return CAT_LINEBREAK;
  if (code === 32 || code === 9) return CAT_SPACE;
  if (code >= 97 && code <= 122) return CAT_LOWER;
  if (code >= 65 && code <= 90) return CAT_UPPER;
  if (code >= 48 && code <= 57) return CAT_NUMBER;
  if (code === 44 || code === 59) return CAT_SEPARATOR;
  return CAT_OTHER;
}

/** 上游 `LinesSliceCharSequence.getBoundaryScore`。 */
function boundaryScore(text: string, length: number): number {
  const prev = categoryOf(length > 0 ? text.charCodeAt(length - 1) : -1);
  const next = categoryOf(length < text.length ? text.charCodeAt(length) : -1);
  // 行尾 / 行首是天然边界（上游固定 150），纯增删优先挪到行首。
  if (prev === CAT_LINEBREAK) return 150;
  let score = 0;
  if (prev !== next) {
    score += 10;
    if (prev === CAT_LOWER && next === CAT_UPPER) score += 1;
  }
  score += CATEGORY_SCORE[prev] + CATEGORY_SCORE[next];
  return score;
}

function swapDiff(d: SeqDiff): SeqDiff {
  return { a0: d.b0, a1: d.b1, b0: d.a0, b1: d.a1 };
}

function deltaDiff(d: SeqDiff, offset: number): SeqDiff {
  return {
    a0: d.a0 + offset,
    a1: d.a1 + offset,
    b0: d.b0 + offset,
    b1: d.b1 + offset,
  };
}

/** 两个区间有**非空**交集（上游 `OffsetRange.intersects`）。 */
function intersects(a0: number, a1: number, b0: number, b1: number): boolean {
  return Math.max(a0, b0) < Math.min(a1, b1);
}

/** 上游 `SequenceDiff.intersect`（允许空交集；不相交返回 `undefined`）。 */
function intersectDiff(x: SeqDiff, y: SeqDiff): SeqDiff | undefined {
  const a0 = Math.max(x.a0, y.a0);
  const a1 = Math.min(x.a1, y.a1);
  const b0 = Math.max(x.b0, y.b0);
  const b1 = Math.min(x.b1, y.b1);
  return a0 <= a1 && b0 <= b1 ? { a0, a1, b0, b1 } : undefined;
}

function joinDiff(x: SeqDiff, y: SeqDiff): SeqDiff {
  return {
    a0: Math.min(x.a0, y.a0),
    a1: Math.max(x.a1, y.a1),
    b0: Math.min(x.b0, y.b0),
    b1: Math.max(x.b1, y.b1),
  };
}

// --------------------------------------------------------------- 词界扩展（上游 extendDiffsToEntireWordIfAppropriate）

/** `index` 所在的词区间（`end` 不含）；`index` 不在词字符上 ⇒ `null`（上游 `findWordContaining`）。 */
function wordAt(text: string, index: number): { start: number; end: number } | null {
  if (index < 0 || index >= text.length || !isWordChar(text.charCodeAt(index))) return null;
  let start = index;
  let end = index;
  while (start > 0 && isWordChar(text.charCodeAt(start - 1))) start--;
  while (end + 1 < text.length && isWordChar(text.charCodeAt(end + 1))) end++;
  return { start, end: end + 1 };
}

/**
 * 上游 `SequenceDiff.invert`：把改动区间翻成**未改动**区间（两侧等长推进）。
 * `n + 1` 段：首段之前 / 相邻两段之间 / 末段之后。
 */
function invertDiffs(diffs: SeqDiff[], length: number): SeqDiff[] {
  const out: SeqDiff[] = [];
  for (let i = 0; i <= diffs.length; i++) {
    const prev = i > 0 ? diffs[i - 1] : null;
    const next = i < diffs.length ? diffs[i] : null;
    const a0 = prev ? prev.a1 : 0;
    const b0 = prev ? prev.b1 : 0;
    const a1 = next ? next.a0 : length;
    const b1 = next ? next.b0 : (prev ? prev.b1 - prev.a1 : 0) + length;
    out.push({ a0, a1, b0, b1 });
  }
  return out;
}

/**
 * 上游 `extendDiffsToEntireWordIfAppropriate`：改动只覆盖某个词的一部分、且该词**未改动的
 * 字符不足 2/3**（`equalChars1 + equalChars2 < (len1 + len2) * 2/3`）时，扩到整个词。
 *
 * 判据是两侧合并算的：`foobar` → `foobaz` 只改一个字符（未改 10 ≥ 8）⇒ 不扩；
 * `foobar` → `fooxxx`（未改 6 < 8）⇒ 扩到 `foobar` / `fooxxx` 整词。
 *
 * 一个改动可能横跨多个词：沿未改动映射往后并，直到词的右端不再越过下一段未改动区。
 * `lastPoint` 保证同一段等值区不会被两个改动各扫一遍（上游同款）。
 */
function extendDiffsToEntireWordIfAppropriate(a: string, b: string, diffs: SeqDiff[]): SeqDiff[] {
  const equalMappings = invertDiffs(diffs, a.length);
  const additional: SeqDiff[] = [];
  let lastA = 0;
  let lastB = 0;

  const scanWord = (aAt: number, bAt: number, equal: SeqDiff): void => {
    if (aAt < lastA || bAt < lastB) return;
    const w1 = wordAt(a, aAt);
    const w2 = wordAt(b, bAt);
    if (!w1 || !w2) return;

    let w: SeqDiff = { a0: w1.start, a1: w1.end, b0: w2.start, b1: w2.end };
    const equalPart = intersectDiff(w, equal);
    let equalChars1 = equalPart ? equalPart.a1 - equalPart.a0 : 0;
    let equalChars2 = equalPart ? equalPart.b1 - equalPart.b0 : 0;

    // 词可能接着下一段未改动区（同一行里相邻的两个词被一个改动连起来）。
    while (equalMappings.length > 0) {
      const next = equalMappings[0];
      if (!(intersects(next.a0, next.a1, w.a0, w.a1) || intersects(next.b0, next.b1, w.b0, w.b1))) {
        break;
      }
      const v1 = wordAt(a, next.a0)!;
      const v2 = wordAt(b, next.b0)!;
      const v: SeqDiff = { a0: v1.start, a1: v1.end, b0: v2.start, b1: v2.end };
      const part = intersectDiff(v, next);
      equalChars1 += part ? part.a1 - part.a0 : 0;
      equalChars2 += part ? part.b1 - part.b0 : 0;
      w = joinDiff(w, v);

      if (w.a1 >= next.a1) equalMappings.shift();
      else break;
    }

    if (equalChars1 + equalChars2 < (w.a1 - w.a0 + (w.b1 - w.b0)) * (2 / 3)) {
      additional.push(w);
    }
    lastA = w.a1;
    lastB = w.b1;
  };

  while (equalMappings.length > 0) {
    const next = equalMappings.shift()!;
    if (next.a0 === next.a1) continue;
    scanWord(next.a0, next.b0, next);
    // 未改动区非空 ⇒ `-1` 落在两侧都相等的字符上。
    scanWord(next.a1 - 1, next.b1 - 1, next);
  }

  return mergeSequenceDiffs(diffs, additional);
}

/** 上游 `mergeSequenceDiffs`：两摞都按起点有序，逐段取起点靠前的，首尾相接/重叠就并。 */
function mergeSequenceDiffs(diffs1: SeqDiff[], diffs2: SeqDiff[]): SeqDiff[] {
  const left = [...diffs1];
  const right = [...diffs2];
  const out: SeqDiff[] = [];
  while (left.length > 0 || right.length > 0) {
    const x = left[0];
    const y = right[0];
    const next = x && (!y || x.a0 < y.a0) ? left.shift()! : right.shift()!;
    const last = out[out.length - 1];
    if (last && last.a1 >= next.a0) out[out.length - 1] = joinDiff(last, next);
    else out.push(next);
  }
  return out;
}

// --------------------------------------------------------------- 去噪（上游 removeShortMatches / removeVeryShortMatchingTextBetweenLongDiffs）

/**
 * 上游 `removeShortMatches`：两段改动之间只要**任一侧**只隔着 ≤2 个未变字符，就并成一段。
 * （上游用的是「或」：两侧同时都短当然也并，只有一侧短时并也不至于吞掉长距离内容。）
 */
function removeShortMatches(diffs: SeqDiff[]): SeqDiff[] {
  if (diffs.length <= 1) return diffs;
  const out: SeqDiff[] = [diffs[0]];
  for (let i = 1; i < diffs.length; i++) {
    const prev = out[out.length - 1];
    const cur = diffs[i];
    if (cur.a0 - prev.a1 <= 2 || cur.b0 - prev.b1 <= 2) {
      out[out.length - 1] = joinDiff(prev, cur);
    } else {
      out.push(cur);
    }
  }
  return out;
}

/**
 * 上游 `removeVeryShortMatchingTextBetweenLongDiffs`：两段大改动之间只夹着一小截未改动
 * 文本（trim 后 ≤20 字符、不含换行、两侧长度和 ≤500）时并成一段。行计数项照上游一起算
 * （换行按 40 字符加权），块内跨行的改动因此也能按同一口径判。
 */
function removeVeryShortMatchingTextBetweenLongDiffs(
  a: string,
  b: string,
  diffs: SeqDiff[],
): SeqDiff[] {
  if (diffs.length === 0) return diffs;

  let current = diffs;
  let counter = 0;
  let shouldRepeat: boolean;
  do {
    shouldRepeat = false;
    const result: SeqDiff[] = [current[0]];
    for (let i = 1; i < current.length; i++) {
      const last = result[result.length - 1];
      const cur = current[i];
      if (shouldJoin(a, b, last, cur)) {
        shouldRepeat = true;
        result[result.length - 1] = joinDiff(last, cur);
      } else {
        result.push(cur);
      }
    }
    current = result;
  } while (counter++ < 10 && shouldRepeat);

  // 上游后半段：超长改动（两侧长度和 > 100）把紧贴它的「≤3 个非空白字符」的前/后缀
  // 也吞进改动（`shouldMarkAsChanged`），再夹回相邻改动之间的可用空间。前缀/后缀只在
  // 当前行内取（上游 `extendToFullLines`），不会把整块前后文都算进来。
  const out: SeqDiff[] = [];
  for (let i = 0; i < current.length; i++) {
    let nd = current[i];
    const prev = i > 0 ? current[i - 1] : null;
    const next = i + 1 < current.length ? current[i + 1] : null;
    const mark = (text: string): boolean =>
      text.length > 0 && text.trim().length <= 3 && nd.a1 - nd.a0 + (nd.b1 - nd.b0) > 100;
    const prefix = a.slice(lineStartAt(a, nd.a0), nd.a0);
    if (mark(prefix)) {
      nd = { a0: nd.a0 - prefix.length, a1: nd.a1, b0: nd.b0 - prefix.length, b1: nd.b1 };
    }
    const suffix = a.slice(nd.a1, lineEndAt(a, nd.a1));
    if (mark(suffix)) {
      nd = { a0: nd.a0, a1: nd.a1 + suffix.length, b0: nd.b0, b1: nd.b1 + suffix.length };
    }
    const space: SeqDiff = {
      a0: prev ? prev.a1 : 0,
      a1: next ? next.a0 : Number.MAX_SAFE_INTEGER,
      b0: prev ? prev.b1 : 0,
      b1: next ? next.b0 : Number.MAX_SAFE_INTEGER,
    };
    const clamped = intersectDiff(nd, space) ?? nd;
    const last = out[out.length - 1];
    if (last && last.a1 === clamped.a0 && last.b1 === clamped.b0) {
      out[out.length - 1] = joinDiff(last, clamped);
    } else {
      out.push(clamped);
    }
  }
  return out;
}

/** 上游 `shouldJoinDiffs`：长度、行数、两侧改动规模一起判。 */
function shouldJoin(a: string, b: string, before: SeqDiff, after: SeqDiff): boolean {
  const unchangedStart = before.a1;
  const unchangedEnd = after.a0;
  const unchangedRangeLength = unchangedEnd - unchangedStart;
  if (countLinesIn(a, unchangedStart, unchangedEnd) > 5 || unchangedRangeLength > 500) {
    return false;
  }
  const unchanged = a.slice(unchangedStart, unchangedEnd).trim();
  if (unchanged.length > 20 || /[\r\n]/.test(unchanged)) return false;

  const max = 2 * 40 + 50;
  const cap = (v: number): number => Math.min(v, max);
  const score = (
    lineCount1: number,
    seq1Length: number,
    lineCount2: number,
    seq2Length: number,
  ): number =>
    Math.pow(
      Math.pow(cap(lineCount1 * 40 + seq1Length), 1.5) +
        Math.pow(cap(lineCount2 * 40 + seq2Length), 1.5),
      1.5,
    );
  const beforeScore = score(
    countLinesIn(a, before.a0, before.a1),
    before.a1 - before.a0,
    countLinesIn(b, before.b0, before.b1),
    before.b1 - before.b0,
  );
  const afterScore = score(
    countLinesIn(a, after.a0, after.a1),
    after.a1 - after.a0,
    countLinesIn(b, after.b0, after.b1),
    after.b1 - after.b0,
  );
  return beforeScore + afterScore > Math.pow(Math.pow(max, 1.5), 1.5) * 1.3;
}

/** `[from, to)` 里的换行数（上游 `countLinesIn`）。 */
function countLinesIn(text: string, from: number, to: number): number {
  let lines = 0;
  for (let i = from; i < to; i++) {
    if (text.charCodeAt(i) === 10) lines++;
  }
  return lines;
}

/** `offset` 所在行的行首。 */
function lineStartAt(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

/** `offset` 所在行的行尾（不含换行符）。 */
function lineEndAt(text: string, offset: number): number {
  const index = text.indexOf("\n", offset);
  return index < 0 ? text.length : index;
}

/** 同侧相邻 / 重叠的区间合并成一段（词界扩展后可能首尾相接；fill 取或）。 */
function mergeRanges(ranges: InnerRange[]): InnerRange[] {
  if (ranges.length <= 1) return ranges;
  ranges.sort((x, y) => x.line - y.line || x.from - y.from || x.to - y.to);
  const out: InnerRange[] = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = out[out.length - 1];
    const cur = ranges[i];
    if (cur.line === last.line && cur.from <= last.to) {
      last.to = Math.max(last.to, cur.to);
      if (cur.fill) last.fill = true;
    } else {
      out.push(cur);
    }
  }
  return out;
}

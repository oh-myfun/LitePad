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
// 本文件只做「块内配对行 → 两侧各自的行内区间」这一段纯计算，不认识 view、也不画：
//   · 纯数据进出（行文本进、`{line, from, to}` 出），单测直接钉向量；
//   · 落色由 `face.ts` 的装饰层照 `side` 发 `diff-char-insert` / `diff-char-delete`；
//   · 「什么时候重算」仍旧归持有两颗 view 的 `surface.ts`（与块表同一发，R24 不动）。
//
// 与上游的两处差别，都是「一次只处理一对配对行」的直接后果：
//   · diff 用 DP LCS 而不是 Myers —— 上游对长度和 < 500 的片段本来就走 DP
//     (`refineDiff` 的那一档)，单行配对正落在这一档；超过 `MAX_CELLS` 放弃细化；
//   · slice 里没有 `\n`，上游按行计数的那几项（`countLinesIn` / `countLinesIn(range)`）
//     恒为 0，`removeVeryShortMatchingTextBetweenLongDiffs` 里只剩长度项。
//
// 词界口径照上游 `linesSliceCharSequence.ts` 的 `isWordChar`：只认 `[A-Za-z0-9]`，
// 标点与空白都不是词字符 ⇒ 词界不会把 `foo,` 的逗号吞进改动里。
// 边界分（`getBoundaryScore`）照抄同文件：逗号/分号 30、空格/制表 3、词字符 0、
// 其他 2、端点 10，小写接大写额外 +1 —— `shiftSequenceDiffs` 用它把纯增/纯删
// 挪到更像「词边界」的位置（上游拿它对齐 `,` / 空白旁的变化）。

import { blockPairing, type DiffBlock } from "./blocks";
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
 * 单行内部差异的输入上限（字符对）。
 *
 * 上游在超时或超长时会放弃细化（`myersDiffing` 的 `hitTimeout` 直接退回整段），这里用
 * 一个确定性的上限代替超时：一行里几万个字符的那种（压缩产物）逐字符跑 DP 只会把主线程
 * 卡住，而整行本来就已经涂着差异色 —— 细化对可读性没有增益。
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

/**
 * 块内每一对配对行各跑一次词级 diff，交回两侧的行内改动。
 *
 * 「配对行」沿用 `blockPairing` 的窗口（块内「多的一侧贴到少的一侧」那一段）：窗口之外
 * 没有搭档的行是纯增 / 纯删，整行按上游 `diffWholeLineAdd/DeleteDecoration` 补一层字符底色
 * （`isWholeLine`），与行底色两层叠加。
 *
 * 上游分两支（`diffEditorDecorations.ts`）：若块有一侧整段为空（纯增 / 纯删），只发整行
 * `char-insert` / `char-delete`；否则逐段 inner change。两支都走，才不会出现「纯增行只有
 * 行底色、别的行有字符层」这种一屏两种口径。
 */
export function innerChanges(
  blocks: DiffBlock[],
  lines: InnerLines,
  ignoreTrimWhitespace: boolean,
): InnerChanges {
  if (blocks.length === 0) return EMPTY;
  const out: InnerChanges = { original: [], modified: [] };
  for (const b of blocks) {
    const originalLength = Math.max(b.originalEnd - b.originalStart + 1, 0);
    const modifiedLength = Math.max(b.modifiedEnd - b.modifiedStart + 1, 0);
    if (originalLength === 0 || modifiedLength === 0) {
      // 纯增 / 纯删：非空侧逐行整行涂色。空行没有字符可盖（行底色本来就铺满整行），
      // 跳过 —— 落成零长会变成 `diff-range-empty` 那根细条，语义是另一回事。
      if (modifiedLength > 0) {
        pushWholeLines(out.modified, lines.modified, b.modifiedStart, b.modifiedEnd);
      } else {
        pushWholeLines(out.original, lines.original, b.originalStart, b.originalEnd);
      }
      continue;
    }
    const p = blockPairing(b);
    for (let k = 0; k < p.count; k++) {
      const oLine = p.originalStart + k;
      const mLine = p.modifiedStart + k;
      const oText = lines.original(oLine);
      const mText = lines.modified(mLine);
      const pair = innerLineRanges(oText, mText, ignoreTrimWhitespace);
      for (const [from, to] of pair.original) {
        out.original.push({ line: oLine, from, to });
      }
      for (const [from, to] of pair.modified) {
        out.modified.push({ line: mLine, from, to });
      }
    }
  }
  return out;
}

/** 一整段行逐行补「整行字符层」（空行跳过）。 */
function pushWholeLines(
  target: InnerRange[],
  textAt: (line: number) => string,
  start: number,
  end: number,
): void {
  for (let line = start; line <= end; line++) {
    const text = textAt(line);
    if (text.length > 0) target.push({ line, from: 0, to: text.length });
  }
}

/**
 * 一对行内部的字符级差异（两侧各自的列区间）。
 *
 * 步骤照上游 `refineDiff` 的流水线：
 *   1. `ignoreTrimWhitespace` 时先把两侧首尾空白裁掉（上游 `LinesSliceCharSequence` 的
 *      `considerWhitespaceChanges = !ignoreTrimWhitespace`：忽略 trim 空白时，行首行尾的
 *      空白差异不进 inner change），算完再把列号平移回去；
 *   2. 逐字符 diff；
 *   3. `optimizeSequenceDiffs` = `joinSequenceDiffsByShifting` × 2 + `shiftSequenceDiffs`；
 *   4. `extendDiffsToEntireWordIfAppropriate`；
 *   5. `removeShortMatches`；
 *   6. `removeVeryShortMatchingTextBetweenLongDiffs`。
 */
export function innerLineRanges(
  original: string,
  modified: string,
  ignoreTrimWhitespace: boolean,
): { original: Array<[number, number]>; modified: Array<[number, number]> } {
  const aSpan = trimSpan(original, ignoreTrimWhitespace);
  const bSpan = trimSpan(modified, ignoreTrimWhitespace);
  const a = original.slice(aSpan.from, aSpan.to);
  const b = modified.slice(bSpan.from, bSpan.to);

  // 一侧整行是空的：这一对本身就是「整行新增 / 删除」。上游 `refineDiff` 照样产出一段
  // inner change —— 空的那侧是零长区间（渲染成 `diff-range-empty` 细条），非空侧整行。
  if (a.length === 0 || b.length === 0) {
    if (a.length === 0 && b.length === 0) return { original: [], modified: [] };
    return {
      original: [[aSpan.from, aSpan.to]],
      modified: [[bSpan.from, bSpan.to]],
    };
  }

  let diffs = lcsDiff(a, b);
  if (diffs.length === 0) return { original: [], modified: [] };

  diffs = optimizeSequenceDiffs(a, b, diffs);
  diffs = extendDiffsToEntireWordIfAppropriate(a, b, diffs);
  diffs = removeShortMatches(diffs);
  diffs = removeVeryShortMatchingTextBetweenLongDiffs(a, diffs);

  const originalRanges: Array<[number, number]> = [];
  const modifiedRanges: Array<[number, number]> = [];
  for (const d of diffs) {
    const a0 = Math.max(0, Math.min(d.a0, a.length));
    const a1 = Math.max(0, Math.min(d.a1, a.length));
    const b0 = Math.max(0, Math.min(d.b0, b.length));
    const b1 = Math.max(0, Math.min(d.b1, b.length));
    // 列号平移回未裁剪的原行；两侧都收 —— 空的那一侧零长，落渲染层那根细条
    // （上游 `diffDeleteDecorationEmpty` / `diffAddDecorationEmpty`）。
    originalRanges.push([a0 + aSpan.from, a1 + aSpan.from]);
    modifiedRanges.push([b0 + bSpan.from, b1 + bSpan.from]);
  }
  return { original: mergeRanges(originalRanges), modified: mergeRanges(modifiedRanges) };
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
 * 上游 `refineDiff` 在字符长度和 < 500 时正走 `DynamicProgrammingDiffing`；本实现的输入是
 * **一对行**，长度通常只在几十到几百，DP 的常数更小、结果也确定（没有超时导致的不稳定）。
 * 超过 `MAX_CELLS` 直接不做细化（整行已着色），与上游 `hitTimeout` 退回整段同一取舍。
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
const CAT_LOWER = 4;
const CAT_UPPER = 5;
const CAT_NUMBER = 6;

/** 上游 `score` 表：逗号/分号最像边界，空白次之，词字符不是。 */
const CATEGORY_SCORE = [10, 2, 30, 3, 0, 0, 0];

/** 上游 `getCategory`（单行 slice 里没有 `\r` / `\n`）。 */
function categoryOf(code: number): number {
  if (code === -1) return CAT_END;
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
 * 文本（trim 后 ≤20 字符）时并成一段。判据里的行计数项在单行 slice 上恒为 0，
 * 只剩长度项（`cap` 到 130，再按 1.5 次方加权）。
 */
function removeVeryShortMatchingTextBetweenLongDiffs(a: string, diffs: SeqDiff[]): SeqDiff[] {
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
      if (shouldJoin(a, last, cur)) {
        shouldRepeat = true;
        result[result.length - 1] = joinDiff(last, cur);
      } else {
        result.push(cur);
      }
    }
    current = result;
  } while (counter++ < 10 && shouldRepeat);

  // 上游后半段：超长改动（两侧长度和 > 100）把紧贴它的「≤3 个非空白字符」的前/后缀
  // 也吞进改动（`shouldMarkAsChanged`），再夹回相邻改动之间的可用空间。
  const out: SeqDiff[] = [];
  for (let i = 0; i < current.length; i++) {
    let nd = current[i];
    const prev = i > 0 ? current[i - 1] : null;
    const next = i + 1 < current.length ? current[i + 1] : null;
    const mark = (text: string): boolean =>
      text.length > 0 && text.trim().length <= 3 && nd.a1 - nd.a0 + (nd.b1 - nd.b0) > 100;
    const prefix = a.slice(0, nd.a0);
    if (mark(prefix)) {
      nd = { a0: nd.a0 - prefix.length, a1: nd.a1, b0: nd.b0 - prefix.length, b1: nd.b1 };
    }
    const suffix = a.slice(nd.a1, a.length);
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

/** 上游 `shouldJoinDiffs` 的单行版（行计数恒为 0）。 */
function shouldJoin(a: string, before: SeqDiff, after: SeqDiff): boolean {
  const unchangedStart = before.a1;
  const unchangedEnd = after.a0;
  if (unchangedEnd - unchangedStart > 500) return false;
  const unchanged = a.slice(unchangedStart, unchangedEnd);
  if (unchanged.trim().length > 20) return false;
  if (/[\r\n]/.test(unchanged)) return false;

  const MAX = 2 * 40 + 50;
  const cap = (v: number): number => Math.min(v, MAX);
  const score = (d: SeqDiff): number =>
    Math.pow(Math.pow(cap(d.a1 - d.a0), 1.5) + Math.pow(cap(d.b1 - d.b0), 1.5), 1.5);
  return score(before) + score(after) > Math.pow(Math.pow(MAX, 1.5), 1.5) * 1.3;
}

/** 同侧相邻 / 重叠的区间合并成一段（词界扩展后可能首尾相接）。 */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length <= 1) return ranges;
  ranges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Array<[number, number]> = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = out[out.length - 1];
    const cur = ranges[i];
    if (cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
    else out.push(cur);
  }
  return out;
}

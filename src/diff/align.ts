// B461 · 差异内核的唯一对齐来源（设计稿约束 ⑥：4px gutter 列与差异面「同源」）。
//
// 对齐语义**照 VS Code 的 advanced 差异实现**（设置 `diffEditor.diffAlgorithm` 的默认档：
// `DefaultLinesDiffComputer`，不是旧版 `LcsDiff`）。移植时保持本模块的对外形状不变：
// `alignLines(a, b, ignoreTrimWhitespace) -> { head, tail, regions }`、`splitLines`、
// `AlignRegion`、`Aligned`、`DIFF_REFRESH_MS`。face / surface / gutter 一个字都不用改。
//
// 上游流水线（`src/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.ts`）：
//   1. 行哈希**总是 trim 后**取（所以纯空白差异会被对齐到同一条对角线）；
//   2. 两序列行数之和 < 1700 走带评分的动态规划（`DynamicProgrammingDiffing`），
//      否则走 Myers（`MyersDiffAlgorithm`）—— 分档线就是上游写的 1700；
//   3. `optimizeSequenceDiffs`：左移/右移把相邻的段合并、再按行首缩进分挪到更像的边界；
//   4. `removeVeryShortMatchingLinesBetweenDiffs`：把「两段大改动之间只夹了 ≤4 个非空白字符」
//      的未改动区并进改动里；
//   5. `ignoreTrimWhitespace === false` 时，在**对齐出来的未改动行**里扫原始文本，
//      只差空白的行各自成一条 1↔1 改动（上游 `scanForWhitespaceChanges`）。
//
// 没有移植的部分：字符级 refine / 单词边界扩展 / moved-text 检测。它们只影响
// `RangeMapping`（字符区间）与「移动代码」的附加信息，**不改行级区间**；本模块的出口是行级
// 的 `AlignRegion`，移植过来只是多一份用不上的代码。
//
// 零件来历：`splitLines` 与 `DIFF_REFRESH_MS` 沿用 B458；`similarity` / `alignOffset`
// 也保留（`offset` 只决定占位块贴哪一侧，不是 VS Code 的行对齐语义）。

/**
 * 键入停下多久之后重算全量：唯一一份，gutter 与差异面共用（原先藏在 gutterDiff.ts:235）。
 */
export const DIFF_REFRESH_MS = 200;

/**
 * 上游的分档线：`sequence1.length + sequence2.length < 1700` 用动态规划，否则 Myers。
 * 数字照抄 `defaultLinesDiffComputer.ts` —— 不放宽也不收紧，两档在同一批输入上给出
 * 与 VS Code 一致的行对齐。
 */
const DP_LINE_LIMIT = 1700;

/**
 * 计算预算：上游 `diffEditor.maxComputationTime` 的默认值（5000ms），由 worker 之外的
 * 调用方传进来。LitePad 在主线程同步跑，没有 worker 可中断，只能同口径地「超时即退化成
 * 整段改动」—— 这条只在病态输入（两篇巨长且几乎完全不同的正文）上才会触发。
 */
const MAX_COMPUTE_MS = 5_000;

/** 错位搜索的格子预算：超了就退回「从区首逐行配对」的老口径（不猜，也别把界面冻住）。 */
export const ALIGN_PAIR_BUDGET = 20_000;

/**
 * 一块「基线的若干行 ↔ 当前的若干行」的替换区（下标都是 0-based）。
 * `offset` 是少的一侧贴到多的一侧的错位（等长 ⇒ 0），
 * gutter 画缝与差异面放占位块共用这一颗。
 */
export interface AlignRegion {
  aStart: number;
  aLen: number;
  bStart: number;
  bLen: number;
  offset: number;
}

/** 对齐结果：修剪掉的相同前缀/后缀行数 + 中段里的替换区（换算绝对行号 = head + start + 1）。 */
export interface Aligned {
  head: number;
  tail: number;
  regions: AlignRegion[];
}

/**
 * 按行切开。
 *
 * `""` 当「**没有一行**」而不是「一个空行」：新建文档（基线是空串）打上两行字该是两格绿，
 * 而不是一道红缝加两格绿。其余保留结尾那个空段 —— 它记的正是「最后一个换行之后什么都没有」，
 * 于是「删掉末尾的换行」如实成一道缝（基线多出一条空行）、「补一个换行」如实成一格绿。
 */
export function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

// ---------------------------------------------------------------- 序列与上游算法零件

/** 上游 `LineSequence` 的等价物：trim 后的哈希负责「相等」，原始行负责强度/边界/文本。 */
interface LineSequence {
  hashes: number[];
  lines: string[];
}

/** 上游 `SequenceDiff`：两个左闭右开区间（0-based 行下标）。 */
interface SequenceDiff {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

interface Deadline {
  valid(): boolean;
}

function deadline(ms: number): Deadline {
  const start = Date.now();
  return { valid: () => Date.now() - start < ms };
}

/** 整段一个改动（上游的 `trivial`，也是超时后的退化结果）。 */
function trivialDiff(a: LineSequence, b: LineSequence): SequenceDiff[] {
  return [{ a0: 0, a1: a.lines.length, b0: 0, b1: b.lines.length }];
}

/**
 * 两份正文的行哈希：**trim 后**取（上游 `defaultLinesDiffComputer.ts` 的
 * `originalLines.map(l => getOrCreateHash(l.trim()))`）。同一张表给两侧共用 ⇒
 * 跨正文相同的行拿到同一个编号。
 */
function hashSequences(a: string[], b: string[]): [LineSequence, LineSequence] {
  const perfect = new Map<string, number>();
  const hash = (line: string): number => {
    const key = line.trim();
    let h = perfect.get(key);
    if (h === undefined) {
      h = perfect.size;
      perfect.set(key, h);
    }
    return h;
  };
  return [
    { hashes: a.map(hash), lines: a },
    { hashes: b.map(hash), lines: b },
  ];
}

function stronglyEqual(seq: LineSequence, i: number, j: number): boolean {
  return seq.lines[i] === seq.lines[j];
}

/** 行首缩进的字符数（上游 `LineSequence.getBoundaryScore` 的 `getIndentation`）。 */
function indentation(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  return i;
}

/** 边界分：越靠外（缩进越小）越适合作改动边界（上游 `getBoundaryScore`）。 */
function boundaryScore(seq: LineSequence, length: number): number {
  const before = length === 0 ? 0 : indentation(seq.lines[length - 1]);
  const after = length === seq.lines.length ? 0 : indentation(seq.lines[length]);
  return 1000 - (before + after);
}

/** 上游 `getText(range)`：原始行用 `\n` 连起来（`removeVeryShortMatchingLinesBetweenDiffs` 吃它）。 */
function textOf(seq: LineSequence, start: number, end: number): string {
  return seq.lines.slice(start, end).join("\n");
}

/**
 * 上游 `DynamicProgrammingDiffing`。
 *
 * 与普通 LCS 的差别全在这里：斜对角只在**哈希相等**时才可取，且取值的「分」不是 1 ——
 * 原始行也相等时按行长给 `1 + log(1+len)`（空行 0.1），只差空白时给 0.99。
 * 于是「改了一行的一个字」会因为比「整行换掉」更值钱而选在同一位置对齐；
 * 连续对角线还有额外加权（上游的 `lengths`），让改动块尽量连成一片。
 */
function dynamicProgrammingDiffing(
  a: LineSequence,
  b: LineSequence,
  timeout: Deadline,
): { diffs: SequenceDiff[]; timedOut: boolean } {
  const n = a.lines.length;
  const m = b.lines.length;
  if (n === 0 || m === 0) return { diffs: trivialDiff(a, b), timedOut: false };

  const lcs = new Float64Array(n * m);
  const dirs = new Uint8Array(n * m);
  const runLengths = new Int32Array(n * m);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (!timeout.valid()) return { diffs: trivialDiff(a, b), timedOut: true };
      const horizontal = i === 0 ? 0 : lcs[(i - 1) * m + j];
      const vertical = j === 0 ? 0 : lcs[i * m + j - 1];

      let extended = -1;
      if (a.hashes[i] === b.hashes[j]) {
        extended = i === 0 || j === 0 ? 0 : lcs[(i - 1) * m + j - 1];
        if (i > 0 && j > 0 && dirs[(i - 1) * m + j - 1] === 3) {
          extended += runLengths[(i - 1) * m + j - 1];
        }
        extended +=
          a.lines[i] === b.lines[j]
            ? b.lines[j].length === 0
              ? 0.1
              : 1 + Math.log(1 + b.lines[j].length)
            : 0.99;
      }

      const best = Math.max(horizontal, vertical, extended);
      if (best === extended) {
        runLengths[i * m + j] = (i > 0 && j > 0 ? runLengths[(i - 1) * m + j - 1] : 0) + 1;
        dirs[i * m + j] = 3;
      } else if (best === horizontal) {
        runLengths[i * m + j] = 0;
        dirs[i * m + j] = 1;
      } else {
        runLengths[i * m + j] = 0;
        dirs[i * m + j] = 2;
      }
      lcs[i * m + j] = best;
    }
  }

  const result: SequenceDiff[] = [];
  let lastA = n;
  let lastB = m;
  const report = (i: number, j: number): void => {
    if (i + 1 !== lastA || j + 1 !== lastB) {
      result.push({ a0: i + 1, a1: lastA, b0: j + 1, b1: lastB });
    }
    lastA = i;
    lastB = j;
  };
  let i = n - 1;
  let j = m - 1;
  while (i >= 0 && j >= 0) {
    const dir = dirs[i * m + j];
    if (dir === 3) {
      report(i, j);
      i--;
      j--;
    } else if (dir === 1) {
      i--;
    } else {
      j--;
    }
  }
  report(-1, -1);
  result.reverse();
  return { diffs: result, timedOut: false };
}

/** 支持负下标的 Int32 数组（上游 `FastInt32Array`，Myers 的 V 表）。 */
class FastInt32Array {
  private positive = new Int32Array(10);
  private negative = new Int32Array(10);

  get(index: number): number {
    return index < 0 ? this.negative[-index - 1] : this.positive[index];
  }

  set(index: number, value: number): void {
    if (index < 0) {
      const i = -index - 1;
      if (i >= this.negative.length) {
        const next = new Int32Array(this.negative.length * 2);
        next.set(this.negative);
        this.negative = next;
      }
      this.negative[i] = value;
    } else {
      if (index >= this.positive.length) {
        const next = new Int32Array(this.positive.length * 2);
        next.set(this.positive);
        this.positive = next;
      }
      this.positive[index] = value;
    }
  }
}

/** 支持负下标的普通数组（上游 `FastArrayNegativeIndices`，Myers 的路径链）。 */
class FastArray<T> {
  private positive: T[] = [];
  private negative: T[] = [];

  get(index: number): T {
    return index < 0 ? this.negative[-index - 1] : this.positive[index];
  }

  set(index: number, value: T): void {
    if (index < 0) this.negative[-index - 1] = value;
    else this.positive[index] = value;
  }
}

interface SnakePath {
  prev: SnakePath | null;
  x: number;
  y: number;
  length: number;
}

/**
 * 上游 `MyersDiffAlgorithm`（O(ND)，最坏二次空间）。
 * 逐行照搬它的枚举范围与回溯（`lowerBound = -min(d, seqY.length + d%2)` 这两个修正
 * 让「一边已经走完」的输入也能正确收敛）。
 */
function myersDiffing(
  a: LineSequence,
  b: LineSequence,
  timeout: Deadline,
): { diffs: SequenceDiff[]; timedOut: boolean } {
  const n = a.lines.length;
  const m = b.lines.length;
  if (n === 0 || m === 0) return { diffs: trivialDiff(a, b), timedOut: false };

  const snake = (x: number, y: number): number => {
    while (x < n && y < m && a.hashes[x] === b.hashes[y]) {
      x++;
      y++;
    }
    return x;
  };

  let d = 0;
  const v = new FastInt32Array();
  v.set(0, snake(0, 0));
  const paths = new FastArray<SnakePath | null>();
  paths.set(0, v.get(0) === 0 ? null : { prev: null, x: 0, y: 0, length: v.get(0) });

  let foundK: number;
  outer: while (true) {
    d++;
    if (!timeout.valid()) return { diffs: trivialDiff(a, b), timedOut: true };
    const lower = -Math.min(d, m + (d % 2));
    const upper = Math.min(d, n + (d % 2));
    for (let k = lower; k <= upper; k += 2) {
      const fromTop = k === upper ? -1 : v.get(k + 1);
      const fromLeft = k === lower ? -1 : v.get(k - 1) + 1;
      const x = Math.min(Math.max(fromTop, fromLeft), n);
      const y = x - k;
      if (x > n || y > m) continue;
      const nextX = snake(x, y);
      v.set(k, nextX);
      const prevPath = x === fromTop ? paths.get(k + 1) : paths.get(k - 1);
      paths.set(k, nextX !== x ? { prev: prevPath, x, y, length: nextX - x } : prevPath);
      if (v.get(k) === n && v.get(k) - k === m) {
        foundK = k;
        break outer;
      }
    }
  }

  let path = paths.get(foundK!);
  const result: SequenceDiff[] = [];
  let lastA = n;
  let lastB = m;
  for (;;) {
    const endA = path ? path.x + path.length : 0;
    const endB = path ? path.y + path.length : 0;
    if (endA !== lastA || endB !== lastB) {
      result.push({ a0: endA, a1: lastA, b0: endB, b1: lastB });
    }
    if (!path) break;
    lastA = path.x;
    lastB = path.y;
    path = path.prev;
  }
  result.reverse();
  return { diffs: result, timedOut: false };
}

// ---------------------------------------------------------------- 上游的整理（cleanup）

/**
 * 上游 `joinSequenceDiffsByShifting`：先尽量左移、能并就并；再尽量右移、能并就并。
 * 右移那一步用 `isStronglyEqual`（原始行相等）—— 上游注释说是为了「别挪到只 trim 相等的行」。
 */
function joinSequenceDiffsByShifting(
  a: LineSequence,
  b: LineSequence,
  diffs: SequenceDiff[],
): SequenceDiff[] {
  if (diffs.length === 0) return diffs;

  const left: SequenceDiff[] = [diffs[0]];
  for (let i = 1; i < diffs.length; i++) {
    const prev = left[left.length - 1];
    let cur = diffs[i];
    if (cur.a0 === cur.a1 || cur.b0 === cur.b1) {
      const length = cur.a0 - prev.a1;
      let d = 1;
      for (; d <= length; d++) {
        if (
          a.hashes[cur.a0 - d] !== a.hashes[cur.a1 - d] ||
          b.hashes[cur.b0 - d] !== b.hashes[cur.b1 - d]
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
      cur = {
        a0: cur.a0 - d,
        a1: cur.a1 - d,
        b0: cur.b0 - d,
        b1: cur.b1 - d,
      };
    }
    left.push(cur);
  }

  const right: SequenceDiff[] = [];
  for (let i = 0; i < left.length - 1; i++) {
    const next = left[i + 1];
    let cur = left[i];
    if (cur.a0 === cur.a1 || cur.b0 === cur.b1) {
      const length = next.a0 - cur.a1;
      let d = 0;
      for (; d < length; d++) {
        if (
          !stronglyEqual(a, cur.a0 + d, cur.a1 + d) ||
          !stronglyEqual(b, cur.b0 + d, cur.b1 + d)
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
      if (d > 0) {
        cur = {
          a0: cur.a0 + d,
          a1: cur.a1 + d,
          b0: cur.b0 + d,
          b1: cur.b1 + d,
        };
      }
    }
    right.push(cur);
  }
  if (left.length > 0) right.push(left[left.length - 1]);
  return right;
}

/** 上游 `shiftDiffToBetterPosition`：在合法范围里挑边界分最高的位置。 */
function shiftDiffToBetterPosition(
  diff: SequenceDiff,
  a: LineSequence,
  b: LineSequence,
  validA: { start: number; end: number },
  validB: { start: number; end: number },
): SequenceDiff {
  const MAX_SHIFT = 100;
  let deltaBefore = 1;
  while (
    diff.a0 - deltaBefore >= validA.start &&
    diff.b0 - deltaBefore >= validB.start &&
    stronglyEqual(b, diff.b0 - deltaBefore, diff.b1 - deltaBefore) &&
    deltaBefore < MAX_SHIFT
  ) {
    deltaBefore++;
  }
  deltaBefore--;

  let deltaAfter = 0;
  while (
    diff.a0 + deltaAfter < validA.end &&
    diff.b1 + deltaAfter < validB.end &&
    stronglyEqual(b, diff.b0 + deltaAfter, diff.b1 + deltaAfter) &&
    deltaAfter < MAX_SHIFT
  ) {
    deltaAfter++;
  }

  if (deltaBefore === 0 && deltaAfter === 0) return diff;

  let bestDelta = 0;
  let bestScore = -1;
  for (let delta = -deltaBefore; delta <= deltaAfter; delta++) {
    const seq1Offset = diff.a0 + delta;
    const seq2Start = diff.b0 + delta;
    const seq2End = diff.b1 + delta;
    const score =
      boundaryScore(a, seq1Offset) + boundaryScore(b, seq2Start) + boundaryScore(b, seq2End);
    if (score > bestScore) {
      bestScore = score;
      bestDelta = delta;
    }
  }
  return {
    a0: diff.a0 + bestDelta,
    a1: diff.a1 + bestDelta,
    b0: diff.b0 + bestDelta,
    b1: diff.b1 + bestDelta,
  };
}

function swapDiff(diff: SequenceDiff): SequenceDiff {
  return { a0: diff.b0, a1: diff.b1, b0: diff.a0, b1: diff.a1 };
}

/** 上游 `shiftSequenceDiffs`：空行侧（纯增/纯删段）按边界分挪位置。 */
function shiftSequenceDiffs(
  a: LineSequence,
  b: LineSequence,
  diffs: SequenceDiff[],
): SequenceDiff[] {
  for (let i = 0; i < diffs.length; i++) {
    const prev = i > 0 ? diffs[i - 1] : undefined;
    const next = i + 1 < diffs.length ? diffs[i + 1] : undefined;
    const diff = diffs[i];
    const validA = {
      start: prev ? prev.a1 + 1 : 0,
      end: next ? next.a0 - 1 : a.lines.length,
    };
    const validB = {
      start: prev ? prev.b1 + 1 : 0,
      end: next ? next.b0 - 1 : b.lines.length,
    };
    if (diff.a0 === diff.a1) {
      diffs[i] = shiftDiffToBetterPosition(diff, a, b, validA, validB);
    } else if (diff.b0 === diff.b1) {
      diffs[i] = swapDiff(shiftDiffToBetterPosition(swapDiff(diff), b, a, validB, validA));
    }
  }
  return diffs;
}

function optimizeSequenceDiffs(a: LineSequence, b: LineSequence, diffs: SequenceDiff[]) {
  // 只做一次：上游 `optimizeSequenceDiffs` 里第二次 `joinSequenceDiffsByShifting`
  // 是**注释掉的**实验项（「Uncomment … to see the difference」），默认档不做。
  const joined = joinSequenceDiffsByShifting(a, b, diffs);
  return shiftSequenceDiffs(a, b, joined);
}

/**
 * 上游 `removeVeryShortMatchingLinesBetweenDiffs`：两段改动之间夹着的未改动内容去掉空白后
 * ≤ 4 个字符、且两侧改动都不算小 ⇒ 并成一段（否则会出现「大改-一行-大改」的碎片）。
 */
function removeVeryShortMatchingLinesBetweenDiffs(
  a: LineSequence,
  diffs: SequenceDiff[],
): SequenceDiff[] {
  if (diffs.length === 0) return diffs;
  let result = diffs;
  let counter = 0;
  let repeat: boolean;
  do {
    repeat = false;
    const next: SequenceDiff[] = [result[0]];
    for (let i = 1; i < result.length; i++) {
      const cur = result[i];
      const last = next[next.length - 1];
      const unchanged = textOf(a, last.a1, cur.a0).replace(/\s/g, "");
      const join =
        unchanged.length <= 4 &&
        (last.a1 - last.a0 + (last.b1 - last.b0) > 5 || cur.a1 - cur.a0 + (cur.b1 - cur.b0) > 5);
      if (join) {
        repeat = true;
        next[next.length - 1] = {
          a0: last.a0,
          a1: cur.a1,
          b0: last.b0,
          b1: cur.b1,
        };
      } else {
        next.push(cur);
      }
    }
    result = next;
  } while (counter++ < 10 && repeat);
  return result;
}

/**
 * 上游最后一步 `lineRangeMappingFromRangeMappings` 会把**相邻**（首尾相接）的行区间并成一条
 * （`intersectsOrTouches`）：两条空白行相邻改、或者两段改动之间没有未改动行时，VS Code 只报
 * 一条。行级这里同口径合并，块边界才和它一致。
 */
function mergeAdjacentDiffs(diffs: SequenceDiff[]): SequenceDiff[] {
  const result: SequenceDiff[] = [];
  for (const d of diffs) {
    const last = result[result.length - 1];
    if (last && (last.a1 >= d.a0 || last.b1 >= d.b0)) {
      result[result.length - 1] = {
        a0: last.a0,
        a1: Math.max(last.a1, d.a1),
        b0: last.b0,
        b1: Math.max(last.b1, d.b1),
      };
    } else {
      result.push(d);
    }
  }
  return result;
}

/**
 * 上游 `scanForWhitespaceChanges`：对齐出来的未改动区里，原始文本不相等的行（只可能是
 * 空白差异，因为相等判定用的是 trim 后的哈希）各自成一条 1↔1 改动。
 * 上游还会对这些行做字符级 refine，但落到行级只是「这一行改了」——本模块不需要字符区间。
 */
function scanForWhitespaceChanges(
  a: LineSequence,
  b: LineSequence,
  diffs: SequenceDiff[],
): SequenceDiff[] {
  const result: SequenceDiff[] = [];
  let lastA = 0;
  let lastB = 0;
  const scan = (count: number): void => {
    for (let i = 0; i < count; i++) {
      const x = lastA + i;
      const y = lastB + i;
      if (a.lines[x] !== b.lines[y]) {
        result.push({ a0: x, a1: x + 1, b0: y, b1: y + 1 });
      }
    }
  };
  for (const diff of diffs) {
    scan(diff.a0 - lastA);
    lastA = diff.a1;
    lastB = diff.b1;
    result.push(diff);
  }
  scan(a.lines.length - lastA);
  return result;
}

// ---------------------------------------------------------------- 占位块的错位

/**
 * 两行有多「像」：公共前缀 + 公共后缀的字符数。
 *
 * 只要够把「改了行尾一个字」（3+0）与「整行换掉」（0）分开就行 —— 用不着编辑距离那种精度。
 */
function similarity(a: string, b: string): number {
  if (a === b) return a.length * 2;
  const min = Math.min(a.length, b.length);
  let p = 0;
  while (p < min && a[p] === b[p]) p++;
  let s = 0;
  while (s < min - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return p + s;
}

/**
 * 区里两边行数不等 ⇒ 把**少的那一侧**贴到**多的那一侧**哪个错位上：取逐行相似度总和最大的 `o`
 * （并列取最小的 `o` ⇒ 与「从区首配对」的老口径同形）。
 *
 * 这一颗**不是** VS Code 的行对齐语义，只决定差异面上「占位块贴哪一侧、对齐缝画在哪」。
 * 上游对应的东西是 `DiffEditorViewModel` 里的 alignment view zones（另一套），这里沿用
 * B458 的近似：只要能把「删两行 + 紧接着那一行又改了」画在正确的一格上就够。
 *
 * ⚠️ 两边的**行数都要显式传**：本区的行数 ≠ 整个文档的行数。
 */
function alignOffset(
  long: string[],
  longFrom: number,
  longLen: number,
  short: string[],
  shortFrom: number,
  shortLen: number,
): number {
  const span = longLen - shortLen;
  if (span <= 0 || (span + 1) * shortLen > ALIGN_PAIR_BUDGET) return 0;
  let best = 0;
  let bestScore = -1;
  for (let o = 0; o <= span; o++) {
    let score = 0;
    for (let k = 0; k < shortLen; k++)
      score += similarity(long[longFrom + o + k], short[shortFrom + k]);
    if (score > bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return best;
}

// ---------------------------------------------------------------- 出口

/**
 * 基线行数组 vs 当前行数组 ⇒ 一份与 VS Code advanced 对齐同语义的结果。
 *
 * a = 基线行数组、b = 当前行数组（**原始**行）。
 * `ignoreTrimWhitespace` 在最后一关生效：为真时只按 trim 后的哈希判等（纯空白差异算未改动）；
 * 为假时，对齐出来的行里原始文本不同的那些各自成一条 1↔1 改动 —— 与上游
 * `considerWhitespaceChanges` 同一口径。输出的行号/段长**恒按原始行**，调用方不必认识哈希。
 */
export function alignLines(a: string[], b: string[], ignoreTrimWhitespace: boolean): Aligned {
  // 上游对「两边都没有一行」先短路（`originalLines.length <= 1 && equals`）；
  // 否则 DP 的 trivial 分支会吐出一条 0↔0 的空改动。
  if (a.length === 0 && b.length === 0) return { head: 0, tail: 0, regions: [] };

  const [seqA, seqB] = hashSequences(a, b);

  const timeout = deadline(MAX_COMPUTE_MS);
  const raw =
    a.length + b.length < DP_LINE_LIMIT
      ? dynamicProgrammingDiffing(seqA, seqB, timeout)
      : myersDiffing(seqA, seqB, timeout);

  let diffs = optimizeSequenceDiffs(seqA, seqB, raw.diffs);
  diffs = removeVeryShortMatchingLinesBetweenDiffs(seqA, diffs);
  if (!ignoreTrimWhitespace) diffs = scanForWhitespaceChanges(seqA, seqB, diffs);
  diffs = mergeAdjacentDiffs(diffs);

  if (diffs.length === 0) {
    // 没有任何改动 ⇒ 全是相同前缀；`head` 给到较短的一侧（调用方不拿它算块）。
    return { head: Math.min(a.length, b.length), tail: 0, regions: [] };
  }

  const head = diffs[0].a0;
  const last = diffs[diffs.length - 1];
  const tail = a.length - last.a1;
  const regions = diffs.map((d): AlignRegion => {
    const aLen = d.a1 - d.a0;
    const bLen = d.b1 - d.b0;
    const offset =
      aLen > bLen
        ? alignOffset(a, d.a0, aLen, b, d.b0, bLen)
        : bLen > aLen
          ? alignOffset(b, d.b0, bLen, a, d.a0, aLen)
          : 0;
    return {
      aStart: d.a0 - head,
      aLen,
      bStart: d.b0 - head,
      bLen,
      offset,
    };
  });
  return { head, tail, regions };
}

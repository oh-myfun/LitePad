// B461 · 差异内核的唯一对齐来源（设计稿约束 ⑥：4px gutter 列与差异面「同源」）。
//
// B458 的 `lineDiff`（`src/editor/gutterDiff.ts`）与 B461 的块级出口（`src/diff/blocks.ts`）
// 吃**同一份**对齐结果 —— 对齐只算一遍，两个出口永远不会各算各的然后飘移。
// 本模块零 CM6 依赖：纯字符串数组进、纯数据出，单测直接钉。
//
// 零件的来历（注释随代码一起从 gutterDiff.ts 搬来，B458 的坑注不许丢）：
// `splitLines`、`lcsAnchors`、`alignRegions`、`similarity`、`alignOffset` 原样搬家；
// `lineDiff` 里「head/tail 修剪 + 只对中段做对齐」那一截收成 `alignLines` 一个出口，
// 并把每个区的 `offset` 就地算好（旧代码在循环体里现算 `alignOffset`，搬上来后同一份结果两处可用）。

/**
 * LCS 的格子预算：替换区「基线行数 × 当前行数」超过它就不再逐行对齐，整段按下标配对
 * （配得上的算橙、当前多出来的算绿、基线多出来的并成一道缝）。
 *
 * 为什么要预算：前后缀修剪已经把日常编辑（改一行、插几行、删几行）压成很小的中间段，
 * 但「全选再粘一篇」会把整篇留在中间 —— 6 万 × 6 万的 DP 会冻住界面。那种情形下逐行对齐
 * 也讲不出更多道理，退化路径同样给出「每行都有交代」的结果。
 */
export const LCS_CELL_BUDGET = 250_000;

/** 错位搜索的格子预算：超了就退回「从区首逐行配对」的老口径（不猜，也别把界面冻住）。 */
export const ALIGN_PAIR_BUDGET = 20_000;

/** 键入停下多久之后重算全量：唯一一份，gutter 与差异面共用（原先藏在 gutterDiff.ts:235）。 */
export const DIFF_REFRESH_MS = 200;

/**
 * 一块「基线的若干行 ↔ 当前的若干行」的替换区（下标都是修剪后中间段内的 0-based）。
 * `offset` 是少的一侧贴到多的一侧的错位（等长 ⇒ 0，与「从区首配对」的老口径同形），
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

/** 最长公共子序列的锚点（成对下标，升序）；超预算返回空 = 整段当一个替换区。 */
function lcsAnchors(a: string[], b: string[]): Array<[number, number]> {
  if (a.length * b.length > LCS_CELL_BUDGET) return [];
  const w = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const anchors: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      anchors.push([i, j]);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return anchors;
}

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
 * 为什么需要它：真机第一轮抓到「删两行 + 紧接着那一行又改了」画成「橙在第 3 行、红缝在第 4 行」——
 * 纯按下标配对会把被删块的第一行当成被改的那一行，于是缝掉到下一格。按相似错位一挑就对了：
 * `丁后行` ↔ `丁后行Y` 远比 `丙一去` ↔ `丁后行Y` 像 ⇒ 橙与缝都归 `丁后行Y` 那一行。
 *
 * ⚠️ 两边的**行数都要显式传**：本区的行数 ≠ 整个中段的行数。第一版拿 `short.length` 当本区行数，
 * 中段里另有一处改动时 span 就算成负数 ⇒ 永远退回老口径，而单测恰好挑不出（那条里两个数相等）。
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

/** 锚点之间剩下的那些行才是替换区（没有锚点 ⇒ 整段一个区，即预算外的退化路径）；`offset` 就地算好。 */
function alignRegions(a: string[], b: string[]): AlignRegion[] {
  const out: AlignRegion[] = [];
  let ia = 0;
  let ib = 0;
  const push = (ma: number, mb: number): void => {
    if (ma > ia || mb > ib) {
      const aStart = ia;
      const aLen = ma - ia;
      const bStart = ib;
      const bLen = mb - ib;
      // 与旧 lineDiff 循环体里现算 alignOffset 的两支同形：谁短谁是 short。
      const offset =
        aLen > bLen
          ? alignOffset(a, aStart, aLen, b, bStart, bLen)
          : bLen > aLen
            ? alignOffset(b, bStart, bLen, a, aStart, aLen)
            : 0;
      out.push({ aStart, aLen, bStart, bLen, offset });
    }
  };
  for (const [ma, mb] of lcsAnchors(a, b)) {
    push(ma, mb);
    ia = ma + 1;
    ib = mb + 1;
  }
  push(a.length, b.length);
  return out;
}

/**
 * 基线行数组 vs 当前行数组 ⇒ 修剪 + 中段对齐的一份结果（两个出口的唯一对齐来源）。
 *
 * a = 基线行数组、b = 当前行数组（**原始**行，不是加工过的键）。
 * `ignoreTrimWhitespace` 在这一层生效：为真时比较键换成 `line.trim()`（首尾修剪、LCS 相等
 * 判定与相似度入参全走键），但**输出的行号/段长仍按原始行** —— 调用方不必认识键的存在。
 *
 * 先掐掉首尾相同的行（日常编辑的改动都挤在中间一小块），只对中间那段做行级对齐，
 * 于是代价与**改动范围**同阶、与文档行数无关 —— B398 那条口径。
 */
export function alignLines(a: string[], b: string[], ignoreTrimWhitespace: boolean): Aligned {
  // 关着时 ka/kb 就是原数组本身：零拷贝，与 B458 逐字节同路径。
  const ka = ignoreTrimWhitespace ? a.map((l) => l.trim()) : a;
  const kb = ignoreTrimWhitespace ? b.map((l) => l.trim()) : b;

  let head = 0;
  while (head < ka.length && head < kb.length && ka[head] === kb[head]) head++;
  let tail = 0;
  while (
    tail < ka.length - head &&
    tail < kb.length - head &&
    ka[ka.length - 1 - tail] === kb[kb.length - 1 - tail]
  )
    tail++;

  const regions = alignRegions(ka.slice(head, ka.length - tail), kb.slice(head, kb.length - tail));
  return { head, tail, regions };
}

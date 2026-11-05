// B458 · 源码模式行号区右侧的 diff 标注（Notepad++ 那一形的「我改了哪些行还没存」）。
//
// 基线 = **上一次保存的正文**（`doc.baseline`，与标签上那颗未保存原点同一个值），不是 git HEAD：
// 保存之后整片清空，外部重载同理。
//
// 三色与落位（2026-11-04 拍板）：
//   · 绿 = 新增行、橙 = 改动行、红 = 被删掉的行；
//   · 红条属于**被删块后面那一行**的上边缘（方案 B：跨接缝上下各 4px），不属于前面那一行；
//     一块连续删除只画**一道**缝，与删掉的行数无关；
//   · 同一行可以同时带自己的颜色与一道缝 —— 让位是画那一层的事（方案 A：橙让掉最后 4px、
//     绿让掉最前 4px，那道缝归红独占），内核只如实把两种标记都交出去。
//
// 为什么不逐键重算：`lineDiff` 靠前后缀修剪把日常编辑压成很小的中间段，但「把当前正文摊成
// 行数组」这一步本身与文档行数同阶 —— 3.6MB 那种文档每按一键做一遍，就是 B398 刚治好的病。
// 所以键入期间只把已有标记**跟着改动映射**（CM6 的 RangeSet.map，几乎免费），
// 手停下 200ms 之后才真算一次全量。

import {
  Facet,
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";

/**
 * 一行在 gutter 里的交代。
 * `line` 是 **当前文档** 的 1-based 行号（基线行号对渲染方没有意义）。
 */
export interface DiffMark {
  line: number;
  /** 新增行（绿） */
  added?: boolean;
  /** 改动行（橙） */
  modified?: boolean;
  /** 被删块的接缝：画在这一行的上边缘；后面没行了才画最后一行的下边缘 */
  seam?: "top" | "bottom";
}

/**
 * LCS 的格子预算：替换区「基线行数 × 当前行数」超过它就不再逐行对齐，整段按下标配对
 * （配得上的算橙、当前多出来的算绿、基线多出来的并成一道缝）。
 *
 * 为什么要预算：前后缀修剪已经把日常编辑（改一行、插几行、删几行）压成很小的中间段，
 * 但「全选再粘一篇」会把整篇留在中间 —— 6 万 × 6 万的 DP 会冻住界面。那种情形下逐行对齐
 * 也讲不出更多道理，退化路径同样给出「每行都有交代」的结果。
 */
const LCS_CELL_BUDGET = 250_000;

/** 一块「基线的若干行 ↔ 当前的若干行」的替换区（下标都是修剪后中间段内的 0-based）。 */
interface Region {
  aStart: number;
  aLen: number;
  bStart: number;
  bLen: number;
}

/**
 * 按行切开。
 *
 * `""` 当「**没有一行**」而不是「一个空行」：新建文档（基线是空串）打上两行字该是两格绿，
 * 而不是一道红缝加两格绿。其余保留结尾那个空段 —— 它记的正是「最后一个换行之后什么都没有」，
 * 于是「删掉末尾的换行」如实成一道缝（基线多出一条空行）、「补一个换行」如实成一格绿。
 */
function splitLines(text: string): string[] {
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

/** 锚点之间剩下的那些行才是替换区（没有锚点 ⇒ 整段一个区，即预算外的退化路径）。 */
function alignRegions(a: string[], b: string[]): Region[] {
  const out: Region[] = [];
  let ia = 0;
  let ib = 0;
  const push = (ma: number, mb: number): void => {
    if (ma > ia || mb > ib) out.push({ aStart: ia, aLen: ma - ia, bStart: ib, bLen: mb - ib });
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

/** 错位搜索的格子预算：超了就退回「从区首逐行配对」的老口径（不猜，也别把界面冻住）。 */
const ALIGN_PAIR_BUDGET = 20_000;

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

/**
 * 基线正文 vs 当前正文 ⇒ 当前文档每一行的标记（按行号升序）。
 *
 * 先掐掉首尾相同的行（日常编辑的改动都挤在中间一小块），只对中间那段做行级对齐，
 * 于是代价与**改动范围**同阶、与文档行数无关 —— B398 那条口径。
 */
export function lineDiff(baseline: string, current: string): DiffMark[] {
  if (baseline === current) return [];
  const a = splitLines(baseline);
  const b = splitLines(current);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const marks = new Map<number, DiffMark>();
  const put = (line: number): DiffMark => {
    let m = marks.get(line);
    if (!m) {
      m = { line };
      marks.set(line, m);
    }
    return m;
  };
  /** 被删块后面没有行了（贴着正文末尾）⇒ 那道缝落在最后一行的下边缘。 */
  const seamAfter = (after: number): void => {
    if (after < b.length) put(after + 1).seam = "top";
    else if (b.length > 0) put(b.length).seam = "bottom";
    else put(1).seam = "top";
  };

  for (const r of alignRegions(midA, midB)) {
    const bLine = (k: number): number => head + r.bStart + k + 1;
    const paired = Math.min(r.aLen, r.bLen);
    if (r.aLen > r.bLen) {
      // 基线多出来那些行是被删掉的：按相似错位切成「配对窗口前面」与「后面」两段，各画一道缝。
      const o = alignOffset(midA, r.aStart, r.aLen, midB, r.bStart, r.bLen);
      for (let k = 0; k < r.bLen; k++) put(bLine(k)).modified = true;
      if (o > 0 && r.bLen > 0) put(bLine(0)).seam = "top";
      if (r.aLen - r.bLen - o > 0) seamAfter(head + r.bStart + r.bLen);
    } else if (r.bLen > r.aLen) {
      // 当前多出来那些行是新增（绿）：配得上的那几行算改（橙），前后配不上的算新增。
      const o = alignOffset(midB, r.bStart, r.bLen, midA, r.aStart, r.aLen);
      for (let k = 0; k < r.bLen; k++)
        put(bLine(k))[k >= o && k < o + paired ? "modified" : "added"] = true;
    } else {
      for (let k = 0; k < r.bLen; k++) put(bLine(k)).modified = true;
    }
  }

  return [...marks.values()].sort((x, y) => x.line - y.line);
}

/** 键入停下多久之后重算全量：够躲开一段连续击键，又短到「刚停手就看到标记跟上」。 */
const DIFF_REFRESH_MS = 200;

/** 一行一格：颜色与缝都写进 class，画与让位归 CSS（方案 A）。 */
class DiffColumnMarker extends GutterMarker {
  constructor(cls: string) {
    super();
    this.elementClass = cls;
  }
  eq(other: GutterMarker): boolean {
    return other instanceof DiffColumnMarker && other.elementClass === this.elementClass;
  }
}

function markerClass(m: DiffMark): string {
  const parts = ["cm-diff-mark"];
  if (m.added) parts.push("cm-diff-add");
  if (m.modified) parts.push("cm-diff-mod");
  if (m.seam === "top") parts.push("cm-diff-del-top");
  else if (m.seam === "bottom") parts.push("cm-diff-del-bottom");
  return parts.join(" ");
}

/**
 * 基线从哪儿问：一份实例一个读取口。
 *
 * 走函数而不把基线字符串塞进 state，是因为它的写点散在模型层（保存、外部重载、换编码、
 * 会话恢复、跨窗口认领……）：拉一手就不必要求每一处都记得派发一发「基线变了」。
 * `null` = 基线未知（热退出副本 / 跨窗口认领那种「只知道它脏、不知道原样是啥」）⇒ 没得比，整片不画。
 */
const baselineProvider = Facet.define<() => string | null, () => string | null>({
  combine: (values) => values[0] ?? (() => null),
});

interface GutterDiffState {
  /** 这批标记是**对着哪一份基线**算出来的（与 `doc.baseline` 一比就知道该不该重来） */
  baseline: string | null;
  marks: RangeSet<GutterMarker>;
}

/**
 * 「去问一次基线、照它重算」。
 *
 * 正文没动而基线动了（保存、改名、外部重载）时 CM6 不会自己醒 —— 这一发由 `refreshAll`
 * 那条统一刷新路补上（见 markdown.ts 的 `refreshGutterDiffBaselines`），否则用户按完 Ctrl+S
 * 什么也没打，橙绿色还挂在行号上。
 */
export const refreshGutterDiff = StateEffect.define<null>();

const gutterDiffField = StateField.define<GutterDiffState>({
  // 建 state 时只记下基线字符串，不算 diff：`makeTabState` 在切标签的关键路径上（B398 那条），
  // 而挂载后插件立刻补一发刷新 —— 第一帧晚 0ms，换来切标签本身不卡。
  create: (state) => ({ baseline: state.facet(baselineProvider)(), marks: RangeSet.empty }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(refreshGutterDiff)) {
        const baseline = tr.state.facet(baselineProvider)();
        return {
          baseline,
          marks: baseline === null ? RangeSet.empty : buildMarks(tr.state, baseline),
        };
      }
    }
    // 键入期间：标记跟着改动走（那一行被挪到哪，条就画到哪），下一次刷新再纠偏。
    return tr.docChanged ? { baseline: value.baseline, marks: value.marks.map(tr.changes) } : value;
  },
});

/** 这一份 state 装了 diff 标注吗（没装的实例要能被刷新循环认出来并跳过）。 */
export function hasGutterDiff(state: EditorState): boolean {
  return state.field(gutterDiffField, false) !== undefined;
}

/** 字段里记着的基线（刷新循环拿它问「基线换了吗」，换了才派发，不空转）。 */
export function gutterDiffBaseline(state: EditorState): string | null | undefined {
  return state.field(gutterDiffField, false)?.baseline;
}

const gutterDiffView = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(private view: EditorView) {
      // 首帧也要算一次：切标签 / 重载是整态换 state，插件跟着重建，此时什么标记都还没有。
      this.schedule(0);
    }

    update(update: ViewUpdate): void {
      // 正文没动、基线动了那一类由 `refreshGutterDiff` 点名（见上面那颗 effect 的注释）。
      if (update.docChanged) this.schedule(DIFF_REFRESH_MS);
    }

    destroy(): void {
      this.cancel();
    }

    private cancel(): void {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
    }

    private schedule(ms: number): void {
      this.cancel();
      this.timer = setTimeout(() => {
        this.timer = null;
        this.view.dispatch({ effects: refreshGutterDiff.of(null) });
      }, ms);
    }
  },
);

/** 当前正文与基线现算一次，落成 gutter 要的 RangeSet（行号 → 该行的行首；gutter 只认从行首起的标记）。 */
function buildMarks(state: EditorState, baseline: string): RangeSet<GutterMarker> {
  const doc = state.doc;
  const ranges: Range<GutterMarker>[] = [];
  for (const m of lineDiff(baseline, doc.toString())) {
    if (m.line < 1 || m.line > doc.lines) continue;
    const line = doc.line(m.line);
    ranges.push({ from: line.from, to: line.to, value: new DiffColumnMarker(markerClass(m)) });
  }
  // lineDiff 已按行号升序，RangeSet 这头就不用再排一遍。
  return RangeSet.of(ranges, true);
}

/** 那一列本身：4px 宽，排在折叠箭头右侧（原先那是 5px 留白，见 global.css 的折叠槽规则）。 */
const diffColumn = gutter({
  class: "cm-diffGutter",
  // 空行也画一格：列宽因此与「有没有标记」无关（正文不会因存盘而左右跳），
  // DOM 里也就能按**可见行序**直接寻址 —— 判落位不必再去猜内部结构。
  renderEmptyElements: true,
  markers: (view) => view.state.field(gutterDiffField, false)?.marks ?? RangeSet.empty,
});

/**
 * 挂进 `makeTabState` 的那一摞（一份实例一份）。
 *
 * 不给 `baseline` = 没处问基线（单测里的最小 state、harness）⇒ 整列空着，
 * 但仍然占那 4px：折叠槽的留白同步收窄，总宽不变，存不存盘都不会让正文左右跳一格。
 */
export function gutterDiff(baseline?: () => string | null): Extension {
  return [
    baselineProvider.of(baseline ?? (() => null)),
    gutterDiffField,
    gutterDiffView,
    diffColumn,
  ];
}

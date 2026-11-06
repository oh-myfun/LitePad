// B461 · Task 3 —— 差异面的装饰层（一栏之内的行底色 / 占位块 / 中间指示带）。
//
// 设计稿 ⑥ 的「同源」约束落在这里：**本文件只消费 `blocks.ts` 交出来的 `DiffBlock[]`，
// 自己一行都不重新对齐**（对齐只在 `src/diff/align.ts` 算一遍，4px 标注与差异面共用那颗）。
// 于是「键入时三处（面板条目 / 两侧底色 / 4px 标注）同刻跟上」不会有两份真相。
//
// 行号口径沿用 `blocks.ts`：**1-based 含端点**，`start > end` ⇒ 该侧是空段
// （空段的落点在 `end` 行之后）—— 占位块据此落位。
//
// 分两半：
//   · `sideLineMarks` / `sideGaps` 是纯函数（一栏 ↔ 一批行/缝），单测直接钉向量；
//   · `diffFace(side, blocks)` 是挂到 view 上的那一臂（就一颗 `StateField`，装饰由它 provide），
//     把纯函数的结果誊成 CM6 装饰。键入期不重算（只 `value.map(tr.changes)`），而
//     「什么时候该重算」由持有两颗 view 的 `surface.ts` 定（停手 `DIFF_REFRESH_MS` 一发
//     `refreshDiff`）—— 与 `gutterDiffField` 同一条纪律（B398），但**本文件自己不排定时器**
//     （R24：防抖只许有一份）。

import {
  Facet,
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Text,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  gutterLineClass,
  GutterMarker,
  WidgetType,
} from "@codemirror/view";
import type { DiffBlock, DiffKind } from "./blocks";
import type { DiffSide } from "./model";

/** 一行之上的交代：落在第几行、是什么形。 */
export interface SideMark {
  line: number;
  kind: DiffKind;
}

/** 这一侧要补出的空位：落在第 `afterLine` 行之后、占 `count` 行。 */
export interface SideGap {
  afterLine: number;
  count: number;
}

/** 本侧区间（1-based 含端点；`start > end` ⇒ 空段）。 */
function ownRange(b: DiffBlock, side: DiffSide): { start: number; end: number } {
  return side === "modified"
    ? { start: b.modifiedStart, end: b.modifiedEnd }
    : { start: b.originalStart, end: b.originalEnd };
}

/** 对侧区间。 */
function otherRange(b: DiffBlock, side: DiffSide): { start: number; end: number } {
  return ownRange(b, side === "modified" ? "original" : "modified");
}

/** 段长：空段（start > end）记 0。 */
function segLen({ start, end }: { start: number; end: number }): number {
  return Math.max(end - start + 1, 0);
}

/**
 * 这一栏要涂底色的那些行（按行号升序）。
 *
 * `modify` 两侧都标、`insert` 只标 modified 侧、`delete` 只标 original 侧 ——
 * 「删掉的行在右栏根本没有真行，新增的行在左栏根本没有真行」正是设计稿 ⑥ 那一屏的语义。
 */
export function sideLineMarks(blocks: DiffBlock[], side: DiffSide): SideMark[] {
  const out: SideMark[] = [];
  for (const b of blocks) {
    if (b.kind === "insert" && side !== "modified") continue;
    if (b.kind === "delete" && side !== "original") continue;
    const { start, end } = ownRange(b, side);
    for (let line = start; line <= end; line++) out.push({ line, kind: b.kind });
  }
  return out;
}

/**
 * 这一栏要补出的空位段（按 `afterLine` 升序）。
 *
 * 只在**本侧段长比另一侧短**时有：短出来的那些行落在配对窗口的哪一头，由 `block.offset`
 * 定（offset = 少的一侧贴到多的一侧的错位 ⇒ 窗口**之前**有 `offset` 行没人配、
 * **之后**有剩下的那些）。空段那一侧没有窗口可言，整段都记在 `end`（= `start - 1`）之后。
 *
 * `alignOffset` 交出来的 `offset` 恒在 `0 .. (otherLen - ownLen)` 之内；那颗 `Math.min`
 * 只是兜一手，别让内核哪天改出个越界的错位把占位行数放大 —— 少了它，多算的那些行会**画出来**，
 * 而两栏的行就错开了（错的方向要是「少画一行」，肉眼还能看出来，多画则是静默错位）。
 */
export function sideGaps(blocks: DiffBlock[], side: DiffSide): SideGap[] {
  const out: SideGap[] = [];
  for (const b of blocks) {
    const own = ownRange(b, side);
    const other = otherRange(b, side);
    const ownLen = segLen(own);
    const otherLen = segLen(other);
    if (ownLen >= otherLen) continue;
    const total = otherLen - ownLen;
    const before = ownLen === 0 ? 0 : Math.min(b.offset, total);
    const after = total - before;
    if (before > 0) out.push({ afterLine: own.start - 1, count: before });
    if (after > 0) out.push({ afterLine: own.end, count: after });
  }
  return out;
}

// --------------------------------------------------------------------------- #
// CM6 那一臂
// --------------------------------------------------------------------------- #

/**
 * 「按 provider 现在给的这批块重画一次」。
 *
 * 谁发：**只有 `surface.ts` 那一处** —— 它持有两颗 view，键入停手 `DIFF_REFRESH_MS` 之后
 * 自己重算一次块表，再把这一发同时点进两侧（对栏那颗 view 看不见这边的键入，两侧才会
 * 同一刻同源）。正文没动而基线动了那一类（存盘、外部重载、换输入）也发这一发。
 *
 * ⚠️ 本文件**自己不排定时器**（裁决 R24）：原先这一臂里藏着一颗同款防抖，与 surface 那颗
 * 并存在 ⇒ 同一次停手把 `diffBlocks` 算两遍。防抖只许有一份，而那份的主人是持有两颗 view
 * 的 surface；`diffFace` 于是只认「点名重画」，不认「什么时候该重画」。
 *
 * 与 `refreshGutterDiff` 同形：CM6 不会自己醒，得点名。
 */
export const refreshDiff = StateEffect.define<null>();

/** 这一臂管哪一栏（行号取哪一对字段、空位落在哪一头，都跟着它）。 */
const faceSide = Facet.define<DiffSide, DiffSide>({ combine: (values) => values[0] ?? "modified" });

/**
 * 块的来源：一颗**读取口**，不是快照。
 *
 * 与 `gutterDiff` 的 `baselineProvider` 同一手法：把「现在这批块是什么」留给持有数据的那一侧
 * （surface / Task 5 的基线读取口），于是装饰层不必认识文档模型，也不需要每个写点记得派发。
 */
const faceBlocks = Facet.define<() => DiffBlock[], () => DiffBlock[]>({
  combine: (values) => values[0] ?? (() => []),
});

/**
 * 对侧的空位：一块占 `count` 行的**块级** widget。
 *
 * ⚠️ 高度只按 `view.defaultLineHeight` 写 inline（R15）：CM6 那套行盒量度才是权威，
 * 样式段里写 `em` 或写数字都会跟着字阶复利 —— 两栏的逐行对齐立刻分家（`src/preview/` 那些
 * 块 widget 栽过两次）。块级身份由装饰那颗 `block: true` 定（本版 CM6 的 `WidgetType`
 * 没有 `block` 口，装饰 spec 是唯一入口），并且不许带竖向 margin（同一条文档）。
 *
 * ⚠️ 「`count` 行 = `count × 行高`」这条等式成立的前提是**一个文档行 = 一个视觉行**，
 * 也就是差异格两栏都不折行（R19，由 `surface.ts` 在挂旁路那一刻保证：右栏的折行被关掉、
 * 左栏从一开始就不装）。折行一开，这几行在对侧折出来的视觉行比 `count` 多 ⇒ 占位块矮了，
 * 两栏的行就错开；那一头要靠按对侧实测行高来对齐（VS Code 的做法），B398 已经裁掉：
 * 「参考 vscode，不要弄这么复杂」。
 */
export class DiffGapWidget extends WidgetType {
  constructor(readonly count: number) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof DiffGapWidget && other.count === this.count;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = "diff-gap";
    el.style.height = `${this.count * view.defaultLineHeight}px`;
    return el;
  }

  /** 占位块不吃点击也不吃光标：那里没有真行，选它与选相邻那行是两件事。 */
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * 一批块誊成这一栏的装饰。
 *
 * 只做**行号 → 位置**的换算（含越界丢弃：块是按 provider 那份正文算的，本栏正文可能已经
 * 先动了一步），一行只发一条 `Decoration.line`（CM6 的行装饰必须是零点区间，且两条同线
 * 不如一条并起来干净），所以块起点的 `diff-edge-top` 并进底色那一条的 class 里。
 */
function buildFace(doc: Text, side: DiffSide, blocks: DiffBlock[]): RangeSet<Decoration> {
  const classes = new Map<number, string>();
  for (const m of sideLineMarks(blocks, side)) {
    if (m.line < 1 || m.line > doc.lines) continue;
    classes.set(m.line, `diff-line-${m.kind}`);
  }
  for (const b of blocks) {
    const { start, end } = ownRange(b, side);
    // 空段那一侧没有真行（那一头的交代是占位块自己的斜纹），起点的横头就不必发。
    if (start > end || start < 1 || start > doc.lines) continue;
    const below = classes.get(start);
    classes.set(start, below ? `${below} diff-edge-top` : "diff-edge-top");
  }

  const ranges: Range<Decoration>[] = [];
  for (const [line, cls] of classes) {
    ranges.push(Decoration.line({ class: cls }).range(doc.line(line).from));
  }
  for (const gap of sideGaps(blocks, side)) {
    if (gap.count <= 0) continue;
    const after = Math.min(Math.max(gap.afterLine, 0), doc.lines);
    const widget = new DiffGapWidget(gap.count);
    // 块 widget 要落在线界上：`after` 行之后 ⇒ 挂在该行行尾（side > 0 = 那一行之后）；
    // 第 0 行之后（正文开头就缺行）⇒ 挂在第 1 行行首（side < 0 = 那一行之前）。
    ranges.push(
      after === 0
        ? Decoration.widget({ widget, block: true, side: -1 }).range(0)
        : Decoration.widget({ widget, block: true, side: 1 }).range(doc.line(after).to),
    );
  }
  // 行装饰与块 widget 混在一摞里（两条队列各自有序 ⇒ 合起来无序），让 CM6 按
  // (`from`, `startSide`) 自己排：条数与块数同阶，排序代价可以忽略。
  return Decoration.set(ranges, true);
}

const diffFaceField = StateField.define<RangeSet<Decoration>>({
  // 建 state 时按 provider 现算一次：这一臂只随差异标签而建，不像 `gutterDiffField`
  // 那样压在「每切一次标签都要过」的那条路上。
  create: (state) => buildFace(state.doc, state.facet(faceSide), state.facet(faceBlocks)()),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(refreshDiff)) {
        return buildFace(tr.state.doc, tr.state.facet(faceSide), tr.state.facet(faceBlocks)());
      }
    }
    // 键入期：装饰跟着改动走，不重算（与 `gutterDiffField` 同一纪律）。
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * 一臂装饰：装在**某一栏**那颗 view 上，吃 `blocks()` 交出来的块，并且带着折叠的那一臂。
 *
 * 用法（预审 R1）：两颗 view 各装一臂、各自 `side`，由 `surface.ts` 在挂旁路那一刻通过自己
 * 创建的 `Compartment` 装上/拆掉。本文件不建 view、不认识文档模型，也**不排任何定时器**
 * （重画的时机归 surface，见 `refreshDiff` 那一段）。
 *
 * 折叠（Task 7）就骑在**同一臂**里：`diffFoldField` 的值由 `setFoldedRanges` 那一发写入，
 * 于是它进得了右栏那颗既有的 view，而不必再 `appendConfig` 一颗新槽 —— 那颗槽就是 Task 5
 * 抓过的「上一臂还活着」那一场病的病根（见 `surface.ts` 的 `rightFaceSlot` 注）。
 */
export function diffFace(side: DiffSide, blocks: () => DiffBlock[]): Extension {
  return [faceSide.of(side), faceBlocks.of(blocks), diffFaceField, diffFoldField];
}

// --------------------------------------------------------------------------- #
// Task 7 · 折叠未改动区（折起来的行 + 占位条）
// --------------------------------------------------------------------------- #

/**
 * 折叠的三颗常量与 `vscode` 的 `diffEditor` 那一组同名同值（照源码抄来：
 * `editor.contrib.diffEditor` 的 `diffEditor.hideUnchangedRegions.contextLineCount 3` /
 * `minimumLineCount 3` / `revealLineCount 20`）。用户可见的文案里不提名处。
 */
export const DIFF_CONTEXT_LINES = 3;
export const DIFF_MIN_UNCHANGED_LINES = 3;
/** 点折条展开时，上下各揭示这么多行。 */
export const DIFF_REVEAL_LINES = 20;

/** 一段未改动行在本栏的位置（`run` = 它是第几段：首块之前 0，两块之间按前一块的序号，末块之后 = 块数）。 */
export interface UnchangedRun {
  run: number;
  start: number;
  end: number;
}

/** 一段**折起来**的行（`run` 带上是为了让 surface 能按段记账；`from`/`to` 含端点，本栏行轴）。 */
export interface FoldRange {
  run: number;
  from: number;
  to: number;
}

/** 折起来的行在臂里的形态（只有行号：画法与段序号都不归装饰层管）。 */
export interface FoldPoint {
  from: number;
  to: number;
}

/** 发进某一臂的折叠态（只带行号：段序号是 surface 那一侧的记账口径，装饰层不认）。 */
export const setFoldedRanges = StateEffect.define<Array<{ from: number; to: number }>>();

/**
 * 折条被点（**每一栏一条**：臂里带上的是那一栏自己的回调）。
 *
 * 为什么交回调用而不是让 widget 自己发 `setFoldedRanges`：折起来的是哪些段只有 surface 知道
 * （它的开关状态 + 手动展开过的段号才是那一份真相）。装饰层自己摘一段就等于第二份真相 ——
 * 下一发 `syncBlocks` 按 surface 那份清单重发，被摘的那一段立刻又折回来。
 */
const faceFoldClick = Facet.define<(from: number) => void, ((from: number) => void) | null>({
  combine: (values) => values[0] ?? null,
});

/** 挂上「折条被点了」的出口（与两臂一起进 state；拆臂就没了）。 */
export function onFoldBarClick(fn: (from: number) => void): Extension {
  return faceFoldClick.of(fn);
}

/**
 * 本栏的每一段未改动行（升序）。
 *
 * **候选只从 `diffBlocks` 的产物推**（设计稿 ⑥ 的同源：三处同刻跟上靠的就是这一条）——
 * 相邻两块之间、首块之前、末块之后那几行就是「两边一字不差」的那一段，别处不许再对
 * 「哪些行是未改动的」另算一遍（所以这里只读块的本栏区间，不读正文、不碰对齐器）。
 *
 * 空段（`start > end`，那一侧没有真行）自己不会造出未改动行：它的 `start = end + 1`
 * 正好落在下一段的边界上，于是 `prev` 取 `end` 之后下一段从 `end + 1` 起 —— 与
 * `blocks.ts` 的空段表示法同一口径，不会把落点那一行重复算进两段里。
 */
export function unchangedRuns(
  blocks: DiffBlock[],
  side: DiffSide,
  totalLines: number,
): UnchangedRun[] {
  const out: UnchangedRun[] = [];
  let prev = 0; // 上一块在本栏的结束行（0 = 还没走到块）
  for (let i = 0; i < blocks.length; i++) {
    const { start, end } = ownRange(blocks[i], side);
    if (prev + 1 <= start - 1) out.push({ run: i, start: prev + 1, end: start - 1 });
    prev = Math.max(prev, end);
  }
  if (prev + 1 <= totalLines) out.push({ run: blocks.length, start: prev + 1, end: totalLines });
  return out;
}

/**
 * 折叠候选（本栏行轴）：长度 **> `DIFF_MIN_UNCHANGED_LINES + 2 * DIFF_CONTEXT_LINES`** 才折，
 * 折掉中间、上下各留 `DIFF_CONTEXT_LINES` 行（阈值照源码那一组：3 + 2×3 ⇒ 9 行不折、10 行才折）。
 *
 * 两侧的**段长天然相等**（两块之间的那些行是配对了的相同行），所以「够不够长」这一问不分栏；
 * 分栏的是**行号**（两块之间一旦有长短不等的块，两栏的行轴就错开）⇒ 候选与折区必须按 `side`
 * 各换算一份，不许只算右栏。
 */
export function foldCandidates(
  blocks: DiffBlock[],
  side: DiffSide,
  totalLines: number,
): FoldRange[] {
  const out: FoldRange[] = [];
  for (const run of unchangedRuns(blocks, side, totalLines)) {
    if (run.end - run.start + 1 <= DIFF_MIN_UNCHANGED_LINES + 2 * DIFF_CONTEXT_LINES) continue;
    out.push({
      run: run.run,
      from: run.start + DIFF_CONTEXT_LINES,
      to: run.end - DIFF_CONTEXT_LINES,
    });
  }
  return out;
}

/**
 * 折起来的那一段之上的**占位条**：一行高（与它替掉的那些行不同，它自己必须占一格），
 * 文案「展开 N 行未改动的内容」，点它 = 展开这一段。
 *
 * ⚠️ 高度与 `DiffGapWidget` 同一条纪律（R15/R18）：只按 `view.defaultLineHeight` 写 inline，
 * 样式段里不许出现 `height` / `em` / 竖向 margin —— 两栏各折同样多的行，折条也各占一行，
 * 逐行对齐才不塌。
 *
 * ⚠️ `eq` 比**回调身份**（除了 from/to）：右栏那一臂是跨 surface 共用的同一颗槽，换挂时
 * 装饰层不会自己重建；不比回调的话，新 surface 挂上后点折条会叫到上一颗（已 dispose 的）
 * surface 身上 —— 与 Task 5 那个「旧 provider 还闭包着旧块表」同形，只是换了个抓手。
 */
export class DiffFoldWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly onExpand: ((from: number) => void) | null,
  ) {
    super();
  }

  get hidden(): number {
    return this.to - this.from + 1;
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof DiffFoldWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.onExpand === this.onExpand
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = "diff-fold-bar";
    el.style.height = `${view.defaultLineHeight}px`;
    el.textContent = `展开 ${this.hidden} 行未改动的内容`;
    el.addEventListener("click", (event) => {
      event.preventDefault();
      // 单独装一臂（不带出口）时点下去就是空转：折叠态的清单只由 surface 那一份真相发进来，
      // 装饰层自己摘一段等于第二份真相（下一次重算又把它折回去）。
      this.onExpand?.(this.from);
    });
    return el;
  }

  /** 折条吃点击，但**不吃光标**：点到它不该把插入符搬进被折起来的那几行里。 */
  ignoreEvent(event: Event): boolean {
    return event.type !== "click" && event.type !== "mousedown";
  }
}

/** 折起来的行在行号栏那一格上的类（线装饰的类**不会**自动落到 gutter 元素上，得自己发标记）。 */
class FoldGutterMarker extends GutterMarker {
  elementClass = "diff-folded-gutter";

  eq(other: GutterMarker): boolean {
    return other instanceof FoldGutterMarker;
  }

  toString(): string {
    return "";
  }
}

const foldGutterMarker = new FoldGutterMarker();

/** 夹到本栏真实存在的行号（块是按 provider 那份正文算的，本栏正文可能先动了一步）。 */
function clampLine(line: number, totalLines: number): number {
  return Math.min(Math.max(line, 1), totalLines);
}

/** 折区 → 一摞行装饰（`display: none` 的那些行）+ 起点的折条。 */
function buildFoldFace(
  doc: Text,
  folds: readonly FoldPoint[],
  onExpand: ((from: number) => void) | null,
): RangeSet<Decoration> {
  const ranges: Range<Decoration>[] = [];
  for (const fold of folds) {
    const from = clampLine(fold.from, doc.lines);
    const to = clampLine(fold.to, doc.lines);
    if (from > to) continue;
    // 折条恒发（出口没挂上时点下去是空转）：折叠态是**看得见的状态**，不该因为没人接就把
    // 那几行抹掉却连条都不留。
    ranges.push(
      Decoration.widget({
        widget: new DiffFoldWidget(from, to, onExpand),
        block: true,
        side: -1,
      }).range(doc.line(from).from),
    );
    for (let line = from; line <= to; line++) {
      ranges.push(Decoration.line({ class: "diff-folded" }).range(doc.line(line).from));
    }
  }
  return Decoration.set(ranges, true);
}

/** 折起来的行 → 行号栏的类（不抹掉的话那一串数字会在 0 高的格子里挤成一坨）。 */
function buildFoldGutter(doc: Text, folds: readonly FoldPoint[]): RangeSet<GutterMarker> {
  const ranges: Range<GutterMarker>[] = [];
  for (const fold of folds) {
    for (
      let line = clampLine(fold.from, doc.lines);
      line <= clampLine(fold.to, doc.lines);
      line++
    ) {
      ranges.push(foldGutterMarker.range(doc.line(line).from));
    }
  }
  return RangeSet.of(ranges, true);
}

/**
 * 键入期把折区跟着改动走（与 `diffFaceField` 里 `value.map(tr.changes)` 同一条纪律）：
 * 行号按位置换算（起点贴前、终点贴后），换算完空了的段丢掉。这一手只管「到点之前别画错行」，
 * 真正的重算还是 surface 那一发 `syncBlocks`（那里会按新块表重发 `setFoldedRanges`）。
 */
function mapFolds(value: FoldPoint[], tr: Transaction): FoldPoint[] {
  const doc = tr.startState.doc;
  const out: FoldPoint[] = [];
  for (const fold of value) {
    const a = tr.changes.mapPos(doc.line(clampLine(fold.from, doc.lines)).from, -1);
    const b = tr.changes.mapPos(doc.line(clampLine(fold.to, doc.lines)).to, 1);
    const from = tr.newDoc.lineAt(a).number;
    const to = tr.newDoc.lineAt(b).number;
    if (from <= to) out.push({ from, to });
  }
  return out;
}

/**
 * 折叠态那一臂的值：**清单**（行号）加上**由它算出来的两份画法**。
 *
 * ⚠️ 画法只在 `setFoldedRanges` 那一发里重建（修复轮 Important 3）：`buildFoldFace` /
 * `buildFoldGutter` 每折一行分配一条 `Decoration.line`（外加一颗 gutter 标记），拿它当
 * `compute([f, "doc"])` 的函数体就等于**每键 O(折起来的行数)** 的分配，而 Tier A 是活着的
 * 编辑面 —— 与本文件头「键入期不重算（只 `value.map(tr.changes)`）」那条纪律直接对冲。
 * 键入期三份一起交给映射：清单按行号换算（`mapFolds`，几笔），画法由 CM6 映射（不重新分配），
 * 于是折条上那份行号清单与它替掉的那几行的行数要等下一次点名才跟着新块表走（已知限制）。
 */
interface FoldFace {
  folds: FoldPoint[];
  lines: RangeSet<Decoration>;
  gutter: RangeSet<GutterMarker>;
}

/** 一份都没有 = 一段都没折（建 state 与拆臂之后都是这一份）。 */
const emptyFoldFace: FoldFace = { folds: [], lines: RangeSet.empty, gutter: RangeSet.empty };

/** 清单 → 画法（只在点名那一发跑：这一发是 O(折起来的行数) 的分配）。 */
function foldFaceOf(
  doc: Text,
  folds: readonly FoldPoint[],
  onExpand: ((from: number) => void) | null,
): FoldFace {
  return {
    folds: folds.map(({ from, to }) => ({ from, to })),
    lines: buildFoldFace(doc, folds, onExpand),
    gutter: buildFoldGutter(doc, folds),
  };
}

/** 折叠态那一臂的字段（`{from,to}` 是本栏行轴的行号，与 `setFoldedRanges` 交进来的同一份）。 */
const diffFoldField = StateField.define<FoldFace>({
  create: () => emptyFoldFace,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setFoldedRanges)) {
        return foldFaceOf(tr.state.doc, e.value, tr.state.facet(faceFoldClick));
      }
    }
    if (!tr.docChanged) return value;
    // 键入期：清单与画法一起映射，不重算（画法这一头 CM6 自己管，见 `FoldFace` 那条 ⚠️）。
    return {
      folds: mapFolds(value.folds, tr),
      lines: value.lines.map(tr.changes),
      gutter: value.gutter.map(tr.changes),
    };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.lines),
    gutterLineClass.from(f, (v) => v.gutter),
  ],
});

/**
 * 某一栏**现在真的画着**哪几段折区（本栏行轴，跟着改动映射过 ⇒ 与屏幕同一份）。
 *
 * surface 查「光标掉进 `display: none` 的行没有」必须读这一份，而不是按候选清单现算：
 * 清单是按**上一份块表**的行号算的，画上去的那一段是跟着改动一路映射的，两者差的正是
 * 「上面插进去（或并上来）的那几行」—— 按清单查会读到「没盖住光标」，而屏幕上那一行
 * 就是看不见（修复轮 Important 1 抓的第二路）。
 *
 * ⚠️ 这是**读**，不是第二份真相：折不折、折哪几段仍旧只由 surface 那一发 `setFoldedRanges`
 * 写进来（R24 同口径），这一颗只是那份画法自己的投影，臂拆了就读到空。
 */
export function foldedRangesIn(state: EditorState): readonly FoldPoint[] {
  return state.field(diffFoldField, false)?.folds ?? [];
}

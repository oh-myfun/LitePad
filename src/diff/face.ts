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
  StateEffect,
  StateField,
  type Extension,
  type Range,
  type RangeSet,
  type Text,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
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
 * 一臂装饰：装在**某一栏**那颗 view 上，吃 `blocks()` 交出来的块。
 *
 * 用法（预审 R1）：两颗 view 各装一臂、各自 `side`，由 `surface.ts` 在挂旁路那一刻通过自己
 * 创建的 `Compartment` 装上/拆掉。本文件不建 view、不认识文档模型，也**不排任何定时器**
 * （重画的时机归 surface，见 `refreshDiff` 那一段）。
 */
export function diffFace(side: DiffSide, blocks: () => DiffBlock[]): Extension {
  return [faceSide.of(side), faceBlocks.of(blocks), diffFaceField];
}

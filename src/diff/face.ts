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
//   · `sideLineMarks` / `gapZones` 是纯函数（一栏 ↔ 一批行/缝），单测直接钉向量；缝的高度
//     是**像素**，由 surface 把两栏的实测行高喂进来（`LineHeightOf`），本文件自己不量；
//   · `diffFace(side, source)` 是挂到 view 上的那一臂（就一颗 `StateField`，装饰由它 provide），
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
  gutter,
  GutterMarker,
  lineNumberMarkers,
  WidgetType,
} from "@codemirror/view";
import { type DiffBlock, type DiffKind, type LineAlignment } from "./blocks";
import type { InnerChanges, InnerRange } from "./inline";
import { CODICONS } from "../shell/codicons";
import type { DiffSide } from "./model";

/** 一行之上的交代：落在第几行、在这一侧是删除行还是新增行。 */
export interface SideMark {
  line: number;
  kind: Extract<DiffKind, "insert" | "delete">;
  /** 这一行整行都是「对侧没有」的（纯增 / 纯删块）：渲染层要铺满整行的字符底色。 */
  whole: boolean;
}

/**
 * 一条对齐缝：落在第 `afterLine` 行之后、占 `height` **像素**。
 *
 * 为什么是像素而不是行数（B461 后续轮，照 VS Code 的 alignment view zone）：
 * 打开自动换行之后一个文档行会折成多个视觉行，两栏哪怕行数相等，视觉高度也不等。
 * 上游的 `diffEditorViewZones.ts` 正是把两侧区间按 `lineHeight × 行数 + 折行额外高度`
 * 折算成像素再补差值 —— 这里沿用同一口径，行数只在「缝落在哪一行之后」这一件事上还用到。
 *
 * `lines` = 这条缝里有多少行是**对侧真的缺行**（不是折行高度差）：
 * 记号槽要按它逐行补 `+` / `−`（见 `DiffGapSignMarker`），折行差那几笔是 0。
 */
export interface GapZone {
  afterLine: number;
  height: number;
  lines: number;
}

/** 某一栏第 `line` 行的实测高度（1-based；已含该行折出来的所有视觉行）。 */
export type LineHeightOf = (side: DiffSide, line: number) => number;

/** 两侧各有多少行（尾段未改动区要靠它收口）。 */
export interface LineTotals {
  original: number;
  modified: number;
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

/**
 * 这一栏要涂底色的那些行（按行号升序）。
 *
 * 分成两侧看，**没有「修改行」这一档**（与 VS Code 的同栏语义一致）：
 * 原稿一侧的每一行都是「被删掉的行」，新稿一侧的每一行都是「新增的行」；
 * 改块在两边各自涂成删除 / 新增，而不是另造一颗第三种颜色。
 *
 * 空段那一侧没有真行（`start > end`），循环自然不发。
 */
export function sideLineMarks(blocks: DiffBlock[], side: DiffSide): SideMark[] {
  const kind = side === "original" ? "delete" : "insert";
  const out: SideMark[] = [];
  for (const b of blocks) {
    const { start, end } = ownRange(b, side);
    const other = ownRange(b, side === "original" ? "modified" : "original");
    const whole = other.start > other.end;
    for (let line = start; line <= end; line++) out.push({ line, kind, whole });
  }
  return out;
}

/**
 * 两侧各自要补出的对齐缝（按 `afterLine` 升序）。
 *
 * 分两段算，照 VS Code 的 `computeRangeAlignment`：
 *   · **未改动区**（两块之间、首块之前、末块之后）：两侧行数相等，但同一行在两栏的宽度不同
 *     （分割线一拖就不是等宽），折出来的视觉行数可能不同 ⇒ 逐行比实测高度，矮的一侧补缝。
 *     上游的 `handleAlignmentsOutsideOfDiffs` 就是这件事，漏掉它，折行时两栏在未改动段
 *     就会整体错开。
 *   · **差异块**：块首、`innerChanges` 反推的对齐边界、块尾连成若干段（上游
 *     `innerHunkAlignment`）。每段比两侧实测总高，差多少就补到矮的一侧、落在**段尾之后**
 *     —— 与上游把 view zone 插在 `range.endLineNumberExclusive - 1` 之后完全同款。段内
 *     行数不同时，缺口记号数量取行数差；只折行不差行时是 0（记号与折行缝分得开）。
 *
 * 高度只从 `heightOf` 来（surface 交进来的实测口）：本文件不认识 view，也不自己量。
 */
export function gapZones(
  blocks: DiffBlock[],
  totals: LineTotals,
  heightOf: LineHeightOf,
  alignments: LineAlignment[][],
): Record<DiffSide, GapZone[]> {
  const out: Record<DiffSide, GapZone[]> = { original: [], modified: [] };
  let po = 0;
  let pm = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const own = ownRange(b, "original");
    const other = otherRange(b, "original");
    alignUnchanged(out, po + 1, own.start - 1, pm + 1, other.start - 1, heightOf);

    // 块首 → 对齐边界 → 块尾。边界来自字符 diff（绝对行号），与块首尾连成一组相邻点。
    const stops: LineAlignment[] = [
      { originalLine: b.originalStart, modifiedLine: b.modifiedStart },
      ...alignments[i],
      { originalLine: b.originalEnd + 1, modifiedLine: b.modifiedEnd + 1 },
    ];
    let prev = stops[0];
    for (let s = 1; s < stops.length; s++) {
      const point = stops[s];
      // 单调性守卫：越界/回退的边界一律跳过（上游 emitAlignment 同款）。
      if (point.originalLine < prev.originalLine || point.modifiedLine < prev.modifiedLine) {
        continue;
      }
      const originalCount = point.originalLine - prev.originalLine;
      const modifiedCount = point.modifiedLine - prev.modifiedLine;
      if (originalCount === 0 && modifiedCount === 0) continue;
      const originalHeight = rangeHeight(
        { start: prev.originalLine, end: point.originalLine - 1 },
        "original",
        heightOf,
      );
      const modifiedHeight = rangeHeight(
        { start: prev.modifiedLine, end: point.modifiedLine - 1 },
        "modified",
        heightOf,
      );
      const delta = modifiedHeight - originalHeight;
      if (delta > 0) {
        pushGap(
          out.original,
          point.originalLine - 1,
          delta,
          Math.max(modifiedCount - originalCount, 0),
        );
      } else if (delta < 0) {
        pushGap(
          out.modified,
          point.modifiedLine - 1,
          -delta,
          Math.max(originalCount - modifiedCount, 0),
        );
      }
      prev = point;
    }

    po = Math.max(po, own.end);
    pm = Math.max(pm, other.end);
  }
  alignUnchanged(out, po + 1, totals.original, pm + 1, totals.modified, heightOf);
  return out;
}

/** 一段行区间的实测高度（`start > end` ⇒ 0）。 */
function rangeHeight(
  range: { start: number; end: number },
  side: DiffSide,
  heightOf: LineHeightOf,
): number {
  let sum = 0;
  for (let line = range.start; line <= range.end; line++) sum += heightOf(side, line);
  return sum;
}

/** 缝按 `afterLine` 合并（同一落点的两笔高度/行数相加，别让 DOM 里挤出两颗同位置的块）。 */
function pushGap(list: GapZone[], afterLine: number, height: number, lines = 0): void {
  if (!(height > 0)) return;
  const last = list[list.length - 1];
  if (last && last.afterLine === afterLine) {
    last.height += height;
    last.lines += lines;
  } else list.push({ afterLine, height, lines });
}

/**
 * 未改动区的逐行对齐：两侧同一「行序」的实测高度不等就补缝。
 *
 * 行数理论上是相等的（未改动区就是对齐器判为相同的那一摞）；真差出来时把多出来的部分
 * 如实补到另一侧，**不许静默丢掉** —— 丢掉一行，后面所有行就整体错开，而屏上没有任何
 * 迹象说明是从哪儿开始错的。
 */
function alignUnchanged(
  out: Record<DiffSide, GapZone[]>,
  oFrom: number,
  oTo: number,
  mFrom: number,
  mTo: number,
  heightOf: LineHeightOf,
): void {
  let o = oFrom;
  let m = mFrom;
  while (o <= oTo && m <= mTo) {
    const delta = heightOf("modified", m) - heightOf("original", o);
    if (delta > 0) pushGap(out.original, o, delta);
    else if (delta < 0) pushGap(out.modified, m, -delta);
    o++;
    m++;
  }
  for (; o <= oTo; o++) pushGap(out.modified, m - 1, heightOf("original", o));
  for (; m <= mTo; m++) pushGap(out.original, o - 1, heightOf("modified", m));
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
 * 这一臂的输入：块 + **本栏**的对齐缝 + 两侧的行内改动，一起从一颗读取口取。
 *
 * 与 `gutterDiff` 的 `baselineProvider` 同一手法：把「现在这批块 / 这些缝 / 这些行内区间
 * 是什么」留给持有两颗 view 的那一侧（surface），于是装饰层不必认识文档模型，也不需要每个
 * 写点记得派发。三者必须同一份来源：块表换了而缝还停在旧测量上，底色与占位块就会互相打架；
 * 行内区间若晚一拍，字符级标记就会短暂地落在新块的旧行号上。
 */
export interface DiffFaceSource {
  blocks: DiffBlock[];
  gaps: GapZone[];
  inner: InnerChanges;
}

const faceSource = Facet.define<() => DiffFaceSource, () => DiffFaceSource>({
  combine: (values) =>
    values[0] ?? (() => ({ blocks: [], gaps: [], inner: { original: [], modified: [] } })),
});

/**
 * 对侧的空位：一条**实测像素**高的块级 widget。
 *
 * ⚠️ 高度由 surface 量好后交进来，这里只写 inline px：CM6 那套行盒量度才是权威，样式段里
 * 写 `em` 或写数字都会跟着字阶复利 —— 两栏的逐行对齐立刻分家（`src/preview/` 那些块 widget
 * 栽过两次）。块级身份由装饰那颗 `block: true` 定（本版 CM6 的 `WidgetType` 没有 `block` 口，
 * 装饰 spec 是唯一入口），并且不许带竖向 margin（同一条文档）。
 *
 * ⚠️ 为什么不再在这里乘行高：一个文档行打开折行后是多个视觉行，`count × defaultLineHeight`
 * 只在「一文档行 = 一视觉行」时成立。VS Code 的 alignment view zone 存的是像素高度差
 * （`diffEditorViewZones.ts` 的 `originalHeightInPx` / `modifiedHeightInPx`），本实现同口径。
 *
 * ⚠️ 缺口行只有正文里的中性斜纹：VS Code 的 alignment view zone 在**侧排**模式下没有
 * `marginDomNode`（`diffEditorViewZones.ts` 只在 inline 模式才给 `gutter-delete /
 * gutter-insert` 的边注），斜纹本身也只是落在 view zone 的内容区里；行号槽那一列由
 * margin 自己盖住，上游从不在那里铺纹。CM6 的块级 widget 是 `.cm-content` 的直接子元素，
 * 天然只吃正文宽 —— 与上游同界，**不靠负偏移铺过 gutter**（那会把斜纹压到行号槽上）。
 *
 * 记号不在这个 widget 里画：缺口行不是文档行，CM6 的 gutter 里没有它的一格，而把它摆进
 * 内容区左缘（原先那条路）就会跟着正文横向滚走、也不在行号槽那一列上。CM6 的 gutter 对
 * **块 widget** 有专门的一格（`widgetMarker`，高度 = 块高），缺口记号因此由
 * `DiffGapSignMarker` 逐行补进记号槽 —— 与真行记号同一个 x，数量 = 缺行数。
 */
export class DiffGapWidget extends WidgetType {
  constructor(
    readonly height: number,
    readonly kind: "insert" | "delete",
    readonly lines: number,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof DiffGapWidget &&
      other.height === this.height &&
      other.kind === this.kind &&
      other.lines === this.lines
    );
  }

  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "diff-gap";
    el.style.height = `${this.height}px`;
    return el;
  }

  /** 占位块不吃点击也不吃光标：那里没有真行，选它与选相邻那行是两件事。 */
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * 缺口行在记号槽里的那些 `+` / `−`：一颗 marker 管一整段缺行，DOM 里是 `lines` 行。
 *
 * 为什么能落进 gutter：CM6 的 gutter 会给每个块 widget 单独一格（`GutterConfig.widgetMarker`，
 * 高度 / 顶边直接取块几何），所以这一格的竖向范围与正文里那段斜纹完全重合。行数按缺行数
 * 均分那一格，于是每一行都有一颗记号、x 与真行记号一致；`lines === 0`（纯折行高度差）不出。
 */
class DiffGapSignMarker extends GutterMarker {
  constructor(
    readonly kind: "insert" | "delete",
    readonly lines: number,
  ) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return (
      other instanceof DiffGapSignMarker && other.kind === this.kind && other.lines === this.lines
    );
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "diff-gap-signs";
    wrap.setAttribute("aria-hidden", "true");
    for (let i = 0; i < this.lines; i++) {
      const row = document.createElement("span");
      row.className = "diff-gap-sign-row";
      row.appendChild(signIcon(this.kind));
      wrap.appendChild(row);
    }
    return wrap;
  }

  toString(): string {
    return `gap-sign-${this.kind}-${this.lines}`;
  }
}

/**
 * 一批块誊成这一栏的装饰。
 *
 * 只做**行号 → 位置**的换算（含越界丢弃：块是按 provider 那份正文算的，本栏正文可能已经
 * 先动了一步），一行只发一条 `Decoration.line`。没有块头横条，也没有第三种「修改行」配色：
 * VS Code 的分侧语义就是原稿删、新稿增。
 */
function buildFace(
  doc: Text,
  side: DiffSide,
  blocks: DiffBlock[],
  gaps: GapZone[],
): RangeSet<Decoration> {
  const classes = new Map<number, string>();
  for (const m of sideLineMarks(blocks, side)) {
    if (m.line < 1 || m.line > doc.lines) continue;
    classes.set(
      m.line,
      m.whole ? `diff-line-${m.kind} diff-whole-${m.kind}` : `diff-line-${m.kind}`,
    );
  }

  const ranges: Range<Decoration>[] = [];
  for (const [line, cls] of classes) {
    ranges.push(Decoration.line({ class: cls }).range(doc.line(line).from));
  }
  for (const gap of gaps) {
    if (!(gap.height > 0)) continue;
    const after = Math.min(Math.max(gap.afterLine, 0), doc.lines);
    // 缺口落在哪一栏，记号就跟哪一栏的分侧语义走：原稿栏缺行 ⇒ `−`，新稿栏缺行 ⇒ `+`。
    const widget = new DiffGapWidget(
      gap.height,
      side === "original" ? "delete" : "insert",
      gap.lines,
    );
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

/**
 * 行号槽**右侧**的 `+` / `−` 记号（VS Code 的 `insert-sign` / `delete-sign`）。
 *
 * 层次照 VS Code 的 `EditorLayoutInfo`（`glyphMarginLeft` → `lineNumbersLeft` →
 * `decorationsLeft` → `contentLeft`）：记号走 `linesDecorationsClassName`，落在**行号与正文
 * 之间**，不是行号左边。CM6 的 gutter 按 DOM 次序排 ⇒ 本槽不许再写 `order: -1`。
 *
 * 行号槽本身另由 `DiffGutterMarker` 上色（上游的 `marginClassName`），两者同源于
 * `sideLineMarks` —— 底色、记号与正文行号因此永远落在同一批行上。
 */
class DiffSignMarker extends GutterMarker {
  constructor(readonly kind: "insert" | "delete") {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof DiffSignMarker && other.kind === this.kind;
  }

  toDOM(): HTMLElement {
    return signIcon(this.kind);
  }

  toString(): string {
    return `sign-${this.kind}`;
  }
}

const insertSign = new DiffSignMarker("insert");
const deleteSign = new DiffSignMarker("delete");

/**
 * 记号字形（行号槽与占位行共用）：VS Code 的记号是 Codicon（`diff-insert` → `add`、
 * `diff-remove` → `remove`，见 `registrations.contribution.ts`），不是手写的 `+` / `−`
 * 字符：字形、宽度与基线都归字体，11px 时才与行号同高且不抖。图标一律走 `CODICONS` 册。
 *
 * 直接把返回的 `<i class="codicon codicon-add">` 当元素：`CODICONS` 给的是整颗 `<i>`，
 * 套一层 span 会让 `.codicon` 的 `font: 16px/1 codicon` 抢在 `.diff-sign` 的 11px 前面
 * （`font` 简写在**内层**元素上，外层字号传不下去）。标记类因此加在这颗 `<i>` 上。
 */
function signIcon(kind: "insert" | "delete"): HTMLElement {
  const el = document.createElement("span");
  el.innerHTML = kind === "delete" ? CODICONS.remove : CODICONS.add;
  const icon = el.firstElementChild as HTMLElement;
  icon.classList.add("diff-sign", `diff-sign-${kind}`);
  return icon;
}

/** 这一栏的记号（与行底色同一份来源，越界丢弃口径同上）。 */
function buildSigns(doc: Text, side: DiffSide, blocks: DiffBlock[]): RangeSet<GutterMarker> {
  const ranges: Range<GutterMarker>[] = [];
  for (const m of sideLineMarks(blocks, side)) {
    if (m.line < 1 || m.line > doc.lines) continue;
    const marker = m.kind === "delete" ? deleteSign : insertSign;
    ranges.push(marker.range(doc.line(m.line).from));
  }
  return RangeSet.of(ranges, true);
}

/**
 * 行号槽（margin）的差异底色：上游 `line-insert` / `line-delete` 同时带
 * `marginClassName: 'gutter-insert' / 'gutter-delete'`（`registrations.contribution.ts`），
 * 也就是行号那一列跟着代码区一起上色。CM6 的 `lineNumberMarkers` 把 `elementClass`
 * 加在**整格**行号元素上，正好是这层 margin。
 */
class DiffGutterMarker extends GutterMarker {
  readonly elementClass: string;

  constructor(readonly kind: "insert" | "delete") {
    super();
    this.elementClass = `diff-gutter-${kind}`;
  }

  eq(other: GutterMarker): boolean {
    return other instanceof DiffGutterMarker && other.kind === this.kind;
  }

  toString(): string {
    return `gutter-${this.kind}`;
  }
}

const insertGutter = new DiffGutterMarker("insert");
const deleteGutter = new DiffGutterMarker("delete");

/** 行号槽底色（每行一格；缺口行没有文档行 ⇒ 不上色，与上游 view zone 一致）。 */
function buildGutters(doc: Text, side: DiffSide, blocks: DiffBlock[]): RangeSet<GutterMarker> {
  const ranges: Range<GutterMarker>[] = [];
  for (const m of sideLineMarks(blocks, side)) {
    if (m.line < 1 || m.line > doc.lines) continue;
    ranges.push((m.kind === "delete" ? deleteGutter : insertGutter).range(doc.line(m.line).from));
  }
  return RangeSet.of(ranges, true);
}

/** 装饰那一臂的四份画法：整行底色 + 记号槽字形 + 行号槽底色 + 行内字符差异。 */
interface FaceValue {
  lines: RangeSet<Decoration>;
  signs: RangeSet<GutterMarker>;
  gutters: RangeSet<GutterMarker>;
  chars: RangeSet<Decoration>;
}

function buildFaceValue(
  doc: Text,
  side: DiffSide,
  blocks: DiffBlock[],
  gaps: GapZone[],
  inner: InnerChanges,
): FaceValue {
  return {
    lines: buildFace(doc, side, blocks, gaps),
    signs: buildSigns(doc, side, blocks),
    gutters: buildGutters(doc, side, blocks),
    chars: buildInner(doc, side, inner[side]),
  };
}

/**
 * 行内字符级差异：整块字符 diff 的结果（`inline.ts`），两侧各标自己那侧。
 *
 * 纯增 / 纯删块由行级类 `diff-whole-*` 铺满整行（上游 `diffWholeLineAdd / Delete`），
 * 这里只处理两侧都有行的块：字符改动标成行内 mark，跨行改动的非末段补到右缘。
 *
 * 类名照上游的 `char-insert` / `char-delete`（`registrations.contribution.ts`），本项目的
 * 前缀是 `diff-char-*`（与 `diff-line-*` 同族）。装饰是**行内 mark**、不是整行线装饰：
 * `Decoration.mark` 落在文字上，底色只覆盖真正变了的那几个字符。
 *
 * 零长区间是上游的 `diff-range-empty`（`diffDeleteDecorationEmpty` / `diffAddDecorationEmpty`）：
 * 这一侧没有字符被改，但另一侧有，要在落点上画一根 3px 细条。CM6 的 mark 不渲染零长区间，
 * 所以走**行内 widget**（空 span + 边框），`side: 1` 让它落在该位置之后。
 * ⚠️ 越界丢弃、首尾夹到行长：块表可能比视图文档先动一步（换基线到 `setState` 之间）。
 */
function buildInner(doc: Text, side: DiffSide, ranges: InnerRange[]): RangeSet<Decoration> {
  const out: Range<Decoration>[] = [];
  if (ranges.length === 0) return RangeSet.empty;
  const cls = side === "original" ? "diff-char-delete" : "diff-char-insert";
  for (const r of ranges) {
    if (r.line < 1 || r.line > doc.lines) continue;
    const line = doc.line(r.line);
    const from = line.from + Math.min(Math.max(r.from, 0), line.length);
    const to = line.from + Math.min(Math.max(r.to, 0), line.length);
    if (to > from) {
      // 跨行改动的非末段要补到右缘（上游 `shouldFillLineOnLineBreak`）：mark 只覆盖字符，
      // 末尾那截空白与行程右缘之间由 `.diff-fill` 的 `::after` 续上。
      const klass = r.fill ? `${cls} diff-fill` : cls;
      out.push(Decoration.mark({ class: klass }).range(from, to));
    } else if (r.to === r.from) {
      // 上游的零长落点：这一侧没有字符被改，画一根 3px 细条。
      out.push(Decoration.widget({ widget: new EmptyRangeBar(cls), side: 1 }).range(from));
    }
    // 其余（越界夹取把真区间夹成零长）没有可画的东西，也不该冒出一根细条。
  }
  return RangeSet.of(out, true);
}

/** 上游 `diff-range-empty` 那根 3px 细条（样式在 `diff.css`，几何 0 宽 + 左边框）。 */
class EmptyRangeBar extends WidgetType {
  constructor(private readonly cls: string) {
    super();
  }
  eq(other: EmptyRangeBar): boolean {
    return other.cls === this.cls;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `${this.cls} diff-range-empty`;
    span.setAttribute("aria-hidden", "true");
    return span;
  }
}

const diffFaceField = StateField.define<FaceValue>({
  // 建 state 时按 provider 现算一次：这一臂只随差异标签而建，不像 `gutterDiffField`
  // 那样压在「每切一次标签都要过」的那条路上。
  create: (state) => {
    const src = state.facet(faceSource)();
    return buildFaceValue(state.doc, state.facet(faceSide), src.blocks, src.gaps, src.inner);
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(refreshDiff)) {
        const src = tr.state.facet(faceSource)();
        return buildFaceValue(
          tr.state.doc,
          tr.state.facet(faceSide),
          src.blocks,
          src.gaps,
          src.inner,
        );
      }
    }
    // 键入期：装饰跟着改动走，不重算（与 `gutterDiffField` 同一纪律）。
    return tr.docChanged
      ? {
          lines: value.lines.map(tr.changes),
          signs: value.signs.map(tr.changes),
          gutters: value.gutters.map(tr.changes),
          chars: value.chars.map(tr.changes),
        }
      : value;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.lines),
    EditorView.decorations.from(f, (v) => v.chars),
    // 行号槽底色吃同一份 `gutters`。依赖写 `f`（provide 的回调参数 = 本字段），
    // 不写外层变量名 —— 否则字段初始化自引用，TS 推不出类型。
    lineNumberMarkers.compute(
      [f],
      (state: EditorState): RangeSet<GutterMarker> => state.field(f).gutters,
    ),
  ],
});

/**
 * 一臂装饰：装在**某一栏**那颗 view 上，吃 `source()` 交出来的块与对齐缝，并且带着折叠的那一臂。
 *
 * 用法（预审 R1）：两颗 view 各装一臂、各自 `side`，由 `surface.ts` 在挂旁路那一刻通过自己
 * 创建的 `Compartment` 装上/拆掉。本文件不建 view、不认识文档模型，也**不排任何定时器**
 * （重画的时机归 surface，见 `refreshDiff` 那一段）。
 *
 * 折叠（Task 7）就骑在**同一臂**里：`diffFoldField` 的值由 `setFoldedRanges` 那一发写入，
 * 于是它进得了右栏那颗既有的 view，而不必再 `appendConfig` 一颗新槽 —— 那颗槽就是 Task 5
 * 抓过的「上一臂还活着」那一场病的病根（见 `surface.ts` 的 `rightFaceSlot` 注）。
 */
export function diffFace(side: DiffSide, source: () => DiffFaceSource): Extension {
  return [
    faceSide.of(side),
    faceSource.of(source),
    diffFaceField,
    diffFoldField,
    // 记号槽在 DOM 里排在行号之后（= 行号**右侧**），与 VS Code `EditorLayoutInfo` 的
    // decorationsLeft 同侧 ⇒ 不必为排序再拆一颗 Compartment，也不许写 `order` 往回挪。
    gutter({
      class: "cm-diffSigns",
      markers: (view) => view.state.field(diffFaceField, false)?.signs ?? RangeSet.empty,
      // 缺口行没有文档行 ⇒ 常规 `markers` 里排不进它的一格；CM6 对块 widget 另有
      // `widgetMarker`（格子高度/顶边取块几何），缺口记号因此与斜纹同高、同列。
      widgetMarker: (_view, widget) =>
        widget instanceof DiffGapWidget && widget.lines > 0
          ? new DiffGapSignMarker(widget.kind, widget.lines)
          : null,
    }),
  ];
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
/** 点折条上下 4px 揭示热区时，各揭示这么多行（上游 `revealLineCount` 默认 20）。 */
export const DIFF_REVEAL_LINES = 20;

/** 一段未改动行在本栏的位置（`run` = 它是第几段：首块之前 0，两块之间按前一块的序号，末块之后 = 块数）。 */
export interface UnchangedRun {
  run: number;
  start: number;
  end: number;
}

/**
 * 一段未改动区里**可折的部分**（`run` = 它是第几段：首块之前 0，两块之间按前一块的序号，
 * 末块之后 = 块数；`start`/`end` 含端点，本栏行轴）。
 *
 * `start`/`end` 已经按上游 `UnchangedRegion.fromDiffs` 的口径裁掉了贴边/中间的 context：
 * 靠近文件头/尾只保留**内侧**那一半 context（阈值 `context + minimum`），夹在两块之间才两端
 * 各留 context（阈值 `2 × context + minimum`）。整篇一字不差的那一段不产出候选。
 */
export interface FoldRange {
  run: number;
  start: number;
  end: number;
}

/**
 * 揭示量（照上游 `CollapsedCodeOverlayWidget` 的三条交互）：
 * 上下 4px 热区点一下 = 各揭示 `DIFF_REVEAL_LINES` 行，拖拽 = 连续揭示，中间双击/图标 = 全开。
 */
export type FoldReveal =
  { above: number } | { below: number } | { all: true } | { top: number } | { bottom: number };

/**
 * 折起来的行在臂里的形态（本栏行轴的行号 + 揭示记账）。
 *
 * `regionLength` 是候选区总行数（未揭示前的整段），widget 靠它算 `maxTop = regionLength - bottom`
 * / `maxBottom = regionLength - top`（上游 `getMaxVisibleLineCountTop/Bottom` 同口径）。
 */
export interface FoldPoint {
  from: number;
  to: number;
  top: number;
  bottom: number;
  regionLength: number;
}

/** 发进某一臂的折叠态（行号 + 揭示量：段序号是 surface 那一侧的记账口径，装饰层不认）。 */
export const setFoldedRanges = StateEffect.define<FoldPoint[]>();

/**
 * 折条被操作（**每一栏一条**：臂里带上的是那一栏自己的回调）。
 *
 * 为什么交回调用而不是让 widget 自己发 `setFoldedRanges`：折起来的是哪些段、已经揭示了几行
 * 只有 surface 知道（它的开关状态 + 每段的揭示记账才是那一份真相）。装饰层自己改一段就等于
 * 第二份真相 —— 下一发 `syncBlocks` 按 surface 那份清单重发，改过的那一段立刻又折回来。
 */
const faceFoldClick = Facet.define<
  (from: number, reveal: FoldReveal) => void,
  ((from: number, reveal: FoldReveal) => void) | null
>({
  combine: (values) => values[0] ?? null,
});

/** 挂上「折条被操作」的出口（与两臂一起进 state；拆臂就没了）。 */
export function onFoldBarClick(fn: (from: number, reveal: FoldReveal) => void): Extension {
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
 * 折叠候选（本栏行轴）：照上游 `UnchangedRegion.fromDiffs` 的构造规则算**可折区**。
 *
 *   · 贴文件头/尾的未改动段：长度 ≥ `DIFF_CONTEXT_LINES + DIFF_MIN_UNCHANGED_LINES`
 *     ⇒ 只裁掉内侧那一半 context（头段留底 3 行可见、尾段留顶 3 行可见）。
 *   · 夹在两块之间的段：长度 ≥ `2 × DIFF_CONTEXT_LINES + DIFF_MIN_UNCHANGED_LINES`
 *     ⇒ 两端各留 context。
 *   · 整篇一字不差（唯一一段覆盖全文）⇒ 上游在 `hideUnchangedRegionsFeature` 里把这一份
 *     regions 直接清空（不出折条），这里同样不产出候选。
 *
 * 两侧的**段长天然相等**（两块之间的那些行是配对了的相同行），所以「够不够长」这一问不分栏；
 * 分栏的是**行号**（两块之间一旦有长短不等的块，两栏的行轴就错开）⇒ 候选与折区必须按 `side`
 * 各换算一份，不许只算右栏。
 */
export function foldCandidates(
  blocks: DiffBlock[],
  side: DiffSide,
  lineCounts: Record<DiffSide, number>,
): FoldRange[] {
  // 整篇一字不差 ⇒ 上游把唯一覆盖全文的 region 清空（不出折条）
  if (blocks.length === 0) return [];
  const other: DiffSide = side === "original" ? "modified" : "original";
  const runs = unchangedRuns(blocks, side, lineCounts[side]);
  // 贴边判定要看**两栏**（上游 `atStart = origStart === 1 && modStart === 1`；一侧贴边、
  // 另一侧因为对侧多出几行而不贴，那一段仍要按「不贴边」裁法留两端 context）。
  const mirrors = unchangedRuns(blocks, other, lineCounts[other]);
  const mirrorOf = new Map(mirrors.map((r) => [r.run, r]));
  const out: FoldRange[] = [];
  for (const run of runs) {
    // 键入之后、重算之前，块表与两栏正文可以是不同一代的：那一小段里对侧同一段可能算不出来
    //（空段被 `unchangedRuns` 跳过）⇒ 退回本栏那一段，别让一次点击撞成 TypeError。
    const mirror = mirrorOf.get(run.run) ?? run;
    const length = run.end - run.start + 1;
    const atStart = run.start === 1 && mirror.start === 1;
    const atEnd = run.end === lineCounts[side] && mirror.end === lineCounts[other];
    let start = run.start;
    let keep = length;
    if ((atStart || atEnd) && length >= DIFF_CONTEXT_LINES + DIFF_MIN_UNCHANGED_LINES) {
      // 只有一端贴边：裁掉贴边那一侧的 context（顶/底留白本来就贴边可见，不必再留）
      if (atEnd) {
        start += DIFF_CONTEXT_LINES;
        keep -= DIFF_CONTEXT_LINES;
      } else {
        keep -= DIFF_CONTEXT_LINES;
      }
    } else if (length >= 2 * DIFF_CONTEXT_LINES + DIFF_MIN_UNCHANGED_LINES) {
      start += DIFF_CONTEXT_LINES;
      keep -= 2 * DIFF_CONTEXT_LINES;
    } else {
      continue;
    }
    if (keep <= 0) continue;
    out.push({ run: run.run, start, end: start + keep - 1 });
  }
  return out;
}

/**
 * 折起来的那一段之上的**占位条**：24px 高（上游 `PlaceholderViewZone(d, 24)`），
 * 上下各 4px 揭示热区、中间一行说明文案（上游 `.diff-hidden-lines .center` 同结构）。
 *
 * 它由一条 `Decoration.replace({ block: true })` **替掉**被折掉的整段行（见 `buildFoldFace`），
 * 所以块高只由这条占位条自己定 —— 不是被折掉那 N 行的高度。
 *
 * ⚠️ 高度写 inline（与 `DiffGapWidget` 同一条纪律 R15/R18）：样式段里不许出现 `height` / `em` /
 * 竖向 margin —— 两栏各折同样多的行，折条也各占 24px，逐行对齐才不塌。
 *
 * 三条交互照上游 `CollapsedCodeOverlayWidget`：
 *   · 上/下 4px 热区：点一下 = 各揭示 `DIFF_REVEAL_LINES` 行；按住拖动 = 按行高连续揭示
 *     （上区 `clamp(cur + round(dy/lh), 0, regionLength - bottom)`、下区反向）；
 *   · 中间双击 / 展开图标单击 = 全开（上游 `showAll`）；
 *   · 全开之后这一条不再存在（上游 `shouldHideControls`），重新折叠入口在工具栏那颗动作上。
 */
export class DiffFoldWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly top: number,
    readonly bottom: number,
    readonly regionLength: number,
    readonly onReveal: ((from: number, reveal: FoldReveal) => void) | null,
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
      other.top === this.top &&
      other.bottom === this.bottom &&
      other.regionLength === this.regionLength &&
      other.onReveal === this.onReveal
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = "diff-fold-bar";
    el.style.height = "24px";
    const emit = (reveal: FoldReveal): void => this.onReveal?.(this.from, reveal);

    const top = document.createElement("div");
    top.className = "diff-fold-top";
    top.setAttribute("data-tip", "单击或拖动以在上方显示更多内容");

    const bottom = document.createElement("div");
    bottom.className = "diff-fold-bottom";
    bottom.setAttribute("data-tip", "单击或拖动以在下方显示更多内容");

    const center = document.createElement("div");
    center.className = "diff-fold-center";
    const action = document.createElement("a");
    action.className = "diff-fold-unfold";
    action.setAttribute("role", "button");
    action.setAttribute("aria-label", "展开全部未改动行");
    action.setAttribute("data-tip", "展开全部未改动行");
    action.innerHTML = CODICONS.unfold;
    const glyph = action.firstElementChild as HTMLElement | null;
    if (glyph) glyph.classList.add("diff-fold-icon");
    const label = document.createElement("span");
    label.className = "diff-fold-text";
    label.textContent = `${this.hidden} 行未改动`;
    center.append(action, label);

    // 上下热区共用一套拖拽口径；`cur` 取按下那一刻的揭示量（拖拽中自己算增量，不回头读 DOM）。
    const draggable = (strip: HTMLElement, dir: "top" | "bottom"): void => {
      strip.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        strip.classList.add("is-dragging");
        const startY = event.clientY;
        const cur = dir === "top" ? this.top : this.bottom;
        const maxTop = this.regionLength - this.bottom;
        const maxBottom = this.regionLength - this.top;
        const lineHeight = Math.max(1, view.defaultLineHeight);
        let moved = false;
        const onMove = (e: MouseEvent): void => {
          const dy = e.clientY - startY;
          if (Math.abs(dy) > 2) moved = true;
          const delta = Math.round(dy / lineHeight);
          if (dir === "top") emit({ top: Math.min(Math.max(cur + delta, 0), maxTop) });
          else emit({ bottom: Math.min(Math.max(cur - delta, 0), maxBottom) });
        };
        const onUp = (): void => {
          strip.classList.remove("is-dragging");
          win.removeEventListener("mousemove", onMove);
          if (!moved)
            emit(dir === "top" ? { above: DIFF_REVEAL_LINES } : { below: DIFF_REVEAL_LINES });
        };
        const win = view.dom.ownerDocument.defaultView ?? window;
        win.addEventListener("mousemove", onMove);
        win.addEventListener("mouseup", onUp, { once: true });
      });
    };
    draggable(top, "top");
    draggable(bottom, "bottom");

    action.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      emit({ all: true });
    });
    center.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      emit({ all: true });
    });

    el.append(top, center, bottom);
    return el;
  }

  /**
   * 编辑器**别碰**折条上的任何事件（`WidgetType.ignoreEvent` 返回 true = 编辑器忽略）：
   * 点它不该把插入符搬进被折起来的那几行里（搬进去会被「光标落进折区就展开」那条守卫
   * 当成用户要去那一行，于是整段被展开），也不该起选区拖拽。揭示/拖拽都由本 widget 自己的
   * DOM 监听处理，与编辑器的派发无关。
   */
  ignoreEvent(): boolean {
    return true;
  }
}

/** 夹到本栏真实存在的行号（块是按 provider 那份正文算的，本栏正文可能先动了一步）。 */
function clampLine(line: number, totalLines: number): number {
  return Math.min(Math.max(line, 1), totalLines);
}

/**
 * 折区 → **一条替换装饰**：被折掉的整段行交给折条替掉。
 *
 * 照 CM6 的正规折叠口径用 `Decoration.replace({ block: true })`（`@codemirror/language` 的
 * 折叠也是 `Decoration.replace`，只是不带 block、折条留在首行行内）。
 *
 * ⚠️ 为什么不是「折条 widget + 逐行 `Decoration.line { display: none }`」（原先那条补丁）：
 * CSS 把行抹成 0 高，但 CM6 的块几何与行号槽仍按原行高记账 ⇒ 折条占掉一行、行号槽里却没有
 * 对应的一格，折区之后的记号/行号整体错一行 ——「折叠后 ± 看不到」就是这一路的症状。
 * 替换装饰把「哪几行不存在」交给 CM6：块表、行号槽、选区和光标用的是同一份几何，不会再错位。
 * 上游折叠块本身就是一条 view zone 盖住被折区间，这里同口径。
 */
function buildFoldFace(
  doc: Text,
  folds: readonly FoldPoint[],
  onReveal: ((from: number, reveal: FoldReveal) => void) | null,
): RangeSet<Decoration> {
  const ranges: Range<Decoration>[] = [];
  for (const fold of folds) {
    const from = clampLine(fold.from, doc.lines);
    const to = clampLine(fold.to, doc.lines);
    if (from > to) continue;
    // 折条恒发（出口没挂上时点下去是空转）：折叠态是**看得见的状态**，不该因为没人接就把
    // 那几行抹掉却连条都不留。
    ranges.push(
      Decoration.replace({
        widget: new DiffFoldWidget(
          from,
          to,
          fold.top,
          fold.bottom,
          Math.max(fold.regionLength, to - from + 1),
          onReveal,
        ),
        block: true,
      }).range(doc.line(from).from, doc.line(to).to),
    );
  }
  return Decoration.set(ranges, true);
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
    if (from <= to) out.push({ ...fold, from, to });
  }
  return out;
}

/**
 * 折叠态那一臂的值：**清单**（行号）加上**由它算出来的画法**。
 *
 * ⚠️ 画法只在 `setFoldedRanges` 那一发里重建（修复轮 Important 3）：`buildFoldFace` 每段折区
 * 分配一条替换装饰（外加一颗 widget），拿它当 `compute([f, "doc"])` 的函数体就等于
 * **每次文档变化都重建全部折条**，而 Tier A 是活着的编辑面 —— 与本文件头「键入期不重算
 * （只 `value.map(tr.changes)`）」那条纪律直接对冲。键入期两份一起交给映射：清单按行号换算
 * （`mapFolds`，几笔），替换装饰由 CM6 映射（不重新分配），于是折条上那份行号清单与它替掉的
 * 那几行的行数要等下一次点名才跟着新块表走（已知限制）。
 */
interface FoldFace {
  folds: FoldPoint[];
  decorations: RangeSet<Decoration>;
}

/** 一份都没有 = 一段都没折（建 state 与拆臂之后都是这一份）。 */
const emptyFoldFace: FoldFace = { folds: [], decorations: RangeSet.empty };

/** 清单 → 画法（只在点名那一发跑：这一发是 O(折区数) 的分配）。 */
function foldFaceOf(
  doc: Text,
  folds: readonly FoldPoint[],
  onReveal: ((from: number, reveal: FoldReveal) => void) | null,
): FoldFace {
  return {
    folds: folds.map((fold) => ({ ...fold })),
    decorations: buildFoldFace(doc, folds, onReveal),
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
      decorations: value.decorations.map(tr.changes),
    };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
});

/**
 * 某一栏**现在真的画着**哪几段折区（本栏行轴，跟着改动映射过 ⇒ 与屏幕同一份）。
 *
 * surface 查「光标掉进被替换掉的那几行没有」必须读这一份，而不是按候选清单现算：
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

// @vitest-environment jsdom
// B461 · Task 3 —— 两侧的行底色、中间指示带与对侧占位块（`src/diff/face.ts`）。
//
// 设计稿 ⑥：改动行画底色（复用三颗主题无关的 token）、删除行在右栏用占位块、左栏用真行 ——
// **两侧必须行行对齐**，否则跳块与肉眼比对都会错位。
//
// 本文件的分层（与 face.ts 的责任一一对应）：
//   1) 纯函数 `sideLineMarks` / `sideGaps`：一块（`DiffBlock`）在**某一栏**落在哪些行、
//      要在第几行之后补几行空位。它们只遍历 `blocks.ts` 交出来的块 ⇒ 与 4px 标注同源，
//      这一层不看 DOM、不看 view，向量直接钉死。
//   2) 装到 view 上的那一臂（`diffFace`）：行装饰 + 块 widget + 记号 + 行号槽底色。
//   3) 样式段（`src/diff/diff.css`）：行底色 / 字符底色取上游 `editorColors.ts` 的默认值
//      （分侧语义没有「修改行」），概览色带另吃 `--diff-add` / `--diff-del`；
//      这一段里一个裸十六进制都不许出现。
//
// ⚠️ **像素**类判据（同一行在两栏的视觉 y 是否真的一致）不在这里：jsdom 没有布局引擎，
// `view.defaultLineHeight`（CM6 的真取值口，`node_modules/@codemirror/view/dist/index.d.ts:1072`）
// 在那里量出来恒为 0 ⇒ 简报里 `getBoundingClientRect().height > 0` 那条在无布局环境**不可能**绿。
// 这一层能钉的是「占位块**写了**多高」：把行高桩成一个已知的数（20），两行空位就得写成 40px ——
// 判的是 widget 写下的那道声明，不是在测试里再推一遍公式。真机上的像素归 Task 11 那台。
import { readFileSync } from "node:fs";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { BlockType, EditorView, type BlockInfo, type WidgetType } from "@codemirror/view";
import { createEditor, makeTabState } from "../src/editor/editor";
import { perfProfileFor } from "../src/editor/perf";
import { stripCssComments, stripLineComments, ruleBlock } from "./static";
import { isWrap, setIsWrap, tabs, type Panel, type Tab } from "../src/core/app-state";
import { createDiffSurface, type DiffSurface } from "../src/diff/surface";
import { diffBlocks, type DiffBlock, type LineAlignment } from "../src/diff/blocks";
import type { InnerChanges } from "../src/diff/inline";
import type { DiffSide, DiffSpec } from "../src/diff/model";
import { DIFF_REFRESH_MS } from "../src/diff/align";
import {
  DIFF_CONTEXT_LINES,
  DIFF_MIN_UNCHANGED_LINES,
  DiffFoldWidget,
  DiffGapWidget,
  diffFace,
  foldCandidates,
  foldGaps,
  foldMarksIn,
  foldedRangesIn,
  gapZones,
  refreshDiff,
  setFoldedRanges,
  sideLineMarks,
  type GapZone,
} from "../src/diff/face";

const srcOf = (p: string): string => readFileSync(p, "utf-8").replace(/\r\n/g, "\n");

/** 删两行：左栏第 2、3 行是删掉的行，右栏得在那之后补出两行空位。 */
const del = diffBlocks("A\n删1\n删2\nZ", "A\nZ");

/** jsdom 里把 CM6 的行高桩成这个数（真取值口是 `view.defaultLineHeight`，无布局时恒为 0）。 */
const LINE_HEIGHT = 20;

/**
 * 单测里的「实测行高」：那一行就是 `LINE_HEIGHT`。
 *
 * 真实现由 surface 把两栏 view 的行盒喂进 `gapZones`；这里只钉纯函数的分配口径，
 * 所以行高是一颗常量。折行那一路的向量另外直接给「某一行 = 多个视觉行」的高度表。
 */
const uniformHeight = (): number => LINE_HEIGHT;

/**
 * 只算 **这一侧** 的缝（不经 surface）。
 *
 * `gapZones` 要两侧总行数才能给尾段收口；单侧现场只知道自己这份文档有多少行，
 * 另一侧按「未改动段两侧行数相等」反推：`对侧末块行号 + (本侧总行数 - 本侧末块行号)`。
 * 与生产的 `LineTotals` 同一口径，只是另一侧的数字由块表推出来。
 */
function zonesOf(
  blocks: DiffBlock[],
  side: DiffSide,
  docLines: number,
  alignments: LineAlignment[][] = [],
): GapZone[] {
  const otherSide: DiffSide = side === "original" ? "modified" : "original";
  const endOf = (b: DiffBlock, s: DiffSide): number =>
    s === "original" ? b.originalEnd : b.modifiedEnd;
  const last = blocks[blocks.length - 1];
  const ownEnd = last ? endOf(last, side) : 0;
  const otherEnd = last ? endOf(last, otherSide) : 0;
  const otherLines = Math.max(otherEnd + (docLines - ownEnd), otherEnd, 0);
  const totals =
    side === "original"
      ? { original: docLines, modified: otherLines }
      : { original: otherLines, modified: docLines };
  const perBlock = alignments.length === blocks.length ? alignments : blocks.map(() => []);
  return gapZones(blocks, totals, uniformHeight, perBlock)[side];
}

describe("B461 · sideLineMarks / gapZones：一块在两栏各落在哪些行", () => {
  it("B461 · 删除块：左栏标真行，右栏在 A 之后补 2 行空位", () => {
    expect(sideLineMarks(del, "original")).toEqual([
      { line: 2, kind: "delete", whole: true },
      { line: 3, kind: "delete", whole: true },
    ]);
    expect(sideLineMarks(del, "modified")).toEqual([]);
    expect(zonesOf(del, "modified", 2)).toEqual([{ afterLine: 1, height: 2 * LINE_HEIGHT }]);
    expect(zonesOf(del, "original", 4)).toEqual([]);
  });

  it("B461 · 新增块反过来：右栏标行、左栏补空位", () => {
    const ins = diffBlocks("A\nZ", "A\n新1\n新2\nZ");
    expect(sideLineMarks(ins, "modified").map((m) => m.line)).toEqual([2, 3]);
    expect(zonesOf(ins, "original", 2)).toEqual([{ afterLine: 1, height: 2 * LINE_HEIGHT }]);
  });

  it("B462 · 混合区按 VS Code 分侧：左栏全算删除、右栏全算新增（没有第三种 modify 行）", () => {
    // 基线 [丙一去, 丙一去, 丁后行] vs 当前 [丙一去, 丁后行改了]
    // head=1；中段无 LCS 锚点 ⇒ 一个区 (aLen 2, bLen 1)；字符 diff 的起止都在行首/行尾
    // ⇒ 没有块内边界，整块一段：左 2 行 vs 右 1 行，缺的那行补在右栏块尾。
    const mixed = diffBlocks("丙一去\n丙一去\n丁后行", "丙一去\n丁后行改了");
    expect(zonesOf(mixed, "modified", 2)).toEqual([{ afterLine: 2, height: LINE_HEIGHT }]);
    expect(sideLineMarks(mixed, "original"), "改 = 先删：左栏两行都是删除色").toEqual([
      { line: 2, kind: "delete", whole: false },
      { line: 3, kind: "delete", whole: false },
    ]);
    expect(sideLineMarks(mixed, "modified"), "改 = 再增：右栏这一行是新增色").toEqual([
      { line: 2, kind: "insert", whole: false },
    ]);
  });

  it("B462 · 改块两侧行数不同 ⇒ 缺的行整段补在块尾，按 afterLine 升序", () => {
    // 基线 [A, x, B中, y, C] vs 当前 [A, B改了, C]：改块左侧 3 行 vs 右侧 1 行，
    // 字符 diff 没有行内边界 ⇒ 整块一段，缺的 2 行补在右栏块尾（第 2 行之后）。
    const both = diffBlocks("A\nx\nB中\ny\nC", "A\nB改了\nC");
    expect(sideLineMarks(both, "original")).toEqual([
      { line: 2, kind: "delete", whole: false },
      { line: 3, kind: "delete", whole: false },
      { line: 4, kind: "delete", whole: false },
    ]);
    expect(sideLineMarks(both, "modified")).toEqual([{ line: 2, kind: "insert", whole: false }]);
    expect(zonesOf(both, "modified", 3)).toEqual([{ afterLine: 2, height: 2 * LINE_HEIGHT }]);
    // 多的一侧（左栏）自己不必补位
    expect(zonesOf(both, "original", 5)).toEqual([]);
  });

  it("B462 · 当前比基线长的改块：左栏按同样的口径补位（缝在配对窗口之后）", () => {
    const grow = diffBlocks("A\nB\nC", "A\nB1\nB2\nC");
    expect(sideLineMarks(grow, "original")).toEqual([{ line: 2, kind: "delete", whole: false }]);
    expect(sideLineMarks(grow, "modified")).toEqual([
      { line: 2, kind: "insert", whole: false },
      { line: 3, kind: "insert", whole: false },
    ]);
    expect(zonesOf(grow, "original", 3)).toEqual([{ afterLine: 2, height: LINE_HEIGHT }]);
    expect(zonesOf(grow, "modified", 4)).toEqual([]);
  });

  it("B462 · 折行：缝高按实测像素，不按行数乘默认行高", () => {
    const wrapDel = diffBlocks("A\nB\nC", "A\nC");
    // 左栏第 2 行折成两个视觉行（2 × 行高），右栏在同高度上只有一行。
    const heightOf = (side: DiffSide, line: number): number =>
      side === "original" && line === 2 ? 2 * LINE_HEIGHT : LINE_HEIGHT;
    expect(gapZones(wrapDel, { original: 3, modified: 2 }, heightOf, [[]]).modified).toEqual([
      { afterLine: 1, height: 2 * LINE_HEIGHT },
    ]);
  });

  it("B462 · 未改动区也逐行对齐：两栏宽度不同，同一行折出的视觉行数不等就补缝", () => {
    // 两侧正文一致（没有差异块），左栏第 2 行折成两个视觉行。
    const same = diffBlocks("A\nB\nC", "A\nB\nC");
    const heightOf = (side: DiffSide, line: number): number =>
      side === "original" && line === 2 ? 2 * LINE_HEIGHT : LINE_HEIGHT;
    const zones = gapZones(same, { original: 3, modified: 3 }, heightOf, []);
    expect(zones.original).toEqual([]);
    expect(zones.modified).toEqual([{ afterLine: 2, height: LINE_HEIGHT }]);
  });

  it("B463 · 块内对齐边界把块切成若干段，每段比两侧实测总高（含折行差与缺行数）", () => {
    // 左 4 行（2..5）vs 右 3 行（2..4）；字符 diff 反推的边界在第 3 行 ↔ 第 3 行。
    // 段 1 = 左2↔右2（等高）；段 2 = 左3..5 ↔ 右3..4：左 3 折成两个视觉行（40）、另两行各 20，
    // 右两行各 20 ⇒ 左多 40，补到右栏（缝在第 4 行之后），缺 1 行。
    const b: DiffBlock = {
      kind: "modify",
      originalStart: 2,
      originalEnd: 5,
      modifiedStart: 2,
      modifiedEnd: 4,
      added: 0,
      removed: 1,
    };
    const heightOf = (side: DiffSide, line: number): number =>
      side === "original" && line === 3 ? 2 * LINE_HEIGHT : LINE_HEIGHT;
    const zones = gapZones([b], { original: 6, modified: 5 }, heightOf, [
      [{ originalLine: 3, modifiedLine: 3 }],
    ]);
    expect(zones.modified, "左 3 的折行差 + 左 5 的缺行，合并落在第 4 行之后").toEqual([
      { afterLine: 4, height: 2 * LINE_HEIGHT },
    ]);
    expect(zones.original, "多的一侧自己不补位").toEqual([]);
  });

  it("B463 · 右栏是长的一侧：边界之后的段把高差补到左栏", () => {
    // 段 1 = 左2 ↔ 右2..3（右两行各 20），左 20 ⇒ 补 20（缺 1 行）到左栏；
    // 段 2 = 左3 ↔ 右4（右第 4 行折成 40、左 20）⇒ 再补 20（只有折行差，缺行数 0）。
    const b: DiffBlock = {
      kind: "modify",
      originalStart: 2,
      originalEnd: 3,
      modifiedStart: 2,
      modifiedEnd: 4,
      added: 1,
      removed: 0,
    };
    const heightOf = (side: DiffSide, line: number): number =>
      side === "modified" && line === 4 ? 2 * LINE_HEIGHT : LINE_HEIGHT;
    const zones = gapZones([b], { original: 4, modified: 5 }, heightOf, [
      [{ originalLine: 3, modifiedLine: 4 }],
    ]);
    expect(zones.original).toEqual([
      { afterLine: 2, height: LINE_HEIGHT },
      { afterLine: 3, height: LINE_HEIGHT },
    ]);
    expect(zones.modified).toEqual([]);
  });

  it("B464 · 填充后两侧总高一致：缝把折行差与缺行一起补齐（等高的验收口径）", () => {
    // 左 4 行（2..5）vs 右 3 行（2..4）；左第 3 行折成两个视觉行；边界在第 3 行 ↔ 第 3 行。
    const b: DiffBlock = {
      kind: "modify",
      originalStart: 2,
      originalEnd: 5,
      modifiedStart: 2,
      modifiedEnd: 4,
      added: 0,
      removed: 1,
    };
    const heightOf = (side: DiffSide, line: number): number =>
      side === "original" && line === 3 ? 2 * LINE_HEIGHT : LINE_HEIGHT;
    const totals = { original: 6, modified: 5 };
    const zones = gapZones([b], totals, heightOf, [[{ originalLine: 3, modifiedLine: 3 }]]);
    const total = (side: DiffSide): number => {
      let h = 0;
      for (let line = 1; line <= totals[side]; line++) h += heightOf(side, line);
      for (const z of zones[side]) h += z.height;
      return h;
    };
    expect(total("original"), "左栏的实际显示高度").toBe(total("modified"));
  });
});

describe("B473 · foldGaps：落进折区的缝挪到折条之后", () => {
  const gap = (afterLine: number, height: number): GapZone => ({ afterLine, height });

  it("折区内的缝挪到折区后沿，折区外的不动", () => {
    expect(foldGaps([gap(2, 20), gap(4, 10), gap(5, 30), gap(9, 5)], [{ from: 3, to: 6 }])).toEqual(
      [gap(2, 20), gap(6, 40), gap(9, 5)],
    );
  });

  it("折区后沿原本就有缝 ⇒ 两笔并成一条（不许同落点两条）", () => {
    expect(foldGaps([gap(4, 10), gap(6, 7)], [{ from: 3, to: 6 }])).toEqual([gap(6, 17)]);
  });

  it("没有折区时原样返回（反复重算不改计划，`sameGapPlans` 才判得平）", () => {
    const gaps = [gap(2, 20), gap(4, 10)];
    expect(foldGaps(gaps, [])).toBe(gaps);
  });
});

// --------------------------------------------------------------------------- #
// Step 3：装到 view 上的那一臂（`diffFace`）
// --------------------------------------------------------------------------- #

/**
 * 现场清单：用例结束统一拆。
 *
 * ⚠️ 必须 `destroy` / `dispose`，不能只把 `document.body` 清空就完事：装进 view 的那一臂
 * 与 surface 的防抖计时器都靠拆这一手收口（R24 之后**只有 surface 那一颗**定时器；原先
 * `face.ts` 在自己那一臂里还藏着一颗，插件不 destroy 就没人取消它，下一发会打在已经作废的
 * 视图上 —— 那一颗已随 R24 摘掉，这条纪律留着是因为拆现场这件事本身没变）。
 */
const live: Array<() => void> = [];

beforeEach(() => {
  // R18：把行高桩成一个已知的数。CM6 把 `toDOM(view)` 收到的那颗 view 交给 widget，
  // 所以桩在原型 getter 上，widget 写进 DOM 的那道高度就**可判**了
  // （jsdom 自己量出来恒为 0：那环境没有布局引擎，`view.defaultLineHeight` 也读不出东西）。
  vi.spyOn(EditorView.prototype, "defaultLineHeight", "get").mockReturnValue(LINE_HEIGHT);
  document.body.innerHTML = "";
  tabs.clear();
});

afterEach(() => {
  for (const stop of live.splice(0)) stop();
  vi.restoreAllMocks();
});

const lineElOf = (view: EditorView, n: number): HTMLElement =>
  view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")[n - 1];

const gapElsOf = (view: EditorView): HTMLElement[] => [
  ...view.contentDOM.querySelectorAll<HTMLElement>(".diff-gap"),
];

/**
 * 从 DOM 那一侧反查 CM6 摆在某一行的块 widget。
 *
 * 公开口是 `view.lineBlockAt(pos)`：那一行被块 widget 切成几块，`type` 就是那几块
 * （实测 `[文本行, 块 widget]`，后一块的 `widget` 才是装进 DOM 的那个实例）。
 * 为什么要反查而不是 `new DiffGapWidget(2)` 直接判：R18 要钉的是「**装在这一臂里的那块**
 * 是块 widget、不吃事件」，凭空 new 一个出来判，装错地方也能绿。
 */
function firstBlockWidget(view: EditorView): { widget: WidgetType; block: BlockInfo } | null {
  const { doc } = view.state;
  for (let line = 1; line <= doc.lines; line++) {
    const blocks = view.lineBlockAt(doc.line(line).to);
    for (const part of (Array.isArray(blocks.type) ? blocks.type : [blocks]) as BlockInfo[]) {
      if (part.widget) return { widget: part.widget, block: part };
    }
  }
  return null;
}

/** 同上，但只认折条：折区之前可能先有占位块（`DiffGapWidget`），按「第一颗块 widget」取会拿错。 */
function firstFoldWidget(view: EditorView): { widget: WidgetType; block: BlockInfo } | null {
  const { doc } = view.state;
  for (let line = 1; line <= doc.lines; line++) {
    const blocks = view.lineBlockAt(doc.line(line).to);
    for (const part of (Array.isArray(blocks.type) ? blocks.type : [blocks]) as BlockInfo[]) {
      if (part.widget instanceof DiffFoldWidget) return { widget: part.widget, block: part };
    }
  }
  return null;
}

/** 正文子节点的可见次序（`line` = 真行，`gap` = 占位块）—— 占位块落在哪一行之间靠它判。 */
const rowOrder = (view: EditorView): string[] =>
  [...view.contentDOM.children].map((el) => (el.classList.contains("diff-gap") ? "gap" : "line"));

/**
 * 这一颗 state 到底装没装折行（R19 的判据）。
 *
 * 判的是 **state facet**，不是 `view.lineWrapping` 那颗 getter —— 后者读的是量出来的
 * `white-space`（`heightOracle`），jsdom 没有布局引擎 ⇒ 恒为「没折行」，绿与不绿都不说明问题。
 * `EditorView.lineWrapping` 的实际落点是 contentAttributes 上那颗类名（CM6 自己也是这么猜的），
 * 于是「扩展在不在 state 里」这件事在 jsdom 里是**看得到**的 —— 看得到的恰恰是要钉的那件事：
 * 一个文档行是否只对应一个视觉行。像素级的两栏等高仍归 Task 11 真机台。
 */
const wrapsLines = (state: EditorState): boolean =>
  state
    .facet(EditorView.contentAttributes)
    .some((attr) => typeof attr !== "function" && attr.class === "cm-lineWrapping");

/**
 * 单独装一臂的最小现场（不经 surface）：`blocks` 给数组或读取口都行。
 *
 * 默认正文按 `del` 那一对喂（简报 Step 3 的 `mountFace("modified", del)` 就是这个形状）；
 * 换别的块时把第三参显式传进来。
 */
function mountFace(
  side: DiffSide,
  blocks: DiffBlock[] | (() => DiffBlock[]),
  doc = side === "modified" ? "A\nZ" : "A\n删1\n删2\nZ",
  inner: InnerChanges = { original: [], modified: [] },
): { view: EditorView; lineEl: (n: number) => HTMLElement; gapEls: () => HTMLElement[] } {
  const provider = typeof blocks === "function" ? blocks : () => blocks;
  let view: EditorView | null = null;
  // 缝与块同一颗读取口（生产里由 surface 交出来）；这里按固定行高现算，
  // 于是「refreshDiff 之后重算」测的仍是同一份输入口径。
  // 行数取**当前**文档（键入之后块表按新文档重算），首建时 view 还没赋值，退回初始行数。
  const source = () => {
    const list = provider();
    const lines = view ? view.state.doc.lines : doc.split("\n").length;
    return { blocks: list, gaps: zonesOf(list, side, lines), inner };
  };
  view = new EditorView({
    state: EditorState.create({ doc, extensions: [diffFace(side, source)] }),
    parent: document.body,
  });
  const created = view;
  live.push(() => created.destroy());
  return { view: created, lineEl: (n) => lineElOf(created, n), gapEls: () => gapElsOf(created) };
}

describe("B461 · diffFace：行底色、块起点的指示带类与对侧占位块", () => {
  it("B461 · 改动行带底色类；对侧空位是块 widget 且高度按行数 × defaultLineHeight 撑出来", () => {
    const { view, gapEls, lineEl } = mountFace("modified", del);
    expect(lineEl(1).className).not.toContain("diff-line-del"); // 右栏第 1 行本身没改
    expect(gapEls()).toHaveLength(1);
    expect(
      gapEls()[0].getAttribute("class"),
      "占位块 = 中性斜纹（行号槽的差异色由行号那一格自己承载）",
    ).toBe("diff-gap");
    expect(rowOrder(view), "空位是插在 A 与 Z 之间的那一整块").toEqual(["line", "gap", "line"]);
    // ⚠️ 简报这条写的是 `getBoundingClientRect().height > 0`，在 jsdom 里**不可能**绿
    // （无布局引擎 ⇒ 量出来恒为 0）。这一层的真主张是「占位块按行数 × 行高写了多高」⇒
    // 判 widget 自己写下的那道 inline 声明（行高已桩成 20 ⇒ 两行 = 40px），不在测试里重推公式。
    // **真机像素**（同一行在两栏的视觉 y 是否真的一致）归 Task 11 那台判据。
    expect(gapEls()[0].style.height).toBe(`${2 * LINE_HEIGHT}px`);
    const placed = firstBlockWidget(view);
    expect(placed?.widget).toBeInstanceOf(DiffGapWidget);
    expect(placed?.block.type, "块 widget ⇒ CM6 把它当一整块排在两行之间，不是行内一格").toBe(
      BlockType.WidgetAfter,
    );
    expect(placed?.widget.ignoreEvent(new MouseEvent("click")), "占位块不吃点击也不吃光标").toBe(
      true,
    );
    // 缝是**纯占位**：没有文档行，也就没有记号（VS Code 的 alignment view zone 同样不挂
    // 行装饰）。这一侧（右栏）本身没有改动行 ⇒ 整栏一颗记号都不该有。
    expect(
      gapEls()[0].querySelector(".diff-sign"),
      "缺口 widget 里不许再画记号（那是内容区，会跟着正文横向滚）",
    ).toBeNull();
    expect(view.dom.querySelectorAll(".cm-diffSigns .diff-sign"), "缝不画记号").toHaveLength(0);
  });

  it("B465 · 占位块把真实高度交给高度表：视口外不许按一行估（填充行滚过才对齐的根因）", () => {
    // CM6 对 `estimatedHeight === -1` 的块级 widget 用 `oracle.lineHeight`（约一行）当估值。
    // 缝动辄 40/60px、也可能一条不补，按一行记 ⇒ 未渲染的那一段总高与实际差着这一截，
    // 文档总高、跳转落点与对栏同步全都只有「滚过去被实测」之后才纠正 —— 用户看到的就是
    // 「填充行要滚过才对得齐」。这里判的是**高度表读到的那个数**，不是 widget 的 DOM 声明。
    const withGap = mountFace("modified", del);
    const without = mountFace("modified", []);
    expect(firstBlockWidget(withGap.view)?.widget.estimatedHeight, "CM6 读的就是这一颗").toBe(
      2 * LINE_HEIGHT,
    );
    expect(
      withGap.view.contentHeight - without.view.contentHeight,
      "总高里那条缝必须整条算进去（默认 -1 ⇒ 只记一行）",
    ).toBe(2 * LINE_HEIGHT);
  });

  it("B464 · 记号按视觉行：一行折成三个视觉行 ⇒ 那一格竖排三颗", () => {
    // 改块落在第 2 行；把那一行的实测行高桩成 3 × LINE_HEIGHT（jsdom 没有布局引擎，
    // 折行只能从「行块高度」这一口径喂进去）。
    const both = diffBlocks("A\n旧\nZ", "A\n新\nZ");
    const real = EditorView.prototype.lineBlockAt;
    vi.spyOn(EditorView.prototype, "lineBlockAt").mockImplementation(function (
      this: EditorView,
      pos: number,
    ) {
      const block = real.call(this, pos);
      const line = this.state.doc.lineAt(pos).number;
      return line === 2 ? ({ ...block, height: 3 * LINE_HEIGHT } as BlockInfo) : block;
    });
    const { view } = mountFace("modified", both, "A\n新\nZ");
    const rows = [...view.dom.querySelectorAll<HTMLElement>(".cm-diffSigns .diff-sign-rows")];
    expect(rows, "一个文档行只有一格，格内竖排").toHaveLength(1);
    expect(rows[0].children, "三个视觉行 ⇒ 三颗").toHaveLength(3);
    expect(rows[0].dataset.rows, "行数记在 dataset 上，几何没变就不重建").toBe("3");
    expect(rows[0].querySelectorAll(".codicon-add").length, "每一颗都是新稿侧的 `+`").toBe(3);
  });

  it("B464 · 占位缝不画记号：原稿侧的缺口同样一颗都不出", () => {
    // 新稿多出两行 ⇒ 缺口落在**原稿**栏；原稿这一侧没有真行可挂。
    const ins = diffBlocks("A\nZ", "A\n新1\n新2\nZ");
    const { view, gapEls } = mountFace("original", ins, "A\nZ");
    expect(gapEls()).toHaveLength(1);
    expect(gapEls()[0].querySelector(".diff-sign")).toBeNull();
    expect(view.dom.querySelectorAll(".cm-diffSigns .diff-sign"), "缝不画记号").toHaveLength(0);
  });

  it("B462 · 左栏删行涂真行底色 + Codicon `−` 记号；纯删块整行再叠一层字符色", () => {
    const { view, lineEl, gapEls } = mountFace("original", del);
    expect(gapEls(), "删掉的行在左栏是**真行** ⇒ 这一侧不补位").toHaveLength(0);
    expect(lineEl(1).className).not.toContain("diff-line");
    expect(lineEl(2).className).toContain("diff-line-delete");
    expect(lineEl(3).className).toContain("diff-line-delete");
    expect(lineEl(2).className, "VS Code 没有块头横条这一层").not.toContain("diff-edge-top");
    // 纯删块的对侧没有行 ⇒ 上游 `diffWholeLineDelete` 是整行字符层（`isWholeLine: true`）。
    expect(lineEl(2).className, "整行差异：字符色铺满整行").toContain("diff-whole-delete");
    expect(lineEl(3).className).toContain("diff-whole-delete");
    const signs = [...view.dom.querySelectorAll<HTMLElement>(".cm-diffSigns .diff-sign")];
    expect(
      signs.map((s) => [s.tagName, s.classList.contains("codicon-remove")]),
      // VS Code 的 `delete-sign` 取的就是 Codicon `remove`；字形元素（`<i>`）本身就是记号，
      // 不再套一层 span —— 否则内层 `.codicon` 的 16px 会压过外层的 11px。
    ).toEqual([
      ["I", true],
      ["I", true],
    ]);
    expect(signs.every((s) => s.classList.contains("diff-sign-delete"))).toBe(true);
  });

  it("B461 · 改块缺行整段补在块尾 ⇒ 插一块 widget，占缺行的高度", () => {
    const both = diffBlocks("A\nx\nB中\ny\nC", "A\nB改了\nC");
    const { view, lineEl, gapEls } = mountFace("modified", both, "A\nB改了\nC");
    expect(gapEls()).toHaveLength(1);
    expect(rowOrder(view), "缝整段落在改块之后（第 2 行与第 3 行之间）").toEqual([
      "line",
      "line",
      "gap",
      "line",
    ]);
    expect(gapEls()[0].style.height).toBe(`${2 * LINE_HEIGHT}px`);
    expect(lineEl(2).className, "新稿一侧的改块照 VS Code 标成新增行").toContain(
      "diff-line-insert",
    );
    expect(lineEl(2).className, "VS Code 没有块头横条这一层").not.toContain("diff-edge-top");
    expect(firstBlockWidget(view)?.widget).toBeInstanceOf(DiffGapWidget);
  });

  it("B461 · 正文开头就缺行（缝落在第 0 行之后）⇒ 占位块插在第一行**之前**", () => {
    const top = diffBlocks("删1\n删2\nA", "A");
    expect(zonesOf(top, "modified", 1), "前置：纯函数报的是第 0 行之后").toEqual([
      { afterLine: 0, height: 2 * LINE_HEIGHT },
    ]);
    const { view, gapEls } = mountFace("modified", top, "A");
    expect(gapEls()).toHaveLength(1);
    expect(rowOrder(view)).toEqual(["gap", "line"]);
    expect(gapEls()[0].style.height).toBe(`${2 * LINE_HEIGHT}px`);
    // 第 0 行之后没有真行可挂：块 widget 在正文最上方，而缝本身不画记号。
    expect(view.dom.querySelectorAll(".cm-diffSigns .diff-sign"), "缝不画记号").toHaveLength(0);
  });

  it("B461 · 键入期只跟着改动映射、不重算；refreshDiff 那一发才按 provider 重来", () => {
    let blocks = del;
    const provider = vi.fn((): DiffBlock[] => blocks);
    const { view, lineEl, gapEls } = mountFace("modified", provider);
    expect(provider, "create 现算一次").toHaveBeenCalledTimes(1);

    view.dispatch({ changes: { from: 2, insert: "新1\n新2\n" } });
    expect(
      provider,
      "停手之前不重算（B398 那条口径，与 gutterDiffField 同纪律）",
    ).toHaveBeenCalledTimes(1);

    blocks = diffBlocks("A\nZ", "A\n新1\n新2\nZ");
    view.dispatch({ effects: refreshDiff.of(null) });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(gapEls(), "新增块补的是**左栏**，右栏这一侧不该留空位").toHaveLength(0);
    expect(lineEl(1).className, "第 1 行 A 没动，不在任何块里").not.toContain("diff-line");
    expect(lineEl(2).className).toContain("diff-line-insert");
    expect(lineEl(3).className).toContain("diff-line-insert");
  });

  it("B461 · 差异面不许自己算对齐（同源判据：源码里不出现 DP 网格）", () => {
    // 比对**剥掉注释**之后的源码（`tests/static.ts:79-89` 那条纪律）：注释里只是提一嘴被禁的
    // 标识符就会把守卫判红 ⇒ face.ts 的注释里也不许出现这些名字。
    const code = stripLineComments(srcOf("src/diff/face.ts"));
    expect(code).not.toMatch(/lcsAnchors|dp\[|Uint32Array/);
    // 也不许自己调对齐器：那一遍只在 `src/diff/align.ts` 里算一次，本文件只吃 `DiffBlock[]`。
    expect(code).not.toMatch(/alignLines|splitLines|lineDiff|diffBlocks\(/);
  });
});

// --------------------------------------------------------------------------- #
// 一挂就位的差异格（Task 3 的两臂用例与 Task 7 的折叠用例共用**同一份**现场搭法）
// --------------------------------------------------------------------------- #

/**
 * 复刻 `src/tabs/lifecycle.ts` 的 `mountView` 那几步（同 `tests/diff-surface.test.ts`）：
 * 建 `.panel-host` → 建 `.panel-editor` → 挂右栏那颗 view → 交给**生产的** `createDiffSurface`。
 * 两臂的装法本身是生产代码，这里没有第二份实现。
 *
 * `env` 四颗键：**折行缺省开**（与出厂 `word_wrap: true` 同形 —— 关掉才是异常路径）、
 * 明暗缺省浅（主题那条要能拿 dark 档当判别位）、左右两份正文（Task 7 的折叠用例要换正文）。
 *
 * `env.wrap` 同时写**全局设置**（差异格的折行初值继承它，见 `surface.ts` 的 `wrapOn`）：
 * 只改标签快照不改设置的话，挂出来的那两栏与用例声称的前提就是两回事。
 */
function mountSurfacePair(
  env: { left?: string; right?: string; dark?: boolean; wrap?: boolean } = {},
): {
  panel: Panel;
  right: EditorView;
  left: EditorView;
  surface: DiffSurface;
  tab: Tab;
  initialState: EditorState;
} {
  setIsWrap(env.wrap ?? true);
  const leftText = env.left ?? "A\n删1\n删2\nZ";
  const rightText = env.right ?? "A\nZ";
  const spec: DiffSpec = {
    tier: "baseline",
    docId: 100,
    leftText: () => leftText,
    leftName: "a.md（上次保存）",
    rightName: "a.md",
    leftPath: null,
  };
  const hostEl = document.createElement("div");
  hostEl.className = "panel-host";
  document.body.appendChild(hostEl);
  const editorEl = document.createElement("div");
  editorEl.className = "panel-editor";
  hostEl.appendChild(editorEl);
  const { state, comps } = makeTabState(
    rightText,
    null,
    {
      dark: env.dark ?? false,
      wrap: env.wrap ?? true,
      perf: perfProfileFor("normal"),
      // 与 `makeDiffInstance` 同口径：差异实例不挂普通编辑器那层右缘标尺
      // （那一格由 `.diff-overview` 自己画）。
      overview: false,
    },
    () => {},
  );
  const tab: Tab = {
    tabId: 1,
    docId: 100,
    panelId: 0,
    comps,
    state,
    viewMode: "source",
    kind: "diff",
    diff: spec,
    scrollV: 1,
  };
  tabs.set(tab.tabId, tab);
  const view = createEditor(editorEl, state);
  const panel: Panel = {
    panelId: 0,
    tabs: [tab.tabId],
    activeTabId: tab.tabId,
    view,
    viewTabId: tab.tabId,
    bodyEl: hostEl,
    diffSurface: null,
  };
  const surface = createDiffSurface(hostEl, panel, spec);
  // 先拆旁路（它会往右栏发一发 reconfigure），再拆那颗 view —— 反过来的话
  // dispose 就只能在已经 destroy 的视图上派发。
  live.push(() => {
    if (panel.diffSurface === surface) surface.dispose();
  });
  live.push(() => view.view.destroy());
  return { panel, right: view.view, left: surface.left, surface, tab, initialState: state };
}

describe("B461 · surface 给两颗 view 各装一臂（预审 R1）", () => {
  /** Task 3 那一批用例的现场：正文沿用「删两行」那一对，一字不改。 */
  const mountHost = (env: { dark?: boolean; wrap?: boolean } = {}) => mountSurfacePair(env);

  it("B461 · 起手两侧就都有交代：左栏真行涂色、右栏补出同高的空位", () => {
    // 这一条钉的是不折行那一路的定值缝（`LINE_HEIGHT` 常量）；折行那一路按实测行高补，
    // 由 B462 那几条覆盖 —— 出厂设置是开，这里显式摆到关，判据才不依赖 jsdom 的假量度。
    const { left, right } = mountHost({ wrap: false });
    expect(gapElsOf(right), "删掉的行在右栏是占位块").toHaveLength(1);
    expect(gapElsOf(right)[0].style.height).toBe(`${2 * LINE_HEIGHT}px`);
    expect(lineElOf(left, 2).className).toContain("diff-line-delete");
    expect(lineElOf(left, 2).className, "VS Code 没有块头横条这一层").not.toContain(
      "diff-edge-top",
    );
    expect(lineElOf(right, 1).className).not.toContain("diff-line");
    // 装上装饰臂不许松动 Task 1 那道硬闸（非 docChanged 的事务照过、改文档的那一发丢掉）
    left.dispatch({ changes: { from: 0, insert: "X" } });
    expect(left.state.doc.toString(), "左栏正文仍是一字不改").toBe("A\n删1\n删2\nZ");
  });

  it("B461 · 右栏键入停手之后，左栏那一侧跟着收干净（它看不见那发键入）", async () => {
    const { left, right } = mountHost();
    expect(gapElsOf(right), "前置：起手右栏有那道空位").toHaveLength(1);

    // 把删掉的两句打字补回来 ⇒ 两侧都该干净了
    right.dispatch({ changes: { from: 2, insert: "删1\n删2\n" } });
    expect(right.state.doc.toString(), "前置：右栏正文已与基线相同").toBe("A\n删1\n删2\nZ");

    await new Promise((resolve) => setTimeout(resolve, DIFF_REFRESH_MS + 30));

    expect(gapElsOf(right), "本栏自己那发防抖刷新").toHaveLength(0);
    expect(gapElsOf(left)).toHaveLength(0);
    expect(
      lineElOf(left, 2).className,
      "对栏那颗 view 看不见这边的键入 ⇒ 由 surface 补一发",
    ).not.toContain("diff-line");
    expect(lineElOf(right, 2).className).not.toContain("diff-line");
  });

  it("B461 · 拆旁路时右栏那一臂跟着退场（那颗 view 是文档本身，不许留底色）", () => {
    const { panel, right, surface } = mountHost();
    expect(gapElsOf(right)).toHaveLength(1);
    surface.dispose();
    expect(gapElsOf(right), "底色与占位块都不许留在既有的 view 上").toHaveLength(0);
    expect(right.contentDOM.querySelectorAll("[class*='diff-line-']")).toHaveLength(0);
    expect(right.dom.querySelectorAll(".cm-diffSigns")).toHaveLength(0);
    expect(panel.view, "右栏那颗 view 本身不受牵连").not.toBeNull();
    expect(right.state.doc.toString()).toBe("A\nZ");
  });

  it("B461 · 折行初值继承全局设置（上游 diffEditor.wordWrap: 'inherit'），开关两栏一起翻、detach 原样还", () => {
    // 上游 `diffEditor.wordWrap` 默认 `"inherit"` ⇒ 差异格挂上时跟着 `editor.wordWrap` 的现值
    // 走；之后 `Alt+Z` 只是格内临时切换，不改设置。本应用全局出厂是开 ⇒ 这里起手就该折行。
    // ⚠️ 「同一行在两栏的视觉 y 是否真的一致」是**像素**判据，jsdom 没有布局引擎 ⇒ 归真机台。
    // 这里钉的是「扩展在不在 state 里」—— 它恰恰是那条像素等式的前提。
    const { right, left, surface, initialState } = mountSurfacePair();
    expect(
      wrapsLines(initialState),
      "前置：出厂 `word_wrap: true` ⇒ 那颗初始 state 确实装了折行",
    ).toBe(true);
    expect(wrapsLines(right.state), "初值继承设置 ⇒ 挂上旁路那一刻右栏就折行").toBe(true);
    expect(wrapsLines(left.state), "左栏同一档起步").toBe(true);
    expect(surface.wrapEnabled(), "读口报的也是继承来的现值").toBe(true);

    surface.setWrapEnabled(false);
    expect(wrapsLines(right.state), "格内临时关掉（Alt+Z）⇒ 右栏跟上").toBe(false);
    expect(wrapsLines(left.state), "左栏一起关（两栏同口径）").toBe(false);
    surface.setWrapEnabled(true);
    expect(wrapsLines(right.state)).toBe(true);
    expect(wrapsLines(left.state)).toBe(true);

    surface.dispose();
    expect(wrapsLines(right.state), "拆掉旁路把折行还回去（那颗 view 是文档本身）").toBe(true);
  });

  it("B463 · 中间回退键：点一下把原稿那一块写回右栏（普通编辑，不是第二套写入）", () => {
    // 用户口径「要能真的点击生效，不是摆设」：这条从「按钮被建出来」一直钉到「文档真的变了」。
    // jsdom 没有布局引擎 ⇒ 中间列高度恒 0，`renderReverts` 会整段跳过；这里先把量度伪装成可见，
    // 之后走真机那条重画路径（换选区 → `updateListener` 的 `selectionSet` 分支）。
    const { right } = mountSurfacePair({ left: "A\n删1\n删2\nZ", right: "A\nZ" });
    const center = right.dom.closest(".panel-host")!.querySelector<HTMLElement>(".diff-center")!;
    center.getBoundingClientRect = () =>
      ({ top: 0, left: 0, bottom: 200, right: 35, width: 35, height: 200 }) as DOMRect;
    right.dispatch({ selection: { anchor: 1 } });

    const btn = center.querySelector<HTMLButtonElement>(".diff-revert");
    expect(btn, "第一处改动（右栏第 2 行前缺了两行）要有一颗回退键").not.toBeNull();
    // 可访问名称与提示同源：字形本身是 `aria-hidden` 的 `<i>`，读屏器认的只有 aria-label。
    expect(btn!.getAttribute("aria-label"), "回退键要有可访问名称").toBe("回退此块");
    expect(btn!.dataset.tip, "悬浮提示与可访问名称同一句").toBe(btn!.getAttribute("aria-label"));
    btn!.click();
    expect(right.state.doc.toString(), "原稿那两行被写回新稿").toBe("A\n删1\n删2\nZ");
  });

  it("B461 · 还原的是「用户那一颗设置」，不是无条件打开（设置里就关着的用户）", () => {
    // 裁决 R23-1（Task 3 评审抓出、Task 5 落地）把还值的权威从「attach 时 view 里的现值」换成
    // **设置**那一颗：`switchTab` 切出时会把「格内 Alt+Z 临时关掉」的那一发回写进标签快照，读现值就会
    // 把开着换行的用户悄悄改成关着。生产里每一张标签的 wrap Compartment 都由 `isWrap` 派生
    //（`makeInstance` 的 `env.wrap` + `applyWrapToTabs` 的写回）⇒ 「本来就关着」这一形只能由
    // 设置来表达；「快照关着而设置开着」是一条到得了测试、到不了用户的路径。
    const was = isWrap;
    setIsWrap(false);
    try {
      const { right, surface, tab } = mountHost({ wrap: false });
      expect(wrapsLines(tab.state), "前置：这位用户本来就关着折行").toBe(false);
      expect(wrapsLines(right.state)).toBe(false);
      surface.dispose();
      expect(wrapsLines(right.state), "detach 之后仍然是关着 —— 旁路不许替用户改设置").toBe(false);
    } finally {
      setIsWrap(was);
    }
  });

  it("B461 · 差异面挂着期间改了设置 ⇒ detach 还的是**改过之后**那一颗（不许还过期值）", () => {
    // 同一颗权威的另一面：`wrapBack` 若是在 attach 那一刻算好的数组，挂着期间用户把「自动换行」
    // 打开，拆掉旁路时还回去的就是那份**过期**的关 ⇒ 设置说开着、这一格从此不折行（两口径，B458 同族）。
    const was = isWrap;
    setIsWrap(false);
    try {
      const { right, surface } = mountHost({ wrap: false });
      setIsWrap(true); // 用户此刻在设置里打开换行（`applyWrapToTabs` 走的是同一颗 Compartment）
      surface.dispose();
      expect(wrapsLines(right.state), "还值必须在落笔那一刻读设置").toBe(true);
    } finally {
      setIsWrap(was);
    }
  });

  it("B461 · 左栏吃的是与右栏**同一套**主题扩展（R22：不在差异面另配一份，也不在 CSS 硬写底色）", () => {
    // 判据落在 facet 上：`EditorView.darkTheme` 只有 `EditorView.theme(spec, { dark })` 那一颗
    // 会给它 `true`。左栏原先**一颗主题都没装** ⇒ 这里读到 false（红），而「装错了档」（dark/light
    // 取反、或另配一份与右栏不同族的）同样读到不等。
    const { right, left } = mountHost({ dark: true });
    expect(right.state.facet(EditorView.darkTheme), "前置：右栏这套确实是 dark 档").toBe(true);
    expect(
      left.state.facet(EditorView.darkTheme),
      "左栏装的是同一套（`{ dark }` 那一参跟着走）",
    ).toBe(true);
  });

  it("B461 · 主题取自编辑器那颗出口，差异面里不另配一份（第二处真相闸）", () => {
    // 「同一套」只能靠**同一个出口**成立：取右栏那颗 state 里 theme Compartment 的现值。
    // 在这里再调一次主题构造器 = 第二份「当前主题是什么」（明暗与族都得重读一遍设置），
    // 设置页改主题后左栏必然落后 ⇒ 那颗构造器的标识符都不许出现在这个文件里。
    const code = stripLineComments(srcOf("src/diff/surface.ts"));
    expect(code, "从左栏那颗 view 的 theme Compartment 现值取").toMatch(/comps\.theme\.get\(/);
    expect(code, "编辑器那套主题构造器不许被差异面第二次调用").not.toMatch(/themeBuilder/);
  });
});

describe("B462 · 右缘差异概览（VS Code 的 diffOverview）", () => {
  const overviewOf = (host: HTMLElement): HTMLElement => {
    const el = host.querySelector<HTMLElement>(".diff-overview");
    expect(el, "概览条得真的挂上（拿不到就是空判据）").not.toBeNull();
    return el!;
  };
  const marksOf = (host: HTMLElement, side: "original" | "modified"): HTMLElement[] => [
    ...host.querySelectorAll<HTMLElement>(`.diff-overview-${side} .diff-overview-mark`),
  ];

  it("B462 · 删块：左列（原稿）出块、右列不画，位置按视觉行轴；视口滑块同在", () => {
    const { panel } = mountSurfacePair();
    const host = panel.bodyEl!;
    const overview = overviewOf(host);
    expect(overview, "概览条是 host 的最后一个 flex 子项").toBe(host.lastElementChild);
    expect(overview.querySelectorAll(".diff-overview-ruler")).toHaveLength(2);
    // 标记画布是纯绘制层：里面没有可读文本，读屏器能拿到的差异信息不该从这儿来。
    const canvases = [...host.querySelectorAll<HTMLElement>(".diff-overview-canvas")];
    expect(canvases, "两列各一层标记画布").toHaveLength(2);
    for (const canvas of canvases) {
      expect(canvas.getAttribute("aria-hidden"), "画布对辅助技术隐藏").toBe("true");
    }

    const dels = marksOf(host, "original");
    expect(dels, "删两行 = 左列一块").toHaveLength(1);
    expect(dels[0].style.top, "第 2 行起 / 共 4 个视觉行").toBe("25%");
    expect(dels[0].style.height, "两行 / 共 4 个视觉行").toBe("50%");
    expect(marksOf(host, "modified"), "被删的行在新稿没有真行").toHaveLength(0);
    expect(overview.querySelector(".diff-viewport"), "视口滑块就是右栏那一根").not.toBeNull();
  });

  it("B462 · 新增块：右列出块、左列不画", () => {
    const { panel } = mountSurfacePair({ left: "A\nZ", right: "A\n新1\n新2\nZ" });
    const host = panel.bodyEl!;
    expect(marksOf(host, "original"), "新增的行在原稿没有真行").toHaveLength(0);
    const ins = marksOf(host, "modified");
    expect(ins, "新增两行 = 右列一块").toHaveLength(1);
    expect(ins[0].style.top).toBe("25%");
    expect(ins[0].style.height).toBe("50%");
  });

  it("B462 · 改块：两列各按自己那一侧上色（左删右增），没有第三列", () => {
    const { panel } = mountSurfacePair({ left: "A\nB\nC", right: "A\nB1\nB2\nC" });
    const host = panel.bodyEl!;
    const dels = marksOf(host, "original");
    const ins = marksOf(host, "modified");
    expect(dels, "左列：被改掉的原行按删除色").toHaveLength(1);
    expect(ins, "右列：改写后的行按新增色").toHaveLength(1);
    // 左栏 3 行 + 配对窗口之后补 1 行 = 4 个视觉行；右栏 4 行（无补位）。
    expect(dels[0].style.top).toBe("25%");
    expect(dels[0].style.height, "1/4").toBe("25%");
    expect(ins[0].style.top).toBe("25%");
    expect(ins[0].style.height, "2/4").toBe("50%");
    // 「左删右增」之外没有第三条色带 ⇒ 只有两颗 ruler，没有第三列/第三颗色。
    expect(host.querySelectorAll(".diff-overview-ruler")).toHaveLength(2);
  });

  it("B462 · 折叠之后概览跟着重算行轴（折条顶替被折的行）", () => {
    const body = ["A", ...Array.from({ length: 15 }, (_, i) => `行${i + 1}`), "Z"];
    const { panel, surface, right } = mountSurfacePair({
      left: body.join("\n"),
      right: [...body.slice(0, -1), "Z改"].join("\n"),
    });
    const host = panel.bodyEl!;
    const before = marksOf(host, "original")[0];
    expect(before, "前置：最后一行是改块").not.toBeUndefined();
    expect(before.style.top).toBe(`${((17 - 1) / 17) * 100}%`);

    // 折区贴文件头 ⇒ 顶边不留 context（1..13）；两栏光标都先挪到改块那一行，别让
    // 「光标在折区里就先展开」那条守卫把这一段提前打开。
    const keep = surface.left.state.doc.line(17).from;
    surface.left.dispatch({ selection: { anchor: keep } });
    right.dispatch({ selection: { anchor: right.state.doc.line(17).from } });
    surface.setCollapseUnchanged(true);
    expect(foldedRangesIn(right.state).length, "前置：够长的未改动区被折起来").toBeGreaterThan(0);

    // 折叠之后行轴按**实测内容高度**重算（不是 17 行那条旧估算）：色块坐标 = 该行的
    // 文档像素 / 当前 contentHeight。jsdom 里 display:none 的行仍按估算行高计入，所以
    // 这里不写死 87.5%，而是要求它与「此刻的实测轴」一致，且与折叠前不同。
    const after = marksOf(host, "original")[0];
    const lv = surface.left;
    const last = lv.lineBlockAt(lv.state.doc.line(17).from);
    const pct = (v: number): string => `${(v / lv.contentHeight) * 100}%`;
    expect(after.style.top, "行轴跟着 contentHeight，不许还吃折叠前的 17 行").toBe(pct(last.top));
    expect(after.style.height).toBe(pct(last.height));
    expect(after.style.top, "折叠确实改了这支轴").not.toBe(before.style.top);
    expect(marksOf(host, "modified")).toHaveLength(1);
  });

  it("B462 · 行号槽与正文同色：上游 marginClassName 的 gutter-insert / gutter-delete", () => {
    const { left, right } = mountSurfacePair();
    // 上游 `registrations.contribution.ts` 的 line-insert / line-delete 都带
    // `marginClassName: 'gutter-insert' / 'gutter-delete'` ⇒ 行号槽与正文同一条差异色。
    // CM6 侧由 `lineNumberMarkers` 落在整格行号元素上。
    const dels = [...left.dom.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement")];
    expect(
      dels.filter((el) => el.classList.contains("diff-gutter-delete")).length,
      "左栏删掉的两行，行号槽也上色",
    ).toBe(2);
    expect(
      right.dom.querySelectorAll(".cm-lineNumbers .cm-gutterElement.diff-gutter-insert"),
      "右栏这一侧没有真行（空位在缝里）",
    ).toHaveLength(0);
    expect(
      left.dom.querySelectorAll(".cm-line.diff-line-delete").length,
      "正文色带照旧（左栏两行删除）",
    ).toBe(2);
  });

  it("B462 · 纯增 / 纯删 = 整行字符层（上游 diffWholeLineAdd / Delete），行内不再散标", () => {
    const { right, left } = mountSurfacePair({ left: "A\nZ", right: "A\n新\nZ" });
    const line = right.dom.querySelectorAll<HTMLElement>(".cm-line")[1];
    expect(line.className, "整行：行底色 + 字符色两层（类名由 face 发）").toContain(
      "diff-line-insert",
    );
    expect(line.className).toContain("diff-whole-insert");
    expect(
      right.dom.querySelector(".diff-char-insert"),
      "整行差异不再产出行内 mark（上游 isWholeLine 那一档）",
    ).toBeNull();
    expect(
      left.dom.querySelector(".cm-line.diff-whole-delete"),
      "对侧没有真行 ⇒ 没有整行字符层",
    ).toBeNull();
  });

  it("B462 · 部分差异：只标行内改动；跨行改动的非末段带 diff-fill（shouldFillLineOnLineBreak）", () => {
    const { right, left } = mountSurfacePair({ left: "p q\nr s", right: "p X\nY s" });
    for (const view of [left, right]) {
      const marks = [...view.dom.querySelectorAll<HTMLElement>(".cm-line .diff-fill")];
      expect(marks, "两侧第一行都被换行截断 ⇒ 各一颗 fill").toHaveLength(1);
      expect(marks[0].className).toMatch(/diff-char-(insert|delete)/);
      expect(
        view.dom.querySelector(".cm-line.diff-whole-insert, .cm-line.diff-whole-delete"),
        "两侧都有行 ⇒ 不是整行块",
      ).toBeNull();
    }
  });

  it("B462 · 4px 差异列照旧占位（列宽不变），差异底色只落在行号槽那一列", () => {
    // 生产路径（makeDiffInstance / makeTabState）的 gutter 次序是
    // 行号 24.4px → cm-diffGutter 4px（gutterDiff 空列）→ 记号 11px → 正文。
    // 折叠槽关掉之后这几列的宽度也不该变（列宽与有没有标记无关），变的只有「谁上色」。
    const { right } = mountSurfacePair({ left: "A\nZ", right: "A\n增1\nZ" });
    expect(
      right.dom.querySelectorAll(".cm-gutter.cm-diffGutter"),
      "前置：4px 差异列得真的在（不在的话这条判据是空转）",
    ).toHaveLength(1);
    expect(
      right.dom.querySelectorAll(".cm-lineNumbers .cm-gutterElement.diff-gutter-insert"),
      "行号槽这一列承载行底色类",
    ).toHaveLength(1);
    for (const gutter of [".cm-diffGutter", ".cm-diffSigns"]) {
      expect(
        right.dom.querySelector(`${gutter} .cm-gutterElement[class*='diff-gutter-']`),
        `${gutter} 这一列不承载行底色类（上游只有 marginClassName 那一格）`,
      ).toBeNull();
    }
    expect(
      right.dom.querySelectorAll(".cm-line.diff-line-insert"),
      "色带只留在代码行",
    ).toHaveLength(1);
  });
});

describe("B463 · 概览滑块 = 右栏滚动条（ScrollbarState.isNeeded 语义）", () => {
  const viewportOf = (host: HTMLElement): HTMLElement => {
    const el = host.querySelector<HTMLElement>(".diff-viewport");
    expect(el, "视口滑块得真的挂上（拿不到就是空判据）").not.toBeNull();
    return el!;
  };
  const overviewOf = (host: HTMLElement): HTMLElement => {
    const el = host.querySelector<HTMLElement>(".diff-overview");
    expect(el, "概览条得真的挂上").not.toBeNull();
    return el!;
  };
  /** jsdom 没有布局引擎 ⇒ 这两颗量度按真机读数桩进来（clientHeight 进滑块几何，scrollHeight 只做对栏夹值）。 */
  const measure = (el: HTMLElement, clientHeight: number, scrollHeight: number): void => {
    Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  };
  const linesOf = (n: number): string => Array.from({ length: n }, (_, i) => `L${i}`).join("\n");
  /**
   * 给一栏铺一套确定的行盒：概览轴（量尺在 jsdom 里量不出宽度 ⇒ `lineHeights` 退回
   * `textBlockOf`）与滚动锚点（`lineBlockAtHeight`）读的是同一套 —— 真机由 CM6 的
   * heightMap 回答，这里桩成已知像素。
   */
  const fakeLines = (view: EditorView, height: number): void => {
    const doc = view.state.doc;
    const lines = doc.lines;
    const box = (n: number): BlockInfo => ({
      from: doc.line(n).from,
      to: doc.line(n).to,
      top: (n - 1) * height,
      bottom: n * height,
      height,
      length: 1,
      type: 0,
      widget: null,
      widgetLineBreaks: 0,
    });
    view.lineBlockAt = ((pos: number) => box(doc.lineAt(pos).number)) as EditorView["lineBlockAt"];
    view.lineBlockAtHeight = ((y: number) => {
      const n = Math.min(Math.max(Math.floor(y / height) + 1, 1), lines);
      return box(n);
    }) as EditorView["lineBlockAtHeight"];
    Object.defineProperty(view, "contentHeight", { configurable: true, get: () => lines * height });
  };
  /** 折行关着时 `lineHeights` 恒读这颗（真机由 CM6 实测，jsdom 里恒 0）。 */
  const fakeDefaultLineHeight = (view: EditorView, height: number): void => {
    Object.defineProperty(view, "defaultLineHeight", { configurable: true, get: () => height });
  };
  /** 派发 `scroll` 就是 `renderViewport` 的生产重画入口（`onRightScroll`）。 */
  const repaint = (right: EditorView): void => {
    right.scrollDOM.dispatchEvent(new Event("scroll"));
  };
  const rectOf = (height: number): DOMRect =>
    ({
      top: 0,
      bottom: height,
      height,
      left: 0,
      right: 30,
      width: 30,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  /** 让一帧落地（CM6 的 measure 与 `scheduleAlign` 的派发都排在 rAF 上）。 */
  const frames = async (n = 4): Promise<void> => {
    for (let i = 0; i < n; i++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  };

  it("内容装得下：滑块带 `is-hidden`（opacity 0 + 不吃指针），不再铺满整条", () => {
    const { panel, right, surface } = mountSurfacePair({ left: "A\nZ", right: "A\nZ" });
    const host = panel.bodyEl!;
    const viewport = viewportOf(host);
    fakeLines(right, 100);
    fakeLines(surface.left, 100);
    // scrollHeight 不再参与这条链：故意填一个与实测轴无关的值。
    measure(right.scrollDOM, 200, 9_999);
    surface.syncBlocks();
    expect(viewport.classList.contains("is-hidden"), "轴总高 200 = 可视高 ⇒ 收起来").toBe(true);
    // 旧实现走 `getSliderSize()` 的 representableSize 那一支，把高度写成 clientHeight
    // ⇒ 右缘一根整条都是滑块的灰柱，按下去拖不动（scrollTop 恒 0）。
    expect(viewport.style.height, "不再铺满整条").not.toBe("200px");

    // 内容一变高（实测行盒 300 ⇒ 轴 600），下一发重画就能拖 —— 不需要重建整条概览。
    fakeLines(right, 300);
    fakeLines(surface.left, 300);
    surface.syncBlocks();
    expect(viewport.classList.contains("is-hidden")).toBe(false);
    expect(viewport.style.height, "floor(200² / 600) = 66").toBe("66px");
  });

  it("溢出时按 ScrollbarState 的像素公式：高度下限 20px，top 由概览轴换算", () => {
    const { panel, right, surface } = mountSurfacePair({ left: linesOf(20), right: linesOf(20) });
    const viewport = viewportOf(panel.bodyEl!);
    fakeLines(right, 100);
    fakeLines(surface.left, 100);
    measure(right.scrollDOM, 100, 9_999);
    right.scrollDOM.scrollTop = 0;
    surface.syncBlocks();
    expect(viewport.style.height, "floor(100² / 2000) = 5 ⇒ 抬到下限 20").toBe("20px");
    expect(viewport.style.top).toBe("0px");

    // 轴 450 = 第 5 行（top 400）+ 半行（50）；travel = 80，轴跨 1900。
    right.scrollDOM.scrollTop = 450;
    repaint(right);
    expect(viewport.style.top).toBe("19px");
  });

  it("拖动：窗口级监听跨出元素边界仍跟手；松手或按键状态变了就停", () => {
    const { panel, right, surface } = mountSurfacePair({ left: linesOf(6), right: linesOf(6) });
    const host = panel.bodyEl!;
    const overview = overviewOf(host);
    overview.getBoundingClientRect = () => rectOf(200);
    fakeLines(right, 100);
    fakeLines(surface.left, 100);
    measure(right.scrollDOM, 200, 9_999);
    surface.syncBlocks();
    expect(viewportOf(host).style.height).toBe("66px");

    overview.dispatchEvent(
      new MouseEvent("pointerdown", { clientY: 100, button: 0, bubbles: true }),
    );
    expect(right.scrollDOM.scrollTop, "按在轨道中点 ⇒ 跳到轴的一半（第 4 行）").toBe(300);

    // 指针移出概览条（仍在窗口里）：监听挂在 window 上，靠元素内命中的写法这里会断。
    window.dispatchEvent(new MouseEvent("pointermove", { clientY: 200, buttons: 1 }));
    expect(right.scrollDOM.scrollTop, "跨出边界继续跟手").toBe(400);

    // 指针在窗口外松开时浏览器不会补 pointerup ⇒ 用「按键状态变了」收尾（上游同一条判据）。
    window.dispatchEvent(new MouseEvent("pointermove", { clientY: 0, buttons: 0 }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientY: 0, buttons: 1 }));
    expect(right.scrollDOM.scrollTop, "已收尾，之后的移动不该再改滚动").toBe(400);

    // 正常松手同样收尾；右键按下不启动拖动（上游只认左键）。
    overview.dispatchEvent(
      new MouseEvent("pointerdown", { clientY: 100, button: 0, bubbles: true }),
    );
    window.dispatchEvent(new MouseEvent("pointerup"));
    window.dispatchEvent(new MouseEvent("pointermove", { clientY: 200, buttons: 1 }));
    expect(right.scrollDOM.scrollTop, "pointerup 之后不再跟手").toBe(300);
    overview.dispatchEvent(
      new MouseEvent("pointerdown", { clientY: 200, button: 2, bubbles: true }),
    );
    expect(right.scrollDOM.scrollTop, "右键不启动拖动").toBe(300);
  });

  it("折行开关与窗口缩放之后都重算滑块（不靠滚一下才醒）", async () => {
    // 起手摆在不折行那一档，下面再翻到折行 —— 与「初值继承设置」不冲突（`env.wrap` 同时写设置）。
    const { panel, right, surface } = mountSurfacePair({
      left: linesOf(4),
      right: linesOf(4),
      wrap: false,
    });
    const viewport = viewportOf(panel.bodyEl!);
    // 折行关着：一个文档行 = 一个视觉行，行高读 `defaultLineHeight`。
    fakeDefaultLineHeight(right, 100);
    fakeDefaultLineHeight(surface.left, 100);
    measure(right.scrollDOM, 200, 9_999);
    surface.syncBlocks();
    expect(viewport.style.height, "floor(200² / 400) = 100").toBe("100px");

    // 打开折行：实测行盒变 200/行（轴 800），刷新跟着重画。
    fakeLines(right, 200);
    fakeLines(surface.left, 200);
    surface.setWrapEnabled(true);
    expect(viewport.style.height, "floor(200² / 800) = 50").toBe("50px");

    // 窗口缩放走 `onWindowResize` → `scheduleAlign` 的 rAF 落地后才重画。
    measure(right.scrollDOM, 100, 9_999);
    window.dispatchEvent(new Event("resize"));
    await frames();
    expect(viewport.style.height, "floor(100² / 800) = 12 ⇒ 抬到下限 20").toBe("20px");
  });

  it("样式：隐藏态照上游 `.invisible`；概览条光标不靠继承；同类状态只留一条规则", () => {
    const css = stripCssComments(srcOf("src/diff/diff.css"));
    const hidden = ruleBlock(css, ".panel-host.is-diff .diff-viewport.is-hidden", undefined, true);
    expect(hidden).toContain("opacity: 0");
    expect(hidden).toContain("pointer-events: none");
    const overview = ruleBlock(css, ".panel-host.is-diff .diff-overview", undefined, true);
    expect(overview).toContain("cursor: default");
    // 收敛：两栏滚动条原先各一条、滑块按下与拖动原先各一条 —— 同一份契约不许写成两处
    // 「后写的覆盖前写的」。
    const scroll = ruleBlock(
      css,
      ".panel-host.is-diff .diff-original .cm-scroller::-webkit-scrollbar:vertical, .panel-host.is-diff .panel-editor .cm-scroller::-webkit-scrollbar",
    );
    expect(scroll, "两栏纵向滚动条合成一条").toContain("width: 0");
    // 右栏若被重新单写一条，`width: 0` 的滚动条规则会变成两条 —— 这里点数兜住。
    const widthZeros = [...css.matchAll(/::-webkit-scrollbar[^{]*\{([^}]*)\}/g)].filter((m) =>
      /width:\s*0/.test(m[1]),
    );
    expect(widthZeros.length, "两栏滚动条只保留一条 width: 0 的规则").toBe(1);
    const active = ruleBlock(
      css,
      ".panel-host.is-diff .diff-viewport:active, .panel-host.is-diff .diff-viewport.is-dragging",
    );
    expect(active, "按下与拖动共一态").toContain("var(--sb-thumb-active)");
  });
});

describe("B461 · 差异段样式（Task 3 追加那一段）", () => {
  const css = (): string => stripCssComments(srcOf("src/diff/diff.css"));

  /**
   * 只取 Task 3 那一段（`.diff-line-insert` → Task 7 的折条规则之前）：前面那一格是 Task 1
   * 的两栏骨架。折条是**外壳**不是差异态（它自己不许吃那三颗色），所以它的色由下面 Task 7
   * 那一条单独判 —— 两段的 token 清单天然不同， census 必须分段做，不许把整份文件一锅端。
   */
  const section = (): string => {
    const code = css();
    const at = code.indexOf(".diff-line-insert");
    if (at < 0) return "";
    const end = code.indexOf(".diff-fold-bar");
    return end < 0 ? code.slice(at) : code.slice(at, end);
  };

  it("B462 · 这一段不许有裸十六进制、也不许借 --warn / --danger；着色只走两套 diff 底色与外壳灰", () => {
    const s = section();
    expect(s, "锚点选择器得真在文件里（截空了后面的判据全是假绿）").not.toBe("");
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    const tokens = new Set([...s.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
    // 行底色与字符底色是上游四个不同的 key（`editorColors.ts`）⇒ 各吃各的 token；
    // 占位块的斜纹走上游 `diffEditor.diagonalFill` 那一颗（也不是差异色）。
    expect([...tokens].sort()).toEqual([
      "--diff-char-add",
      "--diff-char-del",
      "--diff-diagonal",
      "--diff-line-add",
      "--diff-line-del",
    ]);
    expect(s, "不许再借 --warn / --danger（B458 续轮定死这两颗与明暗档无关）").not.toMatch(
      /--(warn|danger)\b/,
    );
  });

  it("B462 · 两套底色取上游默认值：行 20% + 字符 20%，两层叠加而不是字符色替换行底色", () => {
    const all = css();
    // 上游 `defaultInsertColor` / `defaultRemoveColor` = rgba(155,185,85,.2) / rgba(255,0,0,.2)。
    expect(all).toContain("--diff-line-add: #9bb95533");
    expect(all).toContain("--diff-line-del: #ff000033");
    // 上游 `insertedTextBackground` 暗 #9ccc2c33 / 亮 #9ccc2c40，`removedTextBackground` #ff000033。
    expect(all).toContain("--diff-char-add: #9ccc2c33");
    expect(all).toContain("--diff-char-del: #ff000033");
    expect(all, "亮色档字符底色照上游高一档").toContain("--diff-char-add: #9ccc2c40");
    // 概览色带：上游那两个 key 默认 null ⇒ 退到字符底色再 `.transparent(2)`（alpha × 2）
    // ⇒ 暗 0.2×2 = 0.4，亮新增 0.25×2 = 0.5。不是从 --diff-add / --diff-del 调百分比。
    expect(all).toContain("--diff-overview-add: #9ccc2c66");
    expect(all).toContain("--diff-overview-del: #ff000066");
    expect(all, "亮色档概览新增色跟着亮色字符底色 ×2").toContain("--diff-overview-add: #9ccc2c80");
    expect(all, "概览色带不许再借增删色自己混").not.toContain("var(--diff-add) 45%");
    const s = section();
    for (const token of [
      "--diff-line-add",
      "--diff-line-del",
      "--diff-char-add",
      "--diff-char-del",
    ]) {
      expect(s, "四条规则都得吃上面那颗 token（不许各自再调一遍百分比）").toContain(
        `var(${token})`,
      );
    }
    expect(s, "上游默认深/浅主题没有描边（只有 HC 才给虚线框）").not.toMatch(
      /(^|[\s;{])(border|outline)\s*:/,
    );
    expect(s, "没有第三种「修改行」配色").not.toMatch(/--diff-mod|diff-line-modify/);
  });

  it("B461 · 底色不打特异度战：走 background-image 叠层，与当前行底色共存（R21）", () => {
    const code = css();
    const kindToToken: Record<string, string> = {
      insert: "--diff-line-add",
      delete: "--diff-line-del",
    };
    for (const [kind, token] of Object.entries(kindToToken)) {
      // 选择器 = `.panel-host.is-diff .cm-line.diff-line-X`（0-4-0，与 global.css 里 B425 那颗
      // `.panel-host .cm-editor .cm-line.cm-find-range` 同形 —— 仓库给「整行叠一层透明色」定的就是这一档）。
      const block = ruleBlock(code, `.panel-host.is-diff .cm-line.diff-line-${kind}`);
      expect(block, `底色规则得真在（判不到东西的 not.toMatch 是假绿）`).not.toBe("");
      expect(block).toMatch(/background-image:\s*linear-gradient\(/);
      expect(block).toContain(`var(${token})`);
      // 关键的一条：这一族**不碰** `background` / `background-color`。那两个属性是
      // `.cm-activeLine` 的（0-3-0，global.css:4521）—— 同一条声明里抢同一个属性，就只能靠
      // 加码特异度压它，压赢的代价是光标停在哪一行、那一行的当前行高亮整个消失（2026 两档
      // 的当前行**只有底色**一种指示，见 global.css:4493-4497）。叠在 background-image 上
      // 两层同时在，零层叠战争。
      expect(block, "不许再声明 background 简写/长写：那才是与当前行抢同一个属性").not.toMatch(
        /(^|[\s;{])background(-color)?\s*:/,
      );
    }
    // `:is(.diff-original, .panel-editor)` 那半档加码（0-5-0）已撤：两栏由 `.is-diff` 那道闸管，
    // 不必再进选择器 —— 它是「压过 .cm-activeLine」留下的遗产，而这一族不再需要压谁。
    expect(section(), "不许留着为压当前行而加的 :is()").not.toContain(":is(");
    // 同特异度（与 global.css:4530 那颗 :has(.cm-selectionBackground) 的 0-4-0）时靠**文件先后**
    // 定输赢：那条 `background: transparent` 的简写会把 background-image 一起重置掉。
    // 先后是 load-bearing 的，所以钉在判据里，而不是留在注释里。
    const main = srcOf("src/main.ts");
    expect(
      main.indexOf("styles/global.css"),
      "前置：global.css 确实在 import 链里",
    ).toBeGreaterThan(-1);
    expect(
      main.indexOf("styles/global.css"),
      "diff.css 必须排在 global.css **之后**（否则当前行有选区时底色会被那条简写抹掉）",
    ).toBeLessThan(main.indexOf("diff/diff.css"));
  });

  it("B461 · 左栏那半的底色归主题：CSS 里不硬写第二处真相（R22）", () => {
    const code = css();
    // 原先左栏什么都没有 ⇒ 那一半画在页面底色上，20% 的改动色两栏叠的根本不是同一颗基色。
    // 修法是把主题扩展装进左栏那颗 state（surface.ts），**不是**在这里补 `background` —— 硬写
    // 一份就等于埋下第二处「当前主题是什么」的真相，dark/HC 族必然跟着错。
    for (const sel of [".diff-original", ".diff-original .cm-editor"]) {
      const block = ruleBlock(code, sel);
      expect(block, `规则得真在（${sel}）`).not.toBe("");
      expect(block, "左栏那一族的底色/字色由主题扩展给，样式段不许硬写").not.toMatch(
        /(^|[\s;{])(background|color)(-color)?\s*:/,
      );
    }
  });

  it("B462 · 占位块走 VS Code 的 -45deg / 8px 斜纹，取上游 diagonalFill 默认值（HC 不画）", () => {
    const s = section();
    expect(s).toMatch(/linear-gradient\(\s*-45deg/);
    expect(s, "VS Code 的 `diagonal-fill` 是 8px 一格").toContain("8px 8px");
    expect(s, "斜纹是中性 fill，不是某一侧的差异色").toContain("var(--diff-diagonal)");
    const all = css();
    // 上游 `diffEditor.diagonalFill`：dark #cccccc33 / light #22222233，hcDark / hcLight 都是 null。
    expect(all).toContain("--diff-diagonal: #cccccc33");
    expect(all).toContain("--diff-diagonal: #22222233");
    expect(all, "高对比档不画斜纹（上游该 key 是 null）").toContain(
      ':root[data-theme-family="hc"] .panel-host.is-diff .diff-gap {',
    );
    // `.diff-gap` 是 `.cm-content` 里的块 widget：继承 `pre-wrap`，而任何竖向 margin/padding
    // 与 em 制高都会把两栏的行盒推开（`src/preview/` 那些块 widget 栽过的坑）。
    // 行高一律由 widget 按 `view.defaultLineHeight` 写 inline ⇒ 这一段只许声明外观。
    const gap = ruleBlock(css(), ".diff-gap", undefined, true);
    expect(gap, "规则得真在（判不到东西的 not.toMatch 是假绿）").not.toBe("");
    expect(gap).not.toMatch(/(^|[\s;{])(margin|padding)(-top|-bottom)?\s*:/);
    expect(gap).not.toMatch(/\d*\.?\d+em\b/);
    expect(gap, "高度是 widget 写 inline 的，样式段不钉死它").not.toMatch(/height\s*:/);
    // 几何照上游 alignment view zone：斜纹只在正文内容区（`.view-zones` 由 margin 盖住左侧），
    // 不许再用负 `left` / `width: 100% + gutter` 的补丁铺到行号槽上。
    expect(gap, "不越界到行号槽").not.toMatch(/(^|[\s;{])left\s*:/);
    expect(gap, "宽度不叠加 gutter，吃满 `.cm-content` 即可").not.toMatch(/width\s*:/);
    expect(srcOf("src/diff/surface.ts"), "铺槽那套实测变量一并清掉").not.toContain(
      "--diff-gutter-w",
    );
    // 缝是纯占位：没有文档行，不挂记号（上游 alignment view zone 同口径）。
    expect(gap, "缺口 widget 里不再自带记号").not.toMatch(/diff-sign/);
    const signRows = ruleBlock(css(), ".panel-host.is-diff .diff-sign-rows", undefined, true);
    expect(signRows, "一格内按视觉行竖排").toContain("flex-direction: column");
    const signRow = ruleBlock(css(), ".panel-host.is-diff .diff-sign-row", undefined, true);
    expect(signRow, "每一视觉行均分整格高度").toContain("flex: 1 1 0");
  });
});

// --------------------------------------------------------------------------- #
// Task 7 —— 折叠未改动区（默认不折 + 三颗动作）
//
// 分层与前面两格同规矩：
//   1) `foldCandidates` 是纯函数（候选长度与「折中间、上下各留 3 行」的算术），向量直接钉；
//   2) surface 的开关状态 + 三颗动作 + `unfoldAround`（默认关 ⇒ 一段都不折）；
//   3) 折条与 `display: none` 的画法走 DOM；样式段的色链走源码文本。
//
// ⚠️ 折叠后「两栏仍然逐行对齐」是像素判据（真机上折条那一行占多高、被折行的行号是否真消失，
// 只有量得出来）⇒ 归 Task 11 那台。这里钉的是行数、类名、文案、落位与「哪些行被折起来」的算术。
// --------------------------------------------------------------------------- #

/** 连号的行清单：`seq(1, 3, "u")` ⇒ `["u1","u2","u3"]`（用来搭长正文的现场）。 */
function seq(from: number, to: number, mark: string): string[] {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`${mark}${i}`);
  return out;
}

/** 三块，块之间各隔 **30 行**未改动（两侧行号重合，按行口算最不容易看错）。 */
const THREE_LEFT = ["甲一", ...seq(1, 30, "未改"), "乙一", ...seq(1, 30, "另笔"), "尾一"].join(
  "\n",
);
const THREE_RIGHT = ["乙二", ...seq(1, 30, "未改"), "丙二", ...seq(1, 30, "另笔"), "丁二"].join(
  "\n",
);

/** 简报 Step 1 的那一座现场：三块 + 两段够长的未改动区 ⇒ 候选恰两段。 */
function mountedSurfaceWithThreeBlocks(): DiffSurface {
  return mountSurfacePair({ left: THREE_LEFT, right: THREE_RIGHT }).surface;
}

/** 任意两份正文的一格（「太短不折」那一条要用）。 */
function mountedSurface(leftText: string, rightText: string): DiffSurface {
  return mountSurfacePair({ left: leftText, right: rightText }).surface;
}

/** `foldRanges()` 只认行号那一半（`top/bottom/regionLength` 是揭示记账，判揭示量用它们）。 */
function rangesOf(s: DiffSurface): Array<{ from: number; to: number }> {
  return s.foldRanges().map(({ from, to }) => ({ from, to }));
}

/** 左栏那一列的第 `index` 颗折条（DOM 顺序 = 行号顺序）。 */
function foldBarOf(s: DiffSurface, index: number): HTMLElement {
  const bars = s.left.contentDOM.querySelectorAll<HTMLElement>(".diff-fold-bar");
  expect(bars.length, `现场得有折条（第 ${index} 颗点不到就是判据空转）`).toBeGreaterThan(index);
  return bars[index];
}

const foldBarCount = (view: { contentDOM: HTMLElement }): number =>
  view.contentDOM.querySelectorAll(".diff-fold-bar").length;

const foldBarText = (s: DiffSurface, index: number): string =>
  foldBarOf(s, index).querySelector(".diff-fold-text")?.textContent ?? "";

/** 点第 `index` 颗折条的揭示热区（上 / 下 4px 那一块；照上游走 mousedown→mouseup，不另挂 click）。 */
function clickFoldZone(s: DiffSurface, index: number, zone: "top" | "bottom"): void {
  const strip = foldBarOf(s, index).querySelector<HTMLElement>(`.diff-fold-${zone}`);
  if (!strip) throw new Error(`第 ${index} 颗折条没有 .diff-fold-${zone}`);
  strip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  (s.left.dom.ownerDocument.defaultView ?? window).dispatchEvent(new MouseEvent("mouseup"));
}

/** 点第 `index` 颗折条中间那颗 `unfold`（= 全开这一段）。 */
function clickFoldIcon(s: DiffSurface, index: number): void {
  foldBarOf(s, index)
    .querySelector(".diff-fold-unfold")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

/**
 * 顶部六颗「改一行」的小块（每块之间只隔 3 行上下文，一段都够不上折的阈值）+ 中段 **100 行**
 * 未改动 + 尾段 30 行未改动 ⇒ 候选两段，其中**第一段折起来 94 行**，比 `DIFF_REVEAL_LINES`
 * 多得多。这一座现场是为「拖拽 / 点击揭示多少行」那几条准备的：94 行这一段连点几次才见底，
 * 而 24 行那一段第二下就被夹到全开，两条边界都在这座现场上量得出来。
 * 每一处改动在两栏都只占一行 ⇒ 两栏行号重合，按行口算最不容易看错。
 */
function longRunsPair(): { left: string; right: string } {
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 1; i <= 5; i++) {
    left.push(`改${i}一`, `定${i}甲`, `定${i}乙`, `定${i}丙`);
    right.push(`改${i}二`, `定${i}甲`, `定${i}乙`, `定${i}丙`);
  }
  left.push("改6一", ...seq(1, 100, "长未改"), "尾一", ...seq(1, 30, "另笔"), "末一");
  right.push("改6二", ...seq(1, 100, "长未改"), "尾二", ...seq(1, 30, "另笔"), "末二");
  return { left: left.join("\n"), right: right.join("\n") };
}

/** 光标现在落在第几行（1-based）。 */
const caretLineOf = (view: EditorView): number =>
  view.state.doc.lineAt(view.state.selection.main.head).number;

describe("B462 · 记号槽与右缘概览条样式", () => {
  const css = (): string => stripCssComments(srcOf("src/diff/diff.css"));

  it("B462 · 记号槽在行号右侧、10px、11px / 0.7；中间列 35px + 20×18 回退键", () => {
    const sign = ruleBlock(css(), ".panel-host.is-diff .cm-diffSigns", undefined, true);
    expect(sign, "规则得真在（判不到东西的 not.toMatch 是假绿）").not.toBe("");
    expect(
      sign,
      // VS Code 的 `EditorLayoutInfo`：glyphMargin → 行号 → lineDecorations → content，
      // 记号在行号**右侧**；CM6 的 gutter 次序就是 DOM 次序 ⇒ 不该再有 `order` 挪位。
      "记号槽不再用 order 挪到行号左边",
    ).not.toContain("order:");
    expect(sign, "lineDecorationsWidth 的默认 10px").toContain("min-width: 10px");

    const glyph = ruleBlock(css(), ".panel-host.is-diff .diff-sign", undefined, true);
    expect(glyph, "上游 insert-sign / delete-sign 的字号").toContain("font-size: 11px");
    expect(glyph).toContain("opacity: 0.7");
    expect(glyph, "上游的记号元素自己是 flex").toContain("display: flex");

    const center = ruleBlock(css(), ".diff-center", undefined, true);
    expect(center, "VS Code 的 DEFAULT_DIFF_EDITOR_GUTTER_WIDTH = 35").toContain("flex: 0 0 35px");
    const revert = ruleBlock(css(), ".diff-revert", undefined, true);
    // 上游可见的是 `.actions-container` 那颗按钮，不是 34×20 的定位容器：
    // `.action-label` 在差异格里 padding: 1px 2px + 16px codicon ⇒ 20×18。
    expect(revert, "按钮本身 20×18（gutterItem 34×20 只是容器）").toContain("width: 20px");
    expect(revert).toContain("height: 18px");
    expect(revert, "上游 .actions-container 的 4px 圆角").toContain("border-radius: 4px");
    // 底色 / 字形照上游 `editorGutter.itemBackground` / `itemGlyphForeground`（新增两颗 token）：
    // itemBackground = opaque(list.inactiveSelectionBackground, editorBackground)，
    // itemGlyphForeground = editor.foreground；HC 两档上游另给纯色。
    expect(revert, "底色走 editorGutter.itemBackground 的口径").toContain("var(--diff-revert-bg)");
    expect(revert, "字形走 editorGutter.itemGlyphForeground 的口径").toContain(
      "var(--diff-revert-fg)",
    );
    expect(css(), "itemBackground 落到 list.inactiveSelectionBackground").toContain(
      "--diff-revert-bg: var(--list-inactive-bg)",
    );
    expect(css(), "itemGlyphForeground = editor.foreground").toContain(
      "--diff-revert-fg: var(--fg)",
    );
    expect(css(), "HC 档另给纯色（hcDark 白底黑字）").toContain("--diff-revert-bg: #ffffff");
    expect(css(), "HC 亮档黑底白字").toContain("--diff-revert-bg: #000000");

    // 行号槽与正文同色（上游 `marginClassName`）：`.diff-gutter-*` 那颗类现在真的落在
    // 整格行号元素上，样式段必须给出与之配套的底色规则（吃同一对行底色 token）。
    const gutterInsert = ruleBlock(
      css(),
      ".panel-host.is-diff .cm-lineNumbers .cm-gutterElement.diff-gutter-insert",
      undefined,
      true,
    );
    expect(gutterInsert, "行号槽新增色规则得真在").toContain("var(--diff-line-add)");
    const gutterDelete = ruleBlock(
      css(),
      ".panel-host.is-diff .cm-lineNumbers .cm-gutterElement.diff-gutter-delete",
      undefined,
      true,
    );
    expect(gutterDelete, "行号槽删除色规则得真在").toContain("var(--diff-line-del)");

    // 回退列：每块一条竖线（上游 `.gutterItem .background`）+ 按钮悬停走 toolbarBackground。
    const rule = ruleBlock(css(), ".diff-revert-line", undefined, true);
    expect(rule, "逐块竖线规则得真在").toContain("height: 100%");
    expect(rule, "颜色走 menu.separatorBackground 那颗 token").toContain("var(--diff-gutter-line)");
    const item = ruleBlock(css(), ".diff-revert-item", undefined, true);
    expect(item, "item 默认隐形").toContain("opacity: 0");
    expect(css(), "悬停这一列时 item 现形").toContain(".diff-center:hover .diff-revert-item");
    const hover = ruleBlock(css(), ".diff-revert:hover", undefined, true);
    expect(hover, "按钮悬停 = toolbar.hoverBackground 叠在 itemBackground 上").toContain(
      "var(--toolbar-hover-bg)",
    );
    expect(
      css(),
      "行背景取上游 insertedLineBackground 的默认值（不是概览色带那颗 token）",
    ).toContain("var(--diff-line-add)");
    expect(css(), "不许再留 18% 的手调色").not.toContain("--diff-add) 18%");
  });

  it("B462 · 概览条 30px、两列各 15px；色块左删右增，视口滑块吃滚动条三档", () => {
    const overview = ruleBlock(css(), ".panel-host.is-diff .diff-overview", undefined, true);
    expect(overview).toContain("flex: 0 0 30px");
    const ruler = ruleBlock(css(), ".panel-host.is-diff .diff-overview-ruler", undefined, true);
    expect(ruler).toContain("width: 15px");
    expect(
      ruleBlock(
        css(),
        ".panel-host.is-diff .diff-overview-original .diff-overview-mark",
        undefined,
        true,
      ),
    ).toContain("var(--diff-overview-del)");
    expect(
      ruleBlock(
        css(),
        ".panel-host.is-diff .diff-overview-modified .diff-overview-mark",
        undefined,
        true,
      ),
    ).toContain("var(--diff-overview-add)");
    const viewport = ruleBlock(css(), ".panel-host.is-diff .diff-viewport", undefined, true);
    expect(viewport).toContain("var(--sb-thumb)");
    // 滑块叠在色带上：几何与配色照 VS Code 的滚动条滑块（无描边、无内缩
    // —— `scrollbars.css` 只给 background，几何由 `_createSlider` 居中摆放，
    // 默认 slider 宽度 = 轨道宽度）；圆角是用户点名的差异。
    expect(viewport, "滑块圆角（用户明确要求）").toContain("border-radius: 4px");
    // VS Code 的 `.diffOverview .diffViewport` 是 z-index: 10 ⇒ 滑块压在色块上，
    // 半透明让下面的删除/新增色透出来。
    expect(viewport, "滑块压在色带上（上游 diffViewport 的层级）").toMatch(/z-index:\s*10/);
    expect(viewport, "铺满色带宽度，不内缩").toContain("left: 0");
    expect(viewport, "铺满色带宽度，不内缩").toContain("right: 0");
    expect(viewport, "VS Code 的滑块没有描边/阴影").not.toContain("box-shadow");
    // 拖动期间窗口级监听，`:active` 会随指针离开滑块失效 ⇒ 另钉一态；按下与拖动共一条
    // 规则（同一个取值原先写了两遍）。
    const dragging = ruleBlock(
      css(),
      ".panel-host.is-diff .diff-viewport:active, .panel-host.is-diff .diff-viewport.is-dragging",
      undefined,
      true,
    );
    expect(dragging, "拖动态明显高于静止态").toContain("var(--sb-thumb-active)");
    expect(css(), "右栏原生纵向滚动条收成 0 宽，概览条就是那一根").toContain(
      ".panel-host.is-diff .panel-editor .cm-scroller::-webkit-scrollbar",
    );
    // 左栏只藏**纵向**：滚动能力（滚轮 / 键盘 / 同步）不受 width: 0 影响；
    // 不能把整条 scrollbar 收掉，否则长行的横向滚动也没了。
    const leftVScroll = ruleBlock(
      css(),
      ".panel-host.is-diff .diff-original .cm-scroller::-webkit-scrollbar:vertical",
      undefined,
      true,
    );
    expect(leftVScroll, "左栏纵向滚动条收成 0 宽").toMatch(/width:\s*0/);
    expect(css(), "左栏横向滚动条保留（整条 scrollbar 不许收）").not.toMatch(
      /\.panel-host\.is-diff \.diff-original \.cm-scroller::-webkit-scrollbar\s*\{/,
    );
  });

  it("B462 · 中间指示带与块头横条已整段清除（VS Code 没有这两层）", () => {
    const code = css();
    expect(code).not.toMatch(/diff-edge-top/);
    expect(code).not.toMatch(/--diff-edge/);
    expect(code).not.toMatch(/diff-line-modify/);
  });
});

describe("B461 · foldCandidates：未改动区的候选算术（纯函数）", () => {
  it("B461 · 夹在两块之间：8 行不折、9 行才折（上游阈值是 `>= 2 × context + 3`）", () => {
    const n8 = seq(1, 8, "短");
    const n9 = seq(1, 9, "长");
    // 三块（第 1、10、20 行改了）⇒ 中间两段未改动区：8 行（差一截，不折）与 9 行（折）。
    const blocks = diffBlocks(
      ["甲1", ...n8, "乙1", ...n9, "丙1"].join("\n"),
      ["乙2", ...n8, "丙2", ...n9, "丁2"].join("\n"),
    );
    expect(blocks).toHaveLength(3);
    expect(9).toBe(DIFF_MIN_UNCHANGED_LINES + 2 * DIFF_CONTEXT_LINES);
    expect(foldCandidates(blocks, "modified", { original: 20, modified: 20 })).toEqual([
      { run: 2, start: 14, end: 16 },
    ]);
    // 首块之前 / 末块之后那两段也是未改动区：这里都是空的 ⇒ 一段候选都不多
    expect(foldCandidates(blocks, "original", { original: 20, modified: 20 })).toEqual([
      { run: 2, start: 14, end: 16 },
    ]);
  });

  it("B461 · 三块之间那两段 30 行的未改动区都是候选（两端各留 context）", () => {
    const blocks = diffBlocks(THREE_LEFT, THREE_RIGHT);
    expect(blocks).toHaveLength(3);
    expect(foldCandidates(blocks, "modified", { original: 63, modified: 63 })).toEqual([
      { run: 1, start: 5, end: 28 },
      { run: 2, start: 36, end: 59 },
    ]);
  });

  it("B461 · 贴文件头/尾的候选只裁内侧 context（上游 atStart / atEnd 口径）", () => {
    const body = seq(1, 15, "未改");
    // 改块在末尾（对侧多一行）⇒ 未改动区贴**头**：顶边不留 context，底边留 3 行。
    // 两栏都按「只在头」裁：原稿栏虽然自己已经到末行，但镜像栏没到 ⇒ 不算 atEnd。
    const head = diffBlocks(["首一", ...body].join("\n"), ["首一", ...body, "尾二"].join("\n"));
    expect(foldCandidates(head, "original", { original: 16, modified: 17 })).toEqual([
      { run: 0, start: 1, end: 13 },
    ]);
    expect(foldCandidates(head, "modified", { original: 16, modified: 17 })).toEqual([
      { run: 0, start: 1, end: 13 },
    ]);
    // 改块在开头 ⇒ 未改动区贴**尾**：顶边留 3 行，底边不留
    const tail = diffBlocks(["首一", ...body].join("\n"), ["首二", ...body].join("\n"));
    expect(foldCandidates(tail, "modified", { original: 16, modified: 16 })).toEqual([
      { run: 1, start: 5, end: 16 },
    ]);
  });

  it("B461 · 整篇一字不差 ⇒ 不出折条（上游把唯一覆盖全文的 region 清空）", () => {
    expect(foldCandidates([], "modified", { original: 20, modified: 20 })).toEqual([]);
    expect(foldCandidates([], "original", { original: 20, modified: 20 })).toEqual([]);
  });
});

describe("B461 · 折叠未改动区（Task 7：默认不折 + 三颗动作）", () => {
  it("B461 · 未改动区够长才成为折叠候选；开关默认关 ⇒ 折起来 0 段", () => {
    const s = mountedSurfaceWithThreeBlocks();
    expect(s.collapseUnchanged()).toBe(false);
    expect(s.foldRanges()).toEqual([]);
    s.setCollapseUnchanged(true);
    expect(s.foldRanges()).toHaveLength(2); // 三块之间那两段长的未改动区
    s.showAllUnchanged();
    expect(s.foldRanges()).toEqual([]);
    s.collapseAllUnchanged();
    expect(s.foldRanges()).toHaveLength(2);
  });

  it("B464 · 折区没变就不重发：反复 syncBlocks 不再派发 setFoldedRanges（闪烁的根因）", () => {
    // 必须在建视图**之前**挂 spy：CM6 构造时会 `this.dispatch = this.dispatch.bind(this)`，
    // 建完之后再换原型方法，已经绑好的那一颗不会经过 spy。
    const spy = vi.spyOn(EditorView.prototype, "dispatch");
    const s = mountedSurfaceWithThreeBlocks();
    s.setCollapseUnchanged(true);
    expect(s.foldRanges()).toHaveLength(2);
    const before = spy.mock.calls.length;
    s.syncBlocks();
    s.syncBlocks();
    const refolded = spy.mock.calls.slice(before).filter(([spec]) => {
      const effects = (spec as { effects?: unknown }).effects;
      const list = effects == null ? [] : Array.isArray(effects) ? effects : [effects];
      return list.some((e) => (e as { is?: (t: unknown) => boolean }).is?.(setFoldedRanges));
    });
    expect(refolded, "同一批折区 ⇒ 装饰集不换、折条 DOM 不重建").toHaveLength(0);
  });

  it("B461 · 太短的未改动区不折（<= 3 行 ⇒ 折了反而更难读）", () => {
    const shortGapsA = "1\n2\n3\n4\n5\n6\n7\n8\n9";
    const shortGapsB = "1A\n2\n3\n4B\n5\n6\n7\n8C\n9";
    const s = mountedSurface(shortGapsA, shortGapsB);
    expect(s.blocks(), "前置：两段未改动区各 2、3 行 ⇒ 都不够长").toHaveLength(3);
    s.collapseAllUnchanged();
    expect(s.foldRanges()).toEqual([]);
    // 反向闸：阈值那一头真的折得动（否则上面的 `toEqual([])` 是靠「什么都折不动」蒙过去的）
    const s2 = mountedSurfaceWithThreeBlocks();
    s2.collapseAllUnchanged();
    expect(s2.foldRanges()).toHaveLength(2);
  });

  it("B461 · 跳块前先展开目标所在的折区 ⇒ 落点不会落进被折起来的行里", () => {
    const s = mountedSurfaceWithThreeBlocks();
    s.setCollapseUnchanged(true);
    s.jumpTo(1);
    const landed = s.left.state.doc.lineAt(s.left.state.selection.main.head).number;
    expect(s.foldRanges().some((r) => r.from <= landed && landed <= r.to)).toBe(false);
    // 落点 32 在折区 36 之前，却在 28 + DIFF_REVEAL_LINES 之内 ⇒ 按简报的规则那一段必须一起摘掉，
    // 而后面那段照旧折着（不许「跳一次就全展开」）。
    expect(landed).toBe(32);
    expect(rangesOf(s)).toEqual([{ from: 36, to: 59 }]);
  });

  it("B461 · 点上方 4px 热区 = 揭示 DIFF_REVEAL_LINES 行（不整段展开，也不动插入符）", () => {
    const { surface: s } = mountSurfacePair(longRunsPair());
    s.collapseAllUnchanged();
    const runs = foldCandidates(s.blocks(), "original", {
      original: s.left.state.doc.lines,
      modified: s.left.state.doc.lines,
    });
    expect(runs, "现场：两段候选（94 行那一段与 24 行那一段），两侧行号重合").toEqual([
      { run: 6, start: 25, end: 118 },
      { run: 7, start: 126, end: 149 },
    ]);
    expect(rangesOf(s)).toEqual([
      { from: 25, to: 118 },
      { from: 126, to: 149 },
    ]);
    const caretBefore = caretLineOf(s.left);

    clickFoldZone(s, 0, "top");
    // 上方揭示 20 行 ⇒ 隐藏区起点从 25 挪到 45；下方那一段一点不跟着动。
    expect(rangesOf(s)).toEqual([
      { from: 45, to: 118 },
      { from: 126, to: 149 },
    ]);
    expect(foldBarText(s, 0), "文案跟着剩下的隐藏行数走").toBe("74 行未改动");
    expect(caretLineOf(s.left), "揭示不动插入符（上游 showMoreAbove 同口径）").toBe(caretBefore);
  });

  it("B461 · 点下方 4px 热区 = 从段尾收 DIFF_REVEAL_LINES 行", () => {
    const s = mountedSurfaceWithThreeBlocks();
    s.collapseAllUnchanged();
    clickFoldZone(s, 1, "bottom");
    expect(rangesOf(s)).toEqual([
      { from: 5, to: 28 },
      { from: 36, to: 39 },
    ]);
    expect(foldBarText(s, 1)).toBe("4 行未改动");
  });

  it("B461 · 揭示到把整段吃光 ⇒ 折条消失（上游 shouldHideControls）", () => {
    const s = mountedSurfaceWithThreeBlocks();
    s.collapseAllUnchanged();
    clickFoldZone(s, 0, "top");
    expect(rangesOf(s)[0]).toEqual({ from: 25, to: 28 });
    clickFoldZone(s, 0, "top");
    expect(caretLineOf(s.left), "段长 24 < 2 × 20 ⇒ 第二次直接夹到全开").toBe(1);
    expect(rangesOf(s)).toEqual([{ from: 36, to: 59 }]);
    expect(foldBarCount(s.left), "全开之后折条不再存在").toBe(1);
  });

  it("B461 · 中间双击 / unfold 图标 = 整段全开；另一段照旧折着", () => {
    const { surface: s } = mountSurfacePair(longRunsPair());
    s.collapseAllUnchanged();
    clickFoldIcon(s, 0);
    expect(rangesOf(s)).toEqual([{ from: 126, to: 149 }]);

    const other = mountedSurfaceWithThreeBlocks();
    other.collapseAllUnchanged();
    foldBarOf(other, 0)
      .querySelector(".diff-fold-text")!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(rangesOf(other)).toEqual([{ from: 36, to: 59 }]);
  });

  it("B461 · 拖拽按行高连续揭示（按住上方热区往下拖两行 = 揭示两行）", () => {
    const { surface: s } = mountSurfacePair(longRunsPair());
    s.collapseAllUnchanged();
    const strip = foldBarOf(s, 0).querySelector<HTMLElement>(".diff-fold-top")!;
    strip.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientY: 100 }),
    );
    const win = s.left.dom.ownerDocument.defaultView!;
    win.dispatchEvent(new MouseEvent("mousemove", { clientY: 140 }));
    win.dispatchEvent(new MouseEvent("mouseup", { clientY: 140 }));
    expect(rangesOf(s)[0], "2 行 × 20px ⇒ 起点 25 + 2").toEqual({ from: 27, to: 118 });
  });

  it("B461 · 点折条本体不动插入符、也不展开（编辑器不碰折条上的事件）", () => {
    const s = mountedSurfaceWithThreeBlocks();
    s.collapseAllUnchanged();
    const before = caretLineOf(s.left);
    const bar = foldBarOf(s, 0);
    bar.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    bar.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(caretLineOf(s.left), "插入符留在原处").toBe(before);
    expect(rangesOf(s), "单击中间不是揭示操作").toHaveLength(2);
  });

  it("B461 · 折条文案「N 行未改动」，N = 这一段此刻被折起来的行数", () => {
    const { surface: s, right } = mountSurfacePair({ left: THREE_LEFT, right: THREE_RIGHT });
    s.collapseAllUnchanged();
    const bars = [...s.left.contentDOM.querySelectorAll<HTMLElement>(".diff-fold-bar")];
    expect(bars).toHaveLength(2);
    for (const bar of bars) expect(bar.textContent).toBe("24 行未改动");
    expect(
      right.contentDOM.querySelectorAll(".diff-fold-bar"),
      "两栏都得有折条（各自那一列都点得开）",
    ).toHaveLength(2);
    // 折条带上游那颗 `unfold`（`renderLabelWithIcons('$(unfold)')`）—— 折叠块头不给 `+` / `−`：
    // 折起来的是两侧一字不差的未改动行，那两颗记号只属于差异行。
    for (const bar of bars) expect(bar.querySelector(".codicon-unfold")).not.toBeNull();
    // 折区由**一条替换装饰**整段替掉（不是 `display:none` 抹高，也不再逐行发 `Decoration.line`）。
    // 判边界：第 5 行行首到第 28 行行尾，CM6 的块表与行号槽用的是同一份几何。
    const fold = firstBlockWidget(s.left);
    expect(fold?.widget, "块头是 DiffFoldWidget").toBeInstanceOf(DiffFoldWidget);
    expect(
      fold?.widget.estimatedHeight,
      "折条也把 24px 交给高度表：默认 -1 会让视口外按一行估，跳过几段之后两栏就对不上",
    ).toBe(24);
    expect(fold?.block.from, "折区从第 5 行行首起").toBe(s.left.state.doc.line(5).from);
    expect(fold?.block.to, "到第 28 行行尾止").toBe(s.left.state.doc.line(28).to);
    expect(
      s.left.contentDOM.querySelector(".cm-line.diff-folded"),
      "display:none 那条补丁已删干净",
    ).toBeNull();
  });

  it("B461 · 两侧行轴不同 ⇒ 折区按 side 各换算一份（不许只算右栏）", () => {
    const leftText = ["甲", ...seq(1, 30, "未改"), "乙", ...seq(1, 30, "另笔")].join("\n");
    const rightText = [
      "甲一",
      "甲二",
      "甲三",
      ...seq(1, 30, "未改"),
      "乙改",
      ...seq(1, 30, "另笔"),
    ].join("\n");
    const { surface: s, right } = mountSurfacePair({ left: leftText, right: rightText });
    s.collapseAllUnchanged();
    // 首块在右栏占 3 行（左栏 1 行）⇒ 右栏的行号比左栏整体低 2 格：左栏折区 5..28 ⇒ 右栏 7..30
    expect(foldCandidates(s.blocks(), "original", { original: 62, modified: 64 })).toEqual([
      { run: 1, start: 5, end: 28 },
      // 末段贴文件尾 ⇒ 只留顶 3 行 context，折区一直折到末行（上游 atEnd 口径）
      { run: 2, start: 36, end: 62 },
    ]);
    expect(rangesOf(s), "读数是右栏行轴").toEqual([
      { from: 7, to: 30 },
      { from: 38, to: 64 },
    ]);
    // 同一行号在两栏的折叠态**不一样**（左栏第 5 行已经折进去，右栏那一行还是上下文）：
    // 这一条判的就是「各换算一份」，只算右栏的话左栏第 5 行会跟着右栏一起不折（画错一整段）。
    // 折区是替换装饰 ⇒ 直接读两栏各自的块区间，比数 DOM 行数稳（jsdom 没有布局）。
    const leftFold = firstFoldWidget(s.left);
    expect(leftFold?.block.from, "左栏行轴：第 5 行起折起来").toBe(s.left.state.doc.line(5).from);
    expect(leftFold?.block.to).toBe(s.left.state.doc.line(28).to);
    const rightFold = firstFoldWidget(right);
    expect(rightFold?.block.from, "右栏行轴：第 7 行才进折区").toBe(right.state.doc.line(7).from);
    expect(rightFold?.block.to).toBe(right.state.doc.line(30).to);
  });

  it("B461 · 右栏选区落进折区 ⇒ 那一段自己展开（被替换掉的行仍在文档里）", () => {
    const { surface: s, right } = mountSurfacePair({ left: THREE_LEFT, right: THREE_RIGHT });
    s.collapseAllUnchanged();
    expect(s.foldRanges()).toHaveLength(2);
    right.dispatch({ selection: { anchor: right.state.doc.line(10).from } });
    expect(rangesOf(s), "光标落到 5..28 那一段里 ⇒ 那一段摘掉，另一段不许被牵连").toEqual([
      { from: 36, to: 59 },
    ]);
  });

  it("B461 · 开关那两颗入口动手之前先看光标：光标落在未改动区里 ⇒ 那一段不许折（折区会盖掉光标）", () => {
    // 简报 Step 3 那条 ⚠️ 的第一路：翻开关**不动选区** ⇒ `selectionSet` 一辈子不响，而差异文件里
    // 未改动的行占绝大多数 ⇒ 「光标正停在那一段里」是最常见的落点，不是边角。
    const { surface: s, right } = mountSurfacePair({ left: THREE_LEFT, right: THREE_RIGHT });
    right.dispatch({ selection: { anchor: right.state.doc.line(10).from } });
    expect(caretLineOf(right), "前置：第 10 行落在候选 5..28 之内").toBe(10);
    expect(s.foldRanges(), "前置：开关还没开 ⇒ 一段都不折").toEqual([]);

    s.setCollapseUnchanged(true);
    expect(
      foldedRangesIn(right.state).some((r) => r.from <= 10 && 10 <= r.to),
      "光标那一行不许被折区替掉（屏上看不见的那一行正是光标所在）",
    ).toBe(false);
    expect(rangesOf(s), "另一段照旧折着（不许一翻开关就全展开）").toEqual([{ from: 36, to: 59 }]);

    // 第二颗入口（三颗动作里的 collapseAllUnchanged）同一条纪律：两棵入口都得补这一手。
    const pair2 = mountSurfacePair({ left: THREE_LEFT, right: THREE_RIGHT });
    pair2.right.dispatch({ selection: { anchor: pair2.right.state.doc.line(10).from } });
    pair2.surface.collapseAllUnchanged();
    expect(
      foldedRangesIn(pair2.right.state).some((r) => r.from <= 10 && 10 <= r.to),
      "collapseAllUnchanged 同样不许盖住光标那一行",
    ).toBe(false);
    expect(rangesOf(pair2.surface)).toEqual([{ from: 36, to: 59 }]);
  });

  it("B461 · 一发**只映射选区**的键入把折区压到光标上 ⇒ 也跟着展开（selectionSet 对键入是 false）", () => {
    // 简报 Step 3 那条 ⚠️ 的第二路：光标停在折区上面那格上下文行的行尾（看得见的一行），
    // 按 Delete 把折区第一行并上来 —— 折区起点被往上吸到光标那一行，而这一发事务只映射了
    // 选区（`selectionSet` 为 false），只听那一颗的兜底整条够不着。
    const { surface: s, right } = mountSurfacePair({ left: THREE_LEFT, right: THREE_RIGHT });
    s.collapseAllUnchanged();
    const at = right.state.doc.line(4).to;
    right.dispatch({ selection: { anchor: at } });
    expect(
      foldedRangesIn(right.state).some((r) => r.from <= 4 && 4 <= r.to),
      "前置：第 4 行是留出来的上下文行，看得见",
    ).toBe(false);

    right.dispatch({ changes: { from: at, to: right.state.doc.line(5).from } });
    expect(caretLineOf(right), "前置：并行之后的光标落在合并出来的第 4 行").toBe(4);
    expect(
      foldedRangesIn(right.state).some((r) => r.from <= 4 && 4 <= r.to),
      "折区被那一发键入压到光标那一行上 ⇒ 当场展开，不许留着一行看不见的光标",
    ).toBe(false);
    expect(rangesOf(s), "摘掉的只是压上来那一段，另一段照旧").toEqual([{ from: 36, to: 59 }]);
  });

  it("B461 · 键入之后、重算之前那一段里折条也点得开（点击不许被吞掉）", () => {
    // 折条带下来的 `from` 是**跟着改动映射过**的行号，而候选清单是按上一份块表算的 ⇒ 两者差的
    // 正是「上面插进去的那几行」。按行号精确比对 ⇒ `hit` 为 undefined ⇒ 点下去什么都不发生，
    // 而且不报错（防抖之后画法自己跟上，被吞掉的那一次点击却追不回来）。
    const { surface: s, right } = mountSurfacePair({ left: THREE_LEFT, right: THREE_RIGHT });
    s.collapseAllUnchanged();
    expect(s.foldRanges(), "前置：两段候选都折着").toHaveLength(2);
    right.dispatch({ changes: { from: 0, insert: "补一行\n" } });
    const bars = [...right.contentDOM.querySelectorAll<HTMLElement>(".diff-fold-bar")];
    expect(bars.length, "前置：右栏得画出折条").toBeGreaterThan(0);

    bars[0]
      .querySelector(".diff-fold-unfold")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(rangesOf(s), "点下去必须真展开那一段（行号差一行也算点的是那一段）").toHaveLength(1);
    expect(rangesOf(s)[0].from, "摘掉的是点下去那一段，留下的是另一段").toBeGreaterThanOrEqual(30);
  });

  it("B475 · 整段展开后行号区出现「折叠这一段」按钮；点它只折回这一段", () => {
    const { surface: s } = mountSurfacePair({ left: THREE_LEFT, right: THREE_RIGHT });
    s.collapseAllUnchanged();
    expect(
      s.left.dom.querySelectorAll(".cm-diffFold .diff-fold-toggle"),
      "两段都折着 ⇒ 行号区没有收起按钮（入口在折条自己的行号区那颗 unfold 上）",
    ).toHaveLength(0);

    clickFoldIcon(s, 0);
    expect(rangesOf(s), "前置：第一段整段展开，第二段照旧折着").toEqual([{ from: 36, to: 59 }]);
    const toggles = [...s.left.dom.querySelectorAll<HTMLElement>(".cm-diffFold .diff-fold-toggle")];
    expect(toggles, "展开的那一段在行号区挂一颗收起按钮（折着的那一段不挂）").toHaveLength(1);
    // 按钮落在**可折区首行**（行 5，裁掉贴边 context 之后真正收起来的第一行）：
    // 上游 glyph 挂的 `UnchangedRegion.originalLineNumber` 正是 `fromDiffs` 加过 context 偏移的值。
    expect(foldMarksIn(s.left.state)).toEqual([{ run: 1, line: 5 }]);

    toggles[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(rangesOf(s), "点下去只把这一段折回去，另一段不动").toEqual([
      { from: 5, to: 28 },
      { from: 36, to: 59 },
    ]);
    expect(
      s.left.dom.querySelectorAll(".cm-diffFold .diff-fold-toggle"),
      "收起之后按钮换回折条上的 unfold",
    ).toHaveLength(0);
  });

  it("B475 · 光标就在这一段里时，点行号区按钮先把它挪到最近的可见行再折", () => {
    const { surface: s, right } = mountSurfacePair({ left: THREE_LEFT, right: THREE_RIGHT });
    s.collapseAllUnchanged();
    clickFoldIcon(s, 0);
    // 光标停在可折区（5..28）里：第二段折着，不挡这一行
    right.dispatch({ selection: { anchor: right.state.doc.line(10).from } });
    const toggles = [...right.dom.querySelectorAll<HTMLElement>(".cm-diffFold .diff-fold-toggle")];
    expect(toggles, "前置：这一段整段展开后在行号区挂了收起按钮").toHaveLength(1);

    toggles[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(rangesOf(s), "点了就真折（不许因为光标在里面而原地不动）").toEqual([
      { from: 5, to: 28 },
      { from: 36, to: 59 },
    ]);
    expect(
      right.state.doc.lineAt(right.state.selection.main.head).number,
      "光标挪到最近的可见行（行 10 离 4 比离 29 近）",
    ).toBe(4);
  });

  it("B475 · 折条的行号区那颗 unfold 是真按钮；折条底色往左铺满行号区", () => {
    const { surface: s } = mountSurfacePair({ left: THREE_LEFT, right: THREE_RIGHT });
    const gutter = s.left.scrollDOM.querySelector<HTMLElement>(".cm-gutters-before");
    expect(gutter, "前置：左栏有行号那一列").not.toBeNull();
    vi.spyOn(gutter!, "getBoundingClientRect").mockReturnValue({ width: 42 } as DOMRect);
    s.collapseAllUnchanged();

    const bar = foldBarOf(s, 0);
    expect(
      bar.querySelector(".diff-fold-center .diff-fold-unfold"),
      "展开图标不许再挤在文案中间（上游 .first / .others 是两块）",
    ).toBeNull();
    expect(
      bar.querySelector(":scope > .diff-fold-unfold"),
      "它得是折条的直接子元素",
    ).not.toBeNull();
    expect(
      bar.style.getPropertyValue("--diff-fold-gutter"),
      "量到的行号区宽度写进自定义属性（折条底色与按钮都吃它）",
    ).toBe("42px");

    const css = (): string => stripCssComments(srcOf("src/diff/diff.css"));
    const extend = ruleBlock(css(), ".panel-host.is-diff .diff-fold-bar::before", undefined, true);
    expect(extend, "往左铺底那条规则得真在").not.toBe("");
    expect(extend).toContain("left: calc(-1 * var(--diff-fold-gutter, 0px))");
    expect(extend, "底色与折条本体同一颗 token（整行同色）").toContain(
      "background: var(--diff-unchanged-bg)",
    );
    expect(extend, "高过 CM6 `.cm-gutters` 的 z-index 200，否则行号区压在上面").toMatch(
      /z-index:\s*201/,
    );
    const unfold = ruleBlock(css(), ".panel-host.is-diff .diff-fold-unfold", undefined, true);
    expect(unfold, "按钮绝对定位进行号区").toContain("position: absolute");
    expect(unfold).toContain("width: var(--diff-fold-gutter, 0px)");
    expect(unfold, "压过折条自己的 gutter 底色").toMatch(/z-index:\s*202/);
    const toggle = ruleBlock(
      css(),
      ".panel-host.is-diff .cm-diffFold .diff-fold-toggle",
      undefined,
      true,
    );
    expect(toggle, "行号区那颗收起按钮的样式得真在").not.toBe("");
    expect(toggle).toContain("width: 16px");
    expect(toggle).toContain("cursor: pointer");
  });

  it("B475 · 收起按钮列在行号左边（glyph margin 位，与上游 fold-unchanged 同层）", () => {
    // 上游把 `fold-unchanged` 挂进 glyph margin（`EditorLayoutInfo` 的 glyphMarginLeft，
    // 行号左边）；CM6 的 gutter 次序按扩展优先级排 ⇒ 折叠列必须是 `.cm-gutters-before` 的第一列。
    const { surface: s } = mountSurfacePair({ left: THREE_LEFT, right: THREE_RIGHT });
    s.collapseAllUnchanged();
    clickFoldIcon(s, 0);
    const gutter = s.left.scrollDOM.querySelector<HTMLElement>(".cm-gutters-before");
    expect(gutter, "前置：左栏有 gutter 容器").not.toBeNull();
    expect(
      gutter!.querySelector(".cm-diffFold .diff-fold-toggle"),
      "前置：按钮挂在折叠列里",
    ).not.toBeNull();
    const cols = [...gutter!.children].map((el) => el.className);
    const at = (name: string): number => cols.findIndex((c) => c.includes(name));
    expect(at("cm-diffFold"), "折叠列在 DOM 里").toBeGreaterThanOrEqual(0);
    expect(at("cm-lineNumbers"), "行号列在 DOM 里").toBeGreaterThanOrEqual(0);
    expect(at("cm-diffSigns"), "记号列在 DOM 里").toBeGreaterThanOrEqual(0);
    expect(at("cm-diffFold"), "按钮列在行号左边").toBeLessThan(at("cm-lineNumbers"));
    expect(at("cm-lineNumbers"), "记号列仍排在行号右边（顺带钉住原有次序）").toBeLessThan(
      at("cm-diffSigns"),
    );
  });

  it("B461 · 键入期折叠装饰只跟着改动映射、不逐键重建（face.ts 文件头那条纪律对折叠一样成立）", () => {
    // `diffFaceField` 守的是「键入期只 `value.map(tr.changes)`」；折叠那一臂原先每键都要
    // `buildFoldFace` / `buildFoldGutter`，那是**每键 O(折起来的行数)** 次 `Decoration.line`
    // 分配。现在每段折区只有一条替换装饰（外加一颗 widget），键入期仍只映射、不重建。
    // 判据落在「同一颗 widget 实例 / 同一条折条 DOM」上：逐键重建就换实例、就重画 DOM。
    const { surface: s, right } = mountSurfacePair({ left: THREE_LEFT, right: THREE_RIGHT });
    s.collapseAllUnchanged();
    const barBefore = right.contentDOM.querySelector<HTMLElement>(".diff-fold-bar");
    const widgetBefore = firstBlockWidget(right);
    expect(barBefore, "现场：右栏得画出折条").not.toBeNull();
    expect(widgetBefore?.widget, "现场：那条折条是 DiffFoldWidget").toBeInstanceOf(DiffFoldWidget);

    right.dispatch({ changes: { from: 0, insert: "补一行\n" } });
    const barAfter = right.contentDOM.querySelector<HTMLElement>(".diff-fold-bar");
    expect(barAfter, "映射之后折条照旧在（跟着改动走，不是没画）").not.toBeNull();
    expect(barAfter, "同一颗 DOM：装饰集由 CM6 跟着改动映射 ⇒ 不逐键重建 widget 与行装饰").toBe(
      barBefore,
    );
    expect(firstBlockWidget(right)?.widget, "同一颗 widget 实例：重建才会换实例").toBe(
      widgetBefore?.widget,
    );
  });

  it("B461 · 拆旁路把折叠一起带走（底色那一条纪律同形：既有的 view 不许留着折区替换）", () => {
    const { surface: s, right } = mountSurfacePair({ left: THREE_LEFT, right: THREE_RIGHT });
    s.collapseAllUnchanged();
    expect(foldedRangesIn(right.state), "前置：两段都折在这一臂里").toHaveLength(2);
    expect(right.contentDOM.querySelectorAll(".diff-fold-bar").length).toBeGreaterThan(0);
    s.dispose();
    expect(foldedRangesIn(right.state), "拆臂之后不留折叠态").toEqual([]);
    expect(right.contentDOM.querySelectorAll(".diff-fold-bar")).toHaveLength(0);
    expect(right.contentDOM.querySelectorAll(".diff-folded")).toHaveLength(0);
    expect(s.foldRanges()).toEqual([]);
  });

  it("B461 · 折叠只走既有那一臂、与 settings 无关（第二颗 Compartment 与用户默认都不许有）", () => {
    // 折叠态要进右栏那颗**既有的** view，只能靠 `diffFace` 那一臂里的 StateEffect：再
    // `appendConfig` 一颗新槽就是把 Task 5 抓过的「上一臂的 provider 还活着」那一场病重新埋回来。
    const code = stripLineComments(srcOf("src/diff/surface.ts"));
    expect(
      code.match(/appendConfig\.of\(/g) ?? [],
      "全文件只许那颗共用槽的 appendConfig（JSDoc 里提它不算一发调用）",
    ).toHaveLength(1);
    expect(code, "本轮不做用户默认 ⇒ 开关不进设置那一格（也不进那颗模块）").not.toMatch(
      /from "\.\.\/prefs"|persistSettings/,
    );
    const face = stripLineComments(srcOf("src/diff/face.ts"));
    expect(face, "折叠态是 StateEffect ⇒ 才能骑在同一臂上进既有 view").toContain(
      "setFoldedRanges = StateEffect.define",
    );
  });

  it("B461 · 折叠态骑在 diffFace 那一臂上：一发 setFoldedRanges 就有一条替换与折条（不另开一臂）", () => {
    // 单独装的那一臂**没带**折条出口（出口只有 surface 那一处挂）⇒ 点下去空转，
    // 装饰层自己不许把折叠态摘掉（那才是第二份真相）。
    const { view } = mountFace("modified", [], "A\n1\n2\n3\n4\nB");
    expect(view.contentDOM.querySelectorAll(".diff-fold-bar")).toHaveLength(0);
    view.dispatch({
      effects: setFoldedRanges.of([{ from: 2, to: 4, top: 0, bottom: 0, regionLength: 3 }]),
    });
    const bars = [...view.contentDOM.querySelectorAll<HTMLElement>(".diff-fold-bar")];
    expect(bars).toHaveLength(1);
    expect(bars[0].textContent).toBe("3 行未改动");
    expect(bars[0].style.height, "折条 24px 高（上游 PlaceholderViewZone(d, 24)）").toBe("24px");
    // 一条替换装饰覆盖 2..4 三行（含端点）：第 5 行不在折区里。
    const fold = firstBlockWidget(view);
    expect(fold?.block.from).toBe(view.state.doc.line(2).from);
    expect(fold?.block.to).toBe(view.state.doc.line(4).to);
    expect(fold?.block.to, "含端点：折区到第 4 行行尾为止，第 5 行仍在").toBeLessThan(
      view.state.doc.line(5).from,
    );
    // 被折掉的三行整段不进 DOM（不是抹成 0 高）；剩下的行照旧一行一格，不夹空行。
    expect(
      [...view.contentDOM.querySelectorAll(".cm-line")].map((el) => el.textContent),
      "折区那几行整段收起",
    ).toEqual(["A", "4", "B"]);
    bars[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(
      view.contentDOM.querySelectorAll(".diff-fold-bar"),
      "没有出口就什么都不改（不许装饰层自己拿一份折叠态）",
    ).toHaveLength(1);
  });

  it("B461 · 折叠不许改左栏那颗文档（硬只读那道闸不因为折叠松动）", () => {
    const s = mountedSurfaceWithThreeBlocks();
    s.collapseAllUnchanged();
    const before = s.left.state.doc.toString();
    s.left.dispatch({ changes: { from: 0, insert: "X" } });
    expect(s.left.state.doc.toString(), "折起来的是**画法**，不是删掉的行").toBe(before);
  });
});

describe("B461 · 折条样式（Task 7 追加那一段）", () => {
  const code = (): string => stripCssComments(srcOf("src/diff/diff.css"));
  /**
   * Task 7 那一段：从 `.diff-fold-bar` 起到右缘概览条之前（Task 3 的 token 清单由另一条判，
   * 概览条是相对滚动条、天然吃 `--diff-*`，两段不能一锅端）。
   */
  const foldSection = (): string => {
    const s = code();
    const at = s.indexOf(".diff-fold-bar");
    if (at < 0) return "";
    // 注释在 `stripCssComments` 里已经没了 ⇒ 用选择器当界桩（概览条那段天然吃 `--diff-*`）。
    const end = s.indexOf(".panel-host.is-diff .diff-overview", at);
    return end < 0 ? s.slice(at) : s.slice(at, end);
  };

  it("B461 · 折条色照上游 unchangedRegion 三颗；一个裸十六进制都不许有，也不许借第四颗 diff 色", () => {
    const s = foldSection();
    expect(s, "锚点规则得真在（截空了后面的判据全是假绿）").not.toBe("");
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(
      s,
      "折不折是外壳态 ⇒ 只许吃 `unchangedRegion*` 与 hover 的 accent，不许吃差异色",
    ).not.toMatch(/--diff-(line|char|overview|diagonal|revert)-/);
    expect(s, "也不许借 --warn / --danger").not.toMatch(/--(warn|danger)\b/);
    const tokens = new Set([...s.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
    expect([...tokens].sort()).toEqual([
      "--accent",
      // 折条往行号区铺底、行号区那颗展开按钮定位都吃这一颗：不是主题色，是 `toDOM`
      // 现量出来的 gutter 宽（`--diff-fold-gutter`），不参与「折条只许吃哪几颗色」。
      "--diff-fold-gutter",
      "--diff-unchanged-bg",
      "--diff-unchanged-fg",
      "--diff-unchanged-shadow",
    ]);
    const root = ruleBlock(code(), ":root", undefined, true);
    expect(root, "背景 = sideBar.background（上游 unchangedRegionBackground）").toContain(
      "--diff-unchanged-bg: var(--sidebar-bg)",
    );
    expect(root, "前景 = foreground（上游 unchangedRegionForeground）").toContain(
      "--diff-unchanged-fg: var(--fg)",
    );
    const light = ruleBlock(code(), ':root[data-theme="light"]', undefined, true);
    expect(light, "亮档阴影上游取 #737373BF").toContain("--diff-unchanged-shadow: #737373bf");
  });

  it("B461 · 折条 24px 高 + 上下各 4px 揭示热区；样式段不钉高度、不添竖向留白、不吃 em", () => {
    const bar = ruleBlock(code(), ".panel-host.is-diff .diff-fold-bar");
    expect(bar, "规则得真在（判不到东西的 not.toMatch 是假绿）").not.toBe("");
    expect(bar).not.toMatch(/(^|[\s;{])(margin|padding)(-top|-bottom)?\s*:/);
    expect(bar).not.toMatch(/\d*\.?\d+em\b/);
    expect(bar, "高度是 widget 按上游 24px 写 inline 的（R15/R18 同一条纪律）").not.toMatch(
      /height\s*:/,
    );
    expect(bar, "折条本体不是可点的整块（点的是上下热区与图标）").not.toContain("cursor");

    expect(foldSection(), "4px 揭示热区 + 竖向缩放游标（上游 canMoveTop/Bottom 同口径）").toMatch(
      /\.diff-fold-top,\s*\.panel-host\.is-diff \.diff-fold-bottom\s*\{[^}]*height:\s*4px[^}]*cursor:\s*ns-resize/,
    );
    expect(code(), "热区悬停 / 拖拽时铺 focusBorder").toMatch(
      /\.diff-fold-top:hover[^{]*\{[^}]*background:\s*var\(--accent\)/,
    );
  });

  it("B461 · 折叠不再有 display:none 补丁：被折掉的行由替换装饰整段收走", () => {
    const s = foldSection();
    expect(s, "旧的行抹除与 gutter 抹除两条补丁都已删").not.toContain("diff-folded");
    expect(s, "也不许把行高抹成 0（CM6 的块几何会与行号槽错位）").not.toContain("display: none");
    expect(s, "折条是这一段唯一的常驻元素").toContain(".diff-fold-bar");
    const face = stripLineComments(srcOf("src/diff/face.ts"));
    expect(face, "折区走 CM6 的替换装饰（block 装饰只能来自 StateField）").toContain(
      "Decoration.replace({",
    );
    expect(face, "同一条装饰替掉行与行号槽 ⇒ 不会再错一行").toContain("block: true");
    expect(face, "旧的逐行抹除与 gutter 补丁已清干净").not.toMatch(
      /buildFoldGutter|FoldGutterMarker|diff-folded/,
    );
  });
});

describe("B464 · 右缘概览的标记层（选区/光标/查找命中/同词出现）", () => {
  const css = (): string => stripCssComments(srcOf("src/diff/diff.css"));

  it("两列各一颗常驻画布：色块重画不许把它一起清掉", () => {
    const { panel, surface } = mountSurfacePair();
    const host = panel.bodyEl!;
    const rulers = [...host.querySelectorAll<HTMLElement>(".diff-overview-ruler")];
    expect(rulers).toHaveLength(2);
    for (const ruler of rulers) {
      expect(ruler.querySelector(".diff-overview-canvas"), "每列一颗标记画布").not.toBeNull();
    }
    surface.syncBlocks();
    for (const ruler of rulers) {
      expect(ruler.querySelector(".diff-overview-canvas"), "重画后画布还在").not.toBeNull();
    }
    // 差异色块照旧是 DOM 那几颗（画布只叠在上面，不接管它们）
    expect(rulers[0].querySelectorAll(".diff-overview-mark").length).toBeGreaterThan(0);
  });

  it("差异实例的右栏不再挂普通编辑器那层（否则新稿栏里会多出一条盖住正文的列）", () => {
    const { right } = mountSurfacePair();
    expect(right.dom.querySelector(".cm-overview-ruler")).toBeNull();
  });

  it("层级三层：差异色块 → 标记画布（z-index 1）→ 视口滑块（z-index 10）", () => {
    const canvas = ruleBlock(css(), ".panel-host.is-diff .diff-overview-canvas", undefined, true);
    expect(canvas, "规则得真在").not.toBe("");
    expect(canvas).toContain("z-index: 1");
    expect(canvas).toContain("pointer-events: none");

    const viewport = ruleBlock(css(), ".panel-host.is-diff .diff-viewport", undefined, true);
    expect(viewport, "滑块永远最上层").toContain("z-index: 10");

    const mark = ruleBlock(css(), ".panel-host.is-diff .diff-overview-mark", undefined, true);
    expect(mark, "色块不自己开叠层 ⇒ 画布那层 1 就压得住").not.toContain("z-index");
  });
});

describe("B461 · 行内字符级差异的装饰与样式", () => {
  const css = (): string => stripCssComments(srcOf("src/diff/diff.css"));

  it("新稿侧只把改动的字符包进 .diff-char-insert（行底色照旧在）", () => {
    const blocks = diffBlocks("const value = old;", "const value = new;");
    const m = mountFace("modified", blocks, "const value = new;", {
      original: [{ line: 1, from: 14, to: 17 }],
      modified: [{ line: 1, from: 14, to: 17 }],
    });
    const span = m.view.contentDOM.querySelector<HTMLElement>(".diff-char-insert");
    expect(span?.textContent, "字符级只盖真正变了的那几个字符").toBe("new");
    expect(m.lineEl(1).className, "整行底色是外面那一层，不因为字符级标记而消失").toContain(
      "diff-line-insert",
    );
  });

  it("原稿侧用 .diff-char-delete，只盖删掉的字符", () => {
    const blocks = diffBlocks("const value = old;", "const value = new;");
    const o = mountFace("original", blocks, "const value = old;", {
      original: [{ line: 1, from: 14, to: 17 }],
      modified: [{ line: 1, from: 14, to: 17 }],
    });
    expect(o.view.contentDOM.querySelector<HTMLElement>(".diff-char-delete")?.textContent).toBe(
      "old",
    );
  });

  it("行内底色比整行更深：字符层叠在行底色之上，两层各吃上游对应的那一颗 key", () => {
    const insert = ruleBlock(css(), ".panel-host.is-diff .diff-char-insert", undefined, true);
    expect(insert, "规则得真在").toContain("var(--diff-char-add)");
    const del = ruleBlock(css(), ".panel-host.is-diff .diff-char-delete", undefined, true);
    expect(del).toContain("var(--diff-char-del)");
    // 行底色与字符底色是上游四个不同的 key（`editorColors.ts`），不是把行色再调深一档；
    // 两层都是带 alpha 的 background，叠出来的更深一档由 alpha 合成给出。
    expect(insert + del).not.toContain("--diff-line-");
    expect(insert + del).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("纯插入行整行包进 .diff-char-insert（上游 diffWholeLineAddDecoration）", () => {
    const blocks = diffBlocks("A\nZ", "A\nnew\nZ");
    const m = mountFace("modified", blocks, "A\nnew\nZ", {
      original: [],
      modified: [{ line: 2, from: 0, to: 3 }],
    });
    const span = m.view.contentDOM.querySelector<HTMLElement>(".diff-char-insert");
    expect(span?.textContent, "整行字符层盖满这一行的正文").toBe("new");
    expect(m.lineEl(2).className, "行底色那一层照旧在").toContain("diff-line-insert");
  });

  it("内联改动为空的那一侧画 diff-range-empty 细条（行内 widget，零长区间）", () => {
    const blocks = diffBlocks("A\nabc\nZ", "A\nabXc\nZ");
    // 原稿侧：这一侧没有字符被改（零长），细条在「删」色上；改稿侧覆盖真正插入的 X。
    const o = mountFace("original", blocks, "A\nabc\nZ", {
      original: [{ line: 2, from: 2, to: 2 }],
      modified: [{ line: 2, from: 2, to: 3 }],
    });
    const delBar = o.view.contentDOM.querySelector<HTMLElement>(".diff-range-empty");
    expect(delBar, "原稿侧的零长落点要画出来").not.toBeNull();
    expect(delBar!.className).toContain("diff-char-delete");
    expect(delBar!.getAttribute("aria-hidden"), "纯装饰，不进无障碍树").toBe("true");
    expect(o.view.contentDOM.querySelector(".diff-char-delete:not(.diff-range-empty)")).toBeNull();

    // 反向：原稿多出 X 时，空的那一侧是改稿，细条换成「增」色。
    const m = mountFace("modified", blocks, "A\nabXc\nZ", {
      original: [{ line: 2, from: 2, to: 3 }],
      modified: [{ line: 2, from: 2, to: 2 }],
    });
    const insBar = m.view.contentDOM.querySelector<HTMLElement>(".diff-range-empty");
    expect(insBar, "改稿侧的零长落点要画出来").not.toBeNull();
    expect(insBar!.className).toContain("diff-char-insert");
  });

  it("diff-range-empty 的几何照上游：3px 左边框、删除侧 margin-left: -1px（净 2px）", () => {
    const insert = ruleBlock(
      css(),
      ".panel-host.is-diff .diff-char-insert.diff-range-empty",
      undefined,
      true,
    );
    expect(insert, "规则得真在").toContain("border-left: 3px solid var(--diff-char-add)");
    const del = ruleBlock(
      css(),
      ".panel-host.is-diff .diff-char-delete.diff-range-empty",
      undefined,
      true,
    );
    expect(del).toContain("border-left: 3px solid var(--diff-char-del)");
    expect(del, "删除侧负外边距（上游同款）").toContain("margin-left: -1px");
  });
});

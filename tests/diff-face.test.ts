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
//   2) 装到 view 上的那一臂（`diffFace`）：行装饰 + 块 widget + 行号槽底色与记号。
//   3) 样式段（`src/diff/diff.css`）：差异色只吃 `--diff-add` / `--diff-del`
//      （VS Code 的分侧语义没有「修改行」），这一段里一个裸十六进制都不许出现。
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
import { diffBlocks, type DiffBlock } from "../src/diff/blocks";
import type { DiffSide, DiffSpec } from "../src/diff/model";
import { DIFF_REFRESH_MS } from "../src/diff/align";
import {
  DIFF_CONTEXT_LINES,
  DIFF_MIN_UNCHANGED_LINES,
  DIFF_REVEAL_LINES,
  DiffFoldWidget,
  DiffGapWidget,
  diffFace,
  foldCandidates,
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
function zonesOf(blocks: DiffBlock[], side: DiffSide, docLines: number): GapZone[] {
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
  return gapZones(blocks, totals, uniformHeight)[side];
}

describe("B461 · sideLineMarks / gapZones：一块在两栏各落在哪些行", () => {
  it("B461 · 删除块：左栏标真行，右栏在 A 之后补 2 行空位", () => {
    expect(sideLineMarks(del, "original")).toEqual([
      { line: 2, kind: "delete" },
      { line: 3, kind: "delete" },
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
    // head=1；中段无 LCS 锚点 ⇒ 一个区 (aLen 2, bLen 1)；alignOffset 挑 o=1（丁后行 ↔ 丁后行改了 最像）
    // ⇒ 配对窗口吃掉 a 的第 2 行，多出来的 a 行（绝对第 2 行）在窗口**之前**被删
    const mixed = diffBlocks("丙一去\n丙一去\n丁后行", "丙一去\n丁后行改了");
    expect(zonesOf(mixed, "modified", 2)).toEqual([{ afterLine: 1, height: LINE_HEIGHT }]);
    expect(sideLineMarks(mixed, "original"), "改 = 先删：左栏两行都是删除色").toEqual([
      { line: 2, kind: "delete" },
      { line: 3, kind: "delete" },
    ]);
    expect(sideLineMarks(mixed, "modified"), "改 = 再增：右栏这一行是新增色").toEqual([
      { line: 2, kind: "insert" },
    ]);
  });

  it("B462 · 配对窗口两头都多出行 ⇒ 前后各一段空位，按 afterLine 升序（两侧都按删除/新增上色）", () => {
    // 基线 [x, B中, y] vs 当前 [B改了]：相似错位挑 o=1 ⇒ B中 ↔ B改了 配对，
    // x 落在窗口之前、y 落在窗口之后 ⇒ 右栏要在第 1 行之后与第 2 行之后各补一行。
    const both = diffBlocks("A\nx\nB中\ny\nC", "A\nB改了\nC");
    expect(sideLineMarks(both, "original")).toEqual([
      { line: 2, kind: "delete" },
      { line: 3, kind: "delete" },
      { line: 4, kind: "delete" },
    ]);
    expect(sideLineMarks(both, "modified")).toEqual([{ line: 2, kind: "insert" }]);
    expect(zonesOf(both, "modified", 3)).toEqual([
      { afterLine: 1, height: LINE_HEIGHT },
      { afterLine: 2, height: LINE_HEIGHT },
    ]);
    // 多的一侧（左栏）自己不必补位
    expect(zonesOf(both, "original", 5)).toEqual([]);
  });

  it("B462 · 当前比基线长的改块：左栏按同样的口径补位（缝在配对窗口之后）", () => {
    const grow = diffBlocks("A\nB\nC", "A\nB1\nB2\nC");
    expect(sideLineMarks(grow, "original")).toEqual([{ line: 2, kind: "delete" }]);
    expect(sideLineMarks(grow, "modified")).toEqual([
      { line: 2, kind: "insert" },
      { line: 3, kind: "insert" },
    ]);
    expect(zonesOf(grow, "original", 3)).toEqual([{ afterLine: 2, height: LINE_HEIGHT }]);
    expect(zonesOf(grow, "modified", 4)).toEqual([]);
  });

  it("B462 · 折行：缝高按实测像素，不按行数乘默认行高", () => {
    const wrapDel = diffBlocks("A\nB\nC", "A\nC");
    // 左栏第 2 行折成两个视觉行（2 × 行高），右栏在同高度上只有一行。
    const heightOf = (side: DiffSide, line: number): number =>
      side === "original" && line === 2 ? 2 * LINE_HEIGHT : LINE_HEIGHT;
    expect(gapZones(wrapDel, { original: 3, modified: 2 }, heightOf).modified).toEqual([
      { afterLine: 1, height: 2 * LINE_HEIGHT },
    ]);
  });

  it("B462 · 未改动区也逐行对齐：两栏宽度不同，同一行折出的视觉行数不等就补缝", () => {
    // 两侧正文一致（没有差异块），左栏第 2 行折成两个视觉行。
    const same = diffBlocks("A\nB\nC", "A\nB\nC");
    const heightOf = (side: DiffSide, line: number): number =>
      side === "original" && line === 2 ? 2 * LINE_HEIGHT : LINE_HEIGHT;
    const zones = gapZones(same, { original: 3, modified: 3 }, heightOf);
    expect(zones.original).toEqual([]);
    expect(zones.modified).toEqual([{ afterLine: 2, height: LINE_HEIGHT }]);
  });

  it("B463 · 块内逐行配对：窗口外多出的行整段补到对侧，窗口内每一对各补自己的折行差", () => {
    // 左 4 行（2..5）vs 右 2 行（2..3），offset 1 ⇒ 窗口 左3↔右2、左4↔右3；
    // 左 2 与左 5 没人配。左 3 折成两个视觉行（40），窗口第一对就得补 20。
    const b: DiffBlock = {
      kind: "modify",
      originalStart: 2,
      originalEnd: 5,
      modifiedStart: 2,
      modifiedEnd: 3,
      added: 0,
      removed: 2,
      offset: 1,
    };
    const heightOf = (side: DiffSide, line: number): number =>
      side === "original" && line === 3 ? 2 * LINE_HEIGHT : LINE_HEIGHT;
    const zones = gapZones([b], { original: 6, modified: 4 }, heightOf);
    expect(zones.modified, "窗口前的左2、窗口内左3的折行、窗口后的左5 各一笔").toEqual([
      { afterLine: 1, height: LINE_HEIGHT },
      { afterLine: 2, height: LINE_HEIGHT },
      { afterLine: 3, height: LINE_HEIGHT },
    ]);
    expect(zones.original, "多的一侧自己不补位").toEqual([]);
  });

  it("B463 · 右栏是长的一侧：窗口前后的多余行与折行差都补到左栏", () => {
    // 左 2 行（2..3）vs 右 4 行（2..5），offset 1 ⇒ 窗口 左2↔右3、左3↔右4；
    // 右 2 与右 5 没人配。右 4 折成两个视觉行 ⇒ 窗口第二对补到左栏。
    const b: DiffBlock = {
      kind: "modify",
      originalStart: 2,
      originalEnd: 3,
      modifiedStart: 2,
      modifiedEnd: 5,
      added: 2,
      removed: 0,
      offset: 1,
    };
    const heightOf = (side: DiffSide, line: number): number =>
      side === "modified" && line === 4 ? 2 * LINE_HEIGHT : LINE_HEIGHT;
    const zones = gapZones([b], { original: 4, modified: 6 }, heightOf);
    // 窗口第二对（右4 折成 40）与窗口后的右5 都落在「原稿第 3 行之后」⇒ 两笔合并。
    expect(zones.original).toEqual([
      { afterLine: 1, height: LINE_HEIGHT },
      { afterLine: 3, height: 2 * LINE_HEIGHT },
    ]);
    expect(zones.modified).toEqual([]);
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
): { view: EditorView; lineEl: (n: number) => HTMLElement; gapEls: () => HTMLElement[] } {
  const provider = typeof blocks === "function" ? blocks : () => blocks;
  let view: EditorView | null = null;
  // 缝与块同一颗读取口（生产里由 surface 交出来）；这里按固定行高现算，
  // 于是「refreshDiff 之后重算」测的仍是同一份输入口径。
  // 行数取**当前**文档（键入之后块表按新文档重算），首建时 view 还没赋值，退回初始行数。
  const source = () => {
    const list = provider();
    const lines = view ? view.state.doc.lines : doc.split("\n").length;
    return { blocks: list, gaps: zonesOf(list, side, lines) };
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
      "占位块 = 中性斜纹 + 本侧方向类（行号槽色条用）",
    ).toBe("diff-gap diff-gap-insert");
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
  });

  it("B462 · 左栏删行涂真行底色 + 行号槽底色 + Codicon `−` 记号（照 VS Code，不再有中线指示带）", () => {
    const { view, lineEl, gapEls } = mountFace("original", del);
    expect(gapEls(), "删掉的行在左栏是**真行** ⇒ 这一侧不补位").toHaveLength(0);
    expect(lineEl(1).className).not.toContain("diff-line");
    expect(lineEl(2).className).toContain("diff-line-delete");
    expect(lineEl(3).className).toContain("diff-line-delete");
    expect(lineEl(2).className, "VS Code 没有块头横条这一层").not.toContain("diff-edge-top");
    // 行号槽：VS Code 的 marginClassName（gutter-delete）+ delete-sign（Codicon.remove）。
    expect(
      view.dom.querySelectorAll(".cm-diffSigns .cm-gutterElement.diff-gutter-delete"),
      "两行删除行各有一格带底色类",
    ).toHaveLength(2);
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

  it("B461 · 配对窗口两头都有空位 ⇒ 插两块 widget，各占自己那一行的高度", () => {
    const both = diffBlocks("A\nx\nB中\ny\nC", "A\nB改了\nC");
    const { view, lineEl, gapEls } = mountFace("modified", both, "A\nB改了\nC");
    expect(gapEls()).toHaveLength(2);
    expect(rowOrder(view), "缝一段在配对窗口之前、一段之后").toEqual([
      "line",
      "gap",
      "line",
      "gap",
      "line",
    ]);
    expect(gapEls()[0].style.height).toBe(`${LINE_HEIGHT}px`);
    expect(gapEls()[1].style.height).toBe(`${LINE_HEIGHT}px`);
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
    const { left, right } = mountHost();
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

  it("B461 · 折行默认关（VS Code 差异格的出厂态），开关两栏一起开、detach 原样还", () => {
    // 历史：R19 曾把「一律不折」写死，理由是两侧行行对齐。后续轮按用户点名补了开关，
    // **默认仍是关**（VS Code 的 `diffEditor.wordWrap` 默认 inherit → `editor.wordWrap` 出厂 off），
    // 于是「不折行才严格逐行对齐」的默认行为没变；打开折行是用户显式选择的取舍。
    // ⚠️ 「同一行在两栏的视觉 y 是否真的一致」是**像素**判据，jsdom 没有布局引擎 ⇒ 归真机台。
    // 这里钉的是「扩展在不在 state 里」—— 它恰恰是那条像素等式的前提。
    const { right, left, surface, initialState } = mountSurfacePair();
    expect(
      wrapsLines(initialState),
      "前置：出厂 `word_wrap: true` ⇒ 那颗初始 state 确实装了折行",
    ).toBe(true);
    expect(wrapsLines(right.state), "挂上旁路那一刻，右栏的折行被关掉").toBe(false);
    expect(wrapsLines(left.state), "左栏同样从「不折」起步").toBe(false);

    surface.setWrapEnabled(true);
    expect(wrapsLines(right.state), "开关打开 ⇒ 右栏折").toBe(true);
    expect(wrapsLines(left.state), "开关打开 ⇒ 左栏一起折（两栏同口径）").toBe(true);
    surface.setWrapEnabled(false);
    expect(wrapsLines(right.state)).toBe(false);
    expect(wrapsLines(left.state)).toBe(false);

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
    btn!.click();
    expect(right.state.doc.toString(), "原稿那两行被写回新稿").toBe("A\n删1\n删2\nZ");
  });

  it("B461 · 还原的是「用户那一颗设置」，不是无条件打开（设置里就关着的用户）", () => {
    // 裁决 R23-1（Task 3 评审抓出、Task 5 落地）把还值的权威从「attach 时 view 里的现值」换成
    // **设置**那一颗：`switchTab` 切出时会把「差异格强制关掉」的那一发回写进标签快照，读现值就会
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

  it("B462 · 右栏行号槽也吃到同一份 gutter 底色类（左右各按自己那一侧）", () => {
    const { left, right } = mountSurfacePair();
    expect(
      left.dom.querySelectorAll(".cm-lineNumbers .cm-gutterElement.diff-gutter-delete"),
    ).toHaveLength(2);
    expect(
      right.dom.querySelectorAll(".cm-lineNumbers .cm-gutterElement.diff-gutter-insert"),
      "右栏这一侧没有真行 ⇒ 没有新增色格",
    ).toHaveLength(0);
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

  it("B462 · 这一段一个裸十六进制都不许有，差异色只走 add / del 两颗 token", () => {
    const s = section();
    expect(s, "锚点选择器得真在文件里（截空了后面的判据全是假绿）").not.toBe("");
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    const tokens = new Set([...s.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
    // 分侧语义没有「修改行」⇒ 不该再有 `--diff-mod`；占位块的斜纹是外壳灰，走 `--fg-muted`。
    // `--diff-gap-gutter` 只是把「该侧差异色」带到行号槽那一段的载体（叠 `--bg` 合成不透明），
    // `--diff-gutter-w` 是实测槽宽。
    expect([...tokens].sort()).toEqual([
      "--bg",
      "--diff-add",
      "--diff-del",
      "--diff-gap-gutter",
      "--diff-gutter-w",
      "--fg-muted",
    ]);
    expect(s, "不许再借 --warn / --danger（B458 续轮定死这两颗与明暗档无关）").not.toMatch(
      /--(warn|danger)\b/,
    );
  });

  it("B462 · 底色与行号槽 = add / del 的 18% color-mix（改块两侧各按自己那一侧上色）", () => {
    const s = section();
    for (const token of ["--diff-add", "--diff-del"]) {
      expect(s).toContain(`color-mix(in srgb, var(${token}) 18%, transparent)`);
    }
    expect(s, "没有第三种「修改行」配色").not.toMatch(/--diff-mod|diff-line-modify/);
  });

  it("B461 · 底色不打特异度战：走 background-image 叠层，与当前行底色共存（R21）", () => {
    const code = css();
    const kindToToken: Record<string, string> = {
      insert: "--diff-add",
      delete: "--diff-del",
    };
    for (const [kind, token] of Object.entries(kindToToken)) {
      // 选择器 = `.panel-host.is-diff .cm-line.diff-line-X`（0-4-0，与 global.css 里 B425 那颗
      // `.panel-host .cm-editor .cm-line.cm-find-range` 同形 —— 仓库给「整行叠一层透明色」定的就是这一档）。
      const block = ruleBlock(code, `.panel-host.is-diff .cm-line.diff-line-${kind}`);
      expect(block, `底色规则得真在（判不到东西的 not.toMatch 是假绿）`).not.toBe("");
      expect(block).toMatch(/background-image:\s*linear-gradient\(/);
      expect(block).toContain(`color-mix(in srgb, var(${token}) 18%, transparent)`);
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
    // 原先左栏什么都没有 ⇒ 那一半画在页面底色上，18% 的改动色两栏叠的根本不是同一颗基色。
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

  it("B462 · 占位块走 VS Code 的 -45deg / 8px 中性斜纹，且不吃 em、不添竖向留白（R15）", () => {
    const s = section();
    expect(s).toMatch(/linear-gradient\(\s*-45deg/);
    expect(s, "VS Code 的 `diagonal-fill` 是 8px 一格").toContain("8px 8px");
    expect(s, "斜纹是外壳灰，不是某一侧的差异色").toContain("var(--fg-muted)");
    // `.diff-gap` 是 `.cm-content` 里的块 widget：继承 `pre-wrap`，而任何竖向 margin/padding
    // 与 em 制高都会把两栏的行盒推开（`src/preview/` 那些块 widget 栽过的坑）。
    // 行高一律由 widget 按 `view.defaultLineHeight` 写 inline ⇒ 这一段只许声明外观。
    const gap = ruleBlock(css(), ".diff-gap", undefined, true);
    expect(gap, "规则得真在（判不到东西的 not.toMatch 是假绿）").not.toBe("");
    expect(gap).not.toMatch(/(^|[\s;{])(margin|padding)(-top|-bottom)?\s*:/);
    expect(gap).not.toMatch(/\d*\.?\d+em\b/);
    expect(gap, "高度是 widget 写 inline 的，样式段不钉死它").not.toMatch(/height\s*:/);
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

/** 左栏那一列的第 `index` 颗折条（DOM 顺序 = 行号顺序），点它。 */
function clickFoldBar(s: DiffSurface, index: number): void {
  const bars = s.left.contentDOM.querySelectorAll<HTMLElement>(".diff-fold-bar");
  expect(bars.length, `现场得有折条（第 ${index} 颗点不到就是判据空转）`).toBeGreaterThan(index);
  bars[index].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

/**
 * 顶部六颗「改一行」的小块（每块之间只隔 3 行上下文，一段都够不上折的阈值）+ 中段 **100 行**
 * 未改动 + 尾段 30 行未改动 ⇒ 候选两段，其中**第一段折起来 94 行**，比 `2 * DIFF_REVEAL_LINES`
 * 还多。这一座现场是为「点折条到底展开多少」那一条准备的：整段展开（94 行）与「有界揭示
 * （40 行预算）」这两条路在这里才真的分得开 —— 在 24 行那段上两条都绿，判不出方向。
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

  it("B462 · 记号槽在行号右侧、10px、11px / 0.7；中间列 35px + 34×20 回退键", () => {
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

    // 底色类会落到所有 gutter 上 ⇒ 只许行号槽与记号槽吃颜色，4px 差异列 / 折叠槽不许变色。
    const gutter = ruleBlock(
      css(),
      ".panel-host.is-diff .cm-lineNumbers .cm-gutterElement.diff-gutter-insert",
      undefined,
      true,
    );
    expect(gutter).toContain("color-mix(in srgb, var(--diff-add) 18%, transparent)");
    expect(
      css(),
      "同一颗标记的另一半落在记号槽上（not.toMatch 判不到东西，这里要正面命中）",
    ).toContain(".cm-diffSigns .cm-gutterElement.diff-gutter-insert");
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
    ).toContain("var(--diff-del)");
    expect(
      ruleBlock(
        css(),
        ".panel-host.is-diff .diff-overview-modified .diff-overview-mark",
        undefined,
        true,
      ),
    ).toContain("var(--diff-add)");
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
    expect(css(), "右栏原生纵向滚动条收成 0 宽，概览条就是那一根").toContain(
      ".panel-host.is-diff .panel-editor .cm-scroller::-webkit-scrollbar",
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
  it("B461 · 候选 = 未改动区 > 阈值；折掉中间、上下各留 DIFF_CONTEXT_LINES 行", () => {
    const n9 = seq(1, 9, "短");
    const n10 = seq(1, 10, "长");
    // 三块（第 1、11、22 行改了）⇒ 中间两段未改动区：9 行（恰等于阈值，不折）与 10 行（折）。
    const blocks = diffBlocks(
      ["甲1", ...n9, "乙1", ...n10, "丙1"].join("\n"),
      ["乙2", ...n9, "丙2", ...n10, "丁2"].join("\n"),
    );
    expect(blocks).toHaveLength(3);
    expect(9).toBe(DIFF_MIN_UNCHANGED_LINES + 2 * DIFF_CONTEXT_LINES);
    expect(foldCandidates(blocks, "modified", 22)).toEqual([{ run: 2, from: 15, to: 18 }]);
    // 首块之前 / 末块之后那两段也是未改动区：这里都是空的 ⇒ 一段候选都不多
    expect(foldCandidates(blocks, "original", 22)).toEqual([{ run: 2, from: 15, to: 18 }]);
  });

  it("B461 · 三块之间那两段 30 行的未改动区都是候选（两栏行号重合时两侧同形）", () => {
    const blocks = diffBlocks(THREE_LEFT, THREE_RIGHT);
    expect(blocks).toHaveLength(3);
    expect(foldCandidates(blocks, "modified", 63)).toEqual([
      { run: 1, from: 5, to: 28 },
      { run: 2, from: 36, to: 59 },
    ]);
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
    expect(s.foldRanges()).toEqual([{ from: 36, to: 59 }]);
  });

  it("B461 · 点折条 = 就地展开那一段，并按 DIFF_REVEAL_LINES 上下各揭示 20 行", () => {
    const { surface: s, left } = mountSurfacePair(longRunsPair());
    s.collapseAllUnchanged();
    const runs = foldCandidates(s.blocks(), "original", left.state.doc.lines);
    expect(runs, "现场：两段候选（94 行那一段与 24 行那一段），两侧行号重合").toEqual([
      { run: 6, from: 25, to: 118 },
      { run: 7, from: 126, to: 149 },
    ]);
    expect(
      runs[0].to - runs[0].from + 1,
      "现场：点下去那一段折起来的行数比 2 × DIFF_REVEAL_LINES 还多 ⇒ 这一座现场才分得开两条路",
    ).toBeGreaterThan(2 * DIFF_REVEAL_LINES);

    clickFoldBar(s, 0);
    // 简报那句「按 `DIFF_REVEAL_LINES` 上下各揭示这么多行」判的是**落位窗口**，不是「一次只准放开
    // 40 行」：折条的文案明写「展开 94 行未改动的内容」，只做半截展开就是让文案说谎，而
    // `expandedRuns` 记的是**段**、不是段里剩下的那半截。原那条 `<= 2 * DIFF_REVEAL_LINES` 的行数
    // 预算判据在这一座现场上必然与它打架（94 > 40），判的从来不是「展开这一段」⇒ 撤掉；
    // 揭示窗口那一半由下面那颗落点判据钉住（它才是简报要的东西）。上面 :734 那条
    // 「这一段比 2×REVEAL 还长」的前置留着，它让「落到窗口第一行」与「落到段尾」两种写法分得开。
    expect(s.foldRanges(), "整段摘掉，另一段照旧折着（不许一次点击把所有段都放开）").toEqual([
      { from: 126, to: 149 },
    ]);
    expect(caretLineOf(s.left)).toBe(runs[0].from - DIFF_CONTEXT_LINES - DIFF_REVEAL_LINES);
  });

  it("B461 · 点折条把揭示窗口的第一行当落点（窗口 = 折区上下各再让出 DIFF_REVEAL_LINES 行）", () => {
    const s = mountedSurfaceWithThreeBlocks();
    s.collapseAllUnchanged();
    clickFoldBar(s, 1); // 第二颗折条在本栏第 36 行，那一段未改动区从第 33 行起
    expect(caretLineOf(s.left)).toBe(36 - DIFF_CONTEXT_LINES - DIFF_REVEAL_LINES);
    expect(s.foldRanges(), "摘掉的只是点下去那一条，另一条照旧折着").toEqual([{ from: 5, to: 28 }]);
  });

  it("B461 · 折条文案「展开 N 行未改动的内容」，N = 这一段被折起来的行数", () => {
    const { surface: s, right } = mountSurfacePair({ left: THREE_LEFT, right: THREE_RIGHT });
    s.collapseAllUnchanged();
    const bars = [...s.left.contentDOM.querySelectorAll<HTMLElement>(".diff-fold-bar")];
    expect(bars).toHaveLength(2);
    for (const bar of bars) expect(bar.textContent).toBe("展开 24 行未改动的内容");
    expect(
      right.contentDOM.querySelectorAll(".diff-fold-bar"),
      "两栏都得有折条（各自那一列都点得开）",
    ).toHaveLength(2);
    // ⚠️ 不数「一共有几行被抹掉」：jsdom 没有布局引擎，CM6 只画视口里那几行（实测只画得到
    // 前一段的一部分）⇒ 数总数会跟着视口抖。这里判**边界**：上下文那三行照旧看得见，第 5 行起没了。
    expect(
      lineElOf(s.left, 4).className,
      "上下各留 DIFF_CONTEXT_LINES 行：第 4 行还在",
    ).not.toContain("diff-folded");
    expect(lineElOf(s.left, 5).className, "折区从第 5 行起").toContain("diff-folded");
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
    expect(foldCandidates(s.blocks(), "original", 62)).toEqual([
      { run: 1, from: 5, to: 28 },
      { run: 2, from: 36, to: 59 },
    ]);
    expect(s.foldRanges(), "读数是右栏行轴").toEqual([
      { from: 7, to: 30 },
      { from: 38, to: 61 },
    ]);
    // 同一行号在两栏的折叠态**不一样**（左栏第 5 行已经折进去，右栏那一行还是上下文）：
    // 这一条判的就是「各换算一份」，只算右栏的话左栏第 5 行会跟着右栏一起不折（画错一整段）。
    expect(lineElOf(s.left, 5).className, "左栏行轴：第 5 行起折起来").toContain("diff-folded");
    expect(lineElOf(s.left, 4).className, "上下文那 3 行照旧看得见").not.toContain("diff-folded");
    expect(lineElOf(right, 5).className, "右栏行轴：第 5 行还没进折区").not.toContain(
      "diff-folded",
    );
    expect(lineElOf(right, 7).className, "右栏从第 7 行起才折").toContain("diff-folded");
  });

  it("B461 · 右栏选区落进折区 ⇒ 那一段自己展开（CM6 里 display:none 的行仍在文档里）", () => {
    const { surface: s, right } = mountSurfacePair({ left: THREE_LEFT, right: THREE_RIGHT });
    s.collapseAllUnchanged();
    expect(s.foldRanges()).toHaveLength(2);
    right.dispatch({ selection: { anchor: right.state.doc.line(10).from } });
    expect(s.foldRanges(), "光标落到 5..28 那一段里 ⇒ 那一段摘掉，另一段不许被牵连").toEqual([
      { from: 36, to: 59 },
    ]);
  });

  it("B461 · 开关那两颗入口动手之前先看光标：光标落在未改动区里 ⇒ 那一段不许折（display:none 会抹掉光标）", () => {
    // 简报 Step 3 那条 ⚠️ 的第一路：翻开关**不动选区** ⇒ `selectionSet` 一辈子不响，而差异文件里
    // 未改动的行占绝大多数 ⇒ 「光标正停在那一段里」是最常见的落点，不是边角。
    const { surface: s, right } = mountSurfacePair({ left: THREE_LEFT, right: THREE_RIGHT });
    right.dispatch({ selection: { anchor: right.state.doc.line(10).from } });
    expect(caretLineOf(right), "前置：第 10 行落在候选 5..28 之内").toBe(10);
    expect(s.foldRanges(), "前置：开关还没开 ⇒ 一段都不折").toEqual([]);

    s.setCollapseUnchanged(true);
    expect(
      lineElOf(right, 10).className,
      "光标那一行不许被 `display: none` 盖掉（屏上看不见的那一行正是光标所在）",
    ).not.toContain("diff-folded");
    expect(s.foldRanges(), "另一段照旧折着（不许一翻开关就全展开）").toEqual([
      { from: 36, to: 59 },
    ]);

    // 第二颗入口（三颗动作里的 collapseAllUnchanged）同一条纪律：两棵入口都得补这一手。
    const pair2 = mountSurfacePair({ left: THREE_LEFT, right: THREE_RIGHT });
    pair2.right.dispatch({ selection: { anchor: pair2.right.state.doc.line(10).from } });
    pair2.surface.collapseAllUnchanged();
    expect(
      lineElOf(pair2.right, 10).className,
      "collapseAllUnchanged 同样不许盖住光标那一行",
    ).not.toContain("diff-folded");
    expect(pair2.surface.foldRanges()).toEqual([{ from: 36, to: 59 }]);
  });

  it("B461 · 一发**只映射选区**的键入把折区压到光标上 ⇒ 也跟着展开（selectionSet 对键入是 false）", () => {
    // 简报 Step 3 那条 ⚠️ 的第二路：光标停在折区上面那格上下文行的行尾（看得见的一行），
    // 按 Delete 把折区第一行并上来 —— 折区起点被往上吸到光标那一行，而这一发事务只映射了
    // 选区（`selectionSet` 为 false），只听那一颗的兜底整条够不着。
    const { surface: s, right } = mountSurfacePair({ left: THREE_LEFT, right: THREE_RIGHT });
    s.collapseAllUnchanged();
    const at = right.state.doc.line(4).to;
    right.dispatch({ selection: { anchor: at } });
    expect(lineElOf(right, 4).className, "前置：第 4 行是留出来的上下文行，看得见").not.toContain(
      "diff-folded",
    );

    right.dispatch({ changes: { from: at, to: right.state.doc.line(5).from } });
    expect(caretLineOf(right), "前置：并行之后的光标落在合并出来的第 4 行").toBe(4);
    expect(
      lineElOf(right, 4).className,
      "折区被那一发键入压到光标那一行上 ⇒ 当场展开，不许留着一行看不见的光标",
    ).not.toContain("diff-folded");
    expect(s.foldRanges(), "摘掉的只是压上来那一段，另一段照旧").toEqual([{ from: 36, to: 59 }]);
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

    bars[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(s.foldRanges(), "点下去必须真展开那一段（行号差一行也算点的是那一段）").toHaveLength(1);
    expect(s.foldRanges()[0].from, "摘掉的是点下去那一段，留下的是另一段").toBeGreaterThanOrEqual(
      30,
    );
  });

  it("B461 · 键入期折叠装饰只跟着改动映射、不逐键重建（face.ts 文件头那条纪律对折叠一样成立）", () => {
    // `diffFaceField` 守的是「键入期只 `value.map(tr.changes)`」；折叠那一臂原先每键都要
    // `buildFoldFace` / `buildFoldGutter`，那是**每键 O(折起来的行数)** 次 `Decoration.line`
    // 分配。判据落在「同一颗 widget 实例 / 同一条折条 DOM」上：逐键重建就换实例、就重画 DOM。
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

  it("B461 · 拆旁路把折叠一起带走（底色那一条纪律同形：既有的 view 不许留着 display:none 的行）", () => {
    const { surface: s, right } = mountSurfacePair({ left: THREE_LEFT, right: THREE_RIGHT });
    s.collapseAllUnchanged();
    expect(lineElOf(right, 5).className, "前置：第 5 行在这一臂里被折起来了").toContain(
      "diff-folded",
    );
    expect(right.contentDOM.querySelectorAll(".diff-fold-bar").length).toBeGreaterThan(0);
    s.dispose();
    expect(right.contentDOM.querySelectorAll(".cm-line.diff-folded")).toHaveLength(0);
    expect(right.contentDOM.querySelectorAll(".diff-fold-bar")).toHaveLength(0);
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

  it("B461 · 折叠态骑在 diffFace 那一臂上：一发 setFoldedRanges 就有点位与折条（不另开一臂）", () => {
    // 单独装的那一臂**没带**折条出口（出口只有 surface 那一处挂）⇒ 点下去空转，
    // 装饰层自己不许把折叠态摘掉（那才是第二份真相）。
    const { view, lineEl } = mountFace("modified", [], "A\n1\n2\n3\n4\nB");
    expect(lineEl(2).className).not.toContain("diff-folded");
    view.dispatch({ effects: setFoldedRanges.of([{ from: 2, to: 4 }]) });
    for (const n of [2, 3, 4]) expect(lineEl(n).className).toContain("diff-folded");
    expect(lineEl(5).className, "含端点：第 5 行不在折区里").not.toContain("diff-folded");
    const bars = [...view.contentDOM.querySelectorAll<HTMLElement>(".diff-fold-bar")];
    expect(bars).toHaveLength(1);
    expect(bars[0].textContent).toBe("展开 3 行未改动的内容");
    expect(bars[0].style.height, "折条自己占一行高（R18：inline 按 defaultLineHeight 写）").toBe(
      `${LINE_HEIGHT}px`,
    );
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

  it("B461 · 折条吃的是外壳 token：一个裸十六进制都不许有，也不许借第四颗 diff 色", () => {
    const s = foldSection();
    expect(s, "锚点规则得真在（截空了后面的判据全是假绿）").not.toBe("");
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(s, "折条是外壳不是差异态 ⇒ 不许吃 --diff-*（更没有第四颗色）").not.toMatch(/--diff-/);
    expect(s, "也不许借 --warn / --danger").not.toMatch(/--(warn|danger)\b/);
    const tokens = new Set([...s.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
    expect([...tokens].sort()).toEqual(["--bg-hover", "--border", "--fg", "--fg-muted"]);
    expect(s, "明暗两档都靠这几颗自己跟上").toContain("var(--bg-hover)");
  });

  it("B461 · 折条一行高：高度由 widget 写 inline，样式段不钉死、不添竖向留白、不吃 em", () => {
    const bar = ruleBlock(code(), ".panel-host.is-diff .diff-fold-bar");
    expect(bar, "规则得真在（判不到东西的 not.toMatch 是假绿）").not.toBe("");
    expect(bar).not.toMatch(/(^|[\s;{])(margin|padding)(-top|-bottom)?\s*:/);
    expect(bar).not.toMatch(/\d*\.?\d+em\b/);
    expect(
      bar,
      "高度是 widget 按 defaultLineHeight 写 inline 的（R15/R18 同一条纪律）",
    ).not.toMatch(/height\s*:/);
    expect(bar).toContain("cursor: pointer");
  });

  it("B461 · 折起来的行走 display:none，而行号栏那几格一起消失（否则数字会挤成一坨）", () => {
    const s = foldSection();
    const hidden = ruleBlock(code(), ".panel-host.is-diff .cm-line.diff-folded");
    expect(hidden, "折起来的行 = 这一行不占任何视觉高度").toContain("display: none");
    expect(s, "线装饰的类不会自动落到 gutter 元素上 ⇒ 折行的行号必须单独抹掉").toContain(
      ".cm-gutterElement",
    );
    const gutter = ruleBlock(code(), ".panel-host.is-diff .cm-gutterElement.diff-folded-gutter");
    expect(gutter).toContain("display: none");
  });
});

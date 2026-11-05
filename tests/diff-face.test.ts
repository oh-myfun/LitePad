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
//   2) 装到 view 上的那一臂（`diffFace`）：行装饰 + 块 widget + 块起点的指示带类。
//   3) 样式段（`src/diff/diff.css`）：颜色只吃 `--diff-add` / `--diff-mod` / `--diff-del`，
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
import { diffBlocks, type DiffBlock } from "../src/diff/blocks";
import type { DiffSide, DiffSpec } from "../src/diff/model";
import { DIFF_REFRESH_MS } from "../src/diff/align";
import {
  DIFF_CONTEXT_LINES,
  DIFF_MIN_UNCHANGED_LINES,
  DIFF_REVEAL_LINES,
  DiffGapWidget,
  diffFace,
  foldCandidates,
  refreshDiff,
  setFoldedRanges,
  sideGaps,
  sideLineMarks,
} from "../src/diff/face";

const srcOf = (p: string): string => readFileSync(p, "utf-8").replace(/\r\n/g, "\n");

/** 删两行：左栏第 2、3 行是删掉的行，右栏得在那之后补出两行空位。 */
const del = diffBlocks("A\n删1\n删2\nZ", "A\nZ");

/** jsdom 里把 CM6 的行高桩成这个数（真取值口是 `view.defaultLineHeight`，无布局时恒为 0）。 */
const LINE_HEIGHT = 20;

describe("B461 · sideLineMarks / sideGaps：一块在两栏各落在哪些行", () => {
  it("B461 · 删除块：左栏标真行，右栏在 A 之后补 2 行空位", () => {
    expect(sideLineMarks(del, "original")).toEqual([
      { line: 2, kind: "delete" },
      { line: 3, kind: "delete" },
    ]);
    expect(sideLineMarks(del, "modified")).toEqual([]);
    expect(sideGaps(del, "modified")).toEqual([{ afterLine: 1, count: 2 }]);
    expect(sideGaps(del, "original")).toEqual([]);
  });

  it("B461 · 新增块反过来：右栏标行、左栏补空位", () => {
    const ins = diffBlocks("A\nZ", "A\n新1\n新2\nZ");
    expect(sideLineMarks(ins, "modified").map((m) => m.line)).toEqual([2, 3]);
    expect(sideGaps(ins, "original")).toEqual([{ afterLine: 1, count: 2 }]);
  });

  it("B461 · 混合区（改 + 删）的占位段按 offset 落位：被删行在配对窗口之前 ⇒ 缝也在那之前", () => {
    // 基线 [丙一去, 丙一去, 丁后行] vs 当前 [丙一去, 丁后行改了]
    // head=1；中段无 LCS 锚点 ⇒ 一个区 (aLen 2, bLen 1)；alignOffset 挑 o=1（丁后行 ↔ 丁后行改了 最像）
    // ⇒ 配对窗口吃掉 a 的第 2 行，多出来的 a 行（绝对第 2 行）在窗口**之前**被删
    const mixed = diffBlocks("丙一去\n丙一去\n丁后行", "丙一去\n丁后行改了");
    expect(sideGaps(mixed, "modified")).toEqual([{ afterLine: 1, count: 1 }]);
    expect(sideLineMarks(mixed, "modified")).toEqual([{ line: 2, kind: "modify" }]);
  });

  it("B461 · 配对窗口两头都多出行 ⇒ 前后各一段空位，按 afterLine 升序", () => {
    // 基线 [x, B中, y] vs 当前 [B改了]：相似错位挑 o=1 ⇒ B中 ↔ B改了 配对，
    // x 落在窗口之前、y 落在窗口之后 ⇒ 右栏要在第 1 行之后与第 2 行之后各补一行。
    const both = diffBlocks("A\nx\nB中\ny\nC", "A\nB改了\nC");
    expect(sideLineMarks(both, "modified")).toEqual([{ line: 2, kind: "modify" }]);
    expect(sideGaps(both, "modified")).toEqual([
      { afterLine: 1, count: 1 },
      { afterLine: 2, count: 1 },
    ]);
    // 多的一侧（左栏）自己不必补位
    expect(sideGaps(both, "original")).toEqual([]);
  });

  it("B461 · 当前比基线长的改块：左栏按同样的口径补位（缝在配对窗口之后）", () => {
    const grow = diffBlocks("A\nB\nC", "A\nB1\nB2\nC");
    expect(sideLineMarks(grow, "original")).toEqual([{ line: 2, kind: "modify" }]);
    expect(sideGaps(grow, "original")).toEqual([{ afterLine: 2, count: 1 }]);
    expect(sideGaps(grow, "modified")).toEqual([]);
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
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [diffFace(side, provider)] }),
    parent: document.body,
  });
  live.push(() => view.destroy());
  return { view, lineEl: (n) => lineElOf(view, n), gapEls: () => gapElsOf(view) };
}

describe("B461 · diffFace：行底色、块起点的指示带类与对侧占位块", () => {
  it("B461 · 改动行带底色类；对侧空位是块 widget 且高度按行数 × defaultLineHeight 撑出来", () => {
    const { view, gapEls, lineEl } = mountFace("modified", del);
    expect(lineEl(1).className).not.toContain("diff-line-del"); // 右栏第 1 行本身没改
    expect(gapEls()).toHaveLength(1);
    expect(gapEls()[0].getAttribute("class"), "占位块就这一颗类名（方向由所在栏的样式定）").toBe(
      "diff-gap",
    );
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

  it("B461 · 左栏把删掉的行涂成真行底色，一块只在自己起点发一条 diff-edge-top", () => {
    const { lineEl, gapEls } = mountFace("original", del);
    expect(gapEls(), "删掉的行在左栏是**真行** ⇒ 这一侧不补位").toHaveLength(0);
    expect(lineEl(1).className).not.toContain("diff-line");
    expect(lineEl(2).className).toContain("diff-line-delete");
    expect(lineEl(3).className).toContain("diff-line-delete");
    expect(lineEl(2).className, "块起点：指示带靠这一条定位").toContain("diff-edge-top");
    expect(lineEl(3).className).not.toContain("diff-edge-top");
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
    expect(lineEl(2).className).toContain("diff-line-modify");
    expect(lineEl(2).className).toContain("diff-edge-top");
    expect(firstBlockWidget(view)?.widget).toBeInstanceOf(DiffGapWidget);
  });

  it("B461 · 正文开头就缺行（缝落在第 0 行之后）⇒ 占位块插在第一行**之前**", () => {
    const top = diffBlocks("删1\n删2\nA", "A");
    expect(sideGaps(top, "modified"), "前置：纯函数报的是第 0 行之后").toEqual([
      { afterLine: 0, count: 2 },
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

    view.dispatch({ changes: { from: 0, insert: "X\n" } });
    expect(
      provider,
      "停手之前不重算（B398 那条口径，与 gutterDiffField 同纪律）",
    ).toHaveBeenCalledTimes(1);

    blocks = diffBlocks("A\nZ", "A\n新1\n新2\nZ");
    view.dispatch({ effects: refreshDiff.of(null) });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(gapEls(), "新增块补的是**左栏**，右栏这一侧不该留空位").toHaveLength(0);
    expect(lineEl(1).className, "第 1 行是新打进去的 X，不在任何块里").not.toContain("diff-line");
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
    expect(lineElOf(left, 2).className).toContain("diff-edge-top");
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
    expect(right.contentDOM.querySelectorAll(".diff-edge-top")).toHaveLength(0);
    expect(panel.view, "右栏那颗 view 本身不受牵连").not.toBeNull();
    expect(right.state.doc.toString()).toBe("A\nZ");
  });

  it("B461 · 差异格两栏一律不折行（R19）：attach 关掉右栏、左栏从一开始就不装、detach 原样还", () => {
    // 设计稿 ⑥ 的头条约束（两侧行行对齐）靠这一条才成立：折行一开，一个文档行就不止一个
    // 视觉行，而两栏**宽度各自不同** ⇒ 同一行长文的视觉行数天然不等（「两边都折」也救不回来），
    // 两栏的高度从第一条长行起就分家 —— 跳块与肉眼比对同时错位。
    // ⚠️ 「同一行在两栏的视觉 y 是否真的一致」是**像素**判据，jsdom 没有布局引擎 ⇒ 归 Task 11
    // 真机台。这里钉的是「扩展在不在 state 里」—— 它恰恰是那条像素等式的前提。
    const { right, left, surface, initialState } = mountSurfacePair();
    expect(
      wrapsLines(initialState),
      "前置：出厂 `word_wrap: true` ⇒ 那颗初始 state 确实装了折行",
    ).toBe(true);
    expect(wrapsLines(right.state), "挂上旁路那一刻，右栏的折行被关掉").toBe(false);
    expect(wrapsLines(left.state), "左栏从一开始就不装折行").toBe(false);
    surface.dispose();
    expect(wrapsLines(right.state), "拆掉旁路把折行还回去（那颗 view 是文档本身）").toBe(true);
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

  it("B461 · 这一段一个裸十六进制都不许有，色值只走那三颗 token", () => {
    const s = section();
    expect(s, "锚点选择器得真在文件里（截空了后面的判据全是假绿）").not.toBe("");
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    const tokens = new Set([...s.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
    // `--diff-edge` 只是「本行指示带用哪颗」的别名（下一条判据钉它），不算第四颗色。
    expect([...tokens].sort()).toEqual(["--diff-add", "--diff-del", "--diff-edge", "--diff-mod"]);
    expect(s, "不许再借 --warn / --danger（B458 续轮定死这三颗与明暗档无关）").not.toMatch(
      /--(warn|danger)\b/,
    );
  });

  it("B461 · 底色 = 三颗 token 的 18% color-mix；`--diff-edge` 只当别名", () => {
    const s = section();
    for (const token of ["--diff-add", "--diff-mod", "--diff-del"]) {
      expect(s).toContain(`color-mix(in srgb, var(${token}) 18%, transparent)`);
    }
    // `--diff-edge` 只是别名：它自己被定义成什么，只许是那三颗 token 之一（数条数会跟着
    // 规则写法抖动，这里判「三颗都被挂上过」= 有鉴别力又不脆）。
    const aliases = [...s.matchAll(/--diff-edge\s*:\s*var\(--diff-(add|mod|del)\)/g)];
    expect(new Set(aliases.map((m) => m[1]))).toEqual(new Set(["add", "mod", "del"]));
    const loose = [...s.matchAll(/--diff-edge\s*:\s*([^;]+);/g)];
    for (const m of loose) expect(m[1].trim()).toMatch(/^var\(--diff-(add|mod|del)\)$/);
  });

  it("B461 · 底色不打特异度战：走 background-image 叠层，与当前行底色共存（R21）", () => {
    const code = css();
    const kindToToken: Record<string, string> = {
      insert: "--diff-add",
      modify: "--diff-mod",
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

  it("B461 · 占位块走 135deg 斜纹，且不吃 em、不添竖向留白（R15）", () => {
    const s = section();
    expect(s).toMatch(/repeating-linear-gradient\(\s*135deg/);
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

/** 一批行区间一共折了多少行。 */
const hiddenTotal = (ranges: Array<{ from: number; to: number }>): number =>
  ranges.reduce((sum, r) => sum + (r.to - r.from + 1), 0);

/**
 * 「这一次点击揭示了多少行」= 全部候选折起来的行数 − 现在还折着的行数。
 *
 * 为什么这么算：jsdom 没有布局引擎，`scrollIntoView` 到底落没落到位量不出来（那一条归真机台 ③），
 * 而**行数**是两个公开读数（`blocks()` 与 `foldRanges()`）的差 ⇒ 判得到「一次点击最多展开
 * `DIFF_REVEAL_LINES × 2` 行」这条预算。反证：把点击写成「一颗都不留」（showAll）就是 48 行 ⇒ 红。
 */
function revealedLines(s: DiffSurface): number {
  const all = foldCandidates(s.blocks(), "original", s.left.state.doc.lines);
  return hiddenTotal(all) - hiddenTotal(s.foldRanges());
}

/** 光标现在落在第几行（1-based）。 */
const caretLineOf = (view: EditorView): number =>
  view.state.doc.lineAt(view.state.selection.main.head).number;

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

  it("B461 · 点折条 = 就地展开，并按 DIFF_REVEAL_LINES 上下各揭示 20 行", () => {
    const s = mountedSurfaceWithThreeBlocks();
    s.collapseAllUnchanged();
    const before = s.foldRanges().length;
    clickFoldBar(s, 0);
    expect(s.foldRanges().length).toBe(before - 1);
    expect(revealedLines(s)).toBeLessThanOrEqual(DIFF_REVEAL_LINES * 2);
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
  /** Task 7 那一段：从 `.diff-fold-bar` 起到文件末尾（Task 3 那一段的 token 清单由另一条判）。 */
  const foldSection = (): string => {
    const s = code();
    const at = s.indexOf(".diff-fold-bar");
    return at < 0 ? "" : s.slice(at);
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

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
import { tabs, type Panel, type Tab } from "../src/core/app-state";
import { createDiffSurface, type DiffSurface } from "../src/diff/surface";
import { diffBlocks, type DiffBlock } from "../src/diff/blocks";
import type { DiffSide, DiffSpec } from "../src/diff/model";
import { DIFF_REFRESH_MS } from "../src/diff/align";
import { DiffGapWidget, diffFace, refreshDiff, sideGaps, sideLineMarks } from "../src/diff/face";

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
 * ⚠️ 必须 `destroy` / `dispose`，不能只把 `document.body` 清空就完事 —— 那一臂的 ViewPlugin
 * 里有一颗防抖计时器，插件不 destroy 就没人取消它，下一发 `refreshDiff` 会打在已经作废的
 * 视图上（`gutterDiffView` 同形）。
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

describe("B461 · surface 给两颗 view 各装一臂（预审 R1）", () => {
  const diffSpec = (): DiffSpec => ({
    tier: "baseline",
    docId: 100,
    leftText: () => "A\n删1\n删2\nZ",
    leftName: "a.md（上次保存）",
    rightName: "a.md",
    leftPath: null,
  });

  /**
   * 复刻 `src/tabs/lifecycle.ts` 的 `mountView` 那几步（同 `tests/diff-surface.test.ts`）：
   * 建 `.panel-host` → 建 `.panel-editor` → 挂右栏那颗 view → 交给**生产的** `createDiffSurface`。
   * 两臂的装法本身是生产代码，这里没有第二份实现。
   */
  function mountHost(): {
    panel: Panel;
    right: EditorView;
    left: EditorView;
    surface: DiffSurface;
  } {
    const hostEl = document.createElement("div");
    hostEl.className = "panel-host";
    document.body.appendChild(hostEl);
    const editorEl = document.createElement("div");
    editorEl.className = "panel-editor";
    hostEl.appendChild(editorEl);
    const { state, comps } = makeTabState(
      "A\nZ",
      null,
      { dark: false, wrap: true, perf: perfProfileFor("normal") },
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
      diff: diffSpec(),
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
    const surface = createDiffSurface(hostEl, panel, diffSpec());
    // 先拆旁路（它会往右栏发一发 reconfigure），再拆那颗 view —— 反过来的话
    // dispose 就只能在已经 destroy 的视图上派发。
    live.push(() => {
      if (panel.diffSurface === surface) surface.dispose();
    });
    live.push(() => view.view.destroy());
    return { panel, right: view.view, left: surface.left, surface };
  }

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
});

describe("B461 · 差异段样式（Task 3 追加那一段）", () => {
  const css = (): string => stripCssComments(srcOf("src/diff/diff.css"));

  /** 只取 Task 3 那一段（从 `.diff-line-insert` 起）：前面那一格是 Task 1 的两栏骨架。 */
  const section = (): string => {
    const code = css();
    const at = code.indexOf(".diff-line-insert");
    return at < 0 ? "" : code.slice(at);
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

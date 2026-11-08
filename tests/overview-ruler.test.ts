// @vitest-environment jsdom
// B464 · 概览标尺（VS Code 的 overview ruler）的标记来源与绘制几何。
//
// 这一层能在 jsdom 里判的只有两件事：**收哪些标记**（`overviewZones`）与
// **画到哪一格**（`layoutOverview`）。画布像素判不了（jsdom 不做布局、`clientWidth` 恒 0），
// 所以颜色/层级那几条落在样式断言与 diff-face 的那条用例上。
//
// 上游口径（`decorationsOverviewRuler.ts` + `editorColors.ts`）：
//   · 选区出现 = `selectionHighlightForeground`、同词出现 = `wordHighlightForeground`，
//     都在 Center 泳道；两者注册默认值同为 #A0A0A0CC。
//   · 查找命中 = `findMatchForeground`（Center）；当前命中取上游另一条既有路径
//     `rangeHighlightForeground` + Full（`findController.addDecorations`）。
//   · 光标 = `editorCursor.foreground` 70%，Full 泳道、2px 高、最后画。

import { readFileSync } from "node:fs";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { makeTabState } from "../src/editor/editor";
import { buildFindQuery, findHighlight, setFindQuery } from "../src/editor/find";
import { perfProfileFor } from "../src/editor/perf";
import {
  OVERVIEW_CURSOR_MARK,
  OVERVIEW_MIN_MARK,
  layoutOverview,
  overviewLanes,
  overviewWordMatches,
  overviewZones,
  type OverviewMapping,
  type OverviewZone,
} from "../src/editor/overview";
import { ruleBlock, stripCssComments } from "./static";

const DOC = "alpha beta\nalpha gamma\nalpha";

/** 100 行、每行 20px、标尺 200px ⇒ 1 行 = 2 个标尺像素。 */
const mapping: OverviewMapping = {
  height: 100 * 20,
  topOf: (line) => (line - 1) * 20,
  heightOf: () => 20,
};

const zone = (
  over: Partial<OverviewZone> & Pick<OverviewZone, "fromLine" | "toLine">,
): OverviewZone => ({
  token: "--overview-word",
  lane: 2,
  zIndex: 0,
  kind: "word",
  ...over,
});

function stateWith(extensions: Extension): EditorState {
  return EditorState.create({ doc: DOC, selection: { anchor: 0, head: 5 }, extensions });
}

describe("B464 · 概览标尺收哪些标记", () => {
  it("选区 / 同词出现 / 光标三类各自出现，且用各自的注册色与泳道", () => {
    const state = stateWith([overviewWordMatches.of(true)]);
    const zones = overviewZones(state);
    const of = (kind: OverviewZone["kind"]) => zones.filter((z) => z.kind === kind);

    const selection = of("selection");
    expect(selection, "选区本身一条").toHaveLength(1);
    expect(selection[0].fromLine).toBe(1);
    expect(selection[0].token).toBe("--overview-selection");
    expect(selection[0].lane).toBe(2);

    const words = of("word");
    expect(
      words.map((z) => z.fromLine),
      "选中 alpha ⇒ 其余两处",
    ).toEqual([2, 3]);
    expect(words[0].token).toBe("--overview-word");
    expect(words[0].lane).toBe(2);

    const cursors = of("cursor");
    expect(
      cursors.map((z) => z.fromLine),
      "光标在选区末端那一行",
    ).toEqual([1]);
    expect(cursors[0].token).toBe("--overview-cursor");
    expect(cursors[0].lane).toBe(7);
  });

  it("同词出现跟着 `perf.selectionMatches` 那颗闸（正文不亮 ⇒ 标尺不亮）", () => {
    const state = stateWith([]);
    expect(overviewZones(state).some((z) => z.kind === "word")).toBe(false);
  });

  it("查找命中与当前命中分开：前者 findMatch/Center，后者 rangeHighlight/Full 且层级更高", () => {
    let state = EditorState.create({ doc: DOC, extensions: [findHighlight()] });
    state = state.update({
      effects: setFindQuery.of({
        query: buildFindQuery({
          search: "alpha",
          caseSensitive: true,
          wholeWord: false,
          regexp: false,
        }),
        activeFrom: 11,
        restrict: null,
      }),
    }).state;
    const zones = overviewZones(state);
    const hits = zones.filter((z) => z.kind === "find");
    const current = zones.filter((z) => z.kind === "find-current");

    expect(
      hits.map((z) => z.fromLine),
      "另外两处命中",
    ).toEqual([1, 3]);
    expect(hits[0].token).toBe("--overview-find");
    expect(hits[0].lane).toBe(2);

    expect(
      current.map((z) => z.fromLine),
      "activeFrom 落在第 2 行",
    ).toEqual([2]);
    expect(current[0].token, "当前命中 = 上游 rangeHighlightForeground").toBe("--overview-range");
    expect(current[0].lane, "Full 泳道才压得住普通命中").toBe(7);
    expect(current[0].zIndex).toBeGreaterThan(hits[0].zIndex);
  });
});

describe("B464 · 行区间合并与层级（照上游 `_renderOneGroup`）", () => {
  it("同色相邻行合并成一条；异色重叠各自保留，后画的压在上面", () => {
    const rects = layoutOverview(
      [
        zone({ fromLine: 10, toLine: 10 }),
        zone({ fromLine: 11, toLine: 11 }),
        zone({
          fromLine: 10,
          toLine: 12,
          token: "--overview-find",
          lane: 2,
          zIndex: 10,
          kind: "find",
        }),
      ],
      mapping,
      15,
      200,
    );
    expect(rects.filter((r) => r.token === "--overview-word")).toHaveLength(1);
    expect(
      rects.map((r) => r.token),
      "低 zIndex 先画、高 zIndex 后画",
    ).toEqual(["--overview-word", "--overview-find"]);
    // 两条都覆盖 10–12 行 ⇒ 同一段像素上叠了两层（canvas 的半透明会合色）
    const word = rects.find((r) => r.token === "--overview-word")!;
    const find = rects.find((r) => r.token === "--overview-find")!;
    expect(word.y).toBeLessThanOrEqual(find.y);
    expect(word.y + word.h).toBeGreaterThanOrEqual(find.y + find.h);
  });

  it("异泳道不合并（上游只按行序合并，泳道由第一条决定 —— 这里分泳道判更稳）", () => {
    const rects = layoutOverview(
      [zone({ fromLine: 10, toLine: 10, lane: 1 }), zone({ fromLine: 11, toLine: 11, lane: 2 })],
      mapping,
      15,
      200,
    );
    expect(rects).toHaveLength(2);
    expect(rects[0].x).not.toBe(rects[1].x);
  });

  it("单行也至少 6px 高；光标 2px 且最后画", () => {
    const rects = layoutOverview(
      [
        zone({ fromLine: 1, toLine: 1 }),
        zone({ fromLine: 1, toLine: 1, token: "--overview-cursor", lane: 7, kind: "cursor" }),
      ],
      mapping,
      15,
      200,
    );
    expect(rects[0].h, "上游 MIN_DECORATION_HEIGHT").toBe(OVERVIEW_MIN_MARK);
    const last = rects[rects.length - 1];
    expect(last.token, "光标在装饰之后画").toBe("--overview-cursor");
    expect(last.h).toBe(OVERVIEW_CURSOR_MARK);
    expect(last.y, "第 1 行贴顶时夹在画布内").toBeGreaterThanOrEqual(0);
  });

  it("三条泳道的几何照上游 `_initLanes(1, width, 3)`", () => {
    expect(overviewLanes(15)).toEqual({
      1: { x: 1, w: 4 },
      2: { x: 5, w: 6 },
      4: { x: 11, w: 4 },
      7: { x: 1, w: 14 },
    });
  });
});

describe("B464 · 普通编辑器挂载", () => {
  const mount = (overview?: boolean) => {
    const { state } = makeTabState(
      "abc",
      null,
      {
        dark: true,
        wrap: false,
        perf: perfProfileFor("normal"),
        ...(overview === undefined ? {} : { overview }),
      },
      () => {},
    );
    const view = new EditorView({ state });
    const canvas = view.dom.querySelector(".cm-overview-ruler");
    view.destroy();
    return canvas;
  };

  it("默认挂上右缘那一列；差异实例（`overview: false`）不挂", () => {
    expect(mount(), "普通编辑器要有概览标尺").not.toBeNull();
    expect(mount(false), "差异格由 `.diff-overview` 自己画").toBeNull();
  });
});

describe("B464 · 样式：颜色取上游注册默认值、层级三层", () => {
  const globalCss = stripCssComments(readFileSync("src/styles/global.css", "utf-8"));

  it("四颗标记色 + HC 族覆盖", () => {
    const root = ruleBlock(globalCss, ":root", "--overview-find");
    expect(root).toContain("--overview-find: #d186167e");
    expect(root).toContain("--overview-range: #007acc99");
    expect(root).toContain("--overview-selection: #a0a0a0cc");
    expect(root).toContain("--overview-word: #a0a0a0cc");
    expect(root).toContain("--overview-cursor: color-mix(in srgb, var(--editor-cursor) 70%");
    const hc = ruleBlock(globalCss, ':root[data-theme-family="hc"]');
    expect(hc, "上游 findMatchForeground 的 HC 档").toContain("--overview-find: #ab5a00");
  });

  it("普通编辑器那一列：贴右缘 8px、不吃指针", () => {
    const ruler = ruleBlock(globalCss, ".cm-overview-ruler");
    expect(ruler).toContain("right: 0");
    expect(ruler).toContain("width: 8px");
    expect(ruler).toContain("pointer-events: none");
  });
});

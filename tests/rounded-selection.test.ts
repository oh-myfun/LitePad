// @vitest-environment jsdom
// 选区圆角（VS Code 口径：`selections.ts` 的三档角 + `selections.css` 的 3px）。
//
// 这一片守四件事：
//   1. 每颗角的分档：外转圆、对齐平、内转凹 —— 多行选区的台阶靠它才对得上 VS Code；
//   2. 几何按行拆：每行只画字符区，跨行时只给行尾换行符补半格，不铺通栏；
//   3. 圆角层真的挂上了（`drawSelection` 之后），原生直角层只是被 CSS 藏起来，仍在 DOM 里；
//   4. 样式侧：凸角引用唯一档位变量、凹角用径向渐变补块、HC 归零。

import { readFileSync } from "node:fs";

import { EditorState, Text } from "@codemirror/state";
import { EditorView, drawSelection } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
  newlineRect,
  roundedSelection,
  selectionCorners,
  selectionSegments,
  stitchLines,
  type CornerRect,
} from "../src/editor/roundedSelection";
import { ruleBlock, stripCssComments, stripLineComments } from "./static";

const CSS = stripCssComments(readFileSync("src/styles/global.css", "utf-8"));

/** 一段选区的一块矩形：只写量角用得上的四个量。 */
function rect(left: number, top: number, width: number, height: number): CornerRect {
  return { left, top, width, height };
}

describe("selectionCorners：照 VS Code 的相邻缘判角", () => {
  it("单块矩形四颗角全圆（只有一段的选区是完整外轮廓）", () => {
    const [corners] = selectionCorners([rect(40, 0, 120, 20)]);
    expect(corners).toEqual({ tl: "round", tr: "round", bl: "round", br: "round" });
  });

  it("中段满宽、首尾半行：台阶处内转凹、对齐边平、外缘圆", () => {
    // 第 1 行从 x=100 选到行尾，中间整段满宽（0..300），最后一行选到 x=150。
    const corners = selectionCorners([
      rect(100, 0, 200, 20), // 首段：100..300
      rect(0, 20, 300, 40), // 中段：0..300（两行高）
      rect(0, 60, 150, 20), // 末段：0..150
    ]);
    expect(corners).toEqual([
      { tl: "round", tr: "round", bl: "concave", br: "flat" },
      { tl: "round", tr: "flat", bl: "flat", br: "round" },
      { tl: "flat", tr: "concave", bl: "round", br: "round" },
    ]);
  });

  it("左右缘都对齐的整行选区：只有整段最外四颗角是圆角", () => {
    const corners = selectionCorners([
      rect(0, 0, 300, 20),
      rect(0, 20, 300, 40),
      rect(0, 60, 300, 20),
    ]);
    expect(corners).toEqual([
      { tl: "round", tr: "round", bl: "flat", br: "flat" },
      { tl: "flat", tr: "flat", bl: "flat", br: "flat" },
      { tl: "flat", tr: "flat", bl: "round", br: "round" },
    ]);
  });

  it("上下不贴合的矩形不算同一段（多光标各算各的外轮廓）", () => {
    const corners = selectionCorners([rect(0, 0, 80, 20), rect(200, 40, 80, 20)]);
    expect(corners).toEqual([
      { tl: "round", tr: "round", bl: "round", br: "round" },
      { tl: "round", tr: "round", bl: "round", br: "round" },
    ]);
  });

  it("亚像素差按对齐处理：0.5px 的抖动不该多画一颗角", () => {
    const corners = selectionCorners([rect(0, 0, 300, 20), rect(0.5, 20, 300, 20)]);
    expect(corners[0].bl).toBe("flat");
    expect(corners[1].tl).toBe("flat");
  });
});

describe("selectionSegments：每行只画自己的字符区", () => {
  // 行界：第 1 行 0..5、第 2 行 6..9、第 3 行 10..17、第 4 行 18..21
  const doc = Text.of(["第一行文字", "第二行", "第三行更长一些", "第四行"]);

  it("跨行选区按行拆开，每行记下换行符是否也在选区里", () => {
    // 第 1 行第 2 列 → 第 3 行第 2 列
    expect(selectionSegments(doc, 2, 12)).toEqual([
      { from: 2, to: 5, newline: true },
      { from: 6, to: 9, newline: true },
      { from: 10, to: 12, newline: false },
    ]);
  });

  it("终点落在下一行行首：下一行没有段，上一行仍含换行符", () => {
    expect(selectionSegments(doc, 2, 6)).toEqual([{ from: 2, to: 5, newline: true }]);
  });

  it("空行整行被选中：字符区为零宽，只补换行符那半格", () => {
    const spaced = Text.of(["a", "", "b"]);
    expect(selectionSegments(spaced, 0, 4)).toEqual([
      { from: 0, to: 1, newline: true },
      { from: 2, to: 2, newline: true },
      { from: 3, to: 4, newline: false },
    ]);
  });

  it("只量视口内的行，换行符的口径仍按整段判", () => {
    expect(selectionSegments(doc, 0, 21, 10, 17)).toEqual([{ from: 10, to: 17, newline: true }]);
  });
});

describe("newlineRect：换行符补块按行方向长", () => {
  it("LTR 往右补", () => {
    expect(newlineRect(rect(40, 0, 120, 20), 8, false)).toEqual(rect(40, 0, 128, 20));
  });

  it("RTL 往左补", () => {
    expect(newlineRect(rect(40, 0, 120, 20), 8, true)).toEqual(rect(32, 0, 128, 20));
  });
});

describe("stitchLines：行距不留缝", () => {
  it("相邻视觉行各让一半，接成连续的一条", () => {
    expect(stitchLines([rect(0, 0, 100, 16), rect(0, 21, 100, 16)], 21)).toEqual([
      rect(0, 0, 100, 18.5),
      rect(0, 18.5, 100, 18.5),
    ]);
  });

  it("缺口超过一行高（跨块级 widget）不接", () => {
    expect(stitchLines([rect(0, 0, 100, 16), rect(0, 100, 100, 16)], 21)).toEqual([
      rect(0, 0, 100, 16),
      rect(0, 100, 100, 16),
    ]);
  });
});

describe("圆角层挂在 drawSelection 之后", () => {
  it("编辑器里同时有原生选区层（藏起来）与圆角层", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "第一行\n第二行",
        extensions: [drawSelection(), roundedSelection()],
      }),
      parent: document.body,
    });
    try {
      expect(
        view.dom.querySelector(".cm-selectionLayer"),
        "原生选区层仍是 :has 守卫的锚点",
      ).not.toBeNull();
      expect(view.dom.querySelector(".lp-selectionLayer"), "圆角选区层").not.toBeNull();
    } finally {
      view.destroy();
    }
  });

  it("两处 drawSelection 都成对挂了圆角层（正文基座 + 差异左栏）", () => {
    for (const file of ["src/editor/editor.ts", "src/diff/surface.ts"]) {
      const src = stripLineComments(readFileSync(file, "utf-8"));
      expect(src, `${file}：圆角层必须跟 drawSelection 成对`).toMatch(
        /drawSelection\(\),\s*roundedSelection\(\)/,
      );
    }
  });
});

describe("样式：原生层让位、凸角圆、凹角补块、HC 归零", () => {
  it("CM6 的直角选区层只藏不删", () => {
    const block = ruleBlock(CSS, ".panel-host .cm-editor .cm-selectionLayer");
    expect(block).toMatch(/display:\s*none/);
  });

  it("圆角档位只有一个书写处：3px，且失焦补块换 inactive 色", () => {
    const base = ruleBlock(CSS, ".panel-host .cm-editor", "--lp-sel-radius");
    expect(base).toMatch(/--lp-sel-radius:\s*3px/);
    expect(base).toMatch(/--lp-sel-bg:\s*var\(--editor-selection\)/);
    const blurred = ruleBlock(CSS, ".panel-host .cm-editor:not(.cm-focused)", "--lp-sel-bg");
    expect(blurred).toMatch(/--lp-sel-bg:\s*var\(--editor-inactive-selection\)/);
  });

  it("四颗凸角各画各的 border-radius，全引用同一档位变量", () => {
    const sides = [
      ["tl", "top-left"],
      ["tr", "top-right"],
      ["bl", "bottom-left"],
      ["br", "bottom-right"],
    ] as const;
    for (const [cls, side] of sides) {
      const block = ruleBlock(CSS, `.panel-host .cm-editor .lp-sel-${cls}`);
      expect(block, `.lp-sel-${cls} 没画圆角`).toContain(
        `border-${side}-radius: var(--lp-sel-radius)`,
      );
    }
  });

  it("四颗凹角补块：3×3 子元素 + 径向渐变，圆心朝被选区包住的角", () => {
    const cases = [
      ["tl", "0 100%"],
      ["tr", "100% 100%"],
      ["bl", "0 0"],
      ["br", "100% 0"],
    ] as const;
    const base = ruleBlock(CSS, ".panel-host .cm-editor .lp-sel-fillet");
    expect(base).toMatch(/width:\s*var\(--lp-sel-radius\)/);
    expect(base).toMatch(/height:\s*var\(--lp-sel-radius\)/);
    for (const [cls, at] of cases) {
      const block = ruleBlock(CSS, `.panel-host .cm-editor .lp-sel-fillet-${cls}`);
      expect(block, `.lp-sel-fillet-${cls} 缺圆心`).toContain(`circle at ${at}`);
      expect(block, `.lp-sel-fillet-${cls} 缺选区色`).toMatch(/var\(--lp-sel-bg\)/);
    }
  });

  it("HC 档不吃圆角（VS Code 在 HC 下同样是 0）", () => {
    const block = ruleBlock(CSS, ':root[data-theme-family="hc"] .panel-host .cm-editor');
    expect(block).toMatch(/--lp-sel-radius:\s*0px/);
  });
});

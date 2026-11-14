// @vitest-environment jsdom
// 「查看 → 显示不可见字符」的装饰面（VS Code `editor.renderWhitespace = all` 口径）：
//   · 只认空格与 Tab（NBSP、全角空格不算，与上游 whitespace.ts 的 charCode 判断一致）；
//   · 空格按「连续 run」挂一段（CSS 以 1ch 平铺点阵）；
//   · Tab 一颗一段 —— CM6 会把相邻且 spec 相等的 mark 并成一个 span，合并了箭头就数不清。

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { invisibleChars, invisiblesIn } from "../src/editor/invisibleChars";

interface WsRange {
  from: number;
  to: number;
  cls: string;
}

function ranges(doc: string, from = 0, to = doc.length): WsRange[] {
  const state = EditorState.create({ doc });
  const out: WsRange[] = [];
  invisiblesIn(state, from, to).between(from, to, (f, t, deco) => {
    out.push({ from: f, to: t, cls: deco.spec.class ?? "" });
  });
  return out;
}

describe("invisiblesIn", () => {
  it("空格按 run 合并、Tab 一颗一段，其余字符不碰", () => {
    expect(ranges("  a\tb   ")).toEqual([
      { from: 0, to: 2, cls: "cm-ws-space" },
      { from: 3, to: 4, cls: "cm-ws-tab" },
      { from: 5, to: 8, cls: "cm-ws-space" },
    ]);
  });

  it("多行各算各的：行尾空格照画，换行符不算空白", () => {
    expect(ranges("  x  \n\t\ty")).toEqual([
      { from: 0, to: 2, cls: "cm-ws-space" },
      { from: 3, to: 5, cls: "cm-ws-space" },
      { from: 6, to: 7, cls: "cm-ws-tab" },
      { from: 7, to: 8, cls: "cm-ws-tab" },
    ]);
  });

  it("可见区间从 run 中间切进来时按切点夹取", () => {
    expect(ranges("  a\tb   ", 1, 6)).toEqual([
      { from: 1, to: 2, cls: "cm-ws-space" },
      { from: 3, to: 4, cls: "cm-ws-tab" },
      { from: 5, to: 6, cls: "cm-ws-space" },
    ]);
  });

  it("NBSP 与全角空格不算不可见字符", () => {
    expect(ranges("a\u00a0\u3000 b")).toEqual([{ from: 3, to: 4, cls: "cm-ws-space" }]);
  });

  it("没有任何空白时不产生装饰", () => {
    expect(ranges("abc")).toEqual([]);
  });

  it("相邻 Tab 在 DOM 里各是一段（不准被 CM6 合并）", () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "\t\tx   ", extensions: [invisibleChars()] }),
      parent: document.body,
    });
    expect(view.contentDOM.querySelectorAll(".cm-ws-tab").length).toBe(2);
    expect(view.contentDOM.querySelectorAll(".cm-ws-space").length).toBe(1);
    view.destroy();
  });
});

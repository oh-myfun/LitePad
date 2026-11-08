// @vitest-environment node
// B461 · 行内字符级差异（`src/diff/inline.ts`）。
//
// 上游 `refineDiff` 在行级配对之后还会再跑一次词级 diff，把变化收窄到词/字符
// （`char-insert` / `char-delete`）。本文件钉四类用户点名的向量：
//   · 一行里改一个词 / 改多处 / 改的词在行尾；
//   · 空白差异在 `ignoreTrimWhitespace` 下不计入 inner change；
// 另外钉词界扩展的两个阈值方向（改一半以下不扩、改到 2/3 以上扩整词）、
// 纯增 / 纯删行补整行字符层（上游 `diffWholeLine*`），以及块内配对行的行号换算。
// 「内联改动为空的那一侧」落在零长区间上（上游 `diff-range-empty` 那根 3px 细条）。
import { describe, expect, it } from "vitest";
import { diffBlocks } from "../src/diff/blocks";
import { innerChanges, innerLineRanges } from "../src/diff/inline";

const both = (from: number, to: number) => ({ original: [[from, to]], modified: [[from, to]] });

describe("B461 · innerLineRanges：一行之内的词级差异", () => {
  it("一行里改一个词：只标那个词", () => {
    expect(innerLineRanges("const value = old;", "const value = new;", false)).toEqual(
      both(14, 17),
    );
  });

  it("一行里改多处：两处各标各的（间隔够长不被去噪合并）", () => {
    expect(innerLineRanges("let a = 1; let b = 2;", "let x = 1; let y = 2;", false)).toEqual({
      original: [
        [4, 5],
        [15, 16],
      ],
      modified: [
        [4, 5],
        [15, 16],
      ],
    });
  });

  it("改的词在行尾：区间收在行尾词的边界上", () => {
    expect(innerLineRanges("return value", "return count", false)).toEqual(both(7, 12));
  });

  it("交替增删：邻近的单字符改动按上游 removeShortMatches 并成一段", () => {
    // 间隔 ≤2 个未变字符 ⇒ 并（上游判据是「或」：任一侧短就并）。
    expect(innerLineRanges("nn1nn2", "nnXnnY", false)).toEqual(both(2, 6));
  });

  it("交替增删：间隔 3 个未变字符时保留两段", () => {
    expect(innerLineRanges("aaa1bbb2ccc", "aaaXbbbYccc", false)).toEqual({
      original: [
        [3, 4],
        [7, 8],
      ],
      modified: [
        [3, 4],
        [7, 8],
      ],
    });
  });
});

describe("B461 · innerLineRanges：空白与词边界", () => {
  it("空白差异不计入 inner change（ignoreTrimWhitespace）", () => {
    expect(innerLineRanges("  foo", "foo  ", true)).toEqual({ original: [], modified: [] });
  });

  it("裁掉的首尾空白不丢列号：真改动仍标在原行位置", () => {
    expect(innerLineRanges("  foo", "  bar", true)).toEqual(both(2, 5));
  });

  it("不忽略 trim 空白时，行首行尾的空白差异如实成段，另一侧落零长（diff-range-empty）", () => {
    expect(innerLineRanges("  foo", "foo", false)).toEqual({
      original: [[0, 2]],
      modified: [[0, 0]],
    });
  });

  it("词界：标点不并入改动", () => {
    expect(innerLineRanges("foo, bar", "baz, bar", false)).toEqual(both(0, 3));
  });

  it("词界扩展：词内只改一个字符时不扩到整词", () => {
    expect(innerLineRanges("foobar", "foobaz", false)).toEqual(both(5, 6));
  });

  it("词界扩展：词内改动超过 1/3 时扩到整词（上游 2/3 相等判据）", () => {
    expect(innerLineRanges("foobar", "fooxxx", false)).toEqual(both(0, 6));
  });
});

describe("B461 · innerChanges：块内配对行", () => {
  const linesOf = (original: string[], modified: string[]) => ({
    original: (line: number) => original[line - 1] ?? "",
    modified: (line: number) => modified[line - 1] ?? "",
  });

  it("改块里两侧各标自己那一侧，行号按块表（1-based）", () => {
    const blocks = diffBlocks("A\nlet x = 1;\nZ", "A\nlet y = 1;\nZ");
    expect(
      innerChanges(blocks, linesOf(["A", "let x = 1;", "Z"], ["A", "let y = 1;", "Z"]), false),
    ).toEqual({
      original: [{ line: 2, from: 4, to: 5 }],
      modified: [{ line: 2, from: 4, to: 5 }],
    });
  });

  it("纯插入行补整行字符层（上游 diffWholeLineAddDecoration）", () => {
    const blocks = diffBlocks("A\nZ", "A\nnew\nZ");
    expect(innerChanges(blocks, linesOf(["A", "Z"], ["A", "new", "Z"]), false)).toEqual({
      original: [],
      modified: [{ line: 2, from: 0, to: 3 }],
    });
  });

  it("纯删除行同样补整行字符层（上游 diffWholeLineDeleteDecoration）", () => {
    const blocks = diffBlocks("A\ngone\nZ", "A\nZ");
    expect(innerChanges(blocks, linesOf(["A", "gone", "Z"], ["A", "Z"]), false)).toEqual({
      original: [{ line: 2, from: 0, to: 4 }],
      modified: [],
    });
  });

  it("配对行里一侧是空行：非空侧整行，空侧落零长（细条）", () => {
    const blocks = diffBlocks("A\n\nZ", "A\nx\nZ");
    expect(innerChanges(blocks, linesOf(["A", "", "Z"], ["A", "x", "Z"]), false)).toEqual({
      original: [{ line: 2, from: 0, to: 0 }],
      modified: [{ line: 2, from: 0, to: 1 }],
    });
  });
});

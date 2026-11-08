// @vitest-environment node
// B461 · 行内字符级差异（`src/diff/inline.ts`）。
//
// 上游 `refineDiff` 在行级配对之后还会再跑一次词级 diff，把变化收窄到词/字符
// （`char-insert` / `char-delete`）。本文件钉四类用户点名的向量：
//   · 一行里改一个词 / 改多处 / 改的词在行尾；
//   · 空白差异在 `ignoreTrimWhitespace` 下不计入 inner change；
// 另外钉词界扩展的两个阈值方向（改一半以下不扩、改到 2/3 以上扩整词）、
// 整块字符 diff 反推的块内对齐边界，以及跨行改动的非末段补到行尾（`fill`）。
// 纯增 / 纯删块**不再产出** inner change：整行字符层归 `face.ts` 的 `diff-whole-*`。
import { describe, expect, it } from "vitest";
import { diffBlocks } from "../src/diff/blocks";
import { innerChanges } from "../src/diff/inline";

/** 一段正文 → 行读取口（1-based）。 */
function linesOf(text: string): (line: number) => string {
  const lines = text.split("\n");
  return (line) => lines[line - 1] ?? "";
}

/** 一份正文对 → 块表 → innerChanges（只读它关心的两半）。 */
function inner(original: string, modified: string, ignoreTrimWhitespace = false) {
  const blocks = diffBlocks(original, modified, { ignoreTrimWhitespace });
  return innerChanges(
    blocks,
    { original: linesOf(original), modified: linesOf(modified) },
    ignoreTrimWhitespace,
  );
}

describe("B461 · innerChanges：一行之内的词级差异", () => {
  it("一行里改一个词：只标那个词", () => {
    expect(inner("const value = old;", "const value = new;").changes).toEqual({
      original: [{ line: 1, from: 14, to: 17 }],
      modified: [{ line: 1, from: 14, to: 17 }],
    });
  });

  it("一行里改多处：两处各标各的（间隔够长不被去噪合并）", () => {
    expect(inner("let a = 1; let b = 2;", "let x = 1; let y = 2;").changes).toEqual({
      original: [
        { line: 1, from: 4, to: 5 },
        { line: 1, from: 15, to: 16 },
      ],
      modified: [
        { line: 1, from: 4, to: 5 },
        { line: 1, from: 15, to: 16 },
      ],
    });
  });

  it("改的词在行尾：区间收在行尾词的边界上", () => {
    expect(inner("return value", "return count").changes).toEqual({
      original: [{ line: 1, from: 7, to: 12 }],
      modified: [{ line: 1, from: 7, to: 12 }],
    });
  });

  it("交替增删：邻近的单字符改动按上游 removeShortMatches 并成一段", () => {
    // 间隔 ≤2 个未变字符 ⇒ 并（上游判据是「或」：任一侧短就并）。
    expect(inner("nn1nn2", "nnXnnY").changes).toEqual({
      original: [{ line: 1, from: 2, to: 6 }],
      modified: [{ line: 1, from: 2, to: 6 }],
    });
  });

  it("交替增删：间隔 3 个未变字符时保留两段", () => {
    expect(inner("aaa1bbb2ccc", "aaaXbbbYccc").changes).toEqual({
      original: [
        { line: 1, from: 3, to: 4 },
        { line: 1, from: 7, to: 8 },
      ],
      modified: [
        { line: 1, from: 3, to: 4 },
        { line: 1, from: 7, to: 8 },
      ],
    });
  });
});

describe("B461 · innerChanges：空白与词边界", () => {
  it("空白差异不计入 inner change（ignoreTrimWhitespace）", () => {
    expect(inner("  foo", "foo  ", true).changes, "整篇只差首尾空白 ⇒ 对齐器连块都不发").toEqual({
      original: [],
      modified: [],
    });
  });

  it("裁掉的首尾空白不丢列号：真改动仍标在原行位置", () => {
    expect(inner("  foo", "  bar", true).changes).toEqual({
      original: [{ line: 1, from: 2, to: 5 }],
      modified: [{ line: 1, from: 2, to: 5 }],
    });
  });

  it("不忽略 trim 空白时，行首行尾的空白差异如实成段，另一侧落零长（diff-range-empty）", () => {
    expect(inner("  foo", "foo").changes).toEqual({
      original: [{ line: 1, from: 0, to: 2 }],
      modified: [{ line: 1, from: 0, to: 0 }],
    });
  });

  it("词界：标点不并入改动", () => {
    expect(inner("foo, bar", "baz, bar").changes).toEqual({
      original: [{ line: 1, from: 0, to: 3 }],
      modified: [{ line: 1, from: 0, to: 3 }],
    });
  });

  it("词界扩展：词内只改一个字符时不扩到整词", () => {
    expect(inner("foobar", "foobaz").changes).toEqual({
      original: [{ line: 1, from: 5, to: 6 }],
      modified: [{ line: 1, from: 5, to: 6 }],
    });
  });

  it("词界扩展：词内改动超过 1/3 时扩到整词（上游 2/3 相等判据）", () => {
    expect(inner("foobar", "fooxxx").changes).toEqual({
      original: [{ line: 1, from: 0, to: 6 }],
      modified: [{ line: 1, from: 0, to: 6 }],
    });
  });
});

describe("B461 · innerChanges：块内行号、整行归属与对齐边界", () => {
  it("改块里两侧各标自己那一侧，行号按块表（1-based）", () => {
    expect(inner("A\nlet x = 1;\nZ", "A\nlet y = 1;\nZ").changes).toEqual({
      original: [{ line: 2, from: 4, to: 5 }],
      modified: [{ line: 2, from: 4, to: 5 }],
    });
  });

  it("纯插入 / 纯删除块不产出 inner change（整行字符层归 face 的 diff-whole-*）", () => {
    expect(inner("A\nZ", "A\nnew\nZ").changes).toEqual({ original: [], modified: [] });
    expect(inner("A\ngone\nZ", "A\nZ").changes).toEqual({ original: [], modified: [] });
    expect(inner("A\nZ", "A\nnew\nZ").alignments).toEqual([[]]);
  });

  it("配对行里一侧是空行：非空侧整行，空侧落零长（细条）", () => {
    expect(inner("A\n\nZ", "A\nx\nZ").changes).toEqual({
      original: [{ line: 2, from: 0, to: 0 }],
      modified: [{ line: 2, from: 0, to: 1 }],
    });
  });

  it("跨行改动：非末段补到行尾（fill），并反推出块内对齐边界", () => {
    // 「q\\nr」→「X\\nY」横跨两行：两侧第一段都被换行截断 ⇒ fill；
    // 原稿侧末段停在行内第 1 列（未到行尾）⇒ 反推出一条边界（第 2 行 ↔ 第 2 行）。
    const r = inner("p q\nr s", "p X\nY s");
    expect(r.changes).toEqual({
      original: [
        { line: 1, from: 2, to: 3, fill: true },
        { line: 2, from: 0, to: 1 },
      ],
      modified: [
        { line: 1, from: 2, to: 3, fill: true },
        { line: 2, from: 0, to: 1 },
      ],
    });
    expect(r.alignments).toEqual([[{ originalLine: 2, modifiedLine: 2 }]]);
  });

  it("改动起止都在行内：不产出对齐边界（整块只对齐首尾）", () => {
    expect(inner("A\nabc def\nZ", "A\nabc xyz\nZ").alignments).toEqual([[]]);
  });
});

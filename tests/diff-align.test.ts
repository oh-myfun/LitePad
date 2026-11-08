// @vitest-environment node
// B461 · Task 2 —— 块级内核的共用对齐器（`src/diff/align.ts`）。
//
// 设计稿 ⑥「对齐只有一个来源」：4px gutter 列（B458 的 `lineDiff`）与差异面的块级出口
// （Task 2 的 `diffBlocks`）吃同一份对齐结果。
//
// 对齐语义已经整段换成 VS Code 的 advanced 差异实现（`DefaultLinesDiffComputer`），
// 下面的「期望输出」是拿上游那份实现跑同样输入得到的逐条结果（不是我们自己拍的）：
//   · 只移动了一行；
//   · 删掉一段、又在下面插入一段相似内容；
//   · 行尾空白差异（`ignoreTrimWhitespace` 两种口径）；
//   · 两序列行数越过 1700 的 Myers 档。
// 另有一条钉 `head`/`tail`：调用方据此把区内的 0-based 换算成绝对行号。
import { describe, expect, it } from "vitest";
import { alignLines, splitLines } from "../src/diff/align";

/** 把 `Aligned` 还原成绝对行区间（与上游 `LineRange` 的半开区间同一口径）。 */
function edits(
  a: string[],
  b: string[],
  ignoreTrimWhitespace: boolean,
): Array<{ a0: number; a1: number; b0: number; b1: number }> {
  const r = alignLines(a, b, ignoreTrimWhitespace);
  return r.regions.map((x) => ({
    a0: r.head + x.aStart,
    a1: r.head + x.aStart + x.aLen,
    b0: r.head + x.bStart,
    b1: r.head + x.bStart + x.bLen,
  }));
}

describe("B461 · alignLines：替换区与前后缀修剪", () => {
  it("B461 · alignLines 给出的替换区与旧 lineDiff 用的那批一致（含相似错位 offset）", () => {
    const a = splitLines("甲\n乙\n丙\n丁");
    const b = splitLines("甲A\n乙\n丙\n丁B");
    expect(alignLines(a, b, false).regions).toEqual([
      { aStart: 0, aLen: 1, bStart: 0, bLen: 1, offset: 0 },
      { aStart: 3, aLen: 1, bStart: 3, bLen: 1, offset: 0 },
    ]);
  });

  it("B461 · 前后缀修剪的结果跟着进 Aligned（调用方据此换算绝对行号）", () => {
    expect(
      alignLines(splitLines("1\n2\n3\nX\n5"), splitLines("1\n2\n3\nY\n5"), false),
    ).toMatchObject({
      head: 3,
      tail: 1,
    });
  });
});

describe("B461 · 对齐结果与 VS Code advanced 实现逐条一致", () => {
  it("只移动了一行：被移动的那段报「删一处、插一处」，不把整段当改", () => {
    const a = splitLines(
      [
        "function alpha() {",
        "  return 1;",
        "}",
        "",
        "function beta() {",
        "  return 2;",
        "}",
        "",
        "function gamma() {",
        "  return 3;",
        "}",
      ].join("\n"),
    );
    const b = splitLines(
      [
        "function alpha() {",
        "  return 1;",
        "}",
        "",
        "function gamma() {",
        "  return 3;",
        "}",
        "",
        "function beta() {",
        "  return 2;",
        "}",
      ].join("\n"),
    );
    expect(edits(a, b, false)).toEqual([
      { a0: 3, a1: 7, b0: 3, b1: 3 },
      { a0: 11, a1: 11, b0: 7, b1: 11 },
    ]);
  });

  it("删掉一段又在下面插入相似内容：删除与相似插入分开报", () => {
    const a = splitLines("item one\nitem two\nitem three\nitem four\nitem five");
    const b = splitLines("item one\nitem three\nitem four\nitem two (updated)\nitem five");
    expect(edits(a, b, false)).toEqual([
      { a0: 1, a1: 2, b0: 1, b1: 1 },
      { a0: 4, a1: 4, b0: 3, b1: 4 },
    ]);
  });

  it("行尾空白差异：不忽略时各自成改动，忽略时整篇无改动", () => {
    const a = splitLines("alpha\nbeta\ngamma");
    const b = splitLines("alpha  \nbeta\ngamma\t");
    expect(edits(a, b, false)).toEqual([
      { a0: 0, a1: 1, b0: 0, b1: 1 },
      { a0: 2, a1: 3, b0: 2, b1: 3 },
    ]);
    expect(edits(a, b, true)).toEqual([]);
  });

  it("越过 1700 行改走 Myers：900 行里改一行只报那一行", () => {
    const a = Array.from({ length: 900 }, (_, i) => `line ${i}`);
    const b = a.slice();
    b[500] = "line 500 changed";
    expect(edits(a, b, false)).toEqual([{ a0: 500, a1: 501, b0: 500, b1: 501 }]);
  });
});

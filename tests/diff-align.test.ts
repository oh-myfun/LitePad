// @vitest-environment node
// B461 · Task 2 —— 块级内核的共用对齐器（`src/diff/align.ts`）。
//
// 设计稿 ⑥「对齐只有一个来源」：4px gutter 列（B458 的 `lineDiff`）与差异面的块级出口
// （Task 2 的 `diffBlocks`）吃同一份对齐结果。本文件钉抽出来的那两件：
//   · 替换区（含相似错位 offset）与旧 lineDiff 循环里现算的那批**逐区一致**；
//   · `head`/`tail` 修剪结果跟着进 `Aligned`，调用方据此把区内的 0-based 换算成绝对行号。
// 与旧实现的一字不差由 `tests/gutter-diff.test.ts` 那 19 条不动来整体证明（等价闸门）。
import { describe, expect, it } from "vitest";
import { alignLines, splitLines } from "../src/diff/align";

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

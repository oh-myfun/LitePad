// @vitest-environment node
// B461 · Task 2 —— 块级出口（`src/diff/blocks.ts`）。
//
// 面板与差异面吃的是**块**：一次连续改动 = 一块，六种形（insert / delete / modify ×
// 贴首 / 贴尾 / 整段）都得有交代。行号口径：1-based 含端点，`start > end` ⇒ 该侧为空段
// （照 VS Code 的空段表示法，Task 3 的占位块据此落位）。
// 对齐不在这里算 —— 与 4px gutter 列同源，都走 `alignLines`（设计稿约束 ⑥）。
import { describe, expect, it } from "vitest";
import { blockAt, diffBlocks } from "../src/diff/blocks";

describe("B461 · diffBlocks：块级出口的六种形", () => {
  it("B461 · 连续改动并成一块；两块之间隔着未改动行就分成两块", () => {
    const bs = diffBlocks("1\n2\n3\n4\n5\n6", "1\n2X\n3Y\n4\n5\n6Z");
    expect(bs.map((b) => b.kind)).toEqual(["modify", "modify"]);
    expect(bs[0]).toMatchObject({
      originalStart: 2,
      originalEnd: 3,
      modifiedStart: 2,
      modifiedEnd: 3,
    });
  });

  it("B461 · 纯增 = insert（左段空）", () => {
    expect(diffBlocks("A\nZ", "A\n新1\n新2\nZ")[0]).toMatchObject({
      kind: "insert",
      originalStart: 2,
      originalEnd: 1,
      modifiedStart: 2,
      modifiedEnd: 3,
      added: 2,
      removed: 0,
    });
  });

  it("B461 · 纯删 = delete（右段空）", () => {
    expect(diffBlocks("A\n删1\n删2\nZ", "A\nZ")[0]).toMatchObject({
      kind: "delete",
      originalStart: 2,
      originalEnd: 3,
      modifiedStart: 2,
      modifiedEnd: 1,
      added: 0,
      removed: 2,
    });
  });

  it("B461 · 贴文首与贴文末都能出块；整篇删空仍有一块", () => {
    expect(diffBlocks("1\n2", "X\n1\n2")[0]).toMatchObject({ kind: "insert", modifiedStart: 1 });
    expect(diffBlocks("1\n2", "1\n2\nX")[0].modifiedEnd).toBe(3);
    expect(diffBlocks("1\n2\n3", "")).toHaveLength(1);
  });

  it("B461 · 全同返回空表；空对空也空表", () => {
    expect(diffBlocks("同一篇", "同一篇")).toEqual([]);
    expect(diffBlocks("", "")).toEqual([]);
  });

  it("Review Focus 1 的一半 · 首尾空白开关只影响比较，不影响行号", () => {
    expect(diffBlocks("甲  ", "甲", { ignoreTrimWhitespace: true })).toEqual([]);
    expect(diffBlocks("甲  ", "甲", { ignoreTrimWhitespace: false })).toHaveLength(1);
  });

  it("Review Focus 5 · 超 LCS 预算走退化路径，仍每块都有交代（不抛、不返回空）", () => {
    const big = (tag: string) => Array.from({ length: 600 }, (_, i) => `${tag}${i}`).join("\n");
    const blocks = diffBlocks(big("甲"), "第0行改了\n" + big("乙"));
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0]).toHaveProperty("offset");
  });
});

describe("B461 · blockAt：包住这一行的块序号（Task 9 面板跟随光标靠它）", () => {
  it("块内行命中块序号；未改动行与表外 ⇒ -1", () => {
    const bs = diffBlocks("1\n2\n3\n4\n5\n6", "1\n2X\n3Y\n4\n5\n6Z");
    expect(blockAt(bs, "modified", 2)).toBe(0);
    expect(blockAt(bs, "modified", 3)).toBe(0);
    expect(blockAt(bs, "original", 3)).toBe(0);
    expect(blockAt(bs, "modified", 4), "隔着未改动行不该串到 0 块").toBe(-1);
    expect(blockAt(bs, "modified", 6)).toBe(1);
    expect(blockAt(bs, "original", 6)).toBe(1);
    expect(blockAt([], "modified", 1)).toBe(-1);
  });

  it("空段那一侧：「块前缘那一行」（line === start - 1）也算命中", () => {
    // 删除块（右段空）：光标停在被删块后面那一行**前面**的那一行（A = 第 1 行）要亮这条。
    const dels = diffBlocks("A\n删1\n删2\nZ", "A\nZ");
    expect(blockAt(dels, "modified", 1)).toBe(0);
    expect(blockAt(dels, "modified", 2), "Z 本身不在块里").toBe(-1);
    expect(blockAt(dels, "original", 3)).toBe(0);
    // 插入块（左段空）：同一条口径。
    const inss = diffBlocks("A\nZ", "A\n新1\n新2\nZ");
    expect(blockAt(inss, "original", 1)).toBe(0);
    expect(blockAt(inss, "modified", 2)).toBe(0);
  });
});

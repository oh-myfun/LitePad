// @vitest-environment node
// B461 · Task 2 —— 块级出口（`src/diff/blocks.ts`）。
//
// 面板与差异面吃的是**块**：一次连续改动 = 一块，六种形（insert / delete / modify ×
// 贴首 / 贴尾 / 整段）都得有交代。行号口径：1-based 含端点，`start > end` ⇒ 该侧为空段
// （照 VS Code 的空段表示法，Task 3 的占位块据此落位）。
// 对齐不在这里算 —— 与 4px gutter 列同源，都走 `alignLines`（设计稿约束 ⑥）。
import { describe, expect, it } from "vitest";
import { blockAt, diffBlocks, type DiffBlock } from "../src/diff/blocks";

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
    expect(blockAt(dels, "original", 3)).toBe(0);
    // 插入块（左段空）：同一条口径。
    const inss = diffBlocks("A\nZ", "A\n新1\n新2\nZ");
    expect(blockAt(inss, "original", 1)).toBe(0);
    expect(blockAt(inss, "modified", 2)).toBe(0);
  });

  // 裁决 R26（Task 4 评审后）：落位规则说空段落「`end + 1`」那一行，而现有命中规则只认
  // 「`start - 1`」（= `end`）那一行 —— 两条天然差一行 ⇒ 刚跳过去的那一块在侧栏里丢高亮。
  // 裁决保留落位规则（贴文首的删除块上 `start - 1` 会算出第 0 行，落位规则是唯一合法的），
  // 改的是查询口：空段那一侧**再**接受 `line === start`，但只作为「现有规则谁都判不中」时的
  // 兜底 ⇒ 命中的优先次序一个字都不许倒过来。
  it("R26 · 空段的落点行（`start`）算命中，但只在现有规则判不中时兜底", () => {
    const dels = diffBlocks("A\n删1\n删2\nZ", "A\nZ");
    expect(dels[0]).toMatchObject({ kind: "delete", modifiedStart: 2, modifiedEnd: 1 });
    expect(blockAt(dels, "modified", 1), "块前缘那一行照旧命中（现有规则不动）").toBe(0);
    // 这一发是本次要修的：Z 那一行就是删除块的落点行 ⇒ 从「谁都没包住」改成归那道删除缝。
    // 代价计划里写明了：光标停在一段删除之后那一行时，高亮的是那一道删除。
    expect(blockAt(dels, "modified", 2), "空段的落点行 = 那块（R26 兜底）").toBe(0);
    const inss = diffBlocks("A\nZ", "A\n新1\n新2\nZ");
    expect(blockAt(inss, "original", 2), "插入块左栏那一侧同口径").toBe(0);
    // 兜底只兜**落点那一行**，不许把整段空段之后的区域都吞掉。
    expect(blockAt(inss, "original", 3), "落点之后第二行仍然谁都没包住").toBe(-1);
  });

  it("R26 · 贴文首的删除块：现有那条命中行是第 0 行（不存在），只有兜底认得它的落点", () => {
    const head = diffBlocks("X\nA\nB", "A\nB");
    expect(head[0]).toMatchObject({ kind: "delete", modifiedStart: 1, modifiedEnd: 0 });
    // 现有规则的命中行在这儿是 `start - 1` = **第 0 行** —— 任何真光标都撞不上去（这也正是
    // 裁决保留落位规则 `end + 1` 的理由：贴文首的删除块上 `start - 1` 会算出第 0 行）。
    expect(blockAt(head, "modified", 1), "落位就落在第 1 行 ⇒ 兜底必须认得，否则侧栏高亮必丢").toBe(
      0,
    );
    expect(blockAt(head, "modified", 2), "兜底只兜落点那一行").toBe(-1);
  });

  it("R26 兜底不许改命中的优先次序：那一行真被别的块包住时仍然归那一块", () => {
    // 手工搭一块表（`diffBlocks` 的产物里两块之间必隔未改动行，撞不上，所以这里直接摆形状）：
    // 第 0 块是空段（modified 3..2 ⇒ 落点行 3），第 1 块把第 3 行**真包在里面**。
    const empty: DiffBlock = {
      kind: "delete",
      originalStart: 1,
      originalEnd: 1,
      modifiedStart: 3,
      modifiedEnd: 2,
      added: 0,
      removed: 1,
      offset: 0,
    };
    const real: DiffBlock = {
      kind: "modify",
      originalStart: 3,
      originalEnd: 3,
      modifiedStart: 3,
      modifiedEnd: 4,
      added: 1,
      removed: 0,
      offset: 0,
    };
    // 两块**谁都不让谁**：把空段那条摆前面也判给真包住它的那一块 ⇒ 相邻两块不会抢同一行。
    expect(blockAt([empty, real], "modified", 3)).toBe(1);
    expect(blockAt([real, empty], "modified", 3)).toBe(0);
    expect(blockAt([empty], "modified", 3), "没有别块时才轮到兜底").toBe(0);
  });
});

// B458 · 源码模式行号区右侧的 diff 标注 —— 纯函数那一段。
//
// 用户口径（2026-11-04 拍板）：
//   · 基线 = **上一次保存的正文**（`doc.baseline`，与标签上那颗未保存原点同一个值），
//     不是 git HEAD ⇒ 保存之后标记整片清空；
//   · 三色：绿 = 新增行、橙 = 改动行、红 = 被删掉的行；
//   · 红的落位（方案 B）：条画在**被删块后面那一行**的上边缘，跨接缝上下各 4px。
//     用户原话：「如果是4行后面的行（原先的5、6行）删除了，红条就应该画在4行和5行中间」
//     ⇒ 接缝属于「现在的第 5 行」（也就是原先第 7 行那一条）的上沿，不属于第 4 行；
//   · 多行删除只画**一道**缝，不因删除行数变长（先看实际效果，需要再议）。
//
// 于是本函数的输出形状是「每一行一条标记」，`seam` 与 `modified`/`added` 可以**同时**
// 落在一行上（这正是用户提的遮挡场景：4 行被改 + 5 行处删 ⇒ 缝不许被橙/绿盖住）。
// 让位是画的事（方案 A：橙让掉最后 4px、绿让掉最前 4px，那道缝归红独占），
// 不在纯函数里做，所以这里只把「同一行有两种标记」如实交出去。

import { describe, expect, it } from "vitest";
import { lineDiff, type DiffMark } from "../src/editor/gutterDiff";

/** 取某一行的标记（没有 ⇒ undefined）。 */
const at = (marks: DiffMark[], line: number): DiffMark | undefined =>
  marks.find((m) => m.line === line);

/** 被删块的那道缝（全篇只该有一条时用这个查）。 */
const seams = (marks: DiffMark[]): DiffMark[] => marks.filter((m) => m.seam);

describe("B458 · lineDiff：基线（上次保存）↔ 当前正文", () => {
  it("一模一样 ⇒ 一条标记都没有", () => {
    expect(lineDiff("A\nB\nC", "A\nB\nC")).toEqual([]);
    expect(lineDiff("", "")).toEqual([]);
  });

  it("改一行 ⇒ 只有那一行是橙（modified），上下行干净", () => {
    const marks = lineDiff("A\nB\nC", "A\nB2\nC");
    expect(at(marks, 2)?.modified).toBe(true);
    expect(at(marks, 1)).toBeUndefined();
    expect(at(marks, 3)).toBeUndefined();
    expect(marks.length, JSON.stringify(marks)).toBe(1);
  });

  it("中间插一行 ⇒ 只有那一行是绿（added），不牵连后面的行", () => {
    const marks = lineDiff("A\nC", "A\nB\nC");
    expect(at(marks, 2)?.added).toBe(true);
    expect(at(marks, 3)?.added).toBeUndefined();
    expect(marks.length, JSON.stringify(marks)).toBe(1);
  });

  // 用户点名的那条：删掉原先的 5、6 两行，红条属于「现在的第 5 行」的上沿。
  it("删掉中间两行 ⇒ 一道缝，落在被删块后面那一行的上边缘", () => {
    const marks = lineDiff("A\nB\nC\nD\nE\nF\nG", "A\nB\nC\nD\nG");
    const s = seams(marks);
    expect(s.length, `多行删除只该画一道缝，实际 ${JSON.stringify(s)}`).toBe(1);
    expect(s[0].line, "缝必须挂在删除块之后的那一行（G = 现在的第 5 行）").toBe(5);
    expect(s[0].seam).toBe("top");
    // 前面的行不许被顺带画脏
    expect(at(marks, 4)).toBeUndefined();
    expect(marks.length, JSON.stringify(marks)).toBe(1);
  });

  it("删除块贴着文档开头 ⇒ 缝落在第 1 行的上边缘", () => {
    const marks = lineDiff("A\nB\nC", "C");
    expect(seams(marks)).toEqual([{ line: 1, seam: "top" }]);
  });

  it("删除块贴着文档末尾 ⇒ 缝落在最后一行的下边缘", () => {
    const marks = lineDiff("A\nB\nC", "A");
    expect(seams(marks)).toEqual([{ line: 1, seam: "bottom" }]);
  });

  it("整篇删空 ⇒ 仍然画出一道缝（挂在第 1 行上沿），别整片什么都不显示", () => {
    const marks = lineDiff("A\nB\nC", "");
    expect(seams(marks).length).toBe(1);
    expect(seams(marks)[0]).toEqual({ line: 1, seam: "top" });
  });

  it("空基线（新建文档还没存过）打字 ⇒ 全绿，没有缝", () => {
    const marks = lineDiff("", "A\nB");
    expect(at(marks, 1)?.added).toBe(true);
    expect(at(marks, 2)?.added).toBe(true);
    expect(seams(marks), JSON.stringify(marks)).toEqual([]);
  });

  it("末尾补一个换行 ⇒ 多出那一条空行算新增", () => {
    const marks = lineDiff("A\nB", "A\nB\n");
    expect(marks.length, JSON.stringify(marks)).toBe(1);
    expect(at(marks, 3)?.added).toBe(true);
  });

  it("末尾删掉换行 ⇒ 缝落在最后一行的下边缘", () => {
    const marks = lineDiff("A\nB\n", "A\nB");
    expect(seams(marks)).toEqual([{ line: 2, seam: "bottom" }]);
  });

  // 遮挡场景的前提：同一行既要交出「自己改了」又要交出「缝在我这里」。
  it("改第 2 行又删掉第 3 行 ⇒ 橙标记与缝各自如实交出（让位交给画的那一层）", () => {
    const marks = lineDiff("A\nB\nC\nD", "A\nB2\nD");
    expect(at(marks, 2)?.modified).toBe(true);
    expect(at(marks, 3)?.seam, JSON.stringify(marks)).toBe("top");
    expect(marks.length, JSON.stringify(marks)).toBe(2);
  });

  it("替换区里基线少、当前多 ⇒ 逐行配对算橙，多出来的那几条算绿", () => {
    const marks = lineDiff("A\nB\nC\nE", "A\nB2\nC2\nD2\nE");
    expect(at(marks, 2)?.modified).toBe(true);
    expect(at(marks, 3)?.modified).toBe(true);
    expect(at(marks, 4)?.added).toBe(true);
  });

  it("替换区里基线多、当前少 ⇒ 配不上的那几条并成一道缝", () => {
    const marks = lineDiff("A\nB\nC\nD\nE", "A\nB2\nC2\nE");
    expect(at(marks, 2)?.modified).toBe(true);
    expect(at(marks, 3)?.modified).toBe(true);
    expect(seams(marks)).toEqual([{ line: 4, seam: "top" }]);
  });

  it("整篇换掉同等行数 ⇒ 每行都橙（大 middle 也要收口，不许漏行）", () => {
    const base = Array.from({ length: 2000 }, (_, i) => `x${i}`).join("\n");
    const cur = Array.from({ length: 2000 }, (_, i) => `y${i}`).join("\n");
    const marks = lineDiff(base, cur);
    expect(marks.length).toBe(2000);
    expect(marks.every((m) => m.modified)).toBe(true);
  });

  it("顶部粘一大块 ⇒ 只有粘的那几行绿，下面原样不动（前后缀修剪的功劳）", () => {
    const base = Array.from({ length: 2000 }, (_, i) => `x${i}`).join("\n");
    const cur = "NEW1\nNEW2\n" + base;
    const marks = lineDiff(base, cur);
    expect(marks.length, JSON.stringify(marks.slice(0, 5))).toBe(2);
    expect(at(marks, 1)?.added).toBe(true);
    expect(at(marks, 2)?.added).toBe(true);
  });

  it("行号一律是**当前文档**的行号，且按行号升序（gutter 落位要用）", () => {
    const marks = lineDiff("A\nB\nC\nD\nE", "A\nX\nC\nE");
    // 「X」是当前第 2 行（改）、「D」没了 ⇒ 缝挂在它后面那一行（当前的 E = 第 4 行）
    expect(marks.map((m) => m.line)).toEqual([2, 4]);
    expect(marks.every((m) => m.line >= 1 && m.line <= 4)).toBe(true);
  });

  // ↓ 真机第一轮（B458-5）抓到的形：删几行 + 紧接着改下一行。纯按下标配对会把「改」
  //   认到被删块的第一行上，于是橙落在对的行、红缝却低了一格。配对要挑**最像**的那个错位。
  it("删两行、紧跟着那一行又改了 ⇒ 橙与缝都在那一行（缝不许掉到下一格）", () => {
    const marks = lineDiff("H\n甲\n丙一去\n丙二来\n丁后行\nT", "H\n甲\n丁后行Y\nT");
    expect(marks.length, JSON.stringify(marks)).toBe(1);
    expect(at(marks, 3)?.modified, JSON.stringify(marks)).toBe(true);
    expect(at(marks, 3)?.seam, JSON.stringify(marks)).toBe("top");
    expect(at(marks, 4), "第 4 行（T）没动，不该有标记").toBeUndefined();
  });

  it("改一行、它前面又粘进两行 ⇒ 橙落在真改了的那一行，粘进来那两条算绿", () => {
    const marks = lineDiff("H\n丁后行\nT", "H\n丙一新\n丙二新\n丁后行Y\nT");
    expect(at(marks, 4)?.modified, JSON.stringify(marks)).toBe(true);
    expect(at(marks, 2)?.added, JSON.stringify(marks)).toBe(true);
    expect(at(marks, 3)?.added, JSON.stringify(marks)).toBe(true);
    expect(at(marks, 2)?.modified).toBeUndefined();
  });

  // 真机第一轮抓到的正是这一形，而上面那条单测**没**抓到：那条里「本区的当前行数」恰好
  // 等于「整个中段的当前行数」，于是错位搜索的 span 蒙对了。前面另有一处改动时，两个数
  // 就不一样了 —— 拿整个中段的长度算 span ⇒ span 变负 ⇒ 永远退回老口径 ⇒ 缝低一格。
  it("两处改动并存时，后面那处的缝仍与橙落在同一格（错位搜索按本区行数算）", () => {
    const marks = lineDiff(
      "A1\n甲线\n乙\n丙一去\n丙二来\n丁后行\nZ",
      "A1\n甲线X\n新行\n乙\n丁后行Y\nZ",
    );
    expect(at(marks, 2)?.modified, JSON.stringify(marks)).toBe(true);
    expect(at(marks, 3)?.added, JSON.stringify(marks)).toBe(true);
    expect(at(marks, 5)?.modified, JSON.stringify(marks)).toBe(true);
    expect(at(marks, 5)?.seam, "缝必须落在改了的那一行（丁后行Y）的上沿").toBe("top");
    expect(at(marks, 6), "Z 没动，不该被缝连累").toBeUndefined();
    expect(marks.length, JSON.stringify(marks)).toBe(3);
  });
});

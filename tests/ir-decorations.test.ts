// B352-3 装饰区间的纯函数。
//
// 这个文件是即时渲染（IR）的判据重心：它只回答「哪些块该被渲染、哪一块该露源码」，
// 不碰 CM 实例、不碰 DOM。把这件事做成纯函数是为了能被表驱动测到边界 —— 一旦相交
// 判定散进 ViewPlugin 里，就得在 jsdom 里造真编辑器才测得动，而这类判据的坑全在边界上。
//
// 边界口径（块区间算半开 `[from, to)`，`to` 把该块末尾那个换行也吞进去，否则每块之间
// 会留一行空白）：
//   · 光标停在某块首字符 ⇒ 展开这一块；
//   · 同一个字节位置也是上一块吞掉的那个换行 ⇒ **不**展开上一块
//     （所以判据里这对用例必须成对出现）。
//
// 鉴别力说明：静态判据那套「内存替身」手法在这里用不上（这是行为判据，不是正则判据），
// 换成**双向成对**的用例：无条件全发会打红「光标在内 ⇒ 不出现」，一概不发会打红
// 「光标在外 ⇒ 出现」，锁态写漏会打红 locked 那一组。三条退化各被一条抓住。
import { EditorState } from "@codemirror/state";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { irDecorationsFor, irFocusLines, shiftBlocks } from "../src/markdown/ir-decorations";
import { stripLineComments } from "./static";

/**
 * 三份块：标题（1 行）、段落（3-5 行，跨行才看得出「吞换行」）、列表（7-8 行）。
 * 行 2 / 6 是空行，故意不属于任何块 —— 块之间的空行不该被任何替换盖住。
 */
const DOC = "# Title\n\nline A\nline B\nline C\n\n- one\n- two\n";
const BLOCKS = [
  { lineStart: 1, lineEnd: 1, html: "<h1>Title</h1>" },
  { lineStart: 3, lineEnd: 5, html: "<p>line A line B line C</p>" },
  { lineStart: 7, lineEnd: 8, html: "<ul><li>one</li><li>two</li></ul>" },
];

const state = EditorState.create({ doc: DOC });
const doc = state.doc;

/** 取替换覆盖的块起始行，便于一次断言整组。 */
function starts(selections: { from: number; to: number }[], locked = false): number[] {
  return irDecorationsFor(BLOCKS, selections, doc, locked).map((r) => r.lineStart);
}

describe("B352-3 irDecorationsFor：谁被渲染、谁露源码", () => {
  it("光标在多行段落中间 ⇒ 整段露源码，其余块渲染", () => {
    const caret = doc.line(4).from + 2;
    expect(starts([{ from: caret, to: caret }])).toEqual([1, 7]);
  });

  it("光标在块外（空行上）⇒ 三块全渲染", () => {
    const caret = doc.line(2).from;
    expect(starts([{ from: caret, to: caret }])).toEqual([1, 3, 7]);
  });

  it("块区间吞掉自己那个换行", () => {
    const replacements = irDecorationsFor(BLOCKS, [], doc, true);
    const byStart = new Map(replacements.map((r) => [r.lineStart, r]));
    expect(byStart.get(1)!.to, "单行块把行尾换行一起吃掉，否则块之间多一行空白").toBe(
      doc.line(1).to + 1,
    );
    expect(byStart.get(3)!.from).toBe(doc.line(3).from);
    expect(byStart.get(3)!.to).toBe(doc.line(5).to + 1);
    // DOC 以 \n 结尾 ⇒ CM 里还有第 9 行（空行），所以尾块也吞得到一个换行；
    // 「没有换行可吞」的情形在下面的退化用例里量（单行、无尾换行的文档）。
    expect(doc.lines, "以换行结尾的文档多出一行空行").toBe(9);
    expect(byStart.get(7)!.to).toBe(doc.line(8).to + 1);
  });

  it("相邻块的区间首尾相接、互不重叠（CM6 要求 RangeSet 不交叠）", () => {
    const replacements = irDecorationsFor(BLOCKS, [], doc, true);
    for (let i = 1; i < replacements.length; i++) {
      expect(replacements[i].from >= replacements[i - 1].to, `第 ${i} 块压到前一块上`).toBe(true);
    }
  });

  it("光标停在「上一块吞掉的换行＝后一块首字符」那一个字节上：展开后一块，不展开前一块", () => {
    // 紧贴的两块（标题行下面直接跟正文，中间没有空行）才会共用这一个字节
    const tight = EditorState.create({ doc: "# Head\nbody\n" });
    const adjacent = [
      { lineStart: 1, lineEnd: 1, html: "<h1>Head</h1>" },
      { lineStart: 2, lineEnd: 2, html: "<p>body</p>" },
    ];
    const at = tight.doc.line(2).from; // 既是块 1 的 to（那个换行），也是块 2 的 from
    expect(
      irDecorationsFor(adjacent, [{ from: at, to: at }], tight.doc, false).map((r) => r.lineStart),
      "光标在块 2 的第一个字符上 ⇒ 展开块 2；它同时是块 1 吞掉的换行 ⇒ 不许连带展开块 1",
    ).toEqual([1]);
  });

  it("锁态零焦点例外：光标在段落里也照样全渲染", () => {
    const caret = doc.line(4).from + 2;
    expect(starts([{ from: caret, to: caret }], true)).toEqual([1, 3, 7]);
  });

  it("多光标分别命中两块 ⇒ 那两块都露源码", () => {
    const a = doc.line(1).from;
    const b = doc.line(8).from + 1;
    expect(
      starts([
        { from: a, to: a },
        { from: b, to: b },
      ]),
    ).toEqual([3]);
  });

  it("一个选区跨三块 ⇒ 按区间重叠算，三块全露源码", () => {
    expect(starts([{ from: doc.line(1).from, to: doc.line(8).to }])).toEqual([]);
  });

  it("选区只碰到块的第一行也算相交（不按「包含整块」判）", () => {
    const selFrom = doc.line(3).from;
    const selTo = doc.line(3).to;
    expect(starts([{ from: selFrom, to: selTo }])).toEqual([1, 7]);
  });

  it("三种退化都不炸", () => {
    const empty = EditorState.create({ doc: "" });
    expect(irDecorationsFor([], [], empty.doc, false)).toEqual([]);
    expect(
      irDecorationsFor(BLOCKS, [], empty.doc, true),
      "空文档上块行号全部越界 ⇒ 什么都不产出，不许抛",
    ).toEqual([]);
    const singleLineDoc = EditorState.create({ doc: "just one line" });
    const one = [{ lineStart: 1, lineEnd: 1, html: "<p>just one line</p>" }];
    const got = irDecorationsFor(one, [], singleLineDoc.doc, true);
    expect(got).toHaveLength(1);
    expect(got[0].to, "末行没有换行可吞 ⇒ 区间止于行尾").toBe(singleLineDoc.doc.line(1).to);
  });

  it("越界的块行号（文档被改短之后）不抛异常也不产出假区间", () => {
    const stale = [{ lineStart: 99, lineEnd: 120, html: "<p>gone</p>" }];
    expect(irDecorationsFor(stale, [], doc, true), "行号越界要被夹住").toEqual([]);
  });
});

describe("B352-3 irFocusLines：哪几行该画焦点标识", () => {
  it("给出与选区相交那些块的起始行", () => {
    const caret = doc.line(4).from;
    expect(irFocusLines(BLOCKS, [{ from: caret, to: caret }], doc, false)).toEqual([3]);
  });

  it("锁态下没有焦点块", () => {
    const caret = doc.line(4).from;
    expect(irFocusLines(BLOCKS, [{ from: caret, to: caret }], doc, true)).toEqual([]);
  });

  it("空选区返回空（不猜「第一块」）", () => {
    expect(irFocusLines(BLOCKS, [], doc, false)).toEqual([]);
  });
});

describe("B352-3 结构判据：这层保持纯净", () => {
  // 判据前先抹注释（行注释与块注释都抹）—— 文件头的散文里就写着 "@codemirror/view"，
  // 不抹的话这条判据会被自己的注释喂假（本仓记过同一条坑）。
  const src = stripLineComments(readFileSync("src/markdown/ir-decorations.ts", "utf-8")).replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

  it("不 import 视图层，也不碰 DOM（纯函数才测得动）", () => {
    expect(src, "不许依赖 @codemirror/view").not.toMatch(/@codemirror\/view/);
    expect(src, "不许出现 document / querySelector").not.toMatch(/\bdocument\b|querySelector/);
  });

  it("锁与相交是两个独立判断，不许揉成一条表达式（揉了就只有一条判据能打红）", () => {
    const body = src.slice(src.indexOf("export function irDecorationsFor"));
    expect(body, "锁态要有自己的分支").toMatch(/if\s*\(locked\)/);
    expect(body, "不许把两个概念合并成 intersects && !locked 这种一条式").not.toMatch(
      /intersects\s*&&\s*!locked|!locked\s*&&\s*intersects/,
    );
  });
});

describe("B352-11（评审 I5）打字顶掉行号之后的块表", () => {
  const B = (lineStart: number, lineEnd: number) => ({
    lineStart,
    lineEnd,
    html: `<p>${lineStart}</p>`,
  });

  it("改点落在哪一块，那一块就作废（html 已经旧了），其后的块按行数平移", () => {
    // 第 1 行行尾按一次回车 ⇒ 多出一行；第 3 行那块整体下移一行，**内容还是它自己的**
    expect(shiftBlocks([B(1, 1), B(3, 3)], [{ from: 1, to: 1, deltaLines: 1 }])).toEqual([
      { lineStart: 4, lineEnd: 4, html: "<p>3</p>" },
    ]);
  });

  it("删掉一整行 ⇒ 相交那块作废，其后各块上移", () => {
    expect(shiftBlocks([B(1, 1), B(3, 5)], [{ from: 1, to: 1, deltaLines: -1 }])).toEqual([
      { lineStart: 2, lineEnd: 4, html: "<p>3</p>" },
    ]);
  });

  it("改点落在两块之间的空行 ⇒ 两块都不动（没挨着内容，html 仍然对得上）", () => {
    const blocks = [B(1, 1), B(3, 3)];
    expect(shiftBlocks(blocks, [{ from: 2, to: 2, deltaLines: 0 }])).toEqual(blocks);
  });

  it("多个改点按各自的累计量平移（不是只算最后一条）", () => {
    const blocks = [B(1, 1), B(3, 3), B(6, 6)];
    // 第 1 行回车 +1；第 5 行删掉一行 -1 ⇒ 第 6 行那块两个改点都在它前面，净 0
    expect(
      shiftBlocks(blocks, [
        { from: 1, to: 1, deltaLines: 1 },
        { from: 5, to: 5, deltaLines: -1 },
      ]),
    ).toEqual([
      { lineStart: 4, lineEnd: 4, html: "<p>3</p>" },
      { lineStart: 6, lineEnd: 6, html: "<p>6</p>" },
    ]);
  });

  it("行内改字（行数不变）只作废那一块，其余原样 —— 不许顺手全篇重算", () => {
    const blocks = [B(1, 1), B(3, 3)];
    expect(shiftBlocks(blocks, [{ from: 1, to: 1, deltaLines: 0 }])).toEqual([B(3, 3)]);
  });

  it("平移后行号倒挂或掉到 1 以下的块丢弃（宁可露源码，也不发一个越界装饰）", () => {
    expect(shiftBlocks([B(2, 3)], [{ from: 1, to: 4, deltaLines: -3 }])).toEqual([]);
  });

  it("没有改点（纯选区移动）⇒ 块表一字不动", () => {
    const blocks = [B(1, 1), B(3, 3)];
    expect(shiftBlocks(blocks, [])).toEqual(blocks);
  });
});

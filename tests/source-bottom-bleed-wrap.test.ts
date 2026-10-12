// @vitest-environment jsdom
// B283：源码末行**软折行**（一个逻辑行被 CM6 拆成多个视觉块）时，底部留白必须按「末视觉块底
//   − 首视觉块顶」取整行高来算，不能只取 `lineBlockAt(末行.from)` 给的**首视觉块高**（单行高）。
//
// 旧写法只取首视觉块高 ⇒ 折行末行留白偏小（甚至为负）⇒ 末行贴不了容器顶（用户报：源码末行
//   折行后滚不到顶、兄弟格跟不到末行底）。这条用例直接钉 `sourceBottomBleedPx` 的返回值，
//   与预览侧 `lastLineHeightOf`（末行整高）同一个口径。
//
// ⚠️ 不拉真机 CM6（真机没法在桩上造「折行」：`.cm-line` 高度是均匀 mock 的）；这里喂一个
//   形状与 `EditorView` 等价的假 view，只用到函数实际读的那 4 个字段
//   （`scrollDOM.clientHeight` / `state.doc` / `lineBlockAt` / `defaultLineHeight`），
//   把「首视觉块高 ≠ 整行高」这一关键不变量钉死。
import { describe, it, expect } from "vitest";

type Block = { top: number; height: number };

function fakeView(opts: {
  clientH: number;
  lineCount: number;
  lastLineFrom: number;
  docLen: number;
  firstBlock: Block;
  lastBlock: Block;
  defaultLineHeight?: number;
}): unknown {
  return {
    scrollDOM: { clientHeight: opts.clientH },
    defaultLineHeight: opts.defaultLineHeight ?? 14,
    state: {
      doc: {
        lines: opts.lineCount,
        length: opts.docLen,
        // `doc.line(doc.lines)`：函数只取 `.from`，忽略行号
        line: () => ({ from: opts.lastLineFrom }),
      },
    },
    // `lineBlockAt(pos)`：末行首块 / 末视觉块各给不同高，模拟「软折行」
    lineBlockAt: (pos: number): Block =>
      pos === opts.lastLineFrom ? opts.firstBlock : opts.lastBlock,
  };
}

// ⚠️ 必须先动态 import：editor.ts 顶层 import `@codemirror/*`，若静态挂会撞上 vi.mock 提升
//   （`sourceBottomBleedPx` 不依赖那些 mock，但 vitest 要求 import 在 `.test.ts` 顶层就解析）。
const { sourceBottomBleedPx } = await import("../src/editor/editor");

describe("B283 源码末行软折行：留白 = 视口高 − 末行整高（末视觉块底 − 首视觉块顶）", () => {
  const CLIENT_H = 60;
  const ROW = 14;

  it("非折行末行（整高 = 单行高）：留白 = 视口 − 单行，与旧写法一致", () => {
    // 末行只占一行 ⇒ 首视觉块与末视觉块是同一个（top=1000, height=14）
    const v = fakeView({
      clientH: CLIENT_H,
      lineCount: 10,
      lastLineFrom: 150,
      docLen: 200,
      firstBlock: { top: 1000, height: ROW },
      lastBlock: { top: 1000, height: ROW },
    });
    // 整高 = 14 ⇒ 留白 = 60 − 14 = 46；首视觉块高也是 14 ⇒ 新旧写法结果相同（回归不回退）
    expect(sourceBottomBleedPx(v as never), "非折行：留白 = 视口 − 单行高").toBeCloseTo(
      CLIENT_H - ROW,
      6,
    );
  });

  it("折行末行（整高 > 首视觉块高）：留白按整行高算，≠ 只取首视觉块高的旧值", () => {
    // 末行折成 3 个视觉块（整高 = 3×ROW = 42）：首块 top=1000 高 14，末块 top=1028 高 14
    //   ⇒ 整行高 = 1028 + 14 − 1000 = 42。
    const v = fakeView({
      clientH: CLIENT_H,
      lineCount: 10,
      lastLineFrom: 150,
      docLen: 200,
      firstBlock: { top: 1000, height: ROW },
      lastBlock: { top: 1000 + 2 * ROW, height: ROW },
    });
    const bleed = sourceBottomBleedPx(v as never);
    // 整高 42 ⇒ 留白 = 60 − 42 = 18（正确的、刚好够把整行顶到容器顶）
    expect(bleed, "折行：留白 = 视口 − 末行整高（42）").toBeCloseTo(CLIENT_H - 3 * ROW, 6);
    // ⚠️ 反向钉：旧写法只取首视觉块高（14）⇒ 留白 = 46；新值必须明显不同，否则没修到根。
    expect(bleed, "新留白必须 ≠ 只取首视觉块高的旧值（46）").not.toBeCloseTo(CLIENT_H - ROW, 6);
  });

  it("折行末行整高超过视口：留白归 0（不能再多留，否则反而把内容顶出界）", () => {
    // 末行折成 6 个视觉块（整高 = 6×ROW = 84 > 视口 60）：首块高 14，末块 top=1000+5×ROW
    //   ⇒ 整行高 = 84。
    const v = fakeView({
      clientH: CLIENT_H,
      lineCount: 10,
      lastLineFrom: 150,
      docLen: 200,
      firstBlock: { top: 1000, height: ROW },
      lastBlock: { top: 1000 + 5 * ROW, height: ROW },
    });
    // 整高 84 > 视口 60 ⇒ Math.max(0, 60 − 84) = 0（不带负号、不偏小）
    expect(sourceBottomBleedPx(v as never), "整高 > 视口 ⇒ 留白 = 0（不取负）").toBe(0);
  });

  it("容器高量不出（离屏 clientHeight=0）：一律返回 0，一个字节都不写", () => {
    const v = fakeView({
      clientH: 0,
      lineCount: 10,
      lastLineFrom: 150,
      docLen: 200,
      firstBlock: { top: 1000, height: ROW },
      lastBlock: { top: 1028, height: ROW },
    });
    expect(sourceBottomBleedPx(v as never), "离屏：留白 = 0").toBe(0);
  });

  it("末行高量不出（heightMap 还在估算，首块 height=0）：退回 defaultLineHeight，永不退回 0", () => {
    // 首块 height=0 ⇒ 走 「量不出 ⇒ 退回 defaultLineHeight」分支
    const v = fakeView({
      clientH: CLIENT_H,
      lineCount: 10,
      lastLineFrom: 150,
      docLen: 200,
      firstBlock: { top: 0, height: 0 },
      lastBlock: { top: 0, height: 0 },
      defaultLineHeight: ROW,
    });
    // 退回 defaultLineHeight=14 ⇒ 留白 = 60 − 14 = 46（恒 > 0）
    expect(
      sourceBottomBleedPx(v as never),
      "量不出 ⇒ 退回默认行高，留白 = 视口 − 默认行高",
    ).toBeCloseTo(CLIENT_H - ROW, 6);
  });
});

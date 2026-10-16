import { describe, it, expect } from "vitest";
import { type EditorScrollSurface, EditorScrollAnchor } from "../src/sync-scroll/anchor";

/**
 * 构造一个确定几何的 fake 编辑器表面：lines 行，第 i 行（1-based）高 heights[i-1]，
 * 顶部 content 坐标 tops[i-1] = sum(前 i-1 行高)。doc 位置按每行 100 递增，
 * 使 `lineAt(from).number` 与 `line(n).from` 自洽。jsdom 无布局，全程用纯数，
 * 故本测试不依赖 CodeMirror 测量，能精确断言 getV/setV 往返。
 */
function makeFakeDoc(heights: number[]): EditorScrollSurface {
  const tops: number[] = [];
  let acc = 0;
  for (const h of heights) {
    tops.push(acc);
    acc += h;
  }
  const total = acc;
  return {
    scrollDOM: { scrollTop: 0 },
    lineBlockAtHeight(h: number) {
      const hh = Math.max(0, Math.min(h, Math.max(0, total - 1)));
      for (let i = 0; i < heights.length; i++) {
        if (hh >= tops[i] && hh < tops[i] + heights[i]) {
          return { top: tops[i], height: heights[i], from: i * 100 };
        }
      }
      const last = heights.length - 1;
      return { top: tops[last], height: heights[last], from: last * 100 };
    },
    lineBlockAt(pos: number) {
      const i = Math.min(heights.length - 1, Math.max(0, Math.floor(pos / 100)));
      return { top: tops[i], height: heights[i], from: i * 100 };
    },
    state: {
      doc: {
        lines: heights.length,
        line(n: number) {
          return { from: (n - 1) * 100 };
        },
        lineAt(pos: number) {
          return { number: Math.floor(pos / 100) + 1 };
        },
      },
    },
  };
}

describe("EditorScrollAnchor.getV", () => {
  // 4 行，每行 10px：tops = [0,10,20,30]。
  const doc = makeFakeDoc([10, 10, 10, 10]);

  it("视口顶在第 1 行顶部时 v=1.0", () => {
    doc.scrollDOM.scrollTop = 0;
    expect(new EditorScrollAnchor(doc).getV()).toBe(1.0);
  });

  it("顶边压在第 1 行半程时 v=1.5", () => {
    doc.scrollDOM.scrollTop = 5;
    expect(new EditorScrollAnchor(doc).getV()).toBe(1.5);
  });

  it("顶边压在第 2 行顶部时 v=2.0", () => {
    doc.scrollDOM.scrollTop = 10;
    expect(new EditorScrollAnchor(doc).getV()).toBe(2.0);
  });

  it("顶边压在第 3 行半程时 v=3.5", () => {
    doc.scrollDOM.scrollTop = 25;
    expect(new EditorScrollAnchor(doc).getV()).toBe(3.5);
  });
});

describe("EditorScrollAnchor.setV / getV 往返一致", () => {
  const doc = makeFakeDoc([10, 10, 10, 10]);

  const cases: Array<[number, number]> = [
    [1.0, 0],
    [1.5, 5],
    [2.0, 10],
    [3.5, 25],
    [4.8, 38],
  ];

  for (const [v, expectTop] of cases) {
    it(`setV(${v}) 落到 scrollTop=${expectTop}`, () => {
      const a = new EditorScrollAnchor(doc);
      a.setV(v);
      expect(doc.scrollDOM.scrollTop).toBe(expectTop);
    });

    it(`setV(${v}) 后 getV 读回 ${v}`, () => {
      const a = new EditorScrollAnchor(doc);
      a.setV(v);
      expect(a.getV()).toBeCloseTo(v, 10);
    });
  }
});

describe("EditorScrollAnchor.setV 越界夹紧", () => {
  const doc = makeFakeDoc([10, 10, 10, 10]);

  it("v=0 夹紧到第 1 行顶部（v 不会 < 1）", () => {
    const a = new EditorScrollAnchor(doc);
    a.setV(0);
    expect(doc.scrollDOM.scrollTop).toBe(0);
    expect(a.getV()).toBe(1.0);
  });

  it("v 超过末行夹到末行（不抛、不越界）", () => {
    const a = new EditorScrollAnchor(doc);
    // 超出范围的输入是协调器不会产生的（v 来自 getV，恒在 [1, N+1)）；
    // 这里只验证不抛、且夹到末行底部（frac 夹到 1 → scrollTop = top + h）。
    a.setV(99);
    expect(doc.scrollDOM.scrollTop).toBe(40);
    expect(Number.isFinite(a.getV())).toBe(true);
  });
});

describe("EditorScrollAnchor 不规则行高", () => {
  // 第 1 行 20px（如折叠/换行），其余 10px：tops=[0,20,30,40]。
  const doc = makeFakeDoc([20, 10, 10, 10]);

  it("顶边压在第 1 行（高 20）半程 → v=1.5", () => {
    doc.scrollDOM.scrollTop = 10;
    expect(new EditorScrollAnchor(doc).getV()).toBe(1.5);
  });

  it("setV(1.5) 在 20px 行里落 scrollTop=10，往返一致", () => {
    const a = new EditorScrollAnchor(doc);
    a.setV(1.5);
    expect(doc.scrollDOM.scrollTop).toBe(10);
    expect(a.getV()).toBeCloseTo(1.5, 10);
  });
});

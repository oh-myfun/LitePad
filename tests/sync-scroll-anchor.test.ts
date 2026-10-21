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

  // B319：预览有了块间节奏之后，两侧在同一个 `v` 下的「剩余内容高度」不再相等 ——
  // 「容器顶对齐到第 N 行」这一发到底时再也撞不上各自的底。共享坐标必须在**被自己
  // 的底裁住**时饱和成「文档末尾」，让接的那一侧靠浏览器裁剪各到各的底。
  it("被自己的底裁住时，报的是文档末尾那一行（不是还能往下对齐的行号）", () => {
    const at = makeFakeDoc([10, 10, 10, 10]);
    Object.assign(at.scrollDOM, { scrollTop: 20, clientHeight: 20, scrollHeight: 40 });
    expect(new EditorScrollAnchor(at).getV()).toBe(4);
  });

  it("没到底时照常报「容器顶那一行」，不许提前饱和", () => {
    const mid = makeFakeDoc([10, 10, 10, 10]);
    Object.assign(mid.scrollDOM, { scrollTop: 10, clientHeight: 20, scrollHeight: 40 });
    expect(new EditorScrollAnchor(mid).getV()).toBe(2.0);
  });

  it("内容不够高（压根不能滚）时不认「到底」，免得短文档永远报末尾", () => {
    const short = makeFakeDoc([10, 10, 10, 10]);
    Object.assign(short.scrollDOM, { scrollTop: 0, clientHeight: 80, scrollHeight: 40 });
    expect(new EditorScrollAnchor(short).getV()).toBe(1.0);
  });

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

/**
 * 带**视觉行**几何的假编辑器面（B300 · 逐行对齐）。
 *
 * 软折行时 CM6 给一个逻辑行一个块（`lineBlockAt` 返回整块），块里每一视觉行有自己的矩形：
 * `coordsAtPos(char)` 报那一行的屏幕矩形、`posAtCoords(点)` 报那一点下的字符。jsdom 没有
 * 布局，所以这两处照 CM6 的语义脚本化：每行 `rows` 个视觉行、每行 `rowH` 高、行首字符按
 * 行长度均分。`scrollTop` 是**内容坐标**，容器顶在屏幕 `CONTAINER_TOP`。
 */
function makeRowDoc(lines: { len: number; rows: number }[]) {
  const rowH = 20;
  const CONTAINER_TOP = 100;
  const rows: { top: number; charFrom: number; charTo: number; line: number }[] = [];
  let contentTop = 0;
  let from = 0;
  for (let i = 0; i < lines.length; i++) {
    const { len, rows: n } = lines[i];
    const per = Math.max(1, Math.floor(len / n));
    for (let r = 0; r < n; r++) {
      const charFrom = from + r * per;
      const charTo = r === n - 1 ? from + len : from + (r + 1) * per;
      rows.push({ top: contentTop + r * rowH, charFrom, charTo, line: i });
    }
    contentTop += n * rowH;
    from += len;
  }
  const tops = lines.map((_, i) => rows.filter((r) => r.line < i).length * rowH);
  const heights = lines.map((l) => l.rows * rowH);
  const starts = (() => {
    const s: number[] = [];
    let f = 0;
    for (const l of lines) {
      s.push(f);
      f += l.len;
    }
    return s;
  })();
  const scrollDOM = {
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: CONTAINER_TOP, left: 0, height: 200 }),
  };
  const surface = {
    scrollDOM,
    lineBlockAtHeight(h: number) {
      const hh = Math.max(0, Math.min(h, contentTop - 1));
      for (let i = 0; i < lines.length; i++) {
        if (hh >= tops[i] && hh < tops[i] + heights[i]) {
          return { top: tops[i], height: heights[i], from: starts[i] };
        }
      }
      const last = lines.length - 1;
      return { top: tops[last], height: heights[last], from: starts[last] };
    },
    lineBlockAt(pos: number) {
      let i = 0;
      for (let k = 0; k < starts.length; k++) if (pos >= starts[k]) i = k;
      return { top: tops[i], height: heights[i], from: starts[i] };
    },
    /** 容器顶那一点落在哪个视觉行 ⇒ 返回那一点下的字符（CM6 的 `precise:false` 估算）。 */
    posAtCoords({ y }: { x: number; y: number }) {
      const contentY = y - CONTAINER_TOP + scrollDOM.scrollTop;
      let hit = rows[0];
      for (const r of rows) if (r.top <= contentY + 1e-6) hit = r;
      return hit.charFrom;
    },
    coordsAtPos(pos: number) {
      const r = rows.find((x) => pos >= x.charFrom && pos < x.charTo) ?? rows[rows.length - 1];
      const top = r.top - scrollDOM.scrollTop + CONTAINER_TOP;
      return { top, bottom: top + rowH, left: 0, right: 10 };
    },
    state: {
      doc: {
        lines: lines.length,
        line(n: number) {
          return { from: starts[n - 1] };
        },
        lineAt(pos: number) {
          let i = 0;
          for (let k = 0; k < starts.length; k++) if (pos >= starts[k]) i = k;
          return { number: i + 1 };
        },
      },
    },
  } as unknown as EditorScrollSurface;
  return { surface, scrollDOM, rows, CONTAINER_TOP };
}

describe("EditorScrollAnchor · 视觉行位置（B300 逐行对齐）", () => {
  // A：4 个逻辑行，第 3 行折成 3 个视觉行。内容顶：行1=0，行2=20，行3=40/60/80，行4=100。
  // 行 3 从字符 200 起，每视觉行 40 字 ⇒ 行首字符 200 / 240 / 280。
  const A = makeRowDoc([
    { len: 100, rows: 1 },
    { len: 100, rows: 1 },
    { len: 120, rows: 3 },
    { len: 100, rows: 1 },
  ]);

  it("topPos() 取的是容器顶那一视觉行的行首字符", () => {
    const a = new EditorScrollAnchor(A.surface);
    A.scrollDOM.scrollTop = 0;
    expect(a.topPos!()).toBe(0);
    A.scrollDOM.scrollTop = 60; // 第 3 行的第 2 个视觉行顶
    expect(a.topPos!()).toBe(240);
    A.scrollDOM.scrollTop = 100;
    expect(a.topPos!()).toBe(320); // 第 4 行行首
  });

  it("setVAt(pos) 把那个字符所在视觉行的行顶贴到容器顶，并诚实读回 v", () => {
    const a = new EditorScrollAnchor(A.surface);
    // 260 落在第 3 行的第 2 个视觉行（240..280），那一行的内容顶是 60。
    expect(a.setVAt!(260)).toBeCloseTo(3 + 20 / 60, 6);
    expect(A.scrollDOM.scrollTop).toBe(60);
    expect(a.topPos!()).toBe(240); // 顶边读回来就是那一行的行首
  });

  it("宽度不同 ⇒ 同一字符落到不同像素，但两边顶边是**包含它的那一视觉行**（只传 v 做不到的事）", () => {
    // 同一份文档，另一格更窄：第 1 行也折了，第 3 行折成 4 行 ⇒ 每一视觉行的内容顶全变了。
    const B = makeRowDoc([
      { len: 100, rows: 2 },
      { len: 100, rows: 1 },
      { len: 120, rows: 4 },
      { len: 100, rows: 1 },
    ]);
    const a = new EditorScrollAnchor(A.surface);
    const b = new EditorScrollAnchor(B.surface);
    A.scrollDOM.scrollTop = 60; // A 停在第 3 行第 2 个视觉行
    const pos = a.topPos!()!; // 240
    expect(pos).toBe(240);
    const va = a.getV();
    b.setVAt!(pos);
    const vb = b.getV();
    // B 里 240 属于第 3 行的第 1 个视觉行（230..260），其内容顶是 80 ⇒ 两侧像素不同
    expect(A.scrollDOM.scrollTop).toBe(60);
    expect(B.scrollDOM.scrollTop).toBe(80);
    // 而两边顶边所在视觉行都**包含**那个字符：这才是用户眼里的「对齐到同一行」
    expect(b.topPos!()).toBeLessThanOrEqual(pos);
    const bRow = B.rows.find((r) => r.top === 80)!;
    expect(bRow.charFrom).toBeLessThanOrEqual(pos);
    expect(pos).toBeLessThan(bRow.charTo);
    // v 按块高比例算，两个宽度下本来就不相等 —— 只传 v 必然差半行到一行（B300 的病根）
    expect(va).not.toBeCloseTo(vb, 2);
  });

  it("拿不到坐标 API（或没有盒）⇒ topPos 给 null、setVAt 退回块顶，不许抛", () => {
    const plain = makeFakeDoc([10, 10, 10, 10]);
    const a = new EditorScrollAnchor(plain);
    expect(a.topPos!()).toBeNull();
    expect(() => a.setVAt!(150)).not.toThrow();
    expect(plain.scrollDOM.scrollTop).toBe(10); // 第 2 行的块顶（兜底）
  });
});

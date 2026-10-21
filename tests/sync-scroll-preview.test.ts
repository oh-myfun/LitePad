import { describe, it, expect } from "vitest";
import {
  type PreviewBlockGeom,
  type PreviewScrollSurface,
  PreviewScrollAnchor,
} from "../src/sync-scroll/preview";

/**
 * 构造一个确定几何的 fake 预览表面：给定各块的 lineStart/lineEnd/top/height，
 * root.scrollTop 可读写，schedule 接到可控队列（不依赖真实 rAF 时序）。
 * jsdom 无布局，全程用纯数，能精确断言 getV/setV 往返与未铺开重试。
 */
function makeFakePreview(blocks: PreviewBlockGeom[], scrollHeight = 0) {
  const root = { scrollTop: 0, clientHeight: 10, scrollHeight };
  let blockState = blocks;
  const queue: Array<() => void> = [];
  const schedule = (fn: () => void) => {
    queue.push(fn);
  };
  const surface: PreviewScrollSurface = {
    root,
    blocks: () => blockState,
    schedule,
  };
  return {
    surface,
    root,
    /** 把块几何换成已铺开状态（用于未铺开→铺开后的重试断言）。 */
    layOut(next: PreviewBlockGeom[]) {
      blockState = next;
    },
    /** 手动清空并取走排队的 rAF 回调，逐发执行。 */
    flush() {
      const q = queue.splice(0, queue.length);
      for (const fn of q) fn();
    },
    pendingCount() {
      return queue.length;
    },
  };
}

describe("PreviewScrollAnchor.getV 的「到底」饱和（B319）", () => {
  // 一块 9 个源行、高 30；视口高 10 ⇒ 可滚上限 20。
  // 预览有了块间节奏之后，两侧在同一个 `v` 下的剩余内容高度不再相等：
  // 「容器顶对齐到第 N 行」这一发到不了自己的底，共享坐标必须在被裁住时改报「末尾」。
  const nine = [{ lineStart: 1, lineEnd: 9, top: 0, height: 30 }];

  it("滚到自己的上限时，报的是最后一块的末行（不是还能往下对齐的行号）", () => {
    const f = makeFakePreview(nine, 30);
    f.root.clientHeight = 10;
    f.root.scrollTop = 20; // = scrollHeight - clientHeight
    expect(new PreviewScrollAnchor(f.surface).getV()).toBe(9);
  });

  it("没到底时照常按块内插值报数", () => {
    const f = makeFakePreview(nine, 30);
    f.root.clientHeight = 10;
    f.root.scrollTop = 10;
    expect(new PreviewScrollAnchor(f.surface).getV()).toBeCloseTo(4, 10);
  });

  it("内容不够高（压根不能滚）时不认「到底」", () => {
    const f = makeFakePreview(nine, 30);
    f.root.clientHeight = 40; // 比内容还高 ⇒ max=0，此刻 scrollTop=0 既是顶也是底
    f.root.scrollTop = 0;
    expect(new PreviewScrollAnchor(f.surface).getV()).toBe(1);
  });
});

describe("PreviewScrollAnchor.getV", () => {
  // 两块：块1 行[1,3] top0 h30；块2 行[4,6] top30 h30。
  const blocks: PreviewBlockGeom[] = [
    { lineStart: 1, lineEnd: 3, top: 0, height: 30 },
    { lineStart: 4, lineEnd: 6, top: 30, height: 30 },
  ];
  const fake = makeFakePreview(blocks);

  it("视口顶在第 1 块顶部时 v=1.0", () => {
    fake.root.scrollTop = 0;
    expect(new PreviewScrollAnchor(fake.surface).getV()).toBe(1.0);
  });

  it("顶边压在第 1 块半程（15px）时，按源行 range=3 插值 → v=2.5", () => {
    fake.root.scrollTop = 15;
    expect(new PreviewScrollAnchor(fake.surface).getV()).toBe(2.5);
  });

  it("顶边压在第 2 块顶（30px，恰为下一块顶）→ v=4.0", () => {
    fake.root.scrollTop = 30;
    expect(new PreviewScrollAnchor(fake.surface).getV()).toBe(4.0);
  });

  it("顶边压在第 1 块 5px → v=1.5", () => {
    fake.root.scrollTop = 5;
    expect(new PreviewScrollAnchor(fake.surface).getV()).toBe(1.5);
  });
});

describe("PreviewScrollAnchor.setV / getV 往返一致（可达域）", () => {
  const blocks: PreviewBlockGeom[] = [
    { lineStart: 1, lineEnd: 3, top: 0, height: 30 },
    { lineStart: 4, lineEnd: 6, top: 30, height: 30 },
  ];
  const fake = makeFakePreview(blocks);

  const cases: Array<[number, number]> = [
    [1.0, 0],
    [1.5, 5],
    [2.5, 15],
    [4.0, 30],
    [5.0, 40],
  ];

  for (const [v, expectTop] of cases) {
    it(`setV(${v}) 落到 scrollTop=${expectTop}`, () => {
      fake.root.scrollTop = 0;
      new PreviewScrollAnchor(fake.surface).setV(v);
      expect(fake.root.scrollTop).toBe(expectTop);
    });

    it(`setV(${v}) 后 getV 读回 ${v}`, () => {
      fake.root.scrollTop = 0;
      const a = new PreviewScrollAnchor(fake.surface);
      a.setV(v);
      expect(a.getV()).toBeCloseTo(v, 10);
    });
  }
});

describe("PreviewScrollAnchor.setV 越界夹紧", () => {
  const blocks: PreviewBlockGeom[] = [
    { lineStart: 1, lineEnd: 3, top: 0, height: 30 },
    { lineStart: 4, lineEnd: 6, top: 30, height: 30 },
  ];
  const fake = makeFakePreview(blocks);

  it("v 超过末行夹到末块顶（不抛、scrollTop 不越界）", () => {
    const a = new PreviewScrollAnchor(fake.surface);
    a.setV(99);
    expect(fake.root.scrollTop).toBe(30);
    expect(Number.isFinite(a.getV())).toBe(true);
  });
});

describe("PreviewScrollAnchor 未铺开走 rAF 重试", () => {
  const unmeasured: PreviewBlockGeom[] = [
    { lineStart: 1, lineEnd: 3, top: 0, height: 0 },
    { lineStart: 4, lineEnd: 6, top: 0, height: 0 },
  ];
  const measured: PreviewBlockGeom[] = [
    { lineStart: 1, lineEnd: 3, top: 0, height: 30 },
    { lineStart: 4, lineEnd: 6, top: 30, height: 30 },
  ];

  it("未铺开时 setV 不动 scrollTop，仅排队一次重试", () => {
    const fake = makeFakePreview(unmeasured);
    const a = new PreviewScrollAnchor(fake.surface);
    a.setV(2.5);
    expect(fake.root.scrollTop).toBe(0);
    expect(fake.pendingCount()).toBe(1);
  });

  it("铺开后 flush 重试 → 落点正确（getV 往返）", () => {
    const fake = makeFakePreview(unmeasured);
    const a = new PreviewScrollAnchor(fake.surface);
    a.setV(2.5);
    fake.layOut(measured);
    fake.flush();
    expect(fake.root.scrollTop).toBe(15);
    expect(a.getV()).toBeCloseTo(2.5, 10);
  });

  it("getV 在未铺开时退回 1.0（与 setV 兜底对称）", () => {
    const fake = makeFakePreview(unmeasured);
    expect(new PreviewScrollAnchor(fake.surface).getV()).toBe(1.0);
  });
});

describe("PreviewScrollAnchor 源行缝隙（块间缺行）稳定落缝前块", () => {
  // 块1 行[1,3] top0 h30；块2 行[5,6] top30 h30（缺第 4 行）。
  const blocks: PreviewBlockGeom[] = [
    { lineStart: 1, lineEnd: 3, top: 0, height: 30 },
    { lineStart: 5, lineEnd: 6, top: 30, height: 30 },
  ];
  const fake = makeFakePreview(blocks);

  it("v=4（缝隙）命中块1末，落块1顶（不误坠底部）", () => {
    const a = new PreviewScrollAnchor(fake.surface);
    a.setV(4);
    // 块1 含 range=5-1=4，into=min(4,4-1=3)=3，top = 0 + (30-0)*3/4 = 22.5。
    expect(fake.root.scrollTop).toBe(22.5);
    expect(a.getV()).toBeCloseTo(4, 10);
  });
});

describe("PreviewScrollAnchor 小数行号跨块不误坠", () => {
  const blocks: PreviewBlockGeom[] = [
    { lineStart: 12, lineEnd: 14, top: 0, height: 30 },
    { lineStart: 16, lineEnd: 18, top: 30, height: 30 },
  ];
  const fake = makeFakePreview(blocks);

  it("v=12.3（带小数）命中块1，按 range 插值落点", () => {
    const a = new PreviewScrollAnchor(fake.surface);
    a.setV(12.3);
    // range=16-12=4，into=min(4,0.3)=0.3，top=0+(30-0)*0.3/4=2.25（浮点非精确，容差比较）。
    expect(fake.root.scrollTop).toBeCloseTo(2.25, 6);
    expect(a.getV()).toBeCloseTo(12.3, 10);
  });
});

describe("PreviewScrollAnchor 空块列表", () => {
  const fake = makeFakePreview([]);
  it("getV 退回 1.0，setV 仅排队重试不抛", () => {
    expect(new PreviewScrollAnchor(fake.surface).getV()).toBe(1.0);
    expect(() => new PreviewScrollAnchor(fake.surface).setV(2)).not.toThrow();
    expect(fake.pendingCount()).toBe(1);
  });
});

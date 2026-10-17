// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { type ScrollAnchor } from "../src/sync-scroll/anchor";
import { type CoordinatedSurface, SyncScrollCoordinator } from "../src/sync-scroll/coordinator";

/** 可控调度：把 rAF 回调排队，手动 flush（不依赖真实时序，便于测合并/广播）。 */
function makeScheduler() {
  const q: Array<() => void> = [];
  let id = 0;
  const schedule = (fn: () => void) => {
    q.push(fn);
    return ++id; // 返回非零 id，使协调器 rafId 守卫生效
  };
  const flush = () => {
    const c = q.splice(0, q.length);
    for (const f of c) f();
  };
  const flushOne = () => {
    const f = q.shift();
    if (f) f();
  };
  return { schedule, flush, flushOne, pending: () => q.length };
}

/** fake 锚点：记录 setV 调用、getV 返回可改写的当前值。 */
function makeFakeAnchor(initialV = 1) {
  let v = initialV;
  const setVCalls: number[] = [];
  const anchor: ScrollAnchor = {
    getV: () => v,
    setV: (x: number) => {
      setVCalls.push(x);
    },
  };
  return {
    anchor,
    setVCalls,
    setGetV(val: number) {
      v = val;
    },
  };
}

describe("SyncScrollCoordinator 同 docId 广播", () => {
  it("syncFrom(driver) 后同 docId 其余 anchor 收到 setV，driver 自身不回写", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makeFakeAnchor(3.5);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1");
    co.register(b.anchor, "f1");
    co.syncFrom(a.anchor);
    sch.flush();
    expect(b.setVCalls).toEqual([3.5]);
    expect(a.setVCalls).toEqual([]); // 不回写 driver
  });

  it("不同 docId 互不串台", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makeFakeAnchor(3.5); // f1
    const b = makeFakeAnchor(1); // f1
    const c = makeFakeAnchor(1); // f2
    co.register(a.anchor, "f1");
    co.register(b.anchor, "f1");
    co.register(c.anchor, "f2");
    co.syncFrom(a.anchor);
    sch.flush();
    expect(b.setVCalls).toEqual([3.5]);
    expect(c.setVCalls).toEqual([]);
  });
});

describe("SyncScrollCoordinator 多锚点（editor+preview+其它 tab）", () => {
  it("同 docId 三个锚点，driver 之外两个都收到", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makeFakeAnchor(2);
    const b = makeFakeAnchor(1);
    const c = makeFakeAnchor(1);
    co.register(a.anchor, "same");
    co.register(b.anchor, "same");
    co.register(c.anchor, "same");
    co.syncFrom(a.anchor);
    sch.flush();
    expect(b.setVCalls).toEqual([2]);
    expect(c.setVCalls).toEqual([2]);
    expect(a.setVCalls).toEqual([]);
  });
});

describe("SyncScrollCoordinator B152 按文档关闭不广播", () => {
  it("setEnabled('f1', false) 后 syncFrom 不写任何同 docId 锚点", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makeFakeAnchor(3.5);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1");
    co.register(b.anchor, "f1");
    co.setEnabled("f1", false);
    co.syncFrom(a.anchor);
    sch.flush();
    expect(b.setVCalls).toEqual([]);
    expect(co.isOn("f1")).toBe(false);
    expect(co.isOn("f2")).toBe(true); // 其它文档默认开
  });
});

describe("SyncScrollCoordinator rAF 合并（last-writer-wins）", () => {
  it("帧内多次触发只广播一次，取帧末 getV", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makeFakeAnchor(1);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1");
    co.register(b.anchor, "f1");
    co.syncFrom(a.anchor); // 排一帧
    a.setGetV(5); // 帧内改变落点
    co.syncFrom(a.anchor); // 守卫命中，不再排帧
    sch.flush();
    expect(b.setVCalls).toEqual([5]); // 仅一次，值为帧末
  });
});

describe("SyncScrollCoordinator syncFrom 按引用查未注册锚点", () => {
  it("传裸 ScrollAnchor 也能定位句柄并广播", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makeFakeAnchor(7);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1");
    co.register(b.anchor, "f1");
    co.syncFrom(a.anchor); // 裸 anchor
    sch.flush();
    expect(b.setVCalls).toEqual([7]);
  });

  it("已注销句柄调用 syncFrom 静默忽略", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makeFakeAnchor(7);
    const b = makeFakeAnchor(1);
    const h = co.register(a.anchor, "f1");
    co.register(b.anchor, "f1");
    co.unregister(h);
    co.syncFrom(h);
    sch.flush();
    expect(b.setVCalls).toEqual([]);
  });
});

describe("SyncScrollCoordinator scroll 监听驱动广播（T6：滚动落定即广播，无需武装）", () => {
  function makeSurface(node: EventTarget): CoordinatedSurface {
    return { events: node };
  }

  it("锚点 scroll 事件直接广播给同 docId 其余锚点", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const node = document.createElement("div");
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    node.dispatchEvent(new Event("scroll"));
    sch.flush();
    expect(b.setVCalls).toEqual([4]);
  });

  it("scroll 之外的事件（wheel/pointerdown/keydown）本身不广播（只有 scroll 驱动）", () => {
    // 这些事件只产生输入、不驱动；驱动仍只在 scroll 上发生。
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const node = document.createElement("div");
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    node.dispatchEvent(new Event("wheel"));
    node.dispatchEvent(new Event("pointerdown"));
    node.dispatchEvent(new Event("keydown"));
    sch.flush();
    expect(b.setVCalls).toEqual([]); // 没有 scroll，不广播
  });

  it("连续 scroll（拖动/惯性/滚轮）每一拍都广播", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const node = document.createElement("div");
    const a = makeFakeAnchor(1);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    node.dispatchEvent(new Event("scroll"));
    a.setGetV(3);
    sch.flush();
    node.dispatchEvent(new Event("scroll"));
    a.setGetV(5);
    sch.flush();
    expect(b.setVCalls).toEqual([3, 5]);
  });

  it("回声抑制：target 因 setV 产生的 scroll 被忽略，不回灌", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const nodeA = document.createElement("div");
    const nodeB = document.createElement("div");
    const a = makeFakeAnchor(4); // driver
    const b = makeFakeAnchor(1); // target
    co.register(a.anchor, "f1", makeSurface(nodeA));
    co.register(b.anchor, "f1", makeSurface(nodeB));
    nodeA.dispatchEvent(new Event("scroll"));
    sch.flushOne(); // 主帧：B.setV(4) + 置 B.programmatic
    expect(b.setVCalls).toEqual([4]);
    expect(a.setVCalls).toEqual([]);
    nodeB.dispatchEvent(new Event("scroll")); // B 回声
    sch.flush(); // 仅跑安全清位
    expect(a.setVCalls).toEqual([]); // 未回灌
    expect(b.setVCalls).toEqual([4]); // B 自身未被再次写
  });

  it("回声清位后 B 再次真实滚动可正常驱动 A", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const nodeA = document.createElement("div");
    const nodeB = document.createElement("div");
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(nodeA));
    co.register(b.anchor, "f1", makeSurface(nodeB));
    nodeA.dispatchEvent(new Event("scroll"));
    sch.flushOne();
    nodeB.dispatchEvent(new Event("scroll")); // 被抑制（programmatic 清位）
    sch.flush();
    // 清位后，B 再滚动应重新驱动 A
    nodeB.dispatchEvent(new Event("scroll"));
    b.setGetV(9);
    sch.flush();
    expect(a.setVCalls).toEqual([9]); // B 这次作为 driver 成功广播
  });

  it("unregister 解绑监听：注销后 scroll 不再广播", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const node = document.createElement("div");
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    const h = co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    co.unregister(h); // 解绑后监听移除
    node.dispatchEvent(new Event("scroll"));
    sch.flush();
    expect(b.setVCalls).toEqual([]);
  });

  it("B152 关闭时 scroll 不广播（当前 pane 仍原生滚）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const node = document.createElement("div");
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    co.setEnabled("f1", false);
    node.dispatchEvent(new Event("scroll"));
    sch.flush();
    expect(b.setVCalls).toEqual([]);
  });

  it("syncFromDriver 用裸锚点直接广播（无需先在册）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makeFakeAnchor(8); // 未在 coordinator 注册的 driver
    const b = makeFakeAnchor(1);
    co.register(b.anchor, "f1");
    co.syncFromDriver("f1", a.anchor);
    sch.flush();
    expect(b.setVCalls).toEqual([8]);
  });

  it("syncFromDriver 在 B152 关的文档上不广播", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makeFakeAnchor(8);
    const b = makeFakeAnchor(1);
    co.register(b.anchor, "f1");
    co.setEnabled("f1", false);
    co.syncFromDriver("f1", a.anchor);
    sch.flush();
    expect(b.setVCalls).toEqual([]);
  });
});

describe("SyncScrollCoordinator 结构性滚动抑制（T7 修正版：自适应突发吞没，非固定时间窗）", () => {
  function makeSurface(node: EventTarget): CoordinatedSurface {
    return { events: node };
  }

  /** 注入 now + quiesceMs 的可控协调器，便于精确测试自适应突发抑制。 */
  function makeClocked(quiesceMs = 150) {
    const sch = makeScheduler();
    const clock = { t: 0 };
    const co = new SyncScrollCoordinator(sch.schedule, { now: () => clock.t, quiesceMs });
    return { sch, co, clock };
  }

  it("进入抑制后，结构性突发内的 scroll 被吞没、不广播（标签切换/复制/分屏/拖拽重排）", () => {
    const { sch, co, clock } = makeClocked();
    const node = document.createElement("div");
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    clock.t = 0;
    co.suppressStructural("f1"); // 结构性操作前进入抑制（最近被吞 = 0）
    clock.t = 10;
    node.dispatchEvent(new Event("scroll")); // CM6 setState 归零重排产生的 scroll（突发内）
    sch.flush();
    expect(b.setVCalls).toEqual([]); // 被吞没，不广播（防自动跳变/调回顶部）
  });

  it("突发静默超 quiesceMs 后，下一条 scroll 视为用户滚动、自动解除并广播", () => {
    const { sch, co, clock } = makeClocked(150);
    const node = document.createElement("div");
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    clock.t = 0;
    co.suppressStructural("f1"); // 最近被吞 = 0
    clock.t = 200; // 距上次被吞 200 > 150，突发结束
    node.dispatchEvent(new Event("scroll")); // 真正的用户滚动
    sch.flush();
    expect(b.setVCalls).toEqual([4]); // 解除抑制后正常广播
  });

  it("自适应突发：连续多条 scroll 间隔都在 quiesce 内全部吞没；之后静默超间隙才广播", () => {
    const { sch, co, clock } = makeClocked(150);
    const node = document.createElement("div");
    const a = makeFakeAnchor(1);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    clock.t = 0;
    co.suppressStructural("f1"); // 最近被吞 = 0
    clock.t = 10;
    node.dispatchEvent(new Event("scroll"));
    a.setGetV(2);
    sch.flush(); // 距0 ≤150 吞
    clock.t = 20;
    node.dispatchEvent(new Event("scroll"));
    a.setGetV(3);
    sch.flush(); // 距10 ≤150 吞
    clock.t = 30;
    node.dispatchEvent(new Event("scroll"));
    a.setGetV(4);
    sch.flush(); // 距20 ≤150 吞
    expect(b.setVCalls).toEqual([]); // 突发内全部未广播
    clock.t = 300;
    node.dispatchEvent(new Event("scroll"));
    a.setGetV(9);
    sch.flush(); // 距30=270>150 解除
    expect(b.setVCalls).toEqual([9]); // 用户滚动才广播
  });

  it("按 docId 隔离：被抑制的 docId 在突发内不广播，其它 docId 照常广播", () => {
    const { sch, co, clock } = makeClocked();
    const nodeF1 = document.createElement("div");
    const nodeF2 = document.createElement("div");
    const a = makeFakeAnchor(4); // f1 driver
    const b = makeFakeAnchor(1); // f1 target
    const c = makeFakeAnchor(9); // f2 driver
    const d = makeFakeAnchor(1); // f2 target
    co.register(a.anchor, "f1", makeSurface(nodeF1));
    co.register(b.anchor, "f1");
    co.register(c.anchor, "f2", makeSurface(nodeF2));
    co.register(d.anchor, "f2");
    clock.t = 0;
    co.suppressStructural("f1"); // 仅抑制 f1（最近被吞 f1 = 0）
    clock.t = 10;
    nodeF1.dispatchEvent(new Event("scroll")); // f1 结构性（突发内）
    nodeF2.dispatchEvent(new Event("scroll")); // f2 用户滚动（无抑制）
    sch.flush();
    expect(b.setVCalls).toEqual([]); // f1 被吞没
    expect(d.setVCalls).toEqual([9]); // f2 照常广播
  });

  it("syncFromDriver 不经抑制（TOC/查找/转到行必须照常同步）", () => {
    const { sch, co, clock } = makeClocked();
    const node = document.createElement("div");
    const a = makeFakeAnchor(8); // 裸 driver
    const b = makeFakeAnchor(1);
    co.register(b.anchor, "f1", makeSurface(node));
    clock.t = 0;
    co.suppressStructural("f1"); // 即便抑制中，程序化跳转仍广播
    co.syncFromDriver("f1", a.anchor);
    sch.flush();
    expect(b.setVCalls).toEqual([8]); // 绕过抑制
  });

  it("suppressStructural 对未注册 docId 也无副作用（静默超间隙后注册不残留抑制）", () => {
    const { sch, co, clock } = makeClocked(150);
    clock.t = 0;
    co.suppressStructural("fX"); // 抑制一个尚未注册的 docId（模拟先抑制后 reconcile）
    clock.t = 200; // 距上次被吞 200 > 150，已解除
    const node = document.createElement("div");
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "fX", makeSurface(node));
    co.register(b.anchor, "fX");
    node.dispatchEvent(new Event("scroll"));
    sch.flush();
    expect(b.setVCalls).toEqual([4]); // 解除后正常广播，无残留抑制
  });

  it("re-suppress 续杯：抑制中途再次 suppress 重置时间戳，延长突发覆盖", () => {
    const { sch, co, clock } = makeClocked(150);
    const node = document.createElement("div");
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    clock.t = 0;
    co.suppressStructural("f1"); // 最近被吞 = 0
    clock.t = 100;
    co.suppressStructural("f1"); // 续杯：最近被吞 = 100
    clock.t = 200;
    node.dispatchEvent(new Event("scroll")); // 距100 = 100 ≤150，仍在突发内
    sch.flush();
    expect(b.setVCalls).toEqual([]); // 仍被吞没
  });
});

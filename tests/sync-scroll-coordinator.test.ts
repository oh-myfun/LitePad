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

describe("SyncScrollCoordinator scroll 监听", () => {
  function makeSurface(node: EventTarget): CoordinatedSurface {
    return { events: node };
  }

  it("scroll 事件触发广播（flush 后目标收到）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const node = new EventTarget();
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    node.dispatchEvent(new Event("scroll"));
    sch.flush();
    expect(b.setVCalls).toEqual([4]);
  });

  it("scroll 之外的事件（wheel/pointerdown/keydown）不触发广播", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const node = new EventTarget();
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    node.dispatchEvent(new Event("wheel"));
    node.dispatchEvent(new Event("pointerdown"));
    node.dispatchEvent(new Event("keydown"));
    sch.flush();
    expect(b.setVCalls).toEqual([]);
  });

  it("连续 scroll（拖动 / 惯性）每一拍都触发广播", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const node = new EventTarget();
    const a = makeFakeAnchor(1);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    node.dispatchEvent(new Event("scroll")); // 拖到 3
    a.setGetV(3);
    sch.flush();
    node.dispatchEvent(new Event("scroll")); // 拖到 5
    a.setGetV(5);
    sch.flush();
    expect(b.setVCalls).toEqual([3, 5]);
  });

  it("回声抑制：target 因 setV 产生的 scroll 被忽略，不回灌", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const nodeA = new EventTarget();
    const nodeB = new EventTarget();
    const a = makeFakeAnchor(4); // driver
    const b = makeFakeAnchor(1); // target
    co.register(a.anchor, "f1", makeSurface(nodeA));
    co.register(b.anchor, "f1", makeSurface(nodeB));
    // A 滚动 → 广播给 B（B 因本次 setV 产生 scroll）
    nodeA.dispatchEvent(new Event("scroll"));
    sch.flushOne(); // 主帧：B.setV(4) + 置 B.programmatic
    expect(b.setVCalls).toEqual([4]);
    expect(a.setVCalls).toEqual([]);
    // B 的回声 scroll 应被抑制，不再广播给 A
    nodeB.dispatchEvent(new Event("scroll"));
    sch.flush(); // 仅跑安全清位
    expect(a.setVCalls).toEqual([]); // 未回灌
    expect(b.setVCalls).toEqual([4]); // B 自身未被再次写
  });

  it("回声清位后 B 再次真实滚动可正常驱动 A", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const nodeA = new EventTarget();
    const nodeB = new EventTarget();
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(nodeA));
    co.register(b.anchor, "f1", makeSurface(nodeB));
    nodeA.dispatchEvent(new Event("scroll"));
    sch.flushOne();
    nodeB.dispatchEvent(new Event("scroll")); // 被抑制（programmatic 清位）
    sch.flush();
    // 安全清位后，B 再次滚动应重新驱动 A
    nodeB.dispatchEvent(new Event("scroll"));
    b.setGetV(9);
    sch.flush();
    expect(a.setVCalls).toEqual([9]); // B 这次作为 driver 成功广播
  });

  it("unregister 解绑 scroll 监听，之后 scroll 不再广播", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const node = new EventTarget();
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    const h = co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    co.unregister(h);
    node.dispatchEvent(new Event("scroll"));
    sch.flush();
    expect(b.setVCalls).toEqual([]);
  });

  it("B152 关闭时 scroll 也不广播（当前 pane 仍原生滚）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const node = new EventTarget();
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

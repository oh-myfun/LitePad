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

describe("SyncScrollCoordinator 结构性滚动抑制（T7 终版：结构性锁 + 用户手势解锁，无时间窗/无帧计数）", () => {
  function makeSurface(node: EventTarget): CoordinatedSurface {
    return { events: node };
  }

  it("上锁后，结构性突发内的 scroll 被吞没、不广播（标签切换/复制/分屏/拖拽重排）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const node = document.createElement("div");
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    co.suppressStructural("f1"); // 结构性操作前上锁
    node.dispatchEvent(new Event("scroll")); // CM6 setState 归零重排产生的 scroll
    sch.flush();
    expect(b.setVCalls).toEqual([]); // 被吞没，不广播（防自动跳变/调回顶部）
  });

  it("锁只由用户真实手势解除：wheel 之后同 docId 的 scroll 正常广播", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const node = document.createElement("div");
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    co.suppressStructural("f1");
    node.dispatchEvent(new Event("scroll")); // 结构性，吞
    sch.flush();
    expect(b.setVCalls).toEqual([]);
    // 用户开始滚动（滚轮手势）⇒ 锁解除
    node.dispatchEvent(new Event("wheel"));
    node.dispatchEvent(new Event("scroll")); // 真正的用户滚动
    sch.flush();
    expect(b.setVCalls).toEqual([4]); // 解除后正常广播
  });

  it("pointerdown/keydown/touchstart 同样解锁（覆盖各输入源）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const node = document.createElement("div");
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    co.suppressStructural("f1");
    for (const ev of ["pointerdown", "keydown", "touchstart"] as const) {
      node.dispatchEvent(new Event(ev)); // 用户手势 ⇒ 解锁
      node.dispatchEvent(new Event("scroll")); // 用户滚动
      sch.flush();
    }
    expect(b.setVCalls).toEqual([4, 4, 4]); // 每次手势后用户滚动都广播
  });

  it("确定性突发：连续多条 scroll 全部吞没；锁不靠静默帧解除", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const node = document.createElement("div");
    const a = makeFakeAnchor(1);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    co.suppressStructural("f1");
    for (const v of [2, 3, 4]) {
      a.setGetV(v);
      node.dispatchEvent(new Event("scroll"));
      sch.flush();
    }
    expect(b.setVCalls).toEqual([]); // 突发内全部未广播
  });

  it("gap-immune：结构性 scroll 迟到 > 任意静默空隙仍被吞没（旧版时间窗/帧释放会漏，本版不会）", () => {
    const sch = makeScheduler();
    // fallbackFrames 注入为 10：旧模型 releaseFrames=2 会在 2 静默帧后解除并漏出迟到 scroll；
    // 本模型即便 10 帧静默也不解除（除非用户手势），证明不受空隙影响。
    const co = new SyncScrollCoordinator(sch.schedule, { fallbackFrames: 10 });
    const node = document.createElement("div");
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    co.suppressStructural("f1");
    node.dispatchEvent(new Event("scroll")); // 结构性 scroll（突发内）
    sch.flush();
    // 静默若干帧（5 帧，< 10 兜底，但远大于旧模型 2 帧）—— 旧模型此时已解除
    for (let i = 0; i < 5; i++) sch.flush();
    // 迟到的结构性 scroll（如 focus / 异步 layout 引发）到了
    node.dispatchEvent(new Event("scroll"));
    sch.flush();
    expect(b.setVCalls).toEqual([]); // 仍被吞没，不漏出广播（gap-immune）
  });

  it("兜底静默 watchdog：fallbackFrames 帧无任何结构性 scroll 后强制解锁", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule, { fallbackFrames: 2 });
    const node = document.createElement("div");
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    co.suppressStructural("f1");
    // 2 帧静默、无结构性 scroll ⇒ watchdog 强制解锁
    sch.flush();
    sch.flush();
    node.dispatchEvent(new Event("scroll")); // 此刻用户滚动（锁已解除）
    sch.flush();
    expect(b.setVCalls).toEqual([4]); // 解锁后正常广播
  });

  it("按 docId 隔离：被锁的 docId 在突发内不广播，其它 docId 照常广播", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
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
    co.suppressStructural("f1"); // 仅锁 f1
    nodeF1.dispatchEvent(new Event("scroll")); // f1 结构性（突发内）
    nodeF2.dispatchEvent(new Event("scroll")); // f2 用户滚动（无锁）
    sch.flush();
    expect(b.setVCalls).toEqual([]); // f1 被吞没
    expect(d.setVCalls).toEqual([9]); // f2 照常广播
  });

  it("syncFromDriver 不经锁（TOC/查找/转到行必须照常同步）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const node = document.createElement("div");
    const a = makeFakeAnchor(8); // 裸 driver
    const b = makeFakeAnchor(1);
    co.register(b.anchor, "f1", makeSurface(node));
    co.suppressStructural("f1"); // 即便上锁，程序化跳转仍广播
    co.syncFromDriver("f1", a.anchor);
    sch.flush();
    expect(b.setVCalls).toEqual([8]); // 绕过锁
  });

  it("用户手势解锁只解该 docId：另一 docId 仍锁住", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const nodeF1 = document.createElement("div");
    const nodeF2 = document.createElement("div");
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    const c = makeFakeAnchor(9);
    const d = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(nodeF1));
    co.register(b.anchor, "f1");
    co.register(c.anchor, "f2", makeSurface(nodeF2));
    co.register(d.anchor, "f2");
    co.suppressStructural("f1");
    co.suppressStructural("f2");
    nodeF1.dispatchEvent(new Event("wheel")); // 仅 f1 面板收到用户手势
    nodeF1.dispatchEvent(new Event("scroll"));
    nodeF2.dispatchEvent(new Event("scroll")); // f2 仍锁
    sch.flush();
    expect(b.setVCalls).toEqual([4]); // f1 解锁后广播
    expect(d.setVCalls).toEqual([]); // f2 仍被吞没
  });
});

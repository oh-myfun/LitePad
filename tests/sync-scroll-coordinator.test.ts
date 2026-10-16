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
  return { schedule, flush, pending: () => q.length };
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

describe("SyncScrollCoordinator B152 关闭不广播", () => {
  it("setEnabled(false) 后 syncFrom 不写任何同 docId 锚点", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makeFakeAnchor(3.5);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1");
    co.register(b.anchor, "f1");
    co.setEnabled(false);
    co.syncFrom(a.anchor);
    sch.flush();
    expect(b.setVCalls).toEqual([]);
    expect(co.isEnabled()).toBe(false);
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

describe("SyncScrollCoordinator 输入监听挂载", () => {
  function makeSurface(node: EventTarget): CoordinatedSurface {
    return {
      events: node,
      rect: () =>
        ({
          left: 0,
          top: 0,
          right: 100,
          bottom: 200,
          width: 100,
          height: 200,
          x: 0,
          y: 0,
        }) as DOMRect,
      scrollbarWidth: () => 15, // 槽在 clientX > 85 区域
    };
  }

  it("wheel 触发广播（flush 后目标收到）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const node = new EventTarget();
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    node.dispatchEvent(new Event("wheel"));
    sch.flush();
    expect(b.setVCalls).toEqual([4]);
  });

  /** 本环境的 jsdom 未暴露 KeyboardEvent，用裸 Event 挂 key 属性构造。 */
  function keyEvent(key: string): Event {
    const e = new Event("keydown");
    Object.defineProperty(e, "key", { value: key });
    return e;
  }

  it("键盘滚动键触发广播；非滚动键不触发", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const node = new EventTarget();
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    node.dispatchEvent(keyEvent("ArrowDown"));
    sch.flush();
    expect(b.setVCalls).toEqual([4]);

    const b2calls = b.setVCalls.length;
    node.dispatchEvent(keyEvent("a"));
    sch.flush();
    expect(b.setVCalls.length).toBe(b2calls); // 非滚动键不广播
  });

  it("滚动条拖动（pointerdown 命中右侧槽）触发；命中内容区不触发", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const node = new EventTarget();
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");

    const onGutter = new Event("pointerdown") as Event & { clientX: number };
    onGutter.clientX = 95; // > 85 → 槽
    node.dispatchEvent(onGutter);
    sch.flush();
    expect(b.setVCalls).toEqual([4]);

    const b2calls = b.setVCalls.length;
    const inContent = new Event("pointerdown") as Event & { clientX: number };
    inContent.clientX = 50; // 内容区
    node.dispatchEvent(inContent);
    sch.flush();
    expect(b.setVCalls.length).toBe(b2calls); // 内容区点击不广播
  });

  it("unregister 解绑监听，之后 wheel 不再广播", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const node = new EventTarget();
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    const h = co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    co.unregister(h);
    node.dispatchEvent(new Event("wheel"));
    sch.flush();
    expect(b.setVCalls).toEqual([]);
  });

  it("B152 关闭时输入事件也不广播（当前 pane 仍原生滚）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const node = new EventTarget();
    const a = makeFakeAnchor(4);
    const b = makeFakeAnchor(1);
    co.register(a.anchor, "f1", makeSurface(node));
    co.register(b.anchor, "f1");
    co.setEnabled(false);
    node.dispatchEvent(new Event("wheel"));
    sch.flush();
    expect(b.setVCalls).toEqual([]);
  });
});

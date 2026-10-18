// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { type ScrollAnchor } from "../src/sync-scroll/anchor";
import { type CoordinatedSurface, SyncScrollCoordinator } from "../src/sync-scroll/coordinator";

/**
 * 可控调度：把 rAF 回调排队，手动 flush。
 *
 * ⚠️ 本套用例**不需要**推进时间或帧数：账本的判定全是「事件到来时查表比较」。
 * 谁要是往协调器里塞回时间窗 / 帧计数 / 静默判定，这些用例就会变得需要 mock 时钟——
 * 那就是走回 T7 的老路（五版抑制机制全部栽在「猜什么时候算突发结束」上）。
 */
function makeScheduler() {
  const q: Array<() => void> = [];
  let id = 0;
  const schedule = (fn: () => void) => {
    q.push(fn);
    return ++id; // 返回非零 id，使协调器的合帧守卫生效
  };
  const flush = () => {
    const c = q.splice(0, q.length);
    for (const f of c) f();
  };
  return { schedule, flush, pending: () => q.length };
}

/**
 * 一个带真实 DOM 滚动面的假 pane。
 *
 * 两种「写下去没到」的形态要分开，它们的修法完全不同：
 *  - `clampTo`：浏览器按**当时的** scrollHeight 把写入裁住，且 `setV` 诚实回报裁剪后的落点。
 *    协调器按回报值认账 ⇒ 不补写、也不广播（没有东西需要补）。
 *  - `lagTo`：写入被接受了，但读回的落点还停在旧值（内容刚重建、布局没定局）。
 *    这才是需要「补写兑现」的那一种 —— 也是 `switchTab` 位置恢复登记**意图值**而非读回值的原因。
 */
function makePane(initialV = 1, opts: { clampTo?: number; lagTo?: number } = {}) {
  const el = document.createElement("div");
  let v = initialV;
  let lag = opts.lagTo;
  const setVCalls: number[] = [];
  // 假面必须**连像素一起动**：协调器按像素认自己的回声（真机 02:42 那一族），一个只改 v
  // 不碰 `scrollTop` 的假面是不诚实的 —— 它会把「用户滚了一格」也演成「像素没动」⇒
  // 判成我们的回声 ⇒ 该广播的不广播，而那几条契约的绿/红就都说不清是谁的错了。
  const put = (val: number) => {
    v = val;
    el.scrollTop = Math.round(val * 10); // 10px 一行，只是换算比例
  };
  put(initialV);
  const anchor: ScrollAnchor = {
    getV: () => v,
    setV: (x: number) => {
      setVCalls.push(x);
      if (lag !== undefined) {
        // 布局没定局：像素写进去了，但按当时的高度图读回来还是老位置
        el.scrollTop = Math.round(x * 10);
        return v;
      }
      put(opts.clampTo !== undefined ? opts.clampTo : x);
      return v;
    },
  };
  const surface: CoordinatedSurface = { events: el };
  return {
    el,
    anchor,
    surface,
    setVCalls,
    /** 改当前落点，模拟「浏览器给出的位置」。 */
    at(val: number) {
      put(val);
    },
    /** 布局定局：解除滞后，此后 setV 真的落到请求值。 */
    release() {
      lag = undefined;
    },
    /** jsdom 不会因为写 scrollTop 而派发 scroll，必须手动派发。 */
    scroll() {
      el.dispatchEvent(new Event("scroll"));
    },
  };
}

describe("SyncScrollCoordinator · 广播", () => {
  it("syncFrom(driver)：同 docId 其余 anchor 写到 driver 的 v，driver 不回写", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(3.5);
    const b = makePane(1);
    co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f1", b.surface);
    co.syncFrom(a.anchor);
    sch.flush();
    expect(b.setVCalls).toEqual([3.5]);
    expect(a.setVCalls).toEqual([]);
  });

  it("同 docId 三个锚点：driver 之外两个都收到", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(2);
    const b = makePane(1);
    const c = makePane(1);
    co.register(a.anchor, "same", a.surface);
    co.register(b.anchor, "same", b.surface);
    co.register(c.anchor, "same", c.surface);
    co.syncFrom(a.anchor);
    sch.flush();
    expect(b.setVCalls).toEqual([2]);
    expect(c.setVCalls).toEqual([2]);
    expect(a.setVCalls).toEqual([]);
  });

  it("已经在同一位置的 anchor 不被写入（不产生无谓的 scroll 与承诺）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(8);
    const b = makePane(8);
    co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f1", b.surface);
    co.syncFrom(a.anchor);
    sch.flush();
    expect(b.setVCalls).toEqual([]);
  });

  it("不同 docId 之间互不广播", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(4);
    const b = makePane(1);
    co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f2", b.surface);
    co.syncFrom(a.anchor);
    sch.flush();
    expect(b.setVCalls).toEqual([]);
  });

  it("B152 关掉：不广播；其它文档默认开", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(3.5);
    const b = makePane(1);
    co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f1", b.surface);
    co.setEnabled("f1", false);
    co.syncFrom(a.anchor);
    sch.flush();
    expect(b.setVCalls).toEqual([]);
    expect(co.isOn("f1")).toBe(false);
    expect(co.isOn("f2")).toBe(true);
  });

  it("帧内多次触发只广播一次，取帧末的 getV（last-writer-wins）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(1);
    const b = makePane(1);
    co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f1", b.surface);
    co.syncFrom(a.anchor);
    a.at(5);
    co.syncFrom(a.anchor); // 合帧守卫命中，不再排第二帧
    sch.flush();
    expect(b.setVCalls).toEqual([5]);
  });

  it("syncFromDriver 接受未在册的裸锚点（TOC / 转到行的调用形态）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const driver = makePane(6.25);
    const target = makePane(1);
    co.register(target.anchor, "f1", target.surface);
    co.syncFromDriver("f1", driver.anchor);
    sch.flush();
    expect(target.setVCalls).toEqual([6.25]);
  });

  it("已注销句柄调用 syncFrom 静默忽略", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(7);
    const b = makePane(1);
    const h = co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f1", b.surface);
    co.unregister(h);
    co.syncFrom(h);
    sch.flush();
    expect(b.setVCalls).toEqual([]);
  });

  it("unregister 解绑监听：注销后该面的 scroll 不再驱动广播", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(4);
    const b = makePane(1);
    const ha = co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f1", b.surface);
    co.unregister(ha);
    a.scroll();
    sch.flush();
    expect(b.setVCalls).toEqual([]);
  });

  it("只有 scroll 驱动广播；wheel / pointerdown / keydown 本身不驱动", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(4);
    const b = makePane(1);
    co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f1", b.surface);
    a.el.dispatchEvent(new Event("wheel"));
    a.el.dispatchEvent(new Event("pointerdown"));
    a.el.dispatchEvent(new Event("keydown"));
    sch.flush();
    expect(b.setVCalls).toEqual([]);
  });

  it("没有滚动面的锚点不被 scroll 驱动，只能经 syncFrom 显式驱动", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const bare = makePane(4);
    const target = makePane(1);
    co.register(bare.anchor, "f1");
    co.register(target.anchor, "f1", target.surface);
    bare.el.dispatchEvent(new Event("scroll"));
    sch.flush();
    expect(target.setVCalls).toEqual([]);
    co.syncFrom(bare.anchor);
    sch.flush();
    expect(target.setVCalls).toEqual([4]);
  });

  it("连续 scroll（拖动 / 惯性 / 滚轮）每一拍都广播", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(1);
    const b = makePane(1);
    co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f1", b.surface);
    a.at(3);
    a.scroll();
    sch.flush();
    a.at(5);
    a.scroll();
    sch.flush();
    expect(b.setVCalls).toEqual([3, 5]);
  });
});

describe("SyncScrollCoordinator · 账本吞没回声", () => {
  it("无承诺在途时，scroll 判为用户滚动并广播", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(1);
    const b = makePane(1);
    co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f1", b.surface);
    a.at(7);
    a.scroll();
    sch.flush();
    expect(b.setVCalls).toEqual([7]);
  });

  it("广播写入后目标报回承诺的 v ⇒ 吞掉，不回灌 driver", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(1);
    const b = makePane(1);
    co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f1", b.surface);
    a.at(7);
    a.scroll();
    sch.flush();
    b.at(7);
    b.scroll();
    sch.flush();
    expect(a.setVCalls).toEqual([]);
  });

  it("一写多滚：同一笔承诺连派三发全部吞掉（旧的 1-shot 标志第二发就漏）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(1);
    const b = makePane(1);
    co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f1", b.surface);
    a.at(7);
    a.scroll();
    sch.flush();
    b.at(7);
    b.scroll();
    b.scroll();
    b.scroll();
    sch.flush();
    expect(a.setVCalls).toEqual([]);
    expect(b.setVCalls).toEqual([7]); // 只有协调器那一次写入
  });

  it("承诺与事件之间隔任意多轮也不漏（没有任何时间窗 / 帧计数会过期）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(1);
    const b = makePane(1);
    co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f1", b.surface);
    a.at(7);
    a.scroll();
    sch.flush();
    for (let i = 0; i < 8; i++) sch.flush(); // 中间空转若干帧
    b.at(7);
    b.scroll();
    sch.flush();
    expect(a.setVCalls).toEqual([]);
  });

  it("承诺兑现一次后即销账：紧随其后的真实用户滚动照常广播", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(1);
    const b = makePane(1);
    co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f1", b.surface);
    a.at(7);
    a.scroll();
    sch.flush();
    b.at(7);
    b.scroll();
    sch.flush();
    b.at(12); // 用户真的动了 b
    b.scroll();
    sch.flush();
    expect(a.setVCalls).toEqual([12]);
  });
});

describe("SyncScrollCoordinator · 承诺没兑现（补写兑现）", () => {
  it("外部登记的意图没落到 ⇒ 补写兑现，且这一发绝不广播（不弹回顶部）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(1);
    // 内容刚重建、布局没定局：写进去了但读回来还停在 1
    const b = makePane(1, { lagTo: 1 });
    co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f1", b.surface);
    // 这就是 switchTab 的形状：同栈写 scrollTop 扶回位置，然后把「意图 + 真实落点」一起登记
    const landed = b.anchor.setV(20);
    co.expectSurfaceV(b.el, 20, landed);
    b.scroll(); // 布局没定局 ⇒ 读回来还是 1
    sch.flush();
    expect(b.setVCalls).toEqual([20, 20]); // 补写一次去兑现承诺
    expect(a.setVCalls).toEqual([]); // 没有把「1」广播出去 ⇒ 对栏不弹回顶部
  });

  it("补写追上后按承诺认账销账；之后的真实用户滚动照常广播", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(1);
    const b = makePane(1, { lagTo: 1 });
    co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f1", b.surface);
    const landed = b.anchor.setV(20);
    co.expectSurfaceV(b.el, 20, landed);
    b.scroll();
    sch.flush();
    b.release(); // 布局定局
    b.at(20);
    b.scroll(); // 这一发读到了承诺 ⇒ 兑现，销账
    sch.flush();
    expect(a.setVCalls).toEqual([]);
    b.at(27); // 用户真的动了
    b.scroll();
    sch.flush();
    expect(a.setVCalls).toEqual([27]); // 账本没把用户也吃掉
  });

  it("补写到上限就认账，但依然不广播；之后的真实用户滚动恢复正常广播", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(1);
    const b = makePane(1, { lagTo: 1 }); // 永远追不上
    co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f1", b.surface);
    const landed = b.anchor.setV(20);
    co.expectSurfaceV(b.el, 20, landed);
    for (let i = 0; i < 6; i++) {
      b.scroll();
      sch.flush();
    }
    // 首次外部写入 1 次 + MAX_REASSERT(3) 次补写
    expect(b.setVCalls.length).toBe(4);
    expect(a.setVCalls).toEqual([]);
    b.at(31); // 用户真的滚了
    b.scroll();
    sch.flush();
    expect(a.setVCalls).toEqual([31]); // 认账之后账本没把用户也吃掉
  });

  it("这一格真的到不了（到底裁住）⇒ 补到上界就认账，不把对栏一起拽下去", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(1);
    const b = makePane(1, { clampTo: 40 }); // 自己的可滚上限就在 40
    co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f1", b.surface);
    a.at(99);
    a.scroll(); // 广播 99 给 b
    sch.flush();
    for (let i = 0; i < 5; i++) {
      b.scroll();
      sch.flush();
    }
    // 登记的是意图 99 ⇒ 补写有上界（首次 + MAX_REASSERT 3 次），不会形成补写风暴
    expect(b.setVCalls).toEqual([99, 99, 99, 99]);
    expect(a.setVCalls).toEqual([]); // b 到不了 99 也不反把 a 拽走
  });

  it("到底裁住后用户向上滚一格 ⇒ 那一发是用户滚动，必须广播（不能把联动锁死在底部）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(1);
    const b = makePane(1, { clampTo: 40 });
    co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f1", b.surface);
    a.at(99);
    a.scroll(); // 广播 99 ⇒ b 被写到自己的上限 40
    sch.flush();
    // ⚠️ 真实浏览器里补写落回同一个 scrollTop ⇒ 不会再派事件。所以「补写风暴」不会
    // 自己把预算烧完：下一发事件只可能来自**别人**动了这一格。上一版在这里把承诺
    // 悬在 99 上，于是用户每一格向上滚都被判成「没兑现」而被 `setV(99)` 拽回底部 ——
    // 表现就是「到底以后两侧都不再跟手」。
    b.scroll(); // 我们那一发的回声（还在 40）⇒ 认领，不广播
    sch.flush();
    expect(a.setVCalls).toEqual([]);
    b.at(38); // 用户真的向上滚了一格
    b.scroll();
    sch.flush();
    expect(a.setVCalls).toEqual([38]);
    expect(b.anchor.getV()).toBe(38); // 没被补写拽回底部
  });
});

describe("SyncScrollCoordinator · 单一写入方纪律", () => {
  it("外部结构性写入登记过 ⇒ 该发被认领，不广播", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(1);
    const b = makePane(1);
    co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f1", b.surface);
    b.at(15.3); // 模拟 PreviewPane.setBlocks 自己写 scrollTop
    co.expectSurfaceV(b.el, 15.3, b.anchor.getV()); // 「停在这儿也是我写的」⇒ 意图与落点同值
    b.scroll();
    sch.flush();
    expect(a.setVCalls).toEqual([]);
  });

  it("反向契约：没登记的写入会被当作用户滚动广播出去（真机 S7 的病根）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(15.1);
    const b = makePane(15.3);
    co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f1", b.surface);
    b.at(1); // replaceChildren 把预览弹回顶部，却忘了登记
    b.scroll();
    sch.flush();
    expect(a.setVCalls).toEqual([1]); // ⇒ 编辑器被拽回顶部
  });

  it("重载 / 整态重建的「就地认领」形态：按写入后的读回值登记即可（不假设落到哪）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(1);
    const b = makePane(1);
    co.register(a.anchor, "f1", a.surface);
    co.register(b.anchor, "f1", b.surface);
    b.at(2.5); // setState 归零重排之后落在哪就是哪
    const here = b.anchor.getV();
    co.expectSurfaceV(b.el, here, here);
    b.scroll();
    sch.flush();
    expect(a.setVCalls).toEqual([]);
  });

  it("账本按滚动面记账：重注册（新建锚点对象）不洗掉在途承诺", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makePane(1);
    const b = makePane(1);
    co.register(a.anchor, "f1", a.surface);
    const h1 = co.register(b.anchor, "f1", b.surface);
    a.at(7);
    a.scroll();
    sch.flush(); // 广播给 b ⇒ 登记承诺
    // reconcileSyncRegistrations 的形状：注销旧句柄，用**新的锚点对象**重注册同一个 DOM 面
    const fresh = makePane(7);
    co.unregister(h1);
    co.register(fresh.anchor, "f1", b.surface); // 同一个 el、新的锚点对象
    b.scroll();
    sch.flush();
    expect(a.setVCalls).toEqual([]); // 承诺还在这个面上 ⇒ 照样被认下来
  });

  it("账本按滚动面隔离：f1 面上的承诺不吃 f2 的滚动", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const f1 = makePane(1);
    const f2 = makePane(1);
    const other = makePane(1);
    co.register(f1.anchor, "f1", f1.surface);
    co.register(f2.anchor, "f2", f2.surface);
    co.register(other.anchor, "f2", other.surface);
    co.expectSurfaceV(f1.el, 42, 42);
    f2.at(3);
    f2.scroll();
    sch.flush();
    expect(other.setVCalls).toEqual([3]); // f2 的滚动没被 f1 的承诺吃掉
  });

  it("syncFromDriver 绕过账本判定（TOC / 查找 / 转到行必须照常同步）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const target = makePane(1);
    const driver = makePane(8);
    co.register(target.anchor, "f1", target.surface);
    co.expectSurfaceV(target.el, 1, 1); // 有一笔「它该停在 1」的在途承诺
    co.syncFromDriver("f1", driver.anchor);
    sch.flush();
    expect(target.setVCalls).toEqual([8]); // 显式跳转仍然生效
  });
});

/**
 * 真机 2026-10-18 02:42 那一族（B290）：**回声的身份是像素，不是 v**。
 *
 * 真机日志给的形状（`P1:editor`，切标签的位置恢复）：
 *   登记[P1:editor] 意图=20.25 落点=14.74      ← 写那一刻被没定局的布局裁住（702px）
 *   scroll[P1:editor] obs=20.13 意图=20.25 落点=14.74
 *     →判=被人挪走→用户滚动·广播              ← 假广播，把对栏拽走
 * CM6 虚拟化下 `setState` 之后高度图只覆盖到视口附近，`scrollTop` 被当时的 scrollHeight
 * 裁住；随后高度图细化，**同一个 702px 被重新解释成另一个行号**。像素一动没动，v 却换了
 * 读数 ⇒ 只按 v 比对，就把我们自己的回声判成「别人挪走了」。
 * 代价是双份的：① 对栏被一发假广播拽走（用户看到的「跳变」）；② 漂移后的读数被当成
 * 「这份标签自己的位置」存进记忆 ⇒ 每切一次掉 0.03~0.2 行（23.32→23.10→23.03→23.01）。
 */
function makeLayoutLagPane(co: SyncScrollCoordinator) {
  const LINE_UNSETTLED = 47.6; // 高度图没细化时的估算行高（真机 702px ≈ 14.74 行）
  const LINE_SETTLED = 32; // 细化后的真实行高：同一像素被读成更大的行号
  const MEASURED_UNSETTLED = 15; // 那一刻高度图只量到这么多行 ⇒ scrollHeight 短
  const el = document.createElement("div");
  el.scrollTop = 0;
  let linePx = LINE_UNSETTLED;
  let measured = MEASURED_UNSETTLED;
  const setVCalls: number[] = [];
  const maxPx = () => (measured - 1) * linePx;
  const vAt = (px: number) => 1 + px / linePx;
  const pxAt = (v: number) => (v - 1) * linePx;
  const anchor: ScrollAnchor = {
    getV: () => vAt(el.scrollTop),
    setV: (v: number) => {
      setVCalls.push(v);
      el.scrollTop = Math.min(pxAt(v), maxPx()); // 浏览器按**当时的**高度裁住
      return vAt(el.scrollTop);
    },
  };
  return {
    el,
    anchor,
    surface: { events: el } as CoordinatedSurface,
    setVCalls,
    px: () => el.scrollTop,
    v: () => vAt(el.scrollTop),
    /** 高度图细化：行高变了，但 `scrollTop` 一个像素都没动。 */
    settle: () => {
      linePx = LINE_SETTLED;
      measured = 60;
    },
    scroll: () => el.dispatchEvent(new Event("scroll")),
    /** 真机 `landVisibleSideAtV` 的形状：写完立刻同栈登记（意图 + 那一写的真实落点）。 */
    landAt: (v: number) => {
      const landed = anchor.setV(v);
      co.expectSurfaceV(el, v, landed);
    },
    /** 用户真的滚了一格：像素必须跟着变（否则这条测试自己就是假的）。 */
    userScrollTo: (v: number) => {
      el.scrollTop = pxAt(v);
    },
  };
}

describe("SyncScrollCoordinator · 回声按像素认（真机 02:42 那一族）", () => {
  it("同一像素在高度图细化后被读成另一个 v ⇒ 仍是我们自己那一发：补写兑现，绝不广播", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const ed = makeLayoutLagPane(co);
    const pv = makePane(1);
    co.register(ed.anchor, "doc", ed.surface);
    co.register(pv.anchor, "doc", pv.surface);

    ed.landAt(20.25);
    const clampedPx = ed.px();
    expect(ed.v()).toBeLessThan(19.25); // 写那一刻根本没到（被没定局的布局裁住）

    ed.settle();
    expect(ed.px()).toBe(clampedPx); // 像素一动没动
    expect(Math.abs(ed.v() - 20.25)).toBeGreaterThan(0.05); // 但 v 换了读数

    ed.scroll();
    sch.flush();

    expect(pv.setVCalls).toEqual([]); // 判成自己的回声 ⇒ 不许把对栏拽走
    expect(ed.setVCalls).toEqual([20.25, 20.25]); // 补写兑现：又朝意图写了一次
    expect(Math.abs(ed.v() - 20.25)).toBeLessThanOrEqual(0.05); // 这次布局已定局 ⇒ 真到了

    // 补写那一发自己的回声：兑现销账，仍然不广播
    ed.scroll();
    sch.flush();
    expect(pv.setVCalls).toEqual([]);

    // 之后用户真的滚了一格（像素变了）⇒ 照常广播，联动没有被认账锁死
    ed.userScrollTo(25);
    ed.scroll();
    sch.flush();
    expect(pv.setVCalls).toEqual([25]);
  });
});

describe("主动跳转的坐标由跳转本身给（B301 · 点大纲有时把位置复位到顶部）", () => {
  // 真机 19:23:27 / 19:23:33 两轮的形状（都是**预览态**标签上点大纲）：
  //   viewport 更新 · handleUpdate 后 tab=4 模式=preview 视图=16
  //   sync [main] 外发 doc=1 v=1.00
  //   sync [main] 帧广播 doc=1 驱动=[?] v=1.00 目标=1
  //   sync [sat-4] 广播写[P0:preview] 目标=1.00 落点=1.00     ← 看得见那一侧被拽上顶
  // `驱动=[?]` 只有两个来源：`toc.ts` 的 onJump 与 `commands.ts` 的转到行 —— 它们都把自己
  // new 出来的**编辑器**锚点交给 `syncFromDriver`。可当这一格处于预览态时编辑器是
  // `display:none`：它的 `scrollTop` 恒 0、`getV()` 只能报 1.00（隐藏侧根本量不出位置，
  // B285/B293 那一条「被藏起来的一侧不注册」说的就是它）。协调器在**下一帧**才读这个锚点，
  // 于是「用户点到哪一行」这个事实被换成「那一侧此刻的兜底读数」，并向所有窗口外发。
  //
  // 跳转的目标行调用方本来就知道（`entry.line` / 输入的行号）⇒ 它应当直接把坐标交出来，
  // 而不是委托某个面去读。
  it("留案：把隐藏侧的锚点交给 syncFromDriver，下一帧广播的就是它那串兜底 1.00", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const preview = makePane(21); // 用户看得见的那一侧，好好停在 21 行
    co.register(preview.anchor, "d1", preview.surface);
    const sent: number[] = [];
    co.setOutbound((_, v) => sent.push(v));
    const hiddenEditor: ScrollAnchor = { getV: () => 1.0, setV: (x) => x };
    co.syncFromDriver("d1", hiddenEditor);
    sch.flush();
    expect(sent).toEqual([1.0]); // 复位值就是这么发出去给别的窗口的
    expect(preview.setVCalls).toEqual([1.0]); // 并且把本窗口看得见那一侧也拽上顶
  });

  it("syncTo(docId, 目标行)：广播的是跳转目标，谁都不去读某一侧", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const preview = makePane(21);
    const editor = makePane(21);
    co.register(preview.anchor, "d2", preview.surface);
    co.register(editor.anchor, "d2", editor.surface);
    const sent: number[] = [];
    co.setOutbound((_, v) => sent.push(v));
    co.syncTo("d2", 30);
    sch.flush();
    expect(sent).toEqual([30]);
    expect(preview.setVCalls).toEqual([30]);
    expect(editor.setVCalls).toEqual([30]);
  });

  it("那份文档的同步关着 ⇒ 跳转不外发、也不动别的面（开关 gate 的是整条联动）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const preview = makePane(21);
    co.register(preview.anchor, "d3", preview.surface);
    const sent: number[] = [];
    co.setOutbound((_, v) => sent.push(v));
    co.setEnabled("d3", false);
    co.syncTo("d3", 30);
    sch.flush();
    expect(sent).toEqual([]);
    expect(preview.setVCalls).toEqual([]);
  });

  it("同一帧里连点两次大纲 ⇒ 只发最后一发（合帧不变，last-writer-wins）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const preview = makePane(21);
    co.register(preview.anchor, "d4", preview.surface);
    const sent: number[] = [];
    co.setOutbound((_, v) => sent.push(v));
    co.syncTo("d4", 30);
    co.syncTo("d4", 40);
    sch.flush();
    expect(sent).toEqual([40]);
    expect(preview.setVCalls).toEqual([40]);
  });
});

/**
 * 会按**视觉行**对齐的假面（B300）。
 *
 * `chars` 是这一格宽度下每个视觉行的行首字符（越窄的行数组越密）。同一份文档在两格里
 * 可以有不同的 `chars` ⇒ 同一个字符落在不同的行序号上 ⇒ 读回的 `v` 也不同。这正是
 * 「只传 v 对不齐」的形状，也是「按 pos 对齐后不许再拿对方的 v 去补写」的原因。
 */
function makeRowPane(rows: { char: number; v: number }[], initialIndex = 0) {
  const el = document.createElement("div");
  const chars = rows.map((r) => r.char);
  let idx = initialIndex;
  const setVCalls: number[] = [];
  const setVAtCalls: number[] = [];
  const anchor: ScrollAnchor = {
    getV: () => rows[idx].v,
    setV: (v: number) => {
      setVCalls.push(v);
      for (let i = rows.length - 1; i >= 0; i--)
        if (rows[i].v <= v) {
          idx = i;
          break;
        }
      el.scrollTop = idx * 20;
      return rows[idx].v;
    },
    topPos: () => chars[idx],
    setVAt: (pos: number) => {
      setVAtCalls.push(pos);
      for (let i = rows.length - 1; i >= 0; i--)
        if (chars[i] <= pos) {
          idx = i;
          break;
        }
      el.scrollTop = idx * 20;
      return rows[idx].v;
    },
  };
  return {
    el,
    anchor,
    surface: { events: el } as CoordinatedSurface,
    setVCalls,
    setVAtCalls,
    at: () => idx,
    v: () => rows[idx].v,
    scroll: () => el.dispatchEvent(new Event("scroll")),
  };
}

describe("帧广播把视觉行位置一起带走（B300 · 逐行对齐）", () => {
  // 宽格：每视觉行 40 字，v 是 1 + 行内比例；窄格：每视觉行 30 字 ⇒ **同一个字符在两格里
  // 算出的 v 本来就不相等**。这就是只传 v 对不齐、以及按字符对齐后必须就地认领的原因。
  const WIDE = [
    { char: 0, v: 1.0 },
    { char: 40, v: 1.25 },
    { char: 80, v: 1.5 },
    { char: 120, v: 1.75 },
  ];
  const NARROW = [
    { char: 0, v: 1.0 },
    { char: 30, v: 1.3 },
    { char: 60, v: 1.6 },
    { char: 90, v: 1.9 },
    { char: 120, v: 2.2 },
  ];

  it("驱动面的 topPos 与 v 一起外发；同文档的行能力面按 pos 对齐，不再用 setV", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const wide = makeRowPane(WIDE, 1);
    const narrow = makeRowPane(NARROW, 0);
    co.register(wide.anchor, "r1", wide.surface);
    co.register(narrow.anchor, "r1", narrow.surface);
    const sent: Array<[string, number, number | null]> = [];
    co.setOutbound((d, v, at) => sent.push([d, v, at ?? null]));
    wide.scroll();
    sch.flush();
    expect(sent).toEqual([["r1", 1.25, 40]]); // v 与 pos 都带
    expect(narrow.setVAtCalls).toEqual([40]); // 按字符对齐
    expect(narrow.setVCalls).toEqual([]); // 而不是按对方的 v
    expect(narrow.at()).toBe(1); // 30..60 那一行
    expect(wide.setVCalls).toEqual([]); // driver 自己不回写
  });

  it("两格宽度不同 ⇒ 对齐同一字符后各自的 v 不等：回声必须被认成自己的，不许补写", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const wide = makeRowPane(WIDE, 1);
    const narrow = makeRowPane(NARROW, 0);
    co.register(wide.anchor, "r2", wide.surface);
    co.register(narrow.anchor, "r2", narrow.surface);
    let out = 0;
    co.setOutbound(() => {
      out += 1;
    });
    wide.scroll();
    sch.flush();
    expect(wide.v()).toBe(1.25);
    expect(narrow.v()).toBe(1.3); // 同一字符，两格算出的 v 不同
    narrow.scroll(); // 那一发的回声（像素确实动过）
    sch.flush();
    // 意图被记成自己的读回值 ⇒ 这一发判成「兑现·吞掉」：不补写、也不再外发。
    // 记成对方的 1.25 就会被判成「没兑现」而把它拽回去，逐行对齐自己把自己拆掉。
    expect(narrow.setVAtCalls).toEqual([40]);
    expect(narrow.setVCalls).toEqual([]);
    expect(out).toBe(1);
  });

  it("已经停在该字符那一行的面 ⇒ 一个字节都不写（echo 保护）", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const a = makeRowPane(WIDE, 1);
    const b = makeRowPane(WIDE, 1); // 同宽度、同一行
    co.register(a.anchor, "r3", a.surface);
    co.register(b.anchor, "r3", b.surface);
    a.scroll();
    sch.flush();
    expect(b.setVAtCalls).toEqual([]);
    expect(b.setVCalls).toEqual([]);
  });

  it("对面只有 v、没有 pos（老版本 / 预览面）⇒ 照旧按 v 写", () => {
    const sch = makeScheduler();
    const co = new SyncScrollCoordinator(sch.schedule);
    const driver = makeRowPane(WIDE, 1);
    const pv = makePane(1); // 只会 setV 的预览面
    co.register(driver.anchor, "r4", driver.surface);
    co.register(pv.anchor, "r4", pv.surface);
    driver.scroll();
    sch.flush();
    expect(pv.setVCalls).toEqual([1.25]);
  });
});

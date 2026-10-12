// @vitest-environment jsdom
// B272：预览底部留白的 **ResizeObserver 自反馈环** 回归。
//
// 真机症状：打开预览 / 滚动之后，每帧一条
//   `ResizeObserver loop completed with undelivered notifications`
// 被 `index.html` 的全局 error 监听逐条渲染进 `#boot-error-overlay` ⇒ 顶部红条堆满屏
// （用户报「软件启动报错」；日志 `%APPDATA%\LitePad\logs\litepad.log` 02:07:42 起连续数十条）。
//
// 成环机制（结构性）：留白写进 `.md-preview` 的 `padding-bottom`，而 `px` 又是拿
// `clientHeight`（padding-box，**含这一份留白**）去算的 —— 容器高度由内容撑开时，
// 「我们写的这一笔」反过来改了「被观察量」⇒ 下一帧算出另一个 px ⇒ 再写……
// 再叠上「滚动条出/没 ⇒ 折行 ⇒ 末块高 ±1」就成了每帧都变的稳定环。
//
// 本用例用**可手动触发的 ResizeObserver 替身** + 「padding 计入 clientHeight」的自反馈模型
// 把它搬进 jsdom（真机的环在这里就是「每次 fire 都写一个新值、永不收敛」）。
// 三条修复纪律：①RO 回调跨帧写（当帧不动样式）；②连续变化熔断；③≤1px 抖动当没变。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PreviewPane } from "../src/markdown/preview";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
}));

const BLOCK = 42;
/** 容器「内容」基准高（不含留白）—— 自反馈模型里 clientHeight = 它 + 留白。 */
let baseH = 100;

/** 可手动触发的 ResizeObserver 替身（jsdom 没有 RO，真机行为靠它建模）。 */
class RoStub {
  static instances: RoStub[] = [];
  constructor(public cb: () => void) {
    RoStub.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  fire(): void {
    this.cb();
  }
}

// 连接感知的 rect：块挂载后才量得出高度（B267 那条纪律）
const RECTS = () => {
  const proto = window.Element.prototype as unknown as { getBoundingClientRect: () => DOMRect };
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    const el = this as HTMLElement;
    if (el.classList.contains("md-block")) {
      const connected = el.isConnected;
      const idx = Math.max(0, Array.prototype.indexOf.call(el.parentElement?.children ?? [], el));
      const top = connected ? idx * BLOCK : 0;
      const height = connected ? BLOCK : 0;
      return {
        top,
        left: 0,
        right: 600,
        bottom: top + height,
        width: 600,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as unknown as DOMRect;
    }
    return {
      top: 0,
      left: 0,
      right: 600,
      bottom: 0,
      width: 600,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as unknown as DOMRect;
  };
};

function sampleBlocks(): { lineStart: number; lineEnd: number; html: string }[] {
  return [
    { lineStart: 1, lineEnd: 1, html: "<h1>标题一</h1>" },
    { lineStart: 2, lineEnd: 2, html: "<h1>标题二</h1>" },
    { lineStart: 3, lineEnd: 5, html: "<p>段落第一行<br>第二行<br>第三行</p>" },
  ];
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function bleedOf(pv: PreviewPane): number {
  return Number.parseFloat(pv.root.style.getPropertyValue("--md-bleed-bottom")) || 0;
}

/** 建一个「容器高度随留白变化」的预览格（= 真机成环的那一格）。 */
function makePane(): PreviewPane {
  const pv = new PreviewPane();
  document.body.appendChild(pv.root);
  Object.defineProperty(pv.root, "clientHeight", {
    configurable: true,
    get: () => baseH + Math.max(0, bleedOf(pv)), // ⚠️ 留白计入「被观察量」⇒ 自反馈
  });
  pv.setBlocks(sampleBlocks());
  return pv;
}

describe("B272 预览底部留白：ResizeObserver 自反馈必须收敛", () => {
  beforeEach(() => {
    baseH = 100;
    RoStub.instances = [];
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = RoStub;
    RECTS();
  });

  it("① RO 回调**当帧不写样式**（跨帧重算，避免同帧连续通知 ⇒ RO loop）", async () => {
    const pv = makePane();
    const ro = RoStub.instances[0];
    expect(ro, "前提：PreviewPane 挂上了 ResizeObserver").toBeTruthy();
    const before = bleedOf(pv);
    expect(before, "前提：setBlocks 已经量出首值").toBeGreaterThan(0);
    ro.fire();
    // 回调刚跑完、rAF 还没到 ⇒ 值必须纹丝不动（同帧写样式正是 RO loop 错误的成因）
    expect(bleedOf(pv), "RO 回调当帧一个字节都不许写").toBe(before);
    await wait(40);
    // 跨帧后才允许重算（这一发写了 ≠ 环，下一条例证它会收敛）
    expect(bleedOf(pv), "跨帧后允许重算一次").toBeGreaterThan(0);
  });

  it("② 连打 20 轮 RO 通知：留白必须收敛（熔断），不再每帧写", async () => {
    const pv = makePane();
    const ro = RoStub.instances[0];
    const series: number[] = [];
    for (let i = 0; i < 20; i++) {
      ro.fire();
      await wait(20);
      series.push(bleedOf(pv));
    }
    // 旧实现：每一轮都算出一个新值 ⇒ 20 轮 20 个值、一路暴涨（真机每帧一条 RO loop）。
    // 修后：连续变化 3 次即熔断 ⇒ 从第 4 轮起值恒定。
    const tail = series.slice(3);
    const settled = tail.every((v) => v === tail[0]);
    expect(settled, `第 4 轮起必须恒定（实测序列 = ${series.join(",")}）`).toBe(true);
  });

  it("③ 真变化仍然生效：内容重排后留白跟上新高度（熔断不是永久停摆）", async () => {
    const pv = makePane();
    const ro = RoStub.instances[0];
    // 先打满熔断
    for (let i = 0; i < 8; i++) {
      ro.fire();
      await wait(20);
    }
    const frozen = bleedOf(pv);
    // 容器真变了（窗口缩放 / 分屏拖条）+ 内容重排 ⇒ setBlocks 重置熔断计数
    baseH = 260;
    pv.setBlocks(sampleBlocks());
    const after = bleedOf(pv);
    expect(after, "真变化时留白必须跟上（熔断不许永久停摆）").not.toBe(frozen);
    // 自反馈模型：clientHeight = baseH + 当前留白 ⇒ 新的留白 = (260 + frozen) − 末行高。
    // 本单修复：留白按末行粒度，末块跨 3 行 ⇒ 末行高 = 末块高 ÷ 3 = 42/3 = 14。
    expect(
      Math.abs(after - (baseH + frozen - BLOCK / 3)),
      "新的留白 = 新的容器高 − 末行高",
    ).toBeLessThanOrEqual(1);
  });
});

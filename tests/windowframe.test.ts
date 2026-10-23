// @vitest-environment jsdom
// B353 · 应用内浮层窗框（设置窗口的壳）。
//
// 用户口径：「设置页面也参考 vscode 做成带标题栏可拖拽和可调整大小的设置窗口」。
// 我的裁定（代价写在报告里）：做**应用内浮层窗口**，不开第二个 Tauri 窗口 ——
// 设置页每一项都是往当前文档写 CSS 变量（`appearance.ts`），换真窗口就要给每一项补一条
// 跨窗广播；换来的是「不能拖出主窗口、不进 Alt-Tab」。
//
// 几何全部走纯函数（`clampMove` / `clampResize` / `centeredRect`）：jsdom 没有布局，
// 所有 rect 都是 0，只有把「算坐标」和「写样式」分开才测得动（同 `shell/tooltip.ts` 的路子）。
// 装配层（`buildFrame`）测的是「装上之后那一下拖拽真的改了 left/top」。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { stripCssComments } from "./static";
import {
  centeredRect,
  clampMove,
  clampResize,
  buildFrame,
  WIN_MIN,
  EDGES,
  type WinRect,
  type WinEdge,
} from "../src/shell/windowframe";

const VP = { w: 1000, h: 800 };
const r = (x: number, y: number, w: number, h: number): WinRect => ({ x, y, w, h });

describe("centeredRect", () => {
  it("默认尺寸在视口正中（打开时不偏）", () => {
    expect(centeredRect(VP, 880, 640)).toEqual({ x: 60, y: 80, w: 880, h: 640 });
  });

  it("窗口比视口大时贴 0（负坐标不会把标题栏顶出屏）", () => {
    expect(centeredRect({ w: 600, h: 400 }, 880, 640)).toEqual({ x: 0, y: 0, w: 880, h: 640 });
  });
});

describe("clampMove（拖标题栏）", () => {
  it("正常位移原样跟上", () => {
    expect(clampMove(r(100, 100, 400, 300), 20, -30, VP)).toEqual({
      x: 120,
      y: 70,
      w: 400,
      h: 300,
    });
  });

  it("往右下拖过界 ⇒ 整窗留在视口内（右边/下边各留 0）", () => {
    const moved = clampMove(r(100, 100, 400, 300), 900, 900, VP);
    expect(moved.x).toBe(VP.w - 400);
    expect(moved.y).toBe(VP.h - 300);
  });

  it("往左上拖过界 ⇒ 停在 0，不出现负坐标", () => {
    const moved = clampMove(r(100, 100, 400, 300), -9999, -9999, VP);
    expect(moved).toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });

  it("尺寸不参与移动（只改 x/y）", () => {
    const moved = clampMove(r(10, 10, 400, 300), 5, 5, VP);
    expect([moved.w, moved.h]).toEqual([400, 300]);
  });

  it("窗口比视口宽时 x 钉在 0（上下界反过来了也不能翻转）", () => {
    const moved = clampMove(r(0, 0, 1400, 300), -500, 0, VP);
    expect(moved.x).toBe(0);
  });
});

describe("clampResize（拖八向把手）", () => {
  const base = r(200, 200, 600, 400);

  it("se：右下把手同时长宽高", () => {
    expect(clampResize(base, "se", 30, 40, VP)).toEqual({ x: 200, y: 200, w: 630, h: 440 });
  });

  it("n：上边把手动 y 与 h，下沿不动（对边钉住）", () => {
    const got = clampResize(base, "n", 0, 30, VP);
    expect(got).toEqual({ x: 200, y: 230, w: 600, h: 370 });
    expect(got.y + got.h).toBe(base.y + base.h);
  });

  it("w：左边把手动 x 与 w，右沿不动", () => {
    const got = clampResize(base, "w", 50, 0, VP);
    expect(got).toEqual({ x: 250, y: 200, w: 550, h: 400 });
    expect(got.x + got.w).toBe(base.x + base.w);
  });

  it("e / s：只动一条边", () => {
    expect(clampResize(base, "e", 20, 999, VP).w).toBe(620);
    expect(clampResize(base, "e", 20, 999, VP).h).toBe(400);
    expect(clampResize(base, "s", 999, 20, VP).h).toBe(420);
    expect(clampResize(base, "s", 999, 20, VP).w).toBe(600);
  });

  it("nw：左上角同时收两条边，对边（右下）钉住", () => {
    const got = clampResize(base, "nw", 40, 20, VP);
    expect(got).toEqual({ x: 240, y: 220, w: 560, h: 380 });
    expect(got.x + got.w).toBe(base.x + base.w);
    expect(got.y + got.h).toBe(base.y + base.h);
  });

  it("缩到小于下限 ⇒ 停在 MIN，且被拖的那条边不再往回走（对边仍是锚）", () => {
    const got = clampResize(base, "se", -9999, -9999, VP);
    expect([got.w, got.h]).toEqual([WIN_MIN.w, WIN_MIN.h]);
    expect([got.x, got.y]).toEqual([200, 200]);
    // 从左边收：撞到 MIN 之后 x 不能继续右推（否则窗口会「穿过」右沿继续跑）
    const fromLeft = clampResize(base, "w", 9999, 0, VP);
    expect(fromLeft.w).toBe(WIN_MIN.w);
    expect(fromLeft.x + fromLeft.w).toBe(base.x + base.w);
  });

  it("长过视口 ⇒ 夹到视口大小", () => {
    const got = clampResize(base, "se", 9999, 9999, VP);
    expect(got.x + got.w).toBeLessThanOrEqual(VP.w);
    expect(got.y + got.h).toBeLessThanOrEqual(VP.h);
  });

  it("视口比 WIN_MIN 还窄 ⇒ 下限让位贴满视口（右/下那几根把手不许被推出屏外）", () => {
    // 真机有 560×380 的窗口地板兜着（tauri.conf.json 的 minWidth / minHeight），正常
    // 走不到这一档。走到的话「把手抓不到」是死局 ⇒ 宁可钉在「视口可用宽」上。
    const vp = { w: 400, h: 300 };
    const got = clampResize({ x: 12, y: 12, w: 200, h: 200 }, "se", 9999, 9999, vp);
    expect([got.w, got.h], "不许超过视口").toEqual([388, 288]);
    const back = clampResize(got, "se", -9999, -9999, vp);
    expect([back.w, back.h], "这一档的下限就是视口可用宽，钉得住才不出屏").toEqual([388, 288]);
    expect(back.x + back.w, "右沿仍贴着视口").toBe(vp.w);
  });

  it("八向都覆盖到（漏一档就是那个方向拖不动）", () => {
    expect([...EDGES].sort()).toEqual(
      ["e", "n", "ne", "nw", "s", "se", "sw", "w"].sort() as WinEdge[],
    );
    for (const e of EDGES) {
      const got = clampResize(base, e, 12, 9, VP);
      const moved = `${e}:${got.x},${got.y},${got.w},${got.h}`;
      expect(moved, `${e} 向拖了却没反应`).not.toBe(`${e}:${base.x},${base.y},${base.w},${base.h}`);
    }
  });
});

describe("buildFrame（装上之后的那一下拖拽）", () => {
  let host: HTMLElement;
  let closed: number;
  let frame: ReturnType<typeof buildFrame>;

  const drag = (target: EventTarget & Element, from: [number, number], to: [number, number]) => {
    target.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, clientX: from[0], clientY: from[1] }),
    );
    window.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: to[0], clientY: to[1] }),
    );
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    closed = 0;
    frame = buildFrame({
      title: "设置",
      rect: { x: 60, y: 80, w: 880, h: 640 },
      viewport: () => ({ w: 1000, h: 800 }),
      onClose: () => {
        closed += 1;
      },
      className: "settings-window",
      host,
    });
  });

  afterEach(() => {
    frame.root.remove();
    host.remove();
  });

  it("结构：标题栏（标题 + 关闭键）+ 内容槽 + 八向把手", () => {
    expect(frame.head.textContent).toContain("设置");
    expect(frame.head.querySelector(".win-head-close"), "标题栏要有关闭键").toBeTruthy();
    expect(frame.body.className, "内容槽交给调用方塞东西").toContain("win-body");
    expect(frame.root.querySelectorAll(".win-resize")).toHaveLength(8);
    expect(frame.root.classList.contains("settings-window"), "额外类名要挂上").toBe(true);
  });

  it("位置尺寸由 rect 写进 style（不是靠 flex 居中）", () => {
    expect(frame.root.style.left).toBe("60px");
    expect(frame.root.style.top).toBe("80px");
    expect(frame.root.style.width).toBe("880px");
    expect(frame.root.style.height).toBe("640px");
  });

  it("拖标题栏 ⇒ left/top 跟上，且尺寸不变", () => {
    drag(frame.head, [200, 90], [260, 130]);
    expect(frame.rect()).toEqual({ x: 120, y: 120, w: 880, h: 640 });
    expect(frame.root.style.left).toBe("120px");
  });

  it("拖内容区不算拖窗口（只有标题栏能移动）", () => {
    drag(frame.body, [300, 400], [500, 500]);
    expect(frame.rect().x).toBe(60);
    expect(frame.rect().y).toBe(80);
  });

  it("拖 se 把手 ⇒ 宽高跟上；拖到越界被夹住", () => {
    drag(frame.root.querySelector('.win-resize[data-edge="se"]')!, [940, 720], [990, 760]);
    expect(frame.rect()).toEqual({ x: 60, y: 80, w: 930, h: 680 });
    drag(frame.root.querySelector('.win-resize[data-edge="se"]')!, [990, 760], [9999, 9999]);
    expect(frame.rect().x + frame.rect().w).toBeLessThanOrEqual(1000);
    expect(frame.rect().y + frame.rect().h).toBeLessThanOrEqual(800);
  });

  it("把手按下后 stopPropagation：别把拖拽冒泡到标题栏/遮罩", () => {
    const se = frame.root.querySelector('.win-resize[data-edge="se"]')!;
    const ev = new MouseEvent("pointerdown", { bubbles: true, clientX: 1, clientY: 1 });
    const spy = vi.spyOn(ev, "stopPropagation");
    se.dispatchEvent(ev);
    expect(spy).toHaveBeenCalled();
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
  });

  it("点关闭键走 onClose（只回调，不自己摘 DOM —— 摘不摘归调用方）", () => {
    frame.head
      .querySelector(".win-head-close")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(closed).toBe(1);
    expect(frame.root.isConnected, "buildFrame 不该替调用方决定怎么收场").toBe(true);
  });

  it("按下关闭键不拖着窗口走（它坐在标题栏里，冒泡上去就是「既关又拖」）", () => {
    const close = frame.head.querySelector(".win-head-close")!;
    // 前提自证：这条判据之所以有意义，就是因为这颗键**坐在**可拖的标题栏里
    // （不然「按下不拖动」可以只是没接线）。
    expect(close.parentElement, "关闭键是标题栏的子节点").toBe(frame.head);
    close.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, clientX: 900, clientY: 90 }),
    );
    window.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 999, clientY: 300 }),
    );
    expect(frame.rect(), "关闭键上的按下不该开一次「拖窗口」").toEqual({
      x: 60,
      y: 80,
      w: 880,
      h: 640,
    });
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    // 掐的只是冒泡：这颗键自己那一下必须还点得动。
    close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(closed, "stopPropagation 不许把关闭也掐掉").toBe(1);
  });
});

describe("把手的鼠标形状（CSS 契约）", () => {
  it("八向各有对应 cursor，缺一个就那个方向手感不对", () => {
    const css = stripCssComments(readFileSync("src/styles/global.css", "utf-8"));
    // 四颗角一律 all-scroll：全应用「同时对角两向」就这一档（`.layout-corner` 同值，
    // B61 定的；`tests/splitview.test.ts` 有一条「不得残留 nwse-resize」守着它）。
    // 窗框自创一颗对角箭头 = 同一个动作两种光标 ⇒ 那条守卫会把它判红，判得对。
    const want: Record<WinEdge, string> = {
      n: "ns-resize",
      s: "ns-resize",
      e: "ew-resize",
      w: "ew-resize",
      ne: "all-scroll",
      sw: "all-scroll",
      nw: "all-scroll",
      se: "all-scroll",
    };
    for (const e of EDGES) {
      const block = new RegExp(`\\.win-resize\\[data-edge="${e}"\\]\\s*\\{([^}]*)\\}`).exec(css);
      expect(block, `.win-resize[data-edge="${e}"] 规则缺失`).toBeTruthy();
      expect(block![1], `${e} 向没写 cursor`).toContain(`cursor: ${want[e]}`);
    }
  });

  it("窗框必须脱流（fixed）且自己定位；标题栏不吃文本选中", () => {
    const css = stripCssComments(readFileSync("src/styles/global.css", "utf-8"));
    const frame = /\.win-frame\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(frame, "窗框要 fixed 才能脱离遮罩的 flex 居中").toContain("position: fixed");
    const head = /\.win-head\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(head, "拖标题栏时不能顺手选中文字").toContain("user-select: none");
  });
});

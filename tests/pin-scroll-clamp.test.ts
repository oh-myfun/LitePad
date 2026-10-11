// @vitest-environment jsdom
// B278 · 同步滚动「源码滚到底 → 切标签/分屏后尾行跳到页面底部」的根因修复。
//
// 真机根因（两处叠加）：
//   1. 分屏 / 切标签新建的源码实例在 `setState` 那一帧 `contentHeight` 还没测出来，
//      `applyBottomBleed` 因 `contentHeight<=0` 提前返回、底部留白 `--cm-bleed-bottom`
//      停在 0；于是「末行贴顶」的 322 被偏短的 `scrollHeight` 裁到自然上限（276），
//      留白后续涨回也不回弹。
//   2. `pinScrollTop` 的「立住」判定把**向下裁切**（`landed < px`，落点被浏览器裁到更靠上的
//      可滚上限）当场当「立住」停重试 —— 于是 bleed 涨回后补钉链早已结束，322 永久卡在 276
//      （末行退到视口底，正是用户报的「尾行跳到页面底部」）。
//
// 修复（src/core/viewport.ts 的 `pinScrollTop`）：向下裁切一律继续重试到窗口末，等
// `scrollHeight` 涨回后落定；只对真·坏掉（`landed<=0`）才告警。
//
// 这里用「会裁剪的 scrollTop + 先短后长的 scrollHeight」复刻浏览器行为，直接验证
// 修复前（卡在短上限）与修复后（撑开后落定）的差异。jsdom 不做布局、赋值永远读得回来，
// 所以必须自己装一个会按 `maxScroll` 裁剪的 scrollTop。
import { describe, it, expect } from "vitest";
import { pinScrollTop } from "../src/core/viewport";

/**
 * 复刻浏览器「赋值超出可滚动上限就被裁到 maxScroll」：
 * `scrollHeight`（= maxScroll + 视口高）在 `growAtMs` 那一刻由短变长，
 * 正好对应真机上「底部留白晚一拍 apply / 内容晚一拍撑开」。
 */
function makeClampingEl(opts: {
  startMax: number;
  endMax: number;
  growAtMs: number;
  clientH?: number;
}): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const clientH = opts.clientH ?? 60;
  let st = 0;
  let max = opts.startMax;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => st,
    set: (v: number) => {
      st = Math.min(Math.max(v, 0), max);
    },
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => max + clientH,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => clientH,
  });
  setTimeout(() => {
    max = opts.endMax;
  }, opts.growAtMs);
  return el;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("B278 底部留白晚一拍：向下裁切不能当场判立住", () => {
  it("scrollHeight 撑开后，被裁的 322 应重试落定（修复前永久卡在 240）", async () => {
    // 视口 60；短上限 maxScroll=240（留白未 apply），撑开后 maxScroll=400（留白已 apply）。
    const el = makeClampingEl({ startMax: 240, endMax: 400, growAtMs: 50 });
    // 想钉到 322（末行贴顶）；短上限时只能到 240。
    pinScrollTop(el, 322);
    await wait(30);
    expect(el.scrollTop, "撑开前仍被裁到短上限 240").toBe(240);
    // 等撑开 + 完整重试窗口（PIN_MAX_FRAMES=12 帧 ≈ 200ms）。
    await wait(400);
    expect(el.scrollTop, "撑开后应重试落定到 322（末行贴顶）").toBeCloseTo(322, 6);
  });

  it("文档真·短（px 永久超出可滚上限）：停在合法 maxScroll、不卡死也不告警", async () => {
    // maxScroll 永远 240，322 本就到不了 —— 合法落点是停在 240，不该反复重试到崩溃。
    const el = makeClampingEl({ startMax: 240, endMax: 240, growAtMs: 9_999_999 });
    pinScrollTop(el, 322);
    await wait(400);
    expect(el.scrollTop, "短文档停在 maxScroll 是合法落点").toBe(240);
  });

  it("正常落点（不裁切）仍一帧内立住", async () => {
    const el = makeClampingEl({ startMax: 400, endMax: 400, growAtMs: 9_999_999 });
    pinScrollTop(el, 200);
    await wait(60);
    expect(el.scrollTop, "不裁切时应直接落定 200").toBeCloseTo(200, 6);
  });
});

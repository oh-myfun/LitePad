// @vitest-environment jsdom
// B455-5 · 图表的「Ctrl+滚轮缩放 + 拖拽平移 + 右上角三颗键」。
//
// 用户拍板的两条口径：
// 1. **统一外层变换** —— 八类图共用一层视口变换（画什么由各自的渲染器管，这一层只搬动成品），
//    脑图自带的那发 d3-zoom 让位给它（B455-6）。
// 2. **拖过阈值算平移，纯点击仍进编辑** —— 点图进编辑（B434/B454）不许因为加了拖拽而丢。
//
// 变换作用在 `.md-diagram-canvas`（enhance 建的那一层，见 tests/preview-diagram-viewport.test.ts
// 的「enhance 那一臂」），按键挂在卡片上：卡片会被 `renderDiagram` 反复清空，按键不能被一起抹掉。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { IDLE_VIEW, ZOOM_MAX, ZOOM_MIN, panBy, zoomAt } from "../src/markdown/diagramViewport";
import { attachDiagramViewport } from "../src/markdown/diagramViewport";
import { ruleBlock, stripCssComments } from "./static";

describe("B455-5 · 变换的算术", () => {
  it("以光标为锚：那一点在屏幕上不许跑掉", () => {
    const at = { x: 100, y: 50 };
    const next = zoomAt(IDLE_VIEW, 1.15, at);
    expect(next.scale).toBeCloseTo(1.15);
    // 锚点处的内容点 c = (at - x) / scale，缩放前后要落回同一个屏幕位置
    const cx = (at.x - IDLE_VIEW.x) / IDLE_VIEW.scale;
    const cy = (at.y - IDLE_VIEW.y) / IDLE_VIEW.scale;
    expect(next.x + next.scale * cx).toBeCloseTo(at.x);
    expect(next.y + next.scale * cy).toBeCloseTo(at.y);
  });

  it("档位钳在 0.2×–8×（连滚 40 次也不许缩成看不见 / 放成糊）", () => {
    let view = IDLE_VIEW;
    for (let i = 0; i < 40; i++) view = zoomAt(view, 1.15, { x: 0, y: 0 });
    expect(view.scale).toBe(ZOOM_MAX);
    for (let i = 0; i < 80; i++) view = zoomAt(view, 1 / 1.15, { x: 0, y: 0 });
    expect(view.scale).toBe(ZOOM_MIN);
  });

  it("已经到顶 / 到底 ⇒ 偏移跟着不动（不然图会凭空跳一下）", () => {
    const maxed = { x: -37, y: 21, scale: ZOOM_MAX };
    expect(zoomAt(maxed, 1.3, { x: 10, y: 10 })).toEqual(maxed);
    const min = { x: -37, y: 21, scale: ZOOM_MIN };
    expect(zoomAt(min, 1 / 1.3, { x: 10, y: 10 })).toEqual(min);
  });

  it("平移只搬位置，不动倍率", () => {
    const view = panBy({ x: 5, y: -5, scale: 2 }, 40, -30);
    expect(view).toEqual({ x: 45, y: -35, scale: 2 });
  });
});

// ---- 挂到卡片上的那一发 ----

function mkCard(): {
  card: HTMLElement;
  canvas: HTMLElement;
} {
  const root = document.createElement("div");
  root.className = "md-preview-face";
  root.innerHTML =
    '<div class="md-diagram md-diagram--mermaid"><div class="md-diagram-canvas">' +
    '<svg xmlns="http://www.w3.org/2000/svg"></svg></div></div>';
  document.body.append(root);
  const card = root.querySelector<HTMLElement>(".md-diagram")!;
  const canvas = card.querySelector<HTMLElement>(".md-diagram-canvas")!;
  // jsdom 没有布局 ⇒ 卡片的位置与尺寸自己给（锚点算的是「指针相对卡片左上角」）
  card.getBoundingClientRect = () =>
    ({
      left: 10,
      top: 20,
      width: 400,
      height: 300,
      right: 410,
      bottom: 320,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    }) as DOMRect;
  return { card, canvas };
}

function scaleOf(canvas: HTMLElement): number {
  const m = /scale\(([-0-9.]+)\)/.exec(canvas.style.transform);
  expect(m, `transform 里读不到倍率：${canvas.style.transform || "(空)"}`).toBeTruthy();
  return Number(m![1]);
}

function offsetsOf(canvas: HTMLElement): { x: number; y: number } {
  const m = /translate\(([-0-9.]+)px,\s*([-0-9.]+)px\)/.exec(canvas.style.transform);
  expect(m, `transform 里读不到平移：${canvas.style.transform || "(空)"}`).toBeTruthy();
  return { x: Number(m![1]), y: Number(m![2]) };
}

const wheel = (deltaY: number, clientX = 10, clientY = 20, ctrl = false) =>
  new WheelEvent("wheel", {
    deltaY,
    clientX,
    clientY,
    ctrlKey: ctrl,
    bubbles: true,
    cancelable: true,
  });

/** 「视图缩放」那一发：按住 Ctrl 才算（2026-11-15 口径）。 */
const zoomWheel = (deltaY: number, clientX = 10, clientY = 20) =>
  wheel(deltaY, clientX, clientY, true);

const mouse = (type: string, clientX: number, clientY: number) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY });

describe("B455-5 · Ctrl+滚轮缩放", () => {
  it("按住 Ctrl 往上滚 = 放大，往下滚 = 缩小（步进 1.15×）", () => {
    const { card, canvas } = mkCard();
    attachDiagramViewport(card);
    canvas.dispatchEvent(zoomWheel(-100));
    expect(scaleOf(canvas)).toBeCloseTo(1.15);
    canvas.dispatchEvent(zoomWheel(100));
    expect(scaleOf(canvas), "放大之后再来一发往下 = 回到原样").toBeCloseTo(1);
  });

  it("不按 Ctrl 的滚轮：不缩放、不拦默认滚动（交回文档）", () => {
    const { card, canvas } = mkCard();
    attachDiagramViewport(card);
    const svg = canvas.querySelector("svg")!;
    // 脑图的 d3-zoom 就挂在图内的 SVG 上（B455-6）：这一发必须被外面的捕获相截住，
    // 否则 CSS transform 缩一次、d3-zoom 再缩一次。
    const reached: string[] = [];
    svg.addEventListener("wheel", () => reached.push("svg"));
    const event = wheel(-100);
    svg.dispatchEvent(event);
    expect(scaleOf(canvas), "普通滚轮不该缩放图表（2026-11-15 用户口径）").toBe(1);
    expect(event.defaultPrevented, "不按 Ctrl 就必须放行默认滚动").toBe(false);
    expect(reached, "没截住 ⇒ 脑图自带的 d3-zoom 会自己放大").toEqual([]);
  });

  it("Ctrl+滚轮缩放时不许顺带把预览面板滚走（preventDefault）", () => {
    const { card, canvas } = mkCard();
    attachDiagramViewport(card);
    const event = zoomWheel(-100);
    canvas.dispatchEvent(event);
    expect(event.defaultPrevented, "没拦 ⇒ 缩一张图的同时整篇文档在跑").toBe(true);
  });

  it("以光标为锚：滚轮落在哪，那一处内容就钉在哪", () => {
    const { card, canvas } = mkCard();
    attachDiagramViewport(card);
    // 指针落在卡片里 (200, 100) 处（rect 是 10/20 起）
    canvas.dispatchEvent(zoomWheel(-100, 210, 120));
    expect(scaleOf(canvas)).toBeCloseTo(1.15);
    const { x, y } = offsetsOf(canvas);
    expect(x).toBeCloseTo(200 - 200 * 1.15);
    expect(y).toBeCloseTo(100 - 100 * 1.15);
  });

  it("已经放到最大还往上滚 ⇒ 不许一路飘走（偏移也不动）", () => {
    const { card, canvas } = mkCard();
    attachDiagramViewport(card);
    for (let i = 0; i < 40; i++) canvas.dispatchEvent(zoomWheel(-100, 210, 120));
    const before = offsetsOf(canvas);
    canvas.dispatchEvent(zoomWheel(-100, 210, 120));
    expect(scaleOf(canvas)).toBe(ZOOM_MAX);
    expect(offsetsOf(canvas)).toEqual(before);
  });
});

describe("B455-5 · 右上角三颗键", () => {
  function buttons(card: HTMLElement): Record<"in" | "out" | "reset", HTMLElement> {
    const get = (sel: string) => {
      const el = card.querySelector<HTMLElement>(sel);
      expect(el, `右上角缺这颗键：${sel}`).toBeTruthy();
      return el!;
    };
    return {
      in: get(".md-diagram-zoom-in"),
      out: get(".md-diagram-zoom-out"),
      reset: get(".md-diagram-zoom-reset"),
    };
  }

  it("三颗键都画在卡片右上角那一格里", () => {
    const { card } = mkCard();
    attachDiagramViewport(card);
    const { in: zoomIn, out, reset } = buttons(card);
    const bar = zoomIn.parentElement!;
    expect(bar.className, "三颗键要同一格（右上角那一条）").toContain("md-diagram-zoom");
    expect(bar.contains(out)).toBe(true);
    expect(bar.contains(reset)).toBe(true);
  });

  it("放大 / 缩小按 1.3 一档，复位回到 1× 且平移归零", () => {
    const { card, canvas } = mkCard();
    attachDiagramViewport(card);
    const { in: zoomIn, out, reset } = buttons(card);
    zoomIn.click();
    expect(scaleOf(canvas)).toBeCloseTo(1.3);
    zoomIn.click();
    reset.click();
    expect(scaleOf(canvas), "复位 = 回到 1×").toBe(1);
    expect(offsetsOf(canvas), "复位也要把平移归零（不然图还在别处）").toEqual({ x: 0, y: 0 });
    out.click();
    expect(scaleOf(canvas)).toBeCloseTo(1 / 1.3);
  });

  it("按键带提示与 codicon（不许用原生 title）", () => {
    const { card } = mkCard();
    attachDiagramViewport(card);
    for (const el of card.querySelectorAll<HTMLElement>(".md-diagram-zoom button")) {
      expect(el.getAttribute("title"), "原生 title 与全应用两档提示口径冲突").toBeNull();
      expect(el.className).toContain("codicon");
      expect(el.dataset.tip, "按键得能说清自己是什么").toBeTruthy();
    }
  });

  it("点按键不算「点图进编辑」，而按键自己得按得动", () => {
    const { card, canvas } = mkCard();
    attachDiagramViewport(card);
    const taps: string[] = [];
    card.addEventListener("md-diagram-tap", () => taps.push("tap"));
    const { in: zoomIn } = buttons(card);
    zoomIn.click();
    expect(scaleOf(canvas), "那颗按键被捕获相的处理一起吃掉了 ⇒ 放大键按不动").toBeCloseTo(1.3);
    zoomIn.dispatchEvent(mouse("mousedown", 380, 30));
    card.dispatchEvent(mouse("mouseup", 380, 30));
    expect(taps, "按键上点一下也进编辑 ⇒ 分不清是在按按键还是在改图").toEqual([]);
    expect(offsetsOf(canvas), "在按键那一格里按下不该开始平移").toEqual({ x: 0, y: 0 });
  });
});

describe("B455-5 · 拖拽平移 / 纯点击", () => {
  it("拖过阈值 ⇒ 图跟着走，且不发「点图」", () => {
    const { card, canvas } = mkCard();
    attachDiagramViewport(card);
    const seen: string[] = [];
    card.addEventListener("md-diagram-tap", () => seen.push("tap"));
    canvas.dispatchEvent(mouse("mousedown", 100, 100));
    card.dispatchEvent(mouse("mousemove", 140, 90));
    card.dispatchEvent(mouse("mouseup", 140, 90));
    expect(offsetsOf(canvas), "拖了 40×-10 ⇒ 平移同量").toEqual({ x: 40, y: -10 });
    expect(seen, "拖过阈值还进编辑态 = 拖一张图变成改一张图").toEqual([]);
  });

  it("没拖过阈值（纯点击）⇒ 发一颗 tap，图不动", () => {
    const { card, canvas } = mkCard();
    attachDiagramViewport(card);
    const seen: string[] = [];
    card.addEventListener("md-diagram-tap", () => seen.push("tap"));
    canvas.dispatchEvent(mouse("mousedown", 100, 100));
    card.dispatchEvent(mouse("mousemove", 102, 99)); // 2px 抖动，算手指抖
    card.dispatchEvent(mouse("mouseup", 102, 99));
    expect(seen, "点图进编辑这条不能因为加拖拽而丢（B434/B454）").toEqual(["tap"]);
    expect(offsetsOf(canvas)).toEqual({ x: 0, y: 0 });
  });

  it("按住拖时是「抓取」光标，松手收回", () => {
    const { card, canvas } = mkCard();
    attachDiagramViewport(card);
    canvas.dispatchEvent(mouse("mousedown", 100, 100));
    card.dispatchEvent(mouse("mousemove", 160, 100));
    expect(card.className, "拖的时候卡片要挂上 dragging 那一档").toMatch(/md-diagram--panning/);
    card.dispatchEvent(mouse("mouseup", 160, 100));
    expect(card.className, "松手就收回").not.toMatch(/md-diagram--panning/);
  });

  // 图自己把 mousedown 的冒泡掐了（markmap 的 d3-zoom 正是这一形，B454-2 真机抓的）
  // ⇒ 变换层与 tap 都得在**捕获相**收得到，否则「脑图未支持」这条旧账重演一遍。
  it("图自己掐了 mousedown 的冒泡也照样能拖、能点", () => {
    const { card, canvas } = mkCard();
    attachDiagramViewport(card);
    const svg = canvas.querySelector("svg")!;
    svg.addEventListener("mousedown", (event) => event.stopImmediatePropagation());
    const seen: string[] = [];
    card.addEventListener("md-diagram-tap", () => seen.push("tap"));
    svg.dispatchEvent(mouse("mousedown", 100, 100));
    card.dispatchEvent(mouse("mouseup", 100, 100));
    expect(seen, "捕获相没接 ⇒ 脑图点了没反应").toEqual(["tap"]);
    svg.dispatchEvent(mouse("mousedown", 100, 100));
    card.dispatchEvent(mouse("mousemove", 130, 100));
    card.dispatchEvent(mouse("mouseup", 130, 100));
    expect(offsetsOf(canvas).x, "脑图拖不动 = 统一变换层没接管").toBe(30);
  });

  it("拖出卡片之后松手也算这一发（不许漏一半）", () => {
    const { card, canvas } = mkCard();
    attachDiagramViewport(card);
    canvas.dispatchEvent(mouse("mousedown", 100, 100));
    document.body.dispatchEvent(mouse("mousemove", 180, 100));
    document.body.dispatchEvent(mouse("mouseup", 180, 100));
    expect(offsetsOf(canvas).x).toBe(80);
  });

  it("右键 / 中键不许开始平移", () => {
    const { card, canvas } = mkCard();
    attachDiagramViewport(card);
    canvas.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 100,
        clientY: 100,
      }),
    );
    card.dispatchEvent(mouse("mousemove", 200, 100));
    expect(offsetsOf(canvas)).toEqual({ x: 0, y: 0 });
  });
});

describe("B455-5 · 样式与接线", () => {
  const css = () => stripCssComments(readFileSync("src/preview/preview.css", "utf-8"));

  it("卡片收得住超出的一格（改成 hidden：平移缩放接管了原来的横向滚动）", () => {
    expect(ruleBlock(css(), ".md-preview-face .md-diagram-widget .md-diagram")).toMatch(
      /overflow:\s*hidden/,
    );
  });

  it("变换那一格的原点钉在左上角（锚点算的就是相对它的偏移）", () => {
    expect(ruleBlock(css(), ".md-preview-face .md-diagram-canvas")).toMatch(
      /transform-origin:\s*0 0/,
    );
    expect(ruleBlock(css(), ".md-preview-face .md-diagram-canvas")).toMatch(/cursor:\s*grab/);
  });

  it("拖的时候换「抓取」光标", () => {
    const block = ruleBlock(css(), ".md-preview-face .md-diagram--panning .md-diagram-canvas");
    expect(block).toMatch(/cursor:\s*grabbing/);
  });

  it("右上角那一格不许被变换搬走（按键跟着图飘就没法连点）", () => {
    const block = ruleBlock(css(), ".md-preview-face .md-diagram-zoom");
    expect(block).toMatch(/position:\s*absolute/);
    expect(block).toMatch(/top:/);
    expect(block).toMatch(/right:/);
    expect(block).not.toMatch(/transform:\s*var\(--md-diagram-transform/);
  });

  it("三颗缩放键平时收着，悬停图块或键盘聚焦才现形（复制键同款）", () => {
    const block = ruleBlock(css(), ".md-preview-face .md-diagram-zoom");
    expect(block).toMatch(/opacity:\s*0/);
    expect(block).toMatch(/pointer-events:\s*none/);
    expect(css()).toMatch(
      /\.md-preview-face \.md-diagram-widget:hover \.md-diagram-zoom[^{]*\{[^}]*opacity:\s*1/,
    );
    expect(css()).toMatch(
      /\.md-preview-face \.md-diagram-zoom:focus-within[^{]*\{[^}]*opacity:\s*1/,
    );
  });

  it("enhance 那一臂：渲染结果落在 .md-diagram-canvas 里，变换层挂在卡片上", () => {
    const src = readFileSync("src/markdown/enhance.ts", "utf-8");
    expect(src).toMatch(/class Name = "md-diagram-canvas"|className = "md-diagram-canvas"/);
    expect(src, "画完没接变换层 ⇒ 用户看到的还是一张不能缩放的图").toMatch(
      /attachDiagramViewport\(/,
    );
  });

  it("画失败退回源码那一格时不留按键，且同一张卡片挂两次不许长出两条按键", async () => {
    const { card } = mkCard();
    attachDiagramViewport(card);
    attachDiagramViewport(card); // 实时重画走的是「新卡片 + 新 attach」，这一发只防手滑重复挂
    expect(card.querySelectorAll(".md-diagram-zoom").length, "重复挂 = 右上角长出两排键").toBe(1);
  });
});

// B456 · 用户报的两条：宽图把卡片顶宽（右上角三颗键跑出窗口）+ 双击复位。
describe("B456-1 · 卡片不许把整块内容层撑宽", () => {
  // 一条通用的：`.cm-content` 按 max-content 取宽 ⇒ **任何**块 widget 的固有宽度都能把整块内容层撑起来，
  // 同屏每一张卡片跟着变宽（真机量到 content 1294 / 3077 vs 可视 1161）。图种先被抓到，
  // 表格是同一条病（`.md-table-body` 本来就带 `overflow-x: auto` 接这一格）。
  const noShrink = [".md-preview-face .md-diagram-widget", ".md-preview-face .md-table-widget"];

  for (const sel of noShrink) {
    it(`${sel} 的固有宽度与内容脱钩（contain: inline-size）`, () => {
      const block = ruleBlock(
        stripCssComments(readFileSync("src/preview/preview.css", "utf-8")),
        sel,
      );
      expect(
        block,
        "宽内容就把 .cm-content 撑宽 ⇒ 同屏所有卡片跟着变宽、钉在卡片右沿的三颗键跑到窗口外" +
          "（真机量到 content 3077px vs 可视 1161px）",
      ).toMatch(/contain:[^;]*inline-size/);
    });
  }
});

describe("B456-2 · 双击复位", () => {
  it("放大 + 平移之后双击图里 ⇒ 回到 1:1 原位，并发一颗 reset", () => {
    const { card, canvas } = mkCard();
    attachDiagramViewport(card);
    const seen: string[] = [];
    card.addEventListener("md-diagram-reset", () => seen.push("reset"));
    canvas.dispatchEvent(zoomWheel(-100)); // 放大一档
    canvas.dispatchEvent(mouse("mousedown", 100, 100));
    card.dispatchEvent(mouse("mousemove", 160, 120));
    card.dispatchEvent(mouse("mouseup", 160, 120)); // 拖过阈值 = 平移
    expect(scaleOf(canvas), "前置条件：这一发得先被放大过").toBeCloseTo(1.15);
    expect(offsetsOf(canvas), "前置条件：这一发得先被平移过").toEqual({ x: 60, y: 20 });

    card.dispatchEvent(mouse("dblclick", 120, 110));
    expect(scaleOf(canvas), "双击没把倍率收回 1:1").toBeCloseTo(1);
    expect(offsetsOf(canvas), "双击没把位移收回原位").toEqual({ x: 0, y: 0 });
    expect(seen, "变换层复位了却不发一颗事件 ⇒ 编辑入口那边不知道，源码框还浮着").toEqual([
      "reset",
    ]);
  });

  it("双击右上角按键那一格 ⇒ 只算按键，那一片不许管复位", () => {
    const { card, canvas } = mkCard();
    attachDiagramViewport(card);
    const zoomIn = card.querySelector<HTMLElement>(".md-diagram-zoom-in")!;
    canvas.dispatchEvent(zoomWheel(-100)); // 先离开工位，否则「没动」永远成立（判据自证）
    canvas.dispatchEvent(mouse("mousedown", 100, 100));
    card.dispatchEvent(mouse("mousemove", 160, 120));
    card.dispatchEvent(mouse("mouseup", 160, 120));
    expect(scaleOf(canvas), "前置条件：这一发得先被放大过").toBeCloseTo(1.15);

    zoomIn.dispatchEvent(mouse("dblclick", 380, 30));
    expect(scaleOf(canvas), "在按键上双击被当成复位 ⇒ 连点放大会变成回零").toBeCloseTo(1.15);
    expect(offsetsOf(canvas), "同上：位移也不许被按键那一片的双击抹掉").toEqual({ x: 60, y: 20 });
  });
});

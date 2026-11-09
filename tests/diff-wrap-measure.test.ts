// @vitest-environment jsdom
// B465 · 折行行高量尺（差异缝「一开始就算好」的地基）。
//
// 钉三件事：
//   1) 整篇一次给齐每行的折行高度（不是等滚到才量）；
//   2) 缓存按**行文本**记 —— 再量一次不重排 DOM；
//   3) 宽度 / 排版变了，缓存整批作废。
//
// jsdom 没有布局，`getBoundingClientRect` 恒 0；这里用一颗假矩形把「浏览器折行」换成
// 「每 N 个字符一个视觉行」的确定规则，量尺本身只认 rect.height，判得到缓存与失效。
import { afterEach, describe, expect, it, vi } from "vitest";
import { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { createWrapMeter } from "../src/diff/wrap-measure";

const LINE = 20;
/** 假矩形：`charsPerRow` 个字符折一行（与字号宽度无关，量尺只读高度）。 */
let charsPerRow = 10;
let contentWidth = 300;
let probeReads = 0;

function rect(width: number, height: number): DOMRect {
  return {
    left: 0,
    right: width,
    top: 0,
    bottom: height,
    width,
    height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function fakeView(lines: string[]): { view: EditorView; dom: HTMLElement; content: HTMLElement } {
  const dom = document.createElement("div");
  dom.className = "cm-editor";
  const content = document.createElement("div");
  content.className = "cm-content cm-lineWrapping";
  const rendered = document.createElement("div");
  rendered.className = "cm-line";
  rendered.textContent = "x";
  content.appendChild(rendered);
  dom.appendChild(content);
  document.body.appendChild(dom);
  const view = {
    dom,
    contentDOM: content,
    state: { doc: Text.of(lines) },
  } as unknown as EditorView;
  return { view, dom, content };
}

let restoreRect: (() => void) | null = null;

function stubRects(): void {
  const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    const el = this as HTMLElement;
    if (el.classList.contains("cm-content")) return rect(contentWidth, 400);
    if (el.classList.contains("diff-wrap-probe-line")) {
      probeReads++;
      const len = (el.textContent ?? "").length;
      return rect(contentWidth, LINE * Math.max(1, Math.ceil(len / charsPerRow)));
    }
    return rect(0, 0);
  });
  restoreRect = () => spy.mockRestore();
}

afterEach(() => {
  restoreRect?.();
  restoreRect = null;
  charsPerRow = 10;
  contentWidth = 300;
  probeReads = 0;
});

describe("B465 · 折行行高量尺", () => {
  it("整篇一次给齐：空行占一个视觉行，长行按折出来的行数算", () => {
    stubRects();
    const { view } = fakeView(["short", "a".repeat(25), ""]);
    const meter = createWrapMeter(view);
    try {
      expect(meter.heights()).toEqual([LINE, LINE * 3, LINE]);
    } finally {
      meter.dispose();
    }
  });

  it("缓存按行文本记：再量一次不重排 DOM（CM6 的估值怎么变都不影响）", () => {
    stubRects();
    const { view } = fakeView(["a".repeat(25), "b"]);
    const meter = createWrapMeter(view);
    try {
      expect(meter.heights()).toEqual([LINE * 3, LINE]);
      probeReads = 0;
      charsPerRow = 1; // 若真的重量，长行会变成 25 个视觉行
      expect(meter.heights()).toEqual([LINE * 3, LINE]);
      expect(probeReads, "命中缓存时一行都不该重量").toBe(0);
    } finally {
      meter.dispose();
    }
  });

  it("宽度变了 ⇒ 缓存整批作废，按新宽度重量", () => {
    stubRects();
    const { view } = fakeView(["a".repeat(25)]);
    const meter = createWrapMeter(view);
    try {
      expect(meter.heights()).toEqual([LINE * 3]);
      contentWidth = 120;
      charsPerRow = 5;
      expect(meter.heights(), "窄了就该折得更多").toEqual([LINE * 5]);
    } finally {
      meter.dispose();
    }
  });

  it("面板还没有宽度（或整栏不可见）⇒ null，调用方退回 CM6 的估值", () => {
    stubRects();
    const { view } = fakeView(["a"]);
    const meter = createWrapMeter(view);
    try {
      contentWidth = 0;
      expect(meter.heights()).toBeNull();
    } finally {
      meter.dispose();
    }
  });

  it("dispose 把量具从编辑器 DOM 里摘掉", () => {
    stubRects();
    const { view, dom } = fakeView(["a"]);
    const meter = createWrapMeter(view);
    expect(meter.heights()).toEqual([LINE]);
    expect(dom.querySelector(".diff-wrap-probe"), "量过之后量具挂在编辑器里").toBeTruthy();
    meter.dispose();
    expect(dom.querySelector(".diff-wrap-probe")).toBeNull();
  });
});

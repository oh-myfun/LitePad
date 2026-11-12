// @vitest-environment jsdom
// 预览块里的原生选区覆盖层 + 同词高亮的圆角。
//
// 这一片守四件事：
//   1. 行内碎片按视觉行合并成一条；横向隔开（表格单元格边框）不合并；
//   2. 视口坐标换算到宿主、宿主外的矩形丢掉、相邻行的行距缝补齐；
//   3. 覆盖层只会落在预览块里的块级宿主上（跨块 / 拖出块外交还浏览器）；
//   4. 样式侧：同词高亮吃正文同一档圆角；覆盖层画在块底色之上、文字之下。

import { readFileSync } from "node:fs";

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { applyCorners, type CornerRect } from "../src/editor/roundedSelection";
import {
  mergeLineRects,
  selectionHost,
  widgetSelection,
  widgetSelectionRects,
} from "../src/preview/widgetSelection";
import { ruleBlock, stripCssComments, stripLineComments } from "./static";

const CSS = stripCssComments(readFileSync("src/styles/global.css", "utf-8"));

function rect(left: number, top: number, width: number, height: number): CornerRect {
  return { left, top, width, height };
}

/** 假的 DOM Range：只提供覆盖层要用的 `getClientRects`。 */
function fakeRange(rects: readonly CornerRect[]): Range {
  const list = rects.map((r) => ({
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
    right: r.left + r.width,
    bottom: r.top + r.height,
  }));
  return { getClientRects: () => list } as unknown as Range;
}

/** 一棵预览块 DOM：contentDOM > .md-block > code > 文本。 */
function previewDom() {
  const content = document.createElement("div");
  const block = document.createElement("div");
  block.className = "md-block";
  const code = document.createElement("code");
  code.style.display = "block";
  const text = document.createTextNode("alpha beta");
  code.append(text);
  block.append(code);
  content.append(block);
  document.body.append(content);
  return { content, block, code, text };
}

describe("mergeLineRects：一条视觉行只留一块", () => {
  it("shiki 的 token 碎片接回一条", () => {
    expect(mergeLineRects([rect(10, 0, 20, 18), rect(30.5, 0, 15, 18)])).toEqual([
      rect(10, 0, 35.5, 18),
    ]);
  });

  it("横向隔开超过 2px 的不接（表格单元格边框）", () => {
    expect(mergeLineRects([rect(10, 0, 20, 18), rect(33, 0, 10, 18)])).toEqual([
      rect(10, 0, 20, 18),
      rect(33, 0, 10, 18),
    ]);
  });

  it("上下不同行不合并", () => {
    expect(mergeLineRects([rect(10, 0, 20, 18), rect(10, 18, 20, 18)])).toEqual([
      rect(10, 0, 20, 18),
      rect(10, 18, 20, 18),
    ]);
  });
});

describe("widgetSelectionRects：视口坐标 → 宿主坐标", () => {
  const host = { top: 100, left: 50, bottom: 500 };

  it("换算坐标、丢掉宿主外的矩形、补齐行距缝", () => {
    const range = fakeRange([
      rect(60, 110, 40, 18), // 行 1
      rect(60, 131, 40, 18), // 行 2，与上行隔 3px
      rect(10, 20, 30, 18), // 在宿主外
    ]);
    expect(widgetSelectionRects(range, host, 21)).toEqual([
      rect(10, 10, 40, 19.5),
      rect(10, 29.5, 40, 19.5),
    ]);
  });

  it("一行都没有（选区在宿主外）时返回空", () => {
    expect(widgetSelectionRects(fakeRange([rect(10, 20, 30, 18)]), host, 21)).toEqual([]);
  });
});

describe("selectionHost：只接管预览块内部", () => {
  it("选区在预览块里 → 宿主是最近的块级元素", () => {
    const { content, code, text } = previewDom();
    const range = document.createRange();
    range.selectNodeContents(text);
    expect(selectionHost(range, content)).toBe(code);
  });

  it("拖出预览块 → 不接管", () => {
    const { content, text } = previewDom();
    const outside = document.createElement("p");
    outside.textContent = "outside";
    content.append(outside);
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(outside.firstChild!, 3);
    expect(selectionHost(range, content)).toBeNull();
  });

  it("整段跨在两个子块之间（公共祖先就是 .md-block）→ 不接管", () => {
    const { content, block } = previewDom();
    const first = block.querySelector("code")!;
    const second = document.createElement("code");
    second.style.display = "block";
    second.textContent = "gamma";
    block.append(second);
    const range = document.createRange();
    range.setStart(first.firstChild!, 1);
    range.setEnd(second.firstChild!, 2);
    expect(selectionHost(range, content)).toBeNull();
  });

  it("不在本编辑器的 contentDOM 里 → 不接管", () => {
    const { text } = previewDom();
    const range = document.createRange();
    range.selectNodeContents(text);
    expect(selectionHost(range, document.createElement("div"))).toBeNull();
  });
});

describe("圆角档位复用正文那一套", () => {
  it("凸角加 class、凹角挂补块", () => {
    const element = document.createElement("div");
    applyCorners(element, { tl: "round", tr: "flat", bl: "concave", br: "flat" });
    expect(element.classList.contains("lp-sel-tl")).toBe(true);
    expect(element.classList.contains("lp-sel-tr")).toBe(false);
    expect(element.querySelector(".lp-sel-fillet-bl")).not.toBeNull();
    expect(element.querySelector(".lp-sel-fillet-br")).toBeNull();
  });
});

describe("覆盖层扩展", () => {
  it("挂载时不凭空建层，销毁后不留节点", () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "x", extensions: [widgetSelection()] }),
      parent: document.body,
    });
    expect(view.dom.querySelector(".lp-widget-selectionLayer")).toBeNull();
    view.destroy();
    expect(document.querySelector(".lp-widget-selectionLayer")).toBeNull();
  });

  it("预览档把覆盖层挂在 livePreview 之后", () => {
    const src = stripLineComments(readFileSync("src/preview/wysiwyg.ts", "utf-8"));
    expect(src).toMatch(/widgetSelection\(\),/);
  });
});

describe("样式：同词高亮圆角、覆盖层落在文字下面", () => {
  it("与选中词相同的其它出现吃正文同一档圆角", () => {
    const block = ruleBlock(CSS, ".panel-host .cm-editor .cm-selectionMatch");
    expect(block).toMatch(/border-radius:\s*var\(--lp-sel-radius\)/);
  });

  it("宿主建立层叠上下文，覆盖层用负 z-index 落到文字下面", () => {
    const host = ruleBlock(CSS, ".panel-host .cm-editor .lp-native-sel-host");
    expect(host).toMatch(/position:\s*relative/);
    expect(host).toMatch(/isolation:\s*isolate/);
    const layer = ruleBlock(CSS, ".panel-host .cm-editor .lp-widget-selectionLayer");
    expect(layer).toMatch(/position:\s*absolute/);
    expect(layer).toMatch(/z-index:\s*-1/);
    expect(layer).toMatch(/pointer-events:\s*none/);
  });

  it("原生直角高亮只在覆盖层生效时藏", () => {
    const block = ruleBlock(
      CSS,
      ".panel-host .cm-editor.lp-widget-selection .md-block ::selection",
    );
    // CM6 基础主题给聚焦的可编辑子元素写了 `background-color: highlight !important`，
    // 这条必须同样带 !important 才压得住（真机未加时选区仍是系统蓝，覆盖层被盖住）。
    expect(block).toMatch(/background-color:\s*transparent\s*!important/);
  });
});

// @vitest-environment jsdom
// 预览块里的原生选区覆盖层 + 同词高亮的圆角。
//
// 这一片守五件事：
//   1. 行内碎片按视觉行合并成一条；横向隔开（表格单元格边框）不合并；
//   2. 视口坐标换算到宿主、宿主外的矩形丢掉、相邻行的行距缝补齐；
//   3. 选区按 `.cm-content` 的直接子块逐块切分：全选 / 跨块时每块各画一层；
//   4. 块内 `contenteditable="false"` 的装饰文字排除，但只读表格那样的整块不可编辑
//      情形仍算正文；
//   5. 样式侧：同词高亮吃正文同一档圆角；覆盖层画在块底色之上、文字之下；
//      原生直角高亮只在覆盖层真的画出来的块上藏。

import { readFileSync } from "node:fs";

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { applyCorners, type CornerRect } from "../src/editor/roundedSelection";
import {
  blockHost,
  intersectText,
  mergeLineRects,
  widgetSelection,
  widgetSelectionPlans,
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

/** jsdom 不做布局：给 Range 的 `getClientRects` 与宿主的包围盒打桩，跑完还原。 */
function withLayout(hosts: readonly HTMLElement[], run: () => void): void {
  const original = Range.prototype.getClientRects;
  Range.prototype.getClientRects = () =>
    [
      { left: 10, top: 0, width: 40, height: 18 },
      { left: 10, top: 21, width: 40, height: 18 },
    ] as unknown as DOMRectList;
  for (const host of hosts) {
    host.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 200,
        bottom: 200,
        width: 200,
        height: 200,
      }) as DOMRect;
  }
  try {
    run();
  } finally {
    Range.prototype.getClientRects = original;
  }
}

/** 一棵预览块 DOM：contentDOM > .md-block > 块级 code > 文本。 */
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

/** 围栏代码块：根挂 `contenteditable="false"`（整颗组件不可编辑），行号槽装饰，
 *  code 再用 plaintext-only 重新开编辑 —— 真机就是这三层叠一起。 */
function codeBlockDom(content: HTMLElement) {
  const block = document.createElement("div");
  block.className = "md-block md-codeblock-widget";
  block.setAttribute("contenteditable", "false");
  const gutter = document.createElement("div");
  gutter.className = "md-codeblock-gutter";
  gutter.style.display = "block";
  gutter.setAttribute("contenteditable", "false");
  gutter.textContent = "1";
  const pre = document.createElement("pre");
  pre.style.display = "block";
  const code = document.createElement("code");
  code.style.display = "block";
  code.setAttribute("contenteditable", "plaintext-only");
  code.textContent = "alpha beta";
  pre.append(code);
  block.append(gutter, pre);
  content.append(block);
  return {
    block,
    gutter,
    code,
    text: code.firstChild as Text,
    gutterText: gutter.firstChild as Text,
  };
}

/** 表格块：根不是 `.md-block`，格子在只读档是 `contenteditable="false"`。 */
function tableDom(content: HTMLElement, editable: boolean) {
  const block = document.createElement("div");
  block.className = "md-table-widget";
  const table = document.createElement("table");
  const row = document.createElement("tr");
  const cells = ["alpha", "beta"].map((text) => {
    const cell = document.createElement("td");
    cell.style.display = "table-cell";
    cell.setAttribute("contenteditable", editable ? "true" : "false");
    cell.textContent = text;
    row.append(cell);
    return cell;
  });
  table.append(row);
  block.append(table);
  content.append(block);
  return {
    block,
    cells,
    first: cells[0].firstChild as Text,
    last: cells[1].firstChild as Text,
  };
}

function rangeBetween(start: Text, end: Text, from = 0, to = end.length): Range {
  const range = document.createRange();
  range.setStart(start, from);
  range.setEnd(end, to);
  return range;
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

describe("intersectText：选区与一颗文字节点的交集", () => {
  it("取中段", () => {
    const node = document.createTextNode("abcdef");
    const range = document.createRange();
    range.setStart(node, 2);
    range.setEnd(node, 4);
    expect(intersectText(range, node)?.toString()).toBe("cd");
  });

  it("选区包住整颗节点（起点是元素边界）时取全部", () => {
    const parent = document.createElement("code");
    const node = document.createTextNode("abcdef");
    parent.append(node);
    const range = document.createRange();
    range.selectNodeContents(parent);
    expect(intersectText(range, node)?.toString()).toBe("abcdef");
  });

  it("不相交或空节点返回 null", () => {
    const node = document.createTextNode("abc");
    const other = document.createTextNode("xyz");
    document.body.append(node, other);
    const range = document.createRange();
    range.selectNodeContents(other);
    expect(intersectText(range, node)).toBeNull();
    expect(intersectText(range, document.createTextNode(""))).toBeNull();
  });
});

describe("blockHost：跳过行内盒，落到最近的块级祖先", () => {
  it("span 里的文字挂到外层的块级 div", () => {
    const block = document.createElement("div");
    const inner = document.createElement("div");
    inner.style.display = "block";
    const span = document.createElement("span");
    span.style.display = "inline";
    const text = document.createTextNode("x");
    span.append(text);
    inner.append(span);
    block.append(inner);
    expect(blockHost(text, block)).toBe(inner);
  });

  it("code 自己是块级时就用它当宿主", () => {
    const { block, code, text } = previewDom();
    expect(blockHost(text, block)).toBe(code);
  });
});

describe("widgetSelectionPlans：逐块切分、多宿主", () => {
  it("选区跨两块时每块各一组矩形", () => {
    const { content, block: first, text: firstText } = previewDom();
    const second = codeBlockDom(content);
    const range = rangeBetween(firstText, second.text, 1, 4);
    withLayout([first.querySelector("code")!, second.code], () => {
      const plan = widgetSelectionPlans(range, content, 21);
      expect(plan.hosts.size).toBe(2);
      expect(plan.blocks).toEqual([first, second.block]);
      expect(plan.hosts.get(second.code)).toEqual([
        rect(10, 0, 40, 19.5),
        rect(10, 19.5, 40, 19.5),
      ]);
    });
  });

  it("块里有可编辑内容时排除 contenteditable=false 的装饰文字", () => {
    const content = document.createElement("div");
    const { block, gutterText, code } = codeBlockDom(content);
    const range = rangeBetween(gutterText, code.firstChild as Text, 0, 5);
    withLayout([block.querySelector<HTMLElement>(".md-codeblock-gutter")!, code], () => {
      const plan = widgetSelectionPlans(range, content, 21);
      // 行号槽整颗被排除；只有 code 这一颗宿主
      expect(plan.hosts.size).toBe(1);
      expect(plan.hosts.has(code)).toBe(true);
      expect(plan.blocks).toEqual([block]);
    });
  });

  it("整块都不可编辑（只读表格）时不排除，格子算正文", () => {
    const content = document.createElement("div");
    const { block, cells, first, last } = tableDom(content, false);
    const range = rangeBetween(first, last, 0, 4);
    withLayout(cells, () => {
      const plan = widgetSelectionPlans(range, content, 21);
      expect(plan.hosts.size).toBe(2);
      expect(plan.hosts.has(cells[0])).toBe(true);
      expect(plan.hosts.has(cells[1])).toBe(true);
      expect(plan.blocks).toEqual([block]);
    });
  });

  it("锁挂在块根上的渲染区（HTML / metadata 预览）算正文，不当装饰", () => {
    const content = document.createElement("div");
    // 真机：CM 给 widget 根挂 contenteditable=false；源码区自己重开编辑，
    // 渲染区则继承块根的 false —— 但那是正文（旧规则按最近 false 一律叠层）。
    const block = document.createElement("div");
    block.className = "md-html-widget";
    block.setAttribute("contenteditable", "false");
    const source = document.createElement("div");
    source.className = "md-block-source";
    source.style.display = "block";
    source.setAttribute("contenteditable", "plaintext-only");
    source.textContent = "<b>alpha</b>";
    const preview = document.createElement("div");
    preview.className = "md-html-preview";
    preview.style.display = "block";
    preview.textContent = "alpha";
    block.append(source, preview);
    content.append(block);
    const text = preview.firstChild as Text;
    const range = rangeBetween(text, text, 0, 5);
    withLayout([preview], () => {
      const plan = widgetSelectionPlans(range, content, 21);
      expect(plan.hosts.size).toBe(1);
      expect(plan.hosts.has(preview)).toBe(true);
      expect(plan.blocks).toEqual([block]);
    });
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

  it("焦点进块时先停编辑器选区，再判只读（否则整篇选区与块内选区叠加）", () => {
    const src = stripLineComments(readFileSync("src/preview/editableSource.ts", "utf-8"));
    const start = src.indexOf('wrap.addEventListener("focusin"');
    const end = src.indexOf('wrap.addEventListener("focusout"');
    const focusin = src.slice(start, end);
    const park = focusin.indexOf("parkSelectionAtBlock(view, wrap)");
    expect(park).toBeGreaterThan(-1);
    expect(park).toBeLessThan(focusin.indexOf("view.state.readOnly"));
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

  it("原生直角高亮只在覆盖层生效时藏，且按块根类命中（不止 .md-block）", () => {
    const block = ruleBlock(
      CSS,
      ".panel-host .cm-editor.lp-widget-selection .lp-native-sel-block ::selection",
    );
    // CM6 基础主题给聚焦的可编辑子元素写了 `background-color: highlight !important`，
    // 这条必须同样带 !important 才压得住（真机未加时选区仍是系统蓝，覆盖层被盖住）。
    expect(block).toMatch(/background-color:\s*transparent\s*!important/);
  });
});

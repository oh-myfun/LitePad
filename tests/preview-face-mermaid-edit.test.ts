// @vitest-environment jsdom
// B434 · mermaid 图就地编辑。
//
// 形状照 InkNote `src/editor/widgets/mermaid.ts`（本机参照 E:\Project\InkNote\InkNote）
// 与本仓代码块那一颗（B397-3）：平时显示画好的图，点一下在**原位**换成源码区，打字
// 回写 ```mermaid 围栏。两段式的显隐由 `.md-block--editing` 一个类驱动。
//
// ⚠️ 渲染那一发仍是 `enhanceMarkdown` 的唯一出口：widget 只负责把 `pre.mermaid-src`
// 占位交出去。这一片要判的是「组件怎么把占位交出去 / 怎么把源码收回」，所以把
// enhance 换成记录器 —— 真跑会去 import 3.5MB 的 mermaid，jsdom 里没有意义
// （与 tests/enhance-shared.test.ts 文件头同一条理由）。

import { readFileSync } from "node:fs";

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { describe, expect, it, vi } from "vitest";

import { ruleBlock, stripCssComments } from "./static";

vi.mock("../src/markdown/enhance", () => ({
  enhanceMarkdown: vi.fn(async () => {
    /* 真渲染在真机；这里只证明占位被交出去了 */
  }),
  nextEnhanceSeq: vi.fn(() => 1),
}));

import { enhanceMarkdown } from "../src/markdown/enhance";
import { attachDiagramViewport } from "../src/markdown/diagramViewport";
import { previewFace, previewLock } from "../src/preview/wysiwyg";

const enhance = vi.mocked(enhanceMarkdown);

const MERMAID_DOC = ["# 头", "```mermaid", "graph TD; A-->B", "```", "尾行"].join("\n");
const FENCE = "```mermaid\ngraph TD; A-->B\n```";

function mermaidView(doc = MERMAID_DOC, readonly = false): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        previewFace(),
        previewLock(readonly),
        EditorView.lineWrapping,
      ],
    }),
    parent: document.body,
  });
  // 光标停在块外的正文行（块级替换不看光标也会画，这里只为贴近真实落点）
  const last = view.state.doc.line(view.state.doc.lines);
  view.dispatch({ selection: { anchor: last.from } });
  return view;
}

const tick = (ms = 12) => new Promise((r) => setTimeout(r, ms));

/** 模拟「在可编辑区里打字」：改 DOM + 发 input（attachSourceEditing 监听的就是这条）。 */
function typeInto(el: HTMLElement, text: string): void {
  el.textContent = text;
  el.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

function fenceRange(view: EditorView): { from: number; to: number } {
  const text = view.state.doc.toString();
  const from = text.indexOf("```mermaid");
  const to = text.indexOf("```", from + 3) + 3;
  expect(from).toBeGreaterThan(-1);
  return { from, to };
}

describe("B434 mermaid 源码区：结构 + 两段式显隐", () => {
  it("块里自带可编辑源码区与渲染容器，源码通过 enhance 交出去", () => {
    enhance.mockClear();
    const view = mermaidView();
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".md-mermaid-widget");
      expect(wrap, "装饰档没画出 mermaid widget，这条判据就是空转").not.toBeNull();
      const source = wrap!.querySelector<HTMLElement>('.md-block-source[data-block-source="1"]');
      expect(source, "缺源码区 ⇒ 只能看图、改不了").not.toBeNull();
      expect(source!.textContent).toBe("graph TD; A-->B");
      const inner = wrap!.querySelector<HTMLElement>(".md-mermaid-inner");
      expect(
        inner,
        "渲染容器要独立成一层：编辑态源码框浮在它上面，图留在下面跟着重画",
      ).not.toBeNull();
      const pre = inner!.querySelector<HTMLElement>("pre.mermaid-src");
      expect(pre, "占位必须是 enhance 认领的那一形").not.toBeNull();
      expect(pre!.textContent).toBe("graph TD; A-->B");
      expect(wrap!.dataset.blockLen, "源码区间按整段围栏记账").toBe(String(FENCE.length));
      expect(enhance).toHaveBeenCalled();
      expect(enhance.mock.calls.some(([root]) => root === inner)).toBe(true);
    } finally {
      view.destroy();
    }
  });

  it("CSS：编辑态只浮出源码区，画好的图留在下面跟着活（B454 推翻旧的整层收起）", () => {
    const css = stripCssComments(readFileSync("src/preview/preview.css", "utf-8"));
    // B434 那一形：`.md-block--editing` 挂上后把 `.md-diagram-inner` 整层 `display:none`，
    // 同一位置只看得见源码。脑图的源码是一串 `- 项目`，图一藏等于盲改（用户：「脑图未支持编辑」）。
    expect(css, "编辑态还在藏画好的图 ⇒ 打字时看不见结果").not.toMatch(
      /\.md-block--editing[^{]*\{[^}]*display:\s*none/s,
    );
    // 源码区仍靠这颗类显形（删显隐规则时别把这一半一起删掉）
    expect(ruleBlock(css, ".md-preview-face .md-block--editing .md-block-source")).toMatch(
      /display:\s*block/,
    );
  });
});

/**
 * 真机那一形：enhance 画完会给出「卡片 + `.md-diagram-canvas`」并挂上 B455-5 的变换层。
 * 这个文件把 enhance 换成了记录器（不真画 mermaid），所以卡片自己搭、变换层自己挂。
 */
function drawCardInto(inner: HTMLElement): { card: HTMLElement; canvas: HTMLElement } {
  const card = document.createElement("div");
  card.className = "md-diagram md-diagram--mermaid";
  const canvas = document.createElement("div");
  canvas.className = "md-diagram-canvas";
  canvas.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  card.append(canvas);
  inner.append(card);
  attachDiagramViewport(card);
  return { card, canvas };
}

const press = (type: string, el: EventTarget, x: number, y: number): MouseEvent => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
  el.dispatchEvent(event);
  return event;
};

describe("B434 点图进编辑：打字回写围栏，DOM 不被换", () => {
  // B455-5 之后，「点图」这条路是两段：变换层判出「这是一次纯点击（没拖过阈值）」⇒ 发
  // `md-diagram-tap` ⇒ widget 接手浮源码框。旧的「mousedown 直接进编辑」不再成立：
  // 那样一来拖一张图就等于改一张图。
  it("点一下画好的图 ⇒ 进编辑态，焦点落在源码区", async () => {
    const view = mermaidView();
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".md-mermaid-widget")!;
      const source = wrap.querySelector<HTMLElement>('[data-block-source="1"]')!;
      const inner = wrap.querySelector<HTMLElement>(".md-mermaid-inner")!;
      const { canvas } = drawCardInto(inner);
      press("mousedown", canvas, 60, 40);
      expect(
        wrap.classList.contains("md-block--editing"),
        "手还没松就浮源码框 ⇒ 那是按下去准备拖，不是点一下",
      ).toBe(false);
      press("mouseup", document, 60, 40);
      expect(
        wrap.classList.contains("md-block--editing"),
        "松手当场就浮源码框 ⇒ 双击的第二发会落到被顶下去的图上（B456-2 要延后一拍）",
      ).toBe(false);
      await tick(250);
      expect(wrap.classList.contains("md-block--editing"), "点图没进编辑态").toBe(true);
      expect(document.activeElement).toBe(source);
    } finally {
      view.destroy();
    }
  });

  it("图自己把 mousedown 的冒泡掐了也得进编辑（脑图的 d3-zoom 正是这一形）", async () => {
    // B454 真机抓的：mermaid / Graphviz / Flowchart / PlantUML 点图都进得了编辑态，只有脑图点了
    // 没反应 —— markmap-view 给那颗 `<svg>` 装了 d3-zoom，它 mousedown 里的 `noevent()`
    // = `preventDefault()` + `stopImmediatePropagation()` ⇒ **冒泡档**监听器永远收不到。
    // 变换层在卡片的捕获相接手这一发，所以图里再怎么掐都还有「一次纯点击」这笔账。
    const view = mermaidView();
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".md-mermaid-widget")!;
      const inner = wrap.querySelector<HTMLElement>(".md-diagram-inner")!;
      const { canvas } = drawCardInto(inner);
      const svg = canvas.querySelector("svg")!;
      svg.addEventListener("mousedown", (event) => event.stopImmediatePropagation());
      press("mousedown", svg, 60, 40);
      press("mouseup", document, 60, 40);
      await tick(250);
      expect(wrap.classList.contains("md-block--editing"), "点图没进编辑态 ⇒ 脑图改不了").toBe(
        true,
      );
      expect(document.activeElement).toBe(wrap.querySelector<HTMLElement>(".md-block-source"));
    } finally {
      view.destroy();
    }
  });

  // B456-2 · 双击 = 视图操作（变换层复位视图）。源码框开在图的**上方** ⇒ 第一发点击当场开的话
  // 会把图往下顶，第二发就落到源码框里（还顺手选个词），双击根本轮不到复位。
  // 所以点图延后一拍开，延后期里来了 `md-diagram-reset` 就整发取消。
  it("双击图 ⇒ 整发改判成视图操作：源码框根本不浮出来", async () => {
    const view = mermaidView();
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".md-mermaid-widget")!;
      const inner = wrap.querySelector<HTMLElement>(".md-diagram-inner")!;
      const { card, canvas } = drawCardInto(inner);
      press("mousedown", canvas, 60, 40);
      press("mouseup", document, 60, 40);
      press("mousedown", canvas, 60, 40);
      press("mouseup", document, 60, 40);
      card.dispatchEvent(
        new MouseEvent("dblclick", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 60,
          clientY: 40,
        }),
      );
      await tick(300);
      expect(
        wrap.classList.contains("md-block--editing"),
        "双击被当成「点图改图」⇒ 想复位视图却掉进编辑态",
      ).toBe(false);
    } finally {
      view.destroy();
    }
  });

  it("拖过阈值 = 搬图，不是改图（不进编辑态）", async () => {
    // 用户拍板：「拖过阈值算平移，纯点击仍进编辑」。
    const view = mermaidView();
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".md-mermaid-widget")!;
      const inner = wrap.querySelector<HTMLElement>(".md-diagram-inner")!;
      const { card, canvas } = drawCardInto(inner);
      press("mousedown", canvas, 60, 40);
      press("mousemove", card, 120, 40);
      press("mouseup", document, 120, 40);
      expect(canvas.style.transform, "拖的那 60px 要真搬过去").toContain("translate(60px, 0px)");
      await tick(250); // B456-2：源码框延后一拍才开 ⇒ 当场判「没开」没有鉴别力
      expect(
        wrap.classList.contains("md-block--editing"),
        "拖一下就把源码框浮出来 = 拖不动图",
      ).toBe(false);
    } finally {
      view.destroy();
    }
  });

  it("点右上角那三颗键不进编辑态（键是 canvas 的兄弟，不是图）", async () => {
    // B455-7 真机抓的：兜底那颗 mousedown 只放行 `.md-diagram-canvas`，而按键条挂在**卡片**上、
    // 在 canvas 外面 ⇒ 一按放大就浮源码框，用户看到的是「放大键按不动」。
    const view = mermaidView();
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".md-mermaid-widget")!;
      const inner = wrap.querySelector<HTMLElement>(".md-mermaid-inner")!;
      const { card, canvas } = drawCardInto(inner);
      const zoomIn = card.querySelector<HTMLElement>(".md-diagram-zoom-in")!;
      press("mousedown", zoomIn, 200, 20);
      press("mouseup", document, 200, 20);
      zoomIn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      expect(canvas.style.transform, "按键要真缩放这一格").toContain("scale(1.3)");
      await tick(250); // 同上：过了延后那一拍仍然不许开源码框
      expect(wrap.classList.contains("md-block--editing"), "按放大键不该进编辑态").toBe(false);
    } finally {
      view.destroy();
    }
  });

  it("在源码区打字 ⇒ 文档里的 ```mermaid 围栏跟着变（rAF 后才落）", async () => {
    const view = mermaidView();
    try {
      const source = view.dom.querySelector<HTMLElement>('[data-block-source="1"]')!;
      source.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      typeInto(source, "graph LR; X-->Y");
      await tick();
      const doc = view.state.doc.toString();
      expect(doc).toContain("```mermaid\ngraph LR; X-->Y\n```");
      expect(doc).not.toContain("A-->B");
    } finally {
      view.destroy();
    }
  });

  it("回写触发装饰重建之后，正在打字的源码区还是同一颗（漏 updateDOM 就红）", () => {
    const view = mermaidView();
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".md-mermaid-widget")!;
      const source = wrap.querySelector<HTMLElement>('[data-block-source="1"]')!;
      const r = fenceRange(view);
      const next = "```mermaid\ngraph TD; C-->D\n```";
      view.dispatch({ changes: { from: r.from, to: r.to, insert: next } });
      expect(view.dom.contains(source), "源码区被整块重建了 ⇒ 光标必然被打掉").toBe(true);
      expect(wrap.dataset.blockLen).toBe(String(next.length));
      expect(source.textContent).toBe("graph TD; C-->D");
    } finally {
      view.destroy();
    }
  });

  it("退出编辑 ⇒ 摘掉编辑类，并把最新源码重新交给 enhance 画一遍", async () => {
    const view = mermaidView();
    try {
      enhance.mockClear();
      const wrap = view.dom.querySelector<HTMLElement>(".md-mermaid-widget")!;
      const source = wrap.querySelector<HTMLElement>('[data-block-source="1"]')!;
      const inner = wrap.querySelector<HTMLElement>(".md-mermaid-inner")!;
      source.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      typeInto(source, "graph LR; X-->Y");
      await tick();
      source.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await tick(30);
      expect(wrap.classList.contains("md-block--editing")).toBe(false);
      const pre = inner.querySelector<HTMLElement>("pre.mermaid-src");
      expect(pre, "退出编辑要把最新源码再交给 enhance").not.toBeNull();
      expect(pre!.textContent).toBe("graph LR; X-->Y");
      expect(enhance.mock.calls.some(([root]) => root === inner)).toBe(true);
    } finally {
      view.destroy();
    }
  });

  it("没在打字时源码被外部改动 ⇒ 源码区与占位都刷成新内容", () => {
    const view = mermaidView();
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".md-mermaid-widget")!;
      const source = wrap.querySelector<HTMLElement>('[data-block-source="1"]')!;
      const inner = wrap.querySelector<HTMLElement>(".md-mermaid-inner")!;
      const r = fenceRange(view);
      view.dispatch({
        changes: { from: r.from, to: r.to, insert: "```mermaid\ngraph TD; C-->D\n```" },
      });
      expect(source.textContent).toBe("graph TD; C-->D");
      expect(inner.querySelector<HTMLElement>("pre.mermaid-src")!.textContent).toBe(
        "graph TD; C-->D",
      );
    } finally {
      view.destroy();
    }
  });

  it("只读档：点不进去、打字不进文档", () => {
    const view = mermaidView(MERMAID_DOC, true);
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".md-mermaid-widget")!;
      const source = wrap.querySelector<HTMLElement>('[data-block-source="1"]')!;
      const inner = wrap.querySelector<HTMLElement>(".md-mermaid-inner")!;
      const before = view.state.doc.toString();
      const { canvas } = drawCardInto(inner);
      press("mousedown", canvas, 60, 40);
      press("mouseup", document, 60, 40);
      expect(wrap.classList.contains("md-block--editing"), "只读还进编辑态就是假可编辑").toBe(
        false,
      );
      source.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      expect(wrap.classList.contains("md-block--editing")).toBe(false);
      typeInto(source, "graph LR; X-->Y");
      expect(view.state.doc.toString()).toBe(before);
    } finally {
      view.destroy();
    }
  });
});

// @vitest-environment jsdom
// B462 · 代码 / 公式 / 图块右上角的复制键与块内光标。
//
// 三种块的 DOM 结构各不相同（代码块有工具行，公式/图块只有视觉盒），但复制键必须是
// **同一颗**：同一个 `md-block-copy` 类、同一颗 codicon、同一个「复制源码」口径。
// 这一片锁定三件事：
//   1. 三种块里都存在同一颗图标键，且不再写「复制」两个字；
//   2. 点击复制的是块内源码（不是渲染结果），反馈只换字形；
//   3. 块根与滚动容器不是文本输入面（用户点名：代码块滚动条上不该是 I-beam）。

import { readFileSync } from "node:fs";

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ruleBlock, stripCssComments } from "./static";

vi.mock("../src/markdown/enhance", () => ({
  enhanceMarkdown: vi.fn(async () => {
    /* KaTeX / mermaid 真渲染在真机；这里只判 widget 结构 */
  }),
  nextEnhanceSeq: vi.fn(() => 1),
}));

import { previewFace } from "../src/preview/wysiwyg";

const CSS = stripCssComments(readFileSync("src/preview/preview.css", "utf-8"));

const CODE_DOC = ["# 头", "```ts", "export const a = 1;", "```", "尾行"].join("\n");
const MATH_DOC = ["# 头", "", "$$", "x^2 + y^2", "$$", "", "尾行"].join("\n");
const MERMAID_DOC = ["# 头", "```mermaid", "graph TD; A-->B", "```", "尾行"].join("\n");

function faceView(doc: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), previewFace(), EditorView.lineWrapping],
    }),
    parent: document.body,
  });
  const last = view.state.doc.line(view.state.doc.lines);
  view.dispatch({ selection: { anchor: last.from } });
  return view;
}

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function copyButtonOf(view: EditorView, rootSelector: string): HTMLButtonElement {
  const root = view.dom.querySelector<HTMLElement>(rootSelector);
  expect(root, `没画出 ${rootSelector}，这条判据就是空转`).not.toBeNull();
  const btn = root!.querySelector<HTMLButtonElement>("button.md-block-copy");
  expect(btn, `${rootSelector} 右上角没找到统一的复制键`).not.toBeNull();
  return btn!;
}

describe("B462 三种块共用同一颗复制键", () => {
  it("代码块 / 公式块 / 图块都有 button.md-block-copy，且只画图标不写字", () => {
    const views = [faceView(CODE_DOC), faceView(MATH_DOC), faceView(MERMAID_DOC)];
    try {
      const selectors = [".md-codeblock-widget", ".md-math-block", ".md-diagram-widget"];
      views.forEach((view, i) => {
        const btn = copyButtonOf(view, selectors[i]);
        expect(btn.type).toBe("button");
        expect(btn.querySelector(".codicon-copy"), "图标取 codicon copy").not.toBeNull();
        expect(btn.textContent, "图标按钮不再写「复制」两个字").toBe("");
        expect(btn.getAttribute("aria-label")).toBe("复制");
        expect(btn.dataset.tip).toBe("复制");
      });
    } finally {
      views.forEach((v) => v.destroy());
    }
  });

  it("点击复制块内源码：代码正文 / LaTeX / 图源码", async () => {
    const cases: { doc: string; selector: string; expected: string }[] = [
      { doc: CODE_DOC, selector: ".md-codeblock-widget", expected: "export const a = 1;" },
      { doc: MATH_DOC, selector: ".md-math-block", expected: "x^2 + y^2" },
      { doc: MERMAID_DOC, selector: ".md-diagram-widget", expected: "graph TD; A-->B" },
    ];
    for (const c of cases) {
      writeText.mockClear();
      const view = faceView(c.doc);
      try {
        const btn = copyButtonOf(view, c.selector);
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(writeText).toHaveBeenCalledWith(c.expected);
        expect(btn.querySelector(".codicon-check"), "复制成功要换勾字形").not.toBeNull();
        expect(btn.dataset.tip).toBe("已复制");
        expect(btn.getAttribute("aria-label")).toBe("已复制");
      } finally {
        view.destroy();
      }
    }
  });

  it("反馈 1.2s 后回到 copy / 复制", () => {
    const view = faceView(CODE_DOC);
    try {
      const btn = copyButtonOf(view, ".md-codeblock-widget");
      vi.useFakeTimers();
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(btn.querySelector(".codicon-check")).not.toBeNull();
      vi.advanceTimersByTime(1200);
      expect(btn.querySelector(".codicon-copy"), "反馈结束后要回到 copy").not.toBeNull();
      expect(btn.dataset.tip).toBe("复制");
    } finally {
      view.destroy();
    }
  });

  it("按下复制键不把焦点从正在编辑的源码区带走", () => {
    const view = faceView(MATH_DOC);
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".md-math-block")!;
      const source = wrap.querySelector<HTMLElement>('[data-block-source="1"]')!;
      source.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      expect(wrap.classList.contains("md-block--editing")).toBe(true);
      const btn = copyButtonOf(view, ".md-math-block");
      const bubbled = vi.fn();
      wrap.addEventListener("mousedown", bubbled);
      const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
      btn.dispatchEvent(down);
      expect(down.defaultPrevented, "mousedown 必须 preventDefault").toBe(true);
      expect(bubbled, "不许冒泡到块的 mousedown 逻辑").not.toHaveBeenCalled();
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(wrap.classList.contains("md-block--editing"), "复制不该把编辑态关掉").toBe(true);
    } finally {
      view.destroy();
    }
  });
});

describe("B462 样式：统一外观、右上角定位与块内光标", () => {
  it("复制键统一在 .md-block-copy 上：20×20 图标键，悬停 / 编辑时显现", () => {
    const block = ruleBlock(CSS, ".md-preview-face .md-block-copy");
    expect(block).toMatch(/width:\s*20px/);
    expect(block).toMatch(/height:\s*20px/);
    expect(block).toMatch(/opacity:\s*0/);
    expect(CSS).toMatch(/\.md-codeblock-widget:hover \.md-block-copy/);
    expect(CSS).toMatch(/\.md-math-block:hover \.md-block-copy/);
    expect(CSS).toMatch(/\.md-diagram-widget:hover \.md-block-copy/);
    // 旧的文字键样式必须清干净（否则「复制」两个字会以另一种方式回来）
    expect(CSS).not.toMatch(/\.md-codeblock-copy\s*\{/);
  });

  it("公式 / 图块钉在视觉盒右上角，图的三颗缩放键让出一格", () => {
    expect(ruleBlock(CSS, ".md-preview-face .md-math-block > .md-block-copy")).toMatch(
      /position:\s*absolute/,
    );
    expect(ruleBlock(CSS, ".md-preview-face .md-diagram-box > .md-block-copy")).toMatch(
      /position:\s*absolute/,
    );
    expect(ruleBlock(CSS, ".md-preview-face .md-diagram-zoom")).toMatch(/right:\s*33px/);
    // 源码框浮上来时收掉悬浮键，避免压住第一行
    expect(CSS).toMatch(/\.md-math-block\.md-block--editing > \.md-block-copy/);
    expect(CSS).toMatch(/\.md-diagram-widget\.md-block--editing \.md-block-copy/);
  });

  it("光标：块容器与滚动条 default，真正的文本面才是 text", () => {
    expect(
      ruleBlock(CSS, ".md-preview-face .md-codeblock-widget"),
      "代码块根不是输入面（滚动条上不能是 I-beam）",
    ).toMatch(/cursor:\s*default/);
    expect(
      ruleBlock(CSS, ".md-preview-face .md-codeblock-widget pre"),
      "横向滚动条挂在 pre 上",
    ).toMatch(/cursor:\s*default/);
    expect(ruleBlock(CSS, ".md-preview-face .md-codeblock-widget code")).toMatch(/cursor:\s*text/);
    expect(ruleBlock(CSS, ".md-preview-face .md-math-widget.md-math-block")).toMatch(
      /cursor:\s*default/,
    );
    expect(ruleBlock(CSS, ".md-preview-face .md-math-block .md-math-render")).toMatch(
      /cursor:\s*text/,
    );
    expect(ruleBlock(CSS, ".md-preview-face .md-diagram-widget")).toMatch(/cursor:\s*default/);
    expect(ruleBlock(CSS, ".md-preview-face .md-table-body")).toMatch(/cursor:\s*default/);
    expect(ruleBlock(CSS, ".md-preview-face .md-block-source")).toMatch(/cursor:\s*text/);
  });
});

describe("B462 行内公式仍按文本处理", () => {
  it("行内公式整颗是文本面，复制键不跟进去", () => {
    const view = faceView("行内 $a+b$ 文本\n");
    try {
      const inline = view.dom.querySelector<HTMLElement>(".md-math-widget");
      expect(inline).not.toBeNull();
      expect(inline!.querySelector(".md-block-copy"), "行内公式没有块级复制键").toBeNull();
    } finally {
      view.destroy();
    }
  });
});

// @vitest-environment jsdom
// B435 · 公式的就地编辑（同类遗漏审计后补上的那一格）。
//
// 两档形状不同，照 InkNote `src/editor/widgets/math.ts`（本机参照 E:\Project\InkNote\InkNote）：
//   · 块级 `$$…$$`：两段式 —— 平时看公式，点公式在原位换 LaTeX 源码区，源码区下方
//     继续显示实时渲染（InkNote 的「右侧实时预览」同一条语义）。
//   · 行内 `$…$`：不另做源码区，点公式把光标送进源码区间，装饰按 `revealFrom/revealTo`
//     撤掉 ⇒ 直接露出 `$…$` 原文（与脚注引用同一条机械）。
//
// 渲染仍归 `enhanceMarkdown`（KaTeX 懒加载），这里换成记录器，理由同
// tests/preview-face-mermaid-edit.test.ts。

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/markdown/enhance", () => ({
  enhanceMarkdown: vi.fn(async () => {
    /* KaTeX 在真机画；这一片只判占位与回写 */
  }),
  nextEnhanceSeq: vi.fn(() => 1),
}));

import { enhanceMarkdown } from "../src/markdown/enhance";
import { previewFace, previewLock } from "../src/preview/wysiwyg";

const enhance = vi.mocked(enhanceMarkdown);

const BLOCK_DOC = ["# 头", "", "$$", "x^2 + y^2", "$$", "", "尾行"].join("\n");
const INLINE_DOC = "行内 $a+b$ 文本\n";

function mathView(doc: string, readonly = false): EditorView {
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
  const last = view.state.doc.line(view.state.doc.lines);
  view.dispatch({ selection: { anchor: last.to } });
  return view;
}

const tick = (ms = 12) => new Promise((r) => setTimeout(r, ms));

function typeInto(el: HTMLElement, text: string): void {
  el.textContent = text;
  el.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

function blockRange(view: EditorView): { from: number; to: number } {
  const text = view.state.doc.toString();
  const from = text.indexOf("$$");
  const to = text.indexOf("$$", from + 2) + 2;
  expect(from).toBeGreaterThan(-1);
  return { from, to };
}

describe("B435 块级公式：点公式改 LaTeX，回写 $$ 围栏", () => {
  it("块里自带源码区与渲染容器，LaTeX 通过 enhance 交出去", () => {
    enhance.mockClear();
    const view = mathView(BLOCK_DOC);
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".md-math-widget.md-math-block");
      expect(wrap, "装饰档没画出块级公式，这条判据就是空转").not.toBeNull();
      const source = wrap!.querySelector<HTMLElement>('.md-block-source[data-block-source="1"]');
      expect(source, "缺源码区 ⇒ 只能看公式、改不了").not.toBeNull();
      expect(source!.textContent).toBe("x^2 + y^2");
      const render = wrap!.querySelector<HTMLElement>(".md-math-render");
      expect(render, "渲染容器要独立成一层，退出编辑好整层重画").not.toBeNull();
      expect(render!.querySelector(".math-display-src")?.textContent).toBe("x^2 + y^2");
      expect(enhance.mock.calls.some(([root]) => root === render)).toBe(true);
    } finally {
      view.destroy();
    }
  });

  it("点公式 ⇒ 进编辑态，焦点落在源码区", () => {
    const view = mathView(BLOCK_DOC);
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".md-math-block")!;
      const source = wrap.querySelector<HTMLElement>('[data-block-source="1"]')!;
      const render = wrap.querySelector<HTMLElement>(".md-math-render")!;
      render.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }),
      );
      expect(wrap.classList.contains("md-block--editing")).toBe(true);
      expect(document.activeElement).toBe(source);
    } finally {
      view.destroy();
    }
  });

  it("在源码区打字 ⇒ 文档里的 $$ 围栏跟着变（rAF 后才落）", async () => {
    const view = mathView(BLOCK_DOC);
    try {
      const source = view.dom.querySelector<HTMLElement>('[data-block-source="1"]')!;
      source.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      typeInto(source, "E = mc^2");
      await tick();
      const doc = view.state.doc.toString();
      expect(doc).toContain("$$\nE = mc^2\n$$");
      expect(doc).not.toContain("x^2 + y^2");
    } finally {
      view.destroy();
    }
  });

  it("回写触发装饰重建之后，正在打字的源码区还是同一颗（漏 updateDOM 就红）", () => {
    const view = mathView(BLOCK_DOC);
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".md-math-block")!;
      const source = wrap.querySelector<HTMLElement>('[data-block-source="1"]')!;
      const r = blockRange(view);
      const next = "$$\nE = mc^2\n$$";
      view.dispatch({ changes: { from: r.from, to: r.to, insert: next } });
      expect(view.dom.contains(source), "源码区被整块重建了 ⇒ 光标必然被打掉").toBe(true);
      expect(wrap.dataset.blockLen).toBe(String(next.length));
      expect(source.textContent).toBe("E = mc^2");
    } finally {
      view.destroy();
    }
  });

  it("退出编辑 ⇒ 摘掉编辑类，并把最新 LaTeX 重新交给 enhance 画一遍", async () => {
    const view = mathView(BLOCK_DOC);
    try {
      enhance.mockClear();
      const wrap = view.dom.querySelector<HTMLElement>(".md-math-block")!;
      const source = wrap.querySelector<HTMLElement>('[data-block-source="1"]')!;
      const render = wrap.querySelector<HTMLElement>(".md-math-render")!;
      source.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      typeInto(source, "E = mc^2");
      await tick();
      source.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await tick(30);
      expect(wrap.classList.contains("md-block--editing")).toBe(false);
      const ph = render.querySelector<HTMLElement>(".math-display-src");
      expect(ph, "退出编辑要把最新 LaTeX 再交给 enhance").not.toBeNull();
      expect(ph!.textContent).toBe("E = mc^2");
      expect(enhance.mock.calls.some(([root]) => root === render)).toBe(true);
    } finally {
      view.destroy();
    }
  });

  it("只读档：点不进去、打字不进文档", () => {
    const view = mathView(BLOCK_DOC, true);
    try {
      const wrap = view.dom.querySelector<HTMLElement>(".md-math-block")!;
      const source = wrap.querySelector<HTMLElement>('[data-block-source="1"]')!;
      const render = wrap.querySelector<HTMLElement>(".md-math-render")!;
      const before = view.state.doc.toString();
      render.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }),
      );
      expect(wrap.classList.contains("md-block--editing"), "只读还进编辑态就是假可编辑").toBe(
        false,
      );
      source.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      expect(wrap.classList.contains("md-block--editing")).toBe(false);
      typeInto(source, "E = mc^2");
      expect(view.state.doc.toString()).toBe(before);
    } finally {
      view.destroy();
    }
  });
});

describe("B435 行内公式：点一下把光标送进源码区间，露出 $…$ 原文", () => {
  it("光标不在公式里 ⇒ 源码藏着（只剩渲染结果）", () => {
    const view = mathView(INLINE_DOC);
    try {
      expect(view.dom.querySelector(".md-math-widget")).not.toBeNull();
      expect(view.dom.querySelector(".cm-line")!.textContent).not.toContain("$a+b$");
    } finally {
      view.destroy();
    }
  });

  it("点公式 ⇒ 光标落进区间，替换装饰撤掉、原文显形", () => {
    const view = mathView(INLINE_DOC);
    try {
      const span = view.dom.querySelector<HTMLElement>(".md-math-widget")!;
      span.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }),
      );
      const head = view.state.selection.main.head;
      expect(head >= 3 && head <= 8, "光标必须落在 $a+b$ 的源码区间里").toBe(true);
      expect(view.dom.querySelector(".cm-line")!.textContent).toContain("$a+b$");
    } finally {
      view.destroy();
    }
  });

  it("只读档：点击不落位、原文始终藏着", () => {
    const view = mathView(INLINE_DOC, true);
    try {
      const before = view.state.selection.main.head;
      const span = view.dom.querySelector<HTMLElement>(".md-math-widget")!;
      span.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }),
      );
      expect(view.state.selection.main.head).toBe(before);
      expect(view.dom.querySelector(".cm-line")!.textContent).not.toContain("$a+b$");
    } finally {
      view.destroy();
    }
  });
});

// @vitest-environment jsdom
// B459 · 行首「标记槽」的占位件与负 text-indent。
//
// 判据按「用户会看到什么」写：
//   · 编辑档选中一行折起来的任务项，蓝色色带要从**方框那颗的左沿**起，行首不许少一段；
//   · 同一次选区里的正文段落，开头一截字不许被色带吃掉。
// 这两条其实是同一件事：CM6 铺色带时只读「渲染出来的第一颗 .cm-line」的
// `paddingLeft + min(0, textIndent)`（view/dist/index.js:9328-9330），把它套给选区里所有行。
// 装饰面把左右留白画在每颗行上、列表/引用行还多一个标记槽 ⇒ 第一颗行是列表行时整屏色带的
// 左沿都跑到正文左沿右边一档。
//
// 所以契约是「**每一颗带槽的行，paddingLeft 与 textIndent 相加恒等于正文左沿**」，
// 而首行正文原本的位置由一颗占位件补回来（宽度 = 槽宽、画不出墨、高度 0 不顶行盒）。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { previewFace, previewLock } from "../src/preview/wysiwyg";
import { ruleBlock } from "./static";

const css = () => readFileSync("src/preview/preview.css", "utf-8");

function mount(doc: string, readonly = false): EditorView {
  const exts: Extension[] = [markdown({ base: markdownLanguage }), previewFace()];
  if (readonly) exts.push(previewLock(true));
  const state = EditorState.create({ doc, extensions: exts });
  return new EditorView({ state, parent: document.createElement("div") });
}

const contentText = (view: EditorView): string =>
  view.dom.querySelector(".cm-content")!.textContent ?? "";
const lineOf = (view: EditorView, cls: string): HTMLElement =>
  view.dom.querySelector<HTMLElement>(`.cm-line.${cls}`)!;

describe("B459 · 色带左沿的不变量（CSS 侧）", () => {
  it("带槽的行：padding 与 text-indent 都从同一颗 --md-lead 派生", () => {
    const src = css();
    // 三个数（padding-left / text-indent / 占位件宽）只要有一处各写各的，色带左沿就会跟正文错位。
    const lead =
      /\.md-preview-face \.cm-line[^{]*\{[^}]*padding-left:\s*calc\(\s*var\(--editor-padding-x\)\s*\+\s*var\(--md-lead\)\s*\)/;
    const indent =
      /\.md-preview-face \.cm-line[^{]*\{[^}]*text-indent:\s*calc\(-1\s*\*\s*var\(--md-lead\)\)/;
    expect(src, "列表/任务/引用行的 padding-left 要写成 `--editor-padding-x + --md-lead`").toMatch(
      lead,
    );
    expect(src, "同一批规则要同时写 `text-indent: calc(-1 * var(--md-lead))`").toMatch(indent);
  });

  it("--md-lead 分档：正文 0、列表=标记槽、任务=方框槽、引用=竖线+缩进", () => {
    const src = css();
    expect(ruleBlock(src, ".md-preview-face .cm-line", "--md-lead")).toContain("--md-lead: 0px");
    expect(ruleBlock(src, ".md-preview-face .cm-line.md-list-item", "--md-lead")).toMatch(
      /--md-lead:\s*var\(--md-list-marker-width,\s*var\(--editor-list-marker-offset\)\)/,
    );
    expect(ruleBlock(src, ".md-preview-face .cm-line.md-task-item", "--md-lead")).toMatch(
      /--md-lead:\s*var\(--editor-list-marker-offset\)/,
    );
    expect(ruleBlock(src, ".md-preview-face .cm-line.md-blockquote", "--md-lead")).toMatch(
      /--md-lead:\s*var\(--md-quote-lead\)/,
    );
    expect(ruleBlock(src, ".md-preview-face .cm-line.md-blockquote", "--md-quote-lead")).toMatch(
      /--md-quote-lead:\s*calc\(\s*var\(--editor-quote-bar\)\s*\+\s*var\(--editor-block-indent\)\s*\)/,
    );
  });

  it("占位件只占宽、不顶行盒", () => {
    const slot = ruleBlock(css(), ".md-preview-face .md-mark-slot");
    expect(slot).toContain("width: var(--md-lead)");
    expect(slot, "高度给 0：行盒高了半档，同步滚动的逐行对齐就跟着偏").toContain("height: 0");
    expect(slot).toContain("display: inline-block");
  });

  it("显形档：标记显形的同一行把 text-indent 归 0（行首就是源码本身）", () => {
    const src = css();
    const reveal = ruleBlock(src, ".md-preview-face .cm-line.md-list-item.md-reveal-marker");
    expect(reveal, "padding 收档那条注释还在，收的正是「槽」这一段").toMatch(/padding-left/);
    expect(reveal).toMatch(/text-indent:\s*0\s*!important/);
    expect(ruleBlock(src, ".md-preview-face .cm-line.md-blockquote.md-reveal-marker")).toMatch(
      /text-indent:\s*0/,
    );
  });
});

describe("B459 · 槽位件（装饰侧）", () => {
  it("折叠的任务行：行首有一颗占位件，源码仍然看不见", () => {
    const view = mount("- [ ] 未勾\n\n正文\n");
    try {
      view.dispatch({ selection: { anchor: view.state.doc.line(3).from } });
      const line = lineOf(view, "md-task-item");
      expect(
        line.querySelector(".md-mark-slot"),
        "标记折着时也要有东西把首行正文顶回原位",
      ).toBeTruthy();
      expect(contentText(view), "占位件不许把源码带进 DOM").not.toContain("[ ]");
    } finally {
      view.destroy();
    }
  });

  it("光标压住那一行：占位件让位给源码；离开再回来", () => {
    const view = mount("- [ ] 未勾\n\n正文\n");
    try {
      view.dispatch({ selection: { anchor: 0 } });
      expect(contentText(view)).toContain("- [ ]");
      expect(
        lineOf(view, "md-task-item").querySelector(".md-mark-slot"),
        "显形档不该再垫一颗",
      ).toBeNull();

      view.dispatch({ selection: { anchor: view.state.doc.line(3).from } });
      expect(contentText(view)).not.toContain("- [ ]");
      expect(lineOf(view, "md-task-item").querySelector(".md-mark-slot")).toBeTruthy();
    } finally {
      view.destroy();
    }
  });

  it("引用行同理：`>` 折起来时行首有占位件", () => {
    const view = mount("> 引用\n\n正文\n");
    try {
      view.dispatch({ selection: { anchor: view.state.doc.line(3).from } });
      expect(contentText(view)).not.toContain(">");
      expect(lineOf(view, "md-blockquote").querySelector(".md-mark-slot")).toBeTruthy();
    } finally {
      view.destroy();
    }
  });

  it("嵌套项：占位件从**行首**起，作者多打的缩进一起吃掉", () => {
    const view = mount("- 顶层\n  - [ ] 嵌套项\n\n正文\n");
    try {
      view.dispatch({ selection: { anchor: view.state.doc.line(4).from } });
      const line = lineOf(view, "md-task-item");
      // CM6 在行首垫一颗 `cm-widgetBuffer`（widget 的挂靠点），它不算内容。
      const kids = [...line.childNodes].filter(
        (n) => !(n instanceof Element && n.classList.contains("cm-widgetBuffer")),
      );
      expect(
        (kids[0] as HTMLElement | undefined)?.className,
        "行首第一个内容节点就得是占位件（缩进 + 标记 + 空格一起收进槽里）",
      ).toContain("md-mark-slot");
      expect(contentText(view)).not.toContain("[ ]");
      // 槽宽写在行内 style 上（嵌套档比顶层多 24px），CSS 里那三条 calc 才能跟着走。
      expect(
        line.getAttribute("style") ?? "",
        "行内要给 --md-lead，不能再各写一份 padding-left",
      ).toMatch(/--md-lead: calc\(.*\+ 24px\)/);
      expect(line.getAttribute("style") ?? "", "行内不许再各写一份 padding-left").not.toMatch(
        /padding-left/,
      );
    } finally {
      view.destroy();
    }
  });

  it("只读档（预览）：标记照旧折着，占位件照旧垫着", () => {
    const view = mount("- [ ] 未勾\n", true);
    try {
      expect(contentText(view)).not.toContain("[ ]");
      expect(lineOf(view, "md-task-item").querySelector(".md-mark-slot")).toBeTruthy();
    } finally {
      view.destroy();
    }
  });
});

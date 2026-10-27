// @vitest-environment jsdom
// B397-4d · 编辑模式的格式动作（照 InkNote src/editor/commands/format.ts 的纯文本那半）。
//
// 为什么挂在 Markdown 语言档里而不是 deco 档里：InkNote 的 `editorActionKeymap()` 是
// 全局装一次（editor.ts:1404），源码档也生效 —— 它只编辑 Markdown。LitePad 的标签可能
// 是 .json/.py，`Ctrl+B` 往 JSON 里塞 `****` 是破坏，所以这批键位跟着「这份文档是
// Markdown」走：语言 Compartment 换档时一并装卸。
import { describe, it, expect } from "vitest";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import {
  insertTableAtCursor,
  markdownFormatExtensions,
  runFormat,
  setHeading,
  toggleLinePrefix,
  wrapInline,
} from "../src/spike/deco/format";

function makeView(doc: string, selection?: { anchor: number; head?: number }) {
  const state = EditorState.create({
    doc,
    selection,
    extensions: [markdown({ base: markdownLanguage }), markdownFormatExtensions()],
  });
  const view = new EditorView({ state, parent: document.body });
  return view;
}

function press(view: EditorView, init: KeyboardEventInit) {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  view.contentDOM.dispatchEvent(ev);
  return ev;
}

describe("行内包裹（wrapInline）", () => {
  it("选中一段 → 两侧补标记，选区仍罩着原文（不是标记）", () => {
    const view = makeView("hello world", { anchor: 6, head: 11 });
    wrapInline(view, "**", "**");
    expect(view.state.doc.toString()).toBe("hello **world**");
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "world",
    );
    view.destroy();
  });

  it("选区自身带着标记 → 摘掉标记（**词** → 词）", () => {
    const view = makeView("a **b** c", { anchor: 2, head: 7 });
    wrapInline(view, "**", "**");
    expect(view.state.doc.toString()).toBe("a b c");
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "b",
    );
    view.destroy();
  });

  it("标记在选区外侧 → 也认得出（选中词，标记恰好在两侧）", () => {
    const view = makeView("a **b** c", { anchor: 4, head: 5 });
    wrapInline(view, "**", "**");
    expect(view.state.doc.toString()).toBe("a b c");
    view.destroy();
  });

  it("光标态（无选区）→ 插一对空标记，光标落在中间", () => {
    const view = makeView("ab", { anchor: 1 });
    wrapInline(view, "`", "`");
    expect(view.state.doc.toString()).toBe("a``b");
    expect(view.state.selection.main.head).toBe(2);
    view.destroy();
  });
});

describe("标题（setHeading）", () => {
  it("多行选区一起改，且保留缩进、剥掉原有前缀", () => {
    const view = makeView("## A\n- B\n    > C", { anchor: 0, head: 13 });
    setHeading(view, 3);
    expect(view.state.doc.toString()).toBe("### A\n### B\n    ### C");
    view.destroy();
  });

  it("同级再按一次 → 退回正文", () => {
    const view = makeView("### A", { anchor: 3 });
    setHeading(view, 3);
    expect(view.state.doc.toString()).toBe("A");
    view.destroy();
  });

  it("0 级 = 正文（剥掉标记）", () => {
    const view = makeView("# A\n## B", { anchor: 0, head: 8 });
    setHeading(view, 0);
    expect(view.state.doc.toString()).toBe("A\nB");
    view.destroy();
  });
});

describe("列表 / 引用前缀（toggleLinePrefix）", () => {
  it("有序列表按顺序编号，且从 1 重排", () => {
    const view = makeView("a\nb\nc", { anchor: 0, head: 5 });
    toggleLinePrefix(view, "1. ", /^\d+[.)]\s+/, true);
    expect(view.state.doc.toString()).toBe("1. a\n2. b\n3. c");
    view.destroy();
  });

  it("全是同款前缀 → 整段摘掉", () => {
    const view = makeView("- a\n- b", { anchor: 0, head: 7 });
    toggleLinePrefix(view, "- ", /^[-*+]\s+/);
    expect(view.state.doc.toString()).toBe("a\nb");
    view.destroy();
  });

  it("缩进保留（嵌套列表不被拉平到顶层）", () => {
    const view = makeView("    a", { anchor: 5 });
    toggleLinePrefix(view, "> ", /^>\s?/);
    expect(view.state.doc.toString()).toBe("    > a");
    view.destroy();
  });

  it("空行 → 直接落到行首写前缀", () => {
    const view = makeView("", { anchor: 0 });
    runFormat(view, "taskList");
    expect(view.state.doc.toString()).toBe("- [ ] ");
    view.destroy();
  });
});

describe("整块插入（runFormat / 表格）", () => {
  it("在行尾追加块，与正文之间空一行，光标按偏移落进围栏内", () => {
    const view = makeView("para", { anchor: 2 });
    runFormat(view, "codeBlock");
    expect(view.state.doc.toString()).toBe("para\n\n```\n\n```");
    expect(view.state.selection.main.head).toBe("para\n\n```\n".length);
    view.destroy();
  });

  it("表格：两行两列 + 分隔行，光标停在表后", () => {
    const view = makeView("x", { anchor: 1 });
    insertTableAtCursor(view, 2, 2);
    expect(view.state.doc.toString()).toBe("x\n\n|  |  |\n| --- | --- |\n|  |  |");
    view.destroy();
  });
});

describe("键位（Markdown 档里才成立）", () => {
  it("Ctrl+B 包裹选中文本", () => {
    const view = makeView("word", { anchor: 0, head: 4 });
    view.focus();
    press(view, { code: "KeyB", key: "b", ctrlKey: true });
    expect(view.state.doc.toString()).toBe("**word**");
    view.destroy();
  });

  it("Ctrl+1 把当前行变一级标题", () => {
    const view = makeView("title", { anchor: 2 });
    view.focus();
    press(view, { code: "Digit1", key: "1", ctrlKey: true });
    expect(view.state.doc.toString()).toBe("# title");
    view.destroy();
  });

  it("没有这批扩展时（源码档的非 md 文件）Ctrl+B 什么都不做 —— 判据有鉴别力", () => {
    // 退化替身：只装 markdown + defaultKeymap，不装 markdownFormatExtensions
    const state = EditorState.create({
      doc: "word",
      selection: { anchor: 0, head: 4 },
      extensions: [markdown({ base: markdownLanguage }), keymap.of([...defaultKeymap])],
    });
    const view = new EditorView({ state, parent: document.body });
    view.focus();
    press(view, { code: "KeyB", key: "b", ctrlKey: true });
    expect(view.state.doc.toString()).toBe("word");
    view.destroy();
  });
});

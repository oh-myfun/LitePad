// @vitest-environment jsdom
// Markdown 语法高亮对齐 VS Code：引用正文 / 引用标记 / 列表标记 / 行内代码各有独立
// token（markup.quote、punctuation.definition.quote.begin、punctuation.definition.list.begin、
// markup.inline.raw）。@lezer/markdown 默认把后三类标记全压进 processingInstruction ⇒
// 只能落进 tags.meta 那一档；MARKDOWN_TOKENS 把它们拆开，再由 theme.ts 按主题族上色。
// 标题标记不用拆：它本就继承 ATXHeading 的 heading。
//
// 取色出处：E:/Project/vscode/extensions/theme-defaults/themes/ 的 tokenColors
// （2026-* / dark_vs / light_vs / hc_*；modern、plus 都 include 了 vs）。
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { detectLanguage } from "../src/editor/language";
import { vscodeEditorTheme } from "../src/editor/theme";
import { syntaxPalette } from "../src/theme/syntax";
import type { ThemeFamily } from "../src/theme/theme";

const DOC = "**加粗**\n\n> 引用\n\n- 列表\n\n`代码`\n\n## 标题\n";

/** VS Code 主题里写的是 #rrggbb；jsdom 的 computed color 一律回 rgb(...)。 */
function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

function mount(family: ThemeFamily, dark = true, parser?: Extension): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: [
        parser ?? detectLanguage("sample.md").extension!,
        vscodeEditorTheme(dark, family),
      ],
    }),
    parent: document.body,
  });
}

/** 文本片段所在的 DOM；没有语法 span（无样式 token）时退回整行。 */
function nodeOf(view: EditorView, text: string): HTMLElement {
  const hit =
    [...view.contentDOM.querySelectorAll<HTMLElement>("span")].find((el) =>
      (el.textContent ?? "").includes(text),
    ) ??
    [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")].find((el) =>
      (el.textContent ?? "").includes(text),
    );
  expect(hit, `找不到含「${text}」的语法 span`).toBeTruthy();
  return hit!;
}

function colorOf(view: EditorView, text: string): string {
  return getComputedStyle(nodeOf(view, text)).color;
}

describe("Markdown 主题色：五族两档全覆盖，照 VS Code 的 markup.* / punctuation.definition.*", () => {
  const EXPECTED: ReadonlyArray<
    readonly [ThemeFamily, boolean, readonly [string, string, string, string]]
  > = [
    // family, dark, [quote, quoteMark, listMark, inlineCode]
    ["2026", true, ["#7ee787", "#7ee787", "#ffa657", "#79c0ff"]],
    ["2026", false, ["#116329", "#116329", "#953800", "#0550ae"]],
    ["modern", true, ["inherit", "#6a9955", "#6796e6", "#ce9178"]],
    ["modern", false, ["inherit", "#0451a5", "#0451a5", "#800000"]],
    ["plus", true, ["inherit", "#6a9955", "#6796e6", "#ce9178"]],
    ["plus", false, ["inherit", "#0451a5", "#0451a5", "#800000"]],
    ["classic", true, ["inherit", "#6a9955", "#6796e6", "#ce9178"]],
    ["classic", false, ["inherit", "#0451a5", "#0451a5", "#800000"]],
    // hc_black 没给这四类 token；hc_light 只有引用/列表标记与行内代码。
    ["hc", true, ["inherit", "inherit", "inherit", "inherit"]],
    ["hc", false, ["inherit", "#0451a5", "#0451a5", "#0f4a85"]],
  ];

  it("每族两档的四个 Markdown token 都落在表里", () => {
    for (const [family, dark, [quote, quoteMark, listMark, inlineCode]] of EXPECTED) {
      const p = syntaxPalette(family, dark);
      expect([p.quote, p.quoteMark, p.listMark, p.inlineCode], `${family}/${dark}`).toEqual([
        quote,
        quoteMark,
        listMark,
        inlineCode,
      ]);
    }
  });
});

describe("Markdown 语法高亮真的落到 DOM（2026 / Plus 两个分档口径）", () => {
  it("2026：加粗 / 引用正文与 `>` 绿、列表符橙、行内代码蓝、标题标记跟标题", () => {
    const view = mount("2026");
    expect(colorOf(view, "加粗")).toBe(rgb("#c9d1d9"));
    expect(getComputedStyle(nodeOf(view, "加粗")).fontWeight).toBe("bold");
    expect(colorOf(view, "引用")).toBe(rgb("#7ee787"));
    expect(colorOf(view, ">")).toBe(rgb("#7ee787"));
    expect(colorOf(view, "-")).toBe(rgb("#ffa657"));
    expect(colorOf(view, "代码")).toBe(rgb("#79c0ff"));
    expect(colorOf(view, "`")).toBe(rgb("#79c0ff"));
    expect(colorOf(view, "##")).toBe(rgb("#79c0ff"));
    view.destroy();
  });

  it("Plus：加粗 / 引用正文沿用正文色，`>` / 列表符 / 行内代码各有标记色", () => {
    const view = mount("plus");
    expect(colorOf(view, "加粗")).toBe(rgb("#569cd6"));
    expect(getComputedStyle(nodeOf(view, "加粗")).fontWeight).toBe("bold");
    expect(colorOf(view, "引用")).not.toBe(rgb("#6a9955"));
    expect(colorOf(view, ">")).toBe(rgb("#6a9955"));
    expect(colorOf(view, "-")).toBe(rgb("#6796e6"));
    expect(colorOf(view, "代码")).toBe(rgb("#ce9178"));
    expect(colorOf(view, "`")).toBe(rgb("#ce9178"));
    expect(colorOf(view, "##")).toBe(rgb("#569cd6"));
    view.destroy();
  });

  it("反向验证：摘掉 MARKDOWN_TOKENS 后，这些标记退回 meta / 默认色（判据会红）", () => {
    const view = mount("2026", true, markdown({ base: markdownLanguage }));
    // 默认 styleTags：ListMark 是 processingInstruction（tags.meta 的子 tag）
    // ⇒ 拿到 strong 档 #c9d1d9；InlineCode 的 monospace 没有样式。
    expect(colorOf(view, "-")).toBe(rgb("#c9d1d9"));
    expect(colorOf(view, "代码")).not.toBe(rgb("#79c0ff"));
    view.destroy();

    // `>` 在 2026 会从 Blockquote 继承 quote（绿），但 Plus 的 quote 是 inherit
    // ⇒ 没有 mdQuoteMark 这一档，引用标记就没有自己的颜色。
    const plus = mount("plus", true, markdown({ base: markdownLanguage }));
    expect(colorOf(plus, ">")).not.toBe(rgb("#6a9955"));
    plus.destroy();
  });
});

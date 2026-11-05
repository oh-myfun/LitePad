// @vitest-environment jsdom
// B440 · 用户报「高亮语法没有渲染（还是显示源码：==xxx==）」
//
// 根因不在装饰层：`==高亮==` 既不在 @lezer/markdown 的 GFM 里（GFM = Table / TaskList /
// Strikethrough / Autolink，`markdownLanguage` 另加 Subscript / Superscript / Emoji），
// 也不在 markdown-it 的核心规则里 ⇒ 语法树根本没有这个节点，装饰层无枝可挂
// （previewSets.ts 头部那条「lezer 不认的方言得先扩 parser」说的就是它）。工具条那颗
// 「高亮」只做了 `wrapInline(view, "==", "==")`（format.ts:326），所以点完只剩源码。
//
// 因此这三件事是一个整体，判据也放在一起：
// ① parser 认得 `==…==`（Mark 节点 + 两枚 MarkMark）；
// ② 装饰面把两枚 `==` 藏掉、正文挂上底色类（与 `**粗体**` 同一套标记显形口径）；
// ③ 导出 HTML 走 `<mark>`（与装饰面同口径，`<mark>` 本就在消毒白名单里）。
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MARK_SYNTAX } from "../src/preview/markSyntax";
import { applySelection, buildPreviewSets } from "../src/preview/previewSets";
import { previewFace } from "../src/preview/wysiwyg";
import { runFormat } from "../src/preview/format";
import { renderFull } from "../src/markdown/pipeline";
import { ruleBlock, stripCssComments } from "./static";

const css = stripCssComments(readFileSync("src/preview/preview.css", "utf-8"));

/** 带 B440 那条语法扩展的 state（与生产 `language.ts` 的 Markdown 档同一份 parser）。 */
function mdState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [MARK_SYNTAX] })],
  });
}

/** 装饰集的可比形状：只问 class，不比对象身份。 */
function rangesOf(
  set: ReturnType<typeof buildPreviewSets>["statics"],
  cls: string,
): [number, number][] {
  const out: [number, number][] = [];
  const it = set.iter();
  while (it.value) {
    if (((it.value.spec as { class?: string }).class ?? "") === cls) out.push([it.from, it.to]);
    it.next();
  }
  return out;
}
/** 藏标记的那几发（`HIDE_MARK` 没有 class ⇒ 按空类取）。 */
const hiddenOf = (set: ReturnType<typeof buildPreviewSets>["statics"]) => rangesOf(set, "");

/** 语法树里出现过的节点名（判「parser 认不认」要看树，不能只看装饰）。 */
function nodeNames(state: EditorState): string[] {
  const names: string[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      names.push(node.name);
    },
  });
  return names;
}

describe("B440 `==高亮==`：先扩 parser，装饰层才有枝可挂", () => {
  it("parser 出 Mark 节点与两枚 MarkMark", () => {
    expect(nodeNames(mdState("看 ==高亮== 这里\n"))).toEqual(
      expect.arrayContaining(["Mark", "MarkMark"]),
    );
  });

  it("不误伤：带空格的 `==`、行内代码与 Setext 的 `====` 都不出 Mark 节点", () => {
    // 这条判语法树：装饰类为空是「什么都没实现」也会满足的形状，没有鉴别力。
    const names = nodeNames(mdState("算式 1 == 2 与 3 == 4\n\n标题\n====\n\n`== 代码 ==`\n"));
    expect(names).not.toContain("Mark");
    expect(names.filter((n) => n === "MarkMark")).toHaveLength(0);
  });

  it("装饰：底色类只罩正文，两枚 `==` 各被藏掉", () => {
    const state = mdState("看 ==高亮== 这里\n");
    const line = state.doc.line(1);
    const at = line.from + line.text.indexOf("高亮");
    const statics = buildPreviewSets(state).statics;
    expect(rangesOf(statics, "cm-md-mark")).toEqual([[at, at + 2]]);
    expect(hiddenOf(statics)).toEqual([
      [line.from + 2, line.from + 4],
      [at + 2, at + 4],
    ]);
  });

  it("光标压进 `==…==` 内部 ⇒ 两枚标记显形（与 `**` 那一档同口径）", () => {
    const state = mdState("看 ==高亮== 这里\n");
    expect(
      hiddenOf(buildPreviewSets(state).statics),
      "前置：光标不在这一截时两枚标记是藏着的",
    ).toHaveLength(2);
    const head = state.doc.line(1).from + 5; // 落在「高亮」两个字之间
    const visible = applySelection(
      buildPreviewSets(state).statics,
      state.update({ selection: { anchor: head } }).state,
    );
    expect(hiddenOf(visible)).toEqual([]);
  });

  it("真视图：`==` 不显形、正文带类；光标压进去才看见源码", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "前一段\n\n看 ==高亮== 这里\n",
        extensions: [
          markdown({ base: markdownLanguage, extensions: [MARK_SYNTAX] }),
          previewFace(),
        ],
      }),
      parent: document.createElement("div"),
    });
    try {
      const text = () => view.dom.querySelector(".cm-content")!.textContent ?? "";
      expect(text(), "光标不在这一截时不该露出 `==`").not.toContain("==");
      expect(text()).toContain("高亮");
      expect(view.dom.querySelector(".cm-md-mark")?.textContent).toBe("高亮");

      view.dispatch({ selection: { anchor: view.state.doc.line(3).from + 5 } });
      expect(text(), "光标进 `==…==` 内部就该看见源码").toContain("==");
    } finally {
      view.destroy();
    }
  });

  it("工具条那颗「高亮」点完真出效果：落字 → 挪开光标 → 画成高亮", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "看 高亮 这里\n",
        extensions: [
          markdown({ base: markdownLanguage, extensions: [MARK_SYNTAX] }),
          previewFace(),
        ],
      }),
      parent: document.createElement("div"),
    });
    try {
      const at = view.state.doc.line(1).text.indexOf("高亮");
      view.dispatch({ selection: { anchor: at, head: at + 2 } });
      expect(runFormat(view, "highlight"), "动作键得报「已处理」").toBe(true);
      const line = view.state.doc.line(1); // ⚠️ 事务后重新取：旧 line 的 to 还是包之前的长度
      expect(line.text).toBe("看 ==高亮== 这里");

      // 刚包完光标仍在这一截里 ⇒ 按 B404-2 口径显形源码；挪到行尾才画成高亮
      view.dispatch({ selection: { anchor: line.to } });
      expect(
        rangesOf(buildPreviewSets(view.state).statics, "cm-md-mark"),
        "落字后装饰层要认得它",
      ).toEqual([[line.from + 4, line.from + 6]]);
    } finally {
      view.destroy();
    }
  });
});

describe("B440 样式与导出口径", () => {
  it("`==高亮==` 与行内 `<mark>` 共用同一档底色（别各画一套）", () => {
    const body = ruleBlock(
      css,
      ".md-preview-face .cm-md-inline-mark, .md-preview-face .cm-md-mark",
    );
    expect(body).toMatch(/background-color:/);
    expect(body).toMatch(/color:/);
  });

  it("导出 HTML 也认它：`==x==` → `<mark>x</mark>`，带空格的不算", () => {
    expect(renderFull("看 ==高亮== 这里\n")).toContain("<mark>高亮</mark>");
    expect(renderFull("算式 1 == 2 与 3 == 4\n")).not.toContain("<mark>");
  });

  it("生产接线：Markdown 档的 parser 带着这条扩展（不许只在测试里生效）", () => {
    expect(readFileSync("src/editor/language.ts", "utf-8")).toContain("extensions: [MARK_SYNTAX]");
  });
});

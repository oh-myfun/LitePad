// @vitest-environment jsdom
// B407 · YAML front matter 块（照 InkNote `src/editor/widgets/frontmatter.ts`）。
//
// 判据分三层：
//   ① 纯函数：区间 / 正文提取 /「像不像 YAML」；
//   ② 装饰集合成：整段变成一块原子块 + 一颗 FrontMatterWidget，且没有标题类装饰；
//   ③ 真 DOM：标签与 YAML 文本常显；在文本区打字 ⇒ 整块按 `---\n…\n---` 回写；
//      只读档打字不回写；没有 key 的两条 `---` 不折成盒子。

import { EditorState } from "@codemirror/state";
import { EditorView, type WidgetType } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { describe, expect, it } from "vitest";
import { frontMatterBody, frontMatterRange, previewSyntaxTree } from "../src/spike/deco/codeFence";
import { FrontMatterWidget, looksLikeFrontMatter } from "../src/spike/deco/frontmatterWidget";
import { buildPreviewSets } from "../src/spike/deco/previewSets";
import { decoFace, decoLock } from "../src/spike/deco/wysiwyg";

const SKILL = [
  "---",
  "name: skill-creator",
  "description: 帮我拆任务",
  "---",
  "",
  "# 正文",
  "",
].join("\n");

function stateOf(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage }), decoFace()],
  });
}

function decoView(doc: string, readonly = false): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), decoFace(), decoLock(readonly)],
    }),
    parent: document.body,
  });
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function widgetsOf(set: ReturnType<typeof buildPreviewSets>["statics"]): WidgetType[] {
  const widgets: WidgetType[] = [];
  const it = set.iter();
  while (it.value) {
    const widget = (it.value.spec as { widget?: WidgetType }).widget;
    if (widget) widgets.push(widget);
    it.next();
  }
  return widgets;
}

describe("B407 front matter 区间与正文", () => {
  it("frontMatterBody 去掉首尾围栏行与闭合行后的换行", () => {
    const state = stateOf(SKILL);
    const fm = frontMatterRange(state);
    expect(fm).toEqual({ from: 0, to: 47 });
    expect(frontMatterBody(state, fm!)).toBe("name: skill-creator\ndescription: 帮我拆任务");
  });

  it("两条围栏贴着时正文是空串", () => {
    const state = stateOf("---\n---\n正文\n");
    expect(frontMatterBody(state, frontMatterRange(state)!)).toBe("");
  });

  it("looksLikeFrontMatter 要认出至少一个 key", () => {
    expect(looksLikeFrontMatter("name: a\ndescription: b")).toBe(true);
    expect(looksLikeFrontMatter("  nested: 1")).toBe(true);
    expect(looksLikeFrontMatter("")).toBe(false);
    expect(looksLikeFrontMatter("只是一段正文")).toBe(false);
  });
});

describe("B407 装饰集合成", () => {
  it("整段 front matter 折成一块 YAML 盒，且没有标题类装饰", () => {
    const state = stateOf(SKILL);
    const { atomicBlocks, statics, lines } = buildPreviewSets(state, previewSyntaxTree(state));
    expect(atomicBlocks).toContainEqual({ from: 0, to: 46 });
    const widgets = widgetsOf(statics);
    expect(widgets.length).toBe(1);
    expect(widgets[0]).toBeInstanceOf(FrontMatterWidget);
    const fmWidget = widgets[0] as FrontMatterWidget;
    expect(fmWidget.body).toBe("name: skill-creator\ndescription: 帮我拆任务");
    // lezer 会把 `name: …` + `---` 判成 SetextHeading ⇒ 第二行不许有标题类
    const line2 = state.doc.line(2).from;
    const classes: string[] = [];
    lines.between(line2, line2 + 1, (_f, _t, value) => {
      const cls = (value.spec as { class?: string }).class;
      if (cls) classes.push(cls);
    });
    expect(classes).toEqual([]);
  });

  it("没有 key 的两条 --- 不折（防吞普通分割线）", () => {
    const state = stateOf("---\n---\n正文\n");
    const { atomicBlocks, statics } = buildPreviewSets(state, previewSyntaxTree(state));
    expect(atomicBlocks).toEqual([]);
    expect(widgetsOf(statics).some((w) => w instanceof FrontMatterWidget)).toBe(false);
  });
});

describe("B407 真 DOM 与就地编辑", () => {
  it("标签与 YAML 文本常显（不靠点开）", () => {
    const view = decoView(SKILL);
    const wrap = view.contentDOM.querySelector<HTMLElement>(".md-frontmatter-widget");
    expect(wrap).not.toBeNull();
    expect(wrap!.querySelector(".md-frontmatter-label")!.textContent).toBe("YAML Front Matter");
    const source = wrap!.querySelector<HTMLElement>(".md-frontmatter-source")!;
    expect(source.textContent).toBe("name: skill-creator\ndescription: 帮我拆任务");
    expect(source.getAttribute("contenteditable")).toBe("plaintext-only");
    expect(wrap!.classList.contains("md-block--editing")).toBe(false);
    view.destroy();
  });

  it("在 YAML 文本区打字 ⇒ 整块按 ---/…/--- 回写", async () => {
    const view = decoView(SKILL);
    const wrap = view.contentDOM.querySelector<HTMLElement>(".md-frontmatter-widget")!;
    const source = wrap.querySelector<HTMLElement>(".md-frontmatter-source")!;
    source.focus();
    source.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(wrap.classList.contains("md-block--editing")).toBe(true);

    source.textContent = "name: new-skill\ndescription: 改过的描述";
    source.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(view.state.doc.toString()).toBe(
      "---\nname: new-skill\ndescription: 改过的描述\n---\n\n# 正文\n",
    );
    view.destroy();
  });

  it("只读档：打字不回写，盒子照常显示", async () => {
    const view = decoView(SKILL, true);
    const wrap = view.contentDOM.querySelector<HTMLElement>(".md-frontmatter-widget")!;
    const source = wrap.querySelector<HTMLElement>(".md-frontmatter-source")!;
    const before = view.state.doc.toString();
    source.textContent = "name: hacked";
    source.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(view.state.doc.toString()).toBe(before);
    // 只读档的输入要拦在 beforeinput：IME / 程序化 insertText 不走 keydown，
    // 不拦就会先改 DOM —— 文档没变、画面上却凭空多字。
    const blocked = new InputEvent("beforeinput", { bubbles: true, cancelable: true });
    source.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);
    view.destroy();
  });
});

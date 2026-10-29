// @vitest-environment jsdom
// B397-4a · 编辑模式的「小件」：分割线 / 缩进代码块 / 链接定义 / HTML 块 / 实体字符。
//
// 五件里有三件是两段式（链接定义 / HTML 块：默认画渲染结果，点一下改源码），
// 一件纯渲染（实体字符，光标压进去显形），一件要**回写保持原形**（缩进代码块补四空格，
// 不许变成围栏）。每一件都先在装饰集层面钉「真的接管了这几行」，再钉 DOM ——
// 只钉 DOM 的话，装饰没接管时 widget 根本不存在，判据会退化成空转。
//
// ⚠️ jsdom 不实现 contenteditable 的编辑行为：「打字」= 改 textContent + 发 `input`；
// 焦点判据只看 `md-block--editing` 这颗类（它才是样式层的显隐开关），不看 activeElement。

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { describe, expect, it } from "vitest";
import { CodeBlockWidget } from "../src/spike/deco/codeBlockWidget";
import { assetBase, setAssetBase } from "../src/spike/deco/assets";
import { HtmlBlockWidget } from "../src/spike/deco/miscWidgets";
import { buildPreviewSets } from "../src/spike/deco/previewSets";
import { decoFace, decoLock } from "../src/spike/deco/wysiwyg";

function decoView(doc: string, readonly = false): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        decoFace(),
        decoLock(readonly),
        EditorView.lineWrapping,
      ],
    }),
    parent: document.body,
  });
}

function stateOf(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
}

/** 装饰集报出的原子块原文（按位置排序）。 */
function atomicTexts(doc: string): string[] {
  return buildPreviewSets(stateOf(doc))
    .atomicBlocks.slice()
    .sort((a, b) => a.from - b.from)
    .map((r) => doc.slice(r.from, r.to));
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const press = (el: Element) =>
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));

const HR_DOC = ["甲", "", "---", "", "乙"].join("\n");
const CODE_DOC = ["甲", "", "    const x = 1;", "    let y = 2;", "", "乙"].join("\n");
const LINKREF_DOC = ['[ref]: https://example.com "T"', "", "[看][ref]"].join("\n");
const FOOTNOTE_DOC = ["[^1]: 脚注正文", "", "正文[^1]"].join("\n");
const HTML_DOC = ['<div class="x" onclick="evil()">hi</div>', "", "乙"].join("\n");

describe("B397-4a 分割线", () => {
  it("`---` 整行换成分割线组件，并作为原子块报出", () => {
    expect(atomicTexts(HR_DOC)).toEqual(["---"]);

    const view = decoView(HR_DOC);
    const hr = view.dom.querySelector<HTMLElement>(".md-hr-widget");
    expect(hr, "装饰档没画分割线组件，这条判据就是空转").toBeTruthy();
    expect(hr!.getAttribute("role")).toBe("separator");
    expect(hr!.querySelector(".md-hr-line")).toBeTruthy();
    // 源码那三个连字符不许再当正文露出来
    expect(view.dom.textContent).not.toContain("---");
  });
});

describe("B397-4a 缩进代码块", () => {
  it("画成代码块组件，正文不含行首那四颗空格", () => {
    const view = decoView(CODE_DOC);
    const wrap = view.dom.querySelector<HTMLElement>(".md-codeblock-widget");
    expect(wrap, "装饰档没画代码块组件，这条判据就是空转").toBeTruthy();
    expect(wrap!.querySelector('[data-block-source="1"]')!.textContent).toBe(
      "const x = 1;\nlet y = 2;",
    );
  });

  it("回写保持缩进式：打字后仍是四空格，不变成围栏", async () => {
    const doc = ["    const x = 1;", "", "乙"].join("\n");
    const view = decoView(doc);
    const wrap = view.dom.querySelector<HTMLElement>(".md-codeblock-widget")!;
    const code = wrap.querySelector<HTMLElement>('[data-block-source="1"]')!;

    code.textContent = "const z = 3;";
    code.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await tick();

    expect(view.state.doc.toString()).toBe(["    const z = 3;", "", "乙"].join("\n"));
    expect(view.state.doc.toString()).not.toContain("```");
  });

  it("对照：围栏式代码块回写仍是围栏（同一套打字体，两种口径）", async () => {
    const doc = ["```ts", "const x = 1;", "```", "", "乙"].join("\n");
    const view = decoView(doc);
    const wrap = view.dom.querySelector<HTMLElement>(".md-codeblock-widget")!;
    const code = wrap.querySelector<HTMLElement>('[data-block-source="1"]')!;

    code.textContent = "const z = 3;";
    code.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await tick();

    expect(view.state.doc.toString()).toBe(["```ts", "const z = 3;", "```", "", "乙"].join("\n"));
  });

  it("缩进式与围栏式是两种组件（eq 判不等 ⇒ 换形必须重建）", () => {
    const indented = new CodeBlockWidget(0, 10, "x", "", true);
    const fenced = new CodeBlockWidget(0, 10, "x", "", false);
    expect(indented.eq(fenced)).toBe(false);
    expect(indented.eq(new CodeBlockWidget(3, 13, "x", "", true))).toBe(true);
  });

  it("代码块吃下的区间挡住公式扫描（对照：正文里的 $x$ 照样算公式）", () => {
    const inCode = decoView(["    a = $x$ + 1", "", "乙"].join("\n"));
    expect(inCode.dom.querySelector(".md-math-widget")).toBeNull();

    const inText = decoView("甲 $x$ 乙");
    expect(inText.dom.querySelector(".md-math-widget")).toBeTruthy();
  });
});

describe("B397-4a 链接定义", () => {
  it("`[ref]: url` 折成一条元信息，文案带箭头", () => {
    expect(atomicTexts(LINKREF_DOC)).toEqual(['[ref]: https://example.com "T"']);

    const view = decoView(LINKREF_DOC);
    const wrap = view.dom.querySelector<HTMLElement>(".md-metadata-widget");
    expect(wrap, "装饰档没折出链接定义，这条判据就是空转").toBeTruthy();
    expect(wrap!.classList.contains("md-metadata-reference")).toBe(true);
    expect(wrap!.querySelector(".md-metadata-preview")!.textContent).toBe(
      "链接定义 · ref → https://example.com",
    );
    expect(wrap!.hasAttribute("data-block-len")).toBe(true);
  });

  it("脚注定义 `[^1]:` 折成脚注卡片，不当链接定义折", () => {
    // lezer 把 `[^1]: 正文` 也解析成 LinkReference（URL 子节点就是正文）⇒ 两支抢同一行。
    // InkNote 的分工：链接定义那一支跳过 `^`，脚注由文末那趟文本扫描接管。
    const view = decoView(FOOTNOTE_DOC);
    expect(view.dom.querySelector(".md-metadata-reference")).toBeNull();
    const wrap = view.dom.querySelector<HTMLElement>(".md-metadata-footnote");
    expect(wrap, "脚注定义没画成脚注卡片，这条判据就是空转").toBeTruthy();
    expect(wrap!.querySelector(".md-metadata-preview")!.textContent).toBe("脚注 1 · 脚注正文");
  });

  it("行内 `[^1]` 画成编号上标；光标压进去才显形源码", () => {
    const doc = ["正文[^1]", "", "[^1]: 脚注正文"].join("\n");
    const view = decoView(doc);
    const sup = view.dom.querySelector<HTMLElement>("sup.cm-md-footnote");
    expect(sup, "装饰档没画出脚注上标，这条判据就是空转").toBeTruthy();
    expect(sup!.textContent).toBe("1");

    view.dispatch({ selection: { anchor: doc.indexOf("[^1]") } });
    expect(view.dom.querySelector("sup.cm-md-footnote")).toBeNull();
    expect(view.dom.textContent).toContain("[^1]");
  });

  it("编号按首次出现排；代码里的 `[^x]` 不算脚注", () => {
    const doc = ["甲[^b] 乙[^a]", "", "[^a]: 一", "", "[^b]: 二", "", "`[^c]` 不是脚注"].join("\n");
    const view = decoView(doc);
    const sups = Array.from(view.dom.querySelectorAll("sup.cm-md-footnote")).map(
      (el) => el.textContent,
    );
    expect(sups).toEqual(["1", "2"]);
    const cards = Array.from(view.dom.querySelectorAll(".md-metadata-footnote")).map(
      (el) => el.querySelector(".md-metadata-preview")!.textContent,
    );
    // 编号按**行内首次出现**排：[^b] 先出现 ⇒ 1 号，[^a] ⇒ 2 号。定义块按文档顺序排，
    // 所以卡片上的编号是 2、1（不是 1、2）——这正是「编号跟引用走、不跟定义走」。
    expect(cards).toEqual(["脚注 2 · 一", "脚注 1 · 二"]);
    // 行内代码里的 `[^c]` 原样留着（反引号本身由 InlineCode 那一支藏掉）
    expect(view.dom.textContent).toContain("[^c]");
  });

  it("点预览进入源码编辑（源码区显形）", () => {
    const view = decoView(LINKREF_DOC);
    const wrap = view.dom.querySelector<HTMLElement>(".md-metadata-widget")!;
    press(wrap.querySelector(".md-metadata-preview")!);
    expect(wrap.classList.contains("md-block--editing")).toBe(true);
    expect(wrap.querySelector(".md-block-source")!.textContent).toBe(
      '[ref]: https://example.com "T"',
    );
  });
});

describe("B397-4a HTML 块", () => {
  it("默认画渲染结果，事件属性被剥掉", () => {
    const view = decoView(HTML_DOC);
    const wrap = view.dom.querySelector<HTMLElement>(".md-html-widget");
    expect(wrap, "装饰档没画 HTML 块组件，这条判据就是空转").toBeTruthy();
    const preview = wrap!.querySelector<HTMLElement>(".md-html-preview")!;
    expect(preview.querySelector(".x")!.textContent).toBe("hi");
    expect(preview.innerHTML).not.toContain("onclick");
    // B402：HTML 块借派生预览的排版（表线 / 段落间距 / 标题线），只多挂一个类
    expect(preview.classList.contains("md-rendered")).toBe(true);
  });

  it("`<script>` 与 `javascript:` 链接都进不了预览", () => {
    const doc = [
      '<div><script>alert(1)</script><a href="javascript:alert(2)">x</a></div>',
      "",
      "乙",
    ].join("\n");
    const view = decoView(doc);
    const preview = view.dom.querySelector<HTMLElement>(".md-html-preview")!;
    expect(preview.querySelector("script")).toBeNull();
    expect(preview.querySelector("a")!.hasAttribute("href")).toBe(false);
  });

  it("点预览进入源码编辑，打字即刷新预览并回写", async () => {
    const view = decoView(HTML_DOC);
    const wrap = view.dom.querySelector<HTMLElement>(".md-html-widget")!;
    const preview = wrap.querySelector<HTMLElement>(".md-html-preview")!;
    press(preview);
    expect(wrap.classList.contains("md-block--editing")).toBe(true);

    const source = wrap.querySelector<HTMLElement>(".md-block-source")!;
    source.textContent = "<em>改</em>";
    source.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(preview.querySelector("em")!.textContent).toBe("改");

    await tick();
    expect(view.state.doc.toString()).toContain("<em>改</em>");
  });

  it("预览模式（只读锁）点预览不进入编辑", () => {
    const view = decoView(HTML_DOC, true);
    const wrap = view.dom.querySelector<HTMLElement>(".md-html-widget")!;
    press(wrap.querySelector(".md-html-preview")!);
    expect(wrap.classList.contains("md-block--editing")).toBe(false);
  });
});

describe("B397-4a 实体字符", () => {
  it("`&amp;` 画成 `&`", () => {
    const view = decoView("a &amp; b");
    const el = view.dom.querySelector<HTMLElement>(".md-entity");
    expect(el, "装饰档没画出实体小件，这条判据就是空转").toBeTruthy();
    expect(el!.textContent).toBe("&");
  });

  it("光标压进实体区间才显形源码", () => {
    const doc = "a &amp; b";
    const view = decoView(doc);
    view.dispatch({ selection: { anchor: 0 } });
    expect(view.dom.querySelector(".md-entity")).toBeTruthy();

    view.dispatch({ selection: { anchor: doc.indexOf("&amp;") } });
    expect(view.dom.querySelector(".md-entity")).toBeNull();
    expect(view.dom.textContent).toContain("&amp;");
  });
});

describe("B409 HTML 块：相对路径图片按文档目录解析", () => {
  // 路径一律用正斜杠拼：`resolveAssetPath` 的分隔符跟随原路径，断言里不必和反斜杠转义打架
  const MD = "E:/docs/LitePad.md";
  const IMG_DOC = [
    '<p><img src="screenshots/a.png"><img src="./pics/../shots/b.png"></p>',
    '<img src="https://example.com/x.png"><img src="data:image/png;base64,AAA">',
    "",
    "乙",
  ].join("\n");

  /** 按 assetBase 建一颗装了装饰档的 state（setAssetBase 是 StateEffect）。 */
  function stateWithBase(doc: string, mdPath: string | null): EditorState {
    const base = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), assetBase],
    });
    return base.update({ effects: setAssetBase.of(mdPath) }).state;
  }

  it("装饰集把文档路径喂给 HTML 块 widget（eq 也认它）", () => {
    const doc = IMG_DOC;
    let widget: HtmlBlockWidget | null = null;
    buildPreviewSets(stateWithBase(doc, MD)).statics.between(0, doc.length, (_from, _to, deco) => {
      const w = (deco as unknown as { spec?: { widget?: unknown } }).spec?.widget;
      if (w instanceof HtmlBlockWidget) widget = w;
    });
    expect(widget, "装饰档没画 HTML 块组件").not.toBeNull();
    expect(widget!.mdPath).toBe(MD);
    // 换文档：同一段 HTML 的 widget 必须判不等，否则 DOM 被复用、图还停在上一份目录
    const other = new HtmlBlockWidget(0, doc.length, doc, "E:/elsewhere/x.md");
    expect(widget!.eq(other)).toBe(false);
  });

  it("预览 DOM：相对路径拼成文档目录下的绝对路径，带协议的不碰", () => {
    const html =
      '<img src="screenshots/a.png"><img src="./pics/../shots/b.png"><img src="https://x/y.png"><img src="data:image/png;base64,AAA"><img src="C:/shots/c.png">';
    const dom = new HtmlBlockWidget(0, html.length, html, MD).toDOM();
    const srcs = [...dom.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    // jsdom 里 convertFileSrc 会抛 ⇒ assetUrl 原样返回路径；拼路径这一半才是判据
    expect(srcs[0]).toBe("E:/docs/screenshots/a.png");
    expect(srcs[1], "`..` 段要折叠").toBe("E:/docs/shots/b.png");
    expect(srcs[2], "http(s) 不碰").toBe("https://x/y.png");
    expect(srcs[3], "data: 不碰").toBe("data:image/png;base64,AAA");
    expect(srcs[4], "Windows 绝对路径（盘符带冒号）不许被当成协议跳过").toBe("C:/shots/c.png");
  });

  it("换文档复用 DOM（updateDOM）：图片地址跟着新目录走", () => {
    const html = '<img src="screenshots/a.png">';
    const first = new HtmlBlockWidget(0, html.length, html, MD);
    const dom = first.toDOM();
    expect(dom.querySelector("img")!.getAttribute("src")).toBe("E:/docs/screenshots/a.png");
    const moved = new HtmlBlockWidget(0, html.length, html, "E:/other/README.md");
    moved.updateDOM(dom);
    expect(dom.querySelector("img")!.getAttribute("src")).toBe("E:/other/screenshots/a.png");
  });

  it("源码里改图地址 ⇒ 预览重解析（onInput 那条路）", () => {
    const html = '<img src="a.png">';
    const widget = new HtmlBlockWidget(0, html.length, html, MD);
    const dom = widget.toDOM();
    const source = dom.querySelector<HTMLElement>(".md-block-source")!;
    source.textContent = '<img src="b.png">';
    source.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(dom.querySelector("img")!.getAttribute("src")).toBe("E:/docs/b.png");
  });
});

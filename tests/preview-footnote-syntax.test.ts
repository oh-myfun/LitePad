// @vitest-environment jsdom
// B444 · 用户拿 Vditor 的样例文档（`E:\Project\vscode-office\vditor\default-markdown.md`）
// 试装饰面，报两处渲染异常。两处的根因都在**解析层**，不在装饰层：
//
// ① 「脚注引用会出现下划线」：`这里是一个脚注引用[^1]，这里是另一个脚注引用[^bignote]` ——
//    lezer 的 inline Link 解析器把整段当成**引用式链接**（`[text][label]`，而且它不校验 label
//    到底有没有定义，见 @lezer/markdown/src/README），于是中间那句普通中文被 `tags.link`
//    染成链接色 + 下划线。装饰层只做到「不给它挂 `.cm-md-link`」（`Link` 分支那行 `return false`），
//    压不住语法高亮自己那一层 span ⇒ 必须让 `[^label]` 在 Link 之前被吃掉。
// ② 「缩进对齐段落 / 代码块范围异常」：脚注定义的正文按 GFM 是缩进 ≥4 的那几行，CommonMark
//    没有脚注 ⇒ 四空格起就是缩进代码块，于是「缩进对齐的段落 + 其中的围栏 + 后面那段」被
//    合成**一大块** CodeBlock（真机截图里那一坨）。GFM 的口径是这些行属于定义体 ⇒
//    做成 composite 块，`moveBaseColumn` 把四空格交给 base，缩进代码那条判据就够不着了。
//
// 判据分两层：先问语法树（parser 认不认），再问装饰（画出来是什么），最后钉 DOM。

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { FOOTNOTE_SYNTAX } from "../src/preview/footnoteSyntax";
import { MARK_SYNTAX } from "../src/preview/markSyntax";
import { buildPreviewSets } from "../src/preview/previewSets";
import { previewFace, previewLock } from "../src/preview/wysiwyg";
import { stripCssComments } from "./static";

/** 与生产 `language.ts` 的 Markdown 档同一份 parser。 */
function mdState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [MARK_SYNTAX, FOOTNOTE_SYNTAX] })],
  });
}

function nodeNames(state: EditorState): string[] {
  const names: string[] = [];
  syntaxTree(state).iterate({ enter: (node) => void names.push(node.name) });
  return names;
}

/** 某个节点名的全部区间（按位置排序），用来比对「谁吞了谁」。 */
function rangesNamed(state: EditorState, name: string): [number, number][] {
  const out: [number, number][] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === name) out.push([node.from, node.to]);
    },
  });
  return out.sort((a, b) => a[0] - b[0]);
}

function rangesOf(set: ReturnType<typeof buildPreviewSets>["statics"], cls: string) {
  const out: [number, number][] = [];
  const it = set.iter();
  while (it.value) {
    if (((it.value.spec as { class?: string }).class ?? "") === cls) out.push([it.from, it.to]);
    it.next();
  }
  return out;
}

function faceView(doc: string): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage, extensions: [MARK_SYNTAX, FOOTNOTE_SYNTAX] }),
        previewFace(),
        EditorView.lineWrapping,
      ],
    }),
    parent: document.body,
  });
}

/** ① 的两行：一句里两个脚注引用，中间夹着普通文字。 */
const REF_DOC = [
  "这里是一个脚注引用[^1]，这里是另一个脚注引用[^bignote]。",
  "",
  "[^1]: 一",
  "",
  "[^bignote]: 二",
].join("\n");

/** ② 的样例：定义体 = 空行 + 缩进段落 + 缩进围栏 + 缩进段落（照 Vditor 那段）。 */
const BODY_DOC = [
  "[^bignote]: 脚注定义可使用多段内容。",
  "",
  "    缩进对齐的段落包含在这个脚注定义内。",
  "",
  "    ```",
  "    可以使用代码块。",
  "    ```",
  "",
  "    还有其他行级排版语法，比如**加粗**。",
  "",
  "定义体之外的段落。",
].join("\n");

describe("B444 ① 脚注引用不再被当成引用式链接", () => {
  it("语法树里两个 `[^x]` 是 FootnoteReference，没有把中间文字吞进去的 Link", () => {
    const state = mdState(REF_DOC);
    const names = nodeNames(state);
    expect(names.filter((n) => n === "FootnoteReference")).toHaveLength(2);
    expect(names, "中间那句普通中文又被判成链接了").not.toContain("Link");
  });

  it("装饰面不给那一行挂链接类（下划线那层没人画）", () => {
    const state = mdState(REF_DOC);
    const { statics } = buildPreviewSets(state);
    expect(rangesOf(statics, "cm-md-link")).toEqual([]);
  });

  it("上标编号与卡片照旧（扩了 parser 不许把现有脚注渲染弄坏）", () => {
    const view = faceView(REF_DOC);
    const sups = Array.from(view.dom.querySelectorAll("sup.cm-md-footnote")).map(
      (el) => el.textContent,
    );
    expect(sups).toEqual(["1", "2"]);
    expect(view.dom.textContent).toContain("这里是另一个脚注引用");
  });
});

describe("B444 ② 脚注定义的正文属于定义体，不被缩进代码吞掉", () => {
  it("语法树里有 FootnoteDefinition，且整篇没有缩进代码块", () => {
    const state = mdState(BODY_DOC);
    const names = nodeNames(state);
    expect(names).toContain("FootnoteDefinition");
    expect(names, "四空格又被判成缩进代码块了").not.toContain("CodeBlock");
  });

  it("定义体的区间盖住正文那几行，之外的段落不被卷进来", () => {
    const state = mdState(BODY_DOC);
    const [[from, to]] = rangesNamed(state, "FootnoteDefinition");
    const outside = BODY_DOC.indexOf("定义体之外的段落。");
    expect(from).toBe(0);
    expect(to, "定义之外的段落被卷进来了").toBeLessThanOrEqual(outside);
    expect(BODY_DOC.slice(from, to)).toContain("还有其他行级排版语法");
  });

  it("正文里的围栏与加粗按嵌套块解析（各归各的范围）", () => {
    const state = mdState(BODY_DOC);
    const names = nodeNames(state);
    expect(names).toContain("FencedCode");
    expect(names).toContain("StrongEmphasis");
    const [[defFrom, defTo]] = rangesNamed(state, "FootnoteDefinition");
    const [fenceFrom, fenceTo] = rangesNamed(state, "FencedCode")[0];
    expect(fenceFrom).toBeGreaterThan(defFrom);
    expect(fenceTo).toBeLessThanOrEqual(defTo);
  });

  it("装饰面：整条定义（含缩进正文与围栏）折进一张卡片（B444 用户选定）", () => {
    const view = faceView(BODY_DOC);
    const card = view.dom.querySelector<HTMLElement>(".md-metadata-footnote");
    expect(card, "脚注定义没画成脚注卡片，这条判据就是空转").toBeTruthy();
    expect(card!.querySelector(".md-metadata-title")!.textContent).toBe(
      "脚注 1 · 脚注定义可使用多段内容。",
    );
    // 卡片接管整个 FootnoteDefinition —— 只吃首行的话，缩进正文会在外面各画各的
    // （围栏标记被藏掉 ⇒ 留下两行看着像空白的真空，用户报的就是这一带）。
    const [[defFrom, defTo]] = rangesNamed(mdState(BODY_DOC), "FootnoteDefinition");
    expect(Number(card!.dataset.blockFrom)).toBe(defFrom);
    expect(Number(card!.dataset.blockTo), "卡片只吃到首行").toBe(defTo);
    // 正文与围栏标记都收在卡片自己的源码里（点卡片才露），编辑器行序列里不再有它们
    const source = card!.querySelector(".md-block-source")!.textContent ?? "";
    expect(source).toContain("缩进对齐的段落包含在这个脚注定义内。");
    expect(source).toContain("```");
    expect(
      [...view.dom.querySelectorAll(".cm-line")].some((l) =>
        l.textContent!.includes("缩进对齐的段落"),
      ),
      "正文还在外面画成普通行",
    ).toBe(false);
    expect(view.dom.querySelector(".md-codeblock-widget")).toBeNull();
  });

  it("卡片里改正文 → 只替换整条定义那一段（多行卡片不许吃掉定义之外的段落）", async () => {
    const view = faceView(BODY_DOC);
    try {
      const [[, defTo]] = rangesNamed(mdState(BODY_DOC), "FootnoteDefinition");
      const definition = BODY_DOC.slice(0, defTo);
      const card = view.dom.querySelector<HTMLElement>(".md-metadata-footnote")!;
      const source = card.querySelector<HTMLElement>(".md-block-source")!;
      expect(source.textContent, "卡片源码该是整条定义").toBe(definition);
      const extra = "\n\n    追加的一段。";
      source.textContent = definition + extra;
      source.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
      source.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      const after = view.state.doc.toString();
      expect(after).toContain("追加的一段。");
      expect(after.endsWith(BODY_DOC.slice(defTo)), "定义之外的段落被卷进回写了").toBe(true);
      expect(after.length).toBe(BODY_DOC.length + extra.length);
    } finally {
      view.destroy();
    }
  });

  it("定义行里带链接也不炸：卡片那一行不许再有别的装饰压进来", () => {
    const doc = ["[^1]: 看 [链接](https://example.com) 一眼", "", "正文[^1]"].join("\n");
    const state = mdState(doc);
    expect(() => buildPreviewSets(state)).not.toThrow();
    const { statics } = buildPreviewSets(state);
    const headTo = doc.indexOf("\n");
    expect(
      rangesOf(statics, "cm-md-link").filter(([from]) => from < headTo),
      "卡片范围内又挂了链接装饰 ⇒ Decoration.set 会抛",
    ).toEqual([]);
  });
});

// B449（用户 2026-11-01 拿同一份 Vditor 样例文档再试）：「脚注 2 用了多段内容，没正常渲染 ——
// 应该在脚注 2 里面显示后续缩进的段落以及内部的代码块」。
//
// 取证结论（`.tmp` 里那份 dump）：**解析层是对的** —— 7 空格缩进那几行确实进了
// `FootnoteDefinition`（20..170），围栏是 `FencedCode`、末段是 `Paragraph`，卡片也真把整条
// 定义接管了。缺的是**卡片只画了标题那一行**：`.md-metadata-preview` = `脚注 2 · 首行`，
// 正文（段落 / 代码块 / 行级语法）只活在隐藏的 `.md-block-source` 里 ⇒ 用户看到的是
// 「脚注 2 只有一句话，后面那些内容不见了」。
//
// 所以这一档要的是：把定义体**渲染进卡片**（与 HTML 块同一套 —— `.md-rendered` 借派生预览
// 的排版、消毒走 `sanitize.ts`），点卡片仍整条换源码。
describe("B449 脚注定义的多段正文渲染进卡片", () => {
  /** 照真实那份文档 `[^bignote]` 那段：**七空格**缩进 + 「空行」带四空格尾随空白 +
   *  闭合围栏后**不空行**直接接一段。（B444 那版夹具是四空格 + 干净空行，差就在这三处。） */
  const VDOC = [
    "这里是一个脚注引用[^1]，这里是另一个脚注引用[^bignote]。",
    "",
    "[^1]: 第一个脚注定义。",
    "    ",
    "[^bignote]: 脚注定义可使用多段内容。",
    "    ",
    "       缩进对齐的段落包含在这个脚注定义内。",
    "    ",
    "       ```",
    "       可以使用代码块。",
    "       ```",
    "       还有其他行级排版语法，比如**加粗**和[链接](https://b3log.org)。",
    "    ",
    "定义之外的段落。",
  ].join("\n");

  const cardOf = (view: EditorView, label: string): HTMLElement => {
    const n = label === "bignote" ? 2 : 1;
    const cards = [...view.dom.querySelectorAll<HTMLElement>(".md-metadata-footnote")];
    const card = cards.find(
      (c) => (c.dataset.blockFrom ?? "") !== "" && c.textContent?.includes(`脚注 ${n} ·`),
    );
    expect(card, `没找到脚注 ${n} 那张卡片`).toBeTruthy();
    return card!;
  };

  it("解析层照旧：七空格那几行属于定义体，且没有一处缩进代码块", () => {
    const state = mdState(VDOC);
    const names = nodeNames(state);
    expect(names, "四空格起又被判成缩进代码").not.toContain("IndentedCode");
    expect(names).toContain("FencedCode");
    const ranges = rangesNamed(state, "FootnoteDefinition");
    const big = ranges[ranges.length - 1];
    expect(VDOC.slice(big[0], big[1])).toContain("还有其他行级排版语法");
    expect(VDOC.slice(big[0], big[1]), "定义之外的段落被卷进来了").not.toContain(
      "定义之外的段落。",
    );
  });

  it("卡片里看得见后续段落（不再只有一行标题）", () => {
    const view = faceView(VDOC);
    const body = cardOf(view, "bignote").querySelector(".md-metadata-body");
    expect(body, "多段脚注的卡片没有正文区").toBeTruthy();
    expect(body!.textContent).toContain("缩进对齐的段落包含在这个脚注定义内。");
    expect(body!.textContent).toContain("还有其他行级排版语法");
    expect([...body!.querySelectorAll("p")].length, "两段段落各画各的").toBeGreaterThanOrEqual(2);
  });

  it("卡片里的代码块真画成代码块（不是露着三根反引号的源码行）", () => {
    const view = faceView(VDOC);
    const body = cardOf(view, "bignote").querySelector(".md-metadata-body")!;
    const pre = body.querySelector("pre");
    expect(pre, "内嵌围栏没渲染成 pre").toBeTruthy();
    expect(pre!.textContent).toContain("可以使用代码块。");
    expect(body.textContent, "围栏标记漏进正文").not.toContain("```");
  });

  it("行级语法跟着渲染：加粗是 strong、链接是 a（且带 href）", () => {
    const view = faceView(VDOC);
    const body = cardOf(view, "bignote").querySelector(".md-metadata-body")!;
    expect(body.querySelector("strong")?.textContent).toBe("加粗");
    expect(body.querySelector("a")?.getAttribute("href")).toBe("https://b3log.org");
  });

  it("标题那一行仍是一句（正文不混进标题），单行脚注不建正文区", () => {
    const view = faceView(VDOC);
    const big = cardOf(view, "bignote");
    expect(big.querySelector(".md-metadata-title")?.textContent).toBe(
      "脚注 2 · 脚注定义可使用多段内容。",
    );
    expect(
      cardOf(view, "1").querySelector(".md-metadata-body"),
      "只有一行的脚注定义不该多一节空正文",
    ).toBeNull();
  });

  it("正文借派生预览那一套排版（`.md-rendered`），且不继承 CM6 的 pre-wrap", () => {
    const view = faceView(VDOC);
    expect(
      cardOf(view, "bignote").querySelector(".md-metadata-body")!.classList.contains("md-rendered"),
    ).toBe(true);
    const css = stripCssComments(readFileSync("src/preview/preview.css", "utf-8"));
    const rule = /(?:^|\n)\.md-preview-face \.md-metadata-body\s*\{([^}]*)\}/s.exec(css)?.[1] ?? "";
    expect(rule, "CM6 的 pre-wrap 会继承进 widget ⇒ 标签间换行会变成假空行（B402 那条坑）").toMatch(
      /white-space:\s*normal/,
    );
    // B454：点卡片进编辑档时源码框浮在上面，正文**不收起**（脚注定义多段正文，藏掉就等于盲改）
    expect(css).not.toMatch(
      /\.md-block--editing[^{]*\.md-metadata-preview[^{]*\{[^}]*display:\s*none/,
    );
  });

  it("编辑器行序列里没有漏在外的正文行（整条仍归卡片）", () => {
    const view = faceView(VDOC);
    expect(
      [...view.dom.querySelectorAll(".cm-line")].some((l) =>
        l.textContent!.includes("缩进对齐的段落"),
      ),
      "正文还在外面画成普通行",
    ).toBe(false);
    expect(view.dom.querySelector(".md-codeblock-widget"), "内嵌围栏又单独长出一块组件").toBeNull();
  });
});

// B450（用户点名「脚注支持点击跳转」）：上标那一颗此前只是**画出来的编号** ——
// `InlinePreviewWidget.ignoreEvent()` 让 CM 不理这一下，编辑档点它是把光标放进去显形源码，
// 预览档点它什么也不发生。现在它要认得自己那条定义在哪儿，点了滚过去。
//
// 口径与 B403 的链接**同一条**（不新造规则）：预览档（锁着）普通点击就跳，编辑档按 Ctrl 才跳
// —— 编辑档那一下不按 Ctrl 时仍是「放光标 / 显形源码」，两条路各走各的。
describe("B450 上标点击跳到那条定义", () => {
  const DEF1 = REF_DOC.indexOf("[^1]: 一");
  const DEF2 = REF_DOC.indexOf("[^bignote]: 二");

  /** 锁着的预览档：与生产同一颗 `previewLock(true)`（readOnly + editable(false)）。 */
  function lockedView(doc: string): EditorView {
    return new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          markdown({ base: markdownLanguage, extensions: [MARK_SYNTAX, FOOTNOTE_SYNTAX] }),
          previewFace(),
          previewLock(true),
        ],
      }),
      parent: document.body,
    });
  }

  const press = (el: Element, ctrl = false): void => {
    // ⚠️ 不带 `view`：jsdom 会拿它做 Window 类型校验（`member view is not of type Window`），
    // 而 ctrlKey / button 这些字段没有 view 照样生效。
    el.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        ctrlKey: ctrl,
      }),
    );
  };

  /** 闪一下那层是**滚完才找得到卡片**（块 widget 按视口挂）⇒ 留几发重试，测试跟着等。 */
  const settled = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10));
  };

  const jumped = (view: EditorView, defFrom: number): boolean =>
    !!view.dom
      .querySelector(`[data-block-from="${defFrom}"]`)
      ?.classList.contains("md-metadata--jump");

  it("两颗上标各带自己的跳转目标（指的就是那条定义的起点）", () => {
    const view = faceView(REF_DOC);
    const sups = [...view.dom.querySelectorAll<HTMLElement>("sup.cm-md-footnote")];
    expect(sups.map((s) => s.dataset.fnJump)).toEqual([String(DEF1), String(DEF2)]);
  });

  it("没有定义的引用不挂目标：点了没去处的东西不该给假 affordance", () => {
    const view = faceView("正文[^9]");
    const sup = view.dom.querySelector<HTMLElement>("sup.cm-md-footnote")!;
    expect(sup, "这颗上标没画出来，判据就是空转").toBeTruthy();
    expect(sup.dataset.fnJump).toBeUndefined();
  });

  it("编辑档：不按 Ctrl 的点击仍是放光标（不跳）", async () => {
    const view = faceView(REF_DOC);
    press(view.dom.querySelector("sup.cm-md-footnote")!);
    await settled();
    expect(jumped(view, DEF1), "编辑档普通点击把位置跳走了").toBe(false);
    expect(view.state.selection.main.from).toBe(REF_DOC.indexOf("[^1]"));
  });

  it("编辑档：按 Ctrl 才跳，且不动文档不动选区", async () => {
    // 另起一张脸：上一发「普通点击」把光标送进了 `[^1]`，那颗上标当场换成源码 ⇒
    // 拿旧节点再按 Ctrl 判的是「脱离文档的 DOM」，测不到真路径。
    const view = faceView(REF_DOC);
    const before = view.state.selection.main.from;
    press(view.dom.querySelector("sup.cm-md-footnote")!, true);
    await settled();
    expect(jumped(view, DEF1), "Ctrl+点击没落到那张卡片上").toBe(true);
    expect(view.state.selection.main.from, "跳转不许把光标塞进定义里").toBe(before);
    expect(view.state.doc.toString(), "跳转不许改文档").toBe(REF_DOC);
  });

  it("预览档（锁着）：普通点击就跳，且不动选区", async () => {
    const view = lockedView(REF_DOC);
    const before = view.state.selection.main.from;
    press(view.dom.querySelector("sup.cm-md-footnote")!);
    await settled();
    expect(jumped(view, DEF1)).toBe(true);
    expect(view.state.selection.main.from).toBe(before);
  });

  it("闪一下会自己收掉（常驻就成了「这张卡片被选中」的假信号）", async () => {
    const view = faceView(REF_DOC);
    press(view.dom.querySelectorAll("sup.cm-md-footnote")[0], true);
    await settled();
    expect(jumped(view, DEF1)).toBe(true);
    await new Promise((r) => setTimeout(r, 1200));
    expect(jumped(view, DEF1), "那层闪高亮没摘掉").toBe(false);
  });
});

// B457（用户 2026-11-03 拿 `docs/zh_CN.md` 再试）：「脚注 2 没有正常渲染了」。
//
// 取证（`.tmp/b457-probe.py` + 一次性语法树 dump）：这一份与 B449 那份的差别只有**一处** ——
// 两条定义**紧挨着**（`[^1]: …` 下一行就是 `[^bignote]: …`，中间没有空行）。
// 于是 `[^1]` 那条的正文段落按 CommonMark 的「惰性续行」把下一行整句吃掉，
// `FootnoteDefinition` 一路长到 45-192（把第二条定义连同它的缩进正文整个吞了）⇒
// 装饰层只折出**一张**卡片（标题「脚注 1 · 第一个脚注定义。」），脚注 2 根本没机会成卡。
//
// GFM 的口径是定义体只吃「缩进 ≥4」的行：顶格的 `[^x]:` 是新的一条，不是上一段的续行。
// 缺的是 `endLeaf` 那一发（与 lezer 自己给 Table 的那条同一形）：段落续行前先问一句
// 「这一行是不是另一条定义」。
describe("B457 两条定义紧挨着：第二条不许被第一条的段落吃掉", () => {
  const ADJ = [
    "这里是一个脚注引用[^1]，这里是另一个脚注引用[^bignote]。",
    "",
    "[^1]: 第一个脚注定义。",
    "[^bignote]: 脚注定义可使用多段内容。",
    "",
    "    缩进对齐的段落包含在这个脚注定义内。",
    "",
    "    ```text",
    "    可以使用代码块。",
    "    ```",
    "",
    "    还有其他行级排版语法，比如**加粗**和[链接](https://b3log.org)。",
    "",
    "定义之外的段落。",
  ].join("\n");

  const cardAt = (view: EditorView, n: number): HTMLElement | undefined =>
    [...view.dom.querySelectorAll<HTMLElement>(".md-metadata-footnote")].find((c) =>
      c.textContent?.includes(`脚注 ${n} ·`),
    );

  it("解析层：两条定义各一个节点，第一条只吃自己那一行", () => {
    const state = mdState(ADJ);
    const ranges = rangesNamed(state, "FootnoteDefinition");
    expect(ranges.length, `只解析出 ${ranges.length} 条定义`).toBeGreaterThanOrEqual(2);
    const first = ADJ.slice(ranges[0][0], ranges[0][1]);
    expect(first).toBe("[^1]: 第一个脚注定义。");
    expect(first, "第二条定义被第一条的段落当续行吃了").not.toContain("bignote");
  });

  it("第二条定义的范围照旧吃到缩进正文，且不吃后面那一段", () => {
    const state = mdState(ADJ);
    const [, last] = rangesNamed(state, "FootnoteDefinition").slice(-1)[0];
    const text = ADJ.slice(rangesNamed(state, "FootnoteDefinition").slice(-1)[0][0], last);
    expect(text).toContain("还有其他行级排版语法");
    expect(text, "定义之外的段落被卷进来了").not.toContain("定义之外的段落。");
  });

  it("装饰层：两张卡片，脚注 2 那张带正文（段落 + 代码块 + 行级语法）", () => {
    const view = faceView(ADJ);
    try {
      const one = cardAt(view, 1);
      const two = cardAt(view, 2);
      expect(one, "脚注 1 的卡片没折出来").toBeTruthy();
      expect(two, "脚注 2 的卡片根本没折出来（被脚注 1 吞了）").toBeTruthy();
      const body = two!.querySelector(".md-metadata-body");
      expect(body, "脚注 2 的卡片没有正文区").toBeTruthy();
      expect(body!.textContent).toContain("缩进对齐的段落包含在这个脚注定义内。");
      expect(body!.querySelector("pre")?.textContent).toContain("可以使用代码块。");
      expect(body!.querySelector("strong")?.textContent).toBe("加粗");
      expect(
        one!.querySelector(".md-metadata-body"),
        "只有一行的脚注定义不该多一节正文",
      ).toBeNull();
    } finally {
      view.destroy();
    }
  });
});

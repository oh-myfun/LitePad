// @vitest-environment jsdom
// B397-3 · 块级可编辑（把 InkNote 的「就地编辑」机械搬进装饰面）。
//
// 形状照 InkNote `src/editor/widgets/{blockRange,editableSource,codeBlock}.ts`
// （本机参照 E:\Project\InkNote\InkNote）。这一片要证的性质只有一条主线：
//
//   **块级 widget 里打字，文档跟着变，而正在打字的那颗 DOM 不许被重建。**
//
// 后半句是全部难点：CM6 在装饰重建时先按 `eq()` 找同一颗 widget，找不到才落到
// `updateDOM(dom, view, oldWidget)`（`@codemirror/view/dist/index.js:2566-2568`，
// pass 1 走 `constructor == constructor && updateDOM()`）。widget 不带 `updateDOM`
// 就等于「内容一变 ⇒ 整块 DOM 换新 ⇒ 光标被打掉」——  LitePad 现在的
// `CodeBlockWidget` 正是这一形（B391 那会儿它是只读的，不需要活下来）。
// 所以「同一颗 code 元素」那几条是本文件最有鉴别力的判据：漏写 `updateDOM` 就红。
//
// ⚠️ jsdom 不实现 contenteditable 的编辑行为：测试里「打字」= 改 textContent + 发一条
// `input` 事件，走的正是 `attachSourceEditing` 监听的那一条路径（不是绕过它）。

import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { describe, expect, it, vi } from "vitest";
import {
  currentBlockRange,
  mapClickToBlockPos,
  stampBlockRange,
} from "../src/spike/deco/blockRange";
import {
  beginSourceEditing,
  caretTextOffset,
  clickedOnBlockPadding,
  enterAdjacentBlock,
  isBlockSyncing,
  makePlainTextEditable,
  readPlainText,
  selectEditableContents,
  setCaretOffset,
} from "../src/spike/deco/editableSource";
import { decoFace, decoLock } from "../src/spike/deco/wysiwyg";

// jsdom 不实现 scrollIntoView（语言下拉展开时 `setActive` 会调）—— 显式打桩成 no-op
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = (): void => {};
}

const FENCE_DOC = ["# 头", "```ts", "export const a = 1;", "```", "尾行"].join("\n");

/** 建一颗真装了所见即所得档的 view（装饰档的 widget 只有在这颗上才存在）。 */
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

/** 光标放在块**外**（块级 widget 只有在光标不进它时才保持折叠显示）。 */
function parkCaretAt(view: EditorView, lineText: string): void {
  const idx = view.state.doc.lines;
  for (let n = 1; n <= idx; n++) {
    const line = view.state.doc.line(n);
    if (line.text === lineText) {
      view.dispatch({ selection: { anchor: line.from } });
      return;
    }
  }
  throw new Error(`夹具里没有整行等于 ${JSON.stringify(lineText)} 的行`);
}

const tick = (ms = 12) => new Promise((r) => setTimeout(r, ms));

/** 围栏那一块在文档里的区间（写死下标会把「替换错了范围」误判成「updateDOM 没生效」）。 */
function fenceRange(view: EditorView): { from: number; to: number } {
  const text = view.state.doc.toString();
  const from = text.indexOf("```");
  const to = text.indexOf("```", from + 3) + 3;
  expect(from).toBeGreaterThan(-1);
  return { from, to };
}

/** 模拟「在可编辑区里打字」：改 DOM + 发 input（attachSourceEditing 监听的就是这条）。 */
function typeInto(el: HTMLElement, text: string): void {
  el.textContent = text;
  el.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

function keyIn(el: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
}

describe("B397-3 区间记账：块级 widget 的源码位置只能反查，不能存绝对值", () => {
  it("stamp 写的是「长度」这一族，取用时只信 posAtDOM", () => {
    const el = document.createElement("div");
    stampBlockRange(el, 12, 30);
    expect(el.dataset.blockFrom).toBe("12");
    expect(el.dataset.blockTo).toBe("30");
    expect(el.dataset.blockLen).toBe("18");
  });

  it("上方插一行 ⇒ 绝对位置过期，反查仍指回同一段源码", () => {
    const view = decoView(FENCE_DOC);
    const wrap = view.dom.querySelector<HTMLElement>(".md-codeblock-widget");
    expect(wrap, "装饰档没画出代码块 widget，这条判据就是空转").not.toBeNull();
    const before = currentBlockRange(view, wrap!);
    expect(before).not.toBeNull();
    const src = view.state.doc.sliceString(before!.from, before!.to);
    expect(src).toBe("```ts\nexport const a = 1;\n```");

    view.dispatch({ changes: { from: 0, insert: "上面又一行\n" } });
    const after = currentBlockRange(view, wrap!);
    expect(after).not.toBeNull();
    expect(view.state.doc.sliceString(after!.from, after!.to)).toBe(src);
    expect(after!.from).toBe(before!.from + "上面又一行\n".length);
    view.destroy();
  });

  it("脱离编辑器的节点给 null，不许退化成 0 或 doc.length", () => {
    const view = decoView(FENCE_DOC);
    const orphan = document.createElement("div");
    stampBlockRange(orphan, 5, 9);
    expect(currentBlockRange(view, orphan)).toBeNull();
    document.body.appendChild(orphan);
    expect(currentBlockRange(view, orphan)).toBeNull();
    orphan.remove();
    view.destroy();
  });

  it("点在外层留白上的坐标估算是「夹到块内」的：块尾之后永不落点", () => {
    const view = decoView(FENCE_DOC);
    const wrap = view.dom.querySelector<HTMLElement>(".md-codeblock-widget")!;
    const r = currentBlockRange(view, wrap)!;
    const rect = { top: 0, left: 0, height: 40, width: 100 } as DOMRect;
    vi.spyOn(wrap, "getBoundingClientRect").mockReturnValue(rect);
    const far = mapClickToBlockPos(view, r.from, r.to, 9999, 9999, wrap);
    expect(far).toBeGreaterThanOrEqual(r.from);
    expect(far).toBeLessThan(r.to);
    view.destroy();
  });
});

describe("B397-3 就地编辑机械：读文本与光标必须同一口径", () => {
  it("readPlainText 把 BR 读成换行、把块级子节点边界补成换行", () => {
    const el = document.createElement("div");
    el.innerHTML = "ab<br>cd<div>ef</div><div>gh</div>";
    expect(readPlainText(el).text).toBe("ab\ncd\nef\ngh");
  });

  it("setCaretOffset ↔ caretTextOffset 往返（含末尾）", () => {
    const el = document.createElement("code");
    el.textContent = "hello";
    document.body.appendChild(el);
    for (const off of [0, 2, 5]) {
      setCaretOffset(el, off);
      expect(caretTextOffset(el)).toBe(off);
    }
    el.remove();
  });

  it("可编辑区认得出自己：plaintext-only + data-block-source，且关掉拼写检查", () => {
    const el = document.createElement("code");
    makePlainTextEditable(el);
    expect(el.dataset.blockSource).toBe("1");
    expect(["plaintext-only", "true"]).toContain(el.contentEditable);
    expect(el.spellcheck).toBe(false);
  });

  it("selectEditableContents 只圈这一块，不落到整篇文档", () => {
    const el = document.createElement("code");
    el.textContent = "只在块内";
    document.body.appendChild(el);
    selectEditableContents(el);
    const range = window.getSelection()!.getRangeAt(0);
    expect(el.contains(range.commonAncestorContainer)).toBe(true);
    expect(range.toString()).toBe("只在块内");
    el.remove();
  });

  it("clickedOnBlockPadding 只认「点在外层根节点自身」那一下", () => {
    const root = document.createElement("div");
    root.className = "md-codeblock-widget";
    const inner = document.createElement("pre");
    root.appendChild(inner);
    const onRoot = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(onRoot, "target", { value: root });
    const onInner = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(onInner, "target", { value: inner });
    expect(clickedOnBlockPadding(onRoot, "md-codeblock-widget")).toBe(true);
    expect(clickedOnBlockPadding(onInner, "md-codeblock-widget")).toBe(false);
    expect(clickedOnBlockPadding(new Event("click"), "md-codeblock-widget")).toBe(false);
  });

  it("回写那一发算「自己人」（isBlockSyncing 在事务里为真、事后落下）", async () => {
    const view = decoView(FENCE_DOC);
    parkCaretAt(view, "尾行");
    const code = view.dom.querySelector<HTMLElement>(".md-codeblock-widget code")!;
    let syncingInTr: boolean | null = null;
    // updateListener 是 state facet：只能走 appendConfig，`effects: 一条扩展` 是静默空转
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((u) => {
          if (u.docChanged && syncingInTr === null) syncingInTr = isBlockSyncing();
        }),
      ),
    });
    expect(isBlockSyncing()).toBe(false);
    typeInto(code, "const gate = 1;");
    await tick();
    expect(syncingInTr, "回写没进「自触发」闸门 ⇒ 输入事件会跟着重放，形成回写环").toBe(true);
    expect(isBlockSyncing()).toBe(false);
    view.destroy();
  });
});

describe("B397-3 代码块 widget：打字进得去、DOM 不被换、只读进不去", () => {
  it("结构照 InkNote：外层只管留白，视觉盒/行号栏/语言下拉/复制键各就各位", () => {
    const view = decoView(FENCE_DOC);
    parkCaretAt(view, "尾行");
    const wrap = view.dom.querySelector<HTMLElement>(".md-codeblock-widget");
    expect(wrap).not.toBeNull();
    const box = wrap!.querySelector<HTMLElement>(".md-codeblock-box");
    expect(box, "视觉盒子必须放内层：根元素带 margin 会让 CM 的高度图算不准").not.toBeNull();
    const code = wrap!.querySelector<HTMLElement>("code");
    expect(code!.dataset.blockSource).toBe("1");
    expect(wrap!.querySelector(".md-codeblock-gutter")).not.toBeNull();
    expect(wrap!.querySelector(".md-codeblock-gutter")!.getAttribute("contenteditable")).toBe(
      "false",
    );
    const lang = wrap!.querySelector<HTMLButtonElement>(".md-codeblock-lang");
    expect(lang, "语言下拉是代码块 34px 上内距的存在理由，没它就不该留那块空").not.toBeNull();
    // B404：不再是原生 select —— 展开列表要跟应用菜单同一套视觉（B108 的组件）
    expect(lang!.tagName, "B404 语言下拉换成应用自己的下拉组件").toBe("BUTTON");
    expect(lang!.classList.contains("dropdown-trigger")).toBe(true);
    expect(wrap!.querySelector("select"), "原生 select 必须一个不剩").toBeNull();
    // B409：别名在列表里落到规范条目（`ts` ⇒ TypeScript），源码写法不变
    expect(lang!.closest(".dropdown")!.getAttribute("data-value")).toBe("typescript");
    expect(wrap!.querySelector("button.md-codeblock-copy")).not.toBeNull();
    view.destroy();
  });

  it("在块里打字 ⇒ 围栏源码跟着变（回写走 rAF，等一帧才落）", async () => {
    const view = decoView(FENCE_DOC);
    parkCaretAt(view, "尾行");
    const code = view.dom.querySelector<HTMLElement>(".md-codeblock-widget code")!;
    typeInto(code, "export const b = 2;\nexport const c = 3;");
    await tick();
    const fence = view.state.doc.sliceString(fenceRange(view).from, view.state.doc.length);
    expect(fence).toContain("export const b = 2;\nexport const c = 3;");
    expect(fence).not.toContain("a = 1");
    view.destroy();
  });

  it("装饰重建之后，正在打字的那颗 code 元素还是同一颗（漏 updateDOM 就红）", () => {
    const view = decoView(FENCE_DOC);
    parkCaretAt(view, "尾行");
    const wrap = view.dom.querySelector<HTMLElement>(".md-codeblock-widget")!;
    const code = wrap.querySelector<HTMLElement>("code")!;
    // 直接改文档（模拟回写那一发）：内容变了 ⇒ eq() 为假 ⇒ 只有 updateDOM 能救下这颗 DOM
    const r = fenceRange(view);
    const next = "```ts\nconst zz = 9;\n```";
    view.dispatch({ changes: { from: r.from, to: r.to, insert: next } });
    expect(view.dom.contains(code), "code 元素被整块重建了 ⇒ 光标必然被打掉").toBe(true);
    expect(view.dom.querySelector(".md-codeblock-widget code")).toBe(code);
    expect(wrap.dataset.blockLen).toBe(String(next.length));
    view.destroy();
  });

  it("块内容变了但没在打字 ⇒ updateDOM 把文本刷成新内容", () => {
    const view = decoView(FENCE_DOC);
    parkCaretAt(view, "尾行");
    const code = view.dom.querySelector<HTMLElement>(".md-codeblock-widget code")!;
    const r = fenceRange(view);
    view.dispatch({ changes: { from: r.from, to: r.to, insert: "```ts\nconst zz = 9;\n```" } });
    expect(code.textContent).toContain("const zz = 9");
    view.destroy();
  });

  it("只读锁下：打字进不去、编辑类不加、文档一个字不动", () => {
    const view = decoView(FENCE_DOC, true);
    parkCaretAt(view, "尾行");
    const wrap = view.dom.querySelector<HTMLElement>(".md-codeblock-widget")!;
    const code = wrap.querySelector<HTMLElement>("code")!;
    const before = view.state.doc.toString();
    code.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(wrap.classList.contains("md-block--editing"), "只读还进编辑态就是假可编辑").toBe(false);
    typeInto(code, "import x from 1;");
    keyIn(code, { key: "Escape" });
    expect(view.state.doc.toString()).toBe(before);
    view.destroy();
  });

  it("Esc 回写并把光标交还给编辑器（落在块之后，不是困在组件里）", () => {
    const view = decoView(FENCE_DOC);
    parkCaretAt(view, "尾行");
    const wrap = view.dom.querySelector<HTMLElement>(".md-codeblock-widget")!;
    const code = wrap.querySelector<HTMLElement>("code")!;
    typeInto(code, "const esc = 1;");
    keyIn(code, { key: "Escape" });
    expect(view.state.doc.toString()).toContain("const esc = 1;");
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    expect(line.text, "Esc 之后光标必须落在正文行上").toBe("尾行");
    view.destroy();
  });

  it("清空之后再退格 ⇒ 整块连它后面那个换行一起删", () => {
    const view = decoView(FENCE_DOC);
    parkCaretAt(view, "尾行");
    const code = view.dom.querySelector<HTMLElement>(".md-codeblock-widget code")!;
    typeInto(code, "");
    keyIn(code, { key: "Backspace" });
    expect(view.state.doc.toString()).not.toContain("```");
    expect(view.state.doc.toString()).toContain("# 头");
    expect(view.state.doc.toString()).toContain("尾行");
    view.destroy();
  });

  it("块内 Ctrl+A 只全选这一块的文本", () => {
    const view = decoView(FENCE_DOC);
    parkCaretAt(view, "尾行");
    const code = view.dom.querySelector<HTMLElement>(".md-codeblock-widget code")!;
    code.textContent = "abc";
    keyIn(code, { key: "a", ctrlKey: true });
    const sel = window.getSelection();
    expect(sel!.rangeCount).toBe(1);
    expect(code.contains(sel!.getRangeAt(0).commonAncestorContainer)).toBe(true);
    expect(sel!.toString()).toBe("abc");
    view.destroy();
  });

  it("语言下拉改档 ⇒ 围栏 info string 跟着改（源码仍是唯一权威）", () => {
    const view = decoView(FENCE_DOC);
    parkCaretAt(view, "尾行");
    const trigger = view.dom.querySelector<HTMLButtonElement>(
      ".md-codeblock-widget .md-codeblock-lang",
    )!;
    trigger.click();
    // B405：展开列表挂 body（撑出 `.cm-scroller` 的层叠上下文），不在 widget 里
    // B409：同文件前面还留着别的 view 的关闭态列表 ⇒ 按「展开态」认那一颗
    const list = document.querySelector<HTMLElement>(".dropdown-list.open")!;
    expect(list, "展开的语言列表必须存在").not.toBeNull();
    expect(list.parentElement, "B405：语言列表应挂在 body 下").toBe(document.body);
    const search = list.querySelector<HTMLInputElement>(".dropdown-search");
    expect(search, "B405：语言列表要带搜索框").toBeTruthy();
    search!.value = "pyth";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    const opt = [...list.querySelectorAll<HTMLButtonElement>(".dropdown-option")].find(
      (b) => b.dataset.value === "python",
    );
    expect(opt, "搜索 pyth 后仍要有 python（B404 换成自定义下拉，B405 加搜索）").toBeDefined();
    opt!.click();
    expect(view.state.doc.toString()).toContain("```python\nexport const a = 1;\n```");
    // 只换语言那一路不重写代码（光标保住），但 <pre data-lang> 与高亮要跟上新语言
    expect(view.dom.querySelector<HTMLElement>(".md-codeblock-widget pre")!.dataset.lang).toBe(
      "python",
    );
    view.destroy();
  });

  it("方向键在块边界把焦点交给块内编辑器；不在边界时不许抢", () => {
    const view = decoView(FENCE_DOC);
    const fence = view.state.doc.line(2); // ```ts
    const after = view.state.doc.line(5); // 尾行
    // 光标在「尾行」行首 ⇒ 向上正好贴着块尾
    view.dispatch({ selection: { anchor: after.from } });
    expect(enterAdjacentBlock(view, false, true)).toBe(true);
    expect(document.activeElement?.tagName).toBe("CODE");
    // 光标在行中间 ⇒ 不适用，交回默认移动
    view.dispatch({ selection: { anchor: fence.from + 2 } });
    (document.activeElement as HTMLElement | null)?.blur();
    expect(enterAdjacentBlock(view, false, true)).toBe(false);
    view.destroy();
  });

  it("退出编辑态 ⇒ md-block--editing 摘掉（下次进来才重新显形）", async () => {
    const view = decoView(FENCE_DOC);
    parkCaretAt(view, "尾行");
    const wrap = view.dom.querySelector<HTMLElement>(".md-codeblock-widget")!;
    const code = wrap.querySelector<HTMLElement>("code")!;
    code.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(wrap.classList.contains("md-block--editing")).toBe(true);
    code.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await tick(30);
    expect(wrap.classList.contains("md-block--editing")).toBe(false);
    view.destroy();
  });
});

describe("B405 块内焦点：编辑器选区跟着落位", () => {
  const HTML_DOC = ["**重点**照旧", "", "<div>", "<p>块</p>", "</div>", "", "尾行"].join("\n");

  it("焦点进 HTML 块 ⇒ 选区落到块起点，上一块 markdown 收回渲染样式", () => {
    const view = decoView(HTML_DOC);
    try {
      // 光标压在 `**重点**` 里 ⇒ 这一行显形源码（前提）
      view.dispatch({ selection: { anchor: 2 } });
      expect(view.dom.textContent, "前提：光标行已显形").toContain("**重点**");
      const wrap = view.dom.querySelector<HTMLElement>(".md-html-widget");
      expect(wrap, "夹具应画出 HTML 块 widget").not.toBeNull();
      const source = wrap!.querySelector<HTMLElement>('.md-block-source[data-block-source="1"]')!;
      // 用户那一手：点 HTML 块的渲染结果 ⇒ 只聚焦组件里的 contenteditable，
      // 不经过 CodeMirror ⇒ 选区必须由 focusin 那条钩子补一发
      beginSourceEditing(wrap!, source, false);
      source.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      const range = currentBlockRange(view, wrap!)!;
      expect(view.state.selection.main.head, "选区应停在 HTML 块起点").toBe(range.from);
      expect(view.dom.textContent, "上一块应收回渲染样式").not.toContain("**重点**");
    } finally {
      view.destroy();
    }
  });
});

describe("B409 代码块语言下拉：图标 + 左置 + 语言表扩容", () => {
  it("工具行里语言选择在左、复制键在右（DOM 序 + 样式各管一半）", () => {
    const view = decoView(FENCE_DOC);
    try {
      parkCaretAt(view, "尾行");
      const header = view.dom.querySelector<HTMLElement>(".md-codeblock-header")!;
      const lang = header.querySelector<HTMLElement>(".md-codeblock-language-control")!;
      const copy = header.querySelector<HTMLElement>(".md-codeblock-copy")!;
      expect(header.firstElementChild, "语言选择必须是工具行第一颗").toBe(lang);
      expect(
        lang.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING,
        "复制键排在语言选择之后",
      ).toBeTruthy();
      // 触发器里图标 + 文字编组，图标取自 Seti（与语言模式同一颗）
      const trigger = lang.querySelector<HTMLElement>(".md-codeblock-lang")!;
      const icon = trigger.querySelector<HTMLElement>(".dd-icon .seti-icon");
      expect(icon, "触发器要有 Seti 图标").not.toBeNull();
      expect(trigger.querySelector(".dd-main .dd-label")!.textContent).toBe("TypeScript");
    } finally {
      view.destroy();
    }
  });

  it("展开列表：语言表扩到五十项以上，每行带图标，搜索仍命中", () => {
    const view = decoView(FENCE_DOC);
    try {
      parkCaretAt(view, "尾行");
      (view.dom.querySelector(".md-codeblock-lang") as HTMLButtonElement).click();
      const list = document.querySelector<HTMLElement>(".dropdown-list.open")!;
      const rows = () => [...list.querySelectorAll<HTMLButtonElement>(".dropdown-option")];
      expect(rows().length, "语言表至少 50 项（B409 从 24 项扩容）").toBeGreaterThanOrEqual(50);
      for (const row of rows()) {
        expect(row.querySelector(".dd-icon .seti-icon"), "每行都要有图标").not.toBeNull();
      }
      const values = rows().map((r) => r.dataset.value);
      for (const id of ["rust", "dockerfile", "shellscript", "fortran-fixed-form", "vue"]) {
        expect(values, `语言表缺 ${id}`).toContain(id);
      }
      const search = list.querySelector<HTMLInputElement>(".dropdown-search")!;
      search.value = "coffee";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      expect(rows().map((r) => r.dataset.value)).toEqual(["coffeescript"]);
      expect(search.value, "搜索框还在（同一次展开里不丢）").toBe("coffee");
    } finally {
      view.destroy();
    }
  });

  it("围栏写的是别名（```sh）⇒ 触发器显示 Shell + 图标，列表里落 shellscript 条目", () => {
    const view = decoView(["# 头", "```sh", "echo hi", "```", "尾行"].join("\n"));
    try {
      parkCaretAt(view, "尾行");
      const trigger = view.dom.querySelector<HTMLElement>(".md-codeblock-lang")!;
      expect(trigger.querySelector(".dd-label")!.textContent).toBe("Shell");
      expect(trigger.querySelector(".dd-icon .seti-icon")).not.toBeNull();
      expect(trigger.closest(".dropdown")!.getAttribute("data-value")).toBe("shellscript");
    } finally {
      view.destroy();
    }
  });
});

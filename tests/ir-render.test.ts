// @vitest-environment jsdom
// B352-6 IR 的 CM6 装配：StateField 存块表、ViewPlugin 现算装饰、块级 widget 画渲染结果。
//
// 判据全部挂在**可观测事实**上（DOM 里数节点、比节点身份、看光标落点），不数内部字段：
// CM6 升级时实现细节会变，这些不会。节点身份那条尤其关键 ——「每敲一字全篇重画」是这条路的
// 头号反目标，`eq()` 命中时 CM6 必须复用同一个 DOM 节点，换块表时才许重造。
import { describe, expect, it, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import {
  IrBlockWidget,
  irBlocksOf,
  liveRenderExtensions,
  setIrBlocks,
} from "../src/markdown/live-render";
import { renderBlocks } from "../src/markdown/pipeline";
import { fnBody, stripLineComments } from "./static";

const DOC = "# Title\n";
const BLOCKS = renderBlocks(DOC);

/** 块外那个落点：文档末行（尾随换行后面那行空行）的行首 —— 谁都不挨着。 */
const outside = (s: EditorState): number => s.doc.line(s.doc.lines).from;

let parents: HTMLElement[] = [];

function mount(opts: { ir: boolean; locked: boolean }, doc = DOC) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  parents.push(parent);
  const state = EditorState.create({
    doc,
    extensions: [liveRenderExtensions({ ...opts, baseDir: null })],
  });
  const view = new EditorView({ state, parent });
  view.dispatch({ effects: setIrBlocks.of(renderBlocks(doc)) });
  return { parent, view };
}

afterEach(() => {
  for (const p of parents) p.remove();
  parents = [];
});

describe("B352-6 开关：关态零开销", () => {
  it("liveRenderExtensions({ir:false}) 返回空数组（关态连 StateField 都不进配置）", () => {
    expect(liveRenderExtensions({ ir: false, locked: true, baseDir: null })).toHaveLength(0);
    expect(liveRenderExtensions({ ir: false, locked: false, baseDir: "/x" })).toHaveLength(0);
  });

  it("ir:false 时 irBlocksOf 不抛、给空表（字段不在配置里）", () => {
    const state = EditorState.create({
      doc: DOC,
      extensions: liveRenderExtensions({ ir: false, locked: true, baseDir: null }),
    });
    expect(() => irBlocksOf(state)).not.toThrow();
    expect(irBlocksOf(state)).toEqual([]);
  });

  it("ir:false 的视图里发块表也不产生任何渲染节点", () => {
    const { view, parent } = mount({ ir: false, locked: false });
    expect(parent.querySelectorAll(".md-ir-block")).toHaveLength(0);
    expect(parent.querySelectorAll(".md-ir-focus-line")).toHaveLength(0);
    expect(view.state.doc.toString()).toBe(DOC);
  });
});

describe("B352-6 装饰跟着光标走（ViewPlugin 现算，不产生事务）", () => {
  it("光标进出同一个块 ⇒ 装饰数 1 → 0 → 1", () => {
    const { view, parent } = mount({ ir: true, locked: false });
    const count = () => parent.querySelectorAll(".md-ir-block").length;

    // 光标在块外（末行的空行）⇒ 这一块被渲染
    view.dispatch({ selection: { anchor: outside(view.state) } });
    expect(count(), "光标在块外应渲染该块").toBe(1);
    // 光标进块 ⇒ 露源码
    view.dispatch({ selection: { anchor: 2 } });
    expect(count(), "光标在块内应露源码").toBe(0);
    // 再出来 ⇒ 又渲染
    view.dispatch({ selection: { anchor: outside(view.state) } });
    expect(count(), "光标离开后应重新渲染").toBe(1);
  });

  it("重算装饰不产生文档事务（selectionSet 只是选区，编辑历史不许被污染）", () => {
    const { view } = mount({ ir: true, locked: false });
    const before = view.state.doc.toString();
    view.dispatch({ selection: { anchor: 2 } });
    view.dispatch({ selection: { anchor: outside(view.state) } });
    expect(view.state.doc.toString(), "文档必须一字未动").toBe(before);
  });

  it("锁态零焦点例外：光标在块里也照样全渲染", () => {
    const { view, parent } = mount({ ir: true, locked: true });
    view.dispatch({ selection: { anchor: 2 } });
    expect(parent.querySelectorAll(".md-ir-block")).toHaveLength(1);
    expect(parent.querySelector(".md-ir-focus-line"), "锁态不该有焦点行").toBeNull();
  });

  it("eq 命中 ⇒ 没动的那块复用同一个 DOM 节点；换了 html 的块必须重造", () => {
    const doc = "# A\n\npara one\npara two\n\n- x\n- y\n";
    const { view, parent } = mount({ ir: true, locked: false }, doc);
    // 光标进段落（第 3 行）⇒ 标题与列表都渲染
    view.dispatch({ selection: { anchor: view.state.doc.line(3).from + 1 } });
    const heading = parent.querySelector('[data-line-start="1"]');
    expect(parent.querySelectorAll(".md-ir-block").length, "标题与列表两块该渲染").toBe(2);
    // 光标改挪进列表：标题那块的区间与 html 都没变 ⇒ CM6 必须复用节点
    //（⚠️ 别用「光标进出同一块」测这条 —— 那一形里节点**必然**被销毁重建，eq 无从命中）
    view.dispatch({ selection: { anchor: view.state.doc.line(5).from + 1 } });
    expect(parent.querySelector('[data-line-start="1"]'), "eq 命中时节点身份必须不变").toBe(
      heading,
    );
    // 换一份标题的 html ⇒ 必须重造（否则上面那条断言毫无鉴别力）
    view.dispatch({
      effects: setIrBlocks.of([
        { lineStart: 1, lineEnd: 1, html: "<h1>Changed</h1>" },
        { lineStart: 3, lineEnd: 4, html: "<p>para</p>" },
        { lineStart: 5, lineEnd: 6, html: "<ul><li>x</li></ul>" },
      ]),
    });
    view.dispatch({ selection: { anchor: view.state.doc.line(3).from + 1 } });
    expect(parent.querySelector('[data-line-start="1"]')).not.toBe(heading);
    expect(parent.querySelector('[data-line-start="1"]')?.textContent).toContain("Changed");
  });
});

describe("B352-6 widget 的 DOM 形状", () => {
  it("外层带 md-rendered/md-ir-block，内层 md-block 带行号 data-*，内容等于该块 html", async () => {
    const { view, parent } = mount({ ir: true, locked: false });
    view.dispatch({ selection: { anchor: outside(view.state) } });
    const outer = parent.querySelector(".md-ir-block");
    expect(outer?.className).toContain("md-rendered");
    const inner = outer?.querySelector(".md-block");
    expect(inner, "内层要有 .md-block（预览同款排版类）").toBeTruthy();
    expect(inner?.getAttribute("data-line-start")).toBe("1");
    expect(inner?.getAttribute("data-line-end")).toBe("1");
    await Promise.resolve();
    expect(inner?.innerHTML).toContain(BLOCKS[0].html.trim());
  });

  it("块表为空（还没算过）时不崩、不渲染", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    parents.push(parent);
    const state = EditorState.create({
      doc: DOC,
      extensions: liveRenderExtensions({ ir: true, locked: false, baseDir: null }),
    });
    const view = new EditorView({ state, parent });
    expect(parent.querySelectorAll(".md-ir-block")).toHaveLength(0);
    expect(view.state.doc.toString()).toBe(DOC);
  });
});

describe("B352-6 事件放行与焦点行", () => {
  it("ignoreEvent：mousedown 放行（true=编辑器忽略），click/keydown 一律不吃", () => {
    const w = new IrBlockWidget({
      lineStart: 1,
      lineEnd: 1,
      html: "<h1>T</h1>",
      editable: true,
      baseDir: null,
    });
    expect(w.ignoreEvent(new MouseEvent("mousedown")), "mousedown 要放行给编辑器以外的处理").toBe(
      true,
    );
    expect(w.ignoreEvent(new MouseEvent("click"))).toBe(false);
    expect(w.ignoreEvent(new KeyboardEvent("keydown"))).toBe(false);
    expect(w.ignoreEvent(new MouseEvent("mousemove"))).toBe(false);
  });

  it("点渲染块 ⇒ 光标必须落进这一块（反查给块外位置时夹回块首）", () => {
    const { view, parent } = mount({ ir: true, locked: false });
    view.dispatch({ selection: { anchor: outside(view.state) } });
    const block = parent.querySelector(".md-ir-block")!;
    block.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 40, clientY: 12 }));
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    expect(head, "落点必须落在被点的那一块（第 1 行）里").toBe(view.state.doc.line(1).from);
    expect(line.number, "别把光标甩到隔壁行去").toBe(1);
  });

  it("锁态下点渲染块不动光标（锁的口径不许靠 changeFilter 兜）", () => {
    const { view, parent } = mount({ ir: true, locked: true });
    const before = view.state.selection.main.head;
    const block = parent.querySelector(".md-ir-block")!;
    block.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 40, clientY: 12 }));
    expect(view.state.selection.main.head, "锁态下这次点击不该改选区").toBe(before);
  });

  it("焦点行装饰只给露源码那一块的首行，类名 md-ir-focus-line", () => {
    const doc = "# Title\n\nline A\nline B\n";
    const { view, parent } = mount({ ir: true, locked: false }, doc);
    view.dispatch({ selection: { anchor: view.state.doc.line(3).from + 1 } });
    const focus = parent.querySelectorAll(".md-ir-focus-line");
    expect(focus, "只该有一行带焦点标识").toHaveLength(1);
    // 段落首行（第 3 行）渲染出来的那一行 DOM 带类名
    expect(focus[0].textContent, "焦点标识落在段落首行的行盒上").toContain("line A");
    expect(
      parent.querySelectorAll(".md-ir-block"),
      "标题与列表都没被盖？只有标题该被盖",
    ).toHaveLength(1);
  });
});

describe("B352-6 结构判据", () => {
  it("块刷新只有一个写点：挂在预览那个防抖里，派发 setIrBlocks 的地方全仓只有一处", () => {
    const md = stripLineComments(readFileSync("src/markdown.ts", "utf-8"));
    expect(fnBody(md, "scheduleMdRender"), "IR 要复用预览那发防抖，不许另开定时器").toMatch(
      /refreshIr\(/,
    );
    expect(md.match(/setIrBlocks\.of\(/g) ?? [], "派发块表的地方必须只有一处").toHaveLength(1);
    const body = fnBody(md, "refreshIr");
    expect(body, "关态必须早退（源码面一分钱不花）").toMatch(
      /liveRender === "off"[\s\S]{0,60}return/,
    );
    expect(body, "非 md 文档也要早退").toMatch(/isMdTab\(tab\)/);
  });

  it("装饰只在 liveRenderExtensions 里出，不许把 foldGutter 一起拖进来（spec：二者互斥）", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    parents.push(parent);
    const state = EditorState.create({
      doc: DOC,
      extensions: [liveRenderExtensions({ ir: true, locked: false, baseDir: null })],
    });
    const view = new EditorView({ state, parent });
    view.dispatch({ effects: setIrBlocks.of(BLOCKS) });
    view.dispatch({ selection: { anchor: outside(view.state) } });
    expect(parent.querySelectorAll(".md-ir-block").length, "装饰确实生效了").toBeGreaterThan(0);
    expect(parent.querySelector(".cm-foldGutter"), "IR 层自己不该注入折叠槽").toBeNull();
  });
});

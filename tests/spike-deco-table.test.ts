// @vitest-environment jsdom
// B397-3b · 表格 widget 的就地编辑（壳移植自 InkNote src/editor/widgets/table.ts，1726 行那份）。
//
// 与代码块那一格（tests/spike-deco-blockedit.test.ts）同一条主线，但表格多两件事：
//
//   1. **表格源码不是整段文本，是一张矩阵** ⇒ 必须有自己的解析/序列化
//      （InkNote 不用语法树拆格：lezer 只给 Table 节点的 from/to，格内容它不拆）。
//      这一对函数是「打字 → 回写 → 再解析」这条环的地基，所以先按纯函数钉死。
//   2. **回写不许打断正在输入的那一颗单元格** ⇒ `updateDOM` 里跳过聚焦格
//      （table.ts:1697/1709），同时结构真的变了（增删行列）必须 `return false` 走重建
//      （table.ts:1673-1677）—— 少了前半句光标会没，少了后半句表格会变成半新半旧。
//
// ⚠️ jsdom 不实现 contenteditable 的编辑行为：测试里「打字」= 改 textContent + 发一条
// `input` 事件（attachCellEvents 监听的就是这条）。另：jsdom 的 `contentEditable` setter
// **不落属性**，而焦点与「这格能不能编辑」都按属性判 ⇒ 本文件所有属性判据同时也是在钉
// 实现必须用 `setAttribute`（见 pitfalls/cm6-api-facets-and-changeset 第 12 条）。

import { EditorState, StateEffect, Text, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { describe, expect, it } from "vitest";
import { currentBlockRange } from "../src/spike/deco/blockRange";
import {
  mutateTableData,
  parseTable,
  serializeTable,
  type TableData,
} from "../src/spike/deco/tableData";
import { TableWidget, isTableSyncing, renderInlineMarkdown } from "../src/spike/deco/tableWidget";
import { decoFace, decoLock } from "../src/spike/deco/wysiwyg";

// ⚠️ 三张表后面都留一个空行：GFM 的表格直到空行才断，`| 1 | 2 |` 紧跟着一行正文时
// 那一行会被算进 `Table` 节点 ⇒ 装饰面把「尾行」也当成表格第四行（真机同理，不是夹具病）。
const TABLE_DOC = ["# 头", "| 甲 | 乙 |", "| --- | --- |", "| 1 | 2 |", "", "尾行"].join("\n");
const ALIGN_DOC = ["| 甲 | 乙 |", "|:---:|---:|", "| 1 | 2 |", "", "尾行"].join("\n");
const RICH_DOC = ["| 甲 | 乙 |", "| --- | --- |", "| **粗** `c` | x<br>y |", "", "尾行"].join("\n");

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

function parkCaretAt(view: EditorView, lineText: string): void {
  for (let n = 1; n <= view.state.doc.lines; n++) {
    const line = view.state.doc.line(n);
    if (line.text === lineText) {
      view.dispatch({ selection: { anchor: line.from } });
      return;
    }
  }
  throw new Error(`夹具里没有整行等于 ${JSON.stringify(lineText)} 的行`);
}

const tick = (ms = 12) => new Promise((r) => setTimeout(r, ms));

/** 装饰档此刻那张表（判据先证「画出来了」，否则后面全是空转）。 */
function tableWrap(view: EditorView): HTMLElement {
  const wrap = view.dom.querySelector<HTMLElement>(".md-table-widget");
  if (!wrap) throw new Error("装饰档没画出表格 widget，这条判据就是空转");
  return wrap;
}

/** 第 row 行（0 = 表头）第 col 列的单元格（nth-child 从 1 数起，row/col 都是 0 起）。 */
function cellAt(wrap: HTMLElement, row: number, col: number): HTMLElement {
  const sel =
    row === 0
      ? `thead th:nth-child(${col + 1})`
      : `tbody tr:nth-child(${row}) td:nth-child(${col + 1})`;
  const el = wrap.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`夹具里没有第 ${row} 行第 ${col} 列这一格`);
  return el;
}

/** 模拟「在格子里打字」：改 textContent + 发 input（attachCellEvents 监听的就是这条）。 */
function typeIntoCell(cell: HTMLElement, text: string): void {
  cell.textContent = text;
  cell.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

function keyIn(el: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
}

function pressToolbar(view: EditorView, action: string): void {
  const btn = tableWrap(view).querySelector<HTMLElement>(
    `.md-table-toolbar [data-action="${action}"]`,
  );
  if (!btn) throw new Error(`工具栏里没有 ${action} 这一键`);
  btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
}

function tableSource(view: EditorView, wrap: HTMLElement): string {
  const range = currentBlockRange(view, wrap);
  if (!range) throw new Error("表格 DOM 反查不到源码区间");
  return view.state.doc.sliceString(range.from, range.to);
}

const snap = (data: TableData): string => JSON.stringify(data);

describe("B397-3b 源码 ↔ 数据：手写解析器（语法树只给 Table 的 from/to，格内容它不拆）", () => {
  const parse = (lines: string[]): TableData => {
    const doc = Text.of(lines);
    return parseTable({ from: 0, to: doc.length }, doc);
  };

  it("拆格只认未转义的竖线，\\| 还原成 |", () => {
    const data = parse(["| 甲\\|乙 | 丙 |", "| --- | --- |", "| 1 | 2 |"]);
    expect(data.header).toEqual(["甲|乙", "丙"]);
    expect(data.rows).toEqual([["1", "2"]]);
  });

  it("分隔行认三种对齐档位；:--- 左、:---: 中、---: 右", () => {
    expect(parse(["| a | b | c |", "|:---|:-:|---:|", "| 1 | 2 | 3 |"]).aligns).toEqual([
      "left",
      "center",
      "right",
    ]);
    // 不是分隔行时不许当分隔行用（bodyStart 仍是 1）
    const noDelim = parse(["| a | b |", "| 1 | 2 |"]);
    expect(noDelim.aligns).toEqual(["left", "left"]);
    expect(noDelim.rows).toEqual([["1", "2"]]);
  });

  it("手写表格的残缺行补成矩形 —— 否则单元格索引全乱", () => {
    const data = parse(["| a | b | c |", "| --- | ---: |", "| 1 |"]);
    expect(data.rows).toEqual([["1", "", ""]]);
    expect(data.aligns).toEqual(["left", "right", "left"]);
    expect(data.header).toEqual(["a", "b", "c"]);
  });

  it("序列化往返恒等，且每格都成 | x | 形状、把 | 转义、把换行写成 <br>", () => {
    const src = ["| 甲 | 乙 |", "| --- | :---: |", "| 1 | 2 |"].join("\n");
    const doc = Text.of(src.split("\n"));
    const first = parseTable({ from: 0, to: doc.length }, doc);
    expect(serializeTable(first.header, first.rows, first.aligns)).toBe(src);

    const tricky = serializeTable(["含|竖线", "x"], [["上\n下"]], ["center"]);
    expect(tricky).toBe("| 含\\|竖线 | x |\n| :---: | --- |\n| 上<br>下 |  |");
  });

  it("mutateTableData 是纯函数：入参一个字节都不许动", () => {
    const data: TableData = { header: ["a", "b"], rows: [["1", "2"]], aligns: ["left", "center"] };
    const before = snap(data);
    mutateTableData(data, 1, 1, "row-below");
    mutateTableData(data, 0, 0, "col-left");
    mutateTableData(data, 1, 1, "align-right");
    expect(snap(data)).toBe(before);
  });

  it("行操作：表头上下插入把表头让位、删表头把首行升格", () => {
    const data: TableData = { header: ["a", "b"], rows: [["1", "2"]], aligns: ["left", "left"] };

    const below = mutateTableData(data, 1, 0, "row-below")!;
    expect(below.data.rows).toEqual([
      ["1", "2"],
      ["", ""],
    ]);
    expect(below.focus).toEqual({ row: 2, col: 0 });

    const atHeader = mutateTableData(data, 0, 0, "row-above")!;
    expect(atHeader.data.header).toEqual(["", ""]);
    expect(atHeader.data.rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(atHeader.focus.row).toBe(0);

    const dropHeader = mutateTableData(data, 0, 1, "row-delete")!;
    expect(dropHeader.data.header).toEqual(["1", "2"]);
    expect(dropHeader.data.rows).toEqual([]);

    const dropBody = mutateTableData(data, 1, 1, "row-delete")!;
    expect(dropBody.data.rows).toEqual([]);
    expect(dropBody.focus.row, "数据行删光了就夹回表头那一行，不许指向不存在的行").toBe(0);
  });

  it("列操作：左右插入落在正确位置，最后一列不许删", () => {
    const data: TableData = { header: ["a", "b"], rows: [["1", "2"]], aligns: ["left", "center"] };

    const right = mutateTableData(data, 0, 1, "col-right")!;
    expect(right.data.header).toEqual(["a", "b", ""]);
    expect(right.data.rows).toEqual([["1", "2", ""]]);
    expect(right.data.aligns).toEqual(["left", "center", "left"]);
    expect(right.focus).toEqual({ row: 0, col: 2 });

    const left = mutateTableData(data, 0, 0, "col-left")!;
    expect(left.data.header).toEqual(["", "a", "b"]);

    const drop = mutateTableData(data, 0, 0, "col-delete")!;
    expect(drop.data.header).toEqual(["b"]);
    expect(drop.data.aligns).toEqual(["center"]);

    const oneCol: TableData = { header: ["a"], rows: [["1"]], aligns: ["left"] };
    expect(mutateTableData(oneCol, 0, 0, "col-delete")).toBeNull();
    expect(
      mutateTableData(data, 0, 0, "delete"),
      "整张表的删除走 widget 那条路，不在这里",
    ).toBeNull();
  });

  it("对齐只改被点中那一列（Markdown 的对齐本来就是整列属性）", () => {
    const data: TableData = { header: ["a", "b"], rows: [["1", "2"]], aligns: ["left", "left"] };
    const centered = mutateTableData(data, 1, 1, "align-center")!;
    expect(centered.data.aligns).toEqual(["left", "center"]);
  });
});

describe("B397-3b 单元格 DOM：工具栏槽 + 表体壳 + 可编辑格（table.ts:1622-1664）", () => {
  it("结构与属性照 InkNote，描边圆角在 .md-table-body 那一层", () => {
    const view = decoView(TABLE_DOC);
    parkCaretAt(view, "尾行");
    const wrap = tableWrap(view);
    expect(wrap.querySelector(".md-table-toolbar-slot .md-table-toolbar")).not.toBeNull();
    expect(
      wrap.querySelector(".md-table-body > table > tbody"),
      "表格 DOM 走 md-table-body 这层壳：根元素只管纵向留白",
    ).not.toBeNull();

    const th = cellAt(wrap, 0, 0);
    const td = cellAt(wrap, 1, 0);
    expect(th.getAttribute("contenteditable"), "属性而不是反射属性：jsdom 只认属性").toBe("true");
    expect(td.getAttribute("contenteditable")).toBe("true");
    expect(td.spellcheck).toBe(false);
    expect(td.dataset.col).toBe("0");
    expect(wrap.dataset.blockLen).toBe(
      String(["| 甲 | 乙 |", "| --- | --- |", "| 1 | 2 |"].join("\n").length),
    );
    expect(th.textContent).toBe("甲");
    expect(td.textContent).toBe("1");
    view.destroy();
  });

  it("未聚焦的格子显示渲染后的行内 Markdown，聚焦的那格保持源码", () => {
    const view = decoView(RICH_DOC);
    parkCaretAt(view, "尾行");
    const wrap = tableWrap(view);
    const code = cellAt(wrap, 1, 0);
    const br = cellAt(wrap, 1, 1);
    expect(code.innerHTML).toContain("<strong>粗</strong>");
    expect(code.innerHTML).toContain("<code>c</code>");
    expect(code.innerHTML).not.toContain("**");
    expect(br.innerHTML).toContain("<br>");

    br.focus();
    br.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(br.textContent).toBe("x\ny");
    expect(code.dataset.raw).toBe("**粗** `c`");
    view.destroy();
  });

  it("renderInlineMarkdown：链接只落 data-href（不带 href），恶意协议退化成文本", () => {
    expect(renderInlineMarkdown("[字](https://e.com)")).toContain('data-href="https://e.com"');
    expect(renderInlineMarkdown("[字](https://e.com)")).not.toMatch(/<a[^>]+\shref=/);
    const evil = renderInlineMarkdown("[点](javascript:alert)");
    expect(evil).toBe("点");
    expect(evil).not.toContain("<a");
    expect(renderInlineMarkdown("<i>x</i>")).toBe("&lt;i&gt;x&lt;/i&gt;");
  });
});

describe("B397-3b 就地编辑：打字回写、同一颗 DOM 不被换、只读进不去", () => {
  it("在格子里打字 ⇒ 文档那一格跟着变，那一发带 userEvent=input.table 且走自触发闸", async () => {
    const view = decoView(TABLE_DOC);
    parkCaretAt(view, "尾行");
    const wrap = tableWrap(view);
    const td = cellAt(wrap, 1, 0);

    const userEvents: (string | undefined)[] = [];
    let syncingInTr: boolean | null = null;
    // updateListener 是 state facet：只能走 appendConfig（`effects: 一条扩展`是静默空转）
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          // userEvent 是**注解**不是属性（`tr.userEvent` 恒 undefined，要按注解读）
          for (const tr of u.transactions) userEvents.push(tr.annotation(Transaction.userEvent));
          if (syncingInTr === null) syncingInTr = isTableSyncing();
        }),
      ),
    });
    expect(isTableSyncing()).toBe(false);

    td.focus();
    typeIntoCell(td, "甲改");
    await tick();

    expect(tableSource(view, tableWrap(view))).toContain("甲改");
    expect(userEvents, "回写没打表格的标记 ⇒ 镜像/历史分不清这是哪一发").toContain("input.table");
    expect(syncingInTr, "回写没进自触发闸 ⇒ 输入事件会跟着重放，形成回写环").toBe(true);
    expect(isTableSyncing()).toBe(false);
    view.destroy();
  });

  it("回写不许把 :---: / ---: 冲掉（对齐住在分隔行，只能靠 wrap 上的记账带走）", async () => {
    const view = decoView(ALIGN_DOC);
    parkCaretAt(view, "尾行");
    const wrap = tableWrap(view);
    expect(
      wrap.dataset.tableAligns,
      "对齐档位要在 DOM 上记账，否则 readTableFromDom 读不回来",
    ).toBe("center,right");

    const td = cellAt(wrap, 1, 1);
    td.focus();
    typeIntoCell(td, "改");
    await tick();

    const src = tableSource(view, tableWrap(view));
    expect(src).toContain(":---:");
    expect(src).toContain("---:");
    expect(src).toContain("改");
    view.destroy();
  });

  it("打字之后那颗 td 还是同一颗、内容仍是打字中的文本（漏 updateDOM 或没跳过聚焦格就红）", async () => {
    const view = decoView(TABLE_DOC);
    parkCaretAt(view, "尾行");
    const wrap = tableWrap(view);
    const td = cellAt(wrap, 1, 0);
    td.focus();
    td.textContent = "打字中";
    td.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await tick();

    const live = tableWrap(view);
    expect(live.contains(td), "整块重建 ⇒ 光标必然被打掉").toBe(true);
    expect(td.textContent, "updateDOM 重写了正在输入的格子，光标同样被打掉").toBe("打字中");
    expect(cellAt(live, 1, 1).textContent).toBe("2");
    view.destroy();
  });

  it("没在打字的格子跟着文档刷新（外部改动要落进 DOM）", () => {
    const view = decoView(TABLE_DOC);
    parkCaretAt(view, "尾行");
    const wrap = tableWrap(view);
    const td = cellAt(wrap, 1, 1);
    const range = currentBlockRange(view, wrap)!;
    view.dispatch({
      changes: {
        from: range.from,
        to: range.to,
        insert: ["| 甲 | 乙 |", "| --- | --- |", "| 1 | 99 |"].join("\n"),
      },
    });
    expect(tableWrap(view).contains(td)).toBe(true);
    expect(td.dataset.raw).toBe("99");
    expect(td.textContent).toBe("99");
    view.destroy();
  });

  it("eq 只比内容与长度：上方一编辑位置变了不算重建，内容变了也不算重建（走 updateDOM）", () => {
    const a = new TableWidget(0, 32, ["甲", "乙"], [["1", "2"]], ["left", "left"]);
    const b = new TableWidget(9, 41, ["甲", "乙"], [["1", "2"]], ["left", "left"]);
    expect(a.eq(b)).toBe(true);
    expect(a.eq(new TableWidget(0, 32, ["甲", "乙"], [["1", "9"]], ["left", "left"]))).toBe(false);
    expect(
      a.eq(new TableWidget(0, 32, ["甲", "乙"], [["1", "2"]], ["center", "left"])),
      "对齐变了也是变化",
    ).toBe(false);
  });

  it("Tab 进下一格、Shift+Tab 回前一格；Enter 在格内换行而不是拆表", async () => {
    const view = decoView(TABLE_DOC);
    parkCaretAt(view, "尾行");
    const wrap = tableWrap(view);
    const first = cellAt(wrap, 1, 0);
    const second = cellAt(wrap, 1, 1);

    first.focus();
    keyIn(first, { key: "Tab" });
    expect(document.activeElement).toBe(second);
    keyIn(second, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(first);

    // 回车落在**下一格**：Shift+Tab 把光标放回了第一格开头，往那里插换行会变成 `<br>1`
    keyIn(second, { key: "Enter" });
    await tick();
    const src = tableSource(view, tableWrap(view));
    expect(src, "格内换行写成 <br> 存回源码").toContain("| 1 | 2<br> |");
    expect(src.split("\n"), "表还是那三行，没被回车拆开").toHaveLength(3);
    view.destroy();
  });

  it("Esc 落到表后正文；第一格开头再退格落到表上方那一行", () => {
    const view = decoView(TABLE_DOC);
    parkCaretAt(view, "尾行");
    const wrap = tableWrap(view);
    const first = cellAt(wrap, 1, 0);
    first.focus();
    keyIn(first, { key: "Escape" });
    const head = view.state.selection.main.head;
    const range = currentBlockRange(view, tableWrap(view))!;
    expect(head, "Esc 之后光标必须落到表之外").toBeGreaterThan(range.to);
    expect(view.state.doc.lineAt(head).text).toBe("");

    const view2 = decoView(TABLE_DOC);
    parkCaretAt(view2, "尾行");
    const headerCell = cellAt(tableWrap(view2), 0, 0);
    headerCell.focus();
    keyIn(headerCell, { key: "Backspace" });
    expect(
      view2.state.doc.lineAt(view2.state.selection.main.head).text,
      "表头第一格退格要落到上一行，不是把表头删掉",
    ).toBe("# 头");
    view.destroy();
    view2.destroy();
  });

  it("工具栏增删行列：结构真的变了 ⇒ 走重建，且焦点落在新那一行", async () => {
    const view = decoView(TABLE_DOC);
    parkCaretAt(view, "尾行");
    pressToolbar(view, "row-below");
    await tick();

    const wrap = tableWrap(view);
    const src = tableSource(view, wrap);
    expect(src.split("\n"), `插入行要先落进源码，DOM 只是它的投影：\n${src}`).toHaveLength(4);
    expect(wrap.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(document.activeElement?.tagName).toBe("TD");
    expect(
      document.activeElement?.parentElement,
      "表头下方插入 ⇒ 新那一行成为第一条数据行，焦点跟着落进去",
    ).toBe(wrap.querySelectorAll("tbody tr")[0]);

    pressToolbar(view, "col-delete");
    const after = tableWrap(view);
    expect(after.querySelectorAll("thead th")).toHaveLength(1);
    expect(tableSource(view, after)).toContain("| 乙 |");
    view.destroy();
  });

  it("工具栏对齐只作用到被点中那一列（对齐本来就是 Markdown 的整列属性）；删表连后随换行一起消失", () => {
    const view = decoView(
      ["| 甲 | 乙 | 丙 |", "|:---:|---:|---|", "| 1 | 2 | 3 |", "", "尾行"].join("\n"),
    );
    parkCaretAt(view, "尾行");
    cellAt(tableWrap(view), 1, 2).focus();
    pressToolbar(view, "align-right");

    const src = tableSource(view, tableWrap(view));
    expect(src).toContain("| :---: | ---: | ---: |");
    expect(cellAt(tableWrap(view), 1, 2).style.textAlign).toBe("right");
    expect(cellAt(tableWrap(view), 0, 0).style.textAlign).toBe("center");

    pressToolbar(view, "delete");
    expect(view.state.doc.toString()).not.toContain("| 甲");
    expect(view.state.doc.toString()).toContain("尾行");
    view.destroy();
  });

  it("只读锁：点格子先把可编辑关掉、打字不回写、按键被吞掉、文档一个字不动", () => {
    const view = decoView(TABLE_DOC, true);
    parkCaretAt(view, "尾行");
    const wrap = tableWrap(view);
    const td = cellAt(wrap, 1, 0);
    const before = view.state.doc.toString();

    td.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(td.getAttribute("contenteditable"), "只读还留着 true 就是假可编辑").toBe("false");

    typeIntoCell(td, "不该进去");
    const esc = keyIn(td, { key: "Escape" });
    expect(esc.defaultPrevented, "只读档按键要吞掉，不能让原生编辑吃掉").toBe(true);
    expect(view.state.doc.toString()).toBe(before);
    view.destroy();
  });

  it("ignoreEvent：点在外层留白交还编辑器，格子里的事件一律自理", () => {
    const widget = new TableWidget(0, 32, ["甲"], [["1"]], ["left"]);
    const root = document.createElement("div");
    root.className = "md-table-widget";
    const onPadding = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(onPadding, "target", { value: root });
    expect(widget.ignoreEvent(onPadding), "外层留白那一发要交还 CM 定位光标").toBe(false);

    const onCell = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(onCell, "target", { value: document.createElement("td") });
    expect(widget.ignoreEvent(onCell), "格子里的事件 CM 一律不插手，否则原生输入被吃掉").toBe(true);
  });
});

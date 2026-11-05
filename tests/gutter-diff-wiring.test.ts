// @vitest-environment jsdom
// B458 · diff 标注接进 CM6 gutter 的那一段（行级比对内核见 tests/gutter-diff.test.ts）。
//
// 这里只管四件事：
//   1) 那一列在 DOM 里存在，且**干净文档一格标记都不画**（不能把「没改过」画成「改过」）；
//   2) 三色落在**正确的行格**上（尤其那道红缝属于被删块后面那一行）；
//   3) 键入时标记跟着文字挪 —— 不等重算也不至指错行（CM6 的 RangeSet.map）；
//   4) 基线换了（保存那一类「正文没动、基线动了」）必须重新问一次，不能把旧 diff 冻在行号上。
//
// ⚠️ 按下标寻行成立的前提是「可见行 = 全部行」：jsdom 没有真布局，CM6 的视口兜底会把这一小篇
// 全画出来。这条前提由 `rowAt` 自己守着 —— 它先数格数，不够就报「前提不成立」而不是判个假绿。

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { EditorView } from "@codemirror/view";
import { fnBody } from "./static";
import { createEditor, makeTabState } from "../src/editor/editor";
import { perfProfileFor } from "../src/editor/perf";
import { refreshGutterDiff } from "../src/editor/gutterDiff";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Harness {
  view: EditorView;
  /** 模拟一次保存：`doc.baseline` 被整体换成当前正文（provider 是活的，读取口跟着变） */
  save: () => void;
  /** 模拟外部重载 / 改名那类「基线未知」 */
  forgetBaseline: () => void;
}

function mount(current: string, baseline: string | null): Harness {
  const box: { baseline: string | null } = { baseline };
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const { state } = makeTabState(
    current,
    null,
    { dark: false, wrap: true, perf: perfProfileFor("normal"), baseline: () => box.baseline },
    () => {},
  );
  const { view } = createEditor(parent, state);
  return {
    view,
    save: () => {
      box.baseline = view.state.doc.toString();
    },
    forgetBaseline: () => {
      box.baseline = null;
    },
  };
}

/** 那一列的行格（`renderEmptyElements: true` ⇒ 空行也画格，下标就是可见行序）。 */
const cells = (view: EditorView): HTMLElement[] => [
  ...view.dom.querySelectorAll<HTMLElement>(".cm-diffGutter .cm-gutterElement"),
];

function rowAt(view: EditorView, line: number): HTMLElement {
  const els = cells(view);
  if (els.length < view.state.doc.lines) {
    throw new Error(
      `只画了 ${els.length}/${view.state.doc.lines} 行，按下标寻行的前提不成立（不是产品缺陷）`,
    );
  }
  return els[line - 1];
}

/** 这一行的格子上有没有那颗类（`cm-diff-mark` 是「有标记」的总开关）。 */
function has(view: EditorView, line: number, cls: string): boolean {
  return rowAt(view, line).className.split(" ").includes(cls);
}

const markedRows = (view: EditorView): number[] =>
  cells(view)
    .map((el, i) => (el.className.includes("cm-diff-mark") ? i + 1 : 0))
    .filter((n) => n > 0);

afterEach(() => {
  for (const el of document.querySelectorAll("div.cm-editor")) el.parentElement?.remove();
  document.body.textContent = "";
});

describe("B458 · gutter 那一列的接线", () => {
  it("列在，且没偏离基线时一格都不画", async () => {
    const { view } = mount("A\nB\nC", "A\nB\nC");
    await wait(60); // 首帧刷新（插件挂载后排的 0ms）
    expect(cells(view).length, "干净文档也要有格：列宽不能随标记有无跳").toBe(3);
    expect(markedRows(view)).toEqual([]);
  });

  it("改一行 ⇒ 橙落在那一行的格子上，上下格干净", async () => {
    const { view } = mount("A\nB\nC\nD\nE", "A\nB\nC\nD\nE");
    view.dispatch({ changes: { from: 2, to: 3, insert: "X" } }); // 第 2 行 B → X
    await wait(300);
    expect(has(view, 2, "cm-diff-mod"), rowAt(view, 2).className).toBe(true);
    expect(markedRows(view)).toEqual([2]);
  });

  it("插一行 ⇒ 那一格是绿，后面的行不被连累", async () => {
    const { view } = mount("A\nB\nD\nE", "A\nB\nD\nE");
    view.dispatch({ changes: { from: 4, insert: "C\n" } }); // 补回一行 ⇒ 现在的第 3 行
    await wait(300);
    expect(view.state.doc.toString()).toBe("A\nB\nC\nD\nE");
    expect(has(view, 3, "cm-diff-add"), rowAt(view, 3).className).toBe(true);
    expect(markedRows(view)).toEqual([3]);
  });

  it("删掉中间两行 ⇒ 那道红缝挂在被删块后面那一行的格子上（方案 B）", async () => {
    const { view } = mount("1\n2\n3\n4\n5\n6\n7", "1\n2\n3\n4\n5\n6\n7");
    // 摘掉原先的第 5、6 行 ⇒ 现在的第 5 行是原先的第 7 行
    view.dispatch({ changes: { from: 8, to: 12 } });
    await wait(300);
    expect(view.state.doc.toString()).toBe("1\n2\n3\n4\n7");
    expect(has(view, 5, "cm-diff-del-top"), rowAt(view, 5).className).toBe(true);
    expect(markedRows(view), "一块删除只画一道缝").toEqual([5]);
  });

  it("同一行既改了又挨着缝 ⇒ 两颗类一起给（让位是 CSS 那一层的事）", async () => {
    const { view } = mount("A\nB\nC\nD\nE", "A\nB\nC\nD\nE");
    // 改第 2 行的 B，同时删掉第 3 行的 C ⇒ 缝属于现在的第 3 行（D）
    view.dispatch({
      changes: [
        { from: 2, to: 3, insert: "X" },
        { from: 4, to: 6 },
      ],
    });
    await wait(300);
    expect(view.state.doc.toString()).toBe("A\nX\nD\nE");
    expect(has(view, 2, "cm-diff-mod"), rowAt(view, 2).className).toBe(true);
    expect(has(view, 3, "cm-diff-del-top"), rowAt(view, 3).className).toBe(true);
  });

  // 键入过程中不做全量重算，靠 RangeSet 跟着改动映射：这条判据必须**不等防抖**就读。
  it("顶部插一行 ⇒ 已有的标记跟着往下挪一格（不等重算也不指错行）", async () => {
    const { view } = mount("A\nB\nC\nD\nE", "A\nB\nC\nD\nE");
    view.dispatch({ changes: { from: 6, to: 7, insert: "X" } }); // 第 4 行 D → X
    await wait(300);
    expect(markedRows(view)).toEqual([4]);
    view.dispatch({ changes: { from: 0, insert: "Z\n" } }); // 顶头插一行
    expect(markedRows(view), "映射之后该跟着挪到第 5 行").toEqual([5]);
  });

  it("保存（基线换成当前正文）⇒ 一格标记都不留", async () => {
    const { view, save } = mount("A\nB\nC\nD\nE", "A\nB\nC\nD\nE");
    view.dispatch({ changes: { from: 2, to: 3, insert: "X" } });
    await wait(300);
    expect(markedRows(view)).toEqual([2]);
    save();
    view.dispatch({ effects: refreshGutterDiff.of(null) });
    await wait(60);
    expect(markedRows(view)).toEqual([]);
  });

  it("基线未知（热退出副本 / 跨窗口认领）⇒ 整片不画，不靠猜", async () => {
    const { view, forgetBaseline } = mount("A\nB\nC", "A\nB\nC");
    forgetBaseline();
    view.dispatch({ changes: { from: 2, to: 3, insert: "X" } });
    view.dispatch({ effects: refreshGutterDiff.of(null) });
    await wait(300);
    expect(markedRows(view)).toEqual([]);
  });
});

// 上面那条「保存清空」判的是 CM6 这一半（effect → 重新问基线）。这一半是**谁来派发**：
// 保存走的是 refreshAll 那条统一刷新路，接线一断，用户按完 Ctrl+S 的橙绿色就摘不掉，
// 而单测与真机台都不会自己发现 —— 所以钉在源码上。
describe("B458 · 基线换了有人补那一发（保存路径的接线）", () => {
  it("refreshAll 点名刷新，main 注册的是 markdown 那个循环，循环里真的派发", () => {
    const ui = readFileSync("src/ui.ts", "utf-8");
    expect(fnBody(ui, "refreshAll"), "refreshAll 要把基线校对列进统一出口").toContain(
      "refreshGutterDiffRef()",
    );
    const main = readFileSync("src/main.ts", "utf-8");
    expect(main).toContain("setRefreshGutterDiff(refreshGutterDiffBaselines)");
    const markdown = readFileSync("src/markdown.ts", "utf-8");
    const body = fnBody(markdown, "refreshGutterDiffBaselines");
    expect(body, "取到的函数体是空的 ⇒ 名字改了或接线断了").toBeTruthy();
    expect(body).toContain("refreshGutterDiff.of(null)");
    // 隐藏实例（没有 view）不许去戳，否则每轮刷新都撞一次空引用
    expect(body).toContain("panel?.view");
  });
});

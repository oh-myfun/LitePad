import { describe, expect, it } from "vitest";
import type { EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { docState } from "./spike-deco-helpers";
import {
  frontMatterRange,
  isUnclosedFenceLine,
  previewSyntaxTree,
} from "../src/spike/deco/codeFence";
import { applySelection, buildPreviewSets, revealFilterRange } from "../src/spike/deco/previewSets";

// B391 spike · Task 1 —— 装饰集构建与 reveal 过滤（移植自 InkNote src/editor.ts）。

/** 装饰集的可比形状：端点 + class，不比对象身份。 */
function tuples(set: DecorationSet): [number, number, string][] {
  const out: [number, number, string][] = [];
  const it = set.iter();
  while (it.value) {
    out.push([it.from, it.to, (it.value.spec as { class?: string }).class ?? ""]);
    it.next();
  }
  return out;
}

/** 某一行的行装饰 class（行装饰的区间是空区间，挂在行首）。 */
function lineClasses(set: DecorationSet, state: EditorState, lineNo: number): string[] {
  const from = state.doc.line(lineNo).from;
  const out: string[] = [];
  // ⚠️ 只能用 `between(from, to, cb)`：`iter(from, to)` 的第二个参数不存在，
  //    拿它写会一路扫到文档末尾，把后面行的 class 也算进这一行（假绿）。
  set.between(from, from + 1, (_f, _t, value) => {
    const cls = (value.spec as { class?: string }).class;
    if (cls) out.push(cls);
  });
  return out;
}

const MIXED = [
  "# 标题一",
  "",
  "> 引用第一行",
  "> 引用第二行",
  "",
  "- 无序项",
  "  - 嵌套项",
  "",
  "1. 有序一",
  "3. 有序三",
  "",
  "- [x] 已完成",
  "",
  "```ts",
  "let a = 1",
  "```",
  "",
  "- 列表里的围栏",
  "  ```ts",
  "  let b = 2",
  "  ```",
  "",
].join("\n");

describe("B391-1 reveal 扫描窗口", () => {
  it("reveal 扫描窗口 = 光标所在行，不是整篇（P3 的根）", () => {
    const state = docState(5000);
    const head = state.doc.line(4200).from + 3;
    const moved = state.update({ selection: { anchor: head } }).state;
    const { head: gotHead, filterFrom, filterTo } = revealFilterRange(moved);
    const line = state.doc.lineAt(head);
    expect(gotHead).toBe(head);
    expect(filterFrom).toBe(line.from);
    expect(filterTo).toBe(line.to);
    expect(filterTo - filterFrom).toBeLessThan(state.doc.length / 10);
  });
});

describe("B391-1 装饰集构建", () => {
  it("标题/引用/列表各挂一条行装饰", () => {
    const state = docState(MIXED);
    const { lines } = buildPreviewSets(state);
    expect(lineClasses(lines, state, 1)).toContain("md-heading md-heading-1");
    // 引用的两行都要挂上（`lineDecoAll`），否则竖线只画半截
    expect(lineClasses(lines, state, 3)).toContain("md-blockquote");
    expect(lineClasses(lines, state, 4)).toContain("md-blockquote");
    expect(lineClasses(lines, state, 6)).toContain("md-list-item md-bullet-list");
    expect(lineClasses(lines, state, 9)).toContain("md-list-item md-ordered-list");
    // 有序列表把源码里真实的序号交给 CSS（3. 就显示 3，不让计数器重排成 1）
    expect(lineClasses(lines, state, 10).join(" ")).toContain("md-ordered-list");
    expect(lineClasses(lines, state, 12)).toContain("md-task-item md-task-done");
  });

  it("块级替换必须整行覆盖，半行不替换", () => {
    const state = docState(MIXED);
    const { atomicBlocks } = buildPreviewSets(state);
    // 正对照：第 14–16 行的顶层围栏整块占满行 ⇒ 注册为原子块
    expect(atomicBlocks).toEqual([{ from: state.doc.line(14).from, to: state.doc.line(16).to }]);
    // 反对照：第 19–21 行的围栏缩进在列表项里，节点起点跳过了缩进 ⇒ 不注册
    expect(atomicBlocks.some((b) => b.from === state.doc.line(19).from)).toBe(false);
  });

  it("同一 state 连调两次 buildPreviewSets 结果幂等", () => {
    const state = docState(MIXED);
    const first = buildPreviewSets(state);
    const second = buildPreviewSets(state);
    expect(first.atomicBlocks).toEqual(second.atomicBlocks);
    expect(tuples(first.lines)).toEqual(tuples(second.lines));
    expect(tuples(first.statics)).toEqual(tuples(second.statics));
    // 防空转：幂等的两个空集合也算相等，这里要求真的产出了装饰
    expect(tuples(first.statics).length).toBeGreaterThan(10);
    expect(tuples(first.lines).length).toBeGreaterThan(5);
  });
});

describe("B391-1 applySelection", () => {
  it("光标压住的标记被过滤掉，其它行的标记保留", () => {
    const state = docState("**粗体** 与 *斜体*\n第二行 **另一处粗体**\n");
    const { statics } = buildPreviewSets(state);
    const before = tuples(statics);
    const head = state.doc.line(1).from + 2; // 压在 **粗体** 里
    const visible = applySelection(statics, state.update({ selection: { anchor: head } }).state);
    const after = tuples(visible);
    expect(after.length).toBeLessThan(before.length);
    // 第二行那些没被光标压住的必须原样留着（窗口只覆盖光标行）
    const line2 = state.doc.line(2).from;
    expect(after.filter(([, , cls]) => cls === "").length).toBeGreaterThan(0);
    expect(after.every(([from]) => from >= line2 || from < state.doc.line(1).to)).toBe(true);
  });
});

describe("B391-2 未闭合围栏与 front matter 两道防吞", () => {
  it("未闭合围栏不得把整篇吞成一个块", () => {
    const state = docState("标题\n```\n半截代码\n后面还有三大段\n");
    const { atomicBlocks } = buildPreviewSets(state, previewSyntaxTree(state));
    expect(atomicBlocks).toEqual([]);
  });

  it("frontmatter 的开头 --- 不被判成整行块替换，且整段不加装饰", () => {
    const state = docState("---\ntitle: x\n---\n正文\n");
    const fm = frontMatterRange(state);
    expect(fm).toEqual({ from: 0, to: 17 });
    const { atomicBlocks, statics, lines } = buildPreviewSets(state, previewSyntaxTree(state));
    expect(atomicBlocks.some((b) => b.from === 0)).toBe(false);
    // 真判据：整段 front matter（含闭合 `---`）里不许有任何装饰。
    // 少了这道闸，lezer 会把 `title: x` + `---` 判成 SetextHeading2 ⇒ 第 2 行被画成标题。
    expect(tuples(statics).filter(([from]) => from < fm!.to)).toEqual([]);
    expect(lineClasses(lines, state, 2)).toEqual([]);
  });

  it("isUnclosedFenceLine 只认行首 ≤3 空格的 ≥3 个 ` 或 ~", () => {
    expect(isUnclosedFenceLine("```")).toBe(true);
    expect(isUnclosedFenceLine("~~~")).toBe(true);
    expect(isUnclosedFenceLine("   ```ts")).toBe(true);
    expect(isUnclosedFenceLine("    ```")).toBe(false); // 4 空格起是缩进代码
    expect(isUnclosedFenceLine("  ~~~ mermaid")).toBe(true);
    expect(isUnclosedFenceLine("``")).toBe(false);
    expect(isUnclosedFenceLine("正文 ```")).toBe(false);
  });
});

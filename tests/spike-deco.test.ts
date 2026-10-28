// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { DecorationSet, WidgetType } from "@codemirror/view";
import {
  frontMatterRange,
  isUnclosedFenceLine,
  previewSyntaxTree,
} from "../src/spike/deco/codeFence";
import { CodeBlockWidget } from "../src/spike/deco/codeBlockWidget";
import { MathWidget, MermaidWidget } from "../src/spike/deco/richWidgets";
import { TableWidget } from "../src/spike/deco/tableWidget";
import { livePreview, wysiwygInstalled } from "../src/spike/deco/livePreview";
import { decoFace, decoLock } from "../src/spike/deco/wysiwyg";
import { taskClick } from "../src/spike/deco/taskClick";
import { applySelection, buildPreviewSets, revealFilterRange } from "../src/spike/deco/previewSets";
import { docState, clickTaskBox } from "./spike-deco-helpers";

// B391 spike · Task 1 —— 装饰集构建与 reveal 过滤（移植自 InkNote src/editor.ts）。
// B397-1 —— 一档装配：`decoFace()` 是预览档，`decoLock()` 是那把与档位正交的只读锁。

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
    expect(lineClasses(lines, state, 6).join(" ")).toContain("md-list-item md-bullet-list");
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

describe("B397-2 标题与行内代码把 InkNote 的类名挂到**内容区**", () => {
  /** 静态装饰里某个 class 的区间（同名可以有多处，全给）。 */
  function rangesOf(statics: DecorationSet, cls: string): [number, number][] {
    return tuples(statics)
      .filter(([, , c]) => c === cls)
      .map(([f, t]) => [f, t]);
  }

  it("ATX：字阶类只罩正文（`## ` 那一截不算）—— 字号挂行元素会顶掉 padding-top 的 em 基准", () => {
    const state = docState("## 标题正文\n");
    const line = state.doc.line(1);
    expect(rangesOf(buildPreviewSets(state).statics, "cm-md-h2")).toEqual([
      [line.from + 3, line.to],
    ]);
  });

  it("Setext：正文只到本行为止，下一行的 `====` 不许被字阶类罩住", () => {
    const state = docState("标题\n====\n下一段\n");
    const line = state.doc.line(1);
    expect(rangesOf(buildPreviewSets(state).statics, "cm-md-h1")).toEqual([[line.from, line.to]]);
  });

  it("光标落在标题正文里：字阶类不随光标显隐（否则整行字缩回正文大小）", () => {
    const base = docState("## 标题正文\n");
    const line = base.doc.line(1);
    const state = base.update({ selection: { anchor: line.from + 4 } }).state;
    const visible = applySelection(buildPreviewSets(state).statics, state);
    expect(rangesOf(visible, "cm-md-h2")).toEqual([[line.from + 3, line.to]]);
  });

  it("光标落在行内代码里：chip 的类也留着（InkNote 那边它是 highlight style）", () => {
    const base = docState("前 `code` 后\n");
    const at = base.doc.toString().indexOf("code");
    const state = base.update({ selection: { anchor: at + 1 } }).state;
    const visible = applySelection(buildPreviewSets(state).statics, state);
    expect(rangesOf(visible, "cm-md-code")).toEqual([[at, at + 4]]);
  });

  it("对照组：光标压进标题行，`##` 那截的藏标记照旧让位 —— 滤镜没被整体关掉", () => {
    const base = docState("## 标题正文\n");
    const line = base.doc.line(1);
    const state = base.update({ selection: { anchor: line.from + 4 } }).state;
    // 「真窗口」= revealTo > 0（`blockReveal` 是 (1,0) 这种永不显形的哨兵值）
    const windows = (set: DecorationSet) => {
      let n = 0;
      const it = set.iter();
      while (it.value) {
        if (((it.value.spec as { revealTo?: number } | null)?.revealTo ?? 0) > 0) n += 1;
        it.next();
      }
      return n;
    };
    const statics = buildPreviewSets(state).statics;
    expect(windows(statics)).toBeGreaterThan(0);
    expect(windows(applySelection(statics, state))).toBe(0);
  });

  it("行内代码：chip 类只罩内容，两个反引号不算（App.css:1343-1350 的形状）", () => {
    const state = docState("看 `code body` 这里\n");
    const line = state.doc.line(1);
    expect(rangesOf(buildPreviewSets(state).statics, "cm-md-code")).toEqual([
      [line.from + 3, line.from + 12],
    ]);
  });

  it("真视图里这些类落到 DOM 上（判据不许只活在装饰数据里）", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "## 标题正文\n\n看 `code body` 这里\n",
        extensions: [markdown({ base: markdownLanguage }), decoFace(), decoLock(true)],
      }),
      parent: document.createElement("div"),
    });
    try {
      expect(view.dom.querySelector(".cm-md-h2")?.textContent).toBe("标题正文");
      expect(view.dom.querySelector(".cm-md-code")?.textContent).toBe("code body");
    } finally {
      view.destroy();
    }
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

describe("B391-3 一个块 widget 打通原子区间", () => {
  it("eq 比长度与内容、不比绝对位置", () => {
    const a = new CodeBlockWidget(10, 40, "x", "ts");
    expect(a.eq(new CodeBlockWidget(90, 120, "x", "ts"))).toBe(true); // 位置不同、内容同 ⇒ 复用 DOM
    expect(a.eq(new CodeBlockWidget(10, 41, "x", "ts"))).toBe(false); // 长度不同 ⇒ 重建
    expect(a.eq(new CodeBlockWidget(10, 40, "y", "ts"))).toBe(false); // 内容不同 ⇒ 重建
    expect(a.eq(new CodeBlockWidget(10, 40, "x", "rs"))).toBe(false); // 语言不同 ⇒ 重建
  });

  it("只读装饰面仍把整行围栏代码挂成原子块", () => {
    const state = docState("前文\n```ts\nlet a = 1\n```\n后文\n");
    const { atomicBlocks } = buildPreviewSets(state, previewSyntaxTree(state));
    const fenceFrom = state.doc.line(2).from;
    const fenceTo = state.doc.line(4).to;
    expect(atomicBlocks).toEqual([{ from: fenceFrom, to: fenceTo }]);
  });

  it("livePreview 提供装饰源、widget DOM 与原子区间", () => {
    const state = EditorState.create({
      doc: "前文\n```ts\nlet a = 1\n```\n后文\n",
      extensions: [markdown({ base: markdownLanguage }), livePreview(), decoLock(true)],
    });
    const view = new EditorView({ state, parent: document.body });
    try {
      // 两份源：行装饰 + 可见静态装饰（`provide` 里两条 `decorations.from`）
      expect(view.state.facet(EditorView.decorations).length).toBe(2);
      // 围栏代码换成了 widget DOM，里面是可被 Shiki 认领的 pre.md-code[data-lang]
      const pre = view.dom.querySelector<HTMLElement>("pre.md-code");
      expect(pre?.dataset.lang).toBe("ts");
      expect(pre?.textContent).toContain("let a = 1");
      // 原子区间：整块给一个 mark，光标以块为单位跳过
      const atomic = view.state.facet(EditorView.atomicRanges)[0](view);
      expect(atomic.size).toBe(1);
      const spans: [number, number][] = [];
      atomic.between(0, view.state.doc.length, (from, to) => {
        spans.push([from, to]);
      });
      expect(spans).toEqual([[view.state.doc.line(2).from, view.state.doc.line(4).to]]);
    } finally {
      view.destroy();
    }
  });
});

/**
 * B397-1 · 两档装配（替代原「B391-4 只读镜像视图与 ChangeSet 桥」）。
 *
 * 原来这一节判的是桥的四道闸（幽灵 docChanged / 回声 / 内容对齐 / 过期基线）—— 被测对象是
 * 「两颗 view 之间那份机械」。「一格一颗 view」之后它整个没有对象了，而它守的**产品性质**
 * 一条没丢，只是换了载体：
 *   · 「切视图不改内容、不置脏、不写盘」⇒ spike-deco-wiring 己（真启动 + Ctrl+/ 二十回）
 *   · 「同文档两格内容对齐」⇒ 主干 `syncDocInstances` 那一族（tests/multi-instance-* 等）
 *   · 「换档不许把对端位置甩掉」⇒ 落位与账本那一族 + 真机台（B397-5）
 * 这一节因此只管装配本身：档位装上/摘下、只读那把锁的性质，以及 `wysiwygInstalled`
 * 这颗早退判据认不认得出来 —— 认不出来就是每次 `applyPanelMode` 都全篇重 parse 一遍。
 */
describe("B397-1 两档装配：预览档与只读锁", () => {
  it("① 预览档默认是可写的：readOnly facet 假、contenteditable 真、打字进得去", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "**粗体**文字\n",
        extensions: [markdown({ base: markdownLanguage }), decoFace()],
      }),
      parent: document.createElement("div"),
    });
    try {
      expect(view.state.facet(EditorState.readOnly), "可写档不该带 readOnly").toBe(false);
      expect(view.contentDOM.getAttribute("contenteditable"), "DOM 要真能打字").toBe("true");
      view.dispatch({ changes: { from: 0, insert: "手感" }, userEvent: "input.type" });
      expect(view.state.doc.toString().startsWith("手感"), "键入必须真的落进这一份文档").toBe(true);
    } finally {
      view.destroy();
    }
  });

  it("② 只读锁挡的不只是键入：程序化 dispatch 的 docChanged 同样进不去", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "**粗体**文字\n",
        extensions: [markdown({ base: markdownLanguage }), decoFace(), decoLock(true)],
      }),
      parent: document.createElement("div"),
    });
    try {
      expect(view.state.facet(EditorState.readOnly), "只读档要真带上 facet").toBe(true);
      expect(view.contentDOM.getAttribute("contenteditable"), "DOM 不许是可写的").toBe("false");
      view.dispatch({ changes: { from: 0, insert: "X" }, userEvent: "input.type" });
      expect(view.state.doc.toString(), "键入被挡").toBe("**粗体**文字\n");
      // 程序化写也要挡：这是 InkNote 那把 `transactionFilter` 的口径（LitePad 里唯一的
      // 合法写点 `toggleTaskInTab` 在更上游就被 `doc.readonly` 判掉了，不会走到这里）
      view.dispatch({ changes: { from: 0, insert: "Y" } });
      expect(view.state.doc.toString(), "绕不过去的锁才算锁").toBe("**粗体**文字\n");
    } finally {
      view.destroy();
    }
  });

  it("③ 只读只关编辑，不关所见即所得（InkNote：readOnly 时装饰反而更彻底）", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "# 标题\n\n**粗体**文字\n",
        extensions: [markdown({ base: markdownLanguage }), decoFace(), decoLock(true)],
      }),
      parent: document.createElement("div"),
    });
    try {
      expect(view.dom.classList.contains("md-deco"), "装饰类要在这颗 view 上").toBe(true);
      // 只读时不做「光标行才显形」的裁剪 ⇒ 标记一律藏起来（`visiblePreview` 那一条）
      expect(view.dom.textContent.includes("**"), "只读档不该把 ** 显出来").toBe(false);
    } finally {
      view.destroy();
    }
  });

  it("④ 换档不换 view：同一颗 view 上摘下/装上装饰，文档一字不动", () => {
    const preview = new Compartment();
    const lock = new Compartment();
    const view = new EditorView({
      state: EditorState.create({
        doc: "**粗体**文字\n",
        extensions: [markdown({ base: markdownLanguage }), preview.of([]), lock.of([])],
      }),
      parent: document.createElement("div"),
    });
    try {
      const text = view.state.doc.toString();
      expect(wysiwygInstalled(view.state), "源码档：档位是空的").toBe(false);
      view.dispatch({ effects: [preview.reconfigure(decoFace()), lock.reconfigure([])] });
      expect(wysiwygInstalled(view.state), "预览档：装上了").toBe(true);
      expect(view.dom.classList.contains("md-deco")).toBe(true);
      view.dispatch({ effects: [preview.reconfigure([]), lock.reconfigure(decoLock(true))] });
      expect(wysiwygInstalled(view.state), "回源码档：摘干净").toBe(false);
      expect(view.dom.classList.contains("md-deco"), "装饰类不许留在裸编辑上").toBe(false);
      expect(view.state.doc.toString(), "换档三次，文档一字没动").toBe(text);
    } finally {
      view.destroy();
    }
  });
});

/**
 * B391F-4 · 块级富构造（公式 / mermaid / 表格）接进装饰集。
 *
 * 判据按「挂上去的是哪一颗 widget、占不占整行、进不进原子区间」三件事问 ——
 * 这三样决定了同步滚动的逐行对齐与行高图会不会被新构造带偏，
 * 而「画得好不好看」归真机那一轮（`.tmp/b391-check.py` 的能力清单）。
 */
describe("B391F-4 公式 / mermaid / 表格的装饰集", () => {
  function widgets(text: string) {
    const state = docState(text);
    const { statics, atomicBlocks } = buildPreviewSets(state, previewSyntaxTree(state));
    const out: { from: number; to: number; block: boolean; w: WidgetType | null }[] = [];
    statics.between(0, state.doc.length, (from, to, value) => {
      const spec = value.spec as { widget?: WidgetType; block?: boolean };
      if (spec.widget) out.push({ from, to, block: Boolean(spec.block), w: spec.widget ?? null });
    });
    return { state, out, atomic: atomicBlocks.length };
  }

  it("整行表格换成一个块级 TableWidget，并记进原子区间", () => {
    const { out, atomic } = widgets("| 甲 | 乙 |\n|:---|---:|\n| 1 | 2 |\n\n正文\n");
    expect(out).toHaveLength(1);
    expect(out[0].w).toBeInstanceOf(TableWidget);
    expect(out[0].block, "表格占满整行 ⇒ 必须是 block widget").toBe(true);
    expect(atomic).toBe(1);
  });

  it("$$ 独占整行 ⇒ 块级 MathWidget；$…$ 在句子里 ⇒ 行内 MathWidget", () => {
    const block = widgets("$$\nx^2\n$$\n");
    expect(block.out[0].w).toBeInstanceOf(MathWidget);
    expect(block.out[0].block).toBe(true);
    expect(block.atomic, "块级公式整块原子化，光标不许落进去").toBe(1);

    const inline = widgets("质能方程 $E = mc^2$ 很有名。\n");
    expect(inline.out).toHaveLength(1);
    expect(inline.out[0].w).toBeInstanceOf(MathWidget);
    expect(inline.out[0].block, "行内公式不许挂成 block widget（会把整行劈开）").toBe(false);
    expect(inline.atomic).toBe(0);
    expect((inline.out[0].w as MathWidget).tex).toBe("E = mc^2");
  });

  it("```mermaid 走 MermaidWidget，其余语言仍走 CodeBlockWidget", () => {
    const { out } = widgets("```mermaid\ngraph TD; A-->B\n```\n\n```ts\nlet a = 1\n```\n");
    expect(out).toHaveLength(2);
    expect(out[0].w).toBeInstanceOf(MermaidWidget);
    expect(out[1].w).toBeInstanceOf(CodeBlockWidget);
    expect((out[0].w as MermaidWidget).code).toContain("graph TD");
  });

  it("代码里的 $ 不算公式：行内代码与围栏各挡一刀", () => {
    const inlineCode = widgets("价格是 `$5 到 $10` 之间。\n");
    expect(
      inlineCode.out.filter((x) => x.w instanceof MathWidget),
      "行内代码里的 $…$ 不算公式",
    ).toHaveLength(0);
    const fenced = widgets("```\n$$\nx^2\n$$\n```\n");
    expect(
      fenced.out.filter((x) => x.w instanceof MathWidget),
      "围栏代码里的 $$ 不算公式",
    ).toHaveLength(0);
    expect(fenced.out[0].w).toBeInstanceOf(CodeBlockWidget);
  });

  it("表格里的 $x$ 不重复挂数学 widget（装饰交叠会让 Decoration.set 直接抛）", () => {
    expect(() => widgets("| 甲 | 乙 |\n|---|---|\n| $x$ | 2 |\n")).not.toThrow();
    const { out } = widgets("| 甲 | 乙 |\n|---|---|\n| $x$ | 2 |\n");
    expect(out.map((x) => x.w?.constructor.name)).toEqual(["TableWidget"]);
  });

  it("金额那一形不被误判成公式（InkNote 同口径的保守规则）", () => {
    expect(widgets("价格 $5 到 $10 元\n").out).toHaveLength(0);
  });

  it("真视图里：表格画出 <table>，公式留下可被 KaTeX 认领的占位", () => {
    const state = EditorState.create({
      doc: "| 甲 | 乙 |\n|---|---|\n| 1 | 2 |\n\n行内 $a+b$ 与 $$\nx^2\n$$\n",
      extensions: [markdown({ base: markdownLanguage }), decoFace(), decoLock(true)],
    });
    const view = new EditorView({ state, parent: document.createElement("div") });
    try {
      expect(
        view.dom.querySelector("table.md-deco-table, .md-table-widget table"),
        "表格要真画出 <table>",
      ).toBeTruthy();
      expect(
        view.dom.querySelectorAll(".math-inline-src, .math-display-src").length,
        "两处数学占位都等 enhance 认领",
      ).toBeGreaterThanOrEqual(2);
      expect(view.dom.querySelector(".mermaid-src"), "本篇没有 mermaid").toBeNull();
    } finally {
      view.destroy();
    }
  });
});

/**
 * B391F-5 · 勾选框。
 *
 * 现方案的那颗勾（B358）认的是「渲染面里第 N 个 `.md-task`」，而 N 是在**岛**内数的
 * —— B394-2 就是这套序号换算写错了行（点第二个勾，`- [x]` 落到了空的那一行）。
 * 所见即所得天然不需要这个中间量：显示面就是文档本身，点的哪一行有行号，
 * 所以这里**按行号回调**，把岛内序号这条支路整个绕开。
 */
describe("B391F-5 所见即所得点勾按行号交回宿主", () => {
  function mountTasks(doc: string, opts: Parameters<typeof taskClick>[0]): EditorView {
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), livePreview(), taskClick(opts)],
    });
    return new EditorView({ state, parent: document.createElement("div") });
  }

  it("点第 N 行的方框 ⇒ 回调收到那一行的**文档行号**（不是列表内序号）", () => {
    const hits: number[] = [];
    const view = mountTasks("- 普通项\n- [ ] 未勾选\n  - [x] 嵌套已勾选\n", {
      onToggleTask: (_view, n) => hits.push(n),
    });
    try {
      const rows = Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-line.md-task-item"));
      expect(rows.length, "两颗方框都应画出来").toBe(2);
      clickTaskBox(rows[0], "40px", 20);
      clickTaskBox(rows[1], "80px", 64);
      // 行 2 / 行 3：若实现按「第几个任务项」报，拿到的是 0/1；按 DOM 行序报是 1/2
      expect(hits, "嵌套项缩进不同也必须认得出自己那一行").toEqual([2, 3]);
    } finally {
      view.destroy();
    }
  });

  it("点正文（方框热区之外）不算点勾", () => {
    const hits: number[] = [];
    const view = mountTasks("- [ ] 未勾选\n", { onToggleTask: (_view, n) => hits.push(n) });
    try {
      const row = view.dom.querySelector<HTMLElement>(".cm-line.md-task-item")!;
      clickTaskBox(row, "40px", 260);
      expect(hits, "正文上的一下应当照常落光标，不是翻勾").toEqual([]);
    } finally {
      view.destroy();
    }
  });

  it("canToggleTask 说不许写 ⇒ 一发回调都不发（点不动的键不许谎报可点）", () => {
    const hits: number[] = [];
    const view = mountTasks("- [ ] 未勾选\n", {
      onToggleTask: (_view, n) => hits.push(n),
      canToggleTask: () => false,
    });
    try {
      clickTaskBox(view.dom.querySelector<HTMLElement>(".cm-line.md-task-item")!, "40px", 20);
      expect(hits).toEqual([]);
    } finally {
      view.destroy();
    }
  });

  it("列表外的裸 `[ ]` 不画方框：装饰面只认 lezer 的 Task 节点（B394-3 那一形不存在）", () => {
    const hits: number[] = [];
    const view = mountTasks("正文一行\n\n[ ] 这不是列表里的任务\n", {
      onToggleTask: (_view, n) => hits.push(n),
    });
    try {
      expect(
        view.dom.querySelectorAll(".cm-line.md-task-item").length,
        "裸 `[ ]` 不是列表项 ⇒ 不许画那颗点不动的方框",
      ).toBe(0);
      const lines = view.dom.querySelectorAll<HTMLElement>(".cm-line");
      clickTaskBox(lines[lines.length - 1], "40px", 20);
      expect(hits).toEqual([]);
    } finally {
      view.destroy();
    }
  });
});

/**
 * B397-1 · Typora 那一半机械（原 B391F-8 里唯一与「镜像」无关的判据，搬过来单独钉住）。
 *
 * 双向桥随镜像一起没了：权威从来只有一份，就不存在「把键入套回源码」这件事。
 * 但「光标压住标记才显形源码」是所见即所得档自己的性质，它决定用户敢不敢在预览档里落笔，
 * 所以判据一字未改，只把载体从镜像换成一颗可写的所见即所得 view。
 */
describe("B397-1 可写档的标记显形", () => {
  it("光标不在标记上时源码藏着；压进 **…** 内部就显形", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "- [ ] 第一行\n\n**粗体**文字\n",
        extensions: [markdown({ base: markdownLanguage }), decoFace()],
      }),
      parent: document.createElement("div"),
    });
    try {
      const mark = view.state.doc.toString().indexOf("**");
      expect(view.dom.textContent.includes("**"), "前置：光标不在标记上时源码不该露出来").toBe(
        false,
      );
      view.dispatch({ selection: { anchor: mark + 1 } });
      expect(view.dom.textContent.includes("**"), "光标进 **…** 内部就该看见源码").toBe(true);
    } finally {
      view.destroy();
    }
  });
});

describe("B401 列表符号分级 / 空格收口 / 链接落点", () => {
  it("多级无序列表按深度挂 md-bullet-1/2/3（disc → circle → square → 循环）", () => {
    const state = docState("- 一\n  - 二\n    - 三\n      - 四\n");
    const { lines } = buildPreviewSets(state);
    expect(lineClasses(lines, state, 1).join(" ")).toContain("md-bullet-1");
    expect(lineClasses(lines, state, 2).join(" ")).toContain("md-bullet-2");
    expect(lineClasses(lines, state, 3).join(" ")).toContain("md-bullet-3");
    expect(lineClasses(lines, state, 4).join(" ")).toContain("md-bullet-1");
  });

  it("列表标记后的**所有**空格都藏掉（多打空格不再把正文推开）", () => {
    // "-   正文"：mark 是 "-"，后面三个空格都必须被 replace 覆盖
    const state = docState("-   正文\n");
    const { statics } = buildPreviewSets(state);
    const line = state.doc.line(1);
    for (let i = 1; i <= 3; i++) {
      let covered = false;
      statics.between(line.from + i, line.from + i + 1, () => {
        covered = true;
      });
      expect(covered, `第 ${i + 1} 个字符（空格）应被藏`).toBe(true);
    }
  });

  it("嵌套列表的作者缩进整段藏掉（缩进只听 CSS 的 depth 档）", () => {
    const state = docState("- 一\n  - 二\n");
    const { statics } = buildPreviewSets(state);
    const l2 = state.doc.line(2);
    let covered = false;
    const it = statics.iter();
    while (it.value) {
      if (it.from === l2.from && it.to === l2.from + 2) covered = true;
      it.next();
    }
    expect(covered, "行首两个空格要整段 replace").toBe(true);
  });

  it("链接的落点写在 data-href 上（没有真 href，WebView 导航不走）", () => {
    const state = docState("[甲](https://a.example) 与 [乙](b.md) 与 <https://c.example>\n");
    const { statics } = buildPreviewSets(state);
    const hrefs: string[] = [];
    const it = statics.iter();
    while (it.value) {
      const spec = it.value.spec as { class?: string; attributes?: Record<string, string> };
      if (spec.class === "cm-md-link") hrefs.push(spec.attributes?.["data-href"] ?? "");
      it.next();
    }
    expect(hrefs).toEqual(["https://a.example", "b.md", "https://c.example"]);
  });

  it("引用式链接也能拿到定义里的地址", () => {
    const state = docState("见 [丙][r]。\n\n[r]: https://d.example\n");
    const { statics } = buildPreviewSets(state);
    let href = "";
    statics.between(0, state.doc.line(1).to, (_f, _t, value) => {
      const spec = value.spec as { class?: string; attributes?: Record<string, string> };
      if (spec.class === "cm-md-link") href = spec.attributes?.["data-href"] ?? "";
    });
    expect(href).toBe("https://d.example");
  });
});

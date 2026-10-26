// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { DecorationSet, WidgetType } from "@codemirror/view";
import {
  docState,
  lastChanges,
  trackedView,
  watchBroadcast,
  clickTaskBox,
} from "./spike-deco-helpers";
import {
  frontMatterRange,
  isUnclosedFenceLine,
  previewSyntaxTree,
} from "../src/spike/deco/codeFence";
import { CodeBlockWidget } from "../src/spike/deco/codeBlockWidget";
import { MathWidget, MermaidWidget, TableWidget } from "../src/spike/deco/richWidgets";
import { livePreview } from "../src/spike/deco/livePreview";
import { taskClick } from "../src/spike/deco/taskClick";
import { isMirrorSyncing, mirrorChanges } from "../src/spike/deco/mirror";
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
      extensions: [markdown({ base: markdownLanguage }), livePreview({ readOnly: true })],
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

describe("B391-4 只读镜像视图与 ChangeSet 桥", () => {
  /** 两个各持独立 EditorState 的同文档视图（与 LitePad 的多实例模型同形）。 */
  function twoViews(text = "第一行\n第二行\n第三行\n") {
    const mk = () =>
      trackedView(
        EditorState.create({
          doc: text,
          extensions: [markdown({ base: markdownLanguage }), livePreview({ readOnly: true })],
        }),
        document.createElement("div"),
      );
    return { src: mk(), dst: mk() };
  }

  it("① 文本未变的事务不回写（幽灵 docChanged）", () => {
    const { src, dst } = twoViews();
    const before = dst.state.doc.toString();
    src.dispatch({ selection: { anchor: 7 } }); // 仅选区，changes 为空
    expect(mirrorChanges(dst, lastChanges(src))).toBe("skipped-identical");
    expect(dst.state.doc.toString()).toBe(before);
  });

  it("② 镜像写入不会被当成用户编辑再广播回去（无回声环）", () => {
    const { src, dst } = twoViews();
    const seen: string[] = [];
    const off = watchBroadcast(dst, (update) => {
      // 天真桥法：dst 每发一次 update 就镜像回 src —— 回声闸必须把这一发判掉
      seen.push(isMirrorSyncing() ? "镜像写入" : "dst 自发广播");
      seen.push("回写 " + mirrorChanges(src, update.changes));
    });
    src.dispatch({ changes: { from: 0, insert: "x" } });
    mirrorChanges(dst, lastChanges(src));
    off();
    expect(seen).toEqual(["镜像写入", "回写 skipped-echo"]);
    expect(src.state.doc.toString().startsWith("xx")).toBe(false);
    expect(src.state.doc.toString().startsWith("x")).toBe(true);
  });

  it("③ 镜像后两侧文本一致，且没有偷偷写 dst 的 scrollTop", () => {
    const { src, dst } = twoViews();
    let scrollWrites = 0;
    let scrollValue = 0;
    Object.defineProperty(dst.scrollDOM, "scrollTop", {
      configurable: true,
      get: () => scrollValue,
      set: (v: number) => {
        scrollWrites++;
        scrollValue = v;
      },
    });
    src.dispatch({ changes: { from: 0, insert: "改一版" } });
    expect(mirrorChanges(dst, lastChanges(src))).toBe("applied");
    expect(dst.state.doc.toString()).toBe(src.state.doc.toString());
    // 落点是同步滚动的事，回写层一只管内容
    expect(scrollWrites).toBe(0);
  });

  it("④ 基线不一致的陈旧 changeset 不硬套（会写出花来）", () => {
    const { src, dst } = twoViews();
    // dst 已经不是 src 那一刻的文档：拿 src 的 changes 直接 apply 会按位置乱改
    dst.dispatch({ changes: { from: 0, insert: "另一版" } });
    const afterDst = dst.state.doc.toString();
    src.dispatch({ changes: { from: 0, insert: "改一版" } });
    expect(mirrorChanges(dst, lastChanges(src))).toBe("skipped-stale");
    expect(dst.state.doc.toString()).toBe(afterDst);
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
      extensions: [markdown({ base: markdownLanguage }), livePreview({ readOnly: true })],
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
 * 装饰面天然不需要这个中间量：它就是源码那份文档的第 N 份实例，点的哪一行有行号，
 * 所以这里**按行号回调**，把岛内序号这条支路整个绕开。
 */
describe("B391F-5 装饰面点勾按行号交回宿主", () => {
  function mountTasks(doc: string, opts: Parameters<typeof taskClick>[0]): EditorView {
    const state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        livePreview({ readOnly: true }),
        taskClick(opts),
      ],
    });
    return new EditorView({ state, parent: document.createElement("div") });
  }

  it("点第 N 行的方框 ⇒ 回调收到那一行的**文档行号**（不是列表内序号）", () => {
    const hits: number[] = [];
    const view = mountTasks("- 普通项\n- [ ] 未勾选\n  - [x] 嵌套已勾选\n", {
      onToggleTask: (n) => hits.push(n),
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
    const view = mountTasks("- [ ] 未勾选\n", { onToggleTask: (n) => hits.push(n) });
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
      onToggleTask: (n) => hits.push(n),
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
      onToggleTask: (n) => hits.push(n),
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

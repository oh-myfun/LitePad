// 移植自 InkNote (MIT, Copyright (c) 2026 likehao19) src/editor.ts:105-898
// 本机参照：E:\Project\InkNote\InkNote
//
// B391 spike · 装饰集构建。范围按 spike 计划收窄：只搬「行装饰 + 标记隐藏 +
// 整行覆盖判定」三类。块级 widget 里围栏代码（Task 3）与公式 / mermaid / 表格
// （B391F-4，见 `richWidgets.ts`）已接；lezer 不认的方言（`==高亮==`、`<u>`、脚注）
// 与 front matter 摘要仍未搬 —— 那几条在派生 DOM 那一侧也是「原样吐字」，
// 补齐的排期跟着 B394 的覆盖面清单走。
// 未闭合围栏的 `CodeMark < 2` 防吞闸：`FencedCode` 分支里那道判据就是它，
// Task 2 的测试靠它拿红基线，别当冗余删掉。

import { EditorState, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { Tree, SyntaxNodeRef } from "@lezer/common";
import { frontMatterRange } from "./codeFence";
import { CodeBlockWidget } from "./codeBlockWidget";
import { MathWidget, MermaidWidget, TableWidget, scanMath } from "./richWidgets";

/** 一个整块替换的源码区间。 */
export interface BlockRange {
  from: number;
  to: number;
}

export interface PreviewSets {
  /** 行装饰：标题留白 / 引用 / 列表 / 任务 / 空行，不随光标隐藏。 */
  lines: DecorationSet;
  /** 标记隐藏与（Task 3 起的）块级替换，未按光标过滤。 */
  statics: DecorationSet;
  /** 光标以整块为单位跳过的区间。 */
  atomicBlocks: BlockRange[];
}

const HEADINGS = new Set([
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "SetextHeading1",
  "SetextHeading2",
]);

/** 标题级别：给标题行加上与 Typora 一致的上方留白 */
function headingLevel(name: string): number {
  const m = /(\d)$/.exec(name);
  return m ? Number(m[1]) : 1;
}

/** 真正把标记从排版里拿掉（透明字符仍会占位，会在链接后留下大片空白） */
const HIDE_MARK = Decoration.replace({});

/**
 * 块级 widget 永不因光标显形。
 *
 * 过滤条件是 `head < revealFrom || head > revealTo`，给一个空区间
 * （from > to）就永远成立。spike 的装饰面是只读的，块 widget 一旦显形
 * 就会露出整块源码，比不渲染更糟。
 */
function blockReveal(_from: number, _to: number) {
  return { revealFrom: 1, revealTo: 0 };
}

/** 永不显形：列表符号、引用标记这类「Typora 里根本看不到源码」的标记。 */
const NEVER_REVEAL = { from: 1, to: 0 };

/** 任务项：兼容标准无序/有序形式，也兼容单独 `[x] 文本` 的简写。 */
const TASK_LINE_RE = /^(\s*(?:(?:[-*+]|\d+[.)])\s+)?)\[([ xX])\](\s|$)/;

/** 围栏的信息串（```ts 里的 `ts`） */
function fencedCodeInfo(node: SyntaxNodeRef, doc: EditorState["doc"]): string {
  const info = node.node.getChild("CodeInfo");
  return info ? doc.sliceString(info.from, info.to) : "";
}

/** 围栏正文（多个 CodeText 片段拼回来） */
function fencedCodeText(node: SyntaxNodeRef, doc: EditorState["doc"]): string {
  return node.node
    .getChildren("CodeText")
    .map((child) => doc.sliceString(child.from, child.to))
    .join("");
}

/**
 * 构建与光标无关的装饰。
 *
 * 只在文档变化时调用；移动光标只做一次范围受限的过滤（见 `applySelection`），
 * 避免每次按方向键都重新遍历语法树。
 */
export function buildPreviewSets(state: EditorState, tree?: Tree): PreviewSets {
  const lineDecos: Range<Decoration>[] = [];
  const decos: Range<Decoration>[] = [];
  const atomicBlocks: BlockRange[] = [];
  /**
   * 已经被**整段接管**的区间（围栏代码 / 行内代码 / 表格）。
   *
   * 两个用途：① 公式扫描要跳过它们（`` `$x$` `` 里的 `$` 不是公式）；
   * ② 装饰不许重叠 —— 表格 widget 已经吃下那几行，再往里塞一发数学 widget
   *   会让 `Decoration.set(…, true)` 直接抛（SpanTree 不接受交叠区间）。
   */
  const occupied: BlockRange[] = [];
  const doc = state.doc;
  const syntax = tree ?? syntaxTree(state);
  const fm = frontMatterRange(state);
  const fmEnd = fm ? fm.to : 0;

  const hide = (from: number, to: number, reveal?: BlockRange) => {
    if (to <= from) return;
    decos.push(
      (reveal
        ? Decoration.replace({ revealFrom: reveal.from, revealTo: reveal.to })
        : HIDE_MARK
      ).range(from, to),
    );
  };

  // 标记的「露出触发范围」是整个节点：光标落在 **粗体** 中间也应看到源码，
  // 而不是只有正好压在 ** 上时才显形。
  const hideChildren = (node: SyntaxNodeRef, name: string) => {
    const reveal = { from: node.from, to: node.to };
    for (const c of node.node.getChildren(name)) hide(c.from, c.to, reveal);
  };

  /** 块级替换装饰要求区间恰好占满整行，否则会把所在行从中间劈开 */
  const coversWholeLines = (from: number, to: number) =>
    doc.lineAt(from).from === from && doc.lineAt(to).to === to;

  const addLineClass = (lineFrom: number, cls: string, attributes?: Record<string, string>) => {
    lineDecos.push(Decoration.line({ class: cls, attributes }).range(lineFrom));
  };

  /** 整块的每一行都加类（引用竖线、列表缩进） */
  const lineDecoAll = (
    from: number,
    to: number,
    cls: string,
    attributes?: Record<string, string>,
  ) => {
    const s = doc.lineAt(from).number;
    const e = doc.lineAt(to).number;
    for (let i = s; i <= e; i++) addLineClass(doc.line(i).from, cls, attributes);
  };

  const listDepth = (node: SyntaxNodeRef): number => {
    let depth = 0;
    for (let p = node.node.parent; p; p = p.parent) {
      if (p.name === "BulletList" || p.name === "OrderedList") depth++;
    }
    return depth;
  };

  syntax.iterate({
    enter(node) {
      const n = node.name;
      const from = node.from;
      const to = node.to;

      // front matter 整段跳过 lezer 在这里的误判（`---` 会被解析成
      // HorizontalRule + SetextHeading）。判据必须是 `to <= fmEnd`：
      // 根节点的 from 也是 0，用 from 比较会直接中止整棵树的遍历。
      if (fm && to <= fmEnd) return false;
      if (HEADINGS.has(n)) {
        addLineClass(doc.lineAt(from).from, `md-heading md-heading-${headingLevel(n)}`);
        for (const c of node.node.getChildren("HeaderMark")) {
          decos.push(
            Decoration.mark({ class: "cm-md-heading-mark", ...blockReveal(c.from, c.to) }).range(
              c.from,
              c.to,
            ),
          );
          // ATX：`## ` 在行首；Setext：`===` 单独占下一行，连同换行一起吃掉
          if (c.from > from) {
            hide(c.from - 1, c.to, { from, to });
          } else {
            let end = c.to;
            if (end < to && doc.sliceString(end, end + 1) === " ") end++;
            hide(c.from, end, { from, to });
          }
        }
        return;
      }

      if (n === "QuoteMark") {
        // 只有第一行的 `>` 是 Blockquote 的直接子节点，后续行的 QuoteMark
        // 嵌在 Paragraph / List 里，getChildren 拿不到 ⇒ 必须在遍历里单独处理
        let end = to;
        if (doc.sliceString(end, end + 1) === " ") end++;
        hide(from, end, NEVER_REVEAL);
        return;
      }

      if (n === "Blockquote") {
        lineDecoAll(from, to, "md-blockquote");
        return;
      }

      if (n === "StrongEmphasis" || n === "Emphasis") {
        hideChildren(node, "EmphasisMark");
        return;
      }

      if (n === "Strikethrough") {
        hideChildren(node, "StrikethroughMark");
        return;
      }

      if (n === "InlineCode") {
        occupied.push({ from, to });
        hideChildren(node, "CodeMark");
        return;
      }

      if (n === "Subscript" || n === "Superscript") {
        const markName = n === "Subscript" ? "SubscriptMark" : "SuperscriptMark";
        const marks = node.node.getChildren(markName);
        if (marks.length >= 2) {
          const reveal = { from, to };
          hide(marks[0].from, marks[0].to, reveal);
          decos.push(
            Decoration.mark({ class: n === "Subscript" ? "md-sub" : "md-sup" }).range(
              marks[0].to,
              marks[marks.length - 1].from,
            ),
          );
          hide(marks[marks.length - 1].from, marks[marks.length - 1].to, reveal);
        }
        return;
      }

      if (n === "HardBreak") {
        hide(from, Math.max(from, to - 1), { from, to });
        return;
      }

      if (n === "ListMark" || n === "TaskMarker") {
        // 与 Typora 一致：列表符号与复选框的源码永不显形，由 CSS 画出来
        let end = to;
        if (doc.sliceString(end, end + 1) === " ") end++;
        hide(from, end, NEVER_REVEAL);
        return;
      }

      if (n === "Task") {
        const m = TASK_LINE_RE.exec(doc.lineAt(from).text);
        const done = m ? m[2].toLowerCase() === "x" : false;
        // 只给首行：复选框是 ::before 画的，多行任务项会画出好几个
        addLineClass(doc.lineAt(from).from, done ? "md-task-item md-task-done" : "md-task-item");
        return;
      }

      if (n === "ListItem") {
        const depth = listDepth(node);
        const parent = node.node.parent;
        const indentExtra = depth > 1 ? (depth - 1) * 24 : 0;
        const indentStyle =
          indentExtra > 0
            ? `--md-list-marker-left: calc(var(--editor-padding-x) + ${indentExtra}px); padding-left: calc(var(--editor-padding-x) + var(--md-list-marker-width, var(--editor-list-marker-offset)) + ${indentExtra}px);`
            : "";

        const firstLine = doc.lineAt(from);
        const lastLine = doc.lineAt(to);
        const ordered = parent?.name === "OrderedList";

        // 有序列表显示源码里真实的序号（`3.` 就该显示 3，而不是 CSS 计数器从 1 重排）
        let markerStyle = "";
        if (ordered) {
          const mark = node.node.getChild("ListMark");
          const raw = mark ? doc.sliceString(mark.from, mark.to) : "";
          const safe = raw.replace(/[^0-9.)]/g, "");
          if (safe) {
            // 1.、10.、100. 不能共用固定宽度，否则两位数起会挤出正文左缘。
            const markerWidth = Math.max(1.35, safe.length * 0.58 + 0.3).toFixed(2);
            markerStyle = `--md-marker: "${safe}"; --md-list-marker-width: ${markerWidth}em;`;
          }
        }

        // 每行只挂一条带 style 的行装饰，避免多条装饰的 style 互相覆盖
        const firstClasses = ordered
          ? "md-list-item md-ordered-list"
          : parent?.name === "BulletList"
            ? "md-list-item md-bullet-list"
            : "md-list-item";
        addLineClass(
          firstLine.from,
          firstClasses,
          indentStyle || markerStyle ? { style: `${indentStyle}${markerStyle}` } : undefined,
        );
        const continuationStyle = `${indentStyle}${ordered ? markerStyle : ""}`;
        for (let i = firstLine.number + 1; i <= lastLine.number; i++) {
          addLineClass(
            doc.line(i).from,
            "md-list-item",
            continuationStyle ? { style: continuationStyle } : undefined,
          );
        }
        return;
      }

      if (n === "Escape") {
        // `\*` 只显示 `*`，反斜杠藏掉
        hide(from, from + 1, { from, to });
        return;
      }

      if (n === "Link") {
        if (doc.sliceString(from, Math.min(to, from + 2)) === "[^") return false;
        hideChildren(node, "LinkMark");
        hideChildren(node, "URL");
        hideChildren(node, "LinkTitle");
        // 引用式链接 [文字][ref] 的 [ref] 也要藏
        hideChildren(node, "LinkLabel");
        decos.push(Decoration.mark({ class: "cm-md-link" }).range(from, to));
        return;
      }

      if (n === "Autolink") {
        // <https://x> 的尖括号要藏掉
        hideChildren(node, "LinkMark");
        decos.push(Decoration.mark({ class: "cm-md-link" }).range(from, to));
        return;
      }

      if (n === "URL" && node.node.parent?.name === "Paragraph") {
        decos.push(Decoration.mark({ class: "cm-md-link" }).range(from, to));
        return;
      }

      if (n === "FencedCode") {
        // 未闭合的围栏按 CommonMark 会一直吃到文末，挂成块级替换会把整篇文档吞掉
        if (node.node.getChildren("CodeMark").length < 2) return;
        occupied.push({ from, to });
        const lang = fencedCodeInfo(node, doc).trim().toLowerCase();
        const code = fencedCodeText(node, doc);
        const block = coversWholeLines(from, to);
        if (!block) {
          // 缩进在列表里的围栏代码块：只隐藏围栏，不做块级替换
          hideChildren(node, "CodeMark");
          return;
        }
        atomicBlocks.push({ from, to });
        // ```mermaid 在派生 DOM 那一侧走的是「占位 pre → enhance 画 SVG」，
        // 装饰面照同一条路（`MermaidWidget`），不引第二套渲染器；
        // 其余语言仍是 Shiki 只读 widget。
        const widget =
          lang === "mermaid"
            ? new MermaidWidget(from, to, code)
            : new CodeBlockWidget(from, to, code, lang);
        decos.push(
          Decoration.replace({
            block: true,
            widget,
            ...blockReveal(from, to),
          }).range(from, to),
        );
        return;
      }

      if (n === "Table") {
        // 表格整块换成只读 `<table>`，内容由 `renderFull` 现产 —— 与派生 DOM 那张
        // 是同一份渲染器出的，对齐（`:---:`）也一并跟着 markdown-it，不在这里重算一遍。
        occupied.push({ from, to });
        if (!coversWholeLines(from, to)) return;
        atomicBlocks.push({ from, to });
        decos.push(
          Decoration.replace({
            block: true,
            widget: new TableWidget(from, to, doc.sliceString(from, to)),
            ...blockReveal(from, to),
          }).range(from, to),
        );
        return;
      }
    },
  });

  // —— 数学：lezer 没有数学节点，只能按文本扫（照 InkNote 的 `scanMath`）——————————
  // 排在语法树遍历**之后**，因为「代码里不算公式」这道闸要拿上面收集到的 `occupied`。
  const inTaken = (a: number, b: number) => occupied.some((r) => a < r.to && b > r.from);
  for (const m of scanMath(doc, inTaken)) {
    const wholeLine = m.block && coversWholeLines(m.from, m.to);
    if (wholeLine) atomicBlocks.push({ from: m.from, to: m.to });
    occupied.push({ from: m.from, to: m.to });
    decos.push(
      Decoration.replace({
        block: wholeLine,
        widget: new MathWidget(m.from, m.to, m.tex, wholeLine),
        ...blockReveal(m.from, m.to),
      }).range(m.from, m.to),
    );
  }
  // 数学那一批发在遍历之后 ⇒ 数组不再按位置有序，而 `Decoration.set(…, true)`
  // 要求已排序（乱序直接抛）。按起点排一次，等价于「谁在前谁先建」。
  decos.sort((a, b) => a.from - b.from);

  // 标记 Markdown 空行，供组件边界和相邻块样式识别。
  // 空行本身仍保留正常行高，确保连续回车时光标会真实向下移动。
  const sortedBlocks = [...atomicBlocks].sort((a, b) => a.from - b.from);
  let blockIndex = 0;
  let previousBlank = false;
  for (let number = 1; number <= doc.lines; number++) {
    const line = doc.line(number);
    while (blockIndex < sortedBlocks.length && sortedBlocks[blockIndex].to < line.from) {
      blockIndex++;
    }
    const block = sortedBlocks[blockIndex];
    const insideBlock = Boolean(block && line.from >= block.from && line.to <= block.to);
    const blank = !insideBlock && line.text.trim().length === 0;
    if (blank) {
      addLineClass(
        line.from,
        previousBlank ? "md-blank-line md-blank-line-extra" : "md-blank-line",
      );
    }
    previousBlank = blank;
  }

  return {
    lines: Decoration.set(lineDecos, true),
    statics: Decoration.set(decos, true),
    atomicBlocks,
  };
}

/**
 * reveal 的扫描窗口：光标所在那一行。
 *
 * 拆成纯函数是为了把 P3 的可测形态摆出来 —— 移动光标的开销必须与文档长度无关，
 * 而 `DecorationSet.update` 的 `filterFrom/filterTo` 是唯一能做到这点的口子。
 */
export function revealFilterRange(state: EditorState): {
  head: number;
  filterFrom: number;
  filterTo: number;
} {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { head, filterFrom: line.from, filterTo: line.to };
}

/**
 * 光标所在处露出源码：把光标压住的装饰过滤掉。
 *
 * 判定用光标位置（`selection.head`）而不是整个选区：否则 Ctrl+A 全选会把整篇
 * 文档一次性翻成源码，拖选时也会一路闪烁。标记类装饰带 `revealFrom/revealTo`
 * （所属节点的范围），所以光标落在 `**粗体**` 中间也会显形。
 */
export function applySelection(statics: DecorationSet, state: EditorState): DecorationSet {
  const { head, filterFrom, filterTo } = revealFilterRange(state);
  return statics.update({
    filter: (dFrom, dTo, value) => {
      const spec = value.spec as { revealFrom?: number; revealTo?: number } | null;
      const revealFrom = spec?.revealFrom ?? dFrom;
      const revealTo = spec?.revealTo ?? dTo;
      return head < revealFrom || head > revealTo;
    },
    filterFrom,
    filterTo,
  });
}

// 移植自 InkNote (MIT, Copyright (c) 2026 likehao19) src/editor.ts:105-898
// 本机参照：E:\Project\InkNote\InkNote
//
// B391 spike · 装饰集构建。块级 widget 的覆盖面：围栏代码（B397-3a）、公式 / mermaid
// （B391F-4，见 `richWidgets.ts`）、表格（B397-3b，见 `tableWidget.ts`）、
// 缩进代码 / 链接定义 / HTML 块 / 分割线（B397-4a，见 `miscWidgets.ts`）。
// 仍未搬：图片（要先把本地路径解析定下来，与 B394-4 同一件事）、以及 lezer 不认的方言
// （`==高亮==`、`<u>`、脚注正文 —— 那几条得先扩 parser，不是装饰层能单独补的）。
// 未闭合围栏的 `CodeMark < 2` 防吞闸：`FencedCode` 分支里那道判据就是它，
// Task 2 的测试靠它拿红基线，别当冗余删掉。

import { EditorState, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { Tree, SyntaxNodeRef } from "@lezer/common";
import { frontMatterRange } from "./codeFence";
import { CodeBlockWidget } from "./codeBlockWidget";
import {
  EditableMetadataWidget,
  HrWidget,
  HtmlBlockWidget,
  InlinePreviewWidget,
} from "./miscWidgets";
import { MathWidget, MermaidWidget, scanMath } from "./richWidgets";
import { parseTable } from "./tableData";
import { TableWidget } from "./tableWidget";
import { assetBase, resolveAssetPath } from "./assets";
import { ImageWidget, parseImage } from "./imageWidget";

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

/** 链接的落点（B401）：`data-href` 要跟着装饰一起给出去，Ctrl+点击才知道开哪儿。 */
function linkHref(
  node: SyntaxNodeRef,
  doc: EditorState["doc"],
  definitions: Map<string, LinkDefinition>,
): string {
  const url = node.node.getChild("URL");
  if (url) return doc.sliceString(url.from, url.to);
  const label = node.node.getChild("LinkLabel");
  if (label) {
    const raw = doc.sliceString(label.from + 1, label.to - 1);
    return definitions.get(normalizeLinkLabel(raw))?.url ?? "";
  }
  return "";
}

/** 多级无序列表的档位：disc → circle → square 循环（与 VS Code 预览同名同序）。 */
function bulletLevel(depth: number): number {
  return ((Math.max(1, depth) - 1) % 3) + 1;
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

/**
 * 行内 HTML（B402）：只渲染「有样式意义」的那几个标签 —— 在 VS Code 的预览里它们就是
 * 普通 HTML，样式取浏览器默认值；装饰面没有元素可挂，用 class 复刻同一份默认值。
 * 其余标签（`<img>` / 自定义组件 / 未知标签）保持源码显形：猜错了比不画更糟。
 */
const INLINE_HTML: Record<string, string> = {
  kbd: "cm-md-inline-kbd",
  mark: "cm-md-inline-mark",
  u: "cm-md-inline-underline",
  sub: "md-sub",
  sup: "md-sup",
  b: "cm-md-inline-bold",
  strong: "cm-md-inline-bold",
  i: "cm-md-inline-italic",
  em: "cm-md-inline-italic",
  s: "cm-md-inline-strike",
  del: "cm-md-inline-strike",
  span: "cm-md-inline-span",
};

/** `<span style="color:…">` 只认这两条能安全落到内联样式的属性（与 sanitize 同口径）。 */
function inlineHtmlStyle(attrs: string): Record<string, string> | null {
  const m = /style\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  if (!m) return null;
  const raw = m[1] ?? m[2] ?? "";
  const kept: string[] = [];
  for (const decl of raw.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if (prop !== "color" && prop !== "background-color") continue;
    if (!/^(?:#[0-9a-f]{3,8}|[a-z]{3,20})$/i.test(value)) continue;
    kept.push(`${prop}:${value}`);
  }
  return kept.length ? { style: kept.join(";") } : null;
}

/**
 * 任务项：兼容标准无序/有序形式，也兼容单独 `[x] 文本` 的简写。
 * 导出给 `taskClick.ts` —— 点勾命中的那一行必须用**画方框时同一条**正则判定，
 * 否则会出现「行上有方框、点上说这不是任务行」的死键。
 */
export const TASK_LINE_RE = /^(\s*(?:(?:[-*+]|\d+[.)])\s+)?)\[([ xX])\](\s|$)/;

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

interface LinkDefinition {
  url: string;
  title: string;
}

/** 链接定义的查表口径（照 InkNote）：去首尾空白、空格折叠、忽略大小写。 */
function normalizeLinkLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/** `"title"` / `'title'` / `(title)` 三种引法都去掉最外层。 */
function linkTitleText(raw: string): string {
  if (raw.length >= 2 && /["'(]/.test(raw[0])) return raw.slice(1, -1);
  return raw;
}

/** `[ref]: url "title"` 定义表；脚注定义（标签以 `^` 开头）不是链接定义。 */
function collectLinkDefinitions(tree: Tree, doc: EditorState["doc"]): Map<string, LinkDefinition> {
  const definitions = new Map<string, LinkDefinition>();
  tree.iterate({
    enter(node) {
      if (node.name !== "LinkReference") return;
      const label = node.node.getChild("LinkLabel");
      const url = node.node.getChild("URL");
      if (!label || !url) return false;
      const rawLabel = doc.sliceString(label.from + 1, label.to - 1);
      if (rawLabel.startsWith("^")) return false;
      const title = node.node.getChild("LinkTitle");
      definitions.set(normalizeLinkLabel(rawLabel), {
        url: doc.sliceString(url.from, url.to).replace(/^<|>$/g, ""),
        title: title ? linkTitleText(doc.sliceString(title.from, title.to)) : "",
      });
      return false;
    },
  });
  return definitions;
}

/** `&amp;` → `&`：借 textarea 的解码，不手写实体表。 */
function decodeEntity(raw: string): string {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = raw;
  return textarea.value;
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
  /** 行内 HTML 的开标签栈（按标签名各自配对：`<b><i>x</i></b>` 不能错配）。 */
  const inlineHtmlOpen = new Map<
    string,
    { from: number; to: number; style: Record<string, string> | null }[]
  >();
  const doc = state.doc;
  const syntax = tree ?? syntaxTree(state);
  const fm = frontMatterRange(state);
  const fmEnd = fm ? fm.to : 0;
  const linkDefinitions = collectLinkDefinitions(syntax, doc);
  // 文档所在目录（图片的相对路径要用它拼成绝对路径）；没装装饰档的那份 state 里没有这个字段
  const assetPath = state.field(assetBase, false) ?? null;

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
        // 字阶类挂**正文**而不是整行：`font-size` 写在行元素上会连 `padding-top: 1.1em`
        // 的 em 基准一起放大（标题上方多出一整行），显形出来的 `#` 也会跟着变大 ——
        // InkNote 那边这两件事分别归 `.cm-md-hN`（highlight style）与 `.cm-line.md-heading-N`。
        let headFrom = from;
        let headTo = to;
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
            // 独占一行的标记（Setext 下划线）之后不算正文；同一行的收尾 `#` 不算边界。
            // 切在**换行符之前**：那个 `\n` 已经被上面那发 hide 吃掉了，把它算进字阶区间
            // 只会让 mark 跨行徒增一段无效范围。
            const markLine = doc.lineAt(c.from);
            if (markLine.from > headFrom) headTo = Math.min(headTo, markLine.from - 1);
          } else {
            let end = c.to;
            if (end < to && doc.sliceString(end, end + 1) === " ") end++;
            hide(c.from, end, { from, to });
            headFrom = Math.max(headFrom, end);
          }
        }
        if (headTo > headFrom) {
          decos.push(
            // 字阶类**不随光标显隐**：`applySelection` 会把光标落在区间内的装饰滤掉，
            // 这颗一掉，光标进标题那一刻整行字缩回正文大小（真机 M-14a 抓到的读数）。
            // InkNote 那边 `.cm-md-hN` 是 highlight style（editor.ts:91 一带），天然不过滤；
            // `blockReveal` 就是本仓「永不显形」的窗口（head<1 || head>0 恒真）。
            Decoration.mark({ class: `cm-md-h${headingLevel(n)}`, ...blockReveal(from, to) }).range(
              headFrom,
              headTo,
            ),
          );
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
        // chip 的形状（底色/描边/内距）只归内容：反引号显形时跟着放大就成了「框里有框」。
        // 取法与 Subscript 那一支同形 —— 第一枚 CodeMark 之后、最后一枚之前。
        const ticks = node.node.getChildren("CodeMark");
        if (ticks.length >= 2) {
          const innerFrom = ticks[0].to;
          const innerTo = ticks[ticks.length - 1].from;
          if (innerTo > innerFrom) {
            // 同字阶类：chip 的底色/描边不随光标显隐（InkNote 里它是 highlight style）
            decos.push(
              Decoration.mark({ class: "cm-md-code", ...blockReveal(from, to) }).range(
                innerFrom,
                innerTo,
              ),
            );
          }
        }
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

      if (n === "Entity") {
        // `&amp;` 画成 `&`；光标压进这一小段时显形源码（行内小件，不整行接管）
        decos.push(
          Decoration.replace({
            widget: new InlinePreviewWidget(
              from,
              to,
              decodeEntity(doc.sliceString(from, to)),
              "md-entity",
            ),
            revealFrom: from,
            revealTo: to,
          }).range(from, to),
        );
        return;
      }

      if (n === "HardBreak") {
        hide(from, Math.max(from, to - 1), { from, to });
        return;
      }

      if (n === "HTMLTag") {
        // 行内 HTML（B402）：白名单内的标签成对藏掉、中间文字挂上对应样式；
        // 光标压进这个元素时两个标签一起显形（与 ** 粗体标记同一套露出口径）。
        // ⚠️ 表格 / 围栏 / 行内代码已经被整段接管（widget），里面的标签不许再插装饰。
        if (occupied.some((r) => from >= r.from && to <= r.to)) return;
        const raw = doc.sliceString(from, to);
        const m = /^<\s*(\/?)\s*([a-zA-Z][\w-]*)([\s\S]*?)\/?>$/.exec(raw);
        if (!m) return;
        const name = m[2].toLowerCase();
        const cls = INLINE_HTML[name];
        if (!cls) return;
        if (m[1]) {
          const open = inlineHtmlOpen.get(name)?.pop();
          if (!open) return;
          const reveal = { from: open.from, to };
          hide(open.from, open.to, reveal);
          hide(from, to, reveal);
          if (from > open.to) {
            decos.push(
              Decoration.mark({
                class: cls,
                ...(open.style ? { attributes: open.style } : {}),
                ...blockReveal(open.from, to),
              }).range(open.to, from),
            );
          }
        } else {
          inlineHtmlOpen.set(name, [
            ...(inlineHtmlOpen.get(name) ?? []),
            { from, to, style: name === "span" ? inlineHtmlStyle(m[3] ?? "") : null },
          ]);
        }
        return;
      }

      if (n === "ListMark" || n === "TaskMarker") {
        // 与 Typora 一致：列表符号与复选框的源码永不显形，由 CSS 画出来。
        // B401：标记后的**所有**空格一并藏掉 —— 只藏一个的话，`-  item`（多打空格）的
        // 正文会被剩下的空格顶开，看着就是「符号与内容的间距忽大忽小」。
        let end = to;
        while (end < doc.length && doc.sliceString(end, end + 1) === " ") end++;
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
        const mark = node.node.getChild("ListMark");

        // 嵌套档的缩进只认 CSS 的 depth 档位：作者在标记前多打的空格一律藏掉。
        // 留着重叠就会「2 空格 vs 4 空格」的同类项左沿对不齐（B401 用户报的那条）。
        if (mark && mark.from > firstLine.from) {
          const lead = doc.sliceString(firstLine.from, mark.from);
          if (/^[ \t]+$/.test(lead)) hide(firstLine.from, mark.from, NEVER_REVEAL);
        }

        // 有序列表显示源码里真实的序号（`3.` 就该显示 3，而不是 CSS 计数器从 1 重排）
        let markerStyle = "";
        if (ordered && mark) {
          const raw = doc.sliceString(mark.from, mark.to);
          const safe = raw.replace(/[^0-9.)]/g, "");
          if (safe) {
            // 1.、10.、100. 不能共用固定宽度，否则两位数起会挤出正文左缘。
            const markerWidth = Math.max(1.35, safe.length * 0.58 + 0.3).toFixed(2);
            markerStyle = `--md-marker: "${safe}"; --md-list-marker-width: ${markerWidth}em;`;
          }
        }

        // 每行只挂一条带 style 的行装饰，避免多条装饰的 style 互相覆盖。
        // 无序列表的符号等级走类名（CSS 画形状）—— 字体里的 • ◦ ▪ 墨迹大小不一，
        // 居中后「符号↔正文」的间隙会忽大忽小（B401 用户报的那条）。
        const firstClasses = ordered
          ? "md-list-item md-ordered-list"
          : parent?.name === "BulletList"
            ? `md-list-item md-bullet-list md-bullet-${bulletLevel(depth)}`
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
        // 链接色不随光标显隐（地址那几截由上面的 hideChildren 负责显形）。
        // B401：落点写在 data-href 上 —— Ctrl+点击要知道开哪儿，而真正的 href 不能给
        // （给了 WebView 就会自己导航，正是这次要修的那个病）。
        const href = linkHref(node, doc, linkDefinitions);
        decos.push(
          Decoration.mark({
            class: "cm-md-link",
            ...(href ? { attributes: { "data-href": href } } : null),
            ...blockReveal(from, to),
          }).range(from, to),
        );
        return;
      }

      if (n === "Autolink") {
        // <https://x> 的尖括号要藏掉
        hideChildren(node, "LinkMark");
        const href = linkHref(node, doc, linkDefinitions) || doc.sliceString(from + 1, to - 1);
        decos.push(
          Decoration.mark({
            class: "cm-md-link",
            attributes: { "data-href": href },
            ...blockReveal(from, to),
          }).range(from, to),
        );
        return;
      }

      if (n === "URL" && node.node.parent?.name === "Paragraph") {
        decos.push(
          Decoration.mark({
            class: "cm-md-link",
            attributes: { "data-href": doc.sliceString(from, to) },
            ...blockReveal(from, to),
          }).range(from, to),
        );
        return;
      }

      if (n === "Image") {
        const { alt, url, title } = parseImage(node, doc, linkDefinitions);
        // 行内图片必须用行内装饰，否则会把整行从中间截断
        const block = coversWholeLines(from, to);
        occupied.push({ from, to });
        if (block) atomicBlocks.push({ from, to });
        decos.push(
          Decoration.replace({
            widget: new ImageWidget(
              from,
              to,
              url,
              alt,
              resolveAssetPath(assetPath, url),
              !block,
              title,
            ),
            block,
            ...(block ? blockReveal(from, to) : null),
          }).range(from, to),
        );
        return;
      }

      if (n === "LinkReference") {
        // 脚注定义（`[^1]: …`）不上这条：它有自己的渲染位，按链接定义折起来就看不见了
        const labelNode = node.node.getChild("LinkLabel");
        const rawLabel = labelNode ? doc.sliceString(labelNode.from + 1, labelNode.to - 1) : "";
        if (rawLabel.startsWith("^")) return false;
        if (!coversWholeLines(from, to)) return false;
        const definition = linkDefinitions.get(normalizeLinkLabel(rawLabel));
        occupied.push({ from, to });
        atomicBlocks.push({ from, to });
        decos.push(
          Decoration.replace({
            block: true,
            widget: new EditableMetadataWidget(
              from,
              to,
              doc.sliceString(from, to),
              `链接定义 · ${rawLabel} → ${definition?.url ?? ""}`,
              "reference",
            ),
            ...blockReveal(from, to),
          }).range(from, to),
        );
        return false;
      }

      if (n === "HTMLBlock") {
        if (!coversWholeLines(from, to)) return false;
        occupied.push({ from, to });
        atomicBlocks.push({ from, to });
        decos.push(
          Decoration.replace({
            block: true,
            widget: new HtmlBlockWidget(from, to, doc.sliceString(from, to)),
            ...blockReveal(from, to),
          }).range(from, to),
        );
        return false;
      }

      if (n === "CodeBlock") {
        // 缩进式代码块（四空格）：lezer 只给出正文节点，行首缩进不在节点里，
        // 所以整行接管；回写时补回四空格（`CodeBlockWidget.indented`）。
        const blockFrom = doc.lineAt(from).from;
        const blockTo = doc.lineAt(to).to;
        if (!coversWholeLines(blockFrom, blockTo)) return false;
        const code = node.node
          .getChildren("CodeText")
          .map((child) => doc.sliceString(child.from, child.to))
          .join("");
        occupied.push({ from: blockFrom, to: blockTo });
        atomicBlocks.push({ from: blockFrom, to: blockTo });
        decos.push(
          Decoration.replace({
            block: true,
            widget: new CodeBlockWidget(blockFrom, blockTo, code, "", true),
            ...blockReveal(blockFrom, blockTo),
          }).range(blockFrom, blockTo),
        );
        return false;
      }

      if (n === "HorizontalRule") {
        if (!coversWholeLines(from, to)) return;
        occupied.push({ from, to });
        atomicBlocks.push({ from, to });
        decos.push(
          Decoration.replace({
            block: true,
            widget: new HrWidget(from, to),
            ...blockReveal(from, to),
          }).range(from, to),
        );
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
        // 表格整块换成**可编辑**的 `<table>`（B397-3b）：格内容由手写的 `parseTable` 拆，
        // 语法树只负责「这一段是表」。对齐（`:---:`）跟着走 —— 回写时它住在分隔行里，
        // 不拆出来再写回去就等于打字把用户的对齐档位冲掉。
        occupied.push({ from, to });
        if (!coversWholeLines(from, to)) return;
        atomicBlocks.push({ from, to });
        const { header, rows, aligns } = parseTable({ from, to }, doc);
        decos.push(
          Decoration.replace({
            block: true,
            widget: new TableWidget(from, to, header, rows, aligns),
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
  // —— 脚注：lezer 把 `[^1]: 正文` 也解析成 LinkReference（URL 子节点就是正文），
  // 所以脚注不按语法树走，照 InkNote 同一条：按全文文本扫，编号按「首次出现」排。
  // 定义行整行换成脚注卡片，行内引用换成编号上标（光标压进去显形源码）。
  const fnRe = /\[\^([^\]\n]+)\]/g;
  const footnoteText = doc.toString();
  const footnoteNumbers = new Map<string, number>();
  const footnoteMatches: { index: number; label: string; raw: string }[] = [];
  let fnm: RegExpExecArray | null;
  while ((fnm = fnRe.exec(footnoteText))) {
    const label = normalizeLinkLabel(fnm[1]);
    footnoteMatches.push({ index: fnm.index, label, raw: fnm[0] });
    // 第一趟：定义行上的 `[^x]` 不给编号（否则定义先出现就会抢走 1 号）
    if (
      !/^\s{0,3}\[\^([^\]]+)\]:/.test(doc.lineAt(fnm.index).text) &&
      !footnoteNumbers.has(label)
    ) {
      footnoteNumbers.set(label, footnoteNumbers.size + 1);
    }
  }
  for (const match of footnoteMatches) {
    if (!footnoteNumbers.has(match.label)) {
      footnoteNumbers.set(match.label, footnoteNumbers.size + 1);
    }
  }

  const foldedFootnoteLines = new Set<number>();
  for (const match of footnoteMatches) {
    const number = footnoteNumbers.get(match.label) ?? 1;
    const from = match.index;
    const to = from + match.raw.length;
    if (fm && from < fmEnd) continue;
    if (inTaken(from, to)) continue; // 代码里的 `[^x]` 不是脚注

    const line = doc.lineAt(from);
    const definition = /^\s{0,3}\[\^([^\]]+)\]:\s*(.*)$/.exec(line.text);
    if (definition && normalizeLinkLabel(definition[1]) === match.label) {
      if (foldedFootnoteLines.has(line.number)) continue;
      foldedFootnoteLines.add(line.number);
      occupied.push({ from: line.from, to: line.to });
      atomicBlocks.push({ from: line.from, to: line.to });
      decos.push(
        Decoration.replace({
          block: true,
          widget: new EditableMetadataWidget(
            line.from,
            line.to,
            line.text,
            `脚注 ${number} · ${definition[2]}`,
            "footnote",
          ),
          ...blockReveal(line.from, line.to),
        }).range(line.from, line.to),
      );
      continue;
    }
    // 定义行已被整行接管时不再往里塞行内替换（区间交叠会让 Decoration.set 直接抛）
    if (foldedFootnoteLines.has(line.number)) continue;
    occupied.push({ from, to });
    decos.push(
      Decoration.replace({
        widget: new InlinePreviewWidget(from, to, String(number), "cm-md-footnote", "sup"),
        revealFrom: from,
        revealTo: to,
      }).range(from, to),
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

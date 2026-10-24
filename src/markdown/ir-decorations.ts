import type { Text } from "@codemirror/state";

import type { MdBlock } from "./pipeline";

/**
 * 即时渲染（IR）的装饰区间计算（B352-3）。
 *
 * 纯函数：只吃 `MdBlock[]`（MarkdownIt 的顶层块，带源码行区间与 HTML）、选区、文档与锁态，
 * 产出「哪些块要被替换成渲染结果」。CM6 的装配（StateField / ViewPlugin / widget）在
 * `live-render.ts`，它只负责把这些区间变成装饰 —— 相交口径**只住在这里**，两处各算一份
 * 就是「点进去改不了 / 没点进去却在编辑」这类病的源头。
 *
 * 不依赖 `@codemirror/view`、不碰 DOM：这样判据能在 node 环境里表驱动测到每一个边界。
 */

/** 一份选区（CM 的 selection 抽象成纯数据，方便单测）。 */
export interface IrSelection {
  from: number;
  to: number;
}

/** 一条替换装饰：源码区间 + 该块的 HTML。`from`/`to` 是文档偏移量，半开区间 `[from, to)`。 */
export interface IrReplacement {
  from: number;
  to: number;
  html: string;
  lineStart: number;
  lineEnd: number;
}

/**
 * 块的可读区间。
 *
 * ⚠️ 尾随换行算在块内（`to = 行尾 + 1`）：不吞的话每两块之间会剩一行空白，正文节奏
 * 与只读预览对不上。文档最后一行没有换行可吞，止于行尾。
 * 行号越界（块表来自上一次防抖、文档刚被改短）返回 `null` 由调用方跳过 —— 这一发
 * 必须不抛异常，装饰重算发生在每次选区变化上。
 */
function blockRange(b: MdBlock, doc: Text): { from: number; to: number } | null {
  if (b.lineStart < 1 || b.lineEnd < b.lineStart || b.lineStart > doc.lines) return null;
  const lastLine = Math.min(b.lineEnd, doc.lines);
  const end = doc.line(lastLine);
  const from = doc.line(b.lineStart).from;
  const to = lastLine < doc.lines ? end.to + 1 : end.to;
  // 零宽区间（空文档上那张过期的块表）会被 CM6 当内联装饰画在字符之间 ⇒ 直接跳过。
  if (to <= from) return null;
  return { from, to };
}

/**
 * 半开区间重叠。
 *
 * ⚠️ 空光标占**一个字符位**（`to = from + 1`）：光标停在某块第一个字符上就该展开这一块。
 * 而它同时是上一块吞掉的那个换行 —— 上一块的 `to` 正好等于这个偏移，半开判定
 * `from < range.to` 在这里为假 ⇒ 只展开后一块，不连带展开前一块。
 */
function overlaps(range: { from: number; to: number }, sel: IrSelection): boolean {
  const selEnd = Math.max(sel.to, sel.from + 1);
  return sel.from < range.to && selEnd > range.from;
}

/** 哪些块该被渲染。锁态走独立分支：那一态下没有「焦点块露源码」这回事。 */
export function irDecorationsFor(
  blocks: readonly MdBlock[],
  selections: readonly IrSelection[],
  doc: Text,
  locked: boolean,
): IrReplacement[] {
  const out: IrReplacement[] = [];
  for (const b of blocks) {
    const range = blockRange(b, doc);
    if (!range) continue;
    const item = { ...range, html: b.html, lineStart: b.lineStart, lineEnd: b.lineEnd };
    if (locked) {
      out.push(item);
      continue;
    }
    if (selections.some((s) => overlaps(range, s))) continue;
    out.push(item);
  }
  return out;
}

/** 焦点行描述：`heading` 1..6 = 标题字阶，0 = 正文档（B357 起焦点行要沿用块的字阶）。 */
export interface IrFocusLine {
  line: number;
  heading: number;
}

/** 哪些块正被编辑（该画焦点标识）。锁态恒空 —— 那一态根本没有焦点块。 */
export function irFocusLines(
  blocks: readonly MdBlock[],
  selections: readonly IrSelection[],
  doc: Text,
  locked: boolean,
): IrFocusLine[] {
  if (locked) return [];
  const lines: IrFocusLine[] = [];
  for (const b of blocks) {
    const range = blockRange(b, doc);
    if (!range) continue;
    if (selections.some((s) => overlaps(range, s)))
      lines.push({ line: b.lineStart, heading: headingLevelOf(b.html) });
  }
  return lines;
}

/** 字阶只认块 html 开头的 `<hN>`（markdown-it 的产物是裸标签，属性也要认得）；列表、引用都不升级。 */
function headingLevelOf(html: string): number {
  const m = /^<h([1-6])(?=[\s>])/.exec(html);
  return m ? Number(m[1]) : 0;
}

/** 一次改动对行号的影响：`from..to` 是改点覆盖的**旧**行号闭区间（纯插入时两者相等）。 */
export interface IrLineShift {
  from: number;
  to: number;
  deltaLines: number;
}

/**
 * 打字之后把块表就地带正（B352-11 评审 I5）—— 不是整篇重算。
 *
 * 块表只由 120ms 防抖喂（重算整篇是这条路的反目标），而用户在 C 态里敲键盘是不停手的：
 * 防抖一直被重置 ⇒ 块表一直是**旧行号**。旧行号配新文档 = 装饰盖到别的行上去，包括光标
 * 正在写的那一行（那行本来该露源码）。所以在事务里改过行号就必须当场把块表对齐：
 *
 * · 与改点**相交**的那一块作废 —— 它的 `html` 已经描述不了新内容了，露源码等下一次防抖到货
 *   （实践中就是光标所在那一块，而它在这一态本来就是源码）；
 * · 完全在改点**之后**的块按行数增减平移；之前的块不动。
 *
 * 越界/倒挂的结果一律丢弃：宁可多露一行源码，也不发一个越界装饰（`blockRange` 那一条同源）。
 */
export function shiftBlocks(blocks: readonly MdBlock[], shifts: readonly IrLineShift[]): MdBlock[] {
  if (shifts.length === 0) return [...blocks];
  const out: MdBlock[] = [];
  for (const b of blocks) {
    if (shifts.some((s) => b.lineStart <= s.to && s.from <= b.lineEnd)) continue;
    const delta = shifts.filter((s) => s.to < b.lineStart).reduce((n, s) => n + s.deltaLines, 0);
    const lineStart = b.lineStart + delta;
    const lineEnd = b.lineEnd + delta;
    if (lineStart < 1 || lineEnd < lineStart) continue;
    out.push({ ...b, lineStart, lineEnd });
  }
  return out;
}

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

/** 哪些块正被编辑（该画焦点标识）。锁态恒空 —— 那一态根本没有焦点块。 */
export function irFocusLines(
  blocks: readonly MdBlock[],
  selections: readonly IrSelection[],
  doc: Text,
  locked: boolean,
): number[] {
  if (locked) return [];
  const lines: number[] = [];
  for (const b of blocks) {
    const range = blockRange(b, doc);
    if (!range) continue;
    if (selections.some((s) => overlaps(range, s))) lines.push(b.lineStart);
  }
  return lines;
}

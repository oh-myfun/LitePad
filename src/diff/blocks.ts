// B461 · Task 2 —— 块级出口（`diffBlocks` 与查询口 `blockAt`）：差异面、两侧行底色与侧栏面板共用的那一摞块。
//
// 与 4px gutter 列**同源**：对齐只在 `alignLines` 里算一遍，本文件把每个替换区誊成一块
// （设计稿约束 ⑥）。零 CM6 依赖 —— 纯字符串进、纯数据出。
//
// 行号口径（与 `AlignRegion` 换算死）：**1-based 含端点**；`start > end` ⇒ 该侧为空段，
// 且恒有 `start = end + 1`（空段的落点在 `end` 行之后）—— 照 VS Code 的
// `LineRangeMapping` 空段表示法，Task 3 的占位块据此落位。

import { alignLines, splitLines, type AlignRegion } from "./align";
import type { DiffSide } from "./model";

/** 块形：纯增 / 纯删 / 改（替换区里两侧都非空）。 */
export type DiffKind = "insert" | "delete" | "modify";

/**
 * 一次连续改动 = 一块。计数不另存：`added` / `removed` 由两段长度差推导（照 VS Code）。
 */
export interface DiffBlock {
  kind: DiffKind;
  /** 左栏（基线）区间，1-based 含端点；start > end ⇒ 该侧为空段 */
  originalStart: number;
  originalEnd: number;
  /** 右栏（当前）区间，同口径 */
  modifiedStart: number;
  modifiedEnd: number;
  added: number;
  removed: number;
}

/** 一个替换区誊成一块：行号 = head + start + 1；空段自然落成 start = end + 1。 */
function toBlock(head: number, r: AlignRegion): DiffBlock {
  const kind: DiffKind = r.bLen === 0 ? "delete" : r.aLen === 0 ? "insert" : "modify";
  return {
    kind,
    originalStart: head + r.aStart + 1,
    originalEnd: head + r.aStart + r.aLen,
    modifiedStart: head + r.bStart + 1,
    modifiedEnd: head + r.bStart + r.bLen,
    added: Math.max(r.bLen - r.aLen, 0),
    removed: Math.max(r.aLen - r.bLen, 0),
  };
}

/**
 * 基线正文 vs 当前正文 ⇒ 块级差异（按区间升序）。
 *
 * **不做额外并块**（我的决定，与设计稿口径一致）：两个替换区之间只要隔着一行未改动内容
 * 就是两块 —— 与 VS Code 的 `LineRangeMapping` 同形；「连续改动并成一块」说的正是
 * 「连续改动的行并成一个 region」这件事本身，对齐器已经做了。
 */
export function diffBlocks(
  baseline: string,
  current: string,
  opts: { ignoreTrimWhitespace?: boolean } = {},
): DiffBlock[] {
  if (baseline === current) return [];
  const a = splitLines(baseline);
  const b = splitLines(current);
  const { head, regions } = alignLines(a, b, opts.ignoreTrimWhitespace ?? false);
  return regions.map((r) => toBlock(head, r));
}

/** 这一侧的起止行（1-based 含端点；`start > end` ⇒ 该侧是空段）。 */
function spanOf(b: DiffBlock, side: DiffSide): { start: number; end: number } {
  return side === "modified"
    ? { start: b.modifiedStart, end: b.modifiedEnd }
    : { start: b.originalStart, end: b.originalEnd };
}

/**
 * 块内一条对齐边界：两栏从这两行开始应当同高（1-based 绝对行号）。
 *
 * 由 `inline.ts` 从整块字符 diff 的起止行列反推（上游 `innerHunkAlignment`），
 * `face.ts` 的 `gapZones` 据此在块内逐段补高差；空数组 ⇒ 整块只对齐首尾。
 */
export interface LineAlignment {
  originalLine: number;
  modifiedLine: number;
}

/** 这一侧是不是空段（这一侧根本没有真行）。 */
function isEmptySide(b: DiffBlock, side: DiffSide): boolean {
  const { start, end } = spanOf(b, side);
  return start > end;
}

/**
 * 这一侧区间的「命中」判定：含端点包含；空段（start > end）时块前缘那一行也算。
 *
 * ⚠️ 这一条是**第一优先**的命中判据，永远排在 R26 那条兜底之前 —— 顺序倒了就会出现
 * 「相邻两块抢同一行、读数来回跳」。
 */
function covers(b: DiffBlock, side: DiffSide, line: number): boolean {
  const { start, end } = spanOf(b, side);
  // 空段没有「之内」可言：光标停在这一行时语义是「改动发生在它后面」（Task 9 跟随靠这格），
  // 于是只有 start - 1（= end，恒差一格）算命中；start 之后那一行不算（那一行交给兜底，见下）。
  if (start > end) return line === start - 1;
  return line >= start && line <= end;
}

/**
 * 兜底命中（裁决 R26）：空段那一侧的**落点行** —— 也就是 `start`（= `end + 1`，恒等）。
 *
 * 为什么需要它：跳块的落位规则说空段落 `end + 1`（`surface.ts` 的 `landingLine`），而现有
 * 命中规则只认 `start - 1`（= `end`）⇒ 两条天然差一行 ⇒ 刚跳到「删掉的行」那一块之后，
 * 权威侧（右栏）的光标其实停在落点行上，`blockAt` 却报 -1：侧栏丢掉刚跳过去那一条的高亮，
 * 贴文首的删除块更惨 —— 它的 `start - 1` 是**第 0 行**，任何真光标都撞不上。
 * 裁决保留落位规则（那才是唯一合法的），改的是这一头的查询口。
 *
 * 判错代价（计划里写明，看得见、一处改动可回滚）：光标停在一段删除**之后**那一行时，
 * 高亮的可能是那一道删除而不是「这一行自己」。
 */
function coversLanding(b: DiffBlock, side: DiffSide, line: number): boolean {
  return isEmptySide(b, side) && line === spanOf(b, side).start;
}

/**
 * 包住这一行的块序号；没有 ⇒ -1。
 *
 * 空段那一侧用「块前缘」也算命中 —— 面板光标停在删除块前面那行时得亮对的那条，
 * 返回 -1 就不许亮（Task 9 的跟随口径）。
 * 现有规则**谁都判不中**时，才轮到 R26 那条「空段的落点行」兜底（一次遍历判不中才走第二次，
 * 命中的优先次序不改）。
 */
export function blockAt(blocks: DiffBlock[], side: DiffSide, line: number): number {
  const hit = blocks.findIndex((b) => covers(b, side, line));
  return hit >= 0 ? hit : blocks.findIndex((b) => coversLanding(b, side, line));
}

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
 * `offset` 是少的一侧贴到多的一侧的错位（视图据此放占位块），来自对齐器就地算好的那颗。
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
  offset: number;
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
    offset: r.offset,
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

/** 这一侧区间的「命中」判定：含端点包含；空段（start > end）时块前缘那一行也算。 */
function covers(b: DiffBlock, side: DiffSide, line: number): boolean {
  const start = side === "modified" ? b.modifiedStart : b.originalStart;
  const end = side === "modified" ? b.modifiedEnd : b.originalEnd;
  // 空段没有「之内」可言：光标停在这一行时语义是「改动发生在它后面」（Task 9 跟随靠这格），
  // 于是只有 start - 1（= end，恒差一格）算命中；start 之后那一行不算。
  if (start > end) return line === start - 1;
  return line >= start && line <= end;
}

/**
 * 包住这一行的块序号；没有 ⇒ -1。
 *
 * 空段那一侧用「块前缘」也算命中 —— 面板光标停在删除块前面那行时得亮对的那条，
 * 返回 -1 就不许亮（Task 9 的跟随口径）。
 */
export function blockAt(blocks: DiffBlock[], side: DiffSide, line: number): number {
  return blocks.findIndex((b) => covers(b, side, line));
}

/**
 * 统一同步游标（B251）：**源码行号（可带小数）⇄ 预览位置（块 + 块内比例）**的严格互逆换算。
 *
 * 引入背景：同步滚动原先是「若干条路径 × 各自一套锚」—— 源码读 `scrollTop + 1`、预览读
 * `scrollTop + 8`、源码写「行首（无偏移）」、预览写「块顶 − 8」。同一个记账口径被抄成四个
 * 值，每换一次手就吃一次差（用户报的「差半行」= 两侧读锚天生差 7px ≈ 0.18 行）。
 * 详见 `docs/sync-cursor-plan.md`。
 *
 * ⚠️ 本模块**只做结构换算，不碰几何**：全部入参是整数行号（块表），读数不是像素、不读 DOM。
 *    这样做的价值是 —— 折行 / 图片重排 / 字体变化只改像素、不改块表 ⇒ 编号永远稳定，
 *    位置不会因渲染扰动漂移。
 *
 * 📌 统一规范值：实数行号 `v ∈ [1, lines]`。
 *   · 源码侧：`v` 就是「逻辑行号 + 行内比例」（源码本就按行排版）⇒ 与 `v` 直接相等，零转换误差。
 *   · 预览侧：`v = starts[k] + t · spans[k]`，`t ∈ [0,1]` 是**块内行比例**（不是像素比例）。
 *
 * ⚠️「精确」的边界：**编号精确，不是像素精确**。源码按行排版、预览按块排版，同一个 `v`
 *    在两侧的**视觉位置本来就不一样**（一行源码 ↔ 一个渲染块）—— 这是排版事实，改不掉。
 *    本模块保证的是：结构编号全局唯一、往返恒等、无累积漂移。
 */

/** 游标量化精度：**1e-4 行**（≈ 0.002px，远小于 1px）。防浮点往返累积（切 100 次也会浮出 1e-16）。 */
export const CURSOR_QUANT = 1e4;

/** 规范化游标：`v` 落在缝隙 / 越界 / NaN 时收到 `[1, lines]`。 */
export function clampCursor(lines: number, v: number): number {
  const n = Math.max(1, Math.floor(lines));
  if (!Number.isFinite(v)) return 1;
  return Math.min(n, Math.max(1, v));
}

/** 量化到 `1/CURSOR_QUANT` 行。往返一律经它 ⇒ 累积误差不跨轮。 */
export function quantize(v: number): number {
  return Math.round(v * CURSOR_QUANT) / CURSOR_QUANT;
}

/**
 * 行 ↔ 块映射表（半开区间，覆盖 `[1, lines]` **且无空洞**）。
 *
 * `starts` 比「真块数」多一项：最后一项是 `lines + 1`，充当半开区间的右端，
 * 于是第 k 块占 `[starts[k], starts[k+1])` —— 空行造成的缝隙（段落 [12,14] 与 [16,18]
 * 之间缺 15）天然被前一块的尾部吃掉，不会把 `v` 漏到「无归属」。
 *
 * ⚠️ 入参来自渲染器的块表，`pipeline` 历史上出过**伪块**（B244：收尾 token 另起块 ⇒
 *    每标题切成两块、`lineStart` 恒为 1 的假块混进来）。这里做**单调性清洗**：
 *    `starts` 非递增 / ≤ 0 / > lines 的项一律丢弃，首项不强求为 1（缺则从 1 补），
 *    ⇒ 结构稳定不依赖上游干净。
 */
export interface RowMap {
  /** 块起始行，升序；`starts[0] >= 1`，`starts[length-1] === lines + 1`。 */
  starts: number[];
  /** `spans[k] = starts[k+1] - starts[k]`，恒 `>= 1`。 */
  spans: number[];
  /** 文档总行数。 */
  lines: number;
}

export function buildRowMap(blockStarts: readonly number[], lineCount: number): RowMap {
  const lines = Math.max(1, Math.floor(lineCount));
  const starts: number[] = [];
  let prev = 0;
  for (const raw of blockStarts) {
    const s = Math.floor(raw);
    if (s <= prev) continue; // 伪块 / 重复 / 乱序 ⇒ 丢弃
    if (s > lines) break;
    starts.push(s);
    prev = s;
  }
  if (starts.length === 0 || starts[0] !== 1) starts.unshift(1);
  starts.push(lines + 1); // 半开区间右端
  const spans = starts.slice(1).map((s, i) => s - starts[i]);
  return { starts, spans, lines };
}

/** 块内位置：`k` = 块索引，`t` = 块内行比例 `[0,1]`（块首 = 0，块尾 = 1）。 */
export interface BlockPos {
  k: number;
  t: number;
}

/**
 * `v` → 块内位置（二分：取最后一个 `starts[k] <= v`）。
 *
 * ⚠️ 与 `vOfBlock` **严格互逆**：`vOfBlock(blockOfV(v)) === quantize(v)`。
 */
export function blockOfV(map: RowMap, v: number): BlockPos {
  const vv = clampCursor(map.lines, v);
  let lo = 0;
  let hi = map.starts.length - 2; // 有效块 0 .. starts.length-2
  let k = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (map.starts[mid] <= vv) {
      k = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const span = map.spans[k] || 1;
  return { k, t: Math.min(1, Math.max(0, (vv - map.starts[k]) / span)) };
}

/** 块内位置 → `v`。与 `blockOfV` 严格互逆（量化后）。 */
export function vOfBlock(map: RowMap, k: number, t: number): number {
  const idx = Math.min(Math.max(Math.floor(k), 0), map.spans.length - 1);
  return map.starts[idx] + Math.min(1, Math.max(0, t)) * (map.spans[idx] || 1);
}

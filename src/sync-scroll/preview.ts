/**
 * 同步滚动 v1 —— 预览侧边缘转换（T2）。
 *
 * 复用 `preview.ts` 里 `applySyncToLine` 的「块内源行插值」口径，把它做成
 * 可单测的纯几何：预览侧 `v` = 连续源码行号（如 12.3 = 源码第 12 行向第 13 行
 * 行进 30%）。`v` 与编辑器侧的 `v` 同名同义（共享坐标），两侧只在各自边缘把
 * `v` 与像素互转，中间只传 `v`（取代旧像素/v 双轨）。
 *
 * 设计背景见项目记忆 `2026-10-16.md`：单一 `v` 坐标 + 输入事件驱动的协调器，
 * 结构上无回环，不需要 `programmatic` 抑制标志。
 *
 * 与 `applySyncToLine` 的一致性（幂等稳定）：
 * - `setV` 正向：块内按「本块顶 → 下一块顶」像素跨度，对 `next.lineStart - lineStart`
 *   这段源行做线性插值；末块按块内源行均分块高。
 * - `getV` 逆向：给定 `scrollTop`，按同一插值基反解回连续源行 `v`。
 * 两侧用的是同一组公式的互逆，故同 pane 内 `getV(setV(v)) === v`（插值可达域内），
 * 块内多源行为近似但稳定（与编辑器侧 wrapped line 的近似同理，设计已认可）。
 */

import type { ScrollAnchor } from "./anchor";

/** 预览一个顶层 block 的几何（取自实时 DOM 测量，单元测试用纯数 fake 注入）。 */
export interface PreviewBlockGeom {
  /** 块首源码行（1-based，含）。 */
  lineStart: number;
  /** 块末源码行（1-based，含）。 */
  lineEnd: number;
  /** 块顶相对预览内容区顶部的像素偏移（不含滚动）。 */
  top: number;
  /** 块高（像素）。 */
  height: number;
}

/**
 * 预览视口在同步滚动里暴露的表面。
 *
 * 用结构接口而非直接依赖 `PreviewPane` / 真实 DOM，便于用 fake 注入做精确单测
 * （jsdom 无布局，`getBoundingClientRect` 全 0，测不准）。`PreviewPane` 在结构上
 * 满足本接口（提供实时测量的 `blocks()`、`root.scrollTop` 与 `schedule`），
 * 生产代码直接传 `PreviewPane` 即可。
 */
export interface PreviewScrollSurface {
  readonly root: {
    /** 视口顶边像素（可读写，setV 落到这里）。 */
    scrollTop: number;
    /** 视口高（像素）。 */
    clientHeight: number;
  };
  /** 当前所有块的有序几何（按 lineStart 升序，取自实时 DOM 测量）。 */
  blocks(): PreviewBlockGeom[];
  /** rAF 调度（默认 requestAnimationFrame），未铺开时重试定位用。 */
  schedule(fn: () => void): void;
}

/** 预览视口的滚动锚点（块内源行插值的薄包装）。 */
export class PreviewScrollAnchor implements ScrollAnchor {
  private pendingV: number | null = null;

  constructor(private readonly surface: PreviewScrollSurface) {}

  getV(): number {
    const blocks = this.surface.blocks();
    if (blocks.length === 0 || this.isUnmeasured(blocks)) return 1.0;
    const s = this.surface.root.scrollTop;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const next = blocks[i + 1];
      // 落在首块之前（含块间像素间隙）：取当前块起点行。
      if (s < b.top) return b.lineStart;
      // 落在 [b.top, 下一块顶) 区间内，或最后一块内。
      if (!next || s < next.top) {
        const top0 = b.top;
        if (next) {
          const span = Math.max(1, next.top - top0);
          const range = Math.max(1, next.lineStart - b.lineStart);
          const into = ((s - top0) / span) * range;
          return b.lineStart + into;
        }
        // 末块：按块内源行均分块高（与 setV 末块公式互逆）。
        const start = b.lineStart;
        const lines = Math.max(1, b.lineEnd - start + 1);
        const h = b.height;
        const lineIdx = h > 0 ? (s - top0) / (h / lines) : 0;
        return start + lineIdx;
      }
    }
    // 超出所有块底 → 末块末行。
    const last = blocks[blocks.length - 1];
    return last.lineEnd;
  }

  setV(v: number): void {
    const blocks = this.surface.blocks();
    if (blocks.length === 0 || this.isUnmeasured(blocks)) {
      this.scheduleRetry(v);
      return;
    }
    const target = this.blockAtLine(blocks, v);
    if (!target) {
      this.scheduleRetry(v);
      return;
    }
    const idx = blocks.indexOf(target);
    const next = blocks[idx + 1];
    let top = target.top;
    if (next) {
      const range = Math.max(1, next.lineStart - target.lineStart);
      const into = Math.min(range, Math.max(0, v - target.lineStart));
      top += (next.top - top) * (into / range);
    } else {
      // 末块（next 不存在）：块内源行均分块高，把请求的源行顶对齐到容器顶。
      const start = target.lineStart;
      const lines = Math.max(1, target.lineEnd - start + 1);
      const lineIdx = v - start;
      if (lineIdx > 0 && lineIdx < lines) {
        top += (target.height / lines) * lineIdx;
      }
    }
    this.surface.root.scrollTop = Math.max(0, top);
  }

  /** 未铺开：记 pending，rAF 重试（与 PreviewPane.applyPending 同思路）。 */
  private scheduleRetry(v: number): void {
    this.pendingV = v;
    this.surface.schedule(() => {
      if (this.pendingV === null) return;
      const retry = this.pendingV;
      this.pendingV = null;
      this.setV(retry);
    });
  }

  /**
   * 容器未铺开判定（与 `applySyncToLine` 同思路）：所有块几何为 0 即认作未铺开——
   * 已铺开容器即便某块贴顶（top=0）也有真实 height>0，不会误判。
   */
  private isUnmeasured(blocks: PreviewBlockGeom[]): boolean {
    return blocks.every((b) => b.top === 0 && b.height === 0);
  }

  /**
   * 按连续源行定位块（接受小数，与 `PreviewPane.blockAtLine` 同口径）：
   * 取 `lineStart <= line` 的最后一块；若该块已含 line 直接命中；缝隙 / 单块
   * 小数则稳定落到缝隙前那块，不再误坠底部。
   */
  private blockAtLine(blocks: PreviewBlockGeom[], line: number): PreviewBlockGeom | null {
    let hit: PreviewBlockGeom | null = null;
    for (const b of blocks) {
      const s = b.lineStart;
      if (line < s) break;
      hit = b;
      if (line <= b.lineEnd) return b;
    }
    return hit ?? blocks[blocks.length - 1] ?? null;
  }
}

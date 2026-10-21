/**
 * 同步滚动 v1 —— 预览侧边缘转换（T2）。
 *
 * 复用 `preview.ts` 里 `applySyncToLine` 的「块内源行插值」口径，把它做成
 * 可单测的纯几何：预览侧 `v` = 连续源码行号（如 12.3 = 源码第 12 行向第 13 行
 * 行进 30%）。`v` 与编辑器侧的 `v` 同名同义（共享坐标），两侧只在各自边缘把
 * `v` 与像素互转，中间只传 `v`（取代旧像素/v 双轨）。
 *
 * 抑制与广播策略全在 `coordinator.ts`（期望账本）：本文件只做换算，
 * `setV` 把**实际落到**的 v 回报给调用方，被容器边界裁住时回报的就是裁剪后的值。
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
    /** 内容总高（像素）。缺省 = 不参与「到底」判定。 */
    scrollHeight?: number;
  };
  /** 当前所有块的有序几何（按 lineStart 升序，取自实时 DOM 测量）。 */
  blocks(): PreviewBlockGeom[];
  /** rAF 调度（默认 requestAnimationFrame），未铺开时重试定位用。 */
  schedule(fn: () => void): void;
}

/** 预览视口的滚动锚点（块内源行插值的薄包装）。 */
export class PreviewScrollAnchor implements ScrollAnchor {
  private pendingV: number | null = null;
  /** 上一次 `setV` 是否只是排了重试（没真写像素）。供补定位落定后决定要不要登记。 */
  private deferred = false;

  constructor(
    private readonly surface: PreviewScrollSurface,
    /**
     * 「我这一写落定了，请记账」——由 `wire.ts` 注入（绑到该滚动面的 `expectSurfaceV`）。
     *
     * 为什么需要它：未铺开时 `setV` 不写像素，改记 pending 下一帧重试。那一帧的写入发生在
     * 协调器 `writeTo` 的调用栈**之外** —— 不登记就是一发无人认领的 `scroll`，会被判成
     * 用户滚动并广播给同文档的其它视口（协调器的单一写入方纪律在这条异步支线上会断）。
     */
    private readonly declare?: (intentV: number, landedV: number) => void,
  ) {}

  /**
   * 块还没铺开、或那一发还只是排在下下一帧的承诺 ⇒ 这个面**报不出**位置。
   * 此时 `getV()` 返回的 1.0 是「量不出来」的兜底值，不是读数（B299）。
   */
  hasPosition(): boolean {
    if (this.pendingV !== null) return false;
    const blocks = this.surface.blocks();
    return blocks.length > 0 && !this.isUnmeasured(blocks);
  }

  getV(): number {
    const blocks = this.surface.blocks();
    if (blocks.length === 0 || this.isUnmeasured(blocks)) return 1.0;
    const s = this.surface.root.scrollTop;
    // 到底那一族（B319）：被自己的可滚上限裁住时报「最后一块的末行」，别报还能往下对齐的行号。
    const end = this.atBottom(blocks);
    if (end !== null) return end;
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

  /**
   * 把预览顶边移到源码行 `v`，返回**实际落到**的 v。
   * 未铺开时不写像素，改为记 pending 下一帧重试 —— 此时返回入参 `v`：
   * 那是对协调器账本的**承诺**（「它最终会到这儿」），返回裁剪后的现状会把承诺改写成
   * 「现在这个错位置」，随后补定位那一发就会被账本判成「没兑现」而被补写拽回去。
   */
  setV(v: number): number {
    const blocks = this.surface.blocks();
    if (blocks.length === 0 || this.isUnmeasured(blocks)) {
      this.scheduleRetry(v);
      return v;
    }
    const target = this.blockAtLine(blocks, v);
    if (!target) {
      this.scheduleRetry(v);
      return v;
    }
    this.deferred = false;
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
    const root = this.surface.root;
    const last = blocks[blocks.length - 1];
    // 「末尾」那一发兑现成**自己的底**（与 `atBottom` 的读数配成一对）：只对齐末块顶的话，
    // 块间节奏把底又往下推了一截，这一发就永远差那 52px 到底不了。
    const aim =
      last && v >= last.lineEnd && root.scrollHeight !== undefined
        ? Math.max(top, root.scrollHeight - root.clientHeight)
        : top;
    root.scrollTop = Math.max(0, aim);
    // 读回真实落点：容器比目标短会被浏览器截到 maxScroll，账本必须看到这个事实值。
    return this.getV();
  }

  /**
   * 到底那一族（B319）：被自己的可滚上限裁住时报「最后一块的末行」。
   *
   * 预览有了块间节奏之后，「顶对齐同一个源行」两侧下面剩余的内容高度不再相等：
   * 源码那一格到了底，预览那一格还差一截（真机验证台 S8 实测差 52px），于是它永远
   * 报不出「我也到底了」，协调器每补写一发都被拽回那个对齐点 ⇒ 到底以后看不见末行。
   * 报成末行之后，对侧的 `setV` 会把这一发兑现成自己的底。
   */
  private atBottom(blocks: PreviewBlockGeom[]): number | null {
    const { scrollTop, clientHeight, scrollHeight } = this.surface.root;
    if (scrollHeight === undefined) return null;
    const max = scrollHeight - clientHeight;
    if (max <= 0 || scrollTop < max - 1) return null;
    return blocks[blocks.length - 1]?.lineEnd ?? null;
  }

  /** 未铺开：记 pending，rAF 重试（与 PreviewPane.applyPending 同思路）。 */
  private scheduleRetry(v: number): void {
    this.deferred = true;
    this.pendingV = v;
    this.surface.schedule(() => {
      if (this.pendingV === null) return;
      const retry = this.pendingV;
      this.pendingV = null;
      const landed = this.setV(retry);
      // 只在**真的写下去了**时登记：还在「没铺开」状态时 setV 又排了一帧，此时登记
      // 「落点 = 现状」会把下一帧真正的补定位判成用户滚动并广播出去。
      if (!this.deferred) this.declare?.(retry, landed);
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

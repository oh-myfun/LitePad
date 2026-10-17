/**
 * 同步滚动 v1 —— 边缘换算（坐标 `v`）。
 *
 * 坐标 `v` ＝ 源码行号 + 小数（`v = lineNo + frac`），宽度无关：软折行只放大那一行的
 * 块高，不改变它的行号。编辑器与预览都拿它当唯一滚动语言，各自在**自己的边缘**把 `v`
 * 与像素互转，中间只传 `v`、不传像素。
 *
 * `setV` 返回**实际落到的** `v`：写入的像素会被浏览器按当时的 `scrollHeight` 裁剪
 * （尤其在同栈刚重建完 DOM 之后），返回值让协调器把账本登记成真实落点，而不是
 * 一厢情愿的目标——这是「承诺—兑现」判定能成立的前提。
 *
 * 抑制与广播策略全在 `coordinator.ts`（期望账本），本文件只做换算。
 */

/** 视口一侧的滚动锚点：把视口顶边的像素位置与共享坐标 `v` 双向互转。 */
export interface ScrollAnchor {
  /** 视口顶边像素 → 分数源码行 `v = lineNo + frac`。 */
  getV(): number;
  /** 把视口顶边移到 `v`，返回**实际落到**的 v（被边界裁剪时不等于入参）。 */
  setV(v: number): number;
}

/**
 * 编辑器侧只暴露给同步滚动的视图子集。
 *
 * 用结构子集而非直接依赖 `EditorView`，便于用 fake 注入做精确单测
 * （jsdom 无布局，真实 CM6 `lineBlockAtHeight` 会退回估算行高，测不准）。
 * `EditorView` 在结构上满足本接口（`scrollDOM` / `lineBlockAtHeight` / `state.doc`）。
 */
export interface EditorScrollSurface {
  readonly scrollDOM: { scrollTop: number };
  lineBlockAtHeight(height: number): { top: number; height: number; from: number };
  lineBlockAt(position: number): { top: number; height: number; from: number };
  readonly state: {
    doc: {
      readonly lines: number;
      line(n: number): { from: number };
      lineAt(pos: number): { number: number };
    };
  };
}

/** 编辑器视口的滚动锚点（CM6 `EditorView` 的薄包装）。 */
export class EditorScrollAnchor implements ScrollAnchor {
  constructor(private readonly view: EditorScrollSurface) {}

  getV(): number {
    return this.vAt(this.view.scrollDOM.scrollTop);
  }

  setV(v: number): number {
    const total = this.view.state.doc.lines;
    const lineNo = Math.min(total, Math.max(1, Math.floor(v)));
    const frac = Math.min(1, Math.max(0, v - lineNo));
    const block = this.view.lineBlockAt(this.view.state.doc.line(lineNo).from);
    const target = block.top + frac * Math.max(1, block.height);
    this.view.scrollDOM.scrollTop = target;
    // 读回真实落点换算：写下去被裁剪的话，返回的是裁剪后的 v。
    return this.vAt(this.view.scrollDOM.scrollTop);
  }

  /** 某个 scrollTop 对应的源码行坐标（与 getV 同一口径，供 setV 读回复算）。 */
  private vAt(scrollTop: number): number {
    const block = this.view.lineBlockAtHeight(scrollTop);
    const lineNo = this.view.state.doc.lineAt(block.from).number;
    const h = block.height > 0 ? block.height : 1;
    const frac = Math.min(1, Math.max(0, (scrollTop - block.top) / h));
    return lineNo + frac;
  }
}

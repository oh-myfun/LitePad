/**
 * 同步滚动 v1 —— 滚动位置边缘转换（Step 2 重做）。
 *
 * 坐标 `v` ＝ 源码行号 + 小数（宽度无关）：`v = lineNo + frac`。
 * 它是文档「行轴」上的一个点，编辑器与预览都把它当作唯一滚动语言；
 * 每侧在**自己的边缘**把 `v` 与像素互转，中间只传 `v`、不传像素
 * （取代旧像素/v 双轨）。具体触发与回声抑制由 `coordinator.ts` 负责。
 *
 * 设计背景见 `docs/...` 与项目记忆 `2026-10-16.md`：单一 `v` 坐标 +
 * 输入事件驱动的协调器，结构上无回环，不需要 `programmatic` 抑制标志。
 */

/** 视口一侧的滚动锚点：把视口顶边的像素位置转换为共享坐标 `v`（双向）。 */
export interface ScrollAnchor {
  /** 视口顶边像素 → 分数源码行 `v = lineNo + frac`。 */
  getV(): number;
  /** 分数源码行 `v` → 视口顶边像素（程序化滚动，不产生输入事件）。 */
  setV(v: number): void;
}

/**
 * 编辑器侧在同步滚动里只暴露的视图子集。
 *
 * 用结构子集而非直接依赖 `EditorView`，便于用 fake 注入做精确单测
 * （jsdom 无布局，真实 CM6 `lineBlockAtHeight` 会退回估算行高，测不准）。
 * `EditorView` 在结构上满足本接口（`scrollDOM` / `lineBlockAtHeight` /
 * `state.doc` 均存在），生产代码直接传 `EditorView` 即可。
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
    const top = this.view.scrollDOM.scrollTop;
    const block = this.view.lineBlockAtHeight(top);
    const lineNo = this.view.state.doc.lineAt(block.from).number;
    const h = block.height > 0 ? block.height : 1;
    const frac = Math.min(1, Math.max(0, (top - block.top) / h));
    return lineNo + frac;
  }

  setV(v: number): void {
    const total = this.view.state.doc.lines;
    const lineNo = Math.min(total, Math.max(1, Math.floor(v)));
    const frac = Math.min(1, Math.max(0, v - lineNo));
    const line = this.view.state.doc.line(lineNo);
    const block = this.view.lineBlockAtHeight(this.view.lineBlockAt(line.from).top);
    const h = block.height > 0 ? block.height : 1;
    this.view.scrollDOM.scrollTop = block.top + frac * h;
  }
}

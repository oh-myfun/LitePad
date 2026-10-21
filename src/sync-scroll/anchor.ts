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
  /**
   * 「我这发 `getV()` 是量出来的，不是兜底编的」（B299）。
   *
   * 预览面在块还没铺开、或补定位还排在下一帧时，`getV()` 只能回报 1.0 —— 那串数字的含义是
   * 「量不出来」，不是「停在顶部」。谁把它当成这份文档的位置，谁就把一份正确的记忆改写成
   * 顶部（真机形状：标签拖出新窗口，新窗口那份预览第一帧就塌到顶）。
   * 不实现 = 说的是真话：编辑器的 `scrollTop` 在任何时刻都是事实读数。
   */
  hasPosition?(): boolean;
  /**
   * 顶边那一**视觉行**的行首字符位置（B300 · 逐行对齐）。量不出来 ⇒ null。
   *
   * 只有编辑器面有这个东西：`v` 的小数是「该逻辑行**块高**的比例」，而块高随宽度变
   * （软折行数不同）⇒ 两个宽度的窗口按同一个 `v` 对齐，顶边会差半行到一行（真机对照：
   * 同一 `v=6.83`，主窗口 376px、新窗口 280px）。字符位置是宽度无关的事实，所以跨窗口
   * 载荷在 `v` 之外再带一个它。
   */
  topPos?(): number | null;
  /** 把某个字符所在视觉行的**行顶**贴到容器顶，返回读回的 `v`（诚实值）。 */
  setVAt?(pos: number): number;
}

/**
 * 编辑器侧只暴露给同步滚动的视图子集。
 *
 * 用结构子集而非直接依赖 `EditorView`，便于用 fake 注入做精确单测
 * （jsdom 无布局，真实 CM6 `lineBlockAtHeight` 会退回估算行高，测不准）。
 * `EditorView` 在结构上满足本接口（`scrollDOM` / `lineBlockAtHeight` / `state.doc`）。
 *
 * `posAtCoords` / `coordsAtPos` 是 CM6 的视觉行↔字符换算，只有真机能给出矩形；
 * 假面不提供时逐行对齐自动退回块顶（`topPos()` 给 null），不许抛。
 */
export interface EditorScrollSurface {
  readonly scrollDOM: {
    scrollTop: number;
    /** 容器自身的高度信息（真 CM6 有；假面不给 = 不参与「到底」判定）。 */
    clientHeight?: number;
    scrollHeight?: number;
    getBoundingClientRect?(): { top: number; left: number; height: number };
  };
  lineBlockAtHeight(height: number): { top: number; height: number; from: number };
  lineBlockAt(position: number): { top: number; height: number; from: number };
  posAtCoords?(coords: { x: number; y: number }, precise?: false): number;
  coordsAtPos?(pos: number): { top: number; bottom: number; left: number; right: number } | null;
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
    const end = this.atBottom();
    return end !== null ? end : this.vAt(this.view.scrollDOM.scrollTop);
  }

  /**
   * 被自己的可滚上限裁住了 ⇒ 共享坐标改报「文档末尾那一行」。
   *
   * 两侧「顶对齐到同一个源行」之后，各自下面还剩多少像素本来就不相等：预览有块间节奏、
   * 源码有软折行。继续报「容器顶那一行」，接的那一侧就永远差一截到不了自己的底
   * （真机验证台 S8 实测差 52px）。报成末尾之后由各侧容器自然裁剪 ⇒ 各到各的底。
   *
   * 压根不能滚（`max <= 0`）时**不认**到底：短文档的 `scrollTop` 恒 0，认了就永远报末尾。
   */
  private atBottom(): number | null {
    const el = this.view.scrollDOM;
    if (el.clientHeight === undefined || el.scrollHeight === undefined) return null;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0 || el.scrollTop < max - 1) return null;
    return this.view.state.doc.lines;
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

  /**
   * 容器顶那一点下的字符位置。
   *
   * ⚠️ 取 `top + 1`：正顶边容易被算成「上一行最后一像素」，差一行就是这次要修的东西。
   * ⚠️ 没有盒（被 `display:none` 藏起来的那一侧）⇒ 一律给 null，绝不给兜底读数：
   * 隐藏侧 `scrollTop` 恒 0，那正是 B301「点大纲把位置复位到顶部」的读数来源。
   */
  topPos(): number | null {
    const el = this.view.scrollDOM;
    const rect = el.getBoundingClientRect?.();
    if (!rect || !this.view.posAtCoords || rect.height <= 0) return null;
    return this.view.posAtCoords({ x: rect.left + 2, y: rect.top + 1 }, false) ?? null;
  }

  /** 把 `pos` 所在视觉行的行顶贴到容器顶；拿不到矩形就退回「整块顶」（粗一点，但不许失败）。 */
  setVAt(pos: number): number {
    const el = this.view.scrollDOM;
    const rect = el.getBoundingClientRect?.();
    const coords = rect && rect.height > 0 ? this.view.coordsAtPos?.(pos) : null;
    if (!rect || rect.height <= 0 || !coords) {
      el.scrollTop = Math.max(0, this.view.lineBlockAt(pos).top);
      return this.vAt(el.scrollTop);
    }
    // 屏幕矩形 → 内容坐标：加回当前 scrollTop，再减掉容器顶。
    el.scrollTop = Math.max(0, coords.top - rect.top + el.scrollTop);
    return this.vAt(el.scrollTop);
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

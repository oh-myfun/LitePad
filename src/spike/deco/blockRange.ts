// 壳移植自 InkNote (MIT, Copyright (c) 2026 likehao19) src/editor/widgets/blockRange.ts
// 本机参照：E:\Project\InkNote\InkNote
//
// B397-3 · 块级 widget 的「源码区间记账」。整片就地编辑都吊在这几个函数上，
// 所以它们的口径一条都不许改：
//
//   · 绝对位置**不能信** —— CM6 在 `eq()` 判相等时直接复用旧 DOM（既不调 `toDOM`
//     也不调 `updateDOM`），文档上方一编辑，DOM 上存的 from/to 就过期了。
//     ⇒ 只把**长度**当缓存，取位置一律走 `currentBlockRange` 的 `posAtDOM` 反查。
//   · 游离节点必须早退 —— `posAtDOM` 对不在编辑器里的节点会退化成 0 或 doc.length，
//     拿它去 dispatch 等于把文档头/尾整段覆盖掉（InkNote 原注，这条最贵）。

import { EditorView } from "@codemirror/view";

/** 在块级 widget 的 DOM 上标记源码区间（长度是唯一的缓存，位置只用于人读）。 */
export function stampBlockRange(el: HTMLElement, from: number, to: number): void {
  el.dataset.blockFrom = String(from);
  el.dataset.blockTo = String(to);
  el.dataset.blockLen = String(to - from);
}

/** 以 DOM 当前挂载位置反查源码区间（对复用的 DOM 依然正确）。 */
export function currentBlockRange(
  view: EditorView,
  el: HTMLElement,
): { from: number; to: number } | null {
  if (!el.isConnected || !view.dom.contains(el)) return null;

  const len = Number(el.dataset.blockLen);
  if (!Number.isFinite(len) || len < 0) return null;

  let from: number;
  try {
    from = view.posAtDOM(el);
  } catch {
    return null;
  }
  if (!Number.isFinite(from)) return null;

  const docLen = view.state.doc.length;
  const start = Math.min(Math.max(from, 0), docLen);
  return { from: start, to: Math.min(start + len, docLen) };
}

/**
 * 把组件外层上下留白的点击放到相邻**可见**正文行。
 *
 * CM6 若直接处理块级替换节点的边界，会画出与整个组件同高的光标，回车也可能被原子
 * 区间吞掉。装饰面里 Markdown 的空行已经完全折叠 ⇒ 必须越过空行退到上一段末尾 /
 * 下一段开头，不能再次把隐藏的空行展开。
 */
export function bindBlockBoundaryCursor(el: HTMLElement, visualBody: HTMLElement): void {
  el.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || event.target !== el) return;

    const bodyRect = visualBody.getBoundingClientRect();
    const before = event.clientY < bodyRect.top;
    const after = event.clientY > bodyRect.bottom;
    if (!before && !after) return;

    const view = EditorView.findFromDOM(el);
    const range = view && currentBlockRange(view, el);
    if (!view || !range) return;

    const doc = view.state.doc;
    let pos = before ? range.from : range.to;
    if (before) {
      for (let number = doc.lineAt(range.from).number - 1; number >= 1; number--) {
        const line = doc.line(number);
        if (line.text.trim()) {
          pos = line.to;
          break;
        }
      }
    } else {
      for (let number = doc.lineAt(range.to).number + 1; number <= doc.lines; number++) {
        const line = doc.line(number);
        if (line.text.trim()) {
          pos = line.from;
          break;
        }
      }
    }

    event.preventDefault();
    // 同一根节点上还可能绑着「点击选中组件」；这里必须连同后续监听器一起截断，
    // 否则刚放到空行的光标会立刻又被组件焦点覆盖。
    event.stopImmediatePropagation();
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
  });
}

/** 将块级 widget 上的点击映射到源码字符位置（含横向估算）。 */
export function mapClickToBlockPos(
  view: EditorView,
  from: number,
  to: number,
  clientX: number,
  clientY: number,
  el: HTMLElement,
): number {
  const direct = view.posAtCoords({ x: clientX, y: clientY });
  if (direct != null && direct >= from && direct < to) return direct;

  const rect = el.getBoundingClientRect();
  const blockLen = Math.max(1, to - from);
  if (rect.height <= 0 && rect.width <= 0) return from;

  const yRatio = Math.min(1, Math.max(0, (clientY - rect.top) / Math.max(rect.height, 1)));
  const xRatio = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(rect.width, 1)));
  const estimated = from + Math.floor(blockLen * (yRatio * 0.82 + xRatio * 0.18));
  return Math.min(Math.max(estimated, from), Math.max(from, to - 1));
}

const BOUND = "data-blockClickBound";

export type BlockClickOptions = {
  shouldHandle?: (event: MouseEvent) => boolean;
};

/** 在 widget 根节点绑定左键点击进入源码（不经过编辑器全局 mousedown）。 */
export function bindBlockClickEdit(
  el: HTMLElement,
  from: number,
  to: number,
  options?: BlockClickOptions,
): void {
  stampBlockRange(el, from, to);

  if (el.hasAttribute(BOUND)) return;
  el.setAttribute(BOUND, "1");

  el.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    if (options?.shouldHandle && !options.shouldHandle(event)) return;

    const view = EditorView.findFromDOM(el);
    if (!view) return;
    if (view.state.readOnly) return;

    const range = currentBlockRange(view, el);
    if (!range) return;

    // 光标已经在这一块里就别抢 —— 抢了等于把用户正在选的字取消掉
    const sel = view.state.selection.main;
    if (sel.from >= range.from && sel.from < range.to) return;

    event.preventDefault();
    event.stopPropagation();

    const pos = mapClickToBlockPos(view, range.from, range.to, event.clientX, event.clientY, el);
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
  });
}

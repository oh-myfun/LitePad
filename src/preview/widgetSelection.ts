// 预览块（代码块 / 表格 / frontmatter …）里的文字是原生 contenteditable 选区，
// 浏览器只会画直角矩形；这里把选区量成逐行矩形，套用正文选区同一套三档角与
// `--lp-sel-*` 圆角，让预览里的选中和源码区看起来一致。
//
// 覆盖层必须画在**文字下面、块底色上面**，否则半透明底色会盖在字上。做法是塞进
// 选区所在的块级宿主（`<code>` / `<td>` / `.md-block-source>`）里，用负 z-index +
// `isolation: isolate`（CSS 见 global.css）：同一层叠上下文里，负 z-index 子树画在
// 宿主底色之上、行内文字之下。所以覆盖层跟着代码块横向滚动一起走，坐标只需相对宿主。
//
// 原生高亮只在覆盖层真的画出来时才藏（`lp-widget-selection` 类）：拖到预览块外面、
// 跨块拖选这类接管不了的情形，浏览器怎么画就怎么画，不会出现「选区看不见」。

import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";

import {
  applyCorners,
  selectionCorners,
  stitchLines,
  type CornerRect,
} from "../editor/roundedSelection";

const HOST_CLASS = "lp-native-sel-host";
const LAYER_CLASS = "lp-widget-selectionLayer";
const ACTIVE_CLASS = "lp-widget-selection";

/** 行内盒不是可用的覆盖层宿主：绝对定位的包含块会跨行盒漂移。 */
const INLINE_DISPLAYS = new Set([
  "inline",
  "inline-block",
  "inline-flex",
  "inline-table",
  "contents",
]);

/**
 * 同一条视觉行上被行内元素切开的几段接回一条（shiki 的每个 token 都是一颗 span，
 * 不接就会变成一串小方块）；横向隔开超过 2px 的不接 —— 那是表格单元格的边框。
 */
export function mergeLineRects(rects: readonly CornerRect[]): CornerRect[] {
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
  const out: CornerRect[] = [];
  for (const rect of sorted) {
    const last = out[out.length - 1];
    const sameLine =
      last && Math.abs(last.top - rect.top) < 1 && Math.abs(last.height - rect.height) < 1;
    if (sameLine && rect.left <= last.left + last.width + 2) {
      const right = Math.max(last.left + last.width, rect.left + rect.width);
      out[out.length - 1] = {
        left: last.left,
        top: last.top,
        width: right - last.left,
        height: last.height,
      };
    } else {
      out.push({ ...rect });
    }
  }
  return out;
}

/** 把一段原生选区量成宿主坐标下的逐行矩形：合并行内碎片、补齐行距、裁掉宿主外的部分。 */
export function widgetSelectionRects(
  range: Range,
  host: { top: number; left: number; bottom: number },
  lineHeight: number,
): CornerRect[] {
  const rects: CornerRect[] = [];
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width < 1 || rect.height < 1) continue;
    if (rect.bottom <= host.top || rect.top >= host.bottom) continue;
    rects.push({
      left: rect.left - host.left,
      top: rect.top - host.top,
      width: rect.width,
      height: rect.height,
    });
  }
  if (!rects.length) return [];
  return stitchLines(mergeLineRects(rects), lineHeight);
}

/** 选区所在的原生选区块；不在预览块里返回 null。 */
function mdBlockOf(node: Node): Element | null {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return element?.closest(".md-block") ?? null;
}

/**
 * 覆盖层的宿主：选区公共祖先往上第一颗块级元素。
 *
 * 整段选区跨在两个子块之间（公共祖先就是 `.md-block` 本身）时返回 null ——
 * 这种时候负 z-index 覆盖层会沉到块底色下面，交还浏览器画更稳。
 */
export function selectionHost(range: Range, contentDOM: HTMLElement): HTMLElement | null {
  const block = mdBlockOf(range.commonAncestorContainer);
  if (!block || !contentDOM.contains(block)) return null;
  if (!block.contains(range.startContainer) || !block.contains(range.endContainer)) return null;
  let node =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as HTMLElement)
      : range.commonAncestorContainer.parentElement;
  while (node && node !== block) {
    if (!INLINE_DISPLAYS.has(getComputedStyle(node).display)) return node;
    node = node.parentElement;
  }
  return null;
}

class WidgetSelectionLayer {
  private host: HTMLElement | null = null;
  private layer: HTMLElement | null = null;
  private frame = 0;
  private readonly mutations: MutationObserver;

  constructor(private readonly view: EditorView) {
    document.addEventListener("selectionchange", this.schedule);
    document.addEventListener("scroll", this.schedule, true);
    window.addEventListener("resize", this.schedule);
    // 上色 / 展开收起会把 `<pre>` 整颗换掉，覆盖层得跟着搬（只在真的有选区时重画）。
    this.mutations = new MutationObserver(() => {
      if (this.host) this.schedule();
    });
    this.mutations.observe(view.contentDOM, { childList: true, subtree: true });
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.geometryChanged) this.schedule();
  }

  destroy(): void {
    document.removeEventListener("selectionchange", this.schedule);
    document.removeEventListener("scroll", this.schedule, true);
    window.removeEventListener("resize", this.schedule);
    this.mutations.disconnect();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.clear();
  }

  private readonly schedule = (): void => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  };

  private clear(): void {
    this.layer?.remove();
    this.layer = null;
    this.host?.classList.remove(HOST_CLASS);
    this.host = null;
    this.view.dom.classList.remove(ACTIVE_CLASS);
  }

  private draw(): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return this.clear();
    const range = selection.getRangeAt(0);
    const host = selectionHost(range, this.view.contentDOM);
    if (!host) return this.clear();
    const box = host.getBoundingClientRect();
    // `getBoundingClientRect` 是边框盒；绝对定位的包含块是内边距盒，减去边框宽。
    const rects = widgetSelectionRects(
      range,
      {
        left: box.left + host.clientLeft,
        top: box.top + host.clientTop,
        bottom: box.bottom,
      },
      this.view.defaultLineHeight,
    );
    if (!rects.length) return this.clear();
    if (this.host !== host) {
      this.layer?.remove();
      this.host?.classList.remove(HOST_CLASS);
      this.host = host;
      host.classList.add(HOST_CLASS);
      this.layer = document.createElement("div");
      this.layer.className = LAYER_CLASS;
      this.layer.setAttribute("contenteditable", "false");
      this.layer.setAttribute("aria-hidden", "true");
      host.append(this.layer);
    }
    const corners = selectionCorners(rects);
    this.layer!.replaceChildren(
      ...rects.map((rect, index) => {
        const element = document.createElement("div");
        element.className = "cm-selectionBackground";
        element.style.cssText = `position:absolute;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
        applyCorners(element, corners[index]);
        return element;
      }),
    );
    this.view.dom.classList.add(ACTIVE_CLASS);
  }
}

/** 预览块里原生选区的圆角覆盖层。 */
export function widgetSelection() {
  return ViewPlugin.fromClass(WidgetSelectionLayer);
}

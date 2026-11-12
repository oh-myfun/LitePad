// 预览块（代码块 / 表格 / frontmatter …）里的文字是原生 contenteditable 选区，
// 浏览器只会画直角矩形；这里把选区量成逐行矩形，套用正文选区同一套三档角与
// `--lp-sel-*` 圆角，让预览里的选中和源码区看起来一致。
//
// 覆盖层必须画在**文字下面、块底色上面**，否则半透明底色会盖在字上。做法是塞进
// 选区所在的块级宿主（`<code>` / `<td>` / `.md-block-source>`）里，用负 z-index +
// `isolation: isolate`（CSS 见 global.css）：同一层叠上下文里，负 z-index 子树画在
// 宿主底色之上、行内文字之下。所以覆盖层跟着代码块横向滚动一起走，坐标只需相对宿主。
//
// 选区可能一次覆盖多颗预览块（全选、从正文拖过代码块）：逐块取文字节点的交集，
// 每颗宿主各画一层。原生直角高亮只在覆盖层真的画出来时才藏（`lp-widget-selection`
// 类 + 块上的 `lp-native-sel-block` 类），接管不了的情形浏览器怎么画就怎么画。
//
// 块内的**装饰文字**（代码行号槽、语言栏、复制按钮、frontmatter 标签 …）都在块内部的
// 下级容器上标着 `contenteditable="false"`：块里只要还有可编辑内容，就把这些假文字排除掉 ——
// 只读表格的单元格同样是 `contenteditable="false"`，但整块没有任何可编辑内容，
// 那时它们就是正文本身，不能排除。标在**块根**上的 false 是容器自己的锁（只读预览的
// HTML / metadata 渲染区），那里面的文字也算正文。

import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";

import {
  applyCorners,
  selectionCorners,
  stitchLines,
  type CornerRect,
} from "../editor/roundedSelection";

const HOST_CLASS = "lp-native-sel-host";
const BLOCK_CLASS = "lp-native-sel-block";
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

/** CM6 的块级 widget 根都直接挂在 `.cm-content` 下（见 preview.css 的 `>` 规则）。 */
function isPreviewBlock(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element.classList.contains("md-block")) return true;
  return Array.from(element.classList).some((name) => /^md-[a-z0-9-]+-widget$/.test(name));
}

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

/**
 * 选区与一颗文字节点的交集；不相交或交集为空返回 null。
 *
 * 用 `compareBoundaryPoints`（不用 `comparePoint`）：jsdom 对后者的实现不完整，
 * 而这条路径的单测就跑在 jsdom 上。
 */
export function intersectText(range: Range, node: Text): Range | null {
  if (!node.length || !range.intersectsNode(node)) return null;
  const whole = range.startContainer.ownerDocument!.createRange();
  whole.selectNodeContents(node);
  const startsBefore = range.compareBoundaryPoints(Range.START_TO_START, whole) <= 0;
  const endsAfter = range.compareBoundaryPoints(Range.END_TO_END, whole) >= 0;
  const part = range.startContainer.ownerDocument!.createRange();
  if (startsBefore) part.setStart(node, 0);
  else part.setStart(range.startContainer, range.startOffset);
  if (endsAfter) part.setEnd(node, node.length);
  else part.setEnd(range.endContainer, range.endOffset);
  return part;
}

/** 文字节点所属的覆盖层宿主：往上第一颗块级元素。 */
export function blockHost(node: Node, block: Element): HTMLElement | null {
  let element = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  while (element && element !== block) {
    if (!INLINE_DISPLAYS.has(getComputedStyle(element).display)) return element;
    element = element.parentElement;
  }
  return null;
}

export interface WidgetSelectionPlan {
  /** 选区碰到的预览块（原生直角高亮按块藏）。 */
  blocks: HTMLElement[];
  /** 每颗宿主对应的逐行矩形（宿主坐标）。 */
  hosts: Map<HTMLElement, CornerRect[]>;
}

/**
 * 把一段原生选区拆成「每颗宿主一组矩形」。
 *
 * 逐块、逐文字节点取交集：全选 / 从正文拖过代码块时选区会把整颗块包进去，
 * 这时按块切分才能每块各画一层；行号槽、语言栏这类 `contenteditable="false"`
 * 的装饰文字只在块里还有可编辑内容时才排除（见文件头）。
 */
export function widgetSelectionPlans(
  range: Range,
  contentDOM: HTMLElement,
  lineHeight: number,
): WidgetSelectionPlan {
  const blocks = new Set<HTMLElement>();
  const hosts = new Map<HTMLElement, CornerRect[]>();
  const hostBlock = new Map<HTMLElement, HTMLElement>();
  for (const block of Array.from(contentDOM.children)) {
    if (!isPreviewBlock(block) || !range.intersectsNode(block)) continue;
    const hasEditable = !!block.querySelector('[contenteditable]:not([contenteditable="false"])');
    const doc = contentDOM.ownerDocument;
    const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      if (!text.length) continue;
      // 看**最近的** contenteditable 祖先，不能看最近的 false：代码块根整颗挂着
      // `contenteditable="false"`，里面的 `<code>` 再用 plaintext-only 重新开编辑 ——
      // 按 false 往上找会把正文一起当成装饰排除掉（真机：hosts 恒为 0）。
      // 只有块**内部的下级**容器标 false 才是装饰（行号槽 / 语言栏 / 复制按钮）；
      // 标在块根上的是容器自己的锁（只读预览里 HTML / metadata 渲染区就是这样），
      // 那里面是正文。
      const scope = text.parentElement?.closest("[contenteditable]");
      const scopeLocked =
        scope?.getAttribute("contenteditable") === "false" &&
        block.contains(scope) &&
        scope !== block;
      if (hasEditable && scopeLocked) continue;
      const part = intersectText(range, text);
      if (!part) continue;
      const host = blockHost(text, block);
      if (!host) continue;
      const box = host.getBoundingClientRect();
      // `getBoundingClientRect` 是边框盒；绝对定位的包含块是内边距盒，减去边框宽。
      const left = box.left + host.clientLeft;
      const top = box.top + host.clientTop;
      let list = hosts.get(host);
      if (!list) {
        list = [];
        hosts.set(host, list);
        hostBlock.set(host, block);
      }
      for (const rect of Array.from(part.getClientRects())) {
        if (rect.width < 1 || rect.height < 1) continue;
        if (rect.bottom <= top || rect.top >= box.bottom) continue;
        list.push({
          left: rect.left - left,
          top: rect.top - top,
          width: rect.width,
          height: rect.height,
        });
      }
    }
  }
  for (const [host, rects] of [...hosts]) {
    const final = rects.length ? stitchLines(mergeLineRects(rects), lineHeight) : [];
    if (final.length) {
      hosts.set(host, final);
      // 只有真的画出覆盖层的块才藏原生直角高亮：一颗矩形都没有时藏了就是「选了没反应」。
      const block = hostBlock.get(host);
      if (block) blocks.add(block);
    } else {
      hosts.delete(host);
    }
  }
  return { blocks: [...blocks], hosts };
}

class WidgetSelectionLayer {
  private layers = new Map<HTMLElement, HTMLElement>();
  private blocks = new Set<HTMLElement>();
  private frame = 0;
  private readonly mutations: MutationObserver;

  constructor(private readonly view: EditorView) {
    document.addEventListener("selectionchange", this.schedule);
    document.addEventListener("scroll", this.schedule, true);
    window.addEventListener("resize", this.schedule);
    // 上色 / 展开收起会把 `<pre>` 整颗换掉，覆盖层得跟着搬（只在真的有选区时重画）。
    this.mutations = new MutationObserver((records) => {
      if (!this.layers.size) return;
      // 覆盖层自己 replaceChildren 造成的变更不重画，否则每一帧都在循环重建。
      if (records.every((record) => this.ownLayerNode(record.target))) return;
      this.schedule();
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

  private ownLayerNode(node: Node): boolean {
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    return !!element?.closest(`.${LAYER_CLASS}`);
  }

  private readonly schedule = (): void => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  };

  private clear(): void {
    for (const [host, layer] of this.layers) {
      layer.remove();
      host.classList.remove(HOST_CLASS);
    }
    this.layers.clear();
    for (const block of this.blocks) block.classList.remove(BLOCK_CLASS);
    this.blocks.clear();
    this.view.dom.classList.remove(ACTIVE_CLASS);
  }

  private draw(): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return this.clear();
    const plan = widgetSelectionPlans(
      selection.getRangeAt(0),
      this.view.contentDOM,
      this.view.defaultLineHeight,
    );
    if (!plan.hosts.size) return this.clear();
    this.sync(plan);
    this.view.dom.classList.add(ACTIVE_CLASS);
  }

  private sync(plan: WidgetSelectionPlan): void {
    for (const [host, layer] of [...this.layers]) {
      if (plan.hosts.has(host)) continue;
      layer.remove();
      host.classList.remove(HOST_CLASS);
      this.layers.delete(host);
    }
    for (const block of this.blocks) {
      if (!plan.blocks.includes(block)) block.classList.remove(BLOCK_CLASS);
    }
    this.blocks = new Set(plan.blocks);
    for (const block of this.blocks) block.classList.add(BLOCK_CLASS);

    for (const [host, rects] of plan.hosts) {
      let layer = this.layers.get(host);
      if (!layer) {
        host.classList.add(HOST_CLASS);
        layer = document.createElement("div");
        layer.className = LAYER_CLASS;
        layer.setAttribute("contenteditable", "false");
        layer.setAttribute("aria-hidden", "true");
        host.append(layer);
        this.layers.set(host, layer);
      }
      const corners = selectionCorners(rects);
      layer.replaceChildren(
        ...rects.map((rect, index) => {
          const element = document.createElement("div");
          element.className = "cm-selectionBackground";
          element.style.cssText = `position:absolute;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
          applyCorners(element, corners[index]);
          return element;
        }),
      );
    }
  }
}

/** 预览块里原生选区的圆角覆盖层。 */
export function widgetSelection() {
  return ViewPlugin.fromClass(WidgetSelectionLayer);
}

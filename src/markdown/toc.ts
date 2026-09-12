import type { TocEntry } from "./pipeline";

/**
 * 大纲 TOC 抽屉（M3）：渲染活动 Markdown 标签的标题大纲，点击跳转。
 */

export interface TocCallbacks {
  onJump: (entry: TocEntry) => void;
}

/** 大纲抽屉宽度（px）：拖拽可调，双击分隔条恢复默认。 */
export const TOC_DEFAULT_WIDTH = 240;
export const TOC_MIN_WIDTH = 160;
export const TOC_MAX_WIDTH = 640;

/** 把任意输入收敛到合法宽度（NaN/非法值回落默认，取整避免亚像素抖动）。 */
export function clampTocWidth(width: number): number {
  if (!Number.isFinite(width)) return TOC_DEFAULT_WIDTH;
  return Math.min(TOC_MAX_WIDTH, Math.max(TOC_MIN_WIDTH, Math.round(width)));
}

export interface TocResizerOptions {
  /** 初始宽度（一般由设置载入，非法值自动收敛） */
  initial: number;
  /** 拖拽结束 / 双击重置后回调，供调用方持久化 */
  onChange: (width: number) => void;
}

export interface TocResizerHandle {
  getWidth(): number;
  setWidth(width: number): void;
}

/**
 * 给大纲抽屉挂上可拖拽的宽度分隔条。
 *
 * 说明：分隔条是独立元素（#toc-resizer）而非面板边框，因为 WebView2 下
 * `dragDropEnabled: true` 会禁用页面内 HTML5 拖放，这里沿用与分屏一致的
 * 指针事件序列（mousedown → document mousemove/mouseup）自行编排。
 */
export function attachTocResizer(
  resizer: HTMLElement,
  panel: HTMLElement,
  opts: TocResizerOptions,
): TocResizerHandle {
  let width = clampTocWidth(opts.initial);

  const apply = (w: number): void => {
    // 同时写 width 与 min-width：父容器是 flex 行，min-width 才能挡住被挤压
    panel.style.width = `${w}px`;
    panel.style.minWidth = `${w}px`;
  };
  apply(width);

  resizer.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    document.body.classList.add("layout-dragging");

    const onMove = (ev: MouseEvent): void => {
      // 大纲在左侧，向右拖 = 变宽
      width = clampTocWidth(startWidth + (ev.clientX - startX));
      apply(width);
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("layout-dragging");
      opts.onChange(width);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // 双击分隔条恢复默认宽度
  resizer.addEventListener("dblclick", () => {
    width = TOC_DEFAULT_WIDTH;
    apply(width);
    opts.onChange(width);
  });

  return {
    getWidth: () => width,
    setWidth: (w: number) => {
      width = clampTocWidth(w);
      apply(width);
    },
  };
}

export function renderToc(
  host: HTMLElement,
  entries: TocEntry[],
  activeLine: number,
  cb: TocCallbacks,
): void {
  host.textContent = "";
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "toc-empty";
    empty.textContent = "当前文档没有标题";
    host.appendChild(empty);
    return;
  }
  for (const e of entries) {
    const item = document.createElement("button");
    item.type = "button";
    item.className =
      "toc-item toc-h" + e.level + (e.line === activeLine ? " toc-active" : "");
    item.textContent = e.text || "(无标题)";
    item.title = `第 ${e.line} 行`;
    item.addEventListener("click", () => cb.onJump(e));
    host.appendChild(item);
  }
}

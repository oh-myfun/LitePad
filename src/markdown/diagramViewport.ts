// B455-5 · 图表的视口变换层：滚轮缩放 + 拖拽平移 + 右上角三颗键。
//
// 用户拍板的两条口径：
// · **统一外层变换** —— 八类图（mermaid / 脑图 / Graphviz / Flowchart / PlantUML / ECharts /
//   五线谱 / WaveDrom）共用这一层，画什么由各自渲染器管，这层只搬动成品。脑图自带那颗
//   d3-zoom 要给它让位（B455-6：在这里捕获掉 wheel / mousedown，markmap 就收不到了）。
// · **拖过阈值算平移，纯点击仍进编辑** —— 点图进编辑（B434/B454）不许因为加了拖拽而丢掉，
//   所以这里不直接改文档，只发一颗 `md-diagram-tap`，由预览面的 widget 决定要不要浮源码框。
//
// 变换作用在 `.md-diagram-canvas`（enhance 建的那一层，渲染结果都落在里面），按键挂在**卡片**上：
// 渲染器会反复清空 canvas（mermaid 甚至直接 `innerHTML =`），按键不能跟着被抹掉。
//
// 监听一律走**捕获相**：这不是风格问题 —— B454-2 真机抓到 d3-zoom 在 mousedown 里
// `stopImmediatePropagation()`，冒泡档的监听器永远收不到那一发。

import { setTip } from "../shell/tooltip";

/** 视口状态：先平移后缩放（`translate(x, y) scale(k)`），原点钉在 canvas 自己的左上角。 */
export interface DiagramView {
  x: number;
  y: number;
  scale: number;
}

export const IDLE_VIEW: DiagramView = { x: 0, y: 0, scale: 1 };

export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 8;
/** 滚轮一档 1.15×：贴着滚轮的节奏，连滚不闪。 */
const WHEEL_STEP = 1.15;
/** 按键一档 1.3×：有意按的就给大一点，两颗键能拉开明显一档。 */
const BUTTON_STEP = 1.3;
/** 拖过这几个像素算「平移」，没越过算「点一下」—— 手抖不该把「改图」变成「搬图」。 */
const DRAG_THRESHOLD_PX = 4;

/** 「点了一下画好的图」：由预览面的 widget 接手（浮源码框），这里不碰文档。 */
export const DIAGRAM_TAP_EVENT = "md-diagram-tap";

/**
 * 「这一下双击是视图操作（复位）」：编辑入口据此把刚浮出来的源码框收回 ——
 * 双击的第一发点击按「纯点击仍进编辑」已经浮过一次，既然整发改判成搬图，就不该留在编辑态。
 */
export const DIAGRAM_RESET_EVENT = "md-diagram-reset";

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/**
 * 以 `at` 为锚缩放（`at` 是相对 canvas 未变换原点的指针位置）：那一点在屏幕上不许跑掉。
 *
 * 屏幕位置 s = x + scale·c（c 是被锚住的内容点）⇒ x' = at - (at - x)·(scale'/scale)。
 * 已经顶到档位上下限时**整发不动**（连偏移也不动）：否则图会在按到底之后一路飘。
 */
export function zoomAt(
  view: DiagramView,
  factor: number,
  at: { x: number; y: number },
): DiagramView {
  const scale = clamp(view.scale * factor, ZOOM_MIN, ZOOM_MAX);
  if (scale === view.scale) return view;
  const k = scale / view.scale;
  return { scale, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k };
}

/** 平移只搬位置，不动倍率。 */
export function panBy(view: DiagramView, dx: number, dy: number): DiagramView {
  return { ...view, x: view.x + dx, y: view.y + dy };
}

/** 指针相对 canvas 未变换原点的落点：卡片的位置 + canvas 在卡片里的偏移都扣掉。 */
function pointerAt(
  event: MouseEvent,
  card: HTMLElement,
  canvas: HTMLElement,
): { x: number; y: number } {
  const rect = card.getBoundingClientRect();
  return {
    x: event.clientX - rect.left - canvas.offsetLeft,
    y: event.clientY - rect.top - canvas.offsetTop,
  };
}

/** 给画好的图装上「滚轮缩放 + 拖拽平移 + 右上角三颗键」。同一张卡片重复调用只生效一次。 */
export function attachDiagramViewport(card: HTMLElement): void {
  const canvas = card.querySelector<HTMLElement>(".md-diagram-canvas");
  if (!canvas || card.querySelector(".md-diagram-zoom")) return;

  let view = IDLE_VIEW;
  const draw = (): void => {
    canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  };

  // ---- 右上角三颗键（用户点名：放大 / 缩小 / 复位）----
  const bar = document.createElement("div");
  bar.className = "md-diagram-zoom";
  // 按键的锚 = 那一格可见区域的中心：用键盘点的人没有「光标落在哪」这回事。
  const center = (): { x: number; y: number } => ({
    x: canvas.clientWidth / 2,
    y: canvas.clientHeight / 2,
  });
  const addKey = (cls: string, glyph: string, label: string, on: () => void): void => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `codicon codicon-${glyph} ${cls}`;
    setTip(btn, label);
    btn.setAttribute("aria-label", label);
    btn.addEventListener("click", on);
    bar.append(btn);
  };
  addKey("md-diagram-zoom-in", "zoom-in", "放大", () => {
    view = zoomAt(view, BUTTON_STEP, center());
    draw();
  });
  addKey("md-diagram-zoom-out", "zoom-out", "缩小", () => {
    view = zoomAt(view, 1 / BUTTON_STEP, center());
    draw();
  });
  addKey("md-diagram-zoom-reset", "screen-normal", "复位视图", () => {
    view = IDLE_VIEW;
    draw();
  });
  card.append(bar);
  draw();

  // ---- 滚轮：以光标为锚缩放，顺带把这一发从「翻文档」里收走 ----
  card.addEventListener(
    "wheel",
    (event) => {
      const wheel = event as WheelEvent;
      if (!wheel.deltaY) return; // 纯横向的触控板手势留给它原来的意思
      wheel.preventDefault();
      // 捕获相 + stopPropagation：脑图那颗 d3-zoom 收到同一发会自己再缩放一遍（B455-6）
      wheel.stopPropagation();
      view = zoomAt(
        view,
        wheel.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP,
        pointerAt(wheel, card, canvas),
      );
      draw();
    },
    { capture: true, passive: false },
  );

  // ---- 左键：拖过阈值算平移，没越过算点一下 ----
  card.addEventListener(
    "mousedown",
    (event) => {
      const mouse = event as MouseEvent;
      if (mouse.button !== 0) return;
      // 按键那一格自己处理：在那里按下既不该开始平移，也不该被当成「点图进编辑」
      if ((mouse.target as HTMLElement | null)?.closest(".md-diagram-zoom")) return;
      mouse.preventDefault(); // 不许顺手选中图里的字 / 让编辑器把光标落到块里
      mouse.stopPropagation(); // d3-zoom 也别接这一发

      let dragging = false;
      let lastX = mouse.clientX;
      let lastY = mouse.clientY;

      const onMove = (move: MouseEvent): void => {
        if (
          !dragging &&
          Math.hypot(move.clientX - lastX, move.clientY - lastY) < DRAG_THRESHOLD_PX
        ) {
          return;
        }
        if (!dragging) {
          dragging = true;
          card.classList.add("md-diagram--panning");
        }
        view = panBy(view, move.clientX - lastX, move.clientY - lastY);
        lastX = move.clientX;
        lastY = move.clientY;
        draw();
      };
      // 挂在 document 上：拖出卡片之外松手也算这一发（只挂卡片就会漏一半，图停在半路）
      const onUp = (): void => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        card.classList.remove("md-diagram--panning");
        if (!dragging) {
          card.dispatchEvent(new CustomEvent(DIAGRAM_TAP_EVENT, { bubbles: true }));
        }
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    true,
  );

  // ---- 双击 = 复位（B456：用户「支持图表空白区域双击进行复位」）----
  card.addEventListener("dblclick", (event) => {
    // 按键那一格上的双击归按键（连点两发放大），不许被当成复位
    if ((event.target as HTMLElement | null)?.closest(".md-diagram-zoom")) return;
    event.preventDefault(); // 顺手掐掉「双击选词」：图里的字本来就不该被这一发选中
    view = IDLE_VIEW;
    draw();
    card.dispatchEvent(new CustomEvent(DIAGRAM_RESET_EVENT, { bubbles: true }));
  });
}

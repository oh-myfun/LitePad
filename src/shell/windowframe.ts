/**
 * 应用内浮层窗框（B353）：一条标题栏 + 八向调整大小的把手，把一块内容变成「窗口」。
 *
 * 用户口径：「设置页面也参考 vscode 做成带标题栏可拖拽和可调整大小的设置窗口」。
 *
 * **为什么是应用内浮层，而不是第二个 Tauri 窗口**（我的裁定，代价写在下面）：
 * 设置页每一项生效的方式都是往**当前文档**写 CSS 变量（`src/appearance.ts` 那批 apply*），
 * 换成真窗口就要给每一项补一条跨窗广播 + 一份回读，改动面从「一个壳」扩散到「所有设置项」。
 * 代价：它拖不出主窗口、不进 Alt-Tab、也不带系统阴影。
 *
 * 几何全部是纯函数（`centeredRect` / `clampMove` / `clampResize`）：jsdom 没有布局引擎，
 * 所有 `getBoundingClientRect()` 都是 0，只有把「算坐标」与「写 style」分开才测得动
 * （同 `shell/tooltip.ts` 的路子）。装配层 `buildFrame` 因此**不读自己的 rect**，
 * 位置尺寸一律由内部那份 `WinRect` 状态推导。
 */

import { CODICONS } from "./codicons";
import { setTip } from "./tooltip";

export interface WinRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WinViewport {
  w: number;
  h: number;
}

/** 八向把手：四边 + 四角（`n` = 上边，`se` = 右下角）。 */
export type WinEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const EDGES: readonly WinEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/**
 * 下限：宽 520 = 设置页「导航 + 内容」两栏还能各站得住；高 360 = 标题栏 + 搜索条 +
 * 两三行设置项。比这更小就不是窗口而是残块了（用户拿它调过也要能调回来）。
 */
export const WIN_MIN: { readonly w: number; readonly h: number } = {
  w: 520,
  h: 360,
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * 某个方向上「起点能落在 0 ~ vp - size」；窗口比视口还大时上下界会反过来，
 * 那样 `Math.min(Math.max(...))` 会把值弹到 hi（负数）⇒ 这一档**以 0 为准**，钉在原点。
 */
function span(size: number, vp: number): [number, number] {
  return size >= vp ? [0, 0] : [0, vp - size];
}

/** 打开时的默认位：视口正中，取整避免半像素缝。 */
export function centeredRect(vp: WinViewport, w: number, h: number): WinRect {
  return {
    x: Math.max(0, Math.round((vp.w - w) / 2)),
    y: Math.max(0, Math.round((vp.h - h) / 2)),
    w,
    h,
  };
}

/** 拖标题栏：只改 x/y，整窗不许离开视口（比视口大时钉 0）。 */
export function clampMove(r: WinRect, dx: number, dy: number, vp: WinViewport): WinRect {
  const [xLo, xHi] = span(r.w, vp.w);
  const [yLo, yHi] = span(r.h, vp.h);
  return { ...r, x: clamp(r.x + dx, xLo, xHi), y: clamp(r.y + dy, yLo, yHi) };
}

/**
 * 拖某一条边/角：**对边钉住**（那条边不动），被拖的边按 min/max 收。
 *
 * ⚠️ 撞限时要改的是「被拖那条边的位置」而不是尺寸：左/上向被拖时 x 才是自变量
 * （`x ∈ [锚 - vp, 锚 - min]`，宽 = 锚 − x），右/下向被拖时宽是自变量。
 * 反过来写会出现「已经最小了、x 还在往锚那边推」⇒ 窗口穿过对边继续跑。
 */
export function clampResize(
  r: WinRect,
  edge: WinEdge,
  dx: number,
  dy: number,
  vp: WinViewport,
  min: { w: number; h: number } = WIN_MIN,
): WinRect {
  let { x, y, w, h } = r;
  const east = edge.includes("e");
  const west = edge.includes("w");
  const north = edge.includes("n");
  const south = edge.includes("s");

  if (east) {
    // 上限就是视口（右边不许出屏）。下限在**视口比 WIN_MIN 还窄**时让位：
    // 那种屏上窗口本来就比下限小，再拿 520 去夹会把右沿推出屏外 ⇒ e / ne / se 三根
    // 把手根本抓不到（真机视口有 560 的地板兜着，这条是给极端窗口与将来改动留的）。
    const hi = Math.max(0, vp.w - x);
    w = clamp(w + dx, Math.min(min.w, hi), hi);
  } else if (west) {
    const anchor = x + w; // 右沿钉住
    x = clamp(x + dx, Math.max(0, anchor - vp.w), Math.max(0, anchor - min.w));
    w = anchor - x;
  }

  if (south) {
    const hi = Math.max(0, vp.h - y);
    h = clamp(h + dy, Math.min(min.h, hi), hi);
  } else if (north) {
    const anchor = y + h; // 下沿钉住
    y = clamp(y + dy, Math.max(0, anchor - vp.h), Math.max(0, anchor - min.h));
    h = anchor - y;
  }

  return { x, y, w, h };
}

export interface FrameOptions {
  /** 标题栏文字（同时是 aria-label 的来源） */
  title: string;
  /** 初始位与尺寸；之后由拖拽/缩放自己维护 */
  rect: WinRect;
  /** 视口取值器（注入是为了能测：jsdom 里 window.innerWidth 是写死的） */
  viewport: () => WinViewport;
  /** 点标题栏关闭键时回调；**摘不摘 DOM 归调用方**（有的要淡出、有的要落状态） */
  onClose: () => void;
  /** 挂到哪个父节点上（遮罩层） */
  host: HTMLElement;
  /** 额外类名，如 `settings-window`（尺寸档与内容样式归调用方） */
  className?: string;
}

export interface WinFrame {
  root: HTMLElement;
  head: HTMLElement;
  /** 内容槽：调用方把自己的东西塞这里 */
  body: HTMLElement;
  /** 当前几何（一份拷贝，改它不影响窗口） */
  rect: () => WinRect;
}

/**
 * 装一个浮层窗口：`.win-frame` = `.win-head`（标题 + 关闭）+ `.win-body`（内容槽）+ 八向把手。
 *
 * 位置尺寸一律写 inline style（`.win-frame` 只给 `position: fixed` 一类静态声明），
 * 因为它就是「用户能拖着走的盒子」，居中那套 flex 规则对它不成立。
 */
export function buildFrame(o: FrameOptions): WinFrame {
  const root = document.createElement("div");
  root.className = "win-frame" + (o.className ? ` ${o.className}` : "");

  const head = document.createElement("div");
  head.className = "win-head";
  const title = document.createElement("span");
  title.className = "win-title";
  title.textContent = o.title;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "win-head-close";
  close.setAttribute("aria-label", `关闭${o.title}`);
  close.innerHTML = CODICONS.close;
  // B350 口径：图标键的提示走按钮档（带尖尖）—— 文案在这里定义一处。
  setTip(close, "关闭");
  head.append(title, close);

  const body = document.createElement("div");
  body.className = "win-body";

  root.append(head, body);
  for (const edge of EDGES) {
    const grip = document.createElement("div");
    grip.className = "win-resize";
    grip.dataset.edge = edge;
    root.appendChild(grip);
  }

  let cur: WinRect = { ...o.rect };
  const paint = (): void => {
    root.style.left = `${cur.x}px`;
    root.style.top = `${cur.y}px`;
    root.style.width = `${cur.w}px`;
    root.style.height = `${cur.h}px`;
  };
  paint();

  /** 一次拖拽：按下点为原点，每次 move 都从**按下时的几何**重算（累加会漂）。 */
  const startDrag = (mode: "move" | WinEdge, e: MouseEvent): void => {
    e.preventDefault();
    if (mode !== "move") e.stopPropagation(); // 把手的按下不该被当成「点背景」
    const sx = e.clientX;
    const sy = e.clientY;
    const from: WinRect = { ...cur };
    const vp = o.viewport;
    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      cur = mode === "move" ? clampMove(from, dx, dy, vp()) : clampResize(from, mode, dx, dy, vp());
      paint();
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  head.addEventListener("pointerdown", (e) => startDrag("move", e as MouseEvent));
  for (const grip of Array.from(root.querySelectorAll<HTMLElement>(".win-resize"))) {
    grip.addEventListener("pointerdown", (e) =>
      startDrag(grip.dataset.edge as WinEdge, e as MouseEvent),
    );
  }
  close.addEventListener("click", o.onClose);
  // 关闭键坐在标题栏里 ⇒ 它的按下会顺着冒泡进「拖窗口」那条路。浏览器在 pointerdown 上
  // 调了 preventDefault 之后仍会派发 click，但真机那一下要不要移动窗口就不一定了 ——
  // 掐在源头：这颗键的按下只属于这颗键（同 `actionbar` 里动作项不吃拖动）。
  close.addEventListener("pointerdown", (e) => e.stopPropagation());

  o.host.appendChild(root);
  return { root, head, body, rect: () => ({ ...cur }) };
}

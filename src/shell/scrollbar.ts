// 标签栏滚动交互 + B117 自绘悬浮滚动条（从 tabstrip.ts 拆出，P2 余下内聚拆分）。
//
// 职责：横向滚轮（bindWheel / onWheel / deltaMode 归一）与自绘悬浮滚动条
// （ensureOverlayScrollbar / syncOverlayScrollbar / revealScrollbar / hideScrollbar /
// bindThumbDrag），以及各自的模块级状态（wheelBound / scrollbars WeakMap）。
// 纯叶子：只碰 DOM 与自身状态，对 tabstrip.ts 零反向依赖；tabstrip.ts 在
// renderTabstrip 里调 bindWheel / ensureOverlayScrollbar / syncOverlayScrollbar 三个出口。

/** wheel 监听只挂一次（同一 host 会被反复重绘）。 */
const wheelBound = new WeakSet<HTMLElement>();

/**
 * 滚轮 deltaMode 归一化系数：某些设备/驱动按「行」或「页」上报 delta，
 * 直接当像素用会几乎滚不动（deltaMode=1 时 delta 常常只有 3）。
 */
const LINE_PX = 16;

// ---------------------------------------------------------------- B117 自绘悬浮滚动条
// 原生横向滚动条在 Chromium 里**永远占布局空间**（哪怕 1px 也把内容区压矮），
// 做不出 VS Code 那种「悬浮在内容上、不用时不占高度」的形态 —— 所以自绘：
// 溢出时在标签条底部叠一条半透明细 thumb（悬浮、不占布局），拖 thumb /
// 滚轮 / ensureVisible 都只是改 host.scrollLeft，由 scroll 事件反向同步 thumb。
// B125：thumb 默认**隐藏**（VS Code 标签条走 ScrollbarVisibility.Auto）：
//   悬停条带 / 滚动 / 拖 thumb 才出现，离开或停手 500ms 后淡出（见下方 B125 段）；
//   几何由 ResizeObserver 跟随面板宽度变化 —— 拖分屏条不改窗口尺寸，
//   光靠 window.resize 会让 thumb 停在旧宽度上。
// 结构：strip 外面包一层 .panel-tabstrip-wrap（position:relative），bar 是
// wrap 的兄弟绝对定位 —— 不能放进 strip 里：滚动容器的 absolute 子元素会
// 随内容滚走，钉不住在可视区边缘。

/** wheel 监听只挂一次（同一 host 会被反复重绘）。 */
export function bindWheel(host: HTMLElement): void {
  if (wheelBound.has(host)) return;
  wheelBound.add(host);
  // passive:false 才能 preventDefault；非 passive 下滚轮才不会被页面抢走
  host.addEventListener("wheel", (e) => onWheel(host, e), { passive: false });
}

/** 自绘滚动条「可见」类（B125：默认隐藏，用时才挂 —— 见下方 B125 段）。 */
const SCROLLBAR_VISIBLE = "is-visible";
/** B125：出现后多久淡出 = VS Code `scrollableElement.ts` 的 HIDE_TIMEOUT（500ms）。 */
const SCROLLBAR_HIDE_DELAY = 500;

interface ScrollbarState {
  bar: HTMLElement;
  timer: number;
  hovering: boolean;
  dragging: boolean;
}
const scrollbars = new WeakMap<HTMLElement, ScrollbarState>();

/** 让滚动条出现；`transient` = 由滚动/程序定位唤起（非悬停），到点自动淡出。 */
function revealScrollbar(host: HTMLElement, transient = false): void {
  const st = scrollbars.get(host);
  // 不溢出（放得下）时连「出现」都不该发生 —— 对应 VS Code 的 setIsNeeded(false)：
  // 没有滚动条可用，唤起了也是一条没意义的空轨道。
  if (!st || st.bar.style.display === "none") return;
  if (st.timer) {
    window.clearTimeout(st.timer);
    st.timer = 0;
  }
  st.bar.classList.add(SCROLLBAR_VISIBLE);
  if (!transient || st.hovering || st.dragging) return;
  st.timer = window.setTimeout(() => {
    st.timer = 0;
    if (!st.hovering && !st.dragging) st.bar.classList.remove(SCROLLBAR_VISIBLE);
  }, SCROLLBAR_HIDE_DELAY);
}

/** 收起（指针离开 / 拖完手）；悬停或拖拽中不动 —— 与 VS Code 的 _hide 同判据。 */
function hideScrollbar(host: HTMLElement): void {
  const st = scrollbars.get(host);
  if (!st) return;
  if (st.timer) {
    window.clearTimeout(st.timer);
    st.timer = 0;
  }
  if (!st.hovering && !st.dragging) st.bar.classList.remove(SCROLLBAR_VISIBLE);
}

/** B117：溢出状态变化时同步 thumb 几何（scroll / resize / 重绘都调它）。
 *  B125：不溢出时连「可见」类一起摘 —— 免得下次溢出时带着上一次的可见态闪一下。 */
export function syncOverlayScrollbar(host: HTMLElement): void {
  const bar = host.parentElement?.querySelector<HTMLElement>(":scope > .panel-tabstrip-scrollbar");
  if (!bar) return; // 尚未包裹（首帧前），renderTabstrip 末尾会再同步一次
  const max = host.scrollWidth - host.clientWidth;
  if (max <= 0) {
    bar.style.display = "none";
    bar.classList.remove(SCROLLBAR_VISIBLE);
    return;
  }
  bar.style.display = "";
  const thumb = bar.firstElementChild as HTMLElement | null;
  if (!thumb) return;
  const track = bar.clientWidth;
  const ratio = host.clientWidth / host.scrollWidth; // thumb 占轨道比例 = 可视占比
  const w = Math.max(24, Math.round(track * ratio));
  const x = Math.round((host.scrollLeft / max) * (track - w));
  thumb.style.width = `${w}px`;
  thumb.style.transform = `translateX(${x}px)`;
}

/**
 * B117：确保 host 被包在 .panel-tabstrip-wrap 里并挂上自绘滚动条。
 * 幂等：重复 renderTabstrip 只建一次；wrap 包裹一次后 host 的兄弟关系不再变。
 */
export function ensureOverlayScrollbar(host: HTMLElement): void {
  let wrap = host.parentElement;
  if (!wrap || !wrap.classList.contains("panel-tabstrip-wrap")) {
    wrap = document.createElement("div");
    wrap.className = "panel-tabstrip-wrap";
    host.replaceWith(wrap);
    wrap.append(host);
  }
  let bar = wrap.querySelector<HTMLElement>(":scope > .panel-tabstrip-scrollbar");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "panel-tabstrip-scrollbar";
    const thumb = document.createElement("div");
    thumb.className = "panel-tabstrip-scrollbar-thumb";
    bar.append(thumb);
    wrap.append(bar);
    scrollbars.set(host, { bar, timer: 0, hovering: false, dragging: false });
    // 程序滚动（ensureVisible / 滚轮 / 重绘恢复）也会触发 scroll 事件，
    // 一处监听覆盖全部来源；拖拽 thumb 与 resize 时再手动同步。
    host.addEventListener("scroll", () => {
      syncOverlayScrollbar(host);
      revealScrollbar(host, true); // B125：滚动唤起，停手 500ms 后淡出
    });
    window.addEventListener("resize", () => syncOverlayScrollbar(host));
    // B125：面板宽度变化（拖分屏条 / 面板最大化 / 布局切换）**不触发 window.resize**
    // —— 只有 ResizeObserver 兜得住，否则 thumb 宽度/位置会停在旧面板尺寸上。
    // ⚠️ B53 那句「不再手写 ResizeObserver」说的是**可见窗口记账**（已被原生滚动
    //    取代）；这里是另一种用途：只改 thumb 几何，不自己算「滚到哪」。
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => syncOverlayScrollbar(host)).observe(host);
    }
    // 悬停即现 / 离开即收（VS Code 的 _onMouseOver / _onMouseLeave）
    wrap.addEventListener("pointerenter", () => {
      const st = scrollbars.get(host);
      if (st) st.hovering = true;
      revealScrollbar(host);
    });
    wrap.addEventListener("pointerleave", () => {
      const st = scrollbars.get(host);
      if (st) st.hovering = false;
      hideScrollbar(host);
    });
    bindThumbDrag(host, bar, thumb);
  }
}

/** B117：thumb 拖拽 —— pointer 换算成 scrollLeft，与原生滚动条手感一致。 */
function bindThumbDrag(host: HTMLElement, bar: HTMLElement, thumb: HTMLElement): void {
  thumb.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const max = host.scrollWidth - host.clientWidth;
    if (max <= 0) return;
    const track = bar.clientWidth;
    const w = thumb.offsetWidth;
    const startX = e.clientX;
    const startScroll = host.scrollLeft;
    const st = scrollbars.get(host);
    if (st) st.dragging = true;
    revealScrollbar(host); // 拖拽期间常显（VS Code 的 _isDragging 同判据）
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - startX;
      host.scrollLeft = Math.max(0, Math.min(max, startScroll + (dx / (track - w)) * max));
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (st) st.dragging = false;
      revealScrollbar(host, true); // 松手后 500ms 淡出（指针若还在条带上则保持）
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

/** 滚轮：横向滚动标签栏（Ctrl+滚轮让位给字号缩放）。 */
function onWheel(host: HTMLElement, e: WheelEvent): void {
  if (e.ctrlKey) return;
  const max = host.scrollWidth - host.clientWidth;
  if (max <= 0) return; // 没溢出：不处理也不拦截
  const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  // deltaMode：0=像素 1=行 2=页
  const delta =
    e.deltaMode === 1 ? raw * LINE_PX : e.deltaMode === 2 ? raw * host.clientWidth : raw;
  if (!delta) return;
  const before = host.scrollLeft;
  host.scrollLeft = Math.max(0, Math.min(max, before + delta));
  // 已经贴到边界、同方向再也滚不动 → 不吞事件，留给页面
  if (host.scrollLeft === before) return;
  e.preventDefault();
  // B125：滚动即现（这里显式调一次，不依赖 scroll 事件的时序；
  // 程序化滚动（ensureVisible）走 host 的 scroll 监听那条路）
  revealScrollbar(host, true);
}

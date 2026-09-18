/**
 * 应用级 tooltip 层（B58）：取代原生 `title`。
 *
 * **为什么不用 `title`**：原生提示由操作系统绘制，样式**完全不可控** —— 不支持主题
 * 配色、圆角、键帽（快捷键）、第二行小字，延迟也由系统决定（约 1s）；深色界面里会
 * 突兀地弹出一个浅色系统气泡，浅色主题下则与周围风格不搭。
 *
 * 数值与做法取自 VS Code（`docs/vscode-reference/`，MIT 只读副本）：
 *
 * - `src/vs/platform/hover/browser/hover.css`（`.monaco-hover.workbench-hover`）——外观：
 *   `font-size: 13px` / `line-height: 19px`、`max-width`、`editorHoverWidget.background`
 *   与 `.border` 取色、圆角 5px（**带指针时 3px**）、`box-shadow: var(--vscode-shadow-lg)`；
 *   指针（caret）是 6px 方块旋转 45°，**只画朝外的两条边**，`pointer-events: none`。
 * - `src/vs/base/browser/ui/hover/hoverWidget.css`——`.hover-contents { padding: 4px 8px }`、
 *   `cursor: default`、`user-select: text`、`fade-in 100ms linear`。
 * - `src/vs/platform/hover/browser/hoverWidget.ts`——`PointerSize = 3`、
 *   `HoverWindowEdgeMargin = 2`，以及指针定位规则：**默认居中于提示框，若中心点跑出
 *   目标横向范围就改为对准目标中心**。
 * - `src/vs/workbench/browser/workbench.contribution.ts`——`workbench.hover.delay`
 *   默认 **500ms**（注释原话：Windows/Linux 上 500ms 最接近原生提示）。
 * - `src/vs/platform/hover/browser/hoverService.ts`——`groupId` 规则：**同一组内的相邻
 *   目标秒开，且跳过淡入动画**（所以顺着工具栏滑过去时提示跟手、不闪）。
 * - `src/vs/base/browser/ui/keybindingLabel/keybindingLabel.css` + `inputColors.ts`——
 *   快捷键渲染成**键帽**（11px、`padding: 3px 5px`、`border-radius: 3px`、
 *   `min-width: 12px`），配色取 `keybindingLabel.background/foreground/border/bottomBorder`。
 *
 * ⚠️ 与 VS Code 的**两处有意偏离**（改之前先读这里）：
 * 1. `max-width` 取 **420px**（VS Code 是 700px）—— 700px 是给树视图里的长文本留的，
 *    LitePad 的提示都是短标签或一条路径，窄一点更不挡视线。
 * 2. 提示层 `pointer-events: none` —— 我们的提示紧贴目标，若可交互，鼠标从目标滑到
 *    提示上会让目标的 `:hover` 断掉、提示闪烁。代价是不能选中提示文字（不需要）。
 *
 * 用法：
 * ```ts
 * setTip(btn, "关闭", { key: "Ctrl+W" });   // 动态创建的控件
 * ```
 * ```html
 * <button data-tip="新建" data-tip-key="Ctrl+N" aria-label="新建 (Ctrl+N)"></button>
 * ```
 * 同一容器内的提示要「秒开」就在容器上标 `data-tip-group="xxx"`（见 `groupOf`）。
 */

export type TipPlacement = "top" | "bottom";

export interface TipOptions {
  /** 右侧的快捷键，如 `"Ctrl+Shift+P"`；按 `+` 拆成键帽 */
  key?: string;
  /** 第二行补充说明（完整路径、行列号等），小字弱色 */
  detail?: string;
  /** 首选方位，默认 `bottom`（提示框在目标下方）；放不下会自动翻到另一侧 */
  placement?: TipPlacement;
  /** 同组标识；也可改在容器上写 `data-tip-group` */
  group?: string;
}

/** VS Code `workbench.hover.delay` 的 Windows 默认值（本项目仅 Windows） */
const SHOW_DELAY = 500;
/** 离开目标后的宽限：给「顺着工具栏滑到下一条」留出秒开的窗口（配合 groupId 规则） */
const HIDE_GRACE = 220;
/** VS Code `Constants.PointerSize`：caret 是 6px 方块，一半是 3px */
const POINTER = 3;
/** 目标与提示框之间的间隙，正好由 caret 那 4.24px 的对角线填满并轻触目标 */
const GAP = 4;
/** VS Code `Constants.HoverWindowEdgeMargin`：提示框离窗口边缘的最小距离 */
const EDGE = 2;
/** caret 中心距提示框端部的最小距离（避开圆角，否则 caret 会啃掉边框） */
const CARET_MARGIN = 7;

export interface TipRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
export interface TipSize {
  width: number;
  height: number;
}
export interface TipGeometry {
  x: number;
  y: number;
  placement: TipPlacement;
  /** caret 左边距（相对提示框），由调用方写进 `style.left` */
  caretLeft: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * 纯函数定位：把「目标 / 提示框 / 视口」三组矩形算成最终坐标。
 *
 * 抽成纯函数是为了**能测** —— 翻转与夹取规则是这块最容易写错的部分，
 * 而 jsdom 没有任何布局能力（所有 rect 都是 0），只能靠喂数字来验证。
 */
export function computeTipGeometry(
  target: TipRect,
  tip: TipSize,
  viewport: TipSize,
  preferred: TipPlacement,
): TipGeometry {
  const centerX = (target.left + target.right) / 2;

  // ① 垂直：先按首选方位算，越界就翻到另一侧（对应 VS Code 的 adjustVerticalHoverPosition）
  let placement = preferred;
  if (placement === "bottom" && target.bottom + GAP + tip.height > viewport.height - EDGE) {
    placement = "top";
  } else if (placement === "top" && target.top - GAP - tip.height < EDGE) {
    placement = "bottom";
  }
  // 两侧都放不下（窗口太矮）时不再翻，贴边放，溢出交给 CSS 的 max-height
  const y =
    placement === "bottom" ? target.bottom + GAP : Math.max(EDGE, target.top - GAP - tip.height);

  // ② 水平：以目标中心对齐，再夹进视口
  const maxX = Math.max(EDGE, viewport.width - tip.width - EDGE);
  const x = clamp(centerX - tip.width / 2, EDGE, maxX);

  // ③ caret：默认居中于提示框；中心点跑出目标横向范围就改为对准目标中心
  let caretLeft = tip.width / 2 - POINTER;
  const caretCenter = x + caretLeft + POINTER;
  if (caretCenter < target.left || caretCenter > target.right) {
    caretLeft = centerX - x - POINTER;
  }
  // 夹进提示框内：宁可让 caret 贴住角，也不要它溢出到框外（视觉上像坏掉了）
  caretLeft = clamp(caretLeft, CARET_MARGIN - POINTER, tip.width - CARET_MARGIN - POINTER);

  return { x, y, placement, caretLeft };
}

// ---------- 单例状态 ----------

let layer: HTMLDivElement | null = null;
let caretEl: HTMLDivElement | null = null;
let textEl: HTMLSpanElement | null = null;
let detailEl: HTMLSpanElement | null = null;
let keyEl: HTMLSpanElement | null = null;

let showTimer: number | undefined;
let hideTimer: number | undefined;
/** 已经显示出来的目标 */
let shownTarget: HTMLElement | null = null;
/** 正在等延迟、还没显示的目标（离开时要能取消） */
let pendingTarget: HTMLElement | null = null;
let shownGroup: string | undefined;
let mouseDown = false;
let bound = false;

function build(): void {
  if (layer) return;
  layer = document.createElement("div");
  layer.className = "tooltip";
  layer.setAttribute("role", "tooltip");
  layer.hidden = true;

  textEl = document.createElement("span");
  textEl.className = "tooltip-text";

  detailEl = document.createElement("span");
  detailEl.className = "tooltip-detail";

  const body = document.createElement("div");
  body.className = "tooltip-body";
  body.append(textEl, detailEl);

  keyEl = document.createElement("span");
  keyEl.className = "tooltip-key";

  caretEl = document.createElement("div");
  caretEl.className = "tooltip-caret";

  layer.append(body, keyEl, caretEl);
  document.body.appendChild(layer);
}

/** 把 `"Ctrl+Shift+P"` 渲染成一串键帽 + `+` 分隔符（对应 `.monaco-keybinding`） */
function renderKey(key: string): void {
  if (!keyEl) return;
  keyEl.textContent = "";
  const parts = key.split("+");
  parts.forEach((p, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "tooltip-key-sep";
      sep.textContent = "+";
      keyEl!.appendChild(sep);
    }
    const kbd = document.createElement("span");
    kbd.className = "tooltip-kbd";
    kbd.textContent = p;
    keyEl!.appendChild(kbd);
  });
}

/**
 * 菜单是否开着（B70 A 档：开着就不弹提示）。
 *
 * 判据是 DOM 里有没有 `.popup-menu`，而不是去问 menu.ts —— tooltip 与 menu 之间是
 * 单向依赖（menu → tooltip 调 setTip），反过来引用会成环。菜单元素本来就平铺在
 * body 上（各层都要躲开父级 overflow），一次 querySelector 足够准也足够便宜。
 */
function menuOpen(doc: Document): boolean {
  return !!doc.querySelector(".popup-menu");
}

function showFor(el: HTMLElement, immediate: boolean): void {
  // B70 A 档：**菜单开着就绝不弹**。提示层 z-index 2000 是刻意高于菜单 1000 的
  // （好让菜单项也能弹提示），代价就是菜单一开，划过工具栏/状态栏/菜单栏的提示
  // 会浮到菜单之上、正对着下拉展开的位置 —— 用户看到的正是这个重叠。
  // VS Code 的做法更彻底：菜单部件根本不注册悬停提示（menubar.ts / menu.ts 全文
  // 0 次 hover），这里我们只做到「菜单开着时不弹」，其余提示照常保留。
  if (menuOpen(el.ownerDocument)) return;
  const text = el.dataset.tip;
  if (!text || !el.isConnected) return;
  build();
  const l = layer!;

  shownTarget = el;
  shownGroup = groupOf(el) ?? undefined;

  textEl!.textContent = text;
  const detail = el.dataset.tipDetail ?? "";
  detailEl!.textContent = detail;
  detailEl!.hidden = detail === "";

  const key = el.dataset.tipKey ?? "";
  keyEl!.hidden = key === "";
  if (key) renderKey(key);

  // 秒开（同组内切换）时不放淡入动画，否则顺着工具栏滑过去会一路闪
  l.classList.toggle("fade-in", !immediate);

  // 先亮出来量尺寸，但用 visibility 挡住这一帧的 (0,0) 位置；同一帧内就摆好，不会闪
  l.style.visibility = "hidden";
  l.hidden = false;
  const rect = el.getBoundingClientRect();
  const geo = computeTipGeometry(
    { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
    { width: l.offsetWidth, height: l.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight },
    (el.dataset.tipPlacement as TipPlacement | undefined) ?? "bottom",
  );
  l.dataset.placement = geo.placement;
  l.style.left = `${geo.x}px`;
  l.style.top = `${geo.y}px`;
  caretEl!.style.left = `${geo.caretLeft}px`;
  l.style.visibility = "";
}

/** 收起提示（主动调用也安全：没显示时是空操作） */
export function hideTip(): void {
  if (showTimer !== undefined) window.clearTimeout(showTimer);
  if (hideTimer !== undefined) window.clearTimeout(hideTimer);
  showTimer = undefined;
  hideTimer = undefined;
  if (layer) {
    layer.hidden = true;
    layer.classList.remove("fade-in");
  }
  shownTarget = null;
  pendingTarget = null;
  shownGroup = undefined;
}

/** 从事件目标回溯到「带提示的元素」（图标内部的 svg 会被归到按钮上） */
function targetOf(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const el = node.closest<HTMLElement>("[data-tip]");
  return el && el.dataset.tip ? el : null;
}

/** 同组判定：元素自身或其祖先带 `data-tip-group`（`closest` 会先命中最内层） */
function groupOf(el: HTMLElement): string | null {
  return el.closest<HTMLElement>("[data-tip-group]")?.dataset.tipGroup ?? null;
}

function scheduleShow(el: HTMLElement, immediate: boolean): void {
  if (showTimer !== undefined) window.clearTimeout(showTimer);
  if (hideTimer !== undefined) window.clearTimeout(hideTimer);
  hideTimer = undefined;
  if (immediate) {
    showFor(el, true);
    return;
  }
  pendingTarget = el;
  showTimer = window.setTimeout(() => {
    showTimer = undefined;
    if (pendingTarget === el) showFor(el, false);
  }, SHOW_DELAY);
}

function scheduleHide(from: HTMLElement): void {
  if (showTimer !== undefined) {
    window.clearTimeout(showTimer);
    showTimer = undefined;
  }
  if (pendingTarget === from) pendingTarget = null;
  if (shownTarget !== from && pendingTarget !== from) return;
  if (hideTimer !== undefined) window.clearTimeout(hideTimer);
  // 延迟收起：给同组的下一个目标留出「秒开且不闪」的机会，
  // 否则鼠标离开的一瞬间提示就没了，groupId 规则永远触发不了。
  hideTimer = window.setTimeout(() => hideTip(), HIDE_GRACE);
}

/**
 * 全局委托一次装配。
 *
 * 用**事件委托**而不是给每个元素挂钩子：标签栏、查找结果、大纲都是整块重绘的，
 * 逐个挂监听要么漏、要么得在每次重绘后重新挂。
 */
export function initTooltips(doc: Document = document): void {
  if (bound) return;
  bound = true;

  doc.addEventListener(
    "mouseover",
    (e) => {
      const el = targetOf(e.target);
      if (!el || el === shownTarget) return;
      // VS Code 的 groupId 规则：同组内已有提示在显示 → 秒开且不放淡入
      const group = groupOf(el);
      const instant = shownTarget !== null && shownGroup !== undefined && group === shownGroup;
      scheduleShow(el, instant);
    },
    true,
  );

  doc.addEventListener(
    "mouseout",
    (e) => {
      const from = targetOf(e.target);
      if (!from) return;
      const to = targetOf(e.relatedTarget);
      if (to === from) return; // 在目标内部移动（svg ↔ 按钮），不算离开
      scheduleHide(from);
    },
    true,
  );

  doc.addEventListener(
    "focusin",
    (e) => {
      const el = targetOf(e.target);
      if (!el || el === shownTarget) return;
      // 鼠标点击会先 mousedown 再 focus：这时候不该弹提示（对应 VS Code 的 isMouseDown 守卫）
      if (mouseDown) return;
      scheduleShow(el, false);
    },
    true,
  );

  doc.addEventListener("focusout", (e) => {
    const from = targetOf(e.target);
    if (from) scheduleHide(from);
  });

  doc.addEventListener(
    "mousedown",
    () => {
      mouseDown = true;
      hideTip();
    },
    true,
  );
  doc.addEventListener("mouseup", () => {
    mouseDown = false;
  });

  // 滚动 / 缩放 / 失焦一律立即收起：提示是 fixed 定位，不跟着内容走，
  // 留在原地就是「贴在错误的东西上」。
  doc.defaultView?.addEventListener("scroll", () => hideTip(), true);
  doc.defaultView?.addEventListener("resize", () => hideTip());
  doc.defaultView?.addEventListener("blur", () => hideTip());
  doc.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTip();
  });
}

/**
 * 给元素挂上提示。
 *
 * 会顺带补 `aria-label`：原生 `title` 同时充当图标的**可访问名**，换成 `data-tip`
 * 后图标按钮会「失名」；这里只对**自身没有文本、也没有显式 aria-label** 的元素补，
 * 不会覆盖调用方写好的名字。
 */
export function setTip(el: HTMLElement, text: string, opts: TipOptions = {}): void {
  el.dataset.tip = text;
  if (opts.key) el.dataset.tipKey = opts.key;
  else delete el.dataset.tipKey;
  if (opts.detail) el.dataset.tipDetail = opts.detail;
  else delete el.dataset.tipDetail;
  if (opts.placement) el.dataset.tipPlacement = opts.placement;
  else delete el.dataset.tipPlacement;
  if (opts.group) el.dataset.tipGroup = opts.group;
  else delete el.dataset.tipGroup;

  if (!el.textContent?.trim() && !el.hasAttribute("aria-label")) {
    el.setAttribute("aria-label", opts.key ? `${text} (${opts.key})` : text);
  }
}

/** 摘掉提示（控件变成「无可提示」状态时用，如状态栏语言按钮切回纯文本名） */
export function clearTip(el: HTMLElement): void {
  delete el.dataset.tip;
  delete el.dataset.tipKey;
  delete el.dataset.tipDetail;
  delete el.dataset.tipPlacement;
  delete el.dataset.tipGroup;
}

/** 供测试用：当前提示是否可见 */
export function isTipVisible(): boolean {
  return !!layer && !layer.hidden;
}
/**
 * 供测试用：清掉单例状态（jsdom 用例之间隔离）。
 *
 * ⚠️ **故意不重置 `bound`** —— 监听器挂在 `document` 上，生命周期与应用一致，
 * 反复 `initTooltips()` 只会让委托重复注册一遍。要重绑请开新文档。
 */
export function resetTooltipsForTest(): void {
  hideTip();
  layer?.remove();
  layer = null;
  caretEl = null;
  textEl = null;
  detailEl = null;
  keyEl = null;
  mouseDown = false;
}

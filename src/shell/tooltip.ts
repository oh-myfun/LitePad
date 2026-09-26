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
 * - `src/vs/platform/hover/browser/hoverService.ts`——managed hover 的 `MOUSE_OVER`
 *   触发 `triggerShowHover`、`MOUSE_LEAVE` 触发 `hideHover`。
 * - `src/vs/platform/hover/browser/hover.ts`——`WorkbenchHoverDelegate.timeLimit = 200`：
 *   收起提示后 **200ms 内**再悬停任何目标，`delay` 归 0 且不放淡入
 *   （`isInstantlyHovering()`）。
 * - `src/vs/base/browser/ui/iconLabel/iconLabel.ts` + `.../actionbar/actionbar.ts`——
 *   `placement` 决定两件事：`'mouse'`（标签走这条）气泡跟鼠标（`e.x + 10`）且
 *   **不画指针**（`ManagedHoverWidget` 里 `showPointer: placement === 'element'`）；
 *   `'element'`（工具栏 / 动作按钮走这条）按元素下方居中并带指针。两者的
 *   `showHover` 都写死 `appearance.compact: true` ⇒ 12px 字号、`2px 8px` 内边距。
 * - `src/vs/base/browser/ui/keybindingLabel/keybindingLabel.css` + `inputColors.ts`——
 *   快捷键渲染成**键帽**（11px、`padding: 3px 5px`、`border-radius: 3px`、
 *   `min-width: 12px`），配色取 `keybindingLabel.background/foreground/border/bottomBorder`。
 *
 * ⚠️ 与 VS Code 的**有向偏离**（改之前先读这里，B127 后共三处）：
 * 1. `max-width` 取 **420px**（VS Code 是 700px）—— 700px 是给树视图里的长文本留的，
 *    LitePad 的提示都是短标签或一条路径，窄一点更不挡视线。
 * 2. 提示层 `pointer-events: none` —— 我们的提示紧贴目标，若可交互，鼠标从目标滑到
 *    提示上会让目标的 `:hover` 断掉、提示闪烁。代价是不能选中提示文字（不需要）。
 * 3. **显示一律重新计时、收起走宽限**（VS Code 刚好相反）：
 *    VS Code managed hover 是「`MOUSE_LEAVE` 立刻收 + 收起后 200ms 内秒开下一条」，
 *    那套手感建立在「提示层浮在目标上方 4px、移开瞬间就换」的布局上。LitePad 的标签
 *    与关闭按钮是**紧贴排布、整条同属一个 group**，套过来实测是坏的：
 *    移到隔壁标签的瞬间提示就跟着换内容 ⇒ 看起来像"没等就弹"，而收起又太干脆，
 *    鼠标快速扫过整条标签栏时提示一路闪。所以这里改成
 *    「任何目标都重新走满 `SHOW_DELAY`，鼠标离开后留 `HIDE_GRACE` 才收」
 *    （用户 09-26 反馈：`「移到别的标签或按钮不能马上显示，应该重新判断触发延迟；
 *    隐藏也不是鼠标离开后立马消失」`）。group / instant 那套秒开机制因此**整体不用**。
 *
 * 用法：
 * ```ts
 * setTip(btn, "关闭", { key: "Ctrl+W" });   // 动态创建的控件
 * ```
 * ```html
 * <button data-tip="新建" data-tip-key="Ctrl+N" aria-label="新建 (Ctrl+N)"></button>
 * ```
 * 同一条控件栏的提示共享一个分组（容器上标 `data-tip-group="xxx"`）：这组标记现在
 * 只作为**结构性/无障碍**信息留在 DOM 上（窗口控制键、菜单栏各有自己的组），
 * 提示的时序**不再**参考它 —— 秒开已停用，见「有向偏离」第 3 条。
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
  // ⚠️ `instant`（VS Code `createInstantHoverDelegate()` 的 `instantHover`）已**停用**：
  // 它带来的「收起后 200ms 内秒开下一条」在紧贴排布的标签栏上观感是「没等就弹」，
  // 用户 09-26 明确要求移到别的目标要重新计时。选项与 `data-tip-instant` 一并移除。
  /**
   * 鼠标定位模式（VS Code `IHoverDelegate.placement === 'mouse'`）：
   * 气泡左缘 = 鼠标 x + 10，且**不画 caret**。
   *
   * 出处：`ManagedHoverWidget.show()` 里
   * `showPointer: this.hoverDelegate.placement === 'element'` —— 只有按元素定位
   * 的提示（工具栏按钮这类）才带指针；标签走的是 `getDefaultHoverDelegate('mouse')`
   * （`iconLabel.ts:126`），所以 VS Code 的标签提示是**没有小箭头**的。
   */
  follow?: boolean;
  /**
   * 紧凑外观（VS Code `appearance.compact`）：12px 字号 + `2px 8px` 内边距。
   *
   * `WorkbenchHoverDelegate.showHover()` 给所有经 hoverDelegate 的提示写死了
   * `compact: true`（`hover.css` 里 `.compact { font-size: 12px }`、
   * `.compact .hover-contents { padding: 2px 8px }`），比编辑器里那种长文本提示
   * （13px / 4px 8px）矮一圈。
   */
  compact?: boolean;
}

/** VS Code `workbench.hover.delay` 的 Windows 默认值（本项目仅 Windows） */
const SHOW_DELAY = 500;
/**
 * 鼠标离开目标后，**提示还能留在原地多久**（B127 后启用，见文件头「有向偏离」第 3 条）。
 *
 * VS Code 这一层是反过来的（`MOUSE_LEAVE` 立刻收 + 200ms 秒开），但那套依赖提示浮在
 * 目标上方、移开瞬间就换的布局；我们的标签栏紧贴排布，实测「立马消失 + 秒开」= 一路闪。
 * 宽限的作用有两个：① 鼠标从标签扫到关闭按钮这种**跨元素但没走远**的动作不闪；
 * ② 鼠标移出窗口/移出标签栏那一瞬间，提示不会原地卡死。
 *
 * ⚠️ 宽限期内只要鼠标进了**另一个**提示目标，`scheduleShow` 会把它取消掉 ——
 * 收起宽限永远不该吃掉新目标那 500ms 的等待。
 */
const HIDE_GRACE = 220;
/**
 * VS Code 鼠标定位模式（`placement: 'mouse'`）的水平偏移。
 *
 * `hoverService.ts` 的 `onMouseMove` 里写死 `target.x = e.x + 10`：气泡左缘落在
 * 鼠标右侧 10px，而不是对齐元素中心。
 */
const MOUSE_OFFSET = 10;
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

/**
 * 鼠标定位模式的定位（VS Code `placement: 'mouse'`）。
 *
 * 与按元素定位的三点差别，都来自 VS Code：
 *  1. **水平**：气泡左缘 = 鼠标 x + `MOUSE_OFFSET`（10），不是对齐元素中心；
 *     右侧放不下就翻到鼠标左侧，最后夹进视口。
 *  2. **垂直**：`ManagedHoverWidget.show()` 写死 `hoverPosition: BELOW`，
 *     只有下方真的放不下才翻到上方（不做「首选方位」这件事）。
 *  3. **不画 caret**：`showPointer` 只在 `placement === 'element'` 时为真。
 *
 * 同样是纯函数，理由同 `computeTipGeometry`：jsdom 里量不出任何几何。
 */
export function computeTipGeometryAtMouse(
  target: TipRect,
  tip: TipSize,
  viewport: TipSize,
  mouseX: number,
): { x: number; y: number; placement: TipPlacement } {
  const maxX = Math.max(EDGE, viewport.width - tip.width - EDGE);
  // 先试鼠标右侧，放不下退到鼠标左侧，两端都放不下就交给夹取
  const right = mouseX + MOUSE_OFFSET;
  const x =
    right + tip.width > viewport.width - EDGE
      ? clamp(mouseX - MOUSE_OFFSET - tip.width, EDGE, maxX)
      : clamp(right, EDGE, maxX);

  const below = target.bottom + GAP;
  const placement: TipPlacement = below + tip.height > viewport.height - EDGE ? "top" : "bottom";
  const y = placement === "bottom" ? below : Math.max(EDGE, target.top - GAP - tip.height);
  return { x, y, placement };
}

// ---------- 单例状态 ----------

let layer: HTMLDivElement | null = null;
let caretEl: HTMLDivElement | null = null;
let textEl: HTMLSpanElement | null = null;
let detailEl: HTMLSpanElement | null = null;
let keyEl: HTMLSpanElement | null = null;

let showTimer: number | undefined;
/** 收起宽限的定时器（鼠标离开后 `HIDE_GRACE` 才真的收） */
let hideTimer: number | undefined;
/** 已经显示出来的目标 */
let shownTarget: HTMLElement | null = null;
/** 正在等延迟、还没显示的目标（离开时要能取消） */
let pendingTarget: HTMLElement | null = null;
let mouseDown = false;
let bound = false;
/** 最近一次鼠标位置：鼠标定位模式（`follow`）要用它算气泡左缘 */
let lastMouseX = 0;
/**
 * 本次提示是**鼠标**带来的还是**键盘聚焦**带来的。
 *
 * 只有鼠标带来的才走 `follow`（鼠标定位）；键盘 focus 时鼠标可能压根没动过，
 * `lastMouseX` 是陈年的坐标，照它摆气泡会飞到屏幕另一头 —— 此时退回按元素定位
 * （VS Code 的 `onFocus` 分支给的 `target` 同样不带鼠标坐标）。
 */
let pointerDriven = false;

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

function showFor(el: HTMLElement): void {
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

  textEl!.textContent = text;
  const detail = el.dataset.tipDetail ?? "";
  detailEl!.textContent = detail;
  detailEl!.hidden = detail === "";

  const key = el.dataset.tipKey ?? "";
  keyEl!.hidden = key === "";
  if (key) renderKey(key);

  // VS Code 的跳过淡入（`skipFadeInAnimation`）只留给「秒开」，而我们不秒开了 ——
  // 每条提示都老老实实淡入，顺着标签栏滑过去也就看不到那种一路闪的连贯感（B127）。
  l.classList.add("fade-in");
  // VS Code `appearance.compact`：走 hoverDelegate 的提示都是紧凑档（12px / 2px 8px）
  l.classList.toggle("tooltip-compact", el.dataset.tipCompact === "1");

  // 先亮出来量尺寸，但用 visibility 挡住这一帧的 (0,0) 位置；同一帧内就摆好，不会闪
  l.style.visibility = "hidden";
  l.hidden = false;
  const rect = el.getBoundingClientRect();
  const size = { width: l.offsetWidth, height: l.offsetHeight };
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const follow = el.dataset.tipFollow === "1" && pointerDriven;
  // 鼠标定位 = VS Code 的 `placement:'mouse'` ⇒ `showPointer` 为 false：不画 caret
  caretEl!.hidden = follow;
  // 圆角跟着变：VS Code 的 `.with-pointer` 会把 5px 收到 3px（hover.css），
  // 本项目不画 caret 的提示（标签这类）没有这一层，必须留在 5px —— 标签提示路径
  // 又长又窄，3px 看着发"方"，用户 09-26 反馈「应该更圆润、参考 VS Code」。
  l.dataset.pointer = follow ? "false" : "true";
  if (follow) {
    const g = computeTipGeometryAtMouse(
      { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      size,
      viewport,
      lastMouseX,
    );
    l.dataset.placement = g.placement;
    l.style.left = `${g.x}px`;
    l.style.top = `${g.y}px`;
  } else {
    const geo = computeTipGeometry(
      { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      size,
      viewport,
      (el.dataset.tipPlacement as TipPlacement | undefined) ?? "bottom",
    );
    l.dataset.placement = geo.placement;
    l.style.left = `${geo.x}px`;
    l.style.top = `${geo.y}px`;
    caretEl!.style.left = `${geo.caretLeft}px`;
  }
  l.style.visibility = "";
}

/** 收起提示（主动调用也安全：没显示时是空操作） */
export function hideTip(): void {
  if (showTimer !== undefined) window.clearTimeout(showTimer);
  showTimer = undefined;
  if (hideTimer !== undefined) window.clearTimeout(hideTimer);
  hideTimer = undefined;
  if (layer) {
    layer.hidden = true;
    layer.classList.remove("fade-in");
  }
  shownTarget = null;
  pendingTarget = null;
}

/** 从事件目标回溯到「带提示的元素」（图标内部的 svg 会被归到按钮上） */
function targetOf(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const el = node.closest<HTMLElement>("[data-tip]");
  return el && el.dataset.tip ? el : null;
}

/**
 * 排一次「`SHOW_DELAY` 后显示」。
 *
 * 没有任何秒开分支（B127 前那套 `instant` / group 秒开已停用）：挪到任何目标都得
 * 重新走满延迟，用户要的就是这个。
 */
/** 取消待执行的收起宽限（提示重新有了归属） */
function cancelHideGrace(): void {
  if (hideTimer === undefined) return;
  window.clearTimeout(hideTimer);
  hideTimer = undefined;
}

function scheduleShow(el: HTMLElement): void {
  if (showTimer !== undefined) {
    window.clearTimeout(showTimer);
    showTimer = undefined;
  }
  // ⚠️ 进了新目标就**取消上一次的收起宽限**。否则宽限到点会把刚排上的等待一起清掉
  // —— 表现是「移到隔壁标签，旧提示收了、新提示也不来，要等鼠标再动一下」。
  cancelHideGrace();
  // 已经在等同一目标显示（鼠标在它内部来回顾了 svg 之类）→ 别把计时白重启一遍
  if (pendingTarget === el) return;
  pendingTarget = el;
  showTimer = window.setTimeout(() => {
    showTimer = undefined;
    if (pendingTarget === el) showFor(el);
  }, SHOW_DELAY);
}

/**
 * 鼠标离开目标：不立刻收，先挂一个 `HIDE_GRACE` 的宽限（见 `HIDE_GRACE` 的注释）。
 *
 * - 宽限期内重新悬停同一目标（`mouseover` → `scheduleShow`）会取消宽限 ⇒ 不闪；
 * - 宽限期内悬停**另一**个目标同理（同一个 `scheduleShow` 里清掉 `hideTimer`）
 *   ⇒ 旧提示继续挂着，直到新提示按自己的 500ms 亮起来。
 */
function scheduleHide(from: HTMLElement): void {
  if (showTimer !== undefined) {
    window.clearTimeout(showTimer);
    showTimer = undefined;
  }
  if (pendingTarget === from) pendingTarget = null;
  if (shownTarget !== from) return;
  cancelHideGrace();
  hideTimer = window.setTimeout(() => {
    hideTimer = undefined;
    // 宽限期里鼠标又回来了（同一目标被重新悬停会走 scheduleShow 清掉 hideTimer，
    // 能走到这里的只可能是「鼠标已经不在任何提示目标上」）
    if (shownTarget === from) hideTip();
  }, HIDE_GRACE);
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
      if (!el) return;
      // ⚠️ 要在 `el === shownTarget` 这个提前 return **之前**取消宽限：鼠标又碰到提示
      // 了（哪怕还是同一个目标），上一次「收起」的决定就作废，否则宽限到点照样收，
      // 表现为「移开一点点又移回来，提示照样消失」。
      cancelHideGrace();
      if (el === shownTarget) return;
      pointerDriven = true;
      // 目标换了就重新计时：不秒开、不跳过淡入（用户 09-26 反馈，见文件头「偏离」第 3 条）。
      // 顺带把上一次的收起宽限取消掉 —— 收起宽限不该吃掉新目标这 500ms 的等待。
      scheduleShow(el);
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

  // 记录鼠标位置（follow 模式要用）+ 补一条「鼠标已经不在目标上就立刻收起」。
  //
  // VS Code 只在 placement 为 'mouse' 时跟踪 mousemove，一旦事件不再属于目标就
  // `hideHover`。这里对所有提示都记位置（鼠标定位要用），并顺带补上这条守卫：
  // 鼠标从目标内部直接滑出窗口、`mouseout` 没派发到 document 的场合也能收掉。
  doc.addEventListener(
    "mousemove",
    (e) => {
      lastMouseX = e.clientX;
      // 走宽限而不是立刻收：鼠标在目标外抖动几下不该把提示闪掉
      if (shownTarget && !shownTarget.contains(e.target as Node)) scheduleHide(shownTarget);
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
      pointerDriven = false; // 键盘聚焦没有鼠标坐标 → 退回按元素定位
      scheduleShow(el);
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
  if (opts.follow) el.dataset.tipFollow = "1";
  else delete el.dataset.tipFollow;
  if (opts.compact) el.dataset.tipCompact = "1";
  else delete el.dataset.tipCompact;
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
  delete el.dataset.tipFollow;
  delete el.dataset.tipCompact;
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
  lastMouseX = 0;
  pointerDriven = false;
}

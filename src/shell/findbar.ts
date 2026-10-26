/**
 * 悬浮查找/替换栏（方案 C：对齐 VS Code 的紧凑浮层）。
 *
 * 设计要点：
 * - **不绑定文件/面板**：挂在 #app 上，是应用级浮层；切换标签/面板/分屏都不会自动关闭。
 * - **一个入口干所有事**：查找、替换都在这一栏里，编辑器内不再嵌 CM6 搜索面板。
 *   ⚠️ **只管当前这一份文档**：跨文档 / 跨文件那一条 B389 起搬到左栏的搜索视图
 *   （`src/search/panel.ts`，键位 `edit.findInFiles`）。原先这里那颗「所有打开的文档」
 *   图标 + 右上角徽标 + 跨文档步进一起撤掉 —— 同一件事在两个地方各干一遍，
 *   用户就得分清「这次搜的到底是哪儿」，而那边已经是 VS Code 的形状了。
 * - **钉在当前面板编辑区的右上角**（B389-9 起照 VS Code 的几何定位，见 `findBarAnchor`）：
 *   去掉了可拖动的标题栏（方案 C），浮层不再钉窗口右上角压住标题栏/标签条，而是落进编辑区里，
 *   顶边 = 编辑区顶 +4px，右边让开竖向滚动条。
 * - **替换行可折叠**：主行永远是「查找」；点 chevron（或菜单「替换」）才展开替换行。
 *   chevron **绝对定位贴在浮层左缘**（VS Code 的 `.button.toggle` 同款），两行各留 17px 边距让位。
 * - **匹配选项改成图标开关**（Aa / ab / .* / 选区 / AB），嵌在输入框右内侧，激活态高亮。
 * - 紧凑计数 `N / M`；无匹配变红。
 * - **样式逐条对齐 VS Code 的查找组件**：盒模型 / 工具按钮 / 计数 / 开关三态都照抄参考源码
 *   （见 `global.css` 该节的注释头），有意偏离处均已就地注明原因。
 * - **图标全部照搬 VS Code 的 codicon**（B80）：不再自绘、也不再用 `Aa`/`ab`/`.*`/`AB`
 *   这类文字字形。字形取自官方 npm 包 `@vscode/codicons` 的图标字体（映射见 `./codicons`），
 *   与 VS Code 查找栏的注册图标一一对应（含「在选区中查找」用的 `find-selection`，
 *   官方码位 \eb85）。尺寸由官方样式统一给 16px，与 16px 图标位**零缩放**。
 * - **左侧宽度调节手柄**：VS Code 的 `.find-widget .monaco-sash`（findWidget.ts 的 `_resizeSash`），
 *   拖左缘改宽度、双击复原/最大化；宽度不写回磁盘（与 VS Code 一致，只活在本次会话）。
 * - ⚠️ **没有底部结果区**（B80 删）：VS Code 的查找浮层里也没有结果列表 —— 多文件结果
 *   在那边去侧边栏的搜索视图，这一栏只在计数格里念当前文档的「第几个 / 共几个」。
 *   原先那块「常驻占位的结果列表」是 B78 加的，用户实测反馈「底下不要添加结果区」，已移除。
 * - **不绑定快捷键**：VS Code 的 Alt+C/W/R/L/P 在 LitePad 不可用（菜单助记符与 B71 命令已占），
 *   故只在 UI 上做图标开关，不注册快捷键。
 */

import { setTip } from "./tooltip";
import { CODICONS } from "./codicons";

export interface FindBarQuery {
  text: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  /** 在选区中查找：命中只限定在活动视图的当前选区 */
  inSelection: boolean;
  /** 保留大小写：替换时把命中词的大小写迁移到替换串 */
  preserveCase: boolean;
}

export interface FindBarCallbacks {
  /** 查找内容 / 选项变化（主程序据此刷新高亮与计数） */
  onQueryChange: (q: FindBarQuery) => void;
  /** 上一个 / 下一个（当前文档内，到头环绕） */
  onStep: (dir: 1 | -1, q: FindBarQuery) => void;
  onReplace: (q: FindBarQuery) => void;
  onReplaceAll: (q: FindBarQuery) => void;
  onClose: () => void;
}

export interface FindBarHandle {
  open(seed?: string, expandReplace?: boolean): void;
  close(): void;
  isOpen(): boolean;
  /** 切换标签/面板后重新把当前查询应用到新的活动视图（栏本身保持打开） */
  retarget(): void;
  /** 布局变了（面板整棵重建 / 分屏 / 侧栏宽 / 窗口缩放）：按当前活动面板重新钉一次位置 */
  relayout(): void;
  step(dir: 1 | -1): void;
  setCount(text: string, bad?: boolean): void;
  setStatus(text: string): void;
  focusFind(): void;
  focusReplace(): void;
  getQuery(): FindBarQuery;
}

// ---------------------------------------------------------------- 定位几何（照 VS Code）

/** 浮层初始宽度 = VS Code 的 `FIND_WIDGET_INITIAL_WIDTH`（findWidget.ts:80，419px）。 */
export const FIND_BAR_INITIAL_WIDTH = 419;
/** 拖动 / 收窄的下限：再窄就摆不下一整行按钮（VS Code 用三档 CSS 断点砍按钮，我们砍不了）。 */
export const FIND_BAR_MIN_WIDTH = 360;
/** VS Code `.find-widget { margin-top: 4px }` 配 `overlayWidgets` 的 `setTop(0)` ⇒ 顶边离编辑区顶 4px。 */
export const FIND_BAR_TOP_GAP = 4;
/** VS Code `maxRight = 2 * verticalScrollbarWidth + minimapWidth`（overlayWidgets.ts 的 `_renderWidget`）。
    它的 2× 是「正文滚动条 + 并排对比槽」两根；LitePad 只有一根 10px 竖向滚动条、没有 minimap，
    所以等价档位就是 10px —— 浮层不许盖住滚动条（那是唯一能拖的东西）。 */
export const FIND_BAR_SCROLLBAR_GUTTER = 10;
/** VS Code `_updateReactiveLayout` 那句注释：「the minimal left offset of findwidget is 15px」。 */
export const FIND_BAR_LEFT_RESERVE = 15;

/** 编辑区（活动面板的 `.panel-host`）相对视口的位置 —— 只有这三项参与定位。 */
export interface FindBarHostRect {
  top: number;
  left: number;
  width: number;
}

export interface FindBarAnchor {
  top: number;
  right: number;
  width: number;
  maxWidth: number;
}

/**
 * 浮层该钉在哪：把「编辑区矩形 + 视口宽 + 想要的宽度」折成 `position: fixed` 的四个值。
 *
 * ⚠️ `right` 是**从视口右缘往里量**的，所以除了滚动条槽，还得把编辑区自身离窗口右缘的那截
 *    （面板外边距 / 侧栏在右之类的情形）一起算进去 —— 这就是 `innerWidth - (left + width)`。
 *    写成纯函数是因为 jsdom 没有布局：真机上量到的矩形只能靠台子核像素，
 *    而这条换算本身（+4 / 让开滚动条 / 不越过左缘 15px）必须能在测试里判。
 */
export function findBarAnchor(
  host: FindBarHostRect,
  innerWidth: number,
  width: number,
): FindBarAnchor {
  const right = innerWidth - (host.left + host.width) + FIND_BAR_SCROLLBAR_GUTTER;
  /**
   * VS Code 原式：`editorWidth − 2×滚动条 − minimap − 15`（`_updateReactiveLayout`）。
   * ⚠️ **不兜下限**：真机量到过 —— 分屏 + 侧栏摊开时活动格只剩 316px，兜到 360 就把浮层
   *    的左缘顶出编辑区、压进隔壁那一格。VS Code 窄到装不下是靠三档 CSS 断点砍按钮，
   *    我们没有那三档 ⇒ 宁可让浮层跟着格宽缩（行内是 flex，输入框 `min-width:60px` 先让，
   *    关闭键绝对定位在右缘不受挤压），也不许它越界。
   */
  const maxWidth = host.width - FIND_BAR_SCROLLBAR_GUTTER - FIND_BAR_LEFT_RESERVE;
  const floor = Math.min(FIND_BAR_MIN_WIDTH, maxWidth);
  return {
    top: host.top + FIND_BAR_TOP_GAP,
    right,
    width: Math.min(Math.max(width, floor), maxWidth),
    maxWidth,
  };
}

/** 活动面板的编辑区矩形；量不到（jsdom 无布局 / 面板还没建）就返回 null，调用方跳过定位。 */
function activeHostRect(): FindBarHostRect | null {
  const host =
    document.querySelector<HTMLElement>(".layout-panel-active .panel-host") ??
    document.querySelector<HTMLElement>(".panel-host");
  if (!host) return null;
  const r = host.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { top: r.top, left: r.left, width: r.width };
}

/**
 * 图标按钮工厂。B58 起提示走自绘层：`tip` 是文案、`key` 是快捷键（渲染成键帽）。
 * 纯图标按钮没有可读文本，必须显式补 aria-label。
 */
function iconBtn(
  cls: string,
  icon: keyof typeof CODICONS,
  label: string,
  tip: string,
  key?: string,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = cls;
  b.type = "button";
  b.innerHTML = CODICONS[icon];
  setTip(b, tip, { key, group: "findbar" });
  b.setAttribute("aria-label", key ? `${label} (${key})` : label);
  return b;
}

/**
 * 图标开关（区分大小写 / 全词 / 正则 / 保留大小写）。图标即 VS Code 的同名 codicon，
 * `label` 用于 aria + 提示；激活态由 `.on` 与 `aria-pressed` 表达。
 */
function toggle(icon: keyof typeof CODICONS, label: string, tip: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "find-toggle";
  b.type = "button";
  b.innerHTML = CODICONS[icon];
  b.setAttribute("aria-pressed", "false");
  b.setAttribute("aria-label", label);
  setTip(b, tip, { group: "findbar" });
  return b;
}

export function createFindBar(host: HTMLElement, cb: FindBarCallbacks): FindBarHandle {
  const dom = document.createElement("section");
  dom.className = "find-bar";
  dom.hidden = true;

  // ---- 主行：chevron + 查找输入框（内嵌图标开关）+ 计数 + 导航 + 跨文档 + 关闭 ----
  const chevron = iconBtn("find-chevron", "chevronRight", "展开/折叠替换", "展开或折叠替换");
  const findInput = document.createElement("input");
  findInput.className = "find-input search-input";
  findInput.placeholder = "查找内容（回车下一个，Shift+回车上一个）";
  findInput.spellcheck = false;

  const caseT = toggle("caseSensitive", "区分大小写", "区分大小写");
  const wordT = toggle("wholeWord", "全词匹配", "全词匹配");
  const reT = toggle("regex", "正则", "使用正则表达式");
  // ⚠️「在选区中查找」**不在这里**：VS Code 把它放在 prev/next **之后**（findWidget.ts
  //    的 find-actions 里顺序是 matchesCount → prev → next → selection），是工具栏上的
  //    一颗 22×22 扁平按钮，而不是输入框内嵌的开关。见下方 selT。
  const findToggles = document.createElement("span");
  findToggles.className = "find-toggles";
  findToggles.append(caseT, wordT, reT);

  const field = document.createElement("span");
  field.className = "find-field";
  field.append(findInput, findToggles);

  const count = document.createElement("span");
  count.className = "find-count";

  const prev = iconBtn("find-nav find-prev", "arrowUp", "上一个", "上一个匹配", "Shift+Enter");
  const next = iconBtn("find-nav find-next", "arrowDown", "下一个", "下一个匹配", "Enter");
  // 在选区中查找：紧跟在上下箭头之后（VS Code 的 find-actions 顺序）。
  // 它是**开关**而不是动作按钮，除了 .find-nav 的外观还要额外维护 aria-pressed / .on。
  const selT = iconBtn("find-nav find-sel", "findSelection", "在选区中查找", "仅在当前选区中查找");
  selT.setAttribute("aria-pressed", "false");

  const closeBtn = iconBtn("find-x", "close", "关闭", "关闭查找栏", "Esc");

  // ---- 左侧宽度调节手柄（= VS Code `.find-widget .monaco-sash`，findWidget.ts 的 _resizeSash）----
  // 拖它改浮层宽度（浮层钉在右上，所以往左拖 = 变宽），双击在「默认宽度 / 可用最大宽度」间切换。
  const sash = document.createElement("div");
  sash.className = "find-sash";
  sash.setAttribute("role", "separator");
  sash.setAttribute("aria-orientation", "vertical");
  sash.setAttribute("aria-label", "拖动调整查找栏宽度，双击复原");
  setTip(sash, "拖动调整宽度，双击复原", { group: "findbar" });

  const rowMain = document.createElement("div");
  rowMain.className = "find-row find-row-main";
  // 顺序照 VS Code：输入框 → 计数 → 上一个 → 下一个 → 选区开关 → 关闭
  rowMain.append(chevron, field, count, prev, next, selT, closeBtn);

  // ---- 替换行（默认隐藏，chevron 展开）：替换输入框（内嵌 AB 保留大小写）+ 替换/全部替换 ----
  // ⚠️ 这里**不再需要左侧占位元素**：chevron 改为绝对定位贴在浮层左缘，
  //    两行各自靠 CSS 的 `margin-left: 17px` 让位，输入框边缘自然对齐（VS Code 同款做法）。
  const replaceInput = document.createElement("input");
  replaceInput.className = "find-replace-input search-input";
  replaceInput.placeholder = "替换为";
  replaceInput.spellcheck = false;
  const presT = toggle("preserveCase", "保留大小写", "替换时保留被替换文本的大小写");
  const replToggles = document.createElement("span");
  replToggles.className = "find-toggles";
  replToggles.append(presT);
  const replField = document.createElement("span");
  replField.className = "find-field";
  replField.append(replaceInput, replToggles);
  const doReplace = iconBtn("find-replace-one", "replace", "替换", "替换当前匹配", "Enter");
  const doAll = iconBtn("find-replace-all", "replaceAll", "全部替换", "替换全部匹配");
  const rowReplace = document.createElement("div");
  rowReplace.className = "find-row find-row-replace";
  rowReplace.hidden = true;
  rowReplace.append(replField, doReplace, doAll);

  // ---- 状态行（临时提示；空文本时整行收起）----
  const status = document.createElement("div");
  status.className = "find-status";
  // 初始无内容 → 直接收起。⚠️ 不能等第一次 setStatus 才收：正常打开查找栏时主程序
  // 根本不会调 setStatus，空的状态行会一直吊在主行下面 = 浮层底部那条空白（用户实测反馈）。
  status.hidden = true;

  // ⚠️ 底部**没有**结果区（B80 删）。命中总数走文档按钮的徽标，命中之间走 Enter / 上下箭头。
  dom.append(sash, rowMain, rowReplace, status);
  host.appendChild(dom);

  // ---- 宽度（由左侧手柄调节；不落盘，与 VS Code 一样只在本次会话内有效）----
  /**
   * 想要的宽度（拖手柄 / 双击改它）。定位时再按编辑区宽夹一次 ——
   * 夹完**不写回来**：VS Code 用 CSS `max-width` 做到「编辑区窄了就压扁、宽了自动还原」，
   * 把夹后的值当源真值会在拖大窗口后丢掉用户调过的那一档。
   */
  let barWidth = FIND_BAR_INITIAL_WIDTH;

  /**
   * 替换输入框**写死成查找输入框的宽度**（= VS Code 展开替换行/拖完手柄后做的
   * `this._replaceInput.width = getTotalWidth(this._findInput.domNode)`）。
   * 两行右侧挂的按钮数不同（主行比替换行多出计数、导航、选区、跨文档四组），
   * 纯 flex 会让替换框比查找框宽出一截、右边缘也错开 —— 故由 JS 量完写死。
   */
  function syncWidths(): void {
    const w = field.getBoundingClientRect().width;
    // jsdom（测试）没有布局，量出来是 0 —— 那就什么都别做，别写死一个 0px 宽度
    if (w <= 0) return;
    replField.style.width = `${Math.round(w)}px`;
  }

  /**
   * 重新钉一次：读活动面板编辑区的矩形，换算成 `top / right / width / maxWidth` 写进内联样式。
   * 量不到布局（jsdom、面板还没建）时**什么都不写**，让 global.css 里那组兜底值生效。
   */
  function relayout(): void {
    if (dom.hidden) return; // 收起状态没有布局可言，等下一次 open() 再钉
    const area = activeHostRect();
    if (!area) return;
    const a = findBarAnchor(area, window.innerWidth, barWidth);
    dom.style.top = `${a.top}px`;
    dom.style.right = `${a.right}px`;
    dom.style.maxWidth = `${a.maxWidth}px`;
    dom.style.width = `${a.width}px`;
    syncWidths();
  }

  function setBarWidth(w: number): void {
    barWidth = w;
    relayout();
  }

  /** 「可用最大宽度」= 双击放大那一档（B389-9 起跟着编辑区宽走，不再是整窗宽）。 */
  function maxBarWidth(): number {
    const area = activeHostRect();
    if (!area) return Math.max(FIND_BAR_MIN_WIDTH, window.innerWidth - 32);
    return findBarAnchor(area, window.innerWidth, Number.POSITIVE_INFINITY).maxWidth;
  }

  // ---- 盯着编辑区：它一变（分屏、拖分割线、侧栏宽、窗口 resize、面板最大化）就重新钉 ----
  // 只盯**当前活动面板**那一格：RO 不吃「位置变了但尺寸没变」，那种情形由 retarget() 补一发。
  // jsdom 没有 ResizeObserver ⇒ 整段跳过，测试路径靠 open()/retarget() 里的显式调用。
  let hostEl: Element | null = null;
  let hostRO: ResizeObserver | null = null;
  function watchHost(): void {
    if (typeof ResizeObserver !== "function") return;
    const next =
      document.querySelector<HTMLElement>(".layout-panel-active .panel-host") ??
      document.querySelector<HTMLElement>(".panel-host");
    if (next === hostEl) return;
    hostRO?.disconnect();
    hostEl = next;
    hostRO = null;
    if (hostEl) {
      hostRO = new ResizeObserver(() => relayout());
      hostRO.observe(hostEl);
    }
  }

  // ---- 选项状态（图标开关的源真值）----
  const opt = { case: false, word: false, regexp: false, selection: false, preserve: false };
  function query(): FindBarQuery {
    return {
      text: findInput.value,
      replace: replaceInput.value,
      caseSensitive: opt.case,
      wholeWord: opt.word,
      regexp: opt.regexp,
      inSelection: opt.selection,
      preserveCase: opt.preserve,
    };
  }

  function syncToggle(btn: HTMLButtonElement, on: boolean): void {
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  /**
   * 状态行。**空文本时整行收起来**：
   * ⚠️ 不能只靠 `.find-status { min-height: 14px }` 养着一个空盒子 —— 主行下面会
   * 多出 14px 状态行 + 4px gap + 8px 底内距，肉眼就是浮层底部挂着一条空带（用户实测反馈）。
   */
  function setStatus(text: string): void {
    status.textContent = text;
    status.hidden = !text;
  }

  function setReplaceExpanded(on: boolean): void {
    rowReplace.hidden = !on;
    // VS Code 用同一个类名（`.replaceToggled`）把 chevron 拉高，这里照搬：
    // 展开后折叠按钮从 25px 长成 53px，把两行输入框都罩住（见 global.css）。
    dom.classList.toggle("replace-toggled", on);
    chevron.innerHTML = on ? CODICONS.chevronDown : CODICONS.chevronRight;
    chevron.setAttribute("aria-label", on ? "折叠替换" : "展开替换");
    if (on) syncWidths();
  }

  // ⚠️ 光在「展开时量一次」不够：计数的位数会变（`.find-count:empty` 让空计数不占宽度），
  // 主程序随后 setCount("3 / 12") 会把查找框挤窄 40px，而替换框还停在旧宽度上 ——
  // 于是两框又错开。用 ResizeObserver 盯住查找框，它一变宽窄就跟着对齐。
  // （jsdom 没有 ResizeObserver，测试环境下整段跳过；那条路径由 open/展开时的显式调用兜住。）
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => syncWidths()).observe(field);
  }

  findInput.addEventListener("input", () => cb.onQueryChange(query()));
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const q = query();
      // ⚠️ 09-20 起两种范围（当前文档 / 选区）同一套逻辑：**回车一律是「下一个」**
      // （Shift+回车上一个）。搜索由「查询或范围发生变化」统一触发，主程序每次都会重算
      // 命中并刷新计数与 prev/next 的可用态，不需要再按一次回车去「启动搜索」。
      if (e.shiftKey) cb.onStep(-1, q);
      else cb.onStep(1, q);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });
  replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      cb.onReplace(query());
    } else if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });

  prev.addEventListener("click", () => cb.onStep(-1, query()));
  next.addEventListener("click", () => cb.onStep(1, query()));
  doReplace.addEventListener("click", () => cb.onReplace(query()));
  doAll.addEventListener("click", () => cb.onReplaceAll(query()));
  chevron.addEventListener("click", () => setReplaceExpanded(rowReplace.hidden));

  // ---- 左侧手柄：拖动改宽度 / 双击在「默认 ↔ 最大」间切换 ----
  sash.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    // 浮层钉在编辑区右上角：手柄在**左**缘，往左拖 = 变宽，故用 (startX - currentX)
    const startW = dom.getBoundingClientRect().width || barWidth;
    sash.classList.add("active");
    const move = (ev: PointerEvent) => setBarWidth(startW + (startX - ev.clientX));
    const up = () => {
      sash.classList.remove("active");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  sash.addEventListener("dblclick", () => {
    // 同 VS Code 的 onDidReset：还没调过宽度就放大到可用宽度，调过了就复原。
    // ⚠️ 比较的是**想要的宽度** `barWidth`，不是量到的那一档：量到的会被编辑区宽夹住，
    //    窄格里「夹后的实际宽」永远不等于 419 ⇒ 拿它当判据的话这一键就只会复原、再也放不大。
    setBarWidth(
      Math.abs(barWidth - FIND_BAR_INITIAL_WIDTH) < 1 ? maxBarWidth() : FIND_BAR_INITIAL_WIDTH,
    );
  });
  // 窗口尺寸变了：编辑区矩形要重量一次（RO 也会到，这里保底同 VS Code 的 onConfigurationChanged）
  window.addEventListener("resize", () => {
    watchHost();
    relayout();
  });

  // 图标开关：点击翻转源真值 → 同步外观 → 通知主程序。
  // 「在选区中查找」也在这一组里：B389 起它不再要顺手熄掉互斥的跨文档开关，
  // 于是与其它四颗同形（原先它为那一句互斥被单独拆出去写）。
  const toggleMap: Array<[HTMLButtonElement, keyof typeof opt]> = [
    [caseT, "case"],
    [wordT, "word"],
    [reT, "regexp"],
    [presT, "preserve"],
    [selT, "selection"],
  ];
  for (const [btn, key] of toggleMap) {
    btn.addEventListener("click", () => {
      opt[key] = !opt[key];
      syncToggle(btn, opt[key]);
      cb.onQueryChange(query());
    });
  }

  closeBtn.addEventListener("click", () => close());
  // Esc 关闭：捕获阶段拦截，避免冒泡到窗口级快捷键
  dom.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });

  function open(seed?: string, expandReplace = false): void {
    const first = dom.hidden;
    dom.hidden = false;
    if (first) {
      setReplaceExpanded(expandReplace);
    } else if (expandReplace) {
      setReplaceExpanded(true);
    }
    if (seed) findInput.value = seed;
    // 浮层可见后才有布局：先认领当前活动面板那一格，再按它的矩形钉一次位置
    // （`relayout()` 里带着重量替换框宽度；首次打开就展开替换行的路径由
    //   setReplaceExpanded 自己量一次）
    watchHost();
    relayout();
    cb.onQueryChange(query());
  }

  function close(): void {
    if (dom.hidden) return;
    dom.hidden = true;
    cb.onClose();
  }

  return {
    open,
    close,
    isOpen: () => !dom.hidden,
    relayout: () => {
      if (dom.hidden) return;
      watchHost();
      relayout();
    },
    retarget: () => {
      // 换面板 = 换锚点：`.layout-panel-active` 那一格挪走了，位置与宽度都要重算
      if (!dom.hidden) {
        watchHost();
        relayout();
        cb.onQueryChange(query());
      }
    },
    step: (dir) => cb.onStep(dir, query()),
    setCount: (t, bad) => {
      // 空文本一律显示「无内容」：计数区始终占位、不隐藏（用户要求）。
      const text = t || "无内容";
      count.textContent = text;
      // 无内容 / 无匹配 → 没有可导航的命中，prev/next 置灰；有命中（N / M）才点亮。
      const noResults = text === "无内容" || text === "无匹配";
      count.classList.toggle("find-count-bad", !!bad || text === "无匹配");
      prev.disabled = noResults;
      next.disabled = noResults;
      // 计数位数变了 → 查找框宽度变了 → 替换框要跟着对齐（见 ResizeObserver 那条注释）
      syncWidths();
    },
    setStatus,
    focusFind: () => {
      findInput.focus();
      findInput.select();
    },
    focusReplace: () => {
      setReplaceExpanded(true);
      replaceInput.focus();
      replaceInput.select();
    },
    getQuery: query,
  };
}

/**
 * 悬浮查找/替换栏（方案 C：对齐 VS Code 的紧凑浮层）。
 *
 * 设计要点：
 * - **不绑定文件/面板**：挂在 #app 上，是应用级浮层；切换标签/面板/分屏都不会自动关闭。
 * - **一个入口干所有事**：查找、替换、跨文档查找都在这一栏里，编辑器内不再嵌 CM6 搜索面板。
 * - **钉在右上角**：去掉了可拖动的标题栏（方案 C），固定停靠编辑器右上，尽量少遮挡正文。
 * - **替换行可折叠**：主行永远是「查找」；点 chevron（或菜单「替换」）才展开替换行。
 *   chevron **绝对定位贴在浮层左缘**（VS Code 的 `.button.toggle` 同款），两行各留 17px 边距让位。
 * - **匹配选项改成图标开关**（Aa / ab / .* / 选区 / AB），嵌在输入框右内侧，激活态高亮。
 * - **跨文档收敛成一个文档图标**：不再用「复选框 + 查找全部按钮」，命中总数显示在
 *   图标**右上角的徽标**里（B80，见下）。
 * - 紧凑计数 `N / M`；无匹配变红。
 * - **样式逐条对齐 VS Code 的查找组件**：盒模型 / 工具按钮 / 计数 / 开关三态都照抄参考源码
 *   （见 `global.css` 该节的注释头），有意偏离处均已就地注明原因。
 * - **图标全部照搬 VS Code 的 codicon**（B80）：不再自绘、也不再用 `Aa`/`ab`/`.*`/`AB`
 *   这类文字字形。轮廓由 `scripts/fetch-codicons.mjs` 从官方包 `@vscode/codicons` 抽出
 *   并内联成 `codicons.ts`，与 VS Code 查找栏的注册图标一一对应（含「在选区中查找」
 *   用的 `find-selection`，官方码位 \eb85）。16×16 视图框 → 与 16px 图标位**零缩放**。
 * - **左侧宽度调节手柄**：VS Code 的 `.find-widget .monaco-sash`（findWidget.ts 的 `_resizeSash`），
 *   拖左缘改宽度、双击复原/最大化；宽度不写回磁盘（与 VS Code 一致，只活在本次会话）。
 * - ⚠️ **没有底部结果区**（B80 删）：VS Code 的查找浮层里也没有结果列表 —— 多文档搜索结果
 *   在那边去侧边栏的搜索视图，我们这一栏只把**总匹配数**交给文档按钮右上角的徽标，
 *   命中之间靠 Enter / 上下箭头跨文档步进（见 main.ts 的 `runFindInDocs` / `stepFindInDocs`）。
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
  /** 勾选「所有打开的文档」时为真：查找全部 / 全部替换作用于全部已打开文档 */
  allDocs: boolean;
  /** 在选区中查找：命中只限定在活动视图的当前选区（跨文档忽略） */
  inSelection: boolean;
  /** 保留大小写：替换时把命中词的大小写迁移到替换串 */
  preserveCase: boolean;
}

/** 一条命中（仅在已打开文档的内存快照里，不涉及磁盘文件）。 */
export interface FindHit {
  /** Rust tabId */
  docId: number;
  path: string;
  name: string;
  line: number;
  col: number;
  text: string;
  from: number;
  to: number;
}

export interface FindBarCallbacks {
  /** 查找内容 / 选项变化（主程序据此刷新高亮与计数） */
  onQueryChange: (q: FindBarQuery) => void;
  /** 上一个 / 下一个（当前文档；跨文档范围时由主程序改为跨文档步进） */
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
  step(dir: 1 | -1): void;
  setCount(text: string, bad?: boolean): void;
  setStatus(text: string): void;
  /**
   * 跨文档徽标：`a/b` —— a = 当前命中所属文档的序号，b = 含结果的文档数。
   * 传 (0,0) 或不点亮文档图标时徽标收起。
   */
  setDocIndex(a: number, b: number): void;
  focusFind(): void;
  focusReplace(): void;
  getQuery(): FindBarQuery;
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

  // 跨文档：文档图标按钮（右上角徽标 = 跨文档命中的总匹配数）
  const docsBtn = iconBtn("find-docs", "files", "所有打开的文档", "在全部已打开的文档中查找");
  const badge = document.createElement("i");
  badge.className = "find-badge";
  badge.hidden = true;
  docsBtn.appendChild(badge);

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
  // 顺序照 VS Code：输入框 → 计数 → 上一个 → 下一个 → 选区开关 → （跨文档）→ 关闭
  rowMain.append(chevron, field, count, prev, next, selT, docsBtn, closeBtn);

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
  const DEFAULT_W = 470;
  const MIN_W = 360;
  const availableW = (): number => Math.max(MIN_W, window.innerWidth - 32);

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

  function setBarWidth(w: number): void {
    dom.style.width = `${Math.round(Math.min(Math.max(w, MIN_W), availableW()))}px`;
    syncWidths();
  }

  // ---- 选项状态（图标开关的源真值）----
  const opt = { case: false, word: false, regexp: false, selection: false, preserve: false };
  /**
   * 跨文档徽标的 `a/b` 源真值（a=当前文档序号，b=含结果文档数）。
   * ⚠️ 必须自己存一份：查找栏是**懒建**的，主程序可能在它建出来之前就算好了命中文档；
   * 若只把数字写在 DOM 里，「先搜出结果、再点亮图标」会渲染出一个空徽标。
   */
  let docA = 0;
  let docB = 0;

  function query(): FindBarQuery {
    return {
      text: findInput.value,
      replace: replaceInput.value,
      caseSensitive: opt.case,
      wholeWord: opt.word,
      regexp: opt.regexp,
      allDocs: docsBtn.classList.contains("on"),
      inSelection: opt.selection,
      preserveCase: opt.preserve,
    };
  }

  function syncToggle(btn: HTMLButtonElement, on: boolean): void {
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  /** 「在选区中查找」开关（工具栏那颗，不是输入框内嵌开关） */
  function setSelection(on: boolean): void {
    opt.selection = on;
    syncToggle(selT, on);
  }

  /** 徽标文案：`a/b`（a=当前命中所属文档序号，b=含结果文档数）。 */
  function badgeText(): string {
    return docB > 0 ? `${docA}/${docB}` : "";
  }

  /** 徽标 = 跨文档 `a/b`；未点亮跨文档、或没有含结果的文档时收起。 */
  function syncBadge(): void {
    const on = docsBtn.classList.contains("on");
    badge.textContent = badgeText();
    badge.hidden = !(on && docB > 0);
  }

  /** 跨文档开关：翻 .on 之后必须走 syncAllDocs（徽标 / 占位提示都在那里） */
  function setAllDocs(on: boolean): void {
    docsBtn.classList.toggle("on", on);
    syncAllDocs();
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

  /**
   * 跨文档范围切换：图标激活即搜索全部打开文档；熄灭时清掉上一次的总数。
   * ⚠️ 09-20 统一触发逻辑后，**三种范围（当前文档 / 选区 / 全部打开文档）的触发方式完全一致**：
   * 改文本、改选项、切范围都会立刻重算并刷新计数与按钮状态，回车一律是「下一个」。
   * 所以不再需要「回车在全部已打开的文档中查找」这句专门提示，placeholder 只留一份。
   */
  function syncAllDocs(): void {
    const on = docsBtn.classList.contains("on");
    if (!on) {
      // 熄灭跨文档：a/b 与提示一起清掉，别留下过期文案
      docA = 0;
      docB = 0;
      setStatus("");
    }
    syncBadge();
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

  findInput.addEventListener("input", () => {
    // 查询一变，上一次的跨文档命中就作废：主程序会在 onQueryChange 里清掉它那份命中表，
    // 徽标也必须跟着归零 —— 否则会一直挂着一个「上一串内容」搜出来的数字。
    if (docsBtn.classList.contains("on")) {
      docA = 0;
      docB = 0;
      syncBadge();
    }
    cb.onQueryChange(query());
  });
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const q = query();
      // ⚠️ 09-20 起三种范围（当前文档 / 选区 / 全部打开文档）同一套逻辑：**回车一律是「下一个」**
      // （Shift+回车上一个）。早先跨文档范围要「回车才触发搜索」，于是点亮文档图标、
      // 改搜索文本都不会刷新结果，必须再按一次回车 —— 现在搜索由「查询或范围发生变化」
      // 统一触发，主程序每次都会重算命中并刷新计数、徽标与 prev/next 的可用态。
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
  docsBtn.addEventListener("click", () => {
    // ⚠️「在选区中查找」与「所有打开的文档」**互斥**：一个说「只搜光标选中的那一段」，
    // 另一个说「搜全部已打开文档」，同时成立是自相矛盾的（VS Code 里这两个查找范围
    // 也是二选一）。点亮一个就熄掉另一个。
    const on = !docsBtn.classList.contains("on");
    setAllDocs(on);
    if (on && opt.selection) setSelection(false);
    cb.onQueryChange(query());
  });
  chevron.addEventListener("click", () => setReplaceExpanded(rowReplace.hidden));

  // ---- 左侧手柄：拖动改宽度 / 双击在「默认 ↔ 最大」间切换 ----
  sash.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    // 浮层钉在右上角：手柄在**左**缘，往左拖 = 变宽，故用 (startX - currentX)
    const startW = dom.getBoundingClientRect().width || DEFAULT_W;
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
    // 同 VS Code 的 onDidReset：还没调过宽度就放大到可用宽度，调过了就复原
    const cur = dom.getBoundingClientRect().width || DEFAULT_W;
    setBarWidth(Math.abs(cur - DEFAULT_W) < 1 ? availableW() : DEFAULT_W);
  });
  // 窗口尺寸变了，写死的替换框宽度要重新量一次（可用最大宽度也会跟着变）
  window.addEventListener("resize", () => {
    syncWidths();
    const w = dom.getBoundingClientRect().width;
    if (w > 0) setBarWidth(w);
  });

  /**
   * 「在选区中查找」的开关动作。与跨文档互斥：点亮它就熄掉跨文档。
   */
  function toggleSelection(): void {
    const on = !opt.selection;
    setSelection(on);
    if (on && docsBtn.classList.contains("on")) setAllDocs(false);
  }

  // 图标开关：点击翻转源真值 → 同步外观 → 通知主程序
  const toggleMap: Array<[HTMLButtonElement, keyof typeof opt]> = [
    [caseT, "case"],
    [wordT, "word"],
    [reT, "regexp"],
    [presT, "preserve"],
  ];
  for (const [btn, key] of toggleMap) {
    btn.addEventListener("click", () => {
      opt[key] = !opt[key];
      syncToggle(btn, opt[key]);
      cb.onQueryChange(query());
    });
  }
  // 「在选区中查找」不在上面那组里：它还要顺手熄掉互斥的跨文档开关
  selT.addEventListener("click", () => {
    toggleSelection();
    cb.onQueryChange(query());
  });

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
    syncAllDocs();
    // 浮层可见后才有布局：替换框宽度必须在这里再量一次
    // （首次打开时就展开替换行的路径走的是 setReplaceExpanded，它自己也量一次）
    syncWidths();
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
    retarget: () => {
      if (!dom.hidden) cb.onQueryChange(query());
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
    setDocIndex: (a, b) => {
      docA = a;
      docB = b;
      syncBadge();
    },
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

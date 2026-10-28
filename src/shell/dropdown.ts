/**
 * 自定义下拉（B108：替代原生 `<select>`，让展开列表与应用的菜单/右键菜单
 * 用同一套视觉语言，而不是交给系统画一个风格各异的原生列表框）。
 *
 * 设计要点：
 *   · 触发器是一颗普通按钮（`.dropdown-trigger`），外观与设置页/工具栏里的
 *     输入框、按键同款（同一组 border / radius / bg / hover / focus 环）。
 *   · 展开列表**直接复用 `.popup-menu`**（背景 `--bg-elevated`、边框 `--border`、
 *     圆角 `--radius`、阴影、13px、内边距 4px；行按钮 flex + 5px 9px 内边距），
 *     当前项沿用 `.menu-item-current`（左侧 accent 色条 + 背景），与活动标签/
 *     应用菜单「当前项」同一个观感。
 *   · 定位用 `position: fixed` + 视口坐标（和 `.popup-menu` 一致，避免被模态
 *     滚动容器裁切）；下方放不下自动翻到上方，右侧放不下往左收。
 *   · B405：展开时**把列表挂到 body**（与应用的菜单/子菜单同一口径）。编辑器里
 *     `.cm-scroller` 带 `z-index: 0` 的层叠上下文，列表留在 DOM 里无论 z-index
 *     多高都压不过外壳与其它组件；挂 body 才真的「显示在所有组件之上」。
 *     关闭时收回（并移出 body），关闭态的 DOM 结构与旧版一致。
 *   · B230：**按上下可用空间动态限高**，且只有选项区滚动、搜索框钉在顶部。
 *     旧版靠 `.popup-menu` 的 `max-height: calc(100vh - 16px)` 兜着，可列表被限到
 *     接近整屏高时「翻到上方」的判据（`r.top - 4 - listH > 0`）恒为假 ⇒ 永远向下放、
 *     超出视口底部被裁掉。选项一多（本机字体动辄几十项）就肉眼可见。
 *   · B230：`searchable` 时列表顶部带一个搜索框，按子串过滤（label + note 都参与匹配，
 *     所以「未安装」那类标记也能搜到）；输入即过滤，回车选中高亮项。
 *   · 键盘：↑/↓ 移动高亮（跳过 disabled）、Enter/Space 选中、Esc 关闭并归还焦点；
 *     点击外部关闭。
 *   · 与原生 `<select>` 一致：`change` 仅在**值真正改变**时回调 onPick（重选当前项
 *     不触发），即时生效的语义不变。
 */
import { setTip } from "./tooltip";

export interface DropdownOption {
  label: string;
  value: string;
  /** 选项右侧的补充说明（muted），可选。 */
  note?: string;
  disabled?: boolean;
}

export interface DropdownOptions {
  options: DropdownOption[];
  current: string;
  onPick: (value: string) => void;
  /** 触发器额外 class（如 keymap 预设的 `keymap-preset`）。 */
  className?: string;
  ariaLabel?: string;
  /**
   * B230：列表顶部带搜索框。选项数量大到「翻找」不现实时才开（如本机字体枚举）；
   * 三五项的小下拉开了反而是噪声。
   */
  searchable?: boolean;
  /** 搜索框占位文案，默认「搜索…」。 */
  searchPlaceholder?: string;
}

export interface DropdownHandle {
  /** 容器：`<div class="dropdown">`（含 trigger 与 list）。 */
  root: HTMLElement;
  getValue(): string;
  setValue(value: string): void;
  destroy(): void;
}

/** 选项区最小高度：上下都放不下时，至少给这么高，保证还能滚。 */
const MIN_LIST_H = 120;
/** 列表与视口边缘的最小间距。 */
const VIEWPORT_MARGIN = 8;

export function createDropdown(opts: DropdownOptions): DropdownHandle {
  const root = document.createElement("div");
  root.className = "dropdown";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "dropdown-trigger" + (opts.className ? " " + opts.className : "");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  if (opts.ariaLabel) trigger.setAttribute("aria-label", opts.ariaLabel);

  // 列表直接套 .popup-menu：视觉与应用的菜单/右键菜单完全一致
  const list = document.createElement("div");
  list.className = "popup-menu dropdown-list";
  list.setAttribute("role", "listbox");

  // B230：searchable 时列表结构是「搜索框 + 可滚动选项区」两层；不可搜索时
  // 选项直接挂在 list 下（少一层 DOM，菜单类小下拉不受影响）。
  const searchable = opts.searchable === true;
  let searchInput: HTMLInputElement | null = null;
  let optionsBox: HTMLElement;
  if (searchable) {
    const searchWrap = document.createElement("div");
    searchWrap.className = "dropdown-search-wrap";
    searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.className = "dropdown-search";
    searchInput.placeholder = opts.searchPlaceholder ?? "搜索…";
    searchInput.setAttribute("aria-label", searchInput.placeholder);
    // 列表内的输入不能触发外层的全局快捷键分发
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        // 让 ↑/↓ 仍然驱动选项高亮，但**不**把按键吃掉到输入框里
        e.preventDefault();
        move(e.key === "ArrowDown" ? 1 : -1);
      }
    });
    searchWrap.appendChild(searchInput);
    optionsBox = document.createElement("div");
    optionsBox.className = "dropdown-options";
    optionsBox.setAttribute("role", "presentation");
    list.append(searchWrap, optionsBox);
  } else {
    optionsBox = list;
  }

  let value = opts.current;
  let open = false;
  let activeIndex = -1;
  /** 当前搜索词（小写）。空串 = 不过滤。 */
  let query = "";

  /**
   * 命中项：搜索词非空时按 label + note 子串过滤（大小写不敏感）。
   * ⚠️ note 也参与匹配 —— 字体下拉的「（未安装）」标记就挂在 note 上，
   * 只匹配 label 的话这条提示搜不到。
   */
  function matched(): DropdownOption[] {
    const q = query.trim().toLowerCase();
    if (!q) return opts.options;
    return opts.options.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.note ?? "").toLowerCase().includes(q),
    );
  }

  function currentLabel(): string {
    return opts.options.find((o) => o.value === value)?.label ?? "";
  }

  function renderTrigger(): void {
    const label = document.createElement("span");
    label.className = "dd-label";
    label.textContent = currentLabel();
    const caret = document.createElement("span");
    caret.className = "dd-caret codicon codicon-chevron-down";
    caret.setAttribute("aria-hidden", "true");
    trigger.replaceChildren(label, caret);
    root.dataset.value = value;
  }

  function renderList(): void {
    // ⚠️ 必须先清空 optionsBox 的旧选项 —— B230 之前选项直接挂在 list 上、
    // 用 replaceChildren 一次清完；拆出「搜索框 + 选项区」两层后只 replaceChildren
    // 会连搜索框一起清掉，于是改成手动清 optionsBox。漏了这行就是**逐次过滤越滚越多**
    // （6 → 13 → 16 项）。
    optionsBox.querySelectorAll(".dropdown-option, .dropdown-empty").forEach((el) => el.remove());
    const items = matched();
    // 无命中时给一句提示，别让用户对着空列表发呆
    if (items.length === 0 && searchable) {
      const empty = document.createElement("div");
      empty.className = "dropdown-empty";
      empty.textContent = `没有匹配「${query.trim()}」的项`;
      optionsBox.appendChild(empty);
      activeIndex = -1;
      return;
    }
    items.forEach((o, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dropdown-option";
      btn.setAttribute("role", "option");
      btn.dataset.value = o.value;
      if (o.disabled) btn.disabled = true;

      const label = document.createElement("span");
      label.className = "dd-label";
      label.textContent = o.label;
      btn.appendChild(label);

      if (o.note) {
        const note = document.createElement("span");
        note.className = "dd-note";
        note.textContent = o.note;
        btn.appendChild(note);
        setTip(btn, o.note, { group: "dropdown" });
      }

      if (o.value === value) {
        btn.classList.add("menu-item-current");
        btn.setAttribute("aria-selected", "true");
      }

      btn.addEventListener("click", () => {
        if (o.disabled) return;
        pick(o.value);
      });
      btn.addEventListener("mousemove", () => setActive(i));
      optionsBox.appendChild(btn);
    });
  }

  function setActive(i: number): void {
    const btns = [...optionsBox.querySelectorAll<HTMLButtonElement>(".dropdown-option")];
    if (i < 0 || i >= btns.length) return;
    btns.forEach((b, idx) => b.classList.toggle("dd-active", idx === i));
    activeIndex = i;
    btns[i].scrollIntoView({ block: "nearest" });
  }

  /**
   * B230：按上下**可用空间**限高，而不是靠 `.popup-menu` 的整屏 max-height 兜。
   * 旧逻辑（下方放不下且上方放得下 → 整块翻上去）在列表被限到接近整屏高时
   * 判据恒为假，于是永远向下放、超出视口底部被裁掉。现在两侧各取可用空间、
   * 取较大者作为 maxHeight，并优先往下放（贴触发器更符合直觉）。
   */
  function positionList(): void {
    const r = trigger.getBoundingClientRect();
    const gap = 4;
    // B404：自建标题栏是 webview 里的一层 DOM，不是系统 chrome —— 只按视口算「上面放得下」
    // 会把列表顶到标题栏背后去（代码块在文档中段时必现）。可用区的上边界取标题栏下沿。
    const chrome =
      document.querySelector<HTMLElement>("#title-bar")?.getBoundingClientRect().bottom ?? 0;
    const minTop = Math.max(VIEWPORT_MARGIN, chrome + VIEWPORT_MARGIN);
    const below = window.innerHeight - r.bottom - gap - VIEWPORT_MARGIN;
    const above = r.top - gap - minTop;
    const maxH = Math.max(MIN_LIST_H, Math.max(below, above));
    // 视口本身太矮（比 MIN_LIST_H 还小）时不能再撑高，否则又顶出去了
    const cap = Math.max(MIN_LIST_H, window.innerHeight - minTop - VIEWPORT_MARGIN);
    list.style.maxHeight = `${Math.min(maxH, cap)}px`;

    list.style.minWidth = `${Math.max(r.width, 120)}px`;
    // B405：代码块的语言按钮在盒子右侧，贴着视口右缘展开会溢出 —— 右放不下就往左收。
    // jsdom 里 offsetWidth 恒 0，这时保持旧读数（r.left），别凭空挪位。
    const width = list.offsetWidth;
    const left = width > 0 ? Math.min(r.left, window.innerWidth - width - VIEWPORT_MARGIN) : r.left;
    list.style.left = `${Math.max(VIEWPORT_MARGIN, left)}px`;
    if (below >= above) {
      list.style.top = `${r.bottom + gap}px`;
      list.style.transform = "";
      return;
    }
    // 翻到上方：top 设在触发器上沿、整体 translateY(-100%)，底边正好贴住。
    // ⚠️ 这里**不必**再按 above 单独收一道：只有 above > below 才会翻，
    // 而此时 maxH = max(MIN_LIST_H, above) 已经等于 above（只有视口比
    // MIN_LIST_H 还矮时才被 cap 兜住）。两种写法同值，别重复收。
    list.style.top = `${Math.max(minTop, r.top - gap)}px`;
    list.style.transform = "translateY(-100%)";
  }

  function openList(): void {
    if (open) return;
    open = true;
    trigger.setAttribute("aria-expanded", "true");
    root.classList.add("open");
    // 每次展开都从干净状态开始（与原生 select 一致：重新打开不留上次搜索词）
    query = "";
    if (searchInput) searchInput.value = "";
    renderList();
    // B405：挂到 body（见文件头）—— 关闭态仍留在触发器里，旧用例/结构不变
    document.body.appendChild(list);
    list.classList.add("open");
    positionList();
    const items = matched();
    const idx = items.findIndex((o) => o.value === value);
    setActive(idx >= 0 ? idx : 0);
    if (searchInput) searchInput.focus();
    document.addEventListener("mousedown", onDocMouseDown, true);
    document.addEventListener("keydown", onKeyDown, true);
  }

  function closeList(): void {
    if (!open) return;
    open = false;
    trigger.setAttribute("aria-expanded", "false");
    root.classList.remove("open");
    list.classList.remove("open");
    // 收回触发器（关闭态结构与旧版一致）；真正销毁由 destroy 负责
    root.appendChild(list);
    document.removeEventListener("mousedown", onDocMouseDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
  }

  function toggle(): void {
    if (open) closeList();
    else openList();
  }

  function pick(v: string): void {
    // 与原生 select 一致：重选当前项不触发回调
    if (v === value) {
      closeList();
      return;
    }
    value = v;
    renderTrigger();
    renderList();
    closeList();
    opts.onPick(v);
  }

  function onDocMouseDown(e: MouseEvent): void {
    const target = e.target as Node;
    // 展开时列表挂在 body，不在 root 里 —— 两处都要问
    if (!root.contains(target) && !list.contains(target)) closeList();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeList();
      trigger.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter" || e.key === " ") {
      // ⚠️ 搜索框正在打字时，Space 必须还能打出空格、Enter 才提交高亮项
      if (e.target === searchInput && e.key === " ") return;
      e.preventDefault();
      const btns = [...optionsBox.querySelectorAll<HTMLButtonElement>(".dropdown-option")];
      const cur = btns[activeIndex];
      if (cur && !cur.disabled) pick(cur.dataset.value!);
    }
  }

  /** ↑/↓ 在**当前可见**选项里移动高亮（跳过 disabled）。 */
  function move(delta: number): void {
    const next = delta > 0 ? nextEnabled(activeIndex + 1) : prevEnabled(activeIndex - 1);
    if (next >= 0) setActive(next);
  }

  // ⚠️ 这两个必须走 matched()（过滤后的列表）而不是 opts.options：
  // 搜索过滤后按下箭头，索引空间是可见列表的，原实现会跳到看不见的项上。
  function nextEnabled(from: number): number {
    const items = matched();
    const n = items.length;
    if (n === 0) return -1;
    for (let i = 0; i < n; i++) {
      const idx = (from + i) % n;
      if (!items[idx].disabled) return idx;
    }
    return -1;
  }

  function prevEnabled(from: number): number {
    const items = matched();
    const n = items.length;
    if (n === 0) return -1;
    for (let i = 0; i < n; i++) {
      const idx = (((from - i) % n) + n) % n;
      if (!items[idx].disabled) return idx;
    }
    return -1;
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });

  if (searchInput) {
    // 输入即过滤。重画后高亮要回到第一项，否则 activeIndex 指着旧索引空间。
    searchInput.addEventListener("input", () => {
      query = searchInput!.value;
      renderList();
      setActive(0);
      positionList();
    });
  }

  // 列表展开后挂在 body，不再经过触发器的上级；自己挡一次冒泡，别把按键漏给全局快捷键。
  // ⚠️ 必须是冒泡阶段：捕获阶段在列表上 stopPropagation 会连搜索框的按键一起掐掉。
  list.addEventListener("keydown", (e) => e.stopPropagation());

  renderTrigger();
  renderList();
  root.append(trigger, list);

  return {
    root,
    getValue: () => value,
    setValue: (v) => {
      value = v;
      renderTrigger();
      renderList();
    },
    destroy: () => {
      closeList();
      list.remove();
    },
  };
}

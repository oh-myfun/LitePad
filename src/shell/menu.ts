export interface MenuItem {
  label?: string;
  checked?: boolean;
  /** 悬停提示（可选） */
  title?: string;
  /** 显示为分隔线（忽略其他字段） */
  separator?: boolean;
  /**
   * 子菜单：本项渲染为父项（右侧 ▸），悬停或点击向右展开。
   * 传函数则每次展开时求值，供动态列表使用。
   * 有子菜单时 `onSelect` 不触发。
   */
  submenu?: MenuItem[] | (() => MenuItem[]);
  onSelect?: () => void;
}

/**
 * 展开链上的所有菜单元素，[0] 为根菜单，末位为最深层。
 * 各层菜单都平铺挂在 body 上（fixed 定位），避免被父级 `overflow` 裁切。
 */
let chain: HTMLElement[] = [];
/** 本次弹出创建的全部菜单（含已收起的层级之外的残留），统一回收。 */
let created: HTMLElement[] = [];
let cleanup: (() => void) | null = null;

/** 记下每个子菜单的父项按钮，用于收起时还原箭头高亮。 */
const parentButton = new WeakMap<HTMLElement, HTMLElement>();

export function closePopupMenu(): void {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}

function resolveSubmenu(item: MenuItem): MenuItem[] | null {
  const sub = typeof item.submenu === "function" ? item.submenu() : item.submenu;
  return sub && sub.length > 0 ? sub : null;
}

/** 关闭比 level 更深的菜单；level < 0 表示全部关闭。 */
function closeDeeperThan(level: number): void {
  for (const m of chain.splice(level + 1)) {
    parentButton.get(m)?.classList.remove("submenu-open");
    m.remove();
    const i = created.indexOf(m);
    if (i >= 0) created.splice(i, 1);
  }
}

/** 在锚点元素附近弹出轻量菜单（默认向上弹，空间不足自动向下）。
 *  也可不传锚点、直接给逻辑坐标 `at`（文件拖放落点等无现成元素的场景）。 */
export function showPopupMenu(
  anchor: HTMLElement | null,
  items: MenuItem[],
  at?: { x: number; y: number },
): void {
  closePopupMenu();
  chain = [];
  created = [];

  const root = buildMenu(items);
  created.push(root);
  chain.push(root);
  document.body.appendChild(root);
  positionMenu(root, anchor, at);

  const onPointerDown = (e: PointerEvent) => {
    const t = e.target as Node;
    if (!created.some((m) => m.contains(t))) closePopupMenu();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") closePopupMenu();
  };
  const onResize = () => closePopupMenu();

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", onResize);

  cleanup = () => {
    for (const m of created) {
      parentButton.delete(m);
      m.remove();
    }
    created = [];
    chain = [];
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", onResize);
  };
}

function buildMenu(items: MenuItem[]): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "popup-menu";

  const openChild = (btn: HTMLElement, sub: MenuItem[]): void => {
    closeDeeperThan(chain.indexOf(menu));
    const child = buildMenu(sub);
    parentButton.set(child, btn);
    created.push(child);
    chain.push(child);
    document.body.appendChild(child);
    positionSubmenu(child, btn);
    btn.classList.add("submenu-open");
  };

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "menu-sep";
      menu.appendChild(sep);
      continue;
    }

    const btn = document.createElement("button");
    btn.type = "button";

    const check = document.createElement("span");
    check.className = "check";
    check.textContent = item.checked ? "✓" : "";

    const [text, shortcut] = (item.label ?? "").split("\t");
    const textEl = document.createElement("span");
    textEl.className = "menu-label";
    textEl.textContent = text ?? "";

    const sub = resolveSubmenu(item);

    if (sub) {
      const arrow = document.createElement("span");
      arrow.className = "menu-arrow";
      arrow.textContent = "▸";
      btn.append(check, textEl, arrow);
      btn.classList.add("has-submenu");
    } else {
      btn.append(check, textEl);
      if (shortcut) {
        const kbd = document.createElement("span");
        kbd.className = "menu-kbd";
        kbd.textContent = shortcut;
        btn.appendChild(kbd);
      }
    }
    if (item.title) btn.title = item.title;

    btn.addEventListener("mouseenter", () => {
      // 移到同级其他项时收起旧的子菜单（连同其更深层）
      const lvl = chain.indexOf(menu);
      if (lvl < 0) return;
      const next = chain[lvl + 1];
      if (next && parentButton.get(next) !== btn) closeDeeperThan(lvl);
      if (sub) openChild(btn, sub);
    });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (sub) {
        openChild(btn, sub);
        return;
      }
      closePopupMenu();
      item.onSelect?.();
    });

    menu.appendChild(btn);
  }

  // 菜单自身滚动时子菜单会脱离原位，直接收起
  menu.addEventListener("scroll", () => {
    const lvl = chain.indexOf(menu);
    if (lvl >= 0) closeDeeperThan(lvl);
  });

  return menu;
}

function positionMenu(
  menu: HTMLElement,
  anchor: HTMLElement | null,
  at?: { x: number; y: number },
): void {
  // 先隐藏测量，避免闪烁
  menu.style.visibility = "hidden";
  menu.style.left = "0px";
  menu.style.top = "0px";

  // 无锚点时用逻辑坐标构造一个虚拟点（宽高为 0，向上弹的空间即 y 上方）
  const rect = anchor
    ? anchor.getBoundingClientRect()
    : ({
        left: at?.x ?? 0,
        right: at?.x ?? 0,
        top: at?.y ?? 0,
        bottom: at?.y ?? 0,
        width: 0,
        height: 0,
        x: at?.x ?? 0,
        y: at?.y ?? 0,
        toJSON() {},
      } as DOMRect);
  const height = menu.offsetHeight;
  const width = menu.offsetWidth;

  // 默认向上弹（状态栏场景）；上方空间不足（菜单栏在顶部）则向下
  let top = rect.top - height - 4;
  if (top < 4) top = rect.bottom + 4;
  // 上下都放不下时贴底（配合 .popup-menu 的 max-height 滚动）
  if (top + height > window.innerHeight - 8) {
    top = Math.max(8, window.innerHeight - height - 8);
  }

  let left = rect.left;
  if (left + width > window.innerWidth - 8) {
    left = window.innerWidth - width - 8;
  }

  menu.style.top = `${top}px`;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.visibility = "visible";
}

function positionSubmenu(menu: HTMLElement, btn: HTMLElement): void {
  menu.style.visibility = "hidden";
  menu.style.left = "0px";
  menu.style.top = "0px";

  const r = btn.getBoundingClientRect();
  const h = menu.offsetHeight;
  const w = menu.offsetWidth;
  const parentMenu = btn.closest(".popup-menu") as HTMLElement | null;
  const pr = parentMenu?.getBoundingClientRect();

  // 优先贴父项右侧；右边界不够则翻到父菜单左侧
  let left = r.right - 2;
  if (left + w > window.innerWidth - 8) {
    left = pr ? pr.left - w + 2 : window.innerWidth - w - 8;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));

  let top = r.top - 5;
  if (top + h > window.innerHeight - 8) top = window.innerHeight - h - 8;
  top = Math.max(8, top);

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = "visible";
}

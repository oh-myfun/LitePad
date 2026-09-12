export interface MenuItem {
  label?: string;
  checked?: boolean;
  /** 悬停提示（可选） */
  title?: string;
  /** 显示为分隔线（忽略其他字段） */
  separator?: boolean;
  onSelect?: () => void;
}

let cleanup: (() => void) | null = null;

export function closePopupMenu(): void {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}

/** 在锚点元素附近弹出轻量菜单（默认向上弹，空间不足自动向下）。 */
export function showPopupMenu(anchor: HTMLElement, items: MenuItem[]): void {
  closePopupMenu();

  const menu = document.createElement("div");
  menu.className = "popup-menu";

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "menu-sep";
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");

    const check = document.createElement("span");
    check.className = "check";
    check.textContent = item.checked ? "✓" : "";

    const [text, shortcut] = (item.label ?? "").split("\t");
    const textEl = document.createElement("span");
    textEl.textContent = text ?? "";

    btn.append(check, textEl);
    if (item.title) btn.title = item.title;
    if (shortcut) {
      const kbd = document.createElement("span");
      kbd.className = "menu-kbd";
      kbd.textContent = shortcut;
      btn.appendChild(kbd);
    }
    btn.addEventListener("click", () => {
      closePopupMenu();
      item.onSelect?.();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  positionMenu(menu, anchor);

  const onPointerDown = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node)) closePopupMenu();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") closePopupMenu();
  };
  const onResize = () => closePopupMenu();

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", onResize);

  cleanup = () => {
    menu.remove();
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", onResize);
  };
}

function positionMenu(menu: HTMLElement, anchor: HTMLElement): void {
  // 先隐藏测量，避免闪烁
  menu.style.visibility = "hidden";
  menu.style.left = "0px";
  menu.style.top = "0px";

  const rect = anchor.getBoundingClientRect();
  const height = menu.offsetHeight;
  const width = menu.offsetWidth;

  // 默认向上弹（状态栏场景）；上方空间不足（菜单栏在顶部）则向下
  let top = rect.top - height - 4;
  if (top < 4) top = rect.bottom + 4;

  let left = rect.left;
  if (left + width > window.innerWidth - 8) {
    left = window.innerWidth - width - 8;
  }

  menu.style.top = `${top}px`;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.visibility = "visible";
}

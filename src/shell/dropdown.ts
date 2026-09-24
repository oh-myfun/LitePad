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
 *     滚动容器裁切）；下方放不下自动翻到上方。
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
}

export interface DropdownHandle {
  /** 容器：`<div class="dropdown">`（含 trigger 与 list）。 */
  root: HTMLElement;
  getValue(): string;
  setValue(value: string): void;
  destroy(): void;
}

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

  let value = opts.current;
  let open = false;
  let activeIndex = -1;

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
    list.replaceChildren();
    opts.options.forEach((o, i) => {
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
      list.appendChild(btn);
    });
  }

  function setActive(i: number): void {
    const btns = [...list.querySelectorAll<HTMLButtonElement>(".dropdown-option")];
    if (i < 0 || i >= btns.length) return;
    btns.forEach((b, idx) => b.classList.toggle("dd-active", idx === i));
    activeIndex = i;
    btns[i].scrollIntoView({ block: "nearest" });
  }

  function positionList(): void {
    const r = trigger.getBoundingClientRect();
    list.style.left = `${r.left}px`;
    list.style.top = `${r.bottom + 4}px`;
    list.style.minWidth = `${Math.max(r.width, 120)}px`;
    // 下方放不下（含 4px 间距）且上方放得下 → 翻到上方
    const listH = list.getBoundingClientRect().height;
    if (r.bottom + 4 + listH > window.innerHeight && r.top - 4 - listH > 0) {
      list.style.top = `${r.top - 4 - listH}px`;
    }
  }

  function openList(): void {
    if (open) return;
    open = true;
    trigger.setAttribute("aria-expanded", "true");
    root.classList.add("open");
    positionList();
    const idx = opts.options.findIndex((o) => o.value === value);
    setActive(idx >= 0 ? idx : 0);
    document.addEventListener("mousedown", onDocMouseDown, true);
    document.addEventListener("keydown", onKeyDown, true);
  }

  function closeList(): void {
    if (!open) return;
    open = false;
    trigger.setAttribute("aria-expanded", "false");
    root.classList.remove("open");
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
    if (!root.contains(e.target as Node)) closeList();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeList();
      trigger.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = nextEnabled(activeIndex + 1);
      if (next >= 0) setActive(next);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = prevEnabled(activeIndex - 1);
      if (prev >= 0) setActive(prev);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const btns = [...list.querySelectorAll<HTMLButtonElement>(".dropdown-option")];
      const cur = btns[activeIndex];
      if (cur && !cur.disabled) pick(cur.dataset.value!);
    }
  }

  function nextEnabled(from: number): number {
    const n = opts.options.length;
    for (let i = 0; i < n; i++) {
      const idx = (from + i) % n;
      if (!opts.options[idx].disabled) return idx;
    }
    return -1;
  }

  function prevEnabled(from: number): number {
    const n = opts.options.length;
    for (let i = 0; i < n; i++) {
      const idx = (from - i + n) % n;
      if (!opts.options[idx].disabled) return idx;
    }
    return -1;
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });

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
    destroy: () => closeList(),
  };
}

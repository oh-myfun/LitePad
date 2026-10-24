// B365：居顶「快速选择」浮层（照 VS Code quick input）。
//
// 几何与交互对齐 VS Code：
//   · `quickInput.css` 的 `.quick-input-widget { position:absolute; width:600px; left:50% }`，
//     位置由 `quickInputController.layout()` 给 `top = titleBarOffset`（我们 = 标题栏 34px）；
//   · 输入即过滤（不区分大小写）、上下键移动高亮、回车选中、Esc / 点浮层外关闭。
//
// 本模块只做浮层与键盘/鼠标，不碰业务：选中回传**清单原始下标**（过滤不会重排语义），
// 由调用方决定落到哪里。焦点归还也交给调用方（onClose）—— 编辑器才是默认落点。

import { CODICONS } from "./codicons";
import { closePopupMenu } from "./menu";
import { hideTip } from "./tooltip";

export interface QuickPickItem {
  label: string;
  /** 右侧弱色补充说明（可选） */
  description?: string;
  /** 当前项（显示勾） */
  checked?: boolean;
  /** 左侧 16px 字形（codicon 的 HTML，来自 `CODICONS`）；缺省不留图标槽 */
  icon?: string;
  /** 图标配色家族，写到 `data-fam` 上走 `--ficon-*`（见 shell/fileicons.ts） */
  iconFamily?: string;
  /** 分隔线：不是条目，不可高亮 / 不可选；空查询时显示，过滤时收掉 */
  separator?: boolean;
  /** 置灰不可选（仍显示；键盘跳过、点击不生效） */
  disabled?: boolean;
}

export interface QuickPickOptions {
  placeholder: string;
  items: QuickPickItem[];
  /** 初始高亮（清单原始下标）；缺省落在第一个 checked 项，再缺省第一项 */
  activeIndex?: number;
  /**
   * 打开它的那颗键。点它不算「点浮层外面」—— 否则 pointerdown 先关、click 又开，
   * 「再点一下收起」永远做不到（VS Code 的 quick input 同款处理）。
   */
  anchor?: HTMLElement | null;
  /** 选中：回传清单原始下标 */
  onSelect: (index: number) => void;
  onClose?: () => void;
}

interface QuickPickState {
  root: HTMLElement;
  input: HTMLInputElement;
  list: HTMLElement;
  empty: HTMLElement;
  items: QuickPickItem[];
  /** 过滤后仍要显示的原始下标（含 disabled，不含分隔线） */
  visible: number[];
  /** 过滤后可选中项的原始下标（键盘 / 回车只在它上面走） */
  selectable: number[];
  /** 高亮位置：`selectable` 的下标 */
  active: number;
  query: string;
  opts: QuickPickOptions;
  onPointerDown: (e: Event) => void;
}

let current: QuickPickState | null = null;

export function quickPickIsOpen(): boolean {
  return current !== null;
}

export function closeQuickPick(): void {
  const s = current;
  if (!s) return;
  current = null;
  document.removeEventListener("pointerdown", s.onPointerDown, true);
  s.root.remove();
  s.opts.onClose?.();
}

function setActive(s: QuickPickState, pos: number, scroll = true): void {
  if (pos < 0 || pos >= s.selectable.length) return;
  s.active = pos;
  const index = String(s.selectable[pos]);
  for (const row of s.list.children) {
    if (row instanceof HTMLElement) row.classList.toggle("is-active", row.dataset.index === index);
  }
  if (scroll) {
    s.list.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView?.({
      block: "nearest",
    });
  }
}

/** 过滤并重画列表；空查询恢复全量。高亮回到第一项（与 VS Code 一致）。 */
function applyFilter(s: QuickPickState, query: string): void {
  const needle = query.trim().toLowerCase();
  s.visible = s.items
    .map((_, i) => i)
    .filter((i) => !s.items[i].separator)
    .filter((i) => !needle || s.items[i].label.toLowerCase().includes(needle));
  s.selectable = s.visible.filter((i) => !s.items[i].disabled);
  s.active = s.selectable.length ? 0 : -1;
  s.query = needle;
  renderList(s);
}

function renderList(s: QuickPickState): void {
  s.list.textContent = "";
  const visible = new Set(s.visible);
  const activeIndex = s.selectable[s.active];
  // 列表里只要有一条带图标，其余条目也要占住 16px 图标槽（VS Code quick pick 同款对齐）；
  // 整表无图标（编码 / 行尾）则不占，标签更靠左。
  const hasIcons = s.items.some((item) => item.icon);
  s.items.forEach((item, index) => {
    if (item.separator) {
      // 过滤时收掉分组线；空查询按原位置画一条（VS Code quick pick 同款）。
      if (s.query) return;
      const sep = document.createElement("div");
      sep.className = "quick-pick-separator";
      sep.setAttribute("role", "presentation");
      s.list.append(sep);
      return;
    }
    if (!visible.has(index)) return;

    const row = document.createElement("div");
    row.className = "quick-pick-item";
    row.dataset.index = String(index);
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(!!item.checked));
    if (item.checked) row.classList.add("is-checked");
    if (item.disabled) {
      row.classList.add("is-disabled");
      row.setAttribute("aria-disabled", "true");
    }
    if (index === activeIndex) row.classList.add("is-active");

    const check = document.createElement("span");
    check.className = "quick-pick-check";
    if (item.checked) check.innerHTML = CODICONS.check;

    row.append(check);
    if (item.icon) {
      const icon = document.createElement("span");
      icon.className = "quick-pick-icon";
      if (item.iconFamily) icon.dataset.fam = item.iconFamily;
      icon.innerHTML = item.icon;
      row.append(icon);
    } else if (hasIcons) {
      const slot = document.createElement("span");
      slot.className = "quick-pick-icon is-empty";
      row.append(slot);
    }

    const label = document.createElement("span");
    label.className = "quick-pick-label";
    label.textContent = item.label;

    row.append(label);
    if (item.description) {
      const desc = document.createElement("span");
      desc.className = "quick-pick-desc";
      desc.textContent = item.description;
      row.append(desc);
    }
    if (!item.disabled) {
      row.addEventListener("pointermove", () => setActive(s, s.selectable.indexOf(index), false));
      row.addEventListener("click", () => choose(s, index));
    }
    s.list.append(row);
  });
  s.empty.hidden = s.visible.length > 0;
}

function choose(s: QuickPickState, index: number): void {
  const item = s.items[index];
  if (!item || item.separator || item.disabled) return;
  const onSelect = s.opts.onSelect;
  closeQuickPick();
  onSelect(index);
}

/** 在标题栏下方居中出现（几何见 global.css 的 `.quick-pick`）。 */
export function showQuickPick(opts: QuickPickOptions): void {
  closeQuickPick();
  // 菜单与提示都是层叠在浮层高度附近的兄弟：先收掉，免得压在列表上
  closePopupMenu();
  hideTip();

  const root = document.createElement("div");
  root.className = "quick-pick";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", opts.placeholder);

  const header = document.createElement("div");
  header.className = "quick-pick-header";
  const search = document.createElement("span");
  search.className = "quick-pick-search";
  search.innerHTML = CODICONS.search;
  const input = document.createElement("input");
  input.className = "quick-pick-input";
  input.type = "text";
  input.placeholder = opts.placeholder;
  input.spellcheck = false;
  input.setAttribute("aria-label", opts.placeholder);
  header.append(search, input);

  const list = document.createElement("div");
  list.className = "quick-pick-list";
  list.setAttribute("role", "listbox");

  const empty = document.createElement("div");
  empty.className = "quick-pick-empty";
  empty.textContent = "没有匹配项";
  empty.hidden = true;

  root.append(header, list, empty);
  document.body.appendChild(root);

  const s: QuickPickState = {
    root,
    input,
    list,
    empty,
    items: opts.items,
    visible: [],
    selectable: [],
    active: -1,
    query: "",
    opts,
    onPointerDown: (e) => {
      const target = e.target as Node;
      if (root.contains(target)) return;
      if (opts.anchor?.contains(target)) return;
      closeQuickPick();
    },
  };
  current = s;

  const initial =
    opts.activeIndex ??
    Math.max(
      0,
      opts.items.findIndex((item) => item.checked),
    );
  applyFilter(s, "");
  const startPos = s.selectable.indexOf(initial);
  if (startPos > 0) setActive(s, startPos, false);

  input.addEventListener("input", () => applyFilter(s, input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      setActive(s, Math.min(s.selectable.length - 1, s.active + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      setActive(s, Math.max(0, s.active - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const index = s.selectable[s.active];
      if (index !== undefined) choose(s, index);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeQuickPick();
    }
  });
  document.addEventListener("pointerdown", s.onPointerDown, true);
  input.focus();
}

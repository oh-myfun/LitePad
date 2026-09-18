/**
 * 命令面板（M4）：Ctrl+Shift+P 呼出，按名字搜命令并回车执行。
 *
 * 设计要点
 * - 数据源就是 `keymap.ts` 的 COMMANDS 注册表，不另建一套命令清单——
 *   否则新增命令要登记两处，迟早不同步。
 * - 只列**可编辑**命令：`editable: false` 的项是 CodeMirror / 菜单助记符
 *   等系统行为，面板调用了也没有对应动作。
 * - 面板打开期间全局快捷键分发必须让路（见 main.ts 的 onGlobalKeydown），
 *   否则在输入框里打 "s" 会顺带触发 Ctrl+S 之类的组合。
 * - 键盘优先：↑↓ 选择、Enter 执行、Esc 关闭；鼠标悬停/点击同样可用。
 */

import { closePopupMenu } from "./menu";
import { COMMANDS, effectiveKeys, formatBinding, parseKey, type KeymapOverrides } from "./keymap";
import { setTip } from "./tooltip";

export interface PaletteItem {
  id: string;
  label: string;
  group: string;
  /** 当前生效键位的展示串；无键位为空串 */
  keys: string;
  note?: string;
}

export interface CommandPaletteOptions {
  overrides: KeymapOverrides;
  /** 选中某条命令时回调（由 main 走 runShortcut 分发） */
  onRun: (id: string) => void;
  /** 关闭后回调（main 用来把焦点还给编辑器） */
  onClose?: () => void;
}

/** 结果上限：命令表再长也不该渲染几百个节点。 */
const MAX_ROWS = 40;

/** 面板在 DOM 中的宿主 class，供全局快捷键分发判断「面板是否开着」。 */
export const PALETTE_OPEN_CLASS = "palette-open";

/** 面板可见时的根元素 class（测试与样式都靠它定位）。 */
export const PALETTE_OVERLAY_CLASS = "palette-overlay";

/** 面板是否正在显示。同一时刻只允许一个。 */
export function paletteOpen(): boolean {
  return !!document.querySelector(`.${PALETTE_OVERLAY_CLASS}`);
}

/** 面板可执行的命令（排除系统/编辑器内置项）。 */
export function paletteItems(overrides: KeymapOverrides): PaletteItem[] {
  return COMMANDS.filter((c) => c.editable !== false).map((c) => ({
    id: c.id,
    label: c.label,
    group: c.group,
    keys: effectiveKeys(c.id, overrides)
      .map((k) => formatBinding(parseKey(k) ?? { ctrl: false, alt: false, shift: false, key: k }))
      .join(" / "),
    note: c.note,
  }));
}

/**
 * 模糊打分：越大越靠前，-1 表示不匹配。
 *
 * 分四档，都是为了「打几个字母就能定位」：
 *   - 名字连续包含（最直观，给最高分，越靠前分越高）
 *   - 分组名包含（打「视图」能列出该组全部命令）
 *   - 命令 id 包含（界面是中文，但 id 是英文，打 "save" 也能找到「保存」）
 *   - 子序列（"fs" → "file save"，跨字符命中）
 *   - 键位匹配（打 "ctrl s" 也能找到保存）
 */
export function scoreItem(item: PaletteItem, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const label = item.label.toLowerCase();
  const group = item.group.toLowerCase();

  const inLabel = label.indexOf(q);
  if (inLabel >= 0) return 1000 - inLabel;
  const inGroup = group.indexOf(q);
  if (inGroup >= 0) return 600 - inGroup;
  const inId = item.id.toLowerCase().indexOf(q);
  if (inId >= 0) return 500 - inId;
  if (subsequence(label, q)) return 400 - label.length;
  if (item.keys.toLowerCase().includes(q)) return 200;
  return -1;
}

/** `q` 是否为 `s` 的子序列（"fs" 命中 "file.save"）。 */
function subsequence(s: string, q: string): boolean {
  let i = 0;
  for (const ch of s) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return q.length === 0;
}

/** 按 query 过滤 + 排序；query 为空时保持注册表原有顺序。 */
export function filterItems(items: PaletteItem[], query: string): PaletteItem[] {
  if (!query.trim()) return items.slice(0, MAX_ROWS);
  const scored: { item: PaletteItem; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    const score = scoreItem(item, query);
    if (score >= 0) scored.push({ item, score, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, MAX_ROWS).map((s) => s.item);
}

export function showCommandPalette(opts: CommandPaletteOptions): void {
  // 已有面板就不叠第二层（Ctrl+Shift+P 连按只会关掉重开，观感很差）
  if (paletteOpen()) return;

  // B70 C 档：先把打开着的菜单收掉。
  // 菜单不监听键盘（只认 Escape 与外部 pointerdown），所以 Ctrl+Shift+P 呼出面板时
  // 菜单会原地留着 —— 面板的遮罩（z-index 120）盖不住菜单（1000），两者同屏且
  // 菜单还压在上面。用户要的是「呼出面板」这一个动作把菜单顶掉。
  closePopupMenu();

  const items = paletteItems(opts.overrides);
  let rows = filterItems(items, "");
  let active = 0;

  const overlay = document.createElement("div");
  overlay.className = PALETTE_OVERLAY_CLASS;

  const panel = document.createElement("div");
  panel.className = "palette";

  const input = document.createElement("input");
  input.className = "palette-input";
  input.type = "text";
  input.placeholder = "搜索命令…（↑↓ 选择，Enter 执行）";
  input.spellcheck = false;
  input.setAttribute("aria-label", "命令面板搜索框");

  const list = document.createElement("div");
  list.className = "palette-list";

  const footer = document.createElement("div");
  footer.className = "palette-footer";
  footer.textContent = "↑↓ 选择 · Enter 执行 · Esc 关闭";

  panel.append(input, list, footer);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  document.body.classList.add(PALETTE_OPEN_CLASS);

  /**
   * 只改选中态，**不重建行**。
   *
   * ⚠️ 这里曾经是「鼠标移到哪一行就整表重绘一次」，代价有两个：
   *   1. 重绘要先把 `list.textContent = ""` 清空 —— **列表滚动位置随之归零**，
   *      再靠给选中行 `scrollIntoView` 补一次滚动，而补滚动只在「选中行确实不在
   *      视野内」时才动，一旦补不回来，用户看到的就是「鼠标挪到某行、列表弹回顶端」。
   *      现在悬停完全不碰 DOM，滚动位置自然不受影响。
   *   2. 行元素被销毁重建 → 挂在这行上的提示（note）每次悬停都从头等 500ms，
   *      且鼠标下的元素在重绘瞬间换了一个，观感与命中都不稳。
   */
  const paint = (): void => {
    list.querySelectorAll<HTMLElement>(".palette-item").forEach((el, i) => {
      el.classList.toggle("is-active", i === active);
    });
  };

  /** 把选中行滚进视野。**只在键盘移动时调**：鼠标不可能停在看不见的行上。 */
  const revealActive = (): void => {
    list.children[active]?.scrollIntoView({ block: "nearest" });
  };

  /** 选中项变化：悬停走静默路径（不滚动），键盘导航才滚动。 */
  const select = (i: number, reveal: boolean): void => {
    active = i;
    paint();
    if (reveal) revealActive();
  };

  const render = (): void => {
    list.textContent = "";
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "palette-empty";
      empty.textContent = "没有匹配的命令";
      list.appendChild(empty);
      return;
    }
    if (active >= rows.length) active = rows.length - 1;
    if (active < 0) active = 0;

    rows.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "palette-item" + (i === active ? " is-active" : "");
      row.dataset.id = item.id;

      const name = document.createElement("span");
      name.className = "palette-item-label";
      name.textContent = item.label;

      const group = document.createElement("span");
      group.className = "palette-item-group";
      group.textContent = item.group;

      row.append(name, group);
      if (item.keys) {
        const kbd = document.createElement("span");
        kbd.className = "palette-item-keys";
        kbd.textContent = item.keys;
        row.appendChild(kbd);
      }
      // B58：note 是命令的补充说明（行里已经有键位了），走自绘提示层
      if (item.note) setTip(row, item.note, { group: "palette" });

      row.addEventListener("mousemove", () => {
        if (active === i) return;
        select(i, false);
      });
      row.addEventListener("click", () => run(item.id));
      list.appendChild(row);
    });
    // 重建后滚动位置本来就在顶端（`textContent = ""` 会归零），
    // 第一项必然可见 —— 这里**不需要**也不该再 scrollIntoView。
  };

  const run = (id: string): void => {
    close();
    opts.onRun(id);
  };

  const close = (): void => {
    document.removeEventListener("keydown", onKeyDown, true);
    overlay.remove();
    document.body.classList.remove(PALETTE_OPEN_CLASS);
    opts.onClose?.();
  };

  /** 挂 document 捕获阶段：输入框可能没焦点，挂 input 上会漏键。 */
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      if (rows.length > 0) select((active + 1) % rows.length, true);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (rows.length > 0) select((active - 1 + rows.length) % rows.length, true);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const item = rows[active];
      if (item) run(item.id);
    }
  };

  input.addEventListener("input", () => {
    rows = filterItems(items, input.value);
    active = 0;
    render();
  });

  // 点面板外面关闭（与设置对话框一致）
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  document.addEventListener("keydown", onKeyDown, true);
  render();
  input.focus();
}

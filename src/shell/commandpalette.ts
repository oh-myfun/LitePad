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
        active = i;
        render();
      });
      row.addEventListener("click", () => run(item.id));
      list.appendChild(row);
      if (i === active) {
        // 键盘移动时把当前项滚进视野（列表可滚动时否则看不到高亮）
        row.scrollIntoView({ block: "nearest" });
      }
    });
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
      if (rows.length > 0) active = (active + 1) % rows.length;
      render();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (rows.length > 0) active = (active - 1 + rows.length) % rows.length;
      render();
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

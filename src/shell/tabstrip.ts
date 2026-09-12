import { showPopupMenu, type MenuItem } from "./menu";
import { beginTabDrag, consumeTabClickSuppressed } from "./splitview";

/**
 * 标签栏渲染：纯函数式全量重绘（标签数量小，简单可靠）。
 * 事件通过回调上抛，模块本身不持有应用状态。
 *
 * 交互：左键激活 / 中键关闭 / 右键菜单（关闭·关闭其他·关闭右侧·复制路径）/
 *       拖拽排序 / 双击空白处新建 / **滚轮切换可见区间**。
 *
 * 溢出策略（用户要求）：标签区**不再显示滚动条**；放不下的标签不横向滚动，
 * 而是折叠进右侧的下拉按钮（左侧与右侧超出可视区的标签都在该列表里），
 * 滚轮改变"可见窗口"的起始位置——所以窗口两侧都可能折叠。
 */

export interface TabViewData {
  tabId: number;
  name: string;
  dirty: boolean;
  readonly: boolean;
  active: boolean;
  /** 完整路径（右键「复制路径」用，可空） */
  path?: string;
  /** 存在其他分屏面板（右键「复制到相邻面板」的显示条件） */
  hasSibling?: boolean;
}

export interface TabstripCallbacks {
  onActivate: (tabId: number) => void;
  onClose: (tabId: number) => void;
  onCloseOther?: (tabId: number) => void;
  onCloseRight?: (tabId: number) => void;
  onCopyPath?: (tabId: number) => void;
  /** 同源复制：在本面板内复制一个标签实例（同文档多实例，内容同步） */
  onDuplicateTab?: (tabId: number) => void;
  /** 同源复制到视觉相邻面板（左右分屏对照源码/预览的快捷入口） */
  onDuplicateToSibling?: (tabId: number) => void;
  onReorder?: (fromTabId: number, toTabId: number) => void;
  onNew?: () => void;
}

/** 每个标签栏的可见窗口状态（重绘之间保留）。 */
interface StripEntry {
  start: number;
  tabs: TabViewData[];
  cb: TabstripCallbacks;
  /** 上次渲染时的活动标签下标——仅在其变化时才把活动标签拉回可视区 */
  lastActive: number;
  acc: number;
}

const strips = new WeakMap<HTMLElement, StripEntry>();
const wheelBound = new WeakSet<HTMLElement>();

/** 折叠按钮预留宽度（px） */
const MORE_WIDTH = 34;
/** 与 .panel-tabstrip 的 gap 保持一致 */
const TAB_GAP = 2;
/** 滚轮步进阈值：鼠标一格约 100，触控板单帧很小（防一次滑动跳太多） */
const WHEEL_THRESHOLD = 30;

export function renderTabstrip(
  host: HTMLElement,
  tabs: TabViewData[],
  cb: TabstripCallbacks,
): void {
  let entry = strips.get(host);
  if (!entry) {
    entry = { start: 0, tabs, cb, lastActive: -1, acc: 0 };
    strips.set(host, entry);
  }
  const activeIdx = tabs.findIndex((t) => t.active);
  // 活动标签变了（用户切换标签）→ 先把它拉进可视区；滚轮浏览时不干预
  if (activeIdx >= 0 && activeIdx !== entry.lastActive) {
    entry.start = Math.max(0, activeIdx);
  }
  entry.tabs = tabs;
  entry.cb = cb;

  host.textContent = "";
  const els = tabs.map((t) => createTabEl(t, cb));
  for (const el of els) host.appendChild(el);

  host.ondblclick = (e) => {
    if (e.target === host) cb.onNew?.();
  };
  if (!wheelBound.has(host)) {
    wheelBound.add(host);
    host.addEventListener("wheel", (e) => onWheel(host, e), { passive: false });
  }

  applyOverflow(host, entry, els, activeIdx);
  entry.lastActive = activeIdx;
}

function createTabEl(t: TabViewData, cb: TabstripCallbacks): HTMLElement {
  const el = document.createElement("div");
  el.className = "tab" + (t.active ? " tab-active" : "");
  el.dataset.tabId = String(t.tabId);
  el.title = t.readonly ? `${t.name} [只读]` : t.name;

  const name = document.createElement("span");
  name.className = "tab-name";
  name.textContent = t.name;

  const mark = document.createElement("span");
  mark.className = "tab-mark";
  mark.textContent = t.dirty ? "●" : "";
  mark.setAttribute("aria-hidden", "true");

  const close = document.createElement("button");
  close.className = "tab-close";
  close.textContent = "×";
  close.title = "关闭 (Ctrl+W)";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    cb.onClose(t.tabId);
  });
  close.addEventListener("mousedown", (e) => e.stopPropagation());

  // 中键关闭
  el.addEventListener("mousedown", (e) => {
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      cb.onClose(t.tabId);
    }
  });

  // 右键菜单
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const items = [
      { label: "关闭", onSelect: () => cb.onClose(t.tabId) },
      {
        label: "复制标签",
        title: "创建同源副本（内容实时同步），可拖到其他面板对照查看",
        onSelect: () => cb.onDuplicateTab?.(t.tabId),
      },
      ...(t.hasSibling
        ? [
            {
              label: "复制到相邻面板",
              onSelect: () => cb.onDuplicateToSibling?.(t.tabId),
            },
          ]
        : []),
      {
        label: "关闭其他标签",
        onSelect: () => cb.onCloseOther?.(t.tabId),
      },
      {
        label: "关闭右侧标签",
        onSelect: () => cb.onCloseRight?.(t.tabId),
      },
      ...(t.path
        ? [
            {
              label: "复制文件路径",
              onSelect: () => cb.onCopyPath?.(t.tabId),
            },
          ]
        : []),
    ];
    showPopupMenu(el, items);
  });

  // 拖拽：指针事件序列（mousedown 阈值进入拖拽，mousemove 预览，mouseup 提交），
  // 具体落点逻辑在 splitview.ts。不用 HTML5 DnD——Windows 上 WebView2 原生拖放
  // 钩子（dragDropEnabled，文件拖入打开需要它）会禁用页面内 HTML5 DnD。
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return; // 仅左键启动拖拽（中键关闭已有独立处理器）
    if ((e.target as HTMLElement).closest(".tab-close")) return; // × 上不拖
    beginTabDrag(t.tabId, e);
  });

  el.append(name, mark, close);
  el.addEventListener("click", () => {
    if (consumeTabClickSuppressed()) return; // 拖拽提交后的 click 不激活
    cb.onActivate(t.tabId);
  });
  return el;
}

/** 宽度合计（含标签之间的 gap）。 */
function widthOf(widths: number[], from: number, count: number): number {
  let sum = 0;
  for (let i = from; i < from + count && i < widths.length; i++) {
    sum += widths[i] + (i > from ? TAB_GAP : 0);
  }
  return sum;
}

/** 从 from 起、在 budget 内最多能放几个标签（至少 1 个）。 */
function fitCount(widths: number[], from: number, budget: number): number {
  let n = 0;
  while (n < widths.length - from && widthOf(widths, from, n + 1) <= budget) n++;
  return n;
}

function applyOverflow(
  host: HTMLElement,
  entry: StripEntry,
  els: HTMLElement[],
  activeIdx: number,
): void {
  const avail = host.clientWidth;
  const widths = els.map((el) => el.getBoundingClientRect().width || el.offsetWidth);
  if (els.length === 0) return;

  // 放得下：不折叠（把窗口复位到 0，避免关掉标签后残留偏移）
  if (avail <= 0 || widthOf(widths, 0, els.length) <= avail) {
    entry.start = 0;
    return;
  }

  const budget = Math.max(MORE_WIDTH, avail - MORE_WIDTH);
  entry.start = Math.min(Math.max(0, entry.start), els.length - 1);
  let count = fitCount(widths, entry.start, budget);
  // 活动标签必须可见（start 已在渲染入口被设为活动下标，这里再补齐尾部对齐）
  if (activeIdx >= 0 && entry.start + count <= activeIdx) {
    entry.start = Math.max(0, activeIdx - count + 1);
  }
  // 尾部越界回收（关标签后窗口可能滑出末尾）
  if (entry.start + count > els.length) {
    entry.start = Math.max(0, els.length - count);
  }
  count = fitCount(widths, entry.start, budget);

  for (let i = 0; i < els.length; i++) {
    if (i < entry.start || i >= entry.start + count) els[i].remove();
  }
  host.appendChild(makeMoreButton(entry.tabs, entry.start, count, entry.cb));
}

/** 折叠按钮：点击展开"看不见的标签"列表（左侧溢出在前，右侧溢出在后）。 */
function makeMoreButton(
  tabs: TabViewData[],
  start: number,
  count: number,
  cb: TabstripCallbacks,
): HTMLElement {
  const left = tabs.slice(0, start);
  const right = tabs.slice(start + count);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tab-more";
  btn.textContent = "»";
  btn.title = `${left.length + right.length} 个标签已折叠（点击展开列表，滚轮可切换显示区间）`;

  const items: MenuItem[] = [];
  const itemOf = (t: TabViewData): MenuItem => ({
    label: (t.dirty ? "● " : "") + t.name,
    checked: t.active,
    title: t.path ?? undefined,
    onSelect: () => cb.onActivate(t.tabId),
  });
  for (const t of left) items.push(itemOf(t));
  if (left.length > 0 && right.length > 0) items.push({ separator: true });
  for (const t of right) items.push(itemOf(t));

  btn.addEventListener("mousedown", (e) => e.stopPropagation());
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    showPopupMenu(btn, items);
  });
  return btn;
}

/** 滚轮：改变可见区间的起始位置（Ctrl+滚轮让位给字号缩放）。 */
function onWheel(host: HTMLElement, e: WheelEvent): void {
  if (e.ctrlKey) return;
  const entry = strips.get(host);
  if (!entry) return;
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  entry.acc += delta;
  if (Math.abs(entry.acc) < WHEEL_THRESHOLD) return;
  const dir = entry.acc > 0 ? 1 : -1;
  entry.acc = 0;
  const next = Math.max(0, entry.start + dir);
  if (next === entry.start) return;
  entry.start = next;
  // 自己消化滚轮，不要传给页面
  e.preventDefault();
  renderTabstrip(host, entry.tabs, entry.cb);
}

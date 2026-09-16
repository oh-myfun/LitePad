import { showPopupMenu } from "./menu";
import { beginTabDrag, consumeTabClickSuppressed } from "./splitview";
import { fileIconSvg, familyOf } from "./fileicons";
import { ICONS, dotIcon } from "./icons";
import { setTip } from "./tooltip";

/**
 * 标签栏渲染：纯函数式全量重绘（标签数量小，简单可靠）。
 * 事件通过回调上抛，模块本身不持有应用状态。
 *
 * 交互：左键激活 / 中键关闭 / 右键菜单（关闭·关闭其他·关闭右侧·复制路径）/
 *       拖拽排序 / 双击空白处新建 / **滚轮横向滚动**。
 *
 * 溢出策略（B53 起，用户要求）：**不再折叠**。放不下的标签就是普通的横向滚动
 * （VS Code 式）——B56 起标签**不收缩**（宽度 = 内容宽度、文件名不裁剪），
 * 所以溢出比之前来得更早，这是预期行为。
 *
 * B32–B47 的「可见窗口 + 折叠下拉列表」已整体删除。它要求手写三条不变量
 * （尺寸变化必须重算、活动标签拉回要门控、窗口必须铺满预算）+ ResizeObserver 记账，
 * 而这些能力**浏览器原生滚动全部自带**：布局与裁剪由 flex + overflow 自动重算，
 * 「滚到哪」由 scrollLeft 持有，不再需要模块自己维护区间。
 */

export interface TabViewData {
  tabId: number;
  name: string;
  dirty: boolean;
  readonly: boolean;
  active: boolean;
  /**
   * 语言标签（来自 `language.ts` 的注册表，如 "Markdown" / "TypeScript"）。
   * 标签左侧的类型图标按它选字形与家族配色；缺省按纯文本处理。
   */
  lang?: string;
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

/** 重绘之间保留的状态。滚动位置本身由 DOM 的 scrollLeft 持有，无需模块记账。 */
interface StripEntry {
  tabs: TabViewData[];
  cb: TabstripCallbacks;
  /** 上次渲染时活动标签的 tabId（-1 = 首次渲染） */
  lastActiveId: number;
}

const strips = new WeakMap<HTMLElement, StripEntry>();
const wheelBound = new WeakSet<HTMLElement>();

/**
 * 滚轮 deltaMode 归一化系数：某些设备/驱动按「行」或「页」上报 delta，
 * 直接当像素用会几乎滚不动（deltaMode=1 时 delta 常常只有 3）。
 */
const LINE_PX = 16;

export function renderTabstrip(
  host: HTMLElement,
  tabs: TabViewData[],
  cb: TabstripCallbacks,
): void {
  let entry = strips.get(host);
  if (!entry) {
    entry = { tabs, cb, lastActiveId: -1 };
    strips.set(host, entry);
  }
  entry.tabs = tabs;
  entry.cb = cb;

  // 全量重绘会清空子节点 → 滚动位置被浏览器归零，必须自己存取。
  // 少了这一步，每次激活/关闭标签标签栏都会跳回最左端。
  const prevScroll = host.scrollLeft;

  host.textContent = "";
  const els = tabs.map((t) => createTabEl(t, cb));
  for (const el of els) host.appendChild(el);

  host.ondblclick = (e) => {
    if (e.target === host) cb.onNew?.();
  };
  bindWheel(host);

  host.scrollLeft = prevScroll;

  const activeIdx = tabs.findIndex((t) => t.active);
  const activeId = activeIdx >= 0 ? tabs[activeIdx].tabId : -1;
  // 只在活动标签**真的换了**时才滚动定位。无脑滚动会把用户手动滚出去的位置
  // 无条件拽回来——活动标签在可视区外的右侧（新开文件的常态）时表现为「滚不动」。
  if (activeIdx >= 0 && activeId !== entry.lastActiveId) {
    ensureVisible(host, els[activeIdx]);
    // 首次渲染（lastActiveId=-1）不闪，免得启动就跳一下
    if (entry.lastActiveId >= 0) flashTab(els[activeIdx]);
  }
  entry.lastActiveId = activeId;
}

/**
 * 把某个标签滚进可见区。
 *
 * 不用 `scrollIntoView()`，两个原因：① jsdom 没有这个方法（测试要跑）；
 * ② 它会把**所有**祖先滚动容器一起滚动，在分屏/嵌套布局里会连带整页跳动。
 *
 * 「已经可见就不动」是自然满足的，这正好保住了老实现用 `activeChanged` 门控
 * 才换来的行为：切换到已可见的标签时标签栏不跳。
 */
function ensureVisible(host: HTMLElement, el: HTMLElement): void {
  const view = host.clientWidth;
  if (view <= 0) return; // 未布局（隐藏面板 / jsdom）：无从判断，不动
  const left = el.offsetLeft;
  const right = left + el.offsetWidth;
  if (left < host.scrollLeft) {
    host.scrollLeft = left;
  } else if (right > host.scrollLeft + view) {
    host.scrollLeft = right - view;
  }
}

/**
 * 新激活的标签闪一次高亮。切换标签（含 Ctrl+Tab、跨面板拖入）时标签栏可能
 * 刚滚动过，闪一下便于定位。动画结束回到常态，不保留结束态。
 */
function flashTab(el: HTMLElement | undefined): void {
  if (!el || !el.isConnected) return;
  el.classList.add("tab-flash");
  const done = (): void => el.classList.remove("tab-flash");
  el.addEventListener("animationend", done, { once: true });
  // 动画被系统禁用 / jsdom 无动画时的兜底，避免 class 常驻
  setTimeout(done, 1200);
}

function createTabEl(t: TabViewData, cb: TabstripCallbacks): HTMLElement {
  const el = document.createElement("div");
  // tab-dirty 供 CSS 决定槽位里显示 ● 还是空（VS Code 式）：
  // 平时只见 ●（未保存）/ 空（已保存），鼠标悬停到标签上才换成 ×。
  el.className = "tab" + (t.active ? " tab-active" : "") + (t.dirty ? " tab-dirty" : "");
  el.dataset.tabId = String(t.tabId);
  // B58：标签提示 = 文件名（+ 只读标记），第二行给完整路径 —— 标签会被横向滚动
  // 推出视野、文件名也可能与同目录的其他同名文件混淆，路径这一行才是真正有用的信息。
  // group 让「顺着标签滑过去」时提示秒开、不忽明忽暗（VS Code 的 groupId 行为）。
  setTip(el, t.readonly ? `${t.name} [只读]` : t.name, {
    detail: t.path,
    group: "tabstrip",
  });

  // 文件类型图标（B57，参考 VS Code 的 .tab.has-icon）：
  // 名字左边一个 16px 的家族字形，颜色由 data-fam 走 CSS 变量（浅深两套）。
  const fam = familyOf(t.lang);
  const icon = document.createElement("span");
  icon.className = "tab-icon";
  icon.dataset.fam = fam;
  icon.dataset.lang = t.lang ?? "";
  icon.innerHTML = fileIconSvg(fam);
  icon.setAttribute("aria-hidden", "true");

  const name = document.createElement("span");
  name.className = "tab-name";
  name.textContent = t.name;

  // ● 与 × 共用同一个**固定尺寸**槽位（.tab-action）：悬停时 ● 换成 ×。
  // 槽位宽度固定、只换内容，否则鼠标划过时标签宽度会变、整排标签左右抖动。
  // B57 起显隐改走 `opacity`（参考 VS Code：`opacity: 0` → 悬停/活动/未保存时 1），
  // 不再用 display 切换 —— 布局本来就稳定，opacity 还能顺势做淡入。
  const action = document.createElement("span");
  action.className = "tab-action";

  const mark = document.createElement("span");
  mark.className = "tab-mark";
  mark.innerHTML = dotIcon();
  mark.setAttribute("aria-hidden", "true");

  const close = document.createElement("button");
  close.className = "tab-close";
  close.innerHTML = ICONS.close;
  setTip(close, "关闭", { key: "Ctrl+W", group: "tabstrip" });
  close.setAttribute("aria-label", `关闭 ${t.name}`);
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    cb.onClose(t.tabId);
  });
  close.addEventListener("mousedown", (e) => e.stopPropagation());

  action.append(mark, close);

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

  el.append(icon, name, action);
  el.addEventListener("click", () => {
    if (consumeTabClickSuppressed()) return; // 拖拽提交后的 click 不激活
    cb.onActivate(t.tabId);
  });
  return el;
}

/** wheel 监听只挂一次（同一 host 会被反复重绘）。 */
function bindWheel(host: HTMLElement): void {
  if (wheelBound.has(host)) return;
  wheelBound.add(host);
  // passive:false 才能 preventDefault；非 passive 下滚轮才不会被页面抢走
  host.addEventListener("wheel", (e) => onWheel(host, e), { passive: false });
}

/** 滚轮：横向滚动标签栏（Ctrl+滚轮让位给字号缩放）。 */
function onWheel(host: HTMLElement, e: WheelEvent): void {
  if (e.ctrlKey) return;
  const max = host.scrollWidth - host.clientWidth;
  if (max <= 0) return; // 没溢出：不处理也不拦截
  const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  // deltaMode：0=像素 1=行 2=页
  const delta =
    e.deltaMode === 1 ? raw * LINE_PX : e.deltaMode === 2 ? raw * host.clientWidth : raw;
  if (!delta) return;
  const before = host.scrollLeft;
  host.scrollLeft = Math.max(0, Math.min(max, before + delta));
  // 已经贴到边界、同方向再也滚不动 → 不吞事件，留给页面
  if (host.scrollLeft === before) return;
  e.preventDefault();
}

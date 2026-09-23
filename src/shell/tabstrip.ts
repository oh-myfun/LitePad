import { showPopupMenu } from "./menu";
import { startTabDrag, type DragImageAnchor } from "./tabdnd";
import { fileIconHtml, familyOf } from "./fileicons";
import { CODICONS } from "./codicons";
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
 *
 * B91-2 起拖拽改回 **HTML5 DnD**（`draggable` + `dragstart` + 系统绘制影像），
 * 传输与跨窗口交接在 `tabdnd.ts`；本模块只负责「从哪个标签起手、影像是谁」。
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
  /** 把该标签分屏到新面板（左右 / 上下）。对标 VS Code 标签右键的 Split Right/Down */
  onSplitH?: (tabId: number) => void;
  onSplitV?: (tabId: number) => void;
  /** B71：双击标签 = 最大化/还原本面板（仅多面板时才有；VS Code 的
   *  `doubleClickTabToToggleEditorGroupSizes = 'maximize'`，LitePad 无「固定标签」，
   *  双击标签原本空闲）。给了这个回调才会接管双击，否则保持无行为。 */
  onToggleMaximize?: () => void;
  /** B71 ④：把该标签放到新窗口（多窗口）。主窗口与卫星窗口都可用。 */
  onOpenInNewWindow?: (tabId: number) => void;
  /** B71 ④：把该标签交回主窗口（只在卫星窗口给；主窗口给了没有意义）。 */
  onReturnToMain?: (tabId: number) => void;
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

// ---------------------------------------------------------------- 拖拽影像（B91-2）
//
// 影像现在交给 `dataTransfer.setDragImage`，由**系统**绘制 —— 指针移出窗口、压到
// 别的应用上照样跟着走。这正是指针编排（B64–B90）做不到的：那时影像是本窗口的一个
// DOM 浮层，越过窗口边界就没了。
//
// ⚠️ 影像元素必须**已经渲染过**才能拍出图（detached 元素在部分 Chromium 版本上会拍成
// 空图）。`startTabDrag` 负责把它离屏挂进 body、交快照、**推一帧再摘掉**（同步摘会在
// Chromium 拍快照之前就把元素移出文档 → 系统根本拿不到图）。

/** 单标签影像锚点：光标落在影像左上角（VS Code `setDragImage(tab, 0, 0)`）。 */
export const TAB_IMAGE_ANCHOR: DragImageAnchor = { x: 0, y: 0 };

/**
 * 整组影像锚点：光标落在药丸**内部**靠左上处（VS Code `applyDragImage` 的
 * `setDragImage(dragImage, -10, -10)`）—— 读起来像「捏着它」而不是「挂在角上」。
 */
export const GROUP_IMAGE_ANCHOR: DragImageAnchor = { x: 10, y: 10 };

/**
 * 造单标签的拖拽影像：被拖标签的**副本**。
 *
 * ⚠️ 必须克隆而不是搬走原标签：影像期间原标签原地不动，它是用户判断「从哪儿拖的、
 * 拖到哪儿了」的参照物。
 */
export function createTabDragImage(srcEl: HTMLElement): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = "tab-drag-ghost";
  ghost.setAttribute("aria-hidden", "true");
  const copy = srcEl.cloneNode(true) as HTMLElement;
  // 副本不得带 tabId：多处逻辑「按 tabId 查元素」，留着会让查询命中副本而非真标签。
  copy.removeAttribute("data-tab-id");
  // 副本不是真标签：剥掉提示接线。
  for (const el of [copy, ...copy.querySelectorAll<HTMLElement>("[data-tip]")]) {
    el.removeAttribute("data-tip");
    el.removeAttribute("data-tip-group");
  }
  // 影像里不该有可聚焦元素（外面套着 aria-hidden）。
  copy.querySelectorAll<HTMLElement>("button").forEach((b) => (b.tabIndex = -1));
  ghost.appendChild(copy);
  return ghost;
}

/**
 * 造「整组拖拽」的影像：一颗只有文字的**聚合药丸**，形如 `a.md (+2)`。
 *
 * 出处：`editorTabsControl.ts:487-494` —— 拖整组时 VS Code 不搬标签 DOM，而是取
 * 「活动标签名」拼上其余数量（`localize('draggedEditorGroup', "{0} (+{1})")`），
 * 交给 `applyDragImage` 渲染成 `.monaco-drag-image`（12px / 圆角 / 单行 / 超长省略）。
 *
 * ⚠️ 为什么不克隆整条标签栏（B71 的做法）：克隆出来的是一条真标签带子，
 *   · 不裁 → 8 个标签能拖出一条横贯窗口的带子，把落点预览全盖住；
 *   · 裁（旧 `max-width: 260px; overflow: hidden`）→ 最后一个标签被拦腰切掉半个，
 *     看起来像「坏了」；
 *   · 而且它和真标签长得一模一样，用户分不清「这是副本还是它们还没搬走」。
 * 药丸只说两件事：**这一组以谁为主、一共几个**，既不遮落点也不需要裁剪。
 *
 * ⚠️ 有意偏离 VS Code 一处：它把 `名字 (+N)` 当成一个字符串，被 `max-width` 截断时
 * **连计数一起吃掉**（`dnd.css` 的 120px）。而「拖的是整组、一共几个」恰恰是整组影像
 * 唯一不可替代的信息，文件名反倒可以从标签栏上认出来 —— 所以这里拆成两个 span：
 * 名字可截断（`overflow: hidden` + 省略号），计数永不截断（`flex: 0 0 auto`）。
 */
export function createGroupDragImage(strip: HTMLElement): HTMLElement {
  const tabs = Array.from(strip.querySelectorAll<HTMLElement>(".tab"));
  const active = strip.querySelector<HTMLElement>(".tab.tab-active") ?? tabs[0] ?? null;
  const name = active?.querySelector<HTMLElement>(".tab-name")?.textContent?.trim() ?? "";
  const ghost = document.createElement("div");
  ghost.className = "tab-drag-ghost tab-drag-ghost-group";
  ghost.setAttribute("aria-hidden", "true");
  const nameEl = document.createElement("span");
  nameEl.className = "tab-drag-ghost-name";
  ghost.appendChild(nameEl);
  // 名字读不出来（面板正在重建？）也别给一颗空药丸 —— 至少把数量说清楚
  if (!name) {
    nameEl.textContent = `${tabs.length} 个标签`;
    return ghost;
  }
  nameEl.textContent = name;
  // 只有一个标签时不带计数（同 VS Code 的 `count > 1` 判据）
  if (tabs.length > 1) {
    const countEl = document.createElement("span");
    countEl.className = "tab-drag-ghost-count";
    countEl.textContent = ` (+${tabs.length - 1})`;
    ghost.appendChild(countEl);
  }
  return ghost;
}

/** 标签栏里有几个标签（整组拖拽的载荷与「空栏不起拖」判据共用）。 */
export function tabCountOf(strip: HTMLElement): number {
  return strip.querySelectorAll(".tab").length;
}

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
  // 未保存 → 平时 ●，指针进到关闭区才换 ×；已保存 → 平时留空，悬停标签 / 活动标签给 ×。
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
  icon.innerHTML = fileIconHtml(fam);
  icon.setAttribute("aria-hidden", "true");

  const name = document.createElement("span");
  name.className = "tab-name";
  name.textContent = t.name;

  // ● 与 × 共用同一个**固定尺寸**槽位（.tab-action）：未保存时平时显示 ●，
  // **指针进到这个槽位（关闭按钮区域）才换成 ×**（B66；对齐 VS Code 的
  // `.tab.dirty … .action-label:not(:hover)::before { circle-filled }` 内容替换）。
  // 槽位宽度固定、只换内容，否则鼠标划过时标签宽度会变、整排标签左右抖动。
  // B57 起显隐改走 `opacity`（参考 VS Code：`opacity: 0` → 命中时 1），
  // 不再用 display 切换 —— 布局本来就稳定，opacity 还能顺势做淡入。
  const action = document.createElement("span");
  action.className = "tab-action";

  const mark = document.createElement("span");
  mark.className = "tab-mark";
  mark.innerHTML = CODICONS.circleFilled;
  mark.setAttribute("aria-hidden", "true");

  const close = document.createElement("button");
  close.className = "tab-close";
  close.innerHTML = CODICONS.close;
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
      ...(cb.onSplitH ? [{ label: "左右分屏", onSelect: () => cb.onSplitH?.(t.tabId) }] : []),
      ...(cb.onSplitV ? [{ label: "上下分屏", onSelect: () => cb.onSplitV?.(t.tabId) }] : []),
      ...(cb.onOpenInNewWindow
        ? [
            {
              label: "在新窗口打开",
              onSelect: () => cb.onOpenInNewWindow?.(t.tabId),
            },
          ]
        : []),
      ...(cb.onReturnToMain
        ? [{ label: "移回主窗口", onSelect: () => cb.onReturnToMain?.(t.tabId) }]
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

  // B71：双击标签 = 最大化 / 还原本面板。
  // ⚠️ 只在 main 传了 onToggleMaximize（= 存在多个面板）时才接管：单面板时双击
  // 必须保持「什么都不做」，否则会得到一个永远按不出效果的手势。
  // 不能挂在 host 上（那里的双击是「空白处新建」），也不能阻止冒泡以外的行为。
  if (cb.onToggleMaximize) {
    el.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      cb.onToggleMaximize?.();
    });
  }

  // B91-2：拖拽改回 HTML5 DnD。`draggable` 让浏览器接管整段手势（越过阈值自动进入
  // 拖拽、松手自动结束），影像由系统绘制后就能跟出窗口。传输与跨窗口交接见 tabdnd.ts。
  // ⚠️ 影像里的 × 是按钮：从它上面起拖会让用户「点关闭却拖走了标签」，显式挡掉。
  el.draggable = true;
  el.addEventListener("dragstart", (e) => {
    const onCloseBtn = e.target instanceof Element && e.target.closest(".tab-close") !== null;
    if (onCloseBtn) {
      e.preventDefault();
      return;
    }
    startTabDrag(
      e,
      { tabId: t.tabId, groupPanelId: null, count: 1 },
      createTabDragImage(el),
      TAB_IMAGE_ANCHOR,
    );
  });

  el.append(icon, name, action);
  // HTML5 拖拽结束后浏览器不会补发 click，所以这里不再需要「吞掉拖拽后那次点击」
  el.addEventListener("click", () => cb.onActivate(t.tabId));
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

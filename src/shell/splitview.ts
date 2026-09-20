import type { LayoutNode } from "./layout";
import { CODICONS } from "./codicons";
import { renderTabstrip, type TabViewData } from "./tabstrip";
import { setTip } from "./tooltip";

/**
 * 分屏区域渲染：递归布局树 → DOM。
 * - split 节点 = flex 容器 + 可拖拽分隔条（拖拽实时改 flex-basis，松手回写 ratio）
 * - leaf 节点 = 面板（面板级标签栏 + 编辑器宿主）
 * 结构变化时整体重绘；拖拽只改内联样式不重建 EditorView。
 *
 * B59 对齐 VS Code（参考 docs/vscode-reference/）：
 * - 分隔条：双击复位、拖到极限光标变形、拖拽中保持高亮、方向光标（O1–O3/S1）
 * - 角手柄：两条相垂直接处斜向同时拖两条（O7）
 * - 落点：边缘 28% 带 + 1/3 方向优先（O6）、Alt 临时取消分屏（O5）
 *
 * B60/B61/B62 补齐「对齐联动」（对标 sash 的 linkedSash）：同向且落同一位置的分隔条
 * 视为一组，一起拖动 / 一起高亮 / 一起复位。
 *
 * B63 两项（用户反馈）：
 * - **交叉点也要联动**：角手柄有 2 个目标、轴互相垂直 → 两轴各自的联动组都并入
 *   「移动组」（见 `movingGroupOf`），拖动与悬停预告同时覆盖两条轴。
 * - **双击不再一律 50%，而是按分割数量均分**：沿同轴链（`chainId`）把每条分隔条
 *   调成「两侧同轴段数相等」（`segmentsAlong` → `equalRatio`），2 段 = 50%、
 *   3 段 = 1/3 与 1/2、4 段 = 1/4 · 1/3 · 1/2（逐层累乘后每格等宽）。
 */

export interface PanelRenderData {
  panelId: number;
  active: boolean;
  tabs: TabViewData[];
  /** 是否可关闭该分屏（唯一面板时 ⨯ 禁用，退出只走窗口关闭/菜单） */
  canClose?: boolean;
  /** B71：该面板正处于最大化（操作栏多一个「还原」⨯，其余面板 collapsed） */
  maximized?: boolean;
  /** B71：被最大化挤成 0 的那一侧（仍留在 DOM 里，只是不占地方） */
  collapsed?: boolean;
}

export interface SplitviewCallbacks {
  onActivatePanel: (panelId: number) => void;
  onActivateTab: (panelId: number, tabId: number) => void;
  onCloseTab: (tabId: number) => void;
  onClosePanel: (panelId: number) => void;
  /** 拖拽结束回写比例；path 为树路径（0=左/上，1=右/下） */
  onRatioChange: (path: number[], ratio: number) => void;
  /** 标签栏扩展交互（右键菜单/拖拽排序/双击新建） */
  onCloseOtherTab?: (panelId: number, tabId: number) => void;
  onCloseRightTabs?: (panelId: number, tabId: number) => void;
  onCopyTabPath?: (tabId: number) => void;
  /** 同源复制标签实例（本面板内 / 相邻面板） */
  onDuplicateTab?: (tabId: number) => void;
  onDuplicateToSibling?: (tabId: number) => void;
  onReorderTab?: (panelId: number, fromTabId: number, toTabId: number) => void;
  /** B71：标签右键「左右/上下分屏」——复制一份到新面板（VS Code 的 Split Right/Down） */
  onSplitTab?: (panelId: number, tabId: number, dir: "h" | "v") => void;
  /** B71：整组拖拽落在本面板的标签区 / 中心 → 整组并入目标面板（源面板消失） */
  onMergeGroup?: (sourcePanelId: number, targetPanelId: number) => void;
  /** B71：整组拖拽落在边缘 → 整组搬到该侧的新分屏位置 */
  onMoveGroupToPanel?: (
    sourcePanelId: number,
    targetPanelId: number,
    dir: "h" | "v",
    newFirst: boolean,
  ) => void;
  /** B71：最大化 / 还原该面板（双击标签、操作栏「还原」按钮都走这里） */
  onToggleMaximizePanel?: (panelId: number) => void;
  /** B71 ④：把标签放到新窗口 / 从卫星窗口交回主窗口 */
  onOpenTabInNewWindow?: (tabId: number) => void;
  onReturnTabToMain?: (tabId: number) => void;
  /**
   * B89：拖拽途中指针**在窗口外**时，每次移动都通知一次（宿主据此广播指针位置，
   * 让别的窗口亮预览）。
   *
   * ⚠️ 这里只准做「告知」，不准产生任何副作用 —— 出界就生效正是用户报的毛病
   * （擦过另一个窗口的面板就被合入）。真正的搬运一律等 `onDropOutOfWindow`。
   */
  onDragOutside?: (drag: {
    tabId: number;
    groupPanelId: number | null;
    clientX: number;
    clientY: number;
  }) => void;
  /**
   * B89：**松手**时指针在窗口外。宿主决定去哪儿：
   *   · 别的 LitePad 窗口接手了 → 交给它（具体面板/分屏位置由那边算）；
   *   · 没人接手（扔在桌面上）→ 回落到旧语义（主窗口开新窗口，卫星窗口交回主窗口）。
   */
  onDropOutOfWindow?: (drag: {
    tabId: number;
    groupPanelId: number | null;
    clientX: number;
    clientY: number;
  }) => void;
  /** 拖拽标签落在 tab 区（B27）：插到 beforeTabId 之前（null = 追加到末尾）。
   *  同面板 = 调整顺序；跨面板 = 移动到该面板的该位置。不是分屏。 */
  onMoveTabToStrip: (panelId: number, tabId: number, beforeTabId: number | null) => void;
  onNewTab?: (panelId: number) => void;
  /** 拖拽标签落点：zone=left/right/top/bottom 表示分屏方向，center 表示移入该面板；
   *  overTabId 仅同面板排序时用于定位目标标签；copy=按住 Ctrl 拖拽（同源复制而非移动）。 */
  onDropTabToPanel?: (
    tabId: number,
    targetPanelId: number,
    zone: "left" | "right" | "top" | "bottom" | "center",
    overTabId: number | null,
    copy: boolean,
  ) => void;
  /** 面板宿主就绪：把该面板的 EditorView DOM 挂载进来 */
  mountView: (panelId: number, hostEl: HTMLElement) => void;
}

export function renderSplitview(
  root: HTMLElement,
  tree: LayoutNode,
  panelData: Map<number, PanelRenderData>,
  cb: SplitviewCallbacks,
): void {
  svCallbacks = cb;
  root.textContent = "";
  // B60：每次重绘都换一批分隔条元素，注册表必须跟着清 —— 否则会拿已脱离文档的
  // 旧句柄去算对齐（centerOf 恒为 0，误判成「全部对齐」）。
  sashRegistry = [];
  // B63：同轴链号每次重绘重排。注册表一起清，所以链号本身不会串场；归零只为
  // 让同一棵树的链号恒定（渲染结果可复现，断言与调试都不依赖绘制次数）。
  chainSeq = 0;
  root.appendChild(build(tree, [], cb, panelData).el);
}

/** 当前布局回调（单一布局区；指针拖拽的落点提交需要访问 onDropTabToPanel）。 */
let svCallbacks: SplitviewCallbacks | null = null;

// ---------------------------------------------------------------- 标签指针拖拽
// 说明：标签拖拽不用 HTML5 DnD——Windows 上 WebView2 开启原生拖放钩子
// （dragDropEnabled，文件拖入需要它）会让页面内 HTML5 DnD 全部失效。
// 改用 mousedown/mousemove/mouseup 指针序列自行编排，落点判定与预览逻辑不变。
// 代价之一：没有浏览器自带的拖拽影像 → B64 自己造一个跟随光标的标签副本
// （`createDragGhost`，对齐 VS Code 的 `setDragImage(tab, 0, 0)`）。

/** 移动超过该距离才进入拖拽（否则保持点击激活语义）。 */
const DRAG_THRESHOLD = 5;

/**
 * 指针要越过窗口边界这么多像素才算「想扔到另一个窗口」。
 *
 * 为什么不直接用「出界」当判据：贴着窗口边缘拖动（尤其是最大化的窗口，边缘就是屏幕
 * 边缘）时指针很容易擦出去几十毫秒，那会莫名其妙弹出一个新窗口。留一段余量，把
 * 「擦边」和「真的拖出去」区分开。
 */
const DRAG_OUT_MARGIN = 24;

interface TabDragState {
  tabId: number;
  startX: number;
  startY: number;
  active: boolean;
  /**
   * B89：指针此刻是否在**窗口外**。
   *
   * 只用来决定「松手时该走窗口内落点还是跨窗口」，不触发任何副作用——出界瞬间就
   * 把标签送走的做法已被 B89 废掉（见 `onDragOutside` 的注释）。
   */
  outOfWindow: boolean;
  /** 被拖的标签元素：越过阈值后据此造「跟随光标的副本」。 */
  tabEl: HTMLElement | null;
  /**
   * B71：非 null = **拖整组**（从标签栏空白处起手，对标 VS Code 的
   * `editorTabsControl.onGroupDragStart`：只有 `e.target === tabsContainer` 才算整组）。
   * 此时 tabId 无意义（传 -1），落点按「整个面板」处理。
   */
  groupPanelId: number | null;
}
let tabDrag: TabDragState | null = null;
let suppressTabClick = false;

/**
 * tabstrip 的 mousedown 调用：开始观察一次潜在的标签拖拽。
 * `tabEl` = 标签元素本身（拖拽影像要克隆它）。缺省时从事件目标反查；
 * 两者都没有就不显示影像，拖拽本身照常工作。
 */
export function beginTabDrag(
  tabId: number,
  e: MouseEvent,
  tabEl: HTMLElement | null = null,
  groupPanelId: number | null = null,
): void {
  if (tabDrag) finishTabDrag(); // 上一次拖拽未正常收尾（如释放到窗外）→ 先强制清场
  suppressTabClick = false;
  tabDrag = {
    tabId,
    startX: e.clientX,
    startY: e.clientY,
    active: false,
    outOfWindow: false,
    tabEl: tabEl ?? tabElFrom(e.target),
    groupPanelId,
  };
  document.addEventListener("mousemove", onTabDragMove);
  document.addEventListener("mouseup", onTabDragEnd);
  // 拖到窗口外松手时 mouseup 收不到 → 窗口失焦即视为取消，顺手清掉浮动影像。
  window.addEventListener("blur", finishTabDrag);
}

/** 事件目标可能是图标/文件名等子元素 → 反查它所在的标签。 */
function tabElFrom(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(".tab") : null;
}

/** 拖拽中跟随光标的浮动影像（`.tab-drag-ghost`）；非拖拽期为 null。 */
let dragGhost: HTMLElement | null = null;

/**
 * 影像左上角相对指针的偏移（像素）。
 *
 * 两种影像的锚点不同，各自对标 VS Code 的一处 `setDragImage`：
 *   · 单标签副本 = `setDragImage(tab, 0, 0)`（`multiEditorTabsControl.ts:1295`，
 *     注释写明「把被拖标签的左上角放到光标处，好给落点边框反馈让位」）→ 偏移 0；
 *   · 整组药丸 = `applyDragImage` 里的 `setDragImage(dragImage, -10, -10)`
 *     （`dnd.ts:27`）→ 指针落在药丸**内部**靠左上处，读起来像「捏着它」而不是
 *     「挂在角上」。
 */
const GHOST_ANCHOR_TAB = { x: 0, y: 0 };
const GHOST_ANCHOR_PILL = { x: 10, y: 10 };
let dragGhostAnchor = GHOST_ANCHOR_TAB;

/**
 * 造一个「跟随光标的标签副本」—— 对标 VS Code 的**单标签**拖拽影像。
 *
 * ⚠️ 必须**克隆**而不是搬走原标签：VS Code 的原生影像期间原标签原地不动，
 * 它是用户判断「从哪儿拖的、拖到哪儿了」的参照物。
 *
 * ⚠️ 为什么自己造浮层：我们是指针事件自己编排拖拽（Windows 上 WebView2 的原生拖放
 * 钩子会禁用页面内 HTML5 DnD，见 ARCHITECTURE §4），拿不到浏览器的拖拽影像。
 */
function createDragGhost(srcEl: HTMLElement): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = "tab-drag-ghost";
  ghost.setAttribute("aria-hidden", "true");
  const copy = srcEl.cloneNode(true) as HTMLElement;
  // 副本不得带 tabId：多处逻辑「按 tabId 查元素」，留着会让查询命中副本而非真标签。
  copy.removeAttribute("data-tab-id");
  // 副本不是真标签：剥掉提示接线。眼下靠外层 pointer-events:none 已经收不到
  // 悬停，但那是「隐式」保护 —— 哪天提示改成 elementFromPoint 就会静默复活。
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
 * ⚠️ 为什么不再克隆整条标签栏（B71 的做法）：克隆出来的是一条真标签带子，
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
function createGroupDragGhost(strip: HTMLElement): HTMLElement {
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

/** 影像左上角跟到光标处（锚点语义见 `GHOST_ANCHOR_*`）。 */
/**
 * 影像跟随光标。
 *
 * `clampToWindow`（B89）：指针拖到窗口外之后，影像若照着坐标走就整个跑到客户区外
 * —— 用户手上「拖着的东西」凭空消失，只剩目标窗口那块预览。贴住边缘、至少露出一条
 * 边，才知道这一拖还在进行中。（原生 DnD 的 drag image 由 OS 画、跨窗口都能看见，
 * 我们是指针事件自己编排的，只能靠这个近似。）
 *
 * ⚠️ 只在上一步判定出界时才夹：窗口内的拖拽必须**精确**跟随，否则贴着面板右侧拖动
 * 时影像会被拉回来一截，落点看着就不准了。
 */
function moveDragGhost(x: number, y: number, clampToWindow = false): void {
  if (!dragGhost) return;
  let left = x - dragGhostAnchor.x;
  let top = y - dragGhostAnchor.y;
  if (clampToWindow) {
    // 露出固定一小条即可：按影像实际尺寸算会让「露出多少」随文件名长短变化
    const keepX = Math.min(dragGhost.offsetWidth || 0, 48);
    const keepY = Math.min(dragGhost.offsetHeight || 0, 24);
    left = Math.min(Math.max(left, 0), Math.max(window.innerWidth - keepX, 0));
    top = Math.min(Math.max(top, 0), Math.max(window.innerHeight - keepY, 0));
  }
  dragGhost.style.left = `${left}px`;
  dragGhost.style.top = `${top}px`;
}

function removeDragGhost(): void {
  dragGhost?.remove();
  dragGhost = null;
  dragGhostAnchor = GHOST_ANCHOR_TAB;
}

/** click 处理器调用：刚完成一次真实拖拽时吞掉紧随的 click（避免拖完又激活标签）。 */
export function consumeTabClickSuppressed(): boolean {
  const v = suppressTabClick;
  suppressTabClick = false;
  return v;
}

/**
 * 指针是否已经拖出窗口客户区（留 `DRAG_OUT_MARGIN` 余量，防擦边误触）。
 *
 * 用客户区尺寸而不是 `screenX/screenY` 比较：后者在多显示器下是相对**当前显示器**
 * 的坐标，主窗口与卫星窗口算出来的口径不一致，判据会时灵时不灵。
 */
export function outsideWindow(x: number, y: number): boolean {
  return (
    x < -DRAG_OUT_MARGIN ||
    y < -DRAG_OUT_MARGIN ||
    x > window.innerWidth + DRAG_OUT_MARGIN ||
    y > window.innerHeight + DRAG_OUT_MARGIN
  );
}

/** 指针位置命中的面板（手动几何判定，jsdom 无布局也可测）。 */
export function panelAt(x: number, y: number): HTMLElement | null {
  // 手动命中测试而非 elementFromPoint：逻辑确定且可在 jsdom（无布局）下测试
  for (const el of document.querySelectorAll<HTMLElement>(".layout-panel")) {
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el;
  }
  return null;
}

function clearAllPreviews(): void {
  document.querySelectorAll(".split-preview.show").forEach((el) => {
    el.className = "split-preview";
  });
}

/** 清掉所有面板的分屏落点预览（标签拖拽与文件拖入共用）。 */
export function clearAllDropPreviews(): void {
  clearAllPreviews();
}

/** 面板级 tab 区（strip）元素。 */
function stripOf(panelEl: HTMLElement): HTMLElement | null {
  return panelEl.querySelector(".panel-tabstrip");
}

/** 指针是否在某面板的 tab 区内；是则返回该 strip。 */
function stripUnder(panelEl: HTMLElement, x: number, y: number): HTMLElement | null {
  const strip = stripOf(panelEl);
  if (!strip) return null;
  const r = strip.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom ? strip : null;
}

export interface StripInsertInfo {
  /** 插到该标签之前；null = 追加到末尾 */
  beforeTabId: number | null;
  /** 指示线相对 strip 左缘的偏移 */
  offsetLeft: number;
}

/** 纯几何（jsdom 可测）：strip 内指针位置 → 插入位置与指示线偏移。 */
export function stripInsertInfo(strip: HTMLElement, x: number): StripInsertInfo | null {
  const r = strip.getBoundingClientRect();
  if (x < r.left || x > r.right) return null;
  // .tab-insert 是 strip 的绝对定位子元素，left 走**内容坐标**，会随内容一起滚；
  // 而 getBoundingClientRect 的差值是**视口坐标**。标签栏横向滚动后两者相差一个
  // strip.scrollLeft（B53 起标签栏可滚动），必须补上 —— 否则滚动过的标签栏上
  // 插入指示线会画在错误的标签之间。
  const scroll = strip.scrollLeft;
  const tabs = Array.from(strip.querySelectorAll<HTMLElement>(".tab"));
  for (const tab of tabs) {
    const tr = tab.getBoundingClientRect();
    if (x < tr.left + tr.width / 2) {
      return { beforeTabId: Number(tab.dataset.tabId), offsetLeft: tr.left - r.left + scroll };
    }
  }
  const last = tabs[tabs.length - 1]?.getBoundingClientRect();
  return { beforeTabId: null, offsetLeft: (last ? last.right - r.left : r.width) + scroll };
}

function showInsertIndicator(strip: HTMLElement, offsetLeft: number): void {
  let el = strip.querySelector<HTMLElement>(".tab-insert");
  if (!el) {
    el = document.createElement("div");
    el.className = "tab-insert";
    strip.appendChild(el);
  }
  el.style.left = `${offsetLeft}px`;
}

function clearInsertIndicators(): void {
  document.querySelectorAll(".tab-insert").forEach((el) => el.remove());
}

/** 清掉一切落点痕迹：分屏预览 + 标签插入指示线（本窗口拖拽收尾与跨窗口清场共用）。 */
export function clearDropIndicators(): void {
  clearAllPreviews();
  clearInsertIndicators();
}

/** 一次落点判定的结果：面板 + 分屏方位 + （落在标签区时）插到谁之前。 */
export interface DropSpot {
  panelId: number;
  zone: DropZone;
  /** 仅 `panel-tabstrip` 上有效：插到该标签之前；null = 追加到末尾 */
  beforeTabId: number | null;
}

/**
 * 在 (x, y) 画落点预览，并把算出来的落点交回调用方。
 *
 * 两个调用方，同一套判定（不各写一份，免得窗口内和跨窗口的落点语义走偏）：
 *   · 本窗口拖拽的 mousemove（`onTabDragMove`）；
 *   · **别的窗口**拖着标签悬停到本窗口时（`windowdrag` 的接收侧，B89）。
 *
 * 每次都先全清再画：拖拽途中「上一个面板的预览」必须消失，否则会同时亮两块。
 */
export function previewDropAt(x: number, y: number, altKey = false): DropSpot | null {
  clearAllPreviews();
  clearInsertIndicators();
  const panelEl = panelAt(x, y);
  if (!panelEl) return null;
  const panelId = Number(panelEl.dataset.panelId);
  // B27：tab 区 = 调整顺序（插入指示线），面板区 = 分屏预览，两者互斥
  const strip = stripUnder(panelEl, x, y);
  if (strip) {
    const info = stripInsertInfo(strip, x);
    if (info) showInsertIndicator(strip, info.offsetLeft);
    return { panelId, zone: "center", beforeTabId: info?.beforeTabId ?? null };
  }
  const zone = zoneOf(panelEl.getBoundingClientRect(), x, y);
  // O5：按住 Alt = 临时取消分屏（本次落点按 center 处理）。预览同步切换成 center，
  // 拖拽时就能看到「这次不会分屏」。（对标 editorDropTarget.ts:382-384 的 Alt 反转开关）
  const effZone = altKey ? "center" : zone;
  const preview = panelEl.querySelector(".split-preview");
  if (preview) preview.className = `split-preview show zone-${effZone}`;
  return { panelId, zone: effZone, beforeTabId: null };
}

function onTabDragMove(e: MouseEvent): void {
  if (!tabDrag) return;
  if (!tabDrag.active) {
    if (Math.hypot(e.clientX - tabDrag.startX, e.clientY - tabDrag.startY) < DRAG_THRESHOLD) {
      return;
    }
    tabDrag.active = true;
    // 拖拽光标 + 禁止文本选区（指针拖拽没有原生 DnD 的光标/选区豁免）
    document.body.classList.add("tab-drag-active");
    // 越过阈值才算真的在拖 → 这时才亮出影像（纯点击不该闪出一个副本）
    if (tabDrag.tabEl) {
      // B71：整组拖拽时 tabEl 是**整个标签栏**（VS Code 的 group drag image 也是
      // 从 group 取的），B72 起整组改用药丸影像（见 createGroupDragGhost）。
      const group = tabDrag.groupPanelId !== null;
      dragGhost = group ? createGroupDragGhost(tabDrag.tabEl) : createDragGhost(tabDrag.tabEl);
      dragGhostAnchor = group ? GHOST_ANCHOR_PILL : GHOST_ANCHOR_TAB;
      document.body.appendChild(dragGhost);
    }
  }
  // 影像跟随光标。⚠️ 必须放在下面「离开面板就 return」**之前** —— 拖到面板之外
  // （空白区、状态栏上方、乃至窗口之外）时影像同样要跟着走，否则会僵在最后一个面板上。
  const outside = outsideWindow(e.clientX, e.clientY);
  moveDragGhost(e.clientX, e.clientY, outside);
  // B89：出界**不再**立刻把标签送走 —— 那正是用户报的毛病（指针擦过另一个窗口的
  // 某块面板就被合入，根本没法挑落点）。这里只记状态 + 通知宿主广播指针位置，
  // 让**目标窗口**自己亮预览；真正的搬运一律等松手（`onDropOutOfWindow`）。
  if (outside) {
    if (!tabDrag.outOfWindow) {
      // 刚出界：本窗口的预览/插入线必须收掉，否则会和目标窗口的预览同时亮着，
      // 看起来像「两个地方都要接住它」。
      clearAllPreviews();
      clearInsertIndicators();
    }
    tabDrag.outOfWindow = true;
    svCallbacks?.onDragOutside?.({
      tabId: tabDrag.tabId,
      groupPanelId: tabDrag.groupPanelId,
      clientX: e.clientX,
      clientY: e.clientY,
    });
    return;
  }
  tabDrag.outOfWindow = false;
  // 落点判定与预览只有一份实现（跨窗口悬停时由 windowdrag 的接收侧复用同一函数）
  previewDropAt(e.clientX, e.clientY, e.altKey);
}

function onTabDragEnd(e: MouseEvent): void {
  const drag = tabDrag;
  finishTabDrag();
  if (!drag || !drag.active) return; // 未超阈值：无拖拽发生，click 正常触发激活
  if (!svCallbacks) return;
  suppressTabClick = true;
  // B89：松手时指针在窗外 → 交给宿主。它可能把标签交给另一个窗口（那边算落点），
  // 也可能没人接手而回落成「开新窗口 / 交回主窗口」。拖拽层不关心是哪一种。
  if (drag.outOfWindow) {
    svCallbacks.onDropOutOfWindow?.({
      tabId: drag.tabId,
      groupPanelId: drag.groupPanelId,
      clientX: e.clientX,
      clientY: e.clientY,
    });
    return;
  }
  const panelEl = panelAt(e.clientX, e.clientY);
  if (!panelEl) return;
  const panelId = Number(panelEl.dataset.panelId);

  // B71：拖整组（从标签栏空白处起手）。落点只有两种语义：
  //   落在别的面板的标签区 / 中心 → 整组并入；落在边缘 → 整组搬到新分屏位置。
  // 拖回自己所在面板 = 无操作（VS Code 也是这样，不做「原地重排」）。
  if (drag.groupPanelId !== null) {
    if (drag.groupPanelId === panelId) return;
    const overStrip = stripUnder(panelEl, e.clientX, e.clientY);
    const zone = zoneOf(panelEl.getBoundingClientRect(), e.clientX, e.clientY);
    // O5：Alt = 临时取消分屏 → 边缘落点按 center（= 并入）处理
    const eff = e.altKey ? "center" : zone;
    if (overStrip || eff === "center") {
      svCallbacks?.onMergeGroup?.(drag.groupPanelId, panelId);
      return;
    }
    svCallbacks?.onMoveGroupToPanel?.(
      drag.groupPanelId,
      panelId,
      eff === "left" || eff === "right" ? "h" : "v",
      eff === "left" || eff === "top",
    );
    return;
  }

  // B27：落在 tab 区 = 排序/移动（绝不分屏）
  const strip = stripUnder(panelEl, e.clientX, e.clientY);
  if (strip) {
    const info = stripInsertInfo(strip, e.clientX);
    if (info) svCallbacks?.onMoveTabToStrip(panelId, drag.tabId, info.beforeTabId);
    return;
  }
  const zone = zoneOf(panelEl.getBoundingClientRect(), e.clientX, e.clientY);
  const over = tabUnder(panelEl, e.clientX, e.clientY);
  // O5：Alt 按住 = 取消分屏 → 边缘落点按 center 处理（同面板即 no-op，跨面板即移入）。
  svCallbacks?.onDropTabToPanel?.(drag.tabId, panelId, e.altKey ? "center" : zone, over, e.ctrlKey);
}

function finishTabDrag(): void {
  tabDrag = null;
  document.body.classList.remove("tab-drag-active");
  document.removeEventListener("mousemove", onTabDragMove);
  document.removeEventListener("mouseup", onTabDragEnd);
  window.removeEventListener("blur", finishTabDrag);
  removeDragGhost();
  clearAllPreviews();
  clearInsertIndicators();
}

/** build 的产物：元素 + （仅 split 节点）其根分隔条、a/b 子元素与**已注册的缩放目标**，
 *  后者供角手柄复用（角手柄要按 target 身份去注册表里找联动伙伴，不能另造一个对象）。 */
interface BuiltNode {
  el: HTMLElement;
  split: {
    sep: HTMLElement;
    dir: "h" | "v";
    aEl: HTMLElement;
    bEl: HTMLElement;
    target: ResizeTarget;
  } | null;
}

/** 同轴链的上下文：父节点是不是同方向、以及它所属链的编号。 */
interface ChainCtx {
  dir: "h" | "v";
  chainId: number;
}

/** 同轴链编号自增源；每次 renderSplitview 归零。 */
let chainSeq = 0;

/**
 * 沿轴向的「段数」：把子树里所有与 `d` 同向的嵌套都展开，数出最后并排多少个面板。
 * 不同向的子树整体算作 1 段（它再切也只是在自己那段里切）。
 * 用于「按分割数量均分」：节点两侧的均分比例 = segA / (segA + segB)。
 */
function segmentsAlong(node: LayoutNode, d: "h" | "v"): number {
  if (node.kind === "leaf") return 1;
  if (node.dir !== d) return 1;
  return segmentsAlong(node.a, d) + segmentsAlong(node.b, d);
}

function build(
  node: LayoutNode,
  path: number[],
  cb: SplitviewCallbacks,
  panelData: Map<number, PanelRenderData>,
  parent: ChainCtx | null = null,
): BuiltNode {
  if (node.kind === "leaf") {
    return { el: buildPanel(node.panelId, path, cb, panelData), split: null };
  }

  // 同轴链：与父节点同向 → 沿用父的链号（一条链 = 一根竖/横边界上所有相连的分隔条）；
  // 不同向则另起一条链。双击均分时按链整条一起调整。
  const chainId = parent && parent.dir === node.dir ? parent.chainId : ++chainSeq;
  const ctx: ChainCtx = { dir: node.dir, chainId };

  const container = document.createElement("div");
  container.className = "layout-split layout-" + (node.dir === "h" ? "h" : "v");

  const A = build(node.a, [...path, 0], cb, panelData, ctx);
  const B = build(node.b, [...path, 1], cb, panelData, ctx);
  const sep = document.createElement("div");
  sep.className = "layout-sep layout-sep-" + (node.dir === "h" ? "h" : "v");

  // 按 ratio 分配：a 占 ratio，b 占剩余
  A.el.style.flexBasis = `${node.ratio * 100}%`;
  B.el.style.flexBasis = `${(1 - node.ratio) * 100}%`;

  const self: ResizeTarget = {
    container,
    dir: node.dir,
    aEl: A.el,
    bEl: B.el,
    commit: (ratio) => cb.onRatioChange(path, ratio),
  };
  const segA = segmentsAlong(node.a, node.dir);
  const segB = segmentsAlong(node.b, node.dir);
  attachResize(sep, [self], node.dir);
  // B60：登记真实分隔条（角手柄不是独立分隔条，不登记），供「对齐联动」查找。
  // B63：同时记录同轴链号与「均分比例」，双击时按链整条一起调整。
  sashRegistry.push({
    handle: sep,
    dir: node.dir,
    target: self,
    chainId,
    equalRatio: segA / (segA + segB),
  });

  // O7 角手柄：子树的根分隔条若与本分隔条**垂直**，则两者在那一端相接成 T/十字
  // （如「左 | 右上下分屏」，右侧上下两条水平线的一端贴在中间竖线上）。
  // 在相接端装一个 8px 手柄，斜向拖动可**同时**改两条 —— 对标 VS Code sash 的
  // orthogonal-drag-handle（sash.css:64-103 / sash.ts:357-417）。
  const kids: Array<{ built: BuiltNode; side: "a" | "b" }> = [
    { built: A, side: "a" },
    { built: B, side: "b" },
  ];
  for (const { built, side } of kids) {
    const child = built.split;
    if (!child || child.dir === node.dir) continue;
    // 相接端：位于 b 侧（右/下）的子树，其分隔条的**首端**贴父；
    // 位于 a 侧（左/上）的子树，其分隔条的**末端**贴父。
    const atStart = side === "b";
    const cHandle = document.createElement("div");
    // 双类写法与 VS Code 的 `.orthogonal-drag-handle.start/.end` 一致
    cHandle.className = `layout-corner ${atStart ? "start" : "end"}`;
    child.sep.appendChild(cHandle);
    // ⚠️ 必须复用子分隔条**已注册的那个 target 对象**（不要另造）：注册表按 target 身份
    // 查联动伙伴，另造对象会让 `sashOfTarget` 找不到它，交叉点拖动时子轴一侧的联动失效。
    attachResize(cHandle, [self, child.target], "corner");
  }

  container.append(A.el, sep, B.el);
  return {
    el: container,
    split: { sep, dir: node.dir, aEl: A.el, bEl: B.el, target: self },
  };
}

function buildPanel(
  panelId: number,
  path: number[],
  cb: SplitviewCallbacks,
  panelData: Map<number, PanelRenderData>,
): HTMLElement {
  const data = panelData.get(panelId) ?? ({ panelId, active: false, tabs: [] } as PanelRenderData);

  const panel = document.createElement("div");
  panel.className =
    "layout-panel" +
    (data.active ? " layout-panel-active" : "") +
    (data.collapsed ? " layout-panel-collapsed" : "");
  panel.dataset.panelId = String(panelId);
  panel.dataset.path = path.join(",");

  // 面板头部：标签栏 + 面板操作
  const head = document.createElement("div");
  head.className = "panel-head";

  const strip = document.createElement("div");
  strip.className = "panel-tabstrip";
  renderTabstrip(strip, data.tabs, {
    onActivate: (tabId) => cb.onActivateTab(panelId, tabId),
    onClose: (tabId) => cb.onCloseTab(tabId),
    onCloseOther: (tabId) => cb.onCloseOtherTab?.(panelId, tabId),
    onCloseRight: (tabId) => cb.onCloseRightTabs?.(panelId, tabId),
    onCopyPath: (tabId) => cb.onCopyTabPath?.(tabId),
    onDuplicateTab: (tabId) => cb.onDuplicateTab?.(tabId),
    onDuplicateToSibling: (tabId) => cb.onDuplicateToSibling?.(tabId),
    // B71：右键「左右/上下分屏」。panelId 由闭包带上（tabstrip 只认 tabId）
    onSplitH: (tabId) => cb.onSplitTab?.(panelId, tabId, "h"),
    onSplitV: (tabId) => cb.onSplitTab?.(panelId, tabId, "v"),
    // B71：双击标签 = 最大化/还原本面板（对标 VS Code 的
    // doubleClickTabToToggleEditorGroupSizes = 'maximize'；LitePad 无「固定标签」，
    // 双击标签本来没有其它用途）。仅多面板时 main 才会传这个回调。
    onToggleMaximize: () => cb.onToggleMaximizePanel?.(panelId),
    onOpenInNewWindow: cb.onOpenTabInNewWindow
      ? (tabId) => cb.onOpenTabInNewWindow?.(tabId)
      : undefined,
    onReturnToMain: cb.onReturnTabToMain ? (tabId) => cb.onReturnTabToMain?.(tabId) : undefined,
    onReorder: (from, to) => cb.onReorderTab?.(panelId, from, to),
    onNew: () => cb.onNewTab?.(panelId),
  });

  // 面板操作栏：仅保留「移除该分屏」⨯。
  // B54 起去掉左右/上下分屏按钮——分屏改为把标签拖到面板边缘完成（zoneOf +
  // 拖拽落点），按钮重复且占位。⨯ 仅移除该分屏（标签并入相邻面板），不关文档，
  // 唯一面板时禁用。
  // B71：**拖标签栏空白处 = 拖整组**（VS Code `onGroupDragStart` 要求
  // `e.target === tabsContainer`，也就是只能从标签之间的空隙起手）。
  // 起手点判据必须是「事件目标就是容器本身」——命中任何 .tab 都归单标签拖拽。
  strip.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target !== strip) return;
    beginTabDrag(-1, e, strip, panelId);
  });

  const ops = document.createElement("div");
  ops.className = "panel-ops";
  const mkOp = (
    icon: string,
    text: string,
    detail: string | undefined,
    onClick: () => void,
  ): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = "panel-op";
    b.innerHTML = icon;
    // B58：提示走自绘层。图标按钮没有文本，aria-label 必须显式给。
    setTip(b, text, { detail });
    b.setAttribute("aria-label", detail ? `${text}（${detail}）` : text);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  };

  const closeP = mkOp(
    CODICONS.close,
    "移除该分屏",
    data.canClose === false ? undefined : "标签并入相邻面板",
    () => cb.onClosePanel(panelId),
  );
  closeP.disabled = data.canClose === false;
  if (data.canClose === false) {
    setTip(closeP, "唯一面板不可移除", { detail: "退出请用窗口关闭或菜单「退出」" });
    closeP.setAttribute("aria-label", "唯一面板不可移除（退出请用窗口关闭或菜单「退出」）");
  }

  // B71：最大化中的面板才多一个「还原」按钮 —— 未最大化时不占位（B54 的精简原则），
  // 但最大化后必须有一个**看得见**的退路：另一侧被挤成 0，只靠快捷键容易让人以为丢了。
  if (data.maximized) {
    ops.append(
      mkOp(CODICONS.chromeRestore, "还原面板", "恢复最大化前的分屏比例", () =>
        cb.onToggleMaximizePanel?.(panelId),
      ),
    );
  }
  ops.append(closeP);

  head.append(strip, ops);

  const host = document.createElement("div");
  host.className = "panel-host";
  cb.mountView(panelId, host);

  // 分屏拖拽：悬停预览落点、松手执行（同面板内为排序，跨面板为分屏/移入）
  const preview = document.createElement("div");
  preview.className = "split-preview";
  if (panel) panel.append(preview);

  panel.addEventListener("mousedown", () => cb.onActivatePanel(panelId));
  // 注意：外部文件拖入走 WebView2 原生拖放（tauri.conf.json dragDropEnabled: true
  // + main.ts 的 onDragDropEvent），页面内不再处理 drop——标签拖拽已改为指针事件。

  panel.append(head, host);
  return panel;
}

export type DropZone = "left" | "right" | "top" | "bottom" | "center";

/**
 * 指针在面板内的分区。
 * - 两轴都落在内侧（边缘 28% 带以内）= `center`（移入/排序，不分屏）。
 * - 落在边缘带时用 VS Code 的「1/3 方向优先」定方向：左右各占外侧 1/3 优先左右分屏，
 *   中 1/3 才按上/下半区给上/下 —— 角部归属因此可预期
 *   （对标 `workbench/.../editorDropTarget.ts:424-479` 的 splitWidthThreshold = 宽/3）。
 * - jsdom 无布局（宽高为 0）时回 `center`，避免 NaN 判定落到意外分支。
 */
export function zoneOf(rect: DOMRect, x: number, y: number): DropZone {
  if (!(rect.width > 0) || !(rect.height > 0)) return "center";
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  const EDGE = 0.28;
  if (rx >= EDGE && rx <= 1 - EDGE && ry >= EDGE && ry <= 1 - EDGE) return "center";
  if (rx < 1 / 3) return "left";
  if (rx > 2 / 3) return "right";
  return ry < 0.5 ? "top" : "bottom";
}

function tabUnder(panel: HTMLElement, x: number, y: number): number | null {
  const strip = panel.querySelector(".panel-tabstrip");
  if (!strip) return null;
  for (const el of strip.querySelectorAll<HTMLElement>(".tab")) {
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      return Number(el.dataset.tabId);
    }
  }
  return null;
}

// ---------------------------------------------------------------- 分隔条缩放
// 一个「可缩放目标」= 一对兄弟元素 + 它们所在的容器 + 比例回写路径。
// 普通分隔条只有 1 个目标；角手柄（O7）有 2 个（父分隔条 + 子分隔条，轴互相垂直），
// 斜向拖动时两个目标各按自己的轴换算比例，实现「一脚拖两条」。

/**
 * 本次布局的全部**真实分隔条**（角手柄不计），用于「对齐联动」与「双击均分」。
 * 每次 renderSplitview 前清空。
 */
let sashRegistry: BuiltSash[] = [];

interface BuiltSash {
  handle: HTMLElement;
  dir: "h" | "v";
  target: ResizeTarget;
  /** 同轴链编号：同一条边界上相连的分隔条共用一个号（B63 双击均分按链整条调整） */
  chainId: number;
  /** 均分比例（0–1）：让该节点两侧的**同轴段数**相等，即「按分割数量均分」 */
  equalRatio: number;
}

/** 对齐容差（px）：两条同向分隔条位置相差不超过它就视为「位置一致」。 */
const ALIGN_TOL = 2;

/**
 * 分隔条在**自己轴上的位置**（须比较的坐标）；没有布局时返回 null。
 *
 * ⚠️ 判空必须看**交叉轴**，不能看主轴：B60 起分隔条是 `flex: 0 0 0` 的浮层，
 * **主轴尺寸恒为 0** —— 早先按主轴判空（`len > 0`）会导致恒返回 null，
 * `alignedSashesOf` 永远拿到空数组，联动在真机上从未生效过一次。
 * 交叉轴是 stretch 出来的满长（竖线有高度、横线有宽度），它 > 0 才说明浏览器真的摆了盘。
 * 主轴为 0 恰好意味着 `left` / `top` **就是**界线本身，直接取用即可。
 */
function centerOf(entry: BuiltSash): number | null {
  const r = entry.handle.getBoundingClientRect();
  const cross = entry.dir === "h" ? r.height : r.width;
  if (!(cross > 0)) return null;
  return entry.dir === "h" ? r.left + r.width / 2 : r.top + r.height / 2;
}

/** 按 target 身份在注册表里找到这条分隔条（交叉点拖动时两端都要能查到）。 */
function sashOfTarget(t: ResizeTarget): BuiltSash | undefined {
  return sashRegistry.find((s) => s.target === t);
}

/**
 * 与给定分隔条**同向且位置一致**的其他分隔条。
 * 对标 VS Code 2x2 网格的 linkedSash（`gridview.ts:715` 的 trySet2x2 + `sash.ts:342`）：
 * 两条竖线（或两条横线）落在同一位置时联动，拖一条两条一起走。
 */
function alignedSashesOf(self: BuiltSash): BuiltSash[] {
  const c = centerOf(self);
  if (c === null) return [];
  return sashRegistry.filter((s) => {
    if (s === self || s.dir !== self.dir) return false;
    const other = centerOf(s);
    return other !== null && Math.abs(other - c) <= ALIGN_TOL;
  });
}

/**
 * 本次拖拽会**一起动**的全部分隔条：每个拖拽目标自身 + 与它同向对齐的伙伴。
 *
 * 普通分隔条只有 1 个目标；**交叉点（角手柄）有 2 个目标、轴互相垂直**，
 * 于是两个轴向各自的联动伙伴都会被带进来（B63 用户要求「交叉点拖动也要联动」）。
 * 这也正是判定「拖一条两条一起走」的统一入口。
 */
function movingGroupOf(targets: ResizeTarget[]): BuiltSash[] {
  const out: BuiltSash[] = [];
  for (const t of targets) {
    const self = sashOfTarget(t);
    if (!self) continue;
    if (!out.includes(self)) out.push(self);
    for (const l of alignedSashesOf(self)) {
      if (!out.includes(l)) out.push(l);
    }
  }
  return out;
}

/** 比例上下限（百分比）。与 CSS 的 min-width/min-height 一起构成缩放下限。 */
const MIN_PCT = 10;
const MAX_PCT = 90;

interface ResizeTarget {
  /** 被分割的容器：把指针坐标换算成比例 */
  container: HTMLElement;
  dir: "h" | "v";
  aEl: HTMLElement;
  bEl: HTMLElement;
  /** 拖拽结束把比例（0.1–0.9）回写布局树 */
  commit: (ratio: number) => void;
}

/** 指针位置 → 该目标的比例（百分比）。jsdom 无布局（长度 0）时回中，避免 NaN 写坏树。 */
function pctFor(t: ResizeTarget, x: number, y: number): number {
  const r = t.container.getBoundingClientRect();
  const len = t.dir === "h" ? r.width : r.height;
  if (!(len > 0)) return (MIN_PCT + MAX_PCT) / 2;
  const raw = (t.dir === "h" ? x - r.left : y - r.top) / len;
  return Math.min(MAX_PCT, Math.max(MIN_PCT, raw * 100));
}

function applyTarget(t: ResizeTarget, pct: number): void {
  t.aEl.style.flexBasis = `${pct}%`;
  t.bEl.style.flexBasis = `${100 - pct}%`;
}

/** 拖拽模式：h/v 决定 `body.layout-dragging` 叠加的光标修饰类；corner = 斜向。 */
type ResizeMode = "h" | "v" | "corner";

/**
 * 给分隔条（或角手柄）装上「拖拽改比例」。
 * - **双击均分**（O1，B63 起）：把该分隔条所在的**同轴链**整条调成等分（见 `equalRatio`），
 *   而不是一律回到 50% —— 对标 VS Code sash 的 onDidReset，但按分割数量分配。
 * - **极限提示**（O2）：拖到 10%/90% 时给手柄加 `.at-min`/`.at-max`，光标变形。
 * - **方向光标**（O3）：垂直分隔条拖拽时 `body` 加 `layout-dragging-v` → `ns-resize`；
 *   其余（水平分隔条 / 大纲 / 查找栏）保持默认 `ew-resize`。
 *   B61：取值改为 VS Code 的**非 mac** 档（`sash.css:52/59` 的 `ew-resize`/`ns-resize`），
 *   原先的 `col-resize`/`row-resize` 是 mac 档，Windows 上观感不同。
 * - **指针捕获**（O4）：真实浏览器里把后续事件锁定到本元素，鼠标移出窗口也不丢事件；
 *   jsdom 无 setPointerCapture 时静默跳过。
 *
 * ⚠️ 所有「哪些线一起动」的判断都走 `movingGroupOf(targets)` 一个入口：普通分隔条
 * 1 个目标，角手柄 2 个（双轴）。悬停高亮、按下高亮、拖动、回写四处必须一致，
 * 否则会出现「高亮了一组、实际只动了一条」的错位。
 */
function attachResize(handle: HTMLElement, targets: ResizeTarget[], mode: ResizeMode): void {
  const body = document.body;
  const BODY_CLASSES = ["layout-dragging", "layout-dragging-v", "layout-dragging-corner"];

  // B60：悬停也联动高亮 —— 对标 sash.ts:629-648 的 onMouseEnter/onMouseLeave 转发给
  // linkedSash。还没按下就能看到「这些是一组、会一起动」，联动才可发现。
  // B63：改走 `movingGroupOf` —— 交叉点有 2 个目标（双轴），悬停时两条轴各自的联动组
  // 都要亮，用户才能预判「斜拖这一下会带动谁」。
  handle.addEventListener("mouseenter", () => {
    for (const s of movingGroupOf(targets)) s.handle.classList.add("linked");
  });
  handle.addEventListener("mouseleave", () => {
    for (const s of sashRegistry) s.handle.classList.remove("linked");
  });

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    // 分隔条落在面板之上；不 stopPropagation 会让面板的 mousedown 抢焦点。
    e.stopPropagation();
    // B60/B63：按下时求一次「整组」——每个目标自身 + 同向对齐的伙伴。普通分隔条是
    // 「本条 + 它的联动条」，交叉点是「父线 + 子线 + 两条轴各自的联动条」。
    const group = movingGroupOf(targets);
    const links = group.filter((s) => !targets.includes(s.target));
    for (const s of group) s.handle.classList.add("resizing");

    body.classList.add("layout-dragging");
    if (mode === "v") body.classList.add("layout-dragging-v");
    if (mode === "corner") body.classList.add("layout-dragging-corner");

    const pid = (e as MouseEvent & { pointerId?: number }).pointerId;
    if (typeof pid === "number" && typeof handle.setPointerCapture === "function") {
      try {
        handle.setPointerCapture(pid);
      } catch {
        /* 浏览器/环境不支持时忽略 */
      }
    }

    // B62：纯点击（按下→抬起，全程没有 mousemove）不得回写比例。
    // 命中区有 7px 宽，指针落点可能离界线好几个像素 —— 会把比例「啪」地推走一点，
    // 而对齐联动是按 2px 容差判定的：**一次点击就能把两条对齐的线推到容差之外**，
    // 之后拖谁都不再联动（表现为「单击一下，联动就没了」）。
    // VS Code 的 sash 同样是「没有 move 事件就不改尺寸」。
    let moved = false;

    const onMove = (ev: MouseEvent): void => {
      moved = true;
      for (const t of targets) applyTarget(t, pctFor(t, ev.clientX, ev.clientY));
      // 联动：同向对齐的分隔条各自按**自己的容器**把指针换算成比例。对齐的两条容器
      // 在拖拽轴上的起止一致，所以换算结果相同 —— 两条始终停在同一个位置。
      for (const l of links) applyTarget(l.target, pctFor(l.target, ev.clientX, ev.clientY));
      // 极限提示：每个目标按**自己的容器**换算（交叉点两个目标的轴不同）
      for (const t of targets) {
        const pct = pctFor(t, ev.clientX, ev.clientY);
        const el = targetElOf(t);
        el.classList.toggle("at-min", pct <= MIN_PCT + 1e-6);
        el.classList.toggle("at-max", pct >= MAX_PCT - 1e-6);
      }
    };
    const onUp = (ev: MouseEvent): void => {
      body.classList.remove(...BODY_CLASSES);
      for (const s of group) s.handle.classList.remove("resizing");
      for (const t of targets) targetElOf(t).classList.remove("at-min", "at-max");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (!moved) return; // 纯点击：比例保持原样
      for (const t of targets) t.commit(pctFor(t, ev.clientX, ev.clientY) / 100);
      for (const l of links) l.target.commit(pctFor(l.target, ev.clientX, ev.clientY) / 100);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // O1：双击复位。只回写比例与内联样式，不重建 DOM（重建会引发整树重绘/闪烁）。
  // B60：联动的一并复位（对标 sash.ts:622 —— `_onDidReset` 会转发给 linkedSash），
  // 否则复位一条就把「位置一致」打破，联动关系当场消失。
  //
  // ⚠️⚠️ **联动集合必须在改任何比例之前求出来**（B62 用户反馈：「双击任意一条，
  // 所有的都应该居中」）。`alignedSashesOf` 读的是 `getBoundingClientRect` 的**实时几何**：
  // 一旦先 `applyTarget(self, 50)` 把本条挪到中间，它和还没动的联动条之间就差了
  // 十几个百分点 —— 远超 `ALIGN_TOL`，求出来的集合是空的，表现为「只有点中的那条居中」。
  //
  // B63：不再是「一律 50%」，而是**按分割数量均分**：沿该分隔条的同轴链把每一段都
  // 调成等分（2 段 = 50%，3 段 = 1/3 与 1/2 …，见 `segmentsAlong` / `equalRatio`）。
  // 「对应的所有分割线一起调整」= 该链上的每条分隔条 + 它们各自的联动伙伴。
  handle.addEventListener("dblclick", () => {
    const chains = new Set(movingGroupOf(targets).map((s) => s.chainId));
    for (const s of sashRegistry) {
      if (!chains.has(s.chainId)) continue;
      applyTarget(s.target, s.equalRatio * 100);
      s.target.commit(s.equalRatio);
    }
  });
}

/** 分隔条元素（`.at-min`/`.at-max` 只能落在分隔条本体上，角手柄上没有样式）。 */
function targetElOf(t: ResizeTarget): HTMLElement {
  return sashOfTarget(t)?.handle ?? (t.aEl.parentElement as HTMLElement);
}

import type { LayoutNode } from "./layout";
import { ICONS } from "./icons";
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

/** 移动超过该距离才进入拖拽（否则保持点击激活语义）。 */
const DRAG_THRESHOLD = 5;

interface TabDragState {
  tabId: number;
  startX: number;
  startY: number;
  active: boolean;
  panelEl: HTMLElement | null;
}
let tabDrag: TabDragState | null = null;
let suppressTabClick = false;

/** tabstrip 的 mousedown 调用：开始观察一次潜在的标签拖拽。 */
export function beginTabDrag(tabId: number, e: MouseEvent): void {
  if (tabDrag) finishTabDrag(); // 上一次拖拽未正常收尾（如释放到窗外）→ 先强制清场
  suppressTabClick = false;
  tabDrag = { tabId, startX: e.clientX, startY: e.clientY, active: false, panelEl: null };
  document.addEventListener("mousemove", onTabDragMove);
  document.addEventListener("mouseup", onTabDragEnd);
}

/** click 处理器调用：刚完成一次真实拖拽时吞掉紧随的 click（避免拖完又激活标签）。 */
export function consumeTabClickSuppressed(): boolean {
  const v = suppressTabClick;
  suppressTabClick = false;
  return v;
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

function onTabDragMove(e: MouseEvent): void {
  if (!tabDrag) return;
  if (!tabDrag.active) {
    if (Math.hypot(e.clientX - tabDrag.startX, e.clientY - tabDrag.startY) < DRAG_THRESHOLD) {
      return;
    }
    tabDrag.active = true;
    // 拖拽光标 + 禁止文本选区（指针拖拽没有原生 DnD 的光标/选区豁免）
    document.body.classList.add("tab-drag-active");
  }
  const panelEl = panelAt(e.clientX, e.clientY);
  if (tabDrag.panelEl && tabDrag.panelEl !== panelEl) {
    const prev = tabDrag.panelEl.querySelector(".split-preview");
    if (prev) prev.className = "split-preview";
  }
  tabDrag.panelEl = panelEl;
  if (!panelEl) {
    clearInsertIndicators();
    return;
  }
  // B27：tab 区 = 调整顺序（插入指示线），面板区 = 分屏预览，两者互斥
  const strip = stripUnder(panelEl, e.clientX, e.clientY);
  if (strip) {
    const preview = panelEl.querySelector(".split-preview");
    if (preview) preview.className = "split-preview";
    const info = stripInsertInfo(strip, e.clientX);
    if (info) showInsertIndicator(strip, info.offsetLeft);
    return;
  }
  clearInsertIndicators();
  const zone = zoneOf(panelEl.getBoundingClientRect(), e.clientX, e.clientY);
  // O5：按住 Alt = 临时取消分屏（本次落点按 center 处理）。预览同步切换成 center，
  // 拖拽时就能看到「这次不会分屏」。（对标 editorDropTarget.ts:382-384 的 Alt 反转开关）
  const effZone = e.altKey ? "center" : zone;
  const preview = panelEl.querySelector(".split-preview");
  if (preview) preview.className = `split-preview show zone-${effZone}`;
}

function onTabDragEnd(e: MouseEvent): void {
  const drag = tabDrag;
  finishTabDrag();
  if (!drag || !drag.active) return; // 未超阈值：无拖拽发生，click 正常触发激活
  if (!svCallbacks) return;
  suppressTabClick = true;
  const panelEl = panelAt(e.clientX, e.clientY);
  if (!panelEl) return;
  const panelId = Number(panelEl.dataset.panelId);
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
  panel.className = "layout-panel" + (data.active ? " layout-panel-active" : "");
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
    onReorder: (from, to) => cb.onReorderTab?.(panelId, from, to),
    onNew: () => cb.onNewTab?.(panelId),
  });

  // 面板操作栏：仅保留「移除该分屏」⨯。
  // B54 起去掉左右/上下分屏按钮——分屏改为把标签拖到面板边缘完成（zoneOf +
  // 拖拽落点），按钮重复且占位。⨯ 仅移除该分屏（标签并入相邻面板），不关文档，
  // 唯一面板时禁用。
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
    ICONS.closePanel,
    "移除该分屏",
    data.canClose === false ? undefined : "标签并入相邻面板",
    () => cb.onClosePanel(panelId),
  );
  closeP.disabled = data.canClose === false;
  if (data.canClose === false) {
    setTip(closeP, "唯一面板不可移除", { detail: "退出请用窗口关闭或菜单「退出」" });
    closeP.setAttribute("aria-label", "唯一面板不可移除（退出请用窗口关闭或菜单「退出」）");
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

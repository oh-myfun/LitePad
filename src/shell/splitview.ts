import type { LayoutNode } from "./layout";
import { renderTabstrip, type TabViewData } from "./tabstrip";

/**
 * 分屏区域渲染：递归布局树 → DOM。
 * - split 节点 = flex 容器 + 可拖拽分隔条（拖拽实时改 flex-basis，松手回写 ratio）
 * - leaf 节点 = 面板（面板级标签栏 + 编辑器宿主）
 * 结构变化时整体重绘；拖拽只改内联样式不重建 EditorView。
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
  onSplitPanel: (panelId: number, dir: "h" | "v") => void;
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
  root.appendChild(build(tree, [], cb, panelData));
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

function panelAt(x: number, y: number): HTMLElement | null {
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
  if (!panelEl) return;
  const zone = zoneOf(panelEl.getBoundingClientRect(), e.clientX, e.clientY);
  const preview = panelEl.querySelector(".split-preview");
  if (preview) preview.className = `split-preview show zone-${zone}`;
}

function onTabDragEnd(e: MouseEvent): void {
  const drag = tabDrag;
  finishTabDrag();
  if (!drag || !drag.active) return; // 未超阈值：无拖拽发生，click 正常触发激活
  suppressTabClick = true;
  if (!svCallbacks?.onDropTabToPanel) return;
  const panelEl = panelAt(e.clientX, e.clientY);
  if (!panelEl) return;
  const panelId = Number(panelEl.dataset.panelId);
  const zone = zoneOf(panelEl.getBoundingClientRect(), e.clientX, e.clientY);
  const over = tabUnder(panelEl, e.clientX, e.clientY);
  svCallbacks.onDropTabToPanel(drag.tabId, panelId, zone, over, e.ctrlKey);
}

function finishTabDrag(): void {
  tabDrag = null;
  document.body.classList.remove("tab-drag-active");
  document.removeEventListener("mousemove", onTabDragMove);
  document.removeEventListener("mouseup", onTabDragEnd);
  clearAllPreviews();
}

function build(
  node: LayoutNode,
  path: number[],
  cb: SplitviewCallbacks,
  panelData: Map<number, PanelRenderData>,
): HTMLElement {
  if (node.kind === "leaf") {
    return buildPanel(node.panelId, path, cb, panelData);
  }

  const container = document.createElement("div");
  container.className = "layout-split layout-" + (node.dir === "h" ? "h" : "v");

  const aEl = build(node.a, [...path, 0], cb, panelData);
  const bEl = build(node.b, [...path, 1], cb, panelData);
  const sep = document.createElement("div");
  sep.className = "layout-sep layout-sep-" + (node.dir === "h" ? "h" : "v");

  // 按 ratio 分配：a 占 ratio，b 占剩余
  aEl.style.flexBasis = `${node.ratio * 100}%`;
  bEl.style.flexBasis = `${(1 - node.ratio) * 100}%`;

  attachDrag(sep, node.dir, aEl, bEl, () => {
    const pct = parseFloat(aEl.style.flexBasis) / 100;
    cb.onRatioChange(path, Math.min(0.9, Math.max(0.1, pct)));
  });

  container.append(aEl, sep, bEl);
  return container;
}

function buildPanel(
  panelId: number,
  path: number[],
  cb: SplitviewCallbacks,
  panelData: Map<number, PanelRenderData>,
): HTMLElement {
  const data =
    panelData.get(panelId) ??
    ({ panelId, active: false, tabs: [] } as PanelRenderData);

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

  const ops = document.createElement("div");
  ops.className = "panel-ops";
  const closeP = document.createElement("button");
  closeP.className = "panel-op";
  closeP.textContent = "⨯";
  // VS Code 式语义：⨯ 仅移除该分屏（标签并入相邻面板），不关文档；唯一面板时禁用
  closeP.disabled = data.canClose === false;
  closeP.title = data.canClose === false
    ? "唯一面板不可移除（退出请用窗口关闭或菜单「退出」）"
    : "移除该分屏（标签并入相邻面板）";
  closeP.addEventListener("click", (e) => {
    e.stopPropagation();
    cb.onClosePanel(panelId);
  });
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

type DropZone = "left" | "right" | "top" | "bottom" | "center";

function zoneOf(rect: DOMRect, x: number, y: number): DropZone {
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  const edge = 0.28;
  if (rx < edge) return "left";
  if (rx > 1 - edge) return "right";
  if (ry < edge) return "top";
  if (ry > 1 - edge) return "bottom";
  return "center";
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

function attachDrag(
  sep: HTMLElement,
  dir: "h" | "v",
  aEl: HTMLElement,
  bEl: HTMLElement,
  onDone: () => void,
): void {
  let dragging = false;
  sep.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    document.body.classList.add("layout-dragging");
    const parentRect = (sep.parentElement as HTMLElement).getBoundingClientRect();

    function onMove(ev: MouseEvent): void {
      if (!dragging) return;
      if (dir === "h") {
        const pct = ((ev.clientX - parentRect.left) / parentRect.width) * 100;
        const clamped = Math.min(90, Math.max(10, pct));
        aEl.style.flexBasis = `${clamped}%`;
        bEl.style.flexBasis = `${100 - clamped}%`;
      } else {
        const pct = ((ev.clientY - parentRect.top) / parentRect.height) * 100;
        const clamped = Math.min(90, Math.max(10, pct));
        aEl.style.flexBasis = `${clamped}%`;
        bEl.style.flexBasis = `${100 - clamped}%`;
      }
    }
    function onUp(): void {
      dragging = false;
      document.body.classList.remove("layout-dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      onDone();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

/**
 * B307（方案乙）：左栏展开区的**外壳**。
 *
 * 一句话的职责：外壳拥有 **宽度 / 显隐 / 按钮列那条内部竖线 / `toc_open` 落盘**，
 * 里面的两块面板（大纲、最近打开）只是「此刻轮到哪一块」的视图。
 *
 * 为什么要单独一层：B305 给左栏加了第二块展开区之后，「展开区开着」这个外壳态仍然由
 * `setSideOpen` 按「大纲开没开」单方面决定，于是长出三个症状 ——
 *   · 最近打开摊开时按钮列那条竖线没了（它为了互斥先 `setSideOpen(false)`，外壳被判成折着）；
 *   · 分隔条只问 `tocPanel.hidden` ⇒ 最近抽屉开着时拖它是「换成大纲」而不是改宽度；
 *   · 宽度靠 `applyDrawerWidth` 从大纲那块**抄**到最近那块（两处写 = 两套口径）。
 * 收成一层之后这三条都是结构上不可能，而不是「记得同步两处」。
 *
 * 依赖方向：视图 → 本模块 → `ui` / `markdown/toc`。本模块**不认识**任何一块内容
 * （不 import `toc.ts`，也不 import `recents/panel.ts`），要重绘就走 `registerDrawerView`
 * 登记进来的 `onShow` —— 反向 import 就是环，这类环本仓库一向靠注入躲，这里用注册表躲。
 */
import { settings } from "../core/app-state";
import { saveSettings } from "../ipc/api";
import { attachSideResizer, clampSideWidth } from "../markdown/toc";
import { sideDrawer, sideResizer, sideShell } from "../ui";

export type DrawerView = "toc" | "recent";

interface DrawerViewSpec {
  /** 这一块的面板元素：轮不到它时 `hidden = true`。 */
  panel: HTMLElement;
  /** 按钮列里对应的那颗键：点亮态与 `aria-pressed` 跟着当前视图翻。 */
  button: HTMLElement;
  /** 这一块被摊开时要做的重绘（大纲重算条目 / 最近重画名单）。 */
  onShow: () => void;
}

const views = new Map<DrawerView, DrawerViewSpec>();

/** 视图自己在装配那一步登记（`setupSideBar` / `setupRecentsPanel` 都在启动回放之前跑）。 */
export function registerDrawerView(name: DrawerView, spec: DrawerViewSpec): void {
  views.set(name, spec);
}

let active: DrawerView | null = null;
/** 往右拖把外壳放回来时露哪一块：记「上次摊开的视图」，缺省大纲（与 B305 之前的手感一致）。 */
let lastView: DrawerView = "toc";
/** 分隔条当前宽度（`setupSideResizer` 的初值与回写都用它）。 */
let sideWidth = 240;

export function activeDrawer(): DrawerView | null {
  return active;
}

export function isDrawerOpen(): boolean {
  return active !== null;
}

/**
 * 显隐的**唯一出口**。一次做齐六件事，谁也不许在外面单独改其中一件：
 * 壳 `hidden` → 卡片 `is-collapsed`（那条竖线）→ 分隔条 `is-off` → 每块面板的 `hidden`
 * → 每颗键的 `is-on` / `aria-pressed` → 当前视图的重绘。
 * 半同步就会长出「面板开着而键是灭的」「门收了抽屉还摊着」那一族症状。
 *
 * ⚠️ 面板的 `hidden` 只表示「轮到我没」，不表示「外壳开着」：外壳的显隐在 `sideDrawer` 上。
 *    所以 `tocPanel.hidden === false` 仍然等价于「大纲正摊着」，老判据不必跟着改。
 *
 * `persist = false` 用于**启动时回放**：那时只是把盘上的值搬到 DOM，不该反过来再写一次盘
 * （写回去会把「加载失败 → 用默认值」那次的值固化成用户设置）。
 */
export function setDrawer(view: DrawerView | null, persist = true): void {
  active = view;
  if (view) lastView = view;
  const open = view !== null;
  sideDrawer.hidden = !open;
  // 折着的时候按钮列右缘正好贴着卡片右缘，两条 1px 边会紧挨着变成 2px 粗的一条线 ⇒ 一起收。
  sideShell.classList.toggle("is-collapsed", !open);
  // 分隔条**不跟着隐藏**：它是两张卡片之间的固定间距，照样吃指针、照样能拖回来（B207）。
  sideResizer.classList.toggle("is-off", !open);
  for (const [name, spec] of views) {
    spec.panel.hidden = name !== view;
    spec.button.classList.toggle("is-on", name === view);
    spec.button.setAttribute("aria-pressed", String(name === view));
  }
  if (view) views.get(view)?.onShow();
  if (!persist || !settings) return;
  // 落盘语义照旧只有一个 `toc_open`：「启动时摊开、且摊开的是大纲」。最近那块是历史账，
  // 不跟着会话走（B305 的裁决），所以它开着时写的是 false。
  settings.toc_open = view === "toc";
  void saveSettings(settings).catch(() => {
    // 持久化失败不影响本次生效（与分隔条回写宽度同一口径）
  });
}

/**
 * 挂载左栏宽度分隔条（B307 起从 `toc.ts` 搬进来：宽度是**外壳**的事，不是大纲的事）。
 * 设置未就绪（`settings` 为 null）时只生效不持久化。
 *
 * ⚠️ `attachSideResizer` 的返回值在这里直接丢弃：它是「装上监听 + 把 onChange 接上夹取回写」
 *    那一步，本模块没有要反过来设宽度的调用者。留着 `const handle =` 反而会被
 *    `noUnusedLocals` 拦下来。
 */
export function setupSideResizer(): void {
  sideWidth = clampSideWidth(settings?.toc_width ?? 240);
  attachSideResizer(sideResizer, sideDrawer, {
    initial: sideWidth,
    // ⚠️ `isOpen` 问的是**外壳**而不是某块面板：拖分隔条与点那两颗键走同一条路，
    //    复制一份开合态迟早跟 `setDrawer` 错开（B207 那条纪律，只是问的对象换成了壳）。
    isOpen: () => isDrawerOpen(),
    onOpenChange: (open) => {
      setDrawer(open ? lastView : null);
    },
    onChange: (w) => {
      sideWidth = w;
      if (!settings) return;
      settings.toc_width = w;
      void saveSettings(settings).catch(() => {
        // 持久化失败不影响本次生效
      });
    },
  });
}

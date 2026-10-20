/**
 * B307（方案乙）：左栏展开区的**外壳**。
 *
 * 一句话的职责：外壳拥有 **宽度 / 显隐 / 按钮列那条内部竖线 / `toc_open` + `drawer_view` 落盘**，
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
import { saveSettings, type DrawerViewName } from "../ipc/api";
import { attachSideResizer, clampSideWidth } from "../markdown/toc";
import { sideDrawer, sideResizer, sideShell } from "../ui";

/** 两块面板的名字。真相在 `ipc/api` 的 `DrawerViewName`（它同时是设置里的字段类型）。 */
export type DrawerView = DrawerViewName;

interface DrawerViewSpec {
  /** 这一块的面板元素：轮不到它时 `hidden = true`。 */
  panel: HTMLElement;
  /** 按钮列里对应的那颗键：点亮态与 `aria-pressed` 跟着当前视图翻。 */
  button: HTMLElement;
  /** 这一块被摊开时要做的重绘（大纲重算条目 / 最近重画名单）。 */
  onShow: () => void;
}

const views = new Map<DrawerView, DrawerViewSpec>();

/**
 * 视图自己在装配那一步登记：大纲排在启动回放**之前**，最近那块排在会话恢复**之后**。
 *
 * ⚠️ 登记**补写**当前开合态：生产次序里最近那块排在会话恢复之后才登记，而外壳回放
 * 排在装配阶段 —— 于是「壳已判成摊开、这块还没进册」那一刻，`setDrawer` 的循环根本看不见它，
 * 重启后「最近打开」就是一片空白。谁登记谁补一次，就不需要把启动链拆开重排（那条链上
 * 每一次 `await` 的次序都有人踩过，见 `main.ts` 里 B305 那段注释）。
 */
export function registerDrawerView(name: DrawerView, spec: DrawerViewSpec): void {
  views.set(name, spec);
  applyView(name, spec);
}

let active: DrawerView | null = null;
/** 往右拖把外壳放回来时露哪一块：记「上次摊开的视图」，缺省大纲（与 B305 之前的手感一致）。 */
let lastView: DrawerView = "toc";
/** 分隔条当前宽度（`setupSideResizer` 的初值与回写都用它）。 */
let sideWidth = 240;

/** 把「此刻轮到哪一块」写到这一块的面板与键上（`setDrawer` 的循环体与登记补写共用同一段）。 */
function applyView(name: DrawerView, spec: DrawerViewSpec): void {
  spec.panel.hidden = name !== active;
  spec.button.classList.toggle("is-on", name === active);
  spec.button.setAttribute("aria-pressed", String(name === active));
}

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
  for (const [name, spec] of views) applyView(name, spec);
  if (view) views.get(view)?.onShow();
  if (!persist || !settings) return;
  // B312：两格各管一件事 —— `toc_open` 只答「开没开」，`drawer_view` 只答「开着的是谁」。
  // 收起时**不覆盖** `drawer_view`：它记的是「最后一次摊开的那块」，拖回来与下次启动都靠它；
  // 抹掉它就等于替用户改了选择。（旧语义把这两件挤进一格，于是「最近打开」开着时写的
  // 是 `toc_open = false` ⇒ 重启后那一块永远收起 —— 用户这次报的就是它。）
  settings.toc_open = open;
  if (view) settings.drawer_view = view;
  void saveSettings(settings).catch(() => {
    // 持久化失败不影响本次生效（与分隔条回写宽度同一口径）
  });
}

/** 盘上那格认不认：未知值（手改过文件 / 别的版本写的串）一律回落大纲，不许把壳搞崩。 */
function viewFromSetting(raw: string | undefined): DrawerView {
  return raw === "recent" || raw === "explorer" ? raw : "toc";
}

/**
 * 启动回放：把盘上那两格（开没开 + 哪一块）搬到 DOM，`persist = false` 不反写盘。
 *
 * ⚠️ 即使收起也要先把「哪一块」摆进 `lastView`：分隔条拖回来露的就是这一块，
 * 不摆的话收起状态下拖开永远是大纲。
 */
export function replayDrawer(): void {
  const view = viewFromSetting(settings?.drawer_view);
  lastView = view;
  setDrawer(settings?.toc_open ? view : null, false);
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

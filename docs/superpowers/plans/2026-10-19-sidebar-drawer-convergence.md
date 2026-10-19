# 左栏展开面板收敛（方案乙 · 共享抽屉外壳）

## 为什么

B305 给左栏加了第二块展开区（最近打开）之后，「展开区开着」这个**外壳态**仍然由大纲一家单方面
决定，于是长出三个症状（用户 2026-10-19 点名第一个）：

1. 最近打开摊开时，按钮列 ↔ 展开区那条内部竖线没了 —— 因为 `is-collapsed` 是
   `setSideOpen(open)` 按「大纲开没开」写的，而 `setRecentOpen(true)` 为了互斥先调
   `setSideOpen(false)`，外壳被判成「折着」。
2. 分隔条 `#side-resizer` 的 `isOpen: () => !tocPanel.hidden` 只问大纲自己 ⇒ 最近抽屉开着时
   拖它是「把大纲摊开、把最近收掉」，而不是改最近抽屉的宽度。
3. 宽度靠 `applyDrawerWidth` 把内联值从 `#toc-panel` **抄**到 `#recent-panel`（两处写 = 两套口径）。

根因是同一件事：外壳的属性被复制进了视图。主流实现（VS Code / Cursor 的活动栏 + 单一 side bar
视图容器、JetBrains 的 Tool Window 条）都是**一份外壳 + 可替换的视图**。

## 目标 / 非目标

- 目标：一块共享外壳 `#side-drawer` 拥有 **宽度、显隐、那条竖线、落盘**；大纲与最近打开退化成
  「往壳里换的两个视图」，互斥变成结构性的而不是互相打电话。
- 目标：删掉 `setSideOpen`、`setRecentOpen`、`applyDrawerWidth`、`ui.setCloseRecentDrawer` /
  `closeRecentDrawer` 反向注入 —— 显隐只剩一个出口 `setDrawer(view | null)`。
- 非目标：不改 `attachSideResizer` 本体（阈值、迟滞带、B213 那个增量锚的手感都不动），
  只把它写的目标元素从面板换成壳。
- 非目标：不动卫星窗口那条整栏 CSS、不改 `settings.json` 的 schema、不碰 B306「上限 0 收起入口」。
- 反目标：不许出现「键灭了而抽屉还摊着」这类半同步（显隐与点亮态必须同处收口）。

## 设计

```html
<div id="side-shell" class="side-shell is-collapsed">
  <div id="side-bar" class="side-bar">…两颗键…</div>
  <div id="side-drawer" class="side-drawer" hidden>   <!-- 外壳：宽度 / 显隐 / 竖线 -->
    <aside id="toc-panel" class="toc-panel">…</aside>   <!-- 视图：只有「当前是不是我」 -->
    <aside id="recent-panel" class="recent-panel">…</aside>
  </div>
</div>
```

新模块 `src/shell/drawer.ts`（唯一出口 + 视图注册表）：

```ts
export type DrawerView = "toc" | "recent";
export function registerDrawerView(
  name: DrawerView,
  spec: { panel: HTMLElement; button: HTMLElement; onShow(): void },
): void;
export function setDrawer(view: DrawerView | null, persist?: boolean): void;
export function activeDrawer(): DrawerView | null;
export function isDrawerOpen(): boolean;
export function setupSideResizer(): void;   // 从 toc.ts 搬进来，挂到 #side-drawer
```

`setDrawer(view)` 一次做齐六件事：壳 `hidden` → `#side-shell.is-collapsed` →
`#side-resizer.is-off` → 每个已注册视图的 `panel.hidden = (view !== 它)` → 每颗键的
`is-on` / `aria-pressed` → 当前视图的 `onShow()`。谁也不许在外面单独改其中一件。

- **重绘走注册表而不是反向注入**：`drawer.ts` 不认识 `toc.ts` / `recents/panel.ts`（依赖方向是
  视图 → 外壳），避免 `ui.ts` 那种 `*Ref` 占位函数。
- **落盘语义不变**：仍然只有 `settings.toc_open`（= 启动时摊开、且摊开的是大纲）。
  `setDrawer("recent")` 与 `setDrawer(null)` 都写 `false`；启动回放传 `persist = false`。
  schema 不动 ⇒ Rust 侧与会话文件零改动。
- **分隔条往右拖回来**恢复 `lastView`（默认 "toc"）；往左拖过阈值即 `setDrawer(null)`。
- **CSS**：宽度 / `min-width` / `overflow` / `flex` 从 `.toc-panel`、`.recent-panel` 上移到
  `.side-drawer`；两块面板只留「标题栏 + 列表」那套内部排布。三条 `[hidden] { display: none }`
  兜底都要在（`.side-drawer`、`.toc-panel`、`.recent-panel`）—— 作者样式压过 UA 那条是 B207
  同一个坑，jsdom 不做级联 ⇒ 全部由静态契约盯。
- **B306 的衔接**：`renderRecents` 里那句「上限 0 时收起抽屉」改成 `setDrawer(null)`
  （判据从 `!recentPanel.hidden` 换成 `activeDrawer() === "recent"`），键本身的显隐仍在面板层。

## 工单（逐单 TDD 先红）

1. **外壳结构与样式**：`index.html` 包一层 `#side-drawer`；`.side-drawer` 规则与三条 `[hidden]`
   兜底；契约先钉结构（壳在 `#side-bar` 之后、两块 `aside` 在壳内）。
2. **`src/shell/drawer.ts`**：注册表 + `setDrawer` 六件事 + `activeDrawer`；单测按「四件事一处收口」
   逐条断言（摘掉任何一件都能红）。
3. **`setupSideResizer` 迁进外壳层**：`attachSideResizer(sideResizer, sideDrawer, …)`，
   `isOpen: () => isDrawerOpen()`、`onOpenChange` → `setDrawer` / `setDrawer(null)`；宽度写一次，
   `applyDrawerWidth` 删除。
4. **`src/toc.ts` 摘掉外壳职责**：删 `setSideOpen` / `applyDrawerWidth` / `closeRecentDrawer` 调用；
   `toggleToc` 改 `setDrawer(activeDrawer() === "toc" ? null : "toc")`；`sideWidth` 与
   `toc_width` 落盘随 resizer 一起搬到 `drawer.ts`。
5. **`src/recents/panel.ts`**：删 `setRecentOpen`，`toggleRecentPanel` / B306 那条都走 `setDrawer`；
   `setupRecentsPanel` 改为注册视图。
6. **`src/ui.ts` 与 `src/main.ts`**：新增 `sideDrawer` 引用；删 `setCloseRecentDrawer` /
   `closeRecentDrawer`；启动回放 `setSideOpen(settings?.toc_open ?? false, false)` →
   `setDrawer(settings?.toc_open ? "toc" : null, false)`。
7. **契约与用例改写**：`sidebar.test.ts`（`src` 拼接加 drawer.ts、竖线/`is-collapsed` 归属改口）、
   `side-resizer.test.ts`、`recents-contract.test.ts`、`recents-panel.test.ts`、
   `multiwindow.test.ts` 及各 app 级用例里对 `setSideOpen` / `setRecentOpen` 的运行时调用。
8. **全量门禁 + 出包 + 真机复现指导**。

## 验证判据（真机）

1. 大纲摊开 → 按钮列右缘有那条竖线（回归：必须还在）。
2. 最近打开摊开 → **同样有那条竖线**（本轮要修的那个症状）。
3. 拖分隔条改宽度 → 切到另一块抽屉**宽度不跳**；松手后 `toc_width` 落盘照旧。
4. 拖到最小再往左拖 → 收起（竖线一起收）；往右拖 → 拖回来，恢复的是**上次那块**视图。
5. 点大纲收起最近、点最近收起大纲（互斥）；两块都不会「键灭了还摊着」。
6. 整栏收起键、卫星窗口无左栏、上限 0 收起最近那颗键 —— 三条既有行为不许变。

# LitePad 架构总览

> 贡献者向的架构说明（非契约）。实现细节以源码为准；深一层的「改代码前必须知道」不变量见
> `.workbuddy/memory/ref/architecture-detail.md`（团队内部）。踩坑根因见 `.workbuddy/memory/pitfalls/`。

## 设计支柱

- **状态归 Rust，视图归前端**。Rust 侧（`src-tauri`）持有文档模型、脏标记、会话、备份与窗口；
  前端（`src/` + Vite/TS + CodeMirror 6）只渲染与转发意图。两者通过 Tauri IPC（`src/ipc/api.ts`
  ↔ `src-tauri/src/commands`）通信，Payload 两侧字段名必须一致（camelCase）。
- **单平台**：仅 Windows，基于 Tauri 2 + WebView2。
- **内存文本一律 LF**；落盘时还原文件原始行尾。
- **原子写入** = 写临时文件 + `fsync` + `rename`（同卷原子），临时文件落在目标同目录。
- **同源多实例**：同一文件可在多个面板（甚至多个窗口）各建实例，靠 ChangeSet 广播同步。

## 模块地图

| 层        | 关键位置                                                                                                           | 职责                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 文档模型  | `src-tauri/src/doc.rs`、`tab.rs`、`session.rs`、`backup/`                                                          | 文档/实例/会话/热退出副本                                      |
| 编辑器    | `src/editor/`（CodeMirror 6 封装）、`src/shell/find.ts`、`outline`                                                 | 编辑、查找、大纲                                               |
| 外壳/UI   | `src/shell/`（main / menubar / tooltip / zoom / preferencesdialog / keymap / keymapdialog / splitview / tabstrip）、`src/appearance.ts`（外观 setter 集合）、`src/encoding.ts`（编码菜单纯函数叶子）、`src/doc-model.ts`（文档/标签/实例纯模型操作 + 工厂）、`src/ui.ts`（启动计时 / DOM 句柄 / 基础访问 / 状态呈现服务簇）、`src/tabs.ts`（标签/面板/布局操作 + 标签栏渲染） | 菜单、标题栏与窗口控制、提示、缩放、设置、快捷键、布局、标签栏、主题/字号/字体/预览宽度、编码菜单、文档模型、状态呈现、标签与面板操作 |
| 预览      | `src/editor/preview/`                                                                                              | Markdown 渲染与预览内查找                                      |
| 窗口      | `src-tauri/src/windows.rs`                                                                                         | 主窗口 + 卫星窗口（多窗口）                                    |
| 构建/打包 | `src-tauri/tauri.conf.json`、`build.rs`、`scripts/release.sh`                                                      | 版本、图标、NSIS                                               |

## 各关注点一句话

- **文档/实例模型**：`Doc`（按 `tabId` 唯一）持元数据与脏标记，`实例`（`nextInstId`）持独立视图状态；
  编辑以 ChangeSet 广播同步到同 doc 的所有实例。
- **置脏判据**：CM6 的 `update.docChanged` 不等于「内容变了」；置脏必须比 `startState/doc` 与
  `state/doc` 的字符串。
- **布局树与分割条**：`splitview.build()` 传给 `onRatioChange` 的 path 是分割节点自身树路径；
  最大化 = 只改比例不动结构；关面板要做比例补偿。
- **拖拽体系**：标签与标签栏空白处的拖拽走 **HTML5 DnD**（`draggable` + `dragstart`/`dragover`/
  `drop`），传输层在 `src/shell/tabdnd.ts` —— 影像交给 `dataTransfer.setDragImage` 由**系统**
  绘制（才能跟出窗口），载荷走私有 MIME `application/x-litepad-tab`；跨窗口交接按「**松手才
  提交** + 定向投递」设计：目标窗口 drop 后带 `dragId` 定向认领，源窗口只把正文回发给它一个
  （正文绝不广播，标签快照可能几十 MB）。文件拖入另走一路：页面内 HTML5 拖放 + 路径桥（关掉
  wry 的原生拖放处理器后，用 WebView2 的 `postMessageWithAdditionalObjects` 换回真实路径，见
  `src-tauri/src/dropbridge.rs`），拿到路径之后仍由 `onDragDropEvent` 的 drop 分支接管。
- ⚠️ **页面级拖放监听一律挂捕获阶段并 `stopPropagation`**：编辑器（CodeMirror 6）会在自己的
  DOM 上吃 `drop` —— 标签拖拽时把载荷里的可读文本插进正文，文件拖入时直接用 `FileReader`
  把**文件内容**读出来插进当前文档。监听挂冒泡阶段时它比页面级监听先跑，等到我们的处理器，
  `preventDefault()` 已经拦不住那次插入。本项目对外只提供「插入**文件路径**」，从来没有
  「插入文件内容」这一项。
- **视图刷新红线**：mousedown 链路上绝不做 DOM 重建（否则「切换面板要点两下」）。
- **窗口边框自建**（B97）：`decorations:false` 去掉原生标题栏，菜单栏画进自建标题栏，右侧是最小化 /
  最大化 / 关闭。
  ⚠️ **拖动由 `setupTitleBar` 自己接管**（B192）：左键按下在标题栏（非按钮）后，等第一个越过
  3px 阈值（常量 `DRAG_THRESHOLD_PX`）的 mousemove 才调 `startDragging()` 交给系统移动循环 ——
  **纯点击一次都不产生 mousemove ⇒ 一次都不碰拖拽**，**真移动则由系统接管（最跟手）**。这样绕开了两条平台方案的坑：
  · Tauri 的 `data-tauri-drag-region` 在 mousedown 当刻就起拖，但它向顶层 Win32 窗口模拟一次
  标题栏点击（`WM_NCLBUTTONDOWN`）来进入移动循环，mouseup 因此到不了 webview；mousedown→起拖
  是异步 IPC，模拟的那次可能晚于真实松手 ⇒ 窗口卡在循环里跟着鼠标走（Tauri #10767，官方未修）；
  · WebView2 原生 `app-region: drag`（B191 试过那版）没这条毛病，但 Chromium 要**先检测到移动**
  才把拖动交给窗口、首次还有跨进程开销 ⇒ 体感「第一下移动发涩」。
  ⚠️ 因此 **CSS 里不许再写 `app-region: drag`** —— 与 `startDragging` 双重起拖反而抖。
  双击最大化、按钮豁免（`closest("button")`）都由 `setupTitleBar` 自己接；窗口控制走
  `core:window` 对应命令。
  ⚠️ 卫星窗口不继承 `tauri.conf.json` 的主窗口配置，必须各自显式设 `decorations(false)`。
- **标题栏两端**（B99）：最左是**软件图标**——纯标识，点击穿透到拖动区，行为等同点标题栏空白；
  图源就是打包用的那份应用图标，不另存副本。右侧窗口控制键之前是**「钉在顶部」**开关
  （`setAlwaysOnTop` 取反），**不写配置、不持久化**（重启回到不置顶）；亮灯与否以
  `isAlwaysOnTop()` 的**回读值**为准，不是本地开关。需 `allow-set-always-on-top` 与
  `allow-is-always-on-top` 两条授权。
- **样式与主题**：组件统一用 CSS 变量；`hidden` 属性必须配 `display:none`；外观/主题/字号/字体/预览宽度的 setter 集中在 `src/appearance.ts`（只消费 core/app-state 与 DOM，不回调 main 编排逻辑，可独立单测）。
- **编码菜单叶子**：BOM 目标判定（`bomTarget`）、语言分组收口（`withLanguageGroups`）、UTF-8 两档常量（`ENC_UTF8` / `ENC_UTF8_BOM`）抽到 `src/encoding.ts`；只依赖 `MenuItem` 类型、不碰模块级状态，可独立单测。写盘出口 `convertDoc` 与菜单模型 `encodingMenuModel` 仍留在 `main.ts`，只在此消费这两个叶子。
- **文档模型叶子**：`makeDoc` / `makeInstance` / `isDirtyVsBaseline` / `markClean` / `markDiskVersion` / `registerDoc` / `attachTabToPanel` / `panelIdsInOrder` 抽到 `src/doc-model.ts`；只依赖 `core/app-state`、`editor/*`、`shell/layout`，对 `main.ts` 零反向依赖。`makeInstance` 需要的编辑器更新回调通过 `setInstanceOnUpdate(handleUpdate)` 在启动时注入（解耦 main 的 handleUpdate，避免 feature 模块 import main）。
- **UI 服务簇**：启动计时（`bootMark`/`reportBoot`/`BOOT_T0`/`BOOT_MARKS`）、全部 DOM 句柄常量（`layoutArea`/`menuBar`/`titleBar`/`appMark`/`syncScrollBtn`/`winMinimize`/`winMaximize`/`winClose`/`winPin`/`tocPanel`/`tocList`/`tocToggleAll`/`tocResizer`/`sideShell`/`sideOutline`/`tocGrip`/`sidebarToggle`/`mainRow`/`sbMessage`/`sbPos`/`sbCount`/`sbEncoding`/`sbEol`/`sbLang`）、基础访问（`el`/`panelOfView`/`remoteHasDoc`/`showMessage`/`updatePositionOf`）、状态呈现（`refreshTitle`/`refreshSyncButton`/`refreshStatus`/`broadcastDocPresence`/`refreshAll`/`markActivePanel`）抽到 `src/ui.ts`；只依赖 `core/*` + `sync-scroll` + `shell/codicons` + `shell/tooltip`，对 `main.ts` 零反向依赖。main 的四个渲染实现（`refreshViewModeButton`/`updateTocDrawer`/`renderPanelTabs`/`renderPanelOps`）在启动时经 `setRefreshViewModeButton`/`setUpdateTocDrawer`/`setRenderPanelTabs`/`setRenderPanelOps` 注入（DI），避免 feature 模块 import main。`remoteOpenByWindow` 收进 `core/app-state`，`lastBroadcastDocIds` 为 ui.ts 私有 `let`。
- **标签/面板/布局簇**：`switchTab` / `closeTabById` / 标签移动·复制·分屏拖拽（`moveTabToPanel`/`duplicateTabToPanel`/`splitPanelWithTab`/`onDropTabToPanel`…）、面板最大化（`toggleMaximizePanel` + `maximizedPanelId`/`maximizeSnapshot`）、标签栏与操作区渲染（`renderPanelTabs`/`renderPanelOps`/`panelDataOf`/`tabViewDataOf`/`tabstripCallbacks`）、布局树重建（`rebuildLayout`）抽到 `src/tabs.ts`；只依赖 `core/*` + `sync-scroll` + `ui` + `shell/*` + `doc-model`，对 `main.ts` 零反向依赖。ⓘ **过渡期 DI**：它调用的下游模块函数（session / markdown / find / io / multiwindow / image-paste 共 14 个）经 `installTabDeps(TabDeps)` 在启动时注入，调用点带 `Ref` 后缀；`#410–#415` 各模块拆出后逐个换成直接 import 并删除对应 ref。`windowKind` / `loanedDocIds` 收进 `core/app-state`；`isMdDoc`/`isMdTab`/`isMdActive` 收进 `src/doc-model.ts`。
- **查找/大纲/缩放/设置/快捷键/菜单/标签栏/分屏/提示/保存/图标**：见 `src/shell/` 与各 `ref` 详情。
- **多窗口（卫星窗口）**：新窗口与主窗口共享文档状态、标签可来回拖；「文档只有一个真相」跨 WebView 成立。
  跨窗口拖拽与窗口内**同语义**：途中只亮落点预览，**松手才提交**——指针掠过哪块面板都不会
  立刻生效（落点由目标窗口自己的 drop 事件决定，然后向源窗口认领正文，见 `src/shell/tabdnd.ts`）。
  详情见 `.workbuddy/memory/ref/multiwindow.md`。

## 质量与发布

- 每次交付一个 Conventional Commit；每个 bug 必须补回归测试并做反向验证
  （技能 `litepad-reverse-verify`）。
- 每次编译产出发布版本：`tsc → vite → vitest → cargo build+test → tauri build`，
  质量门 = `.githooks`（pre-commit: prettier/eslint/tsc/cargo fmt；pre-push: vitest/cargo test）+ GitHub `CI`。
- 发布只由 `v*` tag 触发（`git push origin main --follow-tags`）。最新发布 **v0.11.0**。

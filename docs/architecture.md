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
| 文档模型  | `src-tauri/src/doc.rs`、`tab.rs`、`session.rs`、`backup/`；`src/session/`（store 权威类型 + session 行为侧）        | 文档/实例/会话/热退出副本                                      |
| 编辑器    | `src/editor/`（CodeMirror 6 封装）、`src/shell/find.ts`、`src/find/findbar.ts`（悬浮查找/替换栏 + 跨文档搜索）、`src/io/files.ts`（打开/保存/文件拖入）、`src/io/export.ts`（导出 HTML/PDF + 图片粘贴）、`outline` | 编辑、查找、大纲、文件 IO                                       |
| 外壳/UI   | `src/shell/`（menubar / tooltip / zoom / preferencesdialog / keymap / keymapdialog / splitview / tabstrip / scrollbar——tabstrip 的滚轮与 B117 自绘悬浮滚动条已拆出 scrollbar.ts，纯叶子零反向依赖）、`src/appearance.ts`（`apply*`：把档位落到 DOM）、`src/prefs.ts`（`set*`：改设置 → 持久化 → 调 apply*；含编码转换与设置对话框）、`src/commands.ts`（命令层：编辑菜单动作 / 折叠 / 转到行 / 查看档位 / 标题栏+菜单栏装配 / 查找替换入口 / 视图批处理）、`src/encoding.ts`（编码菜单纯函数叶子）、`src/doc-model.ts`（文档/标签/实例纯模型操作 + 工厂）、`src/ui.ts`（启动计时 / DOM 句柄 / 基础访问 / 状态呈现服务簇）、`src/tabs/`（标签/面板/布局操作 + 标签栏渲染；P3 批次按职责拆为 render/lifecycle/split/deps 四子模块 + index 门面）、`src/markdown.ts`（Markdown 预览：视图模式切换 / 渲染调度 / 视图模式按钮）、`src/toc.ts`（大纲 TOC 抽屉 + 侧栏可见性/宽度） | 菜单、标题栏与窗口控制、提示、缩放、设置、快捷键、布局、标签栏、主题/字号/字体/预览宽度、编码菜单、文档模型、状态呈现、标签与面板操作、Markdown 预览、大纲与侧栏 |
| 预览      | `src/editor/preview/`                                                                                              | Markdown 渲染与预览内查找                                      |
| 窗口      | `src-tauri/src/windows.rs`；`src/multiwindow/windows.ts`（标签搬出/回收、拖拽出窗、跨窗口同源同步）                  | 主窗口 + 卫星窗口（多窗口）                                    |
| 构建/打包 | `src-tauri/tauri.conf.json`、`build.rs`、`scripts/release.sh`、`scripts/make_icons.py`（图标产物链，源图 = `docs/LitePad.png`） | 版本、图标、NSIS                                               |

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
- **UI 服务簇**：启动计时（`bootMark`/`reportBoot`/`BOOT_T0`/`BOOT_MARKS`）、全部 DOM 句柄常量（`layoutArea`/`menuBar`/`titleBar`/`appMark`/`syncScrollBtn`/`winMinimize`/`winMaximize`/`winClose`/`winPin`/`tocPanel`/`tocList`/`tocToggleAll`/`tocResizer`/`sideShell`/`sideOutline`/`tocGrip`/`sidebarToggle`/`mainRow`/`sbMessage`/`sbPos`/`sbCount`/`sbEncoding`/`sbEol`/`sbLang`）、基础访问（`el`/`panelOfView`/`remoteHasDoc`/`showMessage`/`updatePositionOf`）、状态呈现（`refreshTitle`/`refreshSyncButton`/`refreshStatus`/`broadcastDocPresence`/`refreshAll`/`markActivePanel`）抽到 `src/ui.ts`；只依赖 `core/*` + `shell/codicons` + `shell/tooltip`，对 `main.ts` 零反向依赖。main 的四个渲染实现（`refreshViewModeButton`/`updateTocDrawer`/`renderPanelTabs`/`renderPanelOps`）在启动时经 `setRefreshViewModeButton`/`setUpdateTocDrawer`/`setRenderPanelTabs`/`setRenderPanelOps` 注入（DI），避免 feature 模块 import main。`remoteOpenByWindow` 收进 `core/app-state`，`lastBroadcastDocIds` 为 ui.ts 私有 `let`。
- **标签/面板/布局簇**：`switchTab` / `closeTabById` / 标签移动·复制·分屏拖拽（`moveTabToPanel`/`duplicateTabToPanel`/`splitPanelWithTab`/`onDropTabToPanel`…）、面板最大化（`toggleMaximizePanel` + `maximizedPanelId`/`maximizeSnapshot`）、标签栏与操作区渲染（`renderPanelTabs`/`renderPanelOps`/`panelDataOf`/`tabViewDataOf`/`tabstripCallbacks`）、布局树重建（`rebuildLayout`）抽到 `src/tabs/`（P3 批次按职责拆四子模块：`render.ts` 标签栏/操作区渲染、`lifecycle.ts` 切换·关闭·布局重建、`split.ts` 分屏·最大化·标签移动、`deps.ts` markdown/session 依赖注入绑定；`index.ts` 仅 `export *` 门面，子模块间为运行期安全的循环引用）；只依赖 `core/*` + `ui` + `shell/*` + `doc-model`，对 `main.ts` 零反向依赖。ⓘ **过渡期 DI**：它调用的下游模块函数（session / markdown / find / io / multiwindow / image-paste 共 14 个）经 `installTabDeps(TabDeps)` 在启动时注入，调用点带 `Ref` 后缀；`#410–#415` 各模块拆出后逐个换成直接 import 并删除对应 ref（**#410–#416 已全部撤销**：applyPanelMode / toggleViewMode / openPreviewToSide → `src/markdown.ts`，updateTocDrawer → `src/toc.ts`，scheduleSessionSave / discardBackupFor → `src/session/session.ts`，retargetFindBar → `src/find/findbar.ts`，saveDocCore → `src/io/files.ts`，openTabsInNewWindow / returnTabToMain / requestSatelliteClose / docHeldElsewhere → `src/multiwindow/windows.ts`，attachPasteHandler → `src/io/export.ts`，keyHint → `src/prefs.ts` —— **TabDeps 与 installTabDeps 已整体删除，全项目再无过渡期 DI**）。`windowKind` / `loanedDocIds` 收进 `core/app-state`；`isMdDoc`/`isMdTab`/`isMdActive` 收进 `src/doc-model.ts`。
- **Markdown 预览簇**：面板视图模式落点（`applyPanelMode`/`toggleViewMode`/`openPreviewToSide`）、渲染调度（`renderMarkdownFor`/`scheduleMdRender`）、视图模式按钮（`refreshViewModeButton`，B97 后实际刷状态栏语言名）、路径工具（`dirname`）、`PreviewFindSpec` 类型抽到 `src/markdown.ts`；只依赖 `core/*` + `ui` + `tabs` + `doc-model` + `editor/perf` + `markdown/pipeline`，对 `main.ts` 零反向依赖。**#413 后 MarkdownDeps 全清**：scheduleSessionSave（#412）/ findSpecOf·applyPreviewFindToPanel·getFindBar（#413，getFindBar 以 getter 形式从 find/findbar.ts 导出）/ updateTocDrawer（#411）均已换直接 import——本模块无 DI；main 仍保留 `refreshViewModeButton` 的 ui.ts 注册（`setRefreshViewModeButton`）。
- **大纲 TOC / 侧栏簇**：大纲抽屉（`updateTocDrawer`/`refreshTocAtCursor`/`refreshTocToggleAll`/`toggleToc` + `tocListView` 控制器与 `tocEntries` 状态）与侧栏（`applySidebarVisible`/`isSidebarOff`/`toggleSidebar`/`setSideOpen`/`setupSideBar`/`setupSideResizer` + `sideWidth` 状态）抽到 `src/toc.ts`；**零外部函数依赖**——只依赖 `core/*` + `ui` + `markdown/toc`（createTocList / activeOutlineLine）+ `ipc/api`（saveSettings）+ `markdown/outline`（extractOutline），对 `main.ts` 零反向依赖。**#411 撤销了 2 个 Ref**：tabs.ts 与 markdown.ts 的 `updateTocDrawerRef` 均换直接 import。
- **会话 / 自动保存 / 热退出簇**：会话落盘与恢复（`scheduleSessionSave`/`persistSession`/`restoreSession`/`snapshotSession`/`refreshSession`/`restoreSatelliteWindows`）、自动保存（`scheduleAutosave`）、热退出副本（`scheduleBackup`/`flushBackups`/`discardBackupFor`/`discardAllBackups`）、外部文件变更恢复（`handleFileChanged`/`resolveExternalChange*`/`applyDiskContent`/`openDiskCopyForCompare`）抽到 `src/session/`（P3-b 批次按职责拆两子模块：`persist.ts` 落盘/自动保存/热退出副本/外部文件变更、`rebuild.ts` 会话恢复与卫星窗口还原；`session.ts` 仅 `export *` 门面，依赖单向 rebuild→persist 无环；权威类型仍在 `src/session/store.ts`）；只依赖 `core/*` + `ui` + `doc-model` + `tabs` + `ipc/api`，对 `main.ts` 零反向依赖。**#414/#415 后 SessionDeps 全清**：`rebuildDocInstances`（→ io/files）、`reclaimRemoted`/`openTabsInNewWindow`（→ multiwindow/windows）均已换直接 import——本模块无 DI。`MAIN_WINDOW_LABEL` / `remotedTabs` 收进 `core/app-state`。
- **悬浮查找 / 替换栏簇**：查找栏句柄与开关（`ensureFindBar`/`openFindBar`/`resetFindAll`）、编辑器查找（`applyFindQuery`/`stepFind`/`replaceCurrent`/`replaceAllInScope`）、预览查找桥（`findSpecOf`/`applyPreviewFindToPanel`）、跨文档搜索（`searchOpenDocs`/`runFindInDocs`/`openFindHit`/`updateDocBadge`）、重定位（`retargetFindBar`）抽到 `src/find/findbar.ts`；**零外部函数依赖**（无 DI）——`PreviewFindSpec` 类型归此模块（markdown.ts 反向只取类型，运行期无环）；`findBar` 私有可变量以 `getFindBar()` getter 导出。
- **打开 / 保存 / 文件拖入簇**：打开（`doOpen`/`openDroppedAt`）、保存（`doSave`/`doSaveAll`/`saveDocCore`）、冲突与有损确认（`resolveSaveConflict`/`confirmLossy`）、实例内容重建（`rebuildDocInstances`）、文件拖入（`showFileDropPreview`/`fileDropTargetAt`/`dropPosOf`/`insertDroppedPath`）、`panelDocIsMarkdown` 抽到 `src/io/files.ts`；只依赖 `core/*` + `ui` + `doc-model` + `tabs` + `session/session` + `ipc/api` + `editor/*`，对 `main.ts` 零反向依赖。**#415 后 IoDeps 全清**：`reclaimRemoted`（→ multiwindow/windows）已换直接 import——本模块无 DI；`handleUpdate` 复用 doc-model 的 `getInstanceOnUpdate()` 访问器（#406 注入机制的读回端）。
- **多窗口 / 卫星 / 跨窗口同步簇**：标签搬出与回收（`transferSnapshotOf`/`remoteTabLocally`/`reclaimRemoted`/`openTabsInNewWindow`/`adoptTransferredTabs`/`returnTabsToMain`/`returnTabToMain`/`detachLocally`）、拖拽出窗成窗（`snapshotDrag`/`relinquishDrag`/`dropOnDesktop`/`acceptDroppedTabs`）、消失窗口清理（`applyTabsReturn`/`applyBackupIds`/`reclaimFromVanished`/`dropRemotedForOwner`）、关标签防误杀（`handleDocCloseQuery`/`docHeldElsewhere`）、跨窗口同源同步（`broadcastDocChange`/`applyRemoteDocChange`/`applyDocResyncFull`/`listenDocSync`）抽到 `src/multiwindow/windows.ts`；**零外部函数依赖（无 DI）**——共享状态（windowKind/windowLabel/remotedTabs/remoteOpenByWindow/loanedDocIds）已在 core/app-state。**#415 撤销了 7 个 Ref**：tabs ×4（TabDeps 剩 2）+ session ×2 + io ×1（SessionDeps/IoDeps 全清）。
- **导出 / 图片粘贴簇**：`exportHtml` / `exportPdf`（导出当前文档为 HTML / 打印为 PDF）与 `attachPasteHandler` / `pasteImageToAssets`（剪贴板图片落到 ./assets 并插入引用）抽到 `src/io/export.ts`；纯叶子模块（零依赖、零状态）。#416-1 撤销了 tabs.ts 的 `attachPasteHandlerRef`（TabDeps 剩 1：keyHint）。
- **设置 / 编码 / 档位簇**：编码与换行转换（`convertDoc`/`switchEncoding`/`showEncodingMenu`/`showEolMenu`/`encodingMenuModel`）、主题档与窗口身份落 DOM（`publishThemeMode`/`publishWindowKind`）、字号字体行距预览宽度等档位 setter（全部 `set*`）、设置对话框与偏好持久化（`openSettingsDialog`/`persistSettings`/`loadPreferenceOptions`/keymap）、`currentFontSize` 抽到 `src/prefs.ts`；零外部函数依赖（无 DI）。与 `src/appearance.ts` 的分工：那边 `apply*` 落 DOM，这边 `set*` 改设置。
- **命令层（解耦第十七步 / #416-3）**：编辑菜单动作（`deleteSelection`/`pasteClipboard`/`insertTimeDate`/`cycleTabInPanel`）、折叠（`foldOperation`/`foldCodeOperation`）、转到行（`openGotoLine`）、查看档位（`changeFontSize`/`toggleWrapSetting`/`toggleStatusbar`/`togglePin`/`refreshPinButton`/`refreshMaximizeButton`）、标题栏与菜单栏装配（`setupTitleBar`/`setupMenuBar`）、查找替换命令入口（`openFindReplace`）、视图批处理（`withView`/`findStep`/`tabStateWriteBack`）抽到 `src/commands.ts`；零外部函数依赖（无 DI）。与 `src/tabs/` 的分工：`tabs/` 管标签/面板/布局的**结构**变更，`commands.ts` 管针对当前视图/标签的**动作**。`openFindReplace` 随迁（事件绑定段末尾），因命令簇外部依赖只剩它一个、一起迁即零 DI。
- **应用编排层（src/main.ts，解耦收口 / #417）**：main 已瘦为纯编排层，仅 3 段横幅——事件绑定（`bindEvents`/`onGlobalKeydown`/`runShortcut`/`openCommandPalette`）、启动（`bootstrap`/`setupShell`）、卫星窗口引导（`initSatelliteWindow`/`registerSatelliteClose`/`registerWindowClose`/`finishSatelliteClose`/`finishAndDestroy`/`destroySelf`）。保留 `handleUpdate`/`syncDocInstances` 作为编辑器 update 回调的协调胶水（串接 session/markdown 渲染/自动保存/备份/多窗口广播/脏标记），不再拆；启动期单向注入 `setInstanceOnUpdate`/`setRefreshViewModeButton`/`setUpdateTocDrawer`/`setRenderPanelTabs`/`setRenderPanelOps` 是 feature 模块不 import main 的引导接线，非死代码。B152 同步滚动键只剩 inert 开关（点击只翻 `docSyncModes` + 字形，见 `bindEvents` 内的处理）。
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
- 发布只由 `v*` tag 触发：`git push origin main` 之后 `git push origin v<版本>`（只推当版 tag，
  不带历史漏推的那批）。最新发布 **v0.23.10**。

- **图标（B222 起采用源图方案）**：真相在 `docs/LitePad.png`（512×512 RGBA）。换图标 = 换这张图，再跑
  `C:/Users/maoyu/.workbuddy/binaries/python/envs/default/Scripts/python.exe scripts/make_icons.py`
  —— 脚本**只做缩放与格式转换**（不重绘、不加底），9 件产物落在 `src-tauri/icons/`。
  ⚠️ 现行源图是**无底的内缩图形**（不透明区约 (117,66)–(458,443)，四边中点透明），
  所以 B222 的「app-mark 四边中点 alpha=255（带底版）」判据已作废，改为
  「四边中点**应当透明** + 与源图/打包图标**形状指纹同源**」（`tests/static.ts` 的
  `alphaGrid`/`gridDiff`）。产物换版后必须重新 `build-all` 才会嵌进 exe/setup ——
  `scripts/icon_check.py` 报「图标不一致」通常就是这一步没做。

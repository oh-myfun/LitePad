# ref: 多窗口（卫星窗口 / B71④）

> 领域参考。改多窗口相关代码前读此文件。
> 关键踩坑「卫星窗口须照抄主窗口 WebView2 参数」见 `pitfalls/0072-webview2-shared-env.md`。
> 本文件由 `ARCHITECTURE.md` §9 迁出（来源可考 `2026-09-*.md`）。

用户选的是**完整多窗口**（新窗口与主窗口共享文档状态、标签可来回拖），不是「复制一份」。
因此「文档只有一个真相」这条不变量要**跨进程内的多个 WebView** 继续成立。

## 9.1 身份与归属

- 每个窗口启动的第一个 IPC 必须是 `window_payload()`（`src-tauri/src/windows.rs`）。
  卫星窗口若先跑主窗口那套（`restoreSession` / `registerWindowClose` / `saveSession`），
  两个窗口会抢同一份 `session.json`，表现为「会话时好时坏」。
- 会话与关窗确认只归主窗口：`scheduleSessionSave()` 在卫星窗口是空操作
  （闸门 `if (windowKind !== "main") return;`）。卫星窗口的标签进会话靠主窗口的
  `satelliteTabs` 段（见 9.3），关窗不问「是否保存」——标签会交回主窗口，内容没消失。
- label 约定：`main` / `sat-<n>`。`capabilities/default.json` 的 `windows` 必须是
  `["main", "sat-*"]`：**前缀写错的表现是「界面能画但 emit/listen 全被 ACL 拒掉」**，
  不报错、不崩，只是什么都不响应（`regressions.test.ts` 已锁）。
- 建窗能力**不下放给前端**（不授予 `core:webview:allow-create-webview-window`），
  只走 Rust 命令 `open_satellite_window` —— 建窗必须 `run_on_main_thread`。
  载荷**随命令一起交给 Rust 存着**，卫星窗口启动时取走：这样不存在
  「源窗口监听还没挂上、卫星窗口已经 ready」的竞态（回问式握手有天然竞态）。

## 9.2 跨窗口正文同步（同源多实例的跨窗口版）

- 只广播 **ChangeSet**（`changes.toJSON()` / `ChangeSet.fromJSON()`），**绝不传全文**：
  每次按键搬一份几 MB 正文会把 IPC 打爆。`ChangeSet` 要当值导入
  （`import { ChangeSet, EditorState }`），写成 `type ChangeSet` 就拿不到 `fromJSON`。
- 三层保护缺一不可：
  1. 发送侧 `applyingRemote` —— 正在套用远端变更时产生的 update 不再广播（否则 A→B→A 无限弹）；
  2. 接收侧复用 `syncingDocId` —— 让 `handleUpdate` 不把远端变更当用户编辑
     （否则两个窗口各排一份自动保存/副本，对着同一个文件写盘打架）。
     **代价**：被抑制的那段不会置脏，所以接收侧要**自己** `doc.dirty = true` + 刷新；
     且**不得**在接收侧 `scheduleAutosave/scheduleBackup`（写盘由动手的那个窗口负责）。
  3. **基准校验** —— 广播带上 `baseLen`（变更前长度）。对端长度对不上就是**已经分叉**
     （对端重载过磁盘、或丢过一次事件）。此时硬套位置增量会在错误位置插入文本 ——
     静默改坏用户内容，绝不能忍 → 转为 `doc-resync-request` / `doc-resync-full` 要一份全文。
- 全文纠错**不准覆盖本地未保存的修改**：分叉后谁更新无从判断，本地 `dirty` 时只提示、不动手。
- 全文替换必须整态 `view.setState(whole)`，不能只 dispatch changes（否则视图与 `tab.state` 不同步）。

## 9.3 标签的搬运：隐藏实例

- 标签搬到别的窗口后，本地**留一个隐藏实例**（`tab.panelId = -1`，仍留在 `tabs` 里）。
  理由：会话与热退出靠「本地还认得这个文档」才能把正文写进 `session.json`；
  删干净的话「拖出去 + 强杀进程」会让未保存内容变成没人认领的孤儿副本。
- `remotedTabs: docId → { tabId, owner }` 是唯一索引。卫星窗口**异常消失**时按它把隐藏实例
  恢复成可见标签（`reclaimFromVanished`）；正常关闭走「先交还再 destroy」，到这里已是空操作。
- **交出去时只摘视图，绝不 `closeTabById` / `ipcCloseTab`** —— 那会连 Rust 侧文档一起删，
  接手方拿到空壳（首次保存报「文档不存在」）。统一走 `detachLocally()`。
- ⚠️ **被搬走的文档再被「打开文件」命中时必须先取回**（`doOpen` 里的 `remotedTabs` 分支）：
  否则会为同一个 docId 再建一个实例，隐藏那份停在载荷时的正文、新建那份来自磁盘，
  两份共用一条 `docs` 记录却各说各话 —— 正是同源多实例最怕的状态。
- 摘标签会改变面板构成 → 必须先 `exitMaximize()`（与分屏/关面板同一不变量）。

## 9.4 拖出窗口 / 拖回（B91-2 起走 HTML5 DnD：途中只预览 + 松手才提交 + 定向认领）

- **跨窗口交接协议**（`src/shell/tabdnd.ts` —— 它替换掉了 B89 的「广播指针坐标 + 200ms 抢单」）：
  1. 拖拽途中只有**预览**：目标窗口自己的 `dragover` 画落点，源窗口零副作用；
  2. **松手才提交**：`drop` 在**目标窗口**触发，由它决定放哪儿 —— 自己拖的直接 `commitLocal`，
     跨窗口则 `emitTo(源窗口, EVT_TAB_CLAIM, { from, dragId })` **定向认领**；
  3. 源窗口按 `dragId` 配对后回 `emitTo(认领方, EVT_TAB_PAYLOAD, { tabs })`（**正文只发给它
     一个**）+ 本地 `relinquish`（摘标签 / 摘空面板 / 写会话）；
  4. 目标窗口按**松手时算好的落点**（spot，**不经过 IPC**）落地。
- ⚠️ **B91-2 删掉的一整套（别再往回加）**：广播指针屏幕坐标、每窗口几何缓存与命中判定、
  200ms「抢单」超时、hover 节流；`src/shell/windowdrag.ts` **整个删除**。目标窗口是被操作系统的
  拖放循环**直接告知**的，不存在「谁被指着」的歧义，也就不需要那些补偿机制。
- ⚠️ **回落（扔在桌面）靠 `dragend` 的 `screenX/screenY`**：整段拖拽手势被交给了系统拖放循环，
  页面在此期间收不到任何指针事件，`dragend` 是唯一还带最后位置的时机。`desktopSpotOf` 挡掉
  非有限值与 `(0,0)`，拿不到就让系统自己摆 → 主窗口开新窗口 / 卫星窗口交回主窗口。
- ⚠️ **源窗口的 `source` 要等 `CLAIM_GRACE_MS = 300` 宽限到期才清**：认领是 IPC 往返、
  **必然晚于 `dragend`**。不等宽限就清的话，每一次成功的跨窗口拖拽都会同时被当成「扔在桌面上」
  → 标签被**复制成两份**（源窗口多开一个新窗）。
- ⚠️ **正文绝不广播**：`emit` 是广播，每个窗口都会收到一份完整 payload；标签快照带着正文，
  几十 MB 广播一次就是「几十 MB × 窗口数」。所以 claim 与 payload 都用 `emitTo` **定向**投递。
- ⚠️ **本地落点要就地收尾，不等 `dragend`**：落点常会重建面板 DOM（分屏 / 并入），源标签元素
  随之脱离文档 —— 而 `dragend` 是派发到**源元素**上的，元素脱离文档就不再冒泡到 document，
  挂在那儿的监听根本收不到。等它的后果是 `body.tab-drag-active`（全局禁文本选区）一直挂着。
- ⚠️ **载荷读不出来 = 跨窗口静默无效**：自定义 MIME 未必能跨过 WebView2 的进程边界。`drop` 里
  读不出载荷时**先无条件拦掉默认动作**（否则浏览器自己往落点编辑器插内容），再记一行
  `onWarn("tab drag payload unreadable")` 以免排不动。→ `pitfalls/0094`

### 9.4.1 拖拽观感与收尾的三条补充（B90 提出，B91-2 迁移）

- **影像始终精确跟随光标，不做任何夹取**。B89 曾加过「出界贴边」，用户明确否掉：指针在哪、
  影像就得在哪。B91-2 起影像由**系统**绘制，这条成了浏览器自己的行为（不再由我们控制），
  但它仍然是判据：任何「把影像夹回窗口内」的补丁都是错的。
- **移空的面板要摘掉**（`pruneEmptyPanels`）：把面板里最后一个标签挪走（移到别处、在自家
  边缘分屏出去、拖到别的窗口、整组搬走）之后别留空框。唯一面板不摘。
  `moveTabToStrip` / `moveTabToPanel` / `moveGroupToPanel` 各自写过这个判据，但同面板分屏与
  跨窗口这两条路径漏了 —— 统一收口到 `pruneEmptyPanels`，别再各判一遍。
- ⚠️ **`tabDrag` 这个指针编排的状态对象已不存在**（B91-2 连同 `finishTabDrag` / `onDragEnd`
  广播 END / `tab-drag-*` 广播事件一起删除）。B90 那套「END 只收视觉、必须留住落点」的补偿
  也随之作废 —— 现在落点只在目标窗口内算一次、直接攒在 `pendingForeign` 里等正文到达。
- 新窗口落点 = `outerPosition + 边框偏移 + 指针坐标`（换成逻辑像素）。
  拿不到就传 null，让系统摆 —— 绝不用 `screenX/screenY` 硬凑（跨屏会跑偏）。
  Rust 侧 `spot_of` 只接受**两个都合法且有限**的坐标（半个坐标 / NaN / ∞ 一律丢弃）。
- ⚠️ `outerPosition/outerSize/innerSize/scaleFactor` 都在 `core:window:default` 里
  （`core:default` 已包含）。若哪天为了「最小权限」把 `core:default` 拆开，
  落点会静默失效（`dropSpotOf` catch 后返回 null）。
- ⚠️ **静态契约测试不得读被 gitignore 的构建产物**（B71④）。`src-tauri/gen/`（含 Tauri 生成的
  ACL 清单）是构建产物、不入库：本地因为一直在构建所以存在，CI 干净检出上没有 ——
  用例会在本机长期绿、**一推就红**。要么只断言入库的源文件（`capabilities/default.json`、
  `windows.rs`），要么 `existsSync` 后跳过并**在注释里写明「跳过 ≠ 通过」**。
- ⚠️ **卫星窗口必须照抄主窗口的 WebView2 浏览器参数**（B72）—— 根因与修法见
  **`pitfalls/0072-webview2-shared-env.md`**（不照抄的表现是**根本建不出窗口**）。

### 9.4.2 Windows 上「影像跟出窗口」的两处劫持与三条路线（调研，2026-09-21）

- **wry 0.55.1 实证**（`wry/src/webview2/mod.rs` 与 `webview2/drag_drop.rs`）：`dragDropEnabled: true`
  时装 handler 会做两件事 —— ① `controller.SetAllowExternalDrop(false)`（源码注释原文
  "Disable file drops, so our handler can capture it"），**页内 HTML5 拖放熄火的真凶是这一刀**，
  不是 `RegisterDragDrop`；② `EnumChildWindows` 遍历子窗口逐个 `RevokeDragDrop` +
  `RegisterDragDrop`，**覆盖 WebView2 自身的拖放目标**。
- wry 的 target 只认 `CF_HDROP`（`DragDropTarget::iterate_filenames` 取不到即返回 `DROPEFFECT_NONE`）
  → 任何非文件拖放在自家窗口上都显示禁止光标。`dragDropEnabled: false` 时 wry **完全不动**
  `AllowExternalDrop`（保持默认 true）→ 页内 DnD 恢复，代价是拖入文件只能读、拿不到路径。
- 所以**不存在「把开关掰成两半」的解法**，只有三条路线（对比与取舍见当日日志 `2026-09-21.md`）：
  B 置顶穿透浮层窗承载影像（改动小、与现有 IPC 协议兼容）；C Rust 侧自建 `DoDragDrop` +
  `IDragSourceHelper` 出系统影像并接管 drop target（最像 VS Code，unsafe COM 最多）；
  D `dragDropEnabled: false` 换回 HTML5 DnD（Chromium 自带跟手影像）+ 低级鼠标钩子抢 `CF_HDROP` 补路径。
- ✅ **路线 D 已落地（B91-1 + B91-2，v0.11.0）**：`dragDropEnabled: false` + 页面内 HTML5 DnD
  （影像交系统绘制、天然跟手），路径用 WebView2 官方 API 桥回（`src-tauri/src/dropbridge.rs`）。
  「影像真跟出窗口」这一条前提**已由实现本身验证**（B91-2 首交付踩到的两个 bug 恰好都在
  影像与事件层，见 `pitfalls/0093` / `0094`）。B / C 两条路线未走，保留在此仅作备选。
- 路线 B 所需 API 在 tauri 2.11.5 齐备：`set_ignore_cursor_events` / `set_always_on_top` /
  `set_skip_taskbar` / `set_shadow` / `set_focusable`（`src/webview/webview_window.rs`）。
- 网络备用线路：`github.com:443` 偶发不通，但 **`ssh.github.com:443` 稳定可连、SSH 认证通过
  （`oh-myfun`）** —— 推送卡住时改用
  `git push ssh://git@ssh.github.com:443/oh-myfun/LitePad.git main --follow-tags`。

### 9.4.3 三方库调研：缺口的拼图都是现成的（2026-09-21）

- **没有单个库能同时给「文件拖入拿路径」+「跨窗口拖拽影像」** —— 限制在 WebView2 host 层，不在库层。
  但缺口的每一块都有现成实现，可以拼出「两件事都要」的方案。
- 🎯 **关键拼图（路线 D 的解法）**：WebView2 官方 API `window.chrome.webview.postMessageWithAdditionalObjects`
  + Rust 侧 `ICoreWebView2WebMessageReceivedEventArgs2::AdditionalObjects()` → cast 到 `ICoreWebView2File`
  → `.Path()` 拿到**真实文件路径**。**在 `dragDropEnabled: false` 的前提下就能拿到路径** ——
  不需要 yyzTools 那套全局低级鼠标钩子，也不需要自研 CF_HDROP 拦截。
  已有 `tauri-plugin-windows-file-drop` 0.1.0（MIT，2026-08-30）用它做了桥接，**发出的事件名就是
  `tauri://drag-drop`、载荷也是 `{paths, position}`** → `main.ts` 的 `onDragDropEvent` 零改动。
  ⚠️ 但该库只能当**参考实现抄**，不能当依赖：0.1.0 / 17 次下载 / 单人 / 无文档；而且**发布的源码里
  注入脚本多了一个 `}`**（`src/desktop.rs:24` 的 `}}`，README 里的同一段是平衡的）→ 注入脚本语法错误，
  而 `ExecuteScript` 的错误被 `let _ =` 吞掉，按发布版大概率根本不生效。另有「Tauri 收到同一条 web message
  会打 JSON error」的已知噪音。最低 WebView2 运行时版本（约 1.0.1774+）与 `FileList` 是否可直接当数组传需实测。
- 🔁 **拖拽层（若要重写成 HTML5 DnD）**：`@atlaskit/pragmatic-drag-and-drop` 3.1.0（Trello/Jira/Confluence
  在用，2026-08-29 仍在更新）= 基于原生 HTML5 DnD 的工具箱；external adapter 明确覆盖「从其它窗口开始的
  拖拽」与「从 OS 拖入的文件」，`onGenerateDragPreview` 可定制原生拖拽影像。
- 🖼️ **原生拖拽影像（路线 C 的源侧）**：`drag` 2.1.1 / `tauri-plugin-drag` 2.1.1（CrabNebula，2026-05 更新，
  12 万下载）= Rust 侧 `DoDragDrop` + `IDragSourceHelper`（`CLSID_DragDropHelper`）→ **影像由系统绘制、
  天然跟手**（`platform_impl/windows/mod.rs` 390 行，可直接当参考实现）。但取向是「文件/数据拖出」，
  落点侧仍要自己接。同仓库 `tauri-plugin-drag-as-window` 2.1.1（html2canvas 抓 DOM + 拖动时开窗）≈ 路线 B
  的现成参考实现，但 6 千下载、npm 绑定停在 2025-02。
- 结论倾向：**路线 D 从「高风险」变成「可行性最高且最像 VS Code」** —— `dragDropEnabled: false`
  让页内 HTML5 DnD 复活（影像由 Chromium 交给系统画、天然跟出窗口），路径用上面的 130 行桥接补回。
  代价是重写 B89/B90 的拖拽层（含测试），并且**拖拽影像是否真跟出窗口仍需一次 spike 实测**。

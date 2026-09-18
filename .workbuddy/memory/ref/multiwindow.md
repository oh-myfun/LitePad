# ref: 多窗口（卫星窗口 / B71④）

> 领域参考。改多窗口相关代码前读此文件。
> 关键踩坑「卫星窗口须照抄主窗口 WebView2 参数」见 `adr/0072-webview2-shared-env.md`。
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

## 9.4 拖出窗口 / 拖回

- 判据在 `splitview.ts`：指针离开客户区**超过 `DRAG_OUT_MARGIN`（24px）**才算「拖出」。
  无余量的话，最大化窗口贴边拖动会擦出去，表现为「莫名弹出新窗口」。
  用客户区尺寸比较，**不要用 `screenX/screenY`**（多显示器下是相对当前显示器的口径）。
- 拖拽层只判出界并上报（`onDragOutOfWindow`），**去哪个窗口由宿主按身份决定**：
  主窗口 → 开新窗口；卫星窗口 → 交回主窗口（否则只会越拖越多窗口）。
- 出界必须**先 `finishTabDrag()` 再上报**：指针已在客户区外，落点判定只会空转，
  不收尾还会留下浮动影像与监听。
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
  **`adr/0072-webview2-shared-env.md`**（不照抄的表现是**根本建不出窗口**）。

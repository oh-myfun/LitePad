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

## 9.4 拖出窗口 / 拖回（B89 起：途中只预览，松手才提交）

- 判据在 `splitview.ts`：指针离开客户区**超过 `DRAG_OUT_MARGIN`（24px）**才算「拖出」。
  无余量的话，最大化窗口贴边拖动会擦出去，表现为「莫名弹出新窗口」。
  用客户区尺寸比较，**不要用 `screenX/screenY`**（多显示器下是相对当前显示器的口径）。
- ⚠️ **出界绝不产生副作用**（B89 修的就是这条）：旧实现一判定出界就 `finishTabDrag()`
  + 上报，于是「想把标签拖到窗口 B 的面板 A，路过面板 B 就被合入」，主窗口拖出时更是
  鼠标没松手就弹了新窗口。现在出界只做三件事：记 `tabDrag.outOfWindow`、清掉**本窗口**
  的落点痕迹、调 `onDragOutside`（宿主据此广播指针位置让**目标窗口**亮预览）。
  **影像继续跟着光标走**，不能收尾。
- **松手才提交**：`onTabDragEnd` 见 `outOfWindow` → `onDropOutOfWindow` → 宿主先问
  「有没有别的窗口接手」（`windowdrag.ts` 的 release/claim 两步），
  · 有 → 正文**定向**发给它（`emitTo`），落点用它自己算的那块（预览在哪就落哪）；
  · 没有（扔在桌面）→ 才回落旧语义：主窗口开新窗口，卫星窗口交回主窗口。
- ⚠️ **为什么跨窗口要靠 IPC 而不是各窗口自己监听鼠标**：Windows 在鼠标按下后会做
  **隐式捕获**，指针掠过另一个窗口时那个窗口**收不到任何鼠标事件**，发起窗口反而能
  继续收到 mousemove/mouseup。所以「指针现在压在哪块面板上」只有目标窗口自己知道
  —— 它得靠 `tab-drag-hover`（只有坐标）被通知，并把 `claim` 回给发起窗口。
- ⚠️ **正文只走定向投递**：`emit` 是广播，每个窗口都会收到一份完整 payload。标签快照
  带着正文，几十 MB 的文件广播一次就是「几十 MB × 窗口数」——所以 release 只带坐标，
  等接手方 `claim` 之后才 `emitTo(target, EVT_PAYLOAD, …)` 单独发正文。
- ⚠️ **顺序：先挂 claim 监听，再广播 release**。反过来的话接手方的回答可能早于监听就位，
  这一次拖拽就只能干等到超时，再回落成「开新窗口」——表现为「明明拖到了另一个窗口，
  却还是新建了一个」。
- ⚠️ 坐标口径：hover/release 传的是**逻辑像素**（`outerPosition/outerSize/innerSize` 都是
  物理像素，必须除以 `scaleFactor`，高 DPI 屏上否则整体偏一倍）。几何一次拖拽问一次并缓存
  （mousemove 频率不该直接变成 IPC 频率），窗口移动后失效重问。

### 9.4.1 拖拽观感的三条补充（B90）

- **影像始终精确跟随光标，不做任何夹取**。B89 曾加过「出界贴边」，用户明确否掉：
  指针在哪、影像就得在哪，钉在边缘反而对不上。（影像是本窗口的 DOM，出界后自然看不见，
  那是窗口边界，不是拖拽边界。）
- **收尾必须通知宿主**：`finishTabDrag` 里统一回调 `onDragEnd`（松手 / 失焦 / 下一次拖拽前
  强制清场都走它）→ 宿主广播 END。只在「松手在窗外」收尾的话，「拖出去又拖回本窗口松手」
  会在另一个窗口留下一块高亮。
- ⚠️ **END 只收视觉，必须留住落点**：发起窗口是「先 `finishTabDrag`（广播 END）→ 再提交落点
  → 定向投递正文」，把落点一起清掉的话，接手方收到正文时已经不知道该放哪儿，只能退回活动
  面板（预览在这、落下在那）。只有「指针不在本窗口」才作废落点。
- **移空的面板要摘掉**（`pruneEmptyPanels`）：把面板里最后一个标签挪走（移到别处、在自家
  边缘分屏出去、拖到别的窗口、整组搬走）之后别留空框。唯一面板不摘。
  `moveTabToStrip` / `moveTabToPanel` / `moveGroupToPanel` 各自写过这个判据，但同面板分屏与
  跨窗口这两条路径漏了 —— 统一收口到 `pruneEmptyPanels`，别再各判一遍。
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

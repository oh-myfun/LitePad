# LitePad 架构不变量与踩坑根因

> 这些条目是「改代码前必须知道」的约束。破坏它们会重现已修过的 bug。
> 逐条背景见 `2026-09-*.md`；本条只记结论与判据。

## 1. 文档 / 实例模型（同文件多面板同源）

- **Doc**（Rust 侧 `tabId` 唯一）持有元数据与脏标记，`docs` Map 去重；**实例**（`nextInstId`）持有
  独立 `state/comps/viewMode`。同一文件可在多个面板各建实例。
- 编辑以 **ChangeSet 广播**同步到同 doc 的所有实例：挂载中的直接 `dispatch`、
  离屏的写快照；用 `syncingDocId` 抑制回环。
- `handleUpdate` 用 **`panelOfView` 反查**面板（不得闭包捕获），否则跨面板移动后写错快照。
- 只有**最后一个实例关闭**时才走保存确认 + `ipcCloseTab`。
- 会话恢复时，同一路径的多个面板各建一个实例。

## 2. 置脏判据（重要）

CM6 的 `update.docChanged` **不等于**「内容变了」。`handleUpdate` 必须比较
`update.startState.doc.toString() !== update.state.doc.toString()` 才置脏/排自动保存。
切视图（编辑器隐藏后恢复）要用 `suppressDirty` 包住，否则误判为修改。
→ 对应 B22：「切视图/点击内容区不应改动文件」。

## 3. 布局树与分割条

- `splitview.build()` 传给 `onRatioChange` 的 path 是**分割节点自身**的树路径（根分割 = `[]`）；
  `layout.updateRatio(node, path, ratio)` 按此约定：空路径写 `node.ratio`，否则按 head 下钻。
  **按「寻址子节点」解释会错位一层**——平时拖拽只改内联样式看不出，任何 `rebuildLayout`（开/关文档）都会跳位。
  → B26。
- 关闭面板要做比例补偿 `promoteSibling`，否则其余分割位置漂移。

## 4. 拖拽体系（B6/B24/B27）

- `tauri.conf.json` 必须 `dragDropEnabled: true`：这是拿到拖入文件**真实路径**的唯一途径
  （`onDragDropEvent` 的 `drop.paths`）。**代价**：WebView2 原生钩子会让页面内 HTML5 DnD 全部失效——
  因此标签拖拽、大纲宽度拖拽一律改成 **mousedown/mousemove/mouseup 指针编排**（`splitview.ts`）。
- 文件拖入：落点预览复用 `.split-preview`；drop 中央 = 落进该面板，边缘 = `splitPanelWithTab` 旁分屏；
  拖放坐标是**物理像素**，要除以 `devicePixelRatio`。
- **md 选择菜单只能在 drop 之后弹**（原生拖拽期间系统捕获鼠标，页面控件收不到点击）。
- 标签拖拽双语义且互斥：落在 `.panel-tabstrip`（需 `position:relative`）= 排序（`.tab-insert` 指示线），
  落在面板区 = 分屏预览；**strip 判定必须先于 `zoneOf`**。
- **同面板排序绝不能改 `activeTabId`**：改了却不重挂视图会破坏 `panel.viewTabId` 不变量
  （状态与编辑器脱节，后续激活早退无法恢复）；只 `splice` + `renderPanelTabs`。

## 5. 视图刷新红线

- **`mousedown` 链路上绝不做 DOM 重建**：否则 `mousedown`→`click` 之间 DOM 被替换，click 落空 ——
  表现为「切换面板要点两下」（B7）。
- 面板容器滚动失效的根因是 flex auto-minimum：滚动容器祖先需补 `min-height: 0`（B7）。
- 单面板撑满需给 `.layout-panel` 补 `flex`（B5）。

## 6. 样式与主题

- **TOC / 滚动条等组件一律用全局 CSS 变量**：`--md-*` 只定义在 `.md-preview` 内，
  `--panel-bg`/`--bg-panel` 根本不存在 —— 顶层 `aside`（TOC）用它就会恒落浅色 fallback，不随深浅色切换（B9）。
- **CSS 注释里不能出现 `*/` 序列**（会把注释提前闭合）。
- 滚动条统一在 `global.css`（`--sb-*` 变量 + `color-scheme` + 全局 `*` 与 `::-webkit-scrollbar` 双写）。
- 隐藏元素陷阱：`.find-bar` 设了 `display:flex`，**必须配 `.find-bar[hidden]{display:none}`**，
  否则 `hidden` 属性失效、面板关不掉（B30）。

## 7. 功能架构落点

- **查找/替换**：统一入口 = 悬浮栏 `src/shell/findbar.ts`（挂在 `#app`，切文件/面板不关闭；
  范围 = 当前文档/所有打开文档/文件夹）。内核 `src/editor/find.ts` 自持匹配/导航/替换/高亮，
  **不用 CM6 `search()` 扩展**（否则 Mod-f/F3/Mod-g 抢键，且多一套面板）。预览态由
  `PreviewPane.applyFind/stepFind` 复用 `cm-find-match` 样式。
- **大纲**：`extractOutline` 统一提取（md 标题；yaml/json 按缩进映射键，`level = depth` 而非 depth+1；
  py class/def）。返回 `null` = 格式不支持，用于区分空态文案。跳转要**遍历 `instancesOfDoc` 广播**，
  可见实例滚动、离屏写快照。
- **缩放**：Ctrl+滚轮走 `src/shell/zoom.ts`（`passive:false` + 累加阈值 30 防触控板跳档）；
  预览字号必须写成 `calc(var(--font-size,14px)+1px)`、代码块用 `em` 才能联动。
- **设置**（B46 起）：偏好收口在「设置」菜单 = **首选项…**（`src/shell/preferencesdialog.ts`，
  模态**弹窗**，分组：外观 / 字体与行距 / 编辑器 / Markdown 预览 / 新建文件；改动即时生效并落盘）
  + **快捷键…**（`src/shell/keymapdialog.ts`，可编辑面板）。
  偏好 setter 一律是**绝对值型**（`setWordWrap(v)` / `setAutosave(v)` / `setFontSizeValue(v)`…），
  toggle 系只是它们的包装——这样弹窗、菜单、快捷键三处入口可以共用同一套 setter。
  改偏好统一走 `persistSettings()`。
- **键盘快捷键**（B42 新增，`src/shell/keymap.ts`）：单一注册表 `CommandDef{id,label,group,keys[],editable,force}`；
  解析用 `KeyboardEvent.code`（**不可用 `e.key`**，`Ctrl+Shift+[` 的 key 是 `{`）；
  覆盖层 `KeymapOverrides`（id→键位串，`""` = 显式解绑）持久化到 `Settings.keymap`（Rust `HashMap<String,String>`）。
  分发在 `main.ts` 的**全局捕获阶段** `onGlobalKeydown`，`shortcutApplies(id)` 按上下文放行。
  `force:true` 只给 F5（必须压过 WebView2 刷新）；`isUsableBinding` 拒绝裸字母/数字/符号（否则打字被吞）。
  **新增一个快捷键的固定动作（照做，缺一步就失灵）**：
  ① `keymap.ts` 的 `COMMANDS` 加一条 `CommandDef`（只读内置项加 `editable:false`）；
  ② `main.ts` 的 `runShortcut(id)` switch 加分支；若需按上下文禁用，在 `shortcutApplies(id)` 加判断；
  ③ 若是菜单项，`menubar.ts` 用 `withKey(label, cb.keyHint("<id>"))` 带上提示；
  ④ 补测试：`tests/keymap.test.ts`（表结构）+ 运行时用例放 `smoke.bootstrap.test.ts`；
  ⑤ 若该键位可能被 CodeMirror 内置抢走，必须用真实 `defaultKeymap` 写探针测试并考虑捕获阶段。
  默认表自检 `duplicateKeys()` 只比对可编辑项，测试里会断言为空。
- **菜单系统**（`src/shell/menu.ts`）：`MenuItem.submenu?: MenuItem[] | (() => MenuItem[])`。
  子菜单**扁平挂到 `document.body`**（按父按钮 rect 定位、右侧越界左翻），**不能挂进父菜单 DOM**——
  父菜单有 `overflow` 会裁掉子菜单。`chain`/`created` 数组维护展开层级，`closeDeeperThan(level)` 收深层。
- **标签栏溢出**（B53 整体重写）：**不折叠，也不手写区间管理** —— 放不下的标签就是
  普通的横向滚动（VS Code 式）。`renderTabstrip` 仍是「全量渲染 → 测量 → 收缩/滚动」，
  但「滚到哪」交给浏览器（DOM 的 `scrollLeft`），模块不再维护"可见窗口"。
  1. `.panel-tabstrip` = `overflow-x: auto` + `flex-wrap: nowrap`，滚动条 **3px**
     （全局 10px 会吃掉 34px 高的标签一大截）。
  2. `.tab` = `flex: 0 1 auto` + `min-width`：**先收缩再滚动**（VS Code tabSizing），
     不是一超宽就溢出。
  3. **全量重绘会重置 `scrollLeft`**：必须在 `host.textContent = ""` **之前**存下、
     之后还原（`prevScroll`），否则每次激活/关闭标签标签栏都跳回最左端。
  4. **活动标签定位用 `ensureVisible()` 手工几何，不用 `scrollIntoView()`** ——
     后者会连带滚动所有祖先容器（分屏/嵌套布局整页跳），而且 jsdom 没有它（测试跑不了）。
     「已可见就不动」是天然满足的，等价于老实现靠 `activeChanged` 门控换来的行为。
  5. 只在**活动标签真的换了**时才定位（`lastActiveId`），否则会把用户滚出去的
     位置无条件拽回来——活动标签在右外侧（新开文件的常态）时表现为「滚不动」。
  6. 滚轮做 `deltaMode` 归一化（0=像素 / 1=行×16 / 2=页×可视宽）：某些驱动按「行」
     上报，delta 只有 3，当像素用几乎滚不动。没溢出 / 已贴边时不 `preventDefault`。
  - **B32–B47 的「可见窗口 + `.tab-more` 下拉折叠列表」已整体删除**，连同上述不变量
    需要的 `ResizeObserver`、`liveStrips` 记账、`reanchorStart`、`fitCountFromEnd`、
    `keepOpen` 菜单原地刷新 —— 这些能力**浏览器原生滚动全部自带**。净删约 150 行。
- **拖拽插入线必须补偿 scrollLeft**（B53）：`.tab-insert` 绝对定位在 strip 内，
  `left` 走**内容坐标**（会随内容一起滚），而 `getBoundingClientRect` 的差值是**视口坐标**。
  `splitview.stripInsertInfo` 必须 `+ strip.scrollLeft`，否则滚动过的标签栏上插入线
  画在错误的标签之间。其余用例 `scrollLeft` 恒为 0，正好掩盖这个 bug ——
  `tabstrip-drag.test.ts` 里显式造了个非零值来锁它。
- **标签的 ● / × 共用一个固定尺寸槽位**（`.tab-action`，B53，VS Code 行为）：
  平时只见 ●（未保存）或留空（已保存），悬停标签才换成 ×。
  槽位尺寸**必须固定**，否则鼠标划过时标签宽度变化、整排标签左右抖动。
  代价：× 不再常驻，键盘/触屏略弱（Ctrl+W 与右键菜单仍在）。
- **活动标签顶部 accent 条用 `::before` 画**，不能用 `box-shadow` ——
  `.tab-flash` 的关键帧也在改 `box-shadow`，用它会盖掉强调条。
- **面板区**（B53）：面板操作栏 = 3 个矢量图标按钮（`ICONS.splitH` / `splitV` /
  `closePanel`），替代原来的 `⨯` 文本字形。分屏按钮必须传**本面板** panelId
  （`cb.onSplitPanel(panelId, "h")`），不是"当前活动面板"；空面板禁用分屏。
  **焦点面板**（`.layout-panel-active`）的视觉 = 非活动分屏的活动标签降亮度。
  它只能靠切 class 同步（`main.ts` 的 `markActivePanel()`）——
  ⚠️ 切面板时**绝不能重绘标签条**：会销毁光标下的 `.tab`，点标签"要点两下"（B33 的坑）。
- **分隔条统一「细线 + 宽命中区」**（B53）：`.layout-sep*` 与 `.toc-resizer` 都是
  7px 透明命中区 + `::after` 画 2px 线、悬停高亮 accent。两者**必须同款**（B28 的约定），
  改一个就要改另一个；`regressions.test.ts` 直接断言两者 `flex` 宽度相等。
- **弹层的两种选中态别混用**：`checked`（打 ✓，语义是「开关」）vs `active`（整行走
  `.menu-item-current`，语义是「你当前在这儿」）。
  ⚠️ 折叠列表是 `active` 语义的**唯一调用方**，已随 B53 删除 ——
  `menu.ts` 的 `MenuItem.active` 与 `.menu-item-current` 样式目前**无使用者**，
  属待清理项（未删是因为 menu 是共享模块，超出本次改动范围）。

- **图标**：`scripts/gen_icons.py` 纯矢量自绘；四角圆角用「alpha 与垂直镜像取 min」保证上下一致；
  改图标后必须重跑 `tauri build` 才会进 exe（`src-tauri/build.rs` 已 `rerun-if-changed=icons`，
  否则增量构建会**静默**沿用旧图标，B41 踩过）。
  方案 B（当前采用）的几何全部收在 `B_*` 常量里：`B_CARD / B_PEN_LENGTH / B_PEN_CENTER /
  B_PEN_ANGLE / B_CARD_SHADOW`。钢笔是 135° 对角线，笔尖 = 中心 + (长度/2)·(-0.707,+0.707)，
  改长度会**同时**移动两端，要定点落笔就得反算中心。`B_CARD_SHADOW=False` 表示纸面无投影。
  **验收方式**：从 exe 里按 PNG 签名抠出内嵌图标，与 `src-tauri/icons/icon.ico` 逐条 sha256 比对。

## 8. 通用教训

- **跨 IPC 的 DTO 命名必须两侧对齐，且要有测试锁住**（B49）。Rust `TabSession` /
  `SessionState` 只有 `#[serde(default)]` 没有 `rename_all`，字段是 snake_case，
  而 `src/ipc/api.ts` 的接口与 `main.ts` 读的是 camelCase（`st.viewMode` / `sess.activePanel`）。
  后果**两个方向同时坏**：前端发来的 `viewMode` 被 serde 当未知字段丢弃，
  落盘写出的 `view_mode` 前端又读不到 —— 表现得像「会话恢复就是不好用」：
  重启后光标回到第 1 行、预览模式丢失、活动面板错位，**全程不报错**。
  **为什么长期没被发现**：会话相关测试全部 mock 了 `loadSession`，只走 JS 侧，
  serde 这一层从没被真跑过。
  对策：① 前端用的字段一律给 Rust 加 `rename_all = "camelCase"`（`TabInfo`/`OpenedFile` 本来就是这样）；
  ② 换格式时对旧字段加 `serde(alias = "old_name")` 兜住旧文件；
  ③ **补一个真正过 serde 的 round-trip 测试**（`session::tests`），
  断言「能读入 camelCase + 落盘也是 camelCase + 旧 snake_case 仍可读」——
  只测 JS 侧的 mock 测试永远抓不到这类问题。
  推论：凡是前端 mock 掉 IPC 的模块，都要另外在 Rust 侧补一条真实序列化测试。
- **`cargo build --release` 得到的 exe 是 devUrl 变体**：`custom-protocol` feature 只由
  `tauri build` 打开，直接 `cargo build --release` 出来的 exe 会去连 `http://127.0.0.1:1420`，
  运行起来是「无法访问此页面 / ERR_CONNECTION_REFUSED」。**要能跑、要打包就一律走
  `node node_modules/@tauri-apps/cli/tauri.js build`**（只想快速过编译错误才用 cargo build）。
- **「同步改 UI + 之后才 await」= 中间态会被真的绘制出来，用户看到的就是「闪一下」**（B45）。
  典型写法：为了让某个只作用于**当前活动项**的函数能复用，先把目标项切成活动项，
  然后 `await ask(...)` —— 切换是同步的、浏览器在 await 处就会重绘。
  修法两条：① 把该函数改造成**按指定实例寻址**（本项目是 `saveDocCore(doc, inst, forceDialog)`，
  只保存活动标签的 `doSave` 才是罪魁），别靠切换 UI 来"喂"它；
  ② 收尾逻辑要判断**被操作的是不是当前显示的那一项**，不是就别动显示内容。
  **测法**：在点击后**同步采样** DOM/视图快照（此时旧实现已经改完了），
  这个断言能精确锁住「闪一下」，并且把 `switchTab` 加回去验证它会失败。
- **CodeMirror 内置键位会静默吞掉应用快捷键，并可能改写文档**（B42 实测，已锁进
  `tests/editor-keymap-conflicts.test.ts`）。CM `defaultKeymap` 的 `Mod-/`（切换注释）
  会抢走应用的 `Ctrl+/`，在 Markdown 下**往正文插入 `<!-- -->`**；`Shift-Alt-ArrowDown`
  （整行复制）会抢走 `Alt+Shift+↓`（垂直分屏）。**二者都不会报错**，只表现为「快捷键失灵 + 文档被改」。
  对策：① 应用全局 `keydown` 挂**捕获阶段**并 `stopPropagation`，先于 CM 拿到事件；
  ② 用 `shortcutApplies(id)` 对非 Markdown 文件放行 `view.toggle`，保留 CM 原生注释切换。
  **推论**：任何「按了没反应」的应用快捷键，先怀疑 editor 的 keymap，再用真实 `defaultKeymap`
  探针实测（不要凭记忆断言）。
- 改方案/改名时要**连注释与 docstring 一起清**——静态断言会抓到注释里的旧字符串（B34）。
- 一个测试文件内多个用例**共享模块状态**（`main` 只 bootstrap 一次、按钮是 toggle）；
  多用例文件必须先确保 UI 状态再操作，否则假阴性（B33）。

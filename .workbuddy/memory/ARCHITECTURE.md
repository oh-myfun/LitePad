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
- **设置**（B42 后）：偏好已收口到「设置」菜单。**首选项 = 二级子菜单**（`menu.ts` 的 `submenu`），
  含 主题三态/预览行距三档/大纲宽度三档/新建默认行尾/新建默认编码；**快捷键…** 打开可编辑面板
  （`src/shell/keymapdialog.ts`）。改偏好统一走 `persistSettings()`。
  仍无设置**对话框**，但快捷键面板本身是一个模态浮层。
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
- **标签栏溢出**（B44 重写过）：不用滚动条。`renderTabstrip` 先全量渲染 → 测量 → 裁剪，
  区间外折叠进 `.tab-more` 下拉，滚轮改 `start`。三条**不能违反**的不变量：
  1. **尺寸变化必须重算**：`watchStripSize()` 用 `ResizeObserver` 观察标签栏自身宽度
     （顺带覆盖拖分屏分隔条——那**不触发** `window.resize`），无 RO 时退化 `window.resize`，
     用 rAF 合并。`WeakMap` 不能遍历，故另存 `liveStrips` 集合并在注册/重排时剔除 `!isConnected` 节点。
  2. **活动标签的拉回只在 `activeChanged` 时生效**（左右两侧规则都要这个门），
     否则滚轮向左滚会被无条件拽回——活动标签在窗口右外侧（新开文件后的常态）时表现为"滚不动"。
  3. **窗口必须铺满预算**：`fitCountFromEnd()`——关标签后 `start` 被夹到末尾时
     `fitCount` 只剩 1 个，会显示成「明明还放得下 2 个却只显示 1 个」。
     只在**没铺满**时左移补满，已铺满不动（免得把用户滚出来的位置拽走）。
- **图标**：`scripts/gen_icons.py` 纯矢量自绘；四角圆角用「alpha 与垂直镜像取 min」保证上下一致；
  改图标后必须重跑 `tauri build` 才会进 exe（`src-tauri/build.rs` 已 `rerun-if-changed=icons`，
  否则增量构建会**静默**沿用旧图标，B41 踩过）。
  方案 B（当前采用）的几何全部收在 `B_*` 常量里：`B_CARD / B_PEN_LENGTH / B_PEN_CENTER /
  B_PEN_ANGLE / B_CARD_SHADOW`。钢笔是 135° 对角线，笔尖 = 中心 + (长度/2)·(-0.707,+0.707)，
  改长度会**同时**移动两端，要定点落笔就得反算中心。`B_CARD_SHADOW=False` 表示纸面无投影。
  **验收方式**：从 exe 里按 PNG 签名抠出内嵌图标，与 `src-tauri/icons/icon.ico` 逐条 sha256 比对。

## 8. 通用教训

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

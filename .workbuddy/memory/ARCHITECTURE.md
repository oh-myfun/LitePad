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
- **最大化（B71）= 只改比例，不动结构**：`maximizePanel()` 沿「根→叶」把各层 ratio 推到 0/1
  并返回原比例快照；面板/标签/编辑器实例全保留，被挤的一侧靠 `.layout-panel-collapsed`
  收成 0（`.layout-panel` 有 `min-width:120px`，只推比例收不掉；也**不能**用 `display:none`，
  会销毁 CodeMirror 度量）。
  - 任何改布局的操作（分屏 / 关面板 / 挪标签 / 拖分隔条）前必须 `exitMaximize()`，
    否则得到「一半 0 宽」的布局且还原快照同时失效。
  - **会话存未最大化的比例**（`layoutForSession()` 还原到副本上）：0/1 进 session
    会让下次启动只剩一块面板。最大化态本身不持久化。
- 整组拖拽（B71）起手判据是 `e.target === strip`（VS Code `onGroupDragStart` 同款）：
  写成「点在 strip 上就算」会把拖单个标签变成拖整组。

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
- **标签拖拽的浮动影像**（B64，`.tab-drag-ghost`）：指针编排的拖拽拿不到浏览器的原生
  拖拽影像，所以自己造一个跟随光标的浮层。对标 VS Code
  `multiEditorTabsControl.ts:1295` 的单标签档 `setDragImage(tab, 0, 0)`：
  - **影像是原标签的克隆**（图标/文件名/未保存点/配色一并带过来），**不能搬走原标签** ——
    原地不动的原标签才是用户判断「拖到哪儿了」的参照物。
  - **锚点 = 左上角**：`left/top` 直接写 `clientX/clientY`（对齐 `setDragImage(tab, 0, 0)`
    的语义；VS Code 的注释说明这是为了给落点边框反馈让位）。
  - ⚠️ **`pointer-events: none` 不能省**：否则鼠标划过影像会掐断其下方元素的 `:hover`，
    自绘提示层也可能把影像当成悬停目标。另外克隆时必须剥掉 `data-tab-id`（否则
    「按 tabId 查元素」的逻辑会命中副本）与 `data-tip*`（副本不是真标签，不该接提示）。
  - ⚠️ **克隆的读取时机**：影像在**越过 `DRAG_THRESHOLD` 那一刻**才创建（纯点击不该闪出副本），
    且**必须每次 `mousemove` 都跟随**，位置更新要放在「离开面板就 `return`」**之前** ——
    拖到面板之外时影像同样得跟着走，否则会僵在最后一个面板上。
  - 三条清理路径缺一不可：`mouseup` 收尾、连续第二次拖拽进入时先清场、
    **窗口 `blur`**（拖到窗口外松手收不到 `mouseup`，不加这条会留下一个跟不动的幽灵标签）。
  - ⚠️ 有意偏离 VS Code 一处：原生影像是元素快照，非活动标签底色本就是透明的；
    本浮层要盖在编辑器/预览等任意内容上，透明底会糊成一片 —— 故补 `--bg-elevated` 底色
    + 内侧描边（`outline` + `offset:-1px`，照搬 `.monaco-drag-image` 的写法，用 `outline`
    而非 `border` 才不会撑大盒子）+ 阴影。想调观感只动 `.tab-drag-ghost` 一处。

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
  1. `.panel-tabstrip` = `overflow-x: auto` + `flex-wrap: nowrap`，滚动条 **4px**、无两端箭头。
     ⚠️ **必须显式复位 `scrollbar-width: auto; scrollbar-color: auto`**（B54 踩坑）：全局
     `*` 上有这两个标准属性时，元素上再写一遍会让 Chromium **忽略 `::-webkit-scrollbar`**，
     标签栏于是拿回系统滚动条 —— 两端带箭头、也压不细。复位后才轮到自绘规则生效。
  2. **标签栏高度是硬约束，且是「4 + N + 4」三段**（B55 起，B57 把 N 从 20 提到 **24**，
     故现在是 **32 = 4 + 24 + 4**）：4px 上间距 + N px 药丸行 + 4px 下间隙；
     **那 4px 滚动条正好吃掉下间隙**，所以滚动条出现/消失都不改变标签栏高度。
     标签靠 `align-items: flex-start` 钉在顶部 → 「溢出 ↔ 不溢出」不跳变（B53 踩过 26↔28px 抖动）。
     ⚠️ 改任一段都要改全部：`.tab` 高度、`strip` 高度、`::-webkit-scrollbar` 高度、
     `.tab-insert` 的 `top/bottom`。回归测试直接断言 `stripH - tabH === 滚动条高度 × 2`。
     （**N 必须有 24px 这一档**：VS Code `editorTabsControl.ts` 注释写明 20px 只是
     「刚够放 16px 图标 + 2px padding」的**下限**，放图标要 24px 才有呼吸。）
  3. `.tab` = **`flex: 0 0 auto`（不可收缩，B56）**：标签宽度 = **内容宽度**，
     **绝不因标签变多而被压窄**，放不下就直接横向滚动（对应 VS Code 的 `tabSizing: fixed`）。
     ⚠️ **这是一次反向翻转**：B53 曾是 `flex: 0 1 auto` + `min-width`（「先收缩再滚动」，
     模仿 VS Code 的 `tabSizing: fit`），用户反馈「标签变多后宽度被压窄、文件名被裁剪成
     `…`」。因此 `.tab` 上**不能有 `max-width`**、`.tab-name` 上**不能有
     `text-overflow: ellipsis` / `overflow: hidden`**（`min-width: 60px` 只作最小宽度下限保留）。
     回归用例会同时断言「有 `flex: 0 0 auto`」与「没有 `flex: 0 1 auto` / `max-width`」。
     💡 教训：**「标签太窄」和「标签太高」是这个 UI 里最容易被反复推翻的两项** ——
     改标签尺寸前先问用户要「收缩派」还是「自然宽度派」，别默认抄 VS Code 的 fit 模式。
     高度 **24px 固定**（B57；不用 padding 撑）：B53 曾改成 34px 方角平标签，
     用户反馈「太高了」→ B54 回退圆角 + 描边；固定高度保证字号档位变化时栏高恒定。
  4. **B55 起标签是 VS Code Modern UI 的「药丸」**（对标 `contrib/modernUI/browser/media/tabs.css`）：
     **无描边**、圆角 4px、间距 4px、非活动文字 = `color-mix(fg 50%, transparent)`、
     活动态**只靠 `--tab-bg-active` 底色**区分（原来靠描边）。
     三档底色 `--tab-bg-hover/-active/-active-hover` 必须**浅深两套主题齐补**，
     且三档要拉开可感知差距 —— hover 与 active 同色就分不出「划过」和「选中」。
     **B57 起高度走「常规档」24px**（B55 的 20px 是 compact 档），并且**名字前有文件类型图标**
     （见下文「标签的文件类型图标」）。
  5. **全量重绘会重置 `scrollLeft`**：必须在 `host.textContent = ""` **之前**存下、
     之后还原（`prevScroll`），否则每次激活/关闭标签标签栏都跳回最左端。
  6. **活动标签定位用 `ensureVisible()` 手工几何，不用 `scrollIntoView()`** ——
     后者会连带滚动所有祖先容器（分屏/嵌套布局整页跳），而且 jsdom 没有它（测试跑不了）。
     「已可见就不动」是天然满足的，等价于老实现靠 `activeChanged` 门控换来的行为。
  7. 只在**活动标签真的换了**时才定位（`lastActiveId`），否则会把用户滚出去的
     位置无条件拽回来——活动标签在右外侧（新开文件的常态）时表现为「滚不动」。
  8. 滚轮做 `deltaMode` 归一化（0=像素 / 1=行×16 / 2=页×可视宽）：某些驱动按「行」
     上报，delta 只有 3，当像素用几乎滚不动。没溢出 / 已贴边时不 `preventDefault`。
  - **B32–B47 的「可见窗口 + `.tab-more` 下拉折叠列表」已整体删除**，连同上述不变量
    需要的 `ResizeObserver`、`liveStrips` 记账、`reanchorStart`、`fitCountFromEnd`、
    `keepOpen` 菜单原地刷新 —— 这些能力**浏览器原生滚动全部自带**。净删约 150 行。
  - ⚠️ **`.tab-flash` 的关键帧结束态必须写 `var(--tab-bg-active)`**（B55）：原来写的是
    `var(--bg)`，药丸化后不改就会「闪完回到旧配色」。一帧的视觉 bug，运行时测不出来 →
    靠 `regressions.test.ts` 静态锁。
  - ⚠️ **非活动面板降亮度规则要连 `:hover` 一起覆盖**（B55）：否则鼠标划过非焦点面板时
    药丸会「亮回来」，比不降级更迷惑焦点。见 `.layout-panel:not(.layout-panel-active) .tab-active:hover`。
- **拖拽插入线必须补偿 scrollLeft**（B53）：`.tab-insert` 绝对定位在 strip 内，
  `left` 走**内容坐标**（会随内容一起滚），而 `getBoundingClientRect` 的差值是**视口坐标**。
  `splitview.stripInsertInfo` 必须 `+ strip.scrollLeft`，否则滚动过的标签栏上插入线
  画在错误的标签之间。其余用例 `scrollLeft` 恒为 0，正好掩盖这个 bug ——
  `tabstrip-drag.test.ts` 里显式造了个非零值来锁它。
- **标签的 ● / × 共用一个固定尺寸槽位**（`.tab-action`，B53，VS Code 行为）：
  **已保存**：平时留空，悬停标签 / 活动标签给 ×；
  **未保存**：平时 ●，**只有指针进到这个槽位（关闭按钮区域）才换成 ×**（B66，用户要求）。
  槽位尺寸**必须固定**，否则鼠标划过时标签宽度变化、整排标签左右抖动。
  ⚠️ **B57 起显隐走 `opacity`（0→1），不再用 `display: none`**（对齐 VS Code 的覆盖层做法）：
  布局本来就靠固定槽位锁住，opacity 还能顺势淡入。**副作用必须知道**：
  槽位结构**恒定存在于 DOM**（连「已保存」的 ● 也在，只是 `opacity: 0`），
  所以**任何「脏状态」断言都不能再看 `.tab-mark` 的文本/存在性**，
  要改判 `.tab.tab-dirty` 这个 class（`tabstrip-scroll` / `smoke.bootstrap` /
  `view-switch-noedit` 三处用例已按此改写）。
  - ⚠️ **换装判据必须挂在关闭区（`.tab-action`）上，不能挂在标签（`.tab`）上**（B66）：
    挂到标签上 = 「指针划过文件名 ● 就消失」，不是用户要的。
    上游同款：`.tab.dirty > .tab-actions .action-label:not(:hover)::before`
    取 `circle-filled`（`multieditortabscontrol.css:491`），它的「关闭区」就是 label 自己的盒子。
    连带要求 **× 必须铺满槽位**（`.tab-mark, .tab-close { position:absolute; inset:0 }`），
    否则指针压在 ● 上却换不出 ×。
  - ⚠️ **● 与 × 的互斥只能写成一条 CSS `:not()` 链**（B65 定、B66 换判据）：
    现在是一句 `.tab-dirty .tab-action:not(:hover):not(:focus-within) .tab-mark { opacity: 1 }`。
    × 有四个出场口，其中「关闭区悬停 / 关闭区聚焦」两档对脏标签也生效，所以必须被上面这条排除；
    另两档（`.tab:hover` / `.tab-active`）自带 `:not(.tab-dirty)`，不可能与 `.tab-dirty` 撞上。
    ⚠️ **两档为什么不合并成「活动标签常驻 ×」**：B57 曾让活动标签无条件给 ×，而
    「未保存的当前标签」必然同时带 `.tab-dirty` 与 `.tab-active` → ● 与 × 双双 `opacity: 1`
    叠死在槽位里（B65），且与 B66 的要求直接冲突。
    ⚠️ 条件必须写全在**一条**规则里，不能退回「● 常驻 + 几条压回 0 的补丁」：
    后者与 `.tab-dirty` 同特异度，只能靠源码顺序取胜，调样式表顺序就静默失效。
    B64 的拖拽影像克隆的正是活动标签、副本永不 `:hover`，由同一条规则兜住 ——
    所以影像拖动未保存标签时稳定显示 ●（静息态，见 §4）。
    ⚠️ **非活动面板的 × 降亮度必须与上面四个出场口逐条对齐**：无条件写
    `.layout-panel:not(.layout-panel-active) .tab-close { opacity: 0.5 }`（B57 老写法）
    会让非焦点面板里**每个**标签常驻一个 50% 的 ×，未保存标签的 ● 直接跟它叠在一起；
    漏掉 B66 新增的两档同样会让脏标签在非焦点面板里复发。**这个坑已经连踩两次（B65/B66）**，
    改任一侧都要同步另一侧。静态锁在 `regressions.test.ts` 的 B65 / B66 块。
- **标签的文件类型图标**（B57，对应 VS Code 的 `.tab.has-icon`）：名字左边一个 **16px**
  家族字形，`.tab-icon[data-fam]` 取 `--ficon-*` 配色（**浅深两套主题各 10 个**，缺一个就是
  某主题下该家族图标没颜色）。字形与家族映射在 **`src/shell/fileicons.ts`**（零依赖内联 SVG，
  `strokeIcon` 产出；不引图标库）—— 10 个家族覆盖 `language.ts` 注册表**全部 56 个 label**，
  未知 / `null` 回落 `txt`。语言标签由 `main.ts` 经 `TabViewData.lang` 传下来
  （漏传 ⇒ 所有标签静默退化成灰色三条横线，回归测试锁覆盖度）。
- **标签视觉的摇摆史（别再来一轮）**：
  B53 曾用 `::before` 画 2px 顶部 accent 条 + 34px 方角平标签 → 用户嫌「太高、风格要退回」；
  B54 回退成 24px 上圆角 + 1px 描边 + 强调条删除（**当时活动态 = 底色 + 描边**）；
  B55 再改成 VS Code Modern UI **药丸**（20px、无描边、圆角 4px、只靠底色区分）；
  B56 标签改不可收缩；B57 把药丸升到 **24px** 并加**文件类型图标**。
  ⚠️ 教训：**「描边」是这套 UI 里最容易被反复推翻的一项**。改活动标签的识别方式前，
  先确认用户要的是「描边派」还是「底色派」—— 两条路线的可见性差异在浅色主题下尤其大。
  高度/宽度同理：**「太高」「太窄」各已被推翻一次**，动手前先问，别默认抄 VS Code 的档位。
  accent 条那条不能回来的原因见上：`box-shadow` 会被 `.tab-flash` 的动画结束态盖掉。
- **面板区**（B54）：面板操作栏**只剩「移除分屏」**一个矢量图标按钮（`ICONS.closePanel`）。
  B53 曾加过 `ICONS.splitH` / `splitV`，B54 按用户要求去掉 —— 分屏改由**把标签拖到面板边缘**
  （`zoneOf` + 拖拽落点）；`cb.onSplitPanel` 回调与接口字段一并删除。
  ⚠️ **删按钮 ≠ 删功能**：菜单「视图 → 左右/上下分屏」与快捷键（`panel.splitH`/`splitV`）
  仍然走 `main.ts` 的 `splitActivePanel(activePanelId, dir)` —— 回归测试同时锁「按钮没了」+「菜单/键位还在」。
  **焦点面板**（`.layout-panel-active`）的视觉 = 非活动分屏的活动标签降亮度。
  它只能靠切 class 同步（`main.ts` 的 `markActivePanel()`）——
  ⚠️ 切面板时**绝不能重绘标签条**：会销毁光标下的 `.tab`，点标签"要点两下"（B33 的坑）。
- **分隔条统一「细线 + 宽命中区」**（B53）：`.layout-sep*` 与 `.toc-resizer` 都是
  7px 透明命中区 + `::after` 画 2px 线、悬停高亮 accent。两者**必须同款**（B28 的约定），
  改一个就要改另一个；`regressions.test.ts` 直接断言两者 `flex` 宽度相等。
  **B59 起线色统一走 `--sep-line`**（不再是通用 `--border`）：深色 `#444444`（对齐 VS Code
  `editorGroup.border`）/ 浅色沿用 `#dcdfe3`。改线色只动这一个变量，但**两条分隔条仍要一起改**。
- **分屏交互**（B59，对齐 VS Code；源码依据见 `docs/split-view-plan.md` 与
  `docs/vscode-reference/` 的 `sash.ts/css`、`splitview.css`、`editorDropTarget.ts`）：
  - 分隔条缩放统一走 `splitview.ts` 的 **`attachResize(handle, targets[], mode)`**：
    `targets` 是「一对兄弟元素 + 容器 + ratio 回写路径」。普通分隔条 1 个目标；
    **角手柄 2 个目标**（父 + 子，轴相垂直）→ 斜向拖动同时改两条比例。
  - **双击均分**（B63 起不再是「一律 50%」）：沿**同轴链**把每条分隔条调成
    「两侧同轴段数相等」（`chainId` + `segmentsAlong` → `equalRatio`），
    2 段 = 50%、3 段 = 1/3·1/2、4 段 = 1/4·1/3·1/2；逐层累乘后每格等宽。
    拖到极限加 `.at-min`/`.at-max` 变形光标、拖拽中加 `.resizing`
    保持高亮（只写 `:hover` 时鼠标滑出 7px 细线就失色）。
  - ⚠️ **`body.layout-dragging` 是三处共用的**（分屏分隔条 / 大纲 `toc.ts` / 查找栏 `findbar.ts`），
    默认光标 = 横向拖拽档。B59 给垂直分隔条叠加 `.layout-dragging-v`；
    **新增方向修饰类，不要改基础类的语义**，否则大纲/查找栏的横向拖拽光标会一起错。
  - **B61 光标取 VS Code 的「非 mac 档」**（`sash.css`，Windows 才这么渲染）：
    竖线 `ew-resize` / 横线 `ns-resize`，极限档 `e-resize`/`w-resize`/`s-resize`/`n-resize`，
    正交角手柄 **`all-scroll`**。
    ⚠️ **`col-resize` / `row-resize` 是 VS Code 的 mac 档**（`.monaco-sash.mac.*`）——
    Windows 上 `col-resize` 渲染成「双箭头中间多一根竖杠」，和 VS Code 一眼就能看出不同。
    ⚠️ 角手柄用 `all-scroll` 而非斜向箭头：`sash.css:63` 的基础光标就是 `all-scroll`，
    那几条 `nwse/nesw-resize` 覆盖规则要求 `.orthogonal-edge-north/south`，
    而该属性**只有 `resizable.ts` 设**、`gridview.ts` 从不设 —— 网格里的角手柄恒为 `all-scroll`。
    ⚠️ 断言「不得残留 col-resize / row-resize」时必须**先剥掉 CSS 注释**：注释里正是要写
    「为什么不用 col/row」，对全文断言会把说明文字当违规（B61 踩过一次）。
  - **角手柄**挂在**子分隔条的相接端**（位于 a 侧 → `end`，b 侧 → `start`），双类写法对齐
    VS Code 的 `.orthogonal-drag-handle.start/.end`；只在 `child.dir !== node.dir` 时生成。
    同行/同列嵌套（如两条竖线）**不生成**角手柄。
  - **落点 `zoneOf`**：两轴都在 **28% 边缘带**以内 = `center`；否则按 VS Code 的
    **1/3 方向优先**定方向（左右各占外侧 1/3，中 1/3 才轮到上/下）—— 角部归左右。
    ⚠️ jsdom 无布局（宽高 0）时必须早退 `center`，否则 NaN 判定会落到意外分支。
    ⚠️ `zoneOf` 同时被**文件拖入**（`main.ts` 的 `showFileDropPreview` / `fileDropTargetAt`）复用，
    改动要一起回归。
  - **Alt 拖拽 = 临时取消分屏**：在 `splitview.ts` 的落点处理里把 edge zone 改判为 `center`
    （预览同步切换），**不需要动 `main.ts`** —— `onDropTabToPanel` 的签名保持 `(zone, …)` 不变。
  - ⚠️ **`tabstrip-drag.test.ts` 有源码级静态断言**：`clearInsertIndicators();` 必须紧跟
    `const zone = zoneOf(`（`onTabDragMove` 里）。改这段代码要保持这个形状。
  - **空面板自动收起**（O8）**早在 B45 前就有**：`closeTabById` / `moveTabToPanel` /
    `splitPanelWithTab` 三处都在「源面板空了且非唯一」时调 `disposePanel`，
    而 `layout.ts` 的 `removePanel` + `promoteSibling` 的 ratio 补偿就是「邻居吃满」。
  - **B60：分隔条改成「不占布局」的浮层**（用户反馈「有点粗」）。根因不是线宽而是**占位**：
    `flex: 0 0 7px` 的透明空档把两侧撑开、露出祖先底色（标签栏行上是 `--bg-status` vs `--bg`），
    看着就是一条 7px 粗带。VS Code 的 sash 是 absolute 浮层、完全不占位。
    现在：元素 `flex: 0 0 0` → **主轴尺寸 0、交叉轴仍 stretch 成满长**（所以
    `.layout-sep-h::before` 敢写 `top:0;bottom:0`、`.layout-sep-v::before` 敢写 `left:0;right:0`）；
    7px 命中区搬到 `::before` 向两侧各溢出 3.5px；视觉线 `::after` 静息 1px、激活 4px。
    ⚠️ **角手柄必须跟着改成骑线**（`top/left: -4px` + 8px），原先 `top:0/left:0 + 7px`
    是贴着已经消失的 7px 带摆的。
  - **B60：对齐联动**（对标 VS Code 2x2 的 `linkedSash`）：`sashRegistry`（真实分隔条，
    角手柄不登记，但**它的目标**登记在案）+ `centerOf()` + `alignedSashesOf(self)`，判定是
    **同向 + 中线差 ≤ 2px**（比 VS Code 的「2x2 且首子尺寸相等」更通用，能覆盖 3×2 网格）。
    ⚠️ `sashRegistry` 必须在 `renderSplitview` 里清空（B63 起 `chainSeq` 也一并归零）——
    否则拿已脱离文档的旧句柄算对齐时 `centerOf` 恒为 0，会误判成「全部对齐」。
    ⚠️⚠️ **`centerOf` 判空必须看交叉轴，不能看主轴**：分隔条是 `flex: 0 0 0` 的浮层，
    主轴尺寸**恒为 0** —— 按主轴判空（`len > 0`）会让它恒返回 `null`、`alignedSashesOf`
    永远拿到空数组，**联动一次都不会生效**（这就是 B60 首版的真机 bug）。正确写法是
    `cross = dir === "h" ? r.height : r.width`；主轴为 0 恰好意味着 `left`/`top` 就是界线。
    判据与 VS Code 的 `trySet2x2`（要求两分支首子尺寸相等）在两行等宽时**等价**。
    ⚠️ **测试桩必须忠实于真实几何**：原用例把分隔条 rect 桩成 4px 宽（= B60 之前的几何），
    正好掩盖了上面这个 bug。改几何的改动，务必回头核对 test 里的 rect 桩。
    ⚠️⚠️ **凡是「先读几何、再据此行动」的路径，都必须先取快照再动手**（B62）：
    `dblclick` 复位时若先 `applyTarget(self, 50)` 再调 `alignedSashesOf`，本条已被挪走、
    与联动条差了几百 px，集合为空 → 「只有点中的那条居中」。**先取集合，再统一改比例。**
    ⚠️ **纯点击（无 `mousemove`）不得回写比例**（B62）：命中区 7px 宽，指针常落在离界线
    几个像素处，一次点击就能把比例推走约 1%（400px 容器 ≈ 4px），而对齐容差只有 2px ——
    **点一下就把两条对齐的线推出容差，之后拖谁都不再联动**。故 `mousedown` 记 `moved`，
    只有真收到 `mousemove` 才在 `onUp` 回写（VS Code 的 sash 同样是「没 move 就不改尺寸」）。
    ⚠️ **rect 桩不能是常量**：上面两个 bug 都只有「桩随 inline `flexBasis` 实时变化」才暴露。
    见 `tests/splitview.test.ts` 的 `stubVerticalSash()`（读左栏 inline basis 算界线位置）。
  - **B63：「一起动的那一组」只有一个入口 —— `movingGroupOf(targets)`**
    = 每个拖拽目标**自身** + 与它**同向对齐的伙伴**。
    ⚠️ **四处（`mouseenter` 悬停预告 / `mousedown` 高亮 / `onMove` 应用 / `onUp` 回写）
    必须全走它**，否则会出现「高亮了一组、实际只动了一条」的错位。
    - **交叉点（角手柄）也联动**：角手柄有 **2 个目标、轴互相垂直** → 两轴各自的联动组
      都并入。用户原话「在交叉点拖动时，也要支持联动（高亮和一起拖动）」。
      B60/B62 的 `mode === "corner" ? [] : …` 分支已删除，**不要再加回来**。
    - ⚠️⚠️ **角手柄必须复用子分隔条已注册的那个 `ResizeTarget` 对象**：
      `attachResize(cHandle, [self, child.target], "corner")`，`child.target` 来自
      `BuiltNode.split.target`。注册表按 **target 身份**（`sashOfTarget`）查伙伴，
      另造对象会让查找落空 → 子轴一侧的联动**静默失效**（不报错，最难查）。
    - **双击 = 按分割数量均分**（用户明确「不一定是居中」）：`chainId` 认链、
      `equalRatio = segA/(segA+segB)` 给比例，双击时把**整条链**（含各条的联动伙伴）一起调。
      不同向的嵌套各自成链，互不干扰。
    - ⚠️ **连带推翻的旧断言**：B59 的「父分隔条不得被连带激活」判据本身就与 B63 冲突
      （角手柄拖起来时子分隔条**本该**高亮）。`stopPropagation` 这条不变量仍要守，
      但判据要换成**回写次数**（一次斜拖恰好 2 条），不能再看 `resizing` class。
  - **B60：落点高亮回退浅蓝、不描边**。`--drop-fill` 回到 accent 系 @0.22（深 `#4c9ffe` /
    浅 `#0969da`）；B59 照搬 VS Code 的 `dropBackground`（深灰@0.5 / 浅蓝@0.18）在 LitePad 上
    落点边界看不清。中间短暂加过 2px 同色描边，用户明确「不用描边」后去掉 `border`，
    **填充值一字未动**（去的是那圈深边，区域内侧观感不变）；圆角 4px 保留。
    想调浓淡只改 `--drop-fill` 一处。
- **弹层的两种选中态别混用**：`checked`（打 ✓，语义是「开关」）vs `active`（整行走
  `.menu-item-current`，语义是「你当前在这儿」）。
  ⚠️ 折叠列表是 `active` 语义的**唯一调用方**，已随 B53 删除 ——
  `menu.ts` 的 `MenuItem.active` 与 `.menu-item-current` 样式目前**无使用者**，
  属待清理项（未删是因为 menu 是共享模块，超出本次改动范围）。

- **提示（tooltip）自绘层**（B58，`src/shell/tooltip.ts` + `global.css` 的 `.tooltip` 段）：
  **全应用弃用原生 `title`**，改 `data-tip` 系列属性 + 全局单例 `.tooltip` 层。
  动机：原生提示由 OS 绘制，**配色/圆角/键帽/延迟全不可控**，深色界面里会弹出一个浅色系统气泡。
  - **检索方式**：`document` 上 `mouseover/mouseout/focusin/focusout/mousedown` 委托
    （`window` 上 `scroll/resize/blur` + `Esc`）—— 标签栏/查找结果/大纲都是整块重绘的，
    逐个挂钩子要么漏、要么得在每次重绘后重挂。
  - **定位**抽成纯函数 `computeTipGeometry(target, tip, viewport, preferred)`（jsdom 无布局，
    只能喂数字测）：垂直越界翻面、水平夹进视口、caret 默认居中/越界改对准目标中心/最后夹进框内。
  - **秒开规则**取 VS Code `groupId`：同 `data-tip-group` 内已有提示显示时，下一个**秒开且不淡入**
    （顺着工具栏滑过去提示跟手、不闪）。
  - **数值全部有出处**（VS Code，见 `tooltip.ts` 模块注释，逐条列了源文件）：
    `13px/19px`、`padding:4px 8px`、**带指针档圆角 3px**、`PointerSize=3`/`EdgeMargin=2`、
    `workbench.hover.delay=500`（仅 Windows，本项目就只跑 Windows）、键帽 `11px/min-width 12px/3px 圆角`。
  - **两处有意偏离 VS Code**（改前先读 `tooltip.ts` 顶部）：① `max-width:420px`（VS Code 700px，
    那是给树视图长文本留的）；② 提示层 `pointer-events:none`（**否则鼠标从目标滑到提示上会掐断
    目标的 `:hover`、提示闪烁**；代价是提示文字不可选中，不需要）。
  - ⚠️ **`[hidden]` 必须显式 `display:none`**：`.tooltip` 自身是 `display:flex`、
    `.tooltip-key` 也是 `display:flex`，会盖掉浏览器对 hidden 默认的 `display:none`
    （同 B30 查找栏的坑）；`.tooltip-key[hidden]` / `.tooltip-detail[hidden]` 两处都写了。
  - ⚠️ **`setTip` 会顺带补 `aria-label`**：原生 `title` 兼任图标的可访问名，
    换成 `data-tip` 后图标按钮会「失名」；只对**自身无文本且无 aria-label** 的元素补，不覆盖调用方。
  - ⚠️ `resetTooltipsForTest()` **故意不重置 `bound`**（监听器生命周期与 `document` 一致，
    反复 `initTooltips()` 只会重复注册）。要重绑请开新文档。
  - 回归：`tests/tooltip.test.ts`（纯函数 + DOM 行为 20 条）+ `regressions.test.ts` 的 B58 块（静态锁样式/接线）。

- **保存体系（B68）：自动保存与热退出是两个独立开关，别混为一谈**
  - **自动保存**（`Settings.autosave`，对应 VS Code `files.autoSave`）写**原文件** → 脏标记清除。
    默认 **关**（对齐 VS Code 桌面版；B67 及更早是默认开）。
  - **热退出**（`Settings.hot_exit`，对应 VS Code `files.hotExit`）写**独立副本** → 原文件一个字节不动，
    默认 **开**。正因为它不动原文件，「关窗不弹确认框」才成立 —— **这个职责属于热退出，
    不属于自动保存**（VS Code 里 `hotExit=off` 的官方枚举说明原文就是
    "A prompt will show when attempting to close a window with editors that have unsaved changes."）。
  - 前端落点：`scheduleBackup()`（1s 防抖，挂在**与 `scheduleAutosave()` 同一个
    `textChanged && !suppressDirty` 门控**上）→ `flushBackups()`（关窗前 `cancelPendingBackup()`
    再同步兑现；判定是否跳过确认框必须**逐文档**查 `doc.backedUp`，不能只信返回值）
    → `discardBackupFor(doc)`（保存成功 / 转干净 / 重载 / 关闭标签 / 关掉热退出时都必须丢）。
  - Rust 落点：`src-tauri/src/backup/mod.rs`（副本读写 + 孤儿清理）+ `commands` 的四条命令
    `write_backup` / `restore_backup` / `discard_backup` / `discard_orphan_backups`。
    副本 = `%APPDATA%\LitePad\backups\<随机 ID>`，格式为 **魔数行 + 单行头部 JSON + 正文（UTF-8、LF）**；
    正文一律存 UTF-8，文档原本声明的编码记在头部 —— 副本因此与 GBK / UTF-16 原编码无关。
  - ⚠️ **副本 ID 必须过白名单**（`backup::is_valid_id`：ASCII 字母数字与连字符，长度 ≤64）。
    它由前端生成后**直接参与拼路径**，放行 `/` 或 `..` 就能把副本写到备份区之外。
    前端 `newBackupId()` 用 `crypto.getRandomValues` 产十六进制，两侧字符集必须一致。
  - ⚠️ **副本文件本身不含「这份副本属于哪个标签」的索引**，认领全靠 `session.json` 里的
    `TabSession.backupId`。于是「丢弃时机」本身就是正确性：漏丢 → 下次启动拿旧快照顶掉
    用户刚保存的内容；错删 → 未保存内容真的没了。
  - ⚠️ **孤儿副本清理只在会话读成功（`restored === true`）时做**。会话文件坏掉时 keep 是空表，
    一刀切清理等于删光用户全部未保存内容。**宁可漏删，不可错删**，漏掉的等下次成功启动再说。
  - ⚠️ 未命名文档在 B68 之前**完全不进会话**（`snapshotSession` 只收有 `path` 的文档），
    于是「从没保存过的草稿」关窗即丢。现在入会话判据是
    `有 path || 有副本 || （热退出开 && 无 path && 不脏）`。
  - ⚠️ **B69：空的未命名文档靠 `docId` 认领**。它既没有 `path`、也不脏（没输入过内容 →
    压根不会写副本），上面前两个判据都认不出它，于是整条被漏掉、重启后凭空消失。
    会话字段 `TabSession.docId`（Rust `doc_id`，= `doc::Doc::id`）既用于把它写进会话，
    也用于恢复时判断「哪些标签其实是同一个文档」——**必须按文档身份去重，不能按面板 /
    标签索引**：同一个空文档被分屏成两个实例时，按索引取两次就会恢复成两份互不相干的
    文档，破坏同源多实例（与 B68 那条「`restore_backup` 每次新建标签」是同一类坑）。
  - ⚠️ B69 的判定**必须带 `!d.dirty`**：若退化成「无路径就收」，会把「**脏、但备份失败**」
    的未命名文档也收进去，恢复时按空文档处理 → 真的把用户打的字丢掉。
    那种情况只能走关窗确认框（快照里没有它 → 恢复时也不会被当成空文档）。
  - ⚠️ 恢复是「**副本优先、文件兜底**」，两个方向都必须留着：副本读不到（已丢 / 写失败 / 格式坏）
    就退回按 `path` 打开原文件；B69 起「既无副本又无路径」= 空的未命名文档，**新开一个空白
    文档**（而不是跳过），且**不置脏**（没内容要存，置脏会亮 ●、关标签还要问「保存吗」）。
  - 回归：`tests/hot-exit.test.ts`（jsdom 真实 bootstrap：编辑只写副本不写原文件、
    有脏文档关窗不弹确认框且会话先落盘、空文档也要进会话且带 docId）
    + `tests/hot-exit-empty.test.ts`（**恢复方向**：会话里两个空标签 → 回来两个空白文档）
    + `regressions.test.ts` 的 B68 / B69 块（静态契约）
    + `backup::tests` / `commands::tests` / `session::tests`（副本格式、路径穿越、线上字段名）。

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
  **B68 补记：同一个坑又踩了一次，这次栽在 `OpenedFile` 上。** 该结构体早就标了
  `rename_all = "camelCase"`，于是 Rust 字段 `size_class` 出去的线上名字是 `sizeClass`；
  但 `src/ipc/api.ts` 的接口写成了 `size_class: string`，`main.ts` 也跟着读 `file.size_class`
  —— 恒为 `undefined` → `normalizeSizeClass(undefined)` 回落 `"normal"`
  → **M4 的「大文件分级降级」从上线起就没有真正生效过**，而且全程不报错。
  同结构体里的 `mixed_eol`→`mixedEol`、`lossy_chars`→`lossyChars` 早就写对了，
  只有**后加的** `size_class`/`size_hint` 漏了 —— **后加字段最容易漏，因为没人会回头重看注解**。
  对策：加一条**直接序列化 Rust DTO 的字段名契约测试**
  （`commands::tests::ipc_structs_use_camel_case_field_names`，断言线上是 `tabId` /
  `sizeClass` / `sizeHint` / `mixedEol`），再在 `regressions.test.ts` 里断言前端读的是 camelCase。
  这类测试断言的只是**字段名字符串本身**，比任何行为测试都便宜且精准，值得每个 DTO 都来一条。
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
- **原生 `title` 不是「轻量提示」，它是「不可控提示」**（B58）。它由操作系统绘制：
  配色/字体/圆角**跟不了应用主题**，加不了键帽与第二行小字，延迟也由 OS 定（约 1s）。
  凡是「要跟主题、要显示快捷键、要控制延迟」的提示，都得换成自绘层。
  代价与做法见 §7 的「提示（tooltip）自绘层」。
- 一个测试文件内多个用例**共享模块状态**（`main` 只 bootstrap 一次、按钮是 toggle）；
  多用例文件必须先确保 UI 状态再操作，否则假阴性（B33）。

## 9. 多窗口（B71 ④：卫星窗口）

用户选的是**完整多窗口**（新窗口与主窗口共享文档状态、标签可来回拖），不是「复制一份」。
因此「文档只有一个真相」这条不变量要**跨进程内的多个 WebView** 继续成立。

### 9.1 身份与归属

- **每个窗口启动的第一个 IPC 必须是 `window_payload()`**（`src-tauri/src/windows.rs`）。
  卫星窗口若先跑主窗口那套（`restoreSession` / `registerWindowClose` / `saveSession`），
  两个窗口会抢同一份 `session.json`，表现为「会话时好时坏」。
- **会话与关窗确认只归主窗口**：`scheduleSessionSave()` 在卫星窗口是空操作
  （闸门 `if (windowKind !== "main") return;`）。卫星窗口的标签进会话靠主窗口的
  `satelliteTabs` 段（见 9.3），关窗不问「是否保存」——标签会交回主窗口，内容没消失。
- label 约定：`main` / `sat-<n>`。`capabilities/default.json` 的 `windows` 必须是
  `["main", "sat-*"]`：**前缀写错的表现是「界面能画但 emit/listen 全被 ACL 拒掉」**，
  不报错、不崩，只是什么都不响应（`regressions.test.ts` 已锁）。
- 建窗能力**不下放给前端**（不授予 `core:webview:allow-create-webview-window`），
  只走 Rust 命令 `open_satellite_window` —— 建窗必须 `run_on_main_thread`。
  载荷**随命令一起交给 Rust 存着**，卫星窗口启动时取走：这样不存在
  「源窗口监听还没挂上、卫星窗口已经 ready」的竞态（回问式握手有天然竞态）。

### 9.2 跨窗口正文同步（同源多实例的跨窗口版）

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

### 9.3 标签的搬运：隐藏实例

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

### 9.4 拖出窗口 / 拖回

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
- **静态契约测试不得读被 gitignore 的构建产物**（B71 ④）。`src-tauri/gen/`（含 Tauri 生成的
  ACL 清单）是构建产物、不入库：本地因为一直在构建所以存在，CI 干净检出上没有 ——
  用例会在本机长期绿、**一推就红**。要么只断言入库的源文件（`capabilities/default.json`、
  `windows.rs`），要么 `existsSync` 后跳过并**在注释里写明「跳过 ≠ 通过」**。

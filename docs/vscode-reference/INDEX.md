# VS Code 源码参考（只读）

本目录是 **microsoft/vscode 源码的只读参考副本**，用于 LitePad 的样式与架构对照。
上游版本锚点见 `REVISION.txt`（ref / commit / 抓取时间）。

```sh
bash scripts/fetch-vscode-ref.sh            # 更新到 main
bash scripts/fetch-vscode-ref.sh v1.137.0   # 或钉到某个 tag
```

> **入库说明**：只有 `INDEX.md` / `REVISION.txt` / `REVISION_EDITOR.txt` / `LICENSE.txt` 与
> `scripts/fetch-vscode-ref.sh` + `scripts/fetch-vscode-editor-ref.sh` 进 git，`src/`（约 3300 份上游源码）
> **被 `.gitignore` 排除**。
> 原因：它是可复现的第三方只读副本（`REVISION.txt` 里钉了确切 commit），
> 且整目录入库会被 pre-commit 的 prettier/eslint 扫到、得往格式检查链里塞例外。
> 新克隆想拿到源码，跑一次上面的脚本即可（需要外网）。

## 许可与使用约定

- 上游为 **MIT**（见 `LICENSE.txt`）。**允许参考与借鉴**，但：
  - 不要整段复制粘贴 CSS/TS —— 我们的技术栈不同（CodeMirror 而非 Monaco，无 VS Code 的
    `--vscode-*` 令牌层），照抄必然带去一堆用不上的依赖；
  - 要借的是**尺寸、层级、交互语义与命名思路**，落到 LitePad 自己的变量体系里；
  - 若确需引入实质性代码片段，保留版权头并在此处标注来源。
- **不要在这个目录里改代码**。要更新就重跑脚本（它是幂等的，会整目录覆盖）。
- 这个目录**不参与构建**，也不该被 `src/` 引用。

## 为什么只抓这些文件

整仓 1.4 GB。来源分两类：

- **A–H 段（精选散文件，约 80 份）**：`scripts/fetch-vscode-ref.sh` 逐文件抓取，针对**设计语言
  + 关键控件**（Modern UI、标签栏、分屏、菜单、提示、色彩令牌等）。我们用 CodeMirror 6 而非
  Monaco，Monaco 内核实现对我们没有复用价值，所以只挑「观感/控件」层面的文件。
- **I 段（目录级整模块，约 3283 份）**：`scripts/fetch-vscode-editor-ref.sh` 一次性拉取
  `src/vs/editor` + `src/vs/base` + `src/vs/platform`，针对**文本编辑交互**（光标/选择/撤销/装饰/
  虚拟滚动/补全/折叠/格式化/查找/悬停/重命名/Diff）。同样是借鉴状态机与边界条件，不是抄 Monaco。

两份都经 `ref` 钉版本（`REVISION.txt` / `REVISION_EDITOR.txt`），且 `src/` 被 gitignore，需要重跑脚本即可复现。

---

## A. Modern UI —— 最重要的一层（VS Code 1.129+，实验性）

> 对应 LitePad 的「观感对标」：B55 的药丸标签就是照着 `tabs.css` 做的。

| 文件 | 用途 |
| --- | --- |
| `media/tabs.css` | **标签的权威定义**。药丸（pill）、紧凑档尺寸、命中区怎么用 `border-block` 撑出来、操作列覆盖层、固定标签、拖拽落点 |
| `media/connectedEditorTabs.css` | 「连接式标签」：活动标签向下接通编辑区 + 左右凹圆角（shoulder）怎么用 quarter-round + 反向 box-shadow 做出来 |
| `media/roundedCorners.css` | 整套圆角层级（卡片 / 面板 / 控件分别取哪一档） |
| `media/padding.css` | 整套间距 scale（`spacing-size20/40/60/80/...`）——我们现在的散装 padding 可以对齐它 |
| `media/fontRamp.css` | 字号阶梯（body1/body2/small…）与两种字重策略 |
| `media/sashHandles.css` | 分隔条：细线 + 宽命中区（与 LitePad 的 `.layout-sep` / `.toc-resizer` 同思路，可对照参数） |
| `media/paneHeaders.css` | 面板标题栏（对应我们的 `.panel-head` + 面板操作栏） |
| `media/shadows.css` | 阴影只给「浮层」，不给静态面板 —— 与 LitePad「不用阴影」的取向一致 |
| `media/statusBar.css` / `media/titlebar.css` / `media/activityBar.css` | 外壳三件套的新版观感 |
| `media/editorBorder.css` | 编辑区描边怎么不占布局空间地画出来（`::after` + `pointer-events:none`） |
| `media/commandCenter.css` | 顶部居中命令入口（可参考我们命令面板的定位） |
| `media/keyboardFocusOnly.css` | **只有键盘操作才显示焦点环** —— LitePad 的 `:focus-visible` 可以对照 |
| `media/notificationsDialogs.css` | 通知 / 对话框 |
| `modernUI.contribution.ts` | 这些 CSS 是**什么条件下挂上去的**（一个总开关 + 若干子模块 class） |
| `connectedEditorTabs.ts` | 连接式标签的运行时判定（哪块是首列、被裁剪、上一行…） |

## B. 编辑器组 / 标签 / 标题栏

| 文件 | 用途 |
| --- | --- |
| `media/multieditortabscontrol.css` | 经典标签实现：`--editor-group-tab-height`、sizing-fit/shrink/fixed、sticky、脏标记与关闭按钮的状态机 |
| `media/singleeditortabscontrol.css` | 单标签模式的标题头（对应 LitePad「一个文件时省掉标签栏」的取舍） |
| `media/editorgroupview.css` | 编辑器组的整体骨架与边框层级（z-index 说明值得一读） |
| `media/editortitlecontrol.css` | 标签栏 + 面包屑 + 编辑器操作栏的容器层级（对应 `.panel-head`） |
| `editorTabsControl.ts` | **标签高度常量在此**（`EDITOR_TAB_HEIGHT`）、tab 的 DOM 结构与状态类 |
| `multiEditorTabsControl.ts` | 多标签：溢出滚动、sticky 计算、拖拽落点 —— 我们的 `tabstrip.ts` 可对照 |
| `singleEditorTabsControl.ts` | 单标签分支的差异处理 |
| `editorTitleControl.ts` | 标题栏的构造与布局 |
| `editorGroupView.ts` | 编辑器组：标签栏 / 编辑器 / 水印 / 拖放 的组合方式 |
| `editorAutoSave.ts` | **自动保存**的策略（延迟、写盘时机、失败回退）—— LitePad 有同样的功能 |
| `editorConfiguration.ts` | **标签与编辑器的全部配置项**（tabSizing / showTabs / wrapTabs / highlightModifiedTabs…）→ 我们首选项弹窗的候选清单 |
| `editorDropTarget.ts` | 外部文件拖入的落点判定 —— 与 LitePad 的 `zoneOf` 落点逻辑对照 |

## C. 网格布局 / 分屏 / 分隔条 / 滚动条

| 文件 | 用途 |
| --- | --- |
| `gridview.ts` / `gridview.css` | **分屏布局的核心算法**（可序列化的网格、增删分屏、比例、嵌套）→ LitePad 的自由分屏直接对照 |
| `splitview.ts` / `splitview.css` | 一维分屏（拖拽改比例、最小尺寸约束） |
| `sash.ts` / `sash.css` | 分隔条的拖拽实现（命中区、悬停反馈、光标、**双击复位**、**正交角手柄**） |
| `editorDropTarget.ts` | **拖拽分屏的落点语义**（10% 边缘阈值 / 33% 方向优先 / 中心=合并 / Ctrl·Alt·Shift 修饰键）→ LitePad `splitview.ts` 的 `zoneOf` 对照 |
| `media/editordroptarget.css` | **落点高亮的样式与过渡**（透明 overlay + `opacity 150ms` + 位移 `70ms ease-out`「滑动」效果） |
| `scrollbar/media/scrollbars.css` | 自绘滚动条样式 —— 我们标签栏那套自绘滚动条可对照 |

## D. 菜单 / 弹层

| 文件 | 用途 |
| --- | --- |
| `menu/menubar.css` | 菜单弹层：条目高度、图标/快捷键列、分隔线、禁用态、选中态 |
| `menu/menu.ts` | 菜单的构造与键盘导航（上下键 / 左右切换同级 / Esc 关闭）→ 对应我们 `menu.ts` |
| `contextview/contextview.css` | 弹层容器（定位、阴影、焦点陷阱）→ 对应我们 `menu.ts` 的 popup |
| `workbench/browser/media/floatingPanels.css` | 浮层面板（命令面板 / 快速挑选的外壳定位） |

## D2. 悬停提示（tooltip）—— 本项目自绘 `.tooltip` 层的数值来源

原生 `title` 由操作系统绘制，配色/圆角/键帽/延迟全不可控（深色界面里会弹浅色系统气泡）。
B58 起全应用改为**自绘单例层**（`src/shell/tooltip.ts`），数值逐条取自这几份：

| 文件 | 用途 |
| --- | --- |
| `platform/hover/browser/hover.css` | **外观基线**（`.monaco-hover.workbench-hover`）：13px / 行高 19px、`max-width`、背景/边框取色、**带指针档圆角 3px**、`box-shadow` |
| `base/browser/ui/hover/hoverWidget.css` | `.hover-contents { padding: 4px 8px }`、淡入 100ms、`cursor: default` |
| `base/browser/ui/hover/hoverWidget.ts` | 指针定位规则：默认居中于提示框，中心点跑出目标横向范围则对准目标中心 |
| `platform/hover/browser/hoverWidget.ts` | `PointerSize = 3`（→ caret 6px 方块）、`HoverWindowEdgeMargin = 2` |
| `platform/hover/browser/hoverService.ts` | **`groupId` 规则**：同组内相邻目标秒开且跳过淡入（顺着工具栏滑过去不闪） |
| `platform/hover/browser/updatableHoverWidget.ts` | 提示内容的增量更新（我们不需要，留作对照） |
| `base/browser/ui/hover/hover.ts` | 提示的 DOM 结构与 `.hover-row` 组成 |
| `base/browser/ui/keybindingLabel/keybindingLabel.css` | **键帽**数值：11px / `min-width: 12px` / `padding: 3px 5px` / 圆角 3px |
| `editor/contrib/hover/browser/hover.css` | 编辑器内悬停浮层（我们暂未做，留作对照） |

> 延迟（`workbench.hover.delay` = Windows 500ms）定义在 `workbench/browser/workbench.contribution.ts`，
> 该文件未收录 —— 数值已固化进 `tooltip.ts` 的 `SHOW_DELAY` 常量并注明出处。

## E. 工具栏 / 按钮 / 输入控件

| 文件 | 用途 |
| --- | --- |
| `toolbar/toolbar.css` | 工具栏布局与分组 |
| `actionbar/actionbar.css` | ActionBar（图标按钮、下拉箭头、状态切换）→ 对应我们的图标工具栏 |
| `button/button.css` | 按钮三态与尺寸档 |
| `inputbox/inputBox.css` | 输入框（我们查找栏 / 命令面板的输入框） |
| `findinput/findInput.css` | 查找输入框（带前置图标与开关按钮） |
| `countBadge/countBadge.css` | 计数角标 |
| `selectBox/selectBox.css` | 下拉选择（对应首选项里的档位选择） |
| `list/list.css` | 列表（命令面板 / 搜索结果 / 大纲都基于它） |
| `list/listView.ts` / `list/listWidget.ts` | 列表的虚拟滚动与选择/焦点模型 —— 对标我们标签栏与大纲的键盘导航 |

## F. 命令面板 / 查找 / 搜索

| 文件 | 用途 |
| --- | --- |
| `quickinput/media/quickInput.css` | **命令面板的样式**：输入行 + 结果列表 + 分组标题 + 键位提示列 |
| `find/browser/findWidget.css` | 编辑器内查找/替换浮层（对应我们的查找悬浮栏） |
| `search/browser/media/searchview.css` | 跨文件搜索结果视图（对应我们 M2 的跨文件搜索） |

## G. 工作台外壳

| 文件 | 用途 |
| --- | --- |
| `workbench/browser/media/style.css` | 全局基础样式 + **CSS 变量的挂载方式**（我们 `global.css` 的对照物） |
| `statusbar/media/statusbarpart.css` | 状态栏（对应我们的 `.statusbar`） |
| `titlebar/media/titlebarpart.css` | 标题栏 / 菜单栏（我们自绘了菜单栏，值得对照） |
| `panel/media/panelpart.css` | 底部面板容器 |
| `sidebar/media/sidebarpart.css` | 侧边栏 |
| `activitybar/media/activitybarpart.css` | 活动栏（最左图标列） |
| `parts/media/paneCompositePart.css` | 侧边栏/面板的通用骨架 |

## H. 首选项 / Markdown / 主题令牌

| 文件 | 用途 |
| --- | --- |
| `preferences/browser/media/settingsEditor2.css` | 设置界面（分组、条目、控件）→ 对应我们的首选项弹窗 |
| `markdown/browser/media/markdown.css` | **Markdown 预览的排版基线**（标题/列表/引用/表格/代码块）→ 我们 `preview.css` 的对照物 |
| `markdown/browser/markdownDocumentRenderer.ts` | Markdown → HTML 的渲染与安全策略（我们 `marked` + DOMPurify 链路可对照） |
| `platform/theme/common/colors/baseColors.ts` | 基础色令牌定义 |
| `platform/theme/common/colors/editorColors.ts` | 编辑器色令牌（`editorHoverWidget.*` 提示背景/边框、`keybindingLabel.*` 键帽配色） |
| `platform/theme/common/colors/miscColors.ts` | 杂项色令牌（阴影 `shadow` 等） |
| `workbench/common/theme.ts` | **`tab.*` / `editorGroup.*` / `statusBar.*` 等语义色令牌的权威定义**（我们的 `--tab-bg-*` 该照这个思路命名） |

## I. 编辑器模块（editor + base + platform，目录级整模块）

B58 之后按用户要求一次性拉取了**所有文本编辑相关源码**：`src/vs/editor` + `src/vs/base` +
`src/vs/platform`（main，`commit 9100222`），过滤后落盘约 3283 份（`REVISION_EDITOR.txt`）。
由 `scripts/fetch-vscode-editor-ref.sh` 拉取（depth 1 + blob:none + sparse + 排除测试/worker/
语法定义），`src/` 被 gitignore。**内部 import 可跳转**——这是相对 A–H 段「精选散文件」最大的差别。

> ⚠️ 我们用自己的 CodeMirror 6，不是 Monaco。这些源码的价值在**文本编辑交互的状态机与边界
> 条件**（光标/选择/撤销栈/装饰/虚拟滚动/补全/折叠/格式化/查找/悬停/重命名/Diff），
> 而不是 Monaco 的实现；内部读到 `monaco.*` / `StandaloneServices` 的部分与我们无关，略过。

### `src/vs/editor/` 导航

| 子目录 | 内容（与 LitePad 编辑器可对照的部分） |
| --- | --- |
| `common/model.ts` / `common/model/*` | **文本模型**：`TextModel`、行模型、版本/变更、tokenization 接口 |
| `common/editorCommon.ts` | 编辑器公共类型（光标、选择、滚动、配置） |
| `common/viewModel*` / `common/viewEvents.ts` | 视图模型与视图事件 |
| `common/config/*` / `common/editorOptions.ts` | 编辑器配置项定义（参考 `editorConfiguration.ts`） |
| `common/cursor*.ts` / `common/controller/*` | 光标移动 / 选择 / 输入控制器（键盘/鼠标交互状态机） |
| `common/commands/*` | 编辑命令、撤销/重做栈 |
| `browser/editorBrowser.ts` / `browser/widget/*` | 编辑器 DOM 装配、滚动、溢出守卫、 minimap |
| `browser/view/*` | 渲染层（行、装饰、行号、内容区、视口虚拟滚动） |
| `contrib/` | **交互功能集合**（每个子目录一个 feature）：`find`（查找/替换）、`suggest`（补全）、`folding`（折叠）、`format`（格式化）、`hover`（悬停）、`rename`（重命名）、`smartSelect`、`comment`、`clipboard`、`multicursor`、`wordHighlighter`、`links`、`gotoSymbol`、`bracketMatching`、`indentation`、`toggleTabFocusMode` 等 |
| `standalone/` | Monaco 独立打包胶水（仅 `editor/` `common/` `browser/` 部分有用，已排除 basic-languages/language） |

### `src/vs/base/`（UI 与基础件，A–H 段已部分收录）

| 子目录 | 内容 |
| --- | --- |
| `browser/ui/` | 所有基础控件（hover、keybindingLabel、list、grid、splitview、sash、menu、toolbar、button、inputbox、contextview…）—— A–H 段引用的就是这里 |
| `common/` | 通用工具（event、lifecycle、scrollable、decorators、worker 已排除） |
| `common/diff/` | 行级 diff 算法（对应我们的差异视图） |

### `src/vs/platform/`（基础服务，供 editor 依赖）

| 子目录 | 内容 |
| --- | --- |
| `theme/common/colors/` | 全部语义色令牌定义（`baseColors` / `editorColors` / `miscColors` 等，D2 段引用） |
| `instantiation` / `registry` / `contextkey` | 依赖注入、贡献点注册、上下文键（VS Code 的扩展/命令体系） |
| `configuration` / `files` / `workspace` / `editor/` | 配置、文件、编辑器服务接口 |
| `hover/browser/` | 悬停宿主服务（D2 段引用） |

---

## J. 图标（codicon + 其它图标集）—— 自绘字形的替代来源

> 2026-09-20 起：本目录下的图标从「只抽应用用到的几十颗」扩充为 **VS Code 的完整图标体系**
> （全量 codicon + seti 文件图标主题 + 工作台 UI 主题图标 + 产品 logo），落点见下表。
> 全部**只读、不入库**（口径见 `.gitignore`），可由脚本精确复现。

### J1. codicon（UI 图标，应用唯一图标来源）

| 位置 | 内容 |
| --- | --- |
| `codicons/*.svg` | `@vscode/codicons@0.0.46-24`（MIT）`src/icons/` 的**全量 639 颗**图标轮廓（只读副本）。由 `scripts/fetch-codicons-all.mjs` 补齐；`src/shell/codicons.ts` 只引用其中子集 |
| `codicons/codicon.ttf` / `codicons/codicon.css` | 官方字体与样式（离线对照字形用，应用不引字体，内联 SVG 即可） |

**为什么用 codicon 而不是手绘/引字体**：手绘的字形与 VS Code 永远差一档（查找栏的替换图标、
`Aa`/`ab`/`.*` 三个开关最初就是自绘的，语义对但轮廓不像）；引字体又要背一个 150KB 的
ttf + 一份 css，而全项目只用到几十颗。codicon 的 `src/icons/*.svg` 是**纯路径 +
`fill="currentColor"` + 16×16 网格**，内联进 DOM 即 1:1 像素对应，零缩放、零依赖。

> 🚩 **红线（2026-09-18 起）**：应用内**所有按钮图标一律取 codicon**，禁止手绘 SVG；
> codicon 里确无合适字形时先与用户商量是否引入别的图标集。唯一豁免是主题的 sun / moon
> 两颗（官方清单里没有日/月字形，经用户确认），仍留在 `src/shell/icons.ts`。
> 规则正文见 `docs/conventions.md`「图标」节，回归守卫见 `regressions.test.ts` B81。

**取用约定**：

- 应用子集由 `node scripts/fetch-codicons.mjs` 生成（落到 `src/shell/codicons.ts`）；
- 全量参考副本由 `node scripts/fetch-codicons-all.mjs` 补齐到 `codicons/`；
- `src/shell/codicons.ts` 是**生成物、要入库**（构建依赖它），不要手改；
- 上游版本**钉死**在脚本的 `VERSION` 常量里：图标字形会随版本变，升级要连版本号一起改，
  重跑后目视核对工具栏 / 标签文件类型图标 / 查找栏（`Aa`/`ab`/`.*`/替换两枚/选区查找）；
- 脚本末段会**调 prettier 收尾**生成物（生成物也要过 `npm run format:check`）；
  `FILE_FAMILIES` 的 10 个家族必须映射到 10 颗不同字形，`assertFamilies()` 会在联网前先拦撞车。
- `codicons/`（含 `REVISION.txt`）整体不入库，与 `src/` 段同一口径。

### J2. 其它图标集（codicon 之外）

| 位置 | 内容 | 来源 |
| --- | --- | --- |
| `file-icons/seti/` | seti 文件图标主题（字体 `seti.woff` + `icons.yml` 映射） | `extensions/theme-seti/icons/` |
| `theme-icons/` | 工作台 / 编辑器 / 平台层 UI 主题图标（`src/vs/**/media/*.{svg,png}`，保持上游目录结构） | `src/vs/` 下各 `media/` 目录 |
| `product/` | VS Code 产品 / logo 图标（`resources/**/*.{ico,png,icns}`） | `resources/` |

- 由 `node scripts/fetch-vscode-icons.mjs` 一次性拉取（先调 GitHub git/trees API 枚举整仓、
  按扩展名 + 路径白名单过滤，再逐颗 curl raw.githubusercontent）。`REVISION_ICONS.txt` 记数量；
- 与 `codicons/` 同口径：**只读、不入库**（`.gitignore` 已加 `file-icons/` / `theme-icons/` / `product/`）；
- 这些集子与 LitePad 的 codicon-only 红线**无关**，纯作「VS Code 全量图标」参考用——
  要加文件类型图标 / 产品图标时可来挑，挑完仍走 codicon（或用户确认的图标集）落地。

---

## 后续怎么用（给未来的自己）

1. **要改观感**：先读 A 段（Modern UI），再读对应区域的具体文件，拿尺寸/层级过来套；
2. **要改交互**：读 B/C 段的 `.ts`（标签控制、编辑器组、网格），重点是**状态机与边界条件**，
   实现本身不用抄；
3. **要加设置项**：`editorConfiguration.ts` 是现成的清单，按需挑；
4. **动笔前先问**：这一处改动是不是必须的？（VS Code 的复杂度来自要同时满足 40 种语言、
   远程、多窗口，LitePad 只有单窗口 Markdown —— 别把它的重量搬过来。）

# VS Code 源码参考（只读）

本目录是 **microsoft/vscode 源码的只读参考副本**，用于 LitePad 的样式与架构对照。
上游版本锚点见 `REVISION.txt`（ref / commit / 抓取时间）。

```sh
bash scripts/fetch-vscode-ref.sh            # 更新到 main
bash scripts/fetch-vscode-ref.sh v1.137.0   # 或钉到某个 tag
```

> **入库说明**：只有 `INDEX.md` / `REVISION.txt` / `LICENSE.txt` 与 `scripts/fetch-vscode-ref.sh`
> 进 git，`src/`（80 份上游源码）**被 `.gitignore` 排除**。
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

整仓 1.4 GB，但我们要的是「**设计语言 + 关键控件实现**」，不是编辑器内核
（LitePad 用 CodeMirror 6，Monaco 的实现对我们没有复用价值）。

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
| `sash.ts` / `sash.css` | 分隔条的拖拽实现（命中区、悬停反馈、光标） |
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

---

## 后续怎么用（给未来的自己）

1. **要改观感**：先读 A 段（Modern UI），再读对应区域的具体文件，拿尺寸/层级过来套；
2. **要改交互**：读 B/C 段的 `.ts`（标签控制、编辑器组、网格），重点是**状态机与边界条件**，
   实现本身不用抄；
3. **要加设置项**：`editorConfiguration.ts` 是现成的清单，按需挑；
4. **动笔前先问**：这一处改动是不是必须的？（VS Code 的复杂度来自要同时满足 40 种语言、
   远程、多窗口，LitePad 只有单窗口 Markdown —— 别把它的重量搬过来。）

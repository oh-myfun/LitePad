# 设计：即时渲染（IR）——自研 CM6 装饰层 + 一颗悬浮锁键（照 VS Code）

日期：2026-10-23 · 状态：待用户批准 · 工单号拟：B352（B351 已被并行会话的标签肩线那笔占走）

> 沿革：`d57243e`（vditor 寄生预览格）→ `24cbf77`（改自研 CM6 装饰层）→ `4e3762e`（按 VS Code 内置
> Markdown Editor 的实测形状重做形态设计）。本版收进用户 2026-10-23 的两条裁定：
> **`默认锁着，用悬浮键`**，并加一条交付时序：**等并行会话（B353 设置窗浮层框）开发完成后再开工**。

## 意图与为什么

LitePad 现在的 .md 只有两面：CodeMirror 源码、自绘只读预览。用户想要**在渲染结果里直接写**。

不换回 vditor 的理由（架构对不上，不是省钱）：它的 IR 是 contenteditable DOM 面 ⇒ 文本不是真相源 ⇒
必须造 DOM→markdown 回灌，换来全文重打印、两套解析、`setValue` 抹光标、Lute 3.74MB、1,715 行
`fixBrowserBehavior`（WebView2 本来就没那些坑）。自研 IR 是**同一个 CM6 面上加一层装饰**，文本始终
是真相源 ⇒ 输入法/撤销/选中/查找/保存全部继承，体积增量 0（所需 CM6 包已在 dependencies）。

## 参照物实测：VS Code 1.143 内置 Markdown Editor（读 `E:\Project\vscode`，非推测）

扩展目录 `extensions/markdown-language-features/`。

- 两个 custom editor：`vscode.markdown.preview.editor` 与 **`vscode.markdown.editor`（Markdown Editor）**，
  后者 `priority.textEditor: "option"` ⇒ **默认仍是文本编辑器**，与我们「默认面不变」一致。
- 本体是 npm 包 `@vscode/markdown-editor@0.0.2-130`（依赖树从 `package-lock.json` 解出）：
  **micromark**(+gfm/frontmatter/math)、`@vscode/diff`、`@vscode/observables`、`@vscode/codicons`、katex、entities。
  **既无 CodeMirror 也无 ProseMirror** ⇒ 它是自制 DOM 编辑面 + micromark AST。
  这份 checkout 未装 `node_modules` ⇒ 包体读不到（见「读不到的部分」）。

### 它印证的三条骨架（自研路线的底气）

| VS Code 的做法                                           | 出处                                                                                                                                                          | LitePad 的对应                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `vscode.TextDocument` remains the single source of truth | `src/preview/markdownEditorProvider.ts:249-252` 注释                                                                                                          | CM6 的 doc 就是真相源，装饰层永不写文本               |
| 外发**最小 offset 差量**而非整篇                         | `markdown-editor-src/editor.ts:720-738 computeTextEdit(previousText, text) → {start, endExclusive, text}`；host `:1351-1376` 换 `vscode.Range` 后 `applyEdit` | 天然成立：编辑就在 CM6 事务里，变更集管道已在         |
| **撤销归宿主**，编辑面不自持历史                         | `editor.ts:450-461 historyStrategy { undo/redo → host }`，注释「`record` is deliberately omitted」；host `:562-573` 先 `editQueue.drain()` 再执行             | `history()` 已在 `baseExtensions`，不新增第二条撤销栈 |

外部改动打进编辑面时它传整篇 + `editEpoch`（`markdownEditorProtocol.ts:152` → `editor.ts:196`），靠 epoch
丢陈旧回声、失败走 `editQueue.invalidate()` + `postAuthoritativeUpdate`（`markdownEditorProvider.ts:599-651`）。
LitePad 连这一层都省：**同一个 CM6 实例、同一份 state**，外部改动仍走现有变更集管道。

### 那颗锁键的接线（用户点名的这一件）

- 命令 `markdown.editor.toggleLocked`，标题 **"Toggle Markdown Read-only"**（`package.json:509-514`，标
  `$generated`；文案 `package.nls.json:373-377`）。键位**只有 mac `cmd+e`**（`package.json:1399-1402`）
  ⇒ **Windows/Linux 没有默认键位**，鼠标是唯一入口。命令面板里还被隐藏（`:925-929` `when:"false"`）。
- 链路：`src/extension.shared.ts:94-102` → `markdownEditorProvider.ts:762-769 renderer.command()` →
  `markdown-editor-src/editor.ts:261-274 controller.executeCommand()` ⇒ **翻转动作在包里做**。
- 状态：`editor.ts:183 model.readonlyMode.set(initialState.readonly)`；`:571-579` 一变就
  `presentation.set(readonly ? 'reading' : 'editing')` 并回推 host；host 只写 `globalState`
  键 `markdown.editor.readonly`（`markdownEditorProvider.ts:558-561`、`:263`），**默认 `true`**
  （`:380`、`:1144` → `webviewInitialState.ts:14`），源码注释的口径是
  「**一个编辑器翻锁，成为下一个的初始模式**」。（用户裁定：我们照它 —— 默认锁着。）
- 它在哪一层：`editor/title` 里七条贡献全属 preview，**没有一条给 `vscode.markdown.editor`**
  ⇒ 那颗悬浮键是**包在编辑面自己那层画的**，不是宿主标题区 UI。
- **锁不被文档只读强制**：全扩展 grep `isReadonly` 零命中（`package.json:241,247` 的
  `!activeEditorIsReadonly` 是文本编辑器命令）。⇒ 这条**不照抄**：LitePad 的 `doc.readonly` 是硬事实，见 §4 的退化规则。
- 可抄的观感纪律：同目录浮层的写法是 `.md-completion-overlay{position:absolute;z-index:100}`、
  `.md-diagnostic-hover{position:fixed;z-index:110}`，配色全走 workbench 变量
  （`--vscode-editor-background`、`--vscode-cornerRadius-large`、`--vscode-shadow-lg`、`--vscode-editor-font-*`）
  ⇒ 与 LitePad B336/B337/B349「形状颜色都跟共用 token 走」是同一条纪律。
- `markdown.editor.*` 设置项实测只有：`highlightActiveBlock(true)`、`quickSuggestions(false)`、
  `drop.enabled("smart")`、`drop.copyIntoWorkspace("mediaFiles")`、`filePaste.enabled("smart")`、
  `copyIntoWorkspace`、`videoSnippet`、`audioSnippet`、`pasteUrlAsFormattedLink.enabled("smartWithSelection")`、
  `updateLinksOnPaste.enabled(true)`。**没有** `markdown.editor.readonly` 设置项 —— 锁只走 globalState。
  其中 **`highlightActiveBlock` 默认开** ⇒ 本版抄（§5）。

### 不照搬的部分（以及为什么）

| 它有的                                                               | 出处                                                                                                                                                  | 本版不做的理由                                                                                                    |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 代码块点开 ⇒ 懒加载**真 iframe 编辑器**                              | `editor.ts:368-388` 动态 import `@vscode/markdown-editor/web-editors`、bootstrap URL 强制 `/fake.html`、协议 `web-editor/0.12`（CONTRIBUTING.md:188） | 那是「复杂块交给另一个编辑器」；LitePad 让它整块退回原始 markdown 可编辑                                          |
| 任务清单也走 iframe provider；checkbox 直接改源                      | `taskProgress/taskProgressProvider.ts:18-31`、`editor.ts:417-419 setTaskCheckboxChecked`                                                              | 本版 IR 里 checkbox 是**内容不是控件**（`ignoreEvent` 吃掉），勾取回源码态手写 `[x]`                              |
| 评论 / 诊断悬浮 / 重命名 / 补全 / webview RPC                        | `diagnosticHover.ts`、`renameController.ts`、`completionController.ts`、`markdownEditorRpc.ts`、`@vscode/hubrpc`                                      | 那是语言服务器 + 跨进程那一整套；LitePad 的 IR 就在主编辑器实例上，语言特性本来就有                               |
| 节点 id + `findNodeOffsetById` 把嵌入编辑器的相对编辑平移回源 offset | 唯一调用点 `editor.ts:402-413`（`blockOffset + block.codeOffset`）                                                                                    | 没有嵌入编辑器就不需要；但它印证「渲染节点必须能查回源 offset」—— 我们的 `MdBlock.lineStart/lineEnd` 正是这个映射 |
| 为 diff 视图造的行/块/`innerChanges` 三级脏区间                      | `lineDiff.ts:90,151-165,181-198,234-252`                                                                                                              | 那是**两个文档对差异**才要的；IR 在同一 state 内，CM6 事务自带差量                                                |

`inner change` 记一句：它指**行数不变但字符变了**（`{line,startColumn,endColumn}`，`types/previewMessaging.d.ts:10-17`）——
行级 diff 看不见、渲染却变了，所以微软专门造了一条通道。LitePad 没这个坑：块按行区间切、比较
`(lineStart, lineEnd, html)`，同步行数不变的字符改动本就落在同一条比较里。这是「文本是真相源 + 行区间坐标」顺带免掉的一类 bug。

### 读不到的部分（不装包就标成待验，别当已知）

浮动键的 DOM 结构与 CSS 选择器（它在包内 `editor.css` / `themes/vscode-default.css`）、`toggleLocked` 的实现、
`EditorModel` 那几个 observable 的语义、节点 id 格式、包内脏区间增量策略、以及「编辑态下行内标记到底显不显」
（本 checkout 只有 `CONTRIBUTING.md:101-104` 一句 source-marker visibility）。
**用户本轮未授权读包，所以本版不依赖这几件**：形状照「在编辑面自己那层、不随正文滚、只在 IR 面有意义」抄，
位置/大小/hover 行为的像素留到实现轮与 VS Code 同框比（真机台）。要钉死时的命令是
`npm pack @vscode/markdown-editor@0.0.2-130`（解开只读，不执行其中代码）。

## 已定的方向（用户裁定）

1. **`viewMode` 仍是 `source | preview` 两值，顶层那颗键与 `Ctrl+/` 的语义一字不改**；IR 是**源码面的渲染态**。
2. 打开 .md 的默认行为不变（仍是源码面）。
3. 先只上即时渲染（IR）；WYSIWYG 缓上，只留枚举位。IME 在这条路线上不构成红线。
4. **默认锁着**（照 VS Code 的阅读优先）：进入渲染态时初始不可写。
5. **用悬浮键**：那颗键一键盘「渲染」与「可写性」两件事（也就是我上一条问的「三态切换按钮」那一形）。
   ⇒ 撤销我上一条的两个提议：入口不放在面板操作区，也**不抢键位**
   （我提的 `Ctrl+Shift+E` 与「显示/隐藏资源管理器」撞，src/shell/keymap.ts:306；VS Code 自己在 Windows 上也没有默认键位）。
6. 会话记住开关，启动懒重建（只给活动实例开装饰）。
7. 随路线失效的一条：原「编辑面不参与同步滚动」。IR 就是 `sideOfPanel`（src/sync-scroll/wire.ts:99）
   眼里的 source 那一格 ⇒ 同步滚动/大纲/查找**零改动自动成立**，按「自动参与」处理。

## 目标

- `Tab` 新增两个实例级字段：`liveRender: "off" | "ir"`（`"wysiwyg"` 预留，不进 UI 与持久化白名单）
  与 `irLocked: boolean`。`viewMode` 不动。
- 编辑面**右下角一颗悬浮键**：`.md` 且非大文件门槛内就存在（源码态也要在，它是唯一入口），
  按固定顺序在三态间循环（§4）。
- 光标落进哪一块、哪一块就退回原始 markdown 可编辑；离开即重新渲染。多光标同理。
- 焦点块有明确视觉标识（抄 `highlightActiveBlock`）。
- 观感与只读预览**同一批 CSS 规则**，不许出现第二份 markdown 排版定义。
- 改的字落到同一份文档真相：脏标记、保存、外部改动冲突框、热退出副本、跨窗口广播全走现有那条链。

## 非目标（本版明确不做）

- 不上 WYSIWYG，不做 contenteditable，不做 iframe 嵌入编辑器。
- 不做**行内**标记渲染（`**粗体**` 的星号在光标所在块内照旧可见）；本版只做**块级**：
  标题、列表、引用、代码块、表格、任务列表、分割线、图片。
- 不做「点渲染内容里某个字精确落到第几列」的列级映射；点击块只保证落进**这一块**。
- 不引工具栏、不引上传（图片粘贴仍按插入 markdown 文本处理，不落文件、不上传）。
- 不给这颗键配默认键位。
- 不改只读预览那一面的任何现有行为。

## 反目标（什么会让这件事算失败）

- **文本不再是唯一真相**：任何把渲染结果反向写回文档的代码路径。
- **每敲一个字全篇重画**：装饰层不许无条件重建所有块 DOM（`eq()` 必须真生效）。
- **锁着却还能改**：锁态下任何写路径（键入、粘贴、拖入、复选框、命令）都必须进不来。
- **一颗键走出两条顺序**：三态循环必须有唯一后继；跳态或分叉就是不可测。
- **多面板时两颗键叠在窗口同一角**：定位上下文选错就会发生（§4 第 3 条）。
- **排版规则复制第二份**：IR 与预览各写一套标题/列表/表格样式，日后必然漂移。
- **装饰与折叠/查找高亮互相吞**：两套「隐藏行」或抢同一段区间的装饰叠在一起。
- **切渲染/翻锁引起位置跳变**：历代病灶（B293/B277/B288）；每次换态都必须按 v 落位。
- **纯浏览也改写文件**：本版不可能（没有 DOM→文本打印器），判据要钉住防日后加回来。

## 约束

- **开工时序（用户裁定）**：等并行会话 B353（设置窗浮层框）开发完成再动产品代码。
  本版要碰的文件与它**重叠**：`src/shell/codicons.ts`（要补两颗锁形）、`src/styles/global.css`、
  `index.html`、`src/ui.ts`、`src/main.ts`。实施计划里凡落在这批文件上的任务都要标「等 B353 落地」。
- 交付铁律照旧：不自动推送、不打 tag；出包前显式 bump（patch 自决，minor/major 先问）；契约测试先行；
  不用 `--no-verify`；并行会话 ⇒ 改完立刻点名 `git add` 自己的文件。
- 体积增量：**0**（无新依赖、无 vendor 资源）。
- 大文件：沿用 `perfProfileFor(sizeClass).autoPreview` 那一档门槛（>2MB 自动预览本来就停了），
  关在门槛外 ⇒ 那颗键不出现。不新立一套尺寸策略。

## 机制设计

### 1. 数据来源：已有的 `MdBlock`，不另起解析

`renderBlocks()`（src/markdown/pipeline.ts）已产出 `MdBlock { lineStart, lineEnd, html }`——块级 IR 要的
正好只有区间与 HTML。IR 复用预览那条 MarkdownIt 配置（`html:false, linkify:true` + footnote + 任务列表规则），
所以「IR 里看到的」与「切到预览看到的」在语法层面不可能不一致。VS Code 走 micromark 是它自建编辑面的需要，
**引擎不必跟**：要抄的是它的三条骨架与那颗键的形状。

⚠️ 不用 CM6 语法树切块：`syntaxTree` 给边界不给 HTML，最终仍要渲染器，多一套边界口径不如共用一套。

### 2. 装饰层：三件套

- `irBlocks` **StateField**：装当前 state 的 `MdBlock[]`，由事务效果写入；写入源与预览共用同一条
  120ms 防抖（src/markdown.ts:95 `scheduleMdRender`），**渲染开时才跑**。
- **纯函数 `irDecorationsFor(blocks, selections, doc, locked): Decoration[]`**：
  `locked` ⇒ 所有块都装饰（**无焦点例外**）；否则块区间与任一选区不相交 ⇒ 发一条
  `Decoration.replace({ widget })` 覆盖 `doc.line(lineStart).from .. doc.line(lineEnd).to`，相交 ⇒ 不发。
  **这一个函数是本设计的 TDD 重心**：不碰 DOM、不碰 CM 实例，正反判据都能写成表驱动用例。
- **ViewPlugin**：`selectionSet || docChanged || viewportChanged` 时重算，产出 `EditorView.decorations`。
  光标移动不产生事务 ⇒ 必须靠 ViewPlugin 才做得到「点一下就散开」。

widget：`WidgetType` 子类，`toDOM()` 造 `<div class="md-rendered md-ir-block"><div class="md-block">…</div></div>`；
`eq()` 比 `(lineStart, lineEnd, html)`，命中就复用现有 DOM；`ignoreEvent()` 只放行 `mousedown`、吃掉其它
（链接与复选框在 IR 里是**内容**不是**控件**，与 VS Code 把 checkbox 交回源文本同一口径）。

⚠️ 「块级 widget」的确切写法是 spike 第 1 项（`WidgetType.define({ block: true })` 那一路，还是整行区间
`Decoration.replace` + `display:block`）。设计只承诺机制（区间替换 + 块级 DOM），不承诺拼写。

### 3. 进入编辑的那一下

- **键盘**：光标移进块区间 ⇒ 选区相交 ⇒ 装饰消失，原始文本现形。零代码。
- **鼠标**：widget 上 `mousedown` ⇒ `view.posAtCoords()` 反查 ⇒ dispatch selection ⇒ 该块装饰消失。
  列级精度不保证，保证的是**这一块的合理位置**；反查失败就落该块 `lineStart` 行首，不报错、不吞点击。
- 锁态：装饰层按 `locked` 全装饰，`EditorView.editable(false)` + `EditorState.readOnly` 同时置 ⇒
  两层各自成立才算锁死（一层漏了就是「锁着还能改」）。

### 4. 那颗悬浮键：三态循环（本轮定稿的核心）

#### 4.1 状态机

| 态              | `liveRender` | `irLocked` | 编辑面表现                       | 键的语义  |
| --------------- | ------------ | ---------- | -------------------------------- | --------- |
| **A 源码**      | `"off"`      | 不生效     | 全原始 markdown，可写            | 按 ⇒ 进 B |
| **B 渲染·锁**   | `"ir"`       | `true`     | 全块渲染，**不可写**，无焦点例外 | 按 ⇒ 进 C |
| **C 渲染·可写** | `"ir"`       | `false`    | 非焦点块渲染、焦点块露源码       | 按 ⇒ 回 A |

- **唯一后继**：`A → B → C → A`。**不设跳态**（不允许 A→C，也不允许 C→B）。
  这条要写进判据：循环顺序是这颗键的全部行为，分叉就不可测。
- 「默认锁着」落点 = **A→B 那一发**永远进 B 而不是 C，与任何持久化值无关。
- 会话恢复与新建实例：优先读实例级会话里的 `(liveRender, irLocked)`；缺失时走应用级默认
  （`liveRender = "off"`、`irLocked = true`）。应用级默认在**每一次翻态后写回**，
  照 VS Code「一个编辑器翻锁，成为下一个的初始模式」的口径。
- ⚠️ 一处歧义留给你一句话推翻：**「默认锁着」我按「进入渲染态后初始不可写」实现，而不是
  「打开 .md 默认就落在 B 态」**——后者与裁定 2「默认面不变（源码）」直接冲突，所以本版取前者。

#### 4.2 只读与大文件的退化

- `doc.readonly` ⇒ **C 态不可达**：`B` 那一下再按直接回 `A`（循环退化成两态 `A ⇄ B`），
  键的提示文案说清「文档只读」。不照抄 VS Code「锁不被文档只读强制」那条。
- `autoPreview` 关档（>2MB）⇒ 那颗键**不出现**（不是「出现了但点了没反应」）。

#### 4.3 挂在哪一层（这是对 VS Code 那根的忠实实现，不是抄它的 CSS）

它「不随正文滚」的意图，LitePad 不能用 `position: fixed` 照抄：**一个窗口有多个面板格**，
fixed 会把每一格的键都钉到窗口同一角并叠起来。所以：

- 键挂进**面板壳**（与 `.panel-head` 同层的定位上下文，`position: absolute`，右下角，
  与纵向滚动条错开一个 `--scrollbar` 档位），**不进滚动容器** ⇒ 天然不随正文滚。
- z-index：高于滚动条槽、低于查找栏与弹层菜单（档位与 B336/B349 那族共用 token 走，不写死数字）。
- 每格各有一颗，状态跟着该格活动实例的 `(liveRender, irLocked)`；切标签 ⇒ 重画这颗键（同 `renderPanelOps`
  那颗双字形切换键的「视图模式落到 DOM 的唯一出口」口径，src/markdown.ts:50-57）。

#### 4.4 呈现与文案

- 三态三形，一律取官方 codicon（图标红线：不手绘）：**A** 用现成 `codicons.code`；
  **B** 用 `lock`、**C** 用 `unlock` —— 这两颗 `src/shell/codicons.ts` 现在**没有**，需补
  （⚠️ 该文件正被 B353 改，见约束）。
- 提示走 **B350 按钮档**（`setTip`，带小尖尖、元素定位），文案随态变（「进即时渲染」/「已渲染 · 点此解锁」/
  「已可写 · 点此回源码」）。
  ⚠️ 判据**不许拿文案子串当结构判据**（[[文案改名的守卫陷阱]]）：态的断言按 `dataset.state` 一类形状判，文案另判一条「三态各有一条非空 tip」。
- 命令注册表另给**两条直达命令**：`view.liveRender`（进/出渲染，不动锁态）与 `view.toggleLock`（只翻锁）。
  两者**默认不抢键位**（`keys: []`，与「打开文件夹」B314 同一先例：菜单与命令面板都点得到，设置里可自行绑定）。
  命令面板里**保留**条目（VS Code 藏了，我们不藏 —— 我们的命令面板就是帮助）。
  ⇒ 鼠标走循环、键盘走直达，两条路径作用在同一个 `(liveRender, irLocked)` 上，不各存一份。

### 5. 与既有扩展的冲突处置

- `lineNumbers()` 与 `foldGutter()` 现在硬编在 `baseExtensions`（src/editor/editor.ts:60-99），挪进新的
  `comps.gutter` 才能按实例切；挪时保留 M4 的 `perf.folding` 门槛（`perf.folding ? foldGutter(...) : []`
  整条进 compartment 值，不是进判断后再 push）。
- **折叠与 IR 互斥**：两者都在「藏行」，重叠的 `Decoration.replace` 行为不可预期。进 IR 撤 `foldGutter`，退出还原。
- **行号在块装饰下的实际表现**（被吞的行还发不发号、跳号刺不刺眼）是 spike 第 2 项；
  默认倾向**保留行号**——大纲「第 N 行」、状态栏、查找落点全都以行号为坐标。
- **焦点块标识**（抄 `markdown.editor.highlightActiveBlock`，默认开）：给光标所在块发一条 `Decoration.line`
  左边条，颜色取 `--border`/`--accent` 一档，不写死。锁态不画（那态没有焦点块）。
- 查找高亮、括号匹配、选中匹配高亮都是 mark 级，与 replace 级不抢语义，不动；
  spike 第 3 项实测「命中文字正好在被渲染的块里」时的可见性。

### 6. 外观：一份排版规则，两个容器 + 一颗键

现在 preview.css 里 `.md-preview` 出现 60 次，容器职责（`overflow-y`、`padding: 16px 24px 48px`、背景色）
与全部排版选择器的前缀混在一起，还兼着 `--md-*` token 定义。IR 的 DOM 挂在 `.cm-content` 里，借不到前缀。

决定：把「token + 排版」从「容器」里剥出来——新增共用类 `.md-rendered`（搬 token 与排版前缀），
`.md-preview` 只留容器职责并自身带上 `.md-rendered`，IR widget 根节点也带 `.md-rendered`；
明暗仍走 `:root[data-theme="dark"]` 那两条。判据钉住「preview.css 里 `.md-preview ` 作排版前缀计数为 0」
与「`.md-rendered` 的 token 块唯一」，防的就是「日后有人复制一份 IR 样式」。
字阶/圆角/CJK 抬升继续走 B337/B342/B347 那套 token —— 与 VS Code 走 `--vscode-*` 是同一条纪律。

那颗键的样式独立成一条（绝对定位、`--radius`、`--shadow` 一档、明暗两套），不引 `--vscode-*`。

⚠️ 岛级节奏（B319-A1 那三条 `+ .md-block` 特例）在 IR 下语义变了：岛变成一个个 widget，
`.md-block + .md-block` 跨不过 widget ⇒ 垂直节奏要在 spike 里量，必要时由 widget 外层承担 margin。

### 7. 增强层（公式 / 高亮 / mermaid）

`PreviewPane.enhance()` 现在私有、绑在自己的岛表上。IR 的 widget 需要同样的增强，否则代码块没高亮、
公式还是 `$$…$$` 文本 —— 那会直接砸掉「IR 与预览观感一致」这个卖点。

决定：抽成 `enhanceMarkdown(root, seq)` 一个出口，预览与 IR 各自调用（`seq` 取消语义、`mermaidSeq`
模块级计数器这两条现有纪律原样保留）。这是本版唯一一处对既有代码的实质重构，先补判据再动刀。

## 已知代价（写在这里，避免日后当 bug 查）

1. **三态一键 = 想写字要按两下**（A→B→C）。这是照抄 VS Code 的阅读优先换来的，用户已裁定接受。
   兜底：直达命令（`view.liveRender` + `view.toggleLock`）可在设置里自行绑键，一步到位。
2. **块粒度 = MarkdownIt 顶层块**：长段落、一整个列表都算一块 ⇒ 光标进去后**整块**露源码。
   VS Code 用 iframe 嵌入编辑器绕开代码块那一类，我们本版让复杂块整块退源码。
3. **看不见源码 ⇒ 不知道自己在删什么**：本版三条兜底 —— 默认锁着（阅读态不能改）、
   焦点块左边条（你在哪一块）、循环一发就回纯源码（内容一个字没变）。产品级风险，不是 bug。
4. **每防抖一拍全量算块 + 重算装饰**：长文档开销由 `eq()` 兜住（DOM 不重建），但 `Decoration.set`
   本身 O(块数)。spike 第 4 项量 5,000 行；顶不住再收 viewport 范围（代价是边缘闪动）。
5. **widget 高度变化引起滚动跳动**：`estimatedHeight` 与 `requestMeasure` 实测调。
6. **IR 与折叠互斥**（§5）：进 IR 折叠槽消失，退出还原。
7. **锁态是应用级默认 + 实例级会话两层**：跨窗口/新窗口打开同一文档时可能不一致；
   照 VS Code「翻态影响下一个」的口径处理，不做逐文档记。

## 验收判据（契约层，先红后绿）

- 顶层那颗键与 `Ctrl+/` 的「源码 ⇄ 预览」语义**一字不改**（守卫判据）。
- **三态循环顺序唯一**：`A→B→C→A`，且从 C 不能进 B、从 A 不能进 C（把循环改成有跳态的替身必须被抓红）。
- 「默认锁着」：A→B 恒为 `irLocked = true`，与持久化里读到的值无关；`liveRender`/`irLocked` 各有会话落点，
  非法值回落默认（`"off"` / `true`）。
- **纯函数判据**：`irDecorationsFor` 表驱动用例（光标在内/在外/多光标/跨块选区/首末块/空文档/单行块/锁态）；
  反向对照用内存替身（把「相交就不发」改成「无条件全发」必须被抓红）。
- 锁态三条同时成立：`EditorView.editable(false)`、`EditorState.readOnly`、装饰层「零焦点例外」；
  锁态下任何写入口（键入/粘贴/拖入/命令）不得产生事务；焦点块左边条不画。
- 只读退化：`doc.readonly` 时循环只有 `A ⇄ B`，C 不可达。
- 门槛：`autoPreview` 关档 ⇒ 那颗键不出现（DOM 里没有这颗按钮节点，而不是 `disabled`）。
- 分层：那颗键的定位上下文是**面板壳**，判据不许出现 `position: fixed`（多面板会叠）。
- 编辑路径唯一：全仓「写 CodeMirror 文档」的入口数量不增加；不允许出现 DOM→文本的任何函数。
- 防抖只有一条：`liveRender !== "off"` 才允许 `renderBlocks`；源码面每键不得触发预览 DOM 更新。
- 换态（进渲染、翻锁、回源码）都必须同栈做 `landVisibleSideAtV` + `reconcileSyncRegistrations`
  （后置显隐切换要补落位与重注册，这条是已记录的坑）。
- 样式四条：preview.css 里 `.md-preview ` 排版前缀计数为 0；`.md-rendered` token 块唯一；
  键与焦点块标识不出现写死的颜色/字号/圆角；锁形取 codicon（不许内联手绘 path）。
- 冲突两条：`foldGutter` 与 IR 不得同时注入同一 state；行号扩展必须走 `comps.gutter`（不许再硬编）。
- 键位：两条直达命令默认 `keys: []`，且**全表不出现 `Ctrl+Shift+E`**（那颗已归资源管理器）。
- 体积：新增依赖为 **0**（package.json diff 不得出现新的 markdown 引擎或 `@vscode/*`）。

## 计划阶段的第一件事：spike（一次性，不进产品，全是我们自己的代码）

1. **块级 widget 的确切写法**：`WidgetType` 的 block 声明、覆盖多行区间的 replace 装饰是否合法、
   与 `lineWrapping` 软折行的交互；顺带定 `estimatedHeight` 取值策略。
2. **行号在块装饰下的表现**：被吞的行是否发行号 ⇒ 决定 `comps.gutter` 在 IR 态给什么值。
3. **`mousedown` + `posAtCoords` 进编辑**：能否稳定落进被点那一块；与 `ignoreEvent` 的放行清单。
4. **性能**：5,000 行文档开 IR 后逐键与拖滚动条的帧时间 ⇒ 决定要不要收 viewport 范围。
5. **岛级垂直节奏**：量 IR 下块间距，与只读预览同框 A/B 对像素。
6. **那颗键的落位**：挂在面板壳右下角后，与纵向滚动条、状态栏、查找栏不互压；分屏两格各一颗不重叠；
   与 VS Code 同框比位置与大小（真机台，不读包）。

任一项实测不过 ⇒ 回本文改设计，不许带着已知破口进实现。

### spike 1 + 2 结案（B352-5 那趟一次性探针：jsdom + 真 CM6，9 行文档 / 3 块）

块级标志在**装饰 spec** 上，不在 `WidgetType` 上 —— CM6 没有 `WidgetType.define({block: true})`
（那是 ProseMirror 的形），要写 `Decoration.replace({ widget, block: true })`
（`ReplaceDecorationSpec.block`，`node_modules/@codemirror/view/dist/index.d.ts:176`）。实测四种组合：

| 组合                                             | widget 落点                | 渲染出的行                 | 行号槽                                       |
| ------------------------------------------------ | -------------------------- | -------------------------- | -------------------------------------------- |
| `block:true` · 区间吞尾随换行                    | `.cm-content` 直属（块级） | 每块一个单元，块间不剩裸行 | **一个都没有**（只剩测宽度用的那个隐藏元素） |
| 不带 `block` · 只靠 CSS `display:block` · 吞换行 | 掉进 `.cm-line` 里（内联） | 每块被挤成一行             | 1 / 3 / 7（按块首行）                        |
| `block:true` · 不吞尾随换行                      | `.cm-content` 直属（块级） | 每两块之间多出一行空白     | 2 / 6 / 9（跳号肉眼可见）                    |
| 对照 · 无装饰                                    | —                          | 9 行源码                   | 1–9                                          |

- **spike 1 结案**：Task 6 的写法定死 `Decoration.replace({ widget, block: true })`。内联那一形（不带
  `block`）不能用 —— 它把渲染块塞进 `.cm-line`，标题/列表的行盒与 `lineWrapping` 软折行都跟着乱，
  而且行号变成「按块首行」的第三种口径。
- **delta 2 结案（Task 3 的区间口径成立且必要）**：吞掉尾随换行才换来「每块一个单元、块间不剩裸行」；
  不吞则每两块之间多一行空白。相邻区间半开首尾相接，CM6 全程没报重叠。
- **spike 2 结案（行号）⇒ 裁定**：块装饰下被盖住的源行**不再发行号**；块级 + 吞换行时整份文档一个行号
  都不剩，不吞换行那形则是 2/6/9 的跳号（等于让行号说谎）。⇒ **IR 的两个渲染态（B/C）把
  `comps.gutter` reconfigure 成 `[]`**（行号与折叠槽一起关），回源码态再给回 `gutterExtensions(perf)`。
  这正是 B352-5 把行号搬进 compartment 的原因；Obsidian / VS Code 的渲染态也都不带行号，
  块内定位靠焦点块左侧标识条与大纲跳转。
  ⚠️ 以上是 jsdom 的 DOM 量测（CM6 的结构由 JS 构造，jsdom 与浏览器同构），Task 11 真机验收仍要用眼睛
  结一次案：IR 态左栏干净无残影、回源码态行号原样回来。
- **顺带钉住两条 API 事实（Task 6/7 直接用）**：重配 compartment 的效果是 `comps.x.reconfigure(v)`，
  `.of(v)` 只用于**建状态时**的初值 —— 对已建好的 state 派 `.of()` 会当场抛
  `effect.is is not a function`（探针实测）；另一条：`comps.x` 必须带着初值进初始 extensions，
  不在配置里的 compartment 被 reconfigure 时**不报错、值被静默丢掉**（`tests/ir-compartments.test.ts`
  拿探针扩展钉住了这一点）。

## 我的决定（未征求，可推翻）

- `liveRender` 做**源码面的修饰位**，不把 `viewMode` 扩成三态 —— 守住「顶层那颗键语义不变」，
  并让 `rebuild.ts:326`、`sideOfPanel`、会话白名单三处保持原样。
- 「默认锁着」按**进入渲染态后初始不可写**实现，不改「打开 .md 默认仍是源码面」那条旧裁定（§4.1 末注）。
- 那颗键用 `position: absolute` 挂面板壳，而不是照抄它的 `fixed` —— 多面板会叠（§4.3）。
- 循环之外再给两条直达命令且**都不抢键位**（VS Code 在 Windows 上也没有默认键位，`Ctrl+Shift+E` 已归资源管理器）。
- 命令面板里**保留**条目（VS Code 藏了，我们不藏）。
- 只读文档 C 态不可达（不照抄 VS Code「锁不被文档只读强制」）。
- 抄 `highlightActiveBlock`（焦点块左边条）；IR 与折叠互斥；行号默认保留。
- 块级优先、行内标记留二档；点击块只保证落进这一块、不保证列。
- `.md-rendered` 一次改掉 60 处前缀，而不是给 IR 复制一份样式。
- 增强层抽成 `enhanceMarkdown(root, seq)` 共用。
- 不引 micromark、不引 `@vscode/markdown-editor`：抄骨架与形状，不抄引擎与依赖树。

## 后续（不在本版）

- **行内标记渲染**（`**粗体**` 在非焦点块里隐去星号、`#` 只留字号）——同一套装饰机制上的 mark 级增量。
- **WYSIWYG 那一档**：真·DOM 编辑面，那时才重估外来引擎（vditor 那条账保留在 `d57243e`；
  VS Code 的 Markdown Editor 是另一条账：自制 DOM + micromark + 一串 `@vscode/*` + webview RPC）。
- **IR 顶掉只读预览**：B 态（渲染·锁）与预览在观感上同义 ⇒ 用户说的「后期用即时模式代替当前的预览模式」
  在这套状态里就是「A/B/C 那颗键吃掉预览那一态」。本版仍保留独立预览面。
- 复杂块的就地编辑（代码块/表格）——VS Code 用 iframe 嵌入编辑器，我们用什么待定。
- 更细的块粒度（列表按项、段落按行组）；跨窗口两份实例的渲染/锁态一致性提示。

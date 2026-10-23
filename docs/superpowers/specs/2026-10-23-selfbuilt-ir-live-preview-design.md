# 设计：即时渲染（IR）——自研 CM6 装饰层 + VS Code 那颗「上锁」浮层键

日期：2026-10-23 · 状态：待用户批准 · 工单号拟：B352（B351 已被并行会话的标签肩线那笔占走）

> 沿革：`d57243e` 是「用 vditor 的 IR 寄生在预览格」那一版，已被用户 2026-10-23 裁定推翻
> （`改写成自研 IR 方案`，提交 `24cbf77`）。本版再按用户点名的参照物重做形态设计：
> **`IR模式应该可以参考vscode自带的markdown preview和markdown editor，markdown editor就是在编辑器里
> 有一个悬浮的切换按钮，对编辑能力进行开关（上锁）`**。被这条推翻的是我上一条里的「开关放面板操作区、
> 不做浮层」——我当时否掉浮层的理由是「内容区会滚，浮层要么跟着滚要么挡正文」，
> 而 VS Code 的实现根本不随正文滚（fixed 在视口角上），我那条理由在它面前不成立。

## 意图与为什么

LitePad 现在的 .md 只有两面：CodeMirror 源码、自绘只读预览。用户想要**在渲染结果里直接写**。

不换回 vditor 的理由（架构对不上，不是省钱）：它的 IR 是 contenteditable DOM 面 ⇒ 文本不是真相源 ⇒
必须造 DOM→markdown 回灌，换来全文重打印、两套解析、`setValue` 抹光标、Lute 3.74MB、1,715 行
`fixBrowserBehavior`（WebView2 本来就没那些坑）。自研 IR 是**同一个 CM6 面上加一层装饰**，
文本始终是真相源 ⇒ 输入法/撤销/选中/查找/保存全部继承，体积增量 0
（`@codemirror/view` `@codemirror/state` `@codemirror/language` `@codemirror/lang-markdown` 已在 dependencies）。

## 参照物实测：VS Code 1.143 内置 Markdown Editor（本轮读源码，非推测）

本地 `E:\Project\vscode`（`2d0b7506a36`，`1.143.0`），扩展目录 `extensions/markdown-language-features/`。

### 它确实存在，且是内置的

- 两个 custom editor：`vscode.markdown.preview.editor`（Markdown Preview）与
  **`vscode.markdown.editor`（Markdown Editor）**；后者的 `priority.textEditor` 是 `"option"`
  ⇒ 默认仍用文本编辑器打开 .md，Markdown Editor 要用户显式选。**这一条与 LitePad「默认面不变」的裁定一致。**
- 本体是 npm 包 `@vscode/markdown-editor`（锁 0.0.2-130）。依赖：`micromark`(+gfm/frontmatter/math 扩展)、
  `@vscode/diff`、`@vscode/observables`、`@vscode/codicons`、`katex`、`entities`。
  **没有 ProseMirror，也没有 CodeMirror** ⇒ 它是自制的 DOM 编辑面 + micromark AST。
  这份 checkout 没装 `node_modules` ⇒ **包体读不到**（见下面「读不到的部分」）。

### 它印证的三条骨架（这是我把「自研」写下去的底气）

| VS Code 的做法 | 出处 | LitePad 的对应 |
| --- | --- | --- |
| `vscode.TextDocument` remains the single source of truth | `src/preview/markdownEditorProvider.ts:249-252` 注释 | 同一条：CM6 的 doc 就是真相源，装饰层不写文本 |
| 外发**最小 offset 差量**，不是整篇 | `markdown-editor-src/editor.ts:720-738 computeTextEdit(previousText, text) → {start, endExclusive, text}`；host `:1351-1376` 换 `vscode.Range` 再 `applyEdit` | 天然成立：编辑就发生在 CM6 事务里，变更集管道已在 |
| **撤销归宿主**，编辑器不自持历史 | `editor.ts:450-461 historyStrategy { undo/redo → host }`，注释「`record` is deliberately omitted」；host `:562-573` 先 `editQueue.drain()` 再执行 | `history()` 已在 `baseExtensions` 里，不新增第二条撤销栈 |

外部改动打进编辑面时它传**整篇 + `editEpoch`**（`markdownEditorProtocol.ts:152` → `editor.ts:196
replaceSourceText(new StringValue(content))`），靠 epoch 丢陈旧回声、失败走
`editQueue.invalidate()` + `postAuthoritativeUpdate` 兜底（`markdownEditorProvider.ts:599-651`、
`recoveringTaskQueue.ts:141-158`）。LitePad 不需要这一层：**同一个 CM6 实例、同一份 state**，
外部改动走的还是现有那条变更集管道 ⇒ 连「跨进程对账」这件事都省了。

### 那颗「上锁」浮层键的完整接线（用户点名的这一件）

- **命令**：`markdown.editor.toggleLocked`，标题 **"Toggle Markdown Read-only"**
  （`package.json:509-514`，标 `$generated`；文案 `package.nls.json:373-377`）。
  键位只有 mac `cmd+e`（`package.json:1399-1402`），且**命令面板里隐藏**（`:925-929` `when: "false"`）。
- **链路**：`src/extension.shared.ts:94-102`（所有 `$generated` 命令 → `provider.executeCommand`）
  → `src/preview/markdownEditorProvider.ts:762-769`（`activeWebview.renderer.command({ command })`）
  → `markdown-editor-src/editor.ts:261-274`（`controller.executeCommand(command)`）⇒ **翻转动作在包里做**。
- **状态**：`editor.ts:183 model.readonlyMode.set(initialState.readonly)`；`:571-579` 一变就
  `presentation.set(readonly ? 'reading' : 'editing')` 并回推 host；host 只把它写进
  `globalState`，键名 `markdown.editor.readonly`（`markdownEditorProvider.ts:558-561`、`:263`），
  **默认 `true`**（`:380`、`:1144` → `webviewInitialState.ts:14`）。
  源码注释的口径是「**一个编辑器翻锁，成为下一个的初始模式**」——不是每份文档各记各的。
- **它在哪一层**：`editor/title` 里 7 条贡献全属 preview，**没有一条给 `vscode.markdown.editor`**
  ⇒ 那颗悬浮键是 **webview 里的 DOM（包自己画的）**，不是宿主标题区 UI。
  LitePad 的对应：它必须长在**编辑面自己那层**（`.panel-host` 内、`position: fixed` 不随正文滚），
  不能进 `renderPanelOps`。
- **锁不被文档只读强制**：全扩展 grep `isReadonly` 零命中（`package.json:241,247` 的
  `!activeEditorIsReadonly` 是文本编辑器命令）。⇒ 这条**不照抄**：LitePad 的 `doc.readonly` 是硬事实，
  只读文档连 IR 都不该给（见 §4）。
- **可抄的观感档位**：同目录 CSS 里浮层的写法是 `.md-completion-overlay{position:absolute;z-index:100}`、
  `.md-diagnostic-hover{position:fixed;z-index:110}`，配色全走 workbench 变量
  （`--vscode-editor-background`、`--vscode-cornerRadius-large`、`--vscode-shadow-lg`、
  `--vscode-editor-font-*`、`--vscode-scrollbarSlider-background`）⇒ 与 LitePad B336/B337/B349
  「形状颜色都跟共用 token 走」是同一条纪律。
- **`markdown.editor.*` 设置项实测只有**：`highlightActiveBlock(true)`、`quickSuggestions(false)`、
  `drop.enabled("smart")`、`drop.copyIntoWorkspace("mediaFiles")`、`filePaste.enabled("smart")`、
  `copyIntoWorkspace`、`videoSnippet`、`audioSnippet`、`pasteUrlAsFormattedLink.enabled("smartWithSelection")`、
  `updateLinksOnPaste.enabled(true)`。**没有** `markdown.editor.readonly` 这一项设置——锁只走 globalState。
  其中 **`highlightActiveBlock` 默认开**，正是「你现在落在哪一块」的答案 ⇒ 本版抄（见 §5）。

### 不照搬的部分（以及为什么）

| 它有的 | 出处 | 本版不做的理由 |
| --- | --- | --- |
| 代码块点开 ⇒ 懒加载**真 iframe 编辑器** | `editor.ts:368-388` 动态 import `@vscode/markdown-editor/web-editors`、bootstrap URL 强制 `/fake.html`、协议 `web-editor/0.12`（CONTRIBUTING.md:188） | 那是「把复杂块交给另一个编辑器」的路线；LitePad 让它整块退回原始 markdown 可编辑（第三条路，最省，代价是长代码块没有高亮态编辑） |
| 任务清单也走 iframe provider；checkbox 直接改源 | `taskProgress/taskProgressProvider.ts:18-31`、`editor.ts:417-419 model.setTaskCheckboxChecked` | 本版 IR 里 checkbox 是**内容不是控件**（`ignoreEvent` 吃掉），勾取回源码态手写 `[x]` |
| 评论（`CommentsModel`/`CommentsView`）、诊断悬浮、重命名、补全 | `diagnosticHover.ts`、`renameController.ts`、`completionController.ts`、`markdownEditorLanguageFeatures.ts` | 那是语言服务器 + webview RPC 那一整套；LitePad 的 IR 就在主编辑器实例上，语言特性本来就有 |
| 节点 id + `findNodeOffsetById` 把嵌入编辑器的相对编辑平移回源 offset | 唯一调用点 `editor.ts:402-413`（`blockOffset + block.codeOffset`） | 我们没有嵌入编辑器，不需要；但**它印证了「渲染节点必须能查回源 offset」**——我们的 `MdBlock.lineStart/lineEnd` 就是这个映射，行号↔offset 由 `doc.line(n)` 现成给 |
| 为 diff 视图造的行/块/`innerChanges` 三级脏区间 | `lineDiff.ts:90,151-165,181-198,234-252` | 它是**两个文档对差异**才需要的；IR 是同一个 state 内的事件，CM6 事务自带差量 |

`inner change` 那个概念值得记一句：它指**行数不变但字符变了**（`{line,startColumn,endColumn}`，
`types/previewMessaging.d.ts:10-17`）——行级 diff 看不见、渲染却变了，所以微软专门造了一条通道。
LitePad 没这个坑：我们的块按行区间切、比较的是 `(lineStart, lineEnd, html)`，同步行数不变的字符改动
本来就落在同一条比较里。这是「文本是真相源 + 行区间坐标」顺带免掉的一类 bug。

### 读不到的部分（不装包就只能标成待验，别当已知）

浮动锁键的 DOM 结构与 CSS 选择器、`toggleLocked` 的实现与它的 `commands[]`（`routing`/键位/presentation 读写）、
`EditorModel` 那几个 observable 的语义、节点 id 格式、包内的脏区间增量策略、
以及「编辑态下行内标记到底显不显」（本 checkout 只有 `CONTRIBUTING.md:101-104` 一句 source-marker visibility 的话）。
要钉这些得读包。**我不擅自下载第三方包**；要读的话命令是
`npm pack @vscode/markdown-editor@0.0.2-130`（解开只读，不执行其中代码），你点头我再动。
本版设计不依赖这几件：形状照「fixed 在编辑区角上、不随正文滚、只在 IR 面出现」抄，
像素留到实现轮用真机台与 VS Code 同框比。

## 已定的方向（用户裁定）

1. **`viewMode` 仍是 `source | preview` 两值，顶层那颗键与 `Ctrl+/` 的语义一字不改**；
   IR 是**源码面的渲染态**，默认面不变（VS Code 的 `priority: "option"` 与此一致）。
2. 先只上即时渲染（IR）；WYSIWYG 缓上，只留枚举位。IME 在这条路线上不构成红线
   （输入面就是天天在用的源码面）。
3. 会话记住开关，启动懒重建（只给活动实例开装饰）。
4. 本轮新增：**那颗键是编辑面内的悬浮键，管「能不能改」（上锁），不是管渲染**（用户点名照 VS Code）。
   ⇒ 渲染与可写性拆成两维（§4）。
5. 随路线失效的一条：原「编辑面不参与同步滚动」。IR 就是 `sideOfPanel`（src/sync-scroll/wire.ts:99）
   眼里的 source 那一格 ⇒ 同步滚动/大纲/查找**零改动自动成立**，本版按「自动参与」处理。

## 目标

- `Tab` 新增两个实例级字段：`liveRender: "off" | "ir"`（`"wysiwyg"` 预留，不进 UI 与持久化白名单）
  与 `irLocked: boolean`（锁）。`viewMode` 不动。
- 编辑面右下角一颗悬浮锁键：只在 `liveRender === "ir"` 时出现；点亮 = 解锁可写，
  再按 = 上锁阅读。`Ctrl+E`（与 VS Code mac `cmd+e` 同位，走 `src/shell/keymap.ts` 统一注册，
  设置页里可改）；命令面板里**照 VS Code 隐藏**它吗？——不隐藏，见 §4。
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
- 不改只读预览那一面的任何现有行为。

## 反目标（什么会让这件事算失败）

- **文本不再是唯一真相**：任何把渲染结果反向写回文档的代码路径。
- **每敲一个字全篇重画**：装饰层不许无条件重建所有块 DOM（`eq()` 必须真生效）。
- **锁着却还能改**：锁态下任何写路径（含粘贴、拖入、复选框、`Cmd+Enter` 一类）都必须进不来。
- **排版规则复制第二份**：IR 与预览各写一套标题/列表/表格样式，日后必然漂移。
- **装饰与折叠/查找高亮互相吞**：两套「隐藏行」或抢同一段区间的装饰叠在一起。
- **切渲染/翻锁引起位置跳变**：历代病灶（B293/B277/B288）；两颗键都必须按 v 落位。
- **纯浏览也改写文件**：本版不可能（没有 DOM→文本打印器），判据要钉住防日后加回来。

## 约束

- 交付铁律照旧：不自动推送、不打 tag；出包前显式 bump（patch 自决，minor/major 先问）；
  契约测试先行；不用 `--no-verify`；并行会话 ⇒ 改完立刻点名 `git add` 自己的文件。
- 体积增量：**0**（无新依赖、无 vendor 资源）。
- 大文件：沿用 `perfProfileFor(sizeClass).autoPreview` 那一档门槛（>2MB 自动预览本来就停了），
  关在门槛外 ⇒ 大文件不出现这颗键。不新立一套尺寸策略。

## 机制设计

### 1. 数据来源：已有的 `MdBlock`，不另起解析

`renderBlocks()`（src/markdown/pipeline.ts）已产出 `MdBlock { lineStart, lineEnd, html }`——
块级 IR 要的正好只有区间与 HTML。IR 复用预览那一条 MarkdownIt 配置（`html:false, linkify:true`
+ footnote + 任务列表规则），所以「IR 里看到的」与「切到预览看到的」在语法层面不可能不一致。
VS Code 走 micromark 而 We 走 markdown-it，**引擎不必跟**：要抄的是它的三条骨架，不是它的解析器。

⚠️ 不用 CM6 语法树切块：`syntaxTree` 给边界不给 HTML，最终仍要渲染器，多一套边界口径不如共用一套。

### 2. 装饰层：三件套

- `irBlocks` **StateField**：装当前 state 的 `MdBlock[]`，由事务效果写入；写入源与预览共用
  同一条 120ms 防抖（src/markdown.ts:95 `scheduleMdRender`），**渲染开时才跑**。
- **纯函数 `irDecorationsFor(blocks, selections, doc, locked): Decoration[]`**：
  `locked` ⇒ 所有块都装饰（无光标例外）；否则块区间与任一改选区不相交 ⇒ 发一条
  `Decoration.replace({ widget })` 覆盖 `doc.line(lineStart).from .. doc.line(lineEnd).to`，相交 ⇒ 不发。
  **这一个函数是本设计的 TDD 重心**：不碰 DOM、不碰 CM 实例，正反判据都能写成表驱动用例。
- **ViewPlugin**：`selectionSet || docChanged || viewportChanged` 时重算，产出 `EditorView.decorations`。
  光标移动不产生事务 ⇒ 必须靠 ViewPlugin 才做得到「点一下就散开」。

widget：`WidgetType` 子类，`toDOM()` 造 `<div class="md-rendered md-ir-block"><div class="md-block">…</div></div>`；
`eq()` 比 `(lineStart, lineEnd, html)`，命中就复用现有 DOM；`ignoreEvent()` 只放行 `mousedown`、
吃掉其它（链接与复选框在 IR 里是**内容**不是**控件**，与 VS Code 把 checkbox 交回源文本一个口径）。

⚠️ 「块级 widget」的确切写法是 spike 第 1 项（`WidgetType.define({ block: true })` 那一路，
还是整行区间 `Decoration.replace` + `display:block`）。设计只承诺机制（区间替换 + 块级 DOM），不承诺拼写。

### 3. 进入编辑的那一下

- **键盘**：光标移进块区间 ⇒ 选区相交 ⇒ 装饰消失，原始文本现形。零代码。
- **鼠标**：widget 上 `mousedown` ⇒ `view.posAtCoords()` 反查 ⇒ dispatch selection ⇒ 该块装饰消失。
  列级精度不保证，保证的是**这一块的合理位置**；反查失败就落该块 `lineStart` 行首，不报错不吞点击。
- 锁态：`mousedown` 不派发选区（`EditorView.editable(false)` 已挡，但装饰层也得按 `locked` 全装饰，
  两层各自成立才算锁死）。

### 4. 状态与那颗键（本轮按用户点名的形状重做）

两维分开，与 VS Code 同构：

- `liveRender`：**渲染**。入口 = 命令 `切换即时渲染`（菜单「视图」+ 命令面板 + `Ctrl+Shift+E`），
  点亮即进 IR 面；顶层 `Ctrl+/` 的源码⇄预览语义不动。
- `irLocked`：**可写性**（用户说的「上锁」）。键 = 编辑面内的**悬浮层**，`position: fixed` 钉在
  编辑区右下角、不随正文滚，只在 `liveRender === "ir"` 时出现；只在 IR 面出现 ⇒
  `doc.readonly` 或大文件门槛外时 IR 根本进不去，那颗键自然不出现（不照抄 VS Code「不理文档只读」那条）。
- **默认值**：进入 IR **默认解锁**（可写）。VS Code 默认 `readonly=true` 是因为它把 Markdown Editor
  当**阅读优先**的入口；LitePad 的默认面是可写的源码面，照抄「默认锁着」会让用户两下才能开始写。
  ⇒ 这条是我猜的产品口径，标在下面「我的决定」里等你裁决。
- **翻锁影响下一份**：照 VS Code 的 globalState 语义 —— `irLocked` 记一个**应用级**默认值
  （新实例继承上次翻到的那一档），同时**也**记进实例会话（`Tab.irLocked` 进持久化白名单）。
  两条不冲突：会话恢复优先，新建实例走应用级默认。
- 撤销/重做**归 CM6**（`history()` 已在），与 VS Code「归宿主」同构，不新增第二条撤销栈。
- 键位走 `src/shell/keymap.ts` 统一注册（菜单显示与实际生效始终一致）；
  提示走 **B350 按钮档**（`setTip`，带小尖尖）。命令面板里**不**照 VS Code 隐藏 —— 它有键位却搜不到，
  对 LitePad 这种「命令面板即帮助」的软件是净损失。

### 5. 与既有扩展的冲突处置（我的决定）

- `lineNumbers()` 与 `foldGutter()` 现在硬编在 `baseExtensions`（src/editor/editor.ts:60-99），
  挪进新的 `comps.gutter` 才能按实例切；挪时保留 M4 的 `perf.folding` 门槛
  （`perf.folding ? foldGutter(...) : []` 整条进 compartment 值，不是进判断后再 push）。
- **折叠与 IR 互斥**：两者都在「藏行」，重叠的 `Decoration.replace` 行为不可预期。
  进 IR 撤 `foldGutter`，退出还原。
- **行号在块装饰下的实际表现**（被吞的行还发不发号、跳号刺不刺眼）是 spike 第 2 项；
  默认倾向**保留行号**，因为大纲「第 N 行」、状态栏、查找落点全都以行号为坐标。
- **焦点块标识**（抄 `markdown.editor.highlightActiveBlock`，默认开）：给光标所在块发一条
  `Decoration.line` 左边条，颜色走 `--border`/`--accent` 一档，不写死。
- 查找高亮、括号匹配、选中匹配高亮都是 mark 级，与 replace 级不抢语义，不动；
  spike 第 3 项实测「命中文字正好在被渲染的块里」时的可见性。

### 6. 外观：一份排版规则，两个容器 + 一层浮

现在 preview.css 里 `.md-preview` 出现 60 次，容器职责（`overflow-y`、`padding: 16px 24px 48px`、
背景色）与全部排版选择器的前缀混在一起，还兼着 `--md-*` token 定义。IR 的 DOM 挂在 `.cm-content` 里，借不到前缀。

决定：把「token + 排版」从「容器」里剥出来——新增共用类 `.md-rendered`（搬 token 与排版前缀），
`.md-preview` 只留容器职责并自身带上 `.md-rendered`，IR widget 根节点也带 `.md-rendered`；
明暗仍走 `:root[data-theme="dark"]` 那两条。判据钉住「preview.css 里 `.md-preview ` 作排版前缀计数为 0」
与「`.md-rendered` 的 token 块唯一」，防的就是「日后有人复制一份 IR 样式」。
字阶/圆角/CJK 抬升继续走 B337/B342/B347 那套 token，与 VS Code 走 `--vscode-*` 是同一条纪律。

浮层那颗键：新增一条 `.md-ir-lock { position: fixed; z-index: … }`，档位照 VS Code 的
`overlay:absolute/100`、`hover:fixed/110` 那对关系，具体值等实现时与现有浮层（findbar、菜单）同框比；
背景/边框/圆角/阴影全部取 LitePad 现有 token，不引 `--vscode-*`。

⚠️ 岛级节奏（B319-A1 那三条 `+ .md-block` 特例）在 IR 下语义变了：岛变成一个个 widget，
`.md-block + .md-block` 跨不过 widget ⇒ 垂直节奏要在 spike 里量，必要时由 widget 外层承担 margin。

### 7. 增强层（公式 / 高亮 / mermaid）

`PreviewPane.enhance()` 现在私有、绑在自己的岛表上。IR 的 widget 需要同样的增强，
否则代码块没高亮、公式还是 `$$…$$` 文本——那会直接砸掉「IR 与预览观感一致」这个卖点。

决定：抽成 `enhanceMarkdown(root, seq)` 一个出口，预览与 IR 各自调用
（`seq` 取消语义、`mermaidSeq` 模块级计数器这两条现有纪律原样保留）。
这是本版唯一一处对既有代码的实质重构，先补判据再动刀。

## 已知代价（写在这里，避免日后当 bug 查）

1. **块粒度 = MarkdownIt 顶层块**：长段落、一整个列表都算一块 ⇒ 光标进去后**整块**露源码。
   VS Code 用 iframe 嵌入编辑器绕开了代码块这一类，我们本版让复杂块整块退源码。
2. **看不见源码 ⇒ 不知道自己在删什么**：本版三条兜底 —— 锁（默认阅读态不能改）、
   焦点块左边条（你在哪一块）、`Ctrl+/` 一键回纯源码（语义不动，回得去）。产品级风险，不是 bug。
3. **每防抖一拍全量算块 + 重算装饰**：长文档开销由 `eq()` 兜住（DOM 不重建），但
   `Decoration.set` 本身 O(块数)。spike 第 4 项量 5,000 行；顶不住再收 viewport 范围（代价是边缘闪动）。
4. **widget 高度变化引起滚动跳动**：`estimatedHeight` 与 `requestMeasure` 实测调。
5. **IR 与折叠互斥**（§5）：进 IR 折叠槽消失，退出还原。
6. **锁是实例级 + 应用级默认两层**：跨窗口/新窗口打开同一文档时，锁态可能不一致；
   照 VS Code「翻锁影响下一个」的口径处理，不做逐文档记。

## 验收判据（契约层，先红后绿）

- 顶层那颗键与 `Ctrl+/` 的「源码 ⇄ 预览」语义**一字不改**（守卫判据）。
- `liveRender` 生效值只有 `"off" | "ir"`；`"wysiwyg"` 不进 UI 也不进持久化白名单；
  `irLocked` 与 `liveRender` 各有会话落点，非法值回落默认。
- **纯函数判据**：`irDecorationsFor` 表驱动用例（光标在内/在外/多光标/跨块选区/首末块/空文档/
  单行块/**锁态**）；反向对照用内存替身（把「相交就不发」改成「无条件全发」必须被抓红）。
- 锁态三条：`EditorView.editable(false)` 与 `EditorState.readOnly` 同时置；锁态下装饰层
  必须「零焦点例外」；锁态下任何写入口（粘贴/拖入/命令）不得产生事务。
- 编辑路径唯一：全仓「写 CodeMirror 文档」的入口数量不增加；不允许出现 DOM→文本的任何函数。
- 防抖只有一条：`liveRender !== "off"` 才允许 `renderBlocks`；源码面每键不得触发预览 DOM 更新。
- 两颗键（进 IR、翻锁）都必须同栈做 `landVisibleSideAtV` + `reconcileSyncRegistrations`
  （后置显隐切换要补落位与重注册，这条是已记录的坑）。
- 样式四条：preview.css 里 `.md-preview ` 排版前缀计数为 0；`.md-rendered` token 块唯一；
  悬浮键不出现写死的颜色/字号；焦点块左边条的颜色取自 token。
- 冲突两条：`foldGutter` 与 IR 不得同时注入同一 state；行号扩展必须走 `comps.gutter`（不许再硬编）。
- 门槛：`doc.readonly` 或 `autoPreview` 关档 ⇒ 进不去 IR，悬浮键不出现（不是「进去了但点了没反应」）。
- 体积：新增依赖为 **0**（package.json diff 不得出现新的 markdown 引擎或 `@vscode/*`）。

## 计划阶段的第一件事：spike（一次性，不进产品，全是我们自己的代码）

1. **块级 widget 的确切写法**：`WidgetType` 的 block 声明、覆盖多行区间的 replace 装饰是否合法、
   与 `lineWrapping` 软折行的交互；顺带定 `estimatedHeight` 取值策略。
2. **行号在块装饰下的表现**：被吞的行是否发行号 ⇒ 决定 `comps.gutter` 在 IR 态给什么值。
3. **`mousedown` + `posAtCoords` 进编辑**：能否稳定落进被点那一块；与 `ignoreEvent` 的放行清单。
4. **性能**：5,000 行文档开 IR 后逐键与拖滚动条的帧时间 ⇒ 决定要不要收 viewport 范围。
5. **岛级垂直节奏**：量 IR 下块间距，与只读预览同框 A/B 对像素。
6. **悬浮锁键的落位与出现时机**：与 VS Code 同框比（位置、大小、hover 行为）；
   若你要钉死包内那几件，先给我 `npm pack @vscode/markdown-editor@0.0.2-130` 的授权。

任一项实测不过 ⇒ 回本文改设计，不许带着已知破口进实现。

## 我的决定（未征求，可推翻）

- `liveRender` 做**源码面的修饰位**，不把 `viewMode` 扩成三态 —— 守住「顶层那颗键语义不变」，
  并让 `rebuild.ts:326`、`sideOfPanel`、会话白名单三处保持原样。
- **渲染与可写性拆两维**（照 VS Code）：入口是命令，悬浮键只管锁。
- **进 IR 默认解锁**（不照抄 VS Code 的 `readonly` 默认 true），但翻锁后的那一档记成应用级默认，
  照它「一个编辑器翻锁成为下一个的初始模式」的口径。
- 只读文档不给 IR（不照抄 VS Code「锁不被文档只读强制」那条）。
- 命令面板里**保留**那颗锁键的条目（VS Code 藏了，我们不藏）。
- 块级优先、行内标记留二档；点击块只保证落进这一块、不保证列。
- 抄 `highlightActiveBlock`（焦点块左边条），且 IR 与折叠互斥；行号默认保留。
- `.md-rendered` 一次改掉 60 处前缀，而不是给 IR 复制一份样式。
- 增强层抽成 `enhanceMarkdown(root, seq)` 共用。
- 不引 micromark、不引 `@vscode/markdown-editor`：抄骨架与形状，不抄引擎与依赖树。

## 后续（不在本版）

- **行内标记渲染**（`**粗体**` 在非焦点块里隐去星号、`#` 只留字号）——同一套装饰机制上的 mark 级增量。
- **WYSIWYG 那一档**：真·DOM 编辑面，那时才重估外来引擎（vditor 那条账保留在 `d57243e`；
  VS Code 的 Markdown Editor 是另一条账：自制 DOM + micromark + 一串 `@vscode/*` + webview RPC）。
- **IR 顶掉只读预览**：锁着的 IR 与预览在观感上同义 ⇒ 用户说的「后期用即时模式代替当前的预览模式」
  在这套两维状态里就是「IR + 锁」吃掉预览那一态。本版仍保留独立预览面。
- 复杂块的就地编辑（代码块/表格）——VS Code 用 iframe 嵌入编辑器，我们用什么待定。
- 更细的块粒度（列表按项、段落按行组）；跨窗口两份实例的渲染/锁态一致性提示。

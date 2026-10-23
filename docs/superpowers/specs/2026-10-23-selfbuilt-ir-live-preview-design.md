# 设计：在源码面上做「即时渲染（IR）」——自研 CM6 装饰层，Obsidian 同款机制

日期：2026-10-23 · 状态：待用户批准 · 工单号拟：B352（B351 已被并行会话的标签肩线那笔占走）

> 本文替换 `d57243e` 那份「用 vditor 的 IR 寄生在预览格」的设计。用户 2026-10-23 裁定：
> 「改写成自研 IR 方案」。被推翻的那条是原裁定第 1 条（引入 vditor、不自研编辑面）；
> 其余裁定大部分继续生效，只有两条因路线换血必须重述，见下面「随路线失效」那一节。

## 意图与为什么

LitePad 现在的 .md 只有两面：CodeMirror 源码、自绘只读预览。用户想要**在渲染结果里直接写**。

换掉 vditor 的理由不是「自研更省钱」，是架构对不上：

- vditor 的 IR 是 **contenteditable DOM 面**，文本不是真相源 ⇒ 必须造一条 DOM→markdown 的
  回灌管道，代价是全文重打印、两套解析并存、光标与撤销栈被 `setValue` 抹掉、+1.5～2.5MB 的
  Lute、以及一整层 1,715 行的 `fixBrowserBehavior`（我们跑在 WebView2，那一半坑我们本来就没有）。
- 自研 IR 是**同一个 CodeMirror 面上加一层装饰**：文本始终是真相源，撤销/输入法/选中/粘贴/
  查找/保存全部继承现状，体积增量为零（`@codemirror/view` `@codemirror/state` `@codemirror/language`
  `@codemirror/lang-markdown` 都已在 dependencies）。
- 这一条路线有名字、有先例：Obsidian 的 Live Preview 就是这个机制（CM6 `ViewPlugin` + 语法树 +
  `Decoration.replace({ widget })`，光标所在块露原始 markdown、其它块显示渲染结果）。
  它闭源，抄不了源码，能抄的是模式；开源侧可参照 `obsidian-cm6-attributes` 与 `@atomic-editor/editor`
  （许可证使用前需单独核实）。

## 已定的方向（用户裁定）

1. **`viewMode` 仍是 `source | preview` 两值，顶层那颗键与 `Ctrl+/` 的语义一字不改**。
   可编辑能力是**源码面上的一个渲染开关**，不是第四个平级视图（原话：「还是源码和预览切换，
   只不过……添加一个是否可编辑的切换按钮，也可以是一个三态的切换按钮」）。
   本版做二态（渲染关 ⇄ 渲染开），结构上给三态留位。
2. 先只上即时渲染（IR）；所见即所得（WYSIWYG）缓上，只留枚举位。
   （IME 那一条红线在新路线下降级：IR 的输入面就是今天的源码面，中文输入法**已经在用、已经通过**。）
3. 会话**记住开关**，启动时懒重建（只给活动实例开装饰）。
4. 打开 .md 的默认行为不变（渲染关，纯源码）。

### 随路线失效 / 变更的两条

- 原裁定「可编辑开关放**预览格头部**」：IR 现在长在**源码面**上，预览格里没有可以点亮它的东西
  ⇒ 那颗键移到面板操作区（与现成的源码⇄预览那颗键同排）。
- 原裁定「编辑面**不参与**同步滚动」：这是 vditor 路线的补丁（外来的 DOM 面报不出行坐标，
  硬接进账本只会重演 B293/B301 读隐藏侧兜底 `1.00` 那一族）。自研 IR **就是源码侧那一格**，
  `sideOfPanel`（src/sync-scroll/wire.ts:99）本来就把它算成 source 面 ⇒
  同步滚动、大纲跳转、查找**一行代码都不用改就自动成立**。本版按「自动参与」处理。

## 目标

- `Tab` 新增实例级字段 `liveRender: "off" | "ir"`（`"wysiwyg"` 预留，本版不进 UI、不进持久化白名单）。
- 源码面上出现一颗「即时渲染」小键：只在 `.md` 且当前格是源码态时可见；点亮 ⇒ 该实例的块
  渲染进编辑器；熄灭 ⇒ 回到纯源码。
- 光标落进哪一块，哪一块就退回原始 markdown 可编辑；离开 ⇒ 重新渲染。多光标：任一选区与块相交，
  该块就保持源码态。
- 观感与只读预览**同一批 CSS 规则**（不允许出现第二份 markdown 排版定义）。
- 改的字落到**同一份文档真相**：脏标记、保存、外部改动冲突框、热退出副本、跨窗口广播全部走现有那条链。

## 非目标（本版明确不做）

- 不上 WYSIWYG，不做 contenteditable。
- 不做**行内**标记渲染（`**粗体**` 的星号在光标所在块内照旧可见，跨块的行内样式不动）——
  本版只做**块级**：标题、列表、引用、代码块、表格、任务列表、分割线、图片。
- 不做「点渲染内容里的某个字精确落到第几列」的列级映射；点击块只保证落进**这一块**。
- 不引工具栏、不引上传（图片粘贴仍按插入 markdown 文本处理，不落文件、不上传）。
- 不改只读预览那一面的任何现有行为。

## 反目标（什么会让这件事算失败）

- **文本不再是唯一真相**：任何把渲染结果反向写回文档的代码路径。
- **每敲一个字全篇重画**：装饰层不许无条件重建所有块的 DOM（`eq()` 必须真生效）。
- **排版规则复制第二份**：IR 与预览各写一套标题/列表/表格样式，日后必然漂移。
- **装饰与折叠/查找高亮互相吞**：两套「隐藏行」或两套「抢同一段区间」的装饰叠在一起。
- **切渲染开关引起位置跳变**：这一族的病灶历代都有（B293/B277/B288），开关必须按 v 落位。
- **纯浏览也改写文件**：本版不可能（没有 DOM→文本的打印器），但判据要钉住，防止日后加回来。

## 约束

- 交付铁律照旧：不自动推送、不打 tag；出包前显式 bump（patch 自决，minor/major 先问）；
  契约测试先行；不用 `--no-verify`；同工作树可能有并行会话 ⇒ 改完立刻点名 `git add` 自己的文件。
- 体积增量：**0**（无新依赖、无 vendor 资源）。
- 只读文档（`doc.readonly`）：**不给这颗键**（「看起来能改、点了没反应」比没有更糟）。
- 大文件：沿用 `perfProfileFor(sizeClass).autoPreview` 那一档门槛（>2MB 自动预览本来就停了），
  关在门槛外 ⇒ 大文件不出现这颗键。不新立一套尺寸策略。

## 机制设计

### 1. 数据来源：已有的 `MdBlock`，不另起解析

`renderBlocks()`（src/markdown/pipeline.ts）已经产出 `MdBlock { lineStart, lineEnd, html }`——
块级 IR 要的正好只有这两样：**区间**（决定装饰范围）与 **HTML**（决定 widget 内容）。
IR 用的就是预览那一条 MarkdownIt 配置（`html:false, linkify:true` + footnote + 任务列表规则），
所以「IR 里看到的」与「切到预览看到的」在语法层面不可能不一致，这是自研路线白捡的保真度。

⚠️ 不用 CM6 语法树来切块：`syntaxTree` 给边界不给 HTML，最终仍要渲染器，多一套边界口径不如共用一套。

### 2. 装饰层：三件套

- `irBlocks` **StateField**：装当前这份 state 的 `MdBlock[]`，由一个事务效果写入；写入源与预览
  共用同一条 120ms 防抖（src/markdown.ts:95 `scheduleMdRender`），**渲染开时**才跑。
- **纯函数 `irDecorationsFor(blocks, selections, doc): Decoration[]`**：块区间与任一选区不相交
  ⇒ 发一条 `Decoration.replace({ widget })` 覆盖 `doc.line(lineStart).from .. doc.line(lineEnd).to`；
  相交 ⇒ 不发。**这一个函数是本设计的 TDD 重心**：不碰 DOM、不碰 CM 实例，正反判据都能写成表驱动用例。
- **ViewPlugin**：`update.selectionSet || update.docChanged || update.viewportChanged` 时重算，
  产出 `EditorView.decorations`。光标移动不产生事务 ⇒ 靠 ViewPlugin 才做得到「点一下就散开」。

- **widget**：`WidgetType` 子类，`toDOM()` 造 `<div class="md-rendered md-ir-block"><div class="md-block">…</div></div>`；
  `eq()` 比 `(lineStart, lineEnd, html)`，命中就复用现有 DOM；`ignoreEvent()` 默认放行 `mousedown`、
  吃掉其它（链接、复选框在 IR 里不许有行为，它们是**内容**不是**控件**）。

⚠️ 「块级 widget」的确切写法是 spike 第 1 项：`WidgetType.define({ block: true })` 那一路，
还是整行区间 `Decoration.replace` + `display:block` 的 DOM。设计只承诺机制（区间替换 + 块级 DOM），
不承诺拼写。

### 3. 进入编辑的那一下

- **键盘**：方向键把光标移进块区间 ⇒ 选区相交 ⇒ 装饰自然消失，原始文本现形。零代码。
- **鼠标**：widget 上的 `mousedown` ⇒ `view.posAtCoords()` 反查 ⇒ dispatch 一个 selection ⇒
  该块落入「选区相交」集合 ⇒ 装饰消失。列级精度不保证（非目标），保证的是**这一块的合理位置**。
- 空选区退化：点在某块上但反查失败 ⇒ 落到该块 `lineStart` 行首，不报错、不吞点击。

### 4. 开关落在哪、怎么切（我的决定）

- `Tab.comps` 新增 `ir: Compartment`（src/editor/editor.ts:116-120 `TabCompartments`）；
  切开关 = `tab.state.update({ effects: comps.ir.reconfigure(...) })`，与 `wrap`/`lang`/`theme`
  同一套路 ⇒ **切标签不会漏染**（每份实例各自带自己的 compartment 值），`setState` 整态切换天然带走。
- 这颗键进**面板操作区**（`renderPanelOps`，src/tabs/render.ts:155），与源码⇄预览那颗键同排、同族
  写法（`is-on`），提示走 **B350 的按钮档**（`setTip`，带小尖尖）。
- 点亮/熄灭那颗键必须**按 v 落位 + `reconcileSyncRegistrations()`**：`applyPanelMode` 那句注释
  （src/markdown.ts:131-155）讲的「先读 v、后换状态、同栈落位」顺序在这里同样成立——
  装饰一上，行长全变，这就是历代跳顶病灶的形状。这条必须有判据。

### 5. 与既有扩展的冲突处置（我的决定）

- `lineNumbers()` 与 `foldGutter()` 现在硬编在 `baseExtensions`（src/editor/editor.ts:60-99），
  挪进新的 `comps.gutter` 才能按实例切；挪的时候必须保留 M4 的 `perf.folding` 门槛
  （`perf.folding ? foldGutter(...) : []` 整条进 compartment 值，不是进判断后再 push）。
- **折叠与 IR 互斥**：两者都在「藏行」，重叠的 `Decoration.replace` 行为不可预期。本版决定
  进入 IR 时把 `foldGutter` 一并撤掉（同一个 `comps.gutter` 换值），退出时还原。
- **行号在块装饰下的实际表现**（被吞的行还发不发号、跳号刺不刺眼）是 spike 第 2 项；
  默认倾向**保留行号**，因为大纲「第 N 行」、状态栏、查找落点全都以行号为坐标。
- 查找高亮（`findHighlight`）、括号匹配、选中匹配高亮都是 mark 级，与 replace 级不抢同一语义，
  不动；spike 第 3 项负责实测「命中文字正好在被渲染的块里」时可见性是否符合预期。

### 6. 外观：一份排版规则，两个容器

现在 preview.css 里 `.md-preview` 出现 60 次，既有容器职责（`overflow-y`、`padding: 16px 24px 48px`、
背景色）也带 `--md-*` token 定义，还兼任全部排版选择器的前缀。IR 的 DOM 挂在 `.cm-content` 里，
借不到这个前缀。

决定：把「token + 排版」从「容器」里剥出来——

- 新增共用类 `.md-rendered`：搬走 `--md-*` token 定义与全部排版选择器前缀；
- `.md-preview` 只留容器职责，自身也带上 `.md-rendered`（明暗仍走 `:root[data-theme="dark"]` 那两条）；
- IR widget 根节点带 `.md-rendered`。

判据钉住「preview.css 里 `.md-preview ` 作为排版前缀的出现次数为 0」与「`.md-rendered` 的 token 块只有一处」，
防的就是「日后有人复制一份 IR 样式」。字阶/圆角/CJK 抬升继续走 B337/B342/B347 那套 token，不写死数值。

⚠️ 岛级节奏（B319-A1 那三条 `+ .md-block` 特例）在 IR 下语义不变：IR 的「岛」就是一个个 widget，
`.md-block + .md-block` 变成跨 widget，选择器命中不到 ⇒ 垂直节奏要在 spike 里量，
必要时改由 widget 外层承担 margin（这条不算反目标，但算高危）。

### 7. 增强层（公式 / 高亮 / mermaid）

`PreviewPane.enhance()` 现在是私有方法、绑在自己的岛表上。IR 的 widget 需要同样的增强，
否则 IR 里的代码块没高亮、公式还是 `$$…$$` 文本——那会直接砸掉「IR 与预览观感一致」这个卖点。

决定：抽成 `enhanceMarkdown(root, seq)` 一个出口，预览与 IR 各自调用（`seq` 的取消语义、
`mermaidSeq` 模块级计数器这两条现有纪律原样保留）。这是本版唯一一处对既有代码的实质重构，
先补判据再动刀。

## 已知代价（写在这里，避免日后当 bug 查）

1. **块粒度 = MarkdownIt 顶层块**：一个长段落、一整个列表都算一块 ⇒ 光标进去后**整块**露源码。
   Obsidian 也是这个粒度；要更细得自己切（后续项）。
2. **看不见源码 ⇒ 不知道自己在删什么**：`**` 掉了、`|` 少了，渲染照常，源文本已改。本版兜底是
   那颗键一键回到纯源码（`Ctrl+/` 语义不动，回得去）。这是产品级风险，不是 bug。
3. **每防抖一拍全量算块 + 重算装饰**：长文档上的开销由 `eq()` 兜住（DOM 不重建），
   但 `Decoration.set` 本身是 O(块数)。spike 第 4 项量 5,000 行文档；顶不住再收 viewport 范围
   （代价是边缘闪动）。
4. **widget 高度变化会引起滚动跳动**：需要 `estimatedHeight` 与 `requestMeasure`，实测调。
5. **IR 与折叠互斥**（见 §5）：切进 IR 时折叠槽消失，退出还原。
6. **同一文档两份实例可以一个开一个关**（`liveRender` 是实例级）：这是现状 `viewMode` 的既有语义，
   不算 bug，但跨窗口同步时「一边渲染一边没渲染」的画面差异要预先告知用户。

## 验收判据（契约层，先红后绿）

- 顶层那颗键与 `Ctrl+/` 的「源码 ⇄ 预览」语义**一字不改**（守卫判据，沿用上一版设计里那条）。
- `liveRender` 生效值只有 `"off" | "ir"`；持久化读到其它值回落 `"off"`；默认仍是关；`"wysiwyg"` 不进白名单。
- 判据中心是**纯函数**：`irDecorationsFor` 表驱动用例（光标在内/在外/多光标/跨块选区/首末块/
  空文档/单行块）；反向对照用内存替身（把「相交就不发」改成「无条件全发」必须被抓红）。
- 编辑路径唯一：全仓「写 CodeMirror 文档」的入口数量不增加；不允许出现 DOM→文本的任何函数。
- 防抖只有一条：`liveRender !== "off"` 才允许 `renderBlocks`；源码面每键不得触发预览 DOM 更新。
- 开关那颗键点亮/熄灭必须同栈做 `landVisibleSideAtV` + `reconcileSyncRegistrations`
  （后置显隐切换要补落位与重注册，这条是已记录的坑）。
- 样式两处：preview.css 里 `.md-preview ` 排版前缀计数为 0；`.md-rendered` 的 token 块唯一。
- 冲突两条：`foldGutter` 与 IR 不得同时注入同一 state；行号扩展必须走 `comps.gutter`（不许再硬编）。
- 只读与大文件：`doc.readonly` 或 `autoPreview` 关档 ⇒ 那颗键不出现（渲染关，不是渲染了但禁写）。
- 体积：`dist/assets` 与安装包的**新增依赖为 0**（package.json diff 不得出现新 `@codemirror/*`
  或任何 markdown 引擎）。

## 计划阶段的第一件事：spike（一次性，不进产品，全是我们自己的代码）

1. **块级 widget 的确切写法**：`WidgetType` 的 block 声明方式、覆盖多行区间的 replace 装饰是否合法、
   与 `lineWrapping` 软折行的交互；顺带定下 `estimatedHeight` 取值策略。
2. **行号在块装饰下的表现**：被吞的行是否发行号；决定 `comps.gutter` 在 IR 态给什么值。
3. **`mousedown` + `posAtCoords` 进编辑**：能否稳定落进被点那一块；与 `ignoreEvent` 的放行清单。
4. **性能**：5,000 行文档开 IR 后逐键与滑动滚动条的帧时间；结论决定要不要收 viewport 范围。
5. **岛级垂直节奏**（§6 末尾那条）：量 IR 下块间距，与只读预览同框 A/B 对像素。

任一项实测不通过 ⇒ 回到本文改设计，不许带着已知破口进实现。

## 我的决定（未征求，可推翻）

- `liveRender` 作为**源码面的修饰位**，而不是把 `viewMode` 扩成三态 —— 为的是守住「顶层那颗键语义不变」那条裁定，
  并让 `rebuild.ts:326`、`sideOfPanel`、会话白名单这三处保持原样。
- 键放面板操作区（与切换键同排），不放编辑器内容浮层。
- 块级优先、行内标记留二档；点击块只保证落进这一块、不保证列。
- IR 与折叠互斥；行号默认保留。
- `.md-rendered` 一次改掉 60 处前缀，而不是给 IR 复制一份样式。
- 增强层抽成 `enhanceMarkdown(root, seq)` 共用。
- 只读与大文件不给开关（不是「开关在但点了不生效」）。

## 后续（不在本版）

- **行内标记渲染**（`**粗体**` 在非焦点块里隐去星号、`#` 只留字号）——同一套装饰机制上的 mark 级增量。
- **WYSIWYG 那一档**：真·DOM 编辑面，那时才需要重新评估外来引擎（vditor 的账本文末那套
  「回灌/重打印/vendor/覆盖样式」论证保留在 `d57243e`，需要时可查）。
- **IR 顶掉只读预览**（用户提过「后期用即时模式代替当前的预览模式」）：本版守住两值语义正是为了给这一步留路。
- 更细的块粒度（列表按项、段落按行组）；撤销栈与渲染开关的联动；跨窗口两份实例的渲染态一致性提示。

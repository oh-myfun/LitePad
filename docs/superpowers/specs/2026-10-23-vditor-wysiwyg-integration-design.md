# 设计：给预览加「可编辑」开关，用 vditor 的即时渲染（IR）落地

日期：2026-10-23 · 状态：待用户批准 · 工单号拟：B351

## 意图与为什么

LitePad 现在的 .md 只有两面：CodeMirror 源码、自绘只读预览。用户想要**在渲染结果里直接写**。
方向已拍定：不自研，直接引入 vditor，先看它的接口能让我们达到什么效果。

本版范围被用户的两条回答收窄成一件明确的事：**只做即时渲染（IR），且它是「预览格的一个开关」，
不是第四个平级视图**。所见即所得（WYSIWYG）缓上，只留枚举位。

## 已定的方向（用户裁定）

1. 引入 vditor，不自研编辑面。
2. **顶层那颗键与 `Ctrl+/` 完全不动**，仍是「源码 ⇄ 预览」；可编辑能力做成**预览界面内的一个开关**
   （原话：「还是源码和预览切换，只不过预览界面内添加一个是否可编辑的切换按钮，也可以是一个三态的切换按钮」）。
   ⇒ 本版是二态开关（只读 ⇄ 可编辑），结构上给三态留位。
3. **先只上即时渲染（IR）**；中文输入法在 WYSIWYG 那一档若实测不过，WYSIWYG 不上。
4. 保真红线：**全部先接受重打印** —— 不设「哪些语法必须无损」的门槛，不做「仅编辑块重打印」的补救。
   spike 的差异清单仍然跑，但只作为记录，不作为放行条件。
5. 编辑面**不参与同步滚动**（同步滚动 v1 账本继续只管「源码 ⇄ 只读预览」这一对）。
6. 会话**记住面**，启动时**懒重建**（只给活动标签建 vditor 实例）。
7. 打开 .md 的默认行为不变（仍是源码面）。

## 目标

- `Tab` 新增实例级字段 `previewEdit: "off" | "ir"`（`"wysiwyg"` 预留、本版不进 UI 与持久化白名单）。
  `viewMode` 仍是 `source | preview` 两值 —— 顶层语义一字不改。
- 预览格头部出现一颗「可编辑」小键：只在当前格是预览态时可见；点亮即在该格内起 IR 编辑面，
  熄灭即回到只读预览。
- IR 改的字落到**同一份文档真相**：脏标记、保存、外部改动冲突框、热退出副本、跨窗口广播
  全部沿用现有那条链，不新增第二条写入路径。
- 离线可用：vditor 的资源全部本地化，不联网。
- 观感属于 LitePad：字体、字号、配色、圆角接现有 token，明暗跟 `data-theme`。

## 非目标（本版明确不做）

- 不上 WYSIWYG（枚举留位，UI 与持久化都不认）。
- 不引 vditor 的工具栏、上传、评论、大纲、emoji、导出、它自带的 `tip()`。
- 编辑态下不做同步滚动、大纲跳转、预览内查找。
- 不做公式（mathjax/katex）与图表（mermaid/echarts/graphviz/markmap/…）的离线渲染，
  那些资源整块不进包；文档里写了就按纯文本呈现。
- 不桥接撤销栈（IR 面的 Ctrl+Z 归 vditor，源码面归 CodeMirror）。
- 不改只读预览那一面的任何现有行为。

## 反目标（什么会让这件事算失败）

- **两份文档真相**：IR 面和 CodeMirror 各存一份、各自保存。
- **纯浏览也改写文件**：只是打开看一眼，落盘字节就变了。
- **每敲一个字整篇重画**：编辑态下还继续跑我们的 MarkdownIt 渲染。
- **包里混进 15MB 可选渲染器**：体积失控。
- **编辑面长成「另一个 app」**：字体、配色、滚动条、提示与外壳不一致。
- **把同步滚动的老病灶引进来**：编辑态读到隐藏侧的兜底 `1.00` 就是历代 B293/B301 的跳顶路径。

## 约束

- 体积：安装包现在 7.44MB。必要子集 gzip 后约 680KB（`index.min.js` 71KB + `lute.min.js` 594KB
  + css 14KB），预估安装包 **+1.5～2.5MB**。用户在知情后选了这条路线。
- 交付铁律照旧：不自动推送、不打 tag；出包前显式 bump（patch 自决）；契约测试先行；不用 `--no-verify`。
- 两套 markdown 解析并存是固有事实：预览/大纲/同步滚动用 MarkdownIt 的 `MdBlock { lineStart, lineEnd }`，
  IR 面用 Lute。本版**不试图让它们一致**，只保证它们不互相覆盖内容。

## vditor 接口事实（本轮实测，附出处）

版本 4.0.1（MIT，2026-10-18 发版）。包解包 23.6MB / 653 文件；`src/ts` 108 文件、12,906 行。

- **公开方法**（`src/index.ts`，31 个）：`getValue` `setValue` `insertValue` `insertMD` `updateValue`
  `deleteValue` `getHTML` `getSelection` `getCursorPosition` `getCurrentMode` `renderPreview` `setTheme`
  `setPreviewMode` `focus` `blur` `disabled` `enable` `clearStack` `clearCache` `disabledCache`
  `enableCache` `insertEmptyBlock` `updateToolbarConfig` `getCommentIds` `hlCommentIds`
  `unHlCommentIds` `removeCommentIds` `exportJSON` `isUploading` `tip` `destroy`。
- ⚠️ **没有 `setMode`** —— 运行时换 ir/wysiwyg 没有公开接口 ⇒ 只能 `destroy()` 后重建。
  本版只上 IR，这条暂时不构成问题。
- **引擎边界只有 5 个函数**：编辑面对 Lute 的调用只有 `SpinVditorDOM`(5) `SpinVditorIRDOM`(3)
  `VditorDOM`(1) `VditorIRDOM`(1) `Md`(1，DOM→markdown 打印器)；108 文件里 22 个提到 lute。
- **缓存默认开**（`cache.enable` 默认 true，写 localStorage 且要求 `cache.id`）⇒ 必须显式关掉。
- **走 `cdn` 动态加载**：`dist/index`、`dist/js/lute/lute`、`dist/js/i18n/<lang>.js`、`dist/js/icons/`、
  `dist/css/content/*`、`dist/images/emoji` + 可选渲染器 ⇒ 连语言包都要本地化。
- **块身份**：DOM 上有 `data-node-id`（Lute 节点 id），**不是源码行号** ⇒ 本版不需要按行定位。
- 回调：官方列 `after` `input` `change` `click`；我在 `src/ts` 搜到 `input` 调用点 22 处，
  `options.change` / `options.after` 的调用点没搜到 ⇒ **挂点以 spike 实测为准**。

## 集成设计

### 1. 依赖与离线资源（我的决定）

- `vditor` 进 `dependencies`（锁 4.0.1），**以 ES module 方式 import**（`import Vditor from "vditor"`），
  由 Vite 打包，不用 `<script>` + 全局变量 —— 这样类型可查、jsdom 测试可 mock 这个模块。
- 但**运行时资源**仍要落盘：新建 `public/vditor/dist/`，构建时从 `node_modules/vditor/dist` 只拷
  `js/lute/`、`js/i18n/zh_CN.js`、`js/icons/`、`css/`；**不拷** mathjax/mermaid/katex/graphviz/echarts/
  markmap/abcjs/smiles-drawer/flowchart.js/plantuml/wavedrom/highlight.js。
- `new Vditor(el, { cdn: <由 base 推导的本地路径>, ... })`，不写死绝对 URL。
- 判据钉住「产物里有 lute、没有 mathjax/mermaid」，防将来整目录 `cp -r` 把 15MB 带进来。

### 2. 开关的形态与位置（我的决定）

- 键放**预览格的头部**（与「移除分屏 ⨯」同排），不放预览内容区里 —— 内容区会滚动，浮层要么跟着滚、
  要么挡住正文；头部已有同类小键的排布与提示档位（B350 按钮档）。
- 只在「当前格 `viewMode === "preview"`」时出现；点亮用 `is-on` 那一族现成写法。
- 结构上按**三态**预留（只读 / IR / 未来的 WYSIWYG），本版只渲染两态；`previewEdit` 的持久化白名单
  只认 `"off" | "ir"`，读到其它值一律回落 `"off"`。

### 3. IR 面占哪一格、生命周期（我的决定）

- IR 面**寄生在预览那一格**：点亮时隐藏 `.md-preview`、在同一宿主里建 Vditor；熄灭时 `destroy()`
  并恢复只读预览。
- **编辑态下绝不跑 MarkdownIt**：`applyPanelMode` 遇到 `previewEdit !== "off"` 必须短路掉
  `renderMarkdownFor(force=true)`，否则每敲一字整篇重画。
- **同步滚动显式不参与**：`sideOfPanel` 现在把「非 source」一律算 preview 侧 —— 编辑态下必须让它
  返回「无侧」，`readVisibleV` 走**不参与**分支，不许落到隐藏侧兜底 `1.00`（B293/B301 的病灶形状）。
- 一个面板一份共享视图 ⇒ IR 实例是**面板级**：切标签时不销毁实例，改 `setValue()` 换内容；
  面板关闭 / 熄灭开关 / 切回源码时才 `destroy()`。
- 会话恢复：`previewEdit` 记进会话；启动**只给活动标签**建实例，非活动标签等它被点亮再建。
- 大文件（`sizeClass` 已是 large / extreme 那一档）：**不给可编辑开关**（按钮不出现）。
  理由：Lute 整篇解析、无增量，而我们连自动预览都在 >2MB 时停了。

### 4. 内容回灌：单一写入方

- 正向：Vditor 输入回调 → `getValue()` → 与该实例上次快照做差异 → 经**既有变更集管道**写进
  CodeMirror state（新增纯函数 `textPatchToChanges(old, next)` 便于单测）。挂点等 spike 定了再写死。
- 反向：源码面编辑、另一格编辑、外部改文件、跨窗口广播 → `setValue()`。
  ⚠️ `setValue` 会重置 vditor 的光标与撤销栈 —— 记为已知代价，本版不做保位。
- **纯浏览不回写**：没有编辑动作时，禁止把 `getValue()` 的结果写回文档（哪怕它与原文不同）。
  这条必须有判据。

### 5. 外观与提示

- 新增 `src/styles/vditor.css`：覆盖 `.vditor-reset` 的字体/字号/行距/颜色/代码块/表格边框，
  全部取现有 token（`--font-body` `--font-ui` `--bg` `--fg` `--border` `--radius`），不写死数值。
- `setTheme()` 与 `data-theme` 联动，切主题同步调。
- 不显示它的工具栏（`toolbar: []`），不用它的 `tip()` —— 全应用提示只有 B350 那两档。
- `lang: "zh_CN"`、`cache: { enable: false }`、不配 `upload`（图片粘贴本版按插入 markdown 文本处理，
  不落文件、不上传）。

## 已知代价（写在这里，避免日后当 bug 查）

1. **全文重打印**：IR 面改过之后由 Lute 的 `Md` 重新序列化整篇，未编辑部分也可能变（缩进、`*`→`**`、
   折行合并、front-matter 与脚注视实测）。用户明确接受，不设红线。
2. **两套解析并存**：预览/大纲的行号来自 MarkdownIt，IR 的 DOM 来自 Lute ⇒ 本版两者不联动。
3. **`setValue` 重置光标与撤销栈**：外部改动后 IR 面的位置感会丢。
4. **大文件不进 IR**（开关不出现）。
5. 安装包 +1.5～2.5MB。

## 验收判据（契约层，先红后绿）

- 顶层那颗键与 `Ctrl+/` 的「源码 ⇄ 预览」语义**一字不改**（守卫判据）。
- `previewEdit` 生效值只有 `"off" | "ir"`；持久化读到其它值回落 `"off"`；默认面仍是源码。
- 编辑态下同步滚动必须短路：不得出现「非 source ⇒ 算 preview 侧」的老分支被 IR 命中。
- 编辑态下不得调用 MarkdownIt 渲染。
- 配置四条：`cache.enable === false`、`toolbar: []`、`cdn` 指本地、`lang` 已设。
- 打包两条：产物含 lute、**不含** mathjax/mermaid。
- 单一写入方：全仓「写 CodeMirror 文档」的入口数量不增加。
- 纯浏览不回写（配内存替身证明判据有鉴别力）；熄灭/关闭必须 `destroy()`。
- 大文件不给开关。
- `vditor.css` 不出现写死的字号/颜色（与 B337 同一族判据）。

## 计划阶段的第一件事：spike（一次性，不进产品）

三件事必须实测，结论写回本文档再开始写产品代码：

1. **输入回调**到底叫什么、什么时机触发（`input` / `change` / `after`）⇒ 决定回灌挂点。
2. **中文输入法在 IR 面的真实表现**（候选窗位置、上屏、光标错位）⇒ 这是本功能的生死线，
   不过就退回「只读预览 + 源码」，并重新讨论路线。
3. **保真差异清单**：拿 `test-data` 样例「载入 → 不编辑 → `getValue()`」逐字对比，
   记录哪些写法会变。按用户裁定它不阻塞放行，但必须留档。

## 我的决定（未征求，可推翻）

- 以 ES module 引入 vditor、资源单独 vendor 到 `public/vditor/`；
- 开关放预览格头部而非内容浮层、结构按三态预留；
- IR 实例是**面板级**（切标签 `setValue` 换内容，不销毁）；
- 大文件不给开关；
- 图片粘贴只插文本、不落盘不上传；
- 语言包 vendor `zh_CN.js`；`vditor.css` 单独成文件、只走 token。

## 后续（不在本版）

- WYSIWYG 那一档（等 IR 的 IME 与保真表现落地）。
- 编辑面接大纲跳转 / 查找 / 同步滚动（先解决两套引擎的块映射）。
- 「仅编辑块重打印」的保真补救；撤销栈桥接。
- IR 顶掉只读预览（用户提过，明确是后话）。

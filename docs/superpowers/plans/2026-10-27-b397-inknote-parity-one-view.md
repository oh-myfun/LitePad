# B397 · 装饰面对标 InkNote：一颗 view、两档切换、样式与块级可编辑照搬

用户口径（2026-10-27）：**「装饰面需要对标 InkNote 的样式和所见即所得编辑能力，不要自己重新开发。
前面那个 preview 看起来和 InkNote 完全不同；独立的只读形态完全没必要 —— 把所见即所得禁用编辑
自然就是只读，效果也能一致。」**

## ① 事实核对（读完 InkNote 现版之后）

| 问          | InkNote 的答案                                                                                                                                                                                                             | LitePad 现状                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 有几颗 view | **1 颗**（全仓 `new EditorView` 只出现在 `src/editor.ts:1466`；`EditorState.create` 也只 1 次）                                                                                                                            | **2 颗**：源码 view + 只读镜像 view（`spike/deco/mirror.ts`）+ ChangeSet 桥                           |
| 模式切换    | `previewCompartment.reconfigure(previewExt(mode, ctx))`（`editor.ts:1370`），mode = `source｜preview`                                                                                                                      | 换 CSS 类显隐两颗 view + 跨面落位（`readVisibleV`/`landVisibleSideAtV`/`reconcileSyncRegistrations`） |
| 只读        | 同一颗 view：`EditorState.readOnly.of(true)` + `EditorView.editable.of(!readOnly)`（`editor.ts:1391-1394`）+ `transactionFilter` 丢弃 docChanged 但白名单 `input.toggleTask`（1395-1399）+ CSS 类 `.editor-host--readonly` | 独立镜像 view（B391F-8 刚加的 `editable` 档是**第二颗** view 的开关，方向错）                         |
| 样式归属    | **全在 `App.css`**，CM6 侧只发 class 名；几何/字阶是硬编码 em/px 档位（h1 1.92em/720、h2 1.52em/700…），颜色全走 CSS 变量（`--fg --md-panel-bg --md-accent`…）                                                             | 接 LitePad 自己的 token，档位与 InkNote 不同 ⇒ 观感完全不同（用户指出的就是这一条）                   |
| 块级组件    | `Decoration.replace({block:true})` 取代整段源码；**widget 内无内层 CM6**，靠原生 `contenteditable` 打字 + `attachSourceEditing`（rAF 防抖 → 整段回写）；表格每格 `contentEditable`、代码块 `plaintext-only`                | widget 全只读；表格/公式/mermaid 是 LitePad 自研的简化版                                              |
| 光标显形    | `applySelection(statics, state)`，判据只看 `selection.main.head`、且过滤范围限在光标所在行（开销与文档长度无关）                                                                                                           | 同形状（Task 1 移植），但 `livePreview` 只有 `readOnly` 一个构造期开关，**不能在同一颗 view 上换档**  |

⇒ 结论：**「去掉镜像、只留一颗 view」与 InkNote 同构**；B391F-8 那一档（可写镜像 + 双向桥）
是要被替换掉的形态，不是要被补全的形态。

## ② 目标形态

```
Panel.p.view（唯一那颗 CM6 view，随面板创建）
 ├─ previewCompartment：source 档 = [] ；preview 档 = livePreview + widgets + atomicRanges + keymap
 ├─ readOnlyCompartment：EditorState.readOnly / EditorView.editable（跟随文档只读性，与档位正交）
 └─ transactionFilter：只读时丢弃 docChanged，白名单 `input.toggleTask`（点勾仍然能改文档）
```

`viewMode=preview` 不再是「另一颗 view 现形」，而是「这一颗换档」。于是整格内不再有第二面：
**B290/B293/B355 那一族「跨显隐落位 + 重注册」在一格内失去对象**（跨格分屏与跨窗口仍要走既有
多实例与账本，那部分机械不动）。

## ③ 切片（每片独立过门禁，TDD 先红）

**B397-1 · 拆掉第二颗 view：一颗 view 两档**

- `editor/editor.ts`：`createEditor` 按 `isDecoPreviewEnabled()` + `isMdTab` 挂 `previewCompartment`
  / `readOnlyCompartment`；`EditorHandle` 导出 `setWysiwyg(on)`、`setReadOnly(on)`（内部 `reconfigure`）。
- `tabs/lifecycle.ts`：删 `createDecoMirror` 分支与 `.md-deco-host` 宿主；`applyPanelMode` /
  `toggleViewMode` 改成派发 `reconfigure`，保留 `mode-*` 类只用于 CSS 显隐遗留（派生 DOM 那一臂）。
- 删 `spike/deco/mirror.ts`（198 行）+ `panelBridge.ts`（38 行）；`io/files.ts` / `tabs/split.ts`
  的播种调用点一并摘。`find/findbar.ts`、`sync-scroll/wire.ts` 的 deco 分支改成只问 `p.view`。
- 判据：镜像类用例（spike-deco.test「可写镜像与双向桥」6 条、wiring ⑦⑧⑨⑩）改写成
  「同一颗 view 的档位」用例；**不许只删断言**，要保留同一条产品性质（打字进得去、只读进不去、
  点勾进得去、查找落在当前这一颗）。

**B397-2 · 样式照搬（用户说的「效果完全不同」的正身）**

- 新 `src/styles/deco-wysiwyg.css`：把 InkNote `App.css` 编辑面段（1156-1701 / 2287-2677 /
  3420 / 3601-3686）搬进来，结构照抄：`.editor-host` 的 token 层 → 各构造规则 → `.md-block-source`
  平时 `display:none`、`.md-block--editing` 才显形那套机制。
- 取值口径：**几何/字阶/间距照抄 InkNote 的数值**；**颜色继续接 LitePad 主题 token**
  （InkNote 本来就是变量取色，这条不冲突，也符合「形状颜色跟共用 token 走」的成文口味）。
- 判据：真机同篇文档 A/B（InkNote 窗口 vs LitePad WYSIWYG 档）截图并排 + 逐类量
  行盒高/字号/左边距/引用竖线位置；这条不做像素对照就又是一次「我以为对标了」。

**B397-3 · 块级可编辑（InkNote 的所见即所得编辑能力）**

- 搬 `editor/widgets/editableSource.ts`（626）+ `blockRange.ts`（158）：
  `makePlainTextEditable` / `attachSourceEditing` / `enterAdjacentBlock` / `focusBlockStartingAt` /
  `stampBlockRange` / `currentBlockRange`；剥掉 i18n 与 Tauri 绑定。
- 表格 widget 换成 InkNote 的 `table.ts`（1726，含单元格 contenteditable、`showCellSource` /
  `showCellRendered`、增删行列与工具栏、`ignoreEvent` 那条「返回 false 会被 CM 吃掉原生输入」）；
  代码块换成 `codeBlock.ts`（354，`plaintext-only` + 语言下拉）。
- 只读时全部早退（InkNote 有 ~20 处 `state.readOnly` 检查），点勾走 `input.toggleTask` 白名单。

**B397-4 · 行内装饰与原子区间对齐 InkNote 现版**

- `previewSets.ts` 与现版差集：`revealFrom/revealTo`、`NEVER_REVEAL`、`blockReveal`（块级永不因
  光标退回源码）、`atomicBlocks` 清单（表格/代码/公式/mermaid/图片/HR/front matter/链接定义/HTML 块）。
- keymap：块边界四方向 `enterAdjacentBlock`、`Enter` 的三条 preview 分支、`Tab/Shift-Tab/Backspace/
Delete` 的表格处理；`markdownKeymap` 必须排在 `defaultKeymap` 前。

**B397-5 · 真机台 + 性能 + 结果文档**

- 同尺复跑：`.tmp/b395-check.py` 那三条（落点 / 击键 / 能力清单）在**新形态**下的读数 ——
  一格内两面消失后，P2 那一族判据里哪些**不再适用**要逐条点名并写下理由（不许静默摘判据）。
- 性能这一条要正视：InkNote 的 `previewSyntaxTree` 用 `ensureSyntaxTree(state, doc.length, 100)`
  **强制全文同步 parse** —— 这是它观感稳定的代价，也是 bigDoc 档位存在的理由。LitePad 保留
  「>5000 行进不了 WYSIWYG 档」的降级，并把它当成交付口径写清楚。

## ④ 已知代价与红线

- 刚交付的 B391F-8（可写镜像 + 双向桥）**作废**：形态错（InkNote 没这颗 view），代码会被删。
  它的测试里「打字进得去 / 只读进不去 / 点勾能改 / 查找落在当前面」这四条产品性质**要保住**，
  改挂到一颗 view 上重写。
- 大改动会碰到同步滚动的既有判据：一格内 source↔preview 落位那一族失去被测对象 ⇒
  逐条改写成「跨格 / 跨窗口」同形判据，**不许整批删**。
- 红线照旧：`deco_preview` 关着时 `src/spike/**` 不可达；不放宽任何阈值；出包前显式 bump；
  推送/发版只在用户明说时做。
- 本轮从 spike 分支起（`spike/b391-inknote-deco-preview`，HEAD 23 笔），是否回合仍由用户拍板。

## ⑤ B397-1 落地记录（提交 `767abfe`）

**落成的形状**（与 ② 一致，两处口径改了）：

- 两颗 Compartment 挂在 **`Tab.comps`**（`preview` / `lock`）而不是 `EditorHandle` 上：一格一颗
  view 轮流承载多份实例，档位必须跟着实例走，`makeTabState` 建的两把锁都从空起步。
  ⇒ **没有**新增 `EditorHandle.setWysiwyg/setReadOnly`；唯一刷点是 `markdown.ts` 的
  `applyDecoFace`，由 `applyPanelMode`（本仓库既有的「视图模式落到 DOM 的唯一出口」）调它。
- 只读锁只装在所见即所得档（源码档保持主干现状：那里从来没有过锁）。
- `decoLock` 的 `transactionFilter` **没有** InkNote 那条 `input.toggleTask` 白名单 ——
  LitePad 的点勾写点在更上游（`canToggleTask` / `toggleTaskInTab` 都判 `doc.readonly`），
  只读文档根本不会走到那一发 dispatch；少一条白名单就少一类「谁能写进来」的口径分叉。

**顺带抓到的真病灶（本轮最有价值的一条）**：`markdown()` 不带 `base` 时，lang-markdown 源码里
那个 `base: { parser } = commonmarkLanguage` 让它默认落到 **CommonMark**，而 CommonMark 没有
`Task` / `Table` 节点 ⇒ `previewSets` 那两个 `if (n === "Task")` / `"Table"` 分支在生产配置下
**永远不进**：应用里的所见即所得画不出任务清单方框，也画不出表格。单元测试用的是
`markdown({ base: markdownLanguage })`（带 GFM），所以「测试绿、真机没画」这一形只有真启动
判据能抓住 —— 辛（wiring 那条点勾判据）就是在这里红的。改法照抄 InkNote `editor.ts:1400`。

**判据换了载体的地方**（一条性质都没摘，逐条对照写在测试头注里）：

| 原镜像判据                               | 现在的同一条性质                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 桥不回写幽灵 docChanged                  | 己：真启动连切 20 回档 ⇒ 不置脏、不写盘、内容不动                                                         |
| 两侧文本一致                             | 丙：预览档打的字切回源码还在（本来就只有一份）                                                            |
| 归属闸拒收别人的文档                     | 癸：换文档 ⇒ 档位重落，`.md-deco` 不带着上一篇的画                                                        |
| 桥写完要在账本认领                       | 一面之格没有 preview 侧：`sideOfPanel` 按实际存在的滚动面回答 + 落位/重注册那一族主干判据                 |
| editable 镜像真是可写视图                | 装配①②：`contenteditable` / `readOnly` facet / 程序化 dispatch 也进不去                                   |
| 播种守卫（refreshDecoMirror ≥ setState） | 换 state 必重落档位（applyPanelMode ≥ setState，三个文件各一条）                                          |
| 关着不构造装饰实例                       | 静态守卫两条（lifecycle 的正向问谓词分支 + markdown 的 `on` 必含谓词）+ 壬：运行时关掉 ⇒ 下一发换档摘干净 |

**已知的洞（B397-5 真机轮要正面回答，不许静默）**：

1. `viewMode === "split"` 在装饰那一臂没有右格（一颗 view 不能同时当两面用）。产品里
   没有任何路径写 `"split"`（`session/rebuild.ts` 把旧会话的 split 映射回 source），
   「打开侧边预览」走的是**新开一格**，所以这条只影响手工造的老会话。
2. bigDoc（>2MB / >20MB）md 落进装饰那一格的预览档：既没有装饰（档位闸判 false）也没有
   派生 DOM 那句「已停用自动预览」的提示 ⇒ 一片裸文本、无说明。要么补提示，要么让
   `shouldMountDecoPreview` 为假时回落到派生那一臂 —— 口径待用户拍板。
3. 只读文档在 A 格（源码档，无锁）被写、B 格正停在预览档（有锁）：`syncDocInstances`
   那一发会被 B 格的 `transactionFilter` 丢掉 ⇒ B 显示陈文。只读 + 多实例同文档才碰得到，
   本轮不动，记在这里。
4. 换档时的落位与重注册在 jsdom 量不出像素（`clientHeight` 恒 0）—— 归真机台。

## ⑥ B397-2 落地记录（样式对标）

**落成的形状**（与 ③ 的写法有两处改了）：

- 样式落在 **`src/spike/deco/deco.css`** 原地重写，**没有**新建 `src/styles/deco-wysiwyg.css`：
  `src/styles/` 是全应用可达的，而红线要求「`deco_preview` 关着时 `src/spike/**` 不可达」——
  放 spike 目录里才真的隔离得掉（`index.ts` 只被 spike 那条 import 链带进来）。
- 分层照 InkNote：宿主先落一层 token（`--editor-padding-x:48px` / `--editor-block-indent:16px`
  / `--editor-quote-bar:3px` / `--editor-list-marker-offset:1.35em` / `--md-component-radius:9px`），
  下面每条规则只吃 token；**颜色一律 `var(--…)` 接 LitePad 主题**（`--accent` / `--code-bg`
  / `--border` / `--editor-fg` / `--link-fg`…），文件里不许出现一颗十六进制色。
- 取色判据是**量出来的**：`.tmp/b397-check.py` 在真机跑时直接解析 InkNote 的
  `E:\Project\InkNote\InkNote\src\App.css` 拿数值（h1..h6 字阶/字重、48/16/3/1.35em、9px、
  方框 14px/1.5px、行内码 .88em、单元格 8/13px…），再拿 LitePad 的 `getComputedStyle` 对 ——
  数值不是我手抄的，InkNote 改了判据会跟着变。

**真机抓到的两颗（单元测试全绿也照样错）**：

1. **简写把整段规则顶掉**：基线行那条我按祖先链写成
   `.panel-host .panel-editor .cm-editor.md-deco .cm-line { padding: 0 var(--editor-padding-x) }`
   ＝特异度 (0,5,0)，而它用的是 `padding` **简写** ⇒ 标题的 `padding-top`、引用/列表/任务的
   `padding-left`（都是 (0,3,0)）全被压平：真机第一轮读到 padTop=0、引用左内距裸 48px。
   降到 `.md-deco .cm-line` (0,2,0) 才对（CM6 自己那条 `.cm-line` 是 (0,1,0)）。
   ⇒ 只有 font-family / overflow / gutters / content 那几条才需要写全祖先链（要赢 global.css
   的 (0,3,0)/(0,4,0)），**用简写的规则不需要**。判据里补了一条反向钉：`.md-deco .cm-line`
   那条规则里出现祖先链就红。
2. **CM6 把语法色 span 套在装饰 span 里面**：标题正文那一段同时带 `cm-md-h2`（我的 mark 装饰）
   和 HighlightStyle 的 `tags.heading` 蓝 —— 后者是**内层** span，取色/字重都按内层算，
   所以外层写了 `color: var(--md-fg)` 也照样画成蓝的；链接同理（内层带下划线）。
   改法照抄 InkNote 自己那招：每条要给正文上色的规则都配一个 `*` 伴生选择器
   （`.cm-md-h2, .cm-md-h2 *`）。这一颗是**肉眼看图**发现的，computed-style 判据当时是绿的
   ⇒ 台子改成读**最内层** span（`deep()`），新增 S-4b2/4b3/13 三条压内层判据。

**判据**：`tests/spike-deco-style.test.ts` 36 条（宿主 token 层 / 外壳 / 字阶表 / 行内 /
列表与任务 / widget / 两条守卫：不许残留 `md-deco-host`·`.md-preview`，每条选择器必须含
`.md-deco`）；真机 `.tmp/b397-check.py` S-1…S-15 **FAILS=0（63 PASS）**，含切档往返
（S-14a..j：装饰类摘掉→行内距回 6px→代码字体→行号栏回来→正文与兄弟实例逐字相等→切回几何不变）
与控制臂（S-15：关着时一颗装饰 view 都没有、派生 DOM 那面照常渲染）。截图
`.tmp/b352-check/b397-{top,bottom,deco,source-face}.png`。

**与 InkNote 的已知差集**（都是有意为之，B397-5 结果文档要点名）：

- 代码块上内距 **12px 而非 34px**：InkNote 那 34px 是给语言下拉留的位置，控件在 B397-3 才搬。
- 行号栏只在**所见即所得档**藏；源码档保持 VS Code 那套。
- 基准字号是真机 12px、行距吃用户的 `--editor-line-height`（B225 设置）：样式里**故意不写**
  `line-height`，所以拿不到 InkNote 的 1.75 —— 那是用户设置项，不该被装饰面顶掉（判据里
  有一条专门钉「正文三层不许出现 line-height」）。
- 组件圆角照抄 9px 而不是共用 `--radius`：这条是「对标 InkNote」的显式指令，压过
  「形状跟共用 token 走」的一般口味，仅限文档面。
- **没做**运行中的 InkNote 像素并排：数值判据直接来自它的样式表（比截图更硬），
  而拉起另一个应用会动它的会话状态。观感对照用的是 LitePad 自己的截图。

# B397 · 装饰面对标 InkNote：一颗 view、两档切换、样式与块级可编辑照搬

用户口径（2026-10-27）：**「装饰面需要对标 InkNote 的样式和所见即所得编辑能力，不要自己重新开发。
前面那个 preview 看起来和 InkNote 完全不同；独立的只读形态完全没必要 —— 把所见即所得禁用编辑
自然就是只读，效果也能一致。」**

## ① 事实核对（读完 InkNote 现版之后）

| 问 | InkNote 的答案 | LitePad 现状 |
| --- | --- | --- |
| 有几颗 view | **1 颗**（全仓 `new EditorView` 只出现在 `src/editor.ts:1466`；`EditorState.create` 也只 1 次） | **2 颗**：源码 view + 只读镜像 view（`spike/deco/mirror.ts`）+ ChangeSet 桥 |
| 模式切换 | `previewCompartment.reconfigure(previewExt(mode, ctx))`（`editor.ts:1370`），mode = `source｜preview` | 换 CSS 类显隐两颗 view + 跨面落位（`readVisibleV`/`landVisibleSideAtV`/`reconcileSyncRegistrations`） |
| 只读 | 同一颗 view：`EditorState.readOnly.of(true)` + `EditorView.editable.of(!readOnly)`（`editor.ts:1391-1394`）+ `transactionFilter` 丢弃 docChanged 但白名单 `input.toggleTask`（1395-1399）+ CSS 类 `.editor-host--readonly` | 独立镜像 view（B391F-8 刚加的 `editable` 档是**第二颗** view 的开关，方向错） |
| 样式归属 | **全在 `App.css`**，CM6 侧只发 class 名；几何/字阶是硬编码 em/px 档位（h1 1.92em/720、h2 1.52em/700…），颜色全走 CSS 变量（`--fg --md-panel-bg --md-accent`…） | 接 LitePad 自己的 token，档位与 InkNote 不同 ⇒ 观感完全不同（用户指出的就是这一条） |
| 块级组件 | `Decoration.replace({block:true})` 取代整段源码；**widget 内无内层 CM6**，靠原生 `contenteditable` 打字 + `attachSourceEditing`（rAF 防抖 → 整段回写）；表格每格 `contentEditable`、代码块 `plaintext-only` | widget 全只读；表格/公式/mermaid 是 LitePad 自研的简化版 |
| 光标显形 | `applySelection(statics, state)`，判据只看 `selection.main.head`、且过滤范围限在光标所在行（开销与文档长度无关） | 同形状（Task 1 移植），但 `livePreview` 只有 `readOnly` 一个构造期开关，**不能在同一颗 view 上换档** |

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

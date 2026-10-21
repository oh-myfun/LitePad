# Markdown 渲染与编辑（B319 排版与增量 · B320 预览内编辑）设计定稿

日期：2026-10-21 · 分支：`main` · 上一轮：B314–B318 左栏资源管理器

## 意图与为什么

预览区「全挤在一起」——段与段、标题与正文之间看不出边界，读长文很累。用户拿 InkNote 做参照，
并问能否像 InkNote / VS Code Office Viewer 那样**在预览里直接改**。

先把病灶钉死：**不是行距**。实测行距 25.5px @ 15px 字号 = 1.7，正常；
真正为 0 的是**岛与岛之间的空隙**。

探针：`.tmp/typo-check/index.html`（引真 `src/styles/global.css` + `preview.css`，按
`pipeline.ts` / `preview.ts` 的真实结构造岛），Chromium 内核实测相邻岛间隙：

| 相邻 | P→P | H1→P | P→H2 | H2→P | P→UL | UL→QUOTE | QUOTE→PRE | PRE→P |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| px  | 0   | 0    | 0    | 0    | 4    | 4      | 0         | 0     |

机制（`src/styles/preview.css:65-75`）：每个岛是 `div.md-block > 单个元素`，而 `.md-block` 自己只吃
`margin: 0 auto`（上下为 0），同时 `> :first-child{margin-top:0}` 与 `:last-child{margin-bottom:0}`
把那个唯一子元素的上下 margin 全清掉 —— 一个元素既是 first 又是 last ⇒ **上下双清零**。
实测每个岛的 `getBoundingClientRect().height` 与它子元素完全相等，说明岛壳贡献 0。
表里那两个 4px 是另一条漏：`li{margin:4px 0}` 从 `<ul>`（只有 `padding-left`，上下无填充无边框）
一路**穿出岛壳**，所以岛与岛之间并非全都干净 —— 这正是下面 `li` 那一条规则要堵的洞。

## 调研结论（四方对照，作为决策依据）

| | 渲染/解析 | 编辑内核 | 真值 | 增量 | 写回源码 |
| --- | --- | --- | --- | --- | --- |
| LitePad 现状 | markdown-it 15 + KaTeX + Shiki + mermaid 12 | 无（只读 innerHTML） | CM6 文本 | 岛级、**按下标**比 html | 不涉及 |
| InkNote | CM6 装饰（无预览 DOM） | CM6 本体 | CM6 文本 | CM6 事务 | 同文本，无往返 |
| VS Code 内置预览 | markdown-it 14 | 无 | TextDocument | **morphdom** 逐元素 diff | 不涉及 |
| VS Code 新 `@vscode/markdown-editor` | markdown-it 14 | 自研实验型自定义编辑器 | **仍是 TextDocument** | 增量 | 区间编辑 |
| vscode-office（cweijan）4.2.2 | **Lute**（Go→JS 引擎） | **Vditor 私有 fork**（vendored，非 npm） | contenteditable DOM | 块级 `SpinVditorDOM` | **400ms 防抖 + 整文档 replace** |

对本地安装 `~/.vscode/extensions/cweijan.vscode-office-4.2.2` 逐字核对到的四条实据：

1. markdown 编辑器不在 `package.json` 依赖里：`resource/markdown/dist/index.min.js`（3.2 MB）+
   `dist/js/lute/lute.min.js`（3.5 MB），容器 `id="vditor"`、类名全 `vditor-*` 前缀 —— vendored 的
   Vditor fork。`prosemirror-*` 属于 Word 预览（`@eigenpal/docx-editor-react`），`markdown-it@14`
   只出现在导出路径，都不参与 markdown 编辑。
2. 视图**只有两档**：`vscode-office.editMode` 的 enum 就是 `["wysiwyg","ir"]`（默认 wysiwyg），
   上游的 `sv`（分屏预览）被删掉了。
3. 写回是整文档替换，逐字为：
   `updateTextDocument(e,r){ let n=r.replace(/\r/g,""); if(e.getText().replace(/\r/g,"")===n) return …; i.replace(uri, new Range(0,0,e.lineCount,0), n); applyEdit(i) }`
   —— 上游 `input()` 经 400 ms 防抖后进 Promise 串行队列，每次换整个文档区间。
4. 回声守卫只有 8 行：`isWriteback(e){ return this.writingContent!==void 0 && this.writingContent===norm(e) }`
   配一条串行队列；光标靠序列化前插 `<wbr>` 占位、重渲染后 `setRangeByWbr` 找回；撤销自建 50 条
   diff-match-patch 文本栈；IME 用 `composingLock` 锁住合成期间。

**判定**：不引 Vditor/Lute。理由三条硬的 —— (a) 真值靠 `VditorDOM2Md` 从 DOM 反推，用户文件里的
字节由第三方 AST 打印机决定，渲染瑕疵直接变成 diff；我们的 CM6 里文本即文件，零往返风险。
(b) 整文档 replace 严格劣于区间替换，且天然无法与原生文本编辑并存。(c) 私有 fork + WASM blob 没有
上游治理。
**抄三样便宜的**：回声守卫指纹、`<wbr>` 光标标记、「滚动恒恢复 / 焦点按需」的分离策略。
**架构沿 InkNote**：任何编辑都必须翻成源码偏移的区间替换，DOM 永远不是真值。

## 仓库事实（本轮核对过，写方案时踩不得）

- `viewMode` 只有 `"source" | "preview"` 两个值，挂在**标签**上（`src/core/app-state.ts:49`）。
  「分屏」不是一个 source|preview 的容器，而是同一文档的**另一个实例**开在另一格
  （`openPreviewToSide`）；某标签处于 preview 态时它自己那份 CM6 编辑器是隐藏的。
- 源码侧「定位到第 N 行」的**已有通路**是「转到行」：`src/commands.ts:224-236` ——
  dispatch 选区 + `EditorView.scrollIntoView`，然后**把这一跳的坐标直接交给协调器**
  （`syncCoordinator.syncTo`），注释写明原因：编辑器隐藏时收不到滚动事件，而隐藏那侧只会报兜底
  的 `1.00`，于是全窗口复位到顶部（B301）。最后 `view.focus()`。
- 预览侧的 `applySyncToLine` / `blockAtLine`（`src/markdown/preview.ts:383,507`）都是 **private、
  且只定位预览格**，没有任何能力定位源码格。方案引用它们时不许说成「按行落点已通用」。

## 阶段 A（本轮交付，B319）

### A1 垂直节奏：间距只声明在岛的边界上

节奏值**取元素自己已经声明的 margin 同量**，让「应用内」与「导出 HTML」两条路径落在同一数量级
（导出走 `renderFull`，不包岛，靠子元素 margin：`h*{margin:24px 0 12px}`、`p{margin:10px 0}`）：

```css
/* ⚠️ 更正（实施时定稿）：这三档**只在用点写 `var(--x, 兜底)`**，绝不在 `:root`/`.md-preview`
   上声明 —— 声明了就把「将来设置页要往 :root 写这几颗变量」的那条路堵死（B238 同一族陷阱）。
   值：--md-flow 0.7em / --md-head-flow 1.6em / --md-after-head 0.8em（15px 基准 ≈ 10.5/24/12px）。 */
.md-preview .md-block + .md-block { margin-top: var(--md-flow, 0.7em); }
.md-preview .md-block:has(> :is(h1,h2,h3)) + .md-block:not(:has(> :is(h1,h2,h3,h4,h5,h6))) { margin-top: var(--md-after-head, 0.8em); }
.md-preview .md-block + .md-block:has(> :is(h1,h2,h3,h4,h5,h6)) { margin-top: var(--md-head-flow, 1.6em); }
.md-preview li:first-child { margin-top: 0; }
.md-preview li:last-child { margin-bottom: 0; }
```

- **顺序与具体度都是承重的**：第一行 `.md-preview .md-block + .md-block` 是 3 个类（0,3,0）；
  写成 `.md-preview .md-block:has(…)` 只有 (0,2,1)，**会被第一行盖掉**（草稿就是这么错的，
  实测标题上方仍是 10.5px）。故后两条都必须带上 `+ .md-block` 或 `:not(:has(…))` 凑到 (0,3,1)。
  标题那两条互斥（主语要么是标题要么不是），不靠先后决胜。
- `:has()` 在 WebView2（Chromium 105+）可用；`em` 相对岛自身继承的 15px，**不随标题字号放大**，
  正是要的常量节奏。首块拿不到边界间距（没有前一个岛）—— 这是对的，容器 padding 负责它。
- 后两条 `li` 规则是**必须的**，不是装饰：实测补上它们之后，`P→UL` 的 4px 漏收进 10.5px 一档，
  岛壳重新紧贴内容。原 `> :first-child/:last-child` 那两条清零**保留**（护住 blockquote 内首末段）。
- **不用** `display:flow-root`：实测它把 `li` 的上下 margin 吞进岛壳（岛 63px / 内容 55px），
  破坏「岛壳矩形 == 内容」这一条 —— 同步滚动的按行插值（`into/range` 与末块按行均分块高）正依赖它。
- 目测口径，不是数值同一：应用内 P→P 是 10.5px、导出是 10px，差半像素。验收用同文档**对照截图**，
  不许写「数值相等」的断言。
- **不动** `--md-line-height`（默认 1.7，实测没问题）。列表项之间保持现有 4px，本轮不再调
  （草稿里的 `li + li{margin-top:2px}` 是空操作 —— 与 `li{margin:4px 0}` 相邻塌陷取 max，仍是 4px）。

实测修后（同一探针）：`H1→P 12 · P→P 11 · P→H2 24 · H2→P 12 · P→UL 11 · UL→QUOTE 11 · QUOTE→PRE 11 · PRE→P 11`，
且九个岛的壳高与内容高**逐一相等**。

### A2 岛级增量：从「按下标」改成「公共前段 + 公共后段」

现状 `src/markdown/preview.ts:65-122`：逐下标比 `html`。在中间插一段 ⇒ 其后全体错位 ⇒ 每一块都重渲染；
而且所有岛先被搬进 `DocumentFragment` 再 `replaceChildren` —— 等于整容器摘除重建。函数开头那两个守卫
（`:66-71` 先记 `scrollTop`、`:108-112` 先读 `scrollHeight` 强制布局再扶位）就是为这次重建而存在的，
注释里记着 B288 / 真机 S7 那条 `15.10 → 1.00` 的弹顶。

改法与口径：

1. 头尾双指针按 **`html` 字符串相等**收缩出公共前段 / 后段；只有中间那段（真变更区）走现有的
   「新建岛」路径；DOM 操作改 `insertBefore` / `remove` 就地做。
2. **相等判据只许包含 `html`，不许掺行号**。行号必然随上方文本漂移，把 `lineStart` 纳入判据等于
   每次插入都让整条后段作废 —— A2 的收益当场归零。
3. 复用下来的岛**只许改写 `data-lineStart` / `data-lineEnd` 属性**（属性写不碰子节点、不触发重渲染），
   别的属性与子树一律不动。
4. **位置语义保持数值 `scrollTop` 不变**（与今天完全一致）。理由：本轮只改「怎么重画」，不改「停在哪」；
   一旦同时改位置语义，真机 B288 那一族用例就分不出「回归」还是「新口径」。
   「敲第一段、视线跟着自己那一行走」是**另一件事**，另立一轮再提。
   那两个滚动守卫**保留**：变更区在视口上方时布局照样变，仍需按原位扶。
5. 写完 `scrollTop` 之后**同一同步调用栈内**继续 `declareOwnScroll()`，同步滚动账本纪律不变
   （`:437-451`）。`blocks()` 是实时量岛矩形的，岛集合变了就重测，没有缓存要失效。
6. `setNotice()` 那个非岛子节点必须在 patch 之后仍是最后一个；查找标记仍整片拆掉重放（口径不变）。

收益：未变的岛不被摘走 ⇒ 里面已完成的 KaTeX / Shiki / Mermaid 结果和 `<img>` 解码全部保住
（今天改文档第一行 = 全文重渲染 + 图闪 + 每张 mermaid 重新出图 + 全部代码重新高亮）。

### A3 双击一个岛 = 回源码那一行

**口径（用户 2026-10-21 定）**：双击预览里的某一块 = **切到源码态、定位到那一行、光标落在那一行**。
落点是**被双击的那一格**：先把该实例的 `viewMode` 翻成 `source`，再复用「转到行」那条已验证的通路
（`src/commands.ts:224-236`）做选区 + `scrollIntoView` + `syncCoordinator.syncTo` 直报坐标 + `focus`，
其余格与别的窗口照旧靠 `syncTo` 跟随。不新造定位代码。B301 那个坑（隐藏侧报兜底 `1.00` ⇒ 全窗口
复位到顶部）正是靠这条通路里「坐标直接交给协调器」那一句避开的。

⚠️ 这条口径落在「先按源态建格、之后才换 viewMode」那一形上 —— 换完态**必须补一发落位与同步重注册**
（`landVisibleSideAtV` + `reconcileSyncRegistrations` 那两条），不许按最终态直接落；这是 B310 记过的
老病根，A3 的实现里把它当作必测项。

### A 阶段的非目标 / 反目标

- **不做**第三档 viewMode（阶段 B）。
- **不引入任何依赖**：morphdom、prosemirror、vditor、diff-match-patch 都不引；岛级 diff 用前缀/后缀
  公共段就够，不上 LCS / Myers。
- **不改** `--md-content-max` 的三档宽度口径。
- **反目标**：不让间距靠「子元素 margin 穿墙塌陷」实现，也不让岛壳把后代 margin 吞进去
  —— 岛壳矩形必须等于内容矩形（两端都有实测反例，见 A1）。

## 阶段 B（形状，下轮另立 spec）

1. 预览那一格从只读变 `contenteditable`（岛级）；**分屏仍是「源码 | 预览」**，只是预览可写。
   这与 vscode-office「删掉 sv」不冲突：它删的是同一内核里的第三种渲染态，我们改的是已有格的读写属性。
2. 每条 inline run 渲染时带源码偏移（`data-s0/s1`，由 block 的 `map` 与 inline token 内容区间推出）。
   **DOM 选区 → 源码区间 = 查表**，不是反向打印 —— 这是 B 的地基，也是与 vscode-office 最关键的分野。
3. 所有编辑翻成 CM6 区间替换：打字 = 区间内替换；Enter = 在该偏移插 `\n\n`；粗斜体 / 行内代码 /
   删除线 = 往映射到的区间外侧包或拆定界符；任务列表勾选 = 改写该项 `[ ]`/`[x]`；粘贴按纯文本进区间。
4. 撤销 / 重做交给 CM6 history，**不建第二套栈**（vscode-office 那 50 条文本 patch 是坏味道）。
5. IME：`compositionstart/end` 加锁，合成期间不重渲染、不写回（B28x 一族的老病根）。
6. 回声守卫：写回带内容指纹自比（抄那 8 行），外部更新才走 `setBlocks` 全量路径。
7. 不做：表格结构编辑、代码块内编辑、Mermaid / KaTeX 编辑、front-matter、图片上传 —— 一律走 A3 双击回源码。

## 验收怎么证

- **A1**：`.tmp/typo-check` 探针跑修后，断言相邻岛间隙落在 12 / 10.5 / 24 三档、且每岛
  `壳高 == 内容高`（jsdom 不算 margin，这条必须走浏览器）；再补一张应用内与导出 HTML 的同文档对照截图。
  源码侧另加一条契约：那三条 `--md-*` 自定义属性与 `+ .md-block` 规则都在，且**顺序**按 A1 的说明。
- **A2**：jsdom 测**节点身份** —— 中间插一段后，其后各岛必须是同一批节点对象（`toBe` 同一引用），
  岛内预置的标记子节点仍在（模拟增强结果）；删除首段后未变岛仍是原节点；复用的岛 `data-lineStart`
  已随新行号刷新而子树未变。
- **A3**：真机跑分屏与单格两条路径。
- A2 必须过真机验证台（`--trace=rerender`、S7、B288 那一族按标签/拖动复位用例）才算绿。

## 约束

- 不自动推送、不打 tag、不手动 bump 版本；发布只走 `scripts/release.sh`（需用户显式要求）。
- 交付门禁全套：`npm run typecheck` / `lint` / `format:check` / `node scripts/run-vitest.cjs` /
  `cargo test`；出包 `bash scripts/build-all.sh`，出包前确认无 litepad.exe 实例在跑。
- 临时文件只写项目 `.tmp/`。注释与界面文案沿用仓库既有中文口径，不写 emoji。
- pre-commit 跑 prettier / eslint / tsc，不用 `--no-verify`。同一工作树可能有并行会话 ⇒ 改完尽快
  点名 `git add` 自己的文件、单独成笔。

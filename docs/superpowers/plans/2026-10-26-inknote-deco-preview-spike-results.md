# B391 spike 结果 · 把预览格换成 InkNote 式 CM6 装饰面 —— go / no-go

**结论：NO-GO（不正式化）。** 三条主张里 P1（更简单）**按行数不成立、按结构成立**（见①的修订）、
P2（不削弱同步滚动）不成立、P3（不更慢）一半成立。P2 不成立的那一条不是「装饰面跟不上」——
它跟上了，而且**顶边对齐精度优于现方案**；不成立的是它把同步滚动那一年修过的三类病灶又各留了
一个口子（后置显隐没补落位、relayout 后差一行、到底一侧差 19px 未归因），而把这些口子补齐的
代价等于重立 B337/B342/B347/B319 那批像素契约测试。收益不值那个代价。

- 分支：`spike/b391-inknote-deco-preview`（未合并、未推送、无 bump、无出包）
- 台子：`.tmp/b391-check.py` → `.tmp/b391-check.out`（本文所有数字取自 23:55–23:56 那一轮，
  **⑧节把它的判据行原样抄了一遍**；00:00–00:01 复跑一轮 `FAILS=5` 逐条一致。判据在 23:41 /
  23:47 / 23:52 三轮里被真机读数改过，修订理由见③。**台子脚本与日志留在 `.tmp/`
  （项目规矩：整目录 gitignore），所以复现脚本不在仓里，判据与数字在。**）
- 夹具：`.tmp/b391-fixture-big.md`（5000 行 / 113,669 字节，含 frontmatter·标题·嵌套列表·
  任务·引用·表格·ts 围栏·图片·行内公式·脚注·hr）
- 两条臂：`deco_preview=false`（现方案 pipeline → `PreviewPane` 派生 DOM）/
  `deco_preview=true`（`src/spike/deco`），同一份会话形状（左格源码、右格预览、同文档两实例）

---

## ① 三条主张逐条判定

### P1 更简单 —— **按结构成立；按代码行数不成立**（评审 I2 之后的修订）

| 侧             | 文件与行数                                                                                                                            | 小计    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 现方案         | `markdown/pipeline.ts` 228 · `markdown/preview.ts` 476 · `markdown/enhance.ts` 190 · `markdown/tasks.ts` 51                           | **945** |
| 现方案的同步侧 | `sync-scroll/preview.ts` 220（派生 DOM 专属锚点：块顶互查、`hasPosition`、补定位回登记）                                              | **220** |
| 装饰面         | `spike/deco/previewSets.ts` 408 · `livePreview.ts` 67 · `codeFence.ts` 95 · `codeBlockWidget.ts` 67 · `mirror.ts` 97 · `deco.css` 161 | **895** |
| 装饰面的同步侧 | 0 —— 直接用 `EditorScrollAnchor`（与源码格同一个类）                                                                                  | **0**   |

⚠️ **上面四行不许读成「净省 50 行」**（本文初版就是这么写的，评审把它抓回来了）。换成装饰面
之后真正**可以删**的只有 `markdown/preview.ts` 476 + `sync-scroll/preview.ts` 220 = **696 行**；
`pipeline.ts` 与 `enhance.ts` 删不掉 —— 前者还有两个非预览消费者（`src/io/export.ts:13` 的
`renderFull`、`src/markdown/outline.ts:1` 的 `extractToc`），后者被装饰面自己要用
（`src/spike/deco/codeBlockWidget.ts:13` 就 import 了 `enhanceMarkdown` / `nextEnhanceSeq`）。
加上的 895 行之外还有生产接线约 174 行（`lifecycle.ts` +90/−15、`app-state.ts` +31、`wire.ts` +7、
`main.ts` +5、`ipc/api.ts` +9）。**所以行数上升，不是下降。**

成立的是**结构**这一维：`PreviewScrollAnchor` 那 220 行之所以存在，是因为派生 DOM 的块高要等
图片 / Shiki / mermaid 落地才知道，于是有了 `expectSurfaceV` 回登记、`applyPending` 补定位、
`hasPosition` 兜底（B299 那一族）这一整条**异步支线**。装饰面本身是 CM6 视图，行盒高度由 CM6
自己维护，所以 `wire.ts:faceOf` 的预览分支只多了一行（`return { anchor: new EditorScrollAnchor(deco), ... }`），
B300 的逐行对齐（`topPos` / `setVAt`）**天然继承**，现方案反而拿不到这两个方法。
一句话：**换掉的是「一类异步机械」，省下的是「一类病灶」，不是行数。**

老症状复测（这是「更简单」的实际意义）：

- **PASS P1-2 源码侧打字不得清零装饰侧 scrollTop** `before=3004 after=3004` —— B23 / B269 那一族
  的形状在真机上不复存在。
- **PASS P1-2 编辑内容经 ChangeSet 桥进了装饰面** `deco=True src_has=True` —— 镜像桥（`mirror.ts`
  的三道闸：回声 / 同文 / 过期）在真实面板里按预期工作。

### P2 不削弱同步滚动 —— **不成立**（3 条 FAIL，但主链在，且精度更高）

成立的部分：

- **PASS P0 台子前置：这页的 RAF 在跑**（臂 A / 臂 B 各 25 帧/400ms）——协调器的广播帧有载体。
- **PASS 开关开着 ⇒ 可见预览面是装饰面**，且 `reconcile 在册=P1:editor/doc1, P2:preview/doc1`。
- **PASS P1-1 翻页后两侧顶边同内容** `src='- 嵌套第二层'` / `pv='嵌套第二层'`（标记被折成样式，
  DOM 文本里没有 `- `，见下面「判据修订理由」）。
- **PASS P2-补（两条臂）广播真的写到了预览面 / 预览面跟着动了**：臂 A `起点=17 现在=2751`，
  臂 B `起点=6 现在=1385`，两侧都是 4 发 `广播写[P*:preview]`。
- **PASS P2-1 装饰侧判到底** `{top:68352, ch:667, sh:69019}` —— 差 0px。
- **PASS P2-4 relayout 后可见装饰面仍在 / 装饰仍挂着**（改窗口尺寸逼 relayout 之后，
  带装饰的标题行仍有 16 行；B344 那条「重建后没重挂注册」的病灶没有复发）。

不成立的三条：

1. **FAIL P2-2 刚现形的装饰面落到底** `各面=[{top:62843, ch:667, sh:68740}, {top:68352, ch:667, sh:69019}]`
   —— 左格 Ctrl+/ 切到预览之后，那一面的 `scrollTop` 停在 62843，而它自己的底是 68073：**差 5230px，
   没落位**。这正是台账里那条「后置显隐切换必须补落位 + 重注册」的形状：Task 5 只把
   `mountView` 那一支接了（`switchTab` / 关相邻标签两处补了 `refreshDecoMirror`），
   `toggleViewMode` 这一支是「先按源码态建格、之后才换 viewMode」，换完没人补
   `landVisibleSideAtV`。修法确定，代价是要把 B310 那批判据在装饰面上重立一遍。
2. **FAIL P2-4 relayout 后同步仍联动（两侧顶边同内容）** `src='## 第 93 节 · 标题行'` vs
   `pv='这是第 93 节的正文段落，带粗体、斜体、行内代'` —— relayout 之后差**一行**。
   TRACE 显示那一发是按字符位置对齐的（`广播写[P2:preview] 目标=4688.11 行首@66176 落点=4690.55`
   → `判=兑现·吞掉`），落点被判兑现而顶边内容差一行，说明 `行首` 采样的那一行与装饰面渲染
   出来的那一行的行盒边界不重合。**根因大概率不是「标题装饰抬了字阶」这一处局部现象，而是
   装饰面压根没吃编辑器的排版 token**（行距 13.80px vs 源码格 18.05px，见②的「排版口径」段，
   评审 I3）—— 同一份文档在两面按两套几何落位，差一行是这套几何差的零头。
3. **FAIL P2-1 源码侧判到底** `{top:89610, ch:667, sh:90296}` —— 差 19px（约一行）。
   **未归因**：这一面是两条臂共用的生产代码，臂 A 走同一条判据时是 `{top:89628, ...}`（差 1px，
   PASS）。两臂的差别只有「臂 B 在这一步之前先在源码格打了 5 个字」（P1-2 的前置），
   所以要么是「先编辑再 Ctrl+End」这一形本身会差一行，要么与装饰面无关。spike 不追，
   正式化前必须追 —— 「到底」那一族是过去一年返工最多的地方（B268/B282/B284/B286）。

**精度对照（这一条改变了替换方案的性质）**：同一把尺（顶边那一条内容念同一句话）拿去量现方案，
**现方案 FAIL**：`src='- 嵌套第二层'` vs `pv='有序一\n有序二'` —— 派生 DOM 只能落到「块顶」，
块内第几行不由它决定；装饰面是逐行对齐的，落到了同一行。也就是说 P2 的三条缺口不是「装饰面比
现方案差」，而是「装饰面在三个具体路径上还没接完」，而它在顶边精度上**已经强于现方案**。

### P3 不更慢 —— **首帧成立，击键不成立**

- **PASS P3-1 首帧 ≤ 现方案 × 1.5**：装饰面 `2.744s` vs 现方案 `3.077s`，**ratio=0.89**
  （三轮分别 0.88 / 0.90 / 0.89）。探针：Popen → 预览侧第一次画出 3 个带装饰的标题行 / 3 个 `.md-block`。
- **FAIL P3-2 平均帧间隔 ≤ 16.7ms（60fps 档）**：装饰面 50 击键 `avg=32.16ms p95=133.40ms n=71`。
  同一条尺量现方案 20 击键：`avg=25.00ms p95=50.10ms n=84` —— **两条臂都超阈值**，
  所以 16.7ms 这个绝对阈值与这台机器 + 这份 5000 行夹具不匹配（阈值不动，按不成立记）。
  可比的部分是**比值**：装饰面比现方案慢约 **29%**，p95 慢 2.7 倍。
- 那 29% 贵在哪儿（评审 I4 逼出来的修订：本文初版在这里写「击键期间在重排 5 万行高度图」，
  把 5000 行说成一个数量级 —— 那句是替 FAIL 找台阶，删掉）。装饰面每一发击键要走四趟全量活：
  1. `src/spike/deco/livePreview.ts:50-51` —— 每次 `docChanged` 整份重建 `LivePreviewState`；
  2. `src/spike/deco/codeFence.ts:67` —— `ensureSyntaxTree(state, state.doc.length, 100)`，
     按**全文**长度要语法树；
  3. `src/spike/deco/previewSets.ts:349-364` —— 空行样式那段**逐行**遍历整篇；
  4. `src/spike/deco/mirror.ts:51-52` —— 桥的两道判据各做一次全文 `toString()`
     （`changes.apply(doc).toString()` 与 `doc.toString()`），**每颗镜像一次**。
     还有一个不对称：`src/spike/deco/codeBlockWidget.ts:53` 把 `bigDoc` 写死成 `false`，
     而现方案在 `src/markdown/preview.ts:295-296` 按 >5000 行把它切成 `true`
     （这份夹具正好 5001 行）—— 所以臂 B 的击键里还多跑了臂 A 没跑的 Shiki 增强。
     这四趟里有三趟是可以增量的（spike 没做），所以 P3 的击键这一条**不能读成装饰面路线的物理上限**。
- **P3-3 量不到**：`buildPreviewSets` 没暴露到 `window`，单次耗时取不到数。不假造，用 P3-2 当上界代理。

---

## ② 与现方案的可见差异矩阵

判据一律是**装饰面 DOM 计数**（`能力清单` MEASURE 行）+ 代码覆盖面，不看截图感觉。
两张对照照片：`.tmp/b352-check/b391-A-old.png`（现方案）与 `.tmp/b352-check/b391-B-deco.png`（装饰面）。

| 构造            | 装饰面 DOM 证据                   | 判定                                                                                                                                        |
| --------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 标题            | `.cm-line.md-heading` = 20        | **降级**（画出来了，但**字阶与行距不对**：见下面「排版口径」那条，评审 I3 抓的）                                                            |
| 嵌套列表        | `.cm-line.md-list-item` = 69      | **一致**（缩进与圆点由装饰给出；行首 `- ` 标记被折成样式，DOM 文本里没有）                                                                  |
| 引用            | `.cm-line.md-blockquote` = 18     | **一致**                                                                                                                                    |
| 围栏代码        | `.md-code-widget` = 11            | **一致**（复用同一套 Shiki 高亮，只读 widget）                                                                                              |
| 任务勾选框      | 未接 `markdown/tasks.ts` 那套机器 | **缺失**（不止按 `- [ ]` 原文显示 —— B358 那颗能点的勾压根没有：`PreviewPane` 没被构造，`markdown/tasks.ts` 那套机器整条不在场）            |
| 表格            | `table` = 0                       | **缺失**（按原始 markdown 管道文本显示，`buildPreviewSets` 不认表格）                                                                       |
| 行内 / 块级公式 | `.katex` = 0                      | **缺失**（现方案 `enhance.ts` 懒加载 katex 渲染）                                                                                           |
| mermaid         | `.md-mermaid` = 0                 | **缺失**（现方案懒渲染；注意 `enhanceMarkdown` 在 `bigDoc` 档位**也不画** mermaid，所以这份 5000 行夹具上两臂呈现一致，小文档上装饰面才缺） |
| 脚注            | 未接（无跳转、无上标列表）        | **降级**（按原文行内显示）                                                                                                                  |
| frontmatter     | 未折叠、未隐藏                    | **降级**（按原文显示；Task 2 的 `draftFences` 只保证它不吞整篇）                                                                            |

**排版口径（评审 I3，本文初版在这里把「一致」写错了）**：DOM **计数**看不见面孔，只看懂不懂构造。
装饰面宿主是 `.md-preview.md-deco-host`（`src/tabs/lifecycle.ts:267`），**不在 `.panel-editor` 里**，
所以编辑器的三条排版规则一条都没落到它身上：`global.css:4465-4472`（`font-size: var(--font-size)`）、
`:4487-4489`（`--font-code` 只给 `.panel-editor` 下的 `.cm-editor` / `.cm-scroller`）、
`:4497+`（`line-height` 同上）。台子的读数正好把这件事照出来了：同一篇 5001 行、同一 `clientHeight`
667，源码格 `scrollHeight=90296`、装饰面 `scrollHeight=69019` ⇒ 行距 **18.05px vs 13.80px**。
这大概也是 P2-4「relayout 后顶边差一行」的真正根因（本文初版只把它归给标题装饰抬字阶）。
⇒ 计划 Global Constraint 里「B337/B342/B347 那批字阶与 CJK 抬升口径不许被绕过」这一条，
装饰面**目前是违反的**，正式化必须先把这三条 token 接上（⑤切片 1）。

**功能面还死了一块（评审 I8）**：`src/find/findbar.ts:174-175` 判的是 `if (!p.preview) return`，
开关开着时 `mountView` 压根不构造 `PreviewPane` ⇒ **预览格里 Ctrl+F 变成空操作**。
B358 的勾选框（上表）与这一条都不在②的「构造种类」维度里，是「预览格的既有能力」维度，
初版漏记。

一句话：**行内构造齐平，块级富构造（表格 / 公式 / mermaid / 脚注）全线缺失或降级，
而行内那一侧的「齐平」也只到构造层级、不到排版层级。**
这些在现方案里是 `enhance.ts` + markdown-it 那条尾巴，装饰面要接就得把它们逐个搬成 CM6 widget
—— 那正是 B359 拆掉的 IR 路线曾经的工作量。

---

## ③ 判据修订理由（计划要求逐条写明）

台子在前几轮把这五条判据改到了「能证伪」的形状，都在 23:45–23:54 之间由真机读数逼出来：

1. **`syncMode` 必须显式写进会话夹具**（台子缺陷，不是判据）：手写 `session.json` 的标签条目
   没有 `syncMode` 键，而 Rust 侧是 `pub sync_mode: bool` + 容器 `#[serde(default)]`
   （`src-tauri/src/session/mod.rs:274`）⇒ 缺键反序列化成 **false** ⇒ 会话恢复把它交给唯一写点
   `setDocSyncMode` ⇒ **这份文档的同步滚动从头就是关着的** ⇒ 协调器帧在 `isOn` 那道闸
   （`coordinator.ts:391`）直接 return：`scroll[...] 判=…·广播` 照打、`帧广播` 整窗零条、
   两条臂一起读到预览面停在 `v=1.00`。上一版把这些全记成了「装饰面不跟同步」。补上
   `syncMode: true` 之后，臂 A 与臂 B 的 `广播写[P*:preview]` 立刻各出 4–5 发。
2. **新增 P0「这页的 RAF 在跑」前置判据** + 三个 Chromium 后台开关
   （`--disable-renderer-backgrounding` 等）：协调器的广播是一发 RAF（`scheduleFrame`），
   而 `rafId !== null` 期间所有后续广播被静默合并掉。不显式量这一发，「RAF 没跑」就会被读成
   「预览面不跟」。本轮实测 RAF 是活的（25 帧/400ms），所以第 1 条才是真凶。
3. **新增「载体计数」`广播写[P\d:preview]`**：有了它，「预览面没跟」才分得清是一发都没写出去
   （协调器 / 台子哑火）vs 写出去了没落到（这一臂的接线病）。两条臂都问。
4. **顶边同内容改按 `same_line` 比**（剥掉行首 markdown 标记后取包含关系）：装饰面把 `- ` / `#`
   折成样式，DOM 文本里没有它们，`a == b` 会把「落在同一行」判成「没落在同一行」。
   这条判据问的是落点，不是装饰吃了什么字符 —— 后者归②矩阵。同时把这条尺子**也拿去量臂 A**，
   否则「臂 B 差一行」无法归因（结果：臂 A 在同一尺上差一整个块）。
5. **P2-2 从「两面 scrollTop 相等」改判「各自到底」**：这不是放宽，是改对了不变量。
   B284 之后「到底」的语义就是各侧到各自的底（`anchor.ts:atBottom()` 改报文档末行，之后由
   两侧容器各自裁剪）；而 CM6 的 `scrollHeight` 在还没量过的行上是估算值，两个装饰实例同一 `v`
   落到的像素本来就可以差几千。原判据与生产语义自相矛盾。这一臂真正要问的是「刚现形那一面
   有没有复位到 0、有没有拿兜底 1.0 冒充位置」—— 答案是有问题（见 P2-2 那条 FAIL 的 5230px）。
6. **P2-1 增加「首读未到底就复读一次」**：判据取值（1.5px）不动，只是把读数等到落定。
   实测两次读数一致（89610），所以这条没有改变结论，只是排除了「读到中间帧」这一种解释。
7. **P2-4 的走位改由 Ctrl+Home 起**：臂 A 走到这里时上一判据刚做完 Ctrl+End，两侧停在底部，
   翻页无处可翻 ⇒ 判据被台子自己的顺序判红（`起点=128753 现在=128775`）。回顶部后再翻页，
   两臂都是跟着动 2700+/1380+ px。

阈值一律没动：**P3-1 的 ×1.5 与 P3-2 的 16.7ms 都按原值判**，P3-2 因此记 FAIL。

---

## ④ 顺带照出的主干问题（不在 spike 分支修，交回给你拍板）

1. **`sync_mode` 缺键 = 关**：Rust `#[serde(default)]` 的 `bool` 把「会话文件里没这个键」读成
   `false`，而前端 `docSyncOn` 的口径是「没记过 = 开」（`core/app-state.ts:182`）。
   旧版本写下的 `session.json` 升上来 ⇒ 同步滚动**静默变成关着**，而且显示与行为此刻是一致的
   （两边都关），所以用户只会觉得「同步怎么不灵了」。两种修法：Rust 侧改成 `Option<bool>`
   （`None` 交给前端缺省），或在 `setDocSyncMode` 里把「没记过」与「记了 false」区分开。
2. **`scheduleFrame` 的 `rafId` 挂死风险（未证实）**：`coordinator.ts:377` 在 `rafId !== null`
   时直接 return，而那发回调若不 fire（页面被判后台），`rafId` 就永远挂着、此后每一发广播
   都被静默丢掉。本轮 RAF 实测是活的，所以没有复现到它；但它与第 1 条是同一族「广播无声失败」，
   值得在正式化之前用一条判据钉住（例如广播计数为 0 而 `判=…·广播` 有 → 报警）。

---

## ⑤ 若仍要 go，必须补的切片（按代价排序）

1. **排版 token 接上**（评审 I3）：装饰面宿主不在 `.panel-editor` 下 ⇒ `--font-size` /
   `--font-code` / `--editor-line-height` 三条一条没吃，行距实测 13.80px vs 源码格 18.05px。
   这一条不补，下面所有像素判据都无从立；而且它现在**违反计划的 Global Constraint**。
2. **三条同形换面路径的落位与重注册**（P2-2 那一形）：`toggleViewMode` / `applyPanelMode`
   换完之后补 `landVisibleSideAtV` + `reconcileSyncRegistrations`，判据照 B310 重立。
3. **relayout 后的逐行对齐**（P2-4 那一形）：装饰抬字阶改变行盒边界 ⇒ `topPos()` 采样与
   `setVAt()` 落位要按**装饰后的**行高口径重算，B357/B300 的合并课题（与切片 1 是同一件事的两面）。
4. **到底一侧差 19px 的归因**（P2-1）：先做「编辑过再 Ctrl+End」的最小复现，再决定改谁。
5. **B337/B342/B347/B319 那批预览侧像素契约测试在装饰面上重立**（字阶五档、CJK 抬升、
   岛级节奏 —— 装饰面的行盒与派生 DOM 的块是两套几何，现成的判据一条都搬不过去）。
6. **块级富构造逐个搬成 CM6 widget**：表格、katex、mermaid、脚注（②矩阵里那四行缺失/降级）。
7. **就地编辑与表格互相打断**：spike 的镜像是只读的，所以这条**压根没验**；真实替换里它是核心。
8. **导出链路**：`markdown/exporter.ts` 自建 `#print-root`，与预览面无关（这条其实**不**是缺口，
   记在这里是为了防止正式化时误伤）。
9. **`deco_preview` 开关的正身**：spike 把它做成 `Settings.deco_preview`（默认 off，Rust 侧
   有 round-trip 测试）；正式化要挪到「文档类型 / 三态」那一档口径里，并补设置页文案。
10. **预览格里死掉的两项既有能力**（评审 I8 / 矩阵「任务勾选框」行）：Ctrl+F
    （`find/findbar.ts:174-175` 认 `p.preview`）与 B358 的勾选框点击 —— 两者都挂在
    `PreviewPane` 上，装饰面得给出自己的等价机器，不是补一行判空。
11. **非 Markdown 与大文档档位**（评审 I6）：`lifecycle.ts` 的装饰分支没问 `isMdTab`，也没走
    `editor/perf.ts:36-60` 的档位 ⇒ 开开关时一篇 `.txt` 或超大文件也会挂一颗隐形的 markdown
    镜像，每次击键全篇重 parse（生产在 `markdown.ts:74-80` 对大文档是**关掉预览**的）。
12. **击键路径的四趟全量活**（②/③ 里 P3-2 那四条）：`livePreview` 整份重建、
    `ensureSyntaxTree(doc.length)`、逐行空行扫描、桥里两次全文 `toString()` —— 都能改成增量。

### 评审后已经补掉的三条（不再是切片）

最终评审（Important #1 / #5）点到的两处按 TDD 修掉了，判据是
`tests/spike-deco-wiring.test.ts` 新增的 ④⑤⑥（三条先各自红过一次，红状与失败原因逐条记在台账）：

- **④ 旧镜像没拆**：`rebuildLayout` 的销毁循环只拆 `p.view`，装饰镜像从不 `dispose()` ——
  每次重建（分屏 / 拖出 / 关面板 / 会话恢复）漏一颗**活着**的 `EditorView`，而 CM6 的
  `selectionchange` 挂在 `document` 上、只有 `destroy()` 会摘。现在与 `p.view` 同寿。
- **⑤ 跨文档套变更**：桥只看 `ChangeSet.length`，两篇**等长**文档之间会把别人的变更按位置
  套进镜像（红的時候实测：`xxxxxxxx…` 变成 `Yxxxxxxx…`）。现在 `DecoMirror` 带 `docId` 戳，
  `syncDecoMirrors` 只写「实际躺着这篇」的镜像。
- **⑥ 写完不认领**：桥那次 `dispatch` 没进期望账本 ⇒ 镜像自己的裁剪被协调器判成用户滚动
  广播回源码（Review Focus 第 2 条那个抖动）。现在按「落在哪就是哪」补一发
  `expectSurfaceV`。

还有一处评审点到、spike **故意不修**的：`tabs/split.ts:102` 与 `io/files.ts:119` 两处换显示
仍未接 `refreshDecoMirror`（台账 Task 5 早就记为已知缺口）。有了⑤那道归属闸，那两形的后果从
「镜像被写出花」降级成「镜像停在旧文档、桥拒收」—— 显示错位，不动数据。补齐它属于切片 2。

---

## ⑥ 留与弃

值得从这次 spike 留下来的**一块种子**（与是否替换预览格无关）：
`src/spike/deco/mirror.ts` 的「只读镜像视图 + ChangeSet 桥」—— 它把「同一文档的第 N 份实例」
这件事做干净了（回声 / 同文 / 过期 / **归属**四道闸 + 幽灵写拒 + 回声环断），110 行，
测试 21/21 在册（spike 18 + 接线 3）。
它同时证明了：**装饰面天然继承 B300 逐行对齐**，这是替换方案里唯一一条现方案拿不到的好处。
如果以后要在预览格里做「就地编辑」，从这块种子起，而不是从整条替换起。

---

## ⑦ 分支状态

`spike/b391-inknote-deco-preview` **保留在本地，不合并、不推送、不出包、无版本推进** ——
结论是一句话：**这条替换路线不成立，别再往「整格替换」上投人；要看的东西已经落进本文⑤的
切片清单和⑥的那块种子里。**

自检（本节最后这笔订正提交落地后实测；`git log --oneline main..HEAD | wc -l` = **11**：
计划 1 · 实现 5 · 结果文档 2 · 结案 1 · 评审修复 1 · 本条订正 1）：

- `git log --oneline HEAD..main | wc -l` = **0**（不落后于主干）
- `git diff --stat main...HEAD -- src/markdown src/styles` = **空**
  —— 生产渲染链路与样式表一行没动；碰到的生产文件只有 `src/core/app-state.ts`（+31，
  `isDecoPreviewEnabled` 那个闸）、`src/tabs/lifecycle.ts`（+100/−18，全在开关分支与
  镜像生命周期里）、`src/sync-scroll/wire.ts`（+7，`faceOf` 的装饰分支）、`src/main.ts`
  （+5，镜像桥一行）、`src/ipc/api.ts`（+9）与 `src-tauri/src/session/mod.rs`（+32，含 round-trip 测试）
- 关着 `deco_preview` 时全量门禁与主干一致：评审修复后再跑一遍 = **114 文件 / 1842 测试通过**
  （spike 那两份从 18 例涨到 21 例），`tsc -b` / `eslint` / `prettier` 干净，
  `cargo test session::` 36 通过（Rust 侧本轮未再改动）

---

## ⑧ 判据行原文（23:55–23:56 那一轮，`FAILS=5 MEASURED=20`）

抄自 `.tmp/b391-check.out`（`.md-deco` 那条臂 = 装饰面；臂 A = 现方案）。
复现：`python .tmp/b391-check.py`（需先 `npm run build && cargo build --release --target-dir ../.tmp/b383-target`）。

```text
MEASURE P3-1 现方案首帧（Popen→预览侧画出 3 个 .md-block） | s=3.077
PASS 臂 A 预览侧是派生 DOM（且可见） | src={top:0,ch:667,sh:90062} pv={top:16,ch:667,sh:128289} deco=False
PASS 臂 A 源码格可滚（5000 行真进去了） | {top: 0, ch: 667, sh: 90062}
PASS P0 台子前置：这页的 RAF 在跑（广播帧的载体） | 帧数=25 臂=A（现方案）
MEASURE 对照：现方案同一形状下翻页后 | src.top=3312 pv.top=4539 pv.sh=129420
FAIL 对照 A：现方案翻页后两侧顶边同内容 | src='- 嵌套第二层' pv='有序一\n有序二'
MEASURE 对照：广播写[P2:preview] 发数 | 5
MEASURE 对照：现方案 Ctrl+End 后两侧读数 | src={top:89628,ch:667,sh:90296} pv={top:128753,ch:667,sh:129420}
PASS 对照 A：P2-1 源码侧判到底（同一判据、同一尺） | {top: 89628, ch: 667, sh: 90296}
PASS 对照 A：P2-1 派生预览侧判到底 | {top: 128753, ch: 667, sh: 129420}
MEASURE P3-2 对照：现方案 20 击键平均帧间隔 | avg=25.00ms p95=50.10ms n=84 焦点确认=True
MEASURE P2-补 A（现方案） 应用自造分屏后读数 | src={top:1999} pv={top:2751} 广播写=4 起点=17
PASS P2-补 A（现方案） 广播真的写到了预览面 | 发数=4
PASS P2-补 A（现方案） 预览面跟着动了 | 起点=17 现在=2751
MEASURE P3-1 装饰面首帧（Popen→画出 3 个带装饰的标题行） | s=2.744
MEASURE P3-1 阈值 装饰面 ≤ 现方案 × 1.5 | ratio=0.89
PASS P3-1 首帧不超过现方案 1.5 倍 | ratio=0.89（2.744 vs 3.077）
PASS 开关开着 ⇒ 可见预览面是装饰面 | {top: 0, ch: 667, sh: 68283}
PASS P0 台子前置：这页的 RAF 在跑（广播帧的载体） | 帧数=25 臂=B（装饰面）
PASS 台子找到可见的源码格 | {'x': 297, 'y': 396}
PASS P1-1 翻页后两侧顶边同内容 | src='- 嵌套第二层' pv='嵌套第二层' tops=src{top:3312,sh:90242} pv{top:3004,sh:68794}
MEASURE P1-1 广播写[P2:preview] 发数 | 5
PASS P1-2 前置：焦点确认在夹具那一格的源码编辑器里 | True
PASS P1-2 源码侧打字不得清零装饰侧 scrollTop | before=3004 after=3004
PASS P1-2 编辑内容经 ChangeSet 桥进了装饰面 | deco=True src_has=True
FAIL P2-1 源码侧判到底 | {top: 89610, ch: 667, sh: 90296}
PASS P2-1 装饰侧判到底 | {top: 68352, ch: 667, sh: 69019}
FAIL P2-2 刚现形的装饰面落到底（不是 0、不是假 1.0、各自到底） | 各面=[{top:62843,ch:667,sh:68740},{top:68352,ch:667,sh:69019}]
PASS P2-4 台子认到自己的窗口 | 17765386
PASS P2-4 relayout 后可见装饰面仍在 | True
PASS P2-4 relayout 后装饰仍挂着（带装饰的标题行 ≥3） | 16
FAIL P2-4 relayout 后同步仍联动（两侧顶边同内容） | src='## 第 93 节 · 标题行' pv='这是第 93 节的正文段落，带粗体、斜体、行内代'
MEASURE P2-4 广播写[P2:preview] 发数（臂 B 累计） | 9
MEASURE P3-2 装饰面 50 击键期间平均帧间隔 / p95 | avg=32.16ms p95=133.40ms n=71
PASS P3-2 前置：焦点确认在夹具那一格 | True
PASS P3-2 前置：50 次击键确实写进了文档 | True
FAIL P3-2 平均帧间隔 ≤ 16.7ms（60fps 档） | avg=32.16ms
MEASURE 能力清单（装饰面 DOM 计数） | {heading:20, list:69, quote:18, codeWidget:11, tableRendered:0, mermaid:0, mathRendered:0}
PASS 标题/围栏代码在装饰面里真画出来了
PASS 表格未被装饰（缺失：按原始 markdown 文本显示） | 0
PASS mermaid / 数学未被装饰（缺失） | mermaid=0 katex=0
MEASURE P2-补 B（装饰面） 应用自造分屏后读数 | src={top:86114,ch:499} pv={top:66093,ch:499,sh:69790} 广播写=4 起点=64820
PASS P2-补 B（装饰面） 广播真的写到了预览面 | 发数=4
PASS P2-补 B（装饰面） 预览面跟着动了 | 起点=64820 现在=66093
FAILS=5  MEASURED=20
```

一条同步 TRACE 原文（臂 B，P1-1 那一步 —— 在册、被读、被写、判兑现，四样齐全）：

```text
scroll[P2:preview] obs=177.95 px=3004.00 意图=177.95 落点=177.95/3004.00 补=0  →判=兑现·吞掉
读可见侧[P1:editor] v=176.00   读可见侧[P2:preview] v=177.95
```

台账里所有 `Ruling:` 行随本文一并交给最终评审。

# B391F · 把 spike 的装饰预览面正式化五片之后 —— 真机复跑与合并评估

**结论：能力面补齐了，精度面没补齐 ⇒ 仍然不建议回合。**
表格 / 公式 / mermaid / 勾选框 / Ctrl+F 五类「spike 里缺失或死掉」的能力，这次在**真机上全部判绿**；
而 B391 判 NO-GO 的那两条主病灶 —— 同步落点精度（P1-1 / P2-1 / P2-2 / P2-4）与击键帧间隔（P3-2）——
一条没好，其中 P1-1 还比 spike 那一轮**退化**了。这两类正是台账里过去一年返工最多的地方
（B268 / B282 / B284 / B286 / B299 / B301 / B310 / B344 / B355 / B357）。

- 分支：`spike/b391-inknote-deco-preview`（未合并、未推送、无 bump、无出包）
- 本轮五笔：`d8c3b2c`（切片 1+3）· `ee47814`（切片 2）· `67f4c4e`（切片 4）· `9377c62`（切片 5）· 本文档
- 台子：`.tmp/b395-check.py` → `.tmp/b395-check.out`（**FAILS=7 MEASURED=20**，2026-10-27 08:08 那一轮；
  判据行原文在④）
- 二进制：`.tmp/b383-target/release/litepad.exe`（`npm run build` + `cargo build --release`，
  与出包同一份代码，只差安装器封装）
- 门禁（关着 `deco_preview` 的全量）：**115 文件 / 1872 测试通过** · `tsc -b` / eslint / prettier 干净

---

## ① 五片各修的是结果文档⑤里哪一条

| 切片 | 补的缺口 | 落点 | 判据 |
| --- | --- | --- | --- |
| 1 | 排版 token 没接到装饰面（行距 13.80 vs 18.05） | `src/styles/global.css` 三条规则各补一条 `.md-deco-host` 选择器 | 真机 P2-4b：**行高 18 = 18** ✅（spike 是 18.05 vs 13.80） |
| 2 | 换 state 的四条同形路径不给装饰面播种 | 新增 `src/spike/deco/panelBridge.ts`（`refreshDecoMirror` 搬出来破环），`tabs/split.ts`、`io/files.ts` 各补一发 | `tests/spike-deco-wiring.test.ts` B391F-2 三条静态守卫（`refreshDecoMirror` 发数 ≥ `view.setState` 发数） |
| 3 | 挂载点不问「是不是 md」「档位让不让」；`bigDoc` 两边不对称 | `shouldMountDecoPreview(tab)` 三道闸；`editor/perf.ts` 导出共用 `LAZY_THRESHOLD_LINES`；`codeBlockWidget` 按行数算 `bigDoc` | B391F-3 六条谓词形状（含孤儿实例 `.not.toThrow()`） |
| 4 | 表格 / 公式 / mermaid 未搬（InkNote 有、装饰面无） | 新增 `src/spike/deco/richWidgets.ts`（`MathWidget` / `MermaidWidget` / 只读 `TableWidget` + `scanMath` 移植），`previewSets` 加 `occupied` 交叠闸 | 真机⑤节 9 条 + `spike-deco.test.ts` B391F-4 七例 |
| 5 | 预览格里 Ctrl+F 与勾选框两项既有能力死掉（评审 I8） | 新增 `src/spike/deco/taskClick.ts`（点勾命中判定移植 InkNote `editor.ts:1223-1293`）；`mirrorState` 挂 `findHighlight()`；`findbar.ts` 三条分支认「看得见那一面」 | 真机 F 节 5 条 + T 节 6 条 ✅；单测 4 例 + 接线 3 例 |

切片 5 特意**不做**的一件事：勾选框交回宿主的是**文档行号**，不是「渲染面里第 N 个 `.md-task`」。
现方案那套岛内序号换算就是 B394-2 把勾写到别的行的根因；行号没有中间量，
真机 T-3 判的正是「源码里恰好一行翻勾、别的行一字不动」（PASS：`- [ ] 未做的任务 → - [x] 未做的任务`）。

---

## ② 补齐了哪些能力（真机 DOM 计数，紧凑富构造夹具 417 字节）

```text
MEASURE ⑤ 能力清单（装饰面 DOM 计数 · 顶底取并） |
  {heading:2, list:8, taskBox:4, quote:2, codeWidget:2, shiki:2,
   tableRendered:2, rawPipe:0, mermaid:2, mermaidPending:0,
   mathRendered:6, mathPending:0, footnoteHtml:0}
```

计数都是「两个装饰面之和」（两格各挂一颗镜像），判据一律问 `>0` / `==0`，不问等于几。

- **表格**：`<table>` 在装饰面里真画出来了，且 `rawPipe=0` ⇒ 没有一行还停在 `| … |` 原文。
  这一轮**只做只读**：可编辑表格要反向写回桥（切片 7），spike 没验过，本轮也不碰。
- **公式**：`.katex` 6 处，占位 `mathPending=0` ⇒ 没有停在「算了但没落地」。
- **mermaid**：SVG 2 处，`mermaidPending=0`。⚠️ 这一条**只能在小文档上问**：
  `enhanceMarkdown` 在 bigDoc 档位（>5000 行）不跑 Shiki、不画 mermaid（`enhance.ts:110,163`，
  两条臂一样），拿 5000 行夹具问 mermaid 量到的是档位。
- **Ctrl+F**：命中画进 `.md-deco-host`、F3 后恰有一个当前项、Esc 关栏无残影；
  浮层那颗计数读的是装饰面全文的命中表（`1 / 2`）。
- **勾选框**：点方框 ⇒ 写回源码那颗 view ⇒ 桥把改动带回装饰面（T-4 前 `false` 后 `true`）。

---

## ③ 没修好的两类，以及它们的机制

### A. 同步落点精度（P1-1 / P2-1 / P2-2 / P2-4 四条 FAIL）

**根因不在广播链，在 v→像素那一步。** 台账里 `obs==意图 → 判=兑现·吞掉`，
但顶边内容不同一句：

```text
广播写[P2:preview] 目标=81.04 行首@1095 落点=79.58      （差 1.46 行）
scroll[P2:preview] obs=79.58 … 落点=79.58/1806.67 补=0  →判=兑现·吞掉
读可见侧[P1:editor] v=81.04   读可见侧[P2:preview] v=79.58
```

`EditorScrollAnchor.setV()` 是 `lineBlockAt(...).top + frac*height`，而 CM6 的高度图对
**还没量过的行**给的是估算值；一侧从没滚到底过，它「第 81 行的顶部在第几像素」就是错的，
写进去还按同一个错读回来 ⇒ 账本判兑现，肉眼看见差一行。P2-2 那一面差 9367px 是同一件事的极端形状
（刚现形那一面从没量过全文）。P2-1 两侧各自差 19px / 313px 也是：两次复读读数不变 ⇒ 不是中间帧。

**为什么这一族在派生 DOM 方案里不存在**：`PreviewScrollAnchor` 的块高是渲染完量的真实 DOM 高度，
`v→像素` 没有估算这一步（代价就是结果文档①说的那一类异步补定位机械）。
切片 1 把行距对齐了（P2-4b PASS），差一行并没有因此消失 ⇒
**「两套排版几何」只是这一族的诱因之一，主因是估算高度图**，spike 结果文档③那条推断要改。

**能修，但代价是重立那批像素契约**：落位写完必须 `requestMeasure()` 再重算目标、
差过阈值就补写，收敛 N 轮 —— 这与协调器现有「补写三轮」不是同一件事（那三轮比的是 v-to-v，
所以它自认为已经兑现）。改点在 `sync-scroll/anchor.ts` 这个**两条路共用**的类上，
B337 / B342 / B347 / B319 那批预览侧像素判据要在装饰面上重立一遍才拦得住回归。
本轮没有动它，因为它不属于装饰面自己的代码，动它就是把 spike 变成生产事故。

**P1-1 比 spike 那一轮退化**（那一轮 `pv='嵌套第二层'` PASS，这一轮 `pv='未办'`、两侧 v 差 6.25 行）。
两个候选原因，本轮**未归因**：① 切片 1 改了装饰面行高，同一 v 落到的像素变了；
② 切片 4 的块 widget 让行盒不再均匀（表格/代码/公式各是一块）。
要定责就把 `b391-check.py` 与 `b395-check.py` 在同一份代码上各跑一遍做 A/B —— 那是正式化的活，不是评估的活。

### B. 击键帧间隔（P3-2 FAIL，阈值 16.7ms 一字未放宽）

```text
装饰面 50 击键   avg=37.57ms p95=233.30ms n=63
现方案 20 击键   avg=28.22ms p95=66.60ms  n=75      （同尺对照）
```

比值 1.33（spike 那一轮 1.29），p95 差 3.5 倍。本轮只摘掉一处白送的开销：
桥里两次全文 `toString()` 改成 `Text.eq` 比结构（`src/spike/deco/mirror.ts:60`）——
对总账没决定性影响，因为剩下三趟还在：`livePreview` 每次 `docChanged` 整份重建、
`ensureSyntaxTree(state, state.doc.length, 100)` 按全文要树、空行样式逐行扫整篇。
**结论与 spike 一致：这三趟都能改成增量，但那是另一个量级的工作，不是「补一片切片」。**

---

## ④ 判据行原文（`.tmp/b395-check.out`，三遍走法）

```text
MEASURE P3-1 现方案首帧（Popen→预览侧画出 3 个 .md-block） | s=3.120
PASS P0 台子前置：这页的 RAF 在跑（广播帧的载体） | 帧数=25 臂=A（现方案）
FAIL 对照 A：现方案翻页后两侧顶边同内容 | src='- 嵌套第二层' pv='有序一\n有序二'
MEASURE P3-2 对照：现方案 20 击键平均帧间隔 | avg=28.22ms p95=66.60ms n=75 焦点确认=True
MEASURE P3-1 装饰面首帧（Popen→画出 3 个带装饰的标题行） | s=2.872
PASS P3-1 首帧不超过现方案 1.5 倍 | ratio=0.92（2.872 vs 3.120）
PASS 开关开着 ⇒ 可见预览面是装饰面 | {'top':0,'ch':603,'sh':64774}
FAIL P1-1 翻页后两侧顶边同内容 | src='- 嵌套第二层' pv='未办' tops=src{top:3312,sh:90242} pv{top:3903,sh:66744}
PASS P1-2 源码侧打字不得清零装饰侧 scrollTop | before=3903 after=3903
PASS P1-2 编辑内容经 ChangeSet 桥进了装饰面 | True
FAIL P2-1 源码侧判到底 | {'top':89610,'ch':667,'sh':90296}
FAIL P2-1 装饰侧判到底 | {'top':66501,'ch':603,'sh':67417}
FAIL P2-2 刚现形的装饰面落到底 | 各面=[{'top':56299,'ch':603,'sh':66269},{'top':66501,'ch':603,'sh':67417}]
PASS P2-4 relayout 后可见装饰面仍在 | True
PASS P2-4 relayout 后装饰仍挂着（带装饰的标题行 ≥3） | 15
FAIL P2-4 relayout 后同步仍联动（两侧顶边同内容） | src='| 1 | 值 |' pv='![图](media/placeholder.p'
PASS P2-4b 两格行高一致（排版 token 接上了 · 宽度不同故不比 scrollHeight） | {'src':18,'deco':18}
FAIL P3-2 平均帧间隔 ≤ 16.7ms（60fps 档 · 阈值不许放宽） | avg=37.57ms（现方案同尺=28.22ms）
PASS P2-补 B（装饰面） 广播真的写到了预览面 | 发数=4
PASS P2-补 B（装饰面） 预览面跟着动了 | 起点=6 现在=1807
（富构造那一遍）⑤-1..⑤-9 全 PASS · F-0..F-5 全 PASS · T-0..T-5 全 PASS
FAILS=7  MEASURED=20
```

`对照 A` 那条 FAIL 是**现方案自己的**（派生 DOM 只落到块顶，块内第几行不由它决定），
留着它就是为了让「装饰面顶边差一行」不被读成装饰面独有的病 —— 这一轮的读数是反过来的：
现方案差一整个块，装饰面差 1.46 行，两边都不合格，但装饰面已经**在逐行对齐这一维上更强**。

---

## ⑤ 装饰面仍未覆盖 / 降级的构造（合并前必须先补或先认）

| 构造 | 装饰面现状 | 本轮真机证据 |
| --- | --- | --- |
| 图片 `![…](…)` | **未处理**，按原始 markdown 文本显示 | P2-4 那一条顶边读数就是 `![图](media/placeholder.p`（现方案会渲染成 `<img>`） |
| 脚注 `[^1]` | **未移植**，行内按原文显示、没有跳转与文末列表 | ⑤-10 `footnotes 节点=0`（照成缺失，未判红） |
| 可编辑表格 | 只读渲染（点击不编辑） | ⑤-4/⑤-5 PASS，但只判渲染 |
| 就地编辑 | 镜像是只读的（`EditorState.readOnly` + `editable(false)`） | spike 就没验，仍是切片 7 |
| `deco_preview` 的「正身」 | 还是 `Settings` 里那颗布尔开关，默认 off，**设置页没有入口** | 本轮全部判据是台子直接写 `settings.json` 打开的 |

图片是这一表里唯一「InkNote 有、LitePad 现方案也有、只有装饰面没有」的一格，
补法与切片 4 同形：`ImageWidget` 造 `<img>`，再走 `enhanceMarkdown(wrap, seq, {baseDir})`
（相对路径→asset 协议那段现成，`enhance.ts:70-79`），代价是要把 `baseDir` 从
`lifecycle → createDecoMirror → mirrorState → livePreview → buildPreviewSets` 穿一层过去。

---

## ⑥ 交给拍板的三句话

1. **能力面**已经能补齐，而且补齐的路径很短（本轮五片全是加法，没动生产渲染链路）。
2. **精度面与性能面**的缺口不在装饰面自己的代码里，在「CM6 估算高度图 + 每次击键全量重建」这两件事上；
   要补就得同时重立 B337 / B342 / B347 / B319 那批像素契约 —— 这与 spike 时的判断一致，且本轮
   P1-1 的退化说明这笔代价比结果文档①估的还要再厚一点。
3. 所以：**继续不合并、不推送、不出包**。要看效果就用 `.tmp/b383-target/release/litepad.exe`
   （本轮真机判据跑的就是它），在配置里写 `"deco_preview": true` 即得装饰预览面。
   若仍要一个安装包去给旁人看，说一声，我按规矩先 bump 再 `scripts/build-all.sh`。

---

## ⑦ 分支自检（本文档落地后）

- `git log --oneline main..HEAD | wc -l` = **17**（spike 11 + 本轮 6：合主干 1 · 实现 4 · 本文档 1）
- `git log --oneline HEAD..main | wc -l` = **0**（不落后于主干）
- 装饰面之外碰到的生产文件共 11 个，每一个都是「接线」而不是「改渲染链路」：
  `core/app-state.ts`（闸门谓词）· `editor/perf.ts`（导出共用 `LAZY_THRESHOLD_LINES`）·
  `find/findbar.ts`（三条「看得见那一面」分支）· `io/files.ts` / `tabs/split.ts`（各补一发播种）·
  `ipc/api.ts` / `main.ts`（桥与开关）· `markdown/preview.ts`（只把本地常量换成 import）·
  `styles/global.css`（三条排版规则各补一条 `.md-deco-host` 选择器）· `sync-scroll/wire.ts`（`faceOf` 装饰分支）·
  `tabs/lifecycle.ts`（挂载分支与镜像生命周期）
- `src/markdown/pipeline.ts` / `src/markdown/enhance.ts` / `src/markdown/tasks.ts` /
  `src/sync-scroll/anchor.ts` / `src/sync-scroll/coordinator.ts` **一行未动** ——
  本轮所有修法都在开关分支与 `src/spike/**` 里，落点精度那条病灶（③A）就在这几个未动的文件里。
- 关着 `deco_preview` 时全量门禁与主干一致：**115 文件 / 1872 测试通过** · `tsc -b` / eslint / prettier 干净

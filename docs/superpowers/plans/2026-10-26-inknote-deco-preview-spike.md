# InkNote 式装饰预览 Spike 验证计划（B391）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一条 spike 分支回答一个问题——把 LitePad 的预览格换成 InkNote 式「CM6 + 装饰面」，是否比现方案更简单、且不削弱现有能力；产出 go/no-go 结论与量化证据，不产出可发布功能。

**Architecture:** 两段式。先廉价证伪：在 `.tmp/` 骨架页里跑两个各自持有 `EditorState` 的 CM6 视图（一个源码、一个只读装饰），验证移植来的装饰机制本身成立；再真接线：把只读装饰实例作为「同文档的第 N 份实例」塞进 LitePad 既有的 `syncDocInstances` 广播与 `EditorScrollAnchor` 注册口，用现成的真机台量落点与性能。装饰层从 InkNote（MIT）移植**机制**（`buildPreviewSets` / `applySelection` / `livePreview` / `draftFences`），块 widget 只做一个（围栏代码）——表格、公式、mermaid、图片明确不在 spike 范围内。

**Tech Stack:** CodeMirror 6（`@codemirror/{view,state,language,lang-markdown}`，LitePad 已全有）、Vitest + jsdom 契约测试、`.tmp/b352-check.py`（PrintWindow）+ `.tmp/b381-check.py` 的 `CDP` 类真机台、Vite 骨架页。

**Spec:** 本计划自带规格——无独立设计文档。判据依据写在下面「背景与判据」；移植来源逐处标 InkNote 文件行号。前一次自建 IR 的教训见 [docs/superpowers/plans/2026-10-24-selfbuilt-ir-live-preview.md](./2026-10-24-selfbuilt-ir-live-preview.md)，其代码在提交 `3b40652` 被整体拆除，可 `git show` 取回对照。

## 背景与判据（结论要落在这三条上）

LitePad 现状：预览是**派生 DOM**（`markdown-it` → HTML → Shiki/KaTeX/mermaid 后处理，`PreviewPane` 在 [src/markdown/preview.ts:48](../../../src/markdown/preview.ts)），源码是 CM6。两套解析器各判一遍同一份 markdown，同步滚动预览侧只能「块内源行插值」（[src/sync-scroll/preview.ts:12-17](../../../src/sync-scroll/preview.ts) 注释自陈「块内多源行为近似」）。

已核实、决定了本 spike 形状的四条事实：

1. LitePad 的多实例模型是**每实例一份 `EditorState` + 把同一个 `ChangeSet` 映射给兄弟实例**（[src/main.ts:328](../../../src/main.ts) 调 `syncDocInstances`，[:356](../../../src/main.ts) 定义），**不是**共享 state。所以「预览 = 又一个 CM6 实例」不需要新造多视图机制。
2. 两侧锚点已经是同一个接口：源码侧 `new EditorScrollAnchor(view)`（[src/sync-scroll/wire.ts:117](../../../src/sync-scroll/wire.ts)），预览侧 `new PreviewScrollAnchor(...)`（[src/markdown/preview.ts:395](../../../src/markdown/preview.ts)）。装饰实例天然满足源码侧那个结构子集。
3. 「预览重渲染把 `scrollTop` 清零、落点被冲掉」这一整类坑（B23 / B265 / B269 / B285 / B344）的根因是派生 DOM 被整棵替换；[src/main.ts:296-304](../../../src/main.ts) 那段注释就是为它写的排程闸。
4. InkNote 编辑器层不依赖 React，外部 import 只有 CM6 / lezer / katex / hljs / html-to-image / Tauri 插件，往自己 App 伸出去的触手是 `lib/{i18n,useToast,editorBridge,markdownOutline,frontmatter,paths,htmlPaste,pendingImages,imageAssets,mermaid}`。

**spike 要证伪的三条主张：**

- **P1（更简单）**：删掉 `scheduleMdRender` + 岛级增量重画 + 落位补偿这一整块机器后，B23 / B269 那两类症状不再出现。
- **P2（不削弱）**：同步滚动的「到底共享锚点」「`hasPosition()` 诚实值」「落位三条同形路径」在两侧都是 CM6 时仍立得住。
- **P3（不更贵）**：装饰层每次击键的全文遍历 × 实例数，在 5000 行文档上不显著劣于现方案（量出来，不靠感觉）。

## Global Constraints

- 只在 `spike/b391-inknote-deco-preview` 分支上工作。**不 bump 版本、不出包、不推送、不合回 main**。
- 生产路径零改动：`Settings.deco_preview` 关着时，`src/spike/**` 必须完全不可达（Task 5 有静态守卫咬这条）。
- 移植文件顶部保留来源声明：`// 移植自 InkNote (MIT, Copyright (c) 2026 likehao19) src/editor.ts:105-898` + 本机路径 `E:\Project\InkNote\InkNote`。
- 全量测试必须 `npx vitest run --no-file-parallelism`（并发跑会漂移红）；结论只读日志里的 `Test Files` / `Tests` 行，不信管道后的 exit code。
- 真机台只停自己记录的 PID（`bc.OUR_PID = bc._load_pid()`），**绝不 `taskkill /IM`**。
- 装饰面的颜色/尺寸只消费既有主题 token（`--fg` / `--bg` / `--syntax-*` / `--fs-*`），spike 里不许写死字面量色值——B337/B342/B347 那批字阶与 CJK 抬升口径不许被绕过。
- 每个 Task 结束时提交一次，message 前缀 `spike(b391):`。

## 共享测试 helper（Task 1 建，后续任务直接引用，不各造一份）

放在 `tests/spike-deco-helpers.ts`：

- `docState(input: string | number): EditorState` —— 字符串按原样建 state；数字生成 N 行 `第 k 行内容` 的文档。
- `lastChanges(view: EditorView): ChangeSet` —— 取该视图最近一次 update 的 `tr.changes`（**不要**手搓 `ChangeSet.empty(n)`：纯选区事务的 changes 尺寸必须等于文档长度，手搓会造出一个真事务）。
- `watchBroadcast(view: EditorView, cb: () => void): () => void` —— 用 `EditorView.updateListener` 挂一个只计数不写回的探针，返回卸载函数。

## Review Focus

规格隐含、但默认没有任何测试覆盖、且最容易伤到使用者的五类输入/失效模式。每行都已在对应任务里落了钉住它的测试：

1. **幽灵 `docChanged`**：切视图 / 重新测量 / 仅改选区的事务，CM6 会报 `docChanged` 但文本未变 ⇒ 被当成编辑会误置脏、误触发自动保存写盘（现方案在 [src/main.ts:296-310](../../../src/main.ts) 已吃过一次）。→ **Task 4 Step 1 测试①**（回写层）+ **Task 5 Step 1 测试③**（整窗层：切源码/预览 20 次不置脏、无第二次 autosave）。
2. **两视图互相回声**：A 广播给 B，B 的 update 又广播回 A ⇒ 循环或位置抖动。→ **Task 4 Step 1 测试②**。
3. **`renderSplitview` 整棵重建后掉线**：面板树每次重建都清空容器，装饰实例的 DOM、锚点注册、ResizeObserver 全被抹掉（B344 类）。→ **Task 6 Step 2 判据④**（拖分屏 / 切标签后装饰仍生效且仍在册）。
4. **未闭合围栏与 frontmatter 让装饰覆盖整篇**：CommonMark 下未闭合 ``` 一路吃到文末；`---` 会被 lezer 判成 HorizontalRule + SetextHeading。InkNote 专门为这两处写了 `draftFences` 与 fm 跳过。→ **Task 2 Step 1 两条**。
5. **大文档输入卡顿**：每次击键全文遍历语法树 × 实例数。→ **Task 6 Step 3 阈值**。

---

### Task 0: 骨架页与分支自检

**Files:**

- Create: `.tmp/b391-skeleton.html`
- Create: `.tmp/b391-skeleton.ts`
- Create: `.tmp/b391-fixture.md`

**Interfaces:**

- Consumes: 无
- Produces: `#a` / `#b` 两个挂载点供 Task 1-4 在真实浏览器里量布局；`window.__spike = { viewA, viewB, doc(): string }` 供 CDP `Runtime.evaluate` 取值。

- [ ] **Step 1: 确认分支与工作树**

Run: `git branch --show-current && git status --short`
Expected: `spike/b391-inknote-deco-preview`，status 为空

- [ ] **Step 2: 写骨架页**

`.tmp/b391-skeleton.html` 以 `<script type="module" src="/.tmp/b391-skeleton.ts">` 引入（Vite dev server 以项目根为 root，可直接伺服 `.tmp/` 下的 ESM）；两栏 `#a`（源码视图）/ `#b`（只读装饰视图，Task 1 前挂空扩展），各自 `EditorState.create({ doc: 同一份 markdown })`。`.tmp/b391-fixture.md` 自带一份约 200 行、含标题 / 嵌套有序与无序列表 / 引用 / 围栏代码 / 表格 / frontmatter / 未闭合围栏样例的文档。

- [ ] **Step 3: 起 dev server 并用 browser-use 截图（红基线）**

Run: `npx vite --port 1420`（后台），browser-use 打开 `http://127.0.0.1:1420/.tmp/b391-skeleton.html` 截图
Expected: 两栏都渲染同一份文档，**B 栏仍看得见 `##` / `>` / `-` 原始标记**——这张图是 Task 1 的红基线

- [ ] **Step 4: 提交**

```bash
git add .tmp/b391-skeleton.html .tmp/b391-skeleton.ts .tmp/b391-fixture.md
git commit -m "spike(b391): 骨架页 —— 两份独立 EditorState 并排，装饰面待接"
```

---

### Task 1: 移植装饰集构建与 reveal 过滤（`previewSets`）

**Files:**

- Create: `src/spike/deco/previewSets.ts`
- Create: `tests/spike-deco-helpers.ts`
- Create: `tests/spike-deco.test.ts`
- 参照移植: `E:\Project\InkNote\InkNote\src\editor.ts:105-898`（`buildPreviewSets`）、`:794-820`（`applySelection`）

**Interfaces:**

- Consumes: `EditorState`、`@codemirror/language` 的 `syntaxTree` / `Tree`、`@codemirror/lang-markdown` 的节点名（`ATXHeading1..6` / `QuoteMark` / `Blockquote` / `ListMark` / `Task` / `ListItem` / `FencedCode`）
- Produces:
  - `interface BlockRange { from: number; to: number }`
  - `interface PreviewSets { lines: DecorationSet; statics: DecorationSet; atomicBlocks: BlockRange[] }`
  - `function buildPreviewSets(state: EditorState, tree?: Tree): PreviewSets` —— **`tree` 省略时内部取 `syntaxTree(state)`**；Task 2 起所有装饰路径一律显式传 `previewSyntaxTree(state)`
  - `function revealFilterRange(state: EditorState): { head: number; filterFrom: number; filterTo: number }` —— 把「扫描窗口」拆成纯函数，P3 的可测形态就是它
  - `function applySelection(statics: DecorationSet, state: EditorState): DecorationSet`

- [ ] **Step 1: 写失败测试（reveal 窗口只覆盖光标行）**

```ts
it("reveal 扫描窗口 = 光标所在行，不是整篇（P3 的根）", () => {
  const state = docState(5000);
  const head = state.doc.line(4200).from + 3;
  const { filterFrom, filterTo } = revealFilterRange(state.withSelection({ anchor: head }));
  const line = state.doc.lineAt(head);
  expect(filterFrom).toBe(line.from);
  expect(filterTo).toBe(line.to);
  expect(filterTo - filterFrom).toBeLessThan(state.doc.length / 10);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/spike-deco.test.ts -t "reveal 扫描窗口"`
Expected: FAIL（`revealFilterRange` 未定义）

- [ ] **Step 3: 实现三个导出**

`buildPreviewSets` 只搬**行装饰 + 标记隐藏 + 整行覆盖判定**三类（`coversWholeLines` 必须一起搬，否则块替换会把行从中间劈开）；表格 / 公式 / mermaid / 图片 / 脚注那几段**不搬**。`applySelection` 用 `revealFilterRange` 的结果喂 `statics.update({ filter, filterFrom, filterTo })`。

- [ ] **Step 4: 补三条机制测试并跑绿**

````ts
it("标题/引用/列表各挂一条行装饰", ...);          // 断 sets.lines 在对应行 from 上的 class
it("块级替换必须整行覆盖，半行不替换", ...);       // 构造 `x ```y` 同行，断 atomicBlocks 为空
it("同一 state 连调两次 buildPreviewSets 结果幂等", ...); // 比 range 数与端点，不比对象身份
````

Run: `npx vitest run tests/spike-deco.test.ts --no-file-parallelism`
Expected: PASS（4 passed）

- [ ] **Step 5: 骨架页接上，肉眼结案**

B 栏扩展挂 `EditorView.decorations.compute`（Task 3 才换成 `livePreview`），browser-use 重新截图
Expected: B 栏看不到 `##` / `>` / `-` 原始标记，标题有上方留白——与 Task 0 Step 3 红基线对照

- [ ] **Step 6: 提交**

```bash
git add src/spike/deco/previewSets.ts tests/spike-deco-helpers.ts tests/spike-deco.test.ts .tmp/b391-skeleton.ts
git commit -m "spike(b391): 移植 buildPreviewSets/applySelection，reveal 窗口拆成纯函数"
```

---

### Task 2: 未闭合围栏与 frontmatter 两道防吞（`codeFence`）

**Files:**

- Create: `src/spike/deco/codeFence.ts`
- Modify: `tests/spike-deco.test.ts`
- 参照移植: `E:\Project\InkNote\InkNote\src\editor\codeFence.ts`；`editor.ts:602-604`（`CodeMark < 2` 直接不替换）、`:324-327`（fm 区间跳过）

**Interfaces:**

- Consumes: Task 1 的 `buildPreviewSets(state, tree?)`
- Produces:
  - `const draftFences: StateField<number[]>`
  - `const setDraftFences: StateEffect<number[]>`
  - `function isUnclosedFenceLine(text: string): boolean`
  - `function previewSyntaxTree(state: EditorState): Tree`
  - `function frontMatterRange(state: EditorState): { from: number; to: number } | null`

- [ ] **Step 1: 写两条失败测试（Review Focus 第 4 条）**

````ts
it("未闭合围栏不得把整篇吞成一个块", () => {
  const state = docState("标题\n```\n半截代码\n后面还有三大段\n");
  const { atomicBlocks } = buildPreviewSets(state, previewSyntaxTree(state));
  expect(atomicBlocks).toEqual([]);
});
it("frontmatter 的开头 --- 不被判成整行块替换", () => {
  const state = docState("---\ntitle: x\n---\n正文\n");
  const fm = frontMatterRange(state);
  expect(fm).toEqual({ from: 0, to: 13 });
  const { atomicBlocks } = buildPreviewSets(state, previewSyntaxTree(state));
  expect(atomicBlocks.some((b) => b.from === 0)).toBe(false);
});
````

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/spike-deco.test.ts -t "未闭合围栏|frontmatter"`
Expected: 两条 FAIL

- [ ] **Step 3: 实现 `previewSyntaxTree`**

把 `draftFences` 命中的行整行替换成**等长空格**后离线重 parse 整篇（等长是为了位置不漂）；`isUnclosedFenceLine` 照 InkNote 判据：行首 ≤3 空格 + ≥3 个 `` ` `` 或 `~`。Task 1 的 `buildPreviewSets` 内部兜底 `syntaxTree(state)` 保留，但所有调用点改为显式传 `previewSyntaxTree(state)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/spike-deco.test.ts --no-file-parallelism`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/spike/deco/codeFence.ts tests/spike-deco.test.ts
git commit -m "spike(b391): draftFences + 离线重 parse，未闭合围栏不再吞整篇"
```

---

### Task 3: 一个块 widget 打通原子区间（围栏代码）

**Files:**

- Create: `src/spike/deco/livePreview.ts`
- Create: `src/spike/deco/codeBlockWidget.ts`
- Create: `src/spike/deco/deco.css`
- Modify: `tests/spike-deco.test.ts`
- 参照移植: `editor.ts:850-898`（`atomicBlockRanges` + `livePreview` StateField）、`widgets/codeBlock.ts:131-315`（**只借壳**，高亮改调 LitePad 现成 Shiki 出口）

**Interfaces:**

- Consumes: Task 1 的 `PreviewSets`、Task 2 的 `previewSyntaxTree`、`src/markdown/enhance.ts` 里的 Shiki 调用路径
- Produces:
  - `function livePreview(opts: { readOnly: boolean }): Extension` —— `provide` 出 `EditorView.decorations`（lines + visible）与 `EditorView.atomicRanges`
  - `class CodeBlockWidget extends WidgetType`，`eq(other): boolean` 比 `to - from` 长度 + code + lang，**不比绝对 from**

- [ ] **Step 1: 写失败测试（eq 的写法是移植要点，必须钉住）**

````ts
it("eq 比长度与内容、不比绝对位置", () => {
  const a = new CodeBlockWidget(10, 40, "x", "ts");
  expect(a.eq(new CodeBlockWidget(90, 120, "x", "ts"))).toBe(true); // 位置不同、内容同 ⇒ 复用 DOM
  expect(a.eq(new CodeBlockWidget(10, 41, "x", "ts"))).toBe(false); // 长度不同 ⇒ 重建
});
it("只读装饰面仍把整行围栏代码挂成原子块", () => {
  const state = docState("前文\n```ts\nlet a = 1\n```\n后文\n");
  const { atomicBlocks } = buildPreviewSets(state, previewSyntaxTree(state));
  const fenceFrom = state.doc.line(2).from;
  const fenceTo = state.doc.line(4).to;
  expect(atomicBlocks).toEqual([{ from: fenceFrom, to: fenceTo }]);
});
````

- [ ] **Step 2: 跑测试确认失败** — Expected: FAIL（`CodeBlockWidget` 未定义）

- [ ] **Step 3: 实现 widget + `livePreview`**

widget 的 DOM 结构照 InkNote（外层 wrap + `data-block-len` + 一个 `.md-block-source`），但**不搬 `attachSourceEditing`**（spike 只读，无原位编辑）；高亮走 Shiki 异步，未回来前显示原文，回来后 `view.requestMeasure()`。`deco.css` 只消费主题 token（Global Constraints）。

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS

- [ ] **Step 5: 骨架页复核** — browser-use 点 B 栏围栏代码块内部，断 `window.__spike.viewB.state.selection.main.head` 落在块外（原子区间生效），截图一张

- [ ] **Step 6: 提交**

```bash
git add src/spike/deco/livePreview.ts src/spike/deco/codeBlockWidget.ts src/spike/deco/deco.css tests/spike-deco.test.ts
git commit -m "spike(b391): livePreview 挂 atomicRanges + 只读围栏代码 widget（Shiki 复用）"
```

---

### Task 4: 只读镜像视图与 ChangeSet 桥（P1/P2 的机制底座）

**Files:**

- Create: `src/spike/deco/mirror.ts`
- Modify: `tests/spike-deco.test.ts`
- 参照: [src/main.ts:356](../../../src/main.ts) `syncDocInstances` 的既有口径（回声用模块级 `syncing` 位，不新造机制）

**Interfaces:**

- Consumes: Task 3 的 `livePreview`；`@codemirror/state` 的 `ChangeSet`；共享 helper `lastChanges` / `watchBroadcast`
- Produces:
  - `interface DecoMirror { view: EditorView; dispose(): void }`
  - `function createDecoMirror(parent: HTMLElement, doc: string): DecoMirror`
  - `function mirrorChanges(src: EditorView, dst: EditorView, changes: ChangeSet): "applied" | "skipped-identical" | "skipped-echo"`
  - `function isMirrorSyncing(): boolean`

- [ ] **Step 1: 写三条失败测试（Review Focus 第 1、2 条）**

```ts
it("① 文本未变的事务不回写（幽灵 docChanged）", () => {
  const { src, dst } = twoViews(); // 本任务测试内建：两个同文档视图
  src.dispatch({ selection: { anchor: 7 } }); // 仅选区，changes 为空
  expect(mirrorChanges(src, dst, lastChanges(src))).toBe("skipped-identical");
});
it("② 镜像回写不再触发第二次广播（无回声环）", () => {
  const { src, dst } = twoViews();
  let dstBroadcasts = 0;
  const off = watchBroadcast(dst, () => dstBroadcasts++);
  src.dispatch({ changes: { from: 0, insert: "x" } });
  mirrorChanges(src, dst, lastChanges(src));
  off();
  expect(dstBroadcasts).toBe(0);
});
it("③ 镜像后两侧文本一致，且 dst 的 scrollTop 未被写", () => {
  const { src, dst } = twoViews();
  dst.scrollDOM.scrollTop = 120;
  src.dispatch({ changes: { from: 0, insert: "改一版" } });
  mirrorChanges(src, dst, lastChanges(src));
  expect(dst.state.doc.toString()).toBe(src.state.doc.toString());
  expect(dst.scrollDOM.scrollTop).toBe(120);
});
```

- [ ] **Step 2: 跑测试确认失败** — Expected: 三条 FAIL

- [ ] **Step 3: 实现 `mirrorChanges`**

判「文本真的变了」用 `!changes.empty` **且** dst 侧前后 `sliceString` 不等（与 [src/main.ts:301-303](../../../src/main.ts) 的 `before !== now` 同口径）；回声用 `isMirrorSyncing()` 那道模块级位。

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/spike/deco/mirror.ts tests/spike-deco.test.ts
git commit -m "spike(b391): 只读镜像视图 + ChangeSet 桥（防幽灵回写与回声环）"
```

---

### Task 5: 塞进 LitePad 面板模型（开关隔离）

**Files:**

- Modify: `src/prefs.ts`（`Settings.deco_preview: boolean`，默认 `false`）
- Modify: `src/tabs/lifecycle.ts:254`（预览实例构造点：开关开着时改走 `createDecoMirror`）
- Modify: `src/sync-scroll/wire.ts:117`（装饰实例按 `EditorScrollAnchor` 注册）
- Modify: `src/main.ts:328` 附近（`syncDocInstances` 把装饰实例算作兄弟实例之一）
- Create: `tests/spike-deco-wiring.test.ts`
- 参照: [src/markdown/preview.ts:395](../../../src/markdown/preview.ts)（现预览侧注册口，作对照）

**Interfaces:**

- Consumes: Task 4 的 `DecoMirror` / `mirrorChanges`；既有 `instancesOfDoc` / `syncDocInstances` / `CoordinatedSurface`
- Produces: `function isDecoPreviewEnabled(settings: Settings): boolean` —— **唯一**读那颗开关的地方，其余分支一律问它

- [ ] **Step 1: 写三条失败测试（含 Review Focus 第 1 条的整窗层）**

```ts
it("① 关着时不构造装饰实例（静态守卫）", () => {
  // callsiteGuarded(src: string): boolean —— 本测试文件内定义：
  // 扫 src/tabs/lifecycle.ts，要求每个 createDecoMirror( 调用点都落在
  // isDecoPreviewEnabled(...) 为真的分支块内（按大括号配平取块体，不用行号猜）。
  expect(callsiteGuarded(readFileSync("src/tabs/lifecycle.ts", "utf-8"))).toBe(true);
});
it("② 开关开着：预览实例的 DOM 形状是 .cm-editor 而不是 .md-rendered", () => {
  // jsdom 下造面板实例，断形状
});
it("③ 开着开关连切源码/预览 20 次：doc.dirty 不变、autosave 只排一次", async () => {
  // 钉住 Review Focus 第 1 条的整窗层：幽灵 docChanged 不得置脏、不得二次排程写盘
});
```

- [ ] **Step 2: 跑测试确认失败** — Expected: 三条 FAIL

- [ ] **Step 3: 落地四处改动**

`lifecycle.ts` 预览构造点按 `isDecoPreviewEnabled` 二选一；`wire.ts` 装饰实例复用源码侧那条 `{ anchor: new EditorScrollAnchor(view), el: view.scrollDOM, label }`；`syncDocInstances` 的兄弟遍历里让装饰实例走 `mirrorChanges` 而不是重新 `setState`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/spike-deco-wiring.test.ts --no-file-parallelism`
Expected: PASS（3 passed）

- [ ] **Step 5: 跑全量门禁**

Run: `npx vitest run --no-file-parallelism > .tmp/b391-suite.log 2>&1`，读日志 `Test Files` / `Tests` 行
Expected: 全绿（基线 112 文件 / 1821 用例 + 本 spike 新增）

- [ ] **Step 6: 类型与格式**

Run: `npx tsc -b && npx eslint src/spike tests/spike-deco*.ts && npx prettier --check src tests`
Expected: 三者零输出

- [ ] **Step 7: 提交**

```bash
git add src/prefs.ts src/tabs/lifecycle.ts src/sync-scroll/wire.ts src/main.ts tests/spike-deco-wiring.test.ts
git commit -m "spike(b391): 装饰预览作为同文档第 N 份实例接进面板模型（deco_preview 开关）"
```

---

### Task 6: 真机台与三条主张的量化（P1 / P2 / P3 结案）

**Files:**

- Create: `.tmp/b391-check.py`
- Create: `.tmp/b391-fixture-big.md`（5000 行）
- Create: `docs/superpowers/plans/2026-10-26-inknote-deco-preview-spike-results.md`
- Modify: `.tmp/b352-check.py`（加 `BENCH_DECO=1` → `base["deco_preview"] = True`，与既有 `BENCH_THEME` 同机制）

**Interfaces:**

- Consumes: 真机台既有 `cmd_go` / `load` / `shoot` / `CDP`
- Produces: `.tmp/b391-check.out`（逐条 PASS/FAIL）+ 结果文档里三张表（落点、能力清单、性能）

- [ ] **Step 1: P1 判据（老症状复测）**

大纲跳转后落点偏差 ≤ 1 个设备像素（CDP 读 `.panel-host .cm-scroller` 的 `scrollTop`，跳转前后各一次）；文本变化后 `scrollTop` 不被清零（对照 B23 / B269 的场景形状）。

- [ ] **Step 2: P2 判据（同步滚动不削弱）—— 四条**

① 到底共享锚点：两侧都判到底；② `hasPosition()` 诚实值：装饰实例未铺开时报 false 而不是 1.0；③ 落位三条同形路径：点标签 / 拖标签跨面板 / 关相邻标签激活相邻；④ **面板重建后仍生效且仍在册**（拖分屏、切标签之后：装饰仍在（B 栏看不到原始标记）、锚点仍在 `CoordinatedSurface` 名册里、同步仍联动）——钉住 Review Focus 第 3 条。

- [ ] **Step 3: P3 判据（性能闸门，阈值判，不靠截图感觉）**

`.tmp/b391-fixture-big.md`（5000 行）下量三个数：首帧装饰耗时、连续 50 次击键的平均帧间隔、`buildPreviewSets` 单次耗时。阈值：首帧 ≤ 现方案首帧 × 1.5；击键平均 ≤ 16.7ms。

- [ ] **Step 4: 跑台子并如实记录**

Run: `python .tmp/b391-check.py > .tmp/b391-check.out 2>&1`，读输出里的 `FAIL` 计数
Expected: **允许 FAIL**——spike 的价值就在照出不成立的项。**禁止为了变绿而放宽阈值**；任何阈值调整必须在结果文档里写明理由。

- [ ] **Step 5: 写结果文档（go/no-go）**

三节：① P1 / P2 / P3 逐条成立与否 + 证据行；② 与现方案的可见差异截图矩阵（标题 / 嵌套列表 / 引用 / 围栏代码 / 表格 / 公式 / mermaid / 脚注 / frontmatter，逐项标「一致 / 降级 / 缺失」）；③ 若 go，正式化要补的切片——**至少**含：表格与原位编辑的互相打断（spike 只读故未验）、导出链路（`markdown-it` 那条尾巴）、B337/B342/B347/B319 那批预览侧像素契约测试的重立。

- [ ] **Step 6: 提交**

```bash
git add .tmp/b391-check.py .tmp/b391-fixture-big.md docs/superpowers/plans/2026-10-26-inknote-deco-preview-spike-results.md
git commit -m "spike(b391): 真机台三条判据 + go/no-go 结果文档"
```

---

### Task 7: 分支收尾（不合并）

**Files:**

- Modify: `docs/superpowers/plans/2026-10-26-inknote-deco-preview-spike-results.md`（末尾「分支状态」一节）

- [ ] **Step 1: 确认主干未被污染**

Run: `git log --oneline main..HEAD | wc -l`
Expected: 等于本 spike 的提交数

Run: `git log --oneline HEAD..main | wc -l`
Expected: `0`（未落后）

Run: `git diff --stat main...HEAD -- src/markdown src/styles`
Expected: **零改动**——生产渲染链路与样式表没被 spike 碰过（`src/prefs.ts` / `lifecycle.ts` / `wire.ts` / `main.ts` 的改动必须在开关之后）

- [ ] **Step 2: 把结论一句话写进「分支状态」一节并提交**

```bash
git add docs/superpowers/plans/2026-10-26-inknote-deco-preview-spike-results.md
git commit -m "spike(b391): 结案 —— 分支保留本地，不合并、不出包"
```

- [ ] **Step 3: 切回 main 并报告**

Run: `git checkout main && git branch --show-current && git status --short`
Expected: `main`、工作树干净；spike 分支留在本地待用户处置（**不推送**）

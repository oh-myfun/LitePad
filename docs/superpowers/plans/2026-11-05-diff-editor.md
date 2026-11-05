# 文本差异编辑器 + 左侧差异面板（B461）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 LitePad 有一种「差异标签」——左右两栏同屏比较（A 档 = 当前文档 vs 它上一次保存的正文，B 档 = 任选两个文件），并把差异项按**块**列进左侧栏第五块视图，编辑器标题栏那排动作键照 VS Code 分组。

**Architecture:** 差异内核从 B458 的 `lineDiff` 里再开一个**块级**出口 `diffBlocks`，两者共用同一个对齐器（`src/diff/align.ts`），保证「4px 标注」与「差异编辑器」永远同一口径。承载形态照用户拍板的「独立标签类型」：`Tab.kind = "diff"`，**右栏就是那份文档本身**（`Panel.view` 不动，脏点/Ctrl+S/撤销全归它），左栏是挂在 `.panel-host` 里、`.panel-editor` 左侧的一颗只读 `EditorView`（旁路，不进 doc 记账）。侧栏那一块走既有的注册表外壳（`registerDrawerView`），条目点击与光标跟随复用大纲那套「显式落位 + 重绘装闸」的口径。

**Tech Stack:** TypeScript + CodeMirror 6（`@codemirror/view` / `@codemirror/state`）、Tauri 2 + Rust（新增一条只读命令）、Vitest（jsdom）、自绘 codicon 层、Python CDP 真机台。

**Spec:** [docs/superpowers/specs/2026-11-05-diff-editor-design.md](file:///E:/Project/LitePad/docs/superpowers/specs/2026-11-05-diff-editor-design.md) —— 逐任务执行时把设计稿一起读；计划只对「怎么落地」做决定，需求口径以设计稿为准。

## Global Constraints

以下为**每个任务都隐含遵守**的约束，取值逐字取自设计稿与仓库既有纪律：

- **在 `feat/b461-diff-editor` 上逐任务提交**（用户选定该分支时的原话口径是「分支让逐任务提交、最终评审与回滚都自成一块」⇒ 分支上的 commit 已获授权，逐任务评审包也依赖它）。**仍然禁止**：`git push`、打 tag、bump 版本号、改 `package.json`/`Cargo.toml`/`tauri.conf.json` 的版本字段、跑发布链（`scripts/release.sh`）—— 这些只在用户显式指示时做。`docs/zh_CN.md` 保持未跟踪、不入库。
- 每一笔提交都要过仓库自己的 pre-commit 钩子（prettier + eslint + `tsc -b` + `cargo fmt --check`）：提交前先 `npm run format:check` 与（动了 Rust 时）`cd src-tauri && cargo fmt --all --check`。**不许用 `--no-verify` 绕过钩子**。
- `docs/zh_CN.md` **不修改、不提交**。
- 源文件**只用 Edit/Write 工具改**，不许用 python/sed 原地 replace。
- 全量门禁：`npx vitest run --no-file-parallelism > .tmp/b461-test.log 2>&1`，读日志里的 `Test Files` / `Tests` 两行定性（**管道后的 exit code 不是被测程序的**）。
- 其余门禁：`npm run lint > .tmp/b461-lint.log 2>&1`、`npm run format:check`、`npx tsc --noEmit`。Rust 侧：`(cd src-tauri && cargo test --release) > .tmp/b461-cargo.log 2>&1`（读 `test result:` 行）。
- 差异内核的预算与延迟沿用 B458 那一批常数：`LCS_CELL_BUDGET = 250_000`、`ALIGN_PAIR_BUDGET = 20_000`、`DIFF_REFRESH_MS = 200`（现在在 `src/editor/gutterDiff.ts:51/135/235`，Task 2 把它们收进 `src/diff/align.ts` 一处定义）。
- **差异格两栏一律不折行**（预审 R19 补进约束；设计稿与计划原文都没写这一格，而它是 ⑥「两侧行行对齐」成立的前提）：`word_wrap` 出厂默认是**开**的（`src-tauri/src/session/mod.rs` 与 `src/main.ts`），两栏宽度又各自不同 ⇒ 同一行长文的视觉行数天然不等。挂 surface 时把右栏那颗 wrap 关掉、detach 时还原，左栏从一开始就不装 `lineWrapping`。于是「一行 = 一个视觉行」严格成立，占位块高度用 `count * view.defaultLineHeight` 才是对的（不做按对侧实测行的复杂方案 —— 用户 B398 定过「参考 vscode，不要弄这么复杂」）。代价：差异格里长行要横向滚，这是明写的取舍，不是遗漏。
- 底色与「当前行」高亮**不许打特异度战**：改动行底色走 `background-image`（叠在 `background-color` 上），不许靠压过 `.cm-activeLine` 的特异度来实现（预审 R21）。
- 颜色**只吃主题无关的三颗**：`--diff-add #72c892`、`--diff-mod #e5ba7d`、`--diff-del #e5534b`（`src/styles/global.css:4612-4614`）。**不许**再借 `--warn` / `--danger`（B458 续轮已定死这三颗与明暗档无关），**不许**新增第四颗 diff 色。
- **对外文案不许写「复刻 VS Code」**：设计稿 ⑤ 已定死「侧栏的块级差异列表」是 LitePad 自己的设计（VS Code 没有这一物），这一列与那一块只能叫「差异」；只有标题拼接、动作键分组这类**真照源码抄**的部分可以在代码注释里点名出处。
- 主 UI 文本 12px；提示只有两档 —— 按钮用 `setTip(el, text, { detail })`（带尖尖）、文本行用 `setTextTip(el, text, { group })`（不带），取值全在 `src/shell/tooltip.ts`。
- 图标**只用 codicon**（`src/shell/codicons.ts` 的 `CODICONS.<name>` 一层，菜单/按钮不留文字字形）。
- **源码串断言是本仓库的既定契约层**：`expect(srcOf("…")).toContain/not.toMatch(…)` 这一形（拿源码文本当结构判据）在册先例有 `tests/sync-scroll-sequence.test.ts`、`tests/gutter-diff-wiring.test.ts`、`tests/explorer-contract.test.ts`、`tests/toc-tree.test.ts` 等，专门钉「不许在别处再算一遍」「不许漏白名单」这类跨文件不变量。用它**替代**而不是叠加行为断言；改名/改文案会顶红这类判据是已知代价（见 pitfalls「文案改名的守卫陷阱」），判据要按形状写、不按文案写。
- 会话/持久化新字段**一律可空**，「没记过」不许读成任何一种状态（B392 纪律）。
- 本轮**只做并排（side-by-side）**，不做内联（单栏）视图；`Diff View` 子菜单不给。
- 差异标签**禁止**跨面板搬移与拖出新窗口（设计稿 ⑧·3）；那几条入口在这一轮必须显式缺席。
- `.tmp/` 已被 git 与 prettier 忽略，真机台脚本放这里。

## Review Focus

设计稿隐含、但单个任务的测试天然不会主动去验的输入/失败模式 —— 按「最可能伤到使用者」排序。每一行都点名负责它的任务，实现时把测试补进那一任务的自有步骤风格里。

1. **基线未知时不许打开 A 档差异**（`doc.baseline === null`：热退出副本还原、跨窗口认领那种「只知它脏、不知原样」）—— 菜单项置灰 + 说明；不置灰就会把每一行刷成绿色糊用户一脸。→ Task 5。
2. **旧会话缺 `kind` / `diffLeftPath` 键**必须当「普通编辑器标签」，不许把缺失读成 `"diff"`、也不许读成「关着的差异」。→ Task 10。
3. **拖差异标签跨面板 / 拖出新窗口 / 「在新窗口打开」/「移回主窗口」**：本轮未定义语义，这四条路径必须显式缺席（而不是带着一个指向已销毁 view 的 `panel.diffSurface` 漂移过去）。→ Task 10。
4. **在原标签里键入时，三处必须同刻跟上且同源**：面板条目数、差异编辑器两侧底色、4px 标注 —— 三者都必须是 `diffBlocks(doc.baseline, 右栏正文)` / `lineDiff` 的产物，不许任何一处另算一遍。→ Task 9（契约）+ Task 11（真机量）。
5. **两份 3MB 级内容同屏**：超 LCS 预算的退化路径必须仍给出「每块都有交代」的结果、且不许冻界面（200ms 停手才算一次）。→ Task 2（纯函数）+ Task 4（键入期跳块）。

---

## 文件结构

先固化分解决定；每个文件只负一件责任。

| 文件 | 责任 | 任务 |
|---|---|---|
| Create `src/diff/align.ts` | 唯一的行对齐器（前后缀修剪 + LCS 锚点 + 替换区 + 相似错位），`lineDiff` 与 `diffBlocks` 的共同上游 | 2 |
| Create `src/diff/blocks.ts` | 块级出口 `diffBlocks` + 面板要的 `blockAt` | 2 |
| Modify `src/editor/gutterDiff.ts` | 只换内部实现（改吃 `alignLines`），`lineDiff` 的签名与行为**一字不动** | 2 |
| Create `src/diff/face.ts` | CM6 侧装饰：两侧改动行底色 + 对侧空位占位块 + 中间指示带（纯消费 `DiffBlock[]`） | 3、7 |
| Create `src/diff/surface.ts` | 一张差异标签的运行时：左栏那颗只读 `EditorView`、分割线、跳块/步进/开关/折叠、生命周期与 dispose | 1、4、7 |
| Create `src/diff/model.ts` | `DiffSpec` / `DiffSide` / 标题拼接 / 能不能开 / 挂一张差异标签 / 块数变化的广播钩子（纯数据 + 编排） | 1、5 |
| Create `src/diff/compare.ts` | B 档「选择以进行比较」的窗口级选中态（同 path 再选 = 取消） | 6 |
| Create `src/diff/panel.ts` | 左侧栏第五块视图 `diff`：登记 + 挂按钮 + 条目列表 + 点击跳块 + 光标跟随后重绘装闸 + 空态 | 9 |
| Create `src/diff/diff.css` | 差异面样式：两侧底色、占位块、指示带、分割线、折叠占位条、侧栏条目行 | 1、3、7、9 |
| Modify `src/core/app-state.ts` | `Tab.kind` / `Tab.diff` / `Panel.diffSurface` 三个字段（可空） | 1 |
| Modify `src/doc-model.ts` | 新增 `makeDiffInstance`（差异实例**不传** `baseline` ⇒ 右栏不画 4px） | 5 |
| Modify `src/editor/editor.ts` | 无签名改动，只在 `EditorStateEnv.baseline` 注释里补「差异实例故意不传」 | 5 |
| Modify `src/tabs/lifecycle.ts` | `mountView` 挂/拆差异旁路、`rebuildLayout`/`disposePanel` 销毁 surface、`closeTabById` 拆那一格；`switchTab` 早退纪律**不动** | 1、10 |
| Modify `src/shell/splitview.ts` | `buildPanelOps` 差异档四颗图标键 + `SplitviewCallbacks.onDiffAction` | 8 |
| Modify `src/tabs/render.ts` | `panelDataOf` 补 `diff` 快照（并让 md 两颗键退场）、`groupMenuOf` 补差异那三条 | 8 |
| Modify `src/shell/tabstrip.ts` | 标签右键：A 档「与上次保存比较」+ B 档那一对；差异标签的窗口项缺席 + 不给 `draggable` | 5、6、10 |
| Modify `src/explorer/panel.ts` | 树右键补「选择以进行比较」/「与已选项目进行比较」 | 6 |
| Modify `src/shell/menubar.ts` | 「查看」菜单加「与上次保存比较」（LitePad 没有「文档」菜单，这一条是它的归宿） | 5 |
| Modify `src/shell/keymap.ts` | `COMMANDS` 新增「差异」那一组（含 `Alt+F5` / `Shift+Alt+F5` / `Ctrl+Shift+D`） | 4、5、8 |
| Modify `src/shell/codicons.ts` | 补 `whitespace` / `map` / `arrowSwap` / `fold` / `unfold` 五颗 | 8 |
| Modify `src/main.ts` | `runShortcut` 分发、`shortcutApplies` 上下文闸、光标高亮调用点 | 4、5、8、9 |
| Modify `src/ui.ts` | 三颗 DOM 引用（`#side-diff` / `#diff-panel` / `#diff-list`） | 9 |
| Modify `src/ipc/api.ts` | `DrawerViewName` 加 `"diff"`、`TabSession` 两个可空字段、`CompareText` + `readCompareText` | 6、9、10 |
| Modify `src/shell/drawer.ts` | `viewFromSetting` 白名单加 `"diff"` | 9 |
| Modify `index.html` | 按钮列第五颗 `#side-diff` + 展开区第五块 `aside#diff-panel` | 9 |
| Modify `src-tauri/src/commands/mod.rs` + `src-tauri/src/main.rs` | `read_compare_text`（**不**注册 doc、**不** watch、**不**记最近打开）与 handler 名单 | 6 |
| Modify `src-tauri/src/session/mod.rs` | `TabSession` 两个 `Option` 字段（**不许** `skip_serializing_if`） | 10 |
| Create `tests/diff-align.test.ts`、`tests/diff-blocks.test.ts`、`tests/diff-face.test.ts`、`tests/diff-model.test.ts`、`tests/diff-surface.test.ts`、`tests/diff-panel.test.ts`、`tests/diff-drawer-contract.test.ts`、`tests/diff-entry-contract.test.ts`、`tests/diff-session.test.ts` | 逐任务对应 | 各任务 |
| Create `.tmp/b461-check.py` | 真机台（CDP + 物理键，深浅各一遍），设计稿 ⑦ 那六段 | 11 |

---

### Task 1: 落点定死 —— `Tab.kind="diff"` 与挂在 `.panel-host` 里的只读左栏

设计稿 ⑧·1 说这一条是本轮最大的接线量与工期不确定性，必须先定死再动渲染。**定死的落点是：`Panel.view` 仍是右栏**（那份文档本身），差异标签只多一个挂在 `.panel-host` 内、`.panel-editor` 左侧的旁路 surface。这样 `switchTab` / `applyPanelMode` / `saveDocCore` / `freshTextOfDoc` / 会话快照 / 撤销栈那一大片按 `panel.view` 寻址的代码**一行都不用加分支** —— 风险从「几十处都要记得问 kind」降级成「一处挂、一处拆」。

**Files:**
- Create: `src/diff/model.ts`（本任务只建 `DiffSpec` / `DiffSide` / `canOpenAgainstBaseline` / `setDiffBlocksListener`）
- Create: `src/diff/surface.ts`（本任务只建 `createDiffSurface` / `disposeDiffSurface` / `diffSurfaceOf` 的骨架 + 左栏那颗 view）
- Create: `src/diff/diff.css`（本任务只建两栏并排 + 分割线那段）
- Modify: `src/core/app-state.ts:20-30`（`Panel` 加 `diffSurface`）、`:35-62`（`Tab` 加 `kind` / `diff`）
- Modify: `src/tabs/lifecycle.ts:241-259`（`mountView` 挂旁路）、`:103-134`（`rebuildLayout` 的销毁循环拆旁路）、`:612-637`（`disposePanel` 拆旁路）、`:446-453`（兜底面板字面量）
- Modify: `src/main.ts`（把 `diff.css` 加进样式 import 链，与 `preview.css` 同处）
- Test: `tests/diff-surface.test.ts`、`tests/diff-model.test.ts`

**Interfaces:**
- Consumes：`Panel` / `Tab` / `Doc`（`src/core/app-state.ts:20-119`）、`EditorHandle`（`src/editor/editor.ts:29-35`）。
- Produces：
  ```ts
  // src/diff/model.ts
  export type DiffTier = "baseline" | "files";
  export type DiffSide = "original" | "modified";
  export interface DiffSpec {
    tier: DiffTier;
    /** 右栏 = 这份文档的另一个实例（可编辑、脏归它） */
    docId: number;
    /** 左栏正文的读取口。A 档实时读 `doc.baseline`；B 档闭包持有一份只读对比缓冲 */
    leftText: () => string;
    leftName: string;
    rightName: string;
    /** B 档左栏的文件路径（「刷新」要重读盘）；A 档为 null */
    leftPath: string | null;
  }
  export function canOpenAgainstBaseline(doc: Doc | null): boolean;
  /** 块数变了要通知谁（侧栏面板注册；surface 不反向 import 面板模块，防成环） */
  export function setDiffBlocksListener(fn: ((spec: DiffSpec) => void) | null): void;
  export function notifyDiffBlocks(spec: DiffSpec): void;

  // src/diff/surface.ts
  export interface DiffSurface {
    /** 左栏那颗只读视图（测试与 Task 4/7 的落位都直接按它寻址） */
    readonly left: EditorView;
    /** 当前输入描述（可交换 ⇒ 是取值口，不是冻结字段） */
    spec(): DiffSpec;
    /** B 档「交换左右」就地换输入用（不换 tabId；Task 6 拥有调用者） */
    retarget(spec: DiffSpec): void;
    dispose(): void;
  }
  export function createDiffSurface(
    hostEl: HTMLElement, panel: Panel, spec: DiffSpec, opts?: { ignoreTrimWhitespace?: boolean }
  ): DiffSurface;
  export function disposeDiffSurface(panel: Panel): void;
  export function diffSurfaceOf(panel: Panel): DiffSurface | null;
  ```
  ⚠️ **两臂的装法（预审裁定 R1）**：左栏 state 在 Task 1 就建好了，而 `diffFace` 到 Task 3 才存在 —— 所以 Task 3 自己负责给**两颗** view 装装饰臂，走它自己创建的 `Compartment`（右栏那颗在 attach 时 `view.dispatch({ effects: comp.of(diffFace("modified", …)) })`），**不改** `makeTabState` / `makeDiffInstance` 的扩展清单。Task 1 不许预留任何 diff 专用 Compartment（那是空转的抽象）。
- `src/core/app-state.ts` 的三处新字段：`Panel.diffSurface: DiffSurface | null`、`Tab.kind: "editor" | "diff"`、`Tab.diff: DiffSpec | null`（`kind` 在建实例时给死，两个引用字段初值都是 `null`）。

- [ ] **Step 1: 写会失败的测试 —— 三个新字段的形状**

```ts
// tests/diff-surface.test.ts
it("B461 · 差异标签的三个新字段都在模型层就位（默认值都是普通编辑器）", () => {
  expect(srcOf("src/doc-model.ts")).toMatch(/kind:\s*"editor"/);        // makeInstance 仍是普通标签
  expect(srcOf("src/doc-model.ts")).toMatch(/diff:\s*null/);
  expect(srcOf("src/tabs/lifecycle.ts")).toMatch(/diffSurface:\s*null/); // 兜底面板字面量也带
});
```

Run: `npx vitest run tests/diff-surface.test.ts`
Expected: FAIL —— 三处正则都取不到（字段还不存在）。

- [ ] **Step 2: 落地三处字段**

`src/doc-model.ts:110-118` 的 `makeInstance` 返回值补 `kind: "editor", diff: null`；`src/core/app-state.ts` 的 `Panel` 补 `diffSurface: DiffSurface | null`、`Tab` 补 `kind` / `diff`（`DiffSurface` 走 `import type`，运行时不成环）；`src/tabs/lifecycle.ts:446-453` 那个兜底 `panels.set(0, {…})` 补 `diffSurface: null`。

其余漏点交给 `npx tsc --noEmit` 全列出来（会话重建、分屏复制、测试里的 `Tab`/`Panel` 替身）逐个补 —— **不许**用可选字段绕开编译器。

- [ ] **Step 3: 跑测试确认转绿**

Run: `npx vitest run tests/diff-surface.test.ts && npx tsc --noEmit > .tmp/b461-t1.log 2>&1`
Expected: 用例 PASS、tsc 无输出。

- [ ] **Step 4: 写会失败的测试 —— 挂旁路与拆旁路**

```ts
it("B461 · 差异标签挂载时 .panel-host 里多出对照栏与分割线，普通标签一根都不加", () => {
  mount(hostEl, panel, tabWithKind("diff"));
  expect(hostEl.querySelector(".diff-original")).toBeTruthy();
  expect(hostEl.querySelector(".diff-sash")).toBeTruthy();
  expect(hostEl.classList.contains("is-diff")).toBe(true);
  expect(panel.view).not.toBeNull();                 // ⚠️ 右栏仍是那颗既有的 view（本轮的地基）
  mount(hostEl, panel, tabWithKind("editor"));
  expect(hostEl.querySelector(".diff-original")).toBeNull();
});

it("B461 · 拆面板/换标签必须 dispose 左栏那颗 view，不留孤儿 DOM 也不留 surface", () => {
  mount(hostEl, panel, tabWithKind("diff"));
  disposeDiffSurface(panel);
  expect(diffSurfaceOf(panel)).toBeNull();
  expect(hostEl.querySelector(".diff-original")).toBeNull();
});

it("B461 · 左栏那颗 view 不注册进同步滚动协调器（两份内容不是同一文档的两个视口）", () => {
  expect(srcOf("src/diff/surface.ts")).not.toMatch(/reconcileSyncRegistrations|registerViewport/);
});
```

Run: `npx vitest run tests/diff-surface.test.ts`
Expected: FAIL —— `createDiffSurface is not defined`。

- [ ] **Step 5: 实现 `createDiffSurface(hostEl, panel, spec, opts)`**

做法：`hostEl.classList.add("is-diff")` → 建 `.diff-original`（`hostEl` 的第一个子节点，排在 `.panel-editor` 之前）+ `.diff-sash` → `new EditorView({ parent: originalEl, state: <左栏 state> })`，`<左栏 state>` = `EditorState.create({ doc: spec.leftText(), extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false), …gutter 行号] })` → `panel.diffSurface = { left, spec, … }`。

只读两手一起给：`EditorState.readOnly` 挡住程序化写，`EditorView.editable(false)` 让敲字进不去；B399 那条经验还记着 —— 只给 `editable(false)` 会让 `focus()` 空操作、选不出字，所以这一颗**不需要** `tabindex` 之外的绕法，但要允许鼠标选中复制（Task 6 的 ⑤ 判据量这件事）。

`disposeDiffSurface` 取回 surface → `left.destroy()` → 摘 DOM 与 `is-diff` 类 → `panel.diffSurface = null`。

- [ ] **Step 6: `src/tabs/lifecycle.ts` 三处接线**

`mountView`（`:241-259`）在 `applyPanelMode(p)` **之前**判 `tab?.kind === "diff" && tab.diff` 并挂旁路；`rebuildLayout` 的销毁循环（`:111-133`）在 `p.view.view.destroy()` 那发旁边补 `disposeDiffSurface(p)`；`disposePanel`（`:621-628`）同理。挂/拆都收敛进一个 `syncDiffSurface(panel)`：`panel.diffSurface` 与「当前活动标签该不该有 surface」不一致才动手（换标签不换面板那条路靠它，见 Task 5）。**不许**在 `switchTab` 里加 kind 分支 —— 它已经靠 `rebuildLayout` / `setState` 两条路走，分支加在那里等于把 B232/B355 那两条顺序纪律再搅一遍。

- [ ] **Step 7: `src/diff/diff.css` 并排骨架 + 可拖分割线**

```css
.panel-host.is-diff { display: flex; flex-direction: row; align-items: stretch; }
.panel-host.is-diff .panel-editor { flex: 1 1 50%; min-width: 0; }
.diff-original { flex: 1 1 50%; min-width: 0; overflow: hidden; }
.diff-sash { flex: 0 0 4px; cursor: col-resize; background: transparent; }
.diff-sash:hover { background: var(--accent); }
```
分割线拖拽：`pointerdown` 记下起始 x 与左栏基准宽，`pointermove` 按比例写 `.diff-original` 的 `flex-basis`（夹在 **15%–85%**），`pointerup` 收尾。不复用 splitview 的 sash（那一套管的是面板树，这一根只管一栏之内），也不落设置（本轮记住宽度不是需求）。

- [ ] **Step 8: 跑测试确认转绿 + 全量门禁**

Run: `npx vitest run tests/diff-surface.test.ts`，再 `npx vitest run --no-file-parallelism > .tmp/b461-t1-full.log 2>&1`
Expected: 新用例 PASS；日志里 `Test Files` 比本轮开始前多 1、`Tests` 全绿、`failed` 不出现。

---

### Task 2: 块级内核 —— 共用对齐器 `alignLines` 与 `diffBlocks`

设计稿 ⑥ 要求两个出口**同源**：4px 那列继续吃 per-line 标记，面板与差异面吃块级标记，但对齐只算一遍。做法是把 `gutterDiff.ts` 的私有零件抽成 `src/diff/align.ts`，`lineDiff` 换内部实现而**签名与行为一字不动** —— `tests/gutter-diff.test.ts` 那 19 条不动就是最硬的等价证明。

**Files:**
- Create: `src/diff/align.ts`、`src/diff/blocks.ts`
- Modify: `src/editor/gutterDiff.ts:68-232`（删掉本地私有零件，改 import）
- Test: `tests/diff-align.test.ts`、`tests/diff-blocks.test.ts`（`tests/gutter-diff.test.ts` **不许改**）

**Interfaces:**
- Consumes：无上游依赖（纯字符串进、纯数据出）。
- Produces：
  ```ts
  // src/diff/align.ts
  export interface AlignRegion { aStart: number; aLen: number; bStart: number; bLen: number; offset: number }
  export interface Aligned { head: number; tail: number; regions: AlignRegion[] }
  /** a = 基线行数组、b = 当前行数组（**原始**行，不是加工过的键）；
   *  ignoreTrimWhitespace 为真时，比较用的键在函数内部按 line.trim() 现取 —— 行号与长度仍按原始行 */
  export function alignLines(a: string[], b: string[], ignoreTrimWhitespace: boolean): Aligned;
  export function splitLines(text: string): string[];   // "" ⇒ 没有一行（B458 原口径）
  export const LCS_CELL_BUDGET = 250_000;
  export const ALIGN_PAIR_BUDGET = 20_000;
  /** 键入停下多久之后重算全量：唯一一份，gutter 与差异面共用（原先藏在 gutterDiff.ts:235） */
  export const DIFF_REFRESH_MS = 200;

  // src/diff/blocks.ts
  export type DiffKind = "insert" | "delete" | "modify";
  export interface DiffBlock {
    kind: DiffKind;
    originalStart: number; originalEnd: number;   // 1-based 含端点；start > end ⇒ 该侧为空段
    modifiedStart: number; modifiedEnd: number;
    added: number; removed: number;               // 由两段长度差推导（照 VS Code，不另存计数）
    offset: number;                               // 少的一侧贴到多的一侧的错位（视图据此放占位块）
  }
  export function diffBlocks(baseline: string, current: string,
                             opts?: { ignoreTrimWhitespace?: boolean }): DiffBlock[];
  /** 包住这一行的块序号；没有 ⇒ -1。空段那一侧用「块前缘」也算命中 */
  export function blockAt(blocks: DiffBlock[], side: DiffSide, line: number): number;
  ```

- [ ] **Step 1: 写会失败的测试 —— 对齐器抽出来且与旧实现逐区等价**

```ts
// tests/diff-align.test.ts
it("B461 · alignLines 给出的替换区与旧 lineDiff 用的那批一致（含相似错位 offset）", () => {
  const a = splitLines("甲\n乙\n丙\n丁");
  const b = splitLines("甲A\n乙\n丙\n丁B");
  expect(alignLines(a, b, false).regions).toEqual([
    { aStart: 0, aLen: 1, bStart: 0, bLen: 1, offset: 0 },
    { aStart: 3, aLen: 1, bStart: 3, bLen: 1, offset: 0 },
  ]);
});
it("B461 · 前后缀修剪的结果跟着进 Aligned（调用方据此换算绝对行号）", () => {
  expect(alignLines(splitLines("1\n2\n3\nX\n5"), splitLines("1\n2\n3\nY\n5"), false)).toMatchObject({
    head: 3, tail: 1,
  });
});
```

Run: `npx vitest run tests/diff-align.test.ts`
Expected: FAIL —— `alignLines is not defined`。

- [ ] **Step 2: 建 `src/diff/align.ts`**

从 `src/editor/gutterDiff.ts` 原样搬 `splitLines`（`:68-70`）、`lcsAnchors`（`:73-100`）、`alignRegions`（`:103-117`）、`similarity`（`:124-132`）、`alignOffset`（`:148-170`）、`DIFF_REFRESH_MS`（`:235`）与两颗预算常数；`gutterDiff.ts` 改成 import 这些，**不许**留下第二份 200（Task 4 的差异面 debounce 也吃这一颗）。新增 `alignLines`，把 `lineDiff` 里「head/tail 修剪 + 只对中段做对齐」那一截（`:182-194` 加 `:212` 的循环头）收成一个出口，并把每个 region 的 `offset` 就地算好（旧代码在循环体里现算 `alignOffset`，搬上来后同一份结果两处可用）。

`ignoreTrimWhitespace` 在这一层生效：为真时把比较键换成 `line.trim()`，`lcsAnchors` 的相等判定与 `similarity` 的入参都走键；**输出的行号/段长仍按原始行**。`alignOffset` 的 `span` 计算继续吃「本区行数」（B458 那轮抓到的坑就在这一格，注释原样搬过来）。

- [ ] **Step 3: `gutterDiff.ts` 的 `lineDiff` 改吃 `alignLines(a, b, false)`**

`head`/`tail`/`regions` 来自 `Aligned`；`put` / `seamAfter` 的输出逻辑与 `:196-231` 逐行对齐。**签名不变**、不接 `ignoreTrimWhitespace`（4px 那一列的口径不动 —— 差异编辑器的开关只影响差异编辑器）。

- [ ] **Step 4: 跑旧测试证明 B458 一字未动**

Run: `npx vitest run tests/gutter-diff.test.ts tests/diff-align.test.ts`
Expected: 19 + 2 全 PASS。这一步是整个重构的等价性闸门，红了就回头改 `align.ts`，**不许**改旧测试。

- [ ] **Step 5: 写会失败的测试 —— 块级出口的六种形**

```ts
// tests/diff-blocks.test.ts
it("B461 · 连续改动并成一块；两块之间隔着未改动行就分成两块", () => {
  const bs = diffBlocks("1\n2\n3\n4\n5\n6", "1\n2X\n3Y\n4\n5\n6Z");
  expect(bs.map((b) => b.kind)).toEqual(["modify", "modify"]);
  expect(bs[0]).toMatchObject({ originalStart: 2, originalEnd: 3, modifiedStart: 2, modifiedEnd: 3 });
});
it("B461 · 纯增 = insert（左段空）", () => {
  expect(diffBlocks("A\nZ", "A\n新1\n新2\nZ")[0]).toMatchObject({
    kind: "insert", originalStart: 2, originalEnd: 1, modifiedStart: 2, modifiedEnd: 3,
    added: 2, removed: 0,
  });
});
it("B461 · 纯删 = delete（右段空）", () => {
  expect(diffBlocks("A\n删1\n删2\nZ", "A\nZ")[0]).toMatchObject({
    kind: "delete", originalStart: 2, originalEnd: 3, modifiedStart: 2, modifiedEnd: 1,
    added: 0, removed: 2,
  });
});
it("B461 · 贴文首与贴文末都能出块；整篇删空仍有一块", () => {
  expect(diffBlocks("1\n2", "X\n1\n2")[0]).toMatchObject({ kind: "insert", modifiedStart: 1 });
  expect(diffBlocks("1\n2", "1\n2\nX")[0].modifiedEnd).toBe(3);
  expect(diffBlocks("1\n2\n3", "")).toHaveLength(1);
});
it("B461 · 全同返回空表；空对空也空表", () => {
  expect(diffBlocks("同一篇", "同一篇")).toEqual([]);
  expect(diffBlocks("", "")).toEqual([]);
});
it("Review Focus 1 的一半 · 首尾空白开关只影响比较，不影响行号", () => {
  expect(diffBlocks("甲  ", "甲", { ignoreTrimWhitespace: true })).toEqual([]);
  expect(diffBlocks("甲  ", "甲", { ignoreTrimWhitespace: false })).toHaveLength(1);
});
it("Review Focus 5 · 超 LCS 预算走退化路径，仍每块都有交代（不抛、不返回空）", () => {
  const big = (tag: string) => Array.from({ length: 600 }, (_, i) => `${tag}${i}`).join("\n");
  const blocks = diffBlocks(big("甲"), "第0行改了\n" + big("乙"));
  expect(blocks.length).toBeGreaterThan(0);
  expect(blocks[0]).toHaveProperty("offset");
});
```

Run: `npx vitest run tests/diff-blocks.test.ts`
Expected: FAIL —— `diffBlocks is not defined`。

- [ ] **Step 6: 实现 `diffBlocks(baseline, current, opts = {})`**

`splitLines` 两侧 → `alignLines(a, b, opts.ignoreTrimWhitespace ?? false)` → 每个 `AlignRegion` 出一个 `DiffBlock`：`kind` 按 `aLen`/`bLen` 定（`bLen === 0` = `delete`、`aLen === 0` = `insert`、其余 = `modify`），行号 = `head + start + 1`，段为空时 `start = end + 1`（照 VS Code 的空段表示法，Task 3 的占位块据此落位），`added`/`removed` 由两段长度差推导，`offset` 直接取 region 的。

**不做额外并块**：两个替换区之间只要隔着一行未改动内容就是两块（与 VS Code 的 `LineRangeMapping` 同形；设计稿「连续改动并成一块」说的就是「连续改动的行并成一个 region」）。这一条记为**我的决定**，写进代码注释与结果文档。

- [ ] **Step 7: 实现 `blockAt(blocks, side, line)` 并跑绿**

`side === "modified"` 按 `modifiedStart/End` 判包含，`"original"` 按 `originalStart/End`；**空段那一侧**要能把「块前缘那一行」（`line === start - 1`）算命中这一块 —— 面板光标停在删除块前面那行时得亮对的那条（Task 9 的跟随靠它，`blockAt` 返回 -1 就不许亮）。跑完补一发全量：`npx vitest run --no-file-parallelism > .tmp/b461-t2-full.log 2>&1`。

---

### Task 3: 两侧的行底色、中间指示带与对侧占位块

设计稿 ⑥：改动行画底色（复用三颗 token）、删除行在右栏用占位块、左栏用真行 —— 两侧必须行行对齐，否则跳块与肉眼比对都会错位。

**Files:**
- Create: `src/diff/face.ts`
- Modify: `src/diff/diff.css`（追加底色/占位块/指示带段）、`src/diff/surface.ts`（两颗 view 各装一臂 `diffFace`）
- Test: `tests/diff-face.test.ts`

**Interfaces:**
- Consumes：`DiffBlock` / `DiffKind` / `DiffSide`（Task 2）、`baseExtensions` / `gutterExtensions`（`src/editor/editor.ts`）。
- Produces：
  ```ts
  // src/diff/face.ts
  export function diffFace(side: DiffSide, blocks: () => DiffBlock[]): Extension;
  export const refreshDiff = StateEffect.define<null>();
  export interface SideMark { line: number; kind: DiffKind }
  export function sideLineMarks(blocks: DiffBlock[], side: DiffSide): SideMark[];
  /** 这一侧要补出的空位：落在第 afterLine 行之后、占 count 行 */
  export function sideGaps(blocks: DiffBlock[], side: DiffSide): Array<{ afterLine: number; count: number }>;
  ```

- [ ] **Step 1: 写会失败的测试 —— 两侧行标记与占位段（纯函数，先不看 DOM）**

```ts
// tests/diff-face.test.ts
const del = diffBlocks("A\n删1\n删2\nZ", "A\nZ");
it("B461 · 删除块：左栏标真行，右栏在 A 之后补 2 行空位", () => {
  expect(sideLineMarks(del, "original")).toEqual([
    { line: 2, kind: "delete" }, { line: 3, kind: "delete" },
  ]);
  expect(sideLineMarks(del, "modified")).toEqual([]);
  expect(sideGaps(del, "modified")).toEqual([{ afterLine: 1, count: 2 }]);
  expect(sideGaps(del, "original")).toEqual([]);
});
it("B461 · 新增块反过来：右栏标行、左栏补空位", () => {
  const ins = diffBlocks("A\nZ", "A\n新1\n新2\nZ");
  expect(sideLineMarks(ins, "modified").map((m) => m.line)).toEqual([2, 3]);
  expect(sideGaps(ins, "original")).toEqual([{ afterLine: 1, count: 2 }]);
});
it("B461 · 混合区（改 + 删）的占位段按 offset 落位：被删行在配对窗口之前 ⇒ 缝也在那之前", () => {
  // 基线 [丙一去, 丙一去, 丁后行] vs 当前 [丙一去, 丁后行改了]
  // head=1；中段无 LCS 锚点 ⇒ 一个区 (aLen 2, bLen 1)；alignOffset 挑 o=1（丁后行 ↔ 丁后行改了 最像）
  // ⇒ 配对窗口吃掉 a 的第 2 行，多出来的 a 行（绝对第 2 行）在窗口**之前**被删
  const mixed = diffBlocks("丙一去\n丙一去\n丁后行", "丙一去\n丁后行改了");
  expect(sideGaps(mixed, "modified")).toEqual([{ afterLine: 1, count: 1 }]);
  expect(sideLineMarks(mixed, "modified")).toEqual([{ line: 2, kind: "modify" }]);
});
```

Run: `npx vitest run tests/diff-face.test.ts`
Expected: FAIL —— `sideLineMarks is not defined`。

- [ ] **Step 2: 实现 `sideLineMarks` / `sideGaps`**

两者都只遍历 `DiffBlock[]`（**不重算 diff** ⇒ 同源）。`side === "modified"` 用 `modifiedStart/End`，`"original"` 用 `originalStart/End`；`modify` 两侧都标，`insert` 只标 modified 侧，`delete` 只标 original 侧。`sideGaps`：取「本侧段长比另一侧短」出来的那些行，按 `block.offset` 决定落在配对窗口之前还是之后，报出落在第 `afterLine` 行之后。

- [ ] **Step 3: 写会失败的测试 —— 装上 face 之后 DOM 里真有色带与占位块**

```ts
it("B461 · 改动行带底色类；对侧空位是块 widget 且高度按行数 × defaultLineHeight 撑出来", () => {
  const { view, gapEls, lineEl } = mountFace("modified", del);
  expect(lineEl(1).className).not.toContain("diff-line-del");   // 右栏第 1 行本身没改
  expect(gapEls()).toHaveLength(1);
  expect(gapEls()[0].getBoundingClientRect().height).toBeGreaterThan(0);
});
it("B461 · 差异面不许自己算对齐（同源判据：源码里不出现 DP 网格）", () => {
  expect(srcOf("src/diff/face.ts")).not.toMatch(/lcsAnchors|dp\[|Uint32Array/);
});
```

Run: `npx vitest run tests/diff-face.test.ts`
Expected: FAIL —— `diffFace is not defined`。

- [ ] **Step 4: 实现 `diffFace(side, blocks)`**

一个 `StateField<RangeSet<Decoration>>` + `ViewPlugin`：`create` 按 `blocks()` 现算一次；`update` 收到 `refreshDiff` 时重算；`tr.docChanged` 时只做 `value.map(tr.changes)`（**与 `gutterDiffField` 同一纪律**：键入期不重算，停手 200ms 由 surface 那头发 `refreshDiff`）。产出：改动行 `Decoration.line({ class: "diff-line-" + kind })`；`sideGaps` 的位置插 `Decoration.widget({ widget: new DiffGapWidget(count), block: true })`；每块起点再发一条 `Decoration.line({ class: "diff-edge-top" })` 给中间指示带定位。

`DiffGapWidget.toDOM(view)`：`<div class="diff-gap">`，`style.height = count * view.defaultLineHeight + "px"`，`ignoreEvent()` 返回 `true`（占位块不吃点击、不吃光标）。

- [ ] **Step 5: 样式段进 `src/diff/diff.css`**

底色是三颗 token 的低透明度版（`color-mix(in srgb, var(--diff-add) 18%, transparent)` 那一形）；中间指示带 4px 实色贴**靠中线那一侧**；`.diff-gap` 用 `repeating-linear-gradient(135deg, …)` 斜纹（本侧缺的是被删的行 ⇒ `--diff-del`，缺的是新增的行 ⇒ `--diff-add`）。**这一段不许出现任何裸十六进制**（判据：`tests/diff-face.test.ts` 里加一条「`diff.css` 的差异段色值只出现在 `color-mix` 的 token 引用里」），HC 主题靠既有 token 自动跟上。

- [ ] **Step 6: 跑绿 + 全量**

Run: `npx vitest run tests/diff-face.test.ts tests/gutter-diff.test.ts`
Expected: 全绿（B458 那 19 条继续当等价闸门）。

---

### Task 4: 跳块、`Alt+F5` / `Shift+Alt+F5` 步进与「落位绕开同步滚动」

设计稿 ⑥·面板 与 ⑩·3：跳块 = 两侧同时落位到各自那段的起始行，走既有**显式落位**那一类，不靠 scroll 猜，也不许把这一发广播给同文档的其它视口。

**Files:**
- Modify: `src/diff/surface.ts`（`syncBlocks` / `blocks` / `jumpTo` / `step` / `activeIndex` / debounce）
- Modify: `src/main.ts`（`runShortcut` 分发 + `shortcutApplies` 上下文闸）
- Modify: `src/shell/keymap.ts:244`（两条命令进表）
- Test: `tests/diff-surface.test.ts`（追加）、`tests/diff-entry-contract.test.ts`（新建）

**Interfaces:**
- Consumes：`DiffBlock`（Task 2）、`refreshDiff` / `diffFace`（Task 3）、`claimVisibleHere(panel)`（`src/sync-scroll/wire.ts:285`）、分发链（`src/main.ts:479-506`）、`setDiffBlocksListener` / `notifyDiffBlocks`（Task 1）。
- Produces：
  ```ts
  export interface DiffSurface {
    /** 现读左右两份正文 → diffBlocks → 给两颗 view 各发 refreshDiff */
    syncBlocks(): void;
    blocks(): DiffBlock[];
    /** 两侧同时落位；索引越界夹到首/末块；先 unfoldAround 目标（Task 7 补实现，此时为 no-op） */
    jumpTo(index: number): void;
    /** 以右栏光标行为起点找下一/上一块 */
    step(dir: 1 | -1): void;
    /** 右栏光标包住的那块；没有 ⇒ -1 */
    activeIndex(): number;
    ignoreTrimWhitespace(): boolean;
    setIgnoreTrimWhitespace(on: boolean): void;   // 翻转后立刻 syncBlocks()
  }
  // src/shell/keymap.ts 新增两条（本任务只加这两条，Task 8 补其余）
  // { id: "diff.nextChange", label: "下一个差异", group: "差异", keys: ["Alt+F5"] }
  // { id: "diff.prevChange", label: "上一个差异", group: "差异", keys: ["Shift+Alt+F5"] }
  ```

- [ ] **Step 1: 写会失败的测试 —— 跳块两侧都落位、且不走 `syncTo`**

```ts
// tests/diff-surface.test.ts
it("B461 · jumpTo(1) 把左右光标分别落在各自那块的起始行", () => {
  const s = createDiffSurface(hostEl, panel, specOf("1\n2\n3\n4\n5", "1\n2\n3A\n4\n5B"));
  s.syncBlocks();
  expect(s.blocks()).toHaveLength(2);
  s.jumpTo(1);
  const rightLine = panel.view!.view.state.doc.lineAt(panel.view!.view.state.selection.main.head).number;
  const leftLine = s.left.state.doc.lineAt(s.left.state.selection.main.head).number;
  expect(rightLine).toBe(5);   // modifiedStart
  expect(leftLine).toBe(5);    // originalStart
});
it("B461 · 跳块不许调 syncCoordinator.syncTo（同一文档的别的面板不该跟着跳）", () => {
  expect(srcOf("src/diff/surface.ts")).not.toMatch(/syncTo\s*\(/);
  expect(srcOf("src/diff/surface.ts")).toContain("claimVisibleHere(");
});
it("B461 · step(1) 往后找、末块之后夹住；step(-1) 往回", () => {
  const s = mountedSurfaceWithThreeBlocks();
  s.jumpTo(0); expect(s.activeIndex()).toBe(0);
  s.step(1);   expect(s.activeIndex()).toBe(1);
  s.step(1); s.step(1); s.step(1); expect(s.activeIndex()).toBe(2);
  s.step(-1);  expect(s.activeIndex()).toBe(1);
});
```

Run: `npx vitest run tests/diff-surface.test.ts`
Expected: FAIL —— `s.syncBlocks is not a function`。

- [ ] **Step 2: 实现 `syncBlocks` / `jumpTo` / `step` / `activeIndex`**

`syncBlocks()`：`const bs = diffBlocks(spec.leftText(), panel.view!.view.state.doc.toString(), { ignoreTrimWhitespace })` 存进 surface → 两颗 view 各发 `refreshDiff.of(null)` → 右栏 `tab.state = view.state` 回写 → `notifyDiffBlocks(spec)`（Task 9 的面板从这里领新块表；surface **不 import** 面板模块）。

`jumpTo(i)`：夹索引 → 目标块在左栏的落点 `block.originalStart > block.originalEnd ? lineStart(left, originalEnd + 1) : lineStart(left, originalStart)`（空段落「块前缘那行的行首」），右栏同理用 `modifiedStart/modifiedEnd` → 各发 `{ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: "start" }) }` → 右栏那一发之后 `tab.state = view.state` **并** `claimVisibleHere(panel)` 认领这下发起的滚动（照 `src/io/files.ts:136` 的先例）。**全程不碰 `syncTo`**。

`activeIndex()` = `blockAt(blocks(), "modified", 右栏光标行)` —— 左栏光标**不参与**（设计稿 ⑩·2：权威侧是右栏）。

- [ ] **Step 3: 写会失败的测试 —— 键入期只映射不重算**

```ts
it("B461 · 连打 20 发只在停手后算一次（同 B458 那条口径）", async () => {
  const s = mountedSurfaceWithThreeBlocks();
  const calls = countSyncBlocks(s);
  for (let i = 0; i < 20; i++) typeChar(panel.view!.view, "x");
  expect(calls()).toBe(0);
  await advance(200);
  expect(calls()).toBe(1);
});
```

Run: `npx vitest run tests/diff-surface.test.ts`
Expected: FAIL —— 打到第 20 发之前 `calls()` 已经 > 0（还没装 debounce）。

- [ ] **Step 4: 装 `DIFF_REFRESH_MS = 200` 的 debounce**

`createDiffSurface` 里给右栏挂 `updateListener`：`update.docChanged` 就重置定时器，到点才 `syncBlocks()`；`dispose()` 里 `clearTimeout`。测试用 `vi.useFakeTimers()` + `advance`（`calls` 的计数由测试自己包一层，别在生产代码里留计数器）。

- [ ] **Step 5: 键位注册 + 上下文闸 + 分发**

`src/shell/keymap.ts:244` 那张表加两条（**键位字面量只许出现在这张表里** —— B389 立下的纪律）。`src/main.ts:513` 的 `shortcutApplies` 加：

```ts
case "diff.nextChange":
case "diff.prevChange":
  return diffTabActive();   // 不成时不抢键，把 Alt+F5 还给系统
```

`runShortcut` 里 `diffSurfaceOf(activePanel())?.step(±1)`。

- [ ] **Step 6: 跑绿 + 键位自检**

Run: `npx vitest run tests/diff-surface.test.ts tests/diff-entry-contract.test.ts tests/keymap.test.ts`
Expected: 全绿，且 `duplicateKeys({})` 仍为空数组、`effectiveKeys("diff.nextChange", {})` 是 `["Alt+F5"]`、`effectiveKeys("diff.prevChange", {})` 是 `["Shift+Alt+F5"]`（`Alt+F5` / `Shift+Alt+F5` 在本应用无人占 —— 用断言证，别只靠眼看表）。

---

### Task 5: A 档 —— 与上次保存比较（新开一张、基线实时、存盘即清空）

**Files:**
- Modify: `src/diff/model.ts`（`diffTitleOf` / `openBaselineDiff` / `attachDiffTab`）、`src/diff/surface.ts`（把 `syncDiffSurface` 接全：换标签不换面板那条路也挂/拆）、`src/doc-model.ts:96-119`（新增 `makeDiffInstance`）、`src/editor/editor.ts:126-131`（注释）、`src/shell/keymap.ts`（`diff.openAgainstSaved`）、`src/shell/menubar.ts:204`（「查看」菜单一条）、`src/shell/tabstrip.ts:342`（标签右键一条）、`src/main.ts`（分发 + 上下文闸）、`src/tabs/render.ts:141-167`（`panelDataOf` 让 md 两颗键对差异档退场）
- Test: `tests/diff-model.test.ts`（追加）、`tests/diff-entry-contract.test.ts`（追加）

**Interfaces:**
- Consumes：`Doc.baseline` / `docs` / `attachTabToPanel` / `markClean` / `isDirtyVsBaseline`（`src/doc-model.ts:96-175`）、`gutterDiff(baseline?)`（`src/editor/gutterDiff.ts:373`）、`hasGutterDiff` / `gutterDiffBaseline`（`:303`/`:308`）、`rebuildLayout` / `refreshAll` / `renderPanelTabs`。
- Produces：
  ```ts
  export function diffTitleOf(spec: DiffSpec, sameName: boolean): string;  // "a.md ↔ b.md"；同名 → "上次保存的 a.md ↔ a.md"
  export async function openBaselineDiff(docId: number): Promise<number | null>;   // 返回新 tabId
  export function attachDiffTab(doc: Doc, spec: DiffSpec, panelId: number): Tab;
  // src/doc-model.ts
  export function makeDiffInstance(doc: Doc, panelId: number, text: string, spec: DiffSpec): Tab;
  // src/shell/keymap.ts
  // { id: "diff.openAgainstSaved", label: "与上次保存比较", group: "差异", keys: ["Ctrl+Shift+D"] }
  ```

- [ ] **Step 1: 写会失败的测试 —— 标题拼接（含两侧同名的补描述）**

```ts
// tests/diff-model.test.ts
it("B461 · 标题是「旧 ↔ 新」；两侧同名时左栏补描述（照 VS Code 的 ForceDescription）", () => {
  const files: DiffSpec = { tier: "files", docId: 1, leftText: () => "", leftName: "a.md", rightName: "b.md", leftPath: "D:/a.md" };
  expect(diffTitleOf(files, false)).toBe("a.md ↔ b.md");
  const same: DiffSpec = { ...files, tier: "baseline", leftName: "a.md", rightName: "a.md", leftPath: null };
  expect(diffTitleOf(same, true)).toBe("上次保存的 a.md ↔ a.md");
});
```

Run: `npx vitest run tests/diff-model.test.ts`
Expected: FAIL —— `diffTitleOf is not defined`。

- [ ] **Step 2: 写会失败的测试 —— 差异实例不画 4px（两张标签各管各的脸）**

```ts
it("B461 · 差异标签那一份实例拿不到基线读取口 ⇒ 那列空着但仍占 4px", () => {
  const made = makeDiffInstance(doc, panelId, "甲\n乙改\n丙", spec);
  expect(hasGutterDiff(made.state)).toBe(true);              // 列还在（正文不因存盘左右跳）
  expect(gutterDiffBaseline(made.state)).toBeNull();         // 没处问基线 ⇒ 整片不画
  expect(made.kind).toBe("diff");
  expect(made.diff).toBe(spec);
});
```

Run: `npx vitest run tests/diff-model.test.ts`
Expected: FAIL —— `makeDiffInstance is not defined`。

- [ ] **Step 3: 实现 `makeDiffInstance`**

`makeInstance`（`src/doc-model.ts:97-119`）的孪生：同样 `makeTabState(text, lang.extension, env, instanceOnUpdate)`，但 env 里 **不传 `baseline`** —— `gutterDiff()` 拿不到读取口时「整列空着但仍占那 4px」是 `src/editor/gutterDiff.ts:370-372` 已经写明的既定行为，所以不必动 `gutterDiff.ts` 一行。返回值带 `kind: "diff"`、`diff: spec`、`viewMode: "source"`。

注释要交代两件事：**差异视图恒源码档**（设计稿 ⑥ —— 折叠标记会把「到底改了哪个字符」藏起来）；**4px 那一列只在原标签画**（差异编辑器本身就是那一格的展开）。`src/editor/editor.ts:126-131` 的 `EditorStateEnv.baseline` 注释补一句「差异实例故意不传」。

- [ ] **Step 4: 实现 `attachDiffTab` / `openBaselineDiff`**

`attachDiffTab`：`makeDiffInstance` → `attachTabToPanel` → `rebuildLayout()` → `refreshAll()` → `renderPanelTabs(panelId)` → 返回该 tab。

`openBaselineDiff(docId)` **第一行就是 Review Focus 1 那道闸**：

```ts
const doc = docs.get(docId) ?? null;
if (!canOpenAgainstBaseline(doc)) {           // canOpenAgainstBaseline = !!doc && doc.baseline !== null
  showMessage("这份文档还没有可比对的已保存版本", true);
  return null;
}
```

`spec`：`tier: "baseline"`、`docId`、`leftText: () => docs.get(docId)?.baseline ?? ""`（**读取口，不是快照** ⇒ 与 B458 同一口径，Ctrl+S 之后不必有人记得派发）、`leftName: doc.name`、`rightName: doc.name`、`leftPath: null`。标题里的「上次保存」按设计稿 ⑥·A 档的措辞；新标签开到活动面板（用户拍板 ④·6：**新开一张**，原标签继续开着）。

- [ ] **Step 5: `syncDiffSurface(panel)` 接全 + md 两颗键退场**

`src/diff/surface.ts` 里把 Task 1 那个「不一致才动手」的判据补全：`panel.view` 存在、活动标签 `kind === "diff"` 且带 `diff` ⇒ 该有；否则该无。`switchTab` / `closeTabById` 激活相邻标签 / `rebuildLayout` 三条同形路径都已经在 `applyPanelMode` 前后收敛到一处，所以在 `applyPanelMode(panel)`（`src/markdown.ts:146`）的末尾点一次名最稳（**渲染回调跑在 append 之前**那条老坑：只在 DOM 已就位时动手）。

`src/tabs/render.ts:145` 的 `const md = !!act && isMdTab(act)` 改成 `… && act.kind !== "diff"` —— 差异档不给 md 那两颗键。

- [ ] **Step 6: 入口三条 + 上下文闸**

`keymap.ts` 加 `diff.openAgainstSaved`（`Ctrl+Shift+D`，先确认这张表里没人占：`duplicateKeys({})` 空）。`tabstrip.ts:342` 那串数组里在「复制标签」之前 `push` 一条 `{ label: 基线未知 ? "与上次保存比较（基线未知）" : "与上次保存比较", disabled: !canOpenAgainstBaseline(doc), onSelect: … }` —— 置灰时**文案自己说明为什么点不动**（`MenuItem` 没有 tooltip 字段；设计稿 ⑩·3 要的「给个说明」用这一形落地）。`menubar.ts` 的「查看」菜单在 `资源管理器` 那条之后加分隔线 + 一条，文案走 `withKey("与上次保存比较", cb.keyHint("diff.openAgainstSaved"))`（LitePad 没有「文档」菜单，这是设计稿那一格的归宿）。`main.ts` 的 `shortcutApplies` 加 `case "diff.openAgainstSaved": return activeDocHasBaseline();`，`runShortcut` 调 `openBaselineDiff(activeTab()!.docId)`。

- [ ] **Step 7: 写会失败的测试 —— Ctrl+S 自己清空 + 两张标签脏点同源 + 闸**

```ts
// tests/diff-entry-contract.test.ts
it("B461 · 存盘后 diffBlocks 收到的是新基线 ⇒ 块数归零（不靠任何一处手动派发）", () => {
  const doc = makeDocWithBaseline("甲\n乙\n丙", "甲\n乙改\n丙");
  const spec = baselineSpecOf(doc);
  expect(diffBlocks(spec.leftText(), "甲\n乙改\n丙")).toHaveLength(1);
  markClean(doc, "甲\n乙改\n丙");                       // 保存成功那一步
  expect(diffBlocks(spec.leftText(), "甲\n乙改\n丙")).toEqual([]);
});
it("B461 · A 档两张标签的脏点同源：都读同一个 docId 的 doc.dirty（不存在哪张才代表未保存）", () => {
  const tab = attachDiffTab(doc, baselineSpecOf(doc), panelId);
  expect(tab.docId).toBe(doc.tabId);
  expect(tabViewDataOf(panel).filter((t) => t.tabId !== doc.tabId).every((t) => t.dirty === doc.dirty)).toBe(true);
});
it("Review Focus 1 · 基线未知 ⇒ canOpenAgainstBaseline 为假", () => {
  expect(canOpenAgainstBaseline({ baseline: null } as Doc)).toBe(false);
  expect(canOpenAgainstBaseline(null)).toBe(false);
});
```

- [ ] **Step 8: 跑绿 + 全量**

Run: `npx vitest run --no-file-parallelism > .tmp/b461-t5-full.log 2>&1`（读 `Test Files` / `Tests`）；`npm run lint > .tmp/b461-t5-lint.log 2>&1`。

---

### Task 6: B 档 —— 只读对比缓冲（Rust 新命令 + 窗口级比较选择）

设计稿 ⑩·1 定死：B 档左栏**不是**一份正常的 doc —— 不注册文件监听、不进跨窗口在场广播、不进最近打开、不弹「外部已修改」。所以必须有一条「只读盘、不记账」的路。

**Files:**
- Create: `src/diff/compare.ts`
- Modify: `src-tauri/src/commands/mod.rs`（新命令 + 它自己的 `#[cfg(test)]` 源码形状测试）、`src-tauri/src/main.rs:318`（handler 名单）、`src/ipc/api.ts`（`CompareText` + `readCompareText`）、`src/diff/model.ts`（`openFileDiff` / `swapDiffInputs`）、`src/explorer/panel.ts:1135`（`menuFor` 两条）、`src/shell/tabstrip.ts:342`（标签右键两条）
- Test: `tests/diff-model.test.ts`（追加）、`tests/diff-entry-contract.test.ts`（追加）

**Interfaces:**
- Consumes：Rust 既有零件 `doc::size_class` / `doc::is_probably_binary` / `codec::detect` / `codec::decode` / `eol::analyze` / `eol::to_lf` / `normalize_path`（`open_file`，`src-tauri/src/commands/mod.rs:477-503` 里已在用）；`attachDiffTab` / `makeDiffInstance`（Task 5）；`doOpen` 的复用与实例语义（`src/io/files.ts:143-233`）；`docs` 按 path 寻址。
- Produces：
  ```rust
  // src-tauri/src/commands/mod.rs（serde 属性照同一个文件里的 OpenedFile ⇒ TS 侧 camelCase）
  pub struct CompareText { path: String, name: String, text: String, encoding: String, size_class: String }
  #[tauri::command] pub async fn read_compare_text(path: String) -> Result<CompareText, String>;
  ```
  ```ts
  // src/ipc/api.ts
  export interface CompareText { path: string; name: string; text: string; encoding: string; sizeClass: string }
  export function readCompareText(path: string): Promise<CompareText>;

  // src/diff/compare.ts —— 「选择以进行比较」的窗口级状态
  export function compareSelection(): string | null;
  export function toggleCompareSelection(path: string): void;   // 同 path 再选 = 取消选择
  export function clearCompareSelection(): void;                // 开成差异标签之后

  // src/diff/model.ts
  export async function openFileDiff(leftPath: string, rightPath: string): Promise<number | null>;
  export function swapDiffInputs(spec: DiffSpec): DiffSpec;     // 仅 B 档；就地交换，不换 tabId
  ```

- [ ] **Step 1: 写会失败的 Rust 测试 —— 新命令里不许出现记账动作**

`src-tauri/src/commands/mod.rs` 底部那个 `#[cfg(test)]` 已经有「读自己的源码再断言形状」的先例（`:962`、`:1002`）。照它加一条：

```rust
#[test]
fn read_compare_text_不注册文档也不装监听() {
    let src = std::fs::read_to_string("src/commands/mod.rs").expect("读不到源码");
    let body = command_body(&src, "read_compare_text");
    assert!(body.contains("codec::decode"), "要复用同一套解码");
    for banned in ["watch_file", "state.docs", "note_opened", "alloc_id"] {
        assert!(!body.contains(banned), "只读对比缓冲不许 {banned}");
    }
}
```

（`command_body` 若现文件里没有，就在同一个 `mod tests` 里补一个按函数名切体的小助手 —— 两条现成测试已经各切过一次，不必自创第二套切法。）

Run: `(cd src-tauri && cargo test --release read_compare_text) > .tmp/b461-t6-cargo.log 2>&1`
Expected: `test result: FAILED`（`command_body` 取不到那段 ⇒ `assert!` 失败）。**读日志原文**确认是这一条，再继续。

- [ ] **Step 2: 实现 Rust 命令**

把 `open_file` 里「定档 → `fs::read` → 二进制拒绝 → 编码决策 → `decode` → `eol::analyze` → `to_lf`」那一串照搬（`src-tauri/src/commands/mod.rs:477-503`），返回 `CompareText`。**签名里不取 `State<'_, AppState>`** —— 拿不到 state 就从结构上不可能注册文档；`watch_file` / `note_opened` 一个都不调。超限文案沿用 `doc::size_class` 那一句（「文件过大（x MB）…」），别另编一套。`src-tauri/src/main.rs:318` 的 `generate_handler![…]` 名单补 `commands::read_compare_text`。

- [ ] **Step 3: 复跑 cargo 确认转绿**

Run: `(cd src-tauri && cargo check --release && cargo test --release) > .tmp/b461-t6-cargo2.log 2>&1`
Expected: `test result: ok.`，`failed` 为 0。

- [ ] **Step 4: 写会失败的测试 —— 比较选择的状态机 + 菜单那一对**

```ts
// tests/diff-model.test.ts
it("B461 · 选一条 → 选中；再选同一条 → 取消；选另一条 → 换过去", () => {
  toggleCompareSelection("a.md"); expect(compareSelection()).toBe("a.md");
  toggleCompareSelection("a.md"); expect(compareSelection()).toBeNull();
  toggleCompareSelection("a.md"); toggleCompareSelection("b.md");
  expect(compareSelection()).toBe("b.md");
});
it("B461 · 右键菜单按当前选中态给那两条（VS Code 的一对）", () => {
  clearCompareSelection();
  expect(labels(explorerMenu("b.md"))).toContain("选择以进行比较");
  toggleCompareSelection("a.md");
  const m = explorerMenu("b.md");
  expect(labels(m)).toContain("与 a.md 比较");
  expect(labels(m)).not.toContain("选择以进行比较");   // 已选中时不给自己留两条入口
  expect(labels(explorerMenu("a.md"))).not.toContain("与 a.md 比较");  // 同一行不给自己当对照物
});
```

Run: `npx vitest run tests/diff-model.test.ts`
Expected: FAIL —— `toggleCompareSelection is not defined`。

- [ ] **Step 5: 实现 `compare.ts` + 两条菜单**

`compare.ts` 就一个模块级 `let selected: string | null`。`src/explorer/panel.ts:1135 menuFor` 在「复制路径」之前用现成的 `push(...)` 助手加那两条（分组分隔线它自己收）；`src/shell/tabstrip.ts:342` 那串数组同位置补两条，回调走 `TabstripCallbacks` 新增的 `onSelectToCompare?` / `onCompareWith?`（卫星窗口按现有那形整组缺席）。两条的 `onSelect` 都是 `void openFileDiff(selected!, path)` 之后 `clearCompareSelection()`。

- [ ] **Step 6: 写会失败的测试 —— `openFileDiff` 的三条边界**

```ts
it("B461 · 右路径已经开着就复用它的 doc，不再读一遍盘", async () => {
  const id = await openFileDiff("D:/a.md", "D:/b.md");   // b.md 已在册
  expect(readCompareText).toHaveBeenCalledTimes(1);      // 只读了左栏那一份
  expect(tabs.get(id)!.docId).toBe(existingDocIdOf("D:/b.md"));
});
it("B461 · 两个路径相同 ⇒ 不开（返回 null 并说明）", async () => {
  expect(await openFileDiff("D:/a.md", "D:/a.md")).toBeNull();
});
it("B461 · 左栏那颗视图真的写不进去，但选得了字", () => {
  const s = mountedBFilesSurface();
  expect(s.left.state.facet(EditorState.readOnly)).toBe(true);
  expect(s.left.contentDOM.contentEditable).not.toBe("true");
});
```

- [ ] **Step 7: 实现 `openFileDiff` / `swapDiffInputs`**

`openFileDiff`：先归一化两个路径再判同（`===` 拿归一化后的串比，别拿用户点进来的原样）→ 相同则 `showMessage("两个文件相同，不必比较", true)` 返回 `null`。右：`docs` 里按 path 找到的那份 doc 直接用，找不到走 `doOpen(rightPath)`；左：`readCompareText(leftPath)` 的 `text` 闭包进 `spec.leftText`（一个 `let holder = text` + `refresh()` 重读一次盘并 `syncBlocks()` —— 「刷新」那颗键在 Task 8 接）。`spec`：`tier: "files"`、`leftPath` 填上、`leftName` / `rightName` 取各自文件名。最后 `attachDiffTab(右 doc, spec, activePanelId)`。

`swapDiffInputs(spec)`：只对 `tier === "files"` 有意义（A 档交换 = 把「还没存盘的改动」变成对照物，会破坏「右栏就是那份文档本身」这条反目标）。实现成「拿 `leftPath` 那份 doc 当新右栏、拿原右栏 path 去 `readCompareText` 当新左栏，**就地换 `tab.diff` 与 surface 的 spec**，`tabId` 不变」。Task 8 的「交换左右」那颗在 A 档置灰、在 B 档调它。

- [ ] **Step 8: 跑绿 + 全量**

Run: `npx vitest run --no-file-parallelism > .tmp/b461-t6-full.log 2>&1`；`npm run lint > .tmp/b461-t6-lint.log 2>&1`。

---

### Task 7: 折叠未改动区（默认不折 + 三颗动作）

设计稿 ⑤：VS Code 是**三颗**（`toggleCollapseUnchangedRegions` 用 `Codicon.map`、`collapseAll` 用 fold、`showAll` 用 unfold），默认关（`hideUnchangedRegions.enabled false`）；上下文常量 `contextLineCount 3` / `minimumLineCount 3` / `revealLineCount 20`。

**Files:**
- Modify: `src/diff/surface.ts`（开关状态 + 折叠集合 + `unfoldAround`）、`src/diff/face.ts`（折起来的区间发线装饰 + 占位条 widget）、`src/diff/diff.css`（占位条）
- Test: `tests/diff-face.test.ts`（追加）

**Interfaces:**
- Consumes：`DiffBlock[]`（相邻两块之间那一段就是未改动区）、`refreshDiff`（Task 3）、`jumpTo`（Task 4）。
- Produces：
  ```ts
  export interface DiffSurface {
    collapseUnchanged(): boolean;
    setCollapseUnchanged(on: boolean): void;
    collapseAllUnchanged(): void;
    showAllUnchanged(): void;
    /** 当前真的折起来的行区间（右栏行轴） */
    foldRanges(): Array<{ from: number; to: number }>;
    /** 落位/揭示前先把包住（或紧邻）这一行的折区展开 */
    unfoldAround(line: number): void;
  }
  // src/diff/face.ts 追加
  export const setFoldedRanges = StateEffect.define<Array<{ from: number; to: number }>>();
  export const DIFF_CONTEXT_LINES = 3;
  export const DIFF_MIN_UNCHANGED_LINES = 3;
  export const DIFF_REVEAL_LINES = 20;   // 点折条展开时，上下各揭示这么多行
  ```

- [ ] **Step 1: 写会失败的测试 —— 候选区间与默认不折**

```ts
// tests/diff-face.test.ts
it("B461 · 未改动区够长才成为折叠候选；开关默认关 ⇒ 折起来 0 段", () => {
  const s = mountedSurfaceWithThreeBlocks();
  expect(s.collapseUnchanged()).toBe(false);
  expect(s.foldRanges()).toEqual([]);
  s.setCollapseUnchanged(true);
  expect(s.foldRanges()).toHaveLength(2);        // 三块之间那两段长的未改动区
  s.showAllUnchanged();      expect(s.foldRanges()).toEqual([]);
  s.collapseAllUnchanged();  expect(s.foldRanges()).toHaveLength(2);
});
it("B461 · 太短的未改动区不折（<= 3 行 ⇒ 折了反而更难读）", () => {
  const s = mountedSurface(shortGapsA, shortGapsB);
  s.collapseAllUnchanged();
  expect(s.foldRanges()).toEqual([]);
});
it("B461 · 跳块前先展开目标所在的折区 ⇒ 落点不会落进被折起来的行里", () => {
  const s = mountedSurfaceWithThreeBlocks();
  s.setCollapseUnchanged(true);
  s.jumpTo(1);
  const landed = s.left.state.doc.lineAt(s.left.state.selection.main.head).number;
  expect(s.foldRanges().some((r) => r.from <= landed && landed <= r.to)).toBe(false);
});
it("B461 · 点折条 = 就地展开，并按 DIFF_REVEAL_LINES 上下各揭示 20 行", () => {
  const s = mountedSurfaceWithThreeBlocks();
  s.collapseAllUnchanged();
  const before = s.foldRanges().length;
  clickFoldBar(s, 0);
  expect(s.foldRanges().length).toBe(before - 1);
  expect(revealedLines(s)).toBeLessThanOrEqual(DIFF_REVEAL_LINES * 2);
});
```

Run: `npx vitest run tests/diff-face.test.ts`
Expected: FAIL —— `s.setCollapseUnchanged is not a function`。

- [ ] **Step 2: 实现候选与开关**

`foldCandidates(blocks, totalLines)`：相邻块之间（以及首块之前、末块之后）那段未改动行，长度 **> `DIFF_MIN_UNCHANGED_LINES + 2 * DIFF_CONTEXT_LINES`** 才折，折掉中间、上下各留 `DIFF_CONTEXT_LINES` 行。`setCollapseUnchanged(true)` 把候选落到 `setFoldedRanges`；`collapseAllUnchanged` 落全部候选；`showAllUnchanged` 清空。**开关是 surface 上的状态，不进 settings**（本轮不做用户默认；设计稿 ⑨ 把视觉留给实现）。两侧的行轴不同 ⇒ 折叠区间按 `side` 各换算一份，别只算右栏。

- [ ] **Step 3: 折起来的画法与 `unfoldAround`**

`face.ts` 收到 `setFoldedRanges` 后：区间内每一行发 `Decoration.line({ class: "diff-folded" })`（`display: none`），区间起点发一条块级 widget `.diff-fold-bar`（文案 `展开 N 行未改动的内容`，点击 = 展开这一段 + 按 `DIFF_REVEAL_LINES` 上下各揭示这么多行后 `scrollIntoView`）。`unfoldAround(line)`：凡 `from <= line <= to + DIFF_REVEAL_LINES` 的区间都摘掉，然后重发 `setFoldedRanges`。

**⚠️ 已知风险（设计稿 ⑧ 预留的正是这里）**：CM6 里 `display:none` 的行仍在文档里，光标可能被移进去 —— 所以 `jumpTo`（Task 4 Step 2）里那一发 `unfoldAround` 是**必须**的，且 surface 要在右栏 `updateListener` 里检查「selection 落进折区 ⇒ 展开那段」。真机台 ③ 会量这一条。**若**它造成落位错乱，退法是「不 `display:none`，只画折条并把该区滚出视野」—— 退法必须在结果文档 ⑥ 已知限制里点名，不许悄悄改完不说。

- [ ] **Step 4: 跑绿 + 全量**

Run: `npx vitest run tests/diff-face.test.ts tests/gutter-diff.test.ts`，再 `npx vitest run --no-file-parallelism > .tmp/b461-t7-full.log 2>&1`。

---

### Task 8: 编辑器标题栏动作键（图标四颗 + 「⋯」里三条）

分组照 VS Code 事实表（设计稿 ⑤）：上一个/下一个是 `arrowUp`/`arrowDown`（**不是**左右箭头），忽略首尾空白是**带 toggled 状态**的一颗 `whitespace`，折叠未改动区是 `map`；`swapSides`（`arrowSwap`）、fold/unfold、刷新进「⋯」。**不给 `Diff View` 子菜单**（④·7）。

**Files:**
- Modify: `src/shell/codicons.ts:35-223`（补五颗）、`src/shell/splitview.ts:38-71`（`PanelRenderData.diff`）、`:121-131`（`SplitviewCallbacks.onDiffAction`）、`:626-704`（`buildPanelOps`）、`src/tabs/render.ts:141-167` + `:196-248`、`src/shell/keymap.ts`（其余六条）、`src/main.ts`（分发）、`src/styles/global.css`（`.panel-op.on` 点亮态，若尚无）
- Test: `tests/diff-entry-contract.test.ts`（追加）

**Interfaces:**
- Consumes：`CODICONS`、`mkOp(icon, text, detail, onClick)`（`src/shell/splitview.ts:629-646`）、`setTip`、`showPopupMenu` + `anchorToggle`、`MenuItem`（`src/shell/menu.ts:4-33`）、`refreshPanelOps`（`:714-721`）、`DiffSurface` 的全部动作（Task 4/7）、`swapDiffInputs`（Task 6）。
- Produces：
  ```ts
  // src/shell/codicons.ts 新增（id 取自 @vscode/codicons，落地前先按 Step 1 核 CSV）
  whitespace: "whitespace", map: "map", arrowSwap: "arrow-swap", fold: "fold", unfold: "unfold"
  // src/shell/splitview.ts
  export type DiffAction = "prev" | "next" | "whitespace" | "collapse"
                         | "collapseAll" | "showAll" | "swap" | "refresh";
  interface SplitviewCallbacks { onDiffAction?: (panelId: number, action: DiffAction) => void }
  interface PanelRenderData {
    diff?: { ignoreTrimWhitespace: boolean; collapseUnchanged: boolean; swappable: boolean };
  }
  // src/shell/keymap.ts 其余六条（除注明外 keys 为空）
  // diff.toggleWhitespace / diff.toggleCollapse / diff.collapseAll / diff.showAll / diff.swapSides / diff.refresh
  // src/diff/actions.ts
  export function applyDiffAction(panelId: number, action: DiffAction): void;  // 唯一的 switch 落点
  ```

- [ ] **Step 1: 先核 codicon id 真的存在（防「写了个不存在的字形」）**

Run: `node -e "const s=require('fs').readFileSync('node_modules/@vscode/codicons/dist/codicon.csv','utf8');for(const id of ['whitespace','map','arrow-swap','fold','unfold'])console.log(id, s.split(/\r?\n/).some(l=>l.startsWith(id+',')))"`
Expected: 五行全 `true`。缺哪个就回 `E:\Project\vscode`（本地 1.143.0 checkout）读对应的 `Codicon.*` 取值 —— **说「参考 VS Code」就读它的源码，不上网找**。

- [ ] **Step 2: 写会失败的测试 —— 图标键清单与 toggled 判据（设计稿 ⑦ 的契约）**

```ts
// tests/diff-entry-contract.test.ts
it("B461 · 差异档图标键就四颗：上/下差异（arrow-up/arrow-down）、忽略首尾空白（toggled）、折叠未改动区（map）", () => {
  const ops = panelOpIcons(diffRenderData({ ignoreTrimWhitespace: true, collapseUnchanged: false }));
  expect(ops).toEqual(["arrow-up", "arrow-down", "whitespace", "map"]);
});
it("B461 · 忽略空白那颗按 ignoreTrimWhitespace == false 才算按下（默认 true ⇒ aria-pressed=false）", () => {
  expect(pressedOf(diffRenderData({ ignoreTrimWhitespace: true }))).toBe("false");
  expect(pressedOf(diffRenderData({ ignoreTrimWhitespace: false }))).toBe("true");
});
it("B461 · md 那两颗在差异档一颗都不渲染（差异标签不是 md 面）", () => {
  expect(panelOpIcons(diffRenderData({}))).not.toContain("open-preview");
});
it("B461 · 「⋯」里有交换左右 / 全部折叠⇄全部展开 / 刷新，且没有 Diff View 子菜单；A 档交换置灰", () => {
  const files = labels(groupMenuOfDiffPanel("files"));
  expect(files).toEqual(expect.arrayContaining(["交换左右", "全部折叠", "刷新"]));
  expect(files).not.toContain("Diff View");
  expect(groupMenuOfDiffPanel("baseline")).toContainEqual(
    expect.objectContaining({ label: "交换左右", disabled: true }),
  );
});
```

Run: `npx vitest run tests/diff-entry-contract.test.ts`
Expected: FAIL —— `panelOpIcons` 拿到空数组。

- [ ] **Step 3: `buildPanelOps` 加差异那一支**

`if (data.diff) { ops.append(mkOp(CODICONS.arrowUp, …), …) }` —— 四颗都走 `cb.onDiffAction?.(data.panelId, "prev" | "next" | "whitespace" | "collapse")`。toggled 那颗照 `src/explorer/panel.ts:676-683 syncCollapseButton` 的口径：`aria-pressed` + `class="on"` + 文案跟着翻，提示 `setTip(b, label, { detail: keyHint(id) })`。`map` 那颗同理按 `collapseUnchanged` 翻文案（`折叠未改动的内容` ⇄ `显示未改动的内容`）。**顺序纪律照 B224**：文档级操作靠标签区（这四颗贴在标签右侧），「…」仍钉最右。

- [ ] **Step 4: `panelDataOf` 与 `groupMenuOf`**

`panelDataOf`（`src/tabs/render.ts:141`）：`const surface = diffSurfaceOf(p)`，`diff = surface ? { ignoreTrimWhitespace: surface.ignoreTrimWhitespace(), collapseUnchanged: surface.collapseUnchanged(), swappable: surface.spec().tier === "files" } : undefined`。`groupMenuOf`（`:196`）：这一格的活动标签是差异标签时，在「解散组」之前 `push` 分隔线 + 三条 —— 「交换左右」（`disabled: !swappable`）、「全部折叠 ⇄ 全部展开」（文案跟着 `collapseUnchanged` 现状走，与 `explorer` 那形同口径）、「刷新」。**这三条都按点击那一刻求值**（B422 那条「浮层条目要点击时求值」的教训：`data.groupMenu` 已经是函数，别在里面提前快照）。

- [ ] **Step 5: `applyDiffAction` + 命令 + 分发**

新建 `src/diff/actions.ts`：一个 `switch (action)` 把八条动作落到 `DiffSurface` 的对应方法上，末尾统一 `renderPanelOps(panelId)`（只刷那一小块，**别** `rebuildLayout` —— B226 那条「重建 ops 会把按钮节点换掉，浏览器合成的 click 派发不到」还挂着）。`keymap.ts` 补其余六条命令（除 `diff.openAgainstSaved` 与两条跳块外 `keys: []`）；`main.ts` 的 `shortcutApplies` 用一个 `diffTabActive()` 兜住这六条，`runShortcut` 与 `SplitviewCallbacks.onDiffAction` 都转调 `applyDiffAction` —— **两处不许各写一份 switch**。

- [ ] **Step 6: 跑绿 + 全量**

Run: `npx vitest run --no-file-parallelism > .tmp/b461-t8-full.log 2>&1`（读 `Test Files` / `Tests`）。

---

### Task 9: 左侧栏第五块视图 `diff` —— 按块列 + 点击跳块 + 光标跟随（权威 = 右栏）

**Files:**
- Create: `src/diff/panel.ts`
- Modify: `src/ipc/api.ts:105`（`DrawerViewName` 加 `"diff"`）、`src/shell/drawer.ts:111`（白名单）、`index.html:206-302`（按钮列第五颗 + 第五块 `aside`）、`src/ui.ts:110-162` + `:463-489`（三颗引用）、`src/main.ts:1300-1315`（`setupDiffPanel()`）与 `:296-303`（光标调用点）、`src/diff/surface.ts`（`syncBlocks` 末尾已经在 `notifyDiffBlocks`）
- Test: `tests/diff-drawer-contract.test.ts`、`tests/diff-panel.test.ts`

**Interfaces:**
- Consumes：`registerDrawerView` / `setDrawer` / `viewFromSetting` / `isDrawerOpen`（`src/shell/drawer.ts:45-112`）、`el()` 取节点（`src/ui.ts:110`）、`setTextTip`、`CODICONS`、`DiffSurface.blocks()/jumpTo()/activeIndex()`、`notifyDiffBlocks` / `setDiffBlocksListener`（Task 1）、`blockAt`（Task 2）、`diffSurfaceOf` / `activePanel`。
- Produces：
  ```ts
  // src/diff/panel.ts
  export function setupDiffPanel(): void;         // 挂 #side-diff 点击 + registerDrawerView("diff", …)
  export function updateDiffDrawer(): void;       // onShow、统一刷新路、块数变化通知都走它
  export function refreshDiffAtCursor(): void;    // 光标跟随，带闸（只有活动块序号变了才重绘）
  export interface DiffRow {
    index: number; kind: DiffKind; added: number; removed: number;
    summary: string;        // 那块首行的正文截断
    range: string;          // "2–4 → 2–5" 那一形
  }
  export function diffRowsOf(blocks: DiffBlock[], readLine: (side: DiffSide, n: number) => string): DiffRow[];
  export function emptyTextFor(kind: "notDiff" | "noBlocks"): string;
  ```

- [ ] **Step 1: 写会失败的测试 —— 白名单与枚举必须是同一份名单（钉住 B389 那条静默回落）**

```ts
// tests/diff-drawer-contract.test.ts
it("B461 · DrawerViewName 的每一员都在 viewFromSetting 白名单里（漏一格是静默回落大纲，不是报错）", () => {
  const api = srcOf("src/ipc/api.ts");
  const drawer = srcOf("src/shell/drawer.ts");
  const union = /export type DrawerViewName =([^;]+);/.exec(api)![1];
  const enumNames = [...union.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  expect(enumNames).toContain("diff");
  const guard = /function viewFromSetting[\s\S]*?\n}/.exec(drawer)![0];
  for (const n of enumNames) expect(guard).toContain(`raw === "${n}"`);
});
```

Run: `npx vitest run tests/diff-drawer-contract.test.ts`
Expected: FAIL —— 名单里没有 `diff`（第一条 `toContain` 就红）。

- [ ] **Step 2: 加 `"diff"` 两处**

`src/ipc/api.ts:101-105` 的枚举加 `"diff"`、注释补「B461 加第五块差异」；`src/shell/drawer.ts:111` 那行加 `|| raw === "diff"`。Rust 侧 `drawer_view` 是 `String` 且不校验（`src-tauri/src/session/mod.rs:66-70`）⇒ Rust 不用改；但 `tests/side-resizer.test.ts:490-528` 那条「两格字段」的钉会数名单，跑一遍看它是否要同步补一格（要补就补，别注释掉）。

- [ ] **Step 3: 写会失败的测试 —— DOM 三处齐全 + 点击自己挂 + 空态两句**

```ts
it("B461 · #side-diff / #diff-panel / #diff-list 三处齐，且点击挂在自己模块里（登记 ≠ 挂按钮）", () => {
  for (const id of ["side-diff", "diff-panel", "diff-list"]) expect(document.getElementById(id)).toBeTruthy();
  expect(srcOf("src/diff/panel.ts")).toMatch(/sideDiff\.addEventListener\("click"/);
  expect(srcOf("src/shell/drawer.ts")).not.toMatch(/sideDiff/);      // 外壳不许代管任何一块的点击
});
it("B461 · 空态两句分场景，不许一片白", () => {
  expect(emptyTextFor("notDiff")).toBe("当前标签不是差异编辑器");
  expect(emptyTextFor("noBlocks")).toBe("两份内容一致 —— 没有差异项");
});
```

Run: `npx vitest run tests/diff-panel.test.ts`
Expected: FAIL —— `emptyTextFor is not defined`（HTML 那条也红，因为还没加骨架）。

- [ ] **Step 4: `index.html` 结构与 `ui.ts` 引用**

按钮列插在 `#side-search` 之后、`#side-recent` 之前（次序照 VS Code 活动栏 Explorer → Search → 差异；理由写进 HTML 注释，与那一列现有的注释同风格）：

```html
<button id="side-diff" class="side-btn" type="button"
        data-tip="差异" data-tip-placement="right"
        aria-label="差异" aria-pressed="false"></button>
```
`#side-drawer` 里追加第五块 `aside`：`#diff-panel` → `#diff-head`（`#diff-title` 文案「差异」+ 一颗计数徽标位）→ `#diff-list`。**标题栏常驻、列表才重绘**（B205 那条纪律：重绘只清 `#diff-list`）。`src/ui.ts` 里 `const sideDiff = el<HTMLButtonElement>("side-diff")` / `const diffPanel = el("diff-panel")` / `const diffList = el("diff-list")` 并加进 `:463-489` 的导出清单。

- [ ] **Step 5: 实现 `setupDiffPanel` / `updateDiffDrawer` / `diffRowsOf`**

`registerDrawerView("diff", { panel: diffPanel, button: sideDiff, onShow: updateDiffDrawer })` **并自己**挂 `sideDiff` 的 click（toggle 口径照 `src/search/panel.ts:209-216`：「当前是不是我 ⇒ 收壳，否则切到我」）。`setupDiffPanel()` 里 `setDiffBlocksListener(() => updateDiffDrawer())`（Task 4 的 `syncBlocks` 由此领到新块表）。

`diffRowsOf` 是纯函数：一块一行。`summary` 取**右栏**那块首行正文（`delete` 块右栏是空段 ⇒ 取左栏 `originalStart` 行并前置 `−`），`range` = `2–4 → 2–5` 那一形，`kind` 图标 `arrowDown`（删）/ `arrowUp`（增）/ `diff`（改）。条目 DOM：`.diff-item` 按钮，内含 `.diff-icon` / `.diff-badge`（`+2 −1`）/ `.diff-text` / `.diff-lines`；活动项 `.diff-active`；提示走 `setTextTip(el, 完整摘要, { group: "diff" })`。点击一条 = **先把那张差异标签聚焦**（`setActivePanelId` + `switchTab`，若已聚焦就跳过），再 `surface.jumpTo(row.index)` —— 不先聚焦就会出现「点了条目、两侧都动了、但那一格还不是活动格」的半跳状态。

**先普通列表**，不引虚拟滚动（设计稿 ⑨ 的口径：Task 11 Step 4 实测条目上千再定）。

- [ ] **Step 6: 光标跟随（权威 = 右栏）与重绘闸门**

照 `src/toc.ts:232-235` 的口径写 `refreshDiffAtCursor()`：`isDrawerOpen()` 为假 ⇒ 直接返回；模块级 `let renderedActiveIndex`，只有 `surface.activeIndex()` 变了才重绘（B388 那条「选区驱动重绘要装闸」：问结果不问事件）。调用点接在 `src/main.ts:296-303` 那段 `update.selectionSet` 之后，与 `refreshTocAtCursor(line)` 并排。

**设计稿 ⑩·2 的两条必须实现并各配一条测试**：只有**右栏**那颗（`panel.viewTabId === tab.tabId`）的光标才算权威 —— 左栏里有选区也不许抢面板高亮；差异标签被切走（切标签/切面板）时高亮**保持最后那块**，不清 `renderedActiveIndex`。

- [ ] **Step 7: 写会失败的测试 —— Review Focus 4：三处同源**

```ts
it("B461 · 面板条目数 == diffBlocks 块数（同源；任何一处自己算对齐就是红）", () => {
  const bs = diffBlocks(left, right);
  expect(diffRowsOf(bs, readLine)).toHaveLength(bs.length);
  for (const f of ["src/diff/panel.ts", "src/diff/surface.ts", "src/diff/face.ts"])
    expect(srcOf(f)).not.toMatch(/lcsAnchors|Uint32Array|dp\[/);
  expect(srcOf("src/diff/panel.ts")).toContain("diffSurfaceOf(");   // 面板不自存第二份块表
});
```

- [ ] **Step 8: 跑绿 + 全量**

Run: `npx vitest run tests/diff-drawer-contract.test.ts tests/diff-panel.test.ts tests/side-resizer.test.ts tests/explorer-contract.test.ts tests/drawer.test.ts`，再 `npx vitest run --no-file-parallelism > .tmp/b461-t9-full.log 2>&1`。

---

### Task 10: 会话字段与多窗口边界（禁搬移 + 不留孤儿 doc）

**我的决定（设计稿没写死的那一格）**：**两张差异标签都进会话**（用户重启后想接着看同一份对比；B 档两个输入本来就是磁盘状态，不落反而丢了用户的选择）。A 档恢复时右栏是同文档的**第二份实例** —— 两条记录同一个 `path`，`open_file` 会回 `reused: true`，正是现有「同源多标签」的恢复路径，不引新机制。

**Files:**
- Modify: `src/ipc/api.ts:642-696`（`TabSession` 两个可空字段）、`src/session/store.ts:20-84`（`SessionTabRecord` + `toDisk` + `toSessionState` + `set*` 写点）、`src/session/rebuild.ts`（`buildInstance` 按 `kind` 重建差异标签）、`src/shell/tabstrip.ts:342-410`（差异标签的窗口项缺席 + `draggable = false`）、跨面板移动那几处（`src/tabs/split.ts` 的 `splitPanelWithTab` / `moveTabToPanel` 一族：拒绝差异标签）、`src/tabs/lifecycle.ts:479-610`（`closeTabById` 拆那一格的 surface）、`src-tauri/src/session/mod.rs`（两个 `Option` 字段 + 缺键回落测试）
- Test: `tests/diff-session.test.ts`、`tests/diff-entry-contract.test.ts`（追加）

**Interfaces:**
- Consumes：`SessionTabRecord`（`src/session/store.ts:20-39`，参照 `viewMode: string | null` / `scrollV: number | null` 那两个可空先例）、`TabSession`（`src/ipc/api.ts:642`）、Rust `session::TabSession`、`openBaselineDiff`（Task 5）/ `openFileDiff`（Task 6）、`instancesOfDoc` / `docOf`。
- Produces：
  ```ts
  // src/ipc/api.ts（TabSession 追加）
  kind?: string | null;           // "diff" | null；缺失 = 普通标签
  diffLeftPath?: string | null;   // B 档左栏文件路径；A 档与普通标签都是 null
  // src/diff/model.ts
  export function diffKindOf(rec: { kind?: string | null }): "editor" | "diff";
  ```
  恢复规则：`kind === "diff" && diffLeftPath` ⇒ B 档 `openFileDiff(diffLeftPath, path)`；`kind === "diff" && !diffLeftPath` ⇒ A 档 `openBaselineDiff(恢复出来的那份 docId)`；其余 ⇒ 普通标签。

- [ ] **Step 1: 写会失败的测试 —— 旧会话缺键一律当普通标签（Review Focus 2）**

```ts
// tests/diff-session.test.ts
it("B461 · 老 session 里没有 kind 键 ⇒ 恢复成普通标签（不许把缺失读成 diff）", () => {
  const rec = toRecord({ path: "a.md", encoding: "UTF-8", eol: "LF", cursorLine: 1, cursorCol: 1 });
  expect(rec.kind ?? null).toBeNull();
  expect(diffKindOf(rec)).toBe("editor");
});
it("B461 · kind 必须显式落盘成 null（不许 skip_serializing_if 把它整格抹掉）", () => {
  const json = JSON.stringify(toDisk(recWith({ kind: null, diffLeftPath: null })));
  expect(JSON.parse(json)).toHaveProperty("kind");
  expect(JSON.parse(json)).toHaveProperty("diffLeftPath");
});
it("B461 · Rust 侧那两格必须是 Option（「没记过」不许被收成任何具体值）", () => {
  const src = srcOf("src-tauri/src/session/mod.rs");
  expect(src).toMatch(/pub kind: Option<String>/);
  expect(src).toMatch(/pub diff_left_path: Option<String>/);
  expect(src).not.toMatch(/skip_serializing_if = "Option::is_none"[^\n]*\n[^\n]*(kind|diff_left_path)/);
});
```

Run: `npx vitest run tests/diff-session.test.ts`
Expected: FAIL —— `diffKindOf is not defined`（Rust 那两条也红）。

- [ ] **Step 2: 落地 TS + Rust 两个可空字段**

`SessionTabRecord` 加 `kind: string | null` / `diffLeftPath: string | null`（初值 `null`），`toDisk` / `toSessionState` 两处都带上 —— **一处写、一处读**（B304 那条「显示与行为两套口径」的教训：别在 `snapshotSession` 与 `autosave` 各写一份）。Rust `session::TabSession` 加 `pub kind: Option<String>` / `pub diff_left_path: Option<String>`，**不许**挂 `skip_serializing_if`。`src-tauri/src/session/mod.rs` 底部那两条「缺键回落 / 落盘字段名单」的测试（`:759-768`、`:811-824`）照形各补一格。

- [ ] **Step 3: 写会失败的测试 —— 差异标签不许跨窗口/跨面板（Review Focus 3）**

```ts
it("B461 · 差异标签的右键没有那四条搬移项，也不 draggable", () => {
  const items = tabContextMenu(diffTab());
  expect(labels(items)).not.toEqual(
    expect.arrayContaining(["在新窗口打开", "移回主窗口", "复制到相邻面板", "左右分屏", "上下分屏"]),
  );
  expect(tabElOf(diffTab()).draggable).toBe(false);
});
it("B461 · moveTabToPanel / splitPanelWithTab 对差异标签直接拒绝：标签还在原面板，别格也不许多出 surface", () => {
  const homePanel = tabs.get(diffTabId)!.panelId;
  const other = otherPanelIdOfLayout();
  moveTabToPanel(diffTabId, other);
  splitPanelWithTab(homePanel, "h", diffTabId, false, true);
  expect(tabs.get(diffTabId)!.panelId).toBe(homePanel);          // 标签没被搬走
  expect(diffSurfaceOf(getPanel(other))).toBeNull();             // 目标格没长出第二颗旁路
  expect(panels.get(homePanel)!.diffSurface).not.toBeNull();     // 原格的 surface 仍指向自己那颗 view
});
it("B461 · 关掉差异标签只销毁这个实例：原标签与 doc 都还在，不留孤儿 doc", async () => {
  await closeTabById(diffTabId);
  expect(docs.has(docId)).toBe(true);
  expect(instancesOfDoc(docId).map((t) => t.tabId)).toEqual([originalTabId]);
  expect(diffSurfaceOf(panel)).toBeNull();
});
```

- [ ] **Step 4: 实现那两条边界**

`tabstrip.ts` 的 items：差异标签那几条用现有 `...(cond ? [item] : [])` 那一形整组缺席（分屏两条也挡 —— 分屏会把这颗 view 连带搬走，`panel.diffSurface` 里的 `panel`/`view` 引用就悬了）。`el.draggable = tab.kind !== "diff"`。跨面板移动的两个入口在函数头 `if (tab.kind === "diff") return;` 早退（**并给一次** `showMessage("差异编辑器暂不支持跨面板移动", true)` —— 静默不动会让人以为按键坏了）。`closeTabById`：在 `tabs.delete(tabId)` 之前，若这张是差异标签且**这一格正显示它**，先 `disposeDiffSurface(panel)`；sibling 判定与那圈跨窗口问话都不动 ⇒ 原标签与 doc 天然不受牵连（正是 ⑦⑥ 要的结论）。

- [ ] **Step 5: 跑绿 + cargo 与全量**

Run: `(cd src-tauri && cargo test --release) > .tmp/b461-t10-cargo.log 2>&1`（读 `test result:`）；`npx vitest run --no-file-parallelism > .tmp/b461-t10-full.log 2>&1`（读 `Test Files` / `Tests`）。

---

### Task 11: 全量门禁 + 真机台 `.tmp/b461-check.py`（六段，深浅各一遍）+ 出包

设计稿 ⑦ 的判据在这一条收口。**未经用户指示不提交、不 bump、不推送。**

**Files:**
- Create: `.tmp/b461-check.py`（沿用现成链路 `.tmp/b459-check.py` → `b457-probe.py` → `b451-diagram-probe.py`（`Q.prep(view_mode)` / `Q.launch()` / `LITEPAD_CONFIG_DIR` / `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`）→ `b431-check.py` → `b381-check.py`（CDP，PORT 9222）→ `b352-check.py`（`bc.stop_ours` / `bc.shoot` / `bc.tab_entry` / `bc.write_config` / `bc.PID_FILE` / `bc.CFG`），别另起一台）
- Create: `docs/superpowers/plans/2026-11-05-b461-results.md`
- Modify: 无产品代码 —— 台子抓到病就回到对应任务补红测再修，**不许**改交付文件/产品源文件去凑绿

- [ ] **Step 1: 门禁五连（先证明绿的再去真机）**

```
npx vitest run --no-file-parallelism > .tmp/b461-final-test.log 2>&1
npm run lint > .tmp/b461-final-lint.log 2>&1
npm run format:check > .tmp/b461-final-fmt.log 2>&1
npx tsc --noEmit > .tmp/b461-final-tsc.log 2>&1
(cd src-tauri && cargo test --release) > .tmp/b461-final-cargo.log 2>&1
```
Expected: vitest 日志 `Test Files` 全 passed、`Tests` 全 passed、`failed` 不出现；lint/format/tsc 无输出；cargo `test result: ok.`。

- [ ] **Step 2: 写台子的六段判据（设计稿 ⑦ 逐条，一条不许少）**

```
① 改 3 处 ⇒ 面板 3 条（数 #diff-list 的 .diff-item，与页面里现算的 diffBlocks 对数比）
② 点第 2 条 ⇒ 两侧都落在那块（量两侧那块起始行的视觉 y，容差 ≤ 1 行高）
③ Alt+F5 连跳次序正确（0→1→2→2→1→0；CDP 修饰键位 Ctrl=2 / Shift=8 ⇒ Alt+F5 用 2、Shift+Alt+F5 用 10）
④ Ctrl+S ⇒ 差异清空、面板回「两份内容一致 —— 没有差异项」、4px 同步清空、两张标签的脏点一起消失
⑤ B 档：左栏敲字进不去、右栏能改且脏归它、左栏不弹「外部已修改」
⑥ 关掉差异标签 ⇒ 原标签与 doc 都不受牵连、不留孤儿 doc、不触发同步滚动
```

每条都要「判据本身有鉴别力」：先拿**内存里的退化替身**（或在 `.tmp` 骨架页上）让它 FAIL 一次，确认它抓得住，再落地 —— 不许改交付文件做红测。② 与 ⑥ 都要量像素（视觉 y / `scrollTop` 差），别拿 state 值当结论（同步滚动那一族的老教训）。

- [ ] **Step 3: 深色 / 浅色各跑一遍 + 截图肉眼结案**

Run: `python .tmp/b461-check.py`
Expected: `判定 <N> 条 · FAILS=0`，深浅各一遍。截图落 `.tmp/b352-check/b461-*.png`，**自己 Read 那张关键截图看像素**：两侧底色分不分得开、`.diff-gap` 有没有把行行对齐撑坏、中间指示带与 B458 那 4px 列打不打架、折叠条在浅色档看不看得见。台子全绿而肉眼看出不对 ⇒ 以肉眼为准，回头补判据。

- [ ] **Step 4: 大文件那一档实测（设计稿 ⑧·2 与 ⑨ 两条悬案在这里定）**

用 `test-data/` 那份 3.6MB 级文档（B398/B458 台子用的同一份）：开 A 档差异 → 连打 12 发物理键 → 取**暖机中位数**帧间隔（第 0 发是冷启动发，扔掉）；同时记 `diffBlocks` 单算耗时与面板条目数。据此定两件事并写进结果文档，不许留在口头：
1. `LCS_CELL_BUDGET = 250_000` 沿用还是给差异编辑器另设一档；
2. 侧栏条目列表要不要补虚拟滚动（先普通列表，实测上千条且滚动掉帧才补）。

⚠️ 可打印字符的 `Input.dispatchKeyEvent` 必须显式带 `text`，否则 WebView2 不产生 char/input 事件（B458 那轮的假绿就是这么来的）；判据要量**打了字的那一行本身**。首发的点击会被 CM6 先聚焦编辑器拿走 ⇒ 落点前先补一发点击。

- [ ] **Step 5: 出包到发布目录**

Run: `bash scripts/build-all.sh > .tmp/b461-build.log 2>&1`
Expected: 四步全绿，`src-tauri/target/release/litepad.exe` 时间戳更新（产物**必须**落 release 目录，不许只留 `.tmp`）。exe 正在跑会撞 `os error 5` ⇒ 只处理本会话自己拉起并记在 `PID_FILE` 里的那个进程，**禁止** `taskkill /IM litepad.exe`。

- [ ] **Step 6: 结果文档 + 记忆**

写 `docs/superpowers/plans/2026-11-05-b461-results.md`，分节照 `2026-11-04-b458-results.md`：①用户原话逐条 ②落成了什么（表）③门禁数字（`Test Files` / `Tests` / lint / format / tsc / cargo / exe 时间戳）④真机台段数与 FAILS 与深浅各一遍的数 ⑤过程中抓到的真病灶（含台子自己的假绿）⑥已知限制 —— 逐条点名本轮**没做**的：内联（单栏）视图、逐字符 `innerChanges`、移动代码块、多文件差异编辑器、跨窗口/跨面板搬移、`Diff View` 子菜单、折叠做成用户设置项、面板虚拟滚动（若 Step 4 判定不需要）。

并把「计划替用户做的决定」逐条列出供核对：不做额外并块、A 档不可 `swapSides`、差异实例不画 4px、两张差异标签都进会话、侧栏按钮列的次序（搜索之后）、基线未知时用「置灰 + 文案自述」代替 tooltip、「复刻」字样的文案纪律。

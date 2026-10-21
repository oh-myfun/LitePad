# B319 预览排版节奏 + 岛级增量 + 双击回源码 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Markdown 预览的块与块之间长出可读的垂直节奏，把预览重画从「整容器重建」改成「岛级就地补丁」，并让双击预览某一块能回到源码那一行。

**Architecture:** 垂直节奏声明在岛（`div.md-block`）的边界上，岛壳矩形始终等于内容矩形；`PreviewPane.setBlocks()` 用「公共前段 + 公共后段」对齐新旧岛，未变的岛一个节点都不碰，于是里面已完成的 KaTeX / Shiki / Mermaid / 图片全部存活；双击经 `PreviewPane` 回调 → `deps.ts` 注入 → `markdown.ts` 里新函数 `revealSourceLine()`，复用「转到行」那条已验证的 dispatch 序列。

**Tech Stack:** Vite + vanilla TypeScript、markdown-it 15、CodeMirror 6、vitest（jsdom）、自研真机验证台 `scripts/sync-scroll-probe.mjs`（真实 Chromium + CDP）。

**Spec:** [docs/superpowers/specs/2026-10-21-markdown-typography-and-editing-design.md](../specs/2026-10-21-markdown-typography-and-editing-design.md)

## Global Constraints

- 不引入任何新依赖：morphdom、prosemirror、vditor、lute、diff-match-patch 一律不许 `npm install`。
- 节奏值只用 `var(--md-flow, 0.7em)` 这种**兜底写在用处**的形式；**不许**在 `:root` 或 `.md-preview` 上声明 `--md-flow` / `--md-head-flow` / `--md-after-head`（元素自身的声明会遮蔽 `main.ts` 将来写在 `:root` 的那份 —— B238 实测过的陷阱，见 `src/styles/preview.css:6-9`）。
- 岛壳矩形必须等于内容矩形：不许在 `.md-block` 上用 `display: flow-root`（实测它把 `li` 的上下 margin 吞进壳里，63 vs 55），也不许靠「删掉子元素 margin」来统一。
- `setBlocks()` 的公开签名 `setBlocks(list: MdBlock[], options?: { enhanced?: boolean })` 不变。
- 岛复用判据**只许比较 `html`**，不许掺行号。
- 注释与界面文案沿用仓库既有中文口径；代码默认不写注释，只在「顺序承重 / 有反例」处写一行为什么。
- 不自动推送、不打 tag、不手动 bump 版本；出包走 `bash scripts/build-all.sh`，出包前确认没有 litepad.exe 实例在跑。
- pre-commit 会跑 prettier / eslint / tsc，禁止 `--no-verify`。临时文件只写项目 `.tmp/`。
- 同一工作树可能有第二个并行会话 ⇒ 每个任务结束立刻**点名 `git add` 本任务的文件**、单独成笔。

## Review Focus

规格隐含、但不会被任何单个任务的「正向用例」自然覆盖、且最可能伤到使用者的输入。每行都在某个任务里有一条测试钉住。

1. **在文档开头插入或删除一段**之后：预览仍停在原来那个数值 `scrollTop`，且这一写被同步滚动账本认领（不许外溢成别的窗口被拽走）。→ Task 2 Step 1 的第 4、5 条。
2. **`html` 没变但行号漂移**（上方多了一段）：岛必须**不重建**，同时 `data-lineStart/lineEnd` 必须刷新——大纲跳转与按行落点都读它，读到旧行号就是「跳错地方」。→ Task 2 Step 1 的第 1、2 条。
3. **复用岛里已完成的增强结果**（Shiki 的 `data-highlighted`、Mermaid 替换出来的节点、已改写成 `asset:` 的 `<img src>`）不许被重跑或被清空。→ Task 2 Step 1 的第 3 条。
4. **空文档 / 只剩提示条**：岛清零、`setNotice()` 那条非岛子节点必须仍排在最后。→ Task 2 Step 1 的第 6、7 条。
5. **导出 HTML 与 PDF 打印没有岛壳**（`renderFull` 不包 `.md-block`）：那三条岛规则在那份里必须整条落空、间距仍由子元素 margin 负责；不许为了让「两边一致」去动子元素 margin。→ Task 1 Step 1 的第 5 条。
6. **预览态那一格的编辑器是 `display:none` 的**：双击后必须先翻 `viewMode` 再落位。顺序反了会被 `landVisibleSideAtV` 的残值覆盖，或读到隐藏侧的兜底 `1.00` 把全窗口拽上顶（B301）。→ Task 3 Step 1 的第 2 条。
7. **资源管理器新建 / 改名时**：同层其余条目必须仍然看得见（这一类只有真机照得出来，本轮先补 jsdom 断言）。→ Task 4 Step 1。

---

### Task 1: A1 预览垂直节奏

**Files:**
- Modify: `src/styles/preview.css:65-75`（现有岛规则处）
- Test: `tests/preview-rhythm.test.ts`（新建）
- Modify: `.tmp/typo-check/index.html`（探针改成会自己判定）

**Interfaces:**
- Consumes: 无。
- Produces: 三个自定义属性名与兜底值 `--md-flow`=0.7em、`--md-head-flow`=1.6em、`--md-after-head`=0.8em（15px 基准下 = 10.5 / 24 / 12 px）；不产新符号。

- [ ] **Step 1: 写失败的契约测试 `tests/preview-rhythm.test.ts`**

  以 `readFileSync("src/styles/preview.css", "utf-8")` 读源码文本，按**形状**断言（不要断言注释与措辞）：

  1. 存在通用岛边界规则：`/\.md-preview \.md-block \+ \.md-block\s*\{[^}]*var\(--md-flow,\s*0\.7em\)/`
  2. 存在「标题下方收紧」规则，且主语带 `+ .md-block`：`/:has\(> :is\(h1,h2,h3\)\) \+ \.md-block:not\(:has\([^{]*\)\)\s*\{[^}]*var\(--md-after-head,\s*0\.8em\)/`
  3. 存在「标题上方加大」规则：`/\.md-block \+ \.md-block:has\(> :is\(h1,h2,h3,h4,h5,h6\)\)\s*\{[^}]*var\(--md-head-flow,\s*1\.6em\)/`
  4. **顺序承重**：第 3 条那条规则在文件里出现的位置必须**晚于**第 1 条（`indexOf` 比较）。理由写进测试名，别写成「防回归」的套话。
  5. `li:first-child { margin-top: 0 }` 与 `li:last-child { margin-bottom: 0 }` 两条都在；且 `.md-block` 的规则体内**不出现** `flow-root`。
  6. 守卫未来的遮蔽陷阱：全文不出现 `--md-flow:` / `--md-head-flow:` / `--md-after-head:` 形式的**声明**（冒号紧跟属性名）。
  7. 反向守卫「不许动子元素 margin」：`.md-preview p` 规则仍含 `margin: 10px 0`、`.md-preview h1..h6` 规则仍含 `margin: 24px 0 12px`（Review Focus #5 —— 导出与 PDF 靠这两条）。

- [ ] **Step 2: 跑测试确认它红**

  Run: `node scripts/run-vitest.cjs tests/preview-rhythm.test.ts`
  Expected: 上面 1–5 各条 FAIL（当前 CSS 里岛边界规则一条都没有）。

- [ ] **Step 3: 在 `src/styles/preview.css` 里补规则**

  紧跟现有 `.md-block > :last-child` 那条之后插入（顺序按 Step 1 第 4 条）：通用 `+ .md-block` → 标题下方收紧 → 标题上方加大，然后两条 `li` 清零。值一律写成 `var(--x, 兜底)`；不在任何选择器上声明这三个变量。
  只在「具体度」处留一行注释：通用那条有 3 个类，写成 `.md-block:has(…)` 只有 (0,2,1) 会被它盖掉，所以两条特例都必须带上 `+ .md-block`。

- [ ] **Step 4: 跑测试确认绿 + 格式**

  Run: `node scripts/run-vitest.cjs tests/preview-rhythm.test.ts && npm run format:check`
  Expected: PASS，format 无差异（有差异先 `npm run format`）。

- [ ] **Step 5: 浏览器探针验收（唯一能量出像素的地方）**

  把 `.tmp/typo-check/index.html` 里的 `__probe` 扩成 `__verdict()`：逐岛输出 `tag / 实测间隙 / 期望 / 壳高==内容高`，并返回 `FAIL` 计数。期望表（±1px）：
  `H1→P 12 · P→P 11 · P→H2 24 · H2→P 12 · P→UL 11 · UL→QUOTE 11 · QUOTE→PRE 11 · PRE→P 11`，九个岛壳全部 `tight`。
  用真实浏览器打开 `file:///E:/Project/LitePad/.tmp/typo-check/index.html`，控制台执行 `window.__verdict()`。
  Expected: 8 行间隙判定 + 9 行壳高判定，`FAIL` 计数为 `0`。（探针引的就是真 `preview.css`，所以这一步同时验证了导出共用那份没被改坏。）

- [ ] **Step 6: Commit**

  ```bash
  git add src/styles/preview.css tests/preview-rhythm.test.ts .tmp/typo-check/index.html
  git commit -m "style(preview): 块间垂直节奏声明到岛边界（B319-A1）"
  ```

---

### Task 2: A2 岛级就地增量

**Files:**
- Modify: `src/markdown/preview.ts:64-122`（`setBlocks` 全体 + 两个私有辅助）
- Test: `tests/preview-incremental.test.ts`（新建）

**Interfaces:**
- Consumes: `MdBlock { lineStart; lineEnd; html }`（`src/markdown/pipeline.ts:12-19`）、`PreviewPane` 现有字段 `blocks: BlockNode[]` / `noticeEl` / `pendingSyncLine`、私有 `declareOwnScroll()`（`:446`）。
- Produces: 私有 `alignIslands(prev: BlockNode[], next: MdBlock[]): { head: number; tail: number }`；私有 `createIsland(b: MdBlock): HTMLElement`（现 `setBlocks` 循环里那三行 `createElement/className/dataset/innerHTML` 收进来）。`setBlocks` 签名不变。

- [ ] **Step 1: 写失败的测试 `tests/preview-incremental.test.ts`**

  `// @vitest-environment jsdom`，沿用 `tests/preview-find.test.ts` 的 `blocksOf(htmls)` 造 block 的写法（行号按 `i*2+1`），但**必须**能各自指定行号（测行号漂移要用）。`vi.mock("../src/sync-scroll/wire", …)` 要同时给两样：`syncCoordinator: { expectSurfaceV: vi.fn() }` **和** `PreviewScrollAnchor: class { constructor() {} getV() { return 1 } setV() {} }` —— `declareOwnScroll()` 里 `new PreviewScrollAnchor(...)` 是真的会构造它，少给这一样整份文件就炸在 import 期。

  1. `中间插入一段：其后各岛必须是同一批节点对象` —— 先 `setBlocks([A,B,C])` 抓住 `children` 引用，再 `setBlocks([A,X,B,C])`，断言 `p.root.children[2]` **`toBe`** 原 B 节点、`children[3]` `toBe` 原 C 节点，且新岛插在 index 1。
  2. `判据只比 html：行号漂移不重建，但 data-line* 跟着刷新` —— 第二次传相同 `html`、`lineStart` 各 +3，断言节点 `toBe` 同一引用且 `dataset.lineStart === "4"`。
  3. `复用岛的子树一个字都没被碰` —— 第一次渲染后给 B 岛 `querySelector("p").append(markerSpan)` 并设 `el.dataset.highlighted = "1"`（模拟 Shiki 结果），第二次同 html 重传，断言 `markerSpan.isConnected === true`、`dataset.highlighted === "1"`。
  4. `删除首段：其余岛保持原节点，顺序与 list 一致`。
  5. `写完 scrollTop 之后、setBlocks 返回之前，同栈向账本认领` —— 断言 `expectSurfaceV` 被调用，且调用发生在 `setBlocks` 同步返回之前（用一个在 mock 里记 `performance.now()`/标志位的技巧，或断言「mock 被调用时 `p.root.children.length` 已是新值」）。钉 Review Focus #1。
  6. `空文档 ⇒ 岛清零`（`setBlocks([])` 后 `p.root.querySelectorAll(".md-block").length === 0`），且此时 `setNotice("…")` 再 `setBlocks([A])`，断言 notice 元素 `isConnected` 且是 `root` 的**最后一个**子节点。钉 Review Focus #4。
  7. `只改末段文字 ⇒ 前面所有岛原节点、末段换新节点`。

- [ ] **Step 2: 跑测试确认红**

  Run: `node scripts/run-vitest.cjs tests/preview-incremental.test.ts`
  Expected: 第 1、2、3、4、7 条 FAIL（现在按下标比，插入会让其后全体错位重建）。

- [ ] **Step 3: 实现 `alignIslands`**

  双指针：`head` = 从 0 起 `prev[i].html === next[i].html` 的连续个数；`tail` = 在其余长度内从尾部继续比的个数，上界 `Math.min(prev.length - head, next.length - head)`。**只比 `html`**（Global Constraints）。

- [ ] **Step 4: 把 `setBlocks` 的循环换成就地补丁**

  保留函数开头那两个滚动守卫的读取与结尾那段（`void this.root.scrollHeight` → `pendingSyncLine` 分支 → `root.scrollTop = prevScroll` + `declareOwnScroll()`，**无条件**执行）与查找标记整片清除；把「建 fragment + `replaceChildren`」换成：

  - `for (const stale of prev.slice(head, prev.length - tail)) stale.el.remove()`
  - 新岛插入锚点 `before = prev[prev.length - tail]?.el ?? this.noticeEl ?? null`，对 `next.slice(head, next.length - tail)` 逐个 `createIsland()` 后 `root.insertBefore(el, before)`
  - 复用段（头 `head` 个与尾 `tail` 个）**只做** `el.dataset.lineStart/lineEnd = String(...)`，不动 `innerHTML`、不动子树、不移动节点（尾段本就排在末尾）
  - `contentChanged` 口径不变（长度不等或中段非空即算变）

  ⚠️ 别把 `alignIslands` 的相等判据扩到行号（Step 3 与 Global Constraints 都钉着）：那样每次插入都会让整条后段作废，本任务收益当场归零。

- [ ] **Step 5: 跑新测试确认绿**

  Run: `node scripts/run-vitest.cjs tests/preview-incremental.test.ts`
  Expected: 7 条全 PASS。

- [ ] **Step 6: 跑既有预览/同步滚动用例，确认没打坏**

  Run: `node scripts/run-vitest.cjs tests/preview-find.test.ts tests/sync-scroll-preview.test.ts tests/multi-instance-preview.test.ts tests/markdown.test.ts`
  Expected: 全 PASS。若 `preview-find` 里「重渲染后旧标记失效需重放」那条转绿失败，说明清除标记的时机被挪走了——它必须仍在 patch 之前。

- [ ] **Step 7: Commit**

  ```bash
  git add src/markdown/preview.ts tests/preview-incremental.test.ts
  git commit -m "perf(preview): 岛级就地补丁取代整容器重建（B319-A2）"
  ```

---

### Task 3: A3 双击某一块 = 回源码那一行

**Files:**
- Modify: `src/markdown/preview.ts`（构造器加 `dblclick` 监听 + 新 setter）
- Modify: `src/tabs/deps.ts`（新注入绑定）
- Modify: `src/tabs/lifecycle.ts:253-258`（`new PreviewPane()` 处挂回调）
- Modify: `src/markdown.ts`（新函数 `revealSourceLine` + 加进 `:268` 的导出块）
- Modify: `src/main.ts:320-322`（注入）
- Test: `tests/preview-dblclick.test.ts`（新建）

**Interfaces:**
- Consumes: `toggleViewMode(target?: Tab)`（`src/markdown.ts:120`）、`syncCoordinator.syncTo(docId: string, line: number)`（`src/sync-scroll/coordinator.ts:339`，两个现存调用点都传**源码行**）、`getPanel` / `panel.viewTabId` / `tabs`、`EditorView.scrollIntoView`。
- Produces: `PreviewPane.setBlockDblClick(cb: ((line: number) => void) | null): void`；`revealSourceLine(panelId: number, line: number): void`（`src/markdown.ts` 导出）；`setRevealSourceLine(fn)`（`src/tabs/deps.ts`）。

- [ ] **Step 1: 写失败的测试 `tests/preview-dblclick.test.ts`**

  1. （纯单元，直接 `new PreviewPane()`）`双击某个岛 ⇒ 回调拿到该岛的 lineStart`：`setBlocks` 后对第二块 `firstElementChild` 派发 `new MouseEvent("dblclick", { bubbles: true })`，断言回调收到 `3`；再补一条「双击岛外（根容器空白处）不回调」。
  2. （端到端，钉 Review Focus #6）以 `tests/multi-instance-preview.test.ts` 的 mock 清单为底起 jsdom + `index.html` 骨架，`await import("../src/main")` 启动，把该标签置为 `viewMode: "preview"`，对其预览的第二块派发 `dblclick`，断言：
     - `tab.viewMode === "source"`（先翻态）
     - `view.state.selection.main` 所在行 `=== 第二块的 lineStart`（落位与光标）
     - `syncCoordinator.syncTo` 被以 `(String(docId), 那一行)` 调用（**不是**把隐藏侧的锚点交出去读）
     - 断言 `landVisibleSideAtV` 的调用发生在 `syncTo` **之前**（顺序承重点）

- [ ] **Step 2: 跑测试确认红**

  Run: `node scripts/run-vitest.cjs tests/preview-dblclick.test.ts`
  Expected: FAIL —— `setBlockDblClick` 不存在 / 回调从未被调用。

- [ ] **Step 3: 在 `PreviewPane` 里加回调通路**

  字段 `private onDblClick: ((line: number) => void) | null = null;`，setter `setBlockDblClick(cb)`；构造器里加 `this.root.addEventListener("dblclick", (e) => { const island = (e.target as HTMLElement).closest(".md-block"); if (!island?.isConnected || island.parentElement !== this.root) return; const line = Number(island.dataset.lineStart); if (Number.isFinite(line)) this.onDblClick?.(line); })`。
  只认**直接子级**的岛（`isparentElement !== this.root` 那一条），避免未来嵌套结构里点到块内元素却跳到错误的行。

- [ ] **Step 4: 实现 `revealSourceLine(panelId, line)`**

  取面板与**它此刻正在显示的那份标签**（`panel.viewTabId`，与 `tabStateWriteBack`（`src/commands.ts:251-256`）同一口径）；`tab.viewMode !== "source"` 时**先** `toggleViewMode(tab)`；然后照「转到行」那段 dispatch：`selection` + `EditorView.scrollIntoView(pos, { y: "start", yMargin: 0 })`、`tab.state = view.state`、`syncCoordinator.syncTo(String(tab.docId), clamped)`、`view.focus()`。行号先夹到 `[1, doc.lines]`。
  翻态必须排在落位之前 —— 反了会被 `toggleViewMode` 内部那发 `landVisibleSideAtV(panel, keepV)` 用残值盖掉（`src/markdown.ts:139-151`）。留这一行注释。

- [ ] **Step 5: 接线**

  `src/tabs/deps.ts` 加 `let revealSourceLine: (panelId: number, line: number) => void = () => {}` + `setRevealSourceLine()`，并加进底部那组 `export { … }`；`src/tabs/lifecycle.ts` 在 `new PreviewPane()` 之后 `preview.setBlockDblClick((line) => revealSourceLine(p.panelId, line))`；`src/main.ts:320-322` 那片注入处加 `setRevealSourceLine(revealSourceLine)`，并把 `revealSourceLine` 加进 `src/markdown.ts:268` 的导出块。

- [ ] **Step 6: 跑测试确认绿**

  Run: `node scripts/run-vitest.cjs tests/preview-dblclick.test.ts && npm run typecheck`
  Expected: PASS + 无类型错误。

- [ ] **Step 7: Commit**

  ```bash
  git add src/markdown/preview.ts src/markdown.ts src/tabs/deps.ts src/tabs/lifecycle.ts src/main.ts tests/preview-dblclick.test.ts
  git commit -m "feat(preview): 双击某一块切回源码态并定位到那一行（B319-A3）"
  ```

---

### Task 4: 资源管理器新建/改名时不再藏同层其余条目

**Files:**
- Modify: `src/explorer/panel.ts:225-231`（`renderChildren`）
- Test: `tests/explorer-panel.test.ts`（追加一条）

**Interfaces:**
- Consumes: 现有 `inputRow(kind)`、`childrenOf(dir)`、`isLoading(dir)`、`errorOf(dir)`、`renderEntry(e, dir, depth)`。
- Produces: 无新符号；`renderChildren` 的口径改成「输入框画在该层最前，其余照常」。

- [ ] **Step 1: 写失败的测试**

  在 `tests/explorer-panel.test.ts` 追一条：根目录下已有两个条目，触发新建文件（`creating.dir === root`）后断言 `host.querySelectorAll(".explorer-row").length >= 2`（同层其余条目仍在）**且**输入框 `.explorer-input` 存在、位于该层第一个；再补一条「空目录进入新建态时只画输入框、不画（空）」。

- [ ] **Step 2: 跑测试确认红**

  Run: `node scripts/run-vitest.cjs tests/explorer-panel.test.ts`
  Expected: 新那条 FAIL（现在 `if (creating?.dir === dir) { host.append(inputRow(…)); return; }` 那个 `return` 把整层藏了）。

- [ ] **Step 3: 改 `renderChildren`**

  把 `return` 去掉：`if (creating?.dir === dir) host.append(inputRow(creating.kind));` 然后继续原有的 kids 渲染；`（空）` 那条只在**没有**输入框时画；`读取中…` / `错误` / `（未读取）` 三个分支保持原样（它们各自 `return`）。

- [ ] **Step 4: 跑测试确认绿 + 全量**

  Run: `node scripts/run-vitest.cjs tests/explorer-panel.test.ts && node scripts/run-vitest.cjs`
  Expected: 全绿（记下全量 PASS 数，Task 5 要对比）。

- [ ] **Step 5: Commit**

  ```bash
  git add src/explorer/panel.ts tests/explorer-panel.test.ts
  git commit -m "fix(explorer): 新建/改名输入框不再藏掉同层其余条目"
  ```

---

### Task 5: 全量门禁 + 真机验证台 + 出包

**Files:**
- 无新增源码改动（只在门禁失败时回到对应任务修）

- [ ] **Step 1: 静态与单元门禁**

  Run: `npm run typecheck && npm run lint && npm run format:check && node scripts/run-vitest.cjs`
  Expected: 四条全部无输出/无失败；vitest 末尾 `Test Files`/`Tests` 全 passed，PASS 数 ≥ Task 4 Step 4 记录的数字。

- [ ] **Step 2: Rust 侧**

  Run: `cargo test --manifest-path src-tauri/Cargo.toml`
  Expected: `test result: ok.`（读输出判定，别信管道后的 exit code）

- [ ] **Step 3: 真机验证台（A2 的硬门槛）**

  Run: `node scripts/sync-scroll-probe.mjs --verbose`
  Expected: 退出码 `0`、逐场景 `✅`，特别是 `--trace=rerender` 那一族与「切标签/拖标签位置不错乱」那几条。有 FAIL 就回 Task 2 修，**不许**改探针容差来凑绿。

- [ ] **Step 4: 出包前清场**

  Run: `tasklist | grep -i litepad || echo "无实例在跑"`
  Expected: `无实例在跑`。有实例就先请用户正常关闭，不要强杀。

- [ ] **Step 5: 出包**

  Run: `bash scripts/build-all.sh`（后台跑，读日志里的 `test result:` 与 `Finished 1 bundle` 行判定，不信 exit code）
  Expected: 打包成功产出一个 bundle。

- [ ] **Step 6: 真机目测（排版只能目测）**

  装好后打开一份含标题/正文/列表/引用/代码块的 md，截图对照：段与段之间应有明显边界、标题上方间距大于下方；再改文档第一行，确认下方各块**不闪**（图不重载、mermaid 不重画）；双击任一块应切到源码态并定位到那行。

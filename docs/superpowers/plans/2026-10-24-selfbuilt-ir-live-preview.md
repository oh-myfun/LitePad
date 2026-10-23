# 即时渲染（IR）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 CodeMirror 源码面上加一层块级装饰（非焦点块显示渲染结果、焦点块露原始 markdown），并用一颗挂在面板壳上的三态悬浮键驱动「源码 → 渲染·锁 → 渲染·可写」循环。

**Architecture:** 文本仍是唯一真相源。`MdBlock { lineStart, lineEnd, html }`（既有的 MarkdownIt 产物）驱动 `Decoration.replace({ widget })`；装饰由纯函数算出，CM6 只做装配。渲染/可写性是两维状态（`Tab.liveRender` × `Tab.irLocked`），`viewMode` 不动 ⇒ 同步滚动、大纲、查找按现状自动成立。

**Tech Stack:** TypeScript + CodeMirror 6（`@codemirror/state` / `@codemirror/view`，已在 dependencies）、markdown-it（既有）、Vitest（jsdom + node 两套环境）、Tauri/Rust 仅会话结构体一处。

**Spec:** [docs/superpowers/specs/2026-10-23-selfbuilt-ir-live-preview-design.md](file:///E:/Project/LitePad/docs/superpowers/specs/2026-10-23-selfbuilt-ir-live-preview-design.md) —— 计划按它论证，执行时两份一起读。

## Global Constraints

每个任务的隐含需求都包含本节，取值逐字来自 spec：

- 新增依赖为 **0**：`package.json` 的 diff 里不得出现新的 markdown 引擎或任何 `@vscode/*`。
- `Tab.viewMode` 仍是 `"source" | "preview"` 两值；顶层那颗键与 `Ctrl+/` 的「源码 ⇄ 预览」语义**一字不改**。
- 三态循环**唯一后继** `A 源码 → B 渲染·锁 → C 渲染·可写 → A`；`A→B` 恒为 `irLocked = true`（默认锁着），与持久化读到的值无关。
- `liveRender` 生效值只有 `"off" | "ir"`；`"wysiwyg"` 既不进 UI 也不进持久化白名单。
- 两条新命令 `view.liveRender` / `view.toggleLock` 默认 `keys: []`；`keymap.ts` 全表**不得**因此出现第二个 `Ctrl+Shift+E`（那颗已归 `view.explorer`）。
- 悬浮键挂**面板壳**、`position: absolute`；本功能任何样式里**不得出现 `position: fixed`**（多面板会叠在窗口同一角）。
- `doc.readonly` ⇒ C 态不可达（循环退化成 `A ⇄ B`）；`perfProfileFor(sizeClass).autoPreview` 为关（>2MB）⇒ 那颗键的 DOM 节点**不存在**，不是 `disabled`。
- `preview.css` 里 `.md-preview ` 作排版前缀的出现次数为 **0**；`--md-*` token 块**唯一**。
- 图标一律取官方 codicon，不手绘 path；形状/颜色/字阶走共用 token（`--radius` / `--fs-*` / `--cjk-lift`），不写死数值。
- 提示只有两档：这颗键是**按钮档** `setTip`（带小尖尖），取值不许散落在调用点。
- 每次换态（进渲染 / 翻锁 / 回源码）必须在**同一同步栈**内 `readVisibleV` 在先、写状态在后、`landVisibleSideAtV` + `reconcileSyncRegistrations` 收尾（B293/B304 口径）。
- 写判据前先 `stripCssComments` / `stripLineComments` 抹掉注释；判像素先过 `resolveCssVars`；反向对照一律用**内存里的退化替身**，不改交付文件做红测。
- 交付铁律：不自动推送、不打 tag；出包**前** `bash scripts/bump-version.sh patch --commit --note "随 B352"`；发布只走 `scripts/release.sh`；不用 `--no-verify`；出包前确认没有 litepad.exe 实例在跑。
- 同工作树可能有并行会话：每个任务改完**立刻**点名 `git add <自己的文件>` 单独成笔，不 `git add -A`。

## Spec deltas（计划相对 spec 新增的三个决定）

1. **锁的实现机制**（spec §4 只说「两层各自成立」，未指定机制）：`EditorView.editable(false)` 挡键入/IME/粘贴/拖放，**外加** `EditorState.changeFilter` 只拒「带 `Transaction.userEvent` 标注」的改文本事务。理由：`EditorState.readOnly` 与 `editable(false)` 都**挡不住程序化 `dispatch`**，而 `edit.timeDate`（F5，`force: true`）与查找栏「替换全部」正是程序化写。跨格/跨窗口同源变更集与外部改文件重载**不带** userEvent 标注 ⇒ 天然放行，锁不会把这三条一起堵死。
2. **尾随换行的归属**（spec 未定）：块替换区间 `to = doc.line(lineEnd).to + 1`（该行后面还有行时），否则 `= doc.line(lineEnd).to`。不吞换行会每块留一行空行。Task 5 的探针验证 CM6 是否接受。
3. **「翻锁影响下一个」只做一半**：本版 = 应用级常量默认 `irLocked = true` + 每实例会话记忆。VS Code 那种 globalState 式「这次翻的锁成为下一份的初始态」要往 Rust settings 加字段，单独成 Task 11 并标 **可砍**，不做删除动作即可。

## Review Focus

规格隐含、但任一任务的测试天然不会替我们检验的五类输入/失败模式（每行后面是钉住它的任务）：

1. **锁态下的非键入写入口**：F5「插入时间/日期」（`force: true`）、查找栏「替换全部」、拖文件入编辑区、Ctrl+V 粘贴 —— 期望文本一个字不变，且不弹错误。（Task 7 的 changeFilter 用例 + Task 9 的 F5 / 替换用例）
2. **锁态下的程序化写必须照样通过**：同源兄弟格的变更集、外部改文件后的重载、热退出副本还原 —— 期望内容更新、装饰跟着重算；锁不许把这三条一起挡死。（Task 7 的第二组用例）
3. **中文 IME 合成中途点锁**：期望不出现半截上屏、光标不留在已被吞掉的块里、合成窗关闭。（jsdom 造不出真实 composition ⇒ 只能 Task 12 真机台 + 截图肉眼结案）
4. **分屏两格同一文档、两格 IR 态不同**（一格 C 一格 B，或一格 A）：期望切态后仍落在同一个 `v`，不跳顶、不把另一格拽走。（Task 10 的会话用例只管记忆，行为归 Task 12 真机台）
5. **软折行的超长段落压成一颗 widget**：期望点中间那行进的是这一块、行号不乱、滚动不因高度估算跳动。（Task 5 探针 + Task 6 用例 + Task 12 截图）

---

### Task 1: 把排版规则从容器里剥出来（`.md-rendered`）

**Files:**
- Modify: `src/styles/preview.css`（`.md-preview` 基块 :12-24、dark 块 :50、以及全部 60 处 `.md-preview ` 前缀）
- Modify: `src/markdown/preview.ts:67`（`this.root.className`）
- Modify: `src/markdown/exporter.ts:37`（`article.className`）
- Test: `tests/ir-styles.test.ts`（新建）

**Interfaces:**
- Consumes: 无（纯样式搬家）
- Produces: 共用类 `.md-rendered`（`--md-*` token + 全部 markdown 排版规则的挂载点）。后续任务的 widget 根节点与悬浮键样式都以它为前提。

- [ ] **Step 1: 写失败测试 `tests/ir-styles.test.ts`**

```ts
const css = stripCssComments(readFileSync("src/styles/preview.css", "utf-8"));
// ① 排版前缀搬家搬干净了
expect(css, "preview.css 里 .md-preview 不得再作排版前缀").not.toMatch(/\.md-preview\s+\./);
expect(css, "排版规则挂在 .md-rendered 上").toMatch(/\.md-rendered\s+\.md-block\s*\{/);
// ② token 唯一：dark 覆盖与基块都只有一份，且都在 .md-rendered 上
expect(count(/--md-fg:/g, css), "token 定义唯一").toBe(2); // 亮 1 + 暗 1
expect(css, "容器类不得再带 token").not.toMatch(/\.md-preview\s*\{[^}]*--md-fg:/);
expect(css, "容器类仍带 overflow（搬家没弄丢容器职责）").toMatch(/\.md-preview\s*\{[^}]*overflow-y:\s*auto/);
expect(css, "暗色覆盖改挂 .md-rendered").toMatch(/:root\[data-theme="dark"\]\s+\.md-rendered/);
```

再加两条既有类名的回归判据（`md-block`、`md-task`、`md-mermaid` 各至少一条规则仍在，防「改前缀时顺手删了规则」）。

- [ ] **Step 2: 跑测试确认它红**

Run: `npm test -- tests/ir-styles.test.ts`
Expected: FAIL（`.md-preview .md-block` 之类前缀仍大量存在）

- [ ] **Step 3: 改 `preview.css` 的两处容器/token 混编 + 60 处前缀**

`.md-preview { … }` 拆成：`md-preview` 留 `overflow-y` / `padding` / `background` / `color`；`--md-*` token 整块移进新增的 `.md-rendered { … }`。全部 `.md-preview ` 前缀选择器改写成 `.md-rendered `（`:root[data-theme="dark"] .md-preview` 同步）。**只改选择器前缀，不改任何声明值** —— B319-A1 那三条 `+ .md-block` 特例与注释里写的具体度算术（0,3,0 vs 0,2,1）在前缀换后仍然成立，别顺手调整顺序。

- [ ] **Step 4: 两个根节点带上共用类**

`preview.ts:67` → `this.root.className = "md-preview md-rendered";`
`exporter.ts:37` → `article.className = "md-preview md-rendered";`（导出走的是 `md-preview` 的排版，不带上 `md-rendered` 导出的 HTML 就没样式）

- [ ] **Step 5: 跑新测试 + 全部既有预览样式测试，确认绿**

Run: `npm test -- tests/ir-styles.test.ts tests/preview` 以及 `npm run format:check`
Expected: PASS。既有像素/字阶判据（B319/B321/B333/B337/B342 那族）**一条都不许挪**，它们红了说明 Step 3 漏改或改坏了前缀。

- [ ] **Step 6: 提交**

```bash
git add src/styles/preview.css src/markdown/preview.ts src/markdown/exporter.ts tests/ir-styles.test.ts
git commit -m "refactor(preview): 排版规则与 --md token 从 .md-preview 剥到共用 .md-rendered（B352-1）"
```

---

### Task 2: 抽出 `enhanceMarkdown(root, seq)`

**Files:**
- Create: `src/markdown/enhance.ts`
- Modify: `src/markdown/preview.ts`（`enhance` :309-316、`enhanceInner` :318-440、`retheme` :299-307、`mermaidSeq` :61）
- Test: `tests/enhance-shared.test.ts`（新建）

**Interfaces:**
- Consumes: `PreviewPane` 现有的岛 DOM（`root.querySelectorAll`）
- Produces:
  ```ts
  export function nextEnhanceSeq(): number;
  export async function enhanceMarkdown(
    root: HTMLElement,
    seq: number,
    opts: { bigDoc: boolean },
  ): Promise<void>;
  ```
  Task 6 的 widget 用 `void enhanceMarkdown(el, nextEnhanceSeq(), { bigDoc: false })`。

- [ ] **Step 1: 写失败测试 `tests/enhance-shared.test.ts`**

```ts
const md = stripLineComments(readFileSync("src/markdown/preview.ts", "utf-8"));
const en = stripLineComments(readFileSync("src/markdown/enhance.ts", "utf-8"));
// 三个动态 import 只能在 enhance.ts 里（防「IR 又抄一份增强」）
for (const lib of ["katex", "shiki", "mermaid"]) {
  expect(md, `preview.ts 不该再自己 import ${lib}`).not.toMatch(new RegExp(`import\\("${lib}"\\)`));
  expect(en, `enhance.ts 里有 ${lib}`).toMatch(new RegExp(`import\\("${lib}"\\)`));
}
// mermaid id 计数必须是模块级唯一（B321 那两条注释的教训：两格各数一份会互相删 SVG）
expect(en, "seq 计数器在模块级，不在类里").toMatch(/^let seqCounter\s*=\s*0/m);
expect(en, "enhanceMarkdown 每次进来就认 seq，过期即早退").toMatch(/seq\s*!==\s*latestSeq[\s\S]{0,80}return/);
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npm test -- tests/enhance-shared.test.ts`
Expected: FAIL（`enhance.ts` 不存在）

- [ ] **Step 3: 把 `enhanceInner` 搬成 `enhanceMarkdown`**

逐段平移 katex / shiki / mermaid 三个分支，`seq` 与 `mermaidSeq` 的早退守卫原样保留（改成模块级 `seqCounter` + `latestSeq`）。`PreviewPane.enhance()` 留作薄包装：`this.seq = nextEnhanceSeq(); try { await enhanceMarkdown(this.root, this.seq, { bigDoc: this.bigDoc() }) } finally { this.applyPending() }`。`retheme()` 还原 mermaid 占位那段留在 `PreviewPane` 里（它要按岛重放原 `html`）。

- [ ] **Step 4: 跑测试 + 既有增强测试确认绿**

Run: `npm test -- tests/enhance-shared.test.ts tests/preview`
Expected: PASS（B321「配色不随主题切换」那族用例是这次搬家的真正风险点，红了就是守卫丢了）

- [ ] **Step 5: 提交**

```bash
git add src/markdown/enhance.ts src/markdown/preview.ts tests/enhance-shared.test.ts
git commit -m "refactor(preview): 增强层抽成 enhanceMarkdown(root, seq) · seq 收进模块级（B352-2）"
```

---

### Task 3: `irDecorationsFor` —— 装饰层的纯函数（TDD 重心）

**Files:**
- Create: `src/markdown/ir-decorations.ts`
- Test: `tests/ir-decorations.test.ts`（新建，node 环境）

**Interfaces:**
- Consumes: `MdBlock`（`src/markdown/pipeline.ts:12-18`）、`Text`（`@codemirror/state`）
- Produces:
  ```ts
  export interface IrSelection { from: number; to: number }
  export interface IrReplacement {
    from: number; to: number; html: string; lineStart: number; lineEnd: number;
  }
  export function irDecorationsFor(
    blocks: readonly MdBlock[],
    selections: readonly IrSelection[],
    doc: Text,
    locked: boolean,
  ): IrReplacement[];
  export function irFocusLines(
    blocks: readonly MdBlock[],
    selections: readonly IrSelection[],
    doc: Text,
    locked: boolean,
  ): number[];
  ```
  Task 5 的 widget 表与 Task 7 的行装饰都吃这两个函数，谁都不许自己重算相交。

- [ ] **Step 1: 写失败测试（表驱动）**

`tests/ir-decorations.test.ts` 用 `EditorState.create({ doc })` 拿 `state.doc` 当 `Text`，用例表每行 `[用例名, blocks, selections, locked, 期望的 lineStart 列表]`：

- 光标在三行段落的第 2 行 ⇒ 该段**不出现**在替换里，其余块全在；
- 光标在块外 ⇒ 该块出现在替换里，`from === doc.line(b.lineStart).from`、`to === doc.line(b.lineEnd).to + 1`（末块不加 1）；
- `locked = true` 且光标在某块内 ⇒ 该块**仍在**替换里（锁态零焦点例外）；
- 多光标（两个 `IrSelection`）分别命中两块 ⇒ 两块都不出现；
- 一个选区跨三块 ⇒ 三块都不出现（相交判定按区间重叠，不按「包含」）；
- 空文档 / `blocks = []` / 单行块（`lineStart === lineEnd`）三种退化各一条；
- `irFocusLines` 在无选区（光标在文档外）时返回 `[]`。

反向对照（内存替身，配一条「替身 ≠ 原文」自证）：

```ts
const naive = code.replace("if (intersects) continue;", "if (false) continue;"); // 「相交就不发」改成无条件全发
expect(naive).not.toBe(code);
expect(irLike(naive)(…)).toHaveLength(blocks.length); // 被自己的替身打红 ⇒ 判据有鉴别力
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npm test -- tests/ir-decorations.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现这两个函数**

纯函数，不 import `@codemirror/view`，不碰 DOM。相交判定用「块区间 `[from,to]` 与选区 `[s.from,s.to]` 有重叠」，注意 `s.to === from` 的边界算**不相交**（光标停在块首字符前不该展开块）。`locked` 走独立分支，别写成 `intersects && !locked` 那种把两个概念揉一条表达式的形式 —— 判据要能分别打红。

- [ ] **Step 4: 跑测试确认绿**

Run: `npm test -- tests/ir-decorations.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/markdown/ir-decorations.ts tests/ir-decorations.test.ts
git commit -m "feat(ir): 装饰区间算成纯函数 irDecorationsFor / irFocusLines（B352-3）"
```

---

### Task 4: `nextIrState` —— 三态循环的纯状态机

**Files:**
- Create: `src/markdown/ir-state.ts`
- Test: `tests/ir-state.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces:
  ```ts
  export type IrRenderMode = "off" | "ir";
  export type IrStateName = "source" | "render-locked" | "render-editable";
  export interface IrState { liveRender: IrRenderMode; irLocked: boolean }
  export const IR_DEFAULT: IrState;            // { liveRender: "off", irLocked: true }
  export const IR_STATE_NAME: Record<string, IrStateName>; // 按 [liveRender, irLocked] 取名字
  export function irStateName(s: IrState): IrStateName;
  export function nextIrState(cur: IrState, opts: { readonly: boolean }): IrState;
  export function coerceIrState(raw: { liveRender?: string | null; irLocked?: boolean | null }): IrState;
  ```
  Task 6（悬浮键点击）、Task 8（键的三态字形）、Task 10（会话回落）都从这里取，别处不许自己映射。

- [ ] **Step 1: 写失败测试**

```ts
// 唯一后继：A→B→C→A，三发回到起点
const A = { liveRender: "off", irLocked: true };
const B = nextIrState(A, { readonly: false }); // { ir, true }
const C = nextIrState(B, { readonly: false }); // { ir, false }
expect(nextIrState(C, { readonly: false })).toEqual(A);
// 不许跳态：A 永远不可能一步到 C；C 的下一发不可能是 B
expect(nextIrState(A, { readonly: false }).liveRender).toBe("ir");
expect(nextIrState(C, { readonly: false }).irLocked).toBe(true);
// 只读退化：B 的下一发是 A，不是 C
expect(nextIrState(B, { readonly: true })).toEqual(A);
// 默认锁着 + 非法值回落
expect(IR_DEFAULT).toEqual({ liveRender: "off", irLocked: true });
for (const bad of ["wysiwyg", "split", "preview", "", null, undefined]) {
  expect(coerceIrState({ liveRender: bad }).liveRender, `liveRender=${bad}`).toBe("off");
}
expect(coerceIrState({}).irLocked).toBe(true);            // 没记过 = 锁着
expect(coerceIrState({ irLocked: false }).irLocked).toBe(false);
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npm test -- tests/ir-state.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `ir-state.ts`**

`nextIrState` 写成显式三行 `if`（按 `irStateName(cur)` 分支），不要写成布尔算术 —— 循环顺序是这颗键的全部行为，评审要能一眼看出「只有三条边」。

- [ ] **Step 4: 跑测试确认绿**

Run: `npm test -- tests/ir-state.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/markdown/ir-state.ts tests/ir-state.test.ts
git commit -m "feat(ir): 三态循环纯状态机 nextIrState · 默认锁着（B352-4）"
```

---

### Task 5: Tab 字段 + 把行号/折叠挪进 Compartment

**Files:**
- Modify: `src/core/app-state.ts:40-61`（`Tab` 加 `liveRender` / `irLocked`）
- Modify: `src/editor/editor.ts:59-107`（`baseExtensions`）、`:116-120`（`TabCompartments`）、`:135-162`（`makeTabState`）
- Modify: `src/doc-model.ts`（`makeInstance` 的返回字面量补初值）
- Test: `tests/ir-compartments.test.ts`（新建）+ 一次性探针 `tests/ir-gutter-probe.test.ts`（Task 结束后删）

**Interfaces:**
- Consumes: `perfProfileFor(...).folding`（既有 M4 档位）
- Produces: `TabCompartments { theme, wrap, lang, ir, gutter }`；`Tab.liveRender: IrRenderMode`；`Tab.irLocked: boolean`。Task 6/7 用 `comps.ir.of(...)` / `comps.gutter.of(...)` 重配。

- [ ] **Step 1: 写失败测试**

```ts
const ts = stripLineComments(readFileSync("src/editor/editor.ts", "utf-8"));
const base = topLevelFnBody(ts, "baseExtensions");
expect(base, "行号必须走 compartment，才能按实例切").toMatch(/comps|gutterCompartment/);
expect(base, "折叠不许再裸 push").not.toMatch(/ext\.push\(\s*foldGutter\(/);
expect(base, "M4 的 perf.folding 门槛还在").toMatch(/perf\.folding\s*\?[\s\S]*foldGutter/);
const comps = topLevelFnBody(ts, "makeTabState");
expect(comps, "gutter 的初值带 lineNumbers").toMatch(/lineNumbers\(\)/);
```

外加一条 `Tab` 字段判据：`src/core/app-state.ts` 里 `liveRender` 与 `irLocked` 各出现一次且带注释（评审要看得见「为什么是实例级」）。

- [ ] **Step 2: 跑测试确认它红**

Run: `npm test -- tests/ir-compartments.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现字段与 compartment**

`TabCompartments` 加 `ir: Compartment` 与 `gutter: Compartment`；`baseExtensions` 去掉 `lineNumbers()` 与 `foldGutter(...)` 两条 push，改由 `makeTabState` 里 `comps.gutter.of([...])` 注入（值 = `perf.folding ? foldGutter({ markerDOM: foldMarkerDOM }) : []` 与 `lineNumbers()` 的组合）；`Tab` 加 `liveRender: "off"`、`irLocked: true`，`makeInstance` 的返回字面量补上。

- [ ] **Step 4: 探针 —— 块装饰下的行号到底长什么样（spike 第 2 项）**

一次性写 `tests/ir-gutter-probe.test.ts`：jsdom 里建 `EditorView`，注入一条覆盖 3 行的 `Decoration.replace`（widget 用 `block: true` 那一路，见 Step 5 的写法问题），打印 gutter 实际渲染出的行号数组。把结论**写回 spec 的 §5**（保留行号还是关掉、跳号是否可见），然后删掉这个探针文件。

- [ ] **Step 5: 顺带钉死块级 widget 的写法（spike 第 1 项）+ 尾随换行（delta 2）**

同一个探针里验证两件事，结论一并写回 spec：`WidgetType.define({ block: true })` 与「整行区间 replace + `display:block`」哪条真能被 CM6 接受；块替换区间吞掉尾随换行后，是否出现「吞掉下一块首行」的越界。任一不成立 ⇒ 停下来改 spec，别带着破口进 Task 6。

- [ ] **Step 6: 跑全量测试确认没弄坏既有编辑器行为**

Run: `npm test`
Expected: PASS（`tests/editor-keymap-conflicts.test.ts` / `tests/language.test.ts` 会真的建 `EditorView`，gutter 搬家一旦漏了什么它们先红）

- [ ] **Step 7: 提交**

```bash
git add src/core/app-state.ts src/editor/editor.ts src/doc-model.ts tests/ir-compartments.test.ts docs/superpowers/specs/2026-10-23-selfbuilt-ir-live-preview-design.md
git commit -m "feat(ir): Tab 加 liveRender/irLocked · 行号与折叠挪进 Compartment（B352-5）"
```

---

### Task 6: IR 的 CM6 装配（StateField + ViewPlugin + widget）

**Files:**
- Create: `src/markdown/live-render.ts`
- Modify: `src/markdown.ts`（`scheduleMdRender` 之外新增 IR 的块刷新，或在 `applyPanelMode` 的出口挂钩）
- Test: `tests/ir-render.test.ts`（新建，jsdom）

**Interfaces:**
- Consumes: `irDecorationsFor` / `irFocusLines`（Task 3）、`MdBlock`（pipeline）、`enhanceMarkdown` / `nextEnhanceSeq`（Task 2）、`.md-rendered`（Task 1）、`TabCompartments.ir`（Task 5）
- Produces:
  ```ts
  export const setIrBlocks: StateEffectType<readonly MdBlock[]>;
  export function liveRenderExtensions(opts: {
    ir: boolean; locked: boolean; docId: number;
  }): Extension[];
  export function irBlocksOf(state: EditorState): readonly MdBlock[];
  export class IrBlockWidget extends WidgetType;   // 内部用，判据按 toDOM 的类名
  ```
  `liveRenderExtensions({ ir: false, … })` 必须返回空数组（关态零开销）。

- [ ] **Step 1: 写失败测试**

```ts
// ① 开/关：同一份 state 在 ir:false 下不产生任何装饰
// ② 光标进出同一块 ⇒ 装饰数 1 → 0 → 1（ViewPlugin 靠 selectionSet 重算，不产生事务）
// ③ widget DOM：class 含 "md-rendered" 与 "md-block"，innerHTML 等于该块的 html
// ④ eq() 命中 ⇒ toDOM 不被再次调用（数调用次数，防「每敲一字全篇重画」这条反目标）
// ⑤ ignoreEvent：mousedown 放行（true=忽略，别写反），click/keydown 一律吃掉
// ⑥ 焦点行装饰只给 irFocusLines 返回的那些 lineStart 的行，类名 "md-ir-focus-line"；locked 时为 []
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npm test -- tests/ir-render.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `live-render.ts`**

`irBlocks` 用 `StateField`（初值 `[]`，`setIrBlocks` 写入）；装饰由 `ViewPlugin` 在 `docChanged || selectionSet || viewportChanged` 时按 `irDecorationsFor(blocks, selections, state.doc, locked)` 现算并 `map` 成 `IrBlockWidget`，`provide` 出 `EditorView.decorations`。widget 的 `eq` 比 `(lineStart, lineEnd, html)`；`toDOM` 造 `<div class="md-rendered md-ir-block"><div class="md-block" data-line-start data-line-end>…</div></div>` 并 `void enhanceMarkdown(el, nextEnhanceSeq(), { bigDoc: false })`；`estimatedHeight` 按 Step 5 的探针结论给值（给不了就用 `-1` 并在 spec 记录跳动风险）。

- [ ] **Step 4: 块内 `mousedown` 进编辑**

widget 的 `toDOM` 上挂 `mousedown` ⇒ `view.posAtCoords({ x, y }, false)` ⇒ 反查失败退回该块 `doc.line(lineStart).from` ⇒ `view.dispatch({ selection: { anchor } })`（**不带** userEvent 标注，锁态下按 delta 1 的口径它会被拒还是放行？锁态下 `editable(false)` 已经不吃这个手势，装饰也全发，所以这里必须在 `locked` 时直接 `return`，不许依赖 changeFilter 兜）。

- [ ] **Step 5: 性能探针（spike 第 4 项）**

一次性：5,000 行文档、逐键与拖滚动条各测 100 次的 `getDecorations` 耗时。结论（是否需要收 viewport 范围）写回 spec §「已知代价」第 4 条，探针删掉。**不设产品判据** —— 帧时间判据在 CI 里必然飘。

- [ ] **Step 6: 跑测试确认绿**

Run: `npm test -- tests/ir-render.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/markdown/live-render.ts src/markdown.ts tests/ir-render.test.ts docs/superpowers/specs/2026-10-23-selfbuilt-ir-live-preview-design.md
git commit -m "feat(ir): CM6 装饰层接线 · StateField+ViewPlugin+块级 widget（B352-6）"
```

---

### Task 7: `applyIrState` —— 换态落地（含锁的真机制）

**Files:**
- Modify: `src/markdown.ts`（新增 `applyIrState` / `cycleIrState` / `irEditable`；`renderMarkdownFor` :68-93 加 IR 闸门；`scheduleMdRender` :95-104 双出口）
- Test: `tests/ir-apply.test.ts`（新建）

**Interfaces:**
- Consumes: `nextIrState`（Task 4）、`liveRenderExtensions`（Task 6）、`comps.ir`（Task 5）、`readVisibleV` / `landVisibleSideAtV` / `reconcileSyncRegistrations`（`src/sync-scroll/wire.ts`）、`setSuppressDirty`
- Produces:
  ```ts
  export function applyIrState(panel: Panel, tab: Tab, next: IrState): void;
  export function cycleIrState(tab: Tab): void;          // 悬浮键那一下
  export function irEditable(tab: Tab): boolean;          // 命令层闸门
  ```

- [ ] **Step 1: 写失败测试 —— 顺序判据**

```ts
const body = topLevelFnBody(stripLineComments(readFileSync("src/markdown.ts", "utf-8")), "applyIrState");
const read = body.indexOf("readVisibleV(panel)");
const write = body.indexOf("tab.liveRender =");
expect(read, "必须先读 v 再写状态（B293）").toBeGreaterThan(-1);
expect(write).toBeGreaterThan(read);
expect(body).toMatch(/landVisibleSideAtV\(panel,\s*keepV/);
expect(body, "显隐变了就要重注册（B285/B310）").toMatch(/reconcileSyncRegistrations\(\)/);
```

- [ ] **Step 2: 写失败测试 —— 锁的机制（delta 1，Review Focus 1&2）**

```ts
// 用 live-render 装的 state 直接试事务
const locked = makeLockedState("# a\n\n- x\n");
expect(locked.update({ changes: { from: 0, insert: "Z" }, annotation: Transaction.userEvent.of("input") }).changes.empty,
  "锁态下带用户事件的写必须被拒").toBe(true);
expect(locked.update({ changes: { from: 0, insert: "Z" } }).docChanged,
  "程序化写（同源变更集/外部重载）必须放行").toBe(true);
// editable(false) 同时置起
expect(locked.facet(EditorView.editable.enabled)).toBe(false);
```

- [ ] **Step 3: 跑测试确认它红**

Run: `npm test -- tests/ir-apply.test.ts`
Expected: FAIL（`applyIrState` 不存在）

- [ ] **Step 4: 实现 `applyIrState`**

按这个顺序写（顺序本身就是判据）：`const keepV = readVisibleV(panel)` → 写 `tab.liveRender` / `tab.irLocked` → `tab.state = tab.state.update({ effects: [comps.ir.reconfigure(liveRenderExtensions({…})), EditorView.editable.of(!locked), EditorState.changeFilter.of(锁时拒 userEvent)] }).state` → `panel.view?.setState(tab.state)` → 非锁态补 `focus()`（排在 `applyPanelMode` 之后，B190 那条）→ `landVisibleSideAtV(panel, keepV)` → `reconcileSyncRegistrations()` → `refreshIrLockKey(panel)`（Task 8 的出口）→ `scheduleSessionSave()`。全程包在 `setSuppressDirty(true/false)` 里 —— 换态不是编辑。

- [ ] **Step 5: 渲染闸门**

`renderMarkdownFor(panel, force)` 在 `tab.liveRender === "ir"` 时**不得**调 `preview.setBlocks(…)`（那时预览面是藏的，且每键重画整篇预览正是反目标），改为走 IR 的块刷新；`scheduleMdRender` 的 120ms 防抖只有一条，两个出口共用。

- [ ] **Step 6: 跑测试确认绿**

Run: `npm test -- tests/ir-apply.test.ts tests/ir-render.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/markdown.ts tests/ir-apply.test.ts
git commit -m "feat(ir): 换态落地 applyIrState · 锁用 editable+changeFilter（B352-7）"
```

---

### Task 8: 那颗三态悬浮键

**Files:**
- Create: `src/shell/irlock.ts`
- Modify: `src/tabs/lifecycle.ts`（`mountView` :235-262 里把键挂到 `hostEl`）
- Modify: `src/shell/codicons.ts`（补 `lock` / `unlock` 两颗官方字形）
- Modify: `src/styles/global.css`（`.ir-lock-key` 绝对定位 + `.md-ir-focus-line` 的左边条）
- Test: `tests/ir-lock-key.test.ts`（新建，jsdom）

**Interfaces:**
- Consumes: `cycleIrState` / `irEditable`（Task 7）、`irStateName`（Task 4）、`setTip`（`src/shell/tooltip.ts`）、`.md-rendered`（Task 1）
- Produces: `export function createIrLockKey(panel: Panel): HTMLElement;`、`export function refreshIrLockKey(panel: Panel): void;`

- [ ] **Step 1: 写失败测试**

```ts
// ① 三态三形：dataset.irState 与内部 codicon class 一对一
//    source → codicon-code / render-locked → codicon-lock / render-editable → codicon-unlock
// ② 点一下走的是循环，不是两条分支：click 后 dataset.irState 变了，且 cycleIrState 被调用一次
// ③ 门槛：非 md 面板 / autoPreview 为关 ⇒ 容器里根本没有 .ir-lock-key 节点（不是 hidden、不是 disabled）
// ④ 只读文档：态名只会是 source|render-locked（C 不可达）
// ⑤ 提示走按钮档：data-tip 有值、data-tip-follow 不为 "1"（B350 两档）
```

静态判据另加两条：`src/styles/global.css` 里本功能新增块**不含 `position: fixed`**、不含写死的 `#[0-9a-f]{3,6}` 颜色（走 token）。

- [ ] **Step 2: 跑测试确认它红**

Run: `npm test -- tests/ir-lock-key.test.ts`
Expected: FAIL（`irlock.ts` 不存在）

- [ ] **Step 3: 实现键 + 挂载**

`createIrLockKey` 造 `<button class="ir-lock-key" data-ir-state="source">` + `CODICONS.code`，`innerHTML` 由 `irStateName` 驱动重画（**别在按钮里塞文字**，B348 教训：删掉的「装饰」可能在撑布局）。`mountView` 里在 `preview.root` 之后 `hostEl.appendChild(createIrLockKey(p))`。`refreshIrLockKey(panel)` 由 `applyIrState`（Task 7）与 `applyPanelMode`（`src/markdown.ts:40`）共同调用 —— 后者是「视图模式落到 DOM 的唯一出口」，漏了这一发就会复刻 B228 那颗键卡在旧字形的 bug。

- [ ] **Step 4: 样式**

`.ir-lock-key { position: absolute; right: calc(12px + var(--scrollbar-size)); bottom: 12px; z-index: …; border-radius: var(--radius); }` 明暗两套走 `--bg`/`--fg`/`--border`；`.md-ir-focus-line` 的左边条取 `--accent`。z-index 档位与 findbar / 弹层菜单同框比一次，取「高于滚动条槽、低于浮层菜单」。

- [ ] **Step 5: 跑测试确认绿 + 肉眼结案一次**

Run: `npm test -- tests/ir-lock-key.test.ts` → PASS。
再按 [[证明判据有鉴别力用 --selftest]] 的路子：`.tmp/` 起一页骨架 + dev server + browser-use 截图，自己看「分屏两格各有一颗、互不重叠、不压滚动条」。这条**只能看图结案**，jsdom 测不到定位上下文。

- [ ] **Step 6: 提交**

```bash
git add src/shell/irlock.ts src/tabs/lifecycle.ts src/shell/codicons.ts src/styles/global.css tests/ir-lock-key.test.ts
git commit -m "feat(ir): 编辑面右下角三态悬浮锁键（B352-8）"
```

---

### Task 9: 命令注册 + 菜单 + 锁态下的写入口

**Files:**
- Modify: `src/shell/keymap.ts:298-314`（视图组加两条，`keys: []`）
- Modify: `src/main.ts:440` 与 `:519` 两处 switch（加 `view.liveRender` / `view.toggleLock`）
- Modify: `src/shell/menubar.ts:193` 附近（视图菜单两项）
- Modify: `src/commands.ts`（`edit.timeDate` 的 handler 前加 `irEditable` 闸）
- Modify: `src/find/findbar.ts`（锁态下「替换全部 / 替换」不写文本）
- Test: `tests/ir-contract.test.ts`（新建）

**Interfaces:**
- Consumes: `cycleIrState`、`applyIrState`、`irEditable`（Task 7）
- Produces: 命令 id `view.liveRender`、`view.toggleLock`；`main.ts` 的 handler 表两个新 case。

- [ ] **Step 1: 写失败测试**

```ts
const km = readFileSync("src/shell/keymap.ts", "utf-8");
for (const id of ["view.liveRender", "view.toggleLock"]) {
  expect(km, `${id} 已注册`).toContain(`id: "${id}"`);
  expect(entry(km, id), `${id} 默认不抢键位`).toMatch(/keys:\s*\[\s*\]/);
}
expect(keyLines(km).filter((l) => l.includes('"Ctrl+Shift+E"')), "那颗仍只归 view.explorer").toHaveLength(1);
// 锁态写入口
const timeDate = topLevelFnBody(stripLineComments(readFileSync("src/commands.ts", "utf-8")), "insertTimeDate");
expect(timeDate, "F5 是 force:true 的程序化写，必须问锁").toMatch(/irEditable\(/);
```

再加一条守卫：`main.ts` 的两个新 case 都走 `applyIrState`/`cycleIrState`，**不出现**直接写 `tab.liveRender =`（写点唯一）。

- [ ] **Step 2: 跑测试确认它红**

Run: `npm test -- tests/ir-contract.test.ts`
Expected: FAIL

- [ ] **Step 3: 注册 + 接线**

两条命令的 label：`切换即时渲染` / `解锁 / 上锁（即时渲染）`；`note` 里写清「渲染不变，只管能不能改」。`menubar.ts` 走 `withKey(...)`（虽然没默认键，`keyHint` 会自己处理空值 —— 与「打开文件夹」B314 同一先例，别特殊照顾）。`insertTimeDate` 与查找栏替换在入口 `if (!irEditable(activeTab())) return;` 并 `showMessage("即时渲染已锁定")`。

- [ ] **Step 4: 跑测试确认绿 + 死键自证**

按 [[登记视图 ≠ 挂按钮]]：菜单项与命令面板条目都要**模拟那一下点击**（`menubar` 回调 + `runCommand(id)`），断言文本不变但 `liveRender` 翻了 —— 只断言「注册表里有这条」是空转。

- [ ] **Step 5: 提交**

```bash
git add src/shell/keymap.ts src/main.ts src/shell/menubar.ts src/commands.ts src/find/findbar.ts tests/ir-contract.test.ts
git commit -m "feat(ir): view.liveRender / view.toggleLock 两条直达命令 · 锁态挡住程序化写（B352-9）"
```

---

### Task 10: 会话与跨窗口的两字段

**Files:**
- Modify: `src/ipc/api.ts:538-`（`TabSession` 加 `liveRender?: string | null`、`irLocked?: boolean | null`）
- Modify: `src/session/store.ts:20-39,55-84,153`（记录 + `blankRecord` + `toDisk` + 唯一写点 `setIr`）
- Modify: `src/session/persist.ts:165`
- Modify: `src/session/rebuild.ts:326`
- Modify: `src-tauri/src/session/mod.rs:223-`（struct 两字段 + `impl Default`）
- Test: `tests/ir-session.test.ts`（新建）

**Interfaces:**
- Consumes: `coerceIrState`（Task 4）
- Produces: `sessionStore.setIr(tabId: number, liveRender: string | null, irLocked: boolean | null): void`（**唯一写点**，B304 口径）。

- [ ] **Step 1: 写失败测试**

```ts
// 落盘形状：非 md 标签两字段都写 null（与 viewMode 同口径，别留 "off"）
// 恢复白名单：rebuild 里必须走 coerceIrState，且旧会话缺字段 ⇒ { off, true }
const rb = stripLineComments(readFileSync("src/session/rebuild.ts", "utf-8"));
expect(rb, "恢复走唯一回落出口").toMatch(/coerceIrState\(/);
expect(rb, "不许像 viewMode 那样手抄枚举白名单").not.toMatch(/liveRender === "ir" \|\| .*liveRender === "off"/);
// Rust 侧：字段 + serde alias + Default 三处齐
const rs = readFileSync("src-tauri/src/session/mod.rs", "utf-8");
expect(rs).toMatch(/pub live_render: Option<String>/);
expect(rs, "camelCase 线上格式靠 alias 兜（B49 那一坑）").toMatch(/#\[serde\(alias = "live_render"\)\]/);
expect(rs).toMatch(/live_render:\s*None/);
expect(rs).toMatch(/pub ir_locked: Option<bool>/);
expect(rs).toMatch(/ir_locked:\s*None/);
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npm test -- tests/ir-session.test.ts`
Expected: FAIL

- [ ] **Step 3: 四处 TS + 一处 Rust**

`irLocked` 用 `Option<bool>` 而非 `bool`：`false`（用户明确解锁）与「没记过」（应回落 `true`）是两件事，这跟 `scrollV` 允许 `null` 是同一个理由（B302 注释）。

- [ ] **Step 4: 跑测试 + Rust 测试确认绿**

Run: `npm test -- tests/ir-session.test.ts tests/session-restore-state.test.ts` 与 `cd src-tauri && cargo test`
Expected: PASS（Rust 侧 `#[serde(default)]` 已让旧会话文件反序列化不炸）

- [ ] **Step 5: 提交**

```bash
git add src/ipc/api.ts src/session/store.ts src/session/persist.ts src/session/rebuild.ts src-tauri/src/session/mod.rs tests/ir-session.test.ts
git commit -m "feat(ir): liveRender/irLocked 进会话 · 恢复走 coerceIrState 回落（B352-10）"
```

---

### Task 11: 可砍 —— 「翻锁影响下一个」的应用级默认

**只有用户点头才做。不做就删掉本节，本版交付物不受影响。**

VS Code 的语义是 globalState：这次翻的锁成为**下一份文档**的初始态（`markdownEditorProvider.ts:258-262` 注释）。LitePad 要这条就得往 Rust settings 加一个布尔字段。

**Files:** Modify `src-tauri/src/settings`（字段 + 默认 `true`）、`src/prefs.ts`（`setIrLockedDefault(on)` 与 `persistSettings()` 同族写法）、`src/shell/settingsdialog.ts`（通用页一项）、`tests/ir-prefs.test.ts`（新建）。

- [ ] Step 1: 写失败测试 —— `IR_DEFAULT` 不再读常量而读 `settings.ir_locked_default`；缺省仍 `true`。
- [ ] Step 2: 跑红。
- [ ] Step 3: 实现三处 + 设置页那一项（文案不带省略号；开关立即生效 + 持久化，照 `setAutosave` 那条写法）。
- [ ] Step 4: 跑绿，`cargo test` 一并。
- [ ] Step 5: `git add` 点名五个文件提交 `feat(ir): 锁态默认升成应用级设置（B352-11）`。

---

### Task 12: 全量门禁、bump、出包与真机验收

**Files:** 无源码改动（除非验收发现问题回相应任务）

- [ ] **Step 1: 静态门禁**

Run: `npm run typecheck && npm run lint && npm run format:check`
Expected: 三条都 exit 0（自己看 `echo $?`，别读管道尾巴 —— [[管道后的 exit code 不是被测程序的]]）

- [ ] **Step 2: 全量测试**

Run: `npm test` → 读输出里的 `Test Files` 与 `Tests` 两行，全绿才算。
Run: `cd src-tauri && cargo test` → `test result: ok`，0 failed。

- [ ] **Step 3: 版本推进**

Run: `bash scripts/bump-version.sh patch --commit --note "随 B352"`
Expected: 四处版本号（package.json / tauri.conf.json / Cargo.toml / Cargo.lock）一致 +patch，并自动成笔。

- [ ] **Step 4: 出包（先确认没有实例在跑）**

Run: 先 `tasklist | grep -i litepad` 确认为空，再 `npm run build:all`，日志落 `.tmp/b352-build.log`。
Expected: 日志尾部 `EXIT=0`；产物 `bundle/nsis/LitePad_<新版本>_x64-setup.exe` 存在；exe 的 `FileVersion`/`ProductVersion` 自证同版本；`dist/assets/*.css` 里搜得到 `.md-rendered`（压缩后形态：引号被去、`::` 变 `:` —— [[读 CSS 的判据与像素探针]]）。

- [ ] **Step 5: 真机台验收（Review Focus 3/4/5 三条只能在这里结案）**

1. 中文 IME：C 态打「你好」候选窗途中点锁 ⇒ 无半截上屏、无光标错帧；
2. 分屏两格同一文档：一格 C、一格 A，各自翻态后落点仍是同一 `v`，另一格不被拽走（对照 `syncTrace` 日志）；
3. 软折行超长段落：点段落中间某行进的是这一块，滚动不跳；
4. 只读文档：循环停在 `source ⇄ render-locked`；
5. >2MB 文档：那颗键的 DOM 节点不存在（DevTools 数一下）。
按 [[真机日志优先于本地推测]]：任一条不复现先补 trace，别当场改判据。

- [ ] **Step 6: 报告**

汇报：改动文件清单、测试与出包证据（日志里的 `EXIT=` / `Test Files`）、真机五条的逐条结论、**未推送未打 tag 未发版**。发布要用户显式说「发布」才走 `scripts/release.sh`。

---

## 自检结论（写计划时对照 spec 跑过）

- **规格覆盖**：spec 的 §1 数据来源→Task 3/6，§2 三件套→Task 6，§3 进入编辑→Task 6 Step 4，§4 状态机与键→Task 4/7/8，§5 冲突处置（行号/折叠/焦点块）→Task 5/6，§6 样式→Task 1/8，§7 增强→Task 2，判据 14 条分散在 Task 1/3/4/7/8/9/10，spike 六项落在 Task 5（1、2）、6（4）、8（6）、7（3 的落位顺序）。**无缺口**。
- **一处 spec 未覆盖**：「IR 面里点链接不该导航」。Task 6 Step 3 的 `ignoreEvent` 已吃掉 click，链接与复选框同样落不进 mousedown 之外的分支 ⇒ 由 Task 6 用例 ⑤ 钉住，无需新开任务。
- **类型一致性**：`IrState` / `IrReplacement` / `IrSelection` / `liveRenderExtensions` / `applyIrState` / `cycleIrState` / `irEditable` / `coerceIrState` / `nextIrState` / `irStateName` / `enhanceMarkdown` / `nextEnhanceSeq` / `setIr` 在各任务间接口一致。
- **篇幅比例**：与 spec 同量级，函数体一律留给实现者；给代码的地方是签名、判据断言与「必须先读 v 再写状态」这类顺序约束。

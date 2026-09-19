# InkNote 源码研读与 LitePad 优化提案（2026-09-19）

> 来源：`E:\Project\InkNote`（MIT，`likehao19/InkNote` v0.2.10，Tauri 2 + React 19 + CodeMirror 6）。
> 定位与本项目高度重叠（本地优先 Markdown 编辑器），但形态不同：InkNote 是**单栏所见即所得**，
> LitePad 是**多标签 + 分屏 + 多窗口的通用文本编辑器**。
> 本文件是**提案，不是结论**：未开工前不改变任何既有不变量。

## 0. 结论先行（四条）

1. **LitePad 的问题不是"文件太大"，而是"没有状态边界"**。`src/main.ts` 5162 行 / 204 个函数 /
   34 个模块级可变变量 / 18 个启动期即取的 DOM 引用；`refreshAll()` 被**手工调用 25 处**
   （24 处调用 + 1 处定义）。文件大是症状，缺响应式订阅是病因。
2. **InkNote 最值得抄的不是 React，而是它的"三层切法"**：`lib/`（无 DOM 的纯逻辑，可 node 直测）
   → `store/`（唯一真相 + 订阅） → `components/`（只渲染）。这套切法**不依赖任何框架**，
   可以原样移植到 LitePad 的原生 TS 上。
3. **顺手实测出一个既有缺陷（本次研读最大收获）**：`tsconfig.json` 只 `include: ["src"]`，
   29 个测试文件**从未被类型检查**。实测补上后报 **52 个类型错误**，其中包括
   `menubar.test.ts` 在给 `MenuBarCallbacks` 传一个**已不存在的字段** `themeChecked`，
   以及 4 处**已成空转的 `@ts-expect-error`**。详见 §2 P1-6。**修复零风险，建议优先做。**
4. **InkNote 有两个明显短板，不要学**：Rust 侧 1352 行单文件 `lib.rs` 无分区（本项目
   `commands/core/session/backup/windows` 分层明显更好）；前端**无 ESLint / Prettier / 无 lint 门禁**
   （本项目已有）。本项目在多窗口、分屏、大文件降级、键位预设上功能更强，**不要为了对齐而回退**。

---

## 1. 量化对比

| 维度 | LitePad | InkNote |
|---|---|---|
| 前端框架 | 无（原生 TS + DOM） | React 19 + Zustand |
| 前端规模 | 14 919 行 / 32 文件 | 19 564 行 / 103 文件 |
| 最大前端文件 | `main.ts` **5162 行** | `App.tsx` 2185 行 |
| Rust 规模 | 2808 行 / 10 文件**分层** | 1352 行 / **1 文件** |
| 测试 | 29 个测试 + `setup.ts`，集中 `tests/` | 23 个，**与源码同目录** |
| lint / format | ✅ eslint + prettier + 门禁 | ❌ 无 |
| i18n | ❌ 63 处硬编码中文 | ✅ 836 条 key，中英双语 |
| 模块被引用次数 | 24/25 个模块**只被 main.ts 引用** | `lib/` 被 store 与 components 双向复用 |
| 状态同步 | 手工 `refreshAll()` ×25 | store 订阅，0 处手工刷新 |

> 注：行数为 2026-09-19 静态统计，含注释与空行。

---

## 2. 值得借鉴的 8 个模式（按「可直接移植」排序）

### P0-1 IPC 单一出口 + 错误码本地化映射

**InkNote 做法**（`src/lib/tauri.ts:18-35`）：所有 `invoke` 只在一个文件出现；
Rust 返回的机器可读错误码经 `BACKEND_ERROR_KEYS` 映射成文案：

```ts
const BACKEND_ERROR_KEYS: Record<string, MessageKey> = {
  file_exists: "error.fileExists",
  invalid_file_name: "error.invalidFileName",
  // ...
};
function invokeLocalized<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args).catch((error) => {
    const key = BACKEND_ERROR_KEYS[String(error)];
    if (key) throw new Error(t(getLocale(), key));
    throw error;
  });
}
```

**对照 LitePad**：`src/ipc/api.ts` 已是单一出口 ✓，但**命名策略不统一**——
`OpenedFile` 是 camelCase、`Settings` 是 snake_case，全靠人肉记忆。这正是 B68 那个
「`size_class` 读成 undefined → 大文件降级从未生效」bug 的土壤。

**建议**：在 `api.ts` 顶部加**类型守卫式解码**（而不是直接 `as` 断言），让"字段名写错"在
类型层就崩掉；顺便把 Rust 错误码收敛成 `LitePadError` 枚举 + 中文文案表，消灭
`catch { /* 写失败不应影响使用 */ }` 这类无差别吞异常。

---

### P0-2 自写入追踪：解决"我的 watcher 把我自己写的当成外部修改"

**InkNote 做法**（`src/lib/tauri.ts:49-86`）：按 `(path, content)` 记录**进行中的写入**计数，
文件监听事件到达时先问一句"这是我刚写的吗"：

```ts
const pendingSelfWrites = new Map<string, Map<string, number>>();
export function isSelfWritePending(path: string, diskContent: string): boolean {
  return (pendingSelfWrites.get(path)?.get(diskContent) ?? 0) > 0;
}
export function writeFile(path: string, content: string): Promise<void> {
  trackSelfWrite(path, content, 1);
  return invoke<void>("write_file", { path, content }).finally(() => trackSelfWrite(path, content, -1));
}
```

用「路径 + 内容」双键而不是「路径 + 时间窗」是关键：时间窗在慢磁盘/大文件上必然误判。

**对照 LitePad**：已有 `suppressDirty`（L287）这个信号量 + `syncingDocId`（L338）防重入，
属于同类思路但更粗（全局布尔，无法并发、无法区分"哪一次写入"）。

**建议**：把 `suppressDirty` 升级为与 InkNote 同构的 `(path, content)` 计数器，
放在 `src/ipc/api.ts` 里收口。这能顺带修掉"自动保存 + 外部修改同时发生"的边缘 case。

---

### P0-3 异步 UI 桥接：把"要弹窗的纯逻辑"与 UI 解耦

**InkNote 做法**（`src/lib/confirmBridge.ts`，全文 13 行）：

```ts
export type ConfirmHandler = (message: string) => Promise<boolean>;
let handler: ConfirmHandler | null = null;
export function setConfirmHandler(fn: ConfirmHandler | null) { handler = fn; }
export async function askConfirm(message: string): Promise<boolean> {
  if (handler) return handler(message);
  return window.confirm(message);   // 测试环境自动降级
}
```

同一个模式还有 `editorBridge.ts`（编辑器 → 宿主对话框）、`useToast.ts`。
**收益**：`lib/` 里的业务逻辑可以写 `await askConfirm("覆盖？")` 而**不 import 任何组件**，
单测时 `setConfirmHandler(() => true)` 一行就能驱动分支。InkNote 因此有 15 个纯净的
`lib/*.test.ts`。

**对照 LitePad**：`showConfirm` / `showPrompt` 这类函数直接在 `main.ts` 里创建 DOM，
业务函数（如 `closeTabById`）必须同处一文件才能调用它 —— 这是**标签逻辑抽不出去的首要原因**。

**建议**：先抽 `src/shell/dialogs/` 模块，导出 `askConfirm/askPrompt/askChoice`，
`main.ts` 启动时注入真实实现。这是后面所有拆分的前置条件，**成本最低、解锁最多**。

---

### P1-4 状态 store + 订阅，替掉手工 `refreshAll()`

**InkNote 做法**（`src/store/useTabsStore.ts`，247 行）：全部文档状态在一个 store，
`content` 与 `diskContent` 分离，`dirty` 是**派生值**（`t.diskContent !== content`）而非独立字段；
`markSaved` 特意注释了"只推进磁盘基线，不用写盘前快照覆盖 content，否则 IPC 往返期间敲的字会被抹掉"——
**这个不变量 LitePad 也踩过**。

**对照 LitePad**：`refreshAll()` 的调用点（`grep -n "refreshAll()" src/main.ts`）：
`743, 876, 990, 1070, 1076, 1102, 1271, 1326, 1356, 1448, 1503, 1519, 1548, 1719, 1797,
1824, 1851, 2264, 4408, 4457, 4507, 4620, 4867, 5144` —— **24 个调用点 + 1 处定义**。
任何新增状态变更忘记调用，UI 就静默不一致。

**建议（不需要引入框架）**：写一个 ~60 行的微订阅器：

```ts
// src/core/store.ts
type Listener = () => void;
const listeners = new Set<Listener>();
export const subscribe = (fn: Listener) => (listeners.add(fn), () => listeners.delete(fn));
export let dirty = false;
export function commit(mutate: () => void) {   // 唯一的写入口
  mutate();
  if (dirty) return;
  dirty = true;
  queueMicrotask(() => { dirty = false; listeners.forEach((l) => l()); });
}
```

再把 24 处 `refreshAll()` 删掉，改成 `subscribe(refreshTitle)` / `subscribe(refreshStatus)` 各注册一次。
`commit()` 内合并同帧多次写。**风险可控**：订阅者在 `main.ts` 里注册，不改任何模块签名。

---

### P1-5 设置：声明式收敛 + 串行写入 + 迁移表

**InkNote 做法**（`src/lib/settingsStore.ts`）三个亮点：
1. **扁平 key → 嵌套 path 映射表**，旧版 localStorage key 一次性迁移后删除；
2. **写入串行链** `saveChain = saveChain.then(...)`，避免并发写覆盖；
3. `flushSettingsStore()` 供**退出前**等待落盘；`resetSettingsStoreForTests()` 供测试重置。

**对照 LitePad**：`main.ts:3652` 的 `persistSettings()` 每次整体写 `saveSettings(settings)`
（Rust 侧 `commands/mod.rs:659`），**无串行保护、无退出前 flush**；
且 `setThemeMode / setDefaultEol / setDefaultEncoding / setAutosave / setHotExit /
setPreviewLineHeight / setTocWidthValue / setFontFamily / setEditorLineHeight /
setFontSizeValue / setWordWrap` 共 11 个近乎同构的 setter（L3454–3628）。

**建议**：建 `src/core/settings.ts`，声明一张 `SETTINGS: Record<Key, {get, set, apply, refresh}>` 表，
`applySetting(key, value)` 统一走「改 → 排队写 → 应用副作用 → 通知订阅者」四步。
新增设置项从"改 3 个文件"变成"加 1 行表项"。

---

### P1-6 测试与源码同目录 + 类型检查覆盖测试 —— **已实测，发现真问题**

**InkNote 做法**：`lib/xxx.ts` 旁边就是 `lib/xxx.test.ts`（23 个测试里 14 个落在 `lib/`），
另有 `editor.integration.test.ts`（718 行）做编辑器级集成。

**对照 LitePad 的一个真实漏洞**：`tsconfig.json` 的 `"include": ["src"]` ——
**`tests/` 下的 29 个测试文件 + `setup.ts` 完全没有被类型检查**。`npm run typecheck` 只查 `src`，
eslint 查 tests，但**类型层是空的**。

**🔬 已实测（2026-09-19）**：用继承根配置的临时 tsconfig（`include: ["src", "tests"]`）
跑 `tsc --noEmit`，**52 个类型错误**，分布如下：

| 数量 | 错误码 | 含义 | 判定 |
|---|---|---|---|
| 17 | TS2339 | 属性不存在（`layout.test.ts` 占 16 处，判别联合未收窄就访问 `.ratio`/`.a`/`.b`） | 测试代码本身的真缺陷 |
| 13 | TS2307 | `Cannot find module 'node:fs'` 等 | 缺 `@types/node` 依赖 |
| 7 | TS7006 | 参数隐式 `any` | mock 无类型 |
| 7 | TS2345 | 实参类型不匹配 | 待逐个判定 |
| **4** | **TS2578** | **`@ts-expect-error` 已成空转（该行现在没有错误）** | **见下** |
| 1 | TS2353 | 对象字面量含未知属性 | **见下** |
| 1 | TS2580 | `Cannot find name 'process'` | 缺 `@types/node` |
| 1 | TS2740 / 1 | `Element` 与 `HTMLElement` 不匹配 / 赋值不兼容 | 待判定 |

**两个高危信号（硬证据）**：
- `tests/menubar.test.ts:101` 给 `MenuBarCallbacks` 传了 **`themeChecked`**，
  而该接口里**没有这个字段**（TS2353）→ 菜单回调接口改过，**测试仍在构造旧形状的 mock**。
  该用例是否真的验证了当前行为，存疑。
- `tests/preview-sync.test.ts:68`、`tests/toc-follows-panel.test.ts:17/28/31` 共 **4 处
  `@ts-expect-error` 已失效**（TS2578）→ 当年为绕过类型系统打的补丁现在不必需了。
  问题不是"它掩盖了新错误"（TS2578 本身会报），而是**没人知道它已经空转**——
  因为这 30 个文件从来不做类型检查。

> 复现：在 `.tmp/` 建 `{ "extends": "../tsconfig.json", "include": ["../src", "../tests"] }`，
> 然后 `npx tsc --noEmit -p .tmp/tsconfig.<name>.json`。

**建议**：`include: ["src", "tests"]`（或加 `tsconfig.test.json` 并在 CI 跑）+ 补 `@types/node`。
按上表分批修：先 `@types/node`（13 个 TS2307 一次消掉）→ 再 `layout.test.ts` 判别联合收窄
（16 个）→ 最后逐个判定 TS2345/TS2740/TS2353。**先修类型再看测试是否仍全绿**——
若某用例修完类型就变红，说明它之前是**假绿**。

---

### P2-7 首屏懒加载

**InkNote 做法**（`App.tsx:150-163`）：14 个对话框全部 `lazy()`，编辑器本身也 lazy。

**对照 LitePad**：`main.ts` 顶部 126 行 import 里，`shell/keymapdialog`、`shell/preferencesdialog`、
`shell/commandpalette`、`shell/tooltip`、`markdown/exporter` 等**首屏用不到**。

**建议**：对「首次点击才出现」的模块改 `await import()`（本项目已依赖 markdown-it / shiki /
mermaid 这三个重库，尤其值得延后到首次真正预览时再加载）。注意本项目构建走
`tsc --noEmit && vite build`，动态 import 的 chunk 命名要在 `vite.config.ts` 里确认。

---

### P2-8 i18n 从"表"开始，不必一次做完

**InkNote 做法**：`src/lib/i18n.ts` 911 行 / 836 条 key，`zh` + `en` 两份，
`t(locale, key)` + 模板占位符（`"{rows} × {cols} 表格"`）。

**对照 LitePad**：`main.ts` 内约 63 处硬编码中文。

**建议**：**现在不必做 i18n**（LitePad 定位是中文用户，这是合理的范围决策）。
但把文案收敛到 `src/locales/zh.ts` 一个对象**零成本**，且会让未来加英文变成纯机械劳动。
顺带解决"同一句提示在两个分支里写法不一致"的隐患。

---

## 3. 不要学的部分

| InkNote 的做法 | 为什么不学 |
|---|---|
| `src-tauri/src/lib.rs` 单文件 1352 行 | 条件编译分支（`replace_file` ×2、`export_pdf` ×3、`configure_markdown_default_app` ×3）与业务逻辑混排，定位困难。本项目 `commands/core/session/backup/windows` 分层更优 |
| 无 ESLint / Prettier | 本项目已有，且 `.githooks` 门禁在跑。**不要因为对齐而删** |
| 前端设置靠"字符串键 + `String(value)`" | 丢失类型信息，`getStoredValue` 返回 `string \| null`，每个取值点都要再解析。本项目的 Rust 强类型 `Settings` 结构体更安全 |
| React 依赖树（19 个运行时依赖） | 本项目 12 个运行时依赖、无框架是**特性而非缺陷**（启动体积/内存）。引入 React 等于重写 M3/M4 全部 UI |
| `App.tsx` 2185 行 | 即使是 React 也没逃掉巨型根组件。反证：**换框架不解决架构问题** |

---

## 4. 建议的落地顺序（待用户确认后开工）

| 阶段 | 内容 | 前置 | 验收 |
|---|---|---|---|
| **S2** ⭐ | `tests/` 纳入类型检查 + 补 `@types/node` | 无 | `tsc --noEmit` 覆盖 30 个文件；**52 个错误分批清零**；清零后复跑测试确认无"修完类型就变红"的假绿用例 |
| **S1** | 抽 `shell/dialogs/` + 桥接注入 | 无 | `main.ts` 减少 ~200 行；现有测试全绿；新增桥接单测 |
| **S3** | `core/store.ts` 微订阅器 + 删 24 处 `refreshAll()` | S1 | 真机 UI 与现状逐项比对无差异；新增"改状态必刷新"回归测试 |
| **S4** | `(path, content)` 自写入追踪替换 `suppressDirty` | S3 | 自动保存 + 外部修改并发用例通过 |
| **S5** | `core/settings.ts` 设置表收敛 11 个 setter | S3 | 逐项功能等价；写入串行；退出前 flush |
| **S6** | 抽 `find/`（532 行，自洽度最高）、`windowing/`（726 行） | S1+S3 | 行为零变化 + 全量回归 |

**顺序理由**：**S2 排第一**，因为它是唯一一个"不改任何生产代码、却能立刻暴露既有缺陷"的动作，
且实测成本已知（52 个错误、三类成因）。S1 次之（零风险解锁项，是所有拆分的**前置条件**）。
S3 是分水岭（一旦有订阅，后续拆分才安全）。S4–S6 才有资格动真正的逻辑。
**禁止**先抽 `find/`（S6）再补 S3 —— 没有订阅机制时拆分会让刷新调用散落两处，比现在更难维护。

**风险预演**：最可能挂的地方是 S3 —— 现有 24 处 `refreshAll()` 里可能有**顺序敏感**的调用
（先刷标签再刷状态栏）。缓解：先加订阅但**保留** `refreshAll()` 调用，做"双跑"对比
（用断言检查订阅路径与手工路径产出的 DOM 快照一致），确认后再逐个删。

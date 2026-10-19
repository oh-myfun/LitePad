# 最近打开（B305）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 左栏加一块「最近打开」面板，列此刻没在任何窗口开着的文件，全机一份、跨窗口即时刷新，上限可在设置页调。

**Architecture:** 「文件被关掉」这件事由 Rust 单点从「各窗口上报的可见路径集合的并集」推导出来，而不是在每个关闭分支里逐条埋点；Rust 持有名单并原子写 `recents.json`，任何变更广播 `recents-changed`，前端各窗口只是视图。挂点是 `broadcastDocPresence`（可见集合变化的唯一广播点）。

**Tech Stack:** Tauri v2 + Rust（`src-tauri`）、TypeScript（`src/`）、CodeMirror 6、vitest（jsdom）+ `cargo test`。

**Spec:** [docs/superpowers/specs/2026-10-19-recent-files-design.md](file:///E:/Project/LitePad/docs/superpowers/specs/2026-10-19-recent-files-design.md)

## Global Constraints

- 工单号 **B305**，注释与提交信息照仓库既有中文口径（`feat(recents): …（B305）`）。
- 不写 emoji，图标一律 codicon（`src/shell/codicons.ts` 的 `IDS` 表加名后取 `CODICONS.x`）。
- 名单**不进** `settings.json`（那张表没有权威窗口，整表覆写会互相冲掉）。
- `Settings.recent_files` 空槽保留不动（不用也不删）。
- 退出时仍开着的文件不记；名单绝不关闭别处的标签。
- jsdom 测试跑法：`node scripts/run-vitest.cjs <文件>`（不加 `run` 参数）。
- Rust 测试跑法：`cargo test --manifest-path src-tauri/Cargo.toml`。
- 临时文件只写项目 `.tmp/`。
- 不自动推送、不打 tag、不手动 bump 版本（发布走 `scripts/release.sh`，需用户显式要求）。

## Review Focus

规格隐含、但没有哪个任务的测试天然覆盖、又最可能伤到使用者的输入类：

1. **窗口崩溃 / 被任务管理器结束**（`Destroyed` 不到，那个 label 的集合残留）⇒ 名单不许长期挂着「其实还开着」的文件；活着的窗口下一次上报必须把它剪掉。
2. **同一文件的三种写法**（大小写不同、`\\?\` verbatim 前缀、原始输入路径 vs canonical）⇒ 只占一格，显示用第一次记下的那条。
3. **退出顺序**：先关主窗口再销毁卫星 ⇒ 一个都不记（「退出时仍开着的不算」）。
4. **`recents.json` 被手改坏 / 缺字段** ⇒ 回落默认继续跑，绝不因为名单文件损坏而启动失败。
5. **子窗口里看不见的那块面板**：标题栏整栏键、`toggleToc`、大纲快捷键都还在，但侧栏被 CSS 藏了 ⇒ 不许把隐藏面板「打开」并把开合值写脏设置。

每一行都由某个任务的测试钉住（见各任务 Step 里的「钉 Review Focus #n」）。

---

### Task 1: Rust 名单内核

**Files:**
- Create: `src-tauri/src/session/recent.rs`
- Modify: `src-tauri/src/session/mod.rs`（在文件里加 `pub mod recent;` —— 与既有 `use crate::core::…` 同一段末尾）
- Test: 同文件底部 `#[cfg(test)] mod tests`（仓库既有做法：被测代码与测试同文件，见 `session/mod.rs:389`）

**Interfaces:**
- Consumes: `session::config_dir()`、`session::save_at` 同族的 `atomic_write`（`src-tauri/src/core/atomic_write.rs`）、`commands::normalize_path`（`src-tauri/src/commands/mod.rs:111`）。
- Produces:
  ```rust
  // crate::session::recent
  pub const DEFAULT_LIMIT: usize = 20;
  #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
  #[serde(rename_all = "camelCase")]
  pub struct RecentEntry { pub path: String, pub name: String, pub closed_at: i64 }

  #[derive(Debug, Clone, Serialize, Deserialize)]
  #[serde(default, rename_all = "camelCase")]
  pub struct Recents { pub limit: usize, pub entries: Vec<RecentEntry> }   // entries[0] = 最新

  pub fn recents_path() -> Option<std::path::PathBuf>;
  pub fn load() -> Recents;                       // 缺失/损坏 → { limit: DEFAULT_LIMIT, entries: [] }
  pub fn save(r: &Recents) -> Result<(), String>;
  pub fn file_name_of(path: &str) -> String;      // 取最后一段（\ 与 / 都算分隔符）
  pub fn key_of(path: &str) -> String;            // canonicalize→normalize_path→Windows 小写
  pub fn record_closed(r: &mut Recents, vanished: &[(String, String)], now_ms: i64) -> bool;
  pub fn prune_open(r: &mut Recents, open_keys: &std::collections::HashSet<String>) -> bool;
  pub fn forget(r: &mut Recents, key: &str) -> bool;
  pub fn clear(r: &mut Recents) -> bool;
  pub fn apply_limit(r: &mut Recents, limit: usize) -> bool;
  /// 剔掉磁盘上已经不存在的条目（文件被外部删除/挪走的自愈）。`exists` 注入进来是为了可测。
  pub fn drop_missing(r: &mut Recents, exists: impl Fn(&str) -> bool) -> bool;

  /// 每个窗口「此刻看得见哪些路径」的账。值里同时留 key 与显示路径。
  #[derive(Debug, Default)]
  pub struct OpenSets { map: std::collections::HashMap<String, std::collections::HashMap<String, String>> }
  impl OpenSets {
      pub fn update(&mut self, window: &str, paths: &[String]) -> Vec<(String, String)>; // 返回从并集消失的 (key, display)
      pub fn drop_window(&mut self, window: &str) -> Vec<(String, String)>;
      pub fn union_keys(&self) -> std::collections::HashSet<String>;
  }
  ```
  `record_closed` 的 `vanished` 元组第一项是 key、第二项是显示路径；同 key 已在册 ⇒ 顶到最前并换 `closed_at`，不新增第二条。

- [ ] **Step 1: 写失败的测试（内核行为）**

在 `recent.rs` 底部 `#[cfg(test)] mod tests` 里写：

```rust
#[test]
fn record_closed_puts_newest_first_and_dedupes_by_key() { /* 关 a 再关 b ⇒ [b, a]；再关 a ⇒ 仍两条且 a 在前 */ }

#[test]
fn limit_zero_stops_recording() { /* r.limit = 0；record_closed(...) 返回 false、entries 仍空 */ }

#[test]
fn apply_limit_trims_oldest_off_the_tail() { /* 先记 3 条，apply_limit(2) ⇒ 剩最新两条 */ }

#[test]
fn prune_open_drops_entries_that_came_back() { /* entries 有 a、b；open_keys 含 a ⇒ 只剩 b，返回 true */ }

#[test]
fn windows_paths_differing_only_in_case_or_verbatim_prefix_share_one_entry() {
    // key_of(r"\\?\C:\Dir\A.md") == key_of(r"c:\dir\a.md") == key_of(r"C:\Dir\A.md".to_lowercase().as_str() 的小写形)
    // 且 record_closed 用第二种写法关掉时，第一条（第一种写法）被顶前而非新增
}

#[test]
fn open_sets_reports_vanished_only_when_the_last_window_loses_it() {
    // main 报 [a]、sat-1 报 [a, b] ⇒ update 返回空
    // main 再报 [] ⇒ a 仍在 sat-1 里 ⇒ 不返回 a；sat-1 报 [] ⇒ 返回 [a, b]
}

#[test]
fn drop_window_reports_only_paths_no_other_window_has() { /* main=[a], sat-1=[b]; drop_window("sat-1") ⇒ 只返回 b */ }

#[test]
fn drop_missing_removes_gone_files_and_reports_the_change() { /* a 在、b 不在 ⇒ 只剩 a，返回 true；全在 ⇒ 返回 false */ }

#[test]
fn recents_serde_uses_camel_case_and_defaults_when_fields_missing() {
    // r#"{"limit":5,"entries":[{"path":"a.md","name":"a.md","closedAt":17}]}""# 读得进 closed_at；
    // "{}" 读成 limit=DEFAULT_LIMIT；落盘串含 "closedAt" 不含 "closed_at"
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml session::recent`
Expected: 编译失败（`recent` 模块不存在 / 未定义项）。

- [ ] **Step 3: 实现内核**

`key_of` 的实现口径必须是：`crate::commands::normalize_path(std::fs::canonicalize(p).unwrap_or(PathBuf::from(p)))`，再 `to_string_lossy()`，Windows 上 `.to_lowercase()`（`#[cfg(windows)]`）。canonicalize 失败（文件已被外部删除）退回原串，条目照样能记账。
`load()` 的容错口径照 `session/mod.rs:148` 的 `load()`：读不到/解析失败都记一条 warn 后回落默认，绝不 Err 出去。
`save()` 走 `atomic_write`（同 `save_at:184`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml session::recent`
Expected: `test result: ok. 11 passed`（实际落地 11 条：计划 8 条 + `forget`/`clear` 变更回报 + `file_name_of` 分隔符两档）

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/session/recent.rs src-tauri/src/session/mod.rs
git commit -m "feat(recents): 名单内核 · 从可见集合推导「刚关掉」＋上限与去重（B305）"
```

---

### Task 2: Rust 状态、IPC 命令、退出旗标与窗口销毁接线

**Files:**
- Create: `src-tauri/src/commands/recents.rs`
- Modify: `src-tauri/src/commands/mod.rs`（加 `pub mod recents;`；`AppState` 结构体 `:30-34` 加三个字段）
- Modify: `src-tauri/src/main.rs`（`:85` 附近的 `manage`、`:89-117` 的 `on_window_event`、`:208-240` 的 `invoke_handler`、`:243-251` 的 `.run`）
- Test: `tests/recents-contract.test.ts`（新建；jsdom 静态契约，覆盖「前端调用的命令名必须真在 Rust 注册表里」这类只在两侧都改才会绿的形状）

**Interfaces:**
- Consumes: Task 1 的全部 `session::recent::*`。
- Produces:
  ```rust
  // AppState 新增
  pub recents: Mutex<session::recent::Recents>,
  pub open_sets: Mutex<session::recent::OpenSets>,
  pub quitting: std::sync::atomic::AtomicBool,

  // crate::commands::recents —— 全部 #[tauri::command]
  pub fn sync_open_paths(window: tauri::Window, app: tauri::AppHandle, state: State<'_, AppState>, paths: Vec<String>) -> Vec<session::recent::RecentEntry>;
  pub fn list_recents(app: tauri::AppHandle, state: State<'_, AppState>) -> Vec<session::recent::RecentEntry>;
  pub fn forget_recent(window: tauri::Window, app: tauri::AppHandle, state: State<'_, AppState>, path: String) -> Vec<session::recent::RecentEntry>;
  pub fn clear_recents(window: tauri::Window, app: tauri::AppHandle, state: State<'_, AppState>) -> Vec<session::recent::RecentEntry>;
  pub fn get_recent_limit(state: State<'_, AppState>) -> usize;
  pub fn set_recent_limit(window: tauri::Window, app: tauri::AppHandle, state: State<'_, AppState>, limit: usize) -> usize;
  ```
  事件名 `recents-changed`，载荷 `{ entries: RecentEntry[] }`（Task 3 在 `events.ts` 里定名）。
  内部一律经一个私有收口 `fn publish(app: &tauri::AppHandle, state: &AppState) -> Vec<RecentEntry>`：**落盘 + 广播 + 回传当前条目**三件事同处，任何改动名单的命令都只走它。窗口身份取 `window.label()`（Rust 侧自证，不接受前端传 `from`）。

- [ ] **Step 1: 写失败的静态契约测试**

`tests/recents-contract.test.ts`（`// @vitest-environment jsdom` 不必，用 `readFileSync`；照 `tests/repo-hygiene.test.ts` 的读文件方式）：

落地为四条（`between(src, start, end)` 这个取段小工具是必要的：找不到起点/终点就直接抛，**别让断言对着空串自娱自乐** —— 用 `indexOf` 裸切 + `slice(0, 400)` 那种写法，needle 一漂测试就无声变绿）：

1. 六条命令名都在 `generate_handler![…]` 里（`recents::sync_open_paths` 这种全名，不是裸名）。
2. `on_window_event` 里：主窗口分支含 `mark_quitting`，卫星分支含 `on_window_destroyed`，整段不含 `unwrap_state`。
3. `.run(|…|)` 兜底：含 `ExitRequested` 且含 `mark_quitting`。
4. `commands/recents.rs` 里 `on_window_destroyed` 与 `sync_open_paths` 两个函数体内 **`prune_open` 的位子都排在 `record_closed` 之前**，且广播名串是 `"recents-changed"`。

Run: `node scripts/run-vitest.cjs tests/recents-contract.test.ts`
Expected: FAIL（四条全红）。

- [ ] **Step 2: 加 `AppState` 三字段与 setup 装载**

`AppState` 派生 `Default` 已有；`recents` 字段需要盘上的值，所以在 `setup(|app| …)` 里把原先的 `app.manage(AppState::default())`（找不到就 grep `manage(AppState`）换成 `app.manage(AppState { recents: Mutex::new(session::recent::load()), ..Default::default() })`。`DEFAULT_LIMIT` 由 `Recents::default()` 给（Task 1 里给它写 `impl Default`：`limit: DEFAULT_LIMIT`）。

- [ ] **Step 3: 实现 `commands/recents.rs`**

要点：
- `sync_open_paths`：`update(window.label(), &paths)` → `prune_open(&mut r, &open_sets.union_keys())` → `if !quitting { record_closed(&mut r, &vanished, now_ms) }` → 任一为真则 `publish`。**顺序必须是先 prune 后 record**：同一轮里「这个窗口刚关掉、另一个窗口报上来它其实还开着」的路径不该进名单（prune 与 record 都对着同一份并集，先剪后记才不会自相矛盾）。
- `forget_recent` / `clear_recents` / `set_recent_limit` 各自改完后 `publish`（`set_recent_limit` 广播前先 `apply_limit`）。
- `list_recents`：先 `session::recent::drop_missing(&mut r, |p| std::path::Path::new(p).exists())`（Task 1 那个注入式纯函数），剔掉了就走 `publish`（落盘 + 广播），然后返回 `entries.clone()`。这是「文件被外部删除/挪走 ⇒ 自动不见」的唯一出口，渲染端不再判存在性（渲染端多判一次，就多一处与 Rust 不一致的机会）。
- `publish`：`session::recent::save` 失败只记 `logging::log(Level::Warn, "recents", …)`（与 `session::save` 同口径：**写盘失败不许把界面卡住**），仍返回条目并 `app.emit("recents-changed", …)`。
- 时间戳：`std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64`。

- [ ] **Step 4: 接 `on_window_event` 与 `RunEvent::ExitRequested`**

`main.rs:99-107` 主窗口分支：在既有 `emit("app-quit")` **之后**调 `commands::recents::mark_quitting(state)`（不剪名单、不记录）。放后面是有意省事的：旗标只需赶在任何卫星 `Destroyed` 之前立起来，而这两句都在同一个同步分支里、卫星销毁事件必然更晚到；放前面会把 `tests/satellite-lifecycle.test.ts:336` 那条「MAIN_LABEL 之后 400 字内要出现 app-quit」的既有契约挤断 —— 那种字符预算契约一插代码就断，是评审时该看见的味道，但本轮不改它。
`:109-116` 卫星分支：`reg.forget_pending(…)` 之后调 `commands::recents::on_window_destroyed(&app, state, win.label())`（内部按 `drop_window` → 剪枝 → 记录 → `publish` 走，与 `sync_open_paths` 同一口径）。拿状态一律 `try_state`（窗口事件可能早于 manage，`unwrap_state` 会把进程 panic 在关窗那一刻）。
`.run(|app, event| …)`（`:243`）里在既有 `RunEvent::Exit` 那条旁加 `RunEvent::ExitRequested { .. }` ⇒ 立 `quitting`（这是 updater `relaunch()` 与主窗口被强杀两条路的兜底）。

- [ ] **Step 5: 跑测试确认通过**

Run: `node scripts/run-vitest.cjs tests/recents-contract.test.ts` → PASS
Run: `cargo test --manifest-path src-tauri/Cargo.toml` → 全绿（新增代码不许破坏既有用例）
Run: `npm run typecheck` → PASS

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/commands/recents.rs src-tauri/src/commands/mod.rs src-tauri/src/main.rs tests/recents-contract.test.ts
git commit -m "feat(recents): Rust 单点持名单 · 窗口销毁推导「刚关掉」＋退出旗标（B305）"
```

---

### Task 3: 前端 IPC 层与事件名

**Files:**
- Modify: `src/ipc/api.ts`（在 `Settings` 之后、`newTab` 之前插入类型与函数）
- Modify: `src/core/events.ts`（文件末尾加事件与载荷）
- Test: `tests/recents-ipc.test.ts`（新建；mock 方式照 `tests/ipc-api.test.ts` 对 `@tauri-apps/api/core` 的 `vi.mock`）

**Interfaces:**
- Consumes: Task 2 的六个命令名。
- Produces:
  ```ts
  // src/ipc/api.ts
  export interface RecentEntry { path: string; name: string; closedAt: number }
  export function listRecents(): Promise<RecentEntry[]>;
  export function syncOpenPaths(paths: string[]): Promise<RecentEntry[]>;      // invoke("sync_open_paths", { paths })
  export function forgetRecent(path: string): Promise<RecentEntry[]>;          // invoke("forget_recent", { path })
  export function clearRecents(): Promise<RecentEntry[]>;
  export function getRecentLimit(): Promise<number>;
  export function setRecentLimit(limit: number): Promise<number>;              // 回包 = 生效后的上限

  // src/core/events.ts
  export const EVT_RECENTS_CHANGED = "recents-changed";
  export interface RecentsChangedPayload { entries?: RecentEntry[] }           // import type { RecentEntry } from "../ipc/api"
  ```
  `events.ts` 目前是零 import 的文件；`api.ts` 只 import `@tauri-apps/*`，所以这条 type-only 依赖不会成环（若 ESLint 的 import 规则报环，就把载荷接口挪到 `api.ts` 并从 `events.ts` re-export 删除，**不许**复制一份字段）。

- [ ] **Step 1: 写失败的测试**

`tests/recents-ipc.test.ts`：断言六个函数把正确的命令名与参数键发出去（`expect(invokeMock).toHaveBeenCalledWith("sync_open_paths", { paths: ["a.md"] })` 这种形式，逐个命令一条），并断言 `EVT_RECENTS_CHANGED === "recents-changed"` 且该串出现在 Task 2 的 `publish` 里：

```ts
it("事件名与 Rust 侧 emit 的字符串同一份（跨语言拼错就是静默失效）", () => {
  expect(EVT_RECENTS_CHANGED).toBe("recents-changed");
  const rust = readFileSync("src-tauri/src/commands/recents.rs", "utf-8");
  expect(rust, "Rust 侧没广播 recents-changed").toContain(EVT_RECENTS_CHANGED);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/run-vitest.cjs tests/recents-ipc.test.ts`
Expected: FAIL（`listRecents` 等未导出）。

- [ ] **Step 3: 实现 api.ts / events.ts 增量**

函数一律照 `api.ts` 既有薄包装写法（`export function x(): Promise<T> { return invoke<T>("cmd", { … }) }`），每个带一行注释说明回包语义：**改过名单的三条命令回包都是「变更后的完整名单」**，视图端因此可以直接拿回包重画，不必再 `list` 一次。

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/run-vitest.cjs tests/recents-ipc.test.ts && npm run typecheck`
Expected: 双双 PASS

- [ ] **Step 5: 提交**

```bash
git add src/ipc/api.ts src/core/events.ts tests/recents-ipc.test.ts
git commit -m "feat(recents): 前端 IPC 薄包装与 recents-changed 事件（B305）"
```

---

### Task 4: 前端 store 与可见路径上报

**Files:**
- Create: `src/recents/store.ts`
- Modify: `src/ui.ts`（`broadcastDocPresence` `:269-285` 末尾加一行上报）
- Test: `tests/recents-store.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 的 `listRecents` / `syncOpenPaths` / `forgetRecent` / `clearRecents` / `getRecentLimit` / `setRecentLimit`、`EVT_RECENTS_CHANGED`；`src/core/app-state.ts` 的 `tabs`、`docs`。
- Produces:
  ```ts
  // src/recents/store.ts
  export function initRecentsStore(): Promise<void>;                     // 首帧 list + 装监听（子窗口不调）
  export function getRecents(): RecentEntry[];
  export function getRecentLimit(): number;
  export function onRecentsChange(cb: (entries: RecentEntry[]) => void): () => void;
  export function visibleOpenPaths(): string[];                          // 本窗口 panelId >= 0 的实例的 doc.path，空串不算
  export function syncVisiblePaths(): void;                              // 与上次上报的集合不同才发 IPC；回包写进缓存
  export function forgetRecentEntry(path: string): Promise<void>;
  export function clearRecentEntries(): Promise<void>;
  export function applyRecentLimit(limit: number): Promise<number>;
  ```
  `syncVisiblePaths` 的 diff 基准是 `Set<string>`（原始路径串），与 `broadcastDocPresence` 里 `lastBroadcastDocIds` 同一手法；没变就一个 IPC 都不发（`refreshAll` 触发得非常频繁，每次都发会把 IPC 打爆）。

- [ ] **Step 1: 写失败的测试**

`tests/recents-store.test.ts`（`// @vitest-environment jsdom`，`vi.mock("../src/ipc/api")`，用 `src/core/app-state.ts` 的 setter 造标签/文档）：

```ts
it("可见集合没变 ⇒ 一次 IPC 都不发", ...)                 // 连调两次 syncVisiblePaths，expect syncOpenPaths 调用 1 次
it("关掉最后一格 ⇒ 上报的集合少一条", ...)                 // 移除实例后再 sync，断言 paths 数组内容
it("未命名（空 path）不进集合", ...)
it("隐藏实例（panelId < 0）不进集合", ...)                 // 这条钉 Review Focus #1 的另一半：外借给卫星的格子不该算「还开着」
it("回包写进缓存并通知订阅者", ...)
it("recents-changed 广播换掉缓存并通知订阅者", ...)
it("applyRecentLimit 用回包数更新上限（Rust 才是权威）", ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/run-vitest.cjs tests/recents-store.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 store.ts**

`initRecentsStore` 装监听用 `listen<RecentsChangedPayload>(EVT_RECENTS_CHANGED, …)`，`catch` 掉（非 Tauri 环境/测试里拿不到事件总线，行为与 `src/multiwindow/windows.ts` 既有监听一致）。回调集合用 `Set<listener>`，返回的反注册函数从集合里删。

- [ ] **Step 4: 把上报挂进 `broadcastDocPresence`**

在 `src/ui.ts:284`（`lastBroadcastDocIds = now;`）之后加一行 `syncVisiblePaths();`，并把它写进 ui.ts 顶部的 import。注释要交代：名单不自己找关闭点，**靠这里**（可见集合变化的唯一广播点，开标签走 `refreshAll`、关标签走 `closeTabById`，两条都覆盖）。

- [ ] **Step 5: 加静态契约测试（挂点不许漂走）**

在 `tests/recents-contract.test.ts` 追加：

```ts
it("可见路径上报只挂在 broadcastDocPresence 这一处", () => {
  const ui = readFileSync("src/ui.ts", "utf-8");
  const b = ui.slice(ui.indexOf("function broadcastDocPresence("));
  expect(b.slice(0, 1200)).toContain("syncVisiblePaths()");
  const files = readFileSync("src/io/files.ts", "utf-8");
  expect(files, "打开流程里不许再各写一遍上报").not.toContain("syncOpenPaths");
});
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node scripts/run-vitest.cjs tests/recents-store.test.ts tests/recents-contract.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/recents/store.ts src/ui.ts tests/recents-store.test.ts tests/recents-contract.test.ts
git commit -m "feat(recents): 前端视图缓存 · 可见路径上报并入 broadcastDocPresence（B305）"
```

---

### Task 5: 侧栏结构与样式 · 子窗口去左边栏

**Files:**
- Modify: `index.html`（`#side-bar` 内加第二颗键；`</aside>` 之后加 `#recent-panel`）
- Modify: `src/shell/codicons.ts`（`IDS` 加 `history: "history"`、`trash: "trash"`）
- Modify: `src/styles/global.css`（新增 `.recent-*` 一组；`:590` 那条 satellite 规则附近加子窗口隐藏左栏）
- Modify: `src/ui.ts`（`el()` 取新 id：`sideRecent`、`recentPanel`、`recentList`、`recentCount`、`recentClear`、`tocHead` 不动）
- Test: `tests/recents-contract.test.ts`（追加静态用例）

**Interfaces:**
- Consumes: 既有 `#side-shell` / `#side-bar` / `is-collapsed` 结构约定（`src/toc.ts:184-201`）。
- Produces（DOM id 与类名是后续任务的契约）：
  `#side-recent`（`.side-btn`，`data-tip="最近打开"`，`aria-pressed`）、`aside#recent-panel.recent-panel`（内含 `#recent-head`、`#recent-title`、`#recent-count`、`#recent-clear`、`#recent-list`）、行 `.recent-row[.recent-name/.recent-dir/.recent-del]`、空态 `.recent-empty`。
  CSS 侧新增 `html[data-window-kind="satellite"] #side-shell, html[data-window-kind="satellite"] #side-resizer, html[data-window-kind="satellite"] #sidebar-toggle { display: none }`。

- [ ] **Step 1: 写失败的静态测试**

追加到 `tests/recents-contract.test.ts`：

```ts
it("侧栏结构与 id 齐备", () => {
  const html = readFileSync("index.html", "utf-8");
  for (const id of ["side-recent", "recent-panel", "recent-head", "recent-count", "recent-clear", "recent-list"]) {
    expect(html, `缺 #${id}`).toContain(`id="${id}"`);
  }
  expect(html.indexOf('id="side-recent"')).toBeGreaterThan(html.indexOf('id="side-outline"')); // 第二颗键排在大纲之后
});

it("子窗口隐藏整条左栏 + 标题栏那颗左栏键（Review Focus #5）", () => {
  const css = readFileSync("src/styles/global.css", "utf-8");
  for (const sel of ["#side-shell", "#side-resizer", "#sidebar-toggle"]) {
    expect(css, `子窗口没隐藏 ${sel}`).toContain(`html[data-window-kind="satellite"] ${sel}`);
  }
});
```

Run: `node scripts/run-vitest.cjs tests/recents-contract.test.ts` → FAIL

- [ ] **Step 2: 写 HTML 结构**

`#side-bar` 里复制 `#side-outline` 那颗按钮的形状加 `#side-recent`（`class="side-btn"`、`type="button"`、`data-tip="最近打开"`、`data-tip-placement="right"`、`aria-label="最近打开"`、`aria-pressed="false"`，不带文字内容，字形由 JS 填）。
`#toc-panel` 的 `</aside>` 之后加：

```html
<aside id="recent-panel" class="recent-panel" hidden>
  <div id="recent-head" class="recent-head">
    <span id="recent-title" class="recent-title">最近打开</span>
    <span id="recent-count" class="recent-count">0/20</span>
    <button id="recent-clear" class="toc-head-btn" type="button" data-tip="清空全部" aria-label="清空全部"></button>
  </div>
  <div id="recent-list" class="recent-list"></div>
</aside>
```

注释照 B205 那条纪律写一句：标题栏是静态结构、列表才重绘，`renderRecents` 只清 `#recent-list`。

- [ ] **Step 3: 写样式**

`.recent-panel` 与 `.toc-panel` 同处一块展开区、互斥可见。行：`.recent-row` 34px 两行结构（`.recent-name` 常规色、`.recent-dir` 取 `--muted` 同档的淡色并 `text-overflow: ellipsis`）、`.recent-del` 默认 `visibility: hidden` 悬停行时可见（照 `global.css:487` 那颗 `.panel-op` 的写法口径，**不要**新造一档悬停色）、`.recent-empty` 淡色居中。全部走 CSS 变量，不许硬编码颜色（明暗两套主题都要成立）。

⚠️ **宽度必须跟着分隔条**（自检时抓到的真缺口）：抽屉宽度不是 CSS 变量，而是 `attachSideResizer(tocResizer, tocPanel, …)`（`src/toc.ts:66`）**内联写在 `#toc-panel` 的 `style` 上**的。只加 HTML 不动这一处，用户拖完分隔条再点开「最近打开」，看到的是一块宽度回到默认的抽屉 ⇒ 观感上像宽度设置丢了。做法：`toc.ts` 的 `onChange`（`:77-84`）里把宽度同时写进两块面板（经一个 `applyDrawerWidth(px)` 的小出口，两处共用一个写入点，不许各写一半）。

- [ ] **Step 4: 跑测试确认通过 + 格式与构建不破**

Run: `node scripts/run-vitest.cjs tests/recents-contract.test.ts` → PASS
Run: `npm run format:check` → PASS（新写的 CSS/HTML 要先 `npm run format`）
Run: `npm run build` → PASS

- [ ] **Step 5: 提交**

```bash
git add index.html src/ui.ts src/shell/codicons.ts src/styles/global.css tests/recents-contract.test.ts
git commit -m "feat(recents): 侧栏第二颗键与面板结构 · 子窗口收掉整条左栏（B305）"
```

---

### Task 6: 面板行为

**Files:**
- Create: `src/recents/panel.ts`
- Modify: `src/toc.ts`（`:266` 的 `export { … }` 清单确认含 `setSideOpen`；`toggleToc` 加子窗口空转）
- Modify: `src/core/app-state.ts`（若 `windowKind` 需要读口，直接用既有 `export let windowKind`）
- Test: `tests/recents-panel.test.ts`（新建）

**Interfaces:**
- Consumes: Task 4 的 `getRecents` / `onRecentsChange` / `getRecentLimit` / `forgetRecentEntry` / `clearRecentEntries`；Task 3 的类型；`src/io/files.ts` 的 `doOpen(path)`（`doOpen` 第二/三参可选）；ui.ts 的 DOM 引用。
- Produces:
  ```ts
  export function setupRecentsPanel(): void;         // 装字形、两颗键的点击、#recent-list 的事件委托；主窗口专用
  export function setRecentOpen(open: boolean): void;// #recent-panel 显隐的唯一出口：hidden + 按钮 is-on/aria-pressed 三处同源
  export function toggleRecentPanel(): void;
  export function renderRecents(): void;             // store 变化驱动；只清 #recent-list
  export function relativeTime(closedAt: number, now?: number): string;
  export function dirOf(path: string): string;       // 去掉最后一段的目录，用于行二
  ```
  互斥：`setRecentOpen(true)` 内调 `setSideOpen(false)`；`toggleToc()` 打开大纲时调 `setRecentOpen(false)`（经 toc.ts → panel.ts 的 import；若形成环，由 `main.ts` 把两个出口对穿接线，**不许**在 panel 里复制一份显隐逻辑）。
  `relativeTime` 的六档文案（钉进测试）：`刚刚`、`N 分钟前`、`N 小时前`、`昨天 HH:mm`、`M月D日 HH:mm`、`YYYY年M月D日`。
  行的悬停信息用既有提示层：`data-tip` = 完整路径，`data-tip-detail` = `relativeTime(...)`（需要 `initTooltips` 的委托，main.ts 已在启动早期装好）。

- [ ] **Step 1: 写失败的测试**

`tests/recents-panel.test.ts`（jsdom；fixture 里先按 `index.html` 的结构建出 `#side-shell`/`#side-bar`/`#toc-panel`/`#recent-panel` 各节点，再 `vi.mock` store 与 `../src/io/files`）：

```ts
it("点「最近打开」⇒ 面板打开且大纲关掉（互斥）", ...)
it("大纲打开时点它 ⇒ 最近打开收起来", ...)
it("一行两截：主行文件名、次行目录", ...)          // .recent-name / .recent-dir
it("悬停属性带完整路径与相对时间", ...)             // data-tip / data-tip-detail
it("计数显示「n/limit」", ...)                      // 3 条 + limit 20 ⇒ "3/20"
it("上限 0 时空态文案是「已停止记录（上限为 0）」", ...) // 钉 Review Focus：0 档必须有解释
it("非空时没有条目 ⇒ 「还没有关掉过的文件」", ...)
it("点一行 ⇒ 用该路径调 doOpen", ...)
it("点 ✕ ⇒ 只清那一条（forgetRecentEntry 收到该路径）", ...)
it("点 🗑 ⇒ 清空且随后列表区是空态", ...)
it("子窗口里 toggleToc / toggleRecentPanel 都空转（Review Focus #5）", ...)
it("relativeTime 六档", ...)                         // 30s / 5min / 3h / 昨天 / 6月5日 / 2019年1月2日
it("dirOf 两种分隔符与无目录输入", ...)
it("拖过分隔条之后打开最近面板，宽度与大纲一致（Task 5 的宽度缺口）", ...)
   // 给 #toc-panel 的 style.width 设成 320px（模拟 attachSideResizer 的写入），再 setRecentOpen(true)，
   // 断言 #recent-panel 的 style.width 也是 320px —— 这条专防「宽度只写在大纲那块上」。
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/run-vitest.cjs tests/recents-panel.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 panel.ts**

行 DOM 由 `document.createElement` 建（不用 innerHTML 拼用户路径 —— 路径里可能有 `<`，这是 XSS 面）。`renderRecents` 每次重绘后刷新 `#recent-count` 并把 `aria-label` 写成「最近打开，N 条」。
`#recent-list` 上用**事件委托**（一次点击判 `.recent-del` 与 `.recent-row`），别逐行挂监听：行会随广播整批重绘。
子窗口空转的判据是 `windowKind === "satellite"`，两出口共用同一条早退。

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/run-vitest.cjs tests/recents-panel.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/recents/panel.ts src/toc.ts tests/recents-panel.test.ts
git commit -m "feat(recents): 面板行为 · 与大纲互斥、单条/全部清除、点行即开（B305）"
```

---

### Task 7: 设置页上限项与启动装配

**Files:**
- Modify: `src/shell/settingsdialog.ts`（`SettingsDialogOptions` 加一对；`fillPage` 的 `general` 分支加一行；`CATEGORIES[0].keywords` 补关键词）
- Modify: `src/prefs.ts`（`openSettingsDialog` 传新 getter/setter，加 `recentLimit` 缓存与 `setRecentLimitValue`）
- Modify: `src/main.ts`（bootstrap：`initRecentsStore()` + `setupRecentsPanel()` 装配，顺序见 Step 4）
- Test: `tests/recents-settings.test.ts`（新建）+ 既有 `tests/settingsdialog.test.ts` 的 `makeOpts()` 补两个键

**Interfaces:**
- Consumes: Task 3 的 `getRecentLimit` / `setRecentLimit`；Task 4 的 `applyRecentLimit`；Task 6 的 `renderRecents`。
- Produces:
  ```ts
  // SettingsDialogOptions 新增（照 logLevel/onLogLevel 的形状：值不在 settings 对象里，走独立 IPC 即时生效）
  recentLimit: () => number;
  onRecentLimit: (limit: number) => void;
  // src/prefs.ts
  export function refreshRecentLimitCache(): Promise<void>;   // 启动时取一次，填给设置页的同步 getter
  function setRecentLimitValue(limit: number): Promise<void>; // applyRecentLimit → 更新缓存 → renderRecents()
  ```
  设置页那一行用 `numberSelectRow("最近打开保留数量", [0, 10, 20, 50, 100], …)`，说明文案必须写清 0 档语义：`0 = 不再记录，并清空现有名单`。

- [ ] **Step 1: 写失败的测试**

```ts
it("设置页「通用」里有「最近打开保留数量」四档 + 0 档说明", ...)   // 断言 selectRow 的 label 与 options 文案
it("改上限 ⇒ 走 applyRecentLimit(50) 并重画面板计数", ...)          // 触发 onPick，断言 applyRecentLimit 与 renderRecents 各一次
it("getter 读的是缓存，不是 settings 对象", ...)                    // 断言 prefs.ts 源码不含 "settings?.recent_limit"（名单不在那张表里）
it("0 档立即把面板计数变成 n/0 且名单空态是「已停止记录」", ...)     // 经 store 桩
```

Run: `node scripts/run-vitest.cjs tests/recents-settings.test.ts tests/settingsdialog.test.ts`
Expected: 新用例 FAIL；`settingsdialog.test.ts` 因 `makeOpts()` 缺键而 TS 报错。

- [ ] **Step 2: `makeOpts()` 补键**

`tests/settingsdialog.test.ts` 的 `makeOpts()` 加 `recentLimit: () => 20, onRecentLimit: noop`。这是「测试夹具跟着契约走」的正常成本，不许为省事把选项设成可选。

- [ ] **Step 3: 实现设置行与 prefs 缓存**

`fillPage` 的 `general` 分支排在「热退出」之后、「日志级别」之前插入 `numberSelectRow`。`CATEGORIES` 的 `general.keywords` 补 `"最近打开"`, `"历史"`, `"上限"`（顶部搜索按关键词过滤分类，漏了就搜不到）。
prefs 的 setter 里 `await applyRecentLimit(v)` 之后必须 `renderRecents()`（面板标题栏那格计数跟着走），且 `applyRecentLimit` 的 `catch` 只记日志、不回滚 UI（与 `setLevelPersisted` 同口径：内存已切，重启回落旧值是可接受的降级）。

- [ ] **Step 4: main.ts 启动装配**

顺序要求（写进注释）：`loadSettings` → `setupRecentsPanel()` 排在 `setupSideBar()` 之后（两颗键同一列，字形都在这一步装）；`initRecentsStore()` 排在**会话恢复完成之后**（恢复过程会开一批标签，先于恢复就上报会把刚恢复出来的文件当成「已关闭」清掉 —— 实际是反过来：先 list 再 sync 才有正确初值）。子窗口两边都不装：`if (windowKind === "main") { … }`。
另外：`listenDocSync` 里对 `EVT_RECENTS_CHANGED` 不做过滤（它不是 `from`-family 回声，Rust 广播给所有人），但**只有主窗口订阅渲染**（store 的监听只在 main 装）。

- [ ] **Step 5: 跑测试确认通过 + 全量**

Run: `node scripts/run-vitest.cjs tests/recents-settings.test.ts tests/settingsdialog.test.ts` → PASS
Run: `node scripts/run-vitest.cjs` → 全量绿

- [ ] **Step 6: 提交**

```bash
git add src/shell/settingsdialog.ts src/prefs.ts src/main.ts tests/recents-settings.test.ts tests/settingsdialog.test.ts
git commit -m "feat(recents): 设置页保留数量 · 启动装配与上限即时生效（B305）"
```

---

### Task 8: 全量门禁、出包与真机复现

**Files:**
- Modify: `.workbuddy/memory/open-items/backlog.md`（把「窗口零标签时显示最近列表（读法二）」登记为后续）
- Test: 无新增（跑既有门禁）

**Interfaces:**
- Consumes: Task 1–7 全部产出。
- Produces: 一个可安装的新构建 + 一轮真机取证结论。

- [ ] **Step 1: 全量门禁**

```bash
npm run typecheck && npm run lint && npm run format:check
node scripts/run-vitest.cjs
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: 四条全部 PASS（vitest 全量约 78 个文件、1200+ 用例；`cargo test` 0 failed）。

- [ ] **Step 2: 出包**

Run: `bash scripts/build-all.sh`
Expected: 产物生成（安装器路径打印在末尾）。

- [ ] **Step 3: 清日志 + 装新包 + 分步复现**

先按仓库取证纪律清掉旧日志（`%APPDATA%\LitePad\logs\litepad.log`；会话内可用设置页那颗「打开日志文件」确认已空），再装新包启动。给用户的分步指导（一次一轮，逐个场景）：

1. 打开 A、B 两个文件，关掉 A ⇒ 左栏「最近打开」应出现 A，计数 `1/20`。
2. 点名单里的 A ⇒ A 重新打开并从名单消失（它现在开着）。
3. 把 A 再关掉，把 A 拖到子窗口（生成卫星）后**在子窗口**关掉 ⇒ 主窗口名单立刻出现 A，主窗口没有任何标签被关掉。
4. 主窗口与子窗口各开一份 C ⇒ 只在子窗口关掉那一份时 C **不该**进名单（主窗口还开着）。
5. 子窗口里应当看不见左栏（连标题栏那颗左栏键也没有）。
6. 设置里把上限调成 0 ⇒ 名单清空、空态写「已停止记录（上限为 0）」；调回 20 ⇒ 之后关的文件重新记录。

- [ ] **Step 4: 取日志自查**

判据（写死在脑子里的口径：**日志形状优先于本地推测**）：`recents` 段的 `记录=` / `剪除=` 行数与上面六步的手势一一对应；第 3 步的那条 `记录` 必须由卫星 label 触发；第 4 步**不该**出现 C 的 `记录` 行。任何一条对不上，回 Task 1/2 的根本原因调查，不许就地补症状。

- [ ] **Step 5: 登记后续**

把「窗口零标签时显示最近列表（读法二）」写进 `.workbuddy/memory/open-items/backlog.md`。**那个目录不在 git 里**（记忆区，不是仓库文件），所以这一步没有提交 —— 不许为了「有提交才算了」把它塞进 `docs/`。本轮工作到此处结束：不推送、不打 tag、不 bump 版本（发布等用户显式要求）。

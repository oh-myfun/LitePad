# LitePad 贡献者约定

> 团队约定（非契约）。更深的「改代码前必须知道」不变量见 `.workbuddy/memory/ref/architecture-detail.md`，
> 硬性红线目录见 `.workbuddy/memory/rules/index.md`。

## 提交与版本

- **每个交付一个 Conventional Commit**（如 `feat(window): ...`、`fix(tab): ...`、
  `docs(memory): ...`、`test(...): ...`）。
- **发布版本门禁**：每次编译产出发布版本，顺序 `tsc → vite → vitest → cargo build+test → tauri build`。
  质量门 = `.githooks`（pre-commit: prettier/eslint/tsc/cargo fmt；pre-push: 版本守卫 → vitest → cargo test
  → **本地构建并生成 release exe**）+ GitHub `CI`。
- **推送前会本地构建，并产出 `src-tauri/target/release/litepad.exe`**（pre-push 最后一步，
  构建失败直接阻断推送；缺 npm/cargo 才警告跳过）。除了「编译问题别只交给 CI 判」，
  还有个容易忽略的连带作用：界面截图脚本 `scripts/capture-screenshots.py` 的前置正是这个 exe
  —— 走 `release.sh --ci`（跳过本地构建）发布的版本，exe 会停在旧代码上，截图就拍不了。
- **发布只由 `v*` tag 触发**：`bash scripts/release.sh <版本>` 同步四文件版本 → 构建 → tag，
  然后 `git push origin main --follow-tags`。`--ci` 跳过本地全量（tauri build 冷启约 38 分钟）；
  但即使用 `--ci`，随后的推送仍会被 pre-push 拦着本地构建一遍，所以 exe 不会是旧的。

### 版本号何时该动（SemVer + Conventional Commit）

发布工具不缺（release.sh 已能四处同步 + 打 tag + CI 出包），缺的是**触发**。口径：

| 提交类型                                                | 版本位                       |
| ------------------------------------------------------- | ---------------------------- |
| `feat`（含 `feat!`）                                    | MINOR                        |
| `fix` / `perf`                                          | PATCH                        |
| 破坏性变更（`!` / `BREAKING CHANGE`）                   | 1.0.0 前记 MINOR，之后 MAJOR |
| `docs` / `test` / `chore` / `style` / `ci` / `refactor` | 不单独触发，只计入累积       |

触发时机（满足任一即 bump）：

- 距最近 tag 出现**任一 `feat`** → `npm run release minor`
- 或距最近 tag 出现**任一 `fix`** → `npm run release patch`
- 或有效提交（feat/perf/refactor/revert，fix 不计入）累计 **≥10** → `npm run release patch`

⚠️ **同一个 bug 反复修复只算一个版本号**：一次真修之后再跟着两次真机回归，也只认那一个
patch 额度。判据是**去重后的 bug 键**（subject 里的 `B\d+` ticket 号；没有 ticket 号的
fix 各自算一个）。例：修 B213 时来回改三轮 ⇒ 只值一次 patch；若期间还夹过一个 feat，
那次 bump 直接进 minor，patch 额度被一起吃掉，不必再补。

**牙齿**：pre-push 先跑 `scripts/check-version-bump.sh`（排在 vitest 之前，失败得快）——
未达阈值只告警，达阈值**直接阻断推送**并打印该执行的命令；同时校验
`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` 三处版本号必须一致。
确属误报可用 `LITEPAD_SKIP_VERSION_CHECK=1` 绕过。

**CHANGELOG.md**：由 `scripts/gen-changelog.sh` 从 Conventional Commit 自动生成，
`release.sh` 发布时自动刷新并进同一个 release 提交，**不要手改**。

## 测试与验证

- **每个 bug 必须补回归测试、与修复同一提交**，且**改完先反向验证**：把修复还原一次，确认用例真会红
  （运行时 → `tests/smoke.bootstrap.test.ts`；配置/样式 → 对应模块的静态契约用例，如 `tests/findbar.test.ts`；
  Rust wire/序列化 → 内联 `#[cfg(test)] mod tests`）。流程见技能 `litepad-reverse-verify`。
- **反向验证本身也是测试用例**，优先写成 `tests/reverse-verify.test.ts` 里的对照用例：
  把错误写法复刻成一个「退化实现」并断言它**确实坏掉**，再与真实实现的基准用例对照 ——
  两者结果不同，才说明正向用例不是恒真。它不改源码、随 `npm test` 一起跑；
  退化用例须先自证「处理器确实执行了」（如断言 `defaultPrevented`），否则「没人拦」
  与「拦不住」分不开，退化用例会变成恒真的假绿。
- 跨 IPC 的 DTO 命名两侧必须对齐（camelCase），并补一条真实序列化 round-trip 测试锁住字段名。
- 🔍 **取证方式：先读代码和测试，再考虑 CDP / 截图**（B136 立规）。
  **只要能靠源码 + 现有测试用例把 bug 原因推理出来，就不许动用 CDP / 截图取证** ——
  例：会话里存 px 而 px 与行高、文档长度耦合 ⇒ 直接读 `src/main.ts` 的存取链路即可定性。
  CDP / 截图只在**代码与测试都推不出来**时兜底（如交互态 hover 的视觉、真实窗口行为），
  且视觉类问题默认**交给用户本人验证**，不写像素级判图脚本。
  取证踩过的坑写进 `.workbuddy/memory/open-items/`，别重复踩。

## 运行日志（B144）

- **只有一份日志**：`<配置目录>/logs/litepad.log`（`%APPDATA%\LitePad\logs\`；设了
  `LITEPAD_CONFIG_DIR` 就整体迁移，截图/测试隔离照旧生效），超过 2 MB 滚动，留 3 份。
  旧的那份 `%TEMP%\litepad-app.log` 与 `%TEMP%\litepad-smoke.log` 已停写（`smoke_log`
  改为转发进日志系统）；再新加日志通道等于重犯「出问题不知道翻哪个文件」。
- **级别五档**：`error` < `warn` < `info` < `debug` < `trace`（数值越小越严重）。
  发布版默认 `info`，`debug` 构建默认 `debug`；可在控制台 `await setLogLevel("debug")`
  临时打开（会写进 `settings.json`，重启后仍生效）。**不提供界面入口**。
- **前端调用一律走 `src/core/logger.ts` 的 `logger.<level>(target, detail)`**，
  `target` 是模块名（`session` / `save` / `preview` / `window` …）。
  ⚠️ 两条硬约束：① `log()` **不许 await**（关窗回调里 await 任何 IPC 会死锁，B135）；
  ② 级别以后端为准，`syncLevel()` 抓不到就按默认 info，绝不能反过来卡住启动。
- **失败不许静默**：任何 `catch` / `let _ =` 直接吞掉的分支，都要留一条日志
  （后端 `logging::log`，前端 `logger.*`）。「静默吞掉」是 B143、B144 反复复现的坑 ——
  它让「会话一次都没落下去」这类问题只能靠猜。
- **成功也要留痕**（B147）：只在失败时记日志，界面上「写成功了」和「压根没写」长得一模一样
  —— 后端 `session_path()` 拿不到配置目录时是直接 `Err` 出去、一行字不写的那一类。
  所以会话的读写两端都记 debug：落盘成功 / 读盘成功各一条，带面板数、标签数、文件路径。
- **可观测性有静态契约**（B147，`tests/session-trace.test.ts`）：会话链路上的每一个
  `catch` 都必须留下痕迹（直接 `logger.*`，或把「跳过谁、为什么」攒进 `dropped`
  收尾一起打），每一个关键时机都要有埋点。日志在 jsdom 里抓不住，盯的是代码形态；
  用例自带反向验证（删掉日志必须变红）。

## 会话链路（B141 / B147）

- **会话修改 → 保存 → 恢复三步的埋点分工**（B147）：
  ① 修改 —— `scheduleSessionSave` 记「卫星窗口跳过 / 防抖重排 / 800ms 到点」；
  ② 保存 —— `snapshotSession` 打载荷摘要（含被 `sessionWorthy` 拦下的标签与理由），
  `persistSession` 在**写出前**再记一份，失败时才有「本来要写的是什么」可对；
  ③ 恢复 —— `restoreSession` 记读盘结果、布局树解析失败、预取跳过、**恢复完成结论**
  （打开几个 / 跳过几个及原因）。缺一环，日志就断成一段没有上下文的序列。
- **「标签没进会话」必须给理由，不能只给 `false`**（B147）：`sessionRejectReason(t)`
  单独返回拒绝原因（无路径且无副本 / 热退出未开 / 无路径且脏 / 文档已不存在），
  `sessionWorthy` 只是它 `=== null`。用户报「我的标签重启后没了」时，日志上要能
  一眼看出是哪种成因 —— 以前三种情况长得一模一样。
- ⚠️ 载荷摘要要限长（`sessionSummary` 只打前 8 个标签）：一行几十 KB 会把 2MB 的
  日志冲掉，反而更难查。

## 自家数据文件不参与「外部修改」（B150）

- **配置目录内的文件（`session.json` / `settings.json` / `backups` / `logs`）一律不监听**
  （`commands::watch_file` 里按 `session::config_dir()` 过滤，判断逻辑在 `is_self_owned_path`）。
- ⚠️ 起因：`session.json` 同时是「LitePad 的数据文件」和「可以被当标签打开的普通文件」。
  一旦被监听，我们**自己写会话**就会激起 `file-changed`，前端把它当成「外部修改了用户打开的
  文件」—— 启动收尾那句 `persistSession()` 足以让「打开 `session.json` 后每次启动都弹
  「`session.json` 已在外部被修改，已自动载入最新内容」，顺手把编辑器里那份覆盖成会话快照」。
  数据文件被自己的写入误判成外部修改，根源就是监听了它 ⇒ 在源头掐断（前端收不到事件），
  比在前端逐个加例外干净。
- 判定用 `Path::starts_with`（**组件级**前缀，不是字符串前缀）：`…\LitePadPlus\session.json`
  不会被算成 `…\LitePad` 的自家文件。⚠️ 别拿 `cfg.join("..")…` 拼路径来断言这条 ——
  `starts_with` 不做 `..` 归一化，那样会写出假绿的用例。
- 取舍：外部（别的编辑器）改了 `session.json` 也不会再提示，下次会话保存仍会覆盖它。
  这是有意的 —— 它是 LitePad 的私有数据，不是用户文档。
## 同源多实例（B149）

- **同一文件打开多份时，光标与滚动位置默认不互相关联**（用户拍板，`tests/multi-instance-scope.test.ts`
  把这条基线钉住）：`syncDocInstances` 只派发 `{ changes }`（纯文本），光标 / 视口 / 视图模式
  各实例各归各的。
- ⚠️ **同步滚动模式（B152）已在重构中整体清除**（`sync-scroll.ts` / 位置记忆 / 跨窗广播均已删除）：
  标题栏那颗键保留可见但 **inert**，点击只翻转 `docSyncModes` 与自身字形，不产生任何联动。
  `docSyncModes` 现在只是这颗键的状态存储（随会话 / 卫星标签载荷搬运点亮态），不是待恢复的功能开关。
- 「同源」只到文本这一层就够：两份实例的光标互不干涉，用户完全可以一边看代码一边
  对照预览翻到不同位置 —— 那正是同文件多实例的用途（B130 的恢复口径同源）。

## README 与文档

- **README 使用者向**：开头只放一张 `main.png`；不写快捷键/安装/构建/明确不做，避开库名与内部机制；
  技术细节留 `docs/` 与代码注释。
- **界面改动必须刷新 `docs/screenshots/`，同一提交**；不影响观感在提交信息注明。
- ⚠️ `docs/*.md` 是说明不是契约，**改语义必须同步改清单/状态表**（B67 守卫）。

## 临时文件

- 📁 **临时文件一律落本项目内** `E:\Project\LitePad\.tmp\`（已进 ignore 链），禁止写全局目录
  `%TEMP%`、Git Bash 的 `/tmp`（= `%TEMP%`，非 `E:\tmp`）、`~/.workbuddy/`（除 memory/skills）。
  例外（是工具链非临时文件，别搬）：`~/.workbuddy/binaries/**`、Playwright chromium、msys2、cargo。

## 状态与视图边界

- **状态归 Rust、视图归前端**；内存文本一律 LF，落盘还原原行尾。
- 增删一个「可放任意内容」的目录时，必须同步所有全仓枚举型清单
  （`.gitignore` / `.prettierignore` / eslint `ignores` / `tsconfig.include` / 测试里的 `SKIP_DIRS`），
  否则探针会误伤无关守卫。
## 视口位置（已移除）

⚠️ **本节描述的整套机制（位置记忆 / 还原）已随同步滚动重构整体删除**：`pinScrollTop` /
`recordScroll` / `rememberViewScroll` / `measureAndKeepScroll` / `restoringViewport` /
`restoreViewScroll` / `clearPendingSync` / `t.scrollTop` 像素槽 / CM6 测量补偿收尾
（B134 / B139 / B142 / B145 / B146 / B148 / B151 那一路）全部不复存在，别再到代码里找它们。

现状：滚动位置只活在 DOM 上，切标签 / 重建布局后**不再记忆与还原**；预览侧只保留
按源行号的本地定位（大纲跳转 / 转到行，`PreviewPane.syncToLine`）。会话只落光标
（`cursor_line` / `cursor_col`），重启后保证光标可见，不恢复滚动位置。

若将来要重做「位置记忆」，这是全新设计（用户已明确「换个思路」），不要参照本节旧口径。

## 图标

- **所有按钮图标一律用 VS Code codicon**：依赖官方 npm 包 `@vscode/codicons`（版本在
  `package.json` 里**钉死**，字形跨版本会变），样式由 `src/main.ts` 引入
  `@vscode/codicons/dist/codicon.css`（必须排在本项目样式之前，详见那里注释）。
- 取用一律走 `src/shell/codicons.ts` 的 `CODICONS.<name>` / `CODICONS[name]`
  （给出 `<i class="codicon codicon-<id>"></i>`），**不得在消费方写死字形或码位**。
  加一颗图标就在 `codicons.ts` 的 `IDS` 里加一条，并给它一个真实调用点。
- 尺寸默认由官方样式统一给 16px；要别的尺寸就在 CSS 里改 `.codicon` 的 `font-size`
  （例：`.panel-op .codicon { font-size: 15px }`），不要给 svg 写 width/height——已经没有 svg 了。
- **禁止手绘 SVG 充当图标**。codicon 里确无合适字形时，**先与用户商量**是否引入别的图标集，
  不得自行绘制、临时拼一个或改字号凑数。
- 想浏览全部 639 颗字形：打开 `node_modules/@vscode/codicons/dist/codicon.html`。

## 范围（明确不做）

不做：插件商店、内置终端、Git 集成、LSP。

## 快捷键预设

支持 default / Notepad++ / VS Code 三档预设；优先级：用户覆盖 > 预设 > 默认。

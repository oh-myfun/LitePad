# LitePad 贡献者约定

> 团队约定（非契约）。更深的「改代码前必须知道」不变量见 `.agents/ref/architecture-detail.md`，
> 硬性红线目录见 `.agents/rules/index.md`。

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
  然后分两条推送 —— `git push origin main`，再 `git push origin v<版本>`（只推当版那一枚；
  整串带上去会把历史漏推的旧 tag 也推醒，每个旧 tag 都触发一次 Release 去抢 Latest）。
  `--ci` 跳过本地全量（tauri build 冷启约 38 分钟）；
  但即使用 `--ci`，随后的推送仍会被 pre-push 拦着本地构建一遍，所以 exe 不会是旧的。

### 版本维护规则（用户 2026-10-18 定）

| 改动性质                                        | 谁决定   | 动作                                                      |
| ----------------------------------------------- | -------- | --------------------------------------------------------- |
| 每次修改（碰产品代码 `src/`、`src-tauri/src/`） | **自动** | 交付时自动 `+patch`，不必征询（同一 bug 多轮只算一档）    |
| 较大改动（`feat`）                              | **用户** | 先问「是否推进 minor」，同意才 `scripts/release.sh minor` |
| 非兼容的大型改动（`!` / `BREAKING CHANGE`）     | **用户** | 先问「是否推进 major」，同意才 `scripts/release.sh major` |

要点：

- **判档权在人，不在工具**。旧的「`feat` 自动算 minor」「有效提交满 10 自动算 patch」
  **已废弃** —— 那等于工具替用户拍板。现在工具只做两件事：把该自动加的 patch 加上，
  以及在**该问却没问**的时候拦住推送。
- **「同一个 bug 修几轮」不重复加版本号**（用户 10-18 补）：patch 的额度键是提交 subject 里的
  `B\d+`；同一个 B 号在本版内已经给过 patch（`chore(version)` 的提交信息里记着「随 Bxxx」），
  后续几轮真机回归/返工**不再加档**。没带 ticket 号的提交无从判同，各算一次
  —— 宁可多一档，也不要把两个 bug 混成一档。
- 「每次修改」指碰**产品代码**的改动。纯 `docs/` / `tests/` / `scripts/` / 内部记忆提交不推 patch
  —— 版本号是软件版本，不是提交计数器。
- patch 由**交付方在出包前显式推**：跑 `bash scripts/build-all.sh` **之前**先
  `scripts/bump-version.sh patch --commit`，把版本号单独提交成一条 `chore(version): …`。
  ⚠️ 构建脚本自己**不动版本号**（B330，用户 2026-10-22 收回这项主动权）：旧口径把 +patch 挂在
  `build-all.sh` 末尾，一是让「编译过」等于「发布过」，二是它排在打包**之后**，产物里嵌的版本串
  必然比仓库低一档。也不挂 pre-commit 钩子：本仓库常用 `git commit <paths>`，**路径限定提交会绕过索引**，
  钩子里 `git add` 的版本号会被那次提交静默丢掉，还会把别人在飞的文件一起提交。
- `scripts/bump-version.sh <patch|minor|major|x.y.z>` 是版本号写入的**唯一**实现，一次写齐四处
  （`package.json` / `tauri.conf.json` / `Cargo.toml` / `Cargo.lock`）；`release.sh` 也调它。别在别处再写一份。
- CI 环境不动版本号（由本地交付流程推进）。

**牙齿**：pre-push 在 vitest 之前跑 `scripts/check-version-bump.sh`——① 四处版本号必须一致；
② tag 以来有产品代码提交而版本号纹丝不动 ⇒ 阻断，给出 `bash scripts/bump-version.sh patch --commit`；
③ tag 以来有 `feat` 而 minor 未变 ⇒ 阻断，要求**先问用户**；④ 有破坏性标记而 major 未变 ⇒ 同上问 major。
用户答「不升档」后才用 `LITEPAD_VERSION_ACK=asked git push …` 放行（**没问过就别设这个变量**，
它代表「已征询且用户答不升」）；`LITEPAD_SKIP_VERSION_CHECK=1` 是连一致性都不查的紧急绕过。
守卫内部还会硬检查 `grep`/`node` 等工具存在 —— 缺了就直接失败而不是跳过：钩子环境里 grep 缺失时
计数会变空串，`[ "" -gt 0 ]` 判假，守卫会「看起来通过」而实际什么都没统计（09-18 实测过的假绿）。

**CHANGELOG.md**：由 `scripts/gen-changelog.sh` 从 Conventional Commit 自动生成，
`release.sh` 发布时自动刷新并进同一个 release 提交，**不要手改**。

## 开发调试与发布构建（用户 2026-10-29 定）

- **日常开发/调试一律跑 dev 构建**，不碰已安装版：dev 构建默认**多开**（不注册单实例插件）、
  配置目录默认 `%APPDATA%\LitePad-dev`，所以开发实例可以和用户正在用的安装版**同时开着**
  （真机实测：同 identifier 两个进程各建各的窗口，互不拦截）。
- **自动化测试/真机台的配置目录一律进项目 `.tmp/`**：
  `LITEPAD_CONFIG_DIR=E:/Project/LitePad/.tmp/<case>/config`。会话、设置、最近打开、日志、备份
  全部跟着搬走；不许碰用户真实的 `%APPDATA%\LitePad`，也别依赖互动开发用的 `LitePad-dev` 缺省
  —— 测试要能在任何机器上重来。
- **release 构建只在交付/发布链路里做**：`bash scripts/build-all.sh`（出包）与
  `bash scripts/release.sh <版本>`（发布）。日常开发不构建、不运行 release 包。
  release 包默认单实例；`LITEPAD_MULTI_INSTANCE=1` 显式放开、`LITEPAD_SINGLE_INSTANCE=1` 显式收紧
  （两个都设时 MULTI 优先），其它取值忽略。
- 例外（这些本来就属交付动作，仍用 release 产物）：`docs/screenshots/` 刷新、安装包验收、
  「release 口径」的性能同尺测量；pre-push 钩子的本地 release 构建保留（只编译、不运行）。
- 任何脚本都**不许杀用户正在跑的实例**：台子只结束自己记录过 PID 的进程，找不到自己的窗口就中止。

## 测试与验证

- **每个 bug 必须补回归测试、与修复同一提交**，且**改完先反向验证**：把修复还原一次，确认用例真会红
  （运行时 → `tests/smoke.bootstrap.test.ts`；配置/样式 → 对应模块的静态契约用例，如 `tests/findbar.test.ts`；
  Rust wire/序列化 → 内联 `#[cfg(test)] mod tests`）。流程见 `.agents/rules/testing.md`。
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
  取证踩过的坑记进 `.agents/pitfalls/`，别重复踩。

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

- **同一文件打开多份时，光标各归各的**：`syncDocInstances` 只派发 `{ changes }`（纯文本），
  光标 / 视图模式不在其中，各实例各归各的。
- **滚动位置按该文档的同步滚动开关联动**（B152，默认开）：`docSyncModes` 按**文档**记，
  唯一写点是 `setDocSyncMode`，写的时候同时驱动 `src/sync-scroll/*` 的协调器并跨窗口广播；
  关 → 同 docId 的各视口各滚各的（即 B149 当初钉的基线）。
- 协调器只认 `scroll` 事件 + 期望账本，判定与跨窗口外发都在 `src/sync-scroll/coordinator.ts`；
  旧的单体 `sync-scroll.ts` 与派生 DOM 预览臂都已不在代码里（分别由 `src/sync-scroll/*` 与
  B412 的单 view 方案取代），别再到代码里找它们。

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

## 视口位置（旧机制已移除 · B302 后重做）

⚠️ **本节描述的整套机制（位置记忆 / 还原）已随同步滚动重构整体删除**：`pinScrollTop` /
`recordScroll` / `rememberViewScroll` / `measureAndKeepScroll` / `restoringViewport` /
`restoreViewScroll` / `clearPendingSync` / `t.scrollTop` 像素槽 / CM6 测量补偿收尾
（B134 / B139 / B142 / B145 / B146 / B148 / B151 那一路）全部不复存在，别再到代码里找它们。

现状（B302 之后重做的）：滚动位置由同步滚动账本管（`src/sync-scroll/*`）—— 每格记
`scrollV`（与宽度无关的块高比例），切标签 / 重建布局 / 跨窗口 / 会话恢复都走同一条落位链
（`landVisibleSideAtV`）。B412 起 Markdown 预览不再是派生 DOM，源码 / 预览 / 编辑三档共用一颗
EditorView，大纲跳转与「转到行」也落在同一颗 view 上；HTML 的预览档则是独立沙箱 iframe
（`src/preview/htmlPreview.ts`）：页面脚本在 opaque origin 里执行（拿不到宿主 / Tauri IPC），
相对样式、图片、脚本按文档目录加载，但不参与这颗 view 的滚动接力。

若将来要重做「位置记忆」，这是全新设计（用户已明确「换个思路」），不要参照本节旧口径。

## 图标

- **所有按钮图标一律用 VS Code codicon**：依赖官方 npm 包 `@vscode/codicons`（版本在
  `package.json` 里**钉死**，字形跨版本会变），样式由 `src/main.ts` 引入
  `@vscode/codicons/dist/codicon.css`（必须排在本项目样式之前，详见那里注释）。
- 取用一律走 `src/shell/codicons.ts` 的 `CODICONS.<name>` / `CODICONS[name]`
  （给出 `<i class="codicon codicon-<id>"></i>`），**不得在消费方写死字形或码位**。
  加一颗图标就在 `codicons.ts` 的 `IDS` 里加一条，并给它一个真实调用点。
- 尺寸默认由官方样式统一给 16px；要别的尺寸就在 CSS 里改 `.codicon` 的 `font-size`
  （例：`.panel-op .codicon { font-size: 15px }`）。补画轨那几枚 svg 同口径：由消费方 CSS
  给 16×16（见 `.md-preview-tool svg`），标记本身只画形状、不带尺寸。
- **禁止手绘 SVG 充当图标**。codicon 里确无合适字形时，**先与用户商量**是否引入别的图标集，
  不得自行绘制、临时拼一个或改字号凑数。
- **例外（B446，用户 2026-11-01 拍板「按同笔补画」）**：Markdown 格式工具条里
  公式 Σ / 下划线 U / 上标 x² / 下标 x₂ 四枚，官方 746 颗确无对应字形（B444 曾就近取
  `#` / `ab` / UML 层级图，用户看了仍要改）。这四枚画在 16 网格、`currentColor` 跟字色，
  出口只有 `src/shell/toolbarMarks.ts` 的 `TOOLBAR_MARKS`，取用一律经
  `formatToolbar.ts` 的 `toolbarIcon()`；**只收有调用点的标记**，与 `codicons.ts` 同纪律。
  其余按钮一律 codicon，不破例。B448（用户点名「调整 Mermaid 图表按钮图标」）加第 5 枚
  `flowchart`：`type-hierarchy` 画的是**圆节点**的组织图，不是 mermaid 那种方框 + 折线箭头
  ⇒ 那颗短名随之下册（红线：不躺零调用点的 id）。B450 加三枚，补画册共 **8 枚**：
  `indent` / `outdent`（经典文本编辑器的「行 + 箭头」缩进对，官方册只有一根孤线的 `indent`
  用户点名不用）与 `footnote`（`[^n]` 角标）；`indent` 的 codicon 字形随之下册。
  同一轮给补画册定了**笔形**：16 网格一律 `fill="none"` + 根元素 `stroke-width="1.4"`
  （第一版 Σ 是实心填充、笔画等效 2.2 厚 ⇒ 在同排 codicon 旁明显粗一档）；相邻两笔之间
  要留出可辨识的缝（第一版 U 的弧底离底线只剩 0.8 单位，16px 下糊成一坨）；墨迹不许贴
  16 边框、小笔画要认得出（第一版上/下标的小「2」是折线硬拼，读起来像「7」）。
  改完必须目视结案：`.tmp/b448-ink.py` 把任意一组 SVG 在真机里按 16px 与 96px 各画一遍。
  镜像**只剩撤销一颗**（`redo` 反着画，`.md-preview-tool--flip` 一条 CSS `transform`）——
  官方册里独独没有 undo；B450 起 `outdent` 有了自己的字形，不再靠 `indent` 翻转。
- **Markdown 格式工具条（B431→B444→B446→B447→B448→B450）**：分组
  `[撤销 恢复 保存] │ [预览↔编辑切换键] │ 段落 7 │ 插入 6 │ 格式 4` = 可见 21 颗
  （插入组 B450 加「脚注」：光标处写 `[^n]`、文末补定义行，编号避开已用过的；
  （段落组里 B448 加了「增加缩进 / 减少缩进」两颗，一级 = **两个空格**，与
  `buildMarkdownToc` 的 `"  "`、大纲侧 `Math.floor(indent / 2)` 同一口径；它们与编辑器
  Tab 吃的 `indentUnit`（4 空格）不是一回事，所以这两颗**不带**键位提示），
  组界各一根 `.md-preview-tool-sep`（第一根在切换键之后 —— 那颗键自己占一组）。
  同类型的成对项与低频的块级插入折成下拉（`列表▾` / `公式·图表▾` / `更多格式▾`），
  折叠一律复用 `showPopupMenu(anchor, items, undefined, { anchorToggle: true })` ——
  **不新造菜单机制**；下拉子项各带字形（`MenuItem.icon`，不传就不建那一格、不留空位）。
  图标两轨：默认 codicon，上述八枚走补画轨；B431 那套 Vditor SVG sprite 仍算整类删除。
  切换键是双字形开关（B450 定稿）：预览档画 `edit`（点了进编辑）、编辑档画 `lock`
  （点了锁上进预览），与置顶 / 同步滚动那几颗同一条「字形 = 点了会去的那一档」。
  三颗历史键的可用态吃 `undoDepth` / `redoDepth` + `doc.dirty`，刷点两处（档位出口
  `syncPreviewEditFab` 与文本变化 `handleUpdate`）；灰态用原生 `disabled`，与菜单项同档
  （0.4 不透明度），**灰而不藏**。
- **文件类型图标是这条红线的唯一例外（B367/B368，用户确认）**：标签、资源管理器的文件行与
  状态栏语言浮层使用 VS Code 默认的 **Seti 文件图标主题**（`seti.woff` + 逐语言码位/色调，
  MIT，许可见 `src/assets/fonts/seti-ui-LICENSE.txt`）。它仍然是**上游字体字形**、不是手绘；
  出口只有 `src/shell/fileicons.ts` 的 `fileIconHtml()`（按语言标签）与
  `fileIconHtmlOfFile()`（按文件名：fileNames → fileExtensions 最长后缀 → 语言表，
  与 VS Code 图标主题同序），消费方不得写死码位。
  九档色调走 `--seti-*`（浅深两套），字号 150% 与 VS Code 图标主题同口径。
  目录/文件夹**不挂图标**：Seti 主题本来就不定义文件夹图标，VS Code 的资源管理器里
  文件夹行只有折叠箭头 + 名字（B370 对齐）；按钮类图标**仍一律 codicon**。
- 想浏览 codicon 的全部字形：打开 `node_modules/@vscode/codicons/dist/codicon.html`。

## 范围（明确不做）

不做：插件商店、内置终端、Git 集成、LSP。

## 快捷键预设

支持 default / Notepad++ / VS Code 三档预设；优先级：用户覆盖 > 预设 > 默认。

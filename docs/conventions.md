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
- 或有效提交（feat/fix/perf/refactor/revert）累计 **≥10** → `npm run release patch`

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

- **同一文件打开多份时，光标与滚动位置不互相关联**（用户拍板，`tests/multi-instance-scope.test.ts`
  把这条基线钉住）：`syncDocInstances` 只派发 `{ changes }`（纯文本），光标 / 视口 / 视图模式
  各实例各归各的。正在做的「同步滚动模式」是**后面单独的独立需求**，现在不做。
- ⚠️ 想做同步滚动模式时，改的是**这一整条基线**，不是在这里开个洞：把
  `tests/multi-instance-scope.test.ts` 整段换成新口径（哪些跟着动、哪些不跟着动），
  再回头清掉 `syncDocInstances` 里那几条「不许碰视口 / 不许带 selection」的契约。
  在这里打补丁，等于把「只同步文本」这条不变量悄悄拆了，之后没人知道哪块能删。
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

## 视口位置（B134 / B139 / B142 / B145 / B146）

- **还原位置要「钉到立住为止」**：`pinScrollTop` 逐帧补钉（上限 `PIN_MAX_FRAMES` 帧），
  中间值一个都不信。只补一帧是不够的 —— 窗口刚打开时布局可能连着好几帧都没稳，
  差一帧位置就永久停在被裁掉的 0 上。补钉期间 `viewportWriteDepth` 不降，
  「程序滚动不许写快照」的区间必须活到最后一次补钉之后。
- **写快照只有 `recordScroll` 一个出口**（B145）：`restoringViewports` 原来只被两个
  scroll 监听认，`rememberViewScroll` / `refreshSession` 那几条旁路照样能把还原期
  的中间值写进记录。别再直连 `sessionStore.setScroll`。
- **`pinInFlight` 是容器的 Trust 开关**：钉位置还在重试时，容器里摆的是没立住的值
  （多半是 0），`rememberViewScroll` 看见了必须一个字都不采。
- **`focus()` 必须排在还原位置之前**（切标签 / 挂载）：`focus()` 会把光标滚进视野，
  排在钉位置之后等于白钉 —— 这就是「切换标签位置会变」。
- 补钉始终没立住时会留一条 `logger.warn("viewport", …)`（含目标值与实际值）。
  真机出现「重启回到顶部」先看这条日志。
- **换文档（`setState`）期间的自动滚动是**主因**（B146 二轮修订，用户拍板）**：
  CM6 的 `setState` 实现末尾是

  ```js
  if (hadFocus) this.focus(); // 换完文档自己再滚一次，把光标滚进视野
  this.requestMeasure();
  ```

  再加上浏览器按**新内容长度**裁剪 `scrollTop` —— 这两下都不是用户造成的。而它们
  派发的 scroll 那一刻，滚动监听会把「换文档的副作用」当成「用户停过的位置」写进
  记录：**这就是「切换标签，md 文档的滚动位置会不断往下移」的直接原因**
  （源码 / 预览都中）。次要成因是下面那条 CM6 测量补偿。

  两条硬规矩：
  1. `panel.viewTabId` 要**先于** `setState` 改掉 —— 滚动监听靠它寻址，晚一步那几下
     滚动就记到**旧**标签头上了。
  2. 整个「换文档 → 还原」要罩进 `restoringViewport(tabId, …)`，还原窗口要从
     `setState` **之前**就开着，不能只罩住还原那一下。两帧后才解锁，而浏览器 scroll
     事件是**下一帧**才派发的，正好落在窗口里。

  ⚠️ 别再给这段叠「也算程序滚动」的计数器（试过 `swappingView`，已删）：它挡掉的并不
  只有换文档那两下自动滚动，**切完标签同一帧内的用户滚动也一并丢了**
  （`session-restore-state` 的 B129 用例因此变红）。`restoringViewport` 的两帧窗口
  已经够用，行为用例实测退回修复前后照样精确变红。加保险前先能说清「丢掉的那一下
  一定是程序造成的」。

  ⚠️ 修这个 bug 时注意：**别在 `setState` 的 scrollTop setter 里派发 scroll 来模拟**。
  那一刻的写入是我们自己的钉位置，本来就归 B139 那条「程序滚动不许写快照」管，
  照样被挡 —— 等于什么都没模拟（B146 实测踩过）。要模拟就钩住 `EditorView.prototype.setState`，
  在它**之后**改一次容器值并派发事件，见 `tests/viewport-anchor.test.ts`。

- **CM6 测量会把视口往下推，`requestMeasure()` 不能裸调**（B146）：`@codemirror/view`
  在 measure 收尾时做「滚动锚点补偿」——拿视口顶行高度与上次记的锚点比，差 >1px
  就 `scrollTop += diff`。`setState` 换文档后 heightMap 是拿 `HeightOracle` 按**估算
  行高**建的，measure 换成实测行高，软换行 / 中英文混排下 `diff` 恒为正 ⇒ 每切一次
  标签视口再多挪一点。测量统一走 `measureAndKeepScroll(panel)`，它在补偿之后把位置
  收回来。这是**次要**成因，别拿它当主修复。
  ⚠️ 时序是躲不掉的：`requestMeasure()` 排的是**下一帧** rAF，而 `pinScrollTop` 第一次
  就判定「立住」、不再补钉，中间无人把关 —— 这正是这个 bug 藏了这么久的原因。
- **预览按像素钉完之后要 `clearPendingSync()`**：`applySyncToLine` 只写 `pendingSyncLine`
  不消费它，而 `applyPending` 会被任意一次图片 / 公式增强的 `load` 唤醒，留着旧行号
  就会把预览从刚钉好的落点拽走。
- ⚠️⚠️ **源码 / 预览共用一个 px 槽，切换模式是一次「交接」，不是各认各的**（B148）：
  `t.scrollTop` 只有一个字段，装的是「**当前这一侧**」的像素。纯预览态下编辑器是
  `display:none`，它的 `scrollDOM.scrollTop` 被浏览器清零，CM6 的
  `inputState.lastScrollTop`（`observers.scroll` 记的那个，focus 时才回读）也被那发
  0 值 scroll 改写 ⇒ **编辑器的位置无从恢复**；而预览的滚动监听照常把**预览的像素**
  写进同一个槽。切回源码时 `measureAndKeepScroll` 下一帧的 `reassertViewScroll` 认的
  判据是 `t.viewMode !== "preview"`（此刻已是源码）⇒ 就把预览的像素钉到了编辑器上。
  于是 `editor@E → preview@syncToLine(E) → 用户滚预览到 P' → source@P'` —— 每绕一圈
  偏一次，这就是「反复切换源码 / 预览，滚动位置持续偏移」。

  修法（**不加第二个字段**，B138 已拍板不再为位置加字段）：切回源码之前，先把
  「预览此刻停在哪一行」换成**编辑器侧**的像素（`PreviewPane.topVisibleLine()` →
  `view.lineBlockAt(doc.line(n).from).top`），**走 `recordScroll` 写进同一个槽**，
  再 `restoreViewScroll` 钉回去。三处顺序都是契约：

  1. 问顶行必须在改 `tab.viewMode` **之前**（切换后编辑器已是 `display:none`，问不出）；
  2. 走 `recordScroll` 唯一闸口，别直连 `sessionStore.setScroll`；
  3. 拿到落点才 `restoreViewScroll`，否则下一帧的测量收尾会拿旧值动手。

  ⚠️ 预览一份都没渲染出来（`topVisibleLine()` 返回 `null`，大文件降级就是这种）时，
  **宁可不动编辑器**，也别把预览的像素原样钉过去 —— 后者跳到的位置没有任何依据，
  比停在开头更像 bug。
  ⚠️ 这条链路在 jsdom 里能真复现（B148 的 `tests/view-mode-scroll.test.ts`：退化实现
  报 `expected 3000 not to be 3000`），因为要的只是「写进去的值 ≠ 另一侧的像素」。

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

# LitePad 长期备忘

**LitePad**（B34 更名，LiteMD 已 B36 全仓清理）；工作区 `E:\Project\LitePad`。

> 本文件只是索引。**改代码前必读**同目录 `ARCHITECTURE.md`（架构不变量 1–9 与踩坑根因）；
> 构建/会话环境精确命令照抄 `BUILD-ENV.md`；最详细的逐日日志见 `2026-09-*.md`；旧空间归档
> 见 `LiteMD-Space-Archive.md`。仓库内另有 `docs/split-view-plan.md`、
> `docs/screenshots/README.md`、`docs/vscode-reference/`。

## 技术栈 / 范围
Tauri 2（Rust 持状态）+ Vite 6/TS + CodeMirror 6（视图）；**仅 Windows**。标识 `litepad`
/ `com.litepad.app` / 配置落 `%APPDATA%\LitePad`；编码 encoding_rs + chardetng；原子写入
= 临时文件 + fsync + rename。**不做**：插件商店、内置终端、Git 集成、LSP。

## 项目约定（用户明确要求）
- **状态归 Rust、视图归前端**；内存文本一律 LF，落盘还原原行尾。
- **git 全程管理**：每个交付一个 Conventional Commit。
- **README = 使用者向**：开头只一张截图 `main.png`；不写截图维护/快捷键/安装/源码构建/
  明确不做；描述避开库名与内部机制。技术细节留 `docs/` 与代码注释。
- **每个用户报告的 bug 必须补回归测试、与修复同一提交**：运行时可测 →
  `tests/smoke.bootstrap.test.ts`；配置/样式根因 → `tests/regressions.test.ts`；
  Rust wire/序列化 → 内联 `#[cfg(test)] mod tests`。**改完先反向验证**（还原修复一次，
  确认对应用例真会红）。
- ⚠️ `docs/*.md` 是说明不是契约，**改语义必须同步改清单/状态表**（B67 教训，已有守卫）。
- **界面改动必须刷新 `docs/screenshots/`**，同一提交；不影响观感则在提交信息注明。
- **每次编译都产出发布版本**：tsc → vite → vitest → cargo build+test → tauri build。
- 质量门 = `.githooks`（pre-commit: prettier/eslint/tsc/cargo fmt；pre-push: vitest/cargo
  test）+ GitHub `CI`。
- ⚠️ **沙箱内禁止 `git stash -u` 或任何触碰 `.git` 的重操作**（09-13 曾致全历史丢失）。
- 📁 **临时文件一律落在本项目内**（用户明确要求，09-18 定）：常量落点
  `E:\Project\LitePad\.tmp\`（已同时进 `.gitignore` / `.prettierignore` / eslint `ignores`）。
  日志、探针与一次性脚本、对照副本、CDP `--user-data-dir`、临时下载、中间 JSON 全进这里。
  ⚠️ **禁止写全局目录**：`%TEMP%`（`C:\Users\maoyu\AppData\Local\Temp`）、
  `~/.workbuddy/` 下除 memory / skills 以外的地方、**Git Bash 的 `/tmp`（实测就是 `%TEMP%`，
  不是 `E:\tmp`）**。历史漏法：`%TEMP%` 里堆过 `litepad-build*.log` / `litepad-*-profile` /
  `notepad_cap*.py`。**例外（是工具链不是临时文件，别搬）**：`~/.workbuddy/binaries/**`
  受管运行时（python venv / node / PortableGit）、Playwright chromium、msys2、cargo；
  既有 `generated-images/` 保持原样（仍作观感自证截图与对照页专用目录）。
  待定：应用自身运行时日志 `%TEMP%\litepad-app.log` / `litepad-smoke.log`（Rust 侧写、
  属产品行为）是否也收进项目内。

## 发布
`bash scripts/release.sh <版本|patch|minor|major> [--ci]`：四处同步（package.json /
tauri.conf.json / Cargo.toml / Cargo.lock）→ 构建 → `chore(release): vX.Y.Z` + tag；
`--ci` 跳过本地全量构建（冷启 tauri build 约 38 分钟）。**Release 只由 `v*` tag 触发**
（只推 main 只跑 CI），推 `git push origin main --follow-tags`，失败可在 Actions 手动
dispatch。里程碑 v0.2.0→0.2.1→0.2.2→**当前 0.3.0**，一致性由 `tests/regressions.test.ts` 守护。

## 构建环境（细节见 `BUILD-ENV.md`）
本机**无 MSVC**，宿主工具链 `stable-x86_64-pc-windows-gnu` + MSYS2 MinGW 链接器。
会话 shell 会**整体丢 PATH**，每条命令先显式 export（push 也要，否则
`NotAttempted("windres")`）；沙箱内 cargo/tauri 构建需 `dangerouslyDisableSandbox`，链接前
先杀 `litepad.exe`；git bash 调 PowerShell 被拒 → 用 PowerShell 工具。
⚠️ 长构建**不要接 `| tail`**（SIGTERM 后管道永挂、任务假 running）→ 落日志或前台分步。
⚠️ 沙箱起不了 WebView2：纯 DOM/CSS 观感用「esbuild + jsdom 静态页 → Playwright 无头
截图」自证（产物进 gitignore 的 `generated-images/`），**不能**当正式截图。

## 参考库 `docs/vscode-reference/`（MIT 只读）
A–H 精选约 82 份、I 编辑器整模块约 3283 份（`fetch-vscode-ref.sh` /
`fetch-vscode-editor-ref.sh` + `REVISION*.txt`），`INDEX.md` 分段导航；抓取坑见
`BUILD-ENV.md`。⚠️ **`src/` 不入库**：故 `eslint .` / `prettier --check .` 在本工作区大量
报错**属预期**，判自己改动只针对具体文件跑。改观感读 A 段、改交互读 B/C 段（**抄状态机与
边界，不抄实现**）。

## 进度
- **M0–M4 全部交付**：脚手架 → 多标签/搜索/设置/日志 → 自由分屏/会话恢复/自动保存/文件
  监听/跨文件搜索 → Markdown 渲染 → 大文件分级降级（≤2MB 全功能 / 2–20MB / 20–64MB /
  >64MB 拒绝）+ 命令面板 + 三档键位预设（default / notepadpp / vscode）。
- **B34–B68 修复与打磨**：更名+图标 / prettier+eslint+CI / 标签栏多轮摇摆（B53 后为**原生
  横向滚动**，折叠机制整体删除）/ 首选项弹窗 / 启动白屏 / 安装包与安装器图标三套机制分层 /
  分屏对齐 VS Code（B59–B63）/ B64 拖拽影像 / **B65+B66 ●↔× 互斥** / B67 复核「双击按
  分割数量均分」（行为早就有，是文档没跟上）。**逐条见 git log 与当日日志。**
- **B68 热退出（Hot Exit）**：用户要「写副本 + 关窗不弹窗 + 下次恢复」= VS Code 的
  Hot Exit（非 Auto Save）。`Settings.hot_exit` 默认开、`autosave` 默认改关；副本落
  `%APPDATA%\LitePad\backups`，靠会话 `backupId` 认领。⚠️ 顺带发现
  `OpenedFile.size_class` 按 snake_case 读 → **M4 大文件降级从未生效**，已修。
  不变量见 `ARCHITECTURE.md` §7「保存体系」/§8 首条。
- **测试规模**：450 vitest + 40 cargo；热退出 → `tests/hot-exit.test.ts`，静态契约 →
  `tests/regressions.test.ts`，分屏/拖拽 → `tests/splitview.test.ts` / `tests/panel-group-drag.test.ts`
  / `tests/window-drag-out.test.ts`。**反向验证**是硬要求（改完把修复还原一次，确认用例真会红），
  脚本落 `scripts/reverse-verify-<B号>.cjs` 入库、流程见项目 skill `litepad-reverse-verify`。
- **B71 面板操作对齐 VS Code**（`72892b2`）：① 5 条面板命令（移动标签 Ctrl+Alt+←/→、
  切焦点 F6/Shift+F6、Alt+Shift+↑ 最大化）② **最大化/还原 = 只改比例不动结构**
  （沿路径推 0/1 + 快照还原；⚠️ 需 `.layout-panel-collapsed` 才能真的收到 0；
  会话必须存未最大化比例）③ 拖标签栏空白处 = 拖整组（`e.target === strip` 判据）。
- **B71 ④ 完整多窗口**（用户明确选「与主窗口共享文档、可来回拖」）：Rust `windows.rs`
  建窗+身份+载荷登记；跨窗口**只传 ChangeSet**（带 `baseLen`，不符即转全文重同步）；
  标签搬走后本地留**隐藏实例**（`panelId = -1`）供会话与异常兜底；**拖出窗口**
  主窗口开新窗（落在松手处）、卫星窗口交回主窗口。不变量见 `ARCHITECTURE.md` §9。
- **B70 提示层三档**：A 档**菜单开着绝不弹提示**（判据 = DOM 有无 `.popup-menu`，
  放在读 `dataset.tip` 之前；tooltip 不许反向 import menu）+ `showPopupMenu` 开场
  `hideTip()`；B 档**菜单项一律不挂提示**（`MenuItem.title` 删除，共删 4 处）并把拖放判据
  换成 `needsChoice(paths, targetIsMarkdown)` = 单个文件 + **落点面板的活动文档是 .md**；
  C 档命令面板：**悬停只切 `.is-active` 不重建列表**（重建会把滚动位置归零 → 弹回顶端）、
  **呼出面板先 `closePopupMenu()`**（菜单遮罩盖不住、会压在上面）。
  不变量见 `ARCHITECTURE.md` §4 / §7「菜单 vs 面板/提示的互斥」/「提示（tooltip）自绘层」。
- **B72 拖拽影像药丸 + 卫星窗口建窗修复**：① 整组拖拽影像从「克隆整条标签栏」改成
  **纯文本聚合药丸**（活动名 + `(+N)`，对齐 VS Code `draggedEditorGroup`；⚠️ 名字可截断、
  数量 `flex:0 0 auto` 不可截断 —— 有意偏离 VS Code 的单字符串写法）；② **卫星窗口打不开**
  的根因 = WebView2 **按 user data 目录共享环境、参数必须一致**，而
  `WebviewWindowBuilder` 不继承 `tauri.conf.json` 的 `additionalBrowserArgs` →
  `shared_browser_args()` 从运行时 `app.config()` 取 `main` 条目喂给卫星窗口；建窗失败原因
  也一并回传状态栏。不变量见 `ARCHITECTURE.md` §4 末条 / §9.4 末条。

## 下一步
- ⚠️ **B72 待真机确认**（沙箱起不了 WebView2，两条都无法自证）：① 拖出标签/整组时
  **新窗口真的能打开**（此前必失败；开窗后核对 `%TEMP%` 无关日志或 `smoke_log` 里
  `browser args` 与主窗口一致）；② 整组拖拽时跟随光标的**药丸**观感（圆角/字号/长文件名
  截断且 `(+N)` 仍在/光标不压字）。
- ⚠️ **B70 待真机确认**：① 菜单开着时划过工具栏/状态栏**不弹**提示，关掉菜单后恢复；
  ② 拖一个非 md 文件到 md 面板 → 弹选择菜单；拖 md 文件到 txt 面板 → **不弹**、直接打开；
  ③ 命令面板里鼠标上下挪行，列表**不**弹回顶端；开着菜单按 Ctrl+Shift+P，菜单消失。
- ⚠️ **B71 ④ 待真机确认**（沙箱起不了 WebView2，全部无法自证）：拖出落点（含多显示器）/
  卫星窗口拖回主窗口 / **两窗口同开一份文档时正文实时同步** / 强杀卫星窗口后主窗口接管
  隐藏实例 / 卫星窗口未保存内容的热退出恢复 / 最大化窗口贴边拖动不该误弹新窗。
- **待桌面环境补拍截图**（沙箱起不了 WebView2）：M4 `keymap.png`/`command-palette.png`；
  B51 `main.png`/`preferences.png`；B53–B71 `main.png`（标签图标/面板操作栏/分隔条细线/
  分屏落点/●↔× 换装/最大化后的「还原」按钮）。
- ⚠️ **B60–B66 待真机确认**：1px 静息线 / 4px 激活线 / 角手柄 `all-scroll` 手感 / 深色下
  浅蓝落点；联动（拖一条一起走 / 悬停预告 / 交叉点双轴 / 双击按段数均分）在 2×2 与 3 栏
  各验；B64 影像跟手；B66 关闭区 20px 手感与 `transition: opacity` 是否迟钝。
- **B68 待真机确认**：① 有未保存修改关窗**不弹**确认框；② 重启后未保存标签（含草稿）原样
  回来且仍脏；③ 保存后副本被丢弃，重启**不回滚**；④ 关掉「文件 → 热退出」恢复弹框并清空
  现存副本。可选打磨：热退出是布尔开关（LitePad 无工作区概念，VS Code 的 `onExit` /
  `onExitAndWindowClose` 两档无法区分）；首选项弹窗不含自动保存/热退出（同 B51 取舍）。
- 待清理：`menu.ts` 的 `MenuItem.active` 与 `.menu-item-current`（B53 后无使用者）。
- 待定：是否发 **v0.3.1**；M5 规划未定（候选见 DESIGN.md）。

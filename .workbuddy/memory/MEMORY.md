# LitePad 长期备忘

**LitePad**（B34 更名，LiteMD 已 B36 全仓清理）；工作区 `E:\Project\LitePad`。

> 本文件只是索引。**改代码前必读**同目录 `ARCHITECTURE.md`（架构不变量 1–8 与踩坑根因）；
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
- **测试规模**：380 vitest + 33 cargo；热退出 → `tests/hot-exit.test.ts`，静态契约 →
  `tests/regressions.test.ts`，分屏/拖拽 → `tests/splitview.test.ts`。

## 下一步
- **待桌面环境补拍截图**（沙箱起不了 WebView2）：M4 `keymap.png`/`command-palette.png`；
  B51 `main.png`/`preferences.png`；B53–B66 `main.png`（标签图标/面板操作栏/分隔条细线/
  分屏落点/●↔× 换装）。
- ⚠️ **B60–B66 待真机确认**：1px 静息线 / 4px 激活线 / 角手柄 `all-scroll` 手感 / 深色下
  浅蓝落点；联动（拖一条一起走 / 悬停预告 / 交叉点双轴 / 双击按段数均分）在 2×2 与 3 栏
  各验；B64 影像跟手；B66 关闭区 20px 手感与 `transition: opacity` 是否迟钝。
- **B68 待真机确认**：① 有未保存修改关窗**不弹**确认框；② 重启后未保存标签（含草稿）原样
  回来且仍脏；③ 保存后副本被丢弃，重启**不回滚**；④ 关掉「文件 → 热退出」恢复弹框并清空
  现存副本。可选打磨：热退出是布尔开关（LitePad 无工作区概念，VS Code 的 `onExit` /
  `onExitAndWindowClose` 两档无法区分）；首选项弹窗不含自动保存/热退出（同 B51 取舍）。
- 待清理：`menu.ts` 的 `MenuItem.active` 与 `.menu-item-current`（B53 后无使用者）。
- 待定：是否发 **v0.3.1**；M5 规划未定（候选见 DESIGN.md）。

# LitePad 长期备忘

**LitePad**（B34 更名，LiteMD 已 B36 全仓清理）；工作区 `E:\Project\LitePad`。

> 本文件是**索引，刻意保持精简**——它会被每次会话整篇加载，臃肿会拖累智能体。
> **改代码前**读 `ARCHITECTURE.md`（架构不变量与踩坑根因）；**构建/环境**命令读 `BUILD-ENV.md`；
> **未决事项 / 待确认 / 待清理**读 `OPEN-ITEMS.md`；逐日明细与历史改动见 `2026-09-*.md`；
> 旧空间归档见 `LiteMD-Space-Archive.md`。

## 技术栈 / 范围
Tauri 2（Rust 持状态）+ Vite 6/TS + CodeMirror 6（视图）；**仅 Windows**。标识 `litepad` /
`com.litepad.app`；配置落 `%APPDATA%\LitePad`；编码 encoding_rs + chardetng；原子写入 =
临时文件 + fsync + rename。**不做**：插件商店、内置终端、Git 集成、LSP。

## 项目约定（用户明确要求，每次会话必读）
- **状态归 Rust、视图归前端**；内存文本一律 LF，落盘还原原行尾。
- **git 全程管理**：每个交付一个 Conventional Commit。
- **README = 使用者向**：开头只一张 `main.png`；不写快捷键/安装/构建/明确不做，避开库名与内部机制；
  技术细节留 `docs/` 与代码注释。
- **每个 bug 必须补回归测试、与修复同一提交**，且**改完先反向验证**（还原修复一次，确认用例真会红）：
  运行时 → `tests/smoke.bootstrap.test.ts`；配置/样式 → `tests/regressions.test.ts`；
  Rust wire/序列化 → 内联 `#[cfg(test)] mod tests`。流程见技能 `litepad-reverse-verify`。
- ⚠️ `docs/*.md` 是说明不是契约，**改语义必须同步改清单/状态表**（B67 教训，已有守卫）。
- **界面改动必须刷新 `docs/screenshots/`，同一提交**；不影响观感在提交信息注明。
- **每次编译都产出发布版本**：tsc → vite → vitest → cargo build+test → tauri build。
  质量门 = `.githooks`（pre-commit: prettier/eslint/tsc/cargo fmt；pre-push: vitest/cargo test）+ GitHub `CI`。
- ⚠️ **沙箱内禁止 `git stash -u` 或任何触碰 `.git` 的重操作**（09-13 曾致全历史丢失）。
- 📁 **临时文件一律落本项目内**（09-18）：常量落点 `E:\Project\LitePad\.tmp\`
  （已进 `.gitignore`/`.prettierignore`/eslint `ignores`）。禁止写全局目录 `%TEMP%`、
  `~/.workbuddy/`（除 memory/skills）、**Git Bash 的 `/tmp`（= `%TEMP%`，非 `E:\tmp`）**。
  例外（是工具链非临时文件，别搬）：`~/.workbuddy/binaries/**`、Playwright chromium、msys2、cargo；
  `generated-images/` 保持作观感自证专用目录。
  ⚠️ 应用自身日志 `%TEMP%\litepad-{app,smoke}.log`（Rust 侧）是否收进项目内**待定**
  （见 `OPEN-ITEMS.md`）。

## 发布
`bash scripts/release.sh <版本|patch|minor|major> [--ci]`：四文件同步版本 → 构建 → tag；
`--ci` 跳过本地全量（tauri build 冷启约 38 分钟）。**Release 只由 `v*` tag 触发**，
`git push origin main --follow-tags`。当前里程碑 **v0.3.0**（一致性由 `tests/regressions.test.ts` 守护）。

## 构建/会话环境（细节见 `BUILD-ENV.md`）
本机**无 MSVC**：宿主 `stable-x86_64-pc-windows-gnu` + MSYS2 MinGW 链接。会话 shell **整体丢 PATH**，
每条命令先 export（精确串见 `BUILD-ENV.md`）；沙箱内 cargo/tauri 构建需 `dangerouslyDisableSandbox`，
链接前杀 `litepad.exe`。⚠️ 沙箱起不了 WebView2，纯 DOM/CSS 观感走「esbuild + jsdom → Playwright 无头
截图」（进 `generated-images/`）自证，**不能当正式截图**。

## 参考库 `docs/vscode-reference/`（MIT 只读）
`INDEX.md` 分段导航；⚠️ **`src/` 不入库** → 本工作区 `eslint .` / `prettier --check .` 大量报错**属预期**，
只针对具体文件跑。改观感读 A 段、改交互读 B/C 段（**抄状态机与边界，不抄实现**）。

## 状态（详细见 `ARCHITECTURE.md` / `OPEN-ITEMS.md`）
- M0–M4 全部交付；B34–B72 修复打磨，逐条见当日日志与 `ARCHITECTURE.md` 各 §。
- **未决事项、待真机确认、待补截图、待清理、版本规划**统一在 **`OPEN-ITEMS.md`**（按需读取，不进会话常载）。

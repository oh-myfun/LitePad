# LitePad 项目长期备忘

应用名 **LitePad**（B34 更名；原名 LiteMD 已于 B36 全仓库清理）。工作区 `E:\Project\LitePad`。

> **本文件只是索引，不承载细节。** 展开看同目录：
> - `ARCHITECTURE.md` —— 改代码前必须知道的**架构不变量与踩坑根因**（按模块编号 1–8）。
> - `BUILD-ENV.md` —— 构建/会话环境的**精确命令**与坑（照抄，不要改写）。
> - `2026-09-*.md` —— 逐日工作日志（最详细：每次用户反馈的原话、根因、验证方式）。
> - 仓库内：`docs/split-view-plan.md`（分屏方案，逐条注 VS Code 出处）、
>   `docs/screenshots/README.md`（截图清单与流程）、`docs/vscode-reference/`（只读参考副本）。
> - `LiteMD-Space-Archive.md` —— 旧 LiteMD 空间的会话与记忆归档。

## 技术栈与范围

- Tauri 2（Rust 持有状态）+ Vite 6/TypeScript + CodeMirror 6（视图）；**仅 Windows**。
- 标识：productName/exe `litepad`、identifier `com.litepad.app`、配置落 `%APPDATA%\LitePad`。
- 编码 encoding_rs + chardetng；原子写入 = 临时文件 + fsync + rename。
- 明确不做：插件商店、内置终端、Git 集成、LSP。

## 项目约定（用户明确要求，别丢）

- **状态归 Rust、视图归前端**；内存中文本一律 LF，落盘时还原原行尾。
- **git 全程管理**：每个交付一个 Conventional Commit。
- **README = 面向使用者的说明**：开头只放一张截图（`main.png`），不写截图维护方法、
  不写快捷键表 / 安装 / 从源码构建 / 明确不做等章节；特性描述用使用者视角，
  避免库名与内部机制。技术细节留在 `docs/`、`.workbuddy/memory/` 与代码注释里。
- **用户报告的每个 bug 必须补对应回归测试**，修 bug 与补测试同一提交：
  运行时可测 → `tests/smoke.bootstrap.test.ts`（jsdom 真实 bootstrap）；
  配置/样式根因 → `tests/regressions.test.ts`（静态文件断言）；
  Rust wire 格式 / 序列化 → `src-tauri/src/**` 内联 `#[cfg(test)] mod tests`。
  ↳ 惯例：**改完先反向验证**（把修复还原一次，确认对应用例真的会失败）。
- **界面有改动必须刷新 `docs/screenshots/` 截图**，与代码改动同一提交；
  确实不影响观感则在提交信息注明「界面无变化」（清单与命令见该目录 README）。
- **每次编译都要产出发布版本**：`npm run build:all`（tsc → vite → vitest →
  cargo build+test → tauri build，出 exe + NSIS）；会话内改前台分步（见 `BUILD-ENV.md`）。
- 质量门 = `.githooks`（pre-commit: prettier/eslint/tsc/cargo fmt --check；
  pre-push: vitest/cargo test）+ GitHub `CI`（push main / PR）。
- ⚠️ **沙箱内禁止 `git stash -u` 或任何触碰 `.git` 的重操作**（09-13 一次误操作致全历史丢失）。

## 发布

- `bash scripts/release.sh <x.y.z|patch|minor|major> [--ci]`：版本**四处**同步
  （package.json / tauri.conf.json / Cargo.toml / Cargo.lock）→ 构建 →
  `chore(release): vX.Y.Z` + tag。`--ci` 跳过本地全量构建（本机冷启 tauri build 要 38 分钟）。
- **Release 只由 `v*` tag 触发**：只推 `main` 只会跑 CI 编译校验，不会发布。
  推 tag：`git push origin main --follow-tags`；失败可在 Actions 手动 dispatch（填 tag）重跑。
- 里程碑：v0.2.0 首个 Release → v0.2.1 → v0.2.2（修好安装包缺 DLL）→ **当前 0.3.0**。
  版本一致性由 `tests/regressions.test.ts` 守护。

## 构建环境（细节见 `BUILD-ENV.md`）

- 本机**无 MSVC**，宿主工具链 `stable-x86_64-pc-windows-gnu`
  （`rust-toolchain.toml` 锁定 + MSYS2 MinGW 链接器）。
- 会话 shell 会**整体丢 PATH**（`dirname/head: command not found`），每条命令先显式 export
  （完整串见 `BUILD-ENV.md`）；**push 也要带全 PATH**，否则找不到 `windres`
  （症状 `NotAttempted("windres")`；与「找到了但预处理失败」是两回事，后者重试即过）。
- 沙箱内 cargo/tauri 构建需 `dangerouslyDisableSandbox`，链接前先杀运行中的 `litepad.exe`。
- git bash 里调 PowerShell 会被安全策略拒 → 用 PowerShell 工具。
- ⚠️ **不要给长构建接 `| tail`**（会话 SIGTERM 后管道永挂，任务假 running）；
  落日志文件，或直接拆成前台分步。

## 参考源码库 `docs/vscode-reference/`（MIT 只读副本）

- 两类：**A–H 精选约 82 份**（`fetch-vscode-ref.sh` + `REVISION.txt`），
  **I 编辑器整模块约 3283 份**（`fetch-vscode-editor-ref.sh` + `REVISION_EDITOR.txt`，
  sparse-clone `src/vs/editor` + `base` + `platform`，只留源码）。
  `INDEX.md` 说明每份文件对我们有什么用、按 A–I 分段导航。
- ⚠️ **`src/` 不入库**（只入库 INDEX / REVISION* / LICENSE / 脚本）：否则上千份上游
  `.css/.ts/.tsx` 会被 pre-commit 的 prettier/eslint 扫到；它是可复现的，需要时重跑脚本。
  ↳ 推论：`eslint .` / `prettier --check .` 在这份工作区会大量报错，**属预期**，
  要判定自己的改动只能针对具体文件跑。
- 抓取环境坑：① 整仓 clone 走 HTTP/2 易 `CANCEL` → `http.version HTTP/1.1` +
  `core.compression 0` + `postBuffer`，配 `--depth 1 --filter=blob:none --sparse`；
  ② 逐文件 curl 会限流 → `--retry 4 --retry-all-errors`，或 `gh api .../contents/<path>?ref=main`。
- 改观感读 A 段（Modern UI 的 css）；改交互读 B/C 段的 `.ts`（**抄状态机与边界，不抄实现**）；
  I 段是 Monaco/编辑器内核，按需深挖。

## 进度

- **M0–M4 全部交付**：M0 脚手架 → M1（语言注册表 55 类 / 多标签 / 搜索 / 设置 / 日志）→
  M2（自由分屏 / 会话恢复 / 自动保存 / 文件监听 / 跨文件搜索）→ M3（Markdown 渲染）→
  M4（大文件分级降级 ≤2MB / 2–20MB / 20–64MB / >64MB 拒绝 + 命令面板 + 键位预设
  default / notepadpp / vscode）。
- **B41–B59**（应用图标 / 标签栏多轮摇摆 / 首选项弹窗 / tooltip 自绘层 / 启动白屏 /
  安装包与安装器图标分层 / 分屏对齐 VS Code）：逐条见 git log、`ARCHITECTURE.md` 与当日日志。
- **B60–B63 分屏联动四连修**（依据与推导见 `docs/split-view-plan.md` 七～十节）：
  - **B60** 分隔条改「不占布局」浮层（`flex:0 0 0` + `::before` 7px 命中区 +
    `::after` 静息 1px / 激活 4px）、落点回退浅蓝**无描边**、新增**对齐联动**
    （`sashRegistry` + `alignedSashesOf`）。⚠️ `centerOf` 判空必须看**交叉轴**
    （主轴恒为 0），否则联动恒不生效；旧用例的 4px rect 桩正好掩盖了它。
  - **B61** 拖动光标取 VS Code **非 mac** 档（竖线 `ew-resize` / 横线 `ns-resize` /
    角手柄 `all-scroll`）—— `col-resize`/`row-resize` 是 mac 档，Windows 上观感不同。
  - **B62** 双击要「整组居中」（**联动集合必须先求**再改比例）+ 纯点击不得回写比例
    （`moved` 标记；否则一次点击就把对齐推出 2px 容差）。
  - **B63** ① 交叉点（角手柄）拖动也联动：`movingGroupOf(targets)` 作为唯一入口，
    悬停 / 按下 / 拖动 / 回写四处全走它；角手柄必须**复用子分隔条已注册的 target 对象**。
    ② 双击不再一律 50%，改为**按分割数量均分**：`chainId` 认同轴链，
    `segmentsAlong` → `equalRatio = segA/(segA+segB)`（2 段 50%、3 段 1/3·1/2、
    4 段 1/4·1/3·1/2），整条链 + 各条的联动伙伴一起调。
- **测试规模**：356 vitest + 22 cargo。分屏运行时用例在 `tests/splitview.test.ts`，
  静态契约在 `tests/regressions.test.ts`。

## 下一步

- **待桌面环境补拍截图**（沙箱内起不了 WebView2，只能由用户拍）：
  M4 的 `keymap.png` / `command-palette.png`；B51 的 `main.png` / `preferences.png`；
  **B53–B63 的 `main.png`**（标签栏含文件类型图标 / 面板操作栏 / 分隔条细线 /
  分屏落点浅蓝）；可选补一张 tooltip 演示图。
- ⚠️ **B60–B63 的观感与交互待真机确认**：1px 静息线是否偏细、4px 激活线宽、角手柄
  骑线 + `all-scroll` 是否好抓、浅蓝落点在深色下是否够醒目；**联动**（拖一条一起走 /
  悬停预告 / 交叉点双轴联动 / 双击按段数均分）需真机在 2×2 与 3 栏各验证一次
  （代码路径已修 + 有回归用例，但沙箱内无法跑 UI）。
- 待清理：`menu.ts` 的 `MenuItem.active` 与 `.menu-item-current`（B53 后已无使用者）。
- 待定：是否发 **v0.3.1**（B55–B63 都改了界面；B54 起就留了同一问题未决）。
- M4 之后：M5 规划未定（候选见 DESIGN.md）；观感/交互改进先查 `docs/vscode-reference/`。

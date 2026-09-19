# LitePad 贡献者约定

> 团队约定（非契约）。更深的「改代码前必须知道」不变量见 `.workbuddy/memory/ref/architecture-detail.md`，
> 硬性红线目录见 `.workbuddy/memory/rules/index.md`。

## 提交与版本

- **每个交付一个 Conventional Commit**（如 `feat(window): ...`、`fix(tab): ...`、
  `docs(memory): ...`、`test(...): ...`）。
- **发布版本门禁**：每次编译产出发布版本，顺序 `tsc → vite → vitest → cargo build+test → tauri build`。
  质量门 = `.githooks`（pre-commit: prettier/eslint/tsc/cargo fmt；pre-push: vitest/cargo test）+ GitHub `CI`。
- **发布只由 `v*` tag 触发**：`bash scripts/release.sh <版本>` 同步四文件版本 → 构建 → tag，
  然后 `git push origin main --follow-tags`。`--ci` 跳过本地全量（tauri build 冷启约 38 分钟）。

### 版本号何时该动（SemVer + Conventional Commit）

发布工具不缺（release.sh 已能四处同步 + 打 tag + CI 出包），缺的是**触发**。口径：

| 提交类型 | 版本位 |
| --- | --- |
| `feat`（含 `feat!`） | MINOR |
| `fix` / `perf` | PATCH |
| 破坏性变更（`!` / `BREAKING CHANGE`） | 1.0.0 前记 MINOR，之后 MAJOR |
| `docs` / `test` / `chore` / `style` / `ci` / `refactor` | 不单独触发，只计入累积 |

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
  （运行时 → `tests/smoke.bootstrap.test.ts`；配置/样式 → `tests/regressions.test.ts`；
  Rust wire/序列化 → 内联 `#[cfg(test)] mod tests`）。流程见技能 `litepad-reverse-verify`。
- 跨 IPC 的 DTO 命名两侧必须对齐（camelCase），并补一条真实序列化 round-trip 测试锁住字段名。

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

## 图标

- **所有按钮图标一律用 VS Code codicon**（`src/shell/codicons.ts`，由 `scripts/fetch-codicons.mjs`
  从官方包 `@vscode/codicons@0.0.46-24`（MIT）逐字抽取；生成物**勿手改**，改脚本里的 `ICONS`
  映射后重跑即可复现）。取用一律 `CODICONS.<name>` / `CODICONS[name]`，不得把字形写死在消费方。
- **禁止手绘 SVG 充当图标**。codicon 里确无合适字形时，**先与用户商量**是否引入别的图标集，
  不得自行绘制、临时拼一个或改字号凑数。

## 范围（明确不做）

不做：插件商店、内置终端、Git 集成、LSP。

## 快捷键预设

支持 default / Notepad++ / VS Code 三档预设；优先级：用户覆盖 > 预设 > 默认。

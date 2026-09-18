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

## 范围（明确不做）

不做：插件商店、内置终端、Git 集成、LSP。

## 快捷键预设

支持 default / Notepad++ / VS Code 三档预设；优先级：用户覆盖 > 预设 > 默认。

# LitePad 长期备忘（路由索引）

> 本文件是**仅有的每次会话整篇加载的文件**，刻意精简。
> 需要某域细节 → 按需读 `ref/`；踩坑根因 → 读 `pitfalls/`；约束目录 → `rules/`；未决/日志 → `open-items/`。
> **不要在会话开头一次性读全部 ref/rules/pitfalls/open-items/，只在触碰对应域时加载。**

## 身份 / 技术栈 / 范围
LitePad（B34 更名，LiteMD 已 B36 清理）Tauri 2（Rust 持状态）+ Vite6/TS + CodeMirror6，**仅 Windows**，工作区 `E:\Project\LitePad`。标识 `litepad`/`com.litepad.app`；配置落 `%APPDATA%\LitePad`；原子写入 = 临时文件+fsync+rename。不做：插件商店/内置终端/Git/LSP。最新发布 **v0.8.0**。

## 关键红线（每次会话必读，违反即回滚）
- 📁 **临时文件一律落本项目 `.tmp/`**（09-18，已进 `.gitignore`/`.prettierignore`/eslint `ignores`）；禁写 `%TEMP%`、`~/.workbuddy/`（除 memory/skills）、Git Bash 的 `/tmp`（=`%TEMP%`）。
- ⚠️ **沙箱内禁 `git stash -u`** 或任何触碰 `.git` 的重操作（09-13 全历史丢失）。
- ⚠️ **编辑回报成功 ≠ 已落盘**：改脚本/钩子/配置后必须**回读或 grep 复核**（本环境已多次出现「写了没生效」，09-18 的 pre-push 修复只落了一半，靠一次真实 push 才暴露）→ 踩坑 `pitfalls/0074-prepush-windres-path.md`。
- ⚠️ **门禁脚本「退出码 0 + 日志正常」≠ 生效**（本项目已三连踩）：pre-push 探测结果写 PATH 必须 `cd … && pwd` 归一；`while read` 消费 `git log --pretty=format:` 必须带 `|| [ -n "$sha" ]`；`gen-changelog.sh` 只在发布流程跑一次。门禁/生成器改完一律**真跑一次 + 回读产物** → `pitfalls/0082-changelog-gen-drops-last.md` / `0083-prepush-windres-posix-path.md`。
- ⚠️ **`.workbuddy` 的搬/删只动索引、别碰磁盘命令**：对本目录跑 `git mv`/`git rm`/`rmdir` 会让运行时**整棵 `.workbuddy` 从磁盘消失**（连未触碰的 `skills/`、`overview.md` 一起）。文件仍在 git 索引/`.git/` 里，用 `git checkout HEAD -- .workbuddy` 还原。
- **状态归 Rust、视图归前端**；内存文本 LF，落盘还原原行尾。
- 每个交付一个 Conventional Commit；每个 bug 必须补回归测试 + 改完先**反向验证**（技能 `litepad-reverse-verify`）。
- **界面改动必刷 `docs/screenshots/` 同一提交**；不影响观感在提交信息注明。
- 🎨 **图标一律用 VS Code codicon**（`src/shell/codicons.ts`，由 `scripts/fetch-codicons.mjs` 从 `@vscode/codicons` 抽取；取用 `CODICONS.<name>`）；**禁手绘 SVG**；codicon 无对应字形先与用户商量再引别的图标集（详见 `docs/conventions.md`「图标」/ `rules/index.md`）。
- ⚠️ `docs/*.md` 是说明不是契约，改语义须同步改清单/状态表（B67 守卫）。
- 每次编译产出发布版本：tsc→vite→vitest→cargo build+test→tauri build（门 = `.githooks` + GitHub `CI`）。
- **README 使用者向**：顶部一张 `main.png`，无快捷键/安装/构建/明确不做，避开库名与内部机制。
- 发布版本只通过 `v*` tag 发布（`git push origin main --follow-tags`）；CI 经 `.githooks` + GitHub Actions。
- **版本号必须跟着交付动**（09-18 起）：距最近 tag 有任一 `feat` → `npm run release minor`；有效提交累计 ≥10 → `patch`。pre-push 由 `scripts/check-version-bump.sh` 卡门（达阈值阻断推送），不准出现「开发很久版本号没变」。`CHANGELOG.md` 由 `scripts/gen-changelog.sh` 自动生成，勿手改。

## 路由表（按需读取，勿全量）
| 你需要… | 读 |
|---|---|
| 跨域架构**总览**（设计支柱/模块地图/各关注点一句话） | `docs/architecture.md`（**可发布**，面向贡献者） |
| 某子系统**深层不变量**（文档模型/布局/拖拽/视图红线/样式/功能落点/通用教训） | `ref/architecture-detail.md`（**内部**） |
| 多窗口（卫星窗口）不变量 | `ref/multiwindow.md`（**内部**） |
| 沙箱/构建环境**特有坑**（PATH/WebView2/截图） | `ref/session-env.md`（**内部**，不进 `docs/`） |
| 构建/环境命令（工具链/打包/WebView2Loader/改名/CI） | `docs/build-env.md`（**可发布**） |
| 贡献者约定（提交/测试/README/临时文件/范围/键位） | `docs/conventions.md`（**可发布**） |
| 约束/红线**全量目录**（按域分类） | `rules/index.md`（**内部**） |
| 某次 bug 的**踩坑根因与判据**（ADR 式） | `pitfalls/<NNNN>-<slug>.md`（**内部**） |
| 未决/待确认/待清理/版本规划 | `open-items/backlog.md`（**内部**） |
| 逐日改动明细 | `open-items/2026-09-DD.md`（**内部**） |

> 说明：`docs/*.md` 是**面向贡献者/用户的可发布文档**，内容脱敏（不含「会话加载」「按需」「沙箱」等内部黑话与内部路径）；其余 `.workbuddy/memory/` 下文件是**智能体内部记忆**，随项目演进维护。两者内容须保持一致（改一处同步另一处）。

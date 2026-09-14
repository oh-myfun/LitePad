# LitePad 项目长期备忘

应用名 **LitePad**（B34 起更名；原名 LiteMD 已于 B36 在**全仓库**清理完毕）。工作区 `E:\Project\LitePad`。

> 本文件是精炼索引，不承载全部细节。展开见同目录：
> `ARCHITECTURE.md`（架构不变量与踩坑根因）· `BUILD-ENV.md`（构建/会话环境精确命令）·
> `LiteMD-Space-Archive.md`（旧 LiteMD 空间会话与记忆归档）· `2026-09-*.md`（逐日工作日志，最详细）。

## 技术栈与范围

- Tauri 2（Rust 持有状态）+ Vite 6/TypeScript + CodeMirror 6（视图）；**仅 Windows**。
- 标识：productName/exe `litepad`、identifier `com.litepad.app`、配置落 `%APPDATA%\LitePad`。
- 编码 encoding_rs + chardetng；原子写入 = 临时文件 + fsync + rename。
- 明确不做：插件商店、内置终端、Git 集成、LSP。

## 项目约定（用户明确要求）

- **状态归 Rust、视图归前端**；内存中文本一律 LF，落盘时还原原行尾。
- **git 全程管理**：每个交付一个 Conventional Commit。
- **用户报告的每个 bug 必须补对应回归测试用例**，修 bug 与补测试同一提交：
  运行时可测 → `tests/smoke.bootstrap.test.ts`（jsdom 真实 bootstrap）；
  配置/样式根因 → `tests/regressions.test.ts`（静态文件断言）；
  Rust 侧 wire 格式/序列化 → `src-tauri/src/**` 内联 `#[cfg(test)] mod tests`。
- **界面有改动必须刷新 `docs/screenshots/` 截图**（B49 起，用户明确要求）：
  菜单/工具栏/状态栏/对话框/配色/字体/标签栏等观感变化，与代码改动**同一提交**更新截图；
  代码合并前确认截图与当前界面一致，确实不影响观感则在提交信息注明「界面无变化」。
  截图清单、演示会话构造与截取命令见 `docs/screenshots/README.md`。
- **每次编译都要产出发布版本**：`npm run build:all`（tsc → vite → vitest → cargo build+test → tauri build，出 exe + NSIS）。
- 质量门 = `.githooks`（pre-commit: prettier/eslint/tsc/cargo fmt --check；pre-push: vitest/cargo test）；
  GitHub 侧另跑 `CI`（push main / PR：format→lint→tsc→vite→vitest→cargo test）。
- ⚠️ **沙箱内禁止 `git stash -u` 或任何触碰 `.git` 的重操作**（09-13 一次误操作致全历史丢失，只能重建）。

## 发布

- `bash scripts/release.sh <x.y.z|patch|minor|major> [--ci]`：版本**四处**同步
  （package.json / tauri.conf.json / Cargo.toml / Cargo.lock）→ 构建 → `chore(release): vX.Y.Z` + tag。
  `--ci` 跳过本地全量构建（本机冷启 tauri build 要 38 分钟；Actions 本来就会构建）。
- **GitHub 的 Release 只由 `v*` tag 触发**：只推 `main` 只会跑 CI 编译校验，不会发布。
  推 tag：`git push origin main --follow-tags`；失败可在 Actions 手动 dispatch（填 tag）重跑。
- 当前状态：**v0.2.2 已发布**（v0.2.0 首个 Release → v0.2.1 构建成功 → v0.2.2 修好安装包缺 DLL）；
  版本一致性由 `tests/regressions.test.ts` 断言守护。

## 构建环境要点

- 本机**无 MSVC**，宿主工具链用 `stable-x86_64-pc-windows-gnu`（`rust-toolchain.toml` 锁定 + MSYS2 MinGW 链接器）。
- 精确 PATH、会话内分步构建、以及 safe-delete shim / npx 异常 / cargo collect2 ICE 等坑 → 见 `BUILD-ENV.md`。
- 沙箱内 cargo/tauri 构建需 `dangerouslyDisableSandbox`，链接前先杀掉运行中的 `litepad.exe`。

## 进度

- **M0–M3 全部交付**：M0 脚手架 → M1（语言注册表 55 类/多标签/搜索/设置/日志）→
  M2（自由分屏/会话恢复/自动保存/文件监听/跨文件搜索）→ M3（Markdown 渲染）。
- 之后是 B4–B35 系列缺陷修复与 UI 打磨：菜单栏 + 图标工具栏二分、同源多实例、
  指针拖拽分屏、查找悬浮栏、大纲跟随活动面板、标签溢出折叠、Ctrl+滚轮缩放、图标矢量重绘、
  发布流程与格式检查链。逐条见 git log 与日志。
- **B34** 应用更名 LitePad + 矢量图标；**B35** prettier/eslint/rustfmt 链 + `scripts/release.sh` + GitHub Actions；
  **B36** 全仓库清理 LiteMD 残留（回归断言升级为全仓库扫描）+ 旧空间记忆归档；
  **B37** 接入 main 分支 CI + 手动触发，发布 **v0.2.0**（首个 GitHub Release，流水线首次实跑通过）。
- **B41** 图标定为无背景折角文档+钢笔（钢笔头朝左下），修好 `build.rs` 未盯 `icons/` 导致旧图标入 exe；
  **B42** 菜单重组为 文件/编辑/查看/设置/帮助，新增「设置→首选项（二级子菜单）」与**可编辑快捷键面板**
  （`src/shell/keymap.ts` 注册表 + `Settings.keymap` 持久化），大纲/折叠展开补齐默认键位。
  该批暴露 **CodeMirror 内置键位静默吞键并改写文档** 的问题（详见 `ARCHITECTURE.md` §8）。
- **B43** 图标微调：钢笔 0.78→0.62、笔尖收进文档中间靠下（不再压角）、去掉文档投影。
  方案 B 几何已收进 `gen_icons.py` 的 `B_*` 常量，改图标只需动那几个数。
- **B44** 标签栏折叠态不重算：补尺寸监听（ResizeObserver + window.resize 退化 + rAF 合并）、
  活动标签拉回门控 `activeChanged`、窗口没铺满时左移补满（`fitCountFromEnd`）。
  三条不变量已写进 `ARCHITECTURE.md` §7「标签栏溢出」，改这块前务必先读。
- **B45** 关闭非活动标签不再「先切过去再切回」：保存改用按实例寻址的 `saveDocCore`，
  并加 `wasShown` 判定——关后台标签不动显示内容。「关闭其他/右侧」的批量闪烁一并解决。
  通用教训见 `ARCHITECTURE.md` §8 首条（同步改 UI + 之后 await = 中间态被绘制）。
- **B46** 首选项从二级子菜单升级为**弹窗设置窗口**（`src/shell/preferencesdialog.ts`，即时生效+持久化），
  新增精细选项：编辑器字体（`Settings.font_family`）、编辑器行距（`Settings.editor_line_height`）、
  字号档位；偏好 setter 全部改为绝对值型（setWordWrap/setAutosave 等），toggle 系是其包装。
- **B47** 折叠标签列表：点选后**菜单保持打开**可连点（menu.ts 的 keepOpen + refreshPopupMenu）、
  当前项不打 ✓ 改整行观感（`.menu-item-current`）、激活标签闪一下（`.tab-flash`）、
  折叠按钮改矢量图标 + 角标（`MORE_WIDTH` 34→28）并可再点收起（anchorToggle）。
  弹层通用能力见 `ARCHITECTURE.md` §7。
- **B48** 安装包补 `WebView2Loader.dll`（否则装好起不来）；踩坑与排查三步见 `BUILD-ENV.md`。
- **B49** ① 写 `README.md`（含真实截图）；② **修会话恢复全线失效**：Rust `TabSession`/`SessionState`
  少 `rename_all = "camelCase"`，前端 camelCase 与落盘 snake_case 两侧对不上，
  表现为重启后**光标回到第 1 行、预览模式丢失、活动面板错位**（B49 前一直是坏的）。
  修法 = 加 `rename_all` + 对旧字段加 `serde(alias)` 兼容，并补 Rust round-trip 测试。
  截图基建：`scripts/screenshot.py` 支持 `--exe` / `--pid` / `--size`（按进程定位窗口，避免标题撞名）。

## 下一步

- M4 性能与打磨：大文件分级降级、命令面板、键位预设、正式图标。
- 待用户桌面环境验证的条目散见各日志（沙箱内无法做 UI 冒烟）。

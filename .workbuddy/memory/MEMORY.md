# LitePad 长期备忘（路由索引）

> 本文件是**仅有的每次会话整篇加载的文件**，刻意精简（约 40 行）。
> 需要某域细节 → 按需读 `ref/<domain>.md`；某次踩坑根因 → 读 `adr/<NNNN>-<slug>.md`。
> **不要在会话开头一次性读全部 ref/adr/**，只在触碰对应域时加载。

## 身份 / 技术栈 / 范围
LitePad（B34 更名，LiteMD 已 B36 清理）Tauri 2（Rust 持状态）+ Vite6/TS + CodeMirror6，**仅 Windows**，工作区 `E:\Project\LitePad`。标识 `litepad`/`com.litepad.app`；配置落 `%APPDATA%\LitePad`；原子写入 = 临时文件+fsync+rename。不做：插件商店/内置终端/Git/LSP。里程碑 **v0.3.0**。

## 项目约定（每次会话必读）
- **状态归 Rust、视图归前端**；内存文本 LF，落盘还原原行尾。
- 每个交付一个 Conventional Commit；每个 bug 必须补回归测试 + 改完先**反向验证**（还原修复一次确认用例真会红，技能 `litepad-reverse-verify`）。
- **README 使用者向**：顶部一张 `main.png`，无快捷键/安装/构建/明确不做，避开库名与内部机制。
- **界面改动必刷 `docs/screenshots/` 同一提交**；不影响观感在提交信息注明。
- 每次编译产出发布版本：tsc→vite→vitest→cargo build+test→tauri build（门 = `.githooks` + GitHub `CI`）。
- ⚠️ `docs/*.md` 是说明不是契约，改语义须同步改清单/状态表（B67 守卫）。
- ⚠️ **沙箱内禁 `git stash -u`** 或任何触碰 `.git` 的重操作（09-13 全历史丢失）。
- 📁 **临时文件一律落本项目 `.tmp/`**（09-18，已进 `.gitignore`/`.prettierignore`/eslint `ignores`）；禁写 `%TEMP%`、`~/.workbuddy/`（除 memory/skills）、Git Bash 的 `/tmp`（=`%TEMP%`，非 `E:\tmp`）。

## 按需路由表
| 你需要… | 读 |
|---|---|
| 跨域架构总览 / 域清单 | `ARCHITECTURE.md`（地图，不含细节） |
| 某子系统不变量（文档模型/布局/拖拽/多窗口/设置/保存…） | `ref/<domain>.md` |
| 某次 bug 的踩坑根因与判据 | `adr/<NNNN>-<slug>.md` |
| 构建/环境命令（PATH/WebView2/截图） | `BUILD-ENV.md` |
| 未决/待确认/待清理/版本规划 | `OPEN-ITEMS.md` |
| 逐日改动明细 | `2026-09-*.md` |

## 当前已建 ref/adr（样本，逐步迁移中）
- `ref/multiwindow.md` — §9 多窗口（卫星窗口）不变量（已迁出）
- `adr/0072-webview2-shared-env.md` — B72 卫星窗口须照抄主窗 WebView2 参数

> 其余域仍在 `ARCHITECTURE.md` 原文，迁到 `ref/` 是渐进过程，不一次性重写历史。

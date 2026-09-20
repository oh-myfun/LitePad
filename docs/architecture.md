# LitePad 架构总览

> 贡献者向的架构说明（非契约）。实现细节以源码为准；深一层的「改代码前必须知道」不变量见
> `.workbuddy/memory/ref/architecture-detail.md`（团队内部）。踩坑根因见 `.workbuddy/memory/pitfalls/`。

## 设计支柱

- **状态归 Rust，视图归前端**。Rust 侧（`src-tauri`）持有文档模型、脏标记、会话、备份与窗口；
  前端（`src/` + Vite/TS + CodeMirror 6）只渲染与转发意图。两者通过 Tauri IPC（`src/ipc/api.ts`
  ↔ `src-tauri/src/commands`）通信，Payload 两侧字段名必须一致（camelCase）。
- **单平台**：仅 Windows，基于 Tauri 2 + WebView2。
- **内存文本一律 LF**；落盘时还原文件原始行尾。
- **原子写入** = 写临时文件 + `fsync` + `rename`（同卷原子），临时文件落在目标同目录。
- **同源多实例**：同一文件可在多个面板（甚至多个窗口）各建实例，靠 ChangeSet 广播同步。

## 模块地图

| 层 | 关键位置 | 职责 |
|---|---|---|
| 文档模型 | `src-tauri/src/doc.rs`、`tab.rs`、`session.rs`、`backup/` | 文档/实例/会话/热退出副本 |
| 编辑器 | `src/editor/`（CodeMirror 6 封装）、`src/shell/find.ts`、`outline` | 编辑、查找、大纲 |
| 外壳/UI | `src/shell/`（main / menubar / tooltip / zoom / preferencesdialog / keymap / keymapdialog / splitview / tabstrip） | 菜单、提示、缩放、设置、快捷键、布局、标签栏 |
| 预览 | `src/editor/preview/` | Markdown 渲染与预览内查找 |
| 窗口 | `src-tauri/src/windows.rs` | 主窗口 + 卫星窗口（多窗口） |
| 构建/打包 | `src-tauri/tauri.conf.json`、`build.rs`、`scripts/release.sh` | 版本、图标、NSIS |

## 各关注点一句话

- **文档/实例模型**：`Doc`（按 `tabId` 唯一）持元数据与脏标记，`实例`（`nextInstId`）持独立视图状态；
  编辑以 ChangeSet 广播同步到同 doc 的所有实例。
- **置脏判据**：CM6 的 `update.docChanged` 不等于「内容变了」；置脏必须比 `startState/doc` 与
  `state/doc` 的字符串。
- **布局树与分割条**：`splitview.build()` 传给 `onRatioChange` 的 path 是分割节点自身树路径；
  最大化 = 只改比例不动结构；关面板要做比例补偿。
- **拖拽体系**：标签/大纲拖拽用指针编排（mousedown/move/up），因为 Tauri 的 `dragDropEnabled`
  会禁用页面内 HTML5 DnD；文件拖入经 `onDragDropEvent` 拿真实路径。
- **视图刷新红线**：mousedown 链路上绝不做 DOM 重建（否则「切换面板要点两下」）。
- **样式与主题**：组件统一用 CSS 变量；`hidden` 属性必须配 `display:none`。
- **查找/大纲/缩放/设置/快捷键/菜单/标签栏/分屏/提示/保存/图标**：见 `src/shell/` 与各 `ref` 详情。
- **多窗口（卫星窗口）**：新窗口与主窗口共享文档状态、标签可来回拖；「文档只有一个真相」跨 WebView 成立。
  跨窗口拖拽与窗口内**同语义**：途中只亮落点预览，**松手才提交**——指针掠过哪块面板都不会
  立刻生效（Windows 的鼠标隐式捕获让目标窗口收不到鼠标事件，落点靠 `src/shell/windowdrag.ts`
  的跨窗口协议来回通报）。
  详情见 `.workbuddy/memory/ref/multiwindow.md`。

## 质量与发布

- 每次交付一个 Conventional Commit；每个 bug 必须补回归测试并做反向验证
  （技能 `litepad-reverse-verify`）。
- 每次编译产出发布版本：`tsc → vite → vitest → cargo build+test → tauri build`，
  质量门 = `.githooks`（pre-commit: prettier/eslint/tsc/cargo fmt；pre-push: vitest/cargo test）+ GitHub `CI`。
- 发布只由 `v*` tag 触发（`git push origin main --follow-tags`）。当前里程碑 **v0.3.0**。

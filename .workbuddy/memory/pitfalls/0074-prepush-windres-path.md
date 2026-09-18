# ADR 0074：pre-push 的工具链 PATH 兜底必须独立判定 windres

- **状态**：Accepted
- **域**：构建 / CI / git 钩子
- **来源**：B75（版本号规则 + CHANGELOG 落地）
- **关联**：`.githooks/pre-push`；`docs/build-env.md`；历史里 09-13 / 09-14 两次
  「`windres: preprocessing failed` 瞬时故障」其实是同一类缺口

## 背景（Context）
一次 `git push` 被门拦下：vitest **458 全绿**，却报 `cargo test 未通过`，细节是
`panicked ... NotAttempted("windres")`。同一份 Rust 代码手动跑 `cargo test` 却是 40 passed。

## 根因（Root Cause）
1. `tauri-winres` 在 build.rs 阶段要调 `windres`，它由 MSYS2 MinGW64 提供
   （`/c/msys64/mingw64/bin/windres.exe`）。
2. pre-push 的兜底原本写成
   `command -v cargo || { for d in ~/.cargo/bin /c/msys64/mingw64/bin; do [ -x $d/cargo.exe ] && PATH=…; done }` ——
   **`mingw64/bin` 里并没有 `cargo.exe`，这个目录永远进不了 PATH**；而 cargo 在本机是从
   `~/.cargo/bin` 命中的，整段兜底因短路根本不执行 ⇒ windres 始终不在 PATH。
3. 于是 `tauri-winres` 拿不到工具 → panic → 钩子报成「cargo test 未通过」。**与代码无关**。
4. 历史上两次「windres 瞬时故障」（09-13、09-14）应是同一缺口，当时被当成偶发、没往下挖。

## 决策（Decision）
- windres 的探测**独立成段**，绝不挂在「找不到 cargo」的条件里（一挂就永不生效）。
- 判据用 **`[ -x "$w/windres.exe" ]` 直测候选目录**，不用 `command -v windres` ——
  钩子环境里实测不准：同一段逻辑在交互 shell 能找到，在 git 钩子进程里却判不到。
- 仍然缺 windres 时按钩子既有哲学**警告跳过**（环境缺失 ≠ 代码红），并打印修复指引。

## 后果与守卫（Consequences）
- 修复后 pre-push 会真的跑 cargo test（40 passed），不再「假绿跳过」。
- ⚠️ **配套教训：改完必须回读文件确认落盘**。本环境出现过「编辑回报成功但内容没写入」的情况 ——
  这次第一版修复就只落了一半（条件判断进了、补 PATH 那段没进），靠一次真实 push 才暴露。
  涉及钩子/脚本/配置的改动，**回读 + 真跑一次**才算完。
- MSYS2 若装到别的盘/前缀，需同步改 `.githooks/pre-push` 的候选目录列表。

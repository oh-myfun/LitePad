# ADR 0083：pre-push 命中 windres 目录后必须归一成 POSIX 路径，否则 cargo 仍 panic

- **状态**：Accepted
- **域**：构建 / CI / git 钩子
- **来源**：B83（v0.8.0 推送时复现，紧接 0074 的第二次教训）
- **关联**：`pitfalls/0074-prepush-windres-path.md`（上游：**探测** windres，本条的续集）；
  `.githooks/pre-push`；守卫 `tests/regressions.test.ts` B83；
  同源的 `COREUTILS_DIR` 归一（见 `ref/session-env.md`）

## 背景（Context）
0074 修掉了「windres 探测段被短路」的问题，探测本身不再漏。但 09-19 推送 v0.8.0 时，
钩子**打印了一切正常的日志**：

```
▸ coreutils: /usr/bin
▸ cargo test（windres: C:/msys64/mingw64/bin）
```

`windres:` 后面明明指着一个有 `windres.exe` 的目录，cargo 却仍然：
`panicked ... NotAttempted("windres")` → 钩子报「cargo test 未通过」。**又是假红。**

## 根因（Root Cause）
0074 候选表的第一项是 **Windows 风格** `C:/msys64/mingw64/bin`，`[ -x "$w/windres.exe" ]`
确实为真（MSYS 的 `test` 能吃 Windows 路径），于是 `break` 并把这个**原样**写进 PATH。

问题在**下游**：cargo 是**原生（非 MSYS）进程**，它把 PATH 交给
`build.rs → embed-resource → windres` 去找可执行文件时，`C:/…` 这种条目在 MSYS 的
路径转换体系里既不会被 shell 搜到，也不会被正确转成原生形式 ⇒ 命中不了。

**判据**：本环境下写进 PATH 的目录，命中后必须经 `cd "$w" && pwd` 归一成 `/c/…`。
这不是新知识 —— 同文件上面的 `COREUTILS_DIR` 就是同一条教训写的（`..` 原始路径
写进 PATH 后 `command -v` 搜不到）。这次是同一个坑换了个位置再踩一遍。

## 决策（Decision）
候选命中后立刻归一，再写 PATH：

```sh
WINDRES_DIR=""
for w in "C:/msys64/mingw64/bin" "/c/msys64/mingw64/bin" "/c/msys64/ucrt64/bin" "/c/msys64/clang64/bin"; do
  if [ -x "$w/windres.exe" ]; then
    WINDRES_DIR="$(cd "$w" 2>/dev/null && pwd)"   # ← 必须归一
    break
  fi
done
```

同时：**凡是要写进 PATH 的探测结果，一律 `cd … && pwd` 归一**（无论 MSYS 工具还是原生工具）。
新增 **B83** 守卫断言这行归一存在。

## 后果与守卫（Consequences）
- 归一成 `/c/msys64/mingw64/bin` 后，`cargo test` **40 passed**，pre-push 全绿（实测）。
- ⚠️ **本条的教训不是「windres 特殊」，而是「打印正确 ≠ 生效」**：
  钩子日志看起来无懈可击（coreutils 找到了、windres 找到了、cargo 也跑了），
  红的却是最下游。排查这类问题要**顺着 PATH 实际被谁消费**走一遍，别停在日志上。
- ⚠️ 与 0074 的「改完必须回读 + 真跑一次」、0082 的「退出码 0 也可能是错的」同源：
  本项目的门禁脚本反复出现**静默/假绿失效**，改动后一律真跑一次。
- ⚠️ 反向验证过：把钩子改回 `WINDRES_DIR="$w"` 旧写法，B83 立刻报红；还原即绿。

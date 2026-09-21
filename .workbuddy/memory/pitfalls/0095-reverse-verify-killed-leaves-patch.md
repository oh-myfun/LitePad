# ADR 0095：反向验证脚本被硬杀 → 源文件停在「探针补丁」状态，伪装成自己写的代码有 bug

- **状态**：Accepted（09-21 B91-2 回归修复时实测踩到）
- **域**：工具链 / 验证（`scripts/reverse-verify-*.cjs`）
- **来源**：`node scripts/reverse-verify-B91.cjs | tail -32` 被 Bash 工具超时杀掉
- **关联**：技能 `litepad-reverse-verify`（已把这条补进铁律与模板）；
  `pitfalls/0092`（同族：构建链上的环境性抖动，症状不像环境）

## 背景（Context）

反向验证脚本的机制是：**临时改写源文件 → 跑测试 → 在 `finally` 里按字节还原**。
判据是「对应用例必须变红」，结束时再用 sha256 自检还原是否逐字节一致。

B91-2 回归修复时，脚本加了 4 条新探针后总共 22 条，整跑约 2.5 分钟。
我用 `node scripts/reverse-verify-B91.cjs 2>&1 | tail -32` 调用 —— 这个组合同时踩了两个坑。

## 根因（Root Cause）

**坑 1（致命）：超时 SIGTERM 让 `finally` 不执行。**
Bash 工具默认 120s 超时，杀掉进程时 `finally` 没有机会跑 → `src/shell/tabdnd.ts` 停在
**探针 ③-1 的补丁状态**（`setTimeout(() => image.remove(), 0)` 被改回 `image.remove();`）。
Node 的 SIGTERM 处理器在 Windows 上**捕不到**（Node 不会生成该信号），注册 handler 也没用。

**坑 2（掩盖真相）：管道下 `process.exit()` 会截断缓冲输出。**
被 SIGTERM 的那次 stdout 是**空**的 —— 看起来像「脚本什么都没跑就死了」。
`console.log` 到管道是异步缓冲的，`process.exit()` 不会等它 flush。

**症状（最容易误导人的一步）**：留下补丁后，`git status` 里 `src/shell/tabdnd.ts` 显示被改，
内容看着就像「我刚写的那行」；单跑那条用例红，而它在我刚提交的版本里是绿的 ——
**看起来完全像自己写的代码有 bug**（尤其当时刚改完影像摘除的时机）。

**判据**：`git status` 里有个**你没动过**的源文件被改，内容恰好等于某条探针的 `to` 片段；
`git diff` 的方向与你的修改**相反**（本次是「异步 → 同步」，而我是把同步改成了异步）。

## 决策（Decision）

1. **跑反向验证一律后台 + 重定向日志**，`cat` 结果：
   ```sh
   node scripts/reverse-verify-B91.cjs > .tmp/rv-b91.log 2>&1; echo "exit=$?"; cat .tmp/rv-b91.log
   ```
   `run_in_background: true`，绝不用 `| tail`。
2. **脚本自带兜底还原**：`process.on("exit", restoreAll)` + `SIGINT/SIGTERM/SIGHUP`，并登记
   `BACKUP`（每探针改写前把原文存进去）。
3. **跑完立刻 `git status` 复核**，末尾的 sha256 自检是最后一道（但被硬杀时它也不会打印）。
4. **`checkFilter` 要区分「没选中」与「选中但失败」**：本次顺带发现旧实现用 `passed > 0`
   判断「过滤器是否选中用例」，而**用例失败时 `passed` 也是 0** → 把「用例失败」误报成
   「过滤器无效（应写用例名）」，把人往错误方向带。改用汇总行里的 `ran` 判据
   （`Tests N passed|N failed`），并把「红」定义成 `!ok && ran`（否则 vitest 启动失败会让
   **每个**探针都「红」）。

## 后果与守卫（Consequences）

- 代价：一次反向验证必须后台跑、等通知、再 `cat` 日志；换来的是不会静默污染工作区。
- ⚠️ **旧交付的 `scripts/reverse-verify-*.cjs` 不随重构自动更新**：把 `image.remove();`
  改成 `setTimeout(...)` 之后，原先锚在 `    image.remove();` 上的探针命中 0 次。
  好在 `replaceOnce()`/命中数校验会把它判成**无效**（既不是红也不是绿），不会默默判绿 ——
  这正是那层护栏的价值。**改了被探针锚定的写法，必须同步改脚本并重跑。**
  本次顺手也修好了 `-t` 过滤器（测试改名后早已失效，靠 `checkFilter` 才发现）。
- 与 `pitfalls/0091`（批量 Edit 互相覆盖）、`0092`（构建产物句柄）同族：
  **本项目的工具链在 Windows 上有「看起来像代码缺陷」的环境性陷阱**，
  判据一律是「同样代码前一次刚通过 / 改动方向与我的修改相反」。

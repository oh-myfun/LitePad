# pitfalls/ — 踩坑记录（ADR 式）

> 每条一个原子文件，按「域 + 序号」命名：`<NNNN>-<slug>.md`。
> 格式沿用 Nygard ADR：背景 / 根因 / 决策 / 后果与守卫。
> 按需读取；路由总表见 `MEMORY.md`。领域不变量见 `ref/`，约束目录见 `rules/index.md`。

| 编号 | slug | 一句话 |
|---|---|---|
| 0072 | webview2-shared-env | 卫星窗口须照抄主窗口 WebView2 浏览器参数，否则建不出窗口 |
| 0073 | hidden-vs-display-flex | 设了 `display:flex` 的元素，`hidden` 属性被盖掉（静默失效，已踩三次） |
| 0074 | prepush-windres-path | pre-push 缺 MSYS2 PATH 时会把「缺 windres」误报成测试失败 |
| 0075 | css-comment-star-slash | CSS 注释里写出 `*/`（如 `.*` 紧跟 `/`）会提前闭合注释，并连带打穿静态守卫 |
| 0078 | findbar-replace-width-stale | 查找/替换两框同宽要跟随 resize，量一次会过期（测量早于 setCount 会算出旧值） |
| 0082 | changelog-gen-drops-last | `git log --pretty=format:` 末条无换行，`while read` 静默吞掉区间内最旧提交 |
| 0083 | prepush-windres-posix-path | 钩子里写进 PATH 的探测结果必须 `cd … && pwd` 归一，`C:/…` 对原生子进程是死路 |
| 0085 | vite-hangs-when-msys2-in-path（文件名历史遗留，实为「vite 间歇性挂死」） | `vite build` 会概率性挂在写盘阶段（CPU 不涨、内存 ~1.7G）；须剥离 MSYS2 PATH 条目 + 超时重试 |
| 0091 | batched-edits-overwrite | 同一文件在同一批里的多个 Edit 互相覆盖，**每个都回报成功**；改完必须逐处回读 |
| 0092 | tauri-build-artifact-lock | 上一次构建的产物句柄未释放 → 打包/链接报 `os error 32` / `Permission denied`（删产物重跑，别当代码缺陷） |

新增踩坑时：在对应 `ref/<domain>.md` 的原文处替换为指向本目录某记录的指针，并新建一条
`<NNNN>-<slug>.md`（序号取 B 编号，slug 用 kebab-case 概括根因）。

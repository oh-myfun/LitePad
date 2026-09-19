# ADR 0085：vite build 在 PATH 含 MSYS2 条目时**挂死**（不是慢，是不动）

- **状态**：Accepted（09-20 实测坐实；此前两轮只记为「疑点未定论」）
- **域**：构建 / 环境
- **来源**：B85（v0.8.0 之后的复盘；同源记录见 `ref/session-env.md` §5、open-items/2026-09-19.md B78 节）
- **关联**：`.githooks/pre-push`、`scripts/build-all.sh`、守卫 `tests/regressions.test.ts` B85；
  与 0083 同源（都是「MSYS 下 PATH 条目对某个消费者是毒药」，只是这次的消费者是 node/vite 而非原生 cargo）

## 背景（Context）
09-19 在 `build-all.sh` 里 `vite build` **两次卡死**：transform 完、写完部分产物后进程不退出，
挂 1 小时。当时规避为「分步跑」，疑点标在脚本顶部把 `/c/msys64/mingw64/bin` 前插进 PATH，
**未定论**。

09-20 做「推送前本地构建」时再次复现，这次有条件做对照：

| 命令 | PATH | 结果 |
|---|---|---|
| `npm run build` | 含 `/c/msys64/mingw64/bin` | **挂死** 13 分钟不出产物 |
| `npm run build` | 剥离该条目 | **40s** 完成 |

## 根因（Root Cause）
为给 cargo 提供 `windres` 而把 MSYS2 的 `mingw64/bin` 加进 PATH 后，**node/vite 会在其中挂住**。

指纹（**判别「慢」还是「挂」的关键**）——挂死时：

- `dist/assets/` 被**清空后一直不写入**（`index.html` 也停在旧时间）；
- 主 node 进程 **CPU 只走 ~25s 就不再增长**，内存却涨到 **~1.8G**；
- `esbuild.exe` 子进程 CPU ~0.4s，完全空闲；
- 没有任何 cargo/rustc 进程（说明根本没走到 Rust 侧）。

⚠️ **不要把它当成「构建很慢」去等**。本项目 release 构建确实要几分钟，但那是
**rustc CPU 持续爬升**（实测 2.5 分钟爬到 76s）。**CPU 不涨 + 内存畸高 = 挂死**，
判据就是看 CPU 时间是否随墙钟增长。

## 决策（Decision）
前端构建**必须在剥离 MSYS2 条目后的 PATH 下跑**，Rust 侧仍用完整 PATH（它需要 windres）：

```sh
FE_PATH=""
OLDIFS="$IFS"; IFS=":"
for d in $PATH; do
  case "$d" in
  *msys64*) ;;                       # ← 摘掉
  *) FE_PATH="${FE_PATH:+$FE_PATH:}$d" ;;
  esac
done
IFS="$OLDIFS"
PATH="$FE_PATH" npm run build        # 仅对这一条命令生效，跑完 PATH 自动恢复
```

落地在两处：`.githooks/pre-push`（新增的本地构建段）与 `scripts/build-all.sh`（原发地）。
守卫 **B85** 断言两处都有 `PATH="$FE_PATH" npm run build` 与 `*msys64*) ;;`。

## 后果与守卫（Consequences）
- 前端构建稳定在 ~40s；「推送前本地构建」这条硬门才可能落地（否则每次推送都可能挂住）。
- ⚠️ **与 0083 是同一族问题**：MSYS 环境里「为 A 加的 PATH 条目，可能是 B 的毒药」。
  0083 里 `C:/…` 毒死原生 cargo；这里 `/c/msys64/mingw64/bin` 毒死 node/vite。
  以后往 PATH 里加东西，要想一遍「这份 PATH 还会被谁消费」。
- ⚠️ 排查口诀：**先看 CPU 时间是否随墙钟增长**，再看产物目录有没有被清空后不写入。
  光看「命令还在跑」会把挂死误判成慢（`ps -W` 的 CPU 列 / `Get-Process` 的 `CPU`）。
- ⚠️ 卡死会清空 `dist/assets` 且只写一半 → **kill 后必须重跑 vite**，别直接进下一步。

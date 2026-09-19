# ADR 0085：`vite build` 会**间歇性挂死**（写盘阶段不动，内存 ~1.7G）

> ⚠️ 文件名是**历史遗留**：初版误以为根因是「PATH 含 MSYS2 条目」，后来证实那只是诱因之一
> （剥离后仍复现），真实范围是「vite 构建间歇性挂死」。改名要动 `.workbuddy` 目录（`git mv`
> 有清空整棵目录的风险，见 `MEMORY.md` 红线），故保留旧名 + 在此注明。


- **状态**：Accepted（09-20 多轮实测）
- **域**：构建 / 环境
- **来源**：B85（`pre-push` 引入本地构建门后暴露；09-19 在 build-all.sh 里已出现过两次）
- **关联**：`.githooks/pre-push`、`scripts/build-all.sh`、守卫 `tests/regressions.test.ts` B85；
  `ref/session-env.md` §5；与 0083 同族（MSYS 下「PATH 条目对某个消费者是毒药」）

## 背景（Context）
09-19 `build-all.sh` 里 `vite build` 两次卡死：transform 完、写完部分产物后进程不退出，挂 1 小时。
09-20 给 pre-push 加本地构建门后又连着复现，一共拿到四次观测：

| # | 场景 | PATH | 结果 |
|---|---|---|---|
| 1 | 手动 `npm run build` | **含** `/c/msys64/mingw64/bin` | 挂 13 分钟 |
| 2 | 手动 `npm run build` | 剥离该条目 | **40s** 完成 |
| 3 | pre-push 钩子内（已剥离该条目） | 钩子 PATH | **挂住**，卡在 `✓ 2667 modules transformed` 之后 |
| 4 | 手动 `npm run build`（剥离后） | 同 #2 | **71s** 完成 |

## 根因（Root Cause）
**没有单一根因，是概率性的写盘阶段挂死。** 能确定的只有：

- 挂点固定：rollup 报完 `✓ N modules transformed` 之后，**写 `dist/assets` 的阶段**不动；
- 指纹：**CPU 不再增长**（实测停 ~25s / 64s），**内存却涨到 ~1.7–1.8G**；
  `esbuild` 子进程 CPU ~0.2s 全空闲；`dist/assets` 被清空后不写入（或只写一部分）。

⚠️ **结论修正（重要）**：#1/#2 的 A/B 一度指向「PATH 含 MSYS2 条目」，但 **#3 证明剥离后仍会挂**
—— 所以 MSYS2 条目至多是**诱因之一，不是充分条件**。曾把它写成「根因坐实」是错的，别再照抄旧结论。
（剥离仍然要做：#1/#2 表明它确实会提高触发概率。）

## 决策（Decision）
两层兜底，**缺一不可**：

1. **跑前端构建前剥离 PATH 里的 MSYS2 条目**（Rust 侧需要 windres，仍走完整 PATH）：

```sh
FE_PATH=""
OLDIFS="$IFS"; IFS=":"
for d in $PATH; do
  case "$d" in *msys64*) ;; *) FE_PATH="${FE_PATH:+$FE_PATH:}$d" ;; esac
done
IFS="$OLDIFS"
```

2. **超时 + 重试一次**（挡住「挂死把推送无限期卡住」）：

```sh
TO=""; if command -v timeout >/dev/null 2>&1; then TO="timeout -k 10 240"; fi
BUILD_OK=0
for attempt in 1 2; do
  if PATH="$FE_PATH" $TO npm run build; then BUILD_OK=1; break; fi
done
```

- `timeout -k` 是必须的：只发 TERM 时 npm 未必带走 node，会留下孤儿继续吃 1.7G 内存；
- `timeout` 不存在时退化为不超时，别让「缺 coreutils」反过来挡住推送。

落地：`.githooks/pre-push`（两层都有）、`scripts/build-all.sh`（第 1 层）。守卫 **B85**。

## 后果与守卫（Consequences）
- 前端构建正常时 40–75s；挂住时最多 240s×2 后退场并报明确错误，不再无限期挂着。
- ⚠️ **判别「慢」还是「挂」**：真的在编译时 rustc 的 CPU 时间**随墙钟持续爬升**（2.5 分钟 → 76s）；
  vite 挂死是 **CPU 不涨 + 内存畸高**。看 `Get-Process … | Select CPU,StartTime`。
- ⚠️ **别只看退出码/日志**：卡住时日志停在 `transforming...` / `✓ N modules transformed`，
  没有任何报错行，看起来就是「还在跑」。
- ⚠️ 挂死会清空 `dist/assets` 且只写一半 → **kill 后必须重跑前端构建**，别直接进 tauri build。
- ⚠️ 同类教训（0082 / 0083 / 本条）：本项目脚本反复出现**静默失效 / 假成功**，
  改动后一律真跑一次并**回读产物**。

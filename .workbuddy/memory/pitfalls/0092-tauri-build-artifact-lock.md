# ADR 0092：`tauri build` 的产物被上一次构建的句柄占住 → 打包/链接 `os error 32` / `Permission denied`

- **状态**：Accepted（09-21 连续两次踩到，两种症状同源）
- **域**：构建 / 发布（Windows 文件锁）
- **来源**：B91 交付后连推两次，pre-push 的 `tauri build` 一次挂在 NSIS 打包、一次挂在链接
- **关联**：`MEMORY.md` 红线「门禁脚本『退出码 0 + 日志正常』≠ 生效」的反面 ——
  这次是**门禁真的响了，但响的原因是环境而不是代码**；`ref/session-env.md` §10

## 背景（Context）

B91 的 `release.sh minor` 已经本地全量构建成功过（exe 8.0M + NSIS 5.6M），随后两次 `git push`
都被 pre-push 拦下，报错**各不相同**，但都指向上一次构建留在 `src-tauri/target/` 里的产物：

```
[第 1 次] Running makensis to produce ...\bundle\nsis\LitePad_0.11.0_x64-setup.exe
          failed to bundle project: `另一个程序正在使用此文件，进程无法访问。 (os error 32)`

[第 2 次] ld.exe: cannot open output file
          E:\Project\LitePad\src-tauri\target\release\deps\litepad-86f86636b5aeed4d.exe:
          Permission denied
```

两次都不是代码问题：源码、测试、类型都没变，重跑 `release.sh` 时同样的代码刚构建通过。

## 根因（Root Cause）

Windows 上**文件句柄的释放晚于进程退出**（Antivirus / Defender 实时扫描、索引服务、
以及 makensis / ld 自己的退出时序都会拖出一小段窗口）。于是：

- 第 1 次：`makensis` 刚把 `LitePad_0.11.0_x64-setup.exe` 写完，tauri 紧接着去 patch/校验它，
  句柄还没放 → `os error 32`。**产物其实已经写出来了**（5853293 字节、时间戳正常），
  属于「写成功但下游打不开」。
- 第 2 次：链接器要写 `deps/litepad-<hash>.exe`（上一次构建的输出文件），
  同样的瞬时占用 → `Permission denied`。

判据：**报错的路径永远指向「上一次构建刚刚产出过的那个文件」**，且 `Get-Process` /
`tasklist` 里**找不到**任何残留进程（不是「有程序忘了关」，是「句柄还没放」）。

## 决策（Decision）

1. **别急着怀疑代码。** 先看报错路径是不是「上一次构建的产物」，是就按文件锁处理。
2. **删掉那个产物再重跑**：删得掉就说明锁已经自己解除了，重跑多半能过。
   ```sh
   rm -f src-tauri/target/release/bundle/nsis/LitePad_<ver>_x64-setup.exe
   ```
   （`target/` 是构建产物目录、在 `.gitignore` 里，删它不影响任何源文件与工作树。）
3. **`pre-push` 的这类失败是「假红」**：它只说明「这一次构建没产出 exe」，不说明代码有问题。
   重试前**先确认没有残留进程**（`tasklist`/`Get-Process` 查 `litepad`、`makensis`、`ld`、`rustc`），
   再重跑；不要连着重试两次以上 —— 每次都白烧 5 分钟。

## 后果与守卫（Consequences）

- 代价：一次推送要多花一轮 ~5 分钟的本地构建；换来的是不误判成代码缺陷。
- ⚠️ 不要为了绕过它去 `--no-verify`：pre-push 同时也是「exe 必须是新代码」的唯一保证
  （截图脚本驱动的就是这个 exe）。**删产物 + 重跑**才是正解。
- 与 `pitfalls/0085`（vite 概率性挂死）同族：**本项目的构建链在 Windows 上有概率性的环境抖动**，
  症状千奇百怪但都不是代码问题 —— 判据一律是「同样代码前一次刚通过」。

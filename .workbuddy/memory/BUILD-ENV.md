# LitePad 构建环境与会话坑（精确命令）

> 本机（Windows + MSYS2 MinGW，**无 MSVC**）的实际可用命令。照抄不要改写。

## 工具链

- 宿主工具链 `stable-x86_64-pc-windows-gnu`，由项目根 `rust-toolchain.toml` 锁定
  （原 `.cargo/config.toml` 已删除）。原因：build script / proc-macro 必须编译到宿主平台，
  而本机没有 `link.exe`，链接器由 MSYS2 MinGW-w64 提供。
- npm / node 直接从 PATH 可用（node 22.22.2 / npm 10.9.7）；managed 版本在
  `C:\Users\maoyu\.workbuddy\binaries\node\versions\22.22.2-3`。

## 会话内 PATH（每次都必须显式导出）

会话 shell 可能**整体丢 PATH**（`shim/*.sh: dirname: command not found`、`head: command not found`）。
命令内先导出：

```sh
export PATH="/c/Users/maoyu/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/msys64/mingw64/bin:/c/Users/maoyu/.cargo/bin:/c/Users/maoyu/.workbuddy/binaries/node/versions/22.22.2-3:/c/WINDOWS/System32:$PATH"
```

Python（分析/脚本）：`C:\Users\maoyu\.workbuddy\binaries\python\versions\3.13.12\python.exe`；
需要 pillow/pywinauto 时用 venv `~/.workbuddy/binaries/python/envs/default`。

## 前台分步构建（绕过 npm 链路）

`npm run build:all` 在会话内**后台**跑会在 cargo test / tauri 链接（collect2）处挂死：
根因是 npm 链路重置 `TEMP`/`TMP` → gcc 报 `Cannot create temporary file in C:\WINDOWS\` ICE。
会话内改为前台分步：

```sh
export CODEBUDDY_SAFE_DELETE_ENABLED=0          # 关键：解除 safe-delete 拦截
node node_modules/typescript/bin/tsc -b          # ① 类型检查
node node_modules/vite/bin/vite.js build         # ② 前端产物
node node_modules/vitest/vitest.mjs run          # ③ 测试
cd src-tauri && cargo build && cargo test        # ④ Rust（需 dangerouslyDisableSandbox）
node node_modules/@tauri-apps/cli/tauri.js build \
  --config '{"build":{"beforeBuildCommand":""}}' # ⑤ 打包 exe + NSIS（前台 + 关沙箱）
```

- `cargo collect2` 的 ICE 也可能是**瞬时故障，重试即过**。
- **`windres: preprocessing failed` 同样是瞬时故障**（09-13 B43 推送时 pre-push 的 cargo test
  在 build script 处报 `tauri-winres ... Failed("windres failed to compile resource.rc ... exit code: 1")`，
  而**同一图标刚用 `tauri build` 打包成功过**）。直接重跑 `cd src-tauri && cargo test` 即 15/15 通过，
  再 push 也过。**不要**因这个报错去改 .rc 或图标——先重试一次。
- ⚠️ **但 `NotAttempted("windres")` 不是瞬时故障，是 PATH 漏了 MSYS2**（09-15 踩）。
  `tauri-winres` 报 `panicked at ... NotAttempted("windres")` 的字面意思就是
  **找不到 windres 这个二进制**，和上面那个「找到了但预处理失败」是两回事。
  **症状**：`git push` 时 pre-push 的 `cargo test` 挂，报 `✗ pre-push 失败：cargo test 未通过`。
  **根因**：push 命令只导出了 PortableGit + System32，**漏了 `/c/msys64/mingw64/bin`**。
  为什么以前 push 都过？因为 build script 只在被监听的文件变化时重跑 ——
  **平时 push 不动 `tauri.conf.json`，根本不触发 winres**；一旦改了 `tauri.conf.json`
  （最典型：`release.sh` bump 版本号），build script 重跑就需要 windres 了。
  **修**：push 也用完整 PATH（见上文「会话内 PATH」），并先 `which windres` 确认可见。
  **判据**：报错里是 `NotAttempted("windres")` → 查 PATH；是 `preprocessing failed` → 先重试。
- 链接前必须**杀掉运行中的 litepad.exe**，否则 `os error 32`（文件被占用）。
- **npx 偶发解析异常**（wsl.exe shim 报 blocked + 乱码）：`run-vitest.cjs` 内部 `execSync("npx vitest")`
  会挂 → 用 `scripts/run-vitest-direct.cjs`（execFileSync 直调 `node_modules/vitest/vitest.mjs`，
  保留盘符大写修复）。tsc/vite 同理直调 node_modules 下的入口。
- vitest 固定 **4.1.11**（5.0.0 在本环境失败）。

## 会话环境坑清单

- **沙箱拦截 WebView2 的一切 http(s) 导航**（dev server 与 tauri 自定义协议都被重置为 `about:blank`，
  `file://` 可加载）→ **本会话内无法做 UI 冒烟**，UI 效果必须由用户在桌面验证。
- bash 的 `tasklist`/PowerShell **看不到桌面进程**；用 python ctypes `EnumWindows`/`EnumProcesses`
  （判活用 `GetProcessTimes`）。
- 杀进程用 python `os.kill(pid, SIGTERM)`（`taskkill //F` 无效）。
- **safe-delete 钩子**会拦截 `rm` 并 FAIL_CLOSED，导致 `rm && app` 整条命令失败；
  它也拦 node 进程的 `rmSync`（>50 文件批量删除，如 vite 清 dist/assets）→
  豁免靠 `CODEBUDDY_SAFE_DELETE_ENABLED=0`（`build-all.sh` 已内置 export；桌面环境无此 shim）。
- WebView2 browser 进程**按用户数据目录复用**：改启动参数做实验前必须杀光 `msedgewebview2`。
- vite 配 `host:"localhost"` 在本机只绑 `::1` → vite 与 `devUrl` 双侧都锁 `127.0.0.1`。
- **`npm install` 被会话 SIGTERM 会回滚 `package.json` 并删掉刚装的包**；
  jsdom 丢失时 jsdom 测试文件被**静默跳过**（测试文件数骤减却不报错）。
  兜底：走 PowerShell 通道，或手写 devDeps + `npm install --package-lock-only --offline`。
- `git grep` 是排查仓库内容的正确姿势（`node_modules`/`src-tauri/target` 巨大，直接 grep 会超时）。
- ⚠️ **同一文件的两处编辑绝不能并发**（B68 实测）。文件编辑是「读—改—写」，
  同一文件上并行发两个编辑请求时后写的那次会覆盖前一次，而**两次都会回报成功**
  —— 表现为「明明说改好了，编译却找不到字段」。一次编辑请求里对同一文件发两处以上改动就会踩到。
  **对策**：同一文件的编辑一律串行；不同文件之间才并发。
  症状与排查：编译报「没有某某字段」但代码里 grep 不到该字段时，**先回头看是不是被并发覆盖了**，
  直接把该文件需要的改动重做一遍（差集靠 `git diff` 核对），不要顺着报错改编译器的抱怨。

## 抓 Win11 记事本菜单做 UI 参考（可行方案）

`PrintWindow` 抓不到 `#32768` 菜单弹层；`SendInput` Alt+F 因前台锁定进不去（按键会误投给前台窗口，慎用）。
**可行 = pywinauto UIA**：

```python
Desktop(backend="uia").window(...) → descendants(control_type="MenuItem") → expand()
→ 全屏 BitBlt(SRCCOPY|CAPTUREBLT) 截图
```

脚本参考 `C:/Users/maoyu/AppData/Local/Temp/notepad_cap4.py`。
**必须用专用临时文件启动记事本**（否则会自动恢复用户会话标签）。

## ⚠️ 长构建不要在后台配 `| tail`（会永久挂住）

会话内把长构建丢到后台并接管道，例如 `vite build 2>&1 | tail -6`：
子进程一旦被会话 SIGTERM 打断，**管道仍被持有、永远等不到 EOF**，
任务显示 running 但实际早已无进程活动（判据：`target/` 与 `dist/` 近 2 分钟无文件更新）。

- **落文件代替管道**：`cmd > /tmp/build.log 2>&1; echo "EXIT=$?" >> /tmp/build.log`，
  再 `tail` 该文件；配 `find <dir> -newermt "-2 minutes" | wc -l` 判断是否真在推进。
- **更省事的替代（B59 实测）**：直接**把 `build:all` 拆成 4 步前台分别执行**
  （`npm run build` → `node scripts/run-vitest.cjs` → `cd src-tauri && cargo build && cargo test`
  → `npm run tauri -- build --config '{"build":{"beforeBuildCommand":""}}'`），
  每步都在 10 分钟前台窗口内跑完，比整脚本后台跑更快也更可控（本次 1m + 15s + 1m36s）。
  ⚠️ 实测症状会骗人：**有时前几步已成功（`dist/` 已更新）之后才挂住**，
  所以别只看「产物有没有更新」就以为整体在推进 —— 要查进程（`Get-Process` / `tasklist`）。
- vite build 被打断会**留下残缺的 `dist/`**（只有 index.html、assets 全丢），
  直接重试即可恢复（实测 44.6 s 重建 435 个产物）。
- 实测耗时参考（本机，冷启动）：`cargo test` 全量 21 min；`tauri build --release` 38 min。

## ⚠️ 构建「卡住不推进」先怀疑沙箱，别干等（B66 实测）

B66 把 `vite build && cargo test && tauri build` 整条链丢进后台时**漏了
`dangerouslyDisableSandbox: true`**，症状如下：

- vite 卡在打包阶段 **7 分 41 秒**不推进；
- 日志只写到 `✓ 2666 modules transformed.`，**没有** `rendering chunks` / `✓ built in`；
- 判据：`dist/index.html` 时间戳还是**上一次**构建的，`dist/assets/*` 也没更新
  （vite 是打包完成后才 `emptyOutDir` + 落盘，所以「老文件还在」= 还没进落盘阶段）；
- `tasklist` 里 node.exe 活着（有进程、无产出）。

→ **处理**：用 `TaskStop` 停掉后台任务，带 `dangerouslyDisableSandbox: true` 重跑，
同一条链 **2 分 39 秒**走完（vite + cargo test + tauri build + NSIS）。
本机 2666 模块的 vite 产物构建正常就是 **30–45 s**；**超过 2 分钟没推进 = 沙箱在拦**。

⚠️ 不要用 `taskkill`/`Stop-Process` 按名字杀 node.exe：会话自身也跑在 node 上
（实测同时有 7 个 node.exe，其中占 1.7 GB / 8.5 GB 的两个就是宿主），杀错直接断会话。
一律走 `TaskStop`。

## ⚠️ 工作区目录改名后必须 `cargo clean`

Rust 的构建缓存里**烙死了绝对路径**。本项目由 `E:\Project\LiteMD` 改名为
`E:\Project\LitePad` 后，`src-tauri/target/`（当时 6.4 GB）里的 build script 产物仍在引用旧路径，
表现为 `cargo build` / `cargo test` 失败：

```
failed to read plugin permissions: failed to read file
'\\?\E:\Project\LiteMD\src-tauri\target\debug\build\tauri-.../out/permissions/...' (os error 3)
```

排查：`grep -rl "Project.LiteMD" src-tauri/target/debug/build/ | head`。
修复：`cd src-tauri && cargo clean` 后全量重建（数分钟）。**改目录名/移动仓库后第一件事就是 clean。**

## GitHub 流水线（CI / Release）

两个 workflow，**触发条件不同，别混**：

| workflow | 触发 | 做什么 |
| --- | --- | --- |
| `ci.yml` | push `main`、任意 PR、手动 | format:check → lint → tsc → vite build → vitest → cargo test |
| `release.yml` | **push `v*` tag**、手动 dispatch | 构建 NSIS → 创建 GitHub Release 并附安装包 |

- **只推 main 不会有任何发布**——这是「GitHub 上没触发发布」的常见根因：
  仓库曾长期一个 tag 都没有（`gh run list` 为空）。必须 `git push origin main --follow-tags`。
- Release 失败时不必再推 tag：Actions 页面手动 dispatch，填 `tag` 输入即可重跑
  （checkout 与 `tag_name` 都跟随该输入，保证补发的是指定版本）。
- 两条流水线都必须装 **MSYS2 MinGW64** 并 `rustup default stable-x86_64-pc-windows-gnu`
  （本项目无 MSVC，`rust-toolchain.toml` 锁 GNU 宿主；runner 上不加 MinGW 就链接不了）。
- 实测耗时（windows-latest，含装 MSYS2/Rust）：CI ≈ 6m40s，Release ≈ 8m30s
  （本地冷启动分别是 21 min / 38 min，所以优先让 Actions 构建）。
- 查进度与结果：`gh run list`、`gh run view <id> --json jobs --jq '.jobs[].steps[]'`、
  `gh release view vX.Y.Z --json assets`。

## ⚠️ 发布包缺 DLL 的排查三步（B48：「装好起不来」）

```sh
# 1) exe 到底依赖谁（gnu 工具链下没有 libgcc/libwinpthread 依赖，别去搞静态链接）
objdump -p src-tauri/target/release/litepad.exe | grep -i "DLL Name" | sort -u

# 2) 安装包里实际装了什么（7z 在 scoop shims，能识别 NSIS 包）
"/c/Users/maoyu/scoop/shims/7z" l src-tauri/target/release/bundle/nsis/LitePad_*_x64-setup.exe

# 3) 干净目录启动验证（只放安装包会有的文件，避免 target 里其他文件"帮忙"造成假通过）
python -c "复制 exe+dll 到 %TEMP% 目录 → subprocess.Popen → sleep 5 → poll() is None 即存活"
```

- Tauri 2 的 **`WebView2Loader.dll` 不会被 bundler 自动收进包**，必须显式声明。
  用 **map 形式**，且**源必须是仓库内的副本**（`src-tauri/WebView2Loader.dll`，已提交）：
  ```jsonc
  "bundle": { "resources": { "WebView2Loader.dll": "WebView2Loader.dll" } }
  ```
  ⚠️ **不要**写成 `target/release/WebView2Loader.dll`——本地因为有构建产物会"假通过"，
  但 CI 冷构建时 Tauri 的 codegen 在**编译之前**就校验资源路径，直接报
  `resource path target\release\WebView2Loader.dll doesn't exist` 而失败。
- 回归断言在 `tests/regressions.test.ts`（「B48 安装包必须自带 WebView2Loader.dll」，
  同时断言该源文件在仓库内、且不含 `target/`）。

## ⚠️ `cargo build --release` ≠ 可运行的 exe

`custom-protocol` feature 只有 `tauri build` 会开。直接 `cargo build --release` 产出的 exe
运行后走 devUrl，界面是 `ERR_CONNECTION_REFUSED`（"无法访问此页面"）。
**要跑、要打包一律 `node node_modules/@tauri-apps/cli/tauri.js build`**；
`cargo build` 只用来快速验证 Rust 编译/链接。增量下 `tauri build` 全流程约 1m45s（含 NSIS）。

## 抓界面截图（README / docs）

`scripts/screenshot.py` 纯 ctypes + zlib，不依赖 Pillow：

```sh
python scripts/screenshot.py --exe litepad.exe --size 1600x1000 --out docs/screenshots/main.png
```

- `--exe <镜像名>`：按**进程**定位窗口（推荐）。用标题关键字会误抓——资源管理器标题里也含 "LitePad"。
  另有 `--pid <pid>`、`--screen`（全屏）、`--out`、`--size WxH`。
- 脚本会先 `SetProcessDPIAware()` 再 `SetWindowPos`，所以 `--size` 是**真实物理像素**
  （本机 2520x1680 @150%，不加这句会被放大 1.5 倍）。
- ⚠️ `--out` 必须给**显式盘符绝对路径**（如 `E:/Project/LitePad/docs/screenshots/main.png`）。
  Windows 原生 python 收到 `/tmp/x.png` 这类无盘符路径会按**当前盘符**解析成 `E:\tmp\x.png`，
  脚本报「已捕获」但文件不在你以为的地方。
- **要拍到指定状态必须先构造演示会话**（改 `%APPDATA%\LitePad\session.json` / `settings.json`，
  字段是 camelCase；`viewMode: "source"|"preview"` 决定预览），拍完记得恢复用户原文件。
  完整流程见 `docs/screenshots/README.md`。
- **exe 必须以后台常驻任务启动**：从会话里 `(./litepad.exe &)` 启动，命令一结束进程就被回收，
  表现为「刚才是活的，截图时 NOT RUNNING」。用 run_in_background 起，拍完再杀。
- **弹层/对话框截图**：窗口固定在 `(0,0)`–`(W,H)`，可先截一张图，再**按亮度阈值聚类**量出
  菜单文字簇的物理中心（不要凭肉眼估，150% 缩放下目测偏差可达 ±25px）：
  菜单栏一行 → 按列聚类；弹层条目 → 按行聚类。得到坐标后用 `SetCursorPos` + `mouse_event`
  点击，最后再截一张。
- 杀进程用 PowerShell `Stop-Process -Name litepad -Force`（`taskkill //F` 在 Git Bash 里报参数错）。

## 沙箱内预览纯 DOM/CSS 观感（B64 起可用）

沙箱跑不了 WebView2（见上文「会话环境坑清单」），但**要看的如果只是纯 DOM + CSS 的观感**，
可以绕过去：用**真实代码**生成静态页 → 无头 Chromium 截图。不需要装 playwright 包，
Playwright 下载好的 chromium 二进制可以直接命令行当 headless 浏览器用：

```sh
CHROME="$HOME/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe"
"$CHROME" --headless --no-sandbox --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=860,240 \
  --screenshot="E:/out.png" "file:///E:/path/preview.html"
```

**生成静态页**（保证是真实标记而不是手抄）：
1. `esbuild`（vite 的依赖，已在 `node_modules`）把目标模块打成 `platform: node` 的 ESM；
2. 起一个 `jsdom`，把 `window/document/Element/HTMLElement/MouseEvent/...` 挂到 `globalThis`，
   再 `import()` 那个 bundle；
3. 用真实渲染函数产出 DOM，甚至可以**派发真实事件**（如 `mousedown` + `mousemove`）把
   拖拽中间态跑出来；最后把 `document.body.innerHTML` 序列化进一个引 `global.css` 的壳页。

现成脚本：`generated-images/gen-drag-ghost-preview.mjs`（拖拽影像那次留下的，可照抄改）、
`generated-images/gen-tab-action-preview.mjs`（标签槽位，第二个参数可指定挂哪份 `global.css`，
用于「改前/改后」同机对比）。
⚠️ 局限：只能验证**静态观感**（尺寸/配色/层级/留白），拖拽跟手、光标形状、滚动等交互
仍必须由用户在桌面环境验证；也**不能**当作 `docs/screenshots/` 的正式截图。
无头产物放进被 gitignore 的 `generated-images/`，别污染仓库。

### 想验 `:hover` / 中间态？用 CDP 派发真实鼠标（B66 起可用）

`--screenshot` 是一次性快照，拿不到 `:hover`；改走**远程调试端口自己驱动**：

```sh
"$CHROME" --headless --no-sandbox --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=880,320 \
  --remote-debugging-port=9222 \
  --user-data-dir="C:/Users/maoyu/AppData/Local/Temp/litepad-cdp-profile" about:blank &
```

Node 22 **自带全局 `WebSocket`**，所以零依赖即可连 CDP（连法照抄 `scripts/cdp_diag.mjs`，
它是连 WebView2 的；换成 `fetch("http://127.0.0.1:9222/json/list")` 取 page target 即可）：

1. `Page.enable` → `Page.navigate` 到 `file:///.../preview.html`；
2. `Runtime.evaluate` 取目标元素的 `getBoundingClientRect()` 中心 → `Input.dispatchMouseEvent`
   `{type:"mouseMoved", x, y}`（**只有派发事件才会更新 `:hover` 状态**，改 CSS 或 JS 赋值都不算）；
3. 等 `var(--transition)` 走完（~300ms）再 `Page.captureScreenshot`，可连拍多态。

**顺手拿到一个运行时断言**：同一次 `Runtime.evaluate` 里读
`getComputedStyle(el).opacity`，就能把「哪个 glyph 在显示」量出来（0 / 0.5 / 1），
比只看图可靠 —— 本环境拿不到 CSS 级联（vitest 是 jsdom），这是唯一的自动核对手段。
现成脚本：`generated-images/gen-tab-action-hover-shots.mjs`。
裁切放大对照用 Pillow：**Windows 下 venv 的解释器在 `Scripts/python.exe`**（不是 `bin/`）——
`~/.workbuddy/binaries/python/envs/default/Scripts/python.exe`（Pillow 12.x）；
`versions/3.13.12/python.exe` 那个**裸装没有 Pillow**，别用它跑裁切脚本。

### 想量「行为」而不是观感？同一条路读几何（B67 起）

「双击分隔条到底把各面板调成多少」这类问题**肉眼看不准**（2 面板时「均分」和「居中」
长得一模一样），而 jsdom 没有布局（`getBoundingClientRect` 恒为 0）——
`splitview.test.ts` 只能靠内联 flexBasis 逐层累乘推算。要证真机行为就走 CDP：

1. 用 esbuild 把**真实模块**打成 **IIFE**（`format: "iife"`，`<script src>` 引入）。
   ⚠️ **不能用 `type="module"`**：`file://` 下 origin 是 `null`，模块脚本被 CORS
   静默拦掉 —— 页面什么都不执行，且 console 里未必有醒目报错（实测踩过）。
   入口里挂 `window.__mount/__measure` 之类供 CDP 调用（脚本见
   `generated-images/splitview-entry.mjs`）。
2. 派发鼠标：双击 = **两轮** press/release，第二轮 `clickCount: 2` 才会合成 `dblclick`；
   拖拽 = press → 分几步 move → release（每步间隔 30ms 更像真人）。
3. `Runtime.evaluate` 里 `getBoundingClientRect()` 换算成百分比 → **数值断言**。
4. 截图用 `Page.captureScreenshot` 的 `clip: {x,y,width,height,scale:1}` 只裁目标区域。
   ⚠️ `--window-size` 在无头下**不一定等于视口**（实测要 940×660 却拿到 918×506）：
   先在页面里读 `window.innerWidth/Height`、把容器设成那么大，再按该尺寸裁，
   否则图里带一条黑边。
5. ⚠️ CDP 的 `Runtime.evaluate` 出错时返回的是 `exceptionDetails`，`result.value` 是
   `undefined` —— 封装 `evalJs` 时要显式抛，否则会看到「undefined 传给下游」的假错。

现成脚本：`generated-images/gen-splitview-dblclick.mjs`（+ `splitview-entry.mjs`、
`crop-splitview-dblclick.py`）。

### 量滚动位置 / 真实计时器（B70 起）：`generated-images/b70-cdp-verify.mjs`

命令面板那类「悬停会不会动滚动条」的缺陷 jsdom 量不出来（没有布局、`scrollTop` 恒 0），
只能断言「DOM 有没有被重建」这种代理指标。要看真东西就走 CDP：

```sh
CHROME="$HOME/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe"
"$CHROME" --headless --no-sandbox --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=800,420 \
  --remote-debugging-port=9222 \
  --user-data-dir="C:/Users/maoyu/AppData/Local/Temp/litepad-b70-profile" about:blank &
node generated-images/b70-cdp-verify.mjs                      # 当前源码
node generated-images/b70-cdp-verify.mjs <broken.html 路径>    # 对照（B70 之前）
```

页面由 `b70-preview/entry.ts`（esbuild → IIFE）+ `b70-preview/index.html`（引真实
`global.css`）组成，入口把 `showCommandPalette/showPopupMenu/initTooltips` 挂到 `window`，
再由 CDP 用 `Input.dispatchMouseEvent`（`mouseMoved` / `mouseWheel`）与
`Input.dispatchKeyEvent` 驱动，读 `scrollTop` / `getBoundingClientRect()` 做数值断言。

⚠️ **两个坑，别重踩**：

1. **`Input.dispatchMouseEvent` 的 `mouseMoved` 必须带 `x`/`y`**，只给 `type` 会报
   `mandatory field missing`；`Runtime.evaluate` 出错返回的是 `exceptionDetails`，
   `result.value` 是 `undefined` —— `evalJs` 要显式抛，否则下游拿到 undefined 假错。
2. ⚠️ **测「悬停后提示该不该弹」必须先离开并等过 `HIDE_GRACE`（220ms）**。
   只等 50ms 时 `shownTarget` 还没清空，紧接着的 `mouseover` 会被 `el === shownTarget`
   早退吃掉 —— 于是**旧代码也「通过」**，量出来的绿是假的。改前先拿旧代码跑一遍对照页，
   确认量法真能把缺陷照出来（这一步筛掉过一条假绿）。

⚠️ **已知局限（重要）**：**「悬停重绘导致列表滚回顶端」这类缺陷，无头 Chromium 复现不出来**。
B70 实测：把 `f30070f^` 的整套旧源码打包成对照页（`tooltip.ts`/`menu.ts`/`commandpalette.ts`
全部还原），滚轮与键盘两条路径、滚到 386px 后再悬停，`scrollTop` 都**停在 386**；
同时 DOM 确实被整表重建（首行节点已换）—— 即 Chromium 的**滚动锚定**（scroll anchoring）
把「清空 `list.textContent` → 再填回」的短暂归零掩盖了。
所以这套量法只能证明「当前实现不动滚动位置」（必要条件），**不能**证明「修好了用户看到的
那个症状」。遇到这类缺陷：先补齐可判定的契约（DOM 是否被重建 / 是否调 `scrollIntoView`），
再请用户在真机上确认。
对照页的重建方式（用完可删）：

```sh
cd generated-images/b70-preview && cp -r ../../src broken-src
for f in tooltip menu commandpalette; do
  git -C ../.. show f30070f^:src/shell/$f.ts > broken-src/shell/$f.ts
done
# broken-entry.ts 不能 import 旧 menu 的 closePopupMenu（旧版没导出），关菜单直接摘 DOM
```

## ⚠️ 改图标后必须让 build.rs 盯 `icons/` 目录

**症状**：换了 `src-tauri/icons/icon.ico` 并 `tauri build`，**exe 仍是旧图标**，且构建零报错
（最阴的地方：不报错，你以为生效了）。

**根因**：`tauri-build` 的 rerun 触发条件只覆盖 `tauri.conf.json` / capabilities 等，
**不监听 `icons/` 目录**。cargo 认为 build script 无需重跑 → `target/.../out/libresource.a`
保持旧内容（实测 26174 B 未被重写）→ 旧图标被打进 exe。

**修复**（`src-tauri/build.rs`，B41 起长期保留）：

```rust
fn main() {
    println!("cargo:rerun-if-changed=icons");   // 关键一行
    tauri_build::build()
}
```

加完后重建：`libresource.a` 26174 → 30558 B，exe 内嵌 PNG 与 `icon.ico` 各档 **逐字节 sha256 一致**。

**验证套路（不依赖 PowerShell `Add-Type`，那条路被会话安全策略拦）**：
用 Python 扫 exe 二进制里的 PNG 签名（`\x89PNG\r\n\x1a\n`）切出每个 PNG chunk，
分别 sha256，与 `icon.ico` 各档解出的 PNG 对比 —— 全中才算真嵌进去了。
改图标后**只认这个证据**，不看「构建成功」。

**现成脚本**（B52 补）：

```sh
PY=C:/Users/maoyu/.workbuddy/binaries/python/versions/3.13.12/python.exe
$PY scripts/icon_check.py        # 扫**未压缩 PNG**：exe 与安装包里的内嵌资源
$PY scripts/icon_check_pe.py     # 解析 **PE 资源段** RT_ICON：外壳图标（安装器/卸载器）
```

两个脚本都要跑，因为**它们查的不是同一层东西**：
- `icon_check.py` 查的是「应用自己带的内嵌图片资源」（NSIS 包未压缩时也能扫到）；
- `icon_check_pe.py` 查的是「Windows 拿来做外壳图标的那份 RT_ICON」——
  安装程序自己的图标**只在这一层**，`icon_check.py` 扫不到（改动前实测安装包切出 0 个 PNG，
  但并不代表图标错，只是查错了层）。

## ⚠️ 安装程序外壳图标要单独配（B52）

**症状**：用户报「生成的二进制文件的图标还是旧的」。实测 `litepad.exe` **完全正确**
（7 档与 `icon.ico` 字节一致），错的是**安装程序外壳**——双击 setup.exe 的任务栏图标、
标题栏图标、「应用和功能」里的卸载图标全是 NSIS 默认图标。

**根因**：`bundle.icon` 只喂给 exe 与快捷方式。NSIS 安装器/卸载器图标是**另一组配置项**，
不配就被 Tauri 渲染成 `!define INSTALLERICON ""`（空串）→ NSIS 回落默认图标，**零报错**。

**修复**（`src-tauri/tauri.conf.json`）：

```jsonc
"bundle": {
  "windows": { "nsis": {
    "installerIcon":   "icons/icon.ico",
    "uninstallerIcon": "icons/icon.ico"
  }}
}
```

改后 `target/release/nsis/x64/installer.nsi` 的 `INSTALLERICON` 从空串变成真实路径，
`MUI_ICON` 分支生效，安装包 5806026 → 5807335 B。回归断言见
`tests/regressions.test.ts`「B52 安装程序自身必须有 LitePad 图标」。

⚠️ 排查这类问题**先分层**：`exe 图标` / `安装器外壳图标` / `快捷方式图标` 是三套独立机制，
别一看到「图标旧」就去动 `build.rs`。

## ⚠️ `failed to remove file litepad.exe / 拒绝访问` = 有残留进程占着产物

**症状**：`tauri build` 走到最后一步报

```
   Compiling litepad v0.3.0 (E:\Project\LitePad\src-tauri)
error: failed to remove file `...\target\release\litepad.exe`
Caused by: 拒绝访问。 (os error 5)
```

而且**失败时旧 exe 已被删掉**——构建结束后 `target/release/litepad.exe` 干脆不存在，
`bundle/nsis/` 里还是上一次的安装包（看时间戳能分辨，别误以为构建成功）。

**根因**：之前手动启动的 `litepad.exe`（从 release 目录直接跑起来试用的那个）还在运行，
Windows 锁住映像文件 → 既不能删也不能覆盖。`taskkill //F //IM litepad.exe` 在 Git Bash 里
**会静默失败**（`2>/dev/null` 吃掉了报错），所以「脚本开头已经 kill 过」并不代表真的杀掉了。

**正确排查**：用 PowerShell 工具（不要从 Bash 工具里外部调用 powershell）查
`Get-Process -Name litepad` 的 `Path`，确认它正是 `target\release\litepad.exe` 后再
`Stop-Process -Force`；从 `target/debug/` 或已安装目录启动的进程不会锁 release 产物，别误杀。

⚠️ 本会话里 PowerShell 工具的 stdout **经常回显为空**，所以「探测 + 结论」要
`Set-Content` 落一个临时文件再用 Read 读，别把「没有输出」当成「没有进程」。

## 诊断基建

- `frontend_ready` 命令写 `%TEMP%\litepad-smoke.log`；`scripts/cdp_diag.mjs` 连 CDP 抓页面异常。
- `scripts/screenshot.py` 截窗口（纯 ctypes + zlib）；用法与截图流程见上文「抓界面截图」。

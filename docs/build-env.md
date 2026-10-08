# LitePad 构建与环境指南

> 贡献者向。本机/CI 工具链为 **Windows + MSVC**（Visual Studio 2022「使用 C++ 的桌面开发」工作负载 + Windows SDK）。
> 团队内部的开发沙箱特殊坑见 `.workbuddy/memory/ref/session-env.md`（不进本文件）。

## 工具链

- 宿主工具链由项目根 `rust-toolchain.toml` 锁定为 **`stable-x86_64-pc-windows-msvc`**（强制，非可选）。
  `webview2-com` 在 MSVC 下把 WebView2 loader **静态链进 exe**，单个 exe 即可运行；
  用 GNU 会动态导入 `WebView2Loader.dll`，缺它直接 `0xC0000135` 起不来（v0.11.0 发布包栽过）。
- MSVC 链接器（`cl.exe` / `link.exe` / `rc.exe`）由 **Visual Studio 的 C++ 桌面工作负载 + Windows SDK** 提供，
  rustc 用 `vswhere` 自动探测安装，**无需 vcvars、无需手工加 PATH**（默认安装路径即可，不要求无空格目录）。
- **不再需要 MSYS2 / MinGW**：资源编译走 Windows SDK 的 `rc.exe`，不是 `windres`。
  构建脚本里若仍见到 `msys64` 的 PATH 引用，属历史残留、不再依赖，且会在前端构建前被剥离（见下）。

## 构建

标准入口：

```sh
npm install                 # 装依赖（vitest 固定 4.1.11）
npm run build:all           # tsc -> vite -> vitest -> cargo build+test -> tauri build
```

分步（排查时更有用）：

```sh
node node_modules/typescript/bin/tsc -b
node node_modules/vite/bin/vite.js build
node node_modules/vitest/vitest.mjs run
cd src-tauri && cargo build && cargo test
node node_modules/@tauri-apps/cli/tauri.js build
```

- ⚠️ **分步只用于排查，不要拿它替代 `npm run build:all`**：完整流程里已经修好的几处
  （safe-delete 开关、前端那步会剥掉 PATH 里可能残留的 MSYS2 条目、打包前 `dist/assets` 点数自检、
  Rust 侧只编 release）在分步手敲时全靠人记 —— 漏一条就是「构建 exit 0、产物却是空壳」
  这类最难查的故障。环境缺什么、该用哪条命令，先跑 `bash scripts/doctor.sh`。

- ⚠️ **`cargo build --release` 产出的 exe 不能直接跑**：`custom-protocol` feature 只有 `tauri build`
  才打开，否则 exe 去连 dev server（`ERR_CONNECTION_REFUSED`）。要跑/打包一律 `tauri build`。
- 链接前杀掉运行中的 `litepad.exe`（被占用会 `os error 32`）。

## WebView2 运行库

- **MSVC 下无需任何额外操作**：`webview2-com` 把 WebView2 loader **静态链进 exe**，运行时不依赖外部的 `WebView2Loader.dll`。仓库里也**没有**这个文件，请勿自作主张补 `bundle.resources` 的 resource map，否则 `tauri build` 会因找不到源文件而失败。
- 真正需要的是系统级的 **WebView2 运行时**：Win11 已自带；Win10 装一次 Microsoft 的 Evergreen Runtime 即可。
- （历史参考）GNU 工具链时代才需要把 `WebView2Loader.dll` 作为 bundle resource 显式声明；现工具链为 MSVC，该做法已废弃。

## 改名 / 移动仓库后必须 `cargo clean`

Rust 构建缓存里烙死了绝对路径。改目录名后 `cargo build/test` 会报
`failed to read plugin permissions ... <旧仓库路径> ... (os error 3)`（路径还是改名前那份）。修复：
`cd src-tauri && cargo clean` 后全量重建。**移动仓库后第一件事就是 clean。**

## 图标

- `src-tauri/build.rs` 必须 `println!("cargo:rerun-if-changed=icons");`，否则换 `icons/icon.ico`
  后 `tauri build` 零报错却仍是旧图标（build script 不被触发重跑）。
- 安装程序外壳图标要单独配（`bundle.windows.nsis.installerIcon` / `uninstallerIcon`），
  `bundle.icon` 只喂 exe 与快捷方式，不配则安装器回落 NSIS 默认图标（零报错）。
- 改图标后验证据：用 `scripts/icon_check.py` + `scripts/icon_check_pe.py` 比对 exe 内嵌与安装包
  RT_ICON 的 sha256，**不能只看「构建成功」**。

## CI / Release

| workflow | 触发 | 做什么 |
|---|---|---|
| `ci.yml` | push `main`、PR、手动 | format:check → lint → tsc → vite build → vitest → cargo test |
| `release.yml` | push `v*` tag、手动 | 构建 NSIS → 建 GitHub Release 并附安装包 |

- **只推 main 不会发布**：必须 `git push origin main --follow-tags`。
- 两条流水线都基于 **MSVC**（`stable-x86_64-pc-windows-msvc`）构建；runner 需装 Visual Studio 2022「使用 C++ 的桌面开发」工作负载 + Windows SDK，**无需 MSYS2 / MinGW**。
- Release 失败可 Actions 页面手动 dispatch 填 `tag` 重跑。

## 临时文件落点

本项目产生的临时文件一律放项目内 `E:\Project\LitePad\.tmp\`（已进 `.gitignore` /
`.prettierignore` / eslint `ignores`，可整目录清空）。不写 `%TEMP%`、Git Bash 的 `/tmp`
（= `%TEMP%`）、`~/.workbuddy/`（除 memory/skills）。详见 `docs/conventions.md`。

## 界面截图（README / docs）

唯一入口是 `scripts/capture-screenshots.py`（BitBlt 抓真实窗口，可见外框裁剪）：

```sh
python scripts/capture-screenshots.py          # 拍 main → docs/screenshots/
python scripts/capture-screenshots.py --list   # 看有哪些配方
python scripts/capture-screenshots.py --keep   # 保留演示会话（排查用）
```

前提：`src-tauri/target/release/litepad.exe` 必须是**当前代码**编译出来的。任何一次 `git push`
都会由 pre-push 自动重建它；手动构建用 `npm run tauri -- build`。

它自己会**先杀干净旧实例、再**备份/写入演示会话（顺序反了会被退出中的旧实例覆盖），
启动后等窗口标题带上演示文件名才抓图，最后还原真实的 `session.json` / `settings.json`
（字段 camelCase）；抓到全黑图会直接报错而不是写出。界面改动必须在同一提交刷新
`docs/screenshots/`。

底层件在 `scripts/screenshot.py`（PNG 编码、窗口查找、BitBlt），也能单独用：

```sh
python scripts/screenshot.py --exe litepad.exe --out x.png --size 1600x1000
```

**为什么不用 CDP**：曾经走 `Page.captureScreenshot`（引擎 `cdp-shot.mjs`），它能免掉系统
标题栏、不怕遮挡，但要求 WebView2 开出调试端口；在本机沙箱里调试端口开得出来、抓图却不
返回（页面停在 `about:blank`），两套流程并存反而容易用错，现已合并成上面这一套。
成因与取舍见 `docs/screenshots/README.md`。

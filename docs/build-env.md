# LitePad 构建与环境指南

> 贡献者向。本机环境为 Windows + MSYS2 MinGW64（**无 MSVC**）。团队内部的开发沙箱特殊坑见
> `.workbuddy/memory/ref/session-env.md`（不进本文件）。

## 工具链

- 宿主工具链由项目根 `rust-toolchain.toml` 锁定为 `stable-x86_64-pc-windows-gnu`。
  原因：build script / proc-macro 必须编译到宿主平台，而本机没有 `link.exe`，
  链接器由 MSYS2 MinGW-w64 提供。**构建前确保 `msys64/mingw64/bin` 与 cargo 在 PATH 上。**
- 需 MSYS2 MinGW64（`pacman -S mingw-w64-x86_64-toolchain` 之类）提供 `gcc`/`windres` 等。

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

- ⚠️ **`cargo build --release` 产出的 exe 不能直接跑**：`custom-protocol` feature 只有 `tauri build`
  才打开，否则 exe 去连 dev server（`ERR_CONNECTION_REFUSED`）。要跑/打包一律 `tauri build`。
- 链接前杀掉运行中的 `litepad.exe`（被占用会 `os error 32`）。

## WebView2 运行库

Tauri 2 的 **`WebView2Loader.dll` 不会被 bundler 自动收进包**，必须显式声明（用 map 形式，
源必须是仓库内副本 `src-tauri/WebView2Loader.dll`）：

```jsonc
"bundle": { "resources": { "WebView2Loader.dll": "WebView2Loader.dll" } }
```

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
- 两条流水线都需装 MSYS2 MinGW64 并 `rustup default stable-x86_64-pc-windows-gnu`（无 MSVC）。
- Release 失败可 Actions 页面手动 dispatch 填 `tag` 重跑。

## 临时文件落点

本项目产生的临时文件一律放项目内 `E:\Project\LitePad\.tmp\`（已进 `.gitignore` /
`.prettierignore` / eslint `ignores`，可整目录清空）。不写 `%TEMP%`、Git Bash 的 `/tmp`
（= `%TEMP%`）、`~/.workbuddy/`（除 memory/skills）。详见 `docs/conventions.md`。

## 界面截图（README / docs）

```sh
python scripts/screenshot.py --exe litepad.exe --size 1600x1000 --out E:/Project/LitePad/docs/screenshots/main.png
```

exe 须以后台常驻任务启动；`--out` 给显式盘符绝对路径。要拍到指定状态先构造演示会话
（`%APPDATA%\LitePad\session.json` / `settings.json`，字段 camelCase）。流程见 `docs/screenshots/README.md`。
界面改动必须在同一提交刷新 `docs/screenshots/`。

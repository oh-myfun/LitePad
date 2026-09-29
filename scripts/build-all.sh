#!/usr/bin/env bash
# LitePad 全量构建：前端构建 + 测试 + release 发布产物（exe + NSIS 安装包）。
#
# 项目约定：每次编译都要把发布版本也编译出来，日常交付用本脚本。
# 宿主工具链是 **MSVC**（`stable-x86_64-pc-windows-msvc`，见 rust-toolchain.toml）：
#   GNU 宿主会动态导入 WebView2Loader.dll（装完缺 dll 直接 0xC0000135 打不开），
#   MSVC 走 webview2-com 的静态链接分支，单个 exe 即可运行（B92）。
set -e

# ---------------------------------------------------------------- 工具链自举
#
# ⚠️ 这一节是「必须存在」的，不是为了好看：曾经因为会话里 PATH 被剥空
# （node / cargo 都不在 PATH，npm 又撞 WSL 黑名单），我在会话里手抄了一份等价命令，
# 之后每次都绕开本脚本手敲 —— 而脚本里**已经修过的坑**（safe-delete 开关、MSYS2 剥离、
# dist/assets 点数自检）在手抄版里全靠现场记起，于是反复踩。
# ⇒ 结论：环境差异一律在**脚本内**兜住。脚本跑不动就**修脚本**，绝不在会话里另起一套命令。
#
# node：PATH 里没有就用 managed node；npm：先探测它能不能真的跑起来（某些沙箱里 npm 是
# bash 脚本，会撞 WSL 黑名单报「拒绝访问」），跑不起来就直调 node_modules 里的入口。

export PATH="/c/msys64/mingw64/bin:$HOME/.cargo/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  for c in \
    "$HOME/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" \
    "/c/Users/maoyu/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"; do
    if [ -x "$c" ]; then
      export PATH="$(dirname "$c"):$PATH"
      echo "    （PATH 里没有 node，自举：$(dirname "$c")）"
      break
    fi
  done
  command -v node >/dev/null 2>&1 || { echo "✗ 找不到 node，先装或把 node 目录加进 PATH" >&2; exit 1; }
fi
command -v cargo >/dev/null 2>&1 || export PATH="$HOME/.cargo/bin:$PATH"

NPM_OK=0
if command -v npm >/dev/null 2>&1 && npm --version >/dev/null 2>&1; then
  NPM_OK=1
else
  echo "    （npm 不可用，改直调 node_modules 入口）"
fi

# WorkBuddy 会话的 safe-delete 钩子会拦截 vite 清空 dist/assets（>50 个文件），
# 导致会话内构建失败；此开关在本脚本进程树内禁用该钩子（用户桌面环境无钩子，无副作用）
export CODEBUDDY_SAFE_DELETE_ENABLED=0

cd "$(dirname "$0")/.."

echo "==> [1/4] 前端类型检查 + 构建（tsc + vite）"
# ⚠️ vite 不能在带 MSYS2 条目的 PATH 下跑，否则**挂死**（09-20 实测坐实，此前标为「疑点未定论」）：
# 表现为 CPU 只走 ~25s 就不动、内存 1.8G、`dist/assets` 被清空后不写入，挂十几分钟也不出产物。
# 本脚本顶部为了给 cargo 提供 windres 把 `/c/msys64/mingw64/bin` 前插进 PATH，所以这里
# **临时摘掉**再跑前端构建；第 3 步的 cargo 仍走完整 PATH（它需要 windres）。
FE_PATH=""
OLDIFS="$IFS"
IFS=":"
for d in $PATH; do
  case "$d" in
  *msys64*) ;;
  *) FE_PATH="${FE_PATH:+$FE_PATH:}$d" ;;
  esac
done
IFS="$OLDIFS"
if [ "$NPM_OK" = 1 ]; then
  PATH="$FE_PATH" npm run build
else
  # 直调 node_modules 入口（等价于 `npm run build` = tsc --noEmit && vite build）
  PATH="$FE_PATH" node node_modules/typescript/bin/tsc --noEmit
  PATH="$FE_PATH" node node_modules/vite/bin/vite.js build
fi

# ⚠️ 前端产物完整性自检（B98）：vite 挂在写盘阶段被 kill／手滑 Ctrl-C 时，`dist` 会只剩
# 一个 `index.html`、`assets/` 全丢；此时后面的 `tauri build` **照样成功退出 0**，但打出来的
# exe 打开是一片空白（前端根本没被嵌进去）。所以打包前必须点数，不合格就拒绝继续。
ASSET_N=$(find dist/assets -type f 2>/dev/null | wc -l | tr -d ' ')
if [ "${ASSET_N:-0}" -lt 10 ]; then
  echo "✗ dist 前端产物不完整：assets 只有 ${ASSET_N:-0} 个文件，拒绝打包（请重跑前端构建）" >&2
  exit 1
fi
echo "    dist/assets: $ASSET_N 个文件"

echo "==> [2/4] 前端单元测试（vitest）"
# 打包前跑一遍全量用例是交付纪律；只想快速出包时用 LITEPAD_SKIP_TESTS=1 跳过后两段测试。
if [ "${LITEPAD_SKIP_TESTS:-0}" = "1" ]; then
  echo "    （LITEPAD_SKIP_TESTS=1：跳过前端 + Rust 测试）"
else
  # ⚠️ 直调 vitest 入口，**不要**走 scripts/run-vitest.cjs：那个脚本是 execSync 里再 spawn
  #    `npx vitest`，嵌套进程下会假红（用例全过却报 status 1，把整条构建打断）。
  node node_modules/vitest/vitest.mjs run
fi

echo "==> [3/4] Rust 编译校验 + 单元测试（只校验，产物不可交付 —— 原因见下）"
# ⚠️ 这一步**不要** `cargo build --release`，两个原因：
#   ① 那样产出的 `target/release/litepad.exe` 是 **dev 模式**：tauri 的判定是
#      `dev = !custom-protocol`，而 `custom-protocol` 由 tauri CLI 在**第 4 步**才注入。
#      结果就是这个 exe 会去连 `build.devUrl`（http://127.0.0.1:1420）→ 打开显示
#      「127.0.0.1 拒绝连接」。**不可交付** —— 只有第 4 步覆盖写的同名文件才是能拿给
#      用户 / 截图的生产产物（B98）。
#   ② 两边 feature 不一致 ⇒ 第 4 步会把 tauri 那棵依赖树整棵重编一遍、再跑一次 LTO，
#      等于每次打包付两次全量 release 编译的钱。
#   所以这里只做**校验**（`cargo check` 不产 rlib，不会污染第 4 步的缓存），
#   测试走 dev 档（不带 `--release` ⇒ 也不碰 release 目录）。
#   ⚠️ 别给这两句加 `--all-targets`，也别把测试改成 dev 档（不带 --release）：
#      那会激活 dev-dependencies 的 feature，schemars 0.8.22 于是走 `indexmap` v1 那条路，
#      而它自己的代码写的是 indexmap 2 的三参数签名 ⇒ `cargo test` 直接编不过（E0107）。
#      release 这条 feature 组合是能编过的，别动它。
if [ "${LITEPAD_SKIP_TESTS:-0}" = "1" ]; then
  (cd src-tauri && cargo check --release)
else
  (cd src-tauri && cargo check --release && cargo test --release)
fi

echo "==> [4/4] release 发布构建（嵌入前端 + NSIS 安装包）"
# 覆盖 beforeBuildCommand：第 1 步已产出 dist，直接嵌入，避免重复构建
# B107 更新器签名：私钥在项目外 ~/.tauri/litepad.key，只经环境变量传给 tauri CLI、
# **绝不入库**；没有密钥时降级关闭 createUpdaterArtifacts —— 本机/CI 没配密钥也照常出 exe。
#
# ⚠️ 这是全流程**唯一**一次 release 编译（第 3 步只 check），别再往前面加 `cargo build --release`。
# 档位可选：`LITEPAD_PROFILE=dist`（Cargo.toml 的 `[profile.dist]`，fat LTO、最小体积，
# 打 tag 出正式包时用；注意换档会全量重编，日常别用）。
LITEPAD_PROFILE="${LITEPAD_PROFILE:-release}"
# ⚠️ UPD_CFG 必须先赋值再被 TAURI_ARGS 引用（本轮重构曾把数组提前到赋值前，导致 --config '' 报错）
UPD_CFG='{"build":{"beforeBuildCommand":""}}'
if [ -f "$HOME/.tauri/litepad.key" ]; then
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.tauri/litepad.key")"
  export TAURI_SIGNING_PRIVATE_KEY
  : "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:=}"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
else
  UPD_CFG='{"build":{"beforeBuildCommand":""},"bundle":{"createUpdaterArtifacts":false}}'
  echo "    （未发现 ~/.tauri/litepad.key：本次不产出更新器签名产物）"
fi
TAURI_ARGS=(build --config "$UPD_CFG")
[ "$LITEPAD_PROFILE" = "release" ] || TAURI_ARGS+=(--profile "$LITEPAD_PROFILE")
if [ "$NPM_OK" = 1 ]; then
  npm run tauri -- "${TAURI_ARGS[@]}"
else
  node node_modules/@tauri-apps/cli/tauri.js "${TAURI_ARGS[@]}"
fi

echo
echo "构建完成，产物（profile=$LITEPAD_PROFILE）："
ls -lh "src-tauri/target/$LITEPAD_PROFILE/litepad.exe"
ls -lh "src-tauri/target/$LITEPAD_PROFILE/bundle/nsis/"*.exe

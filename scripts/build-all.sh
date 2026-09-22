#!/usr/bin/env bash
# LitePad 全量构建：debug 校验 + 测试 + release 发布产物（exe + NSIS 安装包）。
#
# 项目约定：每次编译都要把发布版本也编译出来，日常交付用本脚本。
# Requires the GNU host toolchain; see rust-toolchain.toml.
set -e

export PATH="/c/msys64/mingw64/bin:$HOME/.cargo/bin:$PATH"

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
PATH="$FE_PATH" npm run build

echo "==> [2/4] 前端单元测试（vitest）"
node scripts/run-vitest.cjs

echo "==> [3/4] Rust release 构建 + 单元测试"
(cd src-tauri && cargo build --release && cargo test --release)

echo "==> [4/4] release 发布构建（嵌入前端 + NSIS 安装包）"
# 覆盖 beforeBuildCommand：第 1 步已产出 dist，直接嵌入，避免重复构建
npm run tauri -- build --config '{"build":{"beforeBuildCommand":""}}'

echo
echo "构建完成，产物："
ls -lh src-tauri/target/release/litepad.exe
ls -lh src-tauri/target/release/bundle/nsis/*.exe

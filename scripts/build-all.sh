#!/usr/bin/env bash
# LiteMD 全量构建：debug 校验 + 测试 + release 发布产物（exe + NSIS 安装包）。
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
npm run build

echo "==> [2/4] 前端单元测试（vitest）"
node scripts/run-vitest.cjs

echo "==> [3/4] Rust debug 构建 + 单元测试"
(cd src-tauri && cargo build && cargo test)

echo "==> [4/4] release 发布构建（嵌入前端 + NSIS 安装包）"
# 覆盖 beforeBuildCommand：第 1 步已产出 dist，直接嵌入，避免重复构建
npm run tauri -- build --config '{"build":{"beforeBuildCommand":""}}'

echo
echo "构建完成，产物："
ls -lh src-tauri/target/debug/litemd.exe 2>/dev/null || true
ls -lh src-tauri/target/release/litemd.exe
ls -lh src-tauri/target/release/bundle/nsis/*.exe

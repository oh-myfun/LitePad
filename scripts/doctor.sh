#!/usr/bin/env bash
# scripts/doctor.sh —— 环境体检：一条命令回答「现在该用哪条命令、还缺什么」。
#
# ## 为什么要有它
#
# 本项目反复踩的坑，绝大多数不是"命令写错"，而是**在会话里手抄命令**：
# 手抄时会漏掉脚本里已经修好的细节 —— safe-delete 开关、MSYS2 PATH 剥离、
# `dist/assets` 点数自检、crates.io 证书镜像、node/cargo 不在 PATH。
# 于是约定：**构建 / 测试 / 打包只有一个入口 `scripts/build-all.sh`**；
# 它跑不动就修它，不要在会话里另起一套等价命令。
# 本脚本负责把"为什么跑不动"变成可查的事实，而不是靠印象猜。
#
# 用法：bash scripts/doctor.sh        # 只读，不改动任何文件
set -u
cd "$(dirname "$0")/.."

ok() { printf '  ✓ %s\n' "$1"; }
bad() { printf '  ✗ %s\n' "$1"; }
warn() { printf '  ! %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }

echo "== 工具链 =="
if command -v node >/dev/null 2>&1; then ok "node $(node -v)"; else bad "node 不在 PATH（build-all.sh 会自举 managed node）"; fi
if command -v npm >/dev/null 2>&1 && npm --version >/dev/null 2>&1; then
  ok "npm $(npm --version)（走 npm run）"
else
  warn "npm 跑不起来（多因 WSL 黑名单）→ build-all.sh 自动改直调 node_modules 入口"
fi
if command -v cargo >/dev/null 2>&1; then ok "cargo $(cargo --version 2>/dev/null | head -1)"; else bad "cargo 不在 PATH（build-all.sh 会补 \$HOME/.cargo/bin）"; fi
if [ -f node_modules/@tauri-apps/cli/tauri.js ]; then ok "@tauri-apps/cli 已装"; else bad "缺 node_modules/@tauri-apps/cli（先装依赖）"; fi

echo "== 已知陷阱 =="
case "$PATH" in
*msys64*) warn "PATH 含 msys64 条目 —— vite 会挂死；build-all.sh 第 1 步会临时剥离" ;;
*) ok "PATH 干净（无 msys64）" ;;
esac
if [ -f "$HOME/.cargo/config.toml" ]; then
  ok "全局 cargo 配置已就位（crates.io 镜像，免项目内 .cargo）"
else
  warn "无 $HOME/.cargo/config.toml —— 沙箱里 crates.io 证书过期时 tauri build 会失败"
fi
if [ -d .cargo ]; then bad "项目内存在 .cargo/（不该有；它不被 .gitignore 覆盖，会被提交）"; else ok "项目内无 .cargo/"; fi

echo "== 产物现状 =="
N=$(find dist/assets -type f 2>/dev/null | wc -l | tr -d ' ')
if [ "${N:-0}" -ge 10 ]; then ok "dist/assets $N 个文件"; else warn "dist/assets 只有 ${N:-0} 个 —— 先跑前端构建（<10 会被 build-all.sh 拒绝打包）"; fi
EXE=src-tauri/target/release/litepad.exe
if [ -f "$EXE" ]; then
  SZ=$(wc -c <"$EXE" | tr -d ' ')
  MB=$((SZ / 1048576))
  if [ "$SZ" -lt 5242880 ]; then
    bad "$EXE 仅 ${MB}MB —— 疑似空壳（正常 ~8MB）：dist 为空时 tauri build 也 exit 0"
  else
    ok "$EXE ${MB}MB（体积正常）"
    note "⚠️ 它必须是**第 4 步 tauri build** 覆盖写的；第 3 步 cargo build 的产物是 dev 模式，会去连 devUrl"
  fi
else
  warn "还没有 release exe"
fi
if command -v tasklist >/dev/null 2>&1 && tasklist //FI "IMAGENAME eq litepad.exe" 2>/dev/null | grep -qi litepad; then
  warn "有残留 litepad.exe 进程 —— 打包/截图前先退出"
fi

echo
echo "== 推荐命令 =="
echo "  全量构建+测试+打包：  bash scripts/build-all.sh"
echo "  只跑类型检查：        npm run typecheck"
echo "  只跑测试：            node scripts/run-vitest.cjs"
echo "  重拍截图：            CODEBUDDY_SAFE_DELETE_ENABLED=0 python scripts/capture-screenshots.py"
echo "  快照 .workbuddy：     bash scripts/backup-workbuddy.sh"
echo
echo "（以上任何一条失败，修对应脚本，不要在会话里手抄等价命令。）"

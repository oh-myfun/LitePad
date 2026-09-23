#!/usr/bin/env bash
# scripts/shot.sh —— 补拍 `docs/screenshots/` 的唯一入口。
#
# 为什么要有这层包装：真跑起来要两件前置（python 解释器 + `CODEBUDDY_SAFE_DELETE_ENABLED=0`），
# 以前这两件都在会话里手敲 —— 手敲就会漏，而漏了的表现不是报错，是「safe-delete 钩子
# 拦住清理 → 截图停在旧图」，很难察觉。
#
# 用法：bash scripts/shot.sh [配方名…]        # 等价于 npm run screenshot
#       PYTHON=/path/to/python bash scripts/shot.sh
set -e
cd "$(dirname "$0")/.."

# ⚠️ 必带：移开 WebView2 用户数据（按需，仅首轮失败时才发生）会触发 safe-delete 钩子。
#    该钩子在本会话环境里存在，在用户桌面环境里不存在 —— 设了无副作用。
export CODEBUDDY_SAFE_DELETE_ENABLED=0

PY="${PYTHON:-}"
if [ -z "$PY" ] || ! command -v "$PY" >/dev/null 2>&1; then
  for c in python \
    "$HOME/.workbuddy/binaries/python/envs/default/Scripts/python.exe" \
    "/c/Users/maoyu/.workbuddy/binaries/python/envs/default/Scripts/python.exe"; do
    if command -v "$c" >/dev/null 2>&1; then
      PY="$c"
      break
    fi
  done
fi
if [ -z "$PY" ]; then
  echo "✗ 找不到 python（可用 PYTHON=<路径> 指定）" >&2
  exit 1
fi

echo "▸ python: $PY"
exec "$PY" scripts/capture-screenshots.py "$@"

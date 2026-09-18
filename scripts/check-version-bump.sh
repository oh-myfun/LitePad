#!/usr/bin/env bash
# LitePad 版本号守卫：防止「开发了半天版本号一点没变」。
#
# 口径（见 docs/conventions.md「版本号规则」，SemVer + Conventional Commit）：
#   feat            → minor
#   fix / perf      → patch
#   破坏性（! / BREAKING CHANGE）→ 1.0.0 前记 minor，1.0.0 后 major
#   docs / test / chore / style / ci → 不单独触发，只计入累积
#
# 行为：距最近 tag 以来达到阈值却没 bump → 阻断 push（exit 1）；未达阈值 → 只告警。
# 由 .githooks/pre-push 在 vitest/cargo 之前调用（便宜的检查先做，失败得快）。
#
# 用法：
#   bash scripts/check-version-bump.sh              # 手动查一次
#   LITEPAD_SKIP_VERSION_CHECK=1 git push ...        # 紧急绕过（仅限明确知情时）
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

# —— 阈值 ——
FEAT_BLOCK=1        # 有 feat 却未 bump → 阻断
EFFECTIVE_BLOCK=10  # 有效提交累计 ≥10 未 bump → 阻断
EFFECTIVE_WARN=5    # ≥5 → 告警
ALL_WARN=20         # 总提交 ≥20 → 告警

if [ "${LITEPAD_SKIP_VERSION_CHECK:-0}" = "1" ]; then
  echo "⚠ 已按 LITEPAD_SKIP_VERSION_CHECK=1 跳过版本号守卫"
  exit 0
fi

# —— 1) 三处版本号必须同步 ——
PKG="$(node -p "require('./package.json').version" 2>/dev/null || echo "")"
TAURI="$(node -p "require('./src-tauri/tauri.conf.json').version" 2>/dev/null || echo "")"
CARGO="$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' src-tauri/Cargo.toml | head -1)"

if [ -z "$PKG" ] || [ -z "$TAURI" ] || [ -z "$CARGO" ]; then
  echo "⚠ 读不全三处版本号（pkg='$PKG' tauri='$TAURI' cargo='$CARGO'），跳过守卫" >&2
  exit 0
fi

if [ "$PKG" != "$TAURI" ] || [ "$PKG" != "$CARGO" ]; then
  echo "✗ 三处版本号不一致：" >&2
  echo "    package.json        = $PKG" >&2
  echo "    tauri.conf.json     = $TAURI" >&2
  echo "    src-tauri/Cargo.toml= $CARGO" >&2
  echo "  修：npm run release $PKG    （release.sh 会三处同步）" >&2
  exit 1
fi

# —— 2) 定位最近 tag ——
TAG="$(git describe --tags --abbrev=0 2>/dev/null || echo "")"
if [ -z "$TAG" ]; then
  echo "· 尚无 tag，跳过版本号守卫"
  exit 0
fi
TAG_VER="${TAG#v}"

# 版本号已领先 tag ⇒ 说明已经 bump 过（release 流程：先改版本再打 tag）
if [ "$PKG" != "$TAG_VER" ]; then
  echo "✓ 版本号已 bump：$TAG → v$PKG（推送时用 --follow-tags，否则 tag 不上去、不会出 Release）"
  exit 0
fi

# —— 3) 统计 tag 以来的提交类型 ——
LOG="$(git log "${TAG}..HEAD" --no-merges --pretty=format:'%s' || true)"
FEAT="$(printf '%s\n' "$LOG" | grep -cE '^feat(\(|\!|:)' || true)"
EFFECTIVE="$(printf '%s\n' "$LOG" | grep -cE '^(feat|fix|perf|refactor|revert)(\(|\!|:)' || true)"
ALL="$(printf '%s\n' "$LOG" | grep -cE '.' || true)"

verdict() {
  # $1 = 建议 minor | patch
  echo "" >&2
  echo "✗ 版本号守卫：距 $TAG 已 $ALL 个提交（feat $FEAT / 有效 $EFFECTIVE），版本号仍是 $PKG" >&2
  echo "  按 docs/conventions.md 的口径，应 bump $1。" >&2
  echo "  执行其一：" >&2
  echo "      npm run release $1            # 本地全量构建（tsc/vitest/cargo/NSIS）后打 tag" >&2
  echo "      npm run release $1 -- --ci    # 跳过本地构建，由 GitHub Actions 在 tag 上出包" >&2
  echo "  确属误报可用 LITEPAD_SKIP_VERSION_CHECK=1 绕过。" >&2
  exit 1
}

if [ "$FEAT" -ge "$FEAT_BLOCK" ]; then verdict minor; fi
if [ "$EFFECTIVE" -ge "$EFFECTIVE_BLOCK" ]; then verdict patch; fi

if [ "$EFFECTIVE" -ge "$EFFECTIVE_WARN" ] || [ "$ALL" -ge "$ALL_WARN" ]; then
  echo "⚠ 版本号仍是 $PKG：$TAG 以来 $ALL 个提交（feat $FEAT / 有效 $EFFECTIVE），接近 bump 阈值" >&2
  echo "  （feat ≥$FEAT_BLOCK 或有效提交 ≥$EFFECTIVE_BLOCK 会强制阻断；先 npm run release <patch|minor>）" >&2
  exit 0
fi

echo "✓ 版本号守卫通过（$TAG 以来 $ALL 个提交，无需 bump）"
exit 0

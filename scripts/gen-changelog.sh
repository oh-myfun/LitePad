#!/usr/bin/env bash
# LitePad 更新日志生成：从 Conventional Commit 自动整理出一个版本小节，插到 CHANGELOG.md 顶部。
#
# 用法：
#   bash scripts/gen-changelog.sh                    # prev = 最近 tag，ver = package.json 版本
#   bash scripts/gen-changelog.sh v0.3.0 0.4.0       # 显式指定起止
#
# 约定：
#   - 由 release.sh 在发布流程里自动调用（step 1 之后、commit 之前），产出进同一个 release 提交
#   - 分组口径与 docs/conventions.md「版本号规则」一致：feat=新功能、fix=修复、perf=性能、
#     refactor=重构，其余（docs/test/chore/style/build/ci）= 其他
#   - 中间文件落项目内 .tmp/（本项目铁律：临时文件不许写 %TEMP%）
set -euo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

PREV="${1:-$(git describe --tags --abbrev=0 2>/dev/null || echo "")}"
VER="${2:-$(node -p "require('./package.json').version")}"
DATE="$(date +%F)"

if [ -z "$PREV" ]; then
  echo "✗ 找不到基准 tag（首个版本请显式指定起点，或先 git tag v0.1.0 <最早提交>）" >&2
  exit 1
fi
git rev-parse -q --verify "$PREV" >/dev/null || { echo "✗ 基准 tag 不存在：$PREV" >&2; exit 1; }

mkdir -p .tmp
TMP=".tmp/changelog-$$.md"

# —— 按类型归类（保持 git log 的新→旧顺序）——
FEAT=""; FIX=""; PERF=""; REFACTOR=""; OTHER=""
COUNT=0
while IFS=$'\x1f' read -r sha subj; do
  [ -n "$subj" ] || continue
  COUNT=$((COUNT + 1))
  line="- ${subj#*: } \`$sha\`"
  case "$subj" in
    feat*)      FEAT="${FEAT}${line}"$'\n' ;;
    fix*)       FIX="${FIX}${line}"$'\n' ;;
    perf*)      PERF="${PERF}${line}"$'\n' ;;
    refactor*)  REFACTOR="${REFACTOR}${line}"$'\n' ;;
    *)          OTHER="${OTHER}${line}"$'\n' ;;
  esac
done < <(git log "${PREV}..HEAD" --no-merges --pretty=format:'%h%x1f%s')

{
  echo "# LitePad 更新日志"
  echo
  echo "> 本文件由 \`scripts/gen-changelog.sh\` 从 Conventional Commit 自动生成，"
  echo "> \`scripts/release.sh\` 发布时自动刷新；版本口径见 \`docs/conventions.md\`「版本号规则」。"
  echo
  echo "## v${VER} — ${DATE}"
  echo
  echo "本版距 \`${PREV}\` 共 ${COUNT} 个提交。"
  echo
  if [ -n "$FEAT" ];     then echo "### 新功能"; echo; printf '%s' "$FEAT";     echo; fi
  if [ -n "$FIX" ];      then echo "### 修复";   echo; printf '%s' "$FIX";      echo; fi
  if [ -n "$PERF" ];     then echo "### 性能";   echo; printf '%s' "$PERF";     echo; fi
  if [ -n "$REFACTOR" ]; then echo "### 重构";   echo; printf '%s' "$REFACTOR"; echo; fi
  if [ -n "$OTHER" ];    then echo "### 其他";   echo; printf '%s' "$OTHER";    echo; fi

  # 保留既有历史（跳过旧文件的头部说明，从第一个 ## 小节起拼接）
  if [ -f CHANGELOG.md ]; then
    START="$(grep -n '^## ' CHANGELOG.md | head -1 | cut -d: -f1)"
    if [ -n "$START" ]; then
      echo "---"
      echo
      tail -n "+$START" CHANGELOG.md
    fi
  fi
} > "$TMP"

mv "$TMP" CHANGELOG.md
echo "✓ CHANGELOG.md 已更新：新增小节 v${VER}（${COUNT} 个提交，基准 ${PREV}）"

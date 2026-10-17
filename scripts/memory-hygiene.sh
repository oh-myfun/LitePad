#!/usr/bin/env bash
# memory-hygiene.sh —— 记忆层自检（规则见 .workbuddy/memory/rules/index.md「记忆卫生」）
#
# 为什么需要脚本而不是只写规则：10-17 之前已有一条「daily log 只留近 7 天」的纯文字规则，
# 结果 23 篇日志一篇没清、记忆涨到 1.8MB。没有可执行判据的约束，注定被违反。
#
# 用法：bash scripts/memory-hygiene.sh        # 全量自检，有问题则 exit 1
#       bash scripts/memory-hygiene.sh --warn # 只告警不阻断（pre-push 用这个档，
#                                             #   但「死指针」始终阻断）
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

MEM=".workbuddy/memory"
PIT="$MEM/pitfalls"
WARN_ONLY="${1:-}"
[ -d "$MEM" ] || { echo "✗ 找不到 $MEM"; exit 1; }

err=0; warn=0
fail() { echo "  ✗ $*"; err=$((err+1)); }
note() { echo "  ⚠ $*"; warn=$((warn+1)); }

echo "▸ 1. 体量与预算"
# MEMORY.md 每次会话整篇注入，且注入有字数上限、超长会静默截断 ⇒ 必须卡在预算内
MEM_MD_MAX=200   # 行
LINES=$(wc -l < "$MEM/MEMORY.md" | tr -d ' ')
if [ "${LINES:-0}" -gt "$MEM_MD_MAX" ]; then
  fail "MEMORY.md $LINES 行 > 预算 $MEM_MD_MAX（超注入上限会被静默截断，红线丢失）"
else
  echo "  ✓ MEMORY.md $LINES 行（预算 $MEM_MD_MAX）"
fi
TOTAL=$(du -sk "$MEM" | cut -f1)
if [ "${TOTAL:-0}" -gt 600 ]; then
  note ".workbuddy/memory 共 ${TOTAL}KB（历史峰值 1.8MB；>600KB 说明日志/坑点又在堆积）"
else
  echo "  ✓ 记忆总体量 ${TOTAL}KB"
fi
CNT=$(find "$MEM" -name '*.md' | wc -l | tr -d ' ')
echo "  · 记忆文件数 $CNT（pitfalls $(ls -1 "$PIT"/*.md 2>/dev/null | grep -vc 'README')）"

echo "▸ 2. daily log 是否只留近 7 天"
CUTOFF=$(date -d '7 days ago' +%Y-%m-%d 2>/dev/null || echo "")
if [ -z "$CUTOFF" ]; then
  note "date -d 不可用，跳过日志时效检查"
else
  found=0
  for f in "$MEM"/*.md "$MEM"/open-items/*.md; do
    [ -f "$f" ] || continue
    base=$(basename "$f" .md)
    case "$base" in 20??-??-??) ;; *) continue ;; esac
    if [ "$base" \< "$CUTOFF" ]; then
      fail "过期 daily log 未清：$f（早于 $CUTOFF）⇒ 先蒸馏进 ref/rules/backlog 再删文件"
      found=1
    fi
  done
  [ "$found" = 0 ] && echo "  ✓ 无超期日志"
fi

echo "▸ 3. pitfalls/README 索引与文件是否一致"
if [ -f "$PIT/README.md" ]; then
  for f in "$PIT"/*.md; do
    b=$(basename "$f" .md); [ "$b" = "README" ] && continue
    n=$(echo "$b" | cut -d- -f1)
    grep -q "| $n " "$PIT/README.md" || fail "README 表里缺 $b（索引落后 = 下次找不到，只能另起新号）"
  done
  for row in $(grep -oE '^\| [0-9]{4} ' "$PIT/README.md" 2>/dev/null | tr -d '| '); do
    ls "$PIT/$row"-*.md >/dev/null 2>&1 || fail "README 表里的 $row 已无对应文件（先删表行或补文件）"
  done
fi
# 同 slug 重复（历史上 0106/0108 就是同主题各写一份）
dup=$(for f in "$PIT"/*.md; do basename "$f" .md | sed 's/^[0-9]*-//'; done | grep -v '^README$' | sort | uniq -d)
[ -n "$dup" ] && fail "同主题重复 slug：$(echo $dup | tr '\n' ' ')⇒ 合并进一条，别开新编号"

echo "▸ 4. 死指针（记忆谎称的守卫最危险：会让人以为已被保护）"
# 豁免：句子本身在讲「已删/当时/之前/历史/旧」的过去时叙述
scan_refs() {
  local pat="$1"
  grep -rn -oE "$pat" "$MEM" --include='*.md' 2>/dev/null | while IFS=: read -r file line match; do
    ctx=$(sed -n "${line}p" "$file")
    case "$ctx" in *已删*|*已下线*|*当时*|*之前*|*历史*|*旧*|*已拆*) continue ;; esac
    p=$(echo "$match" | sed 's#^[0-9]*:##')
    case "$p" in
      *xxx*|*\**|*\<*|*\>*) continue ;;   # 散文里的占位示例，不是真引用
      tests/*|scripts/*)
        [ -f "$p" ] || echo "DEAD|$file:$line|$p" ;;
      pitfalls/*)
        ls "$PIT/${p#pitfalls/}"*.md >/dev/null 2>&1 || echo "DEAD|$file:$line|$p" ;;
    esac
  done
}
DEAD=$( { scan_refs '(tests|scripts)/[A-Za-z0-9._-]+\.(ts|tsx|sh|cjs|mjs|py)'; scan_refs 'pitfalls/[0-9]{4}[a-z0-9-]*'; } | sort -u -t'|' -k3 )
if [ -n "$DEAD" ]; then
  while IFS='|' read -r _ loc what; do
    fail "死指针 $loc → $what（该文件不存在；要么改指真正守住它的测试，要么写「无守卫，属欠账」）"
  done <<< "$DEAD"
else
  echo "  ✓ 无死指针"
fi
grep -rn "待核" "$MEM" --include='*.md' >/dev/null 2>&1 && note "仍有「待核」标记未收口"

echo "▸ 5. 与仓库的耦合提醒"
# .workbuddy 已整体 gitignore ⇒ workbuddy-local 快照是记忆的唯一历史
if git rev-parse --verify workbuddy-local >/dev/null 2>&1; then
  SNAP=$(git log -1 --format=%ad --date=short workbuddy-local)
  echo "  · workbuddy-local 最近快照：$SNAP（大改记忆前后各跑一次 scripts/backup-workbuddy.sh）"
else
  fail "workbuddy-local 分支不存在：记忆没有任何历史，删错了找不回"
fi

echo
if [ "$err" -gt 0 ]; then
  echo "✗ 记忆卫生未通过：$err 项 ✗ / $warn 项 ⚠"
  echo "  判据与删除口径见 $MEM/rules/index.md「记忆卫生」一节。"
  # --warn：只报告不阻断（pre-push 用这档 —— 代码推送不该被文档状态卡死）
  [ "$WARN_ONLY" = "--warn" ] && { echo "（--warn 模式：不阻断）"; exit 0; }
  exit 1
fi
echo "✓ 记忆卫生通过（$warn 项告警）"

#!/usr/bin/env bash
# memory-hygiene.sh —— 记忆层自检（规则见 .agents/rules/memory-hygiene.md）
#
# 为什么需要脚本而不是只写规则：10-17 之前已有一条「daily log 只留近 7 天」的纯文字规则，
# 结果 23 篇日志一篇没清、记忆涨到 1.8MB。没有可执行判据的约束，注定被违反。
#
# 用法：bash scripts/memory-hygiene.sh        # 全量自检，有问题则 exit 1
#       bash scripts/memory-hygiene.sh --warn # 只告警不阻断（pre-push 用这个档，
#                                             #   但「死指针」始终阻断）
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

MEM=".agents"
PIT="$MEM/pitfalls"
ENTRY="AGENTS.md"
WARN_ONLY="${1:-}"
[ -d "$MEM" ] || { echo "✗ 找不到 $MEM"; exit 1; }

err=0; warn=0
fail() { echo "  ✗ $*"; err=$((err+1)); }
note() { echo "  ⚠ $*"; warn=$((warn+1)); }

echo "▸ 1. 体量与预算"
# AGENTS.md 每次会话整篇注入，且注入有字数上限、超长会静默截断 ⇒ 必须卡在预算内
ENTRY_MAX=200   # 行
if [ -f "$ENTRY" ]; then
  LINES=$(wc -l < "$ENTRY" | tr -d ' ')
  if [ "${LINES:-0}" -gt "$ENTRY_MAX" ]; then
    fail "$ENTRY $LINES 行 > 预算 $ENTRY_MAX（超注入上限会被静默截断，红线丢失）"
  else
    echo "  ✓ $ENTRY $LINES 行（预算 $ENTRY_MAX）"
  fi
else
  fail "找不到入口 $ENTRY"
fi
TOTAL=$(du -sk "$MEM" | cut -f1)
if [ "${TOTAL:-0}" -gt 600 ]; then
  note ".agents 共 ${TOTAL}KB（历史峰值 1.8MB；>600KB 说明日志/坑点又在堆积）"
else
  echo "  ✓ 记忆总体量 ${TOTAL}KB"
fi
CNT=$(find "$MEM" -name '*.md' | wc -l | tr -d ' ')
echo "  · 记忆文件数 $CNT（pitfalls $(ls -1 "$PIT"/*.md 2>/dev/null | grep -vc 'README')）"

echo "▸ 2. 目录形态（不设归档区 / 不存日志）"
for d in archive log; do
  [ -d "$MEM/$d" ] && fail "出现了 $MEM/$d：本项目口径是直接删除而非归档，日志也不常驻"
done
[ -d "$MEM/archive" ] || [ -d "$MEM/log" ] || echo "  ✓ 无 archive/ 与 log/ 目录"

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
    case "$ctx" in *已删*|*已下线*|*已退役*|*退役*|*已拆分*|*不存在*|*当时*|*之前*|*历史*|*旧*|*已拆*) continue ;; esac
    p=$(echo "$match" | sed 's#^[0-9]*:##')
    case "$p" in
      *xxx*|*\**|*\<*|*\>*) continue ;;   # 散文里的占位示例，不是真引用
      tests/*|scripts/*)
        [ -f "$p" ] || echo "DEAD|$file:$line|$p" ;;
      *pitfalls/[0-9]*)
        [ -f "$PIT/$(basename "$p")" ] || echo "DEAD|$file:$line|$p" ;;
    esac
  done
}
DEAD=$( { scan_refs '(tests|scripts)/[A-Za-z0-9._-]+\.(ts|tsx|sh|cjs|mjs|py)'; scan_refs 'pitfalls/[0-9]{4}[a-z0-9-]*\.md'; } | sort -u -t'|' -k3 )
if [ -n "$DEAD" ]; then
  while IFS='|' read -r _ loc what; do
    fail "死指针 $loc → $what（该文件不存在；要么改指真正守住它的测试，要么写「无守卫，属欠账」）"
  done <<< "$DEAD"
else
  echo "  ✓ 无死指针"
fi
grep -rn "待核" "$MEM" --include='*.md' >/dev/null 2>&1 && note "仍有「待核」标记未收口"

echo "▸ 5. 与仓库的耦合提醒"
# .agents 已整体 gitignore ⇒ agents-local 快照是记忆的唯一历史
if git rev-parse --verify agents-local >/dev/null 2>&1; then
  SNAP=$(git log -1 --format=%ad --date=short agents-local)
  echo "  · agents-local 最近快照：$SNAP（大改记忆前后各跑一次 scripts/backup-agents.sh）"
else
  fail "agents-local 分支不存在：记忆没有任何历史，删错了找不回"
fi

echo
if [ "$err" -gt 0 ]; then
  echo "✗ 记忆卫生未通过：$err 项 ✗ / $warn 项 ⚠"
  echo "  判据与删除口径见 $MEM/rules/memory-hygiene.md。"
  # --warn：只报告不阻断（pre-push 用这档 —— 代码推送不该被文档状态卡死）
  [ "$WARN_ONLY" = "--warn" ] && { echo "（--warn 模式：不阻断）"; exit 0; }
  exit 1
fi
echo "✓ 记忆卫生通过（$warn 项告警）"

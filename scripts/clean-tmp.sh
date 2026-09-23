#!/usr/bin/env bash
# scripts/clean-tmp.sh —— 清理项目内临时目录 `.tmp/`。**默认只列不删（dry-run）**。
#
# 为什么默认 dry-run：`.tmp/` 里可能压着还没复盘的日志、探针脚本、截图备份、放大对照图。
# 一次误删就把排查线索抹掉了；而且本项目明确禁止在会话里手写删除命令，所以清理也走脚本。
#
# 用法：bash scripts/clean-tmp.sh          # 只列清单
#       bash scripts/clean-tmp.sh --yes    # 真删（会二次确认已列出的范围）
set -u
cd "$(dirname "$0")/.."

DO=0
for a in "$@"; do
  [ "$a" = "--yes" ] && DO=1
done

if [ ! -d .tmp ]; then
  echo ".tmp/ 不存在，无需清理。"
  exit 0
fi

echo "== .tmp/ 现有内容 =="
du -sh .tmp/* 2>/dev/null | sort -rh | head -20
echo
echo "总计：$(du -sh .tmp 2>/dev/null | cut -f1)"

# 只清「可再生」的那几类：日志、放大对照图、中间步骤图、截图时的配置备份与隔离目录。
# ⚠️ 探针脚本（rv-*.py / *.cjs）**不删** —— 那是反向验证的产物，可能还要复盘。
TARGETS=$(find .tmp -maxdepth 1 -type f \( -name '*.log' -o -name 'zoom-*.png' -o -name 'z2-*.png' -o -name 'step-*.png' \) 2>/dev/null)
DIRS=""
for d in .tmp/screenshot-backup .tmp/shot; do
  [ -d "$d" ] && DIRS="${DIRS:+$DIRS }$d"
done

if [ -z "$TARGETS" ] && [ -z "$DIRS" ]; then
  echo "没有可清理的临时产物。"
  exit 0
fi

echo
echo "== 将被删除 =="
[ -n "$TARGETS" ] && printf '%s\n' "$TARGETS"
[ -n "$DIRS" ] && printf '%s\n' "$DIRS"

if [ "$DO" != 1 ]; then
  echo
  echo "（dry-run：以上均未删除。确认后加 --yes。）"
  exit 0
fi

printf '%s\n' "$TARGETS" | while read -r f; do [ -n "$f" ] && rm -f "$f"; done
for d in $DIRS; do rm -rf "$d"; done
echo
echo "已清理。剩余："
du -sh .tmp/* 2>/dev/null | sort -rh | head -10

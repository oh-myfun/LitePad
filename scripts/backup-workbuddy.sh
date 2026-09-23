#!/usr/bin/env bash
# backup-workbuddy.sh
# 把磁盘上的 .workbuddy 快照提交到本地分支 workbuddy-local，作为备份。
# 关键：不切换分支、不碰主工作树、绝不删除磁盘上的 .workbuddy。
# 实现：用「临时索引」以 workbuddy-local 的树为基底，叠加磁盘上的 .workbuddy，
#       生成新 tree 后直接 commit-tree 到 workbuddy-local（不改动当前分支的索引/工作树）。
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
BRANCH="workbuddy-local"

if ! git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  echo "错误：本地分支 $BRANCH 不存在" >&2
  exit 1
fi

GITDIR="$(git rev-parse --absolute-git-dir)"
TMP_INDEX="$GITDIR/.workbuddy-backup-index"

# 以 workbuddy-local 的树为基底，载入临时索引
GIT_INDEX_FILE="$TMP_INDEX" git read-tree "$BRANCH"

# 把磁盘上的 .workbuddy 叠加进临时索引（强制纳入被忽略的文件；
# -A 同时处理「磁盘已删除」的情况，使其从备份 tree 中移除）
GIT_INDEX_FILE="$TMP_INDEX" git add -A -f .workbuddy

# 生成 tree，并清理临时索引
TREE="$(GIT_INDEX_FILE="$TMP_INDEX" git write-tree)"
rm -f "$TMP_INDEX"

# 与当前 workbuddy-local 的 tree 一致 => 无变化，跳过
CUR_TREE="$(git rev-parse "$BRANCH^{tree}")"
if [ "$TREE" = "$CUR_TREE" ]; then
  echo ".workbuddy 无变化，跳过备份提交。"
  exit 0
fi

PARENT="$(git rev-parse "$BRANCH")"
MSG="backup(workbuddy): 自动快照 $(date +%Y-%m-%dT%H:%M:%S)"
NEW="$(git commit-tree "$TREE" -p "$PARENT" -m "$MSG")"
git branch -f "$BRANCH" "$NEW"
echo "已更新 $BRANCH -> $(git rev-parse --short "$NEW")（仅本地，勿推送）"

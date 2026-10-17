#!/usr/bin/env bash
# 清掉旧日志，让下一次复现的现场是干净的（取证工作流的第一步）。
#
# 为什么要清：同步滚动的判定日志一秒能打好几十行，复现一次就是一整段；新旧两次复现混在
# 同一个 `litepad.log` 里，读的时候要靠时间戳切窗口，切错了就把上一轮的结论当成这一轮的。
#
# ⚠️ 为什么要求先关窗：写盘线程握着 `litepad.log` 的**追加句柄**。它在运行中你把正本删了，
# 句柄不会重开 —— 之后的写入会继续按原来的偏移量落盘，文件变成一段空洞 + 尾部新内容，
# 读出来是坏的。所以这里只肯在「没有 litepad.exe 在跑」的时候动手。
set -euo pipefail

CFG="${LITEPAD_CONFIG_DIR:-$APPDATA/LitePad}"
LOG_DIR="$CFG/logs"

if tasklist //FI "IMAGENAME eq litepad.exe" 2>/dev/null | grep -qi "litepad.exe"; then
  echo "✗ LitePad 正在运行。先正常关窗（关窗前最后几条日志已经会落盘 —— 见 flush_pending），再跑这条。" >&2
  exit 1
fi
if [ ! -d "$LOG_DIR" ]; then
  echo "· 没有日志目录，无需清理：$LOG_DIR"
  exit 0
fi
rm -f "$LOG_DIR"/litepad.log "$LOG_DIR"/litepad.log.*
echo "✓ 已清空日志目录：$LOG_DIR"
echo "· 现在启动 LitePad 再复现；复现完直接关窗，日志尾部不会缺。"

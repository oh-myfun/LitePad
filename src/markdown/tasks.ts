// 任务清单勾选框 ↔ 源码行的映射（B358）。
//
// 渲染面（IR widget 与只读预览岛）里第 N 个 `.md-task` 勾选框，对应
// `[lineStart, lineEnd]` 内按顺序数的第 N 条任务行。管线给勾选框加 `disabled`，
// 可写的面在 DOM 侧摘掉它，只读文档保持灰着 —— 点不动的键比谎报可点强（B228 口径）。
import type { Text } from "@codemirror/state";

/** 一条任务行在源码里的落点：行号 + 方括号记号的字符区间 + 当前勾选态。 */
export interface TaskLineInfo {
  line: number;
  from: number;
  to: number;
  checked: boolean;
}

const TASK_RE = /^(\s*(?:>\s*)*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\]/;

/**
 * 块区间内第 `index` 个任务行的落点；换算不了（越界 / 没有任务行）给 null。
 * ⚠️ 序号按**任务行**数：任务行之间的续行、空行都不占号。
 */
export function taskLineAt(
  text: Text,
  lineStart: number,
  lineEnd: number,
  index: number,
): TaskLineInfo | null {
  let n = 0;
  for (let no = lineStart; no <= lineEnd; no++) {
    if (no < 1 || no > text.lines) break;
    const line = text.line(no);
    const m = TASK_RE.exec(line.text);
    if (!m) continue;
    if (n === index) {
      const mark = m[2];
      return {
        line: no,
        from: line.from + m[1].length,
        to: line.from + m[1].length + 3,
        checked: mark.toLowerCase() === "x",
      };
    }
    n++;
  }
  return null;
}

/** 翻转后的方括号记号（写回用）：`[x]/[X]` → `[ ]`，`[ ]` → `[x]`。 */
export function flippedTaskMark(checked: boolean): string {
  return checked ? "[ ]" : "[x]";
}

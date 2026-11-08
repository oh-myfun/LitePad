// B461 · 「回退此块」的纯文本换算（中间那列按钮真正动文档的那一步）。
//
// 语义照 VS Code `diffEditorWidget.ts` 的 `RevertHunkOrSelection`：把**原稿**那一段写回
// **新稿**。右栏就是 `Panel.view` = 这份文档本身 ⇒ 落到 CM6 只是一次普通文档编辑
// （可撤销、会标脏、会触发防抖重算），与用户手敲走同一条路，不是第二套写入机制。
//
// 为什么单独一颗模块：行号 → 字符偏移的边界（空段、文首、文末、末尾换行）全是容易写错的
// 算术，抽成纯函数才测得住；`surface.ts` 只负责把结果派发出去。

import type { DiffBlock } from "./blocks";

/** 一次 `{ from, to, insert }` 替换（CM6 的 `ChangeSpec` 子集）。 */
export interface RevertEdit {
  from: number;
  to: number;
  insert: string;
}

/**
 * 把一块的「原稿正文」换算成一次针对新稿的替换。
 *
 * 行号口径与 `blocks.ts` 一致：1-based、含端点、空段 `start = end + 1`。
 * 返回 `null` 表示这块没有可做的事（两侧都空 —— 正常不会出现）。
 */
export function revertEdit(
  originalText: string,
  modifiedText: string,
  block: DiffBlock,
): RevertEdit | null {
  const orig = originalText.split("\n");
  const mod = modifiedText.split("\n");

  /** 1-based 行号 → 该行行首的字符偏移；越界给文末（追加点）。 */
  const lineStart = (line: number): number => {
    if (line <= 1) return 0;
    if (line > mod.length) return modifiedText.length;
    let at = 0;
    for (let i = 0; i < line - 1; i++) at += mod[i].length + 1;
    return at;
  };

  const from = block.originalStart;
  const to = block.originalEnd;
  const text = to < from ? "" : orig.slice(from - 1, to).join("\n");

  const mStart = block.modifiedStart;
  const mEnd = block.modifiedEnd;

  // 右栏是空段（原稿有、新稿没有）：在 mStart 行之前插入一整段。
  // 边界只看插入点两侧的字符：前面不是换行才补前导换行，后面还有内容才补结尾换行 ——
  // 这样「文首 / 文末 / 文末带换行 / 空文档」四种边界都自然落对，不用各写一条特判。
  if (mEnd < mStart) {
    if (text === "") return null;
    const at = lineStart(mStart);
    const before = at > 0 ? modifiedText[at - 1] : "";
    const after = at < modifiedText.length ? modifiedText[at] : "";
    const prefix = before !== "" && before !== "\n" ? "\n" : "";
    const suffix = after !== "" && after !== "\n" ? "\n" : "";
    return { from: at, to: at, insert: prefix + text + suffix };
  }

  const start = lineStart(mStart);
  // 右栏这一段有真行：替换范围按「吃掉块尾那个换行」算（VS Code 的 `toExclusiveRange`）。
  // 块尾之后还有行 ⇒ 替换到下一行行首，原稿有内容就补回那个换行；块尾就是文末 ⇒ 到文末为止。
  if (mEnd < mod.length) {
    return {
      from: start,
      to: lineStart(mEnd + 1),
      insert: text === "" ? "" : text + "\n",
    };
  }
  return { from: start, to: modifiedText.length, insert: text };
}

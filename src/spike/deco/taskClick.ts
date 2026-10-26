// B391F-5 · 装饰面上的任务勾选框。
// 命中判定移植自 InkNote (MIT, Copyright (c) 2026 likehao19) src/editor.ts:1223-1293
// 本机参照：E:\Project\InkNote\InkNote
//
// 与 InkNote 的**一处**关键差别：它那颗 view 自己就能写，所以命中后直接
// `view.dispatch({changes})`；装饰面是只读镜像，写必须回到宿主那棵源码 view。
// 因此这里交出去的是**文档行号**而不是「岛内第几个勾选框」。这不是省事 ——
// 现方案按「渲染面里第 N 个 `.md-task`」换算（`markdown/tasks.ts`），那套序号在
// B394-2 上把勾写到了别的行（点第二个勾，`- [x]` 落到了空任务行上）。行号没有
// 中间量，也就没有换算可错；写点仍然是 `markdown.ts` 那颗唯一的 `toggleTaskInTab`。

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { TASK_LINE_RE } from "./previewSets";

export interface DecoTaskHandlers {
  /** 点中第 `line` 行的方框 ⇒ 宿主去翻那一行的 `[ ]` / `[x]`。 */
  onToggleTask: (line: number) => void;
  /**
   * 这一格现在许不许写（只读文档要挡）。
   * 不给就当作一直许 —— 写点自己还有 `doc.readonly` 那道闸，这里只多不少。
   */
  canToggleTask?: () => boolean;
}

/** 方框的视觉左沿：`padding-left − 标记位宽`（deco.css 就是把方框画在这个差值上）。 */
function checkboxLeftOf(lineEl: HTMLElement, style: CSSStyleDeclaration): number {
  const rect = lineEl.getBoundingClientRect();
  const fontSize = Number.parseFloat(style.fontSize) || 16;
  const paddingLeft = Number.parseFloat(style.paddingLeft);
  // 嵌套项的方框跟着 `--md-list-marker-left` 走（previewSets 给缩进那一档写在行内 style 上）
  const nested = lineEl.getAttribute("style")?.includes("--md-list-marker-left") ?? false;
  const markerOffsetRaw =
    (nested ? style.getPropertyValue("--md-list-marker-width") : "").trim() ||
    style.getPropertyValue("--editor-list-marker-offset").trim();
  const markerOffsetValue = Number.parseFloat(markerOffsetRaw);
  const markerOffset = Number.isFinite(markerOffsetValue)
    ? markerOffsetValue * (markerOffsetRaw.endsWith("em") ? fontSize : 1)
    : 22;
  return Number.isFinite(paddingLeft) ? rect.left + paddingLeft - markerOffset : rect.left;
}

/**
 * 装饰面的点勾。
 *
 * 判「点中没点中」以**行 DOM** 为准，而不是 `posAtCoords`：伪元素画出来的方框偶尔会让
 * 坐标落到相邻行上（InkNote 同一条注释），而行元素不会骗人。两种落点算命中：
 * 压在方框的视觉位置上（含左右热区），或正好压在源码里那三个字符 `[ ]` 上。
 */
export function taskClick(handlers: DecoTaskHandlers): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target as HTMLElement | null;
      const lineEl = target?.closest?.(".cm-line.md-task-item") as HTMLElement | null;
      if (!lineEl) return false;

      const at = view.posAtDOM(lineEl, 0);
      const line = view.state.doc.lineAt(at);
      const m = TASK_LINE_RE.exec(line.text);
      if (!m) return false;

      const bracketFrom = line.from + m[1].length;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const onBrackets =
        pos !== null && pos !== undefined && pos >= bracketFrom && pos <= bracketFrom + 3;
      const checkboxLeft = checkboxLeftOf(lineEl, getComputedStyle(lineEl));
      // 方框本身 1em，左右再各留一点热区：只有一根线宽的可点面积等于没有（B314-8 那一族）
      const onBox = event.clientX >= checkboxLeft - 6 && event.clientX <= checkboxLeft + 20;
      if (!onBrackets && !onBox) return false;

      if (handlers.canToggleTask && !handlers.canToggleTask()) return false;
      handlers.onToggleTask(line.number);
      event.preventDefault();
      return true;
    },
  });
}

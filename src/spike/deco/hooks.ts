// 装饰面与宿主的晚绑定钩子（B401 从 wysiwyg.ts 挪出来）。
//
// 装饰扩展活在**标签的 EditorState** 里，比任何一个面板都长寿 ⇒ 回调只能晚绑定。
// 单独一个叶子模块：livePreview / miscWidgets / tableWidget 都要用，
// 而它们都被 wysiwyg 的依赖链拉着 —— 从 wysiwyg 反向 import 会成环。

import type { EditorView } from "@codemirror/view";

export interface DecoHooks {
  /** 用户点中第 `line` 行（**文档行号**，1 起）的方框。宿主写的是这一颗 view 那份文档的那一行。 */
  onToggleTask: (view: EditorView, line: number) => void;
  /** 这一格现在许不许写（只读文档 / 非 Markdown ⇒ false，点了不许有反应，B228 口径）。 */
  canToggleTask: (view: EditorView) => boolean;
  /** 本地链接的落点：宿主把它开进一个标签（B401）。 */
  openLocalFile: (path: string) => void;
}

let hooks: DecoHooks = {
  onToggleTask: () => {},
  canToggleTask: () => true,
  openLocalFile: () => {},
};

/** 组合根（main.ts）注入。 */
export function setDecoHooks(next: DecoHooks): void {
  hooks = next;
}

export function decoHooks(): DecoHooks {
  return hooks;
}

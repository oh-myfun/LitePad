// 移植自 InkNote (MIT, Copyright (c) 2026 likehao19) src/editor.ts:1019-1122（三个回车分支）
//   + 1429-1435（keymap 顺序）
// 本机参照：E:\Project\InkNote\InkNote
//
// B397-4b · 编辑模式的键位。装饰面里「回车」和「方向键」的含义跟源码面不一样：
//
//   · 块级组件是**原子区间**，光标整块跳过 ⇒ 在块的边界按方向键要把焦点交给组件内部
//     （`enterAdjacentBlock`，表格落第一格、代码块落正文）。
//   · 空行回车在源码面天然成立，在装饰面得**先替组件把源码补齐**（``` / `$$` 行尾回车
//     要同时把闭合标记和中间的空行写进去），否则用户只是在一行文本里换行。
//   · `markdownKeymap`（续列表 / 删标记）**不用再装一遍**：`markdown()` 自带的
//     languageSupport 已经 `Prec.high(keymap.of(markdownKeymap))`
//     （@codemirror/lang-markdown dist:424），两档都有它。
//
// ⚠️ 顺序靠 `Prec.highest` 而不是数组位置：整档是 `preview` Compartment 的一发 reconfigure，
// 它在 state 配置里的位置**晚于** `baseExtensions`（editor.ts:174-189）且晚于语言那一格
// ⇒ 同优先级下既输给 base 里的 `defaultKeymap`，也输给 `markdown()` 装的那份
// `markdownKeymap`（Prec.high）。回车那三闸必须抢在「续列表」之前，否则代码围栏行
// 在一个列表项里就只会续出一行 `- `。

import { syntaxTree } from "@codemirror/language";
import { Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { currentBlockRange } from "./blockRange";
import { CODE_FENCE, draftFences, setDraftFences } from "./codeFence";
import { enterAdjacentBlock, focusBlockStartingAt } from "./editableSource";

/** 这些组件的边界上没有可落光标的正文行 ⇒ 空段落得由回车替它造出来。 */
const BOUNDARY_BLOCKS = [
  ".md-codeblock-widget",
  ".md-table-widget",
  ".md-image-widget",
  ".md-mermaid-widget",
  ".md-hr-widget",
  ".md-math-block",
  ".md-metadata-widget",
  ".md-html-widget",
].join(", ");

/** 在 `` ``` `` / `$$` 行尾按回车：补上闭合标记与中间空行，然后把焦点交给组件。 */
function openBlockOnEnter(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;

  const line = state.doc.lineAt(sel.head);
  if (sel.head !== line.to) return false;

  const fence = CODE_FENCE.exec(line.text);
  const math = /^\$\$\s*$/.test(line.text);
  if (!fence && !math) return false;

  // 已经是完整代码块（光标停在被展开的源码里）就别再插一道围栏，直接进组件
  const drafts = state.field(draftFences, false) ?? [];
  if (fence && !drafts.includes(line.from)) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(line.from, 1);
    for (; node; node = node.parent) {
      if (node.name !== "FencedCode") continue;
      if (node.getChildren("CodeMark").length >= 2) {
        focusBlockStartingAt(view, node.from);
        return true;
      }
      break;
    }
  }

  const closing = fence ? fence[1] : "$$";
  const insert = `\n\n${closing}`;
  const blockFrom = line.from;
  const blockTo = line.to + insert.length;

  view.dispatch({
    changes: { from: line.to, insert },
    // 光标先停在块外，随后把焦点交给组件内部的编辑区
    selection: { anchor: blockTo },
    effects: setDraftFences.of(
      drafts
        .filter((from) => from !== blockFrom)
        .map((from) => (from > line.to ? from + insert.length : from)),
    ),
    userEvent: "input.block",
    scrollIntoView: true,
  });
  focusBlockStartingAt(view, blockFrom);
  return true;
}

/** 在任意块组件边界按回车时创建一个真正可输入的空段落。 */
function insertParagraphAtBlockBoundary(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;

  for (const block of Array.from(view.dom.querySelectorAll<HTMLElement>(BOUNDARY_BLOCKS))) {
    const range = currentBlockRange(view, block);
    if (!range) continue;
    if (sel.head === range.from) {
      view.dispatch({
        changes: { from: range.from, insert: "\n" },
        selection: { anchor: range.from },
        userEvent: "input",
        scrollIntoView: true,
      });
      return true;
    }
    if (sel.head === range.to) {
      view.dispatch({
        changes: { from: range.to, insert: "\n" },
        selection: { anchor: range.to + 1 },
        userEvent: "input",
        scrollIntoView: true,
      });
      return true;
    }
  }
  return false;
}

/** 标题行首回车：停在新段落里，而不是插完仍跟着标题、空行立刻被折叠。 */
function insertParagraphBeforeHeading(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const line = view.state.doc.lineAt(sel.head);
  if (sel.head !== line.from || !/^\s{0,3}#{1,6}(?:\s|$)/.test(line.text)) return false;

  view.dispatch({
    changes: { from: line.from, insert: "\n" },
    selection: { anchor: line.from },
    userEvent: "input",
    scrollIntoView: true,
  });
  return true;
}

/**
 * 编辑模式的键位（进 `preview` Compartment，源码面不受影响）。
 *
 * 三闸回车的顺序与 InkNote 一致（开门 → 标题上方 → 组件边界），方向键殿后。
 */
export function decoKeymap(): Extension {
  return Prec.highest(
    keymap.of([
      { key: "Enter", run: openBlockOnEnter },
      { key: "Enter", run: insertParagraphBeforeHeading },
      { key: "Enter", run: insertParagraphAtBlockBoundary },
      // 块级组件是原子区间，光标会整块跳过；在边界上把焦点交给组件内部
      { key: "ArrowDown", run: (v: EditorView) => enterAdjacentBlock(v, true, false) },
      { key: "ArrowUp", run: (v: EditorView) => enterAdjacentBlock(v, false, false) },
      { key: "ArrowRight", run: (v: EditorView) => enterAdjacentBlock(v, true, true) },
      { key: "ArrowLeft", run: (v: EditorView) => enterAdjacentBlock(v, false, true) },
    ]),
  );
}

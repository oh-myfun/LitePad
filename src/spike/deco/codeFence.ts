// 移植自 InkNote (MIT, Copyright (c) 2026 likehao19) src/editor/codeFence.ts:1-50
// 本机参照：E:\Project\InkNote\InkNote
//
// B391 spike · 两道「别让装饰吃掉整篇」的防吞闸。
//
// 1. 未闭合围栏：CommonMark 规定一根没有闭合的 ``` 会一路吞到文档末尾，lezer 也照这个
//    口径出树 —— 于是 `FencedCode` 节点的区间就是「从这一行到整篇结尾」。照原样挂成
//    块级替换，用户看到的是一篇文档只剩一个代码块。
// 2. 输入中的围栏（draftFences）：正在敲的那一行还不该参与解析，否则它会和下文里
//    已有的结束围栏误配对，把中间整段判成代码。处理办法是把这一行整行替换成**等长
//    空格**后离线重 parse —— 等长是为了让所有位置不漂，装饰区间仍然对得上原文。

import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { markdownLanguage } from "@codemirror/lang-markdown";
import type { Tree } from "@lezer/common";

/** 行首 ≤3 空格 + ≥3 个 `` ` `` 或 `~`（4 空格起是缩进代码，不算围栏）。 */
const FENCE_LINE_RE = /^ {0,3}(?:`{3,}|~{3,})/;

export function isUnclosedFenceLine(text: string): boolean {
  return FENCE_LINE_RE.test(text);
}

export const setDraftFences = StateEffect.define<readonly number[]>({
  map: (positions, changes) => positions.map((pos) => changes.mapPos(pos)),
});

/** 输入中的围栏行（按行首位置记账，随文档变更映射）。 */
export const draftFences = StateField.define<readonly number[]>({
  create: () => [],
  update(value, tr) {
    const restored = tr.effects.find((effect) => effect.is(setDraftFences));
    if (restored) return restored.value;
    if (!tr.docChanged) return value;
    const positions = value
      .map((pos) => tr.changes.mapPos(pos, -1))
      .filter((pos) => {
        const line = tr.newDoc.lineAt(pos);
        return line.from === pos && isUnclosedFenceLine(line.text);
      });
    if (!tr.startState.readOnly && tr.isUserEvent("input.type") && tr.newSelection.main.empty) {
      const head = tr.newSelection.main.head;
      const line = tr.newDoc.lineAt(head);
      if (head === line.to && isUnclosedFenceLine(line.text) && !positions.includes(line.from)) {
        const oldPos = tr.changes.invertedDesc.mapPos(line.from);
        let node = previewSyntaxTree(tr.startState).resolveInner(oldPos, 1);
        let inCode = false;
        for (; node.parent; node = node.parent) {
          if (node.name === "FencedCode" || node.name === "CodeBlock") inCode = true;
        }
        if (!inCode) positions.push(line.from);
      }
    }
    return positions;
  },
});

/**
 * 给预览用的语法树：等长空格抹掉输入中的围栏后重 parse。
 *
 * `ensureSyntaxTree(..., 100)` 是另一件要紧事：长文档初始化时 Lezer 可能只同步解析
 * 前半段，直接拿那棵临时树构建装饰，靠后的围栏代码就永久停在源码态。
 */
export function previewSyntaxTree(state: EditorState): Tree {
  const drafts = state.field(draftFences, false) ?? [];
  if (!drafts.length) return ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
  let text = state.doc.toString();
  for (const from of drafts) {
    const line = state.doc.lineAt(from);
    text = text.slice(0, from) + " ".repeat(line.length) + text.slice(line.to);
  }
  return markdownLanguage.parser.parse(text);
}

/**
 * 整段 front matter 的区间（含闭合的 `---` 与其换行）。
 *
 * 判据用「第一行是 `---` 且后面还有一行 `---`」——没有闭合就不算，否则半截
 * `---` 会把整篇文档划成不可装饰区。lezer 会把这段判成 HorizontalRule +
 * SetextHeading（`title: x` 被当成带下划线的标题），所以 buildPreviewSets
 * 必须在进遍历前先把这一段跳掉。
 */
export function frontMatterRange(state: EditorState): { from: number; to: number } | null {
  const doc = state.doc;
  if (doc.lines < 2 || doc.line(1).text.trim() !== "---") return null;
  for (let number = 2; number <= doc.lines; number++) {
    const line = doc.line(number);
    const text = line.text.trim();
    if (text === "---" || text === "...") {
      return { from: 0, to: Math.min(line.to + 1, doc.length) };
    }
  }
  return null;
}

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

/**
 * **一整行恰好是围栏**（InkNote 同名常量，原样搬）：捕获标记与信息串。
 * 与上面那条宽松判据分工不同：draft 记账只问「这行像不像围栏的开头」，
 * 「行尾回车开门」必须拿到闭合标记的原文。
 */
export const CODE_FENCE = /^(`{3,}|~{3,})([^\s`~]*)\s*$/;

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
        // 光标的树一定是解析过的（视口优先）⇒ 问 `syntaxTree` 就够；
        // B398 之前这里用 `previewSyntaxTree`（强制全文 parse）—— 大文件每敲一个围栏字符
        // 都要吃 100ms 的预算，正是「大文件开不了装饰面」的一半原因。
        let node = syntaxTree(tr.startState).resolveInner(oldPos, 1);
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
 * **只解析到 `to`**（缺省整篇，测试与离线场景照旧）：B398 起装饰面传的是
 * 「视口末端 + 前瞻」，预算 20ms —— 大文件不再为了一屏装饰去同步 parse 全篇。
 * 视口之外的部分由 CM6 的 parseWorker 在空闲时推进，推进后装饰面会重建（见 livePreview）。
 *
 * 有 draft 时仍是整篇离线 parse（`parser.parse`）：抹掉那几行才拿得到正确结构，
 * 而 draft 只在「敲完围栏标记、还没按回车」的一瞬存在（keymap 的 `openBlockOnEnter`
 * 会把它换掉）—— 不是稳态成本。
 */
export function previewSyntaxTree(state: EditorState, to = state.doc.length, budget = 100): Tree {
  const drafts = state.field(draftFences, false) ?? [];
  if (!drafts.length) return ensureSyntaxTree(state, to, budget) ?? syntaxTree(state);
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

/**
 * B407 · front matter 的 YAML 正文（去掉首尾围栏行、去掉闭合行后的那个换行）。
 *
 * 块组件拿它做可编辑文本；回写时再包回 `---\n…\n---`。空集（两条围栏贴着）返回空串。
 */
export function frontMatterBody(state: EditorState, range: { from: number; to: number }): string {
  const doc = state.doc;
  const first = doc.lineAt(range.from);
  const last = doc.lineAt(range.to > range.from ? range.to - 1 : range.to);
  if (last.number <= first.number) return "";
  return doc.sliceString(first.to + 1, last.from).replace(/\n$/, "");
}

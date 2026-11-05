// B440 · `==高亮==` 的语法扩展（用户报「高亮语法没有渲染，还是显示源码」的根因）。
//
// 装饰层（previewSets）挂不出来的原因不在它自己：`==…==` 既不在 @lezer/markdown 的 GFM
// 里（GFM = Table / TaskList / Strikethrough / Autolink，`markdownLanguage` 另加
// Subscript / Superscript / Emoji），也不在 CommonMark 里 ⇒ 语法树根本没有这个节点。
// 工具条那颗「高亮」只是把 `==` 写进文档（format.ts 的 `wrapInline`），所以点完仍是源码。
//
// 规则照抄 @lezer/markdown 自己的 Strikethrough（dist:2025-2050）：两枚 `=`、第三枚不许是
// `=`（`===` 留给 Setext 标题下划线），并按「左右是空白还是标点」决定这一枚能不能开/能
// 不能闭 —— 于是 `1 == 2` 这种算式不会被当成高亮（marked / Typora 同一口径）。

import { tags } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";

/** 配对上的两枚 `==` 之间就是 Mark 正文。 */
const MARK_DELIM = { resolve: "Mark", mark: "MarkMark" };

/**
 * 空白/标点闸门要认标点：与 @lezer/markdown 内部那条 `Punctuation` 同一条
 * （`/[\p{S}|\p{P}]/u`，dist:1389-1391）⇒ 中文标点也算。于是 `（==高亮==）`
 * 与 `（**粗体**）` 走的是同一套判定，不额外造一套口径。
 */
const PUNCTUATION = /[\p{S}\p{P}]/u;

export const MARK_SYNTAX: MarkdownConfig = {
  defineNodes: [
    // 正文不借 tags.strikethrough 那类现成样式：装饰面自己挂 `.cm-md-mark`（见 preview.css），
    // 源码档只把两枚 `==` 压成 processingInstruction（与 `**` / `~~` 同一档灰）。
    { name: "Mark", style: { "Mark/...": tags.special(tags.content) } },
    { name: "MarkMark", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "Mark",
      parse(cx, next, pos) {
        if (next !== 61 /* '=' */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) {
          return -1;
        }
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const spaceBefore = /\s|^$/.test(before);
        const spaceAfter = /\s|^$/.test(after);
        const punctBefore = PUNCTUATION.test(before);
        const punctAfter = PUNCTUATION.test(after);
        return cx.addDelimiter(
          MARK_DELIM,
          pos,
          pos + 2,
          !spaceAfter && (!punctAfter || spaceBefore || punctBefore),
          !spaceBefore && (!punctBefore || spaceAfter || punctAfter),
        );
      },
      after: "Emphasis",
    },
  ],
};

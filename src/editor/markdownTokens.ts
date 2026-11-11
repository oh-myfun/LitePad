// Markdown 的标记符在 VS Code 里各有自己的 TextMate scope（引用 `>` / 列表 `-` / 行内代码），
// 而 @lezer/markdown 默认把它们一并压进 processingInstruction —— 一个 tag 只能给一种颜色。
// 这里把要单独取色的几类提成独立 tag；标题标记不需要拆（它本就继承 ATXHeading 的 heading，
// 颜色和字重都对）。
//
// 只在 Markdown 语言档里装（language.ts），其它语言的 processingInstruction 不受影响。
import { styleTags, Tag } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";

/** QuoteMark / ListMark / InlineCode 的独立 tag，色值见 theme.ts 的 HighlightStyle。 */
export const mdQuoteMark = Tag.define("markdown.quoteMark");
export const mdListMark = Tag.define("markdown.listMark");
export const mdInlineCode = Tag.define("markdown.inlineCode");

export const MARKDOWN_TOKENS: MarkdownConfig = {
  props: [
    styleTags({
      QuoteMark: mdQuoteMark,
      ListMark: mdListMark,
      // `/...` 让反引号也吃同一档颜色（VS Code 的 punctuation.definition.raw 落在
      // markup.inline.raw 的父 scope 里）；围栏的 CodeMark 不在此节点下，不受影响。
      "InlineCode/...": mdInlineCode,
    }),
  ],
};

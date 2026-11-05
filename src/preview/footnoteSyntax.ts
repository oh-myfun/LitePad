// B444 · GFM 脚注的语法扩展（装饰面两处渲染异常的根因都在解析层，不在装饰层）。
//
// ① 「脚注引用会出现下划线」：`这里是一个脚注引用[^1]，这里是另一个脚注引用[^bignote]` ——
//    lezer 的 inline Link 解析器把这一整段当成**引用式链接**（`[text][label]`；它按 README
//    明说不校验 label 有没有定义），于是中间那句普通中文被 `tags.link` 染成链接色 + 下划线。
//    装饰层只做到「不给它挂 `.cm-md-link`」（`previewSets` 的 Link 分支 `return false`），
//    压不住语法高亮自己那层 span ⇒ 必须让 `[^label]` 在 Link 之前被吃掉。
// ② 「缩进对齐段落 / 代码块范围异常」：脚注定义的正文按 GFM 是缩进 ≥4 的那几行，
//    CommonMark 没有脚注 ⇒ 四空格起就是缩进代码块，于是「缩进对齐的段落 + 其中的围栏 +
//    后面那段」被合成**一大块** CodeBlock（真机截图里那一坨，范围一路吃到定义体之后）。
//    做成 composite 块：`composite` 把四空格交给行的 base（与 ListItem 同一条走法），
//    缩进代码那条判据（`indent >= baseIndent + 4`）就够不着了，正文按嵌套块继续解析。
//
// 渲染仍归装饰层：定义行折成脚注卡片、行内引用换成编号上标（`previewSets` 那趟文本扫描）。
// 这里只负责「语法树别再把它认成链接 / 缩进代码」。

import { tags } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";

/** 行内引用：`[^label]`（label 不许有 `]` 与换行，与装饰层那趟扫描同一条）。 */
const FN_REF_RE = /^\[\^([^\]\n]+)\]/;

/** 定义行：`[^label]:` 后面跟着的空白算标记的一部分（正文从内容起算）。 */
const FN_DEF_RE = /^\[\^([^\]\n]+)\]:[ \t]*/;

/** GFM：定义体的续行要缩进四空格起。 */
const BODY_INDENT = 4;

export const FOOTNOTE_SYNTAX: MarkdownConfig = {
  defineNodes: [
    {
      name: "FootnoteDefinition",
      block: true,
      /**
       * 续行判据照 ListItem（`markdown.ts` 的 `DefaultSkipMarkup[Type.ListItem]`）：
       * 空行留在定义体里（定义可以有多段），非空行必须缩进够，否则整块到此为止。
       */
      composite(_cx, line, value) {
        if (line.indent < line.baseIndent + value && line.next > -1) return false;
        line.moveBaseColumn(line.baseIndent + value);
        return true;
      },
      style: { "FootnoteDefinition/...": tags.content },
    },
    { name: "FootnoteMarker", style: tags.processingInstruction },
    { name: "FootnoteReference", style: tags.link },
  ],
  parseBlock: [
    {
      name: "FootnoteDefinition",
      // 抢在缩进代码之前：列表项里四空格起的定义行也认（不抢就会被整块判成代码）。
      before: "IndentedCode",
      parse(cx, line) {
        const m = FN_DEF_RE.exec(line.text.slice(line.pos));
        if (!m) return false;
        const markerEnd = line.pos + m[0].length - /[ \t]*$/.exec(m[0])![0].length;
        cx.startComposite("FootnoteDefinition", line.basePos, BODY_INDENT);
        cx.addElement(cx.elt("FootnoteMarker", cx.lineStart + line.pos, cx.lineStart + markerEnd));
        line.moveBase(line.pos + m[0].length);
        return null;
      },
      /**
       * B457 · 两条定义紧挨着时（`docs/zh_CN.md` 的 `[^1]` + `[^bignote]`），第一条那行
       * 正文会起一个段落，而 CommonMark 的「懒惰续行」把下一行同样当作段落内容 ——
       * 第二条定义整行被吞进第一条的 `Paragraph`，于是装饰层只折得出「脚注 1」那张卡片。
       *
       * `composite` 管不到这一层（它只在块已开、行要进 base 时问一句，答 false 也不收段落）：
       * 收段落得靠 `endLeaf` —— 与 lezer 自己给 Table 的那条同一形（`index.js` 里
       * `DefaultEndLeaf` + `Table.endLeaf`），段落在续行前先问「这一行是不是另一条定义」。
       *
       * 缩进那侧不用管：调用点（`parseLeafBlock` 的行循环）本来就只在
       * `indent < baseIndent + 4` 时才问过来 ⇒ 定义体内缩进四格起的 `[^x]:` 仍是正文。
       */
      endLeaf(_cx, line) {
        return FN_DEF_RE.test(line.text.slice(line.pos));
      },
    },
  ],
  parseInline: [
    {
      name: "FootnoteReference",
      // 抢在 Link 之前：`[^1]` 一被吃掉，`[^1]，中间文字[^bignote]` 就拼不成引用式链接。
      before: "Link",
      parse(cx, next, pos) {
        if (next !== 91 /* '[' */) return -1;
        const m = FN_REF_RE.exec(cx.slice(pos, pos + 128));
        if (!m) return -1;
        cx.addElement(cx.elt("FootnoteReference", pos, pos + m[0].length));
        return pos + m[0].length;
      },
    },
  ],
};

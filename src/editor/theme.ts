// 源码编辑区主题（B376）：照 VS Code 默认主题取色，取代原来的 One Dark。
//
// 为什么换：用户点名「复刻 VS Code 的深浅主题颜色，尤其激活标签、编辑区背景（包括预览
// 和源码模式）」。One Dark 的编辑器底色是 #282c34，与 VS Code Dark Modern 的 #1F1F1F
// 差着一档，标签要跟编辑器「融为一体」就只能跟着 One Dark 走 —— 越走越远。
//
// 取色出处（本机 checkout E:\Project\vscode）：
//   · UI / 底色：extensions/theme-defaults/themes/dark_modern.json / light_modern.json
//   · 语法色：   dark_plus.json / light_plus.json（Modern 主题 include 的那两份 tokenColors）
//   · 光标 / 选区 / 行号 / 当前行边框：src/vs/editor/common/core/editorColorRegistry.ts
//
// UI 层全走 CSS 变量（--bg / --fg / --editor-*）：预览与源码共用同一颗底色 token，
// 主题切换时 CM6 只需重配 dark 标志，颜色自己跟着变量走。

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { EditorView } from "@codemirror/view";

/** 编辑器壳层（CM6 自己的 DOM）。颜色全部来自 global.css 的主题 token。 */
function shellStyles(dark: boolean): Extension {
  // `dark` 必须交给 EditorView.theme 的第二个参数：它设置 EditorView.darkTheme facet，
  // CM6 的原生控件与默认样式按这一位走；只把颜色写深、不给 facet 的话，
  // 读 `state.facet(EditorView.darkTheme)` 的地方会一律读到 false（B376 的回归点）。
  return EditorView.theme(
    {
      "&": {
        color: "var(--fg)",
        backgroundColor: "var(--bg)",
      },
      ".cm-content": {
        caretColor: "var(--editor-cursor)",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--editor-cursor)",
      },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        {
          backgroundColor: "var(--editor-selection)",
        },
      // VS Code 的当前行是**一圈 1px 边框**（editor.lineHighlightBorder #282828/#eeeeee），
      // 不是整行底色；边框那条在 global.css 里画（要压过 CM 基础主题的层叠顺序）。
      ".cm-activeLine": {
        backgroundColor: "transparent",
      },
      ".cm-gutters": {
        backgroundColor: "var(--bg)",
        color: "var(--editor-line-number)",
        border: "none",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
        color: "var(--editor-line-number-active)",
      },
      ".cm-foldPlaceholder": {
        backgroundColor: "transparent",
        border: "none",
        color: "var(--fg-muted)",
      },
      ".cm-tooltip": {
        border: "1px solid var(--border)",
        backgroundColor: "var(--bg-elevated)",
      },
      ".cm-tooltip .cm-tooltip-arrow:before": {
        borderTopColor: "transparent",
        borderBottomColor: "transparent",
      },
      ".cm-tooltip .cm-tooltip-arrow:after": {
        borderTopColor: "var(--bg-elevated)",
        borderBottomColor: "var(--bg-elevated)",
      },
      ".cm-tooltip-autocomplete": {
        "& > ul > li[aria-selected]": {
          backgroundColor: "var(--pick-focus-bg)",
          color: "var(--pick-focus-fg)",
        },
      },
    },
    { dark },
  );
}
/** Dark+ 语法色（dark_plus.json + dark_vs.json 的 tokenColors）。 */
const darkHighlight = HighlightStyle.define([
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: "#6a9955",
  },
  { tag: [tags.keyword, tags.operatorKeyword, tags.definitionKeyword], color: "#569cd6" },
  { tag: [tags.controlKeyword, tags.moduleKeyword], color: "#c586c0" },
  { tag: [tags.string, tags.special(tags.string), tags.character], color: "#ce9178" },
  { tag: tags.number, color: "#b5cea8" },
  { tag: [tags.bool, tags.null, tags.atom], color: "#569cd6" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName],
    color: "#dcdcaa",
  },
  { tag: tags.variableName, color: "#9cdcfe" },
  { tag: tags.propertyName, color: "#9cdcfe" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "#4ec9b0" },
  { tag: tags.tagName, color: "#569cd6" },
  { tag: tags.attributeName, color: "#9cdcfe" },
  { tag: tags.operator, color: "#d4d4d4" },
  { tag: [tags.annotation, tags.modifier], color: "#569cd6" },
  { tag: tags.meta, color: "#d4d4d4" },
  { tag: tags.regexp, color: "#d16969" },
  { tag: tags.escape, color: "#d7ba7d" },
  { tag: [tags.link, tags.url], color: "#4daafc", textDecoration: "underline" },
  { tag: tags.heading, color: "#569cd6", fontWeight: "bold" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.inserted, color: "#b5cea8" },
  { tag: tags.deleted, color: "#ce9178" },
  { tag: tags.changed, color: "#569cd6" },
  { tag: tags.invalid, color: "#f44747" },
]);

/** Light+ 语法色（light_plus.json + light_vs.json 的 tokenColors）。 */
const lightHighlight = HighlightStyle.define([
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: "#008000",
  },
  { tag: [tags.keyword, tags.operatorKeyword, tags.definitionKeyword], color: "#0000ff" },
  { tag: [tags.controlKeyword, tags.moduleKeyword], color: "#af00db" },
  { tag: [tags.string, tags.special(tags.string), tags.character], color: "#a31515" },
  { tag: tags.number, color: "#098658" },
  { tag: [tags.bool, tags.null, tags.atom], color: "#0000ff" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName],
    color: "#795e26",
  },
  { tag: tags.variableName, color: "#001080" },
  { tag: tags.propertyName, color: "#001080" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "#267f99" },
  { tag: tags.tagName, color: "#800000" },
  { tag: tags.attributeName, color: "#e50000" },
  { tag: tags.operator, color: "#000000" },
  { tag: [tags.annotation, tags.modifier], color: "#0000ff" },
  { tag: tags.meta, color: "#000000" },
  { tag: tags.regexp, color: "#811f3f" },
  { tag: tags.escape, color: "#ee0000" },
  { tag: [tags.link, tags.url], color: "#005fb8", textDecoration: "underline" },
  { tag: tags.heading, color: "#800000", fontWeight: "bold" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.inserted, color: "#098658" },
  { tag: tags.deleted, color: "#a31515" },
  { tag: tags.changed, color: "#0451a5" },
  { tag: tags.invalid, color: "#cd3131" },
]);

/** 一组主题扩展：壳层 + 对应深浅的语法配色（与 oneDark 同为 Compartment 里的一整份）。 */
export function vscodeEditorTheme(dark: boolean): Extension {
  return [shellStyles(dark), syntaxHighlighting(dark ? darkHighlight : lightHighlight)];
}

// 源码编辑区主题（B376 照 VS Code 默认主题取色；B377 扩到 5 个主题族）。
//
// 用户先后要求：①复刻 VS Code 深浅主题的颜色（尤其激活标签、编辑区背景）；
// ②再补一套 2026 配色并设为默认，尽量把 VS Code 自带的几套默认主题都搬过来。
// 现在 `theme_family` 决定编辑区语法色，`theme` 决定明暗，两者正交：
//   2026 / modern / plus / classic / hc × dark / light = 10 个变体。
//
// 语法色表在 `src/theme/syntax.ts`（预览里的 Shiki 代码块共用同一份）；
// 本文件只管 CM6 壳层与把色表翻成 HighlightStyle。
// UI 层全走 CSS 变量（--bg / --editor-fg / --editor-* 等）：预览与源码共用同一颗
// 底色 token，主题切换时 CM6 只需重配 dark 标志与语法色，颜色自己跟着变量走。

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { syntaxPalette, type SyntaxPalette } from "../theme/syntax";
import type { ThemeFamily } from "../theme/theme";

/** 编辑器壳层（CM6 自己的 DOM）。颜色全部来自 global.css 的主题 token。 */
function shellStyles(dark: boolean): Extension {
  // `dark` 必须交给 EditorView.theme 的第二个参数：它设置 EditorView.darkTheme facet，
  // CM6 的原生控件与默认样式按这一位走；只把颜色写深、不给 facet 的话，
  // 读 `state.facet(EditorView.darkTheme)` 的地方会一律读到 false（B376 的回归点）。
  return EditorView.theme(
    {
      "&": {
        // B379：编辑区正文取 `editor.foreground`（--editor-fg），与预览同一颗；
        // 全应用正文色 --fg 属于 workbench，Plus 浅色里两档并不同值。
        color: "var(--editor-fg)",
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
      // B380：当前行 = lineHighlightBackground（多数主题透明）+
      // lineHighlightBorder 的一圈 1px 边框；边框那条在 global.css 里画
      // （要压过 CM 基础主题的层叠顺序），这里只把底色也接上 token。
      ".cm-activeLine": {
        backgroundColor: "var(--editor-line-highlight-bg)",
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

function styleOf(p: SyntaxPalette): HighlightStyle {
  return HighlightStyle.define([
    {
      tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
      color: p.comment,
    },
    { tag: [tags.keyword, tags.operatorKeyword, tags.definitionKeyword], color: p.keyword },
    { tag: [tags.controlKeyword, tags.moduleKeyword], color: p.control },
    { tag: [tags.string, tags.special(tags.string), tags.character], color: p.string },
    { tag: tags.number, color: p.number },
    { tag: [tags.bool, tags.null], color: p.languageConst },
    { tag: tags.atom, color: p.atom },
    {
      tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName],
      color: p.function,
    },
    { tag: tags.variableName, color: p.variable },
    { tag: tags.propertyName, color: p.property },
    { tag: [tags.typeName, tags.className, tags.namespace], color: p.type },
    { tag: tags.tagName, color: p.tag },
    { tag: tags.attributeName, color: p.attribute },
    { tag: tags.operator, color: p.operator },
    { tag: [tags.annotation, tags.modifier], color: p.modifier },
    { tag: tags.meta, color: p.strong },
    { tag: tags.regexp, color: p.regexp },
    { tag: tags.escape, color: p.escape },
    { tag: [tags.link, tags.url], color: p.link, textDecoration: "underline" },
    { tag: tags.heading, color: p.heading, fontWeight: "bold" },
    { tag: tags.strong, color: p.strong, fontWeight: "bold" },
    { tag: tags.emphasis, color: p.emphasis, fontStyle: "italic" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    { tag: tags.inserted, color: p.inserted },
    { tag: tags.deleted, color: p.deleted },
    { tag: tags.changed, color: p.changed },
    { tag: tags.invalid, color: p.invalid },
  ]);
}

const STYLES: Record<ThemeFamily, { dark: HighlightStyle; light: HighlightStyle }> = {
  "2026": {
    dark: styleOf(syntaxPalette("2026", true)),
    light: styleOf(syntaxPalette("2026", false)),
  },
  modern: {
    dark: styleOf(syntaxPalette("modern", true)),
    light: styleOf(syntaxPalette("modern", false)),
  },
  plus: {
    dark: styleOf(syntaxPalette("plus", true)),
    light: styleOf(syntaxPalette("plus", false)),
  },
  classic: {
    dark: styleOf(syntaxPalette("classic", true)),
    light: styleOf(syntaxPalette("classic", false)),
  },
  hc: { dark: styleOf(syntaxPalette("hc", true)), light: styleOf(syntaxPalette("hc", false)) },
};

// HC 的 selectionForeground（hc_black #000000 / hc_light #FFFFFF）必须压过语法色。
// 背景是选择层（在文字下面），改不了文字颜色 ⇒ 只能给选中的每一段挂一个 mark 装饰，
// 由 global.css 的 `.cm-hc-selection, .cm-hc-selection *` 统一换色（含后代 token span）。
const hcSelectionMark = Decoration.mark({ class: "cm-hc-selection" });

function hcSelectionSet(view: EditorView): DecorationSet {
  const ranges = view.state.selection.ranges
    .filter((r) => r.from < r.to)
    .map((r) => hcSelectionMark.range(r.from, r.to));
  return Decoration.set(ranges, true);
}

const hcSelectionForeground = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = hcSelectionSet(view);
    }
    update(u: ViewUpdate) {
      if (u.selectionSet || u.docChanged || u.viewportChanged) {
        this.decorations = hcSelectionSet(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** 一组主题扩展：壳层 + 对应主题族/明暗的语法配色（Compartment 里的一整份）。 */
export function vscodeEditorTheme(dark: boolean, family: ThemeFamily = "2026"): Extension {
  return [
    shellStyles(dark),
    syntaxHighlighting(STYLES[family][dark ? "dark" : "light"]),
    // 只有 HC 档有 selectionForeground；切到别的族时随 Compartment 重配自动撤掉。
    ...(family === "hc" ? [hcSelectionForeground] : []),
  ];
}

// 预览代码块的 Shiki 主题（B377）。
//
// 为什么不全用 Shiki 自带主题：它只随包提供了 dark-plus / light-plus
// （VS Code 的 Dark+ / Light+），而用户要的 2026 / 经典 / 高对比度都没有。
// 这里用 `src/theme/syntax.ts` 的同一份色表**现场拼** ThemeRegistration，
// 源码编辑区与预览代码块因此永远同色；Modern / Plus 直接用包里那两颗原版主题。
import type { ThemeRegistration, ThemeRegistrationAny } from "shiki";
import { syntaxPalette, type SyntaxPalette } from "../theme/syntax";
import type { ThemeFamily } from "../theme/theme";

/** 预览代码块的默认底色：VS Code 的 textCodeBlock.background（与 global.css 的 --code-bg 同档）。 */
const CODE_BG: Record<ThemeFamily, { dark: string; light: string }> = {
  "2026": { dark: "#242526", light: "#eaeaea" },
  modern: { dark: "#2b2b2b", light: "#f8f8f8" },
  plus: { dark: "#252526", light: "#f3f3f3" },
  classic: { dark: "#252526", light: "#f3f3f3" },
  hc: { dark: "#000000", light: "#ffffff" },
};

function registration(
  name: string,
  dark: boolean,
  p: SyntaxPalette,
  bg: string,
): ThemeRegistration {
  return {
    name,
    type: dark ? "dark" : "light",
    fg: p.strong,
    bg,
    settings: [
      { settings: { foreground: p.strong, background: bg } },
      {
        scope: ["comment", "punctuation.definition.comment", "string.comment"],
        settings: { foreground: p.comment },
      },
      { scope: ["keyword", "storage", "storage.type"], settings: { foreground: p.keyword } },
      {
        scope: ["keyword.control", "keyword.control.import", "keyword.other.unit"],
        settings: { foreground: p.control },
      },
      {
        scope: ["string", "string.quoted", "string.template", "string.interpolated"],
        settings: { foreground: p.string },
      },
      { scope: ["constant.numeric"], settings: { foreground: p.number } },
      {
        scope: ["constant.language", "constant.language.boolean", "constant.language.null"],
        settings: { foreground: p.languageConst },
      },
      {
        scope: [
          "constant",
          "variable.other.constant",
          "variable.other.enummember",
          "variable.language",
        ],
        settings: { foreground: p.atom },
      },
      {
        scope: [
          "entity.name.function",
          "support.function",
          "meta.function-call entity.name.function",
        ],
        settings: { foreground: p.function },
      },
      {
        scope: ["variable", "meta.definition.variable.name", "support.variable"],
        settings: { foreground: p.variable },
      },
      {
        scope: ["variable.other.property", "meta.object-literal.key", "support.type.property-name"],
        settings: { foreground: p.property },
      },
      {
        scope: [
          "entity.name.type",
          "entity.name.class",
          "entity.name.namespace",
          "support.class",
          "support.type",
        ],
        settings: { foreground: p.type },
      },
      { scope: ["entity.name.tag", "support.class.component"], settings: { foreground: p.tag } },
      { scope: ["entity.other.attribute-name"], settings: { foreground: p.attribute } },
      { scope: ["keyword.operator"], settings: { foreground: p.operator } },
      { scope: ["storage.modifier"], settings: { foreground: p.modifier } },
      { scope: ["string.regexp"], settings: { foreground: p.regexp } },
      { scope: ["constant.character.escape"], settings: { foreground: p.escape } },
      { scope: ["markup.heading"], settings: { foreground: p.heading, fontStyle: "bold" } },
      { scope: ["markup.bold"], settings: { foreground: p.strong, fontStyle: "bold" } },
      { scope: ["markup.italic"], settings: { foreground: p.emphasis, fontStyle: "italic" } },
      { scope: ["markup.inserted"], settings: { foreground: p.inserted } },
      { scope: ["markup.deleted"], settings: { foreground: p.deleted } },
      { scope: ["markup.changed"], settings: { foreground: p.changed } },
      {
        scope: ["markup.underline.link"],
        settings: { foreground: p.link, fontStyle: "underline" },
      },
      { scope: ["invalid", "invalid.illegal"], settings: { foreground: p.invalid } },
    ],
  };
}

const custom = new Map<string, ThemeRegistration>();

function customTheme(family: ThemeFamily, dark: boolean): ThemeRegistration {
  const key = `${family}-${dark ? "dark" : "light"}`;
  let t = custom.get(key);
  if (!t) {
    t = registration(
      `litepad-${key}`,
      dark,
      syntaxPalette(family, dark),
      CODE_BG[family][dark ? "dark" : "light"],
    );
    custom.set(key, t);
  }
  return t;
}

/** 当前主题族 / 明暗对应的 Shiki 主题。Modern 与 Plus 用包里原版 Dark+ / Light+。 */
export function shikiThemeFor(
  family: ThemeFamily,
  dark: boolean,
): ThemeRegistrationAny | "dark-plus" | "light-plus" {
  if (family === "modern" || family === "plus") return dark ? "dark-plus" : "light-plus";
  return customTheme(family, dark);
}

// B458 · 未保存改动标注的样式契约（源码模式行号右侧那 4px）。
//
// 判据按「用户会看到什么」写：
//   · 那一列宽 4px，落在折叠箭头原先的 5px 留白里 ⇒ 箭头到正文的间距一毫不变，
//     存不存盘正文都不会左右跳一格；
//   · 三色 = 竖条（4×8px 那道缝），形状不改成箭头（用户 2026-11-04 定稿）；
//   · **明暗同一套色**（用户：「浅色颜色和深色保持一致」）⇒ 三颗只在一颗主题无关的 `:root`
//     里定义一次，明暗基座表与五个族都不许再覆盖它们；橙/红也不再借用 `--warn` / `--danger`
//     （浅色的 `--warn` 是橄榄绿 #667309，借过来两档就不可能一致）；
//   · 红那颗在原来那颗警示红的基础上**加深**（用户：「删除的红色颜色统一加深一下」）⇒
//     判据量相对亮度，不许悄悄退回更浅的那颗。
//
// 解析按「变体最终拿到什么值」判，而不是「块里有没有这行」：族覆盖被删掉时会落回 `:root`
// ⇒ 期望表对不上 ⇒ 红。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ruleBlock, stripCssComments, themeBlock } from "./static";

const css = () => readFileSync("src/styles/global.css", "utf-8");

/** 块体里某颗变量的**最后一个**声明值（CSS 同元素上后写的规则顶掉前面的）。 */
function lastDecl(block: string, name: string): string {
  const code = stripCssComments(block);
  const hits = [...code.matchAll(new RegExp(`${name}\\s*:\\s*([^;]+);`, "g"))];
  return hits.length ? hits[hits.length - 1][1].trim() : "";
}

/** 族覆盖块：选择器同时带 `[data-theme]` 与 `[data-theme-family]`（classic 有两块，拼起来看）。 */
function familyBlock(src: string, mode: string, family: string): string {
  const re = new RegExp(
    `[^{}]*\\[data-theme="${mode}"\\]\\[data-theme-family="${family}"\\][^{}]*\\{([^}]*)\\}`,
    "g",
  );
  return [...stripCssComments(src).matchAll(re)].map((m) => m[1]).join("\n");
}

const FAMILIES = ["2026", "modern", "plus", "classic", "hc"] as const;

describe("B458 · 标注列的几何", () => {
  it("列宽 4px，且允许越过行格画那道跨接缝的缝", () => {
    const col = ruleBlock(css(), ".cm-diffGutter", "min-width");
    expect(col).toContain("min-width: 4px");
    expect(col, "CM6 给每列的 overflow: hidden 不关掉，缝的上半截会被裁掉").toContain(
      "overflow: visible",
    );
  });

  it("折叠槽把 5px 留白让成 1px（箭头到正文的总间距不变：1px + 4px）", () => {
    const fold = ruleBlock(css(), ".panel-host .cm-editor .cm-foldGutter .cm-gutterElement");
    expect(fold).toContain("padding-right: 1px");
  });

  it("橙与绿铺满自己那一行（背景走 diff 那三颗，不借用警示色）", () => {
    expect(ruleBlock(css(), ".cm-diff-add")).toContain("background: var(--diff-add)");
    expect(ruleBlock(css(), ".cm-diff-mod"), "橙不许再吃 --warn（浅色那颗是橄榄绿）").toContain(
      "background: var(--diff-mod)",
    );
  });

  it("红属于被删块后面那一行的上边缘：8px 高、跨出 4px、压在橙/绿之上", () => {
    const seam = ruleBlock(
      css(),
      ".panel-host .cm-editor .cm-diffGutter .cm-gutterElement.cm-diff-del-top::after, " +
        ".panel-host .cm-editor .cm-diffGutter .cm-gutterElement.cm-diff-del-bottom::after",
      "background",
    );
    expect(seam, "红也走 token").toContain("background: var(--diff-del)");
    expect(seam).toContain("width: 4px");
    expect(seam).toContain("height: 8px");
    expect(seam, "让位：橙让掉最后 4px、绿让掉最前 4px，那道缝归红独占").toContain("z-index: 3");
    // 上沿缝与下沿缝各只偏移 4px（文档末尾的删除才用下沿那颗）。
    // ⚠️ 带 filter 取规则：列表规则的最后一个成员紧跟着 `{`，`::after` 字面量会先撞上它。
    expect(ruleBlock(css(), ".cm-diff-del-top::after", "top: -4px")).toContain("top: -4px");
    expect(ruleBlock(css(), ".cm-diff-del-bottom::after", "bottom: -4px")).toContain(
      "bottom: -4px",
    );
  });
});

// ---------------------------------------------------------------- 三色：明暗同一套

/** 三颗的定稿值（用户 2026-11-04：明暗一致 + 红加深）。 */
const TRIO: Record<string, string> = {
  "--diff-add": "#72c892",
  "--diff-mod": "#e5ba7d",
  "--diff-del": "#e5534b",
};

/** 某变体最终生效的那颗：族覆盖 → 明暗基座 → 主题无关的 `:root`（特异度从低到高）。 */
function resolve(name: string, mode: "dark" | "light", family: string): string {
  const src = css();
  const layers = [
    ruleBlock(src, ":root", name),
    themeBlock(src, mode),
    family === "2026" ? "" : familyBlock(src, mode, family),
  ];
  for (let i = layers.length - 1; i >= 1; i--) {
    const v = lastDecl(layers[i], name);
    if (v) return v;
  }
  return lastDecl(layers[0], name);
}

/** sRGB 相对亮度（0–1）：判「加深」用，不看字符串像不像。 */
function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe("B458 · 三色明暗同一套，只定义一次", () => {
  for (const name of Object.keys(TRIO)) {
    it(`${name} 十个变体都解析到同一颗（明暗一致）`, () => {
      for (const mode of ["dark", "light"] as const) {
        for (const family of FAMILIES) {
          expect(resolve(name, mode, family), `${mode}/${family} 的 ${name}`).toBe(TRIO[name]);
        }
      }
    });
  }

  it("三颗定义在主题无关的 :root 里（写进明暗任一张基座表就必然两档不一致）", () => {
    const src = css();
    for (const mode of ["dark", "light"] as const) {
      for (const name of Object.keys(TRIO)) {
        expect(themeBlock(src, mode), `${mode} 基座表不该再定义 ${name}`).not.toContain(name);
        for (const family of FAMILIES) {
          expect(
            familyBlock(src, mode, family),
            `${mode}/${family} 不该覆盖 ${name}`,
          ).not.toContain(name);
        }
      }
    }
  });

  it("红那颗比原先借用的警示红更深（「统一加深一下」不许悄悄退回去）", () => {
    expect(luminance(TRIO["--diff-del"]), "--diff-del 得比深色档的 --danger 更深").toBeLessThan(
      luminance("#f48771"),
    );
  });

  it("橙与红不再借用全应用的 --warn / --danger（改了会带动别的界面）", () => {
    const src = css();
    const mod = ruleBlock(src, ".cm-diff-mod", "background");
    const del = ruleBlock(
      src,
      ".cm-diffGutter .cm-gutterElement.cm-diff-del-top::after",
      "background",
    );
    expect(mod).not.toContain("var(--warn)");
    expect(del).not.toContain("var(--danger)");
  });
});

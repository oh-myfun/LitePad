// B319-A1 预览垂直节奏：块间间距声明在「岛与岛之间」，不再靠子元素 margin 穿墙。
// jsdom 不做布局、算不出 margin 与 rect，所以这里只管 CSS 的**形状**；像素由
// .tmp/typo-check/index.html 的真浏览器探针验收。
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** 归一化空白后再匹配：prettier 会把长选择器折行、给选择器列表补空格。 */
const css = readFileSync("src/styles/preview.css", "utf-8").replace(/\s+/g, " ");

/** 把 CSS 拆成 [选择器, 声明体]，用于「哪条规则里出现了什么」的判断。 */
function rules(): Array<{ sel: string; body: string }> {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sel: m[1].trim(),
    body: m[2].trim(),
  }));
}

function hasRule(pattern: RegExp): boolean {
  return pattern.test(css);
}

/** 找一条规则：选择器要含 selMust 的每一段、声明体要含 bodyMust。 */
function rule(selMust: string[], bodyMust: string): string | undefined {
  return rules()
    .find((r) => selMust.every((s) => r.sel.includes(s)) && r.body.includes(bodyMust))
    ?.sel.replace(/\.md-preview /g, "");
}

describe("预览垂直节奏（B319-A1）", () => {
  it("岛与岛之间有默认节奏，兜底值写在用处", () => {
    expect(
      hasRule(
        /\.md-preview \.md-block \+ \.md-block\s*\{[^}]*margin-top:\s*var\(--md-flow,\s*0\.7em\)/,
      ),
    ).toBe(true);
  });

  it("标题下方收紧，且主语带上 + .md-block 才压得住默认那条", () => {
    expect(rule([":has(> :is(h1, h2, h3)) + .md-block"], "var(--md-after-head, 0.8em)")).toContain(
      "+ .md-block",
    );
  });

  it("标题上方加大，且主语同样带上 + .md-block", () => {
    expect(
      rule(
        [".md-block + .md-block:has(> :is(h1, h2, h3, h4, h5, h6))"],
        "var(--md-head-flow, 1.6em)",
      ),
    ).toContain(".md-block + .md-block:has");
  });

  it("具体度相同的两条特例排在通用那条之后 —— 否则标题间距会被 0.7em 盖掉", () => {
    const generic = css.indexOf(".md-preview .md-block + .md-block {");
    const headFlow = css.search(/\.md-block \+ \.md-block:has\(/);
    expect(generic).toBeGreaterThanOrEqual(0);
    expect(headFlow).toBeGreaterThan(generic);
  });

  it("列表首末项的上下 margin 清零（堵住从 ul 穿出岛壳的那 4px）", () => {
    expect(hasRule(/\.md-preview li:first-child\s*\{[^}]*margin-top:\s*0\b/)).toBe(true);
    expect(hasRule(/\.md-preview li:last-child\s*\{[^}]*margin-bottom:\s*0\b/)).toBe(true);
  });

  it("岛壳不许改用 flow-root（它会把 li 的 margin 吞进壳里，壳高就不再等于内容高）", () => {
    for (const r of rules()) {
      if (r.sel.includes(".md-block")) {
        expect(r.body, `规则 ${r.sel} 里出现了 flow-root`).not.toContain("flow-root");
      }
    }
  });

  it("三个节奏变量只以 var() 兜底出现，不在任何选择器上声明（B238 遮蔽陷阱）", () => {
    expect(css).not.toMatch(/(?:^|[;{\s])--md-flow\s*:/);
    expect(css).not.toMatch(/(?:^|[;{\s])--md-head-flow\s*:/);
    expect(css).not.toMatch(/(?:^|[;{\s])--md-after-head\s*:/);
  });

  // Review Focus #5：导出 HTML 与 PDF 打印里没有 .md-block 岛壳，间距全靠下面这两条。
  it("子元素自己的 margin 不许被删（导出与 PDF 没有岛壳，靠的就是它们）", () => {
    expect(hasRule(/\.md-preview p\s*\{[^}]*margin:\s*10px 0/)).toBe(true);
    expect(hasRule(/\.md-preview h1,[^{}]*\.md-preview h6\s*\{[^}]*margin:\s*24px 0 12px/)).toBe(
      true,
    );
  });
});

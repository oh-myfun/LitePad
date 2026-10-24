// B319-A1 预览垂直节奏：块间间距声明在「岛与岛之间」，不再靠子元素 margin 穿墙。
// jsdom 不做布局、算不出 margin 与 rect，所以这里只管 CSS 的**形状**；像素由
// .tmp/typo-check/index.html 的真浏览器探针验收。
//
// B352-11（评审 I4）换了一口径：三个档位此前只以 `var(--md-flow, 0.7em)` 的**兜底值**存在，
// 全仓没有一处声明 ⇒ 即时渲染（IR）的岛间节奏住在 global.css，要复用同一个观感档位就只能
// 把 0.7/0.8/1.6em 再抄一遍 —— 正是「两处各写一份必然漂移」。现在它们声明在两边都挂着的
// `.md-rendered` 上，使用处只写 `var(--token)`。
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { stripCssComments } from "./static";

/** 归一化空白后再匹配：prettier 会把长选择器折行、给选择器列表补空格。注释先抹掉，
    否则注释里的散文会喂出假命中。 */
const css = stripCssComments(readFileSync("src/styles/preview.css", "utf-8")).replace(/\s+/g, " ");

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
    ?.sel.replace(/\.md-rendered /g, "");
}

/** 数一个自定义属性的**声明**次数（前一个非空白字符是 `{` / `;` / 串首）。
    走扫描而不是 `new RegExp(`[;{\s]`)`：模板字面量里的 `\s` 是恒等转义 ⇒ 字符类退化成
    `[;{s]`，三条 token 全数漏计，判据自己假红。 */
function declCount(text: string, token: string): number {
  let n = 0;
  let at = 0;
  for (;;) {
    const i = text.indexOf(`${token}:`, at);
    if (i < 0) return n;
    let j = i - 1;
    while (text[j] === " ") j--;
    if (j < 0 || text[j] === "{" || text[j] === ";") n++;
    at = i + 1;
  }
}

describe("预览垂直节奏（B319-A1）", () => {
  it("岛与岛之间有默认节奏，取值走声明在 `.md-rendered` 上的 token", () => {
    expect(
      hasRule(/\.md-rendered \.md-block \+ \.md-block\s*\{[^}]*margin-top:\s*var\(--md-flow\)/),
    ).toBe(true);
  });

  it("标题下方收紧，且主语带上 + .md-block 才压得住默认那条", () => {
    expect(rule([":has(> :is(h1, h2, h3)) + .md-block"], "var(--md-after-head)")).toContain(
      "+ .md-block",
    );
  });

  it("标题上方加大，且主语同样带上 + .md-block", () => {
    expect(
      rule([".md-block + .md-block:has(> :is(h1, h2, h3, h4, h5, h6))"], "var(--md-head-flow)"),
    ).toContain(".md-block + .md-block:has");
  });

  it("具体度相同的两条特例排在通用那条之后 —— 否则标题间距会被 0.7em 盖掉", () => {
    const generic = css.indexOf(".md-rendered .md-block + .md-block {");
    const headFlow = css.search(/\.md-block \+ \.md-block:has\(/);
    expect(generic).toBeGreaterThanOrEqual(0);
    expect(headFlow).toBeGreaterThan(generic);
  });

  it("列表首末项的上下 margin 清零（堵住从 ul 穿出岛壳的那 4px）", () => {
    expect(hasRule(/\.md-rendered li:first-child\s*\{[^}]*margin-top:\s*0\b/)).toBe(true);
    expect(hasRule(/\.md-rendered li:last-child\s*\{[^}]*margin-bottom:\s*0\b/)).toBe(true);
  });

  it("岛壳不许改用 flow-root（它会把 li 的 margin 吞进壳里，壳高就不再等于内容高）", () => {
    for (const r of rules()) {
      if (r.sel.includes(".md-block")) {
        expect(r.body, `规则 ${r.sel} 里出现了 flow-root`).not.toContain("flow-root");
      }
    }
  });

  it("三个档位各自**只声明一次**，且声明在预览与 IR 都挂着的 `.md-rendered` 上（I4）", () => {
    for (const t of ["--md-flow", "--md-after-head", "--md-head-flow"]) {
      expect(declCount(css, t), `${t} 的声明次数`).toBe(1);
    }
    expect(css).toMatch(
      /\.md-rendered \{[^}]*--md-flow: 0\.7em[^}]*--md-after-head: 0\.8em[^}]*--md-head-flow: 1\.6em/,
    );
  });

  it("使用处不再自带兜底值 —— 同一个档位抄两遍，改一处漏一处（I4 的根因）", () => {
    expect(css, "不许再出现 var(--md-flow, 0.7em) 这种带兜底的写法").not.toMatch(
      /var\(--md-(?:flow|after-head|head-flow)\s*,/,
    );
  });

  // Review Focus #5：导出 HTML 与 PDF 打印里没有 .md-block 岛壳，间距全靠下面这两条。
  it("子元素自己的 margin 不许被删（导出与 PDF 没有岛壳，靠的就是它们）", () => {
    expect(hasRule(/\.md-rendered p\s*\{[^}]*margin:\s*10px 0/)).toBe(true);
    expect(hasRule(/\.md-rendered h1,[^{}]*\.md-rendered h6\s*\{[^}]*margin:\s*24px 0 12px/)).toBe(
      true,
    );
  });
});

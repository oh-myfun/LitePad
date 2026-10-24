// B352-1 排版层分离：markdown 的排版规则与 `--md-*` token 挂到共用类 `.md-rendered` 上，
// `.md-preview` 退化成**容器**（overflow / padding / 背景）。
//
// 为什么要拆开：即时渲染（IR）把每个块的 HTML 装进 CodeMirror 的块 widget 里，那个 DOM
// 不在 `.md-preview` 容器下 —— 借不到前缀就没有排版。两处各写一份 markdown 样式是
// 「日后必然漂移」的那条反目标，所以这里只搬选择器前缀，并把「容器类不许再带 token」
// 钉成守卫：谁将来把规则写回 `.md-preview `，这条判据就红。
//
// 像素与字阶的既有判据在 tests/preview-rhythm.test.ts 与 tests/settingsdialog.test.ts，
// 它们跟着前缀一起搬到 `.md-rendered`（声明值一条没动）。
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { stripCssComments, stripLineComments } from "./static";

const css = stripCssComments(readFileSync("src/styles/preview.css", "utf-8"));

describe("B352-1 排版规则从容器里剥出来（.md-rendered）", () => {
  it("`.md-preview` 不再当排版前缀用", () => {
    expect(css, "preview.css 里 .md-preview 不得再作祖先前缀").not.toMatch(/\.md-preview\s+\./);
  });

  it("排版规则挂在 `.md-rendered` 上", () => {
    expect(css, "岛壳规则改挂共用类").toMatch(/\.md-rendered\s+\.md-block\s*\{/);
    expect(css, "标题规则改挂共用类").toMatch(/\.md-rendered\s+h1/);
  });

  it("`--md-*` token 定义唯一，且不在容器类上", () => {
    const defs = (css.match(/--md-fg:/g) ?? []).length;
    expect(defs, "token 只该有亮/暗两份定义").toBe(2);
    expect(css, "容器类不得再带 token").not.toMatch(/\.md-preview\s*\{[^}]*--md-fg:/);
    expect(css, "暗色覆盖跟着搬到 .md-rendered").toMatch(
      /:root\[data-theme="dark"\]\s+\.md-rendered/,
    );
  });

  it("容器职责没在搬家路上弄丢", () => {
    expect(css, "预览容器仍然自己滚").toMatch(/\.md-preview\s*\{[^}]*overflow-y:\s*auto/);
    expect(css, "预览容器仍然留正文内边距").toMatch(/\.md-preview\s*\{[^}]*padding:/);
  });

  it("既有类名的规则一条都没被顺手删掉", () => {
    for (const cls of ["md-block", "md-task", "md-mermaid", "md-preview-notice"]) {
      expect(css, `.${cls} 的规则还在`).toContain(`.${cls}`);
    }
  });

  it("三个渲染根节点都带上共用类", () => {
    const preview = stripLineComments(readFileSync("src/markdown/preview.ts", "utf-8"));
    expect(preview, "预览根节点 = 容器类 + 共用排版类").toMatch(
      /className\s*=\s*"md-preview md-rendered"/,
    );
    const exporter = readFileSync("src/markdown/exporter.ts", "utf-8");
    expect(exporter, "打印导出的 article 也带共用排版类").toMatch(
      /className\s*=\s*"md-preview md-rendered"/,
    );
    // ⚠️ 导出件只注入 preview.css，:root 不在里面 —— 模板漏了这个类，导出的 HTML 整篇没排版
    expect(exporter, "导出 HTML 模板的 <article> 带共用排版类").toMatch(
      /class="md-preview md-rendered md-export-body"/,
    );
  });
});

describe("B352-6 IR 标识的样式（焦点块左边条 + 块 widget 容器）", () => {
  const g = stripCssComments(readFileSync("src/styles/global.css", "utf-8"));

  it("焦点行标识条存在，且颜色走 token（不写死）", () => {
    const rule = g.match(/\.cm-line\.md-ir-focus-line\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule, "Task 6 发的类名要在样式里有规则").toBeTruthy();
    expect(rule).toMatch(/var\(--accent/);
    expect(rule, "不许写死颜色").not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("块 widget 容器不带垂直 margin（CM6：块级装饰带 margin 会抖行高估计）", () => {
    const rule = g.match(/\.md-ir-block\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule, "要有 .md-ir-block 规则").toBeTruthy();
    expect(rule).toMatch(/margin:\s*0/);
    expect(rule, "不许出现非零的 margin-top/bottom").not.toMatch(/margin-(top|bottom):\s*(?!0)/);
  });
});

describe("B352-11 评审 I4：IR 的岛间节奏与预览同档位", () => {
  const g = stripCssComments(readFileSync("src/styles/global.css", "utf-8")).replace(/\s+/g, " ");

  /** 通用那一档。命名出来是为了下面能用**同一把尺**量一份退化替身。 */
  const flowRule = /\.md-ir-block \+ \.md-ir-block\s*\{[^}]*padding-top:\s*var\(--md-flow\)/;

  /** 按「选择器含哪段 + 声明体含哪档」找规则：三条选择器都含 `.md-ir-block`，
      只有第二个选择器和取值能把它们分开。 */
  const grules = () =>
    [...g.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2].trim() }));

  function grule(selMust: string, bodyMust: string): string {
    const hit = grules().find((r) => r.sel.includes(selMust) && r.body.includes(bodyMust));
    return hit?.sel ?? "";
  }

  it("三档节奏各有一条 padding-top，取值走 token 不带兜底", () => {
    expect(g).toMatch(flowRule);
    expect(
      grule("+ .md-ir-block:not(", "padding-top: var(--md-after-head)"),
      "标题下方收紧那一档",
    ).toContain(":has(> .md-block > :is(h1, h2, h3))");
    expect(
      grule(".md-ir-block + .md-ir-block:has(", "padding-top: var(--md-head-flow)"),
      "标题上方加大那一档",
    ).toContain(":has(> .md-block > :is(h1, h2, h3, h4, h5, h6))");
  });

  it("两条特例排在通用那条之后（具体度相同，靠顺序决胜 —— 与预览同一口径）", () => {
    const generic = g.indexOf(".md-ir-block + .md-ir-block {");
    const headFlow = g.search(/\.md-ir-block \+ \.md-ir-block:has\(/);
    expect(generic).toBeGreaterThanOrEqual(0);
    expect(headFlow).toBeGreaterThan(generic);
  });

  it("档位只在 preview.css 声明，global.css 只读不抄（两份兜底必然漂移）", () => {
    expect(g, "global.css 里不许声明 --md-* 节奏档位").not.toMatch(/(?:^|[;{\s])--md-flow\s*:/);
  });

  it("判据有鉴别力：padding 换成 margin-top 的替身必须被 flowRule 拒掉", () => {
    const sub = g.replace("padding-top: var(--md-flow)", "margin-top: var(--md-flow)");
    expect(sub, "替身必须真的与原文不同，否则这条什么都没测").not.toBe(g);
    expect(sub).not.toMatch(flowRule);
  });
});

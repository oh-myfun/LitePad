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

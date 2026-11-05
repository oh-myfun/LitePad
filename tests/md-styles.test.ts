// B352-1 排版层分离：markdown 的排版规则与 `--md-*` token 挂到共用类 `.md-rendered` 上，
// `.md-preview` 退化成**容器**（overflow / padding / 背景）。
//
// 为什么要拆开：预览格不是唯一的 markdown 面 —— 导出 HTML / 打印 article 也要同一份排版，
// 两处各写一份样式是「日后必然漂移」的那条反目标，所以这里只搬选择器前缀，并把
// 「容器类不许再带 token」钉成守卫：谁将来把规则写回 `.md-preview `，这条判据就红。
//
// 像素与字阶的既有判据在 tests/preview-rhythm.test.ts 与 tests/settingsdialog.test.ts，
// 它们跟着前缀一起搬到 `.md-rendered`（声明值一条没动）。
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { stripCssComments } from "./static";

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
    expect(defs, "B377：--md-* 只该有一份定义（全部引用 :root 主题 token）").toBe(1);
    expect(css, "容器类不得再带 token").not.toMatch(/\.md-preview\s*\{[^}]*--md-fg:/);
    expect(css, "预览 token 必须引用全局主题变量").toMatch(
      /\.md-rendered\s*\{[^}]*--md-fg:\s*var\(--editor-fg/,
    );
    expect(css, "不得再有第二份深色色表").not.toMatch(
      /:root\[data-theme="dark"\][^{]*\{[^}]*--md-/,
    );
  });

  it("容器职责没在搬家路上弄丢", () => {
    expect(css, "预览容器仍然自己滚").toMatch(/\.md-preview\s*\{[^}]*overflow-y:\s*auto/);
    expect(css, "预览容器仍然留正文内边距").toMatch(/\.md-preview\s*\{[^}]*padding:/);
  });

  it("既有类名的规则一条都没被顺手删掉", () => {
    for (const cls of ["md-block", "md-task", "md-mermaid"]) {
      expect(css, `.${cls} 的规则还在`).toContain(`.${cls}`);
    }
    // 公式只活在应用内的装饰面（`preview/preview.css`）—— 那张表也钉一条，别两边都丢
    // B452：装饰面的图表卡片改名成通用 `md-diagram`（mermaid 的旧类名仍在 DOM 上，但样式只有一份）
    const face = stripCssComments(readFileSync("src/preview/preview.css", "utf-8"));
    for (const cls of ["md-block", "md-task", "md-diagram", "md-math-widget"]) {
      expect(face, `.${cls} 的规则还在装饰面表里`).toContain(`.${cls}`);
    }
  });

  it("任务清单勾选框：跟正文同字号 + 行盒中心对齐 + 可点的框用 hand 光标", () => {
    const rule = css.match(/\.md-rendered input\.md-task\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule, "B401：方框 1em（不再是固定 1.05em）").toMatch(/width:\s*1em/);
    expect(rule).toMatch(/height:\s*1em/);
    expect(rule, "input 不继承字号 ⇒ 必须显式 inherit，否则 1em 是 13.33px").toMatch(
      /font-size:\s*inherit/,
    );
    expect(rule, "B401 真机量：-0.18em 时方框中心比行盒中心低 2.4px").toMatch(
      /vertical-align:\s*-0\.06em/,
    );
    const pointer =
      css.match(/\.md-rendered input\.md-task:not\(:disabled\)\s*\{[^}]*\}/)?.[0] ?? "";
    expect(pointer, "可点的框 hand 光标；灰着的框不撒谎").toMatch(/cursor:\s*pointer/);
  });

  it("剩下的两个渲染根节点都带上共用类（应用内那一面是编辑器，不吃这张表）", () => {
    const exporter = readFileSync("src/markdown/exporter.ts", "utf-8");
    expect(exporter, "打印导出的 article 也带共用排版类").toMatch(
      /className\s*=\s*"md-preview md-rendered"/,
    );
    // ⚠️ 导出件只注入 preview.css，:root 不在里面 —— 模板漏了这个类，导出的 HTML 整篇没排版
    expect(exporter, "导出 HTML 模板的 <article> 带共用排版类").toMatch(
      /class="md-preview md-rendered md-export-body"/,
    );
    // B402：装饰面的 HTML 块借用同一份排版（它没有岛壳）
    const misc = readFileSync("src/preview/miscWidgets.ts", "utf-8");
    expect(misc, "HTML 块 widget 也带共用排版类").toMatch(
      /className\s*=\s*"md-html-preview md-rendered"/,
    );
    expect(
      readFileSync("src/markdown.ts", "utf-8"),
      "B412：旧派生 DOM 预览臂已删除，应用内不再有第三个渲染根",
    ).not.toContain("PreviewPane");
  });
});

describe("B357 标题字阶 token（IR 已移除，token 与消费方保留）", () => {
  const g = stripCssComments(readFileSync("src/styles/global.css", "utf-8"));

  it("字阶只声明一次（preview.css :root），别处只读不抄（两份比例必然漂移）", () => {
    for (const t of [
      "--md-h1-scale",
      "--md-h2-scale",
      "--md-h3-scale",
      "--md-h4-scale",
      // B402：h5/h6 补上显式档位（此前没写，落到浏览器默认的 0.83/0.67）
      "--md-h5-scale",
      "--md-h6-scale",
    ]) {
      // 走 split 计数，不走 `new RegExp`：字符串里的 `"\s"` 是恒等转义（eslint 也会打
      // no-useless-escape），拼出来的正则会静默变成错的。
      expect(css.split(t + ":").length - 1, `${t} 声明次数`).toBe(1);
    }
    // h1 的字号不许再是裸 em（改回裸 em 等于把比例写回调用点）
    expect(css).toMatch(/\.md-rendered h1 \{[^}]*font-size: calc\(var\(--md-h1-scale\)/);
    expect(css).toMatch(/\.md-rendered h5 \{[^}]*font-size: calc\(var\(--md-h5-scale\)/);
    expect(css).toMatch(/\.md-rendered h6 \{[^}]*font-size: calc\(var\(--md-h6-scale\)/);
    expect(g, "global.css 不许声明 --md-* 档位").not.toMatch(
      /(?:^|[;{\s])--md-(?:flow|h\d-scale)\s*:/,
    );
  });
});

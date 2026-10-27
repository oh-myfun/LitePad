// @vitest-environment node
// B397-2 · 样式对标的判据：装饰那一档的排版数值必须与 InkNote 的编辑面一致，
// 取色必须回接 LitePad 的主题 token。
//
// 为什么每条都写死数字（而不是只判「有没有这条规则」）：用户这次的口径是
// 「装饰面需要对标 InkNote 的样式，不要自己重新开发」—— 上一版 preview 被点名的就是
// 「看起来和 InkNote 完全不同」。少了这层数值闸，改回自己的一套档位测试照样绿。
//
// 数值来源：E:\Project\InkNote\InkNote\src\App.css（本机参照，行号写在每条 it 里）。
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ruleBlock, stripCssComments } from "./static";

// ⚠️ 一律读**剥掉注释**的文本：文件头那几条说明里复述了旧值（`margin: 12px 0`、
// InkNote 的 1.75 行距），不剥注释的话 `not.toMatch` 会被自己的文档误伤（tests/static.ts
// 那段注释讲的就是这个坑）。
const css = stripCssComments(readFileSync("src/spike/deco/deco.css", "utf-8"));

/** InkNote 的标题字阶（App.css:1308-1313）：类名 → [字号, 字重]。 */
const HEADING_SCALE: [string, string, string][] = [
  ["cm-md-h1", "1.92em", "720"],
  ["cm-md-h2", "1.52em", "700"],
  ["cm-md-h3", "1.27em", "650"],
  ["cm-md-h4", "1.12em", "600"],
  ["cm-md-h5", "1.02em", "600"],
  ["cm-md-h6", "0.95em", "600"],
];

describe("B397-2 宿主 token 层：形状照抄 InkNote，颜色回接 LitePad", () => {
  const host = ruleBlock(css, ".panel-host .panel-editor .cm-editor.md-deco", "--editor-padding-x");

  it("几何档位逐条是 InkNote 的数（App.css:1159-1165）", () => {
    expect(host).toMatch(/--editor-padding-x:\s*48px/);
    expect(host).toMatch(/--editor-block-indent:\s*16px/);
    expect(host).toMatch(/--editor-quote-bar:\s*3px/);
    expect(host).toMatch(/--editor-list-marker-offset:\s*1\.35em/);
    expect(host).toMatch(/--md-component-radius:\s*9px/);
  });

  it("取色一律引用 LitePad 的主题 token，不许抄 InkNote 的字面量色值", () => {
    for (const token of [
      "--md-accent",
      "--md-panel-bg",
      "--md-panel-border",
      "--md-fg",
      "--md-muted",
      "--md-faint",
      "--md-code-font",
    ]) {
      expect(host, `${token} 必须由 var(--…) 定义`).toMatch(
        new RegExp(`${token}:\\s*var\\(--[a-z-]+`),
      );
    }
    expect(css, "deco.css 里不许出现十六进制色值").not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(css, "deco.css 里不许出现 rgb()/rgba()").not.toMatch(/\brgba?\(/);
  });

  it("previewSets 行内 style 引用的那两颗 token 有定义（缺了嵌套列表缩进整条失效）", () => {
    expect(host).toMatch(/--editor-padding-x:/);
    expect(host).toMatch(/--editor-list-marker-offset:/);
  });
});

describe("B397-2 壳层：正文归正文字体，留白画在行上", () => {
  it("文档面走正文字体（--font-body），且把祖先链写全压过 global.css 的代码字体那条", () => {
    const body = ruleBlock(
      css,
      ".panel-host .panel-editor .cm-editor.md-deco, .panel-host .panel-editor .cm-editor.md-deco .cm-scroller",
    );
    expect(body).toMatch(/font-family:\s*var\(--font-body\)/);
    expect(body, "不许写成 var(--font-code)：那等于没换档").not.toMatch(/var\(--font-code\)/);
  });

  it("正文左右留白画在 .cm-line 上，且**只到 (0,2,0)**（更高就吃掉构造规则的留白）", () => {
    const line = ruleBlock(css, ".md-deco .cm-line");
    expect(line).toMatch(/position:\s*relative/);
    expect(line).toMatch(/padding:\s*0 var\(--editor-padding-x\)/);
    // 这一条是 `padding` 简写 ⇒ 谁特异度高于它，谁的 padding-top/padding-left 就没了。
    // 真机第一轮（B397-2）读到的正是 padTop=0、引用与列表左内距等于裸 48px —— 那条判据就钉在这里。
    expect(css, "不许给这条行留白补祖先链").not.toMatch(
      /\.panel-host\s+\.panel-editor\s+\.cm-editor\.md-deco\s+\.cm-line\s*\{/,
    );
    expect(ruleBlock(css, ".md-deco .cm-line.md-heading-1")).toMatch(/padding-top:\s*1\.1em/);
    expect(ruleBlock(css, ".md-deco .cm-line.md-blockquote")).toMatch(/padding-left:/);
  });

  it("上下留白 + 居中宽度在 .cm-content 上，宽度档仍吃用户的正文宽度设置", () => {
    const content = ruleBlock(css, ".panel-host .panel-editor .cm-editor.md-deco .cm-content");
    expect(content).toMatch(/padding:\s*clamp\(32px,\s*6vh,\s*64px\) 0 48px/);
    expect(content).toMatch(/max-width:\s*var\(--md-content-max,/);
    expect(content).toMatch(/margin:\s*0 auto/);
  });

  it("正文行距不在这里定：不许把 InkNote 的 1.75 顶掉用户的编辑器行距设置", () => {
    // 组件内部（代码块 1.55）自己管自己的行高，那是 InkNote 的数；**正文**那三层不许出现行距声明。
    const body = [
      ruleBlock(css, ".panel-host .panel-editor .cm-editor.md-deco .cm-scroller", "overflow"),
      ruleBlock(css, ".panel-host .panel-editor .cm-editor.md-deco .cm-content"),
      ruleBlock(css, ".md-deco .cm-line"),
    ].join("\n");
    expect(body, "行距归 --editor-line-height（B225 的用户设置），样式里不许写死").not.toMatch(
      /line-height/,
    );
    expect(css).not.toMatch(/--editor-line-height:/);
  });

  it("文档面不画行号栏、不画当前行那一圈（InkNote 1287 / 1391 段）", () => {
    const gutters = ruleBlock(css, ".panel-host .panel-editor .cm-editor.md-deco .cm-gutters");
    expect(gutters).toMatch(/display:\s*none/);
    const active = ruleBlock(css, ".panel-host .cm-editor.md-deco .cm-activeLine");
    expect(active).toMatch(/background:\s*transparent/);
    expect(active).toMatch(/box-shadow:\s*none/);
  });

  it("横向滚动交给组件自己管，正文不产生第二条横滚动条（App.css:1602）", () => {
    const scroller = ruleBlock(
      css,
      ".panel-host .panel-editor .cm-editor.md-deco .cm-scroller",
      "overflow-x",
    );
    expect(scroller).toMatch(/overflow-x:\s*hidden/);
    expect(scroller).toMatch(/overflow-y:\s*auto/);
  });
});

describe("B397-2 标题：字阶挂在行内 mark 上，行元素只管上方留白", () => {
  for (const [cls, size, weight] of HEADING_SCALE) {
    it(`${cls} = ${size} / ${weight}（App.css:1308-1313）`, () => {
      // filter 是必需的：取色那条大列表（h1…h6 + 各自的 `*`）里也含这一对选择器，
      // 不指定「块体里有 font-size」就会抓到列表那条而不是字阶那条。
      const body = ruleBlock(css, `.md-deco .${cls}, .md-deco .${cls} *`, "font-size");
      expect(body).toContain(`font-size: ${size}`);
      expect(body).toContain(`font-weight: ${weight}`);
    });
  }

  it("带 `*` 的那一支是必需的：语法高亮的 tags.heading 会给内层 span 写 bold", () => {
    for (const [cls] of HEADING_SCALE) {
      expect(css, `${cls} 必须有配对的 * 选择器`).toMatch(
        new RegExp("\\.md-deco \\." + cls + " \\*\\s*(,|\\{)"),
      );
    }
  });

  it("字号不许挪到行元素上：padding-top 的 em 基准会被字号顶掉", () => {
    for (let level = 1; level <= 6; level++) {
      const body = ruleBlock(css, `.md-deco .cm-line.md-heading-${level}`);
      expect(body, `md-heading-${level} 只管 padding-top`).not.toMatch(/font-size/);
      expect(body).toMatch(/padding-top:/);
    }
  });

  it("上方留白照抄 InkNote 的 1.1/0.95/0.8/0.65 那一组（App.css:1323-1329）", () => {
    expect(ruleBlock(css, ".md-deco .cm-line.md-heading")).toMatch(/padding-top:\s*0\.5em/);
    expect(ruleBlock(css, ".md-deco .cm-line.md-heading-1")).toMatch(/padding-top:\s*1\.1em/);
    expect(ruleBlock(css, ".md-deco .cm-line.md-heading-2")).toMatch(/padding-top:\s*0\.95em/);
    expect(ruleBlock(css, ".md-deco .cm-line.md-heading-3")).toMatch(/padding-top:\s*0\.8em/);
  });

  it("`#` 显形时压成不抢眼的灰（App.css:1314-1319 的 !important 口径）", () => {
    const body = ruleBlock(css, ".md-deco .cm-md-heading-mark, .md-deco .cm-md-heading-mark *");
    expect(body).toMatch(/font-weight:\s*400\s*!important/);
    expect(body).toMatch(/color:\s*color-mix\(in srgb,\s*var\(--md-faint\)\s*68%/);
  });

  it("空行不折叠（折叠改变行盒高度 ⇒ 同步滚动逐行对齐必差，B300）", () => {
    const blank = ruleBlock(css, ".md-deco .cm-line.md-blank-line");
    expect(blank).toMatch(/min-height:\s*1em/);
    expect(blank).not.toMatch(/height:\s*0/);
    expect(blank).not.toMatch(/display:\s*none/);
  });
});

describe("B397-2 行内构造：代码 chip、链接、引用竖线", () => {
  it("行内代码是带描边的小 chip（App.css:1343-1350）", () => {
    const body = ruleBlock(css, ".md-deco .cm-md-code");
    expect(body).toMatch(/padding:\s*0\.14em 0\.42em/);
    expect(body).toMatch(/border-radius:\s*5px/);
    expect(body).toMatch(/font-size:\s*0\.88em/);
    expect(body).toMatch(/border:\s*1px solid var\(--md-panel-border\)/);
    expect(body).toMatch(/background:\s*var\(--md-panel-bg\)/);
  });

  it("链接默认不带下划线、悬停才画（App.css:1351-1352），且必须连内层 span 一起压", () => {
    // theme.ts 的 tags.link 自带 underline，那一层在 mark **里面** ⇒ 只写外层等于没写
    //（真机第一轮截图里那条下划线就是它）。判据按列表选择器问，别只问外层那颗类。
    const body = ruleBlock(css, ".md-deco .cm-md-link, .md-deco .cm-md-link *");
    expect(body).toMatch(/text-decoration:\s*none/);
    expect(body).toMatch(/color:\s*var\(--link-fg\)/);
    expect(ruleBlock(css, ".md-deco .cm-md-link:hover, .md-deco .cm-md-link:hover *")).toMatch(
      /text-decoration:\s*underline/,
    );
  });

  it("标题取色也压到内层（语法色 tags.heading 在那一层）", () => {
    const body = ruleBlock(
      css,
      ".md-deco .cm-md-h1, .md-deco .cm-md-h1 *, .md-deco .cm-md-h2, .md-deco .cm-md-h2 *," +
        " .md-deco .cm-md-h3, .md-deco .cm-md-h3 *, .md-deco .cm-md-h4, .md-deco .cm-md-h4 *," +
        " .md-deco .cm-md-h5, .md-deco .cm-md-h5 *, .md-deco .cm-md-h6, .md-deco .cm-md-h6 *",
    );
    expect(body).toMatch(/color:\s*var\(--md-fg\)/);
    expect(body).toMatch(/font-family:\s*var\(--font-body\)/);
  });

  it("引用竖线画在 padding-x 处并贴满行盒上下（相邻行连成整条线，App.css:1404-1415）", () => {
    const bar = ruleBlock(css, ".md-deco .cm-line.md-blockquote::before");
    expect(bar).toMatch(/left:\s*var\(--editor-padding-x\)/);
    expect(bar).toMatch(/top:\s*0/);
    expect(bar).toMatch(/bottom:\s*0/);
    expect(bar).toMatch(/width:\s*var\(--editor-quote-bar\)/);
    expect(bar).toMatch(/background:\s*var\(--md-quote-border\)/);
    const text = ruleBlock(css, ".md-deco .cm-line.md-blockquote");
    expect(text).toMatch(/padding-left:/);
    expect(text).toMatch(/color:\s*var\(--md-muted\)/);
  });
});

describe("B397-2 列表与任务项：标记由 CSS 画", () => {
  it("圆点用 `•`、序号用源码里的真实序号，两者都占 marker-width（App.css:1421-1445）", () => {
    const bullet = ruleBlock(
      css,
      ".md-deco .cm-line.md-list-item.md-bullet-list:not(.md-task-item)::before",
    );
    expect(bullet).toMatch(/content:\s*"•"/);
    expect(bullet).toMatch(/width:\s*var\(--md-list-marker-width,/);
    const ordered = ruleBlock(
      css,
      ".md-deco .cm-line.md-list-item.md-ordered-list:not(.md-task-item)::before",
    );
    expect(ordered).toMatch(/content:\s*var\(--md-marker,\s*counter\(md-olist\)\s*"\."\)/);
    expect(ordered).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(ruleBlock(css, ".md-deco .cm-content", "counter-reset")).toMatch(
      /counter-reset:\s*md-olist/,
    );
    expect(css).toMatch(/counter-increment:\s*md-olist/);
  });

  it("任务方框 14×14 / 1.5px 描边 / top .45em（App.css:1449-1462）", () => {
    const box = ruleBlock(css, ".md-deco .cm-line.md-task-item::before");
    expect(box).toMatch(/width:\s*14px/);
    expect(box).toMatch(/height:\s*14px/);
    expect(box).toMatch(/border:\s*1\.5px solid var\(--md-strong-border\)/);
    expect(box).toMatch(/border-radius:\s*3px/);
    expect(box).toMatch(/top:\s*0\.45em/);
    expect(box).toMatch(/cursor:\s*pointer/);
  });

  it("勾是两根 1.8px 的边转 45°，不是字符 ✓（App.css:1473-1485）", () => {
    const check = ruleBlock(css, ".md-deco .cm-line.md-task-done::after");
    expect(check).not.toMatch(/content:\s*"[^"]+"/);
    expect(check).toMatch(/width:\s*5px/);
    expect(check).toMatch(/height:\s*9px/);
    expect(check).toMatch(/border-width:\s*0 1\.8px 1\.8px 0/);
    expect(check).toMatch(/transform:\s*rotate\(45deg\)/);
    expect(ruleBlock(css, ".md-deco .cm-line.md-task-done::before")).toMatch(
      /background:\s*var\(--md-accent\)/,
    );
  });

  it("完成项压淡并画删除线（App.css:1464-1468）", () => {
    const done = ruleBlock(css, ".md-deco .cm-line.md-task-done");
    expect(done).toMatch(/text-decoration:\s*line-through/);
    expect(done).toMatch(/text-decoration-color:\s*var\(--md-strong-border\)/);
    expect(done).toMatch(/color:\s*var\(--md-muted\)/);
  });

  it("任务行左内距保持 padding-x + marker-offset（taskClick 的命中判据算的就是这个差）", () => {
    const item = ruleBlock(css, ".md-deco .cm-line.md-task-item");
    expect(item.replace(/\s+/g, " ")).toMatch(
      /padding-left: calc\(var\(--editor-padding-x\) \+ var\(--editor-list-marker-offset\)\)/,
    );
  });
});

describe("B397-2 块级 widget：与正文左缘对齐，且一条纵向 margin 都没有", () => {
  it("根元素用 margin: 0 padding-x 对齐正文（App.css:1487-1503）", () => {
    const roots = ruleBlock(
      css,
      ".md-deco .md-codeblock-widget, .md-deco .md-table-widget, .md-deco .md-mermaid-widget, .md-deco .md-math-block",
    );
    expect(roots).toMatch(/box-sizing:\s*border-box/);
    expect(roots).toMatch(/max-width:\s*calc\(100% - 2 \* var\(--editor-padding-x\)\)/);
    expect(roots).toMatch(/margin:\s*0 var\(--editor-padding-x\)/);
  });

  it("全文件没有任何纵向 margin / 非 0 起手的 margin（CM6 块高图会逐块累积误差）", () => {
    expect(css).not.toMatch(/margin-(top|bottom)/);
    const margins = [...css.matchAll(/margin\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(margins.length).toBeGreaterThan(2);
    for (const value of margins) {
      expect(value, `块级根不许写纵向 margin：margin: ${value}`).toMatch(/^0(\s|;|$)/);
    }
  });

  it("代码块：外层只管纵向留白，视觉盒在**内层**（App.css:1546-1563）", () => {
    expect(ruleBlock(css, ".md-deco .md-codeblock-widget", "8px 0")).toMatch(/padding:\s*8px 0/);
    const box = ruleBlock(css, ".md-deco .md-codeblock-box");
    expect(box).toMatch(/display:\s*flex/);
    expect(box).toMatch(/border:\s*1px solid var\(--md-panel-border\)/);
    expect(box).toMatch(/border-radius:\s*var\(--md-component-radius\)/);
    expect(box).toMatch(/background:\s*var\(--md-panel-bg\)/);
    expect(box, "描边画在 pre 上会让行号栏那条分隔线对不齐盒子圆角").not.toMatch(/margin/);
  });

  it("代码块：行号栏 + 语言下拉 + 可编辑区三件一套，上内距 34px 是给下拉留的位（App.css:1564-1599）", () => {
    const gutter = ruleBlock(css, ".md-deco .md-codeblock-gutter");
    expect(gutter).toMatch(/padding:\s*34px 10px 12px 14px/);
    expect(gutter).toMatch(/border-right:\s*1px solid var\(--md-panel-border\)/);
    expect(gutter).toMatch(/user-select:\s*none/);
    const code = ruleBlock(css, ".md-deco .md-codeblock-widget code");
    expect(code).toMatch(/padding:\s*34px 16px 12px/);
    expect(code).toMatch(/font-size:\s*0\.85em/);
    expect(code).toMatch(/line-height:\s*1\.55/);
    expect(code).toMatch(/white-space:\s*pre/);
    expect(ruleBlock(css, ".md-deco .md-codeblock-widget pre")).toMatch(/padding:\s*0/);
    expect(ruleBlock(css, ".md-deco .md-codeblock-lang")).toMatch(/height:\s*22px/);
    expect(ruleBlock(css, ".md-deco .md-codeblock-language-control")).toMatch(
      /position:\s*absolute/,
    );
    const header = ruleBlock(css, ".md-deco .md-codeblock-header");
    expect(header).toMatch(/opacity:\s*0/);
    expect(header).toMatch(/pointer-events:\s*none/);
    expect(css).toMatch(/\.md-codeblock-widget\.md-block--editing \.md-codeblock-header/);
  });

  it("表格：单元格 8px/13px、表头 650、separate 描边（App.css:2299-2325）", () => {
    expect(ruleBlock(css, ".md-deco .md-table-widget", "5px 0 7px")).toMatch(
      /padding:\s*5px 0 7px/,
    );
    expect(ruleBlock(css, ".md-deco .md-table-widget table")).toMatch(
      /border-collapse:\s*separate/,
    );
    const cell = ruleBlock(css, ".md-deco .md-table-widget th, .md-deco .md-table-widget td");
    expect(cell).toMatch(/padding:\s*8px 13px/);
    expect(cell).toMatch(/min-width:\s*3em/);
    expect(cell).toMatch(/vertical-align:\s*top/);
    expect(ruleBlock(css, ".md-deco .md-table-widget th", "font-weight: 650")).toMatch(
      /font-weight:\s*650/,
    );
  });

  it("B397-3b 表格：描边/圆角/底色回到 .md-table-body 那一层，根只剩纵向留白（App.css:2288-2298）", () => {
    const root = ruleBlock(css, ".md-deco .md-table-widget", "5px 0 7px");
    expect(root, "视觉盒子放内层：根元素带描边就等于把 B397-2 那层壳又拆了").not.toMatch(/border:/);
    expect(root).not.toMatch(/background:/);
    const body = ruleBlock(css, ".md-deco .md-table-body");
    expect(body).toMatch(/border:\s*1px solid var\(--md-panel-border\)/);
    expect(body).toMatch(/border-radius:\s*var\(--md-component-radius\)/);
    expect(body).toMatch(/overflow-x:\s*auto/);
  });

  it("B397-3b 工具栏：槽常驻 18px 不顶表格、按钮 20×18、聚焦才现身（App.css:2383-2426）", () => {
    const slot = ruleBlock(css, ".md-deco .md-table-toolbar-slot");
    expect(slot).toMatch(/height:\s*18px/);
    expect(slot).toMatch(/pointer-events:\s*none/);
    const bar = ruleBlock(css, ".md-deco .md-table-toolbar", "display: flex");
    expect(bar).toMatch(/opacity:\s*0/);
    expect(bar).toMatch(/visibility:\s*hidden/);
    expect(css).toMatch(/\.md-deco \.md-table-widget--focused \.md-table-toolbar/);
    expect(css).toMatch(/\.md-deco \.md-table-widget:focus-within \.md-table-toolbar/);
    const btn = ruleBlock(css, ".md-deco .md-table-toolbar-btn");
    expect(btn).toMatch(/width:\s*20px/);
    expect(btn).toMatch(/height:\s*18px/);
    expect(btn).toMatch(/border-radius:\s*4px/);
    expect(
      ruleBlock(css, ".md-deco .md-table-toolbar-menu", "min-width: 140px"),
      "菜单阴影走 LitePad 的 --shadow-lg，不抄 InkNote 的字面量黑",
    ).toMatch(/box-shadow:\s*var\(--shadow-lg\)/);
  });

  it("B397-3b 打字那一格按真实换行排；框选那一档底色不许透出表头（App.css:2318 / 2356-2360）", () => {
    expect(ruleBlock(css, '.md-deco .md-table-widget [contenteditable="true"]:focus')).toMatch(
      /white-space:\s*pre-wrap/,
    );
    const selected = ruleBlock(
      css,
      ".md-deco .md-table-widget th.md-table-cell-selected, .md-deco .md-table-widget td.md-table-cell-selected",
    );
    expect(selected).toMatch(/background:\s*color-mix\(/);
    expect(selected).toMatch(/!important/);
  });

  it("B397-3b 只读那一把锁有 CSS 读数点：藏光标、收工具栏与语言下拉、留静态语言名（App.css:1142-1155）", () => {
    expect(css).toMatch(/\.md-deco--readonly \.cm-content\s*\{\s*caret-color:\s*transparent/);
    expect(css).toMatch(
      /\.md-deco--readonly \.md-table-toolbar,\s*\.md-deco--readonly \.md-codeblock-lang,\s*\.md-deco--readonly \.md-codeblock-language-control::after\s*\{\s*display:\s*none/,
    );
    expect(css).toMatch(
      /\.md-deco--readonly \.md-codeblock-language-label\s*\{\s*display:\s*inline-block/,
    );
    // 同特异度靠先后定胜负：静态标签那条排在 `display: none` 之后才生效
    expect(css.indexOf(".md-deco--readonly .md-codeblock-language-label")).toBeGreaterThan(
      css.indexOf(".md-deco .md-codeblock-language-label"),
    );
  });

  it("公式块级档 18px/14px 留白、mermaid 盒 20px 留白（App.css 数学段 / 图表段）", () => {
    const math = ruleBlock(css, ".md-deco .md-math-widget.md-math-block");
    expect(math).toMatch(/padding:\s*18px 14px/);
    expect(math).toMatch(/overflow-x:\s*auto/);
    expect(ruleBlock(css, ".md-deco .md-mermaid-widget .md-mermaid")).toMatch(/padding:\s*20px/);
  });

  it("B397-4a 分割线：上下一律 8px 留白，线走 --md-strong-border 渐隐（App.css:1684-1697）", () => {
    expect(ruleBlock(css, ".md-deco .md-hr-widget", "8px 0")).toMatch(/padding:\s*8px 0/);
    const line = ruleBlock(css, ".md-deco .md-hr-line");
    expect(line).toMatch(/height:\s*1px/);
    expect(line).toMatch(/linear-gradient\(/);
    expect(line).toMatch(/var\(--md-strong-border\)/);
    expect(line).toMatch(/pointer-events:\s*none/);
  });

  it("B397-4a 块内源码区：平时 display:none，editing 那一颗类才显形（App.css:2495-2512）", () => {
    const source = ruleBlock(css, ".md-deco .md-block-source", "display: none");
    expect(source).toMatch(/display:\s*none/);
    expect(source).toMatch(/font-family:\s*var\(--md-code-font\)/);
    expect(source).toMatch(/padding:\s*8px 10px/);
    expect(source, "InkNote 的 margin-bottom 不搬：块级 widget 禁纵向 margin").not.toMatch(
      /margin-bottom/,
    );
    expect(ruleBlock(css, ".md-deco .md-block--editing .md-block-source")).toMatch(
      /display:\s*block/,
    );
    const hidden = ruleBlock(
      css,
      ".md-deco .md-block--editing > .md-metadata-preview, .md-deco .md-block--editing > .md-html-preview",
    );
    expect(hidden).toMatch(/display:\s*none/);
  });

  it("B397-4a 链接定义 / HTML 预览：左边一道 accent 竖线、虚线框（App.css:2515-2543）", () => {
    const meta = ruleBlock(css, ".md-deco .md-metadata-preview");
    expect(meta).toMatch(/border-left:\s*3px solid var\(--md-accent\)/);
    expect(meta).toMatch(/background:\s*var\(--md-quote-bg\)/);
    expect(meta).toMatch(/font-size:\s*0\.88em/);
    const html = ruleBlock(css, ".md-deco .md-html-preview");
    expect(html).toMatch(/border:\s*1px dashed var\(--md-panel-border\)/);
    expect(html).toMatch(/padding:\s*10px 12px/);
    expect(ruleBlock(css, ".md-deco .md-metadata-footnote .md-metadata-preview")).toMatch(
      /font-size:\s*0\.82em/,
    );
  });

  it("B397-4a 脚注引用是编号上标，定义卡片字号再小一档（App.css:1356-1362 / 2515-2520）", () => {
    const sup = ruleBlock(css, ".md-deco .cm-md-footnote");
    expect(sup).toMatch(/vertical-align:\s*super/);
    expect(sup).toMatch(/font-size:\s*0\.75em/);
    expect(sup).toMatch(/color:\s*var\(--md-accent\)/);
  });

  it("B397-4a 三颗新块级根与正文左缘对齐（同一张禁纵向 margin 的名单）", () => {
    const roots = ruleBlock(
      css,
      ".md-deco .md-hr-widget, .md-deco .md-metadata-widget, .md-deco .md-html-widget",
    );
    expect(roots).toMatch(/margin:\s*0 var\(--editor-padding-x\)/);
    expect(roots).toMatch(/max-width:\s*calc\(100% - 2 \* var\(--editor-padding-x\)\)/);
  });
});

describe("B397-2 守卫：镜像那一臂的宿主类不再回来", () => {
  it("deco.css 里已无 .md-deco-host / .md-preview（B397-1 拆掉第二颗 view 后没有宿主了）", () => {
    expect(css).not.toMatch(/md-deco-host/);
    expect(css).not.toMatch(/\.md-preview/);
  });

  it("装饰规则一律以 `.md-deco` 为根（源码那一格与派生 DOM 那一臂都不受牵连）", () => {
    const rules = css.split("}").filter((block) => block.includes("{"));
    const naked = rules
      .map((block) => block.split("{")[0].trim())
      .filter((selector) => selector && !/\.md-deco|:root\[data-theme/.test(selector));
    expect(naked, `这些选择器没挂在 .md-deco 下：${naked.join(" | ")}`).toEqual([]);
  });
});

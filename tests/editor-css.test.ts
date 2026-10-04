// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ruleBlock, cssDecls, stripLineComments, topLevelFnBody } from "./static";
import { FONT_FAMILY_OPTIONS } from "../src/shell/settingsdialog";

describe("编辑器 DOM / CSS 静态契约", () => {
  it("编辑器必须可滚动：.panel-editor 须 min-height:0 且 cm-scroller 双轴 overflow（回归：源码无法滚动）", () => {
    // 用户报告：只有 md 预览能看到滚动条，其他文本和源码既无滚动条也无法滚动。
    // 根因：flex 项的 min-height:auto = 内容高度（滚动容器才豁免为 0）——
    // .panel-editor 缺 min-height:0 时被整篇文档撑开、被 .panel-host 裁掉。
    const css = readFileSync("src/styles/preview.css", "utf-8");
    const editorBlock = css.match(/\.panel-host \.panel-editor \{[^}]*\}/)?.[0] ?? "";
    expect(editorBlock, ".panel-editor 必须允许收缩（min-height: 0）").toContain("min-height: 0");
    const scrollerBlock =
      css.match(/\.panel-host \.panel-editor \.cm-scroller \{[^}]*\}/)?.[0] ?? "";
    expect(
      scrollerBlock,
      "cm-scroller 必须显式 overflow: auto（CM 基础主题只有 overflow-x）",
    ).toContain("overflow: auto");
  });
  it("嵌套分屏时拖拽落点预览不错位：.layout-panel 必须自身成为定位基准", () => {
    // 用户报告：已分屏区域再分屏，落点预览不准确。
    // .split-preview 是 absolute inset:0，宿主缺 position:relative 时
    // 会相对整个布局容器定位——单面板碰巧正确、嵌套分屏错位。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const block = css.match(/\.layout-panel\s*\{[^}]*\}/);
    expect(block, "global.css 应有 .layout-panel 规则块").toBeTruthy();
    expect(block![0], ".layout-panel 必须包含 position: relative").toMatch(/position:\s*relative/);
  });
  it("行号 gutter 必须走主题变量（深浅色切换联动，而非 CM 默认/oneDark 固定配色）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const block = css.match(/\.panel-host \.cm-editor \.cm-gutters\s*\{[^}]*\}/);
    expect(block, "应有 .cm-gutters 主题化规则").toBeTruthy();
    expect(block![0], "gutter 背景必须引用主题变量").toMatch(/var\(--/);
    expect(block![0], "gutter 文字色必须引用主题变量").toMatch(/color:\s*var\(--/);
  });
  it("折叠图标必须是 codicon 字形标记（open/closed 形态不同，颜色走 CSS 变量）", async () => {
    const { foldMarkerDOM } = await import("../src/editor/editor");
    const open = foldMarkerDOM(true);
    const closed = foldMarkerDOM(false);
    for (const [name, el] of [
      ["open", open],
      ["closed", closed],
    ] as const) {
      expect(el.className, `${name} 应带 cm-fold-marker 类`).toContain("cm-fold-marker");
      // B102 起字形由官方图标字体绘制：`<i class="codicon codicon-…">`
      expect(el.querySelector("i.codicon"), `${name} 应为 codicon 字形`).toBeTruthy();
    }
    expect(open.innerHTML, "展开/折叠两种形态的图标应不同").not.toBe(closed.innerHTML);
  });
});

// B225：用户报「改了编辑器字体 / 行距没反应」。
// 根因＝main.ts 只是把值写进 :root 上的 `--font-editor` / `--editor-line-height`，
// 而**全仓没有任何 CSS 消费这两颗变量**（编辑区当时写死 `var(--font-mono)`）⇒
// 设置项是个空转的壳。下面四条死锁「写入端 ↔ 消费端」这条链。
describe("B225：编辑器字体 / 行距必须真的接到 CSS", () => {
  // ⚠️ 真实祖先链：splitview.ts 建 `.panel-host` → main.ts 建 `.panel-editor` → CM6 建 `.cm-editor`。
  // 这里**曾经**写过 `.editor-host`，而那个类名全仓只有 CSS 在引用、没有任何 JS 创建它
  // ⇒ 规则一个元素都匹配不到，字体 / 行距 / 字号三样依然是死的（静态看 CSS 完全是绿的）。
  const CHAIN = ".panel-host .panel-editor .cm-editor";

  const globalCss = (): string => readFileSync("src/styles/global.css", "utf-8");

  it("选择器依赖的祖先类必须是 JS 真的建出来的 DOM 类（防「选择器挂空」假绿）", () => {
    const code =
      readFileSync("src/shell/splitview.ts", "utf-8") + "\n" + readFileSync("src/main.ts", "utf-8");
    const classes = [...CHAIN.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    expect(classes.length, "选择器里应有多个祖先类").toBeGreaterThan(1);
    for (const cls of classes) {
      // cm-editor 由 CM6 自己建（不经过我们的 className 赋值），其余都得是项目自己建的
      if (cls === "cm-editor") continue;
      // 反例前置：退化成压根不存在的类名（如 .editor-host）时，JS 里搜不到这个字符串
      expect(code, `.${cls} 必须在 JS 里被赋给真实元素（否则 CSS 规则匹配不到任何东西）`).toMatch(
        new RegExp(`["']${cls}["']`),
      );
    }
  });

  it("--font-editor 必须有消费方，且带一份内置等宽栈兜底", () => {
    const block = ruleBlock(globalCss(), CHAIN, "font-family");
    expect(block, `应有 ${CHAIN} 的 font-family 规则`).toBeTruthy();
    const decls = cssDecls(block);
    // 反例前置（退化形态 1：压根不认 --font-editor，写死内置栈）
    expect(decls, "font-family 不许写死成只取 --font-mono").not.toMatch(
      /font-family:\s*var\(--font-mono\)/,
    );
    expect(decls, "font-family 必须优先取 --font-editor").toMatch(
      /font-family:\s*var\(--font-editor/,
    );
    // 退化形态 2：认了变量但没兜底 —— 选中的字体本机没装时，
    // 会掉到浏览器默认的**非等宽**字体上（不是内置等宽栈）。
    expect(decls, "--font-editor 之后必须再挂一份 --font-mono 兜底").toMatch(
      /var\(--font-editor[^;]*\)\s*,\s*var\(--font-mono\)/,
    );
  });

  it("--editor-line-height 必须有消费方，行号栏要跟着一起走", () => {
    const css = globalCss();
    const body = cssDecls(ruleBlock(css, ".panel-host .panel-editor .cm-content", "line-height"));
    expect(body, "正文必须引用 --editor-line-height").toMatch(
      /line-height:\s*var\(--editor-line-height/,
    );
    // ⚠️ `.cm-gutterElement` 的高度是 CM6 按实测行高写死的 px，正文改了行距、
    // 行号栏不跟着改 line-height 的话数字会贴着格子顶边、不与正文对齐。
    const gutter = cssDecls(
      ruleBlock(css, ".panel-host .panel-editor .cm-gutterElement", "line-height"),
    );
    // 反例前置：退化形态＝只给 .cm-content 一条
    expect(gutter, "行号栏必须同样引用 --editor-line-height").toMatch(
      /line-height:\s*var\(--editor-line-height/,
    );
  });

  it("预览行距的链路不能断（--md-line-height 由 .md-preview 消费）", () => {
    const block = ruleBlock(
      readFileSync("src/styles/preview.css", "utf-8"),
      ".md-preview",
      "line-height",
    );
    expect(block, "preview.css 的 .md-preview 应有 line-height 规则").toBeTruthy();
    expect(cssDecls(block), ".md-preview 必须引用 --md-line-height").toMatch(
      /line-height:\s*var\(--md-line-height/,
    );
  });

  it("改字号 / 字体 / 行距后一律走 measureAndKeepScroll（不许裸 requestMeasure）", () => {
    // 退化形态：回到裸 `view.requestMeasure()` —— CM6 测量结束会做滚动锚点补偿，
    // 把视口顶行往下推一截（B146），改一次设置就飘一次。
    const src = readFileSync("src/main.ts", "utf-8");
    for (const fn of ["applyFontSize", "applyFontFamily", "applyEditorLineHeight"]) {
      const body = stripLineComments(topLevelFnBody(src, fn));
      expect(body, `应能截到 ${fn} 的函数体`).toBeTruthy();
      // 反例必须排在正向之前，否则退化时被正向断言抢先报错
      expect(body, `${fn} 不许裸调 requestMeasure`).not.toContain("requestMeasure");
      expect(body, `${fn} 必须走 measureAndKeepScroll`).toContain("measureAndKeepScroll(p)");
    }
  });

  it("编辑器字体候选成规模、无重复，「默认」仍在首位", () => {
    // 退化形态：缩回 B225 前那份「默认 + 4 项」的老清单
    expect(FONT_FAMILY_OPTIONS.length, "候选清单应成规模").toBeGreaterThanOrEqual(12);
    const values = FONT_FAMILY_OPTIONS.map((o) => o.value);
    expect(new Set(values).size, "value 不得重复（下拉里会出现两个同值项）").toBe(values.length);
    // 「默认」占位必须在首位：value 空串 = 移除变量、回落内置栈
    expect(values[0], "第一项必须是「默认」占位").toBe("");
    expect(
      values.slice(1).every((v) => v.trim().length > 0),
      "其余项不得为空串",
    ).toBe(true);
    // 中文等宽是这次扩充的主诉求之一
    expect(
      values.some((v) => v.includes("Sarasa")),
      "应含更纱黑体",
    ).toBe(true);
    expect(
      values.some((v) => v.includes("LXGW")),
      "应含霞鹜文楷",
    ).toBe(true);
  });
});

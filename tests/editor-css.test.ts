// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ruleBlock, cssDecls, stripLineComments, topLevelFnBody } from "./static";
import {
  FONT_FAMILY_NO_DIFF_SUFFIX,
  FONT_FAMILY_OPTIONS,
  fontFamilyOptions,
} from "../src/shell/settingsdialog";

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

  it("字体必须落到 .cm-scroller 上（正文/行号从它继承，.cm-editor 会被截胡）", () => {
    // 第四层根因：CM6 baseTheme 给 `.cm-scroller` 写了 `font-family: monospace`，
    // 正文 .cm-content 和行号 .cm-gutterElement 都在它里面 ⇒ 只把字体挂在
    // .cm-editor 上，文字继承到的仍是 monospace，换什么字体界面都不动。
    const css = globalCss();
    const body = cssDecls(
      ruleBlock(css, ".panel-host .panel-editor .cm-editor .cm-scroller", "font-family"),
    );
    expect(body, ".cm-scroller 必须有 font-family 规则（否则正文继承不到 --font-editor）").toMatch(
      /font-family:\s*var\(--font-editor/,
    );
    expect(body, ".cm-scroller 那一份同样要挂 --font-mono 兜底").toMatch(
      /var\(--font-editor[^;]*\)\s*,\s*var\(--font-mono\)/,
    );
  });

  it("CM6 的 .cm-scroller 那条 monospace 不许带 !important（我们靠特异性盖它）", () => {
    const cm = readFileSync("node_modules/@codemirror/view/dist/index.js", "utf-8");
    const from = cm.indexOf('".cm-scroller"');
    const to = cm.indexOf('".cm-content"', from);
    const scroller = from >= 0 && to > from ? cm.slice(from, to) : "";
    expect(scroller, "应能截到 CM6 的 .cm-scroller 规则").toBeTruthy();
    expect(scroller, "CM6 必须在 .cm-scroller 上写 font-family（这是继承截胡的源头）").toMatch(
      /fontFamily:\s*["']monospace/,
    );
    // 反例前置：退化形态＝CM6 哪天给 fontFamily 补上 !important ⇒ 本项目 (0,4,0)
    // 的特异性就盖不住它，正文会永远锁死 monospace，而**没有任何报错**。
    expect(
      scroller,
      "CM6 的 fontFamily 不许带 !important（带了我们这条覆盖就静默失效）",
    ).not.toMatch(/fontFamily:\s*["'][^"']*!important/);
    // 正文与行号确实都挂在 .cm-scroller 里（否则上面那条规则挂给谁都没用）：
    // 正文 = scrollDOM.appendChild(contentDOM)，行号 = gutter 插件
    // scrollDOM.insertBefore(gutterDOM, contentDOM) —— 都在 scrollDOM 下。
    const dom = readFileSync("node_modules/@codemirror/view/dist/index.js", "utf-8");
    expect(
      /this\.scrollDOM\.appendChild\(this\.contentDOM\)/.test(dom),
      "正文必须在 scrollDOM 内（.cm-content 的字体从这里继承）",
    ).toBe(true);
    // 反例前置：退化＝行号栏哪天被挪出 scrollDOM（挂到 .cm-editor 下），
    // 那它继承到的就还是 monospace，换字体只有正文动、行号不动。
    expect(
      /scrollDOM\.insertBefore\(this\.dom,\s*view\.contentDOM\)/.test(dom),
      "行号栏必须插进 scrollDOM（.cm-gutterElement 的字体从这里继承）",
    ).toBe(true);
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

  it("本机装得到的字体必须排在候选前列（先给看得见效果的）", () => {
    // 退化形态：把没装的那批（JetBrains Mono 等）挪到最前 —— 也就是 B225 修之前
    // 的排法，用户从头往下点、点到没装的那几项，观感就是「改了没反应」。
    // 这五项是 Windows 自带的等宽字体，任何 Win10/11 都装得上。
    const installed = [
      "Cascadia Code",
      "Cascadia Mono",
      "Consolas",
      "Lucida Console",
      "Courier New",
    ];
    const values = FONT_FAMILY_OPTIONS.map((o) => o.value).slice(1);
    expect(values.slice(0, 5), "前五项必须全部是系统自带的等宽字体").toEqual(installed);
    for (const name of installed) {
      expect(values.slice(0, 6), `${name} 是系统自带，必须留在前六项里`).toContain(name);
    }
  });

  it("未安装的字体候选要打标说明（否则用户当成「改了没反应」报回来）", () => {
    // jsdom 里 canvas 拿不到 2d 上下文，isFontInstalled 一律判「装了」⇒ 标注行为
    // 只能在真浏览器里验（headless 探针），这里钉的是**接线**：编辑器分类页必须走
    // fontFamilyOptions() 而不是直接用静态清单。
    const src = stripLineComments(readFileSync("src/shell/settingsdialog.ts", "utf-8"));
    const page = src.match(/else if \(id === "editor"\) \{([\s\S]*?)\n {2}\} else if/)?.[1] ?? "";
    expect(page, "应能截到编辑器分类页").toBeTruthy();
    expect(page, "编辑器字体行必须走 fontFamilyOptions() 打标").toContain("fontFamilyOptions()");
    expect(page, "不能退回未打标的静态清单").not.toContain("FONT_FAMILY_OPTIONS");
    expect(
      FONT_FAMILY_NO_DIFF_SUFFIX.trim().length,
      "打标文案不能是空串（等于没标）",
    ).toBeGreaterThan(0);
  });

  it("canvas 判不出来时必须放行全部候选（宁可不标，也不误杀装着的字体）", () => {
    // 显式把 getContext 打桩返回 null（jsdom 不装 canvas 包时它本来就返回 null，
    // 但会往控制台刷 16 行 Not implemented —— 打桩是为了把「判不出来」摆到台面上）
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = () => null;
    try {
      const marked = fontFamilyOptions();
      expect(marked.length, "候选数量必须保留").toBe(FONT_FAMILY_OPTIONS.length);
      for (let i = 0; i < FONT_FAMILY_OPTIONS.length; i++) {
        expect(marked[i].value, `第 ${i} 项的 value 不该动`).toBe(FONT_FAMILY_OPTIONS[i].value);
        expect(marked[i].label, `第 ${i} 项不该被误标`).toBe(FONT_FAMILY_OPTIONS[i].label);
      }
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  });
});

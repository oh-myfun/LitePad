// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { ruleBlock, cssDecls, stripLineComments, topLevelFnBody } from "./static";
import {
  DEFAULT_BODY_FONT_LABEL,
  DEFAULT_CODE_FONT_LABEL,
  FONT_FAMILY_NO_DIFF_SUFFIX,
  FONT_FAMILY_OPTIONS,
  fontFamilyOptions,
  fontOptionsFor,
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

  it("--font-code 必须有消费方（源码区是代码），且带一份内置等宽栈兜底", () => {
    const block = ruleBlock(globalCss(), CHAIN, "font-family");
    expect(block, `应有 ${CHAIN} 的 font-family 规则`).toBeTruthy();
    const decls = cssDecls(block);
    // 反例前置（退化形态 1：压根不认 --font-code，写死内置栈）
    expect(decls, "font-family 不许写死成只取 --font-mono").not.toMatch(
      /font-family:\s*var\(--font-mono\)/,
    );
    expect(decls, "font-family 必须优先取 --font-code").toMatch(/font-family:\s*var\(--font-code/);
    // 退化形态 2：认了变量但没兜底 —— 选中的字体本机没装时，
    // 会掉到浏览器默认的**非等宽**字体上（不是内置等宽栈）。
    expect(decls, "--font-code 之后必须再挂一份 --font-mono 兜底").toMatch(
      /var\(--font-code[^;]*\)\s*,\s*var\(--font-mono\)/,
    );
    // B231：--font-editor 那层中转已删（正文字体写 --font-body、代码字体写
    // --font-code，两条语义栈直接对应两个设置项）。留着会让人以为还有第三条栈。
    expect(decls, "源码区不该再读已作废的 --font-editor").not.toContain("--font-editor");
  });

  it("字体必须落到 .cm-scroller 上（正文/行号从它继承，.cm-editor 会被截胡）", () => {
    // 第四层根因：CM6 baseTheme 给 `.cm-scroller` 写了 `font-family: monospace`，
    // 正文 .cm-content 和行号 .cm-gutterElement 都在它里面 ⇒ 只把字体挂在
    // .cm-editor 上，文字继承到的仍是 monospace，换什么字体界面都不动。
    const css = globalCss();
    const body = cssDecls(
      ruleBlock(css, ".panel-host .panel-editor .cm-editor .cm-scroller", "font-family"),
    );
    expect(body, ".cm-scroller 必须有 font-family 规则（否则正文继承不到 --font-code）").toMatch(
      /font-family:\s*var\(--font-code/,
    );
    expect(body, ".cm-scroller 那一份同样要挂 --font-mono 兜底").toMatch(
      /var\(--font-code[^;]*\)\s*,\s*var\(--font-mono\)/,
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
    const src = readFileSync("src/appearance.ts", "utf-8");
    // B231：真正会改 CM6 布局的三个 —— 字号、编辑器行距、**代码字体**
    // （源码区改吃 --font-code，换字体即改行宽；B227 时它只落预览、不碰 CM6，
    //  才不需要重测，那版判断已随口径作废）。
    for (const fn of ["applyFontSize", "applyEditorLineHeight", "applyCodeFontFamily"]) {
      const body = stripLineComments(topLevelFnBody(src, fn));
      expect(body, `应能截到 ${fn} 的函数体`).toBeTruthy();
      // 反例必须排在正向之前，否则退化时被正向断言抢先报错
      expect(body, `${fn} 不许裸调 requestMeasure`).not.toContain("requestMeasure");
      expect(body, `${fn} 必须走 measureAndKeepScroll`).toContain("measureAndKeepScroll(p)");
    }
    // 反向：applyFontFamily 只写 --font-body（预览正文），没有 CM6 消费方 ——
    // 重测是空转。契约钉住「别加」，免得日后又照着旧口径补回来。
    const bodyFont = stripLineComments(topLevelFnBody(src, "applyFontFamily"));
    expect(bodyFont, "正文字体只写 --font-body").toContain("--font-body");
    expect(bodyFont, "正文字体不消费 CM6，不该重测编辑器（空转）").not.toContain(
      "measureAndKeepScroll",
    );
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

  it("字体两栏（B227）：候选走本机枚举，未安装的值照样列出并打标", () => {
    // B227 起候选来自 Rust `list_fonts` 的**本机枚举**（用户拍定：其余字体动态列出），
    // 「本机没装」的标注挪进 `fontOptionsFor`：枚举结果里没有、但当前正选着的那个值
    // 仍要列在首位并打标 —— 悄悄退回默认值会让人以为设置被重置了。
    // ⚠️ jsdom 里 canvas 拿不到 2d 上下文，isFontInstalled 一律判「装了」，
    // 像素判据只能上真浏览器（headless 探针），这里钉的是**接线 + 纯函数行为**。
    const src = stripLineComments(readFileSync("src/shell/settingsdialog.ts", "utf-8"));
    const page = src.match(/else if \(id === "editor"\) \{([\s\S]*?)\n {2}\} else if/)?.[1] ?? "";
    expect(page, "应能截到编辑器分类页").toBeTruthy();
    // 反例在前：不能退回那份未打标的手抄清单
    expect(page, "不能退回未打标的静态清单").not.toContain("FONT_FAMILY_OPTIONS");
    expect(page, "正文字体那一行要走动态字体选择器").toMatch(/fontRow\(\s*"正文字体"/);
    expect(page, "代码字体要单列一行（源码区 + 预览代码都用它）").toMatch(/fontRow\(\s*"代码字体"/);
    expect(page, "两栏都要把本机枚举喂进去").toContain("opts.systemFonts()");
    expect(
      FONT_FAMILY_NO_DIFF_SUFFIX.trim().length,
      "打标文案不能是空串（等于没标）",
    ).toBeGreaterThan(0);
  });

  it("fontOptionsFor：两档互斥、缺装的值打标、枚举空则退回内置清单（B236）", () => {
    const sys = [
      { name: "Consolas", is_monospace: true },
      { name: "Cascadia Code", is_monospace: true },
      { name: "Microsoft YaHei UI", is_monospace: false },
    ];
    // B236：两档是「比例 / 等宽」，**互斥**（原来「全部」只是不过滤）
    const prop = fontOptionsFor("proportional", "", sys, DEFAULT_BODY_FONT_LABEL);
    expect(prop[0], "默认项必须在首位（value 空串 = 回落默认栈）").toEqual({
      label: DEFAULT_BODY_FONT_LABEL,
      value: "",
    });
    expect(
      prop.map((o) => o.value),
      "比例档要含非等宽项",
    ).toContain("Microsoft YaHei UI");
    expect(
      prop.map((o) => o.value),
      "比例档不许混进等宽字体",
    ).not.toContain("Consolas");
    // 「等宽」：默认项 + 只留 is_monospace
    const mono = fontOptionsFor("mono", "", sys, DEFAULT_CODE_FONT_LABEL);
    expect(
      mono.map((o) => o.value),
      "等宽栏不许混进非等宽字体",
    ).not.toContain("Microsoft YaHei UI");
    expect(
      mono.map((o) => o.value),
      "等宽栏要留系统等宽",
    ).toContain("Consolas");
    // 当前值不在枚举里（选了之后把字体卸了）→ 仍要列出 + 打未安装标记
    const missing = fontOptionsFor("proportional", "Sarasa Mono SC", sys, DEFAULT_BODY_FONT_LABEL);
    expect(missing[1], "缺装的值要顶在默认项之后、且带上未安装标记").toEqual({
      label: `Sarasa Mono SC${FONT_FAMILY_NO_DIFF_SUFFIX}`,
      value: "Sarasa Mono SC",
    });
    // 装了但不在本档 ⇒ 顶上来但**不打标**（B236：打标是「没装」的意思，不能滥用）
    const offTab = fontOptionsFor("proportional", "Consolas", sys, DEFAULT_BODY_FONT_LABEL);
    expect(offTab.find((o) => o.value === "Consolas")?.label, "装着的当前值不该打未安装标记").toBe(
      "Consolas",
    );
    // 枚举没到手（非 Windows / IPC 失败）→ 退回内置清单，别把这一栏变空
    const fallback = fontOptionsFor("proportional", "", [], DEFAULT_BODY_FONT_LABEL);
    expect(fallback.length, "枚举为空时必须退回 B225 的手抄清单").toBe(FONT_FAMILY_OPTIONS.length);
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

// B227：默认字体**内嵌**在应用里（不靠本机装没装），且「正文 / 代码」分成两条栈。
// 三份契约各自盯一个消费点：@font-face 声明、:root 的栈、CM6 与预览的取值。
describe("B227 内嵌字体：@font-face、正文/代码两条栈、两处消费点", () => {
  const fontsCss = readFileSync("src/styles/fonts.css", "utf-8");
  const global = readFileSync("src/styles/global.css", "utf-8");
  const preview = readFileSync("src/styles/preview.css", "utf-8");

  it("两款内嵌字体都要有 @font-face 声明，且指向真实存在的 woff2", () => {
    for (const [family, file] of [
      ["Cascadia Mono", "cascadia-mono-regular.woff2"],
      ["Noto Sans SC", "noto-sans-sc-regular.woff2"],
    ]) {
      const block =
        fontsCss.match(new RegExp(`@font-face\\s*\\{[^}]*${family}[^}]*\\}`))?.[0] ?? "";
      expect(block, `${family} 必须有 @font-face 块`).toBeTruthy();
      expect(block, `${family} 的 src 必须指向子集化产物`).toContain(file);
      expect(block, `${family} 走 woff2 格式声明`).toContain('format("woff2")');
    }
    // 产物文件必须真在仓里（子集化脚本漏跑就会只剩一条 @font-face 指向空气）
    for (const f of ["cascadia-mono-regular.woff2", "noto-sans-sc-regular.woff2"]) {
      expect(existsSync(`src/assets/fonts/${f}`), `产物 ${f} 不存在`).toBe(true);
    }
    // 字体-display 取 block：swap 会在首绘后换字体、行高一跳（B225 的行号栏高度是
    // CM6 按实测行高写死的 px），编辑区会跟着跳。
    expect(fontsCss, "内嵌字体不许用 swap（会引发行高跳动）").not.toContain("font-display: swap");
  });

  it("B236：内嵌等宽那份要有汉字层（unicode-range 指向思源那份），否则中文全靠回落", () => {
    // 内嵌 Cascadia Mono **一个汉字字形都没有**（源字体本身不含汉字，子集化切不出
    // 不存在的字形）⇒ 必须再挂一条同名 @font-face 用 unicode-range 把汉字圈给思源。
    const blocks = fontsCss.match(/@font-face\s*\{[^}]*\}/g) ?? [];
    const monoBlocks = blocks.filter((b) => /font-family:\s*"Cascadia Mono"/.test(b));
    expect(monoBlocks.length, "Cascadia Mono 要有两条 @font-face（ASCII 层 + 汉字层）").toBe(2);
    const cjk = monoBlocks.find((b) => b.includes("unicode-range"));
    expect(cjk, "其中一条必须带 unicode-range（汉字层）").toBeTruthy();
    expect(cjk!, "汉字层复用已内嵌的思源那份，零新增字节").toContain("noto-sans-sc-regular.woff2");
    // unicode-range 必须覆盖中文最常用的三段：CJK 标点 / 汉字基本区 / 全角形式
    for (const r of ["U+3000-303F", "U+4E00-9FFF", "U+FF00-FFEF"]) {
      expect(cjk, `unicode-range 要含 ${r}`).toContain(r);
    }
    // ⚠️ 反向闸：不许把 ASCII 也圈进汉字层（那样拉丁字母会变成思源黑体，等宽就没了）。
    // 必须排在正向断言之后。
    expect(cjk).not.toContain("U+0000-007F");
    expect(cjk).not.toContain("U+0020-007E");
  });

  it(":root 的正文/代码/界面三条栈，首项都是内嵌那款；--font-mono 不挂内嵌", () => {
    const root = global.match(/:root\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(root, "应能截到 :root").toBeTruthy();
    // 反例在前：--font-mono 是第二回落，它的**首项**不该是内嵌那份 ——
    // 一旦正文/代码两条栈解析不出就立刻落到它，字面会变回等宽观感（正文≠等宽）。
    // （栈里第三项仍保留 Cascadia Mono：那是 B225 起的系统回落，不动。）
    const monoDecl = (root.match(/--font-mono:\s*([^;]+);/)?.[1] ?? "").trim();
    expect(monoDecl.split(",")[0].trim(), "--font-mono 首项不该是内嵌等宽那份").not.toBe(
      '"Cascadia Mono"',
    );
    expect(root, "正文栈 --font-body 要在，且首项是内嵌思源黑体").toMatch(
      /--font-body:[^;]*"Noto Sans SC"/,
    );
    expect(root, "代码栈 --font-code 要在，且首项是内嵌 Cascadia Mono").toMatch(
      /--font-code:[^;]*"Cascadia Mono"/,
    );
    expect(root, "界面栈 --font-ui 首项是内嵌思源黑体").toMatch(/--font-ui:[^;]*"Noto Sans SC"/);
  });

  it("三个消费点各取各的：源码区与预览代码走 --font-code，预览正文走 --font-body", () => {
    // B231 口径：源码区归**代码字体**（源码是代码），预览正文归**正文字体**。
    // CM6 那条规则末尾那份 --font-mono 是第二回落
    expect(global, "CM6 源码区要走 var(--font-code), var(--font-mono)").toContain(
      "font-family: var(--font-code), var(--font-mono);",
    );
    // --font-editor 是 B227 的中转名，B231 已删：正文字体直接写 --font-body
    expect(global, "--font-editor 那层中转已作废，不该再出现").not.toContain("--font-editor");
    // 预览正文：正文字体
    const mdBlock = preview.match(/\.md-preview \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(mdBlock, "应能截到 .md-preview 块").toBeTruthy();
    expect(mdBlock, "预览正文必须读 --font-body（正文字体）").toMatch(
      /font-family: var\(--font-body,/,
    );
    // 代码块：与源码区同一项（凡是代码一律等宽）
    const codeBlock = preview.match(/\.md-preview code \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(codeBlock, "应能截到 .md-preview code 块").toBeTruthy();
    expect(codeBlock, "代码块必须读 --font-code（与源码区同一项）").toMatch(
      /font-family: var\(--font-code,/,
    );
    // 退化形态：把代码块写死 Consolas（就是 B227 之前那版）
    expect(preview, "代码块不许写死字体栈").not.toMatch(
      /\.md-preview code \{[^}]*font-family: Consolas/,
    );
  });

  it("界面文字不跟用户设置走（用户裁决：标签栏/菜单/状态栏保持不可配）", () => {
    // --font-ui 是 :root 里的写死栈，不接受任何内联覆盖。
    // 契约盯两处：①全局消费点不许读 --font-body；②applyFontFamily 只写 --font-body。
    const src = readFileSync("src/appearance.ts", "utf-8");
    const body = stripLineComments(topLevelFnBody(src, "applyFontFamily"));
    // 反向闸在前
    expect(body, "界面栈 --font-ui 不许被用户设置覆盖").not.toContain("--font-ui");
    expect(body, "正文字体只写 --font-body 一处").not.toContain("--font-code");
    // 界面那些规则仍读 --font-ui
    expect(global, "界面消费点应继续读 --font-ui").toMatch(/font-family: var\(--font-ui\)/);
  });
});

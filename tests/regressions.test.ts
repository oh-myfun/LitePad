// @vitest-environment jsdom
// 用户报告过的 bug 回归测试（静态断言版）。
// 约定：用户每报告一个 bug，修复时必须在此（或 smoke.bootstrap.test.ts）补对应用例。
// 这三个 bug 的根因都在配置/样式层，无法在运行时断言，故用文件内容断言防回归。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("用户报告过的 bug 回归（静态配置断言）", () => {
  it("关闭窗口/最后一个面板不报 ACL 错误：capabilities 必须授予 window close/destroy", () => {
    // 用户报告：unhandledrejection: Command plugin:window|destroy not allowed by ACL。
    // onCloseRequested 未 preventDefault 时内部调 destroy()，缺权限则关闭窗口报错。
    const cap = readJson("src-tauri/capabilities/default.json");
    const perms: string[] = cap.permissions ?? [];
    expect(perms, "必须包含 core:window:allow-close").toContain(
      "core:window:allow-close",
    );
    expect(perms, "必须包含 core:window:allow-destroy").toContain(
      "core:window:allow-destroy",
    );
  });

  it("文件拖入窗口必须能拿到路径打开：dragDropEnabled 必须为 true", () => {
    // 用户报告：拖文件进窗口应打开文件而不是把内容插进当前文档。
    // 拿到拖入文件真实路径的唯一方式是 WebView2 原生拖放（dragDropEnabled: true
    // + onDragDropEvent 的 drop.paths）。代价是页面内 HTML5 DnD 失效——
    // 因此标签拖拽已改为 mousedown/mousemove/mouseup 指针编排（见 splitview.ts）。
    const conf = readJson("src-tauri/tauri.conf.json");
    const win = (conf.app?.windows ?? []).find(
      (w: { label?: string }) => w.label === "main",
    );
    expect(win, "tauri.conf.json 应有 main 窗口配置").toBeTruthy();
    expect(win.dragDropEnabled, "dragDropEnabled 必须为 true").toBe(true);
  });

  it("标签拖拽必须是指针事件编排：tabstrip 不得再依赖 HTML5 draggable", () => {
    // dragDropEnabled: true 后页面内 HTML5 DnD 全部失效，
    // tabstrip 若残留 draggable=true / dragstart 依赖，标签拖拽会静默死亡。
    const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
    expect(ts.includes("draggable = true"), "不得设置 el.draggable").toBe(false);
    expect(ts.includes('addEventListener("dragstart"'), "不得监听 dragstart").toBe(false);
    expect(ts.includes("beginTabDrag"), "必须走指针拖拽（beginTabDrag）").toBe(true);
    const sv = readFileSync("src/shell/splitview.ts", "utf-8");
    expect(sv.includes("getCurrentWebview"), "splitview 不得处理文件拖放（归 main.ts 原生通道）").toBe(false);
    expect(sv.includes('addEventListener("drop"'), "面板不得再挂 HTML5 drop 处理器").toBe(false);
  });

  it("编辑器必须可滚动：.panel-editor 须 min-height:0 且 cm-scroller 双轴 overflow（回归：源码无法滚动）", () => {
    // 用户报告：只有 md 预览能看到滚动条，其他文本和源码既无滚动条也无法滚动。
    // 根因：flex 项的 min-height:auto = 内容高度（滚动容器才豁免为 0）——
    // .panel-editor 缺 min-height:0 时被整篇文档撑开、被 .panel-host 裁掉。
    const css = readFileSync("src/styles/preview.css", "utf-8");
    const editorBlock = css.match(/\.panel-host \.panel-editor \{[^}]*\}/)?.[0] ?? "";
    expect(editorBlock, ".panel-editor 必须允许收缩（min-height: 0）").toContain(
      "min-height: 0",
    );
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
    expect(block![0], ".layout-panel 必须包含 position: relative").toMatch(
      /position:\s*relative/,
    );
  });
});

describe("行号 gutter 主题化与折叠图标（用户反馈：随深浅色变化 + 图标优化）", () => {
  it("行号 gutter 必须走主题变量（深浅色切换联动，而非 CM 默认/oneDark 固定配色）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const block = css.match(/\.panel-host \.cm-editor \.cm-gutters\s*\{[^}]*\}/);
    expect(block, "应有 .cm-gutters 主题化规则").toBeTruthy();
    expect(block![0], "gutter 背景必须引用主题变量").toMatch(/var\(--/);
    expect(block![0], "gutter 文字色必须引用主题变量").toMatch(/color:\s*var\(--/);
  });

  it("折叠图标必须是自定义 SVG 标记（open/closed 形态不同，颜色走 CSS 变量）", async () => {
    const { foldMarkerDOM } = await import("../src/editor/editor");
    const open = foldMarkerDOM(true);
    const closed = foldMarkerDOM(false);
    for (const [name, el] of [["open", open], ["closed", closed]] as const) {
      expect(el.className, `${name} 应带 cm-fold-marker 类`).toContain("cm-fold-marker");
      expect(el.querySelector("svg"), `${name} 应为内联 SVG 图标`).toBeTruthy();
    }
    expect(open.innerHTML, "展开/折叠两种形态的图标应不同").not.toBe(closed.innerHTML);
  });

  it("大纲 TOC 必须走全局主题变量（回归：--md-* 作用域在 .md-preview 内，TOC 不随深浅色变化）", () => {
    // TOC 是 #main-row 下的顶层 aside，不在 .md-preview 内——
    // --panel-bg/--md-code-bg/--md-link/--md-muted 在该作用域全部未定义，
    // var() 永远落到浅色 fallback → 深色主题下大纲仍是浅色。
    const preview = readFileSync("src/styles/preview.css", "utf-8");
    const panel = preview.match(/\/\* 大纲 TOC[^*]*\*\/\s*\.toc-panel\s*\{[^}]*\}/)?.[0] ?? "";
    expect(panel, "应有 .toc-panel 规则块").toBeTruthy();
    expect(panel, "TOC 面板背景必须用全局变量 --bg-elevated").toContain("var(--bg-elevated");
    expect(panel, "不得再引用未定义的 --panel-bg").not.toContain("--panel-bg");
    const hover = preview.match(/\.toc-item:hover\s*\{[^}]*\}/)?.[0] ?? "";
    expect(hover, "TOC hover 必须用 --bg-hover").toContain("var(--bg-hover");
    const active = preview.match(/\.toc-item\.toc-active\s*\{[^}]*\}/)?.[0] ?? "";
    expect(active, "TOC 活动项必须用 --accent").toContain("var(--accent");
    const empty = preview.match(/\.toc-empty\s*\{[^}]*\}/)?.[0] ?? "";
    expect(empty, "TOC 空态必须用 --fg-muted").toContain("var(--fg-muted");
    const g = readFileSync("src/styles/global.css", "utf-8");
    expect(g, "global.css 不得残留未定义的 --bg-panel 引用").not.toContain("--bg-panel");
  });

  it("窗口标题软件名在前、文件名在后（用户要求）", () => {
    const src = readFileSync("src/main.ts", "utf-8");
    expect(src, "标题格式应为 LitePad - 文件名").toContain("`LitePad - ${doc.name}${mark}${suffix}`");
    expect(src, "不得再使用「文件名 - LitePad」格式").not.toContain("${text} - LitePad");
  });

  it("悬浮查找栏必须挂在应用根、且不随标签/面板切换关闭（用户要求）", () => {
    // 用户要求：查找/替换用一个悬浮栏，不绑定文件/面板——切换文件/面板不自动消失。
    const src = readFileSync("src/main.ts", "utf-8");
    expect(src, "必须挂到 #app（应用级浮层），不能挂在面板里").toContain(
      'createFindBar(el("app")',
    );
    // 切换标签（switchTab）与切换活动面板都要重新把查询应用到新视图，而不是关闭浮层
    expect(src, "切换标签后必须重新定位查找查询").toContain("retargetFindBar()");
    const switchBody = src.match(/function switchTab\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(switchBody, "switchTab 末尾必须调 retargetFindBar").toContain("retargetFindBar()");
    const barSrc = readFileSync("src/shell/findbar.ts", "utf-8");
    expect(barSrc, "查找栏不得自行监听标签切换而关闭").not.toContain("switchTab");
    expect(barSrc, "关闭只应由 close/Esc/× 触发").toContain("function close(): void");
  });

  it("非编辑操作不得改动文件：只有文本真变化才置脏/写盘（用户要求）", () => {
    // 用户反馈：切换 Markdown 预览/源码、或点击内容区，不应该改变文件内容。
    // 根因防线有三条，缺一条就会"没编辑却被自动保存改写磁盘文件"：
    const src = readFileSync("src/main.ts", "utf-8");
    const handler = src.match(/function handleUpdate\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(handler, "应有 handleUpdate").toBeTruthy();
    // ① docChanged 不等于"内容变了"——要比较前后文本
    expect(handler, "必须比较事务前后文本").toContain("const textChanged =");
    // ② 自动保存只能在内容真的变化时排程（单纯移动光标不写盘）
    expect(handler, "自动保存必须挂在文本变化上").toContain(
      "if (textChanged && !suppressDirty) scheduleAutosave()",
    );
    expect(handler, "选区变化不应触发自动保存").not.toContain("if (!suppressDirty) {\n    scheduleAutosave();");
    // ③ 切换视图隐藏/恢复编辑器时 CM6 可能产生事务——整个切换过程抑制置脏
    const toggle = src.match(/function toggleViewMode\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(toggle, "切换视图必须抑制置脏").toContain("suppressDirty = true;");
  });

  it("标签区不显示滚动条：溢出折叠为下拉按钮 + 滚轮切换区间（用户要求）", () => {
    // 用户要求：tab 区不显示滚动条；超出宽度的标签折叠成一个下拉按钮；
    // 滚轮调节显示的标签区间，左右两侧超出的都进下拉列表。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const strip = css.match(/\.panel-tabstrip\s*\{[^}]*\}/)?.[0] ?? "";
    expect(strip, "应有 .panel-tabstrip 规则").toBeTruthy();
    expect(strip, "标签区不得再横向滚动（不再出现滚动条）").not.toContain("overflow-x: auto");
    expect(strip, "标签区应为 overflow: hidden").toContain("overflow: hidden");

    const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
    expect(ts, "必须有折叠下拉按钮").toContain("tab-more");
    expect(ts, "必须挂载滚轮切换").toContain('addEventListener("wheel"');
    expect(ts, "滚轮需用 passive:false 才能 preventDefault").toContain("passive: false");
    expect(ts, "Ctrl+滚轮要让位给字号缩放").toContain("if (e.ctrlKey) return;");
    expect(ts, "左右两侧溢出的标签都要进列表").toContain("tabs.slice(0, start)");
    expect(ts, "右侧溢出同样要进列表").toContain("tabs.slice(start + count)");
  });

  it("Ctrl+滚轮缩放字号，且预览随之缩放（用户要求）", () => {
    // 用户要求：Ctrl+滚轮调字号，预览内容也要跟着变。
    const src = readFileSync("src/main.ts", "utf-8");
    expect(src, "必须挂载滚轮缩放").toContain("attachWheelZoom(");
    const zoom = readFileSync("src/shell/zoom.ts", "utf-8");
    expect(zoom, "只响应 Ctrl+滚轮").toContain("if (!e.ctrlKey) return;");
    expect(zoom, "必须 preventDefault 阻断 WebView2 整页缩放").toContain("e.preventDefault()");
    expect(zoom, "必须用 passive:false 注册，否则 preventDefault 无效").toContain("passive: false");

    // 预览字号不能再写死：必须跟随 --font-size（导出 HTML 只注入 preview.css，故需兜底）
    const css = readFileSync("src/styles/preview.css", "utf-8");
    const root = css.match(/\.md-preview\s*\{[^}]*\}/)?.[0] ?? "";
    expect(root, "应有 .md-preview 规则").toBeTruthy();
    expect(root, "预览字号必须跟随 --font-size").toContain("var(--font-size");
    expect(root, "导出场景缺少 :root，需要 14px 兜底").toContain("var(--font-size, 14px)");
    expect(root, "预览字号不得再写死 15px").not.toMatch(/font-size:\s*15px/);
    // 代码块用 em 才会跟随缩放
    const pre = css.match(/\.md-preview pre\.md-code[\s\S]*?\}/)?.[0] ?? "";
    expect(pre, "代码块字号必须用 em 跟随缩放").toMatch(/font-size:\s*[\d.]+em/);
  });

  it("滚动条必须全应用统一且随深浅色联动（用户要求）", () => {
    // 用户报告：滚动条样式与界面不统一，且不跟随深浅色。
    // WebView2 默认滚动条走 Windows 系统样式 → 深色界面里是一条浅色亮条。
    // 统一方案：轨道透明 + thumb 走 --sb-* 变量（两个主题各一套），全局生效。
    const g = readFileSync("src/styles/global.css", "utf-8");
    const dark = g.match(/:root\[data-theme="dark"\]\s*\{[^}]*\}/)?.[0] ?? "";
    const light = g.match(/:root\[data-theme="light"\]\s*\{[^}]*\}/)?.[0] ?? "";
    expect(dark, "应有深色主题变量块").toBeTruthy();
    expect(light, "应有浅色主题变量块").toBeTruthy();

    for (const [name, block] of [
      ["深色", dark],
      ["浅色", light],
    ] as const) {
      expect(block, `${name}主题必须定义 --sb-thumb`).toContain("--sb-thumb:");
      expect(block, `${name}主题必须定义 --sb-thumb-hover`).toContain("--sb-thumb-hover:");
      expect(block, `${name}主题应声明 color-scheme（原生控件跟随主题）`).toContain(
        "color-scheme:",
      );
    }
    // 两套主题取值必须不同，否则等于没跟随主题
    const darkThumb = /--sb-thumb:\s*([^;]+);/.exec(dark)?.[1]?.trim();
    const lightThumb = /--sb-thumb:\s*([^;]+);/.exec(light)?.[1]?.trim();
    expect(darkThumb).toBeTruthy();
    expect(lightThumb).toBeTruthy();
    expect(darkThumb, "深浅色的滚动条滑块颜色必须不同").not.toBe(lightThumb);

    // 全局生效：标准属性 + Chromium 的 webkit 伪元素双写
    expect(g, "必须有全局 scrollbar-width: thin").toMatch(/\*\s*\{[^}]*scrollbar-width:\s*thin/);
    expect(g, "scrollbar-color 必须走变量（不能写死颜色）").toContain(
      "scrollbar-color: var(--sb-thumb) transparent",
    );
    const thumb = g.match(/::-webkit-scrollbar-thumb\s*\{[^}]*\}/)?.[0] ?? "";
    expect(thumb, "应有 ::-webkit-scrollbar-thumb 规则").toBeTruthy();
    expect(thumb, "滑块颜色必须引用 --sb-thumb 变量").toContain("var(--sb-thumb");
    expect(thumb, "滑块不得写死十六进制颜色").not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(g, "必须去掉滚动条两端箭头按钮").toMatch(
      /::-webkit-scrollbar-button\s*\{[^}]*display:\s*none/,
    );
  });

  it("大纲宽度可调节：分隔条元素、拖拽接线、设置字段三者齐全", () => {
    // 用户要求：大纲区域支持宽度调节。三处缺一即失效：
    // ① index.html 要有 #toc-resizer（缺则 main.ts 的 el() 直接抛错，启动白屏）
    // ② main.ts 要挂载 attachTocResizer 且收起大纲时同步隐藏分隔条
    // ③ 设置里要有 toc_width 字段（前端类型 + Rust 结构），否则宽度无法持久化
    const html = readFileSync("index.html", "utf-8");
    expect(html, "index.html 必须有 #toc-resizer 分隔条").toContain('id="toc-resizer"');

    const src = readFileSync("src/main.ts", "utf-8");
    expect(src, "bootstrap 必须挂载大纲分隔条").toContain("setupTocResizer()");
    expect(src, "挂载必须走 attachTocResizer").toContain("attachTocResizer(");
    expect(
      src,
      "收起/展开大纲时分隔条必须与面板同步显隐，否则留下 4px 死区",
    ).toContain("tocResizer.hidden = tocPanel.hidden");

    const css = readFileSync("src/styles/preview.css", "utf-8");
    const resizer = css.match(/\.toc-resizer\s*\{[^}]*\}/)?.[0] ?? "";
    expect(resizer, "应有 .toc-resizer 规则块").toBeTruthy();
    expect(resizer, "分隔条必须是左右调整光标").toContain("col-resize");
    // 旧样式把 min-width 写死为 240px，会挡住拖动变窄
    const panel = css.match(/\.toc-panel\s*\{[^}]*\}/)?.[0] ?? "";
    expect(panel, ".toc-panel 不得再写死 min-width: 240px").not.toContain("min-width: 240px");

    const api = readFileSync("src/ipc/api.ts", "utf-8");
    expect(api, "Settings 类型需要 toc_width 字段").toContain("toc_width: number");
    const rs = readFileSync("src-tauri/src/session/mod.rs", "utf-8");
    expect(rs, "Rust Settings 需要 toc_width 字段并给默认值").toContain("pub toc_width: f64");
    expect(rs, "默认宽度应为 240").toContain("toc_width: 240.0");
  });

  it("B28 大纲分隔条必须与分屏分割条同款（5px 常显 border 色 + hover accent，无双线）", () => {
    // 用户要求：大纲区分隔条样式与面板分割条保持一致。
    // 旧样式是 4px 透明细条，视觉上与 5px 常显 var(--border) 的 .layout-sep 不统一；
    // 且 .toc-panel 自带 border-right 会与常显分隔条叠成双线。
    const previewCss = readFileSync("src/styles/preview.css", "utf-8");
    const resizer = previewCss.match(/\.toc-resizer\s*\{[^}]*\}/)?.[0] ?? "";
    expect(resizer, "应有 .toc-resizer 规则块").toBeTruthy();
    expect(resizer, "宽度必须与 .layout-sep 一致（5px）").toContain("flex: 0 0 5px");
    expect(resizer, "必须常显 border 色（与 .layout-sep 同款）").toContain(
      "background: var(--border)",
    );
    const highlight = previewCss.match(/\.toc-resizer:hover,\s*body\.layout-dragging \.toc-resizer\s*\{[^}]*\}/)?.[0] ?? "";
    expect(highlight, "悬停/拖拽高亮必须是 accent（允许带回退值）").toMatch(/var\(--accent[,\)]/);

    const globalCss = readFileSync("src/styles/global.css", "utf-8");
    const sep = globalCss.match(/\.layout-sep\s*\{[^}]*\}/)?.[0] ?? "";
    expect(sep, "分屏分割条基准样式应存在").toContain("flex: 0 0 5px");
    expect(sep, "分屏分割条基准色应为 var(--border)").toContain("background: var(--border)");

    const panel = previewCss.match(/\.toc-panel\s*\{[^}]*\}/)?.[0] ?? "";
    expect(panel, ".toc-panel 不得自带 border-right（与常显分隔条叠成双线）").not.toContain(
      "border-right",
    );
  });

  it("B30 查找栏必须可关闭（[hidden] 不得被 display:flex 覆盖）且预览态接线齐全", () => {
    // 用户报告：查找/替换悬浮条无法关闭。
    // 根因：.find-bar { display: flex } 覆盖了 hidden 属性的 UA 样式（display:none），
    // close() 置 dom.hidden=true 后浮层仍然可见。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const hiddenRule = css.match(/\.find-bar\[hidden\]\s*\{[^}]*\}/)?.[0] ?? "";
    expect(hiddenRule, "必须有 .find-bar[hidden] { display: none } 规则").toContain(
      "display: none",
    );
    expect(css, "查找行应有 flex 行布局（.find-row）").toMatch(/\.find-row\s*\{[^}]*display:\s*flex/);

    // 预览态查找接线：高亮应用、重放、步进、清除
    const main = readFileSync("src/main.ts", "utf-8");
    expect(main, "applyFindQuery 必须同步预览高亮").toContain("applyPreviewFindEverywhere(q)");
    expect(main, "重渲染后必须重放预览高亮").toMatch(
      /renderMarkdownFor[\s\S]{0,600}?applyPreviewFindToPanel\(panel, findSpecOf\(findBar\.getQuery\(\)\)\)/,
    );
    expect(main, "clearFindHighlight 必须同时清预览高亮").toMatch(
      /clearFindHighlight[\s\S]{0,200}?applyFind\(null\)/,
    );
    expect(main, "stepFind 必须有预览分支（在预览高亮里步进）").toMatch(
      /stepFind[\s\S]{0,400}?viewMode === "preview" && panel\.preview/,
    );
    const preview = readFileSync("src/markdown/preview.ts", "utf-8");
    expect(preview, "PreviewPane 必须提供 applyFind/stepFind/findState").toMatch(
      /applyFind\(|stepFind\(|findState\(/,
    );
    expect(preview, "预览命中必须复用编辑器高亮样式类").toContain('cm-find-match');
  });

  it("B31 转到行必须顶部对齐（与大纲跳转一致，不得最小滚动贴底）", () => {
    const src = readFileSync("src/main.ts", "utf-8");
    // 转到行 overlay（.goto-overlay 所在函数链）里的跳转必须用 y:"start"
    const gotoIdx = src.indexOf('overlay.className = "goto-overlay"');
    expect(gotoIdx, "goto overlay 应存在").toBeGreaterThan(0);
    const region = src.slice(gotoIdx, gotoIdx + 4000);
    expect(region, "转到行跳转必须 y:start 顶部对齐").toContain(
      'EditorView.scrollIntoView(pos, { y: "start", yMargin: 0 })',
    );
    expect(region, "转到行不得再用最小滚动的 scrollIntoView:true").not.toContain(
      "scrollIntoView: true",
    );
  });

  it("B25/B34 应用图标四角圆角必须一致（矢量自绘，非镜像修角）", () => {
    // B25 用户报告：图标下边缘接近直角、上边缘是大圆角。
    // B34 用户要求：改名 LitePad 并重绘图标，背景四角全部圆角。
    // 修复：scripts/gen_icons.py 改为矢量自绘——圆角矩形 rounded_rectangle
    // 一次成型（四角半径天然一致），不再依赖 AI 源图与镜像修角。
    const gen = readFileSync("scripts/gen_icons.py", "utf-8");
    expect(gen, "必须用 rounded_rectangle 保证四角圆角一致").toMatch(
      /rounded_rectangle\(/,
    );
    expect(gen, "背景必须是渐变（蓝→青）").toMatch(
      /2563EB[\s\S]{0,600}06B6D4|06B6D4[\s\S]{0,600}2563EB/,
    );
    expect(gen, "不得再依赖 AI 源图（B25 镜像方案已废弃）").not.toContain(
      "icon_final.png",
    );
    expect(gen, "ico 必须包含多尺寸（任务栏/资源管理器清晰）").toMatch(/ICO_SIZES/);
    const conf = readJson("src-tauri/tauri.conf.json");
    const icons: string[] = conf.bundle?.icon ?? [];
    expect(
      icons.some((i) => i.includes("icon.ico")),
      "bundle.icon 必须含 icon.ico（exe/安装包图标来源）",
    ).toBe(true);
  });

  it("B34 应用更名为 LitePad 后不得有 LiteMD 残留", () => {
    // 用户报告：应用名改为 LitePad。源码（src + index.html + 配置 + Rust）
    // 中的 LiteMD/litemd 必须全部替换（gen/schemas 与 target 由构建再生，不查）。
    for (const f of [
      "index.html",
      "package.json",
      "src-tauri/tauri.conf.json",
      "src-tauri/Cargo.toml",
      "src/main.ts",
      "src/shell/menubar.ts",
      "src/markdown/exporter.ts",
      "src/shell/findbar.ts",
      "src/theme/theme.ts",
      "src-tauri/src/session/mod.rs",
      "src-tauri/src/commands/mod.rs",
    ]) {
      const text = readFileSync(f, "utf-8");
      expect(text, `${f} 不得含 LiteMD/litemd 残留`).not.toMatch(
        /[Ll]ite[Mm][Dd]/,
      );
    }
    const conf = readJson("src-tauri/tauri.conf.json");
    expect(conf.productName, "productName 必须是 LitePad").toBe("LitePad");
    expect(conf.identifier, "identifier 必须是 com.litepad.app").toBe(
      "com.litepad.app",
    );
    const pkg = readJson("package.json");
    expect(pkg.name, "package.json name 必须是 litepad").toBe("litepad");
  });
});

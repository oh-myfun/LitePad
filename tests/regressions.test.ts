// @vitest-environment jsdom
// 用户报告过的 bug 回归测试（静态断言版）。
// 约定：用户每报告一个 bug，修复时必须在此（或 smoke.bootstrap.test.ts）补对应用例。
// 这三个 bug 的根因都在配置/样式层，无法在运行时断言，故用文件内容断言防回归。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { extname, join } from "node:path";

// JSON 配置结构松散（tauri.conf/package.json 各异），此处刻意放宽：
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

// 断样式规则时先剥掉注释：注释里常写「旧值是什么」（如 flex: 0 1 auto），
// 不剥离的话 not.toMatch 会被自己的文档误伤。
function cssDecls(block: string): string {
  return block.replace(/\/\*[\s\S]*?\*\//g, "");
}

// B57 文件类型图标的 10 个家族（与 src/shell/fileicons.ts 的 FileFamily 一一对应）
const FILE_FAMILIES = [
  "md",
  "code",
  "brace",
  "hash",
  "tag",
  "brk",
  "db",
  "diff",
  "build",
  "txt",
] as const;

// 全仓库文本文件枚举（B36 改名残留检查用）：跳过构建产物 / 依赖 / 二进制。
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "target",
  "gen",
  ".git",
  "generated-images",
  ".vite",
]);
const BINARY_EXT = new Set([
  ".png",
  ".jpg",
  ".ico",
  ".exe",
  ".woff",
  ".woff2",
  ".ttf",
  ".pdf",
  ".zip",
]);
function collectTextFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) collectTextFiles(p, acc);
    } else if (!BINARY_EXT.has(extname(e.name).toLowerCase())) {
      acc.push(p);
    }
  }
  return acc;
}

describe("用户报告过的 bug 回归（静态配置断言）", () => {
  it("关闭窗口/最后一个面板不报 ACL 错误：capabilities 必须授予 window close/destroy", () => {
    // 用户报告：unhandledrejection: Command plugin:window|destroy not allowed by ACL。
    // onCloseRequested 未 preventDefault 时内部调 destroy()，缺权限则关闭窗口报错。
    const cap = readJson("src-tauri/capabilities/default.json");
    const perms: string[] = cap.permissions ?? [];
    expect(perms, "必须包含 core:window:allow-close").toContain("core:window:allow-close");
    expect(perms, "必须包含 core:window:allow-destroy").toContain("core:window:allow-destroy");
  });

  it("文件拖入窗口必须能拿到路径打开：dragDropEnabled 必须为 true", () => {
    // 用户报告：拖文件进窗口应打开文件而不是把内容插进当前文档。
    // 拿到拖入文件真实路径的唯一方式是 WebView2 原生拖放（dragDropEnabled: true
    // + onDragDropEvent 的 drop.paths）。代价是页面内 HTML5 DnD 失效——
    // 因此标签拖拽已改为 mousedown/mousemove/mouseup 指针编排（见 splitview.ts）。
    const conf = readJson("src-tauri/tauri.conf.json");
    const win = (conf.app?.windows ?? []).find((w: { label?: string }) => w.label === "main");
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
    expect(
      sv.includes("getCurrentWebview"),
      "splitview 不得处理文件拖放（归 main.ts 原生通道）",
    ).toBe(false);
    expect(sv.includes('addEventListener("drop"'), "面板不得再挂 HTML5 drop 处理器").toBe(false);
  });

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
    for (const [name, el] of [
      ["open", open],
      ["closed", closed],
    ] as const) {
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
    expect(src, "标题格式应为 LitePad - 文件名").toContain(
      "`LitePad - ${doc.name}${mark}${suffix}`",
    );
    expect(src, "不得再使用「文件名 - LitePad」格式").not.toContain("${text} - LitePad");
  });

  it("悬浮查找栏必须挂在应用根、且不随标签/面板切换关闭（用户要求）", () => {
    // 用户要求：查找/替换用一个悬浮栏，不绑定文件/面板——切换文件/面板不自动消失。
    const src = readFileSync("src/main.ts", "utf-8");
    expect(src, "必须挂到 #app（应用级浮层），不能挂在面板里").toContain('createFindBar(el("app")');
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
    expect(handler, "选区变化不应触发自动保存").not.toContain(
      "if (!suppressDirty) {\n    scheduleAutosave();",
    );
    // ③ 切换视图隐藏/恢复编辑器时 CM6 可能产生事务——整个切换过程抑制置脏
    const toggle = src.match(/function toggleViewMode\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(toggle, "切换视图必须抑制置脏").toContain("suppressDirty = true;");
  });

  it("B53 标签区改为横向滚动（折叠机制已整体移除，用户要求）", () => {
    // 用户要求：去掉 tab 折叠功能，保留滚动能力，参考 VS Code 优化。
    // 旧实现是「不显示滚动条 + 溢出的标签折叠进下拉按钮」——那套机制已删除，
    // 连同它需要的 ResizeObserver 重算 / tabId 重对齐 / 预算铺满三条不变量。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const strip = css.match(/\.panel-tabstrip\s*\{[^}]*\}/)?.[0] ?? "";
    expect(strip, "应有 .panel-tabstrip 规则").toBeTruthy();
    expect(strip, "标签区必须可横向滚动").toContain("overflow-x: auto");
    // 细滚动条由 ::-webkit-scrollbar 自绘。⚠️ B54 踩坑：元素上写了 scrollbar-width /
    // scrollbar-color（标准属性）后 Chromium 会**忽略** ::-webkit-scrollbar，标签栏
    // 会拿回系统滚动条（两端带箭头、也压不细）→ 必须复位成 auto，见下面 B54 用例。
    expect(css, "标签栏滚动条必须自绘且很细").toMatch(
      /\.panel-tabstrip::-webkit-scrollbar\s*\{[^}]*height:\s*[1-4]px/,
    );
    expect(strip, "标签永不换行（VS Code）").toContain("flex-wrap: nowrap");
    expect(css, "折叠按钮的样式必须整体删除").not.toContain("tab-more");

    const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
    expect(ts, "折叠机制必须整体删除（含下拉列表构造）").not.toContain("tab-more");
    expect(ts, "不应再按 tabId 重对齐可见窗口（原生滚动不需要）").not.toContain("reanchorStart");
    expect(ts, "不应再手写 ResizeObserver 重算可见区间").not.toContain("new ResizeObserver");
    expect(ts, "必须挂载滚轮滚动").toContain('addEventListener("wheel"');
    expect(ts, "滚轮需用 passive:false 才能 preventDefault").toContain("passive: false");
    expect(ts, "Ctrl+滚轮要让位给字号缩放").toContain("if (e.ctrlKey) return;");
    expect(ts, "全量重绘必须存取滚动位置，否则每次重绘都跳回最左").toContain(
      "const prevScroll = host.scrollLeft",
    );
    expect(ts, "必须把活动标签滚进可见区").toContain("ensureVisible(host");
    // 用 scrollIntoView 会连带滚动所有祖先容器（分屏/嵌套布局下整页跳），且 jsdom 没有它。
    // 只禁止**调用**（注释里提到它没关系），故匹配带接收者的调用式。
    expect(ts, "定位用自身几何而不是 scrollIntoView").not.toMatch(/\.scrollIntoView\(/);

    // 滚动条余量必须**恒定预留**：原生横向滚动条从内容区里切高度，
    // 不预留则「溢出↔不溢出」切换时标签栏 26↔28px 跳变，编辑器内容跟着抖
    expect(strip, "标签栏高度必须固定（含滚动条余量）").toMatch(/height:\s*\d+px/);
    const tabRule = css.match(/\n\.tab\s*\{[^}]*\}/)?.[0] ?? "";
    const stripH = Number(strip.match(/height:\s*(\d+)px/)![1]);
    const tabH = Number(tabRule.match(/height:\s*(\d+)px/)![1]);
    expect(stripH, "标签栏高度必须大于标签高度（差值即滚动条余量）").toBeGreaterThan(tabH);
  });

  it("B56 标签不收缩：宽度跟内容走，放不下就横向滚动（文件名不裁剪成「…」）", () => {
    // 用户反馈：标签变多后标签被压窄，文件名被裁剪成「…」。
    // 根因 = .tab 上的 flex-shrink:1（B53 的「先收缩再滚动」）+ .tab-name 的
    // text-overflow: ellipsis。B56 反过来：宽度 = 内容宽度，溢出交给横向滚动。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const tab = cssDecls(css.match(/\n\.tab\s*\{[^}]*\}/)?.[0] ?? "");
    expect(tab, "应有 .tab 规则").toBeTruthy();
    expect(tab, "标签必须不可收缩（flex-shrink:0），否则标签变多时宽度被压窄").toMatch(
      /flex:\s*0 0 auto/,
    );
    expect(tab, "不得再写 flex: 0 1 auto（那是会裁剪文本的可收缩行为）").not.toMatch(
      /flex:\s*0 1 auto/,
    );
    expect(tab, "不得再给标签设宽度上限，否则超长文件名仍会被截断").not.toMatch(/max-width/);
    expect(tab, "保留收缩下限当最小宽度（短名标签不至于窄成一条）").toMatch(/min-width:\s*\d+px/);

    const name = cssDecls(css.match(/\n\.tab-name\s*\{[^}]*\}/)?.[0] ?? "");
    expect(name, "应有 .tab-name 规则").toBeTruthy();
    expect(name, "文件名不得收缩").toMatch(/flex:\s*1 0 auto/);
    expect(name, "不得再用省略号裁剪文件名").not.toContain("text-overflow: ellipsis");
    expect(name, "不得再裁剪溢出（文件名必须整段可见）").not.toContain("overflow: hidden");
  });

  it("B57 ● 与 × 共用固定尺寸槽位，显隐走 opacity（对齐 VS Code 标签操作列）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const slot = cssDecls(css.match(/\n\.tab-action\s*\{[^}]*\}/)?.[0] ?? "");
    expect(slot, "应有 .tab-action 槽位规则").toBeTruthy();
    expect(slot, "槽位尺寸必须固定，否则悬停切换会改变标签宽度").toMatch(/width:\s*\d+px/);
    expect(slot).toMatch(/height:\s*\d+px/);

    // VS Code 标签操作列用 opacity 而不是 display 做显隐（经典档 multieditortabscontrol.css
    // 与 Modern UI 档 tabs.css 都是这套）：布局本来就被固定槽位锁住，
    // opacity 既能淡入，也不触发重排。
    const layer = cssDecls(css.match(/\.tab-mark,\s*\.tab-close\s*\{[^}]*\}/)?.[0] ?? "");
    expect(layer, "应有 .tab-mark / .tab-close 公共层规则").toBeTruthy();
    expect(layer, "默认必须隐藏（opacity: 0）").toMatch(/opacity:\s*0\b/);
    expect(layer, "不得再用 display 切换显隐").not.toMatch(/display:\s*none/);

    expect(css, "未保存的 ● 常驻显示").toMatch(/\.tab-dirty\s+\.tab-mark\s*\{[^}]*opacity:\s*1/);
    expect(css, "悬停标签显示 ×").toMatch(/\.tab:hover\s+\.tab-close[^{]*\{[^}]*opacity:\s*1/);
    expect(css, "活动标签常驻 ×（关闭当前文件是高频操作，不该先悬停）").toMatch(
      /\.tab-active\s+\.tab-close[^{]*\{[^}]*opacity:\s*1/,
    );
    expect(css, "悬停时 ● 让位给 ×（同槽位只显示一个）").toMatch(
      /\.tab:hover\s+\.tab-mark\s*\{[^}]*opacity:\s*0/,
    );
    expect(css, "× 颜色继承标签文字色（VS Code 做法，非独立灰）").toMatch(
      /\.tab-close\s*\{[^}]*color:\s*inherit/,
    );

    const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
    expect(ts, "未保存必须打 tab-dirty（CSS 靠它决定槽位状态）").toContain("tab-dirty");
    expect(ts, "× 必须用矢量图标（ICONS.close），不再是文本字形").toContain("ICONS.close");
    expect(ts, "不得再用文本 ×").not.toContain('textContent = "×"');
    expect(ts, "未保存圆点必须走矢量（dotIcon）").toContain("dotIcon()");
    expect(ts, "不得再用文本 ●").not.toContain('textContent = "●"');
  });

  it("B57 标签前置文件类型图标：家族字形 + 家族配色，且家族覆盖注册表全部语言", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const icon = cssDecls(css.match(/\n\.tab-icon\s*\{[^}]*\}/)?.[0] ?? "");
    expect(icon, "应有 .tab-icon 规则").toBeTruthy();
    expect(icon, "图标不得收缩（文件名变长不能把图标挤扁）").toMatch(/flex:\s*0 0 auto/);
    expect(icon, "图标固定 16px").toMatch(/width:\s*16px/);
    expect(icon, "非活动图标要跟着文字一起降透明度").toMatch(/opacity:\s*0\.75/);
    expect(css, "悬停/活动图标回到全不透明").toMatch(
      /\.tab-active\s+\.tab-icon\s*\{[^}]*opacity:\s*1/,
    );

    // 家族配色 = 10 个 data-fam 选择器 + 浅深两套 --ficon-* 变量。
    // 缺任意一处 → 某主题下该家族图标没有颜色（继承文字色，等于「图标丢了」）。
    const FAMILIES = FILE_FAMILIES;
    for (const fam of FAMILIES) {
      expect(css, `缺 .tab-icon[data-fam="${fam}"] 配色`).toContain(`.tab-icon[data-fam="${fam}"]`);
    }
    for (const [name, block] of [
      ["深色", css.match(/:root\[data-theme="dark"\]\s*\{[^}]*\}/)?.[0] ?? ""],
      ["浅色", css.match(/:root\[data-theme="light"\]\s*\{[^}]*\}/)?.[0] ?? ""],
    ] as const) {
      for (const fam of FAMILIES) {
        expect(block, `${name}主题缺 --ficon-${fam}`).toContain(`--ficon-${fam}:`);
      }
    }

    // 接线：tabstrip 建图标节点并带上 data-fam；main 把检测到的语言传下去。
    // 漏掉 lang 的话所有标签都会退化成 txt 图标（灰三条横线），是最容易静默发生的回归。
    const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
    expect(ts, "标签必须建 .tab-icon 节点").toContain('"tab-icon"');
    expect(ts, "图标必须带 data-fam（CSS 靠它取色）").toContain("data-fam");
    expect(ts, "图标必须来自 fileIconSvg").toContain("fileIconSvg(");
    const main = readFileSync("src/main.ts", "utf-8");
    expect(main, "main 必须把语言标签喂给标签视图数据").toMatch(/lang:\s*doc\?\.langLabel/);
  });

  it("B57 图标家族：覆盖语言注册表全部 label，未知语言回落 txt", async () => {
    const { familyOf, knownLabels, fileIconSvg } = await import("../src/shell/fileicons");
    const known = new Set(knownLabels());

    // 从 language.ts 抽出 REGISTRY 里的全部 label（未导出，只能静态抽）。
    const src = readFileSync("src/editor/language.ts", "utf-8");
    const reg = src.slice(
      src.indexOf("const REGISTRY"),
      src.indexOf("export interface LanguageInfo"),
    );
    const labels = [...reg.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(labels.length, "应当抽到语言注册表（数量级在 50+）").toBeGreaterThanOrEqual(50);
    const uncovered = labels.filter((l) => !known.has(l));
    expect(uncovered, `这些语言没有归属家族（会退化成 txt 图标）：${uncovered.join(", ")}`).toEqual(
      [],
    );

    // 抽样确认映射方向正确（覆盖度对不代表映射对）。
    expect(familyOf("Markdown")).toBe("md");
    expect(familyOf("TypeScript")).toBe("code");
    expect(familyOf("JSON")).toBe("brace");
    expect(familyOf("Python")).toBe("hash");
    expect(familyOf("HTML")).toBe("tag");
    expect(familyOf("Rust")).toBe("brk");
    expect(familyOf("SQL")).toBe("db");
    expect(familyOf("Diff")).toBe("diff");
    expect(familyOf("Dockerfile")).toBe("build");
    expect(familyOf("Plain Text")).toBe("txt");
    // 未知 / 空值必须落到 txt（新建未命名缓冲区的 langLabel 可能是 null）
    expect(familyOf(null)).toBe("txt");
    expect(familyOf("Klingon")).toBe("txt");

    // 字形必须是真 SVG（不是空串 / 占位文本），且每个家族各不相同。
    const svgs = FILE_FAMILIES.map((f) => fileIconSvg(f));
    for (let i = 0; i < svgs.length; i++) {
      expect(svgs[i], `家族 ${FILE_FAMILIES[i]} 的字形不能为空`).toContain("<svg");
    }
    expect(new Set(svgs).size, "十个家族应有十个不同字形").toBe(FILE_FAMILIES.length);
  });

  describe("B54/B55 面板按钮精简 + 标签药丸化（Modern UI）", () => {
    it("面板操作栏只剩「移除分屏」，分屏按钮已去掉（分屏仍走拖拽与菜单）", () => {
      const sv = readFileSync("src/shell/splitview.ts", "utf-8");
      expect(sv, "不得再用 ⨯ 文本字形").not.toContain('textContent = "⨯"');
      expect(sv, "必须保留移除分屏按钮").toContain("ICONS.closePanel");
      expect(sv, "不得再有左右分屏按钮").not.toContain("ICONS.splitH");
      expect(sv, "不得再有上下分屏按钮").not.toContain("ICONS.splitV");
      expect(sv, "面板渲染不得再调 onSplitPanel").not.toContain("onSplitPanel");

      // 删按钮 ≠ 删功能：菜单 / 快捷键的分屏入口必须还在（B53 之前就有）
      const main = readFileSync("src/main.ts", "utf-8");
      expect(main, "菜单左右分屏处理必须保留").toContain('splitActivePanel(activePanelId, "h")');
      expect(main, "菜单上下分屏处理必须保留").toContain('splitActivePanel(activePanelId, "v")');
      const km = readFileSync("src/shell/keymap.ts", "utf-8");
      expect(km, "分屏快捷键必须保留").toContain("panel.splitH");
      expect(km, "分屏快捷键必须保留").toContain("panel.splitV");
    });

    it("B55：标签改成 Modern UI 药丸（无描边、圆角 4px、非活动文字 50%）", () => {
      const css = readFileSync("src/styles/global.css", "utf-8");
      const tab = css.match(/\n\.tab\s*\{[^}]*\}/)?.[0] ?? "";
      expect(tab, "应有 .tab 规则").toBeTruthy();
      const h = tab.match(/height:\s*(\d+)px/);
      expect(h, "标签高度必须显式给出（字号档位变化时栏高才恒定）").toBeTruthy();
      expect(Number(h![1]), "药丸高 24px（VS Code Modern UI 常规档）").toBeLessThanOrEqual(26);
      expect(tab, "药丸必须无描边（B54 的 1px 描边是旧观感）").toMatch(/border:\s*none/);
      expect(tab, "药丸圆角 4px").toMatch(/border-radius:\s*4px/);
      expect(tab, "不得退回上圆角方标签").not.toContain("6px 6px 0 0");
      expect(tab, "非活动文字降到 50% 前景（VS Code color-mix 写法）").toMatch(
        /color:\s*color-mix\(in srgb, var\(--fg\) 50%, transparent\)/,
      );

      const active = css.match(/\n\.tab-active\s*\{[^}]*\}/)?.[0] ?? "";
      expect(active, "活动标签只靠药丸底色区分").toContain("var(--tab-bg-active)");
      expect(active, "活动标签不得再有描边").not.toContain("border");

      const hover = css.match(/\.tab:hover:not\(\.tab-active\)\s*\{[^}]*\}/)?.[0] ?? "";
      expect(hover, "悬停要有独立一档底色").toContain("var(--tab-bg-hover)");

      // 三档底色两套主题都要齐：缺一个就是某个主题下某状态完全没有反馈
      for (const [name, block] of [
        ["深色", css.match(/:root\[data-theme="dark"\]\s*\{[^}]*\}/)?.[0] ?? ""],
        ["浅色", css.match(/:root\[data-theme="light"\]\s*\{[^}]*\}/)?.[0] ?? ""],
      ] as const) {
        for (const v of ["--tab-bg-hover:", "--tab-bg-active:", "--tab-bg-active-hover:"]) {
          expect(block, `${name}主题必须定义 ${v}`).toContain(v);
        }
      }

      // tab-flash 结束态必须回到药丸底色。写 var(--bg) 会「闪完变回旧配色」——
      // 一帧的视觉 bug，运行时测不出来，只能静态锁死。
      const flash = css.match(/@keyframes tab-flash\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
      expect(flash, "应有 tab-flash 关键帧").toBeTruthy();
      expect(flash, "结束态必须回到药丸底色").toContain("background: var(--tab-bg-active)");
      expect(flash, "关键帧不得再引用旧配色 var(--bg)").not.toContain("var(--bg))");
    });

    it("B55：标签栏滚动条 4px，正好塞进药丸行下方那 4px 间隙", () => {
      const css = readFileSync("src/styles/global.css", "utf-8");
      const strip = css.match(/\n\.panel-tabstrip\s*\{[^}]*\}/)?.[0] ?? "";
      expect(strip, "应有 .panel-tabstrip 规则").toBeTruthy();
      // 关键坑：元素上指定 scrollbar-width/color 后 Chromium 会忽略 ::-webkit-scrollbar，
      // 标签栏就拿回系统滚动条（两端带箭头、压不细）。必须复位成 auto。
      expect(strip, "scrollbar-width 必须复位为 auto").toMatch(/scrollbar-width:\s*auto/);
      expect(strip, "scrollbar-color 必须复位为 auto").toMatch(/scrollbar-color:\s*auto/);
      expect(strip, "药丸之间要有 4px 间距").toMatch(/gap:\s*4px/);
      expect(strip, "下内边距为 0（下方 4px 让给滚动条）").toMatch(/padding:\s*4px 4px 0/);

      const thin = css.match(/\.panel-tabstrip::-webkit-scrollbar\s*\{[^}]*\}/)?.[0] ?? "";
      expect(thin, "必须有 webkit 滚动条规则").toBeTruthy();
      const bar = Number(thin.match(/height:\s*(\d+)px/)?.[1]);
      expect(bar, "滚动条 4px").toBe(4);

      const btn = css.match(/\.panel-tabstrip::-webkit-scrollbar-button\s*\{[^}]*\}/)?.[0] ?? "";
      expect(btn, "必须显式去掉两端箭头按钮").toBeTruthy();
      expect(btn, "箭头按钮必须 display:none").toMatch(/display:\s*none/);

      // 几何自洽：32 = 4(上间距) + 24(药丸) + 4(滚动条)。三个数绑在一起，
      // 改一个必须改全部，否则滚动条会压到药丸上（或药丸行被挤下去）。
      const tabH = Number(css.match(/\n\.tab\s*\{[^}]*\}/)![0].match(/height:\s*(\d+)px/)![1]);
      const stripH = Number(strip.match(/height:\s*(\d+)px/)![1]);
      expect(stripH - tabH, "药丸行上下各留 4px，滚动条正好吃下面那 4px").toBe(bar * 2);

      // 拖拽插入线必须跟着药丸行走，且让开滚动条那 4px（B55 计划的头号雷点）
      const insert = css.match(/\.tab-insert\s*\{[^}]*\}/)?.[0] ?? "";
      expect(insert, "拖拽插入线必须与药丸行等高").toMatch(/top:\s*4px/);
      expect(insert, "拖拽插入线必须让开滚动条").toMatch(/bottom:\s*4px/);
    });

    it("分隔条：视觉细线 + 更宽命中区（原先 5px 可视条兼当命中区，容易抓空）", () => {
      const css = readFileSync("src/styles/global.css", "utf-8");
      const sep = css.match(/\n\.layout-sep\s*\{[^}]*\}/)?.[0] ?? "";
      expect(sep, "应有 .layout-sep 规则").toBeTruthy();
      // B60：分隔条本身改为**不占布局**（flex 基准 0）—— 原先 7px 的透明占位会撑开
      // 两侧内容、露出祖先底色，视觉上就是一条粗带；命中区搬到 ::before 向两侧溢出。
      expect(sep, "分隔条不得占布局宽度").toMatch(/flex:\s*0 0 0/);
      const m = css.match(/\.layout-sep-h::before\s*\{[^}]*width:\s*(\d+)px/);
      expect(m, "命中区宽度必须显式给出").toBeTruthy();
      expect(Number(m![1]), "命中区至少 7px（原先是 5px 兼当视觉条）").toBeGreaterThanOrEqual(7);
      expect(css, "悬停高亮落在伪元素上").toMatch(/\.layout-sep:hover::after/);
      expect(css, "细线由伪元素画").toMatch(/\.layout-sep-h::after\s*\{/);
    });

    it("焦点面板：非活动分屏的活动标签降亮度；class 必须实时同步且不重建 DOM", () => {
      const css = readFileSync("src/styles/global.css", "utf-8");
      expect(css, "非活动面板的活动标签要降亮度").toMatch(
        /\.layout-panel:not\(\.layout-panel-active\)\s+\.tab-active/,
      );

      const main = readFileSync("src/main.ts", "utf-8");
      const fn = main.match(/function markActivePanel\([\s\S]*?\n\}/)?.[0] ?? "";
      expect(fn, "必须有 markActivePanel 同步 class").toBeTruthy();
      // 切面板绝不能重绘标签条：会销毁光标下的 .tab → 点标签要点两下（B33 的坑）
      expect(fn, "只切 class，不得重建标签条").not.toContain("renderTabstrip");
      expect(fn, "只切 class，不得重建布局").not.toContain("renderSplitview");
      expect(main, "onActivatePanel 必须走 markActivePanel 而不是裸赋值").toMatch(
        /markActivePanel\(panelId\);\s*\n\s*if \(!changed\)/,
      );
    });
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
    expect(src, "收起/展开大纲时分隔条必须与面板同步显隐，否则留下 4px 死区").toContain(
      "tocResizer.hidden = tocPanel.hidden",
    );

    const css = readFileSync("src/styles/preview.css", "utf-8");
    const resizer = css.match(/\.toc-resizer\s*\{[^}]*\}/)?.[0] ?? "";
    expect(resizer, "应有 .toc-resizer 规则块").toBeTruthy();
    // B61：竖线光标取 VS Code **非 mac** 档的 ew-resize（col-resize 是 mac 档，
    // Windows 上会渲染成「箭头中间多一根竖杠」）
    expect(resizer, "分隔条必须是左右调整光标（非 mac 档 ew-resize）").toContain("ew-resize");
    // 旧样式把 min-width 写死为 240px，会挡住拖动变窄
    const panel = css.match(/\.toc-panel\s*\{[^}]*\}/)?.[0] ?? "";
    expect(panel, ".toc-panel 不得再写死 min-width: 240px").not.toContain("min-width: 240px");

    const api = readFileSync("src/ipc/api.ts", "utf-8");
    expect(api, "Settings 类型需要 toc_width 字段").toContain("toc_width: number");
    const rs = readFileSync("src-tauri/src/session/mod.rs", "utf-8");
    expect(rs, "Rust Settings 需要 toc_width 字段并给默认值").toContain("pub toc_width: f64");
    expect(rs, "默认宽度应为 240").toContain("toc_width: 240.0");
  });

  it("B28 大纲分隔条必须与分屏分割条同款（细线 + 宽命中区 + hover accent，无双线）", () => {
    // 用户要求：大纲区分隔条样式与面板分割条保持一致。
    // 旧样式是 4px 透明细条，与 .layout-sep 不统一；
    // 且 .toc-panel 自带 border-right 会与分隔条叠成双线。
    // B53 起两者统一升级为「透明命中区 + ::after 细线」——改一处必须改另一处。
    const previewCss = readFileSync("src/styles/preview.css", "utf-8");
    const resizer = previewCss.match(/\.toc-resizer\s*\{[^}]*\}/)?.[0] ?? "";
    expect(resizer, "应有 .toc-resizer 规则块").toBeTruthy();
    const globalCss = readFileSync("src/styles/global.css", "utf-8");
    const sep = globalCss.match(/\.layout-sep\s*\{[^}]*\}/)?.[0] ?? "";
    expect(sep, "分屏分割条基准样式应存在").toBeTruthy();

    // B60：两条分隔条都改为**不占布局**（flex 基准 0），命中区改由 ::before 向两侧溢出。
    // 原先 7px 的透明占位会把两侧内容撑开、中间露出祖先底色 —— 用户看到的就是「粗带」。
    expect(resizer, "大纲分隔条不得占布局宽度").toMatch(/flex:\s*0 0 0/);
    expect(sep, "分屏分隔条不得占布局宽度").toMatch(/flex:\s*0 0 0/);

    // 命中区宽度必须一致（B53 起的「细线 + 宽命中区」约定；宽度从元素搬到 ::before）
    const hitResizer = previewCss.match(/\.toc-resizer::before\s*\{[^}]*width:\s*(\d+)px/)?.[1];
    const hitSep = globalCss.match(/\.layout-sep-h::before\s*\{[^}]*width:\s*(\d+)px/)?.[1];
    expect(hitResizer, "大纲分隔条命中区宽度必须显式给出").toBeTruthy();
    expect(hitResizer, "大纲与分屏分隔条命中区宽度必须一致").toBe(hitSep);
    const line = previewCss.match(/\.toc-resizer::after\s*\{[^}]*\}/)?.[0] ?? "";
    expect(line, "大纲分隔条细线必须由伪元素画").toContain("background: var(--sep-line)");
    // 分屏分隔条：颜色在共享的 .layout-sep::after，几何按方向类定位
    // （B59 S5：线色从通用 --border 抽成 --sep-line，两条分隔条同步改并共用）
    const sepLine = globalCss.match(/\.layout-sep::after\s*\{[^}]*\}/)?.[0] ?? "";
    expect(sepLine, "分屏分隔条细线必须由伪元素画").toContain("background: var(--sep-line)");
    expect(globalCss, "横向分隔条的细线几何").toMatch(/\.layout-sep-h::after\s*\{/);
    expect(globalCss, "纵向分隔条的细线几何").toMatch(/\.layout-sep-v::after\s*\{/);

    const highlight =
      previewCss.match(
        /\.toc-resizer:hover::after,\s*body\.layout-dragging \.toc-resizer::after\s*\{[^}]*\}/,
      )?.[0] ?? "";
    expect(highlight, "悬停/拖拽高亮必须是 accent（允许带回退值）").toMatch(/var\(--accent[,)]/);

    const panel = previewCss.match(/\.toc-panel\s*\{[^}]*\}/)?.[0] ?? "";
    expect(panel, ".toc-panel 不得自带 border-right（与分隔条叠成双线）").not.toContain(
      "border-right",
    );
  });

  it("B59 分屏对齐 VS Code：复位/极限光标/方向光标/角手柄/落点高亮（静态契约）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const previewCss = readFileSync("src/styles/preview.css", "utf-8");
    const sv = readFileSync("src/shell/splitview.ts", "utf-8");

    // S1 拖拽中必须与 hover 同色（只写 :hover 时鼠标滑出 7px 细线就失色）
    const sepHL = css.match(/\.layout-sep:hover::after,[\s\S]{0,80}?\{[^}]*\}/)?.[0] ?? "";
    expect(sepHL, "拖拽中要加 .resizing 并保持高亮").toMatch(/\.layout-sep\.resizing::after/);
    expect(sepHL, "高亮色为 accent").toMatch(/var\(--accent/);

    // O2 极限光标（对标 sash.css 的 .minimum/.maximum）
    expect(css, "水平分隔条到极限的光标").toMatch(/\.layout-sep-h\.at-min\s*\{[^}]*e-resize/);
    expect(css, "水平分隔条到极限的光标").toMatch(/\.layout-sep-h\.at-max\s*\{[^}]*w-resize/);
    expect(css, "垂直分隔条到极限的光标").toMatch(/\.layout-sep-v\.at-min\s*\{[^}]*s-resize/);
    expect(css, "垂直分隔条到极限的光标").toMatch(/\.layout-sep-v\.at-max\s*\{[^}]*n-resize/);

    // O7 角手柄：绝对定位的 8px 命中块，按分隔条朝向摆在两端
    expect(css, "角手柄基准样式").toMatch(/\.layout-corner\s*\{[^}]*position:\s*absolute/);
    expect(css, "横线上的角手柄在左右端").toMatch(
      /\.layout-sep-v\s*>\s*\.layout-corner\.start\s*\{/,
    );
    expect(css, "横线上的角手柄在左右端").toMatch(/\.layout-sep-v\s*>\s*\.layout-corner\.end\s*\{/);
    expect(css, "竖线上的角手柄在上下端").toMatch(
      /\.layout-sep-h\s*>\s*\.layout-corner\.start\s*\{/,
    );
    expect(css, "竖线上的角手柄在上下端").toMatch(/\.layout-sep-h\s*>\s*\.layout-corner\.end\s*\{/);

    // O3 方向光标：默认 ew-resize（大纲/查找栏/水平分隔条都靠它），
    // 只有垂直分隔条叠加 -v → ns-resize（原实现恒为 col-resize，是 bug）
    expect(css, "垂直分隔条拖拽时 ns-resize").toMatch(
      /body\.layout-dragging\.layout-dragging-v\s*\{[^}]*ns-resize/,
    );
    expect(css, "角手柄拖拽时光标").toMatch(
      /body\.layout-dragging\.layout-dragging-corner\s*\{[^}]*all-scroll/,
    );

    // S4 缩放期间抑制面板内过渡（拖动不发飘）
    expect(css, "缩放期间抑制过渡").toMatch(/body\.layout-dragging \.layout-panel \*/);

    // S5 线色抽成 --sep-line，分屏与大纲两条分隔条共用（B28 要求同款），两套主题齐补
    expect(css, "分屏分隔条线色走 --sep-line").toMatch(
      /\.layout-sep::after\s*\{[^}]*background:\s*var\(--sep-line\)/,
    );
    expect(previewCss, "大纲分隔条线色同款").toMatch(
      /\.toc-resizer::after\s*\{[^}]*background:\s*var\(--sep-line\)/,
    );
    const darkTheme = css.match(/:root\[data-theme="dark"\]\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    const lightTheme = css.match(/:root\[data-theme="light"\]\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(darkTheme, "深色主题块必须找到").toBeTruthy();
    expect(lightTheme, "浅色主题块必须找到").toBeTruthy();
    for (const [name, block] of [
      ["dark", darkTheme],
      ["light", lightTheme],
    ] as const) {
      expect(block, `${name} 主题必须有 --sep-line`).toContain("--sep-line:");
      expect(block, `${name} 主题必须有 --drop-fill`).toContain("--drop-fill:");
    }

    // S3 落点高亮过渡（B60 保留）：70ms 位移 / 150ms opacity（VS Code editordroptarget.css）
    const preview = css.match(/\.split-preview::after\s*\{[^}]*\}/)?.[0] ?? "";
    expect(preview, "填充走 --drop-fill").toContain("background: var(--drop-fill)");
    // B60：填充与描边同源（都走 --drop-fill），叠加成约 @0.39，改主题不会只改一半。
    // B60 二次反馈：用户明确「不用描边」—— 填充值保持不动，只去掉那圈 2px 边。
    expect(preview, "用户要求落点预览不描边").not.toMatch(/border:\s*\d+px/);
    expect(preview, "圆角 4px 保留").toMatch(/border-radius:\s*4px/);
    expect(preview, "位移过渡 70ms").toMatch(/70ms/);
    expect(preview, "不透明度过渡 150ms").toMatch(/150ms/);
    expect(css, "基础态 opacity:0，靠 .show 点亮").toMatch(
      /\.split-preview\.show::after\s*\{[^}]*opacity:\s*1/,
    );

    // 接线：统一走 attachResize（双击复位 + 指针捕获 + 方向修饰类），角手柄双类写法
    expect(sv, "双击复位接线").toMatch(/addEventListener\("dblclick"/);
    expect(sv, "指针捕获（移出窗口不丢事件）").toMatch(/setPointerCapture/);
    expect(sv, "垂直分隔条加方向修饰类").toMatch(/layout-dragging-v/);
    expect(sv, "角手柄双类 start/end（对齐 VS Code）").toMatch(
      /layout-corner \$\{atStart \? "start" : "end"\}/,
    );
  });

  it("B60 分隔条改细 + 落点回退浅蓝 + 对齐联动（静态契约）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const previewCss = readFileSync("src/styles/preview.css", "utf-8");
    const sv = readFileSync("src/shell/splitview.ts", "utf-8");

    // ① 分隔条不占布局（对齐 VS Code sash 的浮层做法）。
    // B59 的 flex:0 0 7px 透明占位会撑开两侧内容、露出祖先底色 = 视觉上的粗带。
    expect(css, "分屏分隔条不占布局").toMatch(/\.layout-sep\s*\{[^}]*flex:\s*0 0 0/);
    expect(previewCss, "大纲分隔条同款（B28）").toMatch(/\.toc-resizer\s*\{[^}]*flex:\s*0 0 0/);
    // 命中区搬到 ::before，向两侧各溢出 3.5px（共 7px）
    expect(css, "竖线命中区 7px 宽").toMatch(/\.layout-sep-h::before\s*\{[^}]*width:\s*7px/);
    expect(css, "横线命中区 7px 高").toMatch(/\.layout-sep-v::before\s*\{[^}]*height:\s*7px/);
    expect(previewCss, "大纲命中区 7px 宽（同款）").toMatch(
      /\.toc-resizer::before\s*\{[^}]*width:\s*7px/,
    );
    // 视觉线：静息 1px（VS Code editorGroup.border），激活 4px（--vscode-sash-size）
    expect(css, "静息线 1px").toMatch(/\.layout-sep-h::after\s*\{[^}]*width:\s*1px/);
    expect(css, "静息线 1px（横线）").toMatch(/\.layout-sep-v::after\s*\{[^}]*height:\s*1px/);
    expect(css, "激活涨到 4px").toMatch(
      /\.layout-sep-h:hover::after,[\s\S]{0,160}?\{\s*width:\s*4px/,
    );
    expect(css, "激活涨到 4px（横线）").toMatch(
      /\.layout-sep-v:hover::after,[\s\S]{0,160}?\{\s*height:\s*4px/,
    );
    expect(previewCss, "大纲分隔条同款涨到 4px").toMatch(
      /\.toc-resizer:hover::after,[\s\S]{0,120}?width:\s*4px/,
    );
    // 角手柄改为骑在界线上（分隔条主轴尺寸已为 0，原先 top:0/left:0 会偏到一侧）
    expect(css, "横线上的角手柄骑线").toMatch(
      /\.layout-sep-v\s*>\s*\.layout-corner\s*\{[^}]*top:\s*-4px/,
    );
    expect(css, "竖线上的角手柄骑线").toMatch(
      /\.layout-sep-h\s*>\s*\.layout-corner\s*\{[^}]*left:\s*-4px/,
    );

    // ② 落点回退浅蓝：accent 系（深 #4c9ffe / 浅 #0969da）@0.22，不再用 VS Code 的灰
    const darkTheme = css.match(/:root\[data-theme="dark"\]\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    const lightTheme = css.match(/:root\[data-theme="light"\]\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(darkTheme, "深色落点为 accent 浅蓝").toContain("--drop-fill: rgba(76, 159, 254, 0.22)");
    expect(lightTheme, "浅色落点为 accent 浅蓝").toContain("--drop-fill: rgba(9, 105, 218, 0.22)");
    expect(darkTheme, "不得残留 VS Code 的深灰落点").not.toContain("rgba(83, 89, 93, 0.5)");

    // ③ 对齐联动：注册表 + 查找 + 双击复位转发（对标 sash.ts 的 linkedSash）
    expect(sv, "登记真实分隔条").toMatch(/sashRegistry\.push\(/);
    expect(sv, "按同向 + 中线容差查找对齐项").toMatch(/function alignedSashesOf/);
    expect(sv, "拖拽中同步联动目标").toMatch(/for \(const l of links\) applyTarget/);
    expect(sv, "松手回写联动目标").toMatch(/for \(const l of links\) l\.target\.commit/);
    expect(sv, "双击复位转发给联动条（sash.ts:622）").toMatch(
      /for \(const l of mode === "corner" \? \[\] : alignedSashesOf\(handle, mode\)\)/,
    );
    expect(sv, "角手柄不参与联动").toMatch(
      /mode === "corner" \? \[\] : alignedSashesOf\(handle, mode\)/,
    );
    expect(css, ".linked 高亮（悬停可见的联动提示）").toMatch(/\.layout-sep\.linked::after/);
  });

  it("B61 分隔条光标与 VS Code 非 mac 档一致（ew/ns，不是 col/row）", () => {
    // 用户反馈「分割条拖动光标和 vscode 不一样」。
    // 根因：我们用的是 VS Code 的 **mac 档** cursor（sash.css）
    //   .monaco-sash.mac.vertical   { cursor: col-resize }
    //   .monaco-sash.mac.horizontal { cursor: row-resize }
    // Windows/Linux 走的是基础档：
    //   .monaco-sash.vertical   { cursor: ew-resize }
    //   .monaco-sash.horizontal { cursor: ns-resize }
    // Windows 上 col-resize 会渲染成「箭头中间多一根竖杠」，一眼就能看出不同。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const previewCss = readFileSync("src/styles/preview.css", "utf-8");
    // ⚠️ 「不得残留」类断言必须先把注释剥掉 —— 注释里恰恰要写清「为什么不用 col-row」
    // （含这两个词），直接对全文断言会把说明文字当成违规。
    const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");
    const cssCode = stripComments(css);

    expect(css, "竖线（左右分屏）走非 mac 档 ew-resize").toMatch(
      /\.layout-sep-h\s*\{[^}]*cursor:\s*ew-resize/,
    );
    expect(css, "横线（上下分屏）走非 mac 档 ns-resize").toMatch(
      /\.layout-sep-v\s*\{[^}]*cursor:\s*ns-resize/,
    );
    // 极限档两平台一致（e/w/s/n-resize），不得被顺手改成 col/row
    expect(css, ".layout-sep-h.at-min 保持 e-resize").toMatch(
      /\.layout-sep-h\.at-min\s*\{[^}]*e-resize/,
    );
    expect(css, ".layout-sep-v.at-min 保持 s-resize").toMatch(
      /\.layout-sep-v\.at-min\s*\{[^}]*s-resize/,
    );

    // 拖拽期间由 body 兜住光标（命中区只有 7px，指针一离开就没了），三档值必须与上面一致
    const drag = css.match(/body\.layout-dragging\s*\{[^}]*\}/)?.[0] ?? "";
    expect(drag, "拖拽默认光标与竖线一致").toMatch(/cursor:\s*ew-resize/);
    expect(cssCode, "不得残留 mac 档 col-resize").not.toContain("col-resize");
    expect(cssCode, "不得残留 mac 档 row-resize").not.toContain("row-resize");
    expect(cssCode, "不得残留 nwse-resize（角手柄改用 all-scroll）").not.toContain("nwse-resize");
    expect(css, "上下分屏拖拽光标与横线一致").toMatch(
      /body\.layout-dragging\.layout-dragging-v\s*\{[^}]*ns-resize/,
    );

    // 正交角手柄：VS Code 的 .orthogonal-drag-handle 基础光标是 all-scroll；
    // 那几条 nwse/nesw 覆盖规则要求 .orthogonal-edge-north/south（只有 resizable.ts 设），
    // gridview 的 2x2 从不设 → 网格里的角手柄恒为 all-scroll。
    expect(css, "角手柄用 all-scroll（VS Code 基础档）").toMatch(
      /\.layout-corner\s*\{[^}]*cursor:\s*all-scroll/,
    );
    // 大纲分隔条与分屏分隔条同款（B28 约定）
    expect(previewCss, "大纲分隔条光标同款").toMatch(/\.toc-resizer\s*\{[^}]*cursor:\s*ew-resize/);
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
    expect(css, "查找行应有 flex 行布局（.find-row）").toMatch(
      /\.find-row\s*\{[^}]*display:\s*flex/,
    );

    // 预览态查找接线：高亮应用、重放、步进、清除
    const main = readFileSync("src/main.ts", "utf-8");
    expect(main, "applyFindQuery 必须同步预览高亮").toContain("applyPreviewFindEverywhere(q)");
    // 重放必须发生在 renderMarkdownFor **函数体内**。
    // 早期这里按「renderMarkdownFor 后 600 字符内」匹配，M4 给该函数加了
    // 大文件降级分支后距离超限就误报——按函数体截取才稳。
    const rmStart = main.indexOf("function renderMarkdownFor");
    expect(rmStart, "应能定位 renderMarkdownFor").toBeGreaterThan(-1);
    const rmBody = main.slice(rmStart, main.indexOf("\nfunction ", rmStart + 10));
    expect(rmBody, "重渲染后必须重放预览高亮").toContain(
      "applyPreviewFindToPanel(panel, findSpecOf(findBar.getQuery()))",
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
    expect(preview, "预览命中必须复用编辑器高亮样式类").toContain("cm-find-match");
  });

  it("B39/B40 查找范围：不得有范围下拉与文件夹搜索，跨文档必须是勾选框", () => {
    // 用户要求：查找替换悬浮栏无需查找文件夹功能，也不用下拉菜单选择查找范围——
    // 但「所有打开的文档」这个能力要保留，改成直接勾选。
    const bar = readFileSync("src/shell/findbar.ts", "utf-8");
    expect(bar, "查询对象不得再有 scope").not.toMatch(/\bscope\b/);
    expect(bar, "不得再有范围下拉控件").not.toContain("find-scope");
    expect(bar, "查找栏内不得出现任何 select 下拉").not.toContain('createElement("select")');
    expect(bar, "不得再有文件夹搜索控件").not.toContain("find-folder");
    expect(bar, "跨文档范围必须是勾选框").toContain("find-opt-docs");
    expect(bar, "勾选态必须进入查询对象").toContain("allDocs");

    const main = readFileSync("src/main.ts", "utf-8");
    expect(main, "不得再调用读盘的跨文件搜索 IPC").not.toContain("searchFiles");
    expect(main, "不得再有默认搜索目录推导").not.toContain("defaultSearchDir");
    expect(main, "不得再有 Ctrl+Shift+F 入口").not.toContain("Ctrl+Shift+F");
    expect(main, "跨文档查找必须只扫内存快照").toContain("function searchOpenDocs(");
    expect(main, "整行替换必须支持勾选后的跨文档分支").toContain("if (!q.allDocs) {");

    const api = readFileSync("src/ipc/api.ts", "utf-8");
    expect(api, "读盘搜索的 IPC 包装必须删除").not.toContain("search_files");

    const rust = readFileSync("src-tauri/src/commands/mod.rs", "utf-8");
    expect(rust, "Rust 搜索命令必须删除").not.toContain("pub async fn search_files");
    expect(rust, "递归收集文件的辅助函数必须删除").not.toContain("fn collect_files");
    const rustMain = readFileSync("src-tauri/src/main.rs", "utf-8");
    expect(rustMain, "不得再注册 search_files 命令").not.toContain("commands::search_files");
    const cargo = readFileSync("src-tauri/Cargo.toml", "utf-8");
    expect(cargo, "regex 依赖只服务于读盘搜索，应一并移除").not.toMatch(/^regex\s*=/m);
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
    expect(gen, "必须用 rounded_rectangle 保证四角圆角一致").toMatch(/rounded_rectangle\(/);
    expect(gen, "背景必须是渐变（蓝→青）").toMatch(
      /2563EB[\s\S]{0,600}06B6D4|06B6D4[\s\S]{0,600}2563EB/,
    );
    expect(gen, "不得再依赖 AI 源图（B25 镜像方案已废弃）").not.toContain("icon_final.png");
    expect(gen, "ico 必须包含多尺寸（任务栏/资源管理器清晰）").toMatch(/ICO_SIZES/);
    const conf = readJson("src-tauri/tauri.conf.json");
    const icons: string[] = conf.bundle?.icon ?? [];
    expect(
      icons.some((i) => i.includes("icon.ico")),
      "bundle.icon 必须含 icon.ico（exe/安装包图标来源）",
    ).toBe(true);
  });

  it("B43 折角文档不得带投影，钢笔需缩短且笔尖收进文档中部（不再顶角）", () => {
    // B43 用户反馈：① 钢笔太长；② 笔尖不要顶到文档角落，落在「中间靠下」即可；
    //              ③ 去掉折角文档的投影（折角处与下面两个圆角处能看到阴影）。
    const gen = readFileSync("scripts/gen_icons.py", "utf-8");

    // ① 文档投影必须关闭（保留开关常量，便于日后回退）
    expect(gen, "方案 B 必须关闭文档投影").toMatch(/B_CARD_SHADOW\s*=\s*False/);

    // ② 钢笔必须明显短于 B41 那版（0.78）
    const lenRaw = gen.match(/B_PEN_LENGTH\s*=\s*([\d.]+)/)?.[1];
    expect(lenRaw, "缺少 B_PEN_LENGTH 常量").toBeTruthy();
    const len = Number(lenRaw);
    expect(len, "钢笔应明显短于原 0.78").toBeLessThanOrEqual(0.66);
    expect(len, "钢笔也不该短到失去比例").toBeGreaterThanOrEqual(0.5);

    // ③ 笔尖落点 = 中心 + (长度/2)·(-0.707, +0.707)，必须收在文档内、且在中线以下
    const cRaw = gen.match(/B_PEN_CENTER\s*=\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/);
    const cardRaw = gen.match(
      /B_CARD\s*=\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/,
    );
    expect(cRaw, "缺少 B_PEN_CENTER").toBeTruthy();
    expect(cardRaw, "缺少 B_CARD").toBeTruthy();

    const cx = Number(cRaw![1]);
    const cy = Number(cRaw![2]);
    const [x0, y0, x1, y1] = cardRaw!.slice(1, 5).map(Number);
    const k = (len / 2) * 0.7071067811865476; // 135° 对角线的单位分量
    const tipX = cx - k;
    const tipY = cy + k;

    expect(tipX, "笔尖不得再顶到文档左边缘").toBeGreaterThan(x0 + 0.08);
    expect(tipY, "笔尖不得再顶到文档下边缘").toBeLessThan(y1 - 0.08);
    expect(tipY, "笔尖应落在文档水平中线以下（中间靠下）").toBeGreaterThan((y0 + y1) / 2);
    expect(Math.abs(tipX - (x0 + x1) / 2), "笔尖不应偏离文档竖直中线过远").toBeLessThan(0.12);
  });

  it("B34/B36 应用更名为 LitePad 后，全仓库不得有 LiteMD/litemd 残留", () => {
    // B34：应用名改为 LitePad（源码 + 配置 + Rust）。
    // B36：用户要求「梳理项目中所有文件」把 LiteMD 全部改成 LitePad——
    // 故断言从 11 个文件硬编码升级为**全仓库文本文件扫描**，
    // 覆盖文档（DESIGN/TASK/技术方案）、脚本注释、样式注释、测试数据、记忆文件。
    // 排除：构建产物（dist/target/gen）、依赖（node_modules）、本文件（规则定义处）。
    const offenders: string[] = [];
    for (const f of collectTextFiles(".")) {
      const rel = f.replace(/\\/g, "/");
      if (rel === "tests/regressions.test.ts") continue;
      // 记忆/归档类文件豁免：它们必须能写下「原名是 LiteMD」这一历史事实
      // （如 .workbuddy/memory/MEMORY.md 的更名说明、LiteMD-Space-Archive.md 的空间归档），
      // 属于对过去的记录，不是会泄漏到产品里的命名残留。
      if (rel.startsWith(".workbuddy/")) continue;
      if (/[Ll]ite[Mm][Dd]/.test(readFileSync(f, "utf-8"))) offenders.push(rel);
    }
    expect(offenders, "以下文件仍含 LiteMD/litemd 残留").toEqual([]);

    const conf = readJson("src-tauri/tauri.conf.json");
    expect(conf.productName, "productName 必须是 LitePad").toBe("LitePad");
    expect(conf.identifier, "identifier 必须是 com.litepad.app").toBe("com.litepad.app");
    const pkg = readJson("package.json");
    expect(pkg.name, "package.json name 必须是 litepad").toBe("litepad");
  });

  it("版本号必须四处同步（发布流程靠它定 tag，漏改会打出对不上的安装包）", () => {
    // 用户反馈：GitHub 上没有触发编译发布、版本号也不随开发走。
    // 根因之一是版本号散落四处（package.json / tauri.conf.json / Cargo.toml / Cargo.lock）：
    // scripts/release.sh 会自动同步，但手改/漏改会让 tag、安装包名、关于对话框三者不一致，
    // 而 Actions 只在 v* tag 上触发 —— 版本没抬就不会有发布。故把它固定成断言。
    const pkgVersion = readJson("package.json").version as string;
    const confVersion = readJson("src-tauri/tauri.conf.json").version as string;

    const cargoToml = readFileSync("src-tauri/Cargo.toml", "utf-8");
    const tomlVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    // Cargo.lock 里 litepad 自己的版本条目（[[package]] 块的 name/version 相邻）
    const cargoLock = readFileSync("src-tauri/Cargo.lock", "utf-8");
    const lockVersion = cargoLock.match(/name = "litepad"\nversion = "([^"]+)"/)?.[1];

    expect(pkgVersion, "版本号应为 x.y.z 形式").toMatch(/^\d+\.\d+\.\d+$/);
    expect(confVersion, "tauri.conf.json 版本必须与 package.json 一致").toBe(pkgVersion);
    expect(tomlVersion, "Cargo.toml 版本必须与 package.json 一致").toBe(pkgVersion);
    expect(lockVersion, "Cargo.lock 中 litepad 版本必须与 package.json 一致").toBe(pkgVersion);
  });
});

describe("B42：菜单重组为 文件/编辑/查看/设置/帮助", () => {
  const menu = (): string => readFileSync("src/shell/menubar.ts", "utf-8");
  const main = (): string => readFileSync("src/main.ts", "utf-8");

  it("「查看」不得再有主题 / 预览行距 / 大纲宽度 / 分屏", () => {
    // 只看「查看」菜单那一段，避免把「设置 → 首选项」里的同名词条误判为残留
    const src = menu();
    const viewBlock = src.slice(src.indexOf('label: "查看"'), src.indexOf('label: "设置"'));
    expect(viewBlock, "查看菜单不得再有主题三态").not.toContain("主题：");
    expect(viewBlock, "查看菜单不得再有预览行距").not.toContain("预览行距");
    expect(viewBlock, "查看菜单不得再有大纲宽度").not.toContain("大纲宽度");
    expect(viewBlock, "查看菜单不得再有分屏项").not.toContain("分屏");
    // 保留项不能被顺手删掉
    expect(viewBlock).toContain("切换 源码 / 预览");
    expect(viewBlock).toContain("大纲 TOC");
    expect(viewBlock).toContain("折叠全部");
    expect(viewBlock).toContain("自动换行");
    expect(viewBlock).toContain("状态栏");
  });

  it("「文件」不得再有新建默认行尾/编码，「帮助」不得再有快捷键", () => {
    const src = menu();
    const fileBlock = src.slice(src.indexOf('label: "文件"'), src.indexOf('label: "编辑"'));
    expect(fileBlock, "文件菜单不得再有新建默认行尾入口").not.toContain("新建文件默认行尾");
    expect(fileBlock, "文件菜单不得再有新建默认编码入口").not.toContain("新建文件默认编码");
    expect(fileBlock, "文件菜单应保留自动保存").toContain("自动保存");

    const helpBlock = src.slice(src.indexOf('label: "帮助"'));
    expect(helpBlock, "帮助菜单只留关于").toContain("关于 LitePad");
    expect(helpBlock, "帮助菜单不得再有快捷键入口").not.toContain("快捷键");
  });

  it("「设置」菜单 = 首选项弹窗入口 + 快捷键；预设值收进弹窗（B46）", () => {
    const src = menu();
    const setBlock = src.slice(src.indexOf('label: "设置"'), src.indexOf('label: "帮助"'));
    expect(setBlock, "设置菜单必须有首选项入口").toContain('label: "首选项…"');
    expect(setBlock, "B46 后首选项不再是子菜单").not.toContain("submenu:");
    expect(setBlock, "设置菜单必须有快捷键入口").toContain('label: "快捷键…"');

    // 原子菜单的预设值全部收进首选项弹窗（按分组标签断言）
    const dlg = readFileSync("src/shell/preferencesdialog.ts", "utf-8");
    for (const item of [
      "外观",
      "主题",
      "字体与行距",
      "编辑器字体",
      "字号",
      "编辑器行距",
      "Markdown 预览",
      "预览行距",
      "大纲宽度",
      "新建文件",
      "默认行尾",
      "默认编码",
    ]) {
      expect(dlg, `首选项弹窗必须含「${item}」`).toContain(item);
    }
    // 新增精细设置的字段必须持久化（前后端成对）
    const api = readFileSync("src/ipc/api.ts", "utf-8");
    const rust = readFileSync("src-tauri/src/session/mod.rs", "utf-8");
    for (const field of ["font_family", "editor_line_height"]) {
      expect(api, `Settings 接口必须含 ${field}`).toContain(field);
      expect(rust, `Rust Settings 必须含 ${field}`).toContain(field);
    }
  });

  it("B51：首选项弹窗移除自动换行 / 自动保存 / 快捷键（功能留在菜单里）", () => {
    // 需求：这三项从首选项弹窗里去掉——它们是高频开关，菜单里一点即达，
    // 塞进弹窗只会让「改一个开关」变成三层点击。
    const dlg = readFileSync("src/shell/preferencesdialog.ts", "utf-8");
    for (const gone of [
      '"自动换行"',
      '"自动保存"',
      '"快捷键…"',
      "onWordWrap",
      "onAutosave",
      "onKeymap",
      "checkRow",
    ]) {
      expect(dlg, `首选项弹窗不得再出现 ${gone}`).not.toContain(gone);
    }
    // 只是搬家，不是砍功能：菜单入口必须都还在
    // （自动换行在「查看」，自动保存在「文件」，快捷键在「设置」）
    const src = menu();
    const viewBlock = src.slice(src.indexOf('label: "查看"'), src.indexOf('label: "设置"'));
    const setBlock = src.slice(src.indexOf('label: "设置"'), src.indexOf('label: "帮助"'));
    expect(viewBlock, "「查看」菜单必须保留自动换行").toContain("自动换行");
    expect(src, "「文件」菜单必须保留自动保存").toContain("自动保存");
    expect(setBlock, "「设置」菜单必须保留快捷键入口").toContain('label: "快捷键…"');
  });

  it("B51：主题按钮三态循环，导出图标改语义", () => {
    const main = readFileSync("src/main.ts", "utf-8");
    expect(main, "主题必须按档位循环（三态）").toContain("nextThemeMode()");
    expect(main, "档位要写进 data 属性供测试/样式用").toContain("dataset.themeMode");
    expect(main, "三态图标须含「跟随系统」").toContain("followSystem");
    expect(main, "不得再退回明暗二选一的旧写法").not.toContain('isDark ? "light" : "dark"');

    const icons = readFileSync("src/shell/icons.ts", "utf-8");
    expect(icons, "应导出「跟随系统」图标").toContain("followSystem:");
    expect(icons, "导出图标不得再用「箭头落入托盘」（下载语义）").not.toContain("M12 3v12");
    expect(icons, "导出图标应为文档 + 出向箭头").toContain("M13 3v5h5");
  });

  it("菜单显示的键位必须来自快捷键注册表（不能写死）", () => {
    const src = menu();
    expect(src, "菜单必须通过 keyHint 取键位").toContain("cb.keyHint(");
    expect(src, "不得再手写硬编码快捷键").not.toContain("新建\\tCtrl+N");
    expect(main(), "main 必须提供 keyHint 实现").toContain("function keyHint(");
  });

  it("子菜单能力与长菜单滚动", () => {
    const m = readFileSync("src/shell/menu.ts", "utf-8");
    expect(m, "MenuItem 必须支持 submenu").toContain("submenu?");
    expect(m, "必须有子菜单箭头").toContain("menu-arrow");
    expect(m, "嵌套层必须能被整体回收").toContain("function closeDeeperThan");

    const css = readFileSync("src/styles/global.css", "utf-8");
    expect(css, "子菜单箭头样式").toContain(".menu-arrow");
    expect(css, "长菜单必须自身滚动").toMatch(/\.popup-menu\s*\{[\s\S]*?overflow-y:\s*auto/);
  });
});

describe("B42：快捷键可浏览可编辑", () => {
  const main = (): string => readFileSync("src/main.ts", "utf-8");

  it("注册表覆盖全部命令，且大纲/折叠/分屏都有默认键位", () => {
    const km = readFileSync("src/shell/keymap.ts", "utf-8");
    for (const id of [
      "view.outline",
      "view.foldCode",
      "view.unfoldCode",
      "view.foldAll",
      "view.unfoldAll",
      "panel.splitH",
      "panel.splitV",
      "panel.close",
    ]) {
      expect(km, `注册表必须登记 ${id}`).toContain(`id: "${id}"`);
    }
    // 大纲此前没有快捷键，B42 起必须有
    expect(km, "大纲必须有默认键位").toMatch(
      /id: "view\.outline"[\s\S]{0,120}keys: \["Ctrl\+Shift\+O"\]/,
    );
    // 折叠全部用 CM 约定的 Ctrl+Alt+[（Ctrl+Shift+[ 是折叠光标处）
    expect(km, "折叠光标处必须是 Ctrl+Shift+[").toMatch(
      /id: "view\.foldCode"[\s\S]{0,120}keys: \["Ctrl\+Shift\+\["\]/,
    );
    expect(km, "折叠全部必须是 Ctrl+Alt+[").toMatch(
      /id: "view\.foldAll"[\s\S]{0,120}keys: \["Ctrl\+Alt\+\["\]/,
    );
  });

  it("折叠键位归应用层：编辑器不得再自带 foldKeymap", () => {
    const ed = readFileSync("src/editor/editor.ts", "utf-8");
    expect(ed, "不得再展开 CM 的 foldKeymap").not.toContain("...foldKeymap");
    const src = main();
    expect(src, "必须有折叠当前块的处理").toContain("function foldCodeOperation(");
    expect(src, "必须从 CM 引入 foldCode/unfoldCode").toMatch(/\bfoldCode\b/);
  });

  it("全局快捷键统一分发：旧的手写分支必须删除", () => {
    const src = main();
    expect(src, "必须走 resolveCommand").toContain("resolveCommand(e, keymapOverrides)");
    expect(src, "动作表必须是 runShortcut").toContain("function runShortcut(");
    expect(src, "不得再手写 e.key 分支").not.toContain("const key = e.key.toLowerCase();");
    expect(src, "不得再散落三份 keydown 监听").not.toMatch(/Ctrl\+Shift\+F/);
  });

  it("快捷键覆盖表必须前后端都有字段，且后端保持前向兼容", () => {
    const api = readFileSync("src/ipc/api.ts", "utf-8");
    expect(api, "Settings 必须暴露 keymap").toMatch(/keymap:\s*Record<string,\s*string>/);

    const rust = readFileSync("src-tauri/src/session/mod.rs", "utf-8");
    expect(rust, "Rust Settings 必须有 keymap").toContain("pub keymap: HashMap<String, String>");
    expect(rust, "缺字段时必须能回落到默认（旧配置文件兼容）").toContain("#[serde(default)]");
  });

  it("快捷键对话框必须是对话框形态（不是第二套设置窗口）", () => {
    const dlg = readFileSync("src/shell/keymapdialog.ts", "utf-8");
    expect(dlg).toContain("settings-overlay");
    expect(dlg, "必须有搜索").toContain("keymap-search");
    expect(dlg, "必须可改键").toContain("keymap-key");
    expect(dlg, "必须能恢复默认").toContain("恢复全部默认");
    expect(dlg, "必须拦冲突").toContain("findConflict");
    expect(dlg, "录制态要挂 document 捕获（按钮未必有焦点）").toContain(
      'document.addEventListener("keydown", recordHandler, true)',
    );
    // 旧的只读说明清单已废弃
    expect(dlg, "不得再保留只读的 KEYMAP_DOC 清单").not.toContain("KEYMAP_DOC");
  });
});

describe("B50 启动不得露出白色窗口（用户反馈：打开时先白屏一下）", () => {
  // 用户报告：exe 打开时会先白屏一下。根因是 WebView2 渲染出第一帧之前的那段时间
  // 窗口内容由 Chromium 用纯白填充，而前端要走完 `await loadSettings()`
  // → `await restoreSession()` 才有东西可画。
  //
  // 修法分两层：
  //   1) Rust 侧把 WebView2 的「预渲染底色」刷成界面背景色（set_background_color）；
  //   2) index.html 内联样式+脚本，让 HTML 的第一帧也是主题色。
  //
  // ⚠️ 为什么不用「visible:false + 前端就绪后 show()」：那样窗口是否出现完全
  //    取决于前端能否跑完 bootstrap。实测出现过「IPC 正常、界面却始终画不出来」
  //    的情况（WebView2 用户数据目录损坏就会这样），此时用户就是「点了图标
  //    什么都没有」，比白屏严重得多。下面两条断言就是防止这个方案复活。
  it("主窗口不得配 visible:false（前端一旦卡住用户将看不到任何窗口）", () => {
    const conf = readJson("src-tauri/tauri.conf.json");
    const win = conf.app?.windows?.find((w: { label?: string }) => w.label === "main");
    expect(win, "必须能找到 label=main 的主窗口配置").toBeTruthy();
    expect(
      "visible" in win,
      "visible:false 会让窗口出现与否依赖前端 bootstrap，前端卡住时用户什么都看不到",
    ).toBe(false);
  });

  it("Rust 侧必须在 setup 阶段把窗口底色刷成主题色", () => {
    const src = readFileSync("src-tauri/src/main.rs", "utf-8");
    expect(src, "main.rs 必须在 setup 里取主窗口").toMatch(/get_webview_window\("main"\)/);
    expect(src, "必须调用 set_background_color 清掉白色预渲染底色").toContain(
      "set_background_color",
    );
    // 主题三态：dark / light 走设置，system 问系统
    expect(src, "必须定义深浅两套底色常量").toMatch(/const BG_DARK: Color/);
    expect(src, "必须定义深浅两套底色常量").toMatch(/const BG_LIGHT: Color/);
    expect(src, "system 模式必须跟随系统主题").toMatch(/win\.theme\(\)/);
  });

  it("四处底色必须一致：tauri.conf.json / main.rs / global.css / index.html", () => {
    const conf = readJson("src-tauri/tauri.conf.json");
    const win = conf.app?.windows?.find((w: { label?: string }) => w.label === "main");
    const rust = readFileSync("src-tauri/src/main.rs", "utf-8");
    const css = readFileSync("src/styles/global.css", "utf-8");
    const html = readFileSync("index.html", "utf-8");

    const confBg = String(win.backgroundColor ?? "")
      .replace("#", "")
      .toLowerCase();
    expect(confBg, "tauri.conf.json 必须给出 backgroundColor").toMatch(/^[0-9a-f]{6}$/);

    // main.rs: const BG_DARK: Color = Color(0x1b, 0x1d, 0x1f, 0xff);
    const m = rust.match(/const BG_DARK: Color = Color\(([^)]*)\)/);
    expect(m, "main.rs 必须能解析出 BG_DARK 的 RGB").toBeTruthy();
    const [r, g, b] = (m?.[1] ?? "").split(",").map((s) => Number.parseInt(s.trim(), 16));
    const rustDark = [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");

    expect(rustDark, "main.rs 的 BG_DARK 必须与 tauri.conf.json 的 backgroundColor 一致").toBe(
      confBg,
    );

    // global.css: :root[data-theme="dark"] { --bg: #1b1d1f; }
    const cssDark = css.match(/\[data-theme="dark"\][\s\S]*?--bg:\s*#([0-9a-fA-F]{6})/);
    expect(cssDark?.[1]?.toLowerCase(), "global.css 深色 --bg 必须同上").toBe(confBg);

    // index.html 内联首屏样式必须同时覆盖深/浅两套
    expect(html, "index.html 必须有内联首屏底色").toContain("background: #ffffff");
    expect(html, "index.html 必须给出深色首屏底色").toContain(`background: #${confBg}`);
  });

  it("index.html 必须在模块脚本之前同步定好 data-theme", () => {
    const html = readFileSync("index.html", "utf-8");
    const style = html.indexOf("<style>");
    const mod = html.indexOf('type="module"');
    expect(style, "必须有内联 <style>").toBeGreaterThan(-1);
    expect(style, "内联样式必须排在模块脚本之前才生效").toBeLessThan(mod);
    expect(html, "必须同步读 localStorage 里的主题镜像").toContain(
      'localStorage.getItem("litepad.theme")',
    );
    expect(html, "必须在首帧前设置 data-theme").toContain('setAttribute("data-theme"');
    expect(html, "缺失镜像时要用 prefers-color-scheme 兜底").toContain("prefers-color-scheme");
  });

  it("前端必须回报启动各阶段耗时（便于定位慢在哪一段）", () => {
    const src = readFileSync("src/main.ts", "utf-8");
    expect(src, "必须有 reportBoot 上报入口").toContain("function reportBoot");
    // 至少三处：定义 + 外壳就绪 + 全部就绪；任一被删都会丢失诊断
    const calls = src.match(/reportBoot\(/g) ?? [];
    expect(
      calls.length,
      "reportBoot 应在 bootstrap 中被调用（外壳 + 就绪）",
    ).toBeGreaterThanOrEqual(3);
  });
});

describe("B50 会话恢复必须并行读盘（而不是逐个 await）", () => {
  // 原先 restoreSession 对每个标签 `await openFile(...)`，N 个文件就是 N 次串行
  // 往返（读盘 + 编码检测），总耗时是各次之和；并行后总耗时≈最慢的那一次。
  it("restoreSession 内必须先把文件并行预取好，再按序组装标签", () => {
    const src = readFileSync("src/main.ts", "utf-8");
    const start = src.indexOf("async function restoreSession");
    expect(start, "必须能定位 restoreSession").toBeGreaterThan(-1);
    const body = src.slice(start, start + 5000);
    expect(body, "必须并行预取（Promise.all）").toContain("Promise.all");
    expect(body, "必须有预取缓存 openedCache").toContain("openedCache");
    expect(body, "组装阶段应读缓存而不是再读盘").toContain("openedCache.get(");
    expect(body, "组装循环里不得再逐个 await openFile（那是串行的老写法）").not.toMatch(
      /const file = await openFile\(/,
    );
  });
});

describe("B48 安装包必须自带 WebView2Loader.dll（缺了应用起不来）", () => {
  // 用户报告：装好的应用双击无反应。根因是 NSIS 包里只有 litepad.exe，
  // 而它的导入表依赖 WebView2Loader.dll（Tauri 的 WebView2 加载器，必须与 exe 同目录）；
  // 该 dll 由构建生成到 target/release/，但 bundler 不会自动收进包。
  it("bundle.resources 必须把 WebView2Loader.dll 打到安装目录根", () => {
    const conf = readJson("src-tauri/tauri.conf.json");
    const res = conf.bundle?.resources;
    expect(res, "bundle.resources 必须存在（否则 WebView2Loader.dll 不会进包）").toBeTruthy();

    // 两种写法都要认：["路径"] 与 { "源": "目标" }
    const pairs: [string, string][] = Array.isArray(res)
      ? (res as string[]).map((p) => [p, p])
      : Object.entries(res as Record<string, string>);

    const hit = pairs.find(([, target]) => /WebView2Loader\.dll$/i.test(target));
    expect(hit, "必须把 WebView2Loader.dll 打进安装包").toBeTruthy();
    // 目标若带子路径（如 target/release/...），exe 仍会在同目录找不到它
    expect(hit![1], "目标必须是安装目录根下的文件名，不能带子路径").toBe("WebView2Loader.dll");

    // 源路径**不能**指向构建产物：Tauri 的 codegen 在**编译前**就校验 resources 路径存在，
    // 而 target/release/ 下的 dll 是链接阶段才生成的 —— 冷构建（CI）必然报
    // "resource path ... doesn't exist"。本地能过只是因为 target 里有上次构建的残留。
    expect(hit![0], "源路径不得指向 target/（构建产物在校验时还不存在）").not.toContain("target/");
    expect(
      existsSync(`src-tauri/${hit![0]}`),
      `源文件 src-tauri/${hit![0]} 必须存在于仓库（随包分发的运行时依赖）`,
    ).toBe(true);
  });
});

describe("B52 安装程序自身必须有 LitePad 图标（否则显示 NSIS 默认图标）", () => {
  // 用户报告「生成的二进制文件的图标还是旧的」。实测 exe 是对的
  // （7 档 PNG 与 icon.ico 逐字节一致），错的是**安装程序外壳**：
  // 双击 setup.exe 时任务栏/标题栏图标、「应用和功能」里的卸载图标
  // 全是 NSIS 自带的默认图标。
  // 根因：bundle.icon 只喂给 exe 与快捷方式；NSIS 安装器图标要
  // bundle.windows.nsis.installerIcon / uninstallerIcon 单独指定，
  // 不配就被 Tauri 渲染成 INSTALLERICON ""（空串），NSIS 回落默认图标。
  const nsisOf = () => readJson("src-tauri/tauri.conf.json").bundle?.windows?.nsis;

  it("必须给 installerIcon 与 uninstallerIcon 指定图标文件", () => {
    const nsis = nsisOf();
    expect(nsis, "bundle.windows.nsis 必须存在（否则安装器用 NSIS 默认图标）").toBeTruthy();
    expect(nsis.installerIcon, "必须配置 installerIcon").toBeTruthy();
    expect(nsis.uninstallerIcon, "必须配置 uninstallerIcon（卸载项也要有图标）").toBeTruthy();
  });

  it("指定的图标文件必须真实存在，且是 ICO 格式", () => {
    const nsis = nsisOf();
    for (const key of ["installerIcon", "uninstallerIcon"] as const) {
      const rel: string = nsis[key];
      const abs = `src-tauri/${rel}`;
      expect(existsSync(abs), `${abs} 必须存在`).toBe(true);
      // ico 头：reserved=0, type=1, count>=1
      const buf = readFileSync(abs);
      expect(buf.readUInt16LE(0), "ICO 保留字段必须为 0").toBe(0);
      expect(buf.readUInt16LE(2), "类型必须是 1（ICO）").toBe(1);
      expect(buf.readUInt16LE(4), "至少含 1 档图像").toBeGreaterThan(0);
    }
  });

  it("图标不能只在 target/ 之类构建产物里（冷构建会取不到）", () => {
    const nsis = nsisOf();
    for (const key of ["installerIcon", "uninstallerIcon"] as const) {
      expect(nsis[key], `${key} 不得指向 target/`).not.toContain("target/");
    }
  });
});

describe("M4 大文件分级：降级而不是拒绝（原先 20 MB 直接打不开）", () => {
  // M0 起 open_file 对 >20MB 一律返回 Err，提示「大文件分级模式将在 M4 提供」。
  // M4 的做法是先定档再降级：只有超过硬上限（64MB）才拒绝。
  it("doc.rs 必须是阈值表，不再用单一 MAX_OPEN_BYTES", () => {
    const src = readFileSync("src-tauri/src/core/doc.rs", "utf-8");
    expect(src).toMatch(/pub const SIZE_NORMAL_MAX: u64/);
    expect(src).toMatch(/pub const SIZE_LARGE_MAX: u64/);
    expect(src).toMatch(/pub const SIZE_HUGE_MAX: u64/);
    expect(src, "单一上限已被阈值表取代").not.toContain("MAX_OPEN_BYTES");
    expect(src, "必须有 size_class 定档函数").toMatch(/pub fn size_class\(/);
  });

  it("open_file 按档位放行，超限才报错（错误信息不再提 M4 未提供）", () => {
    const src = readFileSync("src-tauri/src/commands/mod.rs", "utf-8");
    expect(src).toMatch(/doc::size_class\(/);
    expect(src, "不该再写「大文件分级模式将在 M4 提供」").not.toContain("将在 M4 提供");
    // 定档结果要随文件内容回传前端
    expect(src).toMatch(/size_class: class\.as_str\(\)\.into\(\)/);
  });

  it("OpenedFile 必须带上 size_class / size_hint 给前端", () => {
    const src = readFileSync("src-tauri/src/commands/mod.rs", "utf-8");
    expect(src).toMatch(/pub size_class: String/);
    expect(src).toMatch(/pub size_hint: String/);
  });

  it("前端必须有 perf 档位表，且编辑器真的按档裁剪", () => {
    const perf = readFileSync("src/editor/perf.ts", "utf-8");
    expect(perf).toMatch(/export type SizeClass/);
    expect(perf).toMatch(/export function perfProfileFor/);
    expect(perf).toMatch(/export function normalizeSizeClass/);

    const ed = readFileSync("src/editor/editor.ts", "utf-8");
    expect(ed, "基础扩展必须接受档位参数").toMatch(/function baseExtensions\(perf/);
    expect(ed, "语法高亮必须受档位控制").toMatch(/perf\.syntax/);
    expect(ed, "折叠必须受档位控制").toMatch(/perf\.folding/);
  });

  it("大文件停用自动预览，但手动切预览仍可渲染（降级不是禁用）", () => {
    const src = readFileSync("src/main.ts", "utf-8");
    expect(src).toMatch(/function renderMarkdownFor\(panel: Panel, force = false\)/);
    expect(src).toMatch(/perfProfileFor\(doc\.sizeClass\)\.autoPreview/);
    // 用户主动切模式时必须传 force=true
    expect(src).toMatch(/renderMarkdownFor\(panel, true\)/);
  });
});

describe("M4 命令面板与键位预设已接入", () => {
  it("命令面板：模块存在、命令已登记、main 已分发", () => {
    const km = readFileSync("src/shell/keymap.ts", "utf-8");
    expect(km, "必须登记 palette.open 命令").toMatch(/id: "palette\.open"/);

    const main = readFileSync("src/main.ts", "utf-8");
    expect(main).toMatch(/case "palette\.open":/);
    expect(main).toMatch(/showCommandPalette\(/);
    // 面板打开期间全局快捷键必须让路，否则输入框里的按键会触发命令
    expect(main).toMatch(/if \(paletteOpen\(\)\) return;/);
  });

  it("键位预设：注册表有预设表，设置里有持久化字段", () => {
    const km = readFileSync("src/shell/keymap.ts", "utf-8");
    expect(km).toMatch(/export const KEYMAP_PRESETS/);
    // 优先级：用户覆盖 > 预设 > 默认，effectiveKeys 必须同时看两层
    expect(km).toMatch(/currentPreset\.overrides\[id\]/);

    const rs = readFileSync("src-tauri/src/session/mod.rs", "utf-8");
    expect(rs).toMatch(/pub keymap_preset: String/);

    const main = readFileSync("src/main.ts", "utf-8");
    // 预设必须在任何 effectiveKeys/resolveCommand 之前落地
    expect(main).toMatch(/setKeymapPreset\(normalizePresetId\(settings\?\.keymap_preset\)\)/);
  });

  it("快捷键对话框必须能切预设", () => {
    const dlg = readFileSync("src/shell/keymapdialog.ts", "utf-8");
    expect(dlg).toMatch(/onPresetChange/);
    expect(dlg).toContain("keymap-preset");
  });
});

// B58：原生 `title` 由操作系统绘制，配色/圆角/键帽/延迟全不可控（深色界面里会突然弹出
// 一个浅色系统气泡）。改为全局单例自绘层，外观对齐 VS Code hover。
describe("B58 应用级 tooltip（取代原生 title，外观对齐 VS Code hover）", () => {
  it("提示层外观取自 VS Code：fixed / 13px / 19px / 4px 8px / 3px 圆角 / 不参与命中", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const tip = cssDecls(css.match(/\n\.tooltip\s*\{[^}]*\}/)?.[0] ?? "");
    expect(tip, "应有 .tooltip 规则").toBeTruthy();
    expect(tip, "fixed 定位（提示不随内容滚动）").toMatch(/position:\s*fixed/);
    // 菜单（1000）与转到行浮层（1000）之上：菜单项自己也要能弹提示
    expect(tip, "必须浮在菜单之上").toMatch(/z-index:\s*2000/);
    expect(tip, "13px 字号（= VS Code .hover-contents）").toMatch(/font-size:\s*13px/);
    expect(tip, "19px 行高（= VS Code .hover-contents）").toMatch(/line-height:\s*19px/);
    expect(tip, "padding 4px 8px（= VS Code .hover-contents）").toMatch(/padding:\s*4px 8px/);
    expect(tip, "恒带指针 → 用 VS Code 的 with-pointer 圆角 3px（不是常规档 5px）").toMatch(
      /border-radius:\s*3px/,
    );
    expect(tip, "420px 是相对 VS Code 700px 的有意收窄（见 tooltip.ts 顶部说明）").toMatch(
      /max-width:\s*420px/,
    );
    expect(tip, "不得裁剪：caret 要露在框外").toMatch(/overflow:\s*visible/);
    // 提示紧贴目标：可交互的话鼠标滑上去会掐断目标的 :hover，提示闪烁
    expect(tip, "不参与命中").toMatch(/pointer-events:\s*none/);
    expect(tip, "配色必须走主题变量（深浅色联动，这是弃用原生 title 的主因之一）").toMatch(
      /background:\s*var\(--tip-bg\)/,
    );

    // ⚠️ hidden 必须显式 display:none：.tooltip 自身是 display:flex，
    // 会盖掉浏览器对 hidden 属性默认的 display:none（B30 查找栏同款坑）。
    expect(css, "隐藏态必须显式 display:none").toMatch(
      /\.tooltip\[hidden\]\s*\{[^}]*display:\s*none/,
    );
  });

  it("两套主题都备齐 --tip-* 变量（缺一个 → 某主题下提示丢配色）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");
    const VARS = [
      "--tip-bg:",
      "--tip-border:",
      "--tip-shadow:",
      "--tip-key-bg:",
      "--tip-key-fg:",
      "--tip-key-border:",
      "--tip-key-bottom:",
    ] as const;
    for (const [name, block] of [
      ["深色", css.match(/:root\[data-theme="dark"\]\s*\{[^}]*\}/)?.[0] ?? ""],
      ["浅色", css.match(/:root\[data-theme="light"\]\s*\{[^}]*\}/)?.[0] ?? ""],
    ] as const) {
      expect(block, `未取到${name}主题变量块`).toContain("--tip-bg:");
      for (const v of VARS) expect(block, `${name}主题缺 ${v}`).toContain(v);
    }
  });

  it("键帽与 caret 齐全：快捷键渲染成键帽，caret 只画朝外两条边", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");

    // 键帽数值 = VS Code keybindingLabel.css（11px / min-width 12px / padding 3px 5px / 圆角 3px）
    const kbd = cssDecls(css.match(/\n\.tooltip-kbd\s*\{[^}]*\}/)?.[0] ?? "");
    expect(kbd, "应有 .tooltip-kbd 规则").toBeTruthy();
    expect(kbd, "min-width 12px").toMatch(/min-width:\s*12px/);
    expect(kbd, "padding 3px 5px").toMatch(/padding:\s*3px 5px/);
    expect(kbd, "圆角 3px").toMatch(/border-radius:\s*3px/);
    expect(kbd, "下边框单独深一档（做出键帽厚度的观感）").toMatch(
      /border-bottom-color:\s*var\(--tip-key-bottom\)/,
    );

    // caret：6px 方块转 45°，只留朝外的两条边 → 看起来是一个贴住目标的三角
    const caret = cssDecls(css.match(/\n\.tooltip-caret\s*\{[^}]*\}/)?.[0] ?? "");
    expect(caret, "应有 .tooltip-caret 规则").toBeTruthy();
    expect(caret, "6px 方块（= VS Code PointerSize 的一半为 3px）").toMatch(/width:\s*6px/);
    expect(caret).toMatch(/height:\s*6px/);
    expect(caret, "只画右边").toMatch(/border-right:[^;}]*var\(--tip-border\)/);
    expect(caret, "只画下边").toMatch(/border-bottom:[^;}]*var\(--tip-border\)/);
    expect(caret, "caret 也不能参与命中").toMatch(/pointer-events:\s*none/);
    expect(css, "上方提示 caret 挂下沿、尖朝下").toMatch(
      /\.tooltip\[data-placement="top"\]\s*>\s*\.tooltip-caret\s*\{[^}]*rotate\(45deg\)/,
    );
    expect(css, "下方提示 caret 挂上沿、尖朝上").toMatch(
      /\.tooltip\[data-placement="bottom"\]\s*>\s*\.tooltip-caret\s*\{[^}]*rotate\(225deg\)/,
    );

    // 没有快捷键 / 没有补充说明时不得留出空白格（flex 会盖掉 hidden 默认值）
    expect(css, "键帽与详情的 hidden 必须显式 display:none").toMatch(
      /\.tooltip-key\[hidden\][^{]*\{[^}]*display:\s*none/,
    );
  });

  it("接线：bootstrap 装配委托、顶栏弃用原生 title、同组标 data-tip-group", () => {
    const ts = readFileSync("src/shell/tooltip.ts", "utf-8");
    expect(ts, "必须导出 initTooltips").toMatch(/export function initTooltips/);
    expect(ts, "必须导出 setTip").toMatch(/export function setTip/);
    expect(ts, "必须导出 clearTip（控件变成无可提示时用）").toMatch(/export function clearTip/);
    // 500ms 是 VS Code workbench.hover.delay 在 Windows/Linux 的默认值（本项目仅 Windows）
    expect(ts, "显示延迟必须是 500ms").toMatch(/SHOW_DELAY\s*=\s*500/);
    // 全局委托而非逐个挂钩子：标签栏/查找结果/大纲都是整块重绘的
    expect(ts, "必须走事件委托（挂 document，而不是给每个元素加监听）").toMatch(
      /doc\.addEventListener\(\s*\n?\s*"mouseover"/,
    );

    const main = readFileSync("src/main.ts", "utf-8");
    expect(main, "bootstrap 必须装配 tooltip 委托").toMatch(/initTooltips\(\)/);

    const html = readFileSync("index.html", "utf-8");
    expect(html, "顶栏按钮必须改用 data-tip").toContain('data-tip="新建"');
    expect(html, "不得再用原生 title 给工具栏按钮做提示").not.toMatch(
      /class="tool-btn"[^>]*\stitle=/,
    );
    expect(html, "工具栏容器必须标 data-tip-group（同组秒开）").toContain(
      'data-tip-group="toolbar"',
    );
  });
});

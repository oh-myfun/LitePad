// @vitest-environment jsdom
// 用户报告过的 bug 回归测试（静态断言版）。
// 约定：用户每报告一个 bug，修复时必须在此（或 smoke.bootstrap.test.ts）补对应用例。
// 这三个 bug 的根因都在配置/样式层，无法在运行时断言，故用文件内容断言防回归。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  readJson,
  themeBlock,
  ruleBlock,
  cssDecls,
  FILE_FAMILIES,
  collectTextFiles,
} from "./static";

describe("用户报告过的 bug 回归（静态配置断言）", () => {
  it("关闭窗口/最后一个面板不报 ACL 错误：capabilities 必须授予 window close/destroy", () => {
    // 用户报告：unhandledrejection: Command plugin:window|destroy not allowed by ACL。
    // onCloseRequested 未 preventDefault 时内部调 destroy()，缺权限则关闭窗口报错。
    const cap = readJson("src-tauri/capabilities/default.json");
    const perms: string[] = cap.permissions ?? [];
    expect(perms, "必须包含 core:window:allow-close").toContain("core:window:allow-close");
    expect(perms, "必须包含 core:window:allow-destroy").toContain("core:window:allow-destroy");
  });

  it("拖文件进窗口仍要拿得到真实路径：关掉原生拖放必须与路径桥成对出现（B91）", () => {
    // 用户报告：拖文件进窗口应打开文件而不是把内容插进当前文档。
    //
    // B91 起改走「页面内 HTML5 拖放 + 路径桥」：wry 的原生处理器（dragDropEnabled: true）
    // 在 Windows 上会 `SetAllowExternalDrop(false)` 并覆盖子窗口的 drop target，把页面内
    // HTML5 拖放一起废掉（源码位置与原文注释见 `src-tauri/src/dropbridge.rs` 模块头）。
    // 关掉它之后路径由 WebView2 官方出口补回：页面 postMessageWithAdditionalObjects →
    // 宿主从 `ICoreWebView2File::Path` 取真实路径。
    //
    // ⚠️ 这条断言是**成对**的，拆开任一半都是静默故障：
    //   · 只改配置不装桥 → 拖文件进来毫无反应；
    //   · 只留桥不改配置 → 页面内收不到 drop，桥永远等不到消息。
    const conf = readJson("src-tauri/tauri.conf.json");
    const win = (conf.app?.windows ?? []).find((w: { label?: string }) => w.label === "main");
    expect(win, "tauri.conf.json 应有 main 窗口配置").toBeTruthy();
    expect(win.dragDropEnabled, "必须关掉 wry 原生拖放（否则页面内 HTML5 拖放全废）").toBe(false);

    const bridge = readFileSync("src-tauri/src/dropbridge.rs", "utf-8");
    expect(bridge, "必须用 ICoreWebView2File 取真实路径").toContain("ICoreWebView2File");
    expect(bridge, "必须发与 Tauri 逐字同名的事件（前端因此零改动）").toContain(
      '"tauri://drag-drop"',
    );
    const main = readFileSync("src-tauri/src/main.rs", "utf-8");
    expect(main, "主窗口必须装桥").toMatch(
      /dropbridge::install\(app\.handle\(\), windows::MAIN_LABEL\)/,
    );
    const wins = readFileSync("src-tauri/src/windows.rs", "utf-8");
    expect(wins, "卫星窗口建窗时必须一起关掉原生拖放").toContain(".drag_and_drop(false)");
    expect(wins, "卫星窗口必须装桥（文件也可以落在它上面）").toMatch(
      /dropbridge::install\(app, label\)/,
    );
  });

  it("标签拖拽必须走 HTML5 DnD：影像才能跟出窗口（B91-2）", () => {
    // 历史链：`dragDropEnabled: true` 时 wry 会 `SetAllowExternalDrop(false)` 并覆盖
    // 子窗口的 drop target，把页面内 HTML5 拖放一起废掉 —— 于是标签拖拽只能退化成指针
    // 编排，代价是影像是本窗口的一个 DOM 浮层：**指针一移出窗口就看不见了**（用户报的
    // 诉求）。B91 关掉那个开关（文件拖入改走路径桥），B91-2 顺势把标签拖拽换回
    // HTML5 DnD —— 影像交给系统绘制，跟出窗口、压在别的应用上都在。
    const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
    expect(ts.includes("draggable = true"), "标签必须可拖（HTML5 DnD 的入口）").toBe(true);
    expect(ts.includes('addEventListener("dragstart"'), "必须监听 dragstart").toBe(true);
    expect(ts.includes("startTabDrag("), "起拖必须走传输层（写载荷 + 交影像）").toBe(true);
    // 旧指针编排那套入口必须彻底消失，否则两套运输会互相打架
    expect(ts.includes("beginTabDrag"), "指针编排的入口不得残留").toBe(false);
    const sv = readFileSync("src/shell/splitview.ts", "utf-8");
    expect(
      sv.includes("getCurrentWebview"),
      "splitview 不得处理文件拖放（归 main.ts 原生通道）",
    ).toBe(false);
    // B91-2 之前这里断言「面板不得挂 drop 处理器」；现在由 tabdnd 挂**一份**页面级的，
    // 面板自己仍然不挂 —— 判定落在几何命中（panelAt / stripUnder）上，与事件目标无关。
    expect(sv.includes('addEventListener("drop"'), "面板仍不得自己挂 drop 处理器").toBe(false);
    expect(sv.includes("export function commitTabDrop"), "落点提交必须留在 splitview").toBe(true);
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
    // ② 自动保存/热退出备份只能在内容真的变化时排程（单纯移动光标不写盘）。
    //    B68 起两者并排成块，但**都**必须在 `textChanged && !suppressDirty` 门控内：
    //    热退出写的是副本，若跟着任意事务走，切换视图/点击内容区也会每 1s 写一次盘。
    expect(handler, "必须有 textChanged 门控").toContain("if (textChanged && !suppressDirty) {");
    const gated = handler.slice(handler.indexOf("if (textChanged && !suppressDirty) {"));
    expect(gated, "自动保存必须在门控分支里").toContain("scheduleAutosave();");
    expect(gated, "热退出备份也必须在门控分支里").toContain("scheduleBackup();");
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

    expect(css, "未保存时 ● 要能显示").toMatch(/\.tab-dirty[^{]*\.tab-mark\s*\{[^}]*opacity:\s*1/);
    expect(css, "悬停**已保存**标签显示 ×").toMatch(
      /\.tab:hover:not\(\.tab-dirty\)\s+\.tab-close[^{]*\{[^}]*opacity:\s*1/,
    );
    expect(css, "**已保存的**活动标签常驻 ×（关闭当前文件是高频操作，不该先悬停）").toMatch(
      /\.tab-active:not\(\.tab-dirty\)\s+\.tab-close[^{]*\{[^}]*opacity:\s*1/,
    );
    expect(css, "× 颜色继承标签文字色（VS Code 做法，非独立灰）").toMatch(
      /\.tab-close\s*\{[^}]*color:\s*inherit/,
    );

    const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
    expect(ts, "未保存必须打 tab-dirty（CSS 靠它决定槽位状态）").toContain("tab-dirty");
    expect(ts, "× 必须用矢量图标（CODICONS.close），不再是文本字形").toContain("CODICONS.close");
    expect(ts, "不得再用文本 ×").not.toContain('textContent = "×"');
    expect(ts, "未保存圆点必须走矢量（CODICONS.circleFilled）").toContain("CODICONS.circleFilled");
    expect(ts, "不得再用文本 ●").not.toContain('textContent = "●"');
  });

  it("B65 ● 与 × 不得同时显示（同槽位互斥，含 hover / 活动标签 / 拖拽影像）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");

    // × 的四个出场口（B66 起按保存状态分档）。回归点：老写法里「未保存的当前标签」
    // 必然同时带 `.tab-dirty` 与 `.tab-active`，于是 `.tab-dirty .tab-mark`（● 无条件亮）
    // 与 `.tab-active .tab-close`（× 常驻）双双 opacity: 1，叠死在同一个槽位里
    // （观感 = 一个带橙调的 ×）。B64 的拖拽影像克隆的正是活动标签、副本永不 :hover，
    // 同样中招。
    const DOORS = [
      ["关闭区悬停", ".tab-action:hover .tab-close"],
      ["关闭区聚焦", ".tab-action:focus-within .tab-close"],
      ["标签悬停（仅已保存）", ".tab:hover:not(.tab-dirty) .tab-close"],
      ["活动标签（仅已保存）", ".tab-active:not(.tab-dirty) .tab-close"],
    ] as const;

    const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const [label, sel] of DOORS) {
      expect(css, `${label}时必须能显示 ×`).toMatch(
        new RegExp(`${esc(sel)}[^{]*\\{[^}]*opacity:\\s*1`),
      );
    }

    // ● 的显示条件必须**显式排除**能与 `.tab-dirty` 同时命中的那两个口（关闭区悬停 /
    // 关闭区聚焦）：互斥就靠这一条 :not() 链。另两个口自带 `:not(.tab-dirty)`，
    // 不可能撞上，所以不必也不该出现在这条链里。
    const mark = cssDecls(css.match(/\.tab-dirty[^{]*\.tab-mark\s*\{[^}]*\}/)?.[0] ?? "");
    expect(mark, "应有「未保存时显示 ●」的规则").toBeTruthy();
    expect(mark, "● 只在指针不在关闭区时出场").toContain(".tab-action:not(:hover)");
    expect(mark, "● 不得在关闭键持有焦点时出场").toContain(":not(:focus-within)");

    // 反向：老写法必须消失 —— 少一条排除就会让 ● 与 × 同时亮。
    // 选择器可以写成独立规则，也可以并进逗号组，所以尾巴上的 `,` 与 `{` 都要抓。
    expect(css, "不得再把 ● 写成无条件常驻").not.toMatch(/\.tab-dirty\s+\.tab-mark\s*[,{]/);
    expect(css, "不得再靠「命中时把 ● 压回 0」的单点补丁（漏掉聚焦档就会复发）").not.toMatch(
      /\.tab-action:hover\s+\.tab-mark\s*[,{]/,
    );
    expect(css, "不得再让整个标签的悬停给脏标签换上 ×").not.toMatch(
      /\.tab:hover\s+\.tab-close\s*[,{]/,
    );
    expect(css, "不得再让脏标签的活动标签常驻 ×").not.toMatch(/\.tab-active\s+\.tab-close\s*[,{]/);

    // 非焦点面板的 × 降亮度同样要逐条对齐触发条件：无条件降亮度（B57 老写法）会让
    // 非焦点面板里**每个**标签都常驻一个 50% 的 ×，未保存标签的 ●（opacity: 1）
    // 就跟它叠在一起 —— 这是 B65 在分屏下的同一个病；B66 新增的两档也要一起补。
    expect(css, "非焦点面板不得无条件把 × 压到 0.5").not.toMatch(
      /\.layout-panel:not\(\.layout-panel-active\)\s+\.tab-close\s*\{/,
    );
    for (const [label, sel] of DOORS) {
      expect(css, `非焦点面板：${label}时 × 要暗一档（0.5 而不是 1）`).toContain(
        `.layout-panel:not(.layout-panel-active) ${sel}`,
      );
    }
    expect(css, "非焦点面板降亮度要落到 0.5").toMatch(
      /\.layout-panel:not\(\.layout-panel-active\)\s+\.tab-action:focus-within\s+\.tab-close[^{]*\{[^}]*opacity:\s*0\.5/,
    );
  });

  it("B66 未保存标签默认 ●，只有指针进入关闭区才换成 ×（用户要求）", () => {
    const css = readFileSync("src/styles/global.css", "utf-8");

    // 判据必须落在**关闭区**（`.tab-action` 那 20px 见方）上，而不是整个标签：
    // 挂到标签上就成了「指针划过文件名 ● 就消失」，不是用户要的行为。
    expect(css, "脏标签的 ● 随「关闭区未命中」出场").toMatch(
      /\.tab-dirty\s+\.tab-action:not\(:hover\)[^{]*\.tab-mark\s*\{[^}]*opacity:\s*1/,
    );
    expect(css, "…指针进关闭区时换出 ×").toMatch(
      /\.tab-action:hover\s+\.tab-close[^{]*\{[^}]*opacity:\s*1/,
    );
    expect(css, "…键盘落到关闭键上同样换出 ×").toMatch(
      /\.tab-action:focus-within\s+\.tab-close[^{]*\{[^}]*opacity:\s*1/,
    );

    // 反向：老写法（判据悬挂在 `.tab` 上）不得复活。
    expect(css, "不得再让整个标签的悬停收走 ●").not.toMatch(
      /\.tab-dirty:not\(:hover\)[^{]*\.tab-mark\s*\{/,
    );

    // 「关闭按钮区域」= ● 所在的那个固定槽位：× 必须铺满它，否则指针压在 ● 上
    // 却换不出 ×（或有缝隙时闪回 ●），手感直接错位。
    const layer = cssDecls(css.match(/\.tab-mark,\s*\.tab-close\s*\{[^}]*\}/)?.[0] ?? "");
    expect(layer, "× 与 ● 必须共用一个槽位").toMatch(/position:\s*absolute/);
    expect(layer, "槽位必须铺满（inset: 0），否则关闭区与 ● 的位置对不上").toMatch(/inset:\s*0/);
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
      ["深色", themeBlock(css, "dark")],
      ["浅色", themeBlock(css, "light")],
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
      expect(sv, "必须保留移除分屏按钮").toContain("CODICONS.close");
      expect(sv, "不得再有左右分屏按钮").not.toContain("splitH");
      expect(sv, "不得再有上下分屏按钮").not.toContain("splitV");
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
        ["深色", themeBlock(css, "dark")],
        ["浅色", themeBlock(css, "light")],
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
    const dark = themeBlock(g, "dark");
    const light = themeBlock(g, "light");
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
    const darkTheme = themeBlock(css, "dark");
    const lightTheme = themeBlock(css, "light");
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
    const darkTheme = themeBlock(css, "dark");
    const lightTheme = themeBlock(css, "light");
    expect(darkTheme, "深色落点为 accent 浅蓝").toContain("--drop-fill: rgba(76, 159, 254, 0.22)");
    expect(lightTheme, "浅色落点为 accent 浅蓝").toContain("--drop-fill: rgba(9, 105, 218, 0.22)");
    expect(darkTheme, "不得残留 VS Code 的深灰落点").not.toContain("rgba(83, 89, 93, 0.5)");

    // ③ 对齐联动：注册表 + 查找 + 双击复位转发（对标 sash.ts 的 linkedSash）
    expect(sv, "登记真实分隔条").toMatch(/sashRegistry\.push\(/);
    expect(sv, "按同向 + 中线容差查找对齐项").toMatch(/function alignedSashesOf/);
    expect(sv, "拖拽中同步联动目标").toMatch(/for \(const l of links\) applyTarget/);
    expect(sv, "松手回写联动目标").toMatch(/for \(const l of links\) l\.target\.commit/);
    // 双击复位要转发给联动条，且**联动集合必须先求**——centerOf 读的是实时几何，
    // 先 applyTarget 把本条挪到 50% 就会让集合变空（B62 用户反馈的真机 bug）
    const dblStart = sv.indexOf('addEventListener("dblclick"');
    expect(dblStart, "应能定位 dblclick 处理器").toBeGreaterThan(-1);
    const dbl = sv.slice(dblStart);
    expect(dbl, "双击按链整条一起调整").toMatch(
      /movingGroupOf\(targets\)\.map\(\(s\) => s\.chainId\)/,
    );
    expect(
      dbl.indexOf("movingGroupOf(targets)"),
      "联动集合必须先于改比例求出（否则只剩点中的那条居中）",
    ).toBeLessThan(dbl.indexOf("applyTarget"));
    expect(dbl, "整链按均分比例回写（不是一律 50%）").toMatch(/s\.target\.commit\(s\.equalRatio\)/);
    // 纯点击（无 mousemove）不得回写比例：命中区 7px 宽，点一下就能把两条对齐推到容差外
    expect(sv, "没有拖动就不回写比例").toMatch(/if \(!moved\) return;/);
    expect(css, ".linked 高亮（悬停可见的联动提示）").toMatch(/\.layout-sep\.linked::after/);
  });

  it("B63 交叉点联动 + 双击按分割数量均分（静态契约）", () => {
    const sv = readFileSync("src/shell/splitview.ts", "utf-8");
    const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");
    const code = stripComments(sv);

    // ① 「一起动的那一组」统一入口：每个拖拽目标自身 + 它同向对齐的伙伴。
    // 角手柄有 2 个目标（轴互相垂直）→ 两条轴各自的联动组都会被带进来。
    expect(code, "统一的移动组入口").toMatch(/function movingGroupOf\(targets: ResizeTarget\[\]\)/);
    expect(code, "组 = 自身 + 同向对齐伙伴").toMatch(
      /out\.push\(self\)[\s\S]{0,220}?alignedSashesOf\(self\)/,
    );
    expect(code, "按 target 身份反查注册项（交叉点两端都要查得到）").toMatch(
      /function sashOfTarget\(t: ResizeTarget\)/,
    );

    // ② 悬停/按下/拖动/松手都必须走这个组 —— 不能再有「corner 不联动」的分支。
    expect(code, "悬停高亮走移动组").toMatch(/mouseenter"[\s\S]{0,120}?movingGroupOf\(targets\)/);
    expect(code, "按下时求整组与联动条").toMatch(
      /const group = movingGroupOf\(targets\);[\s\S]{0,140}?const links = group\.filter/,
    );
    expect(code, "不得残留「角手柄不参与联动」分支").not.toMatch(/mode === "corner" \? \[\]/);

    // ③ 角手柄必须**复用子分隔条已注册的 target 对象**：注册表按 target 身份查伙伴，
    // 另造对象会让 sashOfTarget 找不到它，交叉点拖动时子轴一侧的联动失效。
    expect(code, "角手柄挂在子分隔条上").toMatch(/child\.sep\.appendChild\(cHandle\)/);
    expect(code, "角手柄复用子分隔条的 target").toMatch(
      /attachResize\(cHandle, \[self, child\.target\], "corner"\)/,
    );

    // ④ 同轴链 + 均分比例：沿轴向数段数，两侧段数相等即为均分点。
    expect(code, "链号随父沿用（同向才同链）").toMatch(
      /parent\.dir === node\.dir \? parent\.chainId : \+\+chainSeq/,
    );
    expect(code, "轴向段数递归").toMatch(
      /function segmentsAlong\(node: LayoutNode, d: "h" \| "v"\)/,
    );
    expect(code, "均分比例 = segA / (segA + segB)").toMatch(/equalRatio: segA \/ \(segA \+ segB\)/);
    // 链号自增源必须每次重绘归零（与注册表一同清），否则渲染结果不可复现
    expect(code, "chainSeq 随 sashRegistry 一同重置").toMatch(
      /sashRegistry = \[\];[\s\S]{0,240}?chainSeq = 0;/,
    );
    expect(code, "注册表登记链号与均分比例").toMatch(/chainId,\s*\n\s*equalRatio:/);
  });

  it("B67 方案文档不得再断言「双击复位到 50%」（与代码的均分语义冲突）", () => {
    // 用户按 `docs/split-view-plan.md` 的清单核对进度，而 O1 行与状态表还写着 B59 的
    // 旧语义（「双击分隔条复位到 50%」）→ 得出「这条还没做」的结论（实为文档没跟上 B63）。
    // 行为契约在代码与测试里（本文件 B63 块 + `splitview.test.ts` 的均分用例）；
    // 这条只挡「文档与代码说法冲突」这一种误导，不去锁文档的其他措辞。
    const doc = readFileSync("docs/split-view-plan.md", "utf-8");
    const sv = readFileSync("src/shell/splitview.ts", "utf-8");
    const code = sv.replace(/\/\*[\s\S]*?\*\//g, "");

    expect(code, "双击的语义取自 equalRatio（均分），不是常数").toMatch(
      /addEventListener\("dblclick"[\s\S]{0,400}?equalRatio/,
    );
    expect(code, "双击不得再写回常数 0.5").not.toMatch(
      /addEventListener\("dblclick"[\s\S]{0,400}?commit\(0\.5\)/,
    );

    const o1 = doc.split("\n").find((l) => l.startsWith("| **O1**")) ?? "";
    expect(o1, "改进项清单里有 O1 行").not.toBe("");
    expect(o1, "O1 行要写明按分割数量均分").toMatch(/按分割数量均分/);
    expect(o1, "O1 行不得再是「复位到 50%」").not.toMatch(/复位到\s*50%/);

    const status = doc.split("\n").find((l) => l.startsWith("| O1 双击复位")) ?? "";
    expect(status, "实施记录里有 O1 行").not.toBe("");
    expect(status, "状态表要指向 B63 改语义后的说明").toMatch(/B63|第十节/);
  });

  it("B64 标签拖拽影像交给系统绘制，能跟出窗口（静态契约）", () => {
    // 用户反馈：「标签拖动时，要像 vscode 那样有一个 tab 随光标移动的效果。」
    // VS Code 出处：`multiEditorTabsControl.ts:1295` —— 拖单个标签且 tabSizing 非
    // shrink 时 `e.dataTransfer.setDragImage(tab, 0, 0)`（注释：把被拖标签的左上角
    // 放到光标处，好给落点边框反馈让位）。本项目标签是 tabSizing: fixed（B56 起
    // 不收缩、不裁剪），正落在那一档。
    //
    // ⚠️ B91-2 起改用 **HTML5 DnD**：影像由 `setDragImage` 交**系统**绘制，指针移出
    // 窗口、压到别的应用上照样跟着走。B64–B90 那套指针编排的 DOM 浮层做不到这一点
    // （指针越过窗口边界就看不见了），那整套实现已删除。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
    const dnd = readFileSync("src/shell/tabdnd.ts", "utf-8");
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const tsCode = stripComments(ts);
    const dndCode = stripComments(dnd);

    // ① 标签元素必须可拖（`draggable = true`），起手写载荷 + 交影像 —— 只测 tabdnd 的
    //    setDragImage 会漏掉这层接线（没人调它照样「测试通过」）
    expect(tsCode, "标签元素可拖").toMatch(/el\.draggable = true;/);
    expect(tsCode, "起手写载荷并交出影像").toMatch(
      /startTabDrag\([\s\S]{0,200}?createTabDragImage\(el\),\s*\n\s*TAB_IMAGE_ANCHOR,/,
    );
    // 影像里的 × 是按钮：从它上面起拖会让用户「点关闭却拖走了标签」，显式挡掉
    expect(tsCode, "挡掉从关闭按钮起拖").toMatch(
      /closest\("\.tab-close"\)[\s\S]{0,140}?preventDefault\(\)/,
    );

    // ② 影像是原标签的**克隆**（原地不动的原标签才是参照物），且副本去掉 tabId
    //    （否则「按 tabId 查元素」会命中副本而非真标签）
    const imageFn = tsCode.match(/function createTabDragImage[\s\S]*?\n\}/)?.[0] ?? "";
    expect(imageFn, "影像工厂必须存在").not.toBe("");
    expect(imageFn, "影像是原标签的克隆").toMatch(/cloneNode\(true\) as HTMLElement/);
    expect(imageFn, "副本去掉 tabId").toMatch(/removeAttribute\("data-tab-id"\)/);

    // ③ 影像是「离屏挂进 body → 交快照 → **推一帧再摘**」：detached 元素在部分 Chromium
    //    版本上会拍成空图，所以必须先渲染；而 Chromium 是在 `dragstart` 派发**返回之后**
    //    才读元素拍快照的，**同步 `remove()` 会让快照时元素已 detached → 系统拿不到图**
    //    （用户报过「拖标签完全没有影像」）。所以摘除必须推到下一轮宏任务
    //    （对齐 VS Code `applyDragImage` 的 `setTimeout(() => dragImage.remove(), 0)`）。
    expect(dndCode, "影像离屏挂进 body").toMatch(/document\.body\.appendChild\(image\)/);
    expect(dndCode, "交给系统绘制（带锚点）").toMatch(
      /dt\.setDragImage\(image, anchor\.x, anchor\.y\)/,
    );
    expect(dndCode, "摘除必须推到下一轮宏任务，绝不能同步摘").toMatch(
      /setDragImage\(image, anchor\.x, anchor\.y\);[\s\S]{0,40}?setTimeout\(\(\) => image\.remove\(\), 0\)/,
    );

    // ③′ **不放 `text/plain`**：dataTransfer 里只要有一份可读文本，落点的 contenteditable
    //    编辑器就会把它当「拖进来的一段文本」插进正文（用户报过「拖标签会把文件名插进
    //    别的文档」）。标签拖拽是内部协议，只写私有 MIME。
    expect(dndCode, "不对外提供可读正文").not.toMatch(/setData\(\s*["']text\/plain["']/);
    expect(dndCode, "只写私有 MIME").toMatch(/dt\.setData\(TAB_MIME,/);

    // ③″ 监听一律挂**捕获阶段**：冒泡阶段的话，页面内组件（编辑器）会先收到事件并
    //     插入文本 —— 捕获阶段挂在 document 上比任何组件都早，拦得住。
    expect(dndCode, "事件监听挂捕获阶段").toMatch(/addEventListener\("drop", onDrop, CAPTURE\)/);
    expect(dndCode, "捕获阶段就 stopPropagation").toMatch(
      /e\.preventDefault\(\);\s*\n\s*e\.stopPropagation\(\)/,
    );

    // ④ 拖拽期间挂 body 类（禁文本选区）；收尾会摘掉（拖拽循环结束 / drop 就地收尾）
    expect(dndCode, "拖拽期间挂类").toMatch(/document\.body\.classList\.add\(TAB_DRAG_CLASS\)/);
    expect(dndCode, "收尾摘类").toMatch(/document\.body\.classList\.remove\(TAB_DRAG_CLASS\)/);

    // ⑤ 样式：快照源要**离屏但可渲染**（fixed + left/top 挪出屏），绝不能用
    //    display:none / visibility:hidden —— 不渲染就拍出一张空图。
    const imageRule = css.match(/\.tab-drag-image\s*\{[^}]*\}/)?.[0] ?? "";
    expect(imageRule, "快照容器规则必须存在").not.toBe("");
    expect(imageRule, "离屏摆放（fixed + 挪出屏）").toMatch(
      /position:\s*fixed[\s\S]*?left:\s*-10000px/,
    );
    expect(imageRule, "拍快照的容器绝不能隐藏（否则拍出空图）").not.toMatch(
      /display:\s*none|visibility:\s*hidden/,
    );
    // 不再是指针编排的常驻浮层：`pointer-events` / `z-index: 1000` 那套随之退场
    const ghostRule = css.match(/\.tab-drag-ghost\s*\{[^}]*\}/)?.[0] ?? "";
    expect(ghostRule, "影像不再是常驻浮层（交系统后无需拦截指针）").not.toMatch(
      /pointer-events:\s*none/,
    );
  });

  it("B72 整组拖拽影像 = VS Code 的聚合药丸，不再是裁剪的标签栏副本（静态契约）", () => {
    // 用户反馈：「面板整体拖拽时，随鼠标拖动的图案优化下，尤其是面板包含多个标签时，
    // 可以参考 vscode。」旧实现（B71）把整个 `.panel-tabstrip` 克隆成影像 + CSS
    // `max-width: 260px; overflow: hidden` 硬裁 → 最后一个标签被切掉半个，像坏了。
    // VS Code 出处：`editorTabsControl.ts:487-494` 拖整组时取活动标签名拼其余数量
    // （`localize('draggedEditorGroup', "{0} (+{1})")`），再交给 `applyDragImage`
    // 渲染成 `.monaco-drag-image`（`base/browser/ui/dnd/dnd.css`：12px、圆角 10px、
    // 单行、max-width + 省略号）。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const sv = readFileSync("src/shell/splitview.ts", "utf-8");
    const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const svCode = stripComments(sv);
    const tsCode = stripComments(ts);
    const pill = css.match(/\.tab-drag-ghost-group\s*\{([^}]*)\}/)?.[1] ?? "";
    const nameRule =
      css.match(/\.tab-drag-ghost-group \.tab-drag-ghost-name\s*\{([^}]*)\}/)?.[1] ?? "";
    const countRule =
      css.match(/\.tab-drag-ghost-group \.tab-drag-ghost-count\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(pill, "药丸规则必须存在").not.toBe("");
    expect(nameRule, "名字 span 规则必须存在").not.toBe("");
    expect(countRule, "计数 span 规则必须存在").not.toBe("");

    // ① 药丸本体：单行 + 圆角 + 收宽度（旧实现的整条带子硬裁已删除）
    expect(pill, "单行").toMatch(/white-space:\s*nowrap/);
    expect(pill, "圆角药丸").toMatch(/border-radius:\s*10px/);
    expect(pill, "12px（对齐 .monaco-drag-image）").toMatch(/font-size:\s*12px/);
    expect(pill, "宽度收住").toMatch(/max-width:\s*220px/);
    // ② 名字可截断：flex 子项要真截断，必须同时有 overflow:hidden 与 min-width:0
    //    （少了 min-width 就根本不会收缩，省略号静默不出现）
    expect(nameRule, "名字要能截断").toMatch(/overflow:\s*hidden/);
    expect(nameRule, "名字打省略号").toMatch(/text-overflow:\s*ellipsis/);
    expect(nameRule, "flex 子项必须 min-width: 0").toMatch(/min-width:\s*0/);
    // ③ 计数不可截断 —— 这正是有意偏离 VS Code 的那一处
    expect(countRule, "计数不得被压缩").toMatch(/flex:\s*0 0 auto/);

    // ④ 文案 = 活动标签名 (+其余数量)；计数只在多标签时出现
    //    （B91-2 起药丸工厂从 splitview 搬到 tabstrip，与标签副本影像同处一模块）
    expect(tsCode, "整组文案取活动标签名").toMatch(
      /querySelector<HTMLElement>\("\.tab\.tab-active"\)/,
    );
    expect(tsCode, "文案形态 name (+N)").toMatch(/\(\+\$\{tabs\.length - 1\}\)/);
    expect(tsCode, "计数判据 tabs.length > 1").toMatch(/if \(tabs\.length > 1\)/);
    expect(tsCode, "名字读不出来时不出现空药丸").toMatch(/`\$\{tabs\.length\} 个标签`/);
    // ⑤ 药丸是**纯文字**：不能再往里塞标签 DOM 副本（那正是旧实现的病根）；
    //    名字与计数必须是**两个** span（合成一个字符串的话 max-width 会把计数一起吃掉）
    const pillFn = tsCode.match(/function createGroupDragImage[\s\S]*?\n\}/)?.[0] ?? "";
    expect(pillFn, "药丸工厂必须存在").not.toBe("");
    expect(pillFn, "不得克隆标签栏").not.toMatch(/cloneNode/);
    expect(pillFn, "名字 span").toMatch(/className = "tab-drag-ghost-name"/);
    expect(pillFn, "计数 span").toMatch(/className = "tab-drag-ghost-count"/);

    // ⑤ 锚点分档：药丸 = setDragImage(pill, 10, 10)（指针落在药丸内部，「捏着它」），
    //    单标签 = setDragImage(tab, 0, 0)（左上角顶到指针）
    expect(tsCode, "药丸锚点 10,10").toMatch(
      /GROUP_IMAGE_ANCHOR: DragImageAnchor = \{ x: 10, y: 10 \}/,
    );
    expect(tsCode, "单标签锚点 0,0").toMatch(
      /TAB_IMAGE_ANCHOR: DragImageAnchor = \{ x: 0, y: 0 \}/,
    );
    // ⚠️ 「定义了常量却没人用」是最常见的漏网形态：起手处必须真把药丸影像与药丸锚点
    //    交给 startTabDrag（单标签侧由 tabstrip 自己交，见 B64）。
    expect(svCode, "整组起手交药丸影像 + 药丸锚点").toMatch(
      /createGroupDragImage\(strip\),\s*\n\s*GROUP_IMAGE_ANCHOR,/,
    );
  });

  it("B72 卫星窗口必须照抄主窗口的 WebView2 浏览器参数（静态契约）", () => {
    // 用户反馈：「卫星窗口打不开，状态栏提示『新窗口没能打开，标签保留在原窗口』」。
    //
    // 根因（可查证，不是猜的）：Windows 上同一进程的 WebView2 环境按用户数据目录复用，
    // Tauri 会给每个 WebView 兜底同一个目录（`tauri/src/manager/webview.rs`：
    // 「in `windows`, we need to force a data_directory」→ `%LOCALAPPDATA%\<identifier>`）。
    // 而 MS Learn `CoreWebView2Environment` 明写：「WebView creation fails if a running
    // instance using the same user data folder exists, and the Environment objects have
    // different CoreWebView2EnvironmentOptions」（同款故障在 WebView2Feedback#257 里的
    // 表现是 `0x8007139F`）。主窗口的参数来自 tauri.conf.json 的 `additionalBrowserArgs`
    // （含 `--disable-gpu`），而运行期 `WebviewWindowBuilder::new(...)` **不继承**这份配置
    // → 落到 wry 内置默认值（少了 `--disable-gpu`）→ 参数不一致 → 建窗直接失败。
    const rs = readFileSync("src-tauri/src/windows.rs", "utf-8");
    const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf-8")) as {
      app: { windows: Array<{ label?: string; additionalBrowserArgs?: string }> };
    };
    const mainArgs = conf.app.windows.find((w) => w.label === "main")?.additionalBrowserArgs;
    expect(mainArgs, "主窗口确实配了 additionalBrowserArgs（否则这条守卫没有对象）").toBeTruthy();

    // ① 取参数必须**读运行时配置**，不能抄成字面量 —— 抄一份就会随 tauri.conf.json 漂移，
    //    而漂移的后果就是「卫星窗口整个打不开」这种致命且难查的故障
    expect(rs, "参数从 app.config() 里取").toMatch(
      /fn shared_browser_args\(app: &AppHandle\)[\s\S]{0,160}?app\.config\(\)\.app\.windows/,
    );
    // ② main 条目说了算，缺失时才退回第一条
    expect(rs, "以 main 条目为准").toMatch(/\.find\(\|w\| w\.label == MAIN_LABEL\)/);
    expect(rs, "缺失时退回第一条").toMatch(/\.or_else\(\|\| windows\.first\(\)\)/);
    // ③ 必须真的喂给建窗器（「函数写对了但没人这么调」是最常见的漏网形态）
    const buildFn = rs.match(/fn build_satellite\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(buildFn, "build_satellite 存在").not.toBe("");
    expect(buildFn, "建窗时把参数喂进去").toMatch(
      /builder = builder\.additional_browser_args\(&args\);/,
    );
    // ④ 喂进去的必须是**取来的**那份，不能把 --disable-gpu 抄成字面量。
    // ⚠️ 断言范围必须卡在 build_satellite 函数体内、且先剥掉注释 —— 注释里恰恰要写明
    //    「为什么不能少 --disable-gpu」，对全文断言或忘了剥注释都会得到一条永远为真的守卫
    //    （这条守卫的第一版就是因为对全文断言而失效，反向验证时抓出来的）。
    const buildFnCode = buildFn.replace(/\/\/[^\n]*/g, "");
    expect(buildFnCode, "不得把 --disable-gpu 抄成字面量（会与 tauri.conf.json 漂移）").not.toMatch(
      /--disable-gpu/,
    );

    // ⑤ 失败原因必须带出来：原先两种情况（建窗失败 / 就绪超时）都只报一句
    //    「没能打开」，把 WebView2 拒绝创建这种可诊断的信息一起吞掉了
    const main = readFileSync("src/main.ts", "utf-8");
    expect(main, "失败原因按 label 存下来").toMatch(/failedLabels\.set\(l, e\.payload\?\.message/);
    expect(main, "detail 必须真的由原因拼出来").toMatch(
      /const detail = why \? `：\$\{why\}` : "：等待新窗口就绪超时";/,
    );
    expect(main, "提示里带上 detail").toMatch(/`新窗口没能打开\$\{detail\}，标签保留在原窗口`/);
    expect(rs, "Rust 侧把 message 一起发出来").toMatch(
      /"satellite-failed",[\s\S]{0,160}?"message": e\.to_string\(\)/,
    );

    // ⑥ 启动自检：把「实际生效的那份参数」落一行日志。这组参数不一致时界面上只有
    //    一句「新窗口没能打开」，没有别的线索 —— 这一行是唯一能事后定位的东西。
    const mainRs = readFileSync("src-tauri/src/main.rs", "utf-8");
    expect(mainRs, "启动时记录实际生效的浏览器参数").toMatch(
      /"browser args = \{:\?\}"[\s\S]{0,120}?windows::shared_browser_args/,
    );
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

  it("B39/B40 查找范围：不得有范围下拉与文件夹搜索，跨文档收敛为文档图标（方案 C）", () => {
    // 用户要求：查找替换悬浮栏无需查找文件夹功能，也不用下拉菜单选择查找范围——
    // 但「所有打开的文档」这个能力要保留。B73（方案 C）把它从勾选框收敛成
    // 带打开文档数徽标的文档图标按钮（对齐 VS Code），能力不变、只是换了形态。
    const bar = readFileSync("src/shell/findbar.ts", "utf-8");
    expect(bar, "查询对象不得再有 scope").not.toMatch(/\bscope\b/);
    expect(bar, "不得再有范围下拉控件").not.toContain("find-scope");
    expect(bar, "查找栏内不得出现任何 select 下拉").not.toContain('createElement("select")');
    expect(bar, "不得再有文件夹搜索控件").not.toContain("find-folder");
    expect(bar, "跨文档能力必须保留（方案 C：文档图标按钮）").toContain("find-docs");
    expect(bar, "文档图标必须带徽标（B80：跨文档命中的总匹配数）").toContain("find-badge");
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

  it("B73 查找栏方案 C：钉右上角（不可拖动）+ 图标开关 + 折叠替换行 + 紧凑计数", () => {
    // 用户从 A/B/C 三套预览方案里选了 C：对齐 VS Code 的紧凑浮层。
    const bar = readFileSync("src/shell/findbar.ts", "utf-8");
    // 去掉标题栏与拖动（方案 C 不再记忆/恢复位置）
    expect(bar, "不得再有可拖动的标题栏").not.toContain("find-bar-title");
    expect(bar, "不得再有位置持久化键").not.toContain("POS_KEY");
    expect(bar, "不得再挂布局拖拽类").not.toContain("layout-dragging");
    // 图标开关 + 折叠替换行 + 文档图标（`"find-toggle"` 带引号：容器叫 find-toggles，不能误命中）
    expect(bar, "匹配选项必须是图标开关").toContain('"find-toggle"');
    expect(bar, "替换行必须可折叠").toContain("find-row-replace");
    expect(bar, "chevron 控制替换行展开").toContain("find-chevron");
    // 查询对象要带新增两个开关
    expect(bar, "查询对象必须有 inSelection").toContain("inSelection");
    expect(bar, "查询对象必须有 preserveCase").toContain("preserveCase");

    const css = readFileSync("src/styles/global.css", "utf-8");
    const barBlock = css.match(/\.find-bar\s*\{[^}]*\}/)?.[0] ?? "";
    expect(barBlock, "浮层必须钉在右侧").toMatch(/right:\s*\d+px/);
    expect(barBlock, "浮层不得再用 left 定位").not.toMatch(/(^|[^-])left:\s*\d+px/);
    expect(css, "标题栏的 move 光标必须移除").not.toContain("cursor: move");
    expect(css, "无匹配变红的样式必须存在").toContain(".find-count-bad");
    expect(css, "图标开关激活态必须高亮").toMatch(/\.find-toggle\.on\s*\{/);
    expect(css, "文档图标徽标必须存在").toContain(".find-badge");
    // ⚠️ .find-row 是 display:flex，会盖掉 hidden 的 UA 样式 —— 折叠态必须显式 none
    expect(css, "折叠的替换行必须显式 display:none").toMatch(
      /\.find-row-replace\[hidden\]\s*\{[^}]*display:\s*none/,
    );

    const findKernel = readFileSync("src/editor/find.ts", "utf-8");
    expect(findKernel, "选区限制必须是可测的纯函数").toContain("export function restrictToRange");
    expect(findKernel, "保留大小写必须是可测的纯函数").toContain("export function preserveCase");

    // 计数改紧凑写法：不得再出现「第 N/M 处」这种冗长文案
    const main = readFileSync("src/main.ts", "utf-8");
    expect(main, "计数必须用紧凑的 N / M").toMatch(
      /bar\.setCount\(`\$\{idx \+ 1\} \/ \$\{matches\.length\}`\)/,
    );
    expect(main, "不得再用旧的「第 N/M 处」查找计数").not.toContain("第 ${idx + 1}/");
    expect(main, "预览态也不得用「第 … 处」查找计数").not.toContain("第 ${st.active + 1}/");
    expect(main, "在选区中查找必须把命中限定在选区").toContain("restrictMatches");
    expect(main, "替换必须支持保留大小写（接线到替换当前）").toContain(
      "applyPreserveCase(matched, q.replace)",
    );
  });

  it("B76 查找栏三处报障：状态行不占位 / 徽标必有数字 / 选区锚点必须冻结", () => {
    const bar = readFileSync("src/shell/findbar.ts", "utf-8");
    const css = readFileSync("src/styles/global.css", "utf-8");
    const main = readFileSync("src/main.ts", "utf-8");

    // ---- ① 浮层底部那条空白：状态行空文本时必须收起 ----
    // 用户实测：主行下面吊着一条空白。根因是 .find-status 一直挂着 min-height，
    // 而正常打开查找栏时主程序**从不调 setStatus**，空盒子就一直占着位置。
    expect(bar, "状态行创建后就必须先收起").toMatch(/status\.hidden = true/);
    expect(bar, "状态行必须有「空文本即收起」的派生逻辑").toMatch(/status\.hidden = !text/);
    expect(bar, "熄灭跨文档要连 a/b 一起清掉（别留下过期文案）").toMatch(
      /docA = 0;\s*\n\s*docB = 0;/,
    );

    // ---- ② 文档图标上的数字显示不出来：徽标数字必须自己存一份源真值 ----
    // 查找栏是懒建的，主程序要等搜完才知道总数；只把数字写进 DOM 的话，
    // 「先搜出结果、再点亮图标」会渲染出一个空徽标。
    // ⚠️ B80 起语义变了：徽标 = 跨文档命中的 **a/b**（a=当前文档序号，b=含结果文档数），
    //    所以源真值叫 docA/docB，由主程序用 setDocIndex 回灌。
    expect(bar, "徽标数字要自己存一份源真值").toMatch(/let docA = 0/);
    const syncBadgeBody = bar.match(/function syncBadge\(\)[^{]*\{([\s\S]*?)\n {2}\}/)?.[1] ?? "";
    expect(syncBadgeBody, "渲染时必须用记着的那份源真值").toMatch(
      /badge\.textContent = badgeText\(\)/,
    );
    expect(bar, "徽标渲染成 a/b（a=当前文档序号，b=含结果文档数）").toMatch(
      /docB > 0 \? `\$\{docA\}\/\$\{docB\}` : ""/,
    );
    expect(bar, "⚠️ 徽标不得再依赖 setDocCount（B78 旧语义已废弃）").not.toContain("setDocCount");
    expect(bar, "徽标数字只能由主程序回灌").toMatch(/setDocIndex: \(a, b\) => \{/);
    const badgeBlock = css.match(/\.find-badge\s*\{[^}]*\}/)?.[0] ?? "";
    expect(badgeBlock, "徽标必须收在按钮盒内，不得用负偏移溢出").not.toMatch(/\b(top|right):\s*-/);
    expect(badgeBlock, "徽标只是标注，不得抢按钮的点击").toContain("pointer-events: none");

    // ---- ③ 选区锚点必须冻结（点「下一个」后计数塌缩成 1 条）----
    // 根因：restrictMatches 每次实时读活动选区，而 stepFind 会把选区换成**命中本身**，
    // 于是第二次步进的范围就只剩这一个命中。
    // 最有效的一条判据：活动选区**只允许被读一次**（在播种锚点处）。
    const withoutDecl = main.replace(/function activeSelectionRange\(\)[^{]*\{[\s\S]*?\n\}/, "");
    const liveReads = [...withoutDecl.matchAll(/activeSelectionRange\(\)/g)];
    expect(liveReads, "activeSelectionRange 只允许在播种锚点时读一次").toHaveLength(1);
    const seedBody =
      main.match(/function seedFindSelectionAnchor\(\)[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(seedBody, "那唯一一次读取必须在 seedFindSelectionAnchor 里").toContain(
      "activeSelectionRange()",
    );
    expect(main, "判断范围一律读冻结锚点").toContain("currentFindRestrict(q)");
    expect(main, "不得再出现「实时取选区当范围」的写法").not.toMatch(
      /restrict:\s*q\.inSelection \? activeSelectionRange\(\)/,
    );
    expect(main, "锚点只在开关「刚被打开」时播种").toMatch(
      /if \(q\.inSelection !== findSelectionOn\)/,
    );
    expect(main, "重开查找栏时重播种").toMatch(
      /if \(findSelectionOn\) seedFindSelectionAnchor\(\)/,
    );
    expect(main, "换文档时重播种（旧偏移量无意义）").toMatch(
      /findSelectionAnchor\?\.docId !== activeTabIdOf\(\)\) seedFindSelectionAnchor\(\)/,
    );
    expect(main, "F3 那条 retarget 必须走同一处判断").toMatch(/else retargetFindBar\(\);/);
  });

  it("B77 查找栏外观对齐 VS Code：盒模型折算 / 扁平按钮 / 两档悬停 / 虚焦环", () => {
    // 用户要求「参考 VS Code 优化搜索悬浮框」。已按 docs/vscode-reference 里的
    // findWidget.css / findInput.css / toggle.css / inputBox.css 逐条对齐，
    // 拿不到出处的地方（跨文档文档图标、min-width 防抖）都在 CSS 注释里注明了。
    const css = readFileSync("src/styles/global.css", "utf-8");

    // ---- ① 浮层盒模型 = `.find-widget`（34px 高由 JS 写死，我们改由内边距自然量到）----
    const bar = ruleBlock(css, ".find-bar");
    expect(bar, "圆角 = cornerRadius-large（8px）").toMatch(/border-radius:\s*8px/);
    expect(bar, "投影必须共用 --shadow-lg（= VS Code --vscode-shadow-lg）").toContain(
      "box-shadow: var(--shadow-lg)",
    );
    expect(bar, "内边距左右必须是 9 / 4（VS Code `0 4px 0 9px`）").toMatch(
      /padding:\s*[\d.]+px\s+4px\s+[\d.]+px\s+9px/,
    );
    expect(bar, "浮层必须是定位基准（chevron 与关闭按钮都绝对定位在里面）").toMatch(
      /position:\s*(fixed|absolute)/,
    );

    // ---- ② 行盒模型 = `.find-part { margin: 3px 25px 0 17px }` ----
    // 左 17 给绝对定位的 chevron，右 25 给绝对定位的关闭按钮；两行共用同一组边距，
    // 于是主行与替换行的输入框左右边缘天然对齐。
    const row = ruleBlock(css, ".find-row");
    expect(row, "行要留出左右两条沟槽（25 / 17）").toMatch(/margin:\s*0\s+25px\s+0\s+17px/);
    expect(row, "行高 25px（= `.find-part .find-actions`）").toMatch(/height:\s*25px/);

    // ---- ③ 输入区：填充式无描边 + 聚焦向内 outline ----
    const field = ruleBlock(css, ".find-field");
    expect(field, "必须无描边（VS Code input.border 深浅两档都是 null）").toMatch(/border:\s*none/);
    expect(field, "底色必须走令牌，不得写死").toContain("background: var(--find-field-bg)");
    expect(field, "最小高度 25px（= `.monaco-inputbox`）").toMatch(/min-height:\s*25px/);
    const fieldFocus = ruleBlock(css, ".find-field:focus-within");
    expect(fieldFocus, "聚焦走 `.synthetic-focus` 的 outline").toMatch(/outline:\s*1px solid/);
    expect(fieldFocus, "⚠️ 必须 outline-offset:-1px，否则聚焦时整行抖 1px").toMatch(
      /outline-offset:\s*-1px/,
    );

    // ---- ④ 输入框内开关 = toggle.css（那份**自己声明了 border-box**，故不用折算）----
    const toggle = ruleBlock(css, ".find-toggle");
    expect(toggle, "开关宽 20px").toMatch(/width:\s*20px/);
    expect(toggle, "开关高 20px").toMatch(/height:\s*20px/);
    expect(toggle, "开关圆角 3px").toMatch(/border-radius:\s*3px/);
    expect(toggle, "⚠️ 常态边框必须是 transparent 的 1px（只占位不上色 → 激活时才不位移）").toMatch(
      /border:\s*1px solid transparent/,
    );
    expect(toggle, "内边距 1px").toMatch(/padding:\s*1px/);
    expect(toggle, "必须显式 border-box（toggle.css 原文如此）").toMatch(
      /box-sizing:\s*border-box/,
    );
    expect(toggle, "左间距 2px").toMatch(/margin-left:\s*2px/);
    expect(ruleBlock(css, ".find-toggle svg"), "开关图标 16px").toMatch(/width:\s*16px/);

    // 激活三态 = inputOption.active{Background,Border,Foreground} 三件套一起换
    const toggleOn = ruleBlock(css, ".find-toggle.on");
    expect(toggleOn, "激活底色 = inputOption.activeBackground").toContain("var(--find-opt-active)");
    expect(toggleOn, "激活边框 = inputOption.activeBorder").toContain(
      "var(--find-opt-active-border)",
    );
    expect(toggleOn, "激活字色 = inputOption.activeForeground").toContain(
      "var(--find-opt-active-fg)",
    );

    // ---- ⑤ 工具按钮：**22px 外框**（本项目全局 border-box，必须折算）----
    // ⚠️ 本节最容易被「照着 VS Code 抄」抄错的一处：VS Code 无全局 box-sizing，
    // 它的 `.button { width:16px; padding:3px }` 是 content-box → 外框 22px。
    // 我们全局是 border-box，照抄会得到 16px 外框 + 10px 内容盒，16px 图标直接溢出去。
    const btn = ruleBlock(css, ".find-nav");
    expect(btn, "外框必须写 22px（22 − 3×2 = 16 内容盒）").toMatch(/width:\s*22px/);
    expect(btn, "高度同样 22px").toMatch(/height:\s*22px/);
    expect(btn, "⚠️ 不得直接抄 16px：全局 border-box 下图标会溢出、悬停底色缩水").not.toMatch(
      /width:\s*16px/,
    );
    expect(btn, "内边距 3px").toMatch(/padding:\s*3px/);
    expect(btn, "圆角 5px（= VS Code `.button`）").toMatch(/border-radius:\s*5px/);
    expect(btn, "平常无底色（扁平式，不像工具栏按钮那样自带填充）").toMatch(/background:\s*none/);
    expect(btn, "平常无描边").toMatch(/border:\s*none/);
    expect(css, "按钮图标 16px").toMatch(
      /\.find-nav svg,[\s\S]{0,240}?\{\s*width:\s*16px;\s*height:\s*16px;/,
    );
    expect(css, "禁用态必须弱化而不是消失").toMatch(
      /\.find-nav:disabled,[\s\S]{0,200}?opacity:\s*0?\.\d+/,
    );

    // 关闭按钮 = `.button.codicon-widget-close { position:absolute; top:5px; right:4px }`
    // ⚠️ `.find-x` 先出现在上面那组扁平按钮列表里，这里要的是它自己的定位规则 → 按内容选。
    const close = ruleBlock(css, ".find-x", "position");
    expect(close, "关闭按钮必须脱离行流钉在浮层右上").toMatch(/position:\s*absolute/);
    expect(close, "上边距 5px（VS Code 同款）").toMatch(/top:\s*5px/);
    expect(close, "右边距 4px（VS Code 同款）").toMatch(/right:\s*4px/);

    // chevron = `.button.toggle { position:absolute; top:3px; left:4px; width:18px }`
    // ⚠️ left 让出最左 4px 给宽度手柄（.find-sash 占 left:0~4px），否则两者重叠（用户实测）。
    const chev = ruleBlock(css, ".find-chevron");
    expect(chev, "chevron 必须绝对定位在最左").toMatch(/position:\s*absolute/);
    expect(chev, "宽 18px（VS Code 同款）").toMatch(/width:\s*18px/);
    expect(chev, "让出最左 4px 给宽度手柄（left: 4px，不再与折叠按钮重叠）").toMatch(/left:\s*4px/);

    // ---- ⑥ 计数 = `.matchesCount` ----
    const count = ruleBlock(css, ".find-count");
    expect(count, "高 25px").toMatch(/height:\s*25px/);
    expect(count, "行高 23px").toMatch(/line-height:\s*23px/);
    expect(count, "内边距 2px 0 0 2px").toMatch(/padding:\s*2px\s+0\s+0\s+2px/);
    expect(count, "左边距 3px").toMatch(/margin-left:\s*3px/);
    expect(count, "居中").toMatch(/text-align:\s*center/);
    // 有意偏离：VS Code 用 JS 逐次测量写死宽度，我们固定 min-width 防抖（数字位数变化时
    // 右边那排按钮不会左右横跳），已在此与 CSS 注释里记录。
    expect(count, "固定 min-width 以防抖（有意偏离，已在注释说明）").toMatch(/min-width:\s*\d+px/);
    // 计数区必须常驻占位（用户第 4 点：无内容时显示「无内容」、不隐藏），
    // 故已删除 `.find-count:empty { min-width:0 }` 折叠规则。这里反向断言：
    // 全局 CSS 里**不得再存在**该折叠规则（否则空计数会被收起、与需求冲突）。
    expect(css, "空计数也必须占位（不得再有 :empty 折叠规则，始终显示无内容）").not.toMatch(
      /\.find-count:empty\s*\{/,
    );
    // 无匹配的红 = errorForeground；⚠️ 原先写成 `var(--error, #e5534b)`，
    // 而项目根本没有 --error 令牌 → 一直吃硬编码 fallback、不随主题走。
    const bad = ruleBlock(css, ".find-count-bad");
    expect(bad, "无匹配必须走 --danger 令牌").toContain("var(--danger)");
    expect(bad, "不得再引用不存在的 --error").not.toContain("--error");

    // ---- ⑦ 两档悬停色必须**各就各位**（VS Code 给的是两个不同的值）----
    // toolbar.hoverBackground @0x50 给工具栏按钮，inputOption.hoverBackground @0x80 给输入框内开关。
    // 抄成同一个值 = 「划过输入框开关比划过按钮亮一档」的层级感丢失。
    expect(css, "工具按钮悬停必须用 --find-btn-hover").toMatch(
      /\.find-nav:hover:not\(:disabled\),[\s\S]{0,300}?\{\s*background:\s*var\(--find-btn-hover\)/,
    );
    expect(ruleBlock(css, ".find-toggle:hover"), "开关悬停必须用 --find-opt-hover").toContain(
      "var(--find-opt-hover)",
    );
    expect(
      ruleBlock(css, ".find-docs:hover"),
      "文档图标属开关，也必须用 --find-opt-hover",
    ).toContain("var(--find-opt-hover)");

    // ---- ⑧ 焦点环必须是**虚线边框**而不是 outline ----
    // outline 画在边框外面 → 开关会视觉上胀 1px，一排开关在焦点移动时互相推挤。
    expect(css, "开关/文档图标的焦点环必须是虚线边框").toMatch(
      /\.find-toggle:focus-visible,\s*\n\s*\.find-docs:focus-visible\s*\{[^}]*border-style:\s*dashed/,
    );
    expect(css, "⚠️ 不得用 outline 画开关焦点环（会胀 1px）").not.toMatch(/outline:\s*1px dashed/);

    // ---- ⑨ 令牌：两套主题都要齐，且取值 = VS Code ----
    const dark = themeBlock(css, "dark");
    const light = themeBlock(css, "light");
    expect(dark, "深色 inputOption.hoverBackground = #5a5d5e80").toContain(
      "--find-opt-hover: #5a5d5e80",
    );
    expect(dark, "深色 toolbar.hoverBackground = #5a5d5e50").toContain(
      "--find-btn-hover: #5a5d5e50",
    );
    expect(light, "浅色两档在 VS Code 里**就是同一个值** #b8b8b850").toContain(
      "--find-opt-hover: #b8b8b850",
    );
    expect(light, "浅色 toolbar 档同为 #b8b8b850").toContain("--find-btn-hover: #b8b8b850");
    expect(dark, "activeForeground 深色档 = 白").toContain("--find-opt-active-fg: #ffffff");
    expect(light, "activeForeground 浅色档 = 黑（白字压浅蓝底读不出来）").toContain(
      "--find-opt-active-fg: #000000",
    );
    for (const [name, block] of [
      ["深色", dark],
      ["浅色", light],
    ] as const) {
      for (const v of [
        "--find-field-bg:",
        "--find-btn-hover:",
        "--find-opt-hover:",
        "--find-opt-active:",
        "--find-opt-active-border:",
        "--find-opt-active-fg:",
        "--find-sash:",
        "--find-sash-hover:",
        "--shadow-lg:",
      ]) {
        expect(block, `${name}主题缺 ${v}`).toContain(v);
      }
      expect(block, `${name}主题的激活边框必须走 accent`).toContain(
        "--find-opt-active-border: var(--accent)",
      );
    }
    // 投影只此一条，tooltip 与查找栏共用（VS Code 也是同一个 --vscode-shadow-lg）
    expect(css, "投影值 = VS Code style.css 的 --vscode-shadow-lg").toContain(
      "--shadow-lg: 0 0 12px rgba(0, 0, 0, 0.14)",
    );
    expect(css, "tooltip 与查找栏必须共用同一条投影").toMatch(/--tip-shadow:\s*var\(--shadow-lg\)/);

    // ---- ⑩ 状态行的收起必须有显式 [hidden] 兜底 ----
    // 与 .find-bar[hidden] 同理：一旦有人给 .find-status 加上 display，
    // UA 的 `[hidden] { display: none }` 就会被覆盖 → B76 那条底部空白复活。
    expect(css, "状态行必须有显式 [hidden] 收起").toMatch(
      /\.find-status\[hidden\]\s*\{[^}]*display:\s*none/,
    );
  });

  it("B78 查找栏七处观感：宽度手柄 / 折叠按钮变高 / 选区按钮移位 / 两个范围互斥 / 结果区常驻 / 两框同宽 / 替换图标", () => {
    // 用户反馈的七条：①左侧有宽度调节手柄 ②替换区展开后折叠按钮变高
    // ③选区查找按钮在上下箭头之后 ④选区查找与所有文档查找互斥
    // ⑤结果区始终保留空位（输入为空也显示无结果）⑥查找与替换输入框同宽 ⑦替换图标改进
    const css = readFileSync("src/styles/global.css", "utf-8");
    const bar = readFileSync("src/shell/findbar.ts", "utf-8");

    // ---- ① 左侧宽度手柄 = VS Code `.find-widget .monaco-sash`（sash.css 的 vertical 变体）----
    const sash = ruleBlock(css, ".find-sash");
    expect(sash, "手柄必须存在").not.toBe("");
    expect(sash, "必须绝对定位在浮层最左缘（findWidget.css 的 `left: 0 !important`）").toMatch(
      /position:\s*absolute/,
    );
    expect(sash, "必须贴左缘 left: 0").toMatch(/left:\s*0/);
    expect(sash, "宽 4px（= --vscode-sash-size）").toMatch(/width:\s*4px/);
    expect(sash, "高度铺满").toMatch(/height:\s*100%/);
    expect(sash, "光标必须是左右拉伸").toMatch(/cursor:\s*ew-resize/);
    expect(sash, "触屏要接管手势，否则会被页面滚动抢走").toMatch(/touch-action:\s*none/);
    // 高亮线画在 ::before 上：本体保持透明，只有悬停/拖拽时才显形（sash.css 的 .hover/.active）
    expect(css, "手柄的高亮必须走 ::before").toMatch(/\.find-sash::before/);
    expect(css, "悬停与拖拽都要亮").toMatch(
      /\.find-sash:hover::before,\s*\n\s*\.find-sash\.active::before/,
    );
    // 拖拽方向：浮层钉在右上角，手柄在左缘 → 往左拖 = 变宽（startX - currentX）
    expect(bar, "往左拖必须变宽（用 startX - currentX，别写反）").toMatch(
      /startW \+ \(startX - ev\.clientX\)/,
    );
    expect(bar, "双击手柄要能复原（同 VS Code 的 onDidReset）").toMatch(
      /sash\.addEventListener\("dblclick"/,
    );

    // ---- ② 替换行展开后折叠按钮变高（VS Code `.button.toggle { height: -webkit-fill-available }`）----
    const chevToggled = ruleBlock(css, ".find-bar.replace-toggled .find-chevron");
    expect(chevToggled, "展开态必须给 chevron 一个更高的高度").toMatch(/height:\s*53px/);
    // 53 = 主行 25 + 行间距 3 + 替换行 25。⚠️ 不能用 fill-available：在 LitePad 里它是相对
    // 整个浮层（含状态行）铺满，两行反而对不齐（CSS 注释里已记原因）。
    expect(css, "⚠️ chevron 不得用 fill-available（会跟着状态行一起长，两行对不齐）").not.toMatch(
      /find-chevron[\s\S]{0,200}?fill-available/,
    );
    expect(bar, "展开/折叠必须同步浮层上的 replace-toggled 类").toMatch(
      /dom\.classList\.toggle\("replace-toggled", on\)/,
    );

    // ---- ③ 选区按钮在上下箭头之后（VS Code find-actions：count → prev → next → selection）----
    expect(bar, "选区开关必须是工具栏那颗 .find-sel，不再是 .find-toggle").toMatch(
      /const selT = iconBtn\("find-nav find-sel"/,
    );
    expect(bar, "主行顺序必须是 …prev, next, selT…").toMatch(
      /rowMain\.append\(chevron, field, count, prev, next, selT, docsBtn, closeBtn\)/,
    );
    expect(css, "选区开关必须与 .find-nav 同尺寸（22×22 组里要有它）").toMatch(
      /\.find-nav,\s*\n\s*\.find-sel,/,
    );
    // 它是开关，激活态要出边框，但 .find-nav 是 border:none —— 加真 border 会把 16px 图标挤成 14px
    const selOn = ruleBlock(css, ".find-sel.on");
    expect(selOn, "激活环必须用 inset 阴影画（外框尺寸一动不动）").toMatch(
      /box-shadow:\s*inset 0 0 0 1px/,
    );
    expect(selOn, "激活底色复用开关那套令牌").toContain("var(--find-opt-active)");
    expect(selOn, "⚠️ 不得给 .find-sel.on 加真 border（border-box 下会挤掉 2px 图标）").not.toMatch(
      /border-color/,
    );

    // ---- ④ 选区查找与所有文档查找互斥 ----
    // 一个说「只搜光标选中的一段」，另一个说「搜全部已打开文档」，同时成立自相矛盾。
    expect(bar, "点亮选区必须熄掉跨文档").toMatch(
      /if \(on && docsBtn\.classList\.contains\("on"\)\) setAllDocs\(false\)/,
    );
    expect(bar, "点亮跨文档必须熄掉选区").toMatch(
      /if \(on && opt\.selection\) setSelection\(false\)/,
    );

    // ---- ⑤ 结果区已删除（B80）----
    // 用户实测反馈「右边的结果区没有一直占位，底下不要添加结果区」，并要求参考 VS Code：
    // VS Code 的查找浮层（findWidget.css / findWidget.ts）**没有任何内联结果列表** ——
    // 多文件结果在侧边栏的搜索视图里。我们这一栏只把总匹配数交给文档按钮的徽标。
    expect(css, "结果区样式必须删除").not.toContain(".find-results");
    expect(css, "空态占位样式必须删除").not.toContain(".find-empty");
    expect(css, "命中行样式必须删除").not.toContain(".find-hit");
    expect(bar, "查找栏不得再渲染结果区").not.toContain("find-results");
    expect(bar, "查找栏不得再持有命中表（命中表归主程序）").not.toMatch(/\bsetHits\b/);
    expect(bar, "查找栏不得再渲染「无结果」空态").not.toContain("无结果");
    // 删掉列表后，命中之间靠 Enter / 上下箭头跨文档步进（主程序侧）
    // ⚠️ 09-20 起跨文档**不再是命令**：搜索改由「查询/范围变化」统一触发（与另两种范围一致），
    // 回车在三种范围里一律是步进 —— 查找栏因此不再需要 onSearchAll / runSearch。
    expect(bar, "查找栏不得再持有跨文档搜索命令 onSearchAll").not.toMatch(/onSearchAll/);
    expect(bar, "查找栏不得再有跨文档专用的 runSearch 分支").not.toContain("runSearch");

    // ---- ⑥ 查找与替换输入框同宽 ----
    expect(css, "替换框必须改 flex: 0 0 auto 好让 JS 写死宽度").toMatch(
      /\.find-row-replace \.find-field\s*\{[^}]*flex:\s*0 0 auto/,
    );
    expect(bar, "必须把查找框量出来的宽度写到替换框上").toMatch(/replField\.style\.width = /);
    // jsdom（测试）没有布局，量出来是 0 —— 写死 0px 会让替换框彻底消失
    expect(bar, "⚠️ 无布局时必须不下手，别写死 0px").toMatch(/if \(w <= 0\) return;/);

    // ---- ⑦ 图标全部照搬 VS Code 的 codicon（B80）----
    // 用户要求「按钮图标可以直接照搬 vscode 的，如果参考源码里没有就先下载到参考源码」。
    // codicon 只以字体（codicon.ttf）+ 码位发布，参考仓库里拿不到轮廓 —— 于是
    // scripts/fetch-codicons.mjs 从官方包 `@vscode/codicons` 的 src/icons/*.svg 抽取，
    // 生成 src/shell/codicons.ts（生成物，勿手改），参考副本落在 docs/vscode-reference/codicons/。
    const icons = readFileSync("src/shell/codicons.ts", "utf-8");
    expect(icons, "codicons.ts 必须写明上游来源与版本").toContain("@vscode/codicons@");
    expect(icons, "必须声明是生成物（防手改）").toContain("不要手改");
    const fetchScript = readFileSync("scripts/fetch-codicons.mjs", "utf-8");
    expect(fetchScript, "必须有可重跑的上游抽取脚本").toContain("@vscode/codicons");
    expect(fetchScript, "必须把「图标名 → 官方文件名」逐条列出").toContain("ICONS");
    // 每一颗都得是 currentColor 填充（否则不跟主题变色）；视图框尺寸不做统一要求
    // （官方那里 files 就是 24 视图框，抽取时已把 width/height 归一到 16）。
    const svgTags = [...icons.matchAll(/<svg[^>]*>/g)].map((m) => m[0]);
    expect(svgTags.length, "至少 13 颗图标").toBeGreaterThanOrEqual(13);
    for (const tag of svgTags) {
      expect(tag, "必须有 viewBox").toContain("viewBox=");
      expect(tag, "必须是 currentColor 填充（跟随主题）").toContain('fill="currentColor"');
      expect(tag, "落到 16px 图标位：width/height 必须是 16").toContain('width="16"');
    }
    expect(icons, "必须含「在选区中查找」用的 find-selection").toContain("findSelection");
    // 查找栏侧：所有图标一律来自 CODICONS，不得再有文字字形或自绘 svg
    expect(bar, "必须从 codicons.ts 取图标").toContain('from "./codicons"');
    expect(bar, "不得再自绘 svg（应全部走 CODICONS）").not.toContain("<svg");
    const innerHtmlLines = bar.match(/innerHTML = .*/g) ?? [];
    expect(innerHtmlLines.length, "图标是懒建的，必须仍走 innerHTML 注入").toBeGreaterThan(0);
    for (const line of innerHtmlLines) {
      // CODICONS.x（具名）或 CODICONS[icon]（工厂传名）都算，重点是不能写死字形
      expect(line, "图标只能来自 CODICONS，不得再写死字形").toMatch(/CODICONS[.[]/);
    }
  });

  it("B80 查找栏三处对齐：左缘手柄不再生硬 / 删除底部结果区 / 图标照搬 codicon", () => {
    // 用户实测三条：①左侧拖拽高亮条很生硬且有错位 ②底下不要结果区，多文档时只在文档
    // 按钮右上角显示总匹配数 ③按钮图标直接照搬 VS Code。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const bar = readFileSync("src/shell/findbar.ts", "utf-8");
    const main = readFileSync("src/main.ts", "utf-8");

    // ---- ① 左缘手柄对齐 VS Code（findWidget.css + sash.css）----
    // 「错位」的根因：VS Code 的 `.find-widget` 带 `overflow: hidden`，那条 4px 手柄被
    // 8px 圆角裁掉两端的直角；我们原先没有 → 方角从圆角里戳出来，看着就是错位。
    expect(ruleBlock(css, ".find-bar"), "浮层必须照抄 overflow: hidden（圆角裁手柄）").toMatch(
      /overflow:\s*hidden/,
    );
    const sash = ruleBlock(css, ".find-sash");
    expect(sash, "手柄常态就是一条淡线（resizeBorder→border = fg@20%）").toContain(
      "background: var(--find-sash)",
    );
    const before = ruleBlock(css, ".find-sash::before");
    expect(before, "::before 常态透明（只负责悬停变色）").toMatch(/background:\s*transparent/);
    expect(before, "⚠️ 必须带 0.1s 缓动，否则变色是瞬间跳（用户实测「很生硬」）").toMatch(
      /transition:\s*background-color 0\.1s ease-out/,
    );
    // 「生硬」的另一半根因：原先高亮只有 2px、还从 left:1px 起，与 4px 手柄和浮层边缘都对不上
    expect(before, "::before 必须铺满手柄本体（100%），别再内缩 1px / 缩成 2px").toMatch(
      /width:\s*100%/,
    );
    expect(css, "悬停/拖拽换成 sash.hoverBorder（→ focusBorder = --accent）").toMatch(
      /\.find-sash:hover::before,\s*\n\s*\.find-sash\.active::before\s*\{\s*background:\s*var\(--find-sash-hover\)/,
    );

    // ---- ② 底部结果区删除，跨文档 a/b 进文档图标徽标 ----
    // （样式与 DOM 的删除已在 B78-⑤ 里断言，这里盯主程序的接线）
    expect(main, "必须有「清空跨文档命中」的收口").toMatch(/function resetFindAll\(/);
    expect(main, "跨文档查找必须把 a/b 回灌给徽标").toMatch(/updateDocBadge\(\)/);
    expect(main, "徽标数字不得再由「已打开文档数」喂（B78 旧语义）").not.toContain("setDocCount");
    expect(main, "查询变更要重搜一次，让徽标跟着实时走").toMatch(
      /if \(q\.allDocs\) runFindInDocs\(q\);/,
    );
    expect(main, "stepFind 必须把跨文档范围转给跨文档步进").toMatch(
      /if \(q\.allDocs\) \{\s*\n\s*stepFindInDocs\(dir, q\);/,
    );
    expect(main, "跨文档步进要在命中表里前后环绕").toMatch(
      /\(findHitIndex \+ dir \+ findHits\.length\) % findHits\.length/,
    );
    // ⚠️ 命中表不能再截断：它同时是「总匹配数」的来源，截断会让徽标少报数
    const searchBody = main.match(/function searchOpenDocs\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(searchBody, "searchOpenDocs 不得再截断到 300 条").not.toMatch(/300/);
    expect(searchBody, "必须扫全部已打开文档的内存快照").toMatch(
      /for \(const doc of docs\.values\(\)\)/,
    );
    // ⚠️ 09-20 起跨文档不再是「带播报标记的命令」：范围/查询变化即重算（不带 announce），
    // 且不再往底部状态行写「共 N 处匹配，回车逐个跳转」（另两种范围都没有这条提示）。
    expect(main, "查询/范围变化必须统一重算跨文档命中").toMatch(
      /if \(q\.allDocs\) runFindInDocs\(q\);/,
    );
    expect(main, "「共 N 处匹配，回车逐个跳转」提示必须删除").not.toContain("回车逐个跳转");
    expect(main, "onOpenHit 回调必须删除（已经没有结果列表可点）").not.toContain("onOpenHit");
    // 关栏即清：否则下次打开会带着上一次的总数
    expect(main, "关栏时必须清空命中表").toMatch(
      /clearFindHighlight\(\);\s*\n\s*resetFindAll\(\);/,
    );

    // ---- 查找栏侧：a/b 只由 setDocIndex 单点驱动，且不再有任何结果区痕迹 ----
    expect(bar, "徽标只能由 setDocIndex 回灌").toMatch(/setDocIndex: \(a, b\) => \{/);
    expect(bar, "查询一变就作废旧的 a/b（别挂着过期数字）").toMatch(/docA = 0;\s*\n\s*docB = 0;/);
    expect(bar, "不得再有结果区 / 命中表的任何痕迹").not.toMatch(
      /find-results|renderResults|setHits|setDocCount/,
    );
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
  }, 60000);

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

// md 扩展名清单在多个文件各写一份，必须同步。
// B70 三档（菜单开着不弹提示 / 删菜单项提示 / 命令面板两处修复）的行为断言见文件
// 末尾的「B70 提示与菜单」块 —— 这里不再重复同一约束，否则改一处要同步两处。
it("md 扩展名集合在多处各写了一份，必须完全一致", () => {
  // filedrop 里那份随 B70 B 档判据改动删掉了，剩下的三处（main ×2 + outline）仍要同步：
  // 不一致会出现「面板认它是 Markdown、导出却不认」这种半吊子状态。
  // ⚠️ 只比 Markdown 那一条：outline 里还另有一组「配置类扩展名」，那不是同一件事。
  const outline = readFileSync("src/markdown/outline.ts", "utf-8");
  const mainSrc = readFileSync("src/main.ts", "utf-8");
  const literals = [...`${mainSrc}\n${outline}`.matchAll(/\\\.\([a-z|]+\)\$/g)]
    .map((m) => m[0])
    .filter((s) => s.includes("markdown"));
  expect(literals.length, "至少三处（main ×2 + outline ×1）").toBeGreaterThanOrEqual(3);
  expect(new Set(literals).size, "各处必须完全一致").toBe(1);
  expect(literals[0]).toBe("\\.(md|markdown|mdown|mkd)$");
});

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

// 取 `:root[data-theme="X"] { ... }` 的**块体**（不含选择器）。
// ⚠️ 必须先剥注释、再按花括号配对计数，不能图省事写 `\{[^}]*\}`：
// 变量块里只要有一条注释含 `}`（例如注释里写 `inputOption.active{Foo,Bar}`），
// 那个 `[^}]*` 就会**从注释里的花括号处截断**，块内后面的变量全被判「缺失」。
// 结果是双向失真 —— 既会把「注释里写了个花括号」误报成「变量漏定义」（假红），
// 也可能在截断点之后恰好没有断言对象时**静默放行**（假绿）。
function themeBlock(css: string, theme: "dark" | "light"): string {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const m = new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{`).exec(code);
  if (!m) return "";
  const open = m.index + m[0].length - 1; // 指向 `{`
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code.charAt(i);
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return "";
}

// 剥掉整行 `//` 注释（保留行号不变，便于报错定位）。
// ⚠️ 源码断言必须落在**代码**上：本文件/源码里常有说明性注释，里面会原样复述被断言的
// 标识符（B79 就在注释里写了 `persistSettings()` 与 `themeMode = normalizeMode(...)`）。
// 反向验证实测：挖掉真正的调用后，只要比对整份文件，断言照样通过（**假绿**）。
// 只剥「整行都是注释」的行，行内的 `//`（如 URL `https://`）不受影响。
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((l) => (/^\s*\/\//.test(l) ? "" : l))
    .join("\n");
}

// 取某条规则的**声明块体**（同样剥注释 + 数花括号）。selector 直接当字面量用。
// 支持三种写法：
//   · 单选择器 `.find-bar { }`
//   · 选择器列表里的一员 `.find-nav, ... .find-x { }`（会自动扫到列表末尾的那个 `{`）
//   · 同一选择器出现多次时用 filter 指定取哪一条：
//       - 数字 = 取第 n 处；
//       - 字符串 = 取**块体里含该声明**的那一处（推荐，比数序号稳）。
//     例：`.find-x` 先出现在扁平按钮列表里，自己还有一条定位规则 →
//     `ruleBlock(css, ".find-x", "position")`
// ⚠️ 新写的用例请用它，不要再用 `\.foo\s*\{[^}]*\}` —— 那个写法在块内注释含 `}` 时
// 会从注释处截断：断言 `toContain` 会误报「缺失」（假红），而断言 `not.toContain`
// 会**静默通过**（假绿），后者尤其危险。
// TODO(backlog): 文件里还有 ~46 处旧写法待迁移，见 .workbuddy/memory/open-items/backlog.md。
function ruleBlock(css: string, selector: string, filter?: number | string): string {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 选择器后必须是边界字符，免得 `.find-row` 命中 `.find-row-replace`
  const re = new RegExp(`${esc}(?=[\\s,{])`, "g");
  let seen = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    seen++;
    const open = code.indexOf("{", m.index);
    if (open < 0) return "";
    // 选择器与该 `{` 之间只允许出现选择器列的字符（`.a, .b:hover > c[attr="x"]`）。
    // 判据：中间**不能出现 `;` / `}`** —— 那说明已经越过上一条声明或上一条规则，
    // 撞到的是别处的 `{`（例如 `.foo` 恰好在某个属性值里被提到）。
    const between = code.slice(m.index + m[0].length, open);
    if (/[;{}]/.test(between)) continue;
    let depth = 0;
    let body = "";
    for (let i = open; i < code.length; i++) {
      const ch = code.charAt(i);
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          body = code.slice(open + 1, i);
          break;
        }
      }
    }
    if (typeof filter === "string") {
      if (body.includes(filter)) return body;
      continue;
    }
    if (typeof filter === "number" && seen < filter) continue;
    return body;
  }
  return "";
}

// 断样式规则时先剥掉注释：注释里常写「旧值是什么」（如 flex: 0 1 auto），
// 不剥离的话 not.toMatch 会被自己的文档误伤。
function cssDecls(block: string): string {
  return block.replace(/\/\*[\s\S]*?\*\//g, "");
}

// 截某个顶层函数的源码体（源文本里第一条「行首 } 后紧跟换行/EOF」，即顶层收尾花括号）。
// ⚠️ 不能只找第一条 `\n}`：多行返回类型字面量也会以 `} {` 出现在行首
//（如 `function f(): {\n  a: number;\n} {`），那样会在签名处就截断，
// 于是函数体内所有断言都变成「找不到」——B71 ④ 的 sessionTabRecordOf 就踩过这个坑。
function topLevelFnBody(fileText: string, name: string): string {
  const start = fileText.indexOf(name);
  if (start < 0) return "";
  let end = fileText.indexOf("\n}", start);
  while (end > -1) {
    const after = fileText[end + 2];
    if (after === undefined || after === "\n") break;
    end = fileText.indexOf("\n}", end + 1);
  }
  return fileText.slice(start, end + 2);
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
// ⚠️ `.tmp` 与 `generated-images` 同理：都是**永不入库、可随时整目录删掉**的临时落点
//    （见 MEMORY.md「临时文件一律落在本项目内」），里面允许放历史副本 —— 历史副本里
//    提到旧名是「对过去的记录」，不是会泄漏到产品里的命名残留。少了这条，
//    往 .tmp/ 扔一个引用旧名的探针脚本就会把全仓改名守卫判红（09-18 B72 推送时实测）。
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "target",
  "gen",
  ".git",
  ".tmp",
  "generated-images",
  ".vite",
  // 内部智能体目录（skills/memory），不随产品发布，且体积庞大；
  // 全仓库文本扫描在此跳过以保 pre-push 门禁稳定（内存文件豁免也覆盖不到的慢路径）。
  ".workbuddy",
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

  it("B64 标签拖拽要有跟随光标的浮动影像（静态契约）", () => {
    // 用户反馈：「标签拖动时，要像 vscode 那样有一个 tab 随光标移动的效果。」
    // VS Code 出处：`multiEditorTabsControl.ts:1295` —— 拖单个标签且 tabSizing 非
    // shrink 时 `e.dataTransfer.setDragImage(tab, 0, 0)`（注释：把被拖标签的左上角
    // 放到光标处，好给落点边框反馈让位）。本项目标签是 tabSizing: fixed（B56 起
    // 不收缩、不裁剪），正落在那一档；但拖拽是指针事件自编排的（WebView2 原生拖放
    // 钩子禁用了页面内 HTML5 DnD），拿不到浏览器影像 → 自己造浮层。
    const css = readFileSync("src/styles/global.css", "utf-8");
    const sv = readFileSync("src/shell/splitview.ts", "utf-8");
    const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
    const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");
    const svCode = stripComments(sv);

    // ① tabstrip 必须把标签元素交出去（只测 splitview 入参会漏掉这层接线）
    expect(ts, "tabstrip 传标签元素给 beginTabDrag").toMatch(/beginTabDrag\(t\.tabId, e, el\)/);
    // B71 起多了 groupPanelId（拖整组）：签名断言放宽到「四参、后两个可空」
    expect(sv, "beginTabDrag 接受标签元素与整组面板").toMatch(
      /export function beginTabDrag\(\s*\n\s*tabId: number,\s*\n\s*e: MouseEvent,\s*\n\s*tabEl: HTMLElement \| null = null,\s*\n\s*groupPanelId: number \| null = null,\s*\n\)/,
    );
    // 事件目标可能是图标/文件名等子元素 → 必须反查
    expect(svCode, "从事件目标反查所在标签").toMatch(/target\.closest<HTMLElement>\("\.tab"\)/);

    // ② 越过阈值才亮出影像（纯点击不该闪副本）；必须克隆而非搬走原标签
    // B72：分岔成两种影像 —— 整组走「聚合药丸」，单标签才克隆标签元素
    expect(svCode, "进入拖拽时造副本").toMatch(
      /dragGhost = group \? createGroupDragGhost\(tabDrag\.tabEl\) : createDragGhost\(tabDrag\.tabEl\)/,
    );
    expect(svCode, "影像是原标签的克隆（原地不动的原标签才是参照物）").toMatch(
      /const copy = \w+\.cloneNode\(true\) as HTMLElement;/,
    );
    expect(svCode, "副本去掉 tabId（否则按 tabId 查元素会命中副本）").toMatch(
      /copy\.removeAttribute\("data-tab-id"\)/,
    );

    // ③ 跟随光标：锚点 = 左上角（setDragImage(tab, 0, 0) 的语义），且要放在
    //    「离开面板就 return」之前 —— 拖到面板之外影像同样得跟着走
    // B89 起第三个参数是「出界时贴边」的开关，跟随本身没变
    expect(svCode, "拖拽中持续跟随光标").toMatch(/moveDragGhost\(e\.clientX, e\.clientY/);
    const moveIdx = svCode.indexOf("moveDragGhost(e.clientX, e.clientY");
    expect(moveIdx, "应能定位跟随调用").toBeGreaterThan(-1);
    expect(moveIdx, "跟随必须在落点判定之前，否则拖到面板外影像会僵住").toBeLessThan(
      svCode.indexOf("previewDropAt(e.clientX, e.clientY, e.altKey)"),
    );

    // ④ 收尾必须清理（松手 / 重复进入 / 拖出窗口失焦三条路径）
    expect(svCode, "收尾移除影像").toMatch(
      /function finishTabDrag[\s\S]{0,420}?removeDragGhost\(\)/,
    );
    expect(svCode, "拖到窗口外失焦即取消（mouseup 收不到）").toMatch(
      /window\.addEventListener\("blur", finishTabDrag\)/,
    );

    // ⑤ 样式：浮层 + 不拦截指针（否则会掐断下方元素的 :hover，自绘提示层也会误判）
    expect(css, "影像浮层").toMatch(/\.tab-drag-ghost\s*\{[^}]*position:\s*fixed/);
    expect(css, "影像不得拦截指针").toMatch(/\.tab-drag-ghost\s*\{[^}]*pointer-events:\s*none/);
    expect(css, "层级与弹出菜单同档（VS Code .monaco-drag-image 也是 1000）").toMatch(
      /\.tab-drag-ghost\s*\{[^}]*z-index:\s*1000/,
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
    const svCode = sv.replace(/\/\*[\s\S]*?\*\//g, "");
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
    expect(sv, "整组文案取活动标签名").toMatch(/querySelector<HTMLElement>\("\.tab\.tab-active"\)/);
    expect(sv, "文案形态 name (+N)").toMatch(/\(\+\$\{tabs\.length - 1\}\)/);
    expect(sv, "计数判据 tabs.length > 1").toMatch(/if \(tabs\.length > 1\)/);
    expect(sv, "名字读不出来时不出现空药丸").toMatch(/`\$\{tabs\.length\} 个标签`/);
    // ⑤ 药丸是**纯文字**：不能再往里塞标签 DOM 副本（那正是旧实现的病根）；
    //    名字与计数必须是**两个** span（合成一个字符串的话 max-width 会把计数一起吃掉）
    const pillFn = sv.match(/function createGroupDragGhost[\s\S]*?\n\}/)?.[0] ?? "";
    expect(pillFn, "药丸工厂必须存在").not.toBe("");
    expect(pillFn, "不得克隆标签栏").not.toMatch(/cloneNode/);
    expect(pillFn, "名字 span").toMatch(/className = "tab-drag-ghost-name"/);
    expect(pillFn, "计数 span").toMatch(/className = "tab-drag-ghost-count"/);

    // ⑤ 锚点分档：药丸 = setDragImage(pill, -10, -10)（指针落在药丸内部），
    //    单标签 = setDragImage(tab, 0, 0)（左上角顶到指针）
    expect(svCode, "药丸锚点 -10,-10").toMatch(/GHOST_ANCHOR_PILL = \{ x: 10, y: 10 \}/);
    expect(svCode, "单标签锚点 0,0").toMatch(/GHOST_ANCHOR_TAB = \{ x: 0, y: 0 \}/);
    expect(svCode, "跟随光标时应用锚点").toMatch(/let left = x - dragGhostAnchor\.x;/);
    expect(svCode, "锚点同样作用于纵向").toMatch(/let top = y - dragGhostAnchor\.y;/);
    expect(svCode, "整组挂药丸锚点").toMatch(
      /dragGhostAnchor = group \? GHOST_ANCHOR_PILL : GHOST_ANCHOR_TAB/,
    );
    // 影像收尾要把锚点复位，否则下一次单标签拖拽会带着药丸的 10px 偏移
    expect(svCode, "收尾复位锚点").toMatch(
      /function removeDragGhost[\s\S]{0,160}?dragGhostAnchor = GHOST_ANCHOR_TAB/,
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
    expect(main, "「跟随系统」档须照搬官方 color-mode（半明半暗的圆）").toContain(
      "CODICONS.colorMode",
    );
    expect(main, "不得再退回明暗二选一的旧写法").not.toContain('isDark ? "light" : "dark"');

    // 导出图标（B51 本来改过一次语义：下载托盘 → 文档 + 出向箭头）现在直接照搬官方
    // `export`，手绘版已删 —— 字形由上游版本钉住（scripts/fetch-codicons.mjs 的 VERSION），
    // 这里只守「确实来自 codicon」。
    const codicons = readFileSync("src/shell/codicons.ts", "utf-8");
    expect(codicons, "导出图标必须来自官方 export").toContain("export:");
  });

  it("B81 图标红线：按钮图标一律走 codicon，手绘只剩 sun/moon（用户确认豁免）", () => {
    // 用户要求：「软件里按钮图标全部使用 vscode 图标集中的图标（如果没有合适的就和我商量
    // 去下载别的图标集），不要自己绘制 svg（除非和我讨论确认或者我明确要求）。」
    // 据此：消费方一律从 codicons.ts 取；源码里不得再内联手绘字形。

    // ---- ① 消费方一律不得手绘 <svg> ----
    const CONSUMERS = [
      "src/main.ts",
      "src/shell/tabstrip.ts",
      "src/shell/splitview.ts",
      "src/shell/findbar.ts",
      "src/shell/fileicons.ts",
      "src/editor/editor.ts",
    ] as const;
    for (const f of CONSUMERS) {
      expect(readFileSync(f, "utf-8"), `${f} 不得手绘 <svg>，图标必须来自 CODICONS`).not.toContain(
        "<svg",
      );
    }

    // ---- ② 工具栏整张表都得是 codicon 名（旧的自绘名 new/open/find/outline 已废） ----
    const main = readFileSync("src/main.ts", "utf-8");
    for (const pair of [
      '[btnNew, "newFile"]',
      '[btnOpen, "folderOpened"]',
      '[btnSave, "save"]',
      '[btnSaveAs, "saveAs"]',
      '[btnFind, "search"]',
      '[btnOutline, "listTree"]',
      '[btnExport, "export"]',
    ]) {
      expect(main, `工具栏缺 ${pair}`).toContain(pair);
    }
    expect(main, "工具栏必须从 CODICONS 取名取图").toContain("btn.innerHTML = CODICONS[name]");

    // ---- ③ 文件类型字形也必须走 codicon（不得再自建手绘字形表） ----
    const fi = readFileSync("src/shell/fileicons.ts", "utf-8");
    expect(fi, "家族字形必须从 CODICONS 取").toContain("CODICONS[");
    expect(fi, "不得再自建 GLYPHS 手绘表").not.toContain("GLYPHS");

    // ---- ④ 手绘豁免只有 icons.ts 的 sun / moon 两颗 ----
    // 官方 639 颗 codicon 里没有日/月字形（最接近的 color-mode 已用于「跟随系统」），
    // 经用户确认这两颗保留手绘；其余任何键冒出来都说明有人又手绘了图标。
    const icons = readFileSync("src/shell/icons.ts", "utf-8");
    const body = icons.slice(icons.indexOf("export const ICONS = {"), icons.indexOf("} as const;"));
    const keys = [...body.matchAll(/\n {2}(\w+):/g)].map((m) => m[1]);
    expect(keys, "icons.ts 只应剩 sun / moon（其余一律 codicon）").toEqual(["sun", "moon"]);
  });

  it("B82 CHANGELOG 生成器不得吞掉区间内最后一个提交（git log 无尾换行）", () => {
    // 事故：v0.8.0 的 CHANGELOG 少了本版唯一的 feat 条目（a3bc51f）。
    // 根因：`git log --pretty=format:'%h%x1f%s'` 的最后一条记录**不带尾换行**，而
    // `while IFS=… read` 在「有内容但无换行」的 EOF 上返回非 0 → 循环体不执行 →
    // 区间内**最旧**的提交被静默丢弃（新→旧排列下，丢的正好是本版头号 feature）。
    // 修法：循环条件补 `|| [ -n "$sha" ]`。这条断言就是防止它被「简化」回去。
    const sh = readFileSync("scripts/gen-changelog.sh", "utf-8");
    expect(sh, '读循环必须补 EOF 兜底（|| [ -n "$sha" ]），否则吞提交').toContain(
      'read -r sha subj || [ -n "$sha" ]',
    );
  });

  it("B83 pre-push 的 windres 目录必须归一成 POSIX 路径（Windows 风格条目是死路）", () => {
    // 事故：钩子打印「cargo test（windres: C:/msys64/mingw64/bin）」，看起来工具链找到了，
    // cargo 却 panic `NotAttempted("windres")` —— 因为 MSYS 下 `C:/…` 风格的 PATH 条目
    // 既搜不到、也不会被转成可用形式传给**原生**子进程（cargo → build.rs → embed-resource）。
    // 归一成 `/c/msys64/mingw64/bin` 后 40 个 Rust 测试全绿（实测）。
    // ⚠️ 这条与 COREUTILS_DIR 的 `cd … && pwd` 是同一类教训：命中路径必须规范化。
    const hook = readFileSync(".githooks/pre-push", "utf-8");
    expect(hook, "WINDRES_DIR 必须经 `cd … && pwd` 归一，不能直接用 C:/… 条目").toContain(
      'WINDRES_DIR="$(cd "$w" 2>/dev/null && pwd)"',
    );
  });

  it("B84 pre-push 必须先本地构建并产出 release exe（exe 不刷新 ⇒ 截图也刷不了）", () => {
    // 09-20 复盘：v0.7.0 / v0.8.0 连续两个版本没刷新 `docs/screenshots/main.png`，
    // 当时归因为「沙箱拍不了图」，真正原因是 **release exe 是旧的** ——
    // `release.sh <ver> --ci` 会跳过本地构建，而 `scripts/capture-screenshots.py` 的
    // 前置就是 `src-tauri/target/release/litepad.exe`。把构建做成 pre-push 的硬门后，
    // exe 每次推送都是新的，截图随时可拍。
    // ⚠️ 断言必须**先剥 `#` 注释**再比：本守卫要找的 `npm run build`、
    //   `beforeBuildCommand` 等字样在说明性注释里同样出现，直接比对整份文件的话，
    //   挖掉真正的命令照样通过 —— B79 那条已经踩过一次这种假绿。
    const raw = readFileSync(".githooks/pre-push", "utf-8");
    const hook = raw
      .split("\n")
      .map((l) => (/^\s*#/.test(l) ? "" : l))
      .join("\n");

    expect(hook, "pre-push 必须跑前端构建（tsc + vite）").toContain("npm run build");
    expect(hook, "pre-push 必须生成 release exe").toContain("npm run tauri -- build");
    expect(
      hook,
      "必须置空 beforeBuildCommand，否则 tauri 会把 vite 再跑一遍（build-all.sh 里卡死过）",
    ).toContain('{"build":{"beforeBuildCommand":""}}');
    expect(hook, "vite 清 dist/assets 会被 safe-delete 钩子拦，必须关掉").toContain(
      "CODEBUDDY_SAFE_DELETE_ENABLED=0",
    );
    // 「构建命令返回 0 却没写出 exe」出现过，光看退出码不够
    expect(hook, "必须复核 exe 真的产出，不能只信退出码").toContain(
      "src-tauri/target/release/litepad.exe",
    );
    // 硬门：构建失败必须阻断推送，不是警告跳过
    expect(hook, "release 构建失败必须 exit 1 阻断推送").toMatch(
      /release 构建未通过[\s\S]*?exit 1/,
    );
  });

  it("B85 vite 构建前必须剥离 PATH 里的 MSYS2 条目（否则 vite 挂死）", () => {
    // 09-20 实测坐实（此前只标为「疑点未定论」）：PATH 里带 `/c/msys64/mingw64/bin`
    // （为给 cargo 提供 windres 而加）时，`vite build` 会**挂死** —— 不是慢，是不动：
    // CPU 只走 ~25s 就停、内存涨到 1.8G、`dist/assets` 被清空后一直不写入，
    // 挂 13 分钟也不出产物。同一指纹 09-19 在 build-all.sh 里出现过两次。
    // 摘掉这些条目后同一条命令 **40s** 完成。
    // ⚠️ 同样先剥 `#` 注释再断言（注释里也写了 `msys64` / `npm run build`）。
    const stripHash = (src: string) =>
      src
        .split("\n")
        .map((l) => (/^\s*#/.test(l) ? "" : l))
        .join("\n");
    const hook = stripHash(readFileSync(".githooks/pre-push", "utf-8"));
    const buildAll = stripHash(readFileSync("scripts/build-all.sh", "utf-8"));

    expect(hook, "pre-push 必须过滤掉含 msys64 的 PATH 条目").toContain("*msys64*) ;;");
    expect(hook, "前端构建必须用剥离后的 PATH 跑，不能直接用原 PATH").toContain('PATH="$FE_PATH"');
    // ⚠️ 剥离 PATH **不足以兜住**：09-20 钩子内实测剥离后仍挂在写盘阶段（内存 ~1.7G），
    // 而手动跑同一命令 71s 就完成 —— 是间歇性的。所以必须有超时 + 重试，
    // 否则一次挂死就会把推送无限期卡住（第一次就是挂了 12 分钟才被人工杀掉）。
    expect(hook, "vite 必须带超时，挂死时能自己退场").toContain("timeout -k 10 240");
    expect(hook, "超时/失败后要重试一次，别把间歇性挂死当真失败").toMatch(/for attempt in 1 2/);
    // build-all.sh 顶部恰恰把 msys64 前插进 PATH，是卡死的原发地，同样要剥
    expect(buildAll, "build-all.sh 的前端构建同样必须剥离 MSYS2 条目").toContain(
      'PATH="$FE_PATH" npm run build',
    );
  });

  it("B86 三种查找范围共用同一套触发与计数逻辑（不再靠回车触发搜索）", () => {
    // 事故：点亮「所有打开的文档」后既不刷新结果也不更新按钮，改搜索文本同样没反应，
    // **必须再按一次回车**才搜。两个根因：
    //   ① 查找栏把跨文档做成**独立命令**（onSearchAll），只有回车会调它；
    //   ② 主程序 `runFindInDocs` 刚写完计数，紧随其后的 `refreshFindCount()` 又因
    //      `q.allDocs` 把它覆盖成「无内容」→ prev/next 被置灰，看起来就是「没触发」。
    // 修法：搜索统一由「查询或范围变化」触发；计数统一由 `refreshFindCount()` 一个出口产出；
    // 回车在三种范围里一律是步进（下一个 / 上一个）。
    const main = stripLineComments(readFileSync("src/main.ts", "utf-8"));
    const bar = stripLineComments(readFileSync("src/shell/findbar.ts", "utf-8"));

    // ① 触发统一：回车不再按范围分叉
    expect(bar, "回车在三种范围里一律是步进，不得再按 allDocs 分叉").not.toContain("q.allDocs");
    expect(bar, "查找栏不再有跨文档专用搜索入口").not.toContain("runSearch");
    expect(main, "范围/查询变化必须统一重算跨文档命中").toMatch(
      /if \(q\.allDocs\) runFindInDocs\(q\);/,
    );

    // ② 计数统一：跨文档也走 refreshFindCount 这一个出口
    const refresh = main.match(/function refreshFindCount\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(refresh, "refreshFindCount 必须覆盖跨文档范围").toContain("q.allDocs");
    expect(refresh, "跨文档有命中时计数 = 当前序号 / 总数").toMatch(/findHits\.length/);
    expect(refresh, "跨文档有文本无命中时显示「无匹配」（与单文档一致）").toContain("无匹配");
    // ⚠️ 关键回归点：早先这里一律写「无内容」，会顺带把 prev/next 置灰
    expect(refresh, "跨文档不得一律写成「无内容」").not.toMatch(/q\.allDocs[\s\S]{0,200}无内容/);

    // ③ 底部提示：跨文档不再写「共 N 处匹配，回车逐个跳转」
    expect(main, "删除「共 N 处匹配，回车逐个跳转」提示").not.toContain("回车逐个跳转");

    // ④ 步进后同样走那一个出口，不再自己写计数/状态行
    const step = main.match(/function stepFindInDocs\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(step, "跨文档步进后必须走 refreshFindCount").toContain("refreshFindCount()");
    expect(step, "跨文档步进不得再自己写状态行").not.toContain("setStatus");
  });

  it("B79 主题：档位必须写回 settings 才存得下；三态按钮一律不点亮", () => {
    // ⚠️ 断言必须落在**代码**上，不能落在整份文件上：上面这段说明性的注释里就写着
    // `persistSettings()` 和 `themeMode = normalizeMode(settings?.theme)`，
    // 反向验证实测——挖掉真正的调用后，只要还比对整份文件，断言照样通过（假绿）。
    // 所以先剥掉整行注释再断言。
    const main = stripLineComments(readFileSync("src/main.ts", "utf-8"));

    // ---- ① 落盘：settings.theme 必须被写回 ----
    // 用户实测「每次打开都是深色」。根因：启动时读的是 `settings.theme`，而 setThemeMode
    // 只改了内存里的 themeMode，**没写回 settings** —— persistSettings() 存的是整个对象，
    // 于是 theme 永远是启动时的 "system"，深色系统下解析出来就是深色。
    // ⚠️ 判据必须落在「写回」这个动作上：只断言「调了 persistSettings」会假绿（一直在调）。
    const setBody =
      main.match(/async function setThemeMode\(mode: ThemeMode\)[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(setBody, "setThemeMode 必须把档位写回 settings（否则根本存不下来）").toMatch(
      /settings\.theme = mode/,
    );
    expect(setBody, "写回之后必须落盘").toContain("persistSettings()");
    expect(main, "启动时必须按 settings.theme 还原档位").toContain(
      "normalizeMode(settings?.theme)",
    );

    // ---- ② 激活态：循环按钮三档外观必须一致 ----
    // 用户实测「深色模式按钮带激活状态，其它模式没有」。旧代码是
    // `btnTheme.classList.toggle("tool-btn-active", themeMode === "dark")`：
    // 它是**循环按钮**不是开关，「激活」没有语义，且只有深色档点亮 = 三档观感各不相同。
    expect(main, "⚠️ 主题按钮不得再按深色档点亮（循环按钮没有「激活」语义）").not.toMatch(
      /btnTheme[\s\S]{0,160}?tool-btn-active/,
    );
    expect(main, "当前档位仍要写进 data 属性供测试/样式用").toContain("btnTheme.dataset.themeMode");
    // .tool-btn-active 本身还要留着（自动换行等开关按钮在用），别整条删掉
    const css = readFileSync("src/styles/global.css", "utf-8");
    expect(css, "开关按钮的激活态样式必须保留").toContain(".tool-btn.tool-btn-active");
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
    // 必须在**深色块体内**取 --bg：原先用 `[data-theme="dark"][\s\S]*?--bg:` 是非贪婪
    // 跨块匹配，深色块一旦丢了 --bg 就会一路扫进浅色块、拿浅色的值来比对（假绿）。
    const cssDark = /--bg:\s*#([0-9a-fA-F]{6})/.exec(themeBlock(css, "dark"));
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
  // B68 起预取里多了「先问副本」这一步，但仍然是同一个 Promise.all 扇出。
  it("restoreSession 内必须先把文件并行预取好，再按序组装标签", () => {
    const src = readFileSync("src/main.ts", "utf-8");
    const start = src.indexOf("async function restoreSession");
    expect(start, "必须能定位 restoreSession").toBeGreaterThan(-1);
    const body = src.slice(start, start + 8000);
    expect(body, "必须并行预取（Promise.all）").toContain("Promise.all");
    expect(body, "必须有预取缓存 restoredCache").toContain("restoredCache");
    expect(body, "组装阶段应读缓存而不是再读盘").toContain("restoredCache.get(");
    expect(body, "组装循环里不得再逐个 await openFile（那是串行的老写法）").not.toMatch(
      /const file = await openFile\(/,
    );
    // B68：预取必须是「副本优先、文件兜底」——先 restoreBackup，拿不到才 openFile
    expect(body, "副本必须先问，原文件作为兜底").toMatch(
      /await restoreBackup\([\s\S]*?await openFile\(/,
    );
  });
});

describe("B68 热退出：关窗不询问，下次启动还原未保存内容", () => {
  const src = readFileSync("src/main.ts", "utf-8");
  const api = readFileSync("src/ipc/api.ts", "utf-8");
  const rustBackup = readFileSync("src-tauri/src/backup/mod.rs", "utf-8");
  const rustCommands = readFileSync("src-tauri/src/commands/mod.rs", "utf-8");
  const rustMain = readFileSync("src-tauri/src/main.rs", "utf-8");

  /** 截取某个顶层函数的源码体（见顶层 topLevelFnBody 的说明）。 */
  function fnBody(name: string): string {
    const body = topLevelFnBody(src, name);
    expect(body, `必须能定位 ${name}`).not.toBe("");
    return body;
  }

  it("关窗流程：先 flush 副本，逐文档确认后才跳过确认框，否则仍要问", () => {
    const body = fnBody("function registerWindowClose");
    // 排程中的备份（1s 防抖）必须在关窗时立刻兑现——防抖窗口里关窗是最常见的丢数据场景
    expect(body, "关窗前必须取消防抖排程").toMatch(
      /cancelPendingBackup\(\);[\s\S]*?settings\?\.hot_exit/,
    );
    expect(body, "必须等待 flushBackups 落盘").toContain("await flushBackups();");
    // 判定必须逐文档查 backedUp，而不能只信 flushBackups 的返回值
    expect(body, "必须以 backedUp 逐文档判定").toMatch(
      /filter\(\(d\) => d\.dirty && !d\.backedUp\)/,
    );
    // 兜底确认框必须还在：备份失败 / 关掉热退出时不能静默丢内容
    expect(body, "备份没成时必须退回确认框").toContain("未保存的内容将丢失");
    // 跳过确认框之前必须先把会话写下来，否则重启后没人认领那些副本
    const fast = body.slice(body.indexOf("if (settings?.hot_exit)"));
    expect(fast, "快路径必须先存会话再关窗").toMatch(
      /const unbacked[\s\S]*?saveSession\(snapshotSession\(\)\)[\s\S]*?\.close\(\)/,
    );
  });

  it("保存 / 自动保存 / 重载后必须丢弃副本（否则旧快照会顶掉已保存内容）", () => {
    for (const fn of ["async function saveDocCore", "function scheduleAutosave"]) {
      expect(fnBody(fn), `${fn} 里转干净后必须丢弃副本`).toContain("discardBackupFor(doc)");
    }
  });

  it("副本 ID 只能含白名单字符（它直接参与拼路径，防穿越）", () => {
    const body = fnBody("function newBackupId");
    expect(body, "必须用密码学随机源").toContain("crypto.getRandomValues");
    expect(body, "必须只产出十六进制").toContain("toString(16)");
    expect(body, "只用连字符分隔").toContain('"-"');
    // 白名单必须与 Rust 侧一致
    expect(rustBackup, "Rust 侧必须有同款白名单校验").toContain("pub fn is_valid_id");
    expect(rustBackup, "白名单必须是 ascii_alphanumeric + '-'").toMatch(
      /is_ascii_alphanumeric\(\)\s*\|\|\s*c == '-'/,
    );
  });

  it("副本是独立文件，格式自带魔数与头部，且从不写原文件", () => {
    expect(rustBackup, "必须有版本化魔数").toContain('MAGIC: &str = "LitePadBackup/1"');
    expect(rustBackup, "副本落在 %APPDATA%\\LitePad\\backups").toContain(
      '.join("LitePad").join("backups")',
    );
    // write_backup 命令只收内容与元数据，没有任何「写到 path」的动作
    const wb = rustCommands.slice(rustCommands.indexOf("pub fn write_backup"));
    expect(wb.slice(0, 900), "write_backup 只应交给 backup::write").toContain("backup::write(");
    // 四条命令都要注册进 invoke_handler，否则前端调用会静默失败
    for (const cmd of [
      "commands::write_backup",
      "commands::restore_backup",
      "commands::discard_backup",
      "commands::discard_orphan_backups",
    ]) {
      expect(rustMain, `${cmd} 必须注册`).toContain(cmd);
    }
  });

  it("同一文档在多个面板时只预取一次（否则副本会还原成两份不同步的文档）", () => {
    const body = src.slice(src.indexOf("async function restoreSession"));
    // 同一个文件可以同时在多个面板打开并共用同一份 doc（同源多实例）。
    // 若按「面板索引|路径」各取一次，`restore_backup` 每次都新建标签，
    // 就会得到两份**互不同步**的文档，把同源多实例悄悄破坏掉。
    expect(body, "预取 key 只能是文档身份，不能带面板索引").toMatch(
      /const key = identityOf\(st\);/,
    );
    expect(body, "组装阶段必须按同一身份键取值").toContain("restoredCache.get(identityOf(st))");
    expect(body, "不得再出现带面板索引的缓存键").not.toContain("${i}|");
  });

  it("会话必须带上 backupId，未命名文档靠它才能恢复", () => {
    expect(src, "会话快照必须写 backupId").toContain("backupId: d.backupId");
    // 没有路径的未命名文档，只有在备份区里确实有副本时才该进会话
    // （B69 起拆成两步 return：先认 path/副本，再补「热退出 + 空的未命名」，
    //  后半条的判定与守卫见下面 B69 块）
    expect(src, "有路径或有副本的立即入会话").toMatch(
      /if \(d\.path \|\| d\.backedUp\) return true;/,
    );
  });

  it("孤儿副本清理必须以「会话读成功」为前提（防会话坏掉时误删全部副本）", () => {
    const body = fnBody("async function bootstrap");
    expect(body, "清理必须在 restored 为真时才做").toMatch(/if \(restored\) \{[\s\S]*?keep/);
    expect(body, "keep 只收已备份的文档").toMatch(/filter\(\(d\) => d\.backedUp && d\.backupId\)/);
  });

  it("前端必须按 camelCase 读 IPC 字段（size_class / size_hint 是真实事故）", () => {
    // B68 之前 api.ts 把这两个字段写成 snake_case，于是 `file.size_class` 恒为
    // undefined → normalizeSizeClass 回落 "normal" → **M4 大文件降级从未生效**。
    // Rust 侧 `rename_all = "camelCase"` 才是线上真名（有 cargo 测试钉住）。
    expect(api, "OpenedFile 必须用 sizeClass").toMatch(/sizeClass: string;/);
    expect(api, "OpenedFile 必须用 sizeHint").toMatch(/sizeHint: string;/);
    expect(api, "不得再有 snake_case 的 size_class 声明").not.toContain("size_class: string");
    expect(src, "不得再读 file.size_class").not.toContain("file.size_class");
    expect(src, "不得再读 file.size_hint").not.toContain("file.size_hint");
    expect(src, "必须读 file.sizeClass").toContain("normalizeSizeClass(file.sizeClass)");
  });

  it("两个开关是独立的，且默认值对齐 VS Code 桌面版", () => {
    const menubar = readFileSync("src/shell/menubar.ts", "utf-8");
    expect(menubar, "文件菜单要有热退出项").toContain("热退出（关窗不询问）");
    expect(menubar, "热退出走独立回调").toContain("onToggleHotExit");
    expect(src, "热退出默认开（?? true）").toContain("settings?.hot_exit ?? true");
    expect(src, "自动保存默认关（?? false）").toContain("settings?.autosave ?? false");
    // 关掉热退出时必须把现存副本一并丢掉，否则「关了还生效」
    const off = fnBody("async function setHotExit");
    expect(off, "关掉热退出要丢弃现存副本").toMatch(/if \(!on\) discardAllBackups\(\);/);
  });
});

describe("B69 空的新建文档也要跨重启回来", () => {
  // 用户报告：热退出开着，新建了但还没打字的空文档，下次打开却没了。
  // 根因：它既没有 path、也不脏（没输入 → 不写副本），而 B68 的会话包含条件是
  // 「有 path || 有副本」，于是整条被漏掉。改法是靠 docId 认领。
  const src = readFileSync("src/main.ts", "utf-8");
  const api = readFileSync("src/ipc/api.ts", "utf-8");
  const rustSession = readFileSync("src-tauri/src/session/mod.rs", "utf-8");

  /** 截取某个顶层函数的源码体（见顶层 topLevelFnBody 的说明）。 */
  function fnBody(name: string): string {
    const body = topLevelFnBody(src, name);
    expect(body, `必须能定位 ${name}`).not.toBe("");
    return body;
  }

  it("快照接纳空的未命名文档，但**绝不**接纳「脏却没备份成功」的", () => {
    // B71 ④ 起「值不值得进会话」抽到了 sessionWorthy（卫星窗口与隐藏实例共用同一判据），
    // 所以断言跟着挪到那个函数体上 —— 判据本身没变。
    const body = fnBody("function sessionWorthy");
    // 空文档（无 path、不脏）必须进会话，否则重启后凭空消失
    expect(body, "热退出开着时要接纳「无路径且不脏」的文档").toMatch(
      /settings\?\.hot_exit === true && !d\.dirty/,
    );
    // ⚠️ 反向约束：判定必须带 !d.dirty。若退化成「无路径就收」，
    // 「脏、但备份失败」的未命名文档也会被收进去，恢复时按空文档处理
    // ——那会真的把用户打的字丢掉。那种情况只能走关窗确认框。
    expect(body, "判定必须同时约束 dirty，不能只看有没有路径").toMatch(/!d\.dirty/);
    // 有路径或有副本的立即放行（B68 的原判据）
    expect(body, "有路径或有副本的立即入会话").toMatch(
      /if \(d\.path \|\| d\.backedUp\) return true;/,
    );
  });

  it("空文档靠 docId 认领：会话 schema 与快照都要带上", () => {
    expect(rustSession, "Rust TabSession 必须有 doc_id").toMatch(/pub doc_id: Option<u64>/);
    expect(rustSession, "doc_id 要有 snake_case alias 兼容旧会话").toMatch(
      /#\[serde\(alias = "doc_id"\)\]/,
    );
    expect(api, "前端 TabSession 必须有 docId").toMatch(/docId\?: number \| null;/);
    // 标签记录构造抽到了 sessionTabRecordOf（面板标签与卫星标签共用），断言跟过去
    expect(fnBody("function sessionTabRecordOf"), "快照必须写入 docId").toMatch(/docId: d\.tabId,/);
  });

  it("恢复时按 docId 认身份：同一个空文档在多个面板只造一份", () => {
    const body = fnBody("async function restoreSession");
    // 没有 docId 分支时，两个空标签的身份会退化成同一个键，被去重成一份
    expect(body, "identityOf 必须有 docId 分支").toMatch(/#doc:\$\{st\.docId\}/);
    // 无路径、无副本 ⇒ 空文档：必须新开一个空白文档，而不是整条跳过
    expect(body, "无路径无副本的标签要 newTab 造空文档").toMatch(
      /await ipcNewTab\([\s\S]*?kind: "empty"/,
    );
  });

  it("恢复出来的空文档不是脏的（不亮 ●、关闭不弹框）", () => {
    const body = fnBody("async function restoreSession");
    // 置脏只属于副本分支：空文档内容本来就是空的，标脏会亮 ● 且关闭时要问「保存吗」
    const dirtyAssigns = body.match(/dirty = true/g) ?? [];
    expect(dirtyAssigns.length, "恢复流程里只有副本分支可以置脏").toBe(1);
    expect(body, "置脏必须在副本分支内").toMatch(
      /if \(hit\.kind === "backup"\)[\s\S]{0,300}dirty = true/,
    );
  });
});

describe("B71 面板操作补齐（移动标签 / 切焦点 / 右键分屏 / 最大化还原）", () => {
  // 用户：VS Code 面板支持拖拽，可能还有其他实用特性，参考下给出改进方案。
  // 落地四件事（用户勾选）：
  //   ① Move Editor into Next/Previous Group（Ctrl+Alt+←/→）
  //   ② 面板间切焦点（F6 / Shift+F6，Windows「下一窗格」的通行键位）
  //   ③ 标签右键的「左右分屏 / 上下分屏」（同时补上 splitview 首次构建时的接线）
  //   ④ 最大化 / 还原面板（Alt+Shift+↑、双击标签、面板上的还原按钮）
  const src = readFileSync("src/main.ts", "utf-8");
  const km = readFileSync("src/shell/keymap.ts", "utf-8");
  const ts = readFileSync("src/shell/tabstrip.ts", "utf-8");
  const sv = readFileSync("src/shell/splitview.ts", "utf-8");
  const css = readFileSync("src/styles/global.css", "utf-8");
  // 根因是**能力缺失**不是 bug，故这里守护的是「接线别断」——这几处一旦漏接，
  // 命令面板里看得见、按下去没反应，属于最难自查的回归。

  /** 截取某个顶层函数的源码体（见顶层 topLevelFnBody 的说明）。 */
  function fnBody(name: string): string {
    const body = topLevelFnBody(src, name);
    expect(body, `必须能定位 ${name}`).not.toBe("");
    return body;
  }

  it("五条命令必须登记进命令表（否则首选项里改不了键）", () => {
    for (const id of [
      "panel.moveTabNext",
      "panel.moveTabPrev",
      "panel.focusNext",
      "panel.focusPrev",
      "panel.toggleMaximize",
    ]) {
      expect(km, `命令表缺 ${id}`).toContain(`id: "${id}"`);
      expect(src, `runShortcut 未接线 ${id}`).toMatch(
        new RegExp(`case "${id.replace(".", "\\.")}":`),
      );
    }
    expect(km, "移动到下一面板 = Ctrl+Alt+→").toMatch(
      /id: "panel\.moveTabNext"[\s\S]{0,200}Ctrl\+Alt\+ArrowRight/,
    );
    expect(km, "切焦点 = F6 / Shift+F6").toMatch(
      /id: "panel\.focusNext"[\s\S]{0,200}keys: \["F6"\]/,
    );
    expect(km, "最大化/还原 = Alt+Shift+↑").toMatch(
      /id: "panel\.toggleMaximize"[\s\S]{0,200}Alt\+Shift\+ArrowUp/,
    );
  });

  it("只有一个面板时不得抢键（把事件还给编辑器）", () => {
    // ⚠️ 反向约束：这四条若不加 countLeaves 闸门，单面板时 F6 / Ctrl+Alt+← 会被
    // 静默吞掉。F6 在编辑器里是「跳到下一个错误/光标位置」的常见用途，吞了很难查。
    const body = fnBody("function shortcutApplies");
    expect(body, "四条命令共用一道 countLeaves > 1 闸门").toMatch(
      /case "panel\.moveTabNext":[\s\S]{0,200}countLeaves\(layout\) > 1/,
    );
  });

  it("移动 / 切焦点按叶子顺序环状取模（几何相邻在网格里没有唯一答案）", () => {
    const order = fnBody("function panelIdsInOrder");
    expect(order, "顺序必须来自分屏树的深度优先遍历").toMatch(/eachLeaf\(layout/);
    for (const fn of ["function moveActiveTabByDelta", "function focusPanelByDelta"]) {
      const body = fnBody(fn);
      // + delta + length 保证负向也回绕到末尾（两处的收尾括号不同，只取核心表达式）
      expect(body, `${fn} 必须环状取模`).toMatch(/\+ delta \+ ids\.length\) % ids\.length/);
      expect(body, `${fn} 必须少于两个面板时直接返回`).toMatch(/if \(ids\.length < 2\) return;/);
    }
  });

  it("切焦点必须走整套收尾（少一个就残留上一份文档）", () => {
    // onActivatePanel 的收尾有五项：标题 / 状态栏 / 大纲 / 查找栏目标 / 焦点。
    // 只 markActivePanel 会让标题栏、大纲、查找栏还指向上一个面板的文档。
    const body = fnBody("function focusPanelByDelta");
    for (const call of [
      "markActivePanel(next);",
      "refreshTitle();",
      "refreshStatus();",
      "updateTocDrawer();",
      "retargetFindBar();",
    ]) {
      expect(body, `focusPanelByDelta 缺 ${call}`).toContain(call);
    }
    expect(body, "焦点也要跟着过去").toMatch(/panels\.get\(next\)\?\.view\?\.focus\(\)/);
  });

  it("右键分屏是**复制**不是移动（VS Code 的 Split 是同一文档开两份）", () => {
    expect(ts, "tabstrip 回调要有 onSplitH/onSplitV").toMatch(
      /onSplitH\?: \(tabId: number\) => void;[\s\S]{0,120}onSplitV\?: \(tabId: number\) => void;/,
    );
    expect(ts, "右键菜单要挂出两个方向").toMatch(/label: "左右分屏"[\s\S]{0,200}label: "上下分屏"/);
    // 末位 copy=true：源面板只剩这一个标签时不会留下空面板
    expect(src, "左右分屏 = 水平 + copy").toMatch(
      /onSplitH: \(tabId\) => splitPanelWithTab\(p\.panelId, "h", tabId, false, true\)/,
    );
    expect(src, "上下分屏 = 垂直 + copy").toMatch(
      /onSplitV: \(tabId\) => splitPanelWithTab\(p\.panelId, "v", tabId, false, true\)/,
    );
    // splitview 首次构建标签栏时也要有这两个入口，否则「分屏后右键菜单少两项」
    expect(sv, "splitview 也要转发 onSplitTab").toMatch(
      /onSplitH: \(tabId\) => cb\.onSplitTab\?\.\(panelId, tabId, "h"\)/,
    );
  });

  it("改布局的操作必须先退出最大化（否则会留下 0 宽的怪布局）", () => {
    // 最大化时路径上全是 0/1。在这个状态下分屏/关面板/挪标签/拖分隔条，
    // 得到的都是「一半看不见」的布局，而且还原快照的路径也同时失效。
    for (const fn of [
      "function splitPanelWithTab",
      "function splitActivePanel",
      "function closePanelById",
      "function moveTabToPanel",
      "function moveTabToStrip",
    ]) {
      expect(fnBody(fn), `${fn} 缺 exitMaximize()`).toContain("exitMaximize();");
    }
    expect(src, "拖分隔条也要退出最大化").toMatch(/onRatioChange:[\s\S]{0,200}exitMaximize\(\);/);
  });

  it("最大化不进会话：0/1 的比例存下来会让下次启动只剩一块面板", () => {
    expect(src, "snapshotSession 要用未最大化的布局").toContain(
      "convertLayoutForSession(layoutForSession(), panelIndex)",
    );
    const body = fnBody("function layoutForSession");
    expect(body, "有快照时才还原副本，不能直接改当前布局").toMatch(
      /const c = cloneTree\(layout\);[\s\S]{0,80}restoreRatios\(c, maximizeSnapshot\);/,
    );
    expect(body, "没最大化时原样返回").toMatch(/return layout;/);
  });

  it("被挤掉的一侧必须真的收成 0（.layout-panel 有 min-width: 120px）", () => {
    const block = css.slice(css.indexOf(".layout-panel-collapsed"));
    const decls = cssDecls(block.slice(0, block.indexOf("}")));
    expect(decls, "min-width/min-height 必须归零").toMatch(/min-width:\s*0/);
    expect(decls, "min-height 也要归零").toMatch(/min-height:\s*0/);
    expect(decls, "不许再伸展").toMatch(/flex-grow:\s*0/);
    expect(src, "main 要标记 collapsed").toMatch(
      /collapsed: maximizedPanelId !== null && maximizedPanelId !== p\.panelId/,
    );
    expect(sv, "splitview 要挂上折叠类").toMatch(/data\.collapsed \? " layout-panel-collapsed"/);
  });

  it("最大化态必须有看得见的退路：还原按钮 + 双击标签", () => {
    // 另一侧被挤成 0，只给快捷键的话用户会以为面板丢了。
    expect(sv, "仅最大化时追加还原按钮（未最大化不占位）").toMatch(
      /if \(data\.maximized\)[\s\S]{0,300}CODICONS\.chromeRestore/,
    );
    expect(sv, "按钮文案要说明恢复比例").toContain("还原面板");
    // 双击标签：只有传了回调（多面板）才接管 —— 单面板时双击必须保持无行为
    expect(ts, "tabstrip 双击受回调门控").toMatch(
      /if \(cb\.onToggleMaximize\)[\s\S]{0,200}addEventListener\("dblclick"/,
    );
    expect(src, "仅多面板时才给双击回调").toMatch(
      /onToggleMaximize:\s*\n?\s*countLeaves\(layout\) > 1 \? \(\) => toggleMaximizePanel\(p\.panelId\) : undefined/,
    );
  });

  it("拖标签栏空白处 = 拖整组：起手判据与落点语义都锁在 splitview", () => {
    // VS Code `editorTabsControl.ts:455`：只有 `e.target === tabsContainer` 才算整组。
    // 写成「点在 strip 上就算」（用 closest 之类）会连点标签都变成整组拖拽。
    expect(sv, "起手必须是事件目标就是容器本身").toMatch(
      /strip\.addEventListener\("mousedown"[\s\S]{0,200}if \(e\.target !== strip\) return;/,
    );
    expect(sv, "整组落点优先于单标签分支").toMatch(
      /if \(drag\.groupPanelId !== null\)[\s\S]{0,900}onMergeGroup\?\.\(drag\.groupPanelId, panelId\)/,
    );
    expect(sv, "拖回自己 = 无操作").toMatch(/if \(drag\.groupPanelId === panelId\) return;/);
    expect(src, "并入 = 关掉这个分屏但指定并入目标").toMatch(
      /onMergeGroup: \(srcId, targetId\) => closePanelById\(srcId, targetId\)/,
    );
    expect(src, "搬到边缘 = moveGroupToPanel").toMatch(
      /onMoveGroupToPanel: \(srcId, targetId, dir, newFirst\) =>\s*\n\s*moveGroupToPanel\(srcId, targetId, dir, newFirst\)/,
    );
    // 整组搬走后源面板必须消失（否则留下一个空面板，等于分屏数莫名 +1）
    const body = fnBody("function moveGroupToPanel");
    expect(body, "源面板清空后要摘除").toMatch(
      /src\.tabs = \[\];[\s\S]{0,400}disposePanel\(srcId\)/,
    );
    expect(body, "标签要改挂到新面板").toMatch(/t\.panelId = newId/);
  });
});

describe("B71 ④ 拖出到新窗口 = 同一批文档的第二扇窗（不是复制一份）", () => {
  const src = readFileSync("src/main.ts", "utf-8");
  const sv = readFileSync("src/shell/splitview.ts", "utf-8");
  const rust = readFileSync("src-tauri/src/windows.rs", "utf-8");
  const api = readFileSync("src/ipc/api.ts", "utf-8");
  const caps = readJson("src-tauri/capabilities/default.json");

  /** 截取某个顶层函数的源码体（见顶层 topLevelFnBody 的说明）。 */
  function fnBody(name: string): string {
    const body = topLevelFnBody(src, name);
    expect(body, `必须能定位 ${name}`).not.toBe("");
    return body;
  }

  it("卫星窗口 label 前缀必须被 ACL 通配覆盖（漏了 = 界面能画但 emit/listen 全废）", () => {
    expect(caps.windows, "windows 必须用通配覆盖 sat-*").toContain("sat-*");
    expect(caps.windows, "主窗口也要留在授权名单里").toContain("main");
    expect(rust, "Rust 侧前缀常量必须与 capabilities 一致").toMatch(/SAT_PREFIX: &str = "sat-"/);
    // 跨窗口定位用的全是**只读**窗口命令，都落在 core:window:default 里、被 core:default 覆盖。
    // 这条断言不依赖任何生成物：源码一旦用上需要额外授权的写接口，就在**这里**红掉，
    // 而不是等到卫星窗口静默失灵（dropSpotOf 的 catch 会把 ACL 拒绝咽下去变成 null）。
    const dropSpot = fnBody("async function dropSpotOf");
    expect(dropSpot, "落点换算只用只读接口").toMatch(/outerPosition\(\)/);
    expect(dropSpot, "不得出现需要额外授权的窗口写接口").not.toMatch(
      /setPosition|setSize|setFullscreen|setAlwaysOnTop/,
    );
    expect(caps.permissions, "core:default 必须在授权里（它内含 core:window:default）").toContain(
      "core:default",
    );
    // ⚠️ 更深一层的核对要读 Tauri **生成**的 ACL 清单，而 `src-tauri/gen/` 不入库 ——
    // CI 的干净检出上根本没有这个文件（B71 ④ 首次推送就是在 CI 上炸在这里）。
    // 所以这一层只在有清单的本机跑：**跳过 ≠ 通过**，只是没有更深的信息可核。
    const manifestPath = "src-tauri/gen/schemas/acl-manifests.json";
    if (existsSync(manifestPath)) {
      const winDefault: string[] =
        readJson(manifestPath)["core:window"].default_permission.permissions;
      for (const p of [
        "allow-outer-position",
        "allow-outer-size",
        "allow-inner-size",
        "allow-scale-factor",
      ]) {
        expect(winDefault, `core:window:default 少了 ${p}，新窗口落点会失效`).toContain(p);
      }
    }
  });

  it("跨窗口同步只传变更集，且必须带基准长度（基准是防分叉的唯一凭据）", () => {
    // 基准长度是「两边说的是同一份文本」的证据：位置增量套在错的基准上会在错的地方
    // 插入文本，属于静默改坏用户内容，比不同步严重得多。
    const body = fnBody("function broadcastDocChange");
    expect(body, "基准长度必须真的写进广播载荷（只出现在参数表里等于没传）").toMatch(
      /baseLen,\s*\n\s*changes: changes\.toJSON\(\),/,
    );
    expect(body, "发的是变更集而不是全文").toMatch(/changes: changes\.toJSON\(\)/);
    expect(body, "正在套用远端变更时不得再广播（否则无限弹）").toMatch(/applyingRemote/);
    const upd = fnBody("function handleUpdate");
    expect(upd, "编辑后要广播，且只有文本真变才广播").toMatch(
      /if \(textChanged\) broadcastDocChange\(tab\.docId, update\.changes, update\.startState\.doc\.length\)/,
    );
    expect(src, "两种窗口都要装同步监听").toMatch(/listenDocSync\(\);/);
  });

  it("基准不符 = 分叉：不许硬套增量，必须转为要一份全文", () => {
    const body = fnBody("function applyRemoteDocChange");
    expect(body, "基准校验失败 → 走重同步").toMatch(
      /t\.state\.doc\.length !== baseLen[\s\S]{0,200}requestDocResync\(docId\)/,
    );
    expect(body, "变更集解析失败也要走重同步（不能吞掉）").toMatch(
      /catch \{[\s\S]{0,120}requestDocResync\(docId\)/,
    );
    expect(body, "远端变更要按同源多实例落到每个实例").toMatch(/instances/);
    expect(body, "远端改了内容 → 本窗口这份也要变脏").toMatch(/doc\.dirty = true/);
    // 接收侧不得自己排自动保存/副本：同一个文件两边写会互相触发 file-changed
    expect(body, "接收侧不许排自动保存").not.toContain("scheduleAutosave()");
    expect(body, "接收侧不许排热退出副本").not.toContain("scheduleBackup()");
    const req = fnBody("function requestDocResync");
    expect(req, "重同步请求要防抖（同一个文档不连发）").toMatch(/resyncPending/);
    expect(req, "广播要带窗口身份，供对端定向应答").toMatch(/from: windowLabel/);
    // 三个事件名必须一致（对不上就是「发出去了没人接」）
    for (const evt of ["doc-change", "doc-resync-request", "doc-resync-full"]) {
      expect(src, `事件名 ${evt} 必须同时出现在常量与监听里`).toContain(`"${evt}"`);
    }
  });

  it("全文纠错不得覆盖本窗口未保存的修改（分叉时谁更新无从判断）", () => {
    const body = fnBody("function applyDocResyncFull");
    expect(body, "本地是脏的就不动手，只提示").toMatch(/if \(doc\?\.dirty\)[\s\S]{0,200}return;/);
    // 全文替换必须整态重建，否则视图与 tab.state 会不同步（后续切标签立刻串档）
    expect(body, "整段替换要经过 setState").toMatch(/setState\(whole\)/);
  });

  it("拖出窗口：拖拽途中只通知，松手才提交（B89）", () => {
    // 判据必须带余量：最大化窗口贴边拖动会擦出去，无余量就会莫名弹新窗口
    expect(sv, "出界判据要留余量").toMatch(/DRAG_OUT_MARGIN/);
    // ⚠️ 拖拽层的函数本体在 splitview.ts，main.ts 的宿主函数才走 fnBody
    const mv = topLevelFnBody(sv, "function onTabDragMove");
    // ⚠️ 这两条是 B89 的核心：旧实现在这里 finishTabDrag + 上报，副作用发生在拖拽途中，
    // 表现为「指针擦过另一个窗口的一块面板就被合入」（用户报的毛病）。
    expect(mv, "出界不得收尾：影像要继续跟着光标走").not.toContain("finishTabDrag()");
    expect(mv, "出界只通知宿主（让它广播指针位置）").toMatch(
      /outsideWindow\(e\.clientX, e\.clientY\)[\s\S]{0,500}onDragOutside\?\.\(/,
    );
    expect(mv, "出界后影像要贴边（否则用户看不见自己拖着什么）").toMatch(
      /moveDragGhost\(e\.clientX, e\.clientY, outside\)/,
    );
    expect(mv, "出界要记状态，供松手时判定走哪条路").toMatch(/tabDrag\.outOfWindow = true/);
    expect(mv, "拖回窗口内要清掉出界状态").toMatch(/tabDrag\.outOfWindow = false/);
    expect(mv, "刚出界时要收掉本窗口的落点痕迹").toMatch(
      /if \(!tabDrag\.outOfWindow\) \{[\s\S]{0,200}clearAllPreviews\(\)/,
    );
    const end = topLevelFnBody(sv, "function onTabDragEnd");
    expect(end, "松手时才上报一次，且带松手坐标").toMatch(
      /if \(drag\.outOfWindow\)[\s\S]{0,220}onDropOutOfWindow\?\.\([\s\S]{0,160}clientX: e\.clientX/,
    );
    const body = fnBody("async function dropTabsOutOfWindow");
    expect(body, "整组拖出取该面板全部标签").toMatch(
      /drag\.groupPanelId !== null[\s\S]{0,160}panels\.get\(drag\.groupPanelId\)\?\.tabs/,
    );
    expect(body, "先问有没有别的窗口愿意接手").toMatch(/await session\.release\(\)/);
    expect(body, "有人接手时正文只发给它").toMatch(/session\.deliver\(target, snapshots\)/);
    expect(body, "没人接手才回落：卫星窗口交回主窗口").toMatch(
      /windowKind === "satellite"[\s\S]{0,200}returnTabsToMain\(ids\)/,
    );
    expect(body, "没人接手才回落：主窗口开新窗").toMatch(/openTabsInNewWindow\(ids, spot\)/);
  });

  it("跨窗口拖拽协议：正文绝不广播（B89）", () => {
    const wd = readFileSync("src/shell/windowdrag.ts", "utf-8");
    // hover/release 只带坐标：广播一次 = 每个窗口都收到一份，正文跟着广播就是
    // 「几十 MB × 窗口数」。
    expect(wd, "hover 只带坐标，不得夹带正文").toMatch(
      /EVT_HOVER, \{\s*\n\s*from: selfLabel,\s*\n\s*screen: clientToScreen\(g, lastClient\.x, lastClient\.y\),\s*\n\s*\}\)/,
    );
    expect(wd, "release 也只广播坐标").toMatch(/EVT_RELEASE, \{ from: selfLabel, screen \}/);
    expect(wd, "正文走定向投递").toMatch(/emitTo\(target, EVT_PAYLOAD/);
    // 顺序是刻意的：先挂 claim 监听再广播 release，反过来的话接手方的回答可能早于
    // 监听就位，这一次拖拽就只能等到超时再回落成「开新窗口」。
    expect(wd, "必须先挂 claim 监听再广播 release").toMatch(
      /listen<ClaimPayload>\(EVT_CLAIM[\s\S]{0,600}emit\(EVT_RELEASE/,
    );
    expect(wd, "坐标口径要除以缩放（高 DPI 屏否则整体偏一倍）").toMatch(/scaleFactor\(\)/);
    expect(src, "两个窗口都要装接收侧（谁都可能成为落点）").toMatch(
      /^ {2}void installWindowDropTarget\(windowLabel, \{/m,
    );
    expect(src, "落点用**本窗口**算出来的那块（预览在哪就落哪）").toMatch(
      /preview: \(x, y\) => previewDropAt\(x, y\)/,
    );
  });

  it("新窗口落点：拿得到就落在松手处，拿不到退回系统摆放", () => {
    const body = fnBody("async function dropSpotOf");
    expect(body, "要靠窗口外框位置换算（screenX 在多显示器下口径不对）").toMatch(
      /outerPosition\(\)/,
    );
    expect(body, "外框→客户区要扣掉边框").toMatch(/borderX/);
    expect(body, "拿不到坐标返回 null").toMatch(/catch \{\s*\n\s*return null;/);
    expect(api, "落点随建窗命令一起交给 Rust").toMatch(/x: spot\?\.x \?\? null/);
    expect(rust, "Rust 侧只接受「两个都合法」的落点").toMatch(/fn spot_of/);
    expect(rust, "建窗时应用落点").toMatch(/builder = builder\.position\(x, y\)/);
  });

  it("被搬到别的窗口的文档再被打开：必须取回，不能变成两份互不同步的实例", () => {
    // 同源多实例的前提是同一窗口内共用一条 docs 记录。隐藏实例的正文停在载荷时的
    // 样子，而重新打开拿到的是磁盘内容 —— 两份各说各话，正是最怕的状态。
    const body = fnBody("async function doOpen");
    expect(body, "隐藏实例（在别的窗口）要先取回").toMatch(
      /const remoted = remotedTabs\.get\(existingDoc\.tabId\);\s*\n\s*if \(inst && remoted !== undefined\) \{[\s\S]{0,240}reclaimRemoted\(inst\.tabId, host\)/,
    );
    expect(body, "取回要走既有的激活收尾（重建/刷新/存会话）").toMatch(
      /reclaimRemoted\(inst\.tabId, host\);[\s\S]{0,240}scheduleSessionSave\(\);/,
    );
  });

  it("交出去之后本地只摘视图，绝不删 Rust 侧的文档", () => {
    // 走 closeTabById 会连文档一起删掉，接手方拿到空壳（首次保存报「文档不存在」）。
    const body = fnBody("function detachLocally");
    expect(body, "只动内存视图").toMatch(/tabs\.delete\(tabId\)/);
    expect(body).not.toContain("ipcCloseTab");
    expect(body).not.toContain("closeTabById");
    // 卫星窗口被交空 → 自己关掉，别留一个空窗口
    expect(body, "交空后自动关窗").toMatch(
      /tabs\.size === 0[\s\S]{0,120}getCurrentWindow\(\)\.close\(\)/,
    );
    // 摘标签会改变面板构成 → 最大化态必须先还原（与分屏/关面板同一不变量）
    const open = fnBody("async function openTabsInNewWindow");
    expect(open, "摘标签前先退出最大化").toMatch(
      /exitMaximize\(\);[\s\S]{0,200}remoteTabLocally\(id, label\)/,
    );
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
      ["深色", themeBlock(css, "dark")],
      ["浅色", themeBlock(css, "light")],
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

// ---------------------------------------------------------------------------
// B70：提示层三档调整（用户逐条提的观感问题）
//   A 档 菜单开着时不弹提示（提示层 z-index 2000 > 菜单 1000，会盖在展开的菜单上）
//   B 档 删掉 3 处菜单项提示，并把「拖放选择菜单」的触发判据从
//        「拖进来的是 .md」改成「落点面板的活动文档是 .md」
//   C 档 修命令面板两处：悬停不重建列表（列表弹回顶端）、呼出面板顶掉菜单
// ---------------------------------------------------------------------------
describe("B70 提示与菜单：菜单开着不弹提示 + 删菜单项提示 + 命令面板两处修复", () => {
  const tooltipSrc = readFileSync("src/shell/tooltip.ts", "utf-8");
  const menuSrc = readFileSync("src/shell/menu.ts", "utf-8");
  const filedropSrc = readFileSync("src/shell/filedrop.ts", "utf-8");
  const tabstripSrc = readFileSync("src/shell/tabstrip.ts", "utf-8");
  const paletteSrc = readFileSync("src/shell/commandpalette.ts", "utf-8");
  const mainSrc = readFileSync("src/main.ts", "utf-8");

  describe("A 档：菜单开着就绝不弹提示", () => {
    it("tooltip 侧靠 DOM 里的 .popup-menu 判断菜单是否开着", () => {
      expect(tooltipSrc, "必须有 menuOpen 判据").toMatch(/function menuOpen\(doc: Document\)/);
      expect(tooltipSrc, "判据就是 DOM 里有没有菜单元素").toMatch(
        /doc\.querySelector\("\.popup-menu"\)/,
      );
      // menu → tooltip 是单向依赖；反过来 import menu 会成环，所以只查 DOM
      const showFor = topLevelFnBody(tooltipSrc, "function showFor");
      expect(showFor, "取不到 showFor").toBeTruthy();
      expect(showFor, "showFor 开头必须早退：菜单开着就不显示（这是 A 档的核心）").toMatch(
        /if \(menuOpen\(el\.ownerDocument\)\) return;/,
      );
    });

    it("reading 目标文本前就要拦下（否则等于没拦）", () => {
      const showFor = topLevelFnBody(tooltipSrc, "function showFor");
      const guard = showFor.indexOf("menuOpen(el.ownerDocument)");
      const readText = showFor.indexOf("el.dataset.tip");
      expect(guard, "守卫必须存在").toBeGreaterThan(-1);
      expect(readText, "守卫必须在读取 dataset.tip 之前").toBeGreaterThan(guard);
    });

    it("菜单侧：showPopupMenu 一开就先 hideTip（已显示的提示不能盖在菜单上）", () => {
      expect(menuSrc, "必须从 tooltip 只引入 hideTip（不要 setTip —— 菜单项已无提示）").toMatch(
        /import \{ hideTip \} from "\.\/tooltip";/,
      );
      const open = topLevelFnBody(menuSrc, "function showPopupMenu");
      expect(open, "取不到 showPopupMenu").toBeTruthy();
      expect(open, "开场第一件事就把已显示的提示收掉").toMatch(/hideTip\(\);/);
    });
  });

  describe("B 档：删掉菜单项提示（写了也永远不显示 = 死代码）", () => {
    it("MenuItem 不再有 title 字段，fillMenu 也不再挂提示", () => {
      expect(menuSrc, "MenuItem 不该再留 title 字段").not.toMatch(/^\s*title\?: string;/m);
      const fill = topLevelFnBody(menuSrc, "function fillMenu");
      expect(fill, "取不到 fillMenu").toBeTruthy();
      expect(fill, "菜单项不得再调 setTip").not.toMatch(/setTip\(/);
    });

    it("标签右键菜单的高频项不带 title（复制标签 / 在新窗口打开）", () => {
      for (const label of ["复制标签", "在新窗口打开"]) {
        const i = tabstripSrc.indexOf(`label: "${label}"`);
        expect(i, `找不到菜单项 ${label}`).toBeGreaterThan(-1);
        // 该项到下一个 } 之间不得出现 title
        const chunk = tabstripSrc.slice(i, tabstripSrc.indexOf("}", i));
        expect(chunk, `${label} 不该再挂提示`).not.toMatch(/title/);
      }
    });

    it("拖放选择菜单两项也不再挂 title", () => {
      const choice = topLevelFnBody(filedropSrc, "function showFileDropChoice");
      expect(choice, "取不到 showFileDropChoice").toBeTruthy();
      expect(choice, "两项都不该有 title").not.toMatch(/title/);
    });

    it("触发判据改成「落点面板的活动文档是 Markdown」，而不是「拖进来的是 .md」", () => {
      expect(filedropSrc, "needsChoice 必须接收落点文档是否为 Markdown").toMatch(
        /export function needsChoice\(paths: string\[\], targetIsMarkdown: boolean\): boolean/,
      );
      expect(filedropSrc, "单个文件 + 落点是 Markdown 才问").toMatch(
        /return paths\.length === 1 && targetIsMarkdown;/,
      );
      expect(filedropSrc, "isMarkdownPath 这条旧判据应已删除").not.toMatch(/isMarkdownPath/);

      // main.ts 接线：落点面板的活动文档是不是 md 由 panelDocIsMarkdown 回答
      expect(mainSrc, "落点判定必须问「落点面板的活动文档」").toMatch(
        /needsChoice\(p\.paths, target !== null && panelDocIsMarkdown\(target\.panelId\)\)/,
      );
      const helper = topLevelFnBody(mainSrc, "function panelDocIsMarkdown");
      expect(helper, "取不到 panelDocIsMarkdown").toBeTruthy();
      expect(helper, "必须取该面板的活动标签再判 isMdTab").toMatch(/isMdTab\(t\)/);
    });
  });

  describe("C 档：命令面板两处修复", () => {
    it("悬停只切选中态，绝不重建列表（重建会把滚动位置归零 → 弹回顶端）", () => {
      const show = topLevelFnBody(paletteSrc, "function showCommandPalette");
      expect(show, "取不到 showCommandPalette").toBeTruthy();

      expect(paletteSrc, "必须有独立的 paint（只切 is-active，不碰 DOM 结构）").toMatch(
        /const paint = \(\): void => \{/,
      );
      expect(paletteSrc, "必须有 revealActive（滚动只在键盘导航时发生）").toMatch(
        /const revealActive = \(\): void => \{/,
      );
      expect(paletteSrc, "select 的第二个参数决定是否滚动").toMatch(
        /const select = \(i: number, reveal: boolean\): void => \{/,
      );

      // 鼠标路径：只 select(i, false) —— 不重建、不滚动
      const box = show.slice(show.indexOf('"mousemove"'));
      const handler = box.slice(0, box.indexOf("});"));
      expect(handler, "悬停必须走静默路径 select(i, false)").toMatch(/select\(i, false\);/);
      expect(handler, "悬停不得调 render()（那是重建列表）").not.toMatch(/render\(\)/);

      // 键盘路径：select(..., true) 才滚动
      expect(show, "↓ 必须滚动选中行").toMatch(/select\(\(active \+ 1\) % rows\.length, true\)/);
      expect(show, "↑ 必须滚动选中行").toMatch(
        /select\(\(active - 1 \+ rows\.length\) % rows\.length, true\)/,
      );

      // 渲染路径里不得再出现 scrollIntoView 调用：它曾经就在这里「重建完再补一次滚动」，
      // 而重建本身已经把滚动位置清零 —— 补不回来的那一次就是用户看到的「弹回顶端」。
      const renderBody = paletteSrc.slice(
        paletteSrc.indexOf("const render = ()"),
        paletteSrc.indexOf("const run = (id"),
      );
      expect(renderBody.length, "必须能截出渲染函数体").toBeGreaterThan(0);
      expect(renderBody, "渲染里不得再调 scrollIntoView").not.toMatch(/scrollIntoView\(/);
    });

    it("呼出面板先把打开着的菜单收掉（菜单只认 Esc / 外部 pointerdown，不认键盘呼出）", () => {
      expect(paletteSrc, "必须引入 closePopupMenu").toMatch(
        /import \{ closePopupMenu \} from "\.\/menu";/,
      );
      const show = topLevelFnBody(paletteSrc, "function showCommandPalette");
      const guard = show.indexOf("if (paletteOpen()) return;");
      const close = show.indexOf("closePopupMenu();");
      expect(guard, "取不到「已有面板就不叠第二层」的守卫").toBeGreaterThan(-1);
      expect(close, "必须调用 closePopupMenu").toBeGreaterThan(-1);
      expect(close, "收菜单必须在守卫之后（面板没开才需要收）").toBeGreaterThan(guard);
    });
  });
});

describe("B87 文件监听：外部修改要真的刷新内容（VS Code 三态 + 回声抑制）", () => {
  // 事故：M2 起就有 watcher，但前端收到 `file-changed` 只置了个 `doc.external = true`
  // 加一句状态栏提示 —— **内容一个字节都不刷新**。用户要求「打开的文档在别处被修改后，
  // 编辑器里的内容也进行刷新，两处都改也要处理好」。
  //
  // 按 VS Code 的语义复刻三态判定：
  //   ① 磁盘内容 == 内存内容  → 静默（外部只是重写了同样的字节，不该惊动用户）
  //   ② 编辑器没改过（clean） → 自动以磁盘为准重新载入（保留光标）
  //   ③ 两边都改过            → 弹三选一：保留我的修改 / 载入磁盘版本 / 打开磁盘版本对照
  //
  // 另有两个必须一并解决的坑，各占一条用例：
  //   · 回声：保存也会激起 file-changed（监听的是同一个文件），不抑制就「保存完立刻弹冲突」；
  //   · 匹配：监听登记的是 `fs::canonicalize` 之后的路径，`OpenedFile.path` 却是用户给的
  //     原始写法，两端比不出来 —— 这就是以前「提示时有时无」的根因，改成认 tabId。
  //
  // ⚠️ 下面所有断言都跑在 `stripLineComments` 之后：本段说明里就写着 `markDiskVersion`
  // 这类标识符，整份文件比对会让「挖掉真代码」也照样通过（假绿，B79 已踩过一次）。
  const main = stripLineComments(readFileSync("src/main.ts", "utf-8"));
  const api = stripLineComments(readFileSync("src/ipc/api.ts", "utf-8"));
  const rustCmds = stripLineComments(readFileSync("src-tauri/src/commands/mod.rs", "utf-8"));
  const rustMain = stripLineComments(readFileSync("src-tauri/src/main.rs", "utf-8"));
  const dialog = stripLineComments(readFileSync("src/shell/conflictdialog.ts", "utf-8"));

  const core = topLevelFnBody(
    main,
    "async function resolveExternalChangeCore(doc: Doc, payload: FileChangedPayload)",
  );
  const applyDisk = topLevelFnBody(
    main,
    "function applyDiskContent(doc: Doc, file: OpenedFile, mtimeMs: number, size: number)",
  );
  const handleFn = topLevelFnBody(main, "function handleFileChanged(payload: FileChangedPayload)");

  describe("A 档：磁盘版本号（回声抑制的唯一依据）", () => {
    it("OpenedFile / SavedFile 都要带 mtime_ms（保存后必须拿得到新版本）", () => {
      // ⚠️ 只断言「文件里出现过 mtime_ms」会假绿：open_file 给了、save_file 没给也照样命中。
      // 所以既按出现次数卡，也分别断言落进了对应的结构体里。
      expect((rustCmds.match(/pub mtime_ms: i64,/g) ?? []).length, "两个结构体各一个").toBe(2);

      const opened = rustCmds.slice(
        rustCmds.indexOf("pub struct OpenedFile"),
        rustCmds.indexOf("pub struct LossyChar"),
      );
      const saved = rustCmds.slice(
        rustCmds.indexOf("pub struct SavedFile"),
        rustCmds.indexOf("fn tab_info"),
      );
      expect(opened, "OpenedFile 必须带 mtime_ms").toContain("pub mtime_ms: i64,");
      expect(saved, "SavedFile 必须带 mtime_ms（否则保存后前端拿不到新版本）").toContain(
        "pub mtime_ms: i64,",
      );

      // 前端类型同步：少一个字段，`saved.mtimeMs` 就是 undefined，已知版本会被写成 undefined
      const openedTs = api.slice(
        api.indexOf("export interface OpenedFile"),
        api.indexOf("export interface FileChangedPayload"),
      );
      expect(openedTs, "前端 OpenedFile 必须有 mtimeMs").toContain("mtimeMs: number;");
      const savedTs = api.slice(
        api.indexOf("export interface SavedFile"),
        api.indexOf("export interface Settings"),
      );
      expect(savedTs, "前端 SavedFile 必须有 mtimeMs").toContain("mtimeMs: number;");
    });

    it("读盘 / 写盘之后都要真的取一次版本号", () => {
      expect(
        (rustCmds.match(/let \(mtime_ms, _\) = disk_version\(&target\);/g) ?? []).length,
        "open_file 与 save_file 各取一次",
      ).toBe(2);
      // 取不到 / 文件被删时回落 (0,0)：下次事件必然与 0 不同，于是不会被当成回声吞掉
      const ver = topLevelFnBody(rustCmds, "pub fn disk_version(path: &Path) -> (i64, u64)");
      expect(ver, "取不到 disk_version").toBeTruthy();
      expect(ver, "元数据读失败必须回落 (0, 0)").toMatch(/Err\(_\) => \(0, 0\)/);
    });

    it("每次落盘 / 读盘后前端都要更新已知版本（漏一次就是「保存完立刻弹冲突」）", () => {
      const save = topLevelFnBody(
        main,
        "async function saveDocCore(doc: Doc, inst: Tab, forceDialog: boolean)",
      );
      expect(save, "saveDocCore 必须更新已知版本").toContain(
        "markDiskVersion(doc, saved.mtimeMs, saved.size)",
      );

      // 自动保存走的是另一条路径（不起 saveDocCore），必须自己更新
      const auto = topLevelFnBody(main, "function scheduleAutosave(): void");
      expect(auto, "自动保存也必须更新已知版本").toContain(
        "markDiskVersion(doc, saved.mtimeMs, saved.size)",
      );
      // ⚠️ B88 起 save_file 的回包是「saved / conflict」联合体，所以这里接住的是
      //    `outcome` 而不是 `saved` —— 契约没变：自动保存必须接住返回值去刷新已知版本。
      expect(auto, "自动保存要接住 saveFile 的返回值").toContain("const outcome = await saveFile(");

      const open = topLevelFnBody(main, "async function doOpen(");
      expect(open, "打开文件后必须记下已知版本").toContain(
        "markDiskVersion(doc, file.mtimeMs, file.size)",
      );
    });

    it("回声抑制：事件版本 == 已知版本 时直接早退，且不排防抖", () => {
      expect(handleFn, "取不到 handleFileChanged").toBeTruthy();
      expect(handleFn, "必须比对已知磁盘版本（mtime + size 两个都要）").toMatch(
        /if \(payload\.mtimeMs === doc\.diskMtimeMs && payload\.size === doc\.diskSize\) return;/,
      );
      const guard = handleFn.indexOf("payload.size === doc.diskSize");
      const pending = handleFn.indexOf("externalPending.set(");
      expect(pending, "比通过了才排防抖").toBeGreaterThan(-1);
      expect(guard, "版本比对必须在排防抖之前（否则回声照样读盘 / 弹框）").toBeLessThan(pending);
    });
  });

  describe("B 档：事件认文档不认路径", () => {
    it("Rust 侧按规范化路径匹配到 doc，事件里带 tabId + 版本号", () => {
      const watcher = rustMain.slice(rustMain.indexOf("notify::recommended_watcher"));
      expect(watcher, "取不到 watcher 段").toBeTruthy();
      expect(watcher, "事件路径必须规范化后再比对").toContain(
        "std::fs::canonicalize(&path).unwrap_or(path.clone())",
      );
      expect(watcher, "匹配必须在 Rust 侧做完（它持有全部 doc）").toContain("d.path == norm");
      expect(watcher, "事件必须带 tabId").toMatch(/"tabId": tab_id/);
      expect(watcher, "事件必须带 mtimeMs").toMatch(/"mtimeMs": mtime_ms/);
      expect(watcher, "事件必须带 size").toMatch(/"size": size/);
      // ⚠️ 反向验证：以前只发 path，前端拿 `doc.path` 与之字符串比对 —— 一边是
      // canonicalize 过的、一边是用户给的原始写法，永远比不上（表现为「提示时有时无」）。
      expect(watcher, "不得再只发 path（前端比不出来）").not.toMatch(/"path": path/);
    });

    it("前端 handleFileChanged 不再按路径比对", () => {
      expect(handleFn, "必须按 tabId 取文档").toContain("docs.get(payload.tabId)");
      expect(handleFn, "不得再按路径字符串比对文档").not.toContain("toLowerCase()");
      // 文档被搬到卫星窗口后，本窗口只剩隐藏实例：两边都会收到事件，必须让对面处理
      expect(handleFn, "正主在别的窗口时必须让位（否则两个窗口各弹一个冲突框）").toContain(
        "remotedTabs.has(payload.tabId)",
      );
    });
  });

  describe("C 档：三态判定与冲突处理", () => {
    it("① 内容一致 → 静默；② clean → 自动载入；③ 都改 → 弹三选一", () => {
      expect(core, "取不到 resolveExternalChangeCore").toBeTruthy();

      const equal = core.indexOf("file.text === mine");
      const clean = core.indexOf("if (!doc.dirty)");
      const conflict = core.indexOf("showExternalConflictDialog(");
      expect(equal, "缺① 内容一致的静默分支").toBeGreaterThan(-1);
      expect(clean, "缺② clean 自动载入分支").toBeGreaterThan(-1);
      expect(conflict, "缺③ 冲突弹框分支").toBeGreaterThan(-1);
      expect(equal, "① 必须在最前：内容一样就什么都不该发生").toBeLessThan(clean);
      expect(clean, "② 必须在 ③ 之前：没改过就不该问用户").toBeLessThan(conflict);

      // ① 静默 = 不弹、不提示，只更新已知版本
      const equalBranch = core.slice(equal, clean);
      expect(equalBranch, "① 更新已知版本").toContain("markDiskVersion(");
      expect(equalBranch, "① 清掉 external 标记").toContain("doc.external = false;");
      expect(equalBranch, "① 不得弹框").not.toContain("showExternalConflictDialog");

      // ② 自动载入 = 换内容 + 提示（清脏在 applyDiskContent 里）
      const cleanBranch = core.slice(clean, conflict);
      expect(cleanBranch, "② 必须真的替换内容").toContain(
        "applyDiskContent(doc, file, mtimeMs, size)",
      );
      expect(cleanBranch, "② 必须给出提示，否则用户不知道内容被换了").toContain("showMessage(");
      expect(cleanBranch, "② 不得弹框").not.toContain("showExternalConflictDialog");
    });

    it("冲突框给出三选一，且默认分支绝不丢用户的修改", () => {
      expect(dialog, "keep-mine：保留我的修改").toContain('textContent = "保留我的修改"');
      expect(dialog, "take-disk：载入磁盘版本").toContain('textContent = "载入磁盘版本"');
      expect(dialog, "compare：打开磁盘版本对照").toContain('textContent = "打开磁盘版本对照"');
      expect(dialog, "Esc 兜底必须是 keep-mine（唯一不丢数据的一支）").toMatch(
        /e\.key === "Escape"[\s\S]{0,200}close\("keep-mine"\)/,
      );

      // keep-mine 绝不能碰内容：只有 take-disk 分支才调 applyDiskContent
      const tail = core.slice(core.indexOf('if (choice === "take-disk")'));
      expect(tail, "keep-mine 必须把「磁盘上有更新版本」记下来").toContain("doc.external = true;");
      expect(tail, "keep-mine 之后不得再替换内容").not.toMatch(
        /doc\.external = true;[\s\S]{0,400}applyDiskContent\(/,
      );
    });

    it("载入磁盘版本 = 内容以磁盘为准：清脏 + 作废热退出副本", () => {
      expect(applyDisk, "取不到 applyDiskContent").toBeTruthy();
      expect(applyDisk, "必须清脏").toContain("doc.dirty = false;");
      expect(applyDisk, "必须清 external").toContain("doc.external = false;");
      // ⚠️ 不清副本的话，下次启动会拿这份「已被放弃的未保存内容」顶掉刚载入的磁盘版本
      expect(applyDisk, "必须丢弃热退出副本").toContain("discardBackupFor(doc);");
      expect(applyDisk, "必须真的替换实例内容并保留光标").toContain(
        "rebuildDocInstances(doc, file.text, true)",
      );
    });

    it("防抖 + 不重入：一次保存会连着给好几个 Modify 事件", () => {
      expect(main, "必须有防抖窗口").toMatch(/const EXTERNAL_DEBOUNCE_MS = \d+;/);
      const resolve = topLevelFnBody(main, "async function resolveExternalChange(tabId: number)");
      expect(resolve, "取不到 resolveExternalChange").toBeTruthy();
      expect(
        resolve.indexOf("externalBusy.has(tabId)"),
        "必须有不重入守卫（否则读盘 / 等选择期间会叠出好几个弹框）",
      ).toBeGreaterThan(-1);
      expect(resolve, "处理中要把文档标记上").toContain("externalBusy.add(tabId);");
      expect(resolve, "结束必须解锁").toContain("externalBusy.delete(tabId);");
      // 弹框期间又来了事件 → 处理完接着处理，不能把最后一次丢了
      expect(resolve, "期间到达的新事件必须补处理").toMatch(
        /if \(externalPending\.has\(tabId\)\) void resolveExternalChange\(tabId\);/,
      );
    });
  });

  describe("D 档：外部刷新不该顺手改掉用户的编码 / 行尾", () => {
    it("重新载入必须带上当前编码（不指定时 open_file 会重新探测，把用户选的冲掉）", () => {
      expect(core, "reloadFile 必须传 doc.encoding").toMatch(
        /reloadFile\(doc\.tabId, doc\.encoding\)/,
      );
    });

    it("applyDiskContent 保留用户选的行尾", () => {
      expect(applyDisk, "先把行尾存下来").toContain("const eol = doc.eol;");
      expect(applyDisk, "再把行尾还原回去（外部刷新不是改行尾的场合）").toContain("doc.eol = eol;");
    });
  });
});

describe("B88 保存时的脏写检查：磁盘版本更新要把选择权交回用户（VS Code FILE_MODIFIED_SINCE）", () => {
  // 需求：用户**主动保存**的瞬间，磁盘上的版本可能已经变了（事件还在防抖窗口里 /
  // 保存与别人的写入撞在一起 / 那一刻根本没在监听）。此时若照旧写盘，就是把别人
  // 刚写进去的内容无声盖掉 —— 而 B87 那条监听器路径覆盖不到这个时刻。
  //
  // VS Code 的做法：写操作自带「期望的版本号」（mtime+size），落盘前比对，不一致就
  // 抛 FILE_MODIFIED_SINCE —— **一个字节都不写**，弹框让用户选「对照 / 覆盖 / 载入」。
  // 本项目照此实现，并把检查放在 Rust 的 save_file **内、atomic_write 之前**：
  //   · 不能前端先查版本再调保存 —— 那会有「查完被改、写完盖掉」的窗口；
  //   · 冲突是**预期分支**（要弹框）而非异常，所以用 tagged enum 回传，不走 Err(String)。
  //
  // ⚠️ 所有断言都跑在 stripLineComments 之后：本段说明里就写着 expectMtimeMs 这类
  //    标识符，整份文件比对会让「挖掉真代码」也照样通过（假绿，B79 已踩过一次）。
  const main = stripLineComments(readFileSync("src/main.ts", "utf-8"));
  const api = stripLineComments(readFileSync("src/ipc/api.ts", "utf-8"));
  const rustCmds = stripLineComments(readFileSync("src-tauri/src/commands/mod.rs", "utf-8"));
  const dialog = stripLineComments(readFileSync("src/shell/conflictdialog.ts", "utf-8"));

  const saveFileRs = topLevelFnBody(rustCmds, "pub async fn save_file(");
  const saveCore = topLevelFnBody(
    main,
    "async function saveDocCore(doc: Doc, inst: Tab, forceDialog: boolean)",
  );
  const resolveSave = topLevelFnBody(main, "async function resolveSaveConflict(");
  const autosave = topLevelFnBody(main, "function scheduleAutosave()");
  const saveDialogFn = topLevelFnBody(dialog, "export function showSaveConflictDialog(");

  describe("A 档：Rust 写盘前的版本比对（不许先写后说）", () => {
    it("save_file 收「期望版本」并在写盘前比对，不一致就返回冲突", () => {
      expect(saveFileRs, "取不到 save_file").toBeTruthy();
      expect(saveFileRs, "必须收 expect_mtime_ms").toContain("expect_mtime_ms: Option<i64>,");
      expect(saveFileRs, "必须收 expect_size").toContain("expect_size: Option<u64>,");

      // ⚠️ 顺序是这条需求的命门：检查必须早于 atomic_write。
      // 写在后面就成了「先盖掉别人的内容，再报告冲突」—— 等于没有保护。
      const checkAt = saveFileRs.indexOf("is_stale(expect, current)");
      const writeAt = saveFileRs.indexOf("atomic_write::atomic_write");
      expect(checkAt, "找不到版本比对").toBeGreaterThan(-1);
      expect(writeAt, "找不到写盘调用").toBeGreaterThan(-1);
      expect(checkAt, "版本比对必须早于写盘").toBeLessThan(writeAt);
    });

    it("撞冲突时一个字节都不写：直接 return Conflict，不落到 atomic_write", () => {
      const conflictAt = saveFileRs.indexOf("return Ok(SaveOutcome::Conflict(");
      const writeAt = saveFileRs.indexOf("atomic_write::atomic_write");
      expect(conflictAt, "必须有冲突分支").toBeGreaterThan(-1);
      expect(conflictAt, "冲突必须提前返回（早于写盘）").toBeLessThan(writeAt);
    });

    it("只在目标存在时检查，force 为 true 时跳过（覆盖保存是用户的明确选择）", () => {
      // 文件被外部删掉时 disk_version 是 (0,0)，会被误判成「版本变了」；
      // 而正确行为是重建文件（用户的内容还在编辑器里）。
      const guard = saveFileRs.slice(saveFileRs.indexOf("force != Some(true)"));
      expect(guard.slice(0, 200), "检查必须限定在目标存在时").toContain("target.exists()");
      expect(saveFileRs, "force 时不检查").toContain("force != Some(true)");
    });

    it("半份基线不算基线：缺 mtime 或缺 size 都得退回不检查", () => {
      // 抽成纯函数是为了能单测（真实 save_file 依赖 AppState 与文件系统，测不动）
      expect(rustCmds, "expected_version 必须存在").toContain("fn expected_version(");
      expect(rustCmds, "is_stale 必须存在").toContain("fn is_stale(");
      expect(rustCmds, "没有已知版本时不做判断").toMatch(/None => false,/);
    });
  });

  describe("B 档：冲突是预期分支，不是异常（回包契约）", () => {
    it("SaveOutcome 用 tagged enum 区分 saved / conflict，不走 Err(String)", () => {
      // 走 Err 的话，前端只能靠匹配错误文案来分辨「冲突」与「真的写盘失败」，
      // 那种写法一改文案就断。
      expect(rustCmds, "必须是 tagged enum").toMatch(/#\[serde\(tag = "kind", content = "value"/);
      expect(rustCmds, "必须有 Saved 分支").toContain("Saved(SavedFile),");
      expect(rustCmds, "必须有 Conflict 分支").toContain("Conflict(SaveConflict),");
      expect(rustCmds, "save_file 的返回类型必须是 SaveOutcome").toMatch(
        /-> Result<SaveOutcome, String>/,
      );
    });

    it("前端按 kind 分派，且冲突字段名是 camelCase", () => {
      expect(api, "saved 分支").toMatch(/kind: "saved"; value: SavedFile/);
      expect(api, "conflict 分支").toMatch(/kind: "conflict"; value: SaveConflict/);
      const conflict = api.slice(api.indexOf("export interface SaveConflict"));
      expect(conflict.slice(0, 400), "diskMtimeMs 必须是 camelCase").toContain(
        "diskMtimeMs: number;",
      );
      expect(conflict.slice(0, 400), "diskSize 必须是 camelCase").toContain("diskSize: number;");
    });
  });

  describe("C 档：手动保存撞冲突 → 四个分支都不能自作主张", () => {
    it("保存时带上已知磁盘版本作为基线", () => {
      expect(saveCore, "必须传 expectMtimeMs").toContain("expectMtimeMs:");
      expect(saveCore, "必须传 expectSize").toContain("expectSize:");
    });

    it("只有原地保存才带基线：另存为不能拿旧文件的版本号去比对", () => {
      // 否则「另存为」到另一个文件时，会拿 A 的版本号去比对 B —— 凭空报一次冲突。
      expect(saveCore, "必须判定是否原地保存").toMatch(
        /const inPlace = !forceDialog && !!doc\.path && target === doc\.path;/,
      );
      expect(saveCore, "基线只在原地保存时启用").toMatch(
        /const hasBaseline = inPlace && doc\.diskMtimeMs > 0;/,
      );
    });

    it("撞冲突先问用户；只有选了覆盖才用 force 重存一次", () => {
      expect(saveCore, "必须识别 conflict").toMatch(/if \(outcome\.kind === "conflict"\)/);
      expect(saveCore, "必须把选择交回用户").toContain("resolveSaveConflict(doc, outcome.value)");
      // ⚠️ 关键：除「覆盖保存」外一律不写盘
      expect(saveCore, "除覆盖外都不写盘").toMatch(/!== "overwrite"\) return false;/);
      expect(saveCore, "覆盖时必须 force（否则会被自己的检查再拦一次）").toMatch(/force: true,/);
    });

    it("取消：既没写盘也没丢改动", () => {
      expect(resolveSave, "取不到 resolveSaveConflict").toBeTruthy();
      expect(resolveSave, "cancel 分支必须给出提示").toContain("已取消保存");
      expect(resolveSave, "cancel 返回 abort（调用方据此不写盘）").toContain('return "abort";');
    });

    it("载入磁盘版本：走 applyDiskContent（内容以磁盘为准），且不写盘", () => {
      const revertBranch = resolveSave.slice(resolveSave.indexOf('if (choice === "revert")'));
      // 与 B87 那条路径共用同一个函数 → 同样会清脏、清 external、作废热退出副本
      // ⚠️ 用正则而不是整串：prettier 会把超宽的多参数调用拆成多行，
      //    写死 "applyDiskContent(doc, file" 会在格式化之后假红（本条已实测踩过）。
      expect(revertBranch, "必须替换内容").toMatch(/applyDiskContent\(\s*doc,\s*file,/);
      expect(revertBranch, "revert 之后不写盘").toContain('return "abort";');
    });

    it("对照比较：开磁盘副本对照并刷新已知版本，当前文档一字不动", () => {
      const compareBranch = resolveSave.slice(resolveSave.indexOf('if (choice === "compare")'));
      expect(compareBranch, "必须开对照").toContain("openDiskCopyForCompare(doc, file)");
      expect(
        compareBranch,
        "刷新已知版本 → 之后保存是「看过之后的有意覆盖」，不该再弹一次",
      ).toContain("markDiskVersion(doc,");
    });
  });

  describe("D 档：自动保存既不能弹框，也不能替用户盖掉外部版本", () => {
    it("自动保存带基线，撞冲突静默跳过（不弹框、不写盘）", () => {
      expect(autosave, "必须传基线").toContain("expectMtimeMs:");
      // ⚠️ 本档命门：自动保存**不得**调 resolveSaveConflict —— 用户正打字时弹模态框
      //    是体验灾难，而替他盖掉外部的新版本是数据灾难。
      expect(autosave, "自动保存绝不弹冲突框").not.toContain("resolveSaveConflict");
      expect(autosave, "撞冲突就跳过这个文档").toMatch(
        /if \(outcome\.kind === "conflict"\) continue;/,
      );
    });
  });

  describe("E 档：保存冲突框的按钮与兜底", () => {
    it("给出覆盖 / 载入 / 对照三选一，Esc 兜底是取消（既不写盘也不丢改动）", () => {
      expect(saveDialogFn, "取不到 showSaveConflictDialog").toBeTruthy();
      expect(saveDialogFn, "覆盖保存").toContain('textContent = "覆盖保存"');
      expect(saveDialogFn, "载入磁盘版本").toContain('textContent = "载入磁盘版本"');
      expect(saveDialogFn, "对照比较").toContain('textContent = "对照比较"');
      expect(saveDialogFn, "Esc 必须取消（唯一既不写盘也不丢改动的一支）").toMatch(
        /e\.key === "Escape"[\s\S]{0,200}close\("cancel"\)/,
      );
    });

    it("焦点给「对照比较」：误触 Enter 也不能盖掉磁盘上的新版本", () => {
      expect(saveDialogFn, "焦点必须是非破坏性的那一支").toContain("compare.focus();");
      expect(saveDialogFn, "不得把焦点给覆盖保存").not.toContain("overwrite.focus();");
    });
  });
});

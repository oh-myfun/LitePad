// 侧栏 B195（对标 VS Code 的 activity bar + side bar）：
//   最左侧是**常驻按钮列**，右边是**展开区**，两者合起来是**一张卡片**；
//   卡片与右侧编辑区卡片之间是**空隙**，空隙正中放**三点拖拽把手**。
// 全部是静态契约：结构（index.html）、卡片样式（global.css）、空隙与把手（preview.css）、
// 接线（main.ts + codicons.ts）。每条关键断言都配「替身」反向验证，
// 免得契约只是把现状抄一遍（假绿）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { cssDecls, ruleBlock } from "./static";

// CRLF 归一：工作副本被翻成 CRLF 时，靠 `\n` 锚行的判据会一起失真（见 MEMORY）。
const html = readFileSync("index.html", "utf-8").replace(/\r\n/g, "\n");
const css = readFileSync("src/styles/global.css", "utf-8").replace(/\r\n/g, "\n");
const preview = readFileSync("src/styles/preview.css", "utf-8").replace(/\r\n/g, "\n");
const src = (
  readFileSync("src/main.ts", "utf-8") +
  "\n" +
  readFileSync("src/ui.ts", "utf-8") +
  "\n" +
  readFileSync("src/toc.ts", "utf-8") +
  "\n" +
  // B307：展开区的显隐出口搬到了外壳，这个拼接清单不含它就等于没盯。
  readFileSync("src/shell/drawer.ts", "utf-8") +
  "\n" +
  // B353：侧栏底部那颗「设置」的装配在 prefs.ts（它开的就是这一页的对话框）。
  readFileSync("src/prefs.ts", "utf-8")
).replace(/\r\n/g, "\n");
const icons = readFileSync("src/shell/codicons.ts", "utf-8").replace(/\r\n/g, "\n");

/** 取某条规则里某条声明的原文（含属性名），取不到返回空串。 */
function declOf(cssText: string, selector: string, prop: string): string {
  const block = cssDecls(ruleBlock(cssText, selector));
  return block.match(new RegExp(`${prop}:\\s*[^;]*`))?.[0] ?? "";
}

describe("B201 左栏几何：卡片画完整一圈 + 按钮列内部分割线 + sash 同款拖拽带", () => {
  it("① 两张卡片**四边完整**：朝缝的那两条边（左卡 right / 右卡 left）照旧 1px", () => {
    // VS Code floatingPanels.css 那句 *gives up its border* 说的是**活动栏 ↔ 侧栏**
    // 那条 rail 的接缝（一张卡压在另一张上、由中间那条轨只画一条缝）；而这里是两张
    // **并列**的独立卡片，各自的外框要画完整 —— 用户第二轮点名「边框不见了」就是这条。
    expect(css, "左卡不得让出朝缝的右边框").not.toMatch(/\.side-shell\s*\{[^}]*border-right-color/);
    expect(css, "右卡不得让出朝缝的左边框").not.toMatch(/\.layout-area\s*\{[^}]*border-left-color/);
    // 卡片轮廓本身还在（上下/外缘那几边照旧 1px），别让完就没了
    expect(declOf(css, ".side-shell", "border")).toBe(declOf(css, ".layout-area", "border"));
    expect(declOf(css, ".side-shell", "border-radius")).toBe(
      declOf(css, ".layout-area", "border-radius"),
    );
  });

  it("② 按钮列 ↔ 展开区之间这条内部分割线必须画（VS Code 活动栏同款）", () => {
    expect(declOf(css, ".side-bar", "border-right"), "按钮列右缘的内部竖线").toBe(
      "border-right: 1px solid var(--activitybar-border)",
    );
    // 收起展开区时它得收掉：那时按钮列右缘正好贴着卡片右缘，
    // 两条 1px 边紧挨着 = 一条 2px 粗的线。
    const collapsed = ruleBlock(css, ".side-shell.is-collapsed > .side-bar");
    expect(collapsed, "必须有一条收起态的抑制规则").toBeTruthy();
    expect(collapsed, "收起时那条内部竖线要收掉").toMatch(/border-right-color:\s*transparent/);
  });

  it("③ 显隐由外壳 setDrawer 一处收口：卡片挂同类名，别在 CSS 里翻显隐", () => {
    expect(src, "side-shell 要先 el() 取出来").toMatch(/const sideShell = el\("side-shell"\)/);
    expect(src, "setDrawer 里必须给卡片挂 is-collapsed（第 5 件事）").toMatch(
      /sideShell\.classList\.toggle\("is-collapsed",\s*!open\)/,
    );
    // 首屏（HTML 里外壳本来就是 hidden）也要带这个类：否则那条内部竖线会先画
    // 出来、再被启动回放收掉 —— 开屏闪一帧 2px 粗线。
    expect(html, "首屏收起态：卡片先带 is-collapsed，与 #side-drawer 的 hidden 同源").toMatch(
      /<div id="side-shell" class="side-shell is-collapsed">/,
    );
  });

  it("④ 拖拽带对齐 VS Code sash：平时透明、悬停/拖拽整条 4px 点亮", () => {
    // sash.css 三层：本体 4px + `:before` 换 background-color + 0.1s ease-out 过渡。
    // 关键是**平时什么都不画**（本体是 editorWidget.border 那层透明），反馈全在悬停那一下。
    const seam = ruleBlock(preview, ".side-resizer::before");
    expect(seam, "应有 .side-resizer::before 这条 sash 反馈").toBeTruthy();
    expect(seam, "平时必须透明（sash 默认态就是看不见）").toMatch(/background:\s*transparent/);
    expect(seam, "亮度必须是渐变（sash.css 的 transition: background-color .1s ease-out）").toMatch(
      /transition:\s*background-color 0\.1s ease-out/,
    );
    // 拖拽区 = 卡片缝 = 同一档宽度（B196：改缝宽时这条跟着走，不写死像素）
    expect(seam, "点亮宽度就是缝本身那 4px").toMatch(/width:\s*var\(--card-gap\)/);
    expect(seam, "纯视觉反馈：不吃指针，别变成热区").toContain("pointer-events: none");
    expect(preview, "抓取区不得外溢（缝是 4px 就是 4px）").not.toMatch(
      /\.side-resizer::before\s*\{[^}]*(?:\s|;)\s*(?:left|right):\s*-/,
    );
    // 点亮 = sash.hoverBorder → focusBorder，即我们的 --accent
    const lit = preview.match(/\.side-resizer:hover::before[\s\S]{0,200}?\{[^}]*\}/)?.[0] ?? "";
    expect(lit, "hover 时点亮").toBeTruthy();
    expect(lit, "点亮走 --accent（= focusBorder 那一档）").toMatch(/background:\s*var\(--accent\)/);
    // B217：拖拽这一档只认**被拖的那一条**（`.resizing` 由按下那一侧亲手加）
    expect(preview, "拖拽中这条自己要亮（指针滑出窄带时不能看着像没抓住）").toMatch(
      /\.side-resizer\.resizing::before\s*\{[\s\S]*?background:\s*var\(--accent\)/,
    );
    // 反向：不许再拿全局的 body 类点亮它 —— 那样拖分屏时这条左栏缝会跟着亮
    expect(preview, "不许用 body 全局类点亮这条缝（拖哪条就亮哪条）").not.toMatch(
      /body\.layout-dragging\s+\.side-resizer::before/,
    );
    // 三点把手必须压在亮条之上：亮条是绝对定位的兄弟，不抬层就糊掉三点
    const grip = ruleBlock(preview, ".toc-grip", undefined, true);
    expect(grip, "三点把手要抬到亮条之上").toMatch(/position:\s*relative/);
    expect(grip, "抬层靠 z-index").toMatch(/z-index:\s*1/);
  });

  it("⑤ 反向验证：摘掉按钮列那条内部竖线必须被咬住", () => {
    const BAD = css.replace(/\.side-shell\.is-collapsed > \.side-bar\s*\{[^}]*\}\n/, "");
    const BAD2 = css.replace(/(\.side-bar\s*\{[^}]*)border-right:[^;]*;/, "$1");
    expect(BAD2, "替身必须真的删掉那条线").not.toBe(css);
    expect(() => {
      expect(declOf(BAD2, ".side-bar", "border-right"), "内部竖线必须存在").toBe(
        "border-right: 1px solid var(--activitybar-border)",
      );
    }).toThrow();
    expect(BAD, "替身必须真的删掉收起态那条").not.toBe(css);
    expect(() => {
      expect(BAD, "收起态的抑制规则必须还在").toMatch(
        /\.side-shell\.is-collapsed > \.side-bar\s*\{[^}]*border-right-color/,
      );
    }).toThrow();
  });

  it("⑥ 反向验证：缝里的反馈退回常驻发丝线（缝里多画一条）必须被咬住", () => {
    const BAD = preview.replace(
      /(\.side-resizer::before\s*\{[^}]*)background:\s*transparent;/,
      "$1background: var(--editor-split-border);",
    );
    expect(BAD, "替身必须真的改成常驻线").not.toBe(preview);
    expect(() => {
      const block = ruleBlock(BAD, ".side-resizer::before");
      expect(block, "sash 默认态必须透明").toMatch(/background:\s*transparent/);
    }).toThrow();
  });

  it("⑦ 反向验证：摘掉变色过渡（生硬跳变）必须被咬住", () => {
    const BAD = preview.replace(
      /(\.side-resizer::before\s*\{[^}]*)transition:\s*background-color 0\.1s ease-out;/,
      "$1transition: none;",
    );
    expect(BAD, "替身必须真的摘掉过渡").not.toBe(preview);
    expect(() => {
      const block = ruleBlock(BAD, ".side-resizer::before");
      expect(block, "sash 的变色过渡必须还在").toMatch(
        /transition:\s*background-color 0\.1s ease-out/,
      );
    }).toThrow();
  });
});

describe("B195 侧栏结构：按钮列 → 展开区（外壳套两块视图）→ 空隙 → 编辑区", () => {
  it("index.html 里各段的先后顺序与嵌套关系正确", () => {
    const at = (id: string) => html.indexOf(`id="${id}"`);
    const iShell = at("side-shell");
    const iBar = at("side-bar");
    const iOutline = at("side-outline");
    const iDrawer = at("side-drawer");
    const iPanel = at("toc-panel");
    const iRecent = at("recent-panel");
    const iResizer = at("side-resizer");
    const iArea = at("layout-area");
    for (const [name, i] of [
      ["side-shell", iShell],
      ["side-bar", iBar],
      ["side-outline", iOutline],
      ["side-drawer", iDrawer],
      ["toc-panel", iPanel],
      ["recent-panel", iRecent],
      ["side-resizer", iResizer],
      ["layout-area", iArea],
    ] as const) {
      expect(i, `index.html 必须有 #${name}`).toBeGreaterThan(-1);
    }
    // 按钮列在展开区**之前**（最左侧），两块视图都在壳**里面**，壳在空隙之前，空隙在编辑区之前
    expect(iBar, "按钮列必须在展开区之前").toBeLessThan(iDrawer);
    expect(iOutline, "大纲键必须落在按钮列里").toBeGreaterThan(iBar);
    expect(iOutline, "大纲键必须落在按钮列里").toBeLessThan(iDrawer);
    // B307：壳的开标签必须排在两块面板之前（真正的嵌套由 drawer.test.ts 用运行时行为盯：
    // 壳收起时两块都得拿不到位置）。这里只挡「壳跑到面板外面变成第二份外壳」这一种走形。
    expect(iDrawer, "外壳的开标签必须先于大纲那块").toBeLessThan(iPanel);
    expect(iDrawer, "外壳的开标签必须先于最近打开那块").toBeLessThan(iRecent);
    expect(iPanel, "空隙必须贴着展开区（在壳之外）").toBeLessThan(iResizer);
    expect(iResizer).toBeLessThan(iArea);
  });

  it("大纲键是可访问按钮；空隙里有三点把手，且首屏就是「收起」态", () => {
    const btn = html.match(/<button\s+id="side-outline"[\s\S]*?>/)?.[0] ?? "";
    expect(btn, "应能取到 #side-outline 开标签").toBeTruthy();
    expect(btn, "要有 aria-label（图标键没有文字）").toContain("aria-label");
    expect(btn, "开合态要有 aria-pressed").toContain('aria-pressed="false"');

    const grip = html.match(/<span id="toc-grip"[^>]*>/)?.[0] ?? "";
    expect(grip, "空隙里要有三点把手（#toc-grip；缺 id 则 main.ts 的 el() 启动即抛）").toBeTruthy();
    expect(grip, "把手是纯装饰，对读屏器隐藏").toContain('aria-hidden="true"');

    const resizer = html.match(/<div\s+id="side-resizer"[\s\S]*?>/)?.[0] ?? "";
    expect(resizer, "应能取到 #side-resizer 开标签").toBeTruthy();
    // 空隙是两张卡片之间的**固定**间距：不再随大纲收起而消失（否则间距会跳变），
    // 收起只是把手隐身 + 不吃指针（preview.css 的 .side-resizer.is-off）。
    expect(resizer, "空隙不再 hidden").not.toContain("hidden");
    expect(resizer, "首屏（大纲收起）分隔条就是 is-off").toContain("is-off");
  });
});

// ------------------------------------------------------- B196：卡片几何对齐 VS Code
// 用户点名：「左栏区和编辑区的拖拽区宽度，左栏以及编辑区和窗口边缘的宽度，也都参考 vscode
// 进行优化」。VS Code 源码里的口径（已逐条核实）：
//   · sash 本体 sash.css 的 --vscode-sash-size = 4px；
//   · 卡片之间 layoutService.ts 的 FLOATING_PANEL_MARGIN = 4（token spacing-size40）；
//   · 卡片到窗口边缘 floatingPanels.css 的 floating-card-outer-margin = 4（两种密度同档）。
// B195 那版拖拽区写成 10px、卡片贴窗口边缘 0px，正差在这一档上 ⇒ 收口成两个变量。

// ------------------------------------------------------- B203：完全复制 VS Code 的间距 / 外框 / 拖拽条
// 用户点名：「完全复制 vscode 的左右栏间距、外框边距，拖拽条样式」。
// 三项逐条回 VS Code 源码核对过（出处都写在注释里，代码里只锁「还必须成立」的那几条）：
//   · 左右栏间距：sash.css 的 --vscode-sash-size 4px = floatingPanels.css 的
//     --modern-ui-floating-card-margin（= spacing-size40 4px）—— 本软件 --card-gap 已经是它
//     （B196 锁死），且缝里那条 sash 三层的悬停反馈 B201 也锁死了。
//   · 外框边距：--modern-ui-floating-card-outer-margin 同样落在 spacing-size40（4px），
//     **且只有 .top-window-edge（无标题栏 / 全屏）那一档才补顶留白** —— LitePad 有自绘
//     标题栏 ⇒ padding-top: 0 是照抄判据，不是漏写，所以顶部那条不在这里重复锁。
//   · 拖拽条样式：B203 补的是**三点把手让位** —— sashHandles.css 里
//     `.monaco-sash.hover:not(.disabled)::after, .monaco-sash.active:not(.disabled)::after
//     { opacity: 0 }`，同文件 README 那句原话就是 "On hover/active the grip fades out in
//     favour of the existing full-length highlight"。

// ------------------------------------------------------- B379：分区域底色（推翻 B199 的单色裁决）
// B199 曾按用户裁决把整张左栏与编辑区压成同一颗 --bg；B379 用户重新点名
// 「侧边栏……颜色和样式尽量和 vscode 保持一致」⇒ 恢复 VS Code 的三层关系：
//   shell（标题/状态栏）= --shell-bg、侧栏 = --sidebar-bg、编辑区 = --bg。
// ② 缝仍是 4px（B196/B197 的裁决不动），三点把手 16px 不动。

describe("B195 接线：按钮列点亮态与面板开合一处收口", () => {
  it("setupSideBar 装上字形与点击、把大纲登记进外壳，且排在开合回放之前", () => {
    const setup = src.match(/function setupSideBar\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(setup, "应有 setupSideBar").toBeTruthy();
    expect(setup, "大纲键要填字形").toContain("sideOutline.innerHTML = CODICONS.outline");
    expect(setup, "把手要填字形").toContain("tocGrip.innerHTML = CODICONS.grip");
    expect(setup, "点击走 toggleToc（与命令、菜单同一入口）").toContain("toggleToc()");
    expect(setup, "大纲这一块必须登记进外壳（登记了才有点亮态与互斥）").toContain(
      'registerDrawerView("toc"',
    );
    // 回放（setDrawer）会写 is-on / aria-pressed，先装配再回放才不会装到空元素上
    const iCall = src.indexOf("setupSideBar();");
    const iReplay = src.indexOf("replayDrawer();");
    expect(iCall, "bootstrap 必须调用 setupSideBar").toBeGreaterThan(-1);
    expect(iReplay, "bootstrap 必须回放开合").toBeGreaterThan(-1);
    expect(iCall, "先装按钮列、再回放开合").toBeLessThan(iReplay);
  });

  it("setDrawer 一处写完：壳显隐 + 空隙 is-off + 两块面板 + 两颗键 is-on/aria-pressed", () => {
    const body = src.match(/function setDrawer\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(body, "应有 setDrawer 这个唯一出口").toBeTruthy();
    expect(body, "展开区显隐写在壳上").toContain("sideDrawer.hidden = !open;");
    expect(body, "空隙转 is-off（不 hidden：间距不跳变）").toContain(
      'sideResizer.classList.toggle("is-off", !open)',
    );
    // B312：面板与键的写法收进了 `applyView` —— 不是把它拆成第二个出口，而是**同一段**
    // 现在有两个调用者（切换时整表循环、登记时补写迟到那一块）。收口仍然只有一处代码。
    expect(body, "每块面板与键都经同一段写完（不许在 setDrawer 里另写一份）").toContain(
      "for (const [name, spec] of views) applyView(name, spec);",
    );
    const apply = src.match(/function applyView\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(apply, "应有 applyView 这一段（面板显隐与点亮态同源）").toBeTruthy();
    expect(apply, "每块面板按「轮到我没」写 hidden（互斥是结构性的）").toContain(
      "spec.panel.hidden = name !== active;",
    );
    expect(apply, "键点亮").toContain('spec.button.classList.toggle("is-on", name === active)');
    expect(apply, "aria-pressed 与点亮态同源").toContain(
      'spec.button.setAttribute("aria-pressed", String(name === active))',
    );
    // 按钮列本身**常驻**：这里不该出现把整列藏掉的代码
    expect(body, "按钮列不得跟着隐藏（收起也留一列）").not.toContain("side-bar");
  });

  it("反向验证：摘掉键的点亮态 → 契约必须落空", () => {
    const ORIG = '  spec.button.classList.toggle("is-on", name === active);';
    expect(src, "退化串要先自证原句还在").toContain(ORIG);
    const BAD = src.replace(ORIG, "");
    expect(BAD, "退化后不再点亮").not.toContain(
      'spec.button.classList.toggle("is-on", name === active)',
    );
    expect(() => {
      expect(
        BAD.match(/function applyView\([\s\S]*?\n\}/)?.[0] ?? "",
        "退化后的缺失必须被抓到",
      ).toContain('spec.button.classList.toggle("is-on", name === active)');
    }).toThrow();
  });
});

// ------------------------------------------------------- B198：标题栏整栏显隐双字形开关
// 用户点名：「标题栏上增加 layout-sidebar-left / layout-sidebar-left-off 按钮，参考 vscode，
// 但是 vscode 应该只对左边栏的展开区做了折叠，按钮还是会显示，本软件直接隐藏整个左边栏」。
// 于是这里分两层：`applySidebarVisible` 管「左栏在不在」（整张卡片 + 中间缝一起收），
// 外壳的 `setDrawer` 管「卡片里的展开区开没开」—— 两层互不撤销，谁也不替对方清状态。
// 与 VS Code 的差别只在**生效范围**：那边折的只是展开区、活动栏仍在（按钮一直显示），
// 本软件收的是整张卡片；但**这颗键自己**两边都始终显示 —— 它是左栏唯一的开关入口。
describe("B198 标题栏整栏显隐：双字形开关 + 整栏一起收", () => {
  it("① index.html：键在 .title-actions 里、排在置顶键左侧、HTML 里不写死字形", () => {
    const iToggle = html.indexOf('id="sidebar-toggle"');
    expect(iToggle, "标题栏要有 #sidebar-toggle").toBeGreaterThan(-1);
    expect(
      iToggle,
      "整栏开关必须与置顶键同容器（.title-actions，不走 .window-controls 那套）",
    ).toBeLessThan(html.indexOf('id="win-pin"'));
    expect(
      html.indexOf('id="win-pin"'),
      "同一个容器：工具键整体仍排在窗口控制三键之前",
    ).toBeLessThan(html.indexOf('class="window-controls"'));
    const btn = html.match(/<button\s+id="sidebar-toggle"[\s\S]*?>/)?.[0] ?? "";
    expect(btn, "应能取到 #sidebar-toggle 开标签").toBeTruthy();
    expect(btn, "图标键没有文字，必须自带 aria-label").toContain("aria-label");
    expect(btn, "图标键必须自带 data-tip（提示走自绘层，不是原生 title）").toContain("data-tip");
    // 初值要反映**首屏真实状态**：左栏默认在 ⇒ aria-pressed="true"（与 #win-pin 的
    // "false" 同一种诚实：那颗的默认值是「未置顶」）。反正 boot 时会被回放覆盖一次。
    expect(btn, "开关型控件必须报 aria-pressed").toContain('aria-pressed="true"');
    // 字形由启动时回放写入（#win-pin 就是这么干的），HTML 里留空才是「一处真相」。
    expect(btn, "HTML 里不许先塞一个字形，免得两处各写一半").not.toContain("codicon");
    // 观感要和置顶/同步键同款（24×24 那族），光给 class="title-btn" 会被 46px 方键吃掉
    expect(btn, "外观要跟着同步滚动键那一族走").toContain('class="title-btn layout-btn"');
  });

  it("② 两颗字形取 codicons.ts 的官方粒子（不许手绘 SVG / 写死码位）", () => {
    expect(icons, "整栏在 = layout-sidebar-left").toMatch(
      /layoutSidebarLeft:\s*"layout-sidebar-left"/,
    );
    expect(icons, "整栏收 = layout-sidebar-left-off").toMatch(
      /layoutSidebarLeftOff:\s*"layout-sidebar-left-off"/,
    );
    const btn = html.match(/<button\s+id="sidebar-toggle"[\s\S]*?>/)?.[0] ?? "";
    expect(btn, "不许内联 SVG（红线：图标只能从 codicons.ts 取）").not.toMatch(/<svg/);
  });

  it("③ applySidebarVisible 一处收口：整栏类 + 双字形 + 点亮 + aria-pressed + 文案 + 落盘", () => {
    const body = src.match(/function applySidebarVisible\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(body, "应有 applySidebarVisible").toBeTruthy();
    // 整栏去留的**唯一真相**：#main-row 上的一个类
    expect(body, "整栏收放挂 #main-row 的 is-sidebar-off").toContain(
      'mainRow.classList.toggle("is-sidebar-off", off)',
    );
    // 双字形：左栏在 = layout-sidebar-left（收起画 -off）—— 与置顶 / 同步滚动同款
    expect(body, "字形是状态本身（左栏在）").toMatch(
      /sidebarToggle\.innerHTML[\s\S]{0,120}?CODICONS\.layoutSidebarLeftOff/,
    );
    expect(body, "字形是状态本身（整栏收）").toMatch(
      /sidebarToggle\.innerHTML[\s\S]{0,120}?CODICONS\.layoutSidebarLeft\b/,
    );
    expect(body, "is-on 与「左栏在」同源").toContain(
      'sidebarToggle.classList.toggle("is-on", !off)',
    );
    expect(body, "aria-pressed 与「左栏在」同源").toContain(
      'sidebarToggle.setAttribute("aria-pressed", String(!off))',
    );
    // 开与关两句都要换：tooltip / aria-label / 读屏器读的是同一个 label
    expect(body, "文案要跟着换（关）").toContain('"显示左栏"');
    expect(body, "文案要跟着换（开）").toContain('"隐藏左栏"');
    expect(body, "提示走 setTip（与 refreshPinButton 同一口径）").toContain("setTip(sidebarToggle");
    // 与外壳 setDrawer 同一口径：只有 persist 为真且设置已就绪才落盘
    expect(body, "落盘前要先过 persist 门槛").toContain("if (!persist || !settings) return;");
    expect(body, "写进设置里的字段是 sidebar_off").toMatch(/settings\.sidebar_off = off;/);
  });

  it("④ 两颗态由 #main-row 一处判（isSidebarOff），切换只走一个出口", () => {
    const off = src.match(/function isSidebarOff\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(off, "应有 isSidebarOff 判据出口").toBeTruthy();
    expect(off, "判据只有一处：#main-row 上的那个类").toContain(
      'mainRow.classList.contains("is-sidebar-off")',
    );
    const toggle = src.match(/function toggleSidebar\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(toggle, "应有 toggleSidebar").toBeTruthy();
    expect(toggle, "切换 = 当前收着取反").toMatch(/applySidebarVisible\(!isSidebarOff\(\)\)/);
    expect(src, "点击接线挂在 setupSideBar 里（与大纲键同一处装配）").toMatch(
      /function setupSideBar\(\)[\s\S]{0,400}?sidebarToggle\.addEventListener\("click", \(\) => toggleSidebar\(\)\)/,
    );
  });

  it("⑤ 与外壳 setDrawer 正交：整栏收着不动展开区，反之亦然", () => {
    const drawer = src.match(/function setDrawer\([\s\S]*?\n\}/)?.[0] ?? "";
    const bar = src.match(/function applySidebarVisible\([\s\S]*?\n\}/)?.[0] ?? "";
    // 整栏收放不许顺手改展开区（不然「收起左栏 = 大纲也关了」就是半同步）
    expect(bar, "整栏收放不得碰展开区显隐").not.toMatch(
      /(tocPanel|recentPanel|sideDrawer)\.(hidden|style)/,
    );
    expect(bar, "整栏收放不得碰展开区的开合字段（互不撤销）").not.toMatch(/toc_open/);
    // 反过来也不许：外壳只管展开区，整栏的去留归 applySidebarVisible
    expect(drawer, "展开区开合不得顺手收放整栏").not.toMatch(/is-sidebar-off/);
    expect(drawer, "整栏收起时展开区值照旧留着 ⇒ 这里不许出现 sidebar_off").not.toMatch(
      /sidebar_off/,
    );
    // 双击/拖拽无关，但「整栏收着时点大纲」这条命令要先放栏 —— 否则是死键。
    // ⚠️ 不写字符预算（`{0,600}` 那一版每次往两句之间插闸就断，是断言自己的脆弱）：
    //  改成在 `toggleToc` 体内比先后 —— 插多少注释都不影响它，而顺序真的反了才红。
    const toggle = src.match(/function toggleToc\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    const iRestore = toggle.indexOf("applySidebarVisible(false)");
    const iOutlet = toggle.indexOf("setDrawer(");
    expect(iRestore, "toggleToc 里要先放整栏").toBeGreaterThan(-1);
    expect(iOutlet, "toggleToc 必须走外壳唯一出口").toBeGreaterThan(-1);
    expect(
      iRestore,
      "整栏收着时必须先把它放出来，再切展开区（display:none 里切＝没反应）",
    ).toBeLessThan(iOutlet);
    // B305 / B307：子窗口整条左栏都不在，大纲命令必须**最先**空转 —— 否则会「打开一块
    // 看不见的面板」，顺带把 `toc_open` 写成 true 落盘，下次在主窗口就表现为「没点它，
    // 大纲自己开起来了」。
    expect(toggle, "大纲命令在子窗口空转").toContain('if (windowKind === "satellite") return;');
    expect(
      toggle.indexOf('if (windowKind === "satellite") return;'),
      "空转那道闸必须排在放栏之前（不然空转还会改掉整栏偏好）",
    ).toBeLessThan(iRestore);
  });

  it("⑥ 整栏收起时卡片与缝**一起**消失（不是只折展开区）", () => {
    // 缝（#side-resizer）那条在 preview.css，卡片（.side-shell）那条在 global.css ——
    // 同一件事的两个半，两处都得有，缺一个就留下一道悬空的空隙。
    expect(css, "侧栏卡片要跟着整栏收起").toMatch(
      /#main-row\.is-sidebar-off > \.side-shell\s*\{\s*display:\s*none;/,
    );
    expect(preview, "中间那道缝也要跟着收起（左栏没了，缝就是悬空间距）").toMatch(
      /#main-row\.is-sidebar-off > #side-resizer\s*\{\s*display:\s*none;/,
    );
    // 与「只折展开区」那条分清：那一条是留缝的（间距不跳变），这里必须相反
    const offRule = ruleBlock(preview, ".side-resizer.is-off");
    // B207：收起展开区 = 只折展开区 —— 缝留着**并且还抓得住**（旧口径把把手隐身 + 掐指针，
    // 结果拖到底就再也拖不回来），把手也照旧在（它现在真是「这里能拖」的标记了）。
    expect(offRule, "收起展开区仍留缝、且照样可抓").toContain("pointer-events: auto");
    expect(preview, "收起时把手不许再隐身（要看得见这条缝在哪）").not.toMatch(
      /\.side-resizer\.is-off \.toc-grip\s*\{[^}]*visibility:\s*hidden/,
    );
  });

  it("⑦ 那颗键自己**始终显示**（它是左栏唯一的开关入口）", () => {
    const bar = src.match(/function applySidebarVisible\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(bar, "整栏收放不得把开关键自己也收掉（收了就点不回来）").not.toMatch(
      /sidebarToggle\.(hidden|classList\.(add|remove)\("hidden\))/,
    );
    expect(bar, "整栏收放只写那个挂在 #main-row 上的类").not.toMatch(
      /sidebarToggle\.classList\.(add|remove)/,
    );
  });
});

// ------------------------------------------------------- B198：设置字段与启动回放
describe("B198 整栏去留：切一次要落盘、启动要回放", () => {
  const api = readFileSync("src/ipc/api.ts", "utf-8").replace(/\r\n/g, "\n");
  const rs = readFileSync("src-tauri/src/session/mod.rs", "utf-8").replace(/\r\n/g, "\n");

  it("设置里要有 sidebar_off（前端类型 + Rust 结构 + 默认值）", () => {
    expect(api, "Settings 类型需要 sidebar_off 字段").toContain("sidebar_off: boolean");
    expect(rs, "Rust Settings 需要 sidebar_off 字段").toContain("pub sidebar_off: bool");
    // 默认左栏在（= 不收），否则老用户一升级就看见编辑区独占整屏
    expect(rs, "默认应为「左栏在」（sidebar_off: false）").toContain("sidebar_off: false");
  });

  it("启动要回放上次的去留，且回放本身不写盘", () => {
    expect(src, "启动要按 settings.sidebar_off 回放").toMatch(
      /applySidebarVisible\(settings\?\.sidebar_off \?\? false, false\)/,
    );
    // persist=false：否则「加载失败 → 用默认值」会把默认值固化成用户设置
    const body = src.match(/function applySidebarVisible\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(body, "persist=false 时不得回写设置").toMatch(/if \(!persist \|\| !settings\) return;/);
    // 装配必须先于回放：那颗键的字形由 applySidebarVisible 写，先装才装得上
    const iCall = src.indexOf("setupSideBar();");
    const iReplay = src.indexOf("applySidebarVisible(settings?.sidebar_off ?? false, false)");
    expect(iCall, "bootstrap 必须调用 setupSideBar").toBeGreaterThan(-1);
    expect(iReplay, "bootstrap 必须回放整栏去留").toBeGreaterThan(-1);
    expect(iCall, "先装按钮列、再回放整栏去留").toBeLessThan(iReplay);
  });

  it("⑧ 反向验证：摘掉整栏类 → 契约必须落空", () => {
    const ORIG = '  mainRow.classList.toggle("is-sidebar-off", off);';
    expect(src, "退化串要先自证原句还在").toContain(ORIG);
    const BAD = src.replace(ORIG, "");
    expect(BAD, "退化后确实不再写整栏类").not.toContain(
      'mainRow.classList.toggle("is-sidebar-off", off)',
    );
    expect(() => {
      expect(
        BAD.match(/function applySidebarVisible\([\s\S]*?\n\}/)?.[0] ?? "",
        "退化后的缺失必须被抓到",
      ).toContain('mainRow.classList.toggle("is-sidebar-off", off)');
    }).toThrow();
  });

  it("⑨ 反向验证：整栏收起只收卡片、把那道缝落下（退回悬空间距）必须被咬住", () => {
    const BAD = preview.replace(
      /#main-row\.is-sidebar-off > #side-resizer\s*\{[^}]*display:\s*none;/,
      "#main-row.is-sidebar-off > #side-resizer { display: flex; }",
    );
    expect(BAD, "替身必须真的把缝留下").not.toBe(preview);
    expect(() => {
      expect(BAD, "替身的悬空缝必须被抓到").toMatch(
        /#main-row\.is-sidebar-off > #side-resizer\s*\{\s*display:\s*none;/,
      );
    }).toThrow();
  });

  it("⑩ 反向验证：字形退回只画一颗（状态全靠配色）必须被咬住", () => {
    const BAD = src.replace("CODICONS.layoutSidebarLeftOff", "CODICONS.layoutSidebarLeft");
    expect(BAD, "替身必须真的退化成单字形").not.toBe(src);
    expect(() => {
      expect(
        BAD.match(/function applySidebarVisible\([\s\S]*?\n\}/)?.[0] ?? "",
        "替身的单字形必须被抓到",
      ).toMatch(/CODICONS\.layoutSidebarLeftOff/);
    }).toThrow();
  });
});

// ------------------------------------------------------------------ B207（真机回归）
// 用户真机报「左栏没法折叠起来了，分割线区域空隙太大」。
// 根因不在 JS：`setSideOpen(false)`（B307 起这个出口叫外壳的 `setDrawer`）写的 `tocPanel.hidden = true` 一直是对的，
// 但 `.toc-panel { display: flex }`（B205 加的）是**作者样式表**，CSS 级联里作者样式表
// 优先于 UA 样式表 —— **与选择器权重无关** ⇒ UA 的 `[hidden] { display: none }` 被压掉，
// 属性改了、面板照旧占着 160px 显示。所以：
//   · 「折叠不起来」= 拖到最小再往左拖，展开区纹丝不动；
//   · 「空隙太大」   = 同一件事的另一半：`.side-shell.is-collapsed` 已经把按钮列右缘那条
//     内部竖线抹成透明了，而面板还在 ⇒ 按钮列右边凭空多出一大片空白。
// ⚠️ jsdom 不做 CSS 级联 ⇒ 断言 `tocPanel.hidden === true` / 断言 class **全是假绿**，
//    这条只能靠静态契约盯住。仓库里同类兜底已有 7 处（find-bar / find-row-replace /
//    find-status / sync-btn / tooltip×3），`.toc-panel` 是漏掉的那一个。
// ------------------------------------------------------- B353：按钮列底部那颗「设置」
// 用户点名「侧边栏底部添加设置页面入口按钮」，并要「直接照着 vscode 做」。
// VS Code 那一列把**管理类动作**放在活动栏的另一头（底部），字形用 `Codicon.gear`
// （上游 `preferences/browser/preferencesIcons.ts`：`settingsMoreActionIcon = Codicon.gear`）。
// 与上面三颗的分别是**职分**：那三颗切「看哪一块」（视图 ⇒ 归 setDrawer 管点亮态、
// 带 aria-pressed），这一颗做一件事（动作 ⇒ 没有「开着」这一态，所以不带 aria-pressed）。
describe("B353 侧栏底部「设置」入口：最后一颗 + 动作不是视图 + 沉到底", () => {
  /** 取 #side-bar **里面**那一段（列的开标签之后到列尾；里面只有注释与 button，
      没有嵌套 div ⇒ 第一个 </div> 就是列尾）。 */
  function sideBarSeg(): string {
    const attr = html.indexOf('id="side-bar"');
    expect(attr, "要有 #side-bar").toBeGreaterThan(-1);
    // ⚠️ 从开标签的 `>` 之后起：从 `id="side-bar"` 起会把这一列自己的 id 也当成第一颗键。
    const open = html.indexOf(">", attr);
    const end = html.indexOf("</div>", open);
    expect(end, "要能取到列尾").toBeGreaterThan(open);
    return html.slice(open + 1, end);
  }

  it("① 它是按钮列的**最后一颗**，顺序 = 资源管理器 / 搜索 / 差异 / 最近打开 / 大纲 / 设置", () => {
    const seg = sideBarSeg();
    const ids = [...seg.matchAll(/id="(side-[a-z]+)"/g)].map((m) => m[1]);
    // B389：搜索键插在资源管理器之后 —— VS Code 活动栏的次序就是 Explorer → Search，
    // 「在文件夹里搜」跟着那棵树走；上五颗切视图，最后一颗（设置）是动作。
    // B461：差异键排在搜索之后（VS Code 活动栏 Explorer → Search → 差异那一段）。
    expect(ids, "按钮列的读法顺序（上五颗切视图，最后一颗是动作）").toEqual([
      "side-explorer",
      "side-search",
      "side-diff",
      "side-recent",
      "side-outline",
      "side-settings",
    ]);
  });

  it("② 开标签：动作键的三件套齐（aria-label / data-tip / 沉底类），且**不带** aria-pressed", () => {
    const btn = html.match(/<button\s+id="side-settings"[\s\S]*?>/)?.[0] ?? "";
    expect(btn, "应能取到 #side-settings 开标签").toBeTruthy();
    expect(btn, "图标键没有文字，必须自带 aria-label").toContain('aria-label="设置"');
    expect(btn, "提示走自绘层（B350 按钮档：靠 data-tip + data-tip-placement 指右）").toContain(
      'data-tip="设置"',
    );
    expect(btn, "提示方向朝右（这一列在最左边，朝左就出屏了）").toContain(
      'data-tip-placement="right"',
    );
    expect(btn, "同款控件同档 + 沉底那一档").toContain('class="side-btn side-btn-bottom"');
    // ⚠️ 没有 aria-pressed 才是对的：它不是一块能「开着」的视图。留着会让读屏器
    //    永远念「未按下」，而 setDrawer 也绝不会去翻它（下面③钉住这一点）。
    expect(btn, "动作键不许报按下态（没有开/关这一档）").not.toContain("aria-pressed");
    expect(btn, "红线：图标只能从 codicons.ts 取，HTML 里不许内联 SVG").not.toMatch(/<svg/);
  });

  it("③ 装配只填字形 + 挂点击，且不进 registerDrawerView（不参与互斥展开）", () => {
    const setup = src.match(/function setupSettingsEntry\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(setup, "应有 setupSettingsEntry").toBeTruthy();
    expect(setup, "字形走 CODICONS.gear（VS Code 给设置用的那颗）").toContain(
      "sideSettings.innerHTML = CODICONS.gear",
    );
    expect(setup, "点击要真的驱动 openSettingsDialog（不是空挂一个函数）").toMatch(
      /sideSettings\.addEventListener\("click",\s*\(\)\s*=>\s*void openSettingsDialog\(\)\)/,
    );
    expect(setup, "它不是抽屉视图：这里不许出现 registerDrawerView").not.toMatch(
      /registerDrawerView/,
    );
    expect(icons, "codicons.ts 要有 gear 这一颗").toMatch(/gear:\s*"gear"/);
    const drawer = src.match(/function setDrawer\([\s\S]*?\n\}/)?.[0] ?? "";
    const apply = src.match(/function applyView\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(drawer + apply, "外壳的显隐收口不得伸手管这颗键（否则就成了第四块视图）").not.toContain(
      "sideSettings",
    );
  });

  it("④ bootstrap 里真的调用装配，且排在按钮列之后", () => {
    const iBar = src.indexOf("setupSideBar();");
    const iSettings = src.indexOf("setupSettingsEntry();");
    expect(iBar, "要装按钮列").toBeGreaterThan(-1);
    expect(iSettings, "bootstrap 必须调用 setupSettingsEntry").toBeGreaterThan(-1);
    expect(iSettings, "排在同列装配之后（同一批 DOM，装配次序照读法来）").toBeGreaterThan(iBar);
  });

  it("⑤ CSS：沉底靠 margin-top:auto，列的下留白与上留白对称", () => {
    const bottom = cssDecls(ruleBlock(css, ".side-btn-bottom"));
    expect(bottom, "flex 列里贴底只认 margin-top: auto（数上面有几颗都不管用）").toMatch(
      /margin-top:\s*auto/,
    );
    const bar = cssDecls(ruleBlock(css, ".side-bar"));
    const top = bar.match(/padding-top:\s*(\d+)px/)?.[1];
    const btm = bar.match(/padding-bottom:\s*(\d+)px/)?.[1];
    expect(top, "列要有上留白").toBeTruthy();
    expect(btm, "必须有下留白，否则齿轮贴死卡片底边、与顶上那颗不对称").toBe(top);
  });

  it("⑥ 反向验证：摘掉 margin-top:auto（齿轮排第四、不贴底）必须被咬住", () => {
    const BAD = css.replace(/(\.side-btn-bottom\s*\{[^}]*)margin-top:\s*auto;/, "$1");
    expect(BAD, "替身必须真的摘掉过这条声明").not.toBe(css);
    expect(() => {
      expect(cssDecls(ruleBlock(BAD, ".side-btn-bottom")), "替身不再贴底，必须被抓到").toMatch(
        /margin-top:\s*auto/,
      );
    }).toThrow();
  });

  it("⑦ 反向验证：把动作键写成视图键（补 aria-pressed）必须被咬住", () => {
    const BAD = html.replace(
      '<button\n              id="side-settings"',
      '<button\n              id="side-settings"\n              aria-pressed="false"',
    );
    expect(BAD, "替身必须真的加过 aria-pressed").not.toBe(html);
    expect(() => {
      const btn = BAD.match(/<button\s+id="side-settings"[\s\S]*?>/)?.[0] ?? "";
      expect(btn, "替身那条多余的按下态必须被抓到").not.toContain("aria-pressed");
    }).toThrow();
  });

  it("⑧ 反向验证：点击接线换成别的（齿轮变成死键那一类）必须被咬住", () => {
    const setup = src.match(/function setupSettingsEntry\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(setup, "先自证原句在").toContain("void openSettingsDialog()");
    const BAD = src.replace(
      'sideSettings.addEventListener("click", () => void openSettingsDialog());',
      'sideSettings.addEventListener("click", () => void 0);',
    );
    expect(BAD, "替身必须真的把动作换掉了").not.toBe(src);
    expect(() => {
      expect(
        BAD.match(/function setupSettingsEntry\(\)[\s\S]*?\n\}/)?.[0] ?? "",
        "替身的空转点击必须被抓到",
      ).toMatch(
        /sideSettings\.addEventListener\("click",\s*\(\)\s*=>\s*void openSettingsDialog\(\)\)/,
      );
    }).toThrow();
  });
});

describe("B207 `display` 压过 UA 的 `[hidden]`：凡写 display 又靠 hidden 收起的都得补一条", () => {
  // ⚠️ 两处都记在同一个表里：仓库里同类兜底已有 8 处（find-bar / find-row-replace /
  //    find-status / sync-btn / tooltip×3 / 这两条），它们是**同一个坑的多个实例** ——
  //    后来人给任何一个元素补 `display` 时都得顺手配一条，这里把「哪几个元素」列出来，
  //    免得每次都要重新踩一遍。
  const cases = [
    {
      sel: ".side-drawer",
      file: "preview.css",
      css: preview,
      why: "B307 起收起的是**外壳**：漏了这条就是「壳收了却还占着一片」，两块视图跟着一起糊在原地",
    },
    {
      sel: ".toc-panel",
      file: "preview.css",
      css: preview,
      why: "收起展开区（B207）：漏了就是「左栏折叠不起来」+「分割线区域空隙太大」",
    },
    {
      sel: ".diff-panel",
      file: "preview.css",
      css: preview,
      why: "B461 第五块「差异」同样是 display:flex + hidden 收起：漏了就是切走这一块它还占着一片",
    },
    {
      sel: ".settings-nav-item",
      file: "global.css",
      css,
      why: "设置对话框搜索过滤分类：漏了被过滤掉的分类按钮不会消失",
    },
  ];

  for (const c of cases) {
    it(`${c.sel}（${c.file}）写了 display ⇒ 必须有 ${c.sel}[hidden] { display: none }`, () => {
      // 前提：该元素本体确实写了 display —— 正是它压过 UA 的 [hidden]
      expect(cssDecls(ruleBlock(c.css, c.sel)), `${c.sel} 本体要有 display`).toMatch(/display:/);
      const esc = c.sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const hidden = c.css.match(new RegExp(`${esc}\\[hidden\\]\\s*\\{[^}]*\\}`))?.[0] ?? "";
      expect(hidden, `必须有 ${c.sel}[hidden] 兜底 —— ${c.why}`).toBeTruthy();
      expect(hidden, "兜底要真的 display: none").toMatch(/display:\s*none/);
      // ⚠️ 兜底**不靠书写顺序**：`.x[hidden]`(0-2-0) 权重本就高于 `.x`(0-1-0)，
      //    与位置无关。记下来，免得后来人以为要挪到本体之后。
    });

    it(`反向验证：摘掉 ${c.sel}[hidden] ⇒ 契约必须落空`, () => {
      const esc = c.sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`${esc}\\[hidden\\]\\s*\\{[^}]*\\}`);
      const BAD = c.css.replace(re, "");
      expect(BAD, "替身必须真的摘掉过兜底").not.toBe(c.css);
      expect(() => {
        expect(BAD.match(re)?.[0] ?? "", "替身摘掉后必须落空").toBeTruthy();
      }).toThrow();
    });
  }
});

// B363（用户：「边栏的按钮图标改到 20px，不要影响其他按钮」）：
// codicon 基座是 16px（官方 codicon.css 的 `font: 16px/1 codicon`），
// 只有按钮列这一族要放大 —— 必须挂在 `.side-btn .codicon` 上，不许去动基座或全站选择器。

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
const src = readFileSync("src/main.ts", "utf-8").replace(/\r\n/g, "\n");
const icons = readFileSync("src/shell/codicons.ts", "utf-8").replace(/\r\n/g, "\n");

/** 取某条规则里某条声明的原文（含属性名），取不到返回空串。 */
function declOf(cssText: string, selector: string, prop: string): string {
  const block = cssDecls(ruleBlock(cssText, selector));
  return block.match(new RegExp(`${prop}:\\s*[^;]*`))?.[0] ?? "";
}

describe("B201 左右两张卡片的面对面边让位：缝里平时不再有分割线", () => {
  it("对标 VS Code seam 口径：朝缝的那两条边各让一条边框（左卡让右、右卡让左）", () => {
    // VS Code floatingPanels.css：面对面的边 *gives up its border*，
    // 由中间那条 rail 只画一条 single hairline seam；compact 档干脆全透明。
    // LitePad 走「平时就是纯空隙」那一档 ⇒ 两边各让一条，缝里不常驻任何线。
    expect(
      declOf(css, ".side-shell", "border-right-color"),
      "左栏卡片（.side-shell）朝缝的右边框必须让位",
    ).toContain("transparent");
    expect(
      declOf(css, ".layout-area", "border-left-color"),
      "编辑区卡片（.layout-area）朝缝的左边框必须让位",
    ).toContain("transparent");
    // 卡片轮廓本身还在（上下/外缘那几边照旧 1px），别让位让没了
    expect(declOf(css, ".side-shell", "border")).toBe(declOf(css, ".layout-area", "border"));
    expect(declOf(css, ".side-shell", "border-radius")).toBe(
      declOf(css, ".layout-area", "border-radius"),
    );
  });

  it("缝里的发丝线平时 opacity: 0，只有 hover / 拖拽才亮（对齐 VS Code sash hover）", () => {
    const seam = preview.match(/\.toc-resizer::before\s*\{[^}]*\}/)?.[0] ?? "";
    expect(seam, "应有 .toc-resizer::before 这条 seam 规则").toBeTruthy();
    expect(seam, "平时必须看不见（不常驻分割线）").toMatch(/opacity:\s*0/);
    // 纯视觉反馈：不能借伪元素把 4px 的热区撑开（B196：命中区就是本体那 4px）
    expect(seam, "seam 不吃指针，别把它变成热区").toContain("pointer-events: none");
    const lit = preview.match(/\.toc-resizer:hover::before[\s\S]*?\{[^}]*\}/)?.[0] ?? "";
    expect(lit, "hover 时要亮").toBeTruthy();
    expect(lit, "hover 亮的是不透明").toMatch(/opacity:\s*1/);
    expect(preview, "拖拽中也要亮（body.layout-dragging 那条）").toMatch(
      /body\.layout-dragging\s+\.toc-resizer::before\s*\{[\s\S]*?opacity:\s*1/,
    );
  });

  it("反向验证：把左栏卡片的朝缝边框画回来（退回两条平行线）必须被咬住", () => {
    const BAD = css.replace(
      /(\.side-shell\s*\{[^}]*)border-right-color:\s*transparent;/,
      "$1border-right-color: var(--tab-bg-hover);",
    );
    expect(BAD, "替身必须真的改过边框色").not.toBe(css);
    expect(() => {
      expect(declOf(BAD, ".side-shell", "border-right-color"), "两边的让位必须成对").toContain(
        "transparent",
      );
    }).toThrow();
  });

  it("反向验证：发丝线改成常驻（平时 opacity: 1）必须被咬住", () => {
    const BAD = preview.replace(/(\.toc-resizer::before\s*\{[^}]*)opacity:\s*0;/, "$1opacity: 1;");
    expect(BAD, "替身必须真的改过 opacity").not.toBe(preview);
    expect(() => {
      expect(BAD.match(/\.toc-resizer::before\s*\{[^}]*\}/)?.[0], "常驻分割线必须被抓到").toMatch(
        /opacity:\s*0/,
      );
    }).toThrow();
  });
});

describe("B195 侧栏结构：按钮列 → 展开区 → 空隙 → 编辑区", () => {
  it("index.html 里四段的先后顺序与嵌套关系正确", () => {
    const at = (id: string) => html.indexOf(`id="${id}"`);
    const iShell = at("side-shell");
    const iBar = at("side-bar");
    const iOutline = at("side-outline");
    const iPanel = at("toc-panel");
    const iResizer = at("toc-resizer");
    const iArea = at("layout-area");
    for (const [name, i] of [
      ["side-shell", iShell],
      ["side-bar", iBar],
      ["side-outline", iOutline],
      ["toc-panel", iPanel],
      ["toc-resizer", iResizer],
      ["layout-area", iArea],
    ] as const) {
      expect(i, `index.html 必须有 #${name}`).toBeGreaterThan(-1);
    }
    // 按钮列在展开区**之前**（最左侧），展开区在空隙之前，空隙在编辑区之前
    expect(iBar, "按钮列必须在展开区之前").toBeLessThan(iPanel);
    expect(iOutline, "大纲键必须落在按钮列里").toBeGreaterThan(iBar);
    expect(iOutline, "大纲键必须落在按钮列里").toBeLessThan(iPanel);
    expect(iPanel, "空隙必须在展开区与编辑区之间").toBeLessThan(iResizer);
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

    const resizer = html.match(/<div\s+id="toc-resizer"[\s\S]*?>/)?.[0] ?? "";
    expect(resizer, "应能取到 #toc-resizer 开标签").toBeTruthy();
    // 空隙是两张卡片之间的**固定**间距：不再随大纲收起而消失（否则间距会跳变），
    // 收起只是把手隐身 + 不吃指针（preview.css 的 .toc-resizer.is-off）。
    expect(resizer, "空隙不再 hidden").not.toContain("hidden");
    expect(resizer, "首屏（大纲收起）分隔条就是 is-off").toContain("is-off");
  });
});

describe("B195 侧栏卡片样式", () => {
  it("侧栏是卡片，且边框/圆角与编辑区卡片**逐字同步**", () => {
    const shell = cssDecls(ruleBlock(css, ".side-shell"));
    expect(shell, "侧栏卡片要有 1px 边框（与编辑区卡片同色）").toContain(
      "border: 1px solid var(--tab-bg-hover)",
    );
    expect(shell, "侧栏卡片圆角 8px").toContain("border-radius: 8px");
    expect(shell, "圆角要能裁掉内部的按钮列与展开区").toContain("overflow: hidden");
    // 两张卡片同处一行，半径或线色差一点就看成两种东西 —— 同源自一处才不会漂移
    for (const prop of ["border", "border-radius"]) {
      expect(
        declOf(css, ".side-shell", prop),
        `侧栏卡片的 ${prop} 必须与 .layout-area 逐字一致`,
      ).toBe(declOf(css, ".layout-area", prop));
    }
  });

  it("按钮列定宽常驻；键不铺底，悬停/点亮只转亮字形（与标题栏图标键同款观感）", () => {
    const bar = cssDecls(ruleBlock(css, ".side-bar"));
    expect(bar, "按钮列定宽（不随展开区宽度变化）").toMatch(/flex:\s*0 0 \d+px/);
    // B199：按钮列**不再自己刷一档底色**（原先 --bg-toolbar，比展开区暗一档）。
    // 整张卡片是一块面，两区间不靠描边分界；要改底色只改 .side-shell 那一处。
    expect(bar, "按钮列不得自己铺底色（否则又变回浮起的浅色面板）").not.toMatch(/background/);

    const btn = cssDecls(ruleBlock(css, ".side-btn"));
    expect(btn, "常态不铺底").toContain("background: transparent");
    expect(btn, "常态字形取 muted").toContain("color: var(--fg-muted)");
    const hl = css.match(/\.side-btn:hover,\s*\.side-btn\.is-on\s*\{[^}]*\}/)?.[0] ?? "";
    expect(hl, "悬停/点亮共用一条规则（同款控件一条规则）").toBeTruthy();
    expect(hl, "悬停/点亮也不铺底").toContain("background: transparent");
    expect(hl, "悬停/点亮只转亮字形").toContain("color: var(--fg)");
  });

  it("反向验证：侧栏卡片圆角与编辑区不同步必须被咬住", () => {
    const BAD = css.replace(
      /(\.side-shell\s*\{[^}]*)border-radius:\s*8px;/,
      "$1border-radius: 4px;",
    );
    expect(BAD, "替身必须真的改过圆角").not.toBe(css);
    expect(() => {
      expect(declOf(BAD, ".side-shell", "border-radius"), "替身的不同步圆角必须被抓到").toBe(
        declOf(BAD, ".layout-area", "border-radius"),
      );
    }).toThrow();
  });

  it("反向验证：按钮键铺回底色（退回通用按钮观感）必须被咬住", () => {
    const BAD = css.replace(
      /(\.side-btn\s*\{[^}]*)background:\s*transparent;/,
      "$1background: var(--bg-hover);",
    );
    expect(BAD, "替身必须真的铺上底色").not.toBe(css);
    expect(() => {
      expect(cssDecls(ruleBlock(BAD, ".side-btn")), "替身的底色必须被抓到").toContain(
        "background: transparent",
      );
    }).toThrow();
  });
});

describe("B195 空隙与三点把手", () => {
  it("空隙占布局宽度，把手静息淡、悬停/拖拽转亮；收起时留空隙只收把手", () => {
    const resizer = cssDecls(ruleBlock(preview, ".toc-resizer"));
    // 宽度走 --card-gap（B196，对齐 VS Code 的 sash 尺寸）：这里**不比数值**，
    // 具体几像素由 :root 那一处定（另一条用例盯「同档 4px」）。
    expect(resizer, "空隙必须**占**布局宽度（不是零宽细线）").toMatch(/flex:\s*0 0 [^;]+/);
    expect(resizer, "仍是左右调整光标（B61：非 mac 档 ew-resize）").toContain("ew-resize");
    expect(resizer, "把手要在空隙里居中").toContain("align-items: center");

    const grip = preview.match(/\n\.toc-grip\s*\{[^}]*\}/)?.[0] ?? "";
    expect(grip, "三点把手静息取 --fg-muted").toMatch(/color:\s*var\(--fg-muted[,)]/);
    const off = cssDecls(ruleBlock(preview, ".toc-resizer.is-off"));
    expect(off, "收起时空隙不吃指针").toContain("pointer-events: none");
  });

  it("字形必须来自 codicons.ts（不许手绘 SVG / 写死码位），且三点那颗是竖排三点", () => {
    expect(icons, "大纲字形 = symbol-class（用户裁决，那对花括号）").toMatch(
      /outline:\s*"symbol-class"/,
    );
    expect(icons, "把手 = kebab-vertical（竖排三点）").toMatch(/grip:\s*"kebab-vertical"/);
    expect(src, "大纲键的字形走 CODICONS").toContain("CODICONS.outline");
    expect(src, "把手的字形走 CODICONS").toContain("CODICONS.grip");
    // 红线：icon 只能从 codicons.ts 取；这里顺带确认把手没被写成内联 SVG
    expect(html, "把手不许内联 SVG").not.toMatch(/toc-grip[\s\S]{0,200}<svg/);
  });

  it("反向验证：把手换成六点 gripper（不是三个点）必须被咬住", () => {
    const BAD = icons.replace('grip: "kebab-vertical"', 'grip: "gripper"');
    expect(BAD, "替身必须真的换过字形").not.toBe(icons);
    expect(() => {
      expect(BAD, "替身的非三点字形必须被抓到").toMatch(/grip:\s*"kebab-vertical"/);
    }).toThrow();
  });

  it("反向验证：大纲字形退回 list-tree（花括号被换掉）必须被咬住", () => {
    const BAD = icons.replace('outline: "symbol-class"', 'outline: "list-tree"');
    expect(BAD, "替身必须真的换过字形").not.toBe(icons);
    expect(() => {
      expect(BAD, "替身的树形字形必须被抓到").toMatch(/outline:\s*"symbol-class"/);
    }).toThrow();
  });
});

// ------------------------------------------------------- B196：卡片几何对齐 VS Code
// 用户点名：「左栏区和编辑区的拖拽区宽度，左栏以及编辑区和窗口边缘的宽度，也都参考 vscode
// 进行优化」。VS Code 源码里的口径（已逐条核实）：
//   · sash 本体 sash.css 的 --vscode-sash-size = 4px；
//   · 卡片之间 layoutService.ts 的 FLOATING_PANEL_MARGIN = 4（token spacing-size40）；
//   · 卡片到窗口边缘 floatingPanels.css 的 floating-card-outer-margin = 4（两种密度同档）。
// B195 那版拖拽区写成 10px、卡片贴窗口边缘 0px，正差在这一档上 ⇒ 收口成两个变量。
describe("B196 卡片几何：拖拽区 = 卡片缝隙，卡片到窗口边缘各留一档（都取 VS Code 的 4px）", () => {
  it("两档量只收在 :root 一处（改宽度动这两行就够）", () => {
    const root = cssDecls(ruleBlock(css, ":root"));
    expect(root, ":root 要有 --card-gap（卡片之间 = 拖拽区）").toMatch(/--card-gap:\s*\d+px/);
    expect(root, ":root 要有 --card-edge（卡片到窗口边缘）").toMatch(/--card-edge:\s*\d+px/);
    // 用户点名的就是**两个**宽度，其中「拖拽区 = 缝隙」在 VS Code 里本来就是同一个数
    const gap = root.match(/--card-gap:\s*(\d+)px/)?.[1];
    const edge = root.match(/--card-edge:\s*(\d+)px/)?.[1];
    expect(gap, "拖拽区宽度取 VS Code 的 4px 那一档").toBe("4");
    expect(edge, "外留白与拖拽区同档（VS Code 两种密度同值）").toBe(gap);
  });

  it("拖拽区**就是**卡片缝隙：宽度取 --card-gap，不写死像素", () => {
    const resizer = cssDecls(ruleBlock(preview, ".toc-resizer"));
    expect(resizer, "空隙必须仍占布局宽度（不能退回零宽细线）").toMatch(/flex:\s*0 0 [^;]+/);
    expect(resizer, "宽度必须取 --card-gap（与 :root 同源，不写死）").toMatch(
      /flex:\s*0 0 var\(--card-gap\)/,
    );
    // 用户裁决「缝 4px + 抓取正好 4px」：命中区就是元素本体，不许再向两侧溢出。
    // B195 那版靠 ::before 左右各撑 3px 把可抓范围做到 10px —— 比 VS Code 宽一倍。
    // ⚠️ B201：::before 又回来了（缝里那条 hover 才亮的发丝线），但**性质变了** ——
    //    它带 `pointer-events: none`，纯视觉反馈，命中区仍是本体那 4px。所以判据不再是
    //    「不许出现 ::before」（那会把 hover 反馈一起禁掉，B201 就做不出来了），
    //    而是「不许出现**带外溢定位**的 ::before」+「::before 必须不吃指针」。
    const seamRule = preview.match(/\.toc-resizer::before\s*\{[^}]*\}/)?.[0] ?? "";
    expect(seamRule, "seam 的 ::before 必须存在（B201 的 hover 反馈）").toBeTruthy();
    expect(seamRule, "seam 必须是纯视觉反馈：不吃指针（命中区仍是本体 4px）").toContain(
      "pointer-events: none",
    );
    expect(preview, "不得再出现外溢式抓取热区（左右各撑 3px 那版，比 VS Code 宽一倍）").not.toMatch(
      /\.toc-resizer::before\s*\{[^}]*(?:\s|;)\s*left:\s*-|right:\s*-/,
    );
  });

  it("卡片到窗口左右/下边缘留白走 --card-edge，且留白只在这一处源头", () => {
    const row = cssDecls(ruleBlock(css, "#main-row"));
    expect(row, "左栏/编辑区到窗口边缘要有留白").toMatch(
      /padding:\s*0 var\(--card-edge\) var\(--card-edge\)/,
    );
    // ⚠️ 顶部**故意**是 0：LitePad 有自定义标题栏，VS Code 也只在 .top-window-edge
    // （无标题栏 / 全屏）那一档才补顶留白 —— 这里照抄那个判据。
    expect(row, "顶部贴住标题栏（不给顶留白）").toMatch(/padding:\s*0\s+var\(--card-edge\)/);
    // 留白只放在 #main-row：两张卡片各写 margin 迟早漏一张，间距就会在开合时跳变
    for (const sel of [".side-shell", ".layout-area"]) {
      expect(cssDecls(ruleBlock(css, sel)), `${sel} 不得自己写 margin`).not.toMatch(/margin/);
    }
  });

  it("把手是 16px 的三点（B199 用户裁决调大），缝仍是 4px 不动", () => {
    const gripSize = preview.match(/\.toc-grip \.codicon\s*\{[^}]*\}/)?.[0] ?? "";
    expect(gripSize, "把手要够大才看得清「这儿能拖」").toMatch(/font-size:\s*16px/);
    // 竖排三点在整行高度里垂直居中（.toc-resizer 撑满卡片高度），16px 上下都够不着卡片边
    expect(
      cssDecls(ruleBlock(preview, ".toc-resizer")),
      "把手所在的缝仍撑满高度，点才能居中而不顶边",
    ).toContain("align-items: center");
  });

  it("反向验证①：拖拽区退回写死 10px（脱钩回旧观感）必须被咬住", () => {
    const BAD = preview.replace(
      /(\.toc-resizer\s*\{[^}]*)flex:\s*0 0 var\(--card-gap\)/,
      "$1flex: 0 0 10px",
    );
    expect(BAD, "替身必须真的换回写死宽度").not.toBe(preview);
    expect(() => {
      expect(cssDecls(ruleBlock(BAD, ".toc-resizer")), "替身的写死宽度必须被抓到").toMatch(
        /flex:\s*0 0 var\(--card-gap\)/,
      );
    }).toThrow();
  });

  it("反向验证②：卡片贴回窗口边缘（留白被摘掉）必须被咬住", () => {
    const BAD = css.replace(/padding:\s*0 var\(--card-edge\) var\(--card-edge\);/, "padding: 0;");
    expect(BAD, "替身必须真的摘掉留白").not.toBe(css);
    expect(() => {
      expect(cssDecls(ruleBlock(BAD, "#main-row")), "替身的无留白必须被抓到").toMatch(
        /padding:\s*0 var\(--card-edge\) var\(--card-edge\)/,
      );
    }).toThrow();
  });

  it("反向验证③：把手退回 12px（三点小到看不清可拖）必须被咬住", () => {
    const BAD = preview.replace(/font-size:\s*16px/, "font-size: 12px");
    expect(BAD, "替身必须真的缩小把手").not.toBe(preview);
    expect(() => {
      expect(
        BAD.match(/\.toc-grip \.codicon\s*\{[^}]*\}/)?.[0] ?? "",
        "替身的小把手必须被抓到",
      ).toMatch(/font-size:\s*16px/);
    }).toThrow();
  });

  it("反向验证④：抓取区又长回外溢的 10px 必须被咬住", () => {
    // 退化 = 把 B195 那个 ::before 命中区加回来（两侧各 3px）
    const BAD = preview.replace(
      /(\.toc-resizer\.is-off\s*\{)/,
      '.toc-resizer::before{\n  content: "";\n  position: absolute;\n  left: -3px;\n  right: -3px;\n}\n$1',
    );
    expect(BAD, "替身必须真的把命中区加回来").not.toBe(preview);
    expect(() => {
      expect(BAD, "替身的外溢命中区必须被抓到").not.toMatch(/\.toc-resizer::before/);
    }).toThrow();
  });
});

// ------------------------------------------------------- B199：卡片底色一致 + 三点把手调大
// 用户点名两件事：①「左边栏展开区（目前只有大纲列表）背景和其他区域一致，参考 vscode」；
// ②「拖拽区三个点调大」。
// ① 的口径（用户裁决）：整张左栏卡片（按钮列 + 展开区）与编辑区**同一颗变量**（--bg）。
//    VS Code 那边其实是 sideBar #252526 / editor #1E1E1E 亮一档（activityBar #333333 再亮
//    一档），但 LitePad 这里用户点名要「一致」⇒ 两块卡片只靠 1px 边框 + 圆角分界。
// ② 缝仍是 4px（B196/B197 的裁决不动），只把把手从 12px 调回 16px —— 竖排三点在整行
//    高度里垂直居中，上下都够不着卡片边，横向也只有约 2px，不影响手感。
describe("B199 卡片底色一致：左栏与编辑区同一颗变量，三点把手调回 16px", () => {
  it("① 整张左栏卡片与编辑区同底色（都是 --bg）", () => {
    const shell = cssDecls(ruleBlock(css, ".side-shell"));
    expect(shell, "侧栏卡片底色 = --bg（与编辑区同色）").toContain("background: var(--bg)");
    // 编辑区卡片（.layout-area）**没有自己的背景**，露的正是 body 的 --bg ——
    // 所以「同色」的可判据是：这两处取的是同一颗变量，不是「颜色看着差不多」。
    expect(
      cssDecls(ruleBlock(css, ".layout-area")),
      "编辑区卡片不许自带底色（自带了就又分出两块）",
    ).not.toMatch(/background/);
    expect(css, "body 的底就是 --bg（编辑区露的就是这一颗）").toMatch(
      /body \{[\s\S]{0,200}?background: var\(--bg\)/,
    );
  });

  it("② 展开区（大纲面板）+ 按钮列都不再刷第二档底色", () => {
    const panel = cssDecls(ruleBlock(preview, ".toc-panel"));
    expect(panel, "TOC 面板要透明（露出父卡片的 --bg）").toMatch(/background:\s*transparent/);
    expect(panel, "不许再刷 --bg-elevated —— 那正是「展开区浮起一块」的来源").not.toContain(
      "--bg-elevated",
    );
    const bar = cssDecls(ruleBlock(css, ".side-bar"));
    expect(bar, "按钮列也不许再刷 --bg-toolbar 那一档").not.toMatch(/--bg-/);
  });

  it("③ 反向验证①：卡片底色退回 --bg-elevated（又浮起一块）必须被咬住", () => {
    const start = css.indexOf(".side-shell {");
    expect(start, "要能定位 .side-shell").toBeGreaterThan(-1);
    const end = css.indexOf("}", start);
    const BAD =
      css.slice(0, start) +
      css.slice(start, end).replace("background: var(--bg);", "background: var(--bg-elevated);") +
      css.slice(end);
    expect(BAD, "替身必须真的刷回抬高一档").not.toBe(css);
    expect(() => {
      expect(cssDecls(ruleBlock(BAD, ".side-shell")), "替身的抬高一档底色必须被抓到").toContain(
        "background: var(--bg)",
      );
    }).toThrow();
  });

  it("④ 反向验证②：展开区把 --bg-elevated 加回来必须被咬住", () => {
    const start = preview.indexOf(".toc-panel {");
    expect(start, "要能定位 .toc-panel").toBeGreaterThan(-1);
    const end = preview.indexOf("}", start);
    const BAD =
      preview.slice(0, start) +
      preview
        .slice(start, end)
        .replace(/background:\s*transparent;/, "background: var(--bg-elevated, #fafafa);") +
      preview.slice(end);
    expect(BAD, "替身必须真的把抬高一档加回来").not.toBe(preview);
    expect(() => {
      expect(cssDecls(ruleBlock(BAD, ".toc-panel")), "替身的抬高一档必须被抓到").toMatch(
        /background:\s*transparent/,
      );
    }).toThrow();
  });

  it("⑤ 三点把手 16px（用户裁决调大），缝仍是 4px", () => {
    const gripSize = preview.match(/\.toc-grip \.codicon\s*\{[^}]*\}/)?.[0] ?? "";
    expect(gripSize, "把手要够大才看得清「这儿能拖」").toMatch(/font-size:\s*16px/);
    // 竖排三点在整行高度里垂直居中（.toc-resizer 撑满卡片高度），16px 上下都够不着卡片边
    expect(
      cssDecls(ruleBlock(preview, ".toc-resizer")),
      "把手所在的缝撑满高度，点才居中而不顶边",
    ).toContain("align-items: center");
    // 缝本身不动：用户裁决「点 16px，缝仍 4px」
    expect(
      cssDecls(ruleBlock(preview, ".toc-resizer")),
      "拖拽缝不许跟着加宽（B197 的 4px 裁决保留）",
    ).toMatch(/flex:\s*0 0 var\(--card-gap\)/);
  });
});

describe("B195 接线：按钮列点亮态与面板开合一处收口", () => {
  it("setupSideBar 装上字形与点击，且排在开合回放之前", () => {
    const setup = src.match(/function setupSideBar\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(setup, "应有 setupSideBar").toBeTruthy();
    expect(setup, "大纲键要填字形").toContain("sideOutline.innerHTML = CODICONS.outline");
    expect(setup, "把手要填字形").toContain("tocGrip.innerHTML = CODICONS.grip");
    expect(setup, "点击走 toggleToc（与命令、菜单同一入口）").toContain("toggleToc()");
    // 回放（setTocOpen）会写 is-on / aria-pressed，先装配再回放才不会装到空元素上
    const iCall = src.indexOf("setupSideBar();");
    const iReplay = src.indexOf("setTocOpen(settings?.toc_open ?? false, false)");
    expect(iCall, "bootstrap 必须调用 setupSideBar").toBeGreaterThan(-1);
    expect(iReplay, "bootstrap 必须回放开合").toBeGreaterThan(-1);
    expect(iCall, "先装按钮列、再回放开合").toBeLessThan(iReplay);
  });

  it("setTocOpen 一处写完：面板显隐 + 空隙 is-off + 键 is-on/aria-pressed", () => {
    const body = src.match(/function setTocOpen\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(body, "应有 setTocOpen").toBeTruthy();
    expect(body, "展开区显隐").toContain("tocPanel.hidden = !open;");
    expect(body, "空隙转 is-off（不 hidden：间距不跳变）").toContain(
      'tocResizer.classList.toggle("is-off", !open)',
    );
    expect(body, "键点亮").toContain('sideOutline.classList.toggle("is-on", open)');
    expect(body, "aria-pressed 与点亮态同源").toContain(
      'sideOutline.setAttribute("aria-pressed", String(open))',
    );
    // 按钮列本身**常驻**：这里不该出现把整列藏掉的代码
    expect(body, "按钮列不得跟着隐藏（收起也留一列）").not.toContain("side-bar");
  });

  it("反向验证：摘掉键的点亮态 → 契约必须落空", () => {
    const ORIG = '  sideOutline.classList.toggle("is-on", open);';
    expect(src, "退化串要先自证原句还在").toContain(ORIG);
    const BAD = src.replace(ORIG, "");
    expect(BAD, "退化后不再点亮").not.toContain('sideOutline.classList.toggle("is-on", open)');
    expect(() => {
      expect(
        BAD.match(/function setTocOpen\([\s\S]*?\n\}/)?.[0] ?? "",
        "退化后的缺失必须被抓到",
      ).toContain('sideOutline.classList.toggle("is-on", open)');
    }).toThrow();
  });
});

// ------------------------------------------------------- B198：标题栏整栏显隐双字形开关
// 用户点名：「标题栏上增加 layout-sidebar-left / layout-sidebar-left-off 按钮，参考 vscode，
// 但是 vscode 应该只对左边栏的展开区做了折叠，按钮还是会显示，本软件直接隐藏整个左边栏」。
// 于是这里分两层：`applySidebarVisible` 管「左栏在不在」（整张卡片 + 中间缝一起收），
// `setTocOpen` 管「卡片里的展开区开没开」—— 两层互不撤销，谁也不替对方清状态。
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
    // 与 setTocOpen 同一口径：只有 persist 为真且设置已就绪才落盘
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

  it("⑤ 与 setTocOpen 正交：整栏收着不动展开区，反之亦然", () => {
    const toc = src.match(/function setTocOpen\([\s\S]*?\n\}/)?.[0] ?? "";
    const bar = src.match(/function applySidebarVisible\([\s\S]*?\n\}/)?.[0] ?? "";
    // 整栏收放不许顺手改展开区（不然「收起左栏 = 大纲也关了」就是半同步）
    expect(bar, "整栏收放不得碰展开区显隐").not.toMatch(/tocPanel\.(hidden|style)/);
    expect(bar, "整栏收放不得碰展开区的开合字段（互不撤销）").not.toMatch(/toc_open/);
    // 反过来也不许：按钮列的点亮态仍归 setTocOpen 管
    expect(toc, "展开区开合不得顺手收放整栏").not.toMatch(/is-sidebar-off/);
    expect(toc, "整栏收起时展开区值照旧留着 ⇒ 这里不许出现 sidebar_off").not.toMatch(/sidebar_off/);
    // 双击/拖拽无关，但「整栏收着时点大纲」这条命令要先放栏 —— 否则是死键
    expect(src, "大纲命令在整栏收着时先把它放出来（display:none 里切展开区＝没反应）").toMatch(
      /function toggleToc\(\)[\s\S]{0,200}?if \(isSidebarOff\(\)\) applySidebarVisible\(false\);[\s\S]{0,120}?setTocOpen\(tocPanel\.hidden\)/,
    );
  });

  it("⑥ 整栏收起时卡片与缝**一起**消失（不是只折展开区）", () => {
    // 缝（#toc-resizer）那条在 preview.css，卡片（.side-shell）那条在 global.css ——
    // 同一件事的两个半，两处都得有，缺一个就留下一道悬空的空隙。
    expect(css, "侧栏卡片要跟着整栏收起").toMatch(
      /#main-row\.is-sidebar-off > \.side-shell\s*\{\s*display:\s*none;/,
    );
    expect(preview, "中间那道缝也要跟着收起（左栏没了，缝就是悬空间距）").toMatch(
      /#main-row\.is-sidebar-off > #toc-resizer\s*\{\s*display:\s*none;/,
    );
    // 与「只折展开区」那条分清：那一条是留缝的（间距不跳变），这里必须相反
    const offRule = preview.match(/\.toc-resizer\.is-off\s*\{[^}]*\}/)?.[0] ?? "";
    expect(offRule, "收起展开区仍留缝（只收把手 + 不吃指针）").toContain("pointer-events: none");
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
      /#main-row\.is-sidebar-off > #toc-resizer\s*\{[^}]*display:\s*none;/,
      "#main-row.is-sidebar-off > #toc-resizer { display: flex; }",
    );
    expect(BAD, "替身必须真的把缝留下").not.toBe(preview);
    expect(() => {
      expect(BAD, "替身的悬空缝必须被抓到").toMatch(
        /#main-row\.is-sidebar-off > #toc-resizer\s*\{\s*display:\s*none;/,
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

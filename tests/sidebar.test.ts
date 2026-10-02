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
    expect(bar, "按钮列底色比展开区暗一档（不靠描边分界）").toContain("var(--bg-toolbar)");

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
    expect(preview, "抓取区不得外溢（= 缝本身 4px，对齐 VS Code sash）").not.toMatch(
      /\.toc-resizer::before/,
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

  it("把手缩到装得进 4px 缝（VS Code 三点把手总高约 12px）", () => {
    const gripSize = preview.match(/\.toc-grip \.codicon\s*\{[^}]*\}/)?.[0] ?? "";
    expect(gripSize, "把手字号必须跟着缝收（原 16px 在 4px 缝里会顶出卡片）").toMatch(
      /font-size:\s*12px/,
    );
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

  it("反向验证③：把手退回 16px（又顶出卡片）必须被咬住", () => {
    const BAD = preview.replace(/font-size:\s*12px/, "font-size: 16px");
    expect(BAD, "替身必须真的放大把手").not.toBe(preview);
    expect(() => {
      expect(
        BAD.match(/\.toc-grip \.codicon\s*\{[^}]*\}/)?.[0] ?? "",
        "替身的放大把手必须被抓到",
      ).toMatch(/font-size:\s*12px/);
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

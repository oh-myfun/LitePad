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
    expect(resizer, "空隙必须**占**布局宽度（不是零宽细线）").toMatch(/flex:\s*0 0 \d+px/);
    expect(resizer, "仍是左右调整光标（B61：非 mac 档 ew-resize）").toContain("ew-resize");
    expect(resizer, "把手要在空隙里居中").toContain("align-items: center");

    const grip = preview.match(/\n\.toc-grip\s*\{[^}]*\}/)?.[0] ?? "";
    expect(grip, "三点把手静息取 --fg-muted").toMatch(/color:\s*var\(--fg-muted[,)]/);
    const off = cssDecls(ruleBlock(preview, ".toc-resizer.is-off"));
    expect(off, "收起时空隙不吃指针").toContain("pointer-events: none");
  });

  it("字形必须来自 codicons.ts（不许手绘 SVG / 写死码位），且三点那颗是竖排三点", () => {
    expect(icons, "大纲字形 = list-tree（VS Code 侧栏大纲同款）").toMatch(/outline:\s*"list-tree"/);
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

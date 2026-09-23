// @vitest-environment jsdom
// B58：应用级 tooltip 层（取代原生 title）。
//
// 分两层测：
//  1. `computeTipGeometry` 是**纯函数**，翻转/夹取/caret 定位是这块最容易写错的
//     部分，直接喂数字断言，不依赖任何排版能力；
//  2. DOM 行为（延迟、同组秒开、收起时机、aria-label 补名）用 jsdom + 假计时器，
//     几何量用桩函数补上（jsdom 的 rect 恒为 0）。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { cssDecls, themeBlock, topLevelFnBody } from "./static";
import {
  computeTipGeometry,
  initTooltips,
  setTip,
  clearTip,
  isTipVisible,
  resetTooltipsForTest,
} from "../src/shell/tooltip";

const VIEWPORT = { width: 1000, height: 600 };

describe("computeTipGeometry（纯函数定位）", () => {
  const tip = { width: 120, height: 27 };
  const rect = (left: number, top: number, w = 40, h = 24) => ({
    left,
    right: left + w,
    top,
    bottom: top + h,
  });

  it("默认放在目标下方，水平对齐目标中心", () => {
    const g = computeTipGeometry(rect(480, 40), tip, VIEWPORT, "bottom");
    expect(g.placement).toBe("bottom");
    expect(g.y, "目标底边 + 4px 间隙").toBe(68);
    expect(g.x, "以目标中心 500 对齐 → 500 - 60").toBe(440);
  });

  it("下方放不下时向上翻转", () => {
    const g = computeTipGeometry(rect(480, 556), tip, VIEWPORT, "bottom");
    expect(g.placement).toBe("top");
    expect(g.y, "目标顶边 - 4px 间隙 - 提示框高").toBe(525);
  });

  it("上方放不下时向下翻转（首选 top 也一样）", () => {
    const g = computeTipGeometry(rect(480, 0), tip, VIEWPORT, "top");
    expect(g.placement).toBe("bottom");
    expect(g.y).toBe(28);
  });

  it("水平方向被夹进视口（左右各留 2px）", () => {
    const right = computeTipGeometry(rect(980, 40), tip, VIEWPORT, "bottom");
    expect(right.x, "1000 - 120 - 2").toBe(878);
    const left = computeTipGeometry(rect(-60, 40), tip, VIEWPORT, "bottom");
    expect(left.x).toBe(2);
  });

  it("caret 默认居中于提示框", () => {
    const g = computeTipGeometry(rect(480, 40), tip, VIEWPORT, "bottom");
    // 60 - 3 = 57；中心 440 + 57 + 3 = 500，落在目标 [480, 520] 内 → 不改
    expect(g.caretLeft).toBe(57);
  });

  it("提示框被夹到边缘时就改为对准目标中心（VS Code 的规则）", () => {
    const g = computeTipGeometry(rect(980, 40), tip, VIEWPORT, "bottom");
    // 居中方案的中心是 878 + 60 = 938 < 目标左边 980 → 改用目标中心 1000
    // caretLeft = 1000 - 878 - 3 = 119，再被夹进框内上限 120 - 7 - 3 = 110
    expect(g.caretLeft).toBeLessThanOrEqual(110);
    expect(g.caretLeft).toBeGreaterThanOrEqual(-3);
  });

  it("caret 永远留在提示框内（不管目标多极端）", () => {
    for (const left of [-500, -60, 0, 480, 980, 1200]) {
      for (const preferred of ["top", "bottom"] as const) {
        const g = computeTipGeometry(rect(left, 40), tip, VIEWPORT, preferred);
        const min = 7 - 3;
        const max = tip.width - 7 - 3;
        expect(g.caretLeft, `left=${left} ${preferred}`).toBeGreaterThanOrEqual(min);
        expect(g.caretLeft, `left=${left} ${preferred}`).toBeLessThanOrEqual(max);
      }
    }
  });
});

describe("tooltip 层行为（jsdom）", () => {
  const TARGET = { left: 480, top: 40, width: 40, height: 24 };
  const stubRect = (): DOMRect =>
    ({
      left: TARGET.left,
      top: TARGET.top,
      right: TARGET.left + TARGET.width,
      bottom: TARGET.top + TARGET.height,
      width: TARGET.width,
      height: TARGET.height,
      x: TARGET.left,
      y: TARGET.top,
      toJSON: () => ({}),
    }) as DOMRect;

  const origRect = HTMLElement.prototype.getBoundingClientRect;
  const origW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  const origH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");

  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: stubRect,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("tooltip") ? 120 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("tooltip") ? 27 : 0;
      },
    });
    initTooltips(document);
  });

  afterAll(() => {
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: origRect,
    });
    if (origW) Object.defineProperty(HTMLElement.prototype, "offsetWidth", origW);
    if (origH) Object.defineProperty(HTMLElement.prototype, "offsetHeight", origH);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    resetTooltipsForTest();
    document.body.innerHTML = "";
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function mkTip(text: string, group: string, key?: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = text;
    setTip(b, text, { key, group });
    document.body.appendChild(b);
    return b;
  }

  const hover = (el: Element, to: Element | null = null): void => {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: to }));
  };
  const leave = (el: Element, to: Element | null = null): void => {
    el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: to }));
  };
  const tipEl = (): HTMLElement => {
    const el = document.querySelector<HTMLElement>(".tooltip");
    expect(el, "提示层应已创建").toBeTruthy();
    return el!;
  };

  it("悬停 500ms 后才出现（VS Code workbench.hover.delay 的 Windows 默认值）", () => {
    const b = mkTip("新建", "toolbar", "Ctrl+N");
    hover(b);
    vi.advanceTimersByTime(499);
    expect(isTipVisible(), "500ms 前不该出现").toBe(false);
    vi.advanceTimersByTime(2);
    expect(isTipVisible()).toBe(true);
    expect(tipEl().querySelector(".tooltip-text")!.textContent).toBe("新建");
  });

  it("快捷键渲染成键帽（Ctrl+N → 两个键帽 + 一个 + 分隔符）", () => {
    const b = mkTip("另存为", "toolbar", "Ctrl+Shift+S");
    hover(b);
    vi.advanceTimersByTime(600);
    const t = tipEl();
    expect([...t.querySelectorAll(".tooltip-kbd")].map((k) => k.textContent)).toEqual([
      "Ctrl",
      "Shift",
      "S",
    ]);
    expect(t.querySelectorAll(".tooltip-key-sep").length).toBe(2);
    expect(t.querySelector<HTMLElement>(".tooltip-key")!.hidden, "有键位就不该隐藏").toBe(false);
  });

  it("没有快捷键 / 没有详情行时，对应节点隐藏（不留空白）", () => {
    const b = mkTip("大纲 TOC", "toolbar");
    hover(b);
    vi.advanceTimersByTime(600);
    const t = tipEl();
    expect(t.querySelector<HTMLElement>(".tooltip-key")!.hidden).toBe(true);
    expect(t.querySelector<HTMLElement>(".tooltip-detail")!.hidden).toBe(true);
  });

  it("详情行渲染路径小字", () => {
    const b = document.createElement("button");
    b.textContent = "a.md";
    setTip(b, "a.md", { detail: "E:\\demo\\a.md", group: "tabstrip" });
    document.body.appendChild(b);
    hover(b);
    vi.advanceTimersByTime(600);
    const d = tipEl().querySelector<HTMLElement>(".tooltip-detail")!;
    expect(d.hidden).toBe(false);
    expect(d.textContent).toBe("E:\\demo\\a.md");
  });

  it("同组内切换目标秒开、且不放淡入动画", () => {
    const a = mkTip("新建", "toolbar");
    const c = mkTip("打开", "toolbar");
    hover(a);
    vi.advanceTimersByTime(600);
    expect(isTipVisible()).toBe(true);
    leave(a, c);
    hover(c, a);
    expect(isTipVisible(), "同组内应立即可见（不等 500ms）").toBe(true);
    expect(tipEl().classList.contains("fade-in"), "秒开不播淡入").toBe(false);
    expect(tipEl().querySelector(".tooltip-text")!.textContent).toBe("打开");
  });

  it("首次显示会播淡入动画", () => {
    const a = mkTip("新建", "toolbar");
    hover(a);
    vi.advanceTimersByTime(600);
    expect(tipEl().classList.contains("fade-in")).toBe(true);
  });

  it("不同组之间不秒开", () => {
    const a = mkTip("新建", "toolbar");
    const c = mkTip("第 3 行", "toc");
    hover(a);
    vi.advanceTimersByTime(600);
    leave(a, c);
    hover(c, a);
    expect(tipEl().querySelector(".tooltip-text")!.textContent, "仍是旧提示").toBe("新建");
  });

  it("离开目标后延迟收起（给同组切换留窗口）", () => {
    const a = mkTip("新建", "toolbar");
    hover(a);
    vi.advanceTimersByTime(600);
    leave(a);
    vi.advanceTimersByTime(219);
    expect(isTipVisible(), "宽限期内先留着").toBe(true);
    vi.advanceTimersByTime(2);
    expect(isTipVisible()).toBe(false);
  });

  it("在目标内部移动（图标 svg ↔ 按钮）不算离开", () => {
    const a = mkTip("新建", "toolbar");
    hover(a);
    vi.advanceTimersByTime(600);
    leave(a, a);
    vi.advanceTimersByTime(600);
    expect(isTipVisible()).toBe(true);
  });

  it("滚轮滚动 / 按下鼠标 / Esc 一律立刻收起", () => {
    const a = mkTip("新建", "toolbar");
    hover(a);
    vi.advanceTimersByTime(600);
    window.dispatchEvent(new Event("scroll"));
    expect(isTipVisible(), "滚动后应收起").toBe(false);

    hover(a);
    vi.advanceTimersByTime(600);
    a.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(isTipVisible(), "按下鼠标后应收起").toBe(false);

    hover(a);
    vi.advanceTimersByTime(600);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(isTipVisible(), "Esc 后应收起").toBe(false);
  });

  it("setTip 只给「没有文本」的元素补 aria-label（原生 title 原本兼任可访问名）", () => {
    const icon = document.createElement("button");
    document.body.appendChild(icon);
    setTip(icon, "保存", { key: "Ctrl+S" });
    expect(icon.getAttribute("aria-label")).toBe("保存 (Ctrl+S)");

    const dirty = document.createElement("button");
    dirty.textContent = "保存";
    document.body.appendChild(dirty);
    setTip(dirty, "保存", { key: "Ctrl+S" });
    expect(dirty.hasAttribute("aria-label"), "有可见文本就不该乱加").toBe(false);

    const explicit = document.createElement("button");
    explicit.setAttribute("aria-label", "我自己写的名字");
    document.body.appendChild(explicit);
    setTip(explicit, "保存");
    expect(explicit.getAttribute("aria-label"), "不得覆盖显式名字").toBe("我自己写的名字");
  });

  it("clearTip 之后不再弹提示（状态栏语言按钮切回纯文本名的场景）", () => {
    const b = mkTip("切换到源码", "statusbar", "Ctrl+/");
    clearTip(b);
    expect(b.dataset.tip).toBeUndefined();
    hover(b);
    vi.advanceTimersByTime(600);
    expect(isTipVisible()).toBe(false);
  });

  it("延迟期间目标被移除就不再显示（标签栏整块重绘的场景）", () => {
    const b = mkTip("关闭", "tabstrip");
    hover(b);
    b.remove(); // 还没到 500ms，标签栏已经重绘
    vi.advanceTimersByTime(600);
    expect(isTipVisible()).toBe(false);
  });

  // ---- B70 A 档：菜单开着就不弹提示 ----
  // 提示层 z-index（2000）刻意高于菜单（1000），所以「菜单开着时划过别处」会把提示
  // 浮到菜单之上、正对着下拉展开的位置。VS Code 干脆不给菜单栏/菜单项注册悬停提示。
  const mkMenu = (): HTMLElement => {
    const m = document.createElement("div");
    m.className = "popup-menu";
    document.body.appendChild(m);
    return m;
  };

  it("菜单开着时不弹新提示（划过工具栏也不弹）", () => {
    mkMenu();
    const b = mkTip("新建", "toolbar", "Ctrl+N");
    hover(b);
    vi.advanceTimersByTime(600);
    expect(isTipVisible(), "菜单开着不该弹提示").toBe(false);
  });

  it("菜单关掉后提示恢复正常", () => {
    const menu = mkMenu();
    const b = mkTip("新建", "toolbar", "Ctrl+N");
    hover(b);
    vi.advanceTimersByTime(600);
    expect(isTipVisible()).toBe(false);
    menu.remove(); // 菜单关了
    leave(b);
    vi.advanceTimersByTime(300);
    hover(b);
    vi.advanceTimersByTime(600);
    expect(isTipVisible(), "菜单关掉后应恢复").toBe(true);
  });

  it("打开菜单会把已经显示出来的提示收掉（menu.ts 调 hideTip）", async () => {
    // 这条走真实接线：showPopupMenu 一开就先 hideTip，否则提示会盖在刚展开的菜单上。
    const { showPopupMenu, closePopupMenu } = await import("../src/shell/menu");
    const b = mkTip("新建", "toolbar", "Ctrl+N");
    hover(b);
    vi.advanceTimersByTime(600);
    expect(isTipVisible(), "先得有提示显示着").toBe(true);

    showPopupMenu(b, [{ label: "示例项" }]);
    expect(isTipVisible(), "菜单一开就该把提示收掉").toBe(false);
    expect(document.querySelector(".popup-menu"), "菜单本身要开出来").toBeTruthy();
    closePopupMenu();
    expect(document.querySelector(".popup-menu")).toBeNull();
  });
});

describe("A 档：菜单开着就绝不弹提示", () => {
  const tooltipSrc = readFileSync("src/shell/tooltip.ts", "utf-8");
  const menuSrc = readFileSync("src/shell/menu.ts", "utf-8");
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
    // B97：顶栏那排快捷按钮已整体移除，现在带 data-tip 的是标题栏右侧的窗口控制键。
    expect(html, "窗口控制键必须用 data-tip").toContain('data-tip="最小化"');
    expect(html, "不得再用原生 title 给图标按钮做提示").not.toMatch(/class="win-btn"[^>]*\stitle=/);
    expect(html, "顶栏不得再有快捷按钮组").not.toContain("toolbar-actions");
    expect(html, "菜单栏必须继续标 data-tip-group（同组秒开）").toContain(
      'data-tip-group="menubar"',
    );
    expect(html, "窗口控制键自成一组").toContain('data-tip-group="window"');
  });
});

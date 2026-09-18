// @vitest-environment jsdom
// B58：应用级 tooltip 层（取代原生 title）。
//
// 分两层测：
//  1. `computeTipGeometry` 是**纯函数**，翻转/夹取/caret 定位是这块最容易写错的
//     部分，直接喂数字断言，不依赖任何排版能力；
//  2. DOM 行为（延迟、同组秒开、收起时机、aria-label 补名）用 jsdom + 假计时器，
//     几何量用桩函数补上（jsdom 的 rect 恒为 0）。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
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

// @vitest-environment jsdom
// 大纲宽度调节：分隔条拖拽 / 边界收敛 / 双击复位 / 设置回写。
// 用户要求「大纲区域也要支持宽度调节」——本文件覆盖拖拽编排的全部行为，
// regressions.test.ts 另补静态接线断言（index.html 元素、CSS 光标、设置字段）。
import { describe, it, expect } from "vitest";
import { ruleBlock } from "./static";
import { readFileSync } from "node:fs";
import {
  attachSideResizer,
  clampSideWidth,
  SIDE_DEFAULT_WIDTH,
  SIDE_MAX_WIDTH,
  SIDE_MIN_WIDTH,
  SIDE_OVERDRAG_PX,
} from "../src/markdown/toc";

function mount(initial = SIDE_DEFAULT_WIDTH) {
  const panel = document.createElement("aside");
  const resizer = document.createElement("div");
  document.body.append(panel, resizer);
  const changes: number[] = [];
  const handle = attachSideResizer(resizer, panel, {
    initial,
    onChange: (w) => changes.push(w),
  });
  return { panel, resizer, handle, changes };
}

function mouse(el: EventTarget, type: string, clientX: number): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, button: 0 }));
}

/** 一次完整拖拽：按下 → 移动 → 松手。 */
function drag(resizer: EventTarget, from: number, to: number): void {
  mouse(resizer, "mousedown", from);
  mouse(document, "mousemove", to);
  mouse(document, "mouseup", to);
}

describe("clampSideWidth 边界收敛", () => {
  it("非法值回落默认，超界值收敛到 [SIDE_MIN_WIDTH, SIDE_MAX_WIDTH]", () => {
    expect(clampSideWidth(Number.NaN)).toBe(SIDE_DEFAULT_WIDTH);
    expect(clampSideWidth(Number.POSITIVE_INFINITY)).toBe(SIDE_DEFAULT_WIDTH);
    expect(clampSideWidth(10)).toBe(SIDE_MIN_WIDTH);
    expect(clampSideWidth(9999)).toBe(SIDE_MAX_WIDTH);
    expect(clampSideWidth(237.6)).toBe(238);
    expect(clampSideWidth(SIDE_DEFAULT_WIDTH)).toBe(SIDE_DEFAULT_WIDTH);
  });
});

describe("大纲分隔条拖拽", () => {
  it("初始宽度写入面板 inline 样式（width 与 min-width 同时写，防止被 flex 挤压）", () => {
    const { panel } = mount(300);
    expect(panel.style.width).toBe("300px");
    expect(panel.style.minWidth).toBe("300px");
  });

  it("向右拖 100px 变宽 100px，向左拖相应变窄", () => {
    const { panel, resizer, changes } = mount();
    drag(resizer, 200, 300);
    expect(panel.style.width).toBe("340px");
    expect(changes).toEqual([340]);

    drag(resizer, 300, 250);
    expect(panel.style.width).toBe("290px");
    expect(changes).toEqual([340, 290]);
  });

  it("拖拽越界被收敛，松手后回写的是收敛后的值", () => {
    const { panel, resizer, changes } = mount();
    drag(resizer, 240, -2000);
    expect(panel.style.width).toBe(`${SIDE_MIN_WIDTH}px`);
    drag(resizer, SIDE_MIN_WIDTH, 5000);
    expect(panel.style.width).toBe(`${SIDE_MAX_WIDTH}px`);
    expect(changes).toEqual([SIDE_MIN_WIDTH, SIDE_MAX_WIDTH]);
  });

  it("拖拽中为 body 加 layout-dragging 光标类，松手移除", () => {
    const { resizer } = mount();
    mouse(resizer, "mousedown", 240);
    mouse(document, "mousemove", 300);
    expect(document.body.classList.contains("layout-dragging")).toBe(true);
    mouse(document, "mouseup", 300);
    expect(document.body.classList.contains("layout-dragging")).toBe(false);
  });

  it("B217：点亮只挂这条自己，松手必须摘掉（拖别的分割条时它不该跟着亮）", () => {
    const { resizer } = mount();
    expect(resizer.classList.contains("resizing"), "静息时这条缝不带高亮类").toBe(false);
    mouse(resizer, "mousedown", 240);
    mouse(document, "mousemove", 300);
    expect(resizer.classList.contains("resizing"), "按下后这条自己亮起来").toBe(true);
    mouse(document, "mouseup", 300);
    expect(resizer.classList.contains("resizing"), "松手要摘掉，别留着残影").toBe(false);
  });

  it("松手后再移动鼠标不再改变宽度（监听已解绑）", () => {
    const { panel, resizer } = mount();
    drag(resizer, 200, 300);
    expect(panel.style.width).toBe("340px");
    mouse(document, "mousemove", 800);
    expect(panel.style.width).toBe("340px");
  });

  it("双击分隔条恢复默认宽度并回写", () => {
    const { panel, resizer, changes, handle } = mount();
    drag(resizer, 240, 480);
    expect(panel.style.width).toBe("480px");
    resizer.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(panel.style.width).toBe(`${SIDE_DEFAULT_WIDTH}px`);
    expect(handle.getWidth()).toBe(SIDE_DEFAULT_WIDTH);
    expect(changes[changes.length - 1]).toBe(SIDE_DEFAULT_WIDTH);
  });

  it("setWidth 供设置对话框回写，同样收敛到合法区间", () => {
    const { panel, handle } = mount();
    handle.setWidth(9999);
    expect(panel.style.width).toBe(`${SIDE_MAX_WIDTH}px`);
    expect(handle.getWidth()).toBe(SIDE_MAX_WIDTH);
    handle.setWidth(20);
    expect(handle.getWidth()).toBe(SIDE_MIN_WIDTH);
  });

  it("非左键按下不启动拖拽（避免右键菜单误触）", () => {
    const { panel, resizer } = mount();
    resizer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 240, button: 2 }));
    mouse(document, "mousemove", 400);
    mouse(document, "mouseup", 400);
    expect(panel.style.width).toBe(`${SIDE_DEFAULT_WIDTH}px`);
  });
});

// ------------------------------------------------------- B207：拖到底再往左拖 = 收起展开区
// 用户原话：「分割线向左拖拽到最小后再往左拖拽可隐藏左侧栏展开区，且左侧栏展开区隐藏后
// 仍然能看到和操作分割线，并将隐藏的左栏展开区展开」。
// 这里覆盖**逻辑**那一半（什么时候该报「收了 / 放了」）；「收起后缝还看得见、还抓得住」
// 是 CSS 那一半，锁在 tests/sidebar.test.ts 与 tests/splitview.test.ts。
describe("B207 拖到最小再往左拖：收起 / 拉回展开区", () => {
  /**
   * 装一份「展开区开合受我们控制」的挂载：
   * `isOpen` 读自己的开关（不问 DOM），`onOpenChange` 只记账 —— 这样「收了 / 放了报
   * 几次、什么时候报」是这条用例真正要看的东西，不掺 DOM 状态。
   */
  function mountOpen(initial = SIDE_DEFAULT_WIDTH, open = false) {
    const panel = document.createElement("aside");
    const resizer = document.createElement("div");
    document.body.append(panel, resizer);
    // 首屏默认收着（与 index.html 上那条 is-off 同态）；要测「展开态那一半」显式传 true
    const changes: number[] = [];
    const opened: boolean[] = [];
    const handle = attachSideResizer(resizer, panel, {
      initial,
      isOpen: () => open,
      onOpenChange: (o) => {
        open = o;
        opened.push(o);
      },
      onChange: (w) => changes.push(w),
    });
    return { panel, resizer, handle, changes, opened, isOpen: () => open };
  }

  it("刚按下时是收起态（isOpen 报的是调用方那份状态，不是自己缓存的）", () => {
    const { handle, isOpen, opened } = mountOpen();
    expect(handle.isOpen(), "收起态要如实报 false").toBe(false);
    expect(isOpen(), "开合判据问的是同一份开关").toBe(false);
    expect(opened, "没拖过就不该报开合变化").toEqual([]);
  });

  it("收起态往左拖：不动、也不报（已经在收起的那一侧）", () => {
    const { panel, resizer, opened, changes } = mountOpen();
    drag(resizer, 200, 120);
    expect(opened, "往左拖不展开").toEqual([]);
    expect(panel.style.width, "宽度原样留着").toBe(`${SIDE_DEFAULT_WIDTH}px`);
    expect(changes, "松手照旧回写当前宽度").toEqual([SIDE_DEFAULT_WIDTH]);
  });

  it("B212：收起与展开共用**最小宽度的一半**这一个阈值（收起线 = 展开线）", () => {
    expect(SIDE_OVERDRAG_PX, "阈值必须是最小宽度的一半").toBe(SIDE_MIN_WIDTH / 2);
    const toc = readFileSync("src/markdown/toc.ts", "utf-8");
    // 两处判据（收起 / 展开）都得读同一个常量：合成一档以后不许再各写各的数字
    const uses = [...toc.matchAll(/SIDE_OVERDRAG_PX/g)];
    expect(uses.length, "收起与展开两处判据都要用这个常量").toBeGreaterThanOrEqual(3);
    expect(toc, "不许再留收起/展开两个分档常量").not.toContain("TOC_HIDE_OVERDRAG_PX");
    expect(toc, "不许再留收起/展开两个分档常量").not.toContain("TOC_RESTORE_OVERDRAG_PX");
  });

  // ⚠️ 这条**故意不引用 `SIDE_OVERDRAG_PX`**：那是个导出的常量，拿它当位移去拖，
  //    常量一改用例跟着改 —— 退化时照样绿（自己写出来的假绿，B212 首轮真退化就是这么漏的）。
  //    展开线按需求写成「最小宽度的一半」这个**表达式**，退化回「长到最小宽才放」必红。
  it("B213：收起态往右拖**过一半**就放开，先落到最小宽，再拖多少宽多少", () => {
    const { panel, resizer, opened, changes } = mountOpen(SIDE_MIN_WIDTH);
    // ⚠️ 一个手势内连走：正好一半 → 过一半 → 撑到最小宽 → 再拖 40。中间松手就换了锚。
    mouse(resizer, "mousedown", 200);
    mouse(document, "mousemove", 200 + SIDE_MIN_WIDTH / 2); // 正好一半：还在收起那一侧
    expect(opened, "贴着阈值还不放").toEqual([]);
    mouse(document, "mousemove", 200 + SIDE_MIN_WIDTH / 2 + 1); // 过一半就得放
    expect(opened, "过一半必须把展开区放回来").toEqual([true]);
    expect(panel.style.width, "放出来先落在最小宽，不是弹回上次那个 240").toBe(
      `${SIDE_MIN_WIDTH}px`,
    );
    // 「先变最小宽、继续拖拽才再变宽」（B212 口径）：这一段累计位移还没够最小宽，
    // 宽度被 clamp 钉在最小宽上 —— 缝得先把面板撑起来，才谈得上贴住鼠标。
    mouse(document, "mousemove", 200 + SIDE_MIN_WIDTH - 1);
    expect(panel.style.width, "还没撑到最小宽 ⇒ 仍钉在最小宽").toBe(`${SIDE_MIN_WIDTH}px`);
    mouse(document, "mousemove", 200 + SIDE_MIN_WIDTH + 40);
    expect(panel.style.width, "过了最小宽跟手：拖 40 就宽 40").toBe(`${SIDE_MIN_WIDTH + 40}px`);
    mouse(document, "mouseup", 200 + SIDE_MIN_WIDTH + 40);
    expect(changes[changes.length - 1], "松手回写摊开后的宽度").toBe(SIDE_MIN_WIDTH + 40);
  });

  it("B213：展开之后宽度**不扣第二条阈值**（旧算法 MIN+(dx-80) 让缝永久站在鼠标右边）", () => {
    const { panel, resizer, opened } = mountOpen(SIDE_MIN_WIDTH);
    mouse(resizer, "mousedown", 200); // 收起态按下 → 锚 = 0
    const dragged = 240; // ⚠️ 位移写成绝对值，不引用阈值常量
    mouse(document, "mousemove", 200 + dragged);
    expect(opened, "过一半就放").toEqual([true]);
    // 判据 = 累计位移本身。旧算法在这里给 160 + (240 - 80) = 320 ⇒ 缝跑到鼠标右边 80px。
    expect(parseInt(panel.style.width, 10), "宽度就是累计位移，一条阈值都不该再扣").toBe(dragged);
    mouse(document, "mouseup", 200 + dragged);
  });

  it("B209：收起态往右拖**没过阈值**不展开（旧行为 dx>0 就弹，太容易误触）", () => {
    const { panel, resizer, opened } = mountOpen(SIDE_MIN_WIDTH);
    // 阈值**差一像素**：用「最小宽度的一半」算，退化成任何更小的数都会越过 ⇒ 必红
    drag(resizer, 200, 200 + SIDE_MIN_WIDTH / 2 - 1);
    expect(opened, "差一像素也不该展开").toEqual([]);
    expect(panel.style.width, "面板宽度不动").toBe(`${SIDE_MIN_WIDTH}px`);
  });

  it("收起态按下先往左（无反应）再往右（展开），左拖不会被当成收起", () => {
    const { panel, resizer, opened, changes } = mountOpen(SIDE_MIN_WIDTH);
    mouse(resizer, "mousedown", 200);
    mouse(document, "mousemove", 160); // 往左：收起态那一边不动（缝钉在按钮列右缘）
    mouse(document, "mousemove", 360); // 往右：累计 160 ⇒ 过了「一半」那条线 ⇒ 放开
    mouse(document, "mouseup", 360);
    expect(opened, "只有往右那一下算展开").toEqual([true]);
    expect(panel.style.width, "宽度按累计位移算").toBe(`${SIDE_MIN_WIDTH}px`);
    expect(changes[changes.length - 1], "回写摊开后的宽度").toBe(SIDE_MIN_WIDTH);
  });

  it("展开态拖到最小：还没过阈值**就不收**（「就想拖窄一点」不能被误判成收起）", () => {
    const { resizer, opened } = mountOpen(SIDE_DEFAULT_WIDTH, true);
    // 起点 400、宽 240 ⇒ 往左 80px（x → 320）正好贴到最小线，还没过阈值
    drag(resizer, 400, 400 - (SIDE_DEFAULT_WIDTH - SIDE_MIN_WIDTH));
    expect(opened, "贴到最小不算收起").toEqual([]);
  });

  it("展开态拖到最小后**继续**往左拖过阈值：收起展开区", () => {
    const { panel, resizer, opened } = mountOpen(SIDE_DEFAULT_WIDTH, true);
    // 判据是 startWidth + dx <= 最小线 - SIDE_OVERDRAG_PX（不累加位移），越过它 8px：
    // 240 + dx = 160 - 80 - 8 ⇒ dx = -188 ⇒ x = 212
    drag(resizer, 400, 400 - (SIDE_DEFAULT_WIDTH - SIDE_MIN_WIDTH) - SIDE_OVERDRAG_PX - 8);
    expect(opened, "过阈值必须报一次收起").toEqual([false]);
    expect(panel.style.width, "收起后宽度仍留在最小值（拖回来接着用）").toBe(`${SIDE_MIN_WIDTH}px`);
  });

  it("B213：按住拖到收起、**不松手**再往右拖 —— 同一个手势里还能重新展开", () => {
    const { panel, resizer, opened, handle } = mountOpen(SIDE_DEFAULT_WIDTH, true);
    mouse(resizer, "mousedown", 460);
    mouse(document, "mousemove", 200); // 往左过收起线：收起，锚从「当前宽度」换成「0」
    expect(opened, "过收起线要报一次收起").toEqual([false]);
    expect(handle.isOpen(), "此刻是收着的").toBe(false);
    // ⚠️ 关键：不松手直接往右拖回来。收起后缝缩回按钮列右缘、宽度钉在最小宽 ——
    //    要是还抱着「手势开始时那个 240」当基准，这一整段都是死区，缝纹丝不动。
    mouse(document, "mousemove", 400); // target = -20 + 200 = 180：过了展开线，但还在最小宽之下
    expect(handle.isOpen(), "同一个手势里折了还得能展回来").toBe(true);
    expect(panel.style.width, "先落在最小宽（B212 那条「先变最小宽、继续拖才再变宽」）").toBe(
      `${SIDE_MIN_WIDTH}px`,
    );
    mouse(document, "mousemove", 400 + (SIDE_MIN_WIDTH - 180) + 20); // target 再过最小宽 20
    expect(
      panel.style.width,
      "宽度按**新锚**（0）接着走：还在同一个手势里就得跟着手动，不是死在最小宽上",
    ).toBe(`${SIDE_MIN_WIDTH + 20}px`);
    mouse(document, "mouseup", 400);
  });

  it("B213：过一半放开之后 —— 撑到最小宽那一段宽钉着，过了就每帧差 0", () => {
    const { panel, resizer, handle } = mountOpen(SIDE_MIN_WIDTH);
    mouse(resizer, "mousedown", 200); // 收起态按下 → 锚 = 0（缝钉在按钮列右缘）
    mouse(document, "mousemove", 200 + SIDE_MIN_WIDTH / 2 + 1); // 刚过一半 ⇒ 放开最小宽
    expect(handle.isOpen(), "过一半就放开").toBe(true);
    // 之后每帧：宽度 -（鼠标 - 按下点）。最小宽那一段被 clamp 钉住 ⇒ 差为负是必然
    // （缝得先把面板从 0 撑起来）；过了最小宽必须严丝合缝 —— 旧行为那里恒差一条阈值。
    for (const step of [0, 10, 40, 39, 60]) {
      mouse(document, "mousemove", 200 + SIDE_MIN_WIDTH + step);
      expect(
        parseInt(panel.style.width, 10) - (SIDE_MIN_WIDTH + step),
        `第 ${step}px 处宽度必须严格跟手`,
      ).toBe(0);
    }
    mouse(document, "mouseup", 200 + SIDE_MIN_WIDTH + 60);
  });

  it("一次拖到底只报一次收起（几十个 mousemove 不能切几十次 setDrawer）", () => {
    const { resizer, opened } = mountOpen(SIDE_DEFAULT_WIDTH, true);
    mouse(resizer, "mousedown", 400);
    for (let x = 399; x >= 200; x -= 1) mouse(document, "mousemove", x);
    mouse(document, "mouseup", 200);
    expect(opened, "收起只该报一次（判据问 isOpen，不是自己缓存布尔）").toEqual([false]);
  });

  it("收起态双击：顺手把展开区放回来，宽度复位默认", () => {
    const { panel, resizer, opened, changes } = mountOpen(SIDE_MIN_WIDTH);
    resizer.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(opened, "收着的时候双击要把展开区放回来").toEqual([true]);
    expect(panel.style.width, "双击照旧复位默认宽度").toBe(`${SIDE_DEFAULT_WIDTH}px`);
    expect(changes[changes.length - 1], "回写的仍是默认宽度").toBe(SIDE_DEFAULT_WIDTH);
  });

  it("收起态双击连着拖也没事：展开后宽度正常（回调不重复触发）", () => {
    const { panel, resizer, opened } = mountOpen(SIDE_MIN_WIDTH);
    resizer.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    drag(resizer, 200, 260);
    expect(opened, "已经是展开态了，不再重复报").toEqual([true]);
    expect(panel.style.width, "展开后照常按拖拽走宽度").toBe("300px");
  });
});

describe("大纲（TOC）静态契约", () => {
  it("大纲 TOC 必须走全局主题变量（回归：--md-* 作用域在 .md-preview 内，TOC 不随深浅色变化）", () => {
    // TOC 是 #main-row 下的顶层 aside，不在 .md-preview 内——
    // --panel-bg/--md-code-bg/--md-link/--md-muted 在该作用域全部未定义，
    // var() 永远落到浅色 fallback → 深色主题下大纲仍是浅色。
    const preview = readFileSync("src/styles/preview.css", "utf-8");
    // ⚠️ 注释里现在出现了 `**` 强调符（「面板**不再自带底色**」）—— 用 `[^*]*\*\/` 匹配
    //    会在强调符处截断 ⇒ 永远找不着规则块（假红）。非贪婪跨行匹配到第一个 `*/` 为止。
    const panel = preview.match(/\/\* 大纲 TOC[\s\S]*?\*\/\s*\.toc-panel\s*\{[^}]*\}/)?.[0] ?? "";
    expect(panel, "应有 .toc-panel 规则块").toBeTruthy();
    // B199（用户裁决「左边栏展开区背景和其他区域一致」）：面板**不再自带底色**，
    // 透明露出父卡片 .side-shell 的 --bg（= 编辑区同色）。原来写 var(--bg-elevated)
    // 会让展开区比编辑区亮一档，看着像浮在窗口上的另一块东西。
    expect(panel, "TOC 面板背景透明（露出父卡片的 --bg）").toMatch(/background:\s*transparent/);
    expect(panel, "不得再引用未定义的 --panel-bg").not.toContain("--panel-bg");
    const hover = ruleBlock(preview, ".toc-item:hover");
    expect(hover, "TOC hover 必须用 list.hoverBackground（B379）").toContain("var(--list-hover-bg");
    const active = ruleBlock(preview, ".toc-item.toc-active");
    expect(active, "TOC 活动项必须用 --accent").toContain("var(--accent");
    const empty = ruleBlock(preview, ".toc-empty");
    expect(empty, "TOC 空态必须用 --fg-muted").toContain("var(--fg-muted");
    const g = readFileSync("src/styles/global.css", "utf-8");
    expect(g, "global.css 不得残留未定义的 --bg-panel 引用").not.toContain("--bg-panel");
  });
  it("大纲宽度可调节：分隔条元素、拖拽接线、设置字段三者齐全", () => {
    // 用户要求：大纲区域支持宽度调节。三处缺一即失效：
    // ① index.html 要有 #side-resizer（缺则 main.ts 的 el() 直接抛错，启动白屏）
    // ② main.ts 要挂载 attachSideResizer 且收起大纲时同步隐藏分隔条
    // ③ 设置里要有 toc_width 字段（前端类型 + Rust 结构），否则宽度无法持久化
    const html = readFileSync("index.html", "utf-8");
    expect(html, "index.html 必须有 #side-resizer 分隔条").toContain('id="side-resizer"');

    const src =
      readFileSync("src/main.ts", "utf-8") + "\n" + readFileSync("src/shell/drawer.ts", "utf-8");
    expect(src, "bootstrap 必须挂载左栏分隔条").toContain("setupSideResizer()");
    expect(src, "挂载必须走 attachSideResizer").toContain("attachSideResizer(");
    // B307：显隐收敛在**外壳**的 `setDrawer`（开合 + 两块面板 + 两颗键 + 回写设置一处收口）
    // —— 断言盯「同一个函数里壳与分隔条一起翻」，而不是盯某一行的字面量。
    const setOpen = src.match(/function setDrawer\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(setOpen, "应有 setDrawer 收口展开区显隐").toBeTruthy();
    expect(setOpen, "外壳的显隐由壳自己承担").toContain("sideDrawer.hidden = !open;");
    // B195：空隙（分隔条）**不再 hidden** —— 它是两张卡片之间的固定间距，
    // 跟着 hidden 会让间距在开合时跳变；收起时只转 is-off（把手消失 + 不吃指针）。
    expect(setOpen, "收起时空隙转 is-off（不是 hidden）").toContain(
      'sideResizer.classList.toggle("is-off", !open)',
    );
    expect(setOpen, "按钮列的点亮态必须在同一处收口（面板开了键就要亮）").toContain(
      "applyView(name, spec)",
    );
    const apply = src.match(/function applyView\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(apply, "点亮态与面板显隐共用同一段（B312 起登记补写也走它）").toContain(
      'spec.button.classList.toggle("is-on", name === active)',
    );

    const css = readFileSync("src/styles/preview.css", "utf-8");
    const resizer = ruleBlock(css, ".side-resizer");
    expect(resizer, "应有 .side-resizer 规则块").toBeTruthy();
    // B61：竖线光标取 VS Code **非 mac** 档的 ew-resize（col-resize 是 mac 档，
    // Windows 上会渲染成「箭头中间多一根竖杠」）
    expect(resizer, "分隔条必须是左右调整光标（非 mac 档 ew-resize）").toContain("ew-resize");
    // B307：宽度归外壳。旧样式把 min-width 写死为 240px 会挡住拖动变窄，如今壳上的下限
    // 必须**等于代码里的 `SIDE_MIN_WIDTH`**（B317 提到 220，这里读符号不读字面量 ——
    // 上一版把 160 抄进了断言，提最小宽时它就自己打红了一次），而两块视图**不许**再带自己的宽度。
    const drawerRule = ruleBlock(css, ".side-drawer");
    expect(drawerRule, "宽度得写在 .side-drawer 上").toContain(`min-width: ${SIDE_MIN_WIDTH}px`);
    expect(drawerRule, "外壳的下限不许高过 SIDE_MIN_WIDTH（拖不窄）").not.toContain(
      "min-width: 240px",
    );
    for (const sel of [".toc-panel", ".recent-panel"]) {
      const view = ruleBlock(css, sel);
      expect(view, `${sel} 不许再自带 min-width（第二处宽度口径）`).not.toMatch(/min-width:/);
    }

    const api = readFileSync("src/ipc/api.ts", "utf-8");
    expect(api, "Settings 类型需要 toc_width 字段").toContain("toc_width: number");
    const rs = readFileSync("src-tauri/src/session/mod.rs", "utf-8");
    expect(rs, "Rust Settings 需要 toc_width 字段并给默认值").toContain("pub toc_width: f64");
    expect(rs, "默认宽度应为 240").toContain("toc_width: 240.0");
  });
});

// ------------------------------------------------------- B207：拖到底收起 / 拖回来
// 逻辑那一半锁在 tests/side-resizer.test.ts 的「B207 拖到最小再往左拖」；这里锁**接线**
// 与**可视性** —— 「收起后缝还看得见、还抓得住」是 CSS 那一半，一起才闭环。
describe("B207 拖到最小再往左拖：接线与可视性契约", () => {
  const src = (
    readFileSync("src/main.ts", "utf-8") +
    "\n" +
    readFileSync("src/shell/drawer.ts", "utf-8")
  ).replace(/\r\n/g, "\n");
  const preview = readFileSync("src/styles/preview.css", "utf-8").replace(/\r\n/g, "\n");

  it("分隔条要接到 setDrawer（拖分隔条与点那两颗键同一条路），且挂的是外壳", () => {
    const body = src.match(/function setupSideResizer\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(body, "应有 setupSideResizer 收口左栏分隔条").toBeTruthy();
    // B307：拖的目标元素必须是**壳**（`#side-drawer`）。挂在某一块面板上就是回到老毛病：
    // 最近抽屉开着时拖它 = 换视图，而不是改宽度。
    expect(body, "attachSideResizer 的第二个参数必须是外壳 sideDrawer").toContain(
      "attachSideResizer(sideResizer, sideDrawer",
    );
    expect(body, "必须把开合问给外壳（不许自己记一份）").toContain("isOpen: () => isDrawerOpen()");
    expect(body, "展开区收放必须回 setDrawer（唯一出口）").toMatch(
      /onOpenChange:\s*\(open\)\s*=>\s*\{\s*setDrawer\(open \? lastView : null\);/,
    );
    // ⚠️ 反着来不许：另存一份开合布尔跟壳的 hidden 各走各的，迟早错开
    expect(body, "不许自己另记一份开合状态").not.toMatch(/let tocOpen/);
  });

  it("收起态的缝：留着、可抓、把手可见（旧口径掐指针 + 隐身把手已废）", () => {
    const off = ruleBlock(preview, ".side-resizer.is-off");
    expect(off, "应有 .side-resizer.is-off 规则块").toBeTruthy();
    expect(off, "收起时空隙照样吃指针（拖回来就靠它）").toContain("pointer-events: auto");
    expect(off, "收起时空隙仍是左右调整光标").toContain("cursor: ew-resize");
    expect(preview, "收起时把手不许隐身 —— 看不见缝在哪，就找不到往右拖的地方").not.toMatch(
      /\.side-resizer\.is-off \.toc-grip\s*\{[^}]*visibility:\s*hidden/,
    );
    // 与整栏收起分清：那一档才是连缝一起不占位
    expect(preview, "整栏收起仍要连缝一起收掉").toMatch(
      /#main-row\.is-sidebar-off > #side-resizer\s*\{\s*display:\s*none;/,
    );
  });

  it("反向验证：收起态退回掐指针（死带）必须被咬住", () => {
    const BAD = preview.replace(
      /(\.side-resizer\.is-off\s*\{[^}]*)pointer-events:\s*auto;/,
      "$1pointer-events: none;",
    );
    expect(BAD, "替身必须真的把缝掐了").not.toBe(preview);
    expect(() => {
      expect(
        BAD.match(/\.side-resizer\.is-off\s*\{[^}]*\}/)?.[0],
        "掐指针的死带必须被抓到",
      ).toContain("pointer-events: auto");
    }).toThrow();
  });

  it("反向验证：isOpen 写死（跟外壳的 hidden 错开）必须被咬住", () => {
    const BAD = src.replace("isOpen: () => isDrawerOpen()", "isOpen: () => true");
    expect(BAD, "替身必须真的改成写死").not.toBe(src);
    expect(() => {
      expect(
        BAD.match(/function setupSideResizer\(\)[\s\S]*?\n\}/)?.[0],
        "写死的 isOpen 必须被抓到",
      ).toContain("isOpen: () => isDrawerOpen()");
    }).toThrow();
  });
});

// ------------------------------------------------------- B194：大纲开合状态存设置并恢复
// 用户诉求：「大纲打开状态也要支持恢复」。存 settings.json（与 toc_width 同处）——
// 它是窗口级外观状态，不属于某份文档，所以不进会话文件。
describe("B194 大纲开合状态：切一次要落盘、启动要回放", () => {
  const src = (
    readFileSync("src/main.ts", "utf-8") +
    "\n" +
    readFileSync("src/toc.ts", "utf-8") +
    "\n" +
    readFileSync("src/shell/drawer.ts", "utf-8")
  ).replace(/\r\n/g, "\n");
  const api = readFileSync("src/ipc/api.ts", "utf-8").replace(/\r\n/g, "\n");
  const rs = readFileSync("src-tauri/src/session/mod.rs", "utf-8").replace(/\r\n/g, "\n");

  function bodyOf(fnHead: string): string {
    const i = src.indexOf(fnHead);
    expect(i, `找不到函数：${fnHead}`).toBeGreaterThan(-1);
    const j = src.indexOf("\n}", i);
    return src.slice(i, j);
  }

  it("设置里要有两格（toc_open + drawer_view：前端类型 + Rust 结构 + 默认值）", () => {
    expect(api, "Settings 类型需要 toc_open 字段").toContain("toc_open: boolean");
    expect(rs, "Rust Settings 需要 toc_open 字段").toContain("pub toc_open: bool");
    expect(rs, "默认应为关闭（与 index.html 的 hidden 初值一致）").toContain("toc_open: false");
    // B312：「开着的是哪一块」是第二格。类型只在前端有（后端不校验枚举，理由同 tab_style），
    // Rust 侧存串 + 默认 "toc" ⇒ 旧配置文件缺这一格也不会读失败。
    expect(api, "Settings 类型需要 drawer_view 字段").toContain("drawer_view: DrawerViewName");
    expect(rs, "Rust Settings 需要 drawer_view 字段").toContain("pub drawer_view: String");
    expect(rs, "默认应为大纲").toContain('drawer_view: "toc".into()');
  });

  it("切换要把「开没开」与「哪一块」都写进设置并落盘", () => {
    // B307：落盘点从 `setSideOpen` 搬到外壳的 `setDrawer`。
    // B312：`toc_open` 只管开没开（旧语义「只有大纲才记 true」把两块挤进一格，
    // 于是最近那块永远存不下来 —— 用户这次报的就是它）。
    const body = bodyOf("function setDrawer(");
    expect(body, "要把开合写进 settings.toc_open").toMatch(/settings\.toc_open = open;/);
    expect(body, "要把哪一块写进 settings.drawer_view").toMatch(
      /if \(view\) settings\.drawer_view = view;/,
    );
    expect(body, "写完要落盘").toMatch(/saveSettings\(settings\)/);
    // 唯一入口：命令与顶部按钮都走 toggleToc → setDrawer。
    // ⚠️ 不写字符预算：这类「函数头之后 N 字内必须出现 X」的断言一插代码就断（B305/B307
    //  两次都是它），改成「toggleToc 体内部就得出现 setDrawer」。
    const toggle = bodyOf("function toggleToc(");
    expect(toggle, "toggleToc 必须走 setDrawer（唯一收口）").toContain("setDrawer(");
  });

  it("启动时要回放那两格，且回放本身不写盘", () => {
    expect(src, "启动要调外壳的回放（两格都在那里读）").toMatch(/\n {2}replayDrawer\(\);/);
    const replay = bodyOf("export function replayDrawer(");
    expect(replay, "「哪一块」要读 settings.drawer_view").toMatch(
      /viewFromSetting\(settings\?\.drawer_view\)/,
    );
    expect(replay, "「开没开」要读 settings.toc_open").toMatch(
      /setDrawer\(settings\?\.toc_open \? view : null, false\)/,
    );
    // persist=false：否则「加载失败 → 用默认值」会把默认值固化成用户设置
    const body = bodyOf("function setDrawer(");
    expect(body, "persist=false 时不得回写设置").toMatch(/if \(!persist \|\| !settings\) return;/);
  });

  it("B194 + B312 反向验证：摘掉落盘 → 上面那条必须落空", () => {
    for (const ORIG of [
      "  settings.toc_open = open;",
      "  if (view) settings.drawer_view = view;",
    ]) {
      expect(src, "退化串要先自证原句还在").toContain(ORIG);
      const degraded = src.replace(ORIG, "");
      expect(degraded, `摘掉「${ORIG.trim()}」之后必须再也匹配不上`).not.toContain(ORIG.trim());
    }
  });

  it("B312 登记补写：迟登记的那一块在登记那一刻就得对上当前开合态", () => {
    // 生产次序：外壳回放在装配阶段，最近那块排在会话恢复之后才登记 ⇒ 登记那一刻
    // 若不补写，重启后就是「壳开着、两块都藏着」的一片空白。
    const reg = bodyOf("export function registerDrawerView(");
    expect(reg, "登记要顺手把当前开合态补到这一块上").toContain("applyView(name, spec)");
    const apply = bodyOf("function applyView(");
    expect(apply, "补写读的是模块里的 active，不是调用方传的第二套口径").toContain(
      "spec.panel.hidden = name !== active;",
    );
  });
});

// ------------------------------------------------------- 命名：左栏 ≠ 大纲
// 用户点名：左栏收起/展开这一层的名字不该挂 TOC 前缀 —— 左栏以后不只有大纲。
// ⚠️ 这里**只用反向断言**。光有正向断言（「CSS 里得有 .side-resizer」）根本锁不住
// 命名：将来谁把选择器改回 .toc-resizer 时只要顺手把测试里的字符串一起改，
// 照样一片绿。只有「旧名不许回来」这类反向断言咬得住这次重命名本身。
describe("B212 命名：左栏的宽度与收放不挂大纲前缀", () => {
  const html = readFileSync("index.html", "utf-8").replace(/\r\n/g, "\n");
  const preview = readFileSync("src/styles/preview.css", "utf-8").replace(/\r\n/g, "\n");
  const globalCss = readFileSync("src/styles/global.css", "utf-8").replace(/\r\n/g, "\n");
  const src = (
    readFileSync("src/main.ts", "utf-8") +
    "\n" +
    readFileSync("src/toc.ts", "utf-8") +
    "\n" +
    // B307：新落下的是 `shell/drawer.ts` —— 反向闸不覆盖它就等于没装：
    // 谁把外壳的出口改回 `setTocOpen` 这类名字，这三条照样绿。
    readFileSync("src/shell/drawer.ts", "utf-8")
  ).replace(/\r\n/g, "\n");
  const toc = readFileSync("src/markdown/toc.ts", "utf-8").replace(/\r\n/g, "\n");

  it("样式表与 index.html 不许再出现旧的大纲分割线选择器", () => {
    for (const [name, text] of [
      ["preview.css", preview],
      ["global.css", globalCss],
    ] as const) {
      expect(text, `${name} 不许残留旧的 toc-resizer 选择器`).not.toContain("toc-resizer");
    }
    expect(html, "index.html 不许再是 #toc-resizer").not.toContain('id="toc-resizer"');
  });

  it("左栏宽度与阈值不许再以 TOC_ 前缀从 toc.ts 导出", () => {
    expect(toc, "不许再导出 TOC_DEFAULT_WIDTH").not.toContain("TOC_DEFAULT_WIDTH");
    expect(toc, "不许再导出 TOC_MIN_WIDTH").not.toContain("TOC_MIN_WIDTH");
    expect(toc, "不许再导出 TOC_MAX_WIDTH").not.toContain("TOC_MAX_WIDTH");
    expect(toc, "不许再导出 TOC_OVERDRAG_PX").not.toContain("TOC_OVERDRAG_PX");
  });

  it("挂载与显隐收口不许再叫 TocResizer / setTocOpen", () => {
    expect(src, "bootstrap 不许再挂 setupTocResizer").not.toContain("setupTocResizer");
    expect(src, "挂载不许再走 attachTocResizer").not.toContain("attachTocResizer");
    expect(src, "显隐收口不许再叫 setTocOpen").not.toContain("setTocOpen");
  });
});

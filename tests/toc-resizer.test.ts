// @vitest-environment jsdom
// 大纲宽度调节：分隔条拖拽 / 边界收敛 / 双击复位 / 设置回写。
// 用户要求「大纲区域也要支持宽度调节」——本文件覆盖拖拽编排的全部行为，
// regressions.test.ts 另补静态接线断言（index.html 元素、CSS 光标、设置字段）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  attachTocResizer,
  clampTocWidth,
  TOC_DEFAULT_WIDTH,
  TOC_MAX_WIDTH,
  TOC_MIN_WIDTH,
  TOC_OVERDRAG_PX,
} from "../src/markdown/toc";

function mount(initial = TOC_DEFAULT_WIDTH) {
  const panel = document.createElement("aside");
  const resizer = document.createElement("div");
  document.body.append(panel, resizer);
  const changes: number[] = [];
  const handle = attachTocResizer(resizer, panel, {
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

describe("clampTocWidth 边界收敛", () => {
  it("非法值回落默认，超界值收敛到 [160, 640]", () => {
    expect(clampTocWidth(Number.NaN)).toBe(TOC_DEFAULT_WIDTH);
    expect(clampTocWidth(Number.POSITIVE_INFINITY)).toBe(TOC_DEFAULT_WIDTH);
    expect(clampTocWidth(10)).toBe(TOC_MIN_WIDTH);
    expect(clampTocWidth(9999)).toBe(TOC_MAX_WIDTH);
    expect(clampTocWidth(237.6)).toBe(238);
    expect(clampTocWidth(TOC_DEFAULT_WIDTH)).toBe(TOC_DEFAULT_WIDTH);
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
    expect(panel.style.width).toBe(`${TOC_MIN_WIDTH}px`);
    drag(resizer, TOC_MIN_WIDTH, 5000);
    expect(panel.style.width).toBe(`${TOC_MAX_WIDTH}px`);
    expect(changes).toEqual([TOC_MIN_WIDTH, TOC_MAX_WIDTH]);
  });

  it("拖拽中为 body 加 layout-dragging 光标类，松手移除", () => {
    const { resizer } = mount();
    mouse(resizer, "mousedown", 240);
    mouse(document, "mousemove", 300);
    expect(document.body.classList.contains("layout-dragging")).toBe(true);
    mouse(document, "mouseup", 300);
    expect(document.body.classList.contains("layout-dragging")).toBe(false);
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
    expect(panel.style.width).toBe(`${TOC_DEFAULT_WIDTH}px`);
    expect(handle.getWidth()).toBe(TOC_DEFAULT_WIDTH);
    expect(changes[changes.length - 1]).toBe(TOC_DEFAULT_WIDTH);
  });

  it("setWidth 供设置对话框回写，同样收敛到合法区间", () => {
    const { panel, handle } = mount();
    handle.setWidth(9999);
    expect(panel.style.width).toBe(`${TOC_MAX_WIDTH}px`);
    expect(handle.getWidth()).toBe(TOC_MAX_WIDTH);
    handle.setWidth(20);
    expect(handle.getWidth()).toBe(TOC_MIN_WIDTH);
  });

  it("非左键按下不启动拖拽（避免右键菜单误触）", () => {
    const { panel, resizer } = mount();
    resizer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 240, button: 2 }));
    mouse(document, "mousemove", 400);
    mouse(document, "mouseup", 400);
    expect(panel.style.width).toBe(`${TOC_DEFAULT_WIDTH}px`);
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
  function mountOpen(initial = TOC_DEFAULT_WIDTH, open = false) {
    const panel = document.createElement("aside");
    const resizer = document.createElement("div");
    document.body.append(panel, resizer);
    // 首屏默认收着（与 index.html 上那条 is-off 同态）；要测「展开态那一半」显式传 true
    const changes: number[] = [];
    const opened: boolean[] = [];
    const handle = attachTocResizer(resizer, panel, {
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
    expect(panel.style.width, "宽度原样留着").toBe(`${TOC_DEFAULT_WIDTH}px`);
    expect(changes, "松手照旧回写当前宽度").toEqual([TOC_DEFAULT_WIDTH]);
  });

  it("B212：收起与展开共用**最小宽度的一半**这一个阈值（收起线 = 展开线）", () => {
    expect(TOC_OVERDRAG_PX, "阈值必须是最小宽度的一半").toBe(TOC_MIN_WIDTH / 2);
    const toc = readFileSync("src/markdown/toc.ts", "utf-8");
    // 两处判据（收起 / 展开）都得读同一个常量：合成一档以后不许再各写各的数字
    const uses = [...toc.matchAll(/TOC_OVERDRAG_PX/g)];
    expect(uses.length, "收起与展开两处判据都要用这个常量").toBeGreaterThanOrEqual(3);
    expect(toc, "不许再留收起/展开两个分档常量").not.toContain("TOC_HIDE_OVERDRAG_PX");
    expect(toc, "不许再留收起/展开两个分档常量").not.toContain("TOC_RESTORE_OVERDRAG_PX");
  });

  it("收起态往右拖：越过阈值才展开，宽度按**超出阈值那一段**起算", () => {
    const { panel, resizer, opened, changes } = mountOpen(TOC_MIN_WIDTH);
    // B209：越过阈值那一刻展开区是最小宽，再往右拖多少就加多少 —— 不是「弹回上次那个数」
    drag(resizer, 200, 200 + TOC_OVERDRAG_PX + 40);
    expect(opened, "往右拖必须把展开区放回来").toEqual([true]);
    expect(panel.style.width, "展开后 = 最小宽 + 超出阈值的那一段").toBe(`${TOC_MIN_WIDTH + 40}px`);
    expect(changes[changes.length - 1], "松手回写摊开后的宽度").toBe(TOC_MIN_WIDTH + 40);
  });

  // ⚠️ 下面两条**故意不引用 `TOC_OVERDRAG_PX`**：那是个导出的常量，拿它当位移去拖，
  //    常量一改用例跟着改 —— 退化时照样绿（自己写出来的假绿，B212 首轮真退化就是这么漏的）。
  //    阈值按需求写成「最小宽度的一半」这个**表达式**，退化成别的数必红。
  it("B212：刚跨过阈值那一刻展开区**正好是最小宽**，继续拖才变宽（整段手势不跳）", () => {
    const { panel, resizer, opened, changes } = mountOpen(TOC_MIN_WIDTH);
    const threshold = TOC_MIN_WIDTH / 2; // 阈值 = 最小宽度的一半
    // ⚠️ 同一个手势里连着走：过阈值 → 再往右 20。中间不能松手，否则就换了起始态，
    //    测不到「整段手势宽度连续」这件事。
    mouse(resizer, "mousedown", 200);
    mouse(document, "mousemove", 200 + threshold); // dx 正好 = 阈值：超出那一段为 0
    expect(opened, "刚好到阈值就该展开").toEqual([true]);
    expect(panel.style.width, "触发展开先落回最小宽，不是弹回上次那个宽度").toBe(
      `${TOC_MIN_WIDTH}px`,
    );
    mouse(document, "mousemove", 200 + threshold + 20); // 继续往右 20
    expect(panel.style.width, "继续拖才再变宽 = 最小宽 + 超出阈值的那一段").toBe(
      `${TOC_MIN_WIDTH + 20}px`,
    );
    mouse(document, "mousemove", 200 + threshold + 21);
    expect(panel.style.width, "再拖一格就加一格，不能整条阈值一起跳").toBe(
      `${TOC_MIN_WIDTH + 21}px`,
    );
    mouse(document, "mouseup", 200 + threshold + 21);
    expect(changes[changes.length - 1], "松手回写的是摊开后的宽度").toBe(TOC_MIN_WIDTH + 21);
  });

  it("B209：收起态往右拖**没过阈值**不展开（旧行为 dx>0 就弹，太容易误触）", () => {
    const { panel, resizer, opened } = mountOpen(TOC_MIN_WIDTH);
    // 阈值**差一像素**：用「最小宽度的一半」算，退化成任何更小的数都会越过 ⇒ 必红
    drag(resizer, 200, 200 + TOC_MIN_WIDTH / 2 - 1);
    expect(opened, "差一像素也不该展开").toEqual([]);
    expect(panel.style.width, "面板宽度不动").toBe(`${TOC_MIN_WIDTH}px`);
  });

  it("收起态按下先往左（无反应）再往右（展开），左拖不会被当成收起", () => {
    const { panel, resizer, opened, changes } = mountOpen(TOC_MIN_WIDTH);
    mouse(resizer, "mousedown", 200);
    mouse(document, "mousemove", 160); // 往左：收起态那一边不动
    mouse(document, "mousemove", 200 + TOC_OVERDRAG_PX + 20); // 往右：过阈值才展开
    mouse(document, "mouseup", 200 + TOC_OVERDRAG_PX + 20);
    expect(opened, "只有往右那一下算展开").toEqual([true]);
    expect(panel.style.width, "宽度按超出阈值那一段算，不是按下起的总位移").toBe(
      `${TOC_MIN_WIDTH + 20}px`,
    );
    expect(changes[changes.length - 1], "回写摊开后的宽度").toBe(TOC_MIN_WIDTH + 20);
  });

  it("展开态拖到最小：还没过阈值**就不收**（「就想拖窄一点」不能被误判成收起）", () => {
    const { resizer, opened } = mountOpen(TOC_DEFAULT_WIDTH, true);
    // 起点 400、宽 240 ⇒ 往左 80px（x → 320）正好贴到最小线，还没过阈值
    drag(resizer, 400, 400 - (TOC_DEFAULT_WIDTH - TOC_MIN_WIDTH));
    expect(opened, "贴到最小不算收起").toEqual([]);
  });

  it("展开态拖到最小后**继续**往左拖过阈值：收起展开区", () => {
    const { panel, resizer, opened } = mountOpen(TOC_DEFAULT_WIDTH, true);
    // 判据是 startWidth + dx <= 最小线 - TOC_OVERDRAG_PX（不累加位移），越过它 8px：
    // 240 + dx = 160 - 80 - 8 ⇒ dx = -188 ⇒ x = 212
    drag(resizer, 400, 400 - (TOC_DEFAULT_WIDTH - TOC_MIN_WIDTH) - TOC_OVERDRAG_PX - 8);
    expect(opened, "过阈值必须报一次收起").toEqual([false]);
    expect(panel.style.width, "收起后宽度仍留在最小值（拖回来接着用）").toBe(`${TOC_MIN_WIDTH}px`);
  });

  it("一次拖到底只报一次收起（几十个 mousemove 不能切几十次 setTocOpen）", () => {
    const { resizer, opened } = mountOpen(TOC_DEFAULT_WIDTH, true);
    mouse(resizer, "mousedown", 400);
    for (let x = 399; x >= 200; x -= 1) mouse(document, "mousemove", x);
    mouse(document, "mouseup", 200);
    expect(opened, "收起只该报一次（判据问 isOpen，不是自己缓存布尔）").toEqual([false]);
  });

  it("收起态双击：顺手把展开区放回来，宽度复位默认", () => {
    const { panel, resizer, opened, changes } = mountOpen(TOC_MIN_WIDTH);
    resizer.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(opened, "收着的时候双击要把展开区放回来").toEqual([true]);
    expect(panel.style.width, "双击照旧复位默认宽度").toBe(`${TOC_DEFAULT_WIDTH}px`);
    expect(changes[changes.length - 1], "回写的仍是默认宽度").toBe(TOC_DEFAULT_WIDTH);
  });

  it("收起态双击连着拖也没事：展开后宽度正常（回调不重复触发）", () => {
    const { panel, resizer, opened } = mountOpen(TOC_MIN_WIDTH);
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
    const hover = preview.match(/\.toc-item:hover\s*\{[^}]*\}/)?.[0] ?? "";
    expect(hover, "TOC hover 必须用 --bg-hover").toContain("var(--bg-hover");
    const active = preview.match(/\.toc-item\.toc-active\s*\{[^}]*\}/)?.[0] ?? "";
    expect(active, "TOC 活动项必须用 --accent").toContain("var(--accent");
    const empty = preview.match(/\.toc-empty\s*\{[^}]*\}/)?.[0] ?? "";
    expect(empty, "TOC 空态必须用 --fg-muted").toContain("var(--fg-muted");
    const g = readFileSync("src/styles/global.css", "utf-8");
    expect(g, "global.css 不得残留未定义的 --bg-panel 引用").not.toContain("--bg-panel");
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
    // B194：显隐已收敛进 `setTocOpen`（开合 + 回写设置一处收口）—— 断言盯
    // 「同一个函数里面板与分隔条的 hidden 一起写」，而不是盯某一行的字面量。
    const setOpen = src.match(/function setTocOpen\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(setOpen, "应有 setTocOpen 收口大纲显隐").toBeTruthy();
    expect(setOpen, "展开区的显隐仍由面板自己承担").toContain("tocPanel.hidden = !open;");
    // B195：空隙（分隔条）**不再 hidden** —— 它是两张卡片之间的固定间距，
    // 跟着 hidden 会让间距在开合时跳变；收起时只转 is-off（把手消失 + 不吃指针）。
    expect(setOpen, "收起时空隙转 is-off（不是 hidden）").toContain(
      'tocResizer.classList.toggle("is-off", !open)',
    );
    expect(setOpen, "按钮列的点亮态必须在同一处收口（面板开了键就要亮）").toContain(
      'sideOutline.classList.toggle("is-on", open)',
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
});

// ------------------------------------------------------- B207：拖到底收起 / 拖回来
// 逻辑那一半锁在 tests/toc-resizer.test.ts 的「B207 拖到最小再往左拖」；这里锁**接线**
// 与**可视性** —— 「收起后缝还看得见、还抓得住」是 CSS 那一半，一起才闭环。
describe("B207 拖到最小再往左拖：接线与可视性契约", () => {
  const src = readFileSync("src/main.ts", "utf-8").replace(/\r\n/g, "\n");
  const preview = readFileSync("src/styles/preview.css", "utf-8").replace(/\r\n/g, "\n");

  it("分隔条要接到 setTocOpen（拖分隔条与点大纲键同一条路）", () => {
    const body = src.match(/function setupTocResizer\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(body, "应有 setupTocResizer 收口大纲分隔条").toBeTruthy();
    expect(body, "必须把开合问给调用方（isOpen）").toContain("isOpen: () => !tocPanel.hidden");
    expect(body, "展开区收放必须回 setTocOpen（唯一出口）").toMatch(
      /onOpenChange:\s*\(open\)\s*=>\s*\{\s*setTocOpen\(open\);/,
    );
    // ⚠️ 反着来不许：另存一份开合布尔跟面板的 hidden 各走各的，迟早错开
    expect(body, "不许自己另记一份开合状态").not.toMatch(/let tocOpen/);
  });

  it("收起态的缝：留着、可抓、把手可见（旧口径掐指针 + 隐身把手已废）", () => {
    const off = preview.match(/\.toc-resizer\.is-off\s*\{[^}]*\}/)?.[0] ?? "";
    expect(off, "应有 .toc-resizer.is-off 规则块").toBeTruthy();
    expect(off, "收起时空隙照样吃指针（拖回来就靠它）").toContain("pointer-events: auto");
    expect(off, "收起时空隙仍是左右调整光标").toContain("cursor: ew-resize");
    expect(preview, "收起时把手不许隐身 —— 看不见缝在哪，就找不到往右拖的地方").not.toMatch(
      /\.toc-resizer\.is-off \.toc-grip\s*\{[^}]*visibility:\s*hidden/,
    );
    // 与整栏收起分清：那一档才是连缝一起不占位
    expect(preview, "整栏收起仍要连缝一起收掉").toMatch(
      /#main-row\.is-sidebar-off > #toc-resizer\s*\{\s*display:\s*none;/,
    );
  });

  it("反向验证：收起态退回掐指针（死带）必须被咬住", () => {
    const BAD = preview.replace(
      /(\.toc-resizer\.is-off\s*\{[^}]*)pointer-events:\s*auto;/,
      "$1pointer-events: none;",
    );
    expect(BAD, "替身必须真的把缝掐了").not.toBe(preview);
    expect(() => {
      expect(
        BAD.match(/\.toc-resizer\.is-off\s*\{[^}]*\}/)?.[0],
        "掐指针的死带必须被抓到",
      ).toContain("pointer-events: auto");
    }).toThrow();
  });

  it("反向验证：isOpen 改成自存布尔（跟面板错开）必须被咬住", () => {
    const BAD = src.replace("isOpen: () => !tocPanel.hidden", "isOpen: () => true");
    expect(BAD, "替身必须真的改成写死").not.toBe(src);
    expect(() => {
      expect(
        BAD.match(/function setupTocResizer\(\)[\s\S]*?\n\}/)?.[0],
        "自存布尔必须被抓到",
      ).toContain("isOpen: () => !tocPanel.hidden");
    }).toThrow();
  });
});

// ------------------------------------------------------- B194：大纲开合状态存设置并恢复
// 用户诉求：「大纲打开状态也要支持恢复」。存 settings.json（与 toc_width 同处）——
// 它是窗口级外观状态，不属于某份文档，所以不进会话文件。
describe("B194 大纲开合状态：切一次要落盘、启动要回放", () => {
  const src = readFileSync("src/main.ts", "utf-8").replace(/\r\n/g, "\n");
  const api = readFileSync("src/ipc/api.ts", "utf-8").replace(/\r\n/g, "\n");
  const rs = readFileSync("src-tauri/src/session/mod.rs", "utf-8").replace(/\r\n/g, "\n");

  function bodyOf(fnHead: string): string {
    const i = src.indexOf(fnHead);
    expect(i, `找不到函数：${fnHead}`).toBeGreaterThan(-1);
    const j = src.indexOf("\n}", i);
    return src.slice(i, j);
  }

  it("设置里要有 toc_open（前端类型 + Rust 结构 + 默认值）", () => {
    expect(api, "Settings 类型需要 toc_open 字段").toContain("toc_open: boolean");
    expect(rs, "Rust Settings 需要 toc_open 字段").toContain("pub toc_open: bool");
    expect(rs, "默认应为关闭（与 index.html 的 hidden 初值一致）").toContain("toc_open: false");
  });

  it("切换大纲要把开合状态写进设置并落盘", () => {
    const body = bodyOf("function setTocOpen(");
    expect(body, "要把开合写进 settings.toc_open").toMatch(/settings\.toc_open = open;/);
    expect(body, "写完要落盘").toMatch(/saveSettings\(settings\)/);
    // 唯一入口：命令与顶部按钮都走 toggleToc → setTocOpen
    expect(src, "toggleToc 必须走 setTocOpen（唯一收口）").toMatch(
      /function toggleToc\(\)[\s\S]{0,200}setTocOpen\(tocPanel\.hidden\)/,
    );
  });

  it("启动时要回放上次的开合，且回放本身不写盘", () => {
    expect(src, "启动要按 settings.toc_open 回放").toMatch(
      /setTocOpen\(settings\?\.toc_open \?\? false, false\)/,
    );
    // persist=false：否则「加载失败 → 用默认值」会把默认值固化成用户设置
    const body = bodyOf("function setTocOpen(");
    expect(body, "persist=false 时不得回写设置").toMatch(/if \(!persist \|\| !settings\) return;/);
  });

  it("B194 反向验证：摘掉落盘 → 上面那条必须落空", () => {
    const ORIG = "  settings.toc_open = open;";
    expect(src, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = src.replace(ORIG, "");
    expect(degraded, "退化后不再写 toc_open").not.toMatch(/settings\.toc_open = open;/);
  });
});

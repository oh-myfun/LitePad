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

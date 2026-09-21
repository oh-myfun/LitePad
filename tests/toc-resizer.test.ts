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
});

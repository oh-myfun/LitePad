// @vitest-environment jsdom
// 大纲宽度调节：分隔条拖拽 / 边界收敛 / 双击复位 / 设置回写。
// 用户要求「大纲区域也要支持宽度调节」——本文件覆盖拖拽编排的全部行为，
// regressions.test.ts 另补静态接线断言（index.html 元素、CSS 光标、设置字段）。
import { describe, it, expect } from "vitest";
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

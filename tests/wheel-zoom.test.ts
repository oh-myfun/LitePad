// @vitest-environment jsdom
// Ctrl + 滚轮缩放字号：滚轮方向、preventDefault（阻断 WebView2 整页缩放）、
// 以及触控板捏合（密集小 delta）的累加阈值。
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { attachWheelZoom } from "../src/shell/zoom";

let detach: (() => void) | null = null;

afterEach(() => {
  detach?.();
  detach = null;
});

function wheel(deltaY: number, ctrlKey = true): WheelEvent {
  const e = new WheelEvent("wheel", { deltaY, ctrlKey, bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e;
}

function mount(): { dirs: (1 | -1)[]; ev: (deltaY: number, ctrl?: boolean) => WheelEvent } {
  const dirs: (1 | -1)[] = [];
  detach = attachWheelZoom((d) => dirs.push(d));
  return { dirs, ev: wheel };
}

describe("Ctrl + 滚轮缩放", () => {
  it("向上滚放大、向下滚缩小，并 preventDefault 阻断页面缩放", () => {
    const m = mount();
    const up = m.ev(-100);
    const down = m.ev(100);
    expect(m.dirs).toEqual([1, -1]);
    expect(up.defaultPrevented, "必须 preventDefault，否则 WebView2 会整页缩放").toBe(true);
    expect(down.defaultPrevented).toBe(true);
  });

  it("未按 Ctrl 时不缩放，也不拦截（保留正常滚动）", () => {
    const m = mount();
    const e = m.ev(120, false);
    expect(m.dirs).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  it("触控板捏合的密集小 delta 走累加阈值，不会一次捏合跳多档", () => {
    const m = mount();
    // 单帧小量（<30）不应触发
    m.ev(-10);
    m.ev(-12);
    expect(m.dirs, "未达阈值前不响应").toEqual([]);
    // 累计越过阈值后走一档
    m.ev(-15);
    expect(m.dirs).toEqual([1]);
    // 反向同样累加
    m.ev(10);
    m.ev(12);
    expect(m.dirs, "反向也要累加到阈值").toEqual([1]);
    m.ev(15);
    expect(m.dirs).toEqual([1, -1]);
  });

  it("detach 后不再响应", () => {
    const m = mount();
    detach?.();
    detach = null;
    m.ev(-100);
    expect(m.dirs).toEqual([]);
  });
});

describe("Ctrl+滚轮缩放字号", () => {
  it("Ctrl+滚轮缩放字号，且预览随之缩放（用户要求）", () => {
    // 用户要求：Ctrl+滚轮调字号，预览内容也要跟着变。
    const src = readFileSync("src/main.ts", "utf-8");
    expect(src, "必须挂载滚轮缩放").toContain("attachWheelZoom(");
    const zoom = readFileSync("src/shell/zoom.ts", "utf-8");
    expect(zoom, "只响应 Ctrl+滚轮").toContain("if (!e.ctrlKey) return;");
    expect(zoom, "必须 preventDefault 阻断 WebView2 整页缩放").toContain("e.preventDefault()");
    expect(zoom, "必须用 passive:false 注册，否则 preventDefault 无效").toContain("passive: false");

    // 预览字号不能再写死：必须跟随 --font-size（导出 HTML 只注入 preview.css，故需兜底）
    const css = readFileSync("src/styles/preview.css", "utf-8");
    const root = css.match(/\.md-preview\s*\{[^}]*\}/)?.[0] ?? "";
    expect(root, "应有 .md-preview 规则").toBeTruthy();
    expect(root, "预览字号必须跟随 --font-size").toContain("var(--font-size");
    expect(root, "导出场景缺少 :root，需要 14px 兜底").toContain("var(--font-size, 14px)");
    expect(root, "预览字号不得再写死 15px").not.toMatch(/font-size:\s*15px/);
    // 代码块用 em 才会跟随缩放
    const pre = css.match(/\.md-preview pre\.md-code[\s\S]*?\}/)?.[0] ?? "";
    expect(pre, "代码块字号必须用 em 跟随缩放").toMatch(/font-size:\s*[\d.]+em/);
  });
});

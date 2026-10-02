// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { themeBlock } from "./static";

describe("滚动条：全应用统一且随深浅色联动", () => {
  it("滚动条必须全应用统一且随深浅色联动（用户要求）", () => {
    // 用户报告：滚动条样式与界面不统一，且不跟随深浅色。
    // WebView2 默认滚动条走 Windows 系统样式 → 深色界面里是一条浅色亮条。
    // 统一方案：轨道透明 + thumb 走 --sb-* 变量（两个主题各一套），全局生效。
    const g = readFileSync("src/styles/global.css", "utf-8");
    const dark = themeBlock(g, "dark");
    const light = themeBlock(g, "light");
    expect(dark, "应有深色主题变量块").toBeTruthy();
    expect(light, "应有浅色主题变量块").toBeTruthy();

    for (const [name, block] of [
      ["深色", dark],
      ["浅色", light],
    ] as const) {
      expect(block, `${name}主题必须定义 --sb-thumb`).toContain("--sb-thumb:");
      expect(block, `${name}主题必须定义 --sb-thumb-hover`).toContain("--sb-thumb-hover:");
      expect(block, `${name}主题应声明 color-scheme（原生控件跟随主题）`).toContain(
        "color-scheme:",
      );
    }
    // 两套主题取值必须不同，否则等于没跟随主题
    const darkThumb = /--sb-thumb:\s*([^;]+);/.exec(dark)?.[1]?.trim();
    const lightThumb = /--sb-thumb:\s*([^;]+);/.exec(light)?.[1]?.trim();
    expect(darkThumb).toBeTruthy();
    expect(lightThumb).toBeTruthy();
    expect(darkThumb, "深浅色的滚动条滑块颜色必须不同").not.toBe(lightThumb);

    // 全局生效：**只走 Chromium 的 webkit 伪元素这一条路**（B200）
    // —— 双写 scrollbar-width / scrollbar-color 时渲染路径由 Chromium 挑，
    //    挑到系统那一路伪元素就管不着 ⇒ 曾经冒出 Windows 的三角箭头。
    //    本软件只跑 Windows + WebView2，标准属性本就没收益，不再双写。
    const bar = g.match(/::-webkit-scrollbar\s*\{[^}]*\}/)?.[0] ?? "";
    expect(bar, "应有 ::-webkit-scrollbar 规则").toBeTruthy();
    expect(bar, "滚动条宽度必须显式声明（伪元素路径唯一的证据）").toMatch(/width:\s*\d+px/);
    expect(g, "不得双写标准属性 scrollbar-width（会抢渲染路径）").not.toMatch(/scrollbar-width:/);
    expect(g, "不得双写标准属性 scrollbar-color（会抢渲染路径）").not.toMatch(/scrollbar-color:/);
    const thumb = g.match(/::-webkit-scrollbar-thumb\s*\{[^}]*\}/)?.[0] ?? "";
    expect(thumb, "应有 ::-webkit-scrollbar-thumb 规则").toBeTruthy();
    expect(thumb, "滑块颜色必须引用 --sb-thumb 变量").toContain("var(--sb-thumb");
    expect(thumb, "滑块不得写死十六进制颜色").not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // 箭头：裸的那一条 + 按方向细分的 increment / decrement，三条都得 hide
    for (const [name, sel] of [
      ["裸 button", "::-webkit-scrollbar-button\\s*\\{"],
      ["increment", "::-webkit-scrollbar-button:increment\\s*\\{"],
      ["decrement", "::-webkit-scrollbar-button:decrement\\s*\\{"],
    ] as const) {
      expect(g, `必须隐藏滚动条两端箭头按钮（${name}）`).toMatch(
        new RegExp(`${sel}[^}]*display:\\s*none`),
      );
    }
  });
});

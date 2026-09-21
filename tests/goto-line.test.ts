// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("转到行：顶部对齐（与大纲跳转一致）", () => {
  it("B31 转到行必须顶部对齐（与大纲跳转一致，不得最小滚动贴底）", () => {
    const src = readFileSync("src/main.ts", "utf-8");
    // 转到行 overlay（.goto-overlay 所在函数链）里的跳转必须用 y:"start"
    const gotoIdx = src.indexOf('overlay.className = "goto-overlay"');
    expect(gotoIdx, "goto overlay 应存在").toBeGreaterThan(0);
    const region = src.slice(gotoIdx, gotoIdx + 4000);
    expect(region, "转到行跳转必须 y:start 顶部对齐").toContain(
      'EditorView.scrollIntoView(pos, { y: "start", yMargin: 0 })',
    );
    expect(region, "转到行不得再用最小滚动的 scrollIntoView:true").not.toContain(
      "scrollIntoView: true",
    );
  });
});

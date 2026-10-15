// @vitest-environment jsdom
// B288 二轮 · 回归契约：`restorePreviewScroll` 在未测量窗口不得走「游标」分支把
//   槽里真值记成 0。
//
//   根因（见 litepad.log 行 623-625 / 630 / 640）：拖标签分屏走 moveTabToStrip→disposePanel，
//   面板重挂载时预览容器未测量，`preview.syncToLineProgrammatic(v)` 把 v→px 算成 0
//   （返回 0 而非 null，不像 `restoreViewScroll` 里 `sourceTopOfV` 返回 null 能自然兜底），
//   于是 `recordScroll(0)` + `return` 把槽里 2886 抹成 0（源码 tab=2 因有同款守卫而还原正常）。
//   jsdom 造不出未测量窗口（`syncToLineProgrammatic` 走真实块几何），故走静态契约 +
//   反向验证，与 B126 / remember-scroll-unmeasured 同口径。真机行为由用户复现 + trace 坐实。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const RAW = readFileSync("src/sync-scroll.ts", "utf-8").replace(/\r\n/g, "\n");

/** 取出 `restorePreviewScroll` 的函数体（首次出现，避免被 import 块截歪）。 */
function restorePreviewBody(): string {
  const start = RAW.indexOf("export function restorePreviewScroll(panel: Panel): void {");
  if (start < 0) throw new Error("应能定位 restorePreviewScroll");
  const next = RAW.indexOf("\nexport function", start + 10);
  const end = next < 0 ? RAW.length : next;
  return RAW.slice(start, end);
}

describe("B288 二轮 restorePreviewScroll 未测量不许走游标记 0", () => {
  it("游标分支必须被 previewGeometryUnready 守卫挡住（B288⑤-3 收口后的具名查询）", () => {
    const body = restorePreviewBody();
    // B288⑤-3：守卫收口到具名查询 `previewGeometryUnready`（语义拆分：unmeasuredPanels
    // 是 CM6 measure 的标记、不是预览的信号；预览侧借用必须走收口，不许内联 has）。
    expect(body, "restorePreviewScroll 必须走具名守卫").toContain("previewGeometryUnready(panel)");
    expect(body, "不许内联 unmeasuredPanels.has").not.toContain("unmeasuredPanels.has(panel)");
    // syncToLineProgrammatic 的真实调用（带 `preview.` 前缀与 `(`，以避开函数体注释里
    // 反引号提及的同名词）必须排在该守卫之后（在受保护的块内）
    const guardPos = body.indexOf("previewGeometryUnready(panel)");
    const syncPos = body.indexOf("preview.syncToLineProgrammatic(");
    expect(guardPos, "应能定位守卫").toBeGreaterThan(-1);
    expect(syncPos, "应能定位 preview.syncToLineProgrammatic 真实调用").toBeGreaterThan(-1);
    expect(
      syncPos,
      "syncToLineProgrammatic 必须在守卫之后（受未测量保护，否则会算成 0 记槽）",
    ).toBeGreaterThan(guardPos);
  });

  it("反向验证：删掉 previewGeometryUnready 守卫，上面的判定必须失效", () => {
    const body = restorePreviewBody();
    const guard = "!previewGeometryUnready(panel)";
    expect(body, "前置：固定代码确有守卫").toContain(guard);
    // 退化：把守卫条件换成 true，模拟 pre-fix「游标分支无条件执行」行为
    const degraded = body.replace(guard, "true /* guard removed */");
    expect(degraded, "退化：应真的摘掉了守卫那一层").not.toBe(body);
    expect(degraded, "退化后具名守卫必须消失（否则上面的 toContain 形同虚设）").not.toContain(
      guard,
    );
  });
});

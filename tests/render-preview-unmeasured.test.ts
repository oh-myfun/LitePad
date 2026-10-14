// @vitest-environment jsdom
// B288 三轮 · 回归契约：`applySyncToLine`（同步游标 v → 预览像素的**唯一换算点**，
//   被 B279 补落 `renderMarkdownFor`、restorePreviewScroll 游标支、pushSyncToSiblings 预览支、
//   applyPending 共用）在**块几何不可用**（容器未铺开 / display:none / 刚挂载尚未 layout，
//   块与容器 rect 全 0）时**必须返回 null**，而非算成 0。
//
//   根因（21:07 复现 litepad.log）：拖标签分屏 → disposePanel→rebuild→applyPanelMode→
//   renderMarkdownFor→setBlocks(归0)→B279 补落调 `syncToLineProgrammatic(v)`。此刻预览容器
//   未铺开，块 rect 全 0 ⇒ `blockTop` 算出的 `top` 为 0 ⇒ 返回 0（而非 null，不像
//   `sourceTopOfV` 返回 null 能自然兜底）→ B279 补落 `recordScroll(0)` 把槽里 600 抹成 0、
//   预览视觉钉回开头。
//
//   修复落在换算点本身：返回 null ⇒ 所有调用方走兜底（restorePreviewScroll 的 pinScrollTop
//   按槽里真值自愈、B279 补落 `if (landed !== null)` 跳过）。jsdom 测试桩（preview-sync /
//   sync-drag-split）给块 / 容器非 0 几何，照常落点、不受影响。
//
//   jsdom 默认 getBoundingClientRect 全 0、无法构造「真机未铺开」的确定性几何，故走静态契约
//   + 反向验证，与 B126 / remember-scroll-unmeasured / restore-preview-unmeasured 同口径。
//   真机行为由用户复现 + trace 坐实。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const RAW = readFileSync("src/markdown/preview.ts", "utf-8").replace(/\r\n/g, "\n");

/** 取出 `applySyncToLine` 的函数体（按签名定位，避免被 import 块截歪）。 */
function applySyncToLineBody(): string {
  const start = RAW.indexOf("private applySyncToLine(line: number): number | null {");
  if (start < 0) throw new Error("应能定位 applySyncToLine");
  const next = RAW.indexOf("\n  private ", start + 10);
  const end = next < 0 ? RAW.length : next;
  return RAW.slice(start, end);
}

describe("B288 三轮 applySyncToLine 块几何不可用必须返回 null", () => {
  it("换算点必须认「块 rect 全 0 且容器高 0」并早退返回 null（与 restoreViewScroll 同款兜底）", () => {
    const body = applySyncToLineBody();
    // 必须同时认块 rect 全 0 与容器高 0（避免误判已铺开容器里恰好贴顶的块）。
    // prettier 会把条件折行，逐段断言，不绑定具体排版（见 preview.ts 实际换行）。
    expect(body, "applySyncToLine 必须检查容器高 0").toContain(
      "this.root.getBoundingClientRect().height === 0",
    );
    expect(body, "applySyncToLine 必须检查块 top 0").toContain("eb.top === 0");
    expect(body, "applySyncToLine 必须检查块 left 0").toContain("eb.left === 0");
    expect(body, "applySyncToLine 必须检查块 width 0").toContain("eb.width === 0");
    expect(body, "applySyncToLine 必须检查块 height 0").toContain("eb.height === 0");
    // 早退：上面的判定必须引导到一个 `return null`，且排在计算/返回 nextTop 之前
    const guardPos = body.indexOf("this.root.getBoundingClientRect().height === 0");
    // 从判定之后找「未铺开」那处早退 null（避开函数顶部 `if (!target) return null`）
    const earlyNull = body.indexOf("return null;", guardPos);
    const finalReturn = body.indexOf("return nextTop;");
    expect(guardPos, "应能定位未铺开判定").toBeGreaterThan(-1);
    expect(earlyNull, "未铺开必须早退返回 null").toBeGreaterThan(guardPos);
    expect(finalReturn, "应能定位正常落点返回").toBeGreaterThan(-1);
    expect(earlyNull, "早退 null 必须在正常落点返回之前（否则判据形同虚设）").toBeLessThan(
      finalReturn,
    );
  });

  it("反向验证：删掉未铺开判定，上面的契约必须失效", () => {
    const body = applySyncToLineBody();
    const guard = "this.root.getBoundingClientRect().height === 0";
    expect(body, "前置：固定代码确有未铺开判定").toContain(guard);
    // 退化：把判定条件换成 false，模拟 pre-fix「无几何校验、必然算成 0」行为
    const degraded = body.replace(guard, "false /* guard removed */");
    expect(degraded, "退化：应真的摘掉了判定那一层").not.toBe(body);
    expect(degraded, "退化后未铺开判定必须消失（否则上面的 toContain 形同虚设）").not.toContain(
      guard,
    );
  });
});

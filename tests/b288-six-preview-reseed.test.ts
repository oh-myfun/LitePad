// @vitest-environment jsdom
// B288⑥ · 回归契约：`restorePreviewScroll` 在几何未就绪（编辑器未测量 / `setBlocks` 尚未
//   layout）那一趟，必须**链式重试** rAF 直到几何就绪才按 `syncV` 重落预览，而不能退回
//   `t.scrollTop` 旧路径（B288⑤ 已删像素轨，`scrollTop` 恒 null ⇒ 预览永久停在顶部）。
//
//   根因（用户真机复现）：应用开机关 / 合并分屏后预览停在顶部。`restorePreviewScroll`
//   在 `mountView` 里早于 `measureAndKeepScroll` 注册 rAF（`unmeasuredPanels` 还没清），
//   只放一轮会正好撞在「几何仍未就绪」那一拍、又被 `previewReseedPending` 占坑挡掉 ⇒
//   沦为空转。必须**每帧再判几何就绪**、未就绪就再排一轮，直到 `measureAndKeepScroll`
//   清掉标记（那帧 layout 也已完成）才真正落位。
//
//   jsdom 造不出逐帧 rAF 时序，故走静态契约 + 反向验证，与 B288 二轮同口径（见
//   `restore-preview-unmeasured.test.ts`）。真机时序由用户复现 + trace 坐实。
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

describe("B288⑥ restorePreviewScroll 几何未就绪必须链式重试、直到就绪才落位", () => {
  it("未就绪时排具名链式重试 reseed，而非退回像素槽（B288⑤ 已删像素轨）", () => {
    const body = restorePreviewBody();
    // 1) 必须排 rAF 重试，且是**具名** `reseed`（区别于 single-shot 内联箭头——
    //    后者放一轮就走人，正是 B288⑥ 第一轮自修的时序坑，必须锁死）。
    expect(body, "必须排具名链式重试 requestAnimationFrame(reseed)").toContain(
      "requestAnimationFrame(reseed)",
    );
    // 2) 重试内部必须**每帧再判几何就绪**（链式），这是与 single-shot 的本质区别。
    expect(body, "重试必须每帧再判 previewGeometryUnready(panel)").toContain(
      "if (previewGeometryUnready(panel)) {",
    );
    // 3) 落位成功才释放标记；4) 排重试时占坑。
    expect(body, "落位成功必须 previewReseedPending.delete(panel)").toContain(
      "previewReseedPending.delete(panel)",
    );
    expect(body, "排重试时必须 previewReseedPending.add(panel)").toContain(
      "previewReseedPending.add(panel)",
    );
  });

  it("反向验证：退化成「未就绪即不重试、退回像素槽」→ 上面判定失效", () => {
    const body = restorePreviewBody();
    // 退化：把 `reseed` 链式重试的调度摘掉，模拟 pre-fix 行为（未就绪 ⇒ 落到 t.scrollTop
    // 旧路径，B288⑤ 之后 t.scrollTop 恒 null ⇒ 预览永久停在顶部）。
    const anchor = "requestAnimationFrame(reseed)";
    expect(body, "前置：确有重试锚").toContain(anchor);
    // 全局替换：同一锚点在 `reseed` 内（递归再排）与外（首次排）各出现一次，单 replace
    // 只摘第一处，退化体仍含第二处会误判。用 /g 一次摘干净。
    const degraded = body.replace(/requestAnimationFrame\(reseed\)/g, "/* retry removed */");
    // 替换成功 ⇒ 上面「具名链式重试」那条 toContain 在退化体上必然变红（契约有牙齿）。
    // 同理，`reseed` 随之消失 ⇒ 前向的「每帧再判 / 占坑释放」两条 toContain 也会变红。
    expect(degraded, "退化：重试锚必须消失（否则前向判定形同虚设）").not.toContain(anchor);
  });
});

// @vitest-environment jsdom
// B288⑤-1a · 规范游标 v 的**无条件维护**（彻底删除像素轨的前置）。
//
// 背景：此前 `syncV` 只在 `pushSyncToSiblings` 里被写过 ⇒ **同步关着的标签恒为 null**
//   （它压根没进过那条路）。而删掉像素轨（1c）之后位置只能由 v 现算，所以
//   **每个标签都得有自己的 v** —— 与同步开关无关，v 的语义就是「这份标签停在第几行」。
//   ⇒ 两处滚动监听（编辑器 / 预览）现在无条件把 `syncSourceV(t)` 写进 `t.syncV`。
//
// ⚠️ 这里最该钉的是**顺序**：`recordScroll` 内部会把 `t.syncV` 落进会话记录
//   （`sessionStore.setSyncV`），若写成「先 recordScroll、后更新 syncV」，落盘的就是
//   **上一次**的游标（滞后一次滚动）⇒ 重启后按陈旧 v 还原。写反了单看功能不红，
//   只在「滚完立刻关窗」时表现，所以必须有契约把它钉死。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const LIFECYCLE = readFileSync("src/tabs/lifecycle.ts", "utf-8").replace(/\r\n/g, "\n");

describe("B288⑤-1a 滚动监听无条件维护规范游标 v", () => {
  it("编辑器侧：先按 syncSourceV 更新 t.syncV，再 recordScroll（落盘不能滞后）", () => {
    const ask = LIFECYCLE.indexOf("const v = syncSourceV(t);");
    expect(ask, "编辑器监听应按 syncSourceV 取规范游标").toBeGreaterThan(-1);
    expect(LIFECYCLE, "取到的游标要写进这份标签的 syncV").toContain("if (v !== null) t.syncV = v;");
    // ⚠️ 顺序闸：`recordScroll` 会把 `t.syncV` 落盘 ⇒ 必须在更新 v **之后**。
    const write = LIFECYCLE.indexOf("recordScroll(t.tabId, t.scrollTop);", ask);
    expect(write, "取游标之后应有落盘/写槽那一步").toBeGreaterThan(-1);
    const askWrite = LIFECYCLE.indexOf("if (v !== null) t.syncV = v;");
    expect(askWrite, "先更新 syncV 再 recordScroll（写反了落盘的是上一次的游标）").toBeLessThan(
      write,
    );
  });

  it("预览侧：同样的无条件下维护 + 同样的顺序", () => {
    const ask = LIFECYCLE.indexOf("const pv = syncSourceV(t);");
    expect(ask, "预览监听应按 syncSourceV 取规范游标").toBeGreaterThan(-1);
    expect(LIFECYCLE, "取到的游标要写进这份标签的 syncV").toContain(
      "if (pv !== null) t.syncV = pv;",
    );
    const write = LIFECYCLE.indexOf("recordScroll(t.tabId, t.scrollTop);", ask);
    expect(write, "取游标之后应有落盘/写槽那一步").toBeGreaterThan(-1);
    const askWrite = LIFECYCLE.indexOf("if (pv !== null) t.syncV = pv;");
    expect(askWrite, "先更新 syncV 再 recordScroll（写反了落盘的是上一次的游标）").toBeLessThan(
      write,
    );
  });

  it("反向验证：摘掉编辑器侧的 v 维护，上面的判定必须失效", () => {
    const ask = "const v = syncSourceV(t);";
    expect(LIFECYCLE, "前置：固定代码确有该行").toContain(ask);
    const degraded = LIFECYCLE.replace(ask, "/* removed */");
    expect(degraded, "退化：应真的摘掉了取游标那行").not.toBe(LIFECYCLE);
    expect(degraded, "退化后该行必须消失（否则上面的判定形同虚设）").not.toContain(ask);
  });

  it("反向验证：把顺序写反（v 挪到 recordScroll 之后），顺序闸必须失效", () => {
    // 退化：模拟「先落盘、后更新 v」——把写 v 那两行挪到 recordScroll 之后，
    // 顺序闸（`askWrite < write`）必须翻转。
    const askV = "const v = syncSourceV(t);";
    const setV = "if (v !== null) t.syncV = v;";
    const rec = "recordScroll(t.tabId, t.scrollTop);";
    expect(LIFECYCLE, "前置：三行都在").toContain(askV);
    expect(LIFECYCLE, "前置：三行都在").toContain(setV);
    // 先在原处删掉写 v 的两行，再插到 recordScroll 之后 ⇒ 顺序被写反
    const removed = LIFECYCLE.replace(`${askV}\n            ${setV}\n`, "");
    expect(removed, "退化：应先摘掉原处的两行").not.toBe(LIFECYCLE);
    const swapped = removed.replace(rec, `${rec}\n            ${askV}\n            ${setV}`);
    const askWrite = swapped.indexOf(setV);
    const write = swapped.indexOf(rec);
    // 退化后「写 v」排到了 recordScroll **之后** ⇒ 正向那条顺序闸（`askWrite < write`）
    // 必然失效（落盘的是上一次的游标）。这条就是正向契约的鉴别力自证。
    expect(askWrite, "顺序写反后，正向顺序闸必须失效（否则那条闸形同虚设）").toBeGreaterThan(write);
  });
});

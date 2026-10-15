import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * P1-IPC 收口：验证 `emitCrossWindow` 自动注入 `from` = 当前窗口 label，
 * 以及 `convertFileSrc` 从 `@tauri-apps/api/core` 再导出收口。
 *
 * 这块之前是散落的 `emit(event, { from: windowLabel, ... })` 手写形态，
 * 容易漏写 `from` 或被悄悄改成别的字段名。运行时测试兜底证明「身份真的进去了」，
 * 静态契约（multiwindow / satellite-lifecycle）只管「走的是 emitCrossWindow」。
 */

// emit 的调用被这里捕获，才能在测试里断言真实入参。
const emitSpy = vi.hoisted(() =>
  vi.fn<(event: string, payload: Record<string, unknown>) => Promise<void>>(() =>
    Promise.resolve(),
  ),
);

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "sat-7" }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload: Record<string, unknown>) => emitSpy(event, payload),
  listen: () => Promise.resolve({ unlisten: () => {} }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: () => Promise.resolve(),
}));

import { emitCrossWindow, convertFileSrc } from "../src/ipc/api";

describe("ipc/api 收口", () => {
  beforeEach(() => {
    emitSpy.mockClear();
  });

  it("emitCrossWindow 自动注入 from = 当前窗口 label，并透传其余载荷", async () => {
    await emitCrossWindow("doc-open", { docId: 3, v: 12.5 });
    expect(emitSpy, "emit 只调一次").toHaveBeenCalledTimes(1);
    const [event, payload] = emitSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(event, "事件名原样透传").toBe("doc-open");
    expect(payload.from, "from 必须是当前窗口身份").toBe("sat-7");
    expect(payload.docId, "业务载荷原样透传").toBe(3);
    expect(payload.v, "业务载荷原样透传").toBe(12.5);
  });

  it("emitCrossWindow 的 from 不能被调用方覆盖（对象展开后者胜出）", async () => {
    // 调用方若误传 from，应被我们注入的 from 覆盖，保证身份唯一可信。
    await emitCrossWindow("doc-resync-request", { from: "fake-window", docId: 1 });
    const payload = emitSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.from, "注入的 from 必须压过调用方传入的 from").toBe("sat-7");
    expect(payload.docId).toBe(1);
  });

  it("convertFileSrc 从 @tauri-apps/api/core 再导出收口", () => {
    expect(convertFileSrc("C:\\a\\b.png")).toBe("asset://C:\\a\\b.png");
  });
});

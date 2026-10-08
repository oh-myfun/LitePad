// @vitest-environment jsdom
// B272：启动错误红条（`#boot-error-overlay`）的行为契约。
//
// 真机症状：预览底部留白的 RO 自反馈成环后，每帧一条
// `ResizeObserver loop completed with undelivered notifications` 被 `index.html` 的全局
// error 监听**逐条**渲染进顶部红条 ⇒ 红条堆满屏（用户报「软件启动报错」），日志几秒几百 KB。
//
// 这条用例**直接执行 index.html 里那段内联经典脚本**（不是复刻一份逻辑 —— 复刻的判据
// 在产品改了之后照样绿，是假绿），然后真派发 `error` 事件，断言覆盖层的行为。
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { readFileSync } from "node:fs";

/** 把 index.html 里那段「启动错误上报」的经典脚本抠出来（真机上就是它在跑）。 */
function bootErrorScript(): string {
  const html = readFileSync("index.html", "utf-8").replace(/\r\n/g, "\n");
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1],
  );
  const hit = blocks.filter((b) => b.includes("boot-error-overlay"));
  if (hit.length !== 1) throw new Error(`启动错误脚本没找到或不止一段（${hit.length}）`);
  return hit[0];
}

function fire(message: string): void {
  window.dispatchEvent(new ErrorEvent("error", { message }));
}
function overlay(): HTMLElement | null {
  return document.getElementById("boot-error-overlay");
}

describe("B272 启动错误红条：噪声不刷屏、真错误照样可见", () => {
  // ⚠️ 那段脚本给 window 挂的是**匿名**监听器，跨用例会累积（一条错误被渲染 N 遍 ⇒ 判据
  //    假红）。这里把它注册的监听器都记下来，每个用例结束后摘掉。
  const added: Array<[string, EventListener]> = [];
  const origAdd = window.addEventListener.bind(window);

  beforeEach(() => {
    document.body.innerHTML = "";
    added.length = 0;
    window.addEventListener = ((type: string, fn: EventListener) => {
      added.push([type, fn]);
      return origAdd(type, fn);
    }) as typeof window.addEventListener;
    // 每个用例重新执行那段脚本（它的去重表在闭包里，必须重建）
    new Function(bootErrorScript())();
  });

  afterEach(() => {
    for (const [type, fn] of added) window.removeEventListener(type, fn);
    window.addEventListener = origAdd;
  });

  it("① ResizeObserver loop 这类已知噪声**不渲染**红条（日志照记）", () => {
    fire("ResizeObserver loop completed with undelivered notifications.");
    expect(overlay(), "噪声不许堆进红条").toBeNull();
  });

  it("② 真错误照样渲染，且同一条只渲染一次（不重复堆）", () => {
    fire("TypeError: boom");
    const box = overlay();
    expect(box, "真错误必须可见（不能静默白屏）").not.toBeNull();
    const first = box?.textContent ?? "";
    expect(first).toContain("boot error: TypeError: boom");
    fire("TypeError: boom"); // 同一条再来一次
    expect(overlay()?.textContent, "同文本不许重复追加").toBe(first);
  });

  it("③ 红条条数封顶：连打 30 条不同错误也不许无限长", () => {
    for (let i = 0; i < 30; i++) fire("boom-" + i);
    const text = overlay()?.textContent ?? "";
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    // 封顶 6 条 + 1 行「后续省略」指路
    expect(lines.length, `实测 ${lines.length} 行：${text.slice(0, 120)}`).toBeLessThanOrEqual(7);
    expect(text, "末尾要指路到日志").toContain("litepad.log");
  });
});

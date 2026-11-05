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
    // 数的是**错误文本**那一格：B453-2 之后卡片上多了一颗关闭键「×」，不许把它算成一行。
    const textEl = overlay()?.querySelector(".boot-error-text");
    expect(textEl, "错误文本要装在 `.boot-error-text` 那一格里").toBeTruthy();
    const text = textEl?.textContent ?? "";
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    // 封顶 6 条 + 1 行「后续省略」指路
    expect(lines.length, `实测 ${lines.length} 行：${text.slice(0, 120)}`).toBeLessThanOrEqual(7);
    expect(text, "末尾要指路到日志").toContain("litepad.log");
  });

  // B453-2（用户）：「出错时不要让错误信息挡住标题栏等应用界面」。原来那条红带是
  // `left:0;top:0;right:0` 横贯整幅 —— 标题栏、菜单栏、标签带一起被压住，窗口键都点不到。
  it("④ 红条贴右下角，不许从窗口顶边/整幅压下来", () => {
    fire("TypeError: boom");
    const css = overlay()!.style.cssText;
    expect(css, "红条不许贴着窗口顶边（压标题栏）").not.toMatch(/(^|;)\s*top:\s*0/);
    expect(css, "红条不许拉满整幅宽度（压标签带和工具条）").not.toMatch(/(^|;)\s*left:\s*0/);
    expect(css, "红条要收进右下角").toMatch(/bottom:/);
    expect(css, "红条要收进右下角").toMatch(/right:/);
  });

  it("⑤ 红条带关闭键：点一下就不挡界面（错误仍在日志里）", () => {
    fire("TypeError: boom");
    const box = overlay()!;
    const close = box.querySelector("button");
    expect(close, "红条必须能收掉，否则一直压着界面").not.toBeNull();
    (close as HTMLElement).click();
    expect(overlay(), "点完关闭要真的从 DOM 里移除").toBeNull();
    // 关掉之后再来一条新错误，仍要能重新露出来（不许关一次就哑掉）
    fire("TypeError: later");
    expect(overlay()?.textContent, "关掉后新错误仍要可见").toContain(
      "boot error: TypeError: later",
    );
  });

  // 建卡的地方有**两处**：内联那段（打包产物加载之前）与 `src/main.ts` 的 `showFatalError`
  // （之后）。两处各写一份样式，最容易走的偏是「改了一处忘另一处」⇒ 拿同一把尺再量一遍。
  it("⑥ main.ts 那张卡与内联脚本同口径（右下角 + 可关掉）", () => {
    const ts = readFileSync("src/main.ts", "utf-8");
    const at = ts.indexOf("box.style.cssText =");
    expect(at, "main.ts 里找不到建卡那一发").toBeGreaterThan(-1);
    const css = ts.slice(at, at + 500).replace(/["\s+]/g, "");
    expect(css, "落点要和内联脚本一致").toContain("bottom:12px");
    expect(css, "不许贴着窗口顶边").not.toMatch(/(^|;)top:0/);
    expect(css, "不许拉满整幅宽度").not.toMatch(/(^|;)left:0/);
    expect(ts, "main.ts 那张卡也要有关闭键和文本格").toMatch(/close\.onclick/);
    expect(ts).toContain("boot-error-text");
  });
});

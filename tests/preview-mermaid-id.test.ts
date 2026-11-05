// @vitest-environment jsdom
// B319 真机抓到的一条：改文档第一行之后，**可见那一格**里的 mermaid 图整块消失（不是闪，是没了）。
//
// 根因在 render id：mermaid 的 `render(id, …)` 开头就是 `document.getElementById(id)?.remove()`
// （node_modules/mermaid/dist/mermaid.core.mjs:1232），而 id 取的是**每个渲染面各自**的计数器。
// 同一份 md 开两格 ⇒ 两格撞同一个 id ⇒ 后渲染那一发把前一发已经插进 DOM 的 `<svg id=…>` 删掉。
//
// B412：旧派生 DOM 预览臂删除后，这条契约落在 `enhance.ts` 的模块级 `mmdUid` 上 ——
// 装饰面的每个 mermaid widget 都请同一个出口增强，撞 id 一样会把别格刚插进去的 SVG 删掉。
//
// ⚠️ 两格必须**先后**渲染：实测 vitest 的 mock 只让同一 tick 里的第一发
// `await import("mermaid")` 落地，第二发根本进不来（那是台子的限制，不是被测代码）。
import { beforeEach, describe, expect, it, vi } from "vitest";

const ledger = vi.hoisted(() => ({ ids: [] as string[] }));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: () => Promise.resolve(),
}));

/** 忠实替身：真实 mermaid 进 body 就那一发按 id 删元素，本用例的全部杀伤力都在这行。 */
vi.mock("mermaid", () => ({
  default: {
    initialize() {},
    async render(id: string) {
      ledger.ids.push(id);
      document.getElementById(id)?.remove();
      return { svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg">图</svg>` };
    },
  },
}));

vi.mock("shiki", () => ({ codeToHtml: async () => "<pre>高亮</pre>" }));

import { enhanceMarkdown, nextEnhanceSeq } from "../src/markdown/enhance";

/** 一个「渲染面」：只有 mermaid 占位，`enhanceMarkdown` 会把它画成 SVG。 */
function mkRoot(): HTMLElement {
  const el = document.createElement("div");
  // B452 之后的占位形状（pipeline 与 widget 都发这一种）：通用类 + data-diagram 认图种。
  el.innerHTML =
    '<pre class="diagram-src mermaid-src" data-diagram="mermaid">graph TD;A-->B;</pre>';
  document.body.append(el);
  return el;
}

/** 增强阶段是 `await import()` 串起来的，排若干轮宏任务等它落定。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("两个渲染面先后增强时的 mermaid 图（B319 契约，B412 换载体）", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    ledger.ids.length = 0;
  });

  it("render id 全窗口唯一，后渲染那一发不许删掉前一面的图", async () => {
    const a = mkRoot();
    await enhanceMarkdown(a, nextEnhanceSeq(a), { bigDoc: false });
    await flush();
    const b = mkRoot();
    await enhanceMarkdown(b, nextEnhanceSeq(b), { bigDoc: false });
    await flush();

    expect(ledger.ids).toHaveLength(2);
    expect(new Set(ledger.ids).size, `id 撞车：${JSON.stringify(ledger.ids)}`).toBe(2);
    expect(a.querySelector(".md-mermaid svg"), "先渲染那一面的图还在").toBeTruthy();
    expect(b.querySelector(".md-mermaid svg"), "后渲染那一面的图还在").toBeTruthy();
  });
});

// @vitest-environment jsdom
// B319 真机抓到的一条：改文档第一行之后，**可见那一格**里的 mermaid 图整块消失（不是闪，是没了）。
//
// 根因在 render id：mermaid 的 `render(id, …)` 开头就是 `document.getElementById(id)?.remove()`
// （node_modules/mermaid/dist/mermaid.core.mjs:1232），而 id 取的是**每个 PreviewPane 各自的**
// `mermaidSeq`。同一份 md 开两格（源码格 + 预览格，两边都会渲染）⇒ 两格撞同一个 id ⇒
// 后渲染那一发把前一发已经插进 DOM 的 `<svg id=…>` 删掉。
// 岛级增量之前每格每次都重建，下一发又画回来（只表现为闪一下）；改成复用之后，被删的那格
// 再也不会重画 ⇒ 图永久消失。
//
// ⚠️ 两格必须**先后**渲染：实测 vitest 的 mock 只让同一 tick 里的第一发
// `await import("mermaid")` 落地，第二发根本进不来（那是台子的限制，不是被测代码）。
import { beforeEach, describe, expect, it, vi } from "vitest";

const ledger = vi.hoisted(() => ({ ids: [] as string[] }));

vi.mock("../src/sync-scroll/wire", () => ({
  syncCoordinator: { expectSurfaceV: vi.fn() },
  PreviewScrollAnchor: class {
    getV() {
      return 1;
    }
    setV() {}
  },
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

import { PreviewPane } from "../src/markdown/preview";
import { renderBlocks } from "../src/markdown/pipeline";

const SRC = "# 标题\n\n```mermaid\ngraph TD;A-->B;\n```\n\n正文\n";

function mk(): PreviewPane {
  const p = new PreviewPane();
  document.body.append(p.root);
  return p;
}

/** 增强阶段是 `await import()` 串起来的，排若干轮宏任务等它落定。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("同一份文档开两个预览格时的 mermaid 图（B319 真机）", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    ledger.ids.length = 0;
  });

  /** 两格各自渲染同一份文档，返回两个 pane（渲染已落定）。 */
  async function twoPanes(list = renderBlocks(SRC)): Promise<[PreviewPane, PreviewPane]> {
    const a = mk();
    a.setBlocks(list);
    await flush();
    const b = mk();
    b.setBlocks(list);
    await flush();
    return [a, b];
  }

  it("两格请求的 render id 互不相同", async () => {
    await twoPanes();
    expect(ledger.ids).toHaveLength(2);
    expect(new Set(ledger.ids).size, `id 撞车：${JSON.stringify(ledger.ids)}`).toBe(2);
  });

  it("后渲染那一格不许删掉前一格已经画好的图", async () => {
    const [a, b] = await twoPanes();
    expect(a.root.querySelector(".md-mermaid svg"), "先渲染那格的图还在").toBeTruthy();
    expect(b.root.querySelector(".md-mermaid svg"), "后渲染那格的图还在").toBeTruthy();
  });

  it("改一行之后（岛级复用）两格的图仍然在", async () => {
    const [a, b] = await twoPanes();
    const next = renderBlocks(SRC.replace("# 标题", "# 标题改过了"));
    a.setBlocks(next);
    b.setBlocks(next);
    await flush();
    expect(a.root.querySelectorAll(".md-mermaid svg").length, "复用之后图不许丢").toBe(1);
    expect(b.root.querySelectorAll(".md-mermaid svg").length).toBe(1);
  });
});

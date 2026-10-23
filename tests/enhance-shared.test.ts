// @vitest-environment jsdom
// B352-2 增强层抽成共享出口 `enhanceMarkdown(root, seq, opts)`。
//
// 为什么要抽：即时渲染（IR）的块 widget 建好 DOM 后需要同样的增强（公式 / 高亮 / 图表 /
// 相对路径图片），否则 IR 里的代码块没颜色、公式还是 `$$…$$` 文本 —— 那会砸掉
// 「IR 与只读预览观感一致」这个卖点。两处各写一份增强就是两份懒加载守卫必然漂移。
//
// 判据分两层：
//   · 行为层走**图片**那一段（纯 DOM，jsdom 里跑得动，并且顺手钉住评审 I5：
//     复用岛里必须按 `data-rel-src` 重算，拿 `src` 判相对路径等于永远不重算）；
//   · 结构层静态判「三个动态 import 只住在 enhance.ts」「两个计数器在模块级」。
//     过期 seq 早退那条**只能静态判** —— 要触发它得先 await 一次真动态 import，
//     在 jsdom 里等于把 3.5MB 的 mermaid 拉进来，不值得。
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { stripLineComments } from "./static";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: () => Promise.resolve(),
}));

import { enhanceMarkdown, nextEnhanceSeq } from "../src/markdown/enhance";

/** 造一个渲染容器：IR 的 widget 根与预览根都带 `.md-rendered`（B352-1）。 */
function rendered(html: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "md-rendered";
  el.innerHTML = html;
  return el;
}

describe("B352-2 enhanceMarkdown 共享出口", () => {
  it("相对路径图片按 baseDir 换成 asset 地址", async () => {
    const root = rendered('<p><img src="pic/a.png" alt=""></p>');
    await enhanceMarkdown(root, nextEnhanceSeq(), { bigDoc: false, baseDir: "C:\\docs" });
    const img = root.querySelector("img")!;
    expect(img.dataset.relSrc, "相对原值要记在 data-rel-src 上").toBe("pic/a.png");
    expect(img.getAttribute("src")).toBe("asset://C:\\docs\\pic/a.png");
  });

  it("换文档后同一张图按**新**目录重算（评审 I5 的回归）", async () => {
    const root = rendered('<img src="pic/a.png">');
    await enhanceMarkdown(root, nextEnhanceSeq(), { bigDoc: false, baseDir: "C:\\one" });
    await enhanceMarkdown(root, nextEnhanceSeq(), { bigDoc: false, baseDir: "D:\\two" });
    expect(
      root.querySelector("img")!.getAttribute("src"),
      "src 已经是 asset 地址，判相对必须看 data-rel-src",
    ).toBe("asset://D:\\two\\pic/a.png");
  });

  it("绝对 / 网络 / data / 锚点图片一律不动", async () => {
    const root = rendered(
      '<img src="https://x/y.png"><img src="data:image/png;base64,AA"><img src="/abs.png">',
    );
    await enhanceMarkdown(root, nextEnhanceSeq(), { bigDoc: false, baseDir: "C:\\docs" });
    const [net, data, abs] = [...root.querySelectorAll("img")];
    expect(net.getAttribute("src")).toBe("https://x/y.png");
    expect(data.getAttribute("src")).toBe("data:image/png;base64,AA");
    expect(abs.getAttribute("src")).toBe("/abs.png");
    expect(net.dataset.relSrc, "不动的图不该被记账").toBeUndefined();
  });

  it("没有 baseDir（未命名文档）时不碰任何 src", async () => {
    const root = rendered('<img src="pic/a.png">');
    await enhanceMarkdown(root, nextEnhanceSeq(), { bigDoc: false, baseDir: null });
    expect(root.querySelector("img")!.getAttribute("src")).toBe("pic/a.png");
  });
});

describe("B352-2 结构判据：增强只有一份", () => {
  const pv = stripLineComments(readFileSync("src/markdown/preview.ts", "utf-8"));
  const en = stripLineComments(readFileSync("src/markdown/enhance.ts", "utf-8"));

  for (const lib of ["katex", "shiki", "mermaid"]) {
    it(`${lib} 的动态 import 只住在 enhance.ts`, () => {
      expect(pv, `preview.ts 不该再自己 import("${lib}")`).not.toMatch(
        new RegExp(`import\\("${lib}"\\)`),
      );
      expect(en, `enhance.ts 里要有 ${lib}`).toMatch(new RegExp(`import\\("${lib}"\\)`));
    });
  }

  it("两个计数器在模块级 —— 每格各数一份会撞 id、把别格刚画好的 SVG 删掉（B319 真机抓到）", () => {
    expect(en, "mermaid render id 计数器在模块级").toMatch(/^let mmdUid\s*=\s*0/m);
    expect(en, "seq 计数器在模块级（跨格共享一个序列）").toMatch(/^let seqCounter\s*=\s*0/m);
    expect(en, "过期那一发必须早退").toMatch(/seq\s*!==\s*latestSeq/);
  });

  it("预览那边只剩薄包装（不再自己数 seq）", () => {
    expect(pv, "PreviewPane 里不该再有 mermaidSeq 字段").not.toMatch(/private mermaidSeq/);
    expect(pv, "预览调的是共享出口").toMatch(/enhanceMarkdown\(/);
  });
});

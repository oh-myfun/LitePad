// @vitest-environment jsdom
// B352-2 增强层抽成共享出口 `enhanceMarkdown(root, seq, opts)`。
//
// 为什么要抽：渲染面建好 DOM 后需要同样的增强（公式 / 高亮 / 图表 /
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

import { enhanceMarkdown, isEnhanceStale, nextEnhanceSeq } from "../src/markdown/enhance";

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
    await enhanceMarkdown(root, nextEnhanceSeq(root), { bigDoc: false, baseDir: "C:\\docs" });
    const img = root.querySelector("img")!;
    expect(img.dataset.relSrc, "相对原值要记在 data-rel-src 上").toBe("pic/a.png");
    expect(img.getAttribute("src")).toBe("asset://C:\\docs\\pic/a.png");
  });

  it("换文档后同一张图按**新**目录重算（评审 I5 的回归）", async () => {
    const root = rendered('<img src="pic/a.png">');
    await enhanceMarkdown(root, nextEnhanceSeq(root), { bigDoc: false, baseDir: "C:\\one" });
    await enhanceMarkdown(root, nextEnhanceSeq(root), { bigDoc: false, baseDir: "D:\\two" });
    expect(
      root.querySelector("img")!.getAttribute("src"),
      "src 已经是 asset 地址，判相对必须看 data-rel-src",
    ).toBe("asset://D:\\two\\pic/a.png");
  });

  it("绝对 / 网络 / data / 锚点图片一律不动", async () => {
    const root = rendered(
      '<img src="https://x/y.png"><img src="data:image/png;base64,AA"><img src="/abs.png">',
    );
    await enhanceMarkdown(root, nextEnhanceSeq(root), { bigDoc: false, baseDir: "C:\\docs" });
    const [net, data, abs] = [...root.querySelectorAll("img")];
    expect(net.getAttribute("src")).toBe("https://x/y.png");
    expect(data.getAttribute("src")).toBe("data:image/png;base64,AA");
    expect(abs.getAttribute("src")).toBe("/abs.png");
    expect(net.dataset.relSrc, "不动的图不该被记账").toBeUndefined();
  });

  it("没有 baseDir（未命名文档）时不碰任何 src", async () => {
    const root = rendered('<img src="pic/a.png">');
    await enhanceMarkdown(root, nextEnhanceSeq(root), { bigDoc: false, baseDir: null });
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

  it("两个计数器在模块级 —— 但**只有 id 计数器该全局**（seq 分域见下一段）", () => {
    expect(
      en,
      "mermaid render id 计数器在模块级（每格各数一份会撞 id、把别格刚画好的 SVG 删掉）",
    ).toMatch(/^let mmdUid\s*=\s*0/m);
    expect(en, "seq 计数器仍在模块级（只是个发号器）").toMatch(/^let seqCounter\s*=\s*0/m);
  });

  // B352-11（评审 C2，推翻台账 Task 2 那条裁定）：把 seq 提到模块级时，两个计数器被我当成
  // 了同一件事。`mmdUid` 要全局，`seq` 的语义却是「**同一个容器**上后发的一发作废先发的那发」。
  // 全局之后：IR 一次画 N 块、每块各发一发 ⇒ 后一块把前 N-1 块一起取消，而那些节点又被 eq
  // 复用、再也轮不到重跑 ⇒ 代码块永远纯文本、公式停在 `$$…$$`。主预览 + 侧边预览同时开时
  // 也是同一形互砍（搬家之前它是 `private mermaidSeq`，每格一个，跨格互不影响）。
  describe("B352-11 过期判据按 root 分域", () => {
    it("两个 root 各发一发 ⇒ 两发都不算过期（IR 一次画 N 块正是这一形）", () => {
      const a = rendered('<img src="pic/a.png">');
      const b = rendered('<img src="pic/b.png">');
      const seqA = nextEnhanceSeq(a);
      nextEnhanceSeq(b);
      expect(isEnhanceStale(a, seqA), "B 那一发不许把 A 判过期").toBe(false);
      expect(isEnhanceStale(b, nextEnhanceSeq(b)), "刚发的那一发当然不算过期").toBe(false);
    });

    it("同一个 root 上的后发一发把先发判过期（原语义不许丢）", () => {
      const a = rendered('<img src="pic/a.png">');
      const first = nextEnhanceSeq(a);
      nextEnhanceSeq(a);
      expect(isEnhanceStale(a, first), "同容器里先发的那一发要作废").toBe(true);
    });

    it("enhanceMarkdown 内部问的是分域判据，不是一张全局表", () => {
      expect(en, "每一段 await 之后都要复检分域判据").toMatch(/isEnhanceStale\(root,\s*seq\)/);
      expect(en, "全局 `latestSeq` 比较是这一族 bug 的形状").not.toMatch(/seq\s*!==\s*latestSeq/);
      expect(
        (en.match(/isEnhanceStale\(root,\s*seq\)/g) ?? []).length,
        "三处 await 之后各复检一次（katex / shiki / mermaid）",
      ).toBeGreaterThanOrEqual(3);
    });

    it("预览面按自己的 root 取号", () => {
      const pv = stripLineComments(readFileSync("src/markdown/preview.ts", "utf-8"));
      expect(pv, "预览按自己的根容器取号").toMatch(/nextEnhanceSeq\((this\.root|root)\)/);
    });
  });

  it("预览那边只剩薄包装（不再自己数 seq）", () => {
    expect(pv, "PreviewPane 里不该再有 mermaidSeq 字段").not.toMatch(/private mermaidSeq/);
    expect(pv, "预览调的是共享出口").toMatch(/enhanceMarkdown\(/);
  });
});

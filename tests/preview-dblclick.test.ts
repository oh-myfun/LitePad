// @vitest-environment jsdom
// B322：预览区双击**不再**切回源码（用户要求去掉 B319-A3 那一下）。
//
// 这一支整份是反向守卫：将来谁再把 dblclick 接回源码侧，这里先红。
//  1) 运行时：PreviewPane 上那颗双击回调的挂点已经不存在，双击一块什么也不改。
//  2) 静态契约：五处接线（preview 监听、revealSourceLine、deps、lifecycle、main 注入）全部摘净。
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PreviewPane } from "../src/markdown/preview";
import type { MdBlock } from "../src/markdown/pipeline";

function bk(html: string, lineStart: number): MdBlock {
  return { html, lineStart, lineEnd: lineStart };
}

describe("预览双击已移除（B322）", () => {
  it("挂点不存在：PreviewPane 不再提供 setBlockDblClick", () => {
    const p = new PreviewPane();
    expect(
      (p as unknown as Record<string, unknown>).setBlockDblClick,
      "那颗回调应已摘掉",
    ).toBeUndefined();
  });

  it("双击某一块：DOM 原样不动，也不炸", () => {
    const p = new PreviewPane();
    document.body.append(p.root);
    p.setBlocks([bk("<p>一</p>", 1), bk("<p>二</p>", 3)]);
    const before = p.root.innerHTML;
    const island = p.root.querySelectorAll(".md-block")[1];
    expect(() =>
      island.querySelector("p")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    ).not.toThrow();
    expect(p.root.innerHTML).toBe(before);
  });
});

describe("接线摘净（B322 静态契约）", () => {
  const read = (p: string) => readFileSync(p, "utf-8");

  it("预览侧不再监听 dblclick", () => {
    expect(read("src/markdown/preview.ts")).not.toContain("dblclick");
  });

  it("五处接线一个都不留", () => {
    expect(read("src/markdown.ts")).not.toContain("revealSourceLine");
    const deps = read("src/tabs/deps.ts");
    expect(deps).not.toContain("revealSourceLine");
    expect(deps).not.toContain("setRevealSourceLine");
    expect(read("src/tabs/lifecycle.ts")).not.toContain("setBlockDblClick");
    expect(read("src/main.ts")).not.toContain("setRevealSourceLine");
  });
});

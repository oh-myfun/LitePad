import { describe, expect, it } from "vitest";

import { extractToc, renderBlocks, renderFull } from "../src/markdown/pipeline";

describe("markdown pipeline", () => {
  it("renderBlocks 切分顶层 block 并映射 source 行", () => {
    const src = "# 标题\n\n第一段。\n多行段落。\n\n第二段。";
    const blocks = renderBlocks(src);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    expect(blocks[0].lineStart).toBe(1);
    // 每个 block 的行区间合法
    for (const b of blocks) {
      expect(b.lineEnd).toBeGreaterThanOrEqual(b.lineStart);
      expect(b.html.length).toBeGreaterThan(0);
    }
  });

  it("GFM 表格与任务列表", () => {
    const html = renderFull("| a | b |\n| --- | --- |\n| 1 | 2 |\n");
    expect(html).toContain("<table>");
    const task = renderFull("- [x] 完成\n- [ ] 待办\n");
    expect(task).toContain('type="checkbox"');
    expect(task).toContain("checked");
  });

  it("数学占位输出（行内与块级）", () => {
    const html = renderFull("质能方程 $E=mc^2$ 与\n\n$$\\int_0^1 x dx$$\n");
    expect(html).toContain('class="math-inline-src"');
    expect(html).toContain('class="math-display-src"');
  });

  it("Mermaid 围栏输出占位 pre", () => {
    const html = renderFull("```mermaid\ngraph TD; A-->B;\n```\n");
    expect(html).toContain('class="mermaid-src"');
    expect(html).not.toContain("<code");
  });

  it("代码围栏带语言标注", () => {
    const html = renderFull("```rust\nfn main() {}\n```\n");
    expect(html).toContain('data-lang="rust"');
  });

  it("extractToc 提取标题层级与行号", () => {
    const src = "# 一级\n\n正文\n\n## 二级 A\n\n## 二级 B\n\n### 三级\n";
    const toc = extractToc(src);
    expect(toc.map((t) => [t.level, t.line])).toEqual([
      [1, 1],
      [2, 5],
      [2, 7],
      [3, 9],
    ]);
    expect(toc[1].text).toBe("二级 A");
  });

  it("extractToc 重复标题生成唯一 id", () => {
    const toc = extractToc("# 重复\n\n## 重复\n\n## 重复\n");
    const ids = new Set(toc.map((t) => t.id));
    expect(ids.size).toBe(toc.length);
  });

  it("标题渲染带锚点 id", () => {
    const html = renderFull("# Hello World\n");
    expect(html).toMatch(/<h1 id="h-hello-world">/);
  });
});

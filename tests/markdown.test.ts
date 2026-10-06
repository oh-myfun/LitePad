import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

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

  it("B244：收尾 token（*_close）不算新块 —— 每个标题/段落只交一块", () => {
    // 退化锚点：早先这里按 `t.level === 0` 一律另起 block，而 markdown-it 的
    // heading/paragraph 都是「open(level0) → inline(level1) → close(level0)」三段 ⇒
    // 每个标题被切成「开标签块 + 闭标签块」两块：24 行标题交出 48 块、闭标签块
    // `lineStart` 恒为 1、html 只有 `</h1>`。这些空壳块混进预览的 `this.blocks` 后，
    // `indexOfBlockAtOffset` 永远命中顶边相同却 lineStart=1 的伪块 ⇒
    // 预览那份游标恒为 1（B257 后 = 块首行 + 0 比例的 `v`）⇒ 跨侧收口把源码钉回第 1 行
    // （B244 四标签复核）。
    const src = Array.from({ length: 24 }, (_, i) => `# 标题 ${i + 1}`).join("\n");
    const blocks = renderBlocks(src);
    expect(blocks).toHaveLength(24); // 不是一个块对两段 token
    blocks.forEach((b, i) => {
      expect(b.lineStart, `第 ${i + 1} 块的行号`).toBe(i + 1); // 行号严格一一对应
      expect(b.html, `第 ${i + 1} 块要含正文`).toContain(`标题 ${i + 1}`);
      expect(b.html, `第 ${i + 1} 块必须是完整闭合（不许只有开标签/只有闭标签）`).toContain(
        "</h1>",
      );
    });
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

describe("md 扩展名清单必须多处一致", () => {
  // md 扩展名清单在多个文件各写一份，必须同步。
  // B70 三档（菜单开着不弹提示 / 删菜单项提示 / 命令面板两处修复）的行为断言见文件
  // 末尾的「B70 提示与菜单」块 —— 这里不再重复同一约束，否则改一处要同步两处。
  it("md 扩展名集合在多处各写了一份，必须完全一致", () => {
    // filedrop 里那份随 B70 B 档判据改动删掉了，剩下的三处（main ×2 + outline）仍要同步：
    // 不一致会出现「面板认它是 Markdown、导出却不认」这种半吊子状态。
    // ⚠️ 只比 Markdown 那一条：outline 里还另有一组「配置类扩展名」，那不是同一件事。
    const outline = readFileSync("src/markdown/outline.ts", "utf-8");
    const mainSrc = readFileSync("src/main.ts", "utf-8");
    const literals = [...`${mainSrc}\n${outline}`.matchAll(/\\\.\([a-z|]+\)\$/g)]
      .map((m) => m[0])
      .filter((s) => s.includes("markdown"));
    expect(literals.length, "至少三处（main ×2 + outline ×1）").toBeGreaterThanOrEqual(3);
    expect(new Set(literals).size, "各处必须完全一致").toBe(1);
    expect(literals[0]).toBe("\\.(md|markdown|mdown|mkd)$");
  });
});

// @vitest-environment jsdom
// B401 · 预览里的原始 HTML：跟 VS Code 的 Markdown 预览一样**渲染**，但先消毒。
import { describe, expect, it } from "vitest";

import { renderBlocks, renderFull } from "../src/markdown/pipeline";
import { sanitizeHtmlString } from "../src/markdown/sanitize";

describe("B401 HTML 渲染", () => {
  it("块级 HTML 原样渲染进预览岛", () => {
    const blocks = renderBlocks('<div class="note">你好</div>\n\n后面一段。\n');
    expect(blocks[0].html).toContain('<div class="note">你好</div>');
    expect(blocks[1].html).toContain("后面一段。");
  });

  it("行内 HTML 也渲染", () => {
    const html = renderFull("前 <b>粗</b> 后\n");
    expect(html).toContain("<b>粗</b>");
  });

  it("script / iframe / style 一律剥掉", () => {
    const html = renderFull(
      '<div>安全</div>\n\n<script>alert(1)</script>\n\n<iframe src="https://x"></iframe>\n',
    );
    expect(html).toContain("安全");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("alert(1)");
  });

  it("事件属性与 javascript: 链接剥掉，正常属性保留", () => {
    const html = renderFull(
      '<img src="https://x/a.png" onerror="alert(1)">\n\n<a href="javascript:alert(1)">坏</a>\n\n<a href="https://ok">好</a>\n',
    );
    expect(html).toContain("https://x/a.png");
    expect(html).not.toContain("onerror");
    expect(html).toContain('href="https://ok"');
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it("sanitizeHtmlString：混淆协议也拦（java\\nscript:）", () => {
    const clean = sanitizeHtmlString('<a href="java\nscript:alert(1)">x</a>');
    expect(clean).not.toMatch(/javascript:/i);
  });

  it("SPAN 的少数无害内联样式留着（VS Code 口径），其它元素的 style 剥掉", () => {
    const clean = sanitizeHtmlString(
      '<span style="color:#ff0000; position:absolute">红</span><div style="color:#ff0000">块</div>',
    );
    expect(clean).toContain('<span style="color:#ff0000">红</span>');
    expect(clean).not.toContain("position:absolute");
    expect(clean).not.toMatch(/<div style=/);
  });

  it("任务列表的 task-item 挂在 li 上（不是被丢掉的 hidden paragraph）", () => {
    const html = renderFull("- [ ] 甲\n- [x] 乙\n");
    expect(html).toContain('<li class="task-item">');
    expect(html).not.toContain("<p");
  });

  it("消毒不误伤生成内容：任务勾选框、公式占位、mermaid 都还在", () => {
    const html = renderFull("- [x] 完成\n\n$E=mc^2$\n\n```mermaid\ngraph TD; A-->B;\n```\n");
    expect(html).toContain('class="md-task"');
    expect(html).toContain('class="math-inline-src"');
    expect(html).toContain('class="mermaid-src"');
  });
});

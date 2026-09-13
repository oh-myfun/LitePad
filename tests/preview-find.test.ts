// @vitest-environment jsdom
// B30 预览态查找高亮/跳转：PreviewPane.applyFind / stepFind / findState
import { describe, it, expect } from "vitest";
import { PreviewPane } from "../src/markdown/preview";
import type { MdBlock } from "../src/markdown/pipeline";

function blocksOf(htmls: string[]): MdBlock[] {
  return htmls.map((html, i) => ({ html, lineStart: i * 2 + 1, lineEnd: i * 2 + 1 }));
}

function markTexts(p: PreviewPane, cls = "cm-find-match"): string[] {
  return Array.from(p.root.querySelectorAll(`mark.${cls}`)).map((m) => m.textContent ?? "");
}

describe("预览态查找（B30：高亮与跳转和源码一致）", () => {
  it("普通文本命中：全部包装为 mark，大小写不敏感默认开启", () => {
    const p = new PreviewPane();
    p.setBlocks(blocksOf(["<p>hello World and world2</p>", "<p>WORLD again</p>"]));
    const n = p.applyFind({ text: "world", caseSensitive: false, wholeWord: false, regexp: false });
    expect(n, "命中数应含 world2 里的 world").toBe(3);
    expect(markTexts(p)).toEqual(["World", "world", "WORLD"]);
    expect(p.root.textContent).toContain("hello World and world2");
  });

  it("区分大小写 / 全词 / 正则语义与编辑器一致", () => {
    const p = new PreviewPane();
    p.setBlocks(blocksOf(["<p>Foo foo foobar</p>"]));
    expect(
      p.applyFind({ text: "foo", caseSensitive: true, wholeWord: false, regexp: false }),
    ).toBe(2);
    expect(
      p.applyFind({ text: "foo", caseSensitive: true, wholeWord: true, regexp: false }),
    ).toBe(1);
    expect(
      p.applyFind({ text: "foo\\w*", caseSensitive: false, wholeWord: false, regexp: true }),
    ).toBe(3);
    // 非法正则按无命中处理
    expect(
      p.applyFind({ text: "([", caseSensitive: false, wholeWord: false, regexp: true }),
    ).toBe(0);
  });

  it("清除时还原原始文本节点（可重复应用）", () => {
    const p = new PreviewPane();
    p.setBlocks(blocksOf(["<p><strong>abc</strong> def abc</p>"]));
    p.applyFind({ text: "abc", caseSensitive: false, wholeWord: false, regexp: false });
    expect(p.root.querySelectorAll("mark").length).toBe(2);
    p.applyFind(null);
    expect(p.root.querySelectorAll("mark").length, "清除后无 mark").toBe(0);
    expect(p.root.querySelector("strong")?.textContent).toBe("abc");
    // 可重复应用
    expect(p.applyFind({ text: "def", caseSensitive: false, wholeWord: false, regexp: false })).toBe(1);
  });

  it("stepFind 设当前项高亮并到头环绕；重渲染（setBlocks）后旧标记失效、需重放", () => {
    const p = new PreviewPane();
    p.setBlocks(blocksOf(["<p>aa bb aa</p>"]));
    p.applyFind({ text: "aa", caseSensitive: false, wholeWord: false, regexp: false });
    p.stepFind(1);
    expect(p.findState()).toEqual({ active: 0, count: 2 });
    expect(p.root.querySelectorAll("mark.cm-find-match-active").length).toBe(1);
    p.stepFind(1);
    expect(p.findState().active).toBe(1);
    p.stepFind(1);
    expect(p.findState().active, "到尾环绕到第一个").toBe(0);
    p.stepFind(-1);
    expect(p.findState().active, "再上一个环绕到最后一个").toBe(1);
    // 重渲染且内容变化时 block DOM 重建：旧标记失效，由 main 层重放
    p.setBlocks(blocksOf(["<p>cc bb aa</p>"]));
    expect(p.findState()).toEqual({ active: -1, count: 0 });
    expect(p.root.querySelectorAll("mark").length).toBe(0);
  });
});

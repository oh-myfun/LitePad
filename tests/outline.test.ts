// B33 多格式大纲：toml/ini/yaml/json/py 的结构化提取 + md 转调 + 不支持格式
import { describe, it, expect } from "vitest";
import { extractOutline, outlineSupported } from "../src/markdown/outline";

const lines = (r: { text: string; level: number; line: number }[]) =>
  r.map((e) => ({ t: e.text, l: e.level, n: e.line }));

describe("多格式大纲提取（B33）", () => {
  it("TOML：段名按点分深度分层，忽略注释", () => {
    const r = extractOutline("app.toml", [
      "# 注释 [fake]",
      'title = "x"',
      "[server]",
      "[server.tls]",
      '[[products]]',
    ].join("\n"));
    expect(lines(r)).toEqual([
      { t: "server", l: 1, n: 3 },
      { t: "server.tls", l: 2, n: 4 },
      { t: "products", l: 1, n: 5 },
    ]);
  });

  it("INI：段一级，跳过注释行", () => {
    const r = extractOutline("config.ini", [
      "; 注释 [no]",
      "[General]",
      "key=1",
      "  [ Display ]  ",
    ].join("\n"));
    expect(lines(r)).toEqual([
      { t: "General", l: 1, n: 2 },
      { t: "Display", l: 1, n: 4 },
    ]);
  });

  it("YAML：缩进映射键，跳过列表项/注释/分隔符", () => {
    const r = extractOutline("a.yaml", [
      "---",
      "top:",
      "  nested:",
      "    deeper: 1",
      "  list:",
      "    - item: 2",
      "# comment: x",
      "scalar: 3",
    ].join("\n"));
    expect(lines(r)).toEqual([
      { t: "top", l: 1, n: 2 },
      { t: "nested", l: 2, n: 3 },
      { t: "deeper", l: 3, n: 4 },
      { t: "list", l: 2, n: 5 },
      { t: "scalar", l: 1, n: 8 },
    ]);
  });

  it("JSON：逐行键扫描，深度随花括号/方括号 nesting，忽略注释", () => {
    const r = extractOutline("pkg.json", [
      "{",
      '  "name": "x", // 注释 "fake": 1',
      '  "scripts": {',
      '    "build": "tsc",',
      '    "arr": [1, 2],',
      "  },",
      '  "version": "1.0"',
      "}",
    ].join("\n"));
    expect(lines(r)).toEqual([
      { t: "name", l: 1, n: 2 },
      { t: "scripts", l: 1, n: 3 },
      { t: "build", l: 2, n: 4 },
      { t: "arr", l: 2, n: 5 },
      { t: "version", l: 1, n: 7 },
    ]);
  });

  it("Python：class/def 按缩进分层，支持 async", () => {
    const r = extractOutline("m.py", [
      "class A:",
      "    def method(self):",
      "        pass",
      "",
      "    async def amethod(self):",
      "        pass",
      "",
      "def top():",
      "    pass",
      "# def fake():",
    ].join("\n"));
    expect(lines(r)).toEqual([
      { t: "class A", l: 1, n: 1 },
      { t: "def method()", l: 2, n: 2 },
      { t: "def amethod()", l: 2, n: 5 },
      { t: "def top()", l: 1, n: 8 },
    ]);
  });

  it("Markdown 仍走原有提取；txt 返回 null（不支持）", () => {
    const md = extractOutline("a.md", "# 标题\n\n## 二级\n");
    expect(md?.map((e) => e.text)).toEqual(["标题", "二级"]);
    expect(md?.[0].line).toBe(1);
    expect(extractOutline("b.txt", "# 不是标题\n")).toBeNull();
    expect(outlineSupported("c.toml")).toBe(true);
    expect(outlineSupported("d.yaml")).toBe(true);
    expect(outlineSupported("e.yml")).toBe(true);
    expect(outlineSupported("f.json")).toBe(true);
    expect(outlineSupported("g.ini")).toBe(true);
    expect(outlineSupported("h.py")).toBe(true);
    expect(outlineSupported("i.md")).toBe(true);
    expect(outlineSupported("j.txt")).toBe(false);
  });
});

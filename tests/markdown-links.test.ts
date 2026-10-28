// B401 · 链接落地口径：外链交系统浏览器、本地文件开标签、纯锚点就地滚，任何情况下
// 都不许把 WebView 导航走（B394-1 的病根）。
import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn(() => Promise.resolve());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...(args as [])),
}));

import {
  anchorCandidates,
  classifyHref,
  dirOf,
  followLink,
  normalizePath,
} from "../src/markdown/links";

function externalCalls(): string[] {
  return invoke.mock.calls
    .map((call) => call as unknown as [string, { target?: string }])
    .filter(([cmd]) => cmd === "open_external")
    .map(([, args]) => args?.target ?? "");
}

beforeEach(() => invoke.mockClear());

describe("B401 classifyHref：链接分类", () => {
  it("http / https / mailto 是外链", () => {
    expect(classifyHref("https://example.com/a?b=1", null)).toEqual({
      kind: "external",
      url: "https://example.com/a?b=1",
    });
    expect(classifyHref("HTTP://Example.com", null)).toEqual({
      kind: "external",
      url: "HTTP://Example.com",
    });
    expect(classifyHref("mailto:a@b.c", null)).toEqual({ kind: "external", url: "mailto:a@b.c" });
  });

  it("javascript / vbscript / data 一律不放行", () => {
    for (const href of [
      "javascript:alert(1)",
      "java\nscript:alert(1)",
      "vbscript:msgbox",
      "data:text/html,<b>x</b>",
    ]) {
      expect(classifyHref(href, "E:\\docs"), `不该放行：${href}`).toEqual({ kind: "none" });
    }
  });

  it("纯锚点单独一类；带 # 的文件链接只取文件那截", () => {
    expect(classifyHref("#第一节", null)).toEqual({ kind: "anchor", id: "第一节" });
    expect(classifyHref("其他.md#再说", "E:\\docs")).toEqual({
      kind: "local",
      path: "E:\\docs\\其他.md",
    });
  });

  it("相对路径按文档目录拼，并归一 `..` / 百分号编码", () => {
    expect(classifyHref("子目录/说明.md", "E:\\docs")).toEqual({
      kind: "local",
      path: "E:\\docs\\子目录\\说明.md",
    });
    expect(classifyHref("../上层/a%20b.md", "E:\\docs\\sub")).toEqual({
      kind: "local",
      path: "E:\\docs\\上层\\a b.md",
    });
  });

  it("绝对路径 / UNC / file:// 都认成本地文件", () => {
    expect(classifyHref("D:\\x\\y.md", null)).toEqual({ kind: "local", path: "D:\\x\\y.md" });
    expect(classifyHref("\\\\server\\share\\a.md", null)).toEqual({
      kind: "local",
      path: "\\\\server\\share\\a.md",
    });
    expect(classifyHref("file:///C:/docs/a%20b.md", null)).toEqual({
      kind: "local",
      path: "C:\\docs\\a b.md",
    });
  });

  it("没保存过的文档里的相对链接无法落地（不猜）", () => {
    expect(classifyHref("a.md", null)).toEqual({ kind: "none" });
  });

  it("未知协议不归本应用管，也不许漏给 WebView", () => {
    expect(classifyHref("ftp://x/y", "E:\\d")).toEqual({ kind: "none" });
  });
});

describe("B401 followLink：落地", () => {
  it("外链交 Rust open_external", async () => {
    followLink("https://example.com", { baseDir: null });
    await vi.waitFor(() => expect(externalCalls()).toEqual(["https://example.com"]));
  });

  it("本地文件交给宿主开标签，不走系统", () => {
    const opened: string[] = [];
    const result = followLink("a.md", {
      baseDir: "E:\\docs",
      openLocal: (p) => opened.push(p),
    });
    expect(result).toEqual({ kind: "local", path: "E:\\docs\\a.md" });
    expect(opened).toEqual(["E:\\docs\\a.md"]);
    expect(externalCalls()).toEqual([]);
  });

  it("纯锚点与非法协议不触发任何打开动作", () => {
    const opened: string[] = [];
    followLink("#top", { baseDir: null, openLocal: (p) => opened.push(p) });
    followLink("javascript:alert(1)", { baseDir: null, openLocal: (p) => opened.push(p) });
    expect(opened).toEqual([]);
    expect(externalCalls()).toEqual([]);
  });
});

describe("B401 路径小工具", () => {
  it("dirOf 两种分隔符都认", () => {
    expect(dirOf("E:\\docs\\a.md")).toBe("E:\\docs");
    expect(dirOf("E:/docs/a.md")).toBe("E:/docs");
  });

  it("normalizePath 收拾 . 与 ..", () => {
    expect(normalizePath("E:\\docs\\sub\\..\\a.md")).toBe("E:\\docs\\a.md");
    expect(normalizePath("E:\\docs\\.\\a.md")).toBe("E:\\docs\\a.md");
  });

  it("anchorCandidates 同时认百分号编码与 h- 前缀", () => {
    // 手写 `[x](#文末章节)`：标题 id 是 h-文末章节
    expect(anchorCandidates("%E6%96%87%E6%9C%AB%E7%AB%A0%E8%8A%82")).toEqual([
      "%E6%96%87%E6%9C%AB%E7%AB%A0%E8%8A%82",
      "文末章节",
      "h-%E6%96%87%E6%9C%AB%E7%AB%A0%E8%8A%82",
      "h-文末章节",
    ]);
    // 大纲点的就是带前缀的 id：原样也算一个候选
    expect(anchorCandidates("h-文末章节")).toContain("h-文末章节");
  });
});

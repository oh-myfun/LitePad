import { describe, expect, it } from "vitest";
import { detectLanguage } from "../src/editor/language";

describe("detectLanguage", () => {
  it("扩展名 → 主流语言", () => {
    expect(detectLanguage("a.rs").label).toBe("Rust");
    expect(detectLanguage("a.py").label).toBe("Python");
    expect(detectLanguage("a.ts").label).toBe("TypeScript");
    expect(detectLanguage("a.tsx").label).toBe("TypeScript");
    expect(detectLanguage("a.cpp").label).toBe("C++");
    expect(detectLanguage("a.hpp").label).toBe("C++");
    expect(detectLanguage("a.cs").label).toBe("C#");
    expect(detectLanguage("a.ps1").label).toBe("PowerShell");
    expect(detectLanguage("a.nsi").label).toBe("NSIS");
    expect(detectLanguage("a.diff").label).toBe("Diff");
  });

  it("大小写不敏感", () => {
    expect(detectLanguage("README.MD").label).toBe("Markdown");
    expect(detectLanguage("MAIN.C").label).toBe("C");
  });

  it("路径分隔符不影响扩展名判断", () => {
    expect(detectLanguage("src/editor/a.rs").label).toBe("Rust");
    expect(detectLanguage("C:\\dir\\a.rs").label).toBe("Rust");
  });

  it("完整文件名优先", () => {
    expect(detectLanguage("Dockerfile").label).toBe("Dockerfile");
    expect(detectLanguage("CMakeLists.txt").label).toBe("CMake");
    expect(detectLanguage("Makefile").label).toBe("Makefile");
    // Dockerfile 无扩展名场景
    expect(detectLanguage("dockerfile").label).toBe("Dockerfile");
  });

  it("Shebang 推断解释器", () => {
    expect(detectLanguage(null, "#!/usr/bin/env python3").label).toBe("Python");
    expect(detectLanguage("noext", "#!/bin/bash").label).toBe("Shell");
    expect(detectLanguage("noext", "#!/usr/bin/perl -w").label).toBe("Perl");
    expect(detectLanguage("noext", "#!/usr/bin/env -S pwsh").label).toBe("PowerShell");
  });

  it("首行魔数识别 XML / HTML", () => {
    expect(detectLanguage(null, '<?xml version="1.0"?>').label).toBe("XML");
    expect(detectLanguage(null, "<!DOCTYPE html>").label).toBe("HTML");
    expect(detectLanguage(null, "<html lang=\"en\">").label).toBe("HTML");
  });

  it("无匹配回退 Plain Text", () => {
    expect(detectLanguage(null).label).toBe("Plain Text");
    expect(detectLanguage("file.unknownext").label).toBe("Plain Text");
    expect(detectLanguage("noext").label).toBe("Plain Text");
  });

  it("高亮扩展随语言返回", () => {
    expect(detectLanguage("a.md").extension).not.toBeNull();
    expect(detectLanguage("a.rs").extension).not.toBeNull();
    expect(detectLanguage("a.txt").extension).toBeNull();
    expect(detectLanguage("a.bat").extension).toBeNull(); // legacy 无 batch，仅标签
  });
});

// 折叠服务为纯状态计算（无 DOM 依赖），沿用默认 node 环境
describe("流式语言缩进折叠（回归：JSON 等除 Markdown 外全部不可折叠）", () => {
  it("JSON 嵌套块可折叠：缩进比本行深的连续块给出 fold 范围", async () => {
    const { foldable } = await import("@codemirror/language");
    const { EditorState } = await import("@codemirror/state");
    const info = detectLanguage("test.json");
    expect(info.extension).not.toBeNull();
    const doc = ['{', '  "a": {', '    "b": 1', '  }', '}', ''].join("\n");
    const state = EditorState.create({ doc, extensions: [info.extension!] });
    // 第 1 行 `{`：缩进 0，后续 2/4 缩进 → 可折叠
    const l1 = state.doc.line(1);
    expect(foldable(state, l1.from, l1.to), "JSON 根块应可折叠").toBeTruthy();
    // 第 2 行 `"a": {`：包含更深的子块 → 可折叠
    const l2 = state.doc.line(2);
    expect(foldable(state, l2.from, l2.to), "JSON 子对象应可折叠").toBeTruthy();
    // 第 4 行 `}` 缩进回退 → 不可折叠
    const l4 = state.doc.line(4);
    expect(foldable(state, l4.from, l4.to), "缩进回退行不应成为折叠起点").toBeNull();
    // 第 5 行空行
    const l5 = state.doc.line(5);
    expect(foldable(state, l5.from, l5.to)).toBeNull();
  });

  it("Python 等缩进语言同样可折叠；Markdown 保持 Lezer 折叠不受影响", async () => {
    const { foldable } = await import("@codemirror/language");
    const { EditorState } = await import("@codemirror/state");
    const py = detectLanguage("a.py");
    const doc = ["def f():", "    if x:", "        return 1", "", "def g():", "    pass", ""].join("\n");
    const state = EditorState.create({ doc, extensions: [py.extension!] });
    const l1 = state.doc.line(1);
    const range = foldable(state, l1.from, l1.to);
    expect(range, "def f() 函数体应可折叠").toBeTruthy();
    // 折叠范围应覆盖到 return 1 行尾，且不含下一个 def
    expect(range!.to, "折叠范围应止于函数体最后").toBe(state.doc.line(3).to);
    const md = detectLanguage("a.md");
    expect(md.extension, "Markdown 扩展存在（Lezer 折叠路径不变）").not.toBeNull();
  });
});

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
    expect(detectLanguage(null, '<html lang="en">').label).toBe("HTML");
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

describe("B371 点开头文件与 VS Code 关联表", () => {
  it("点开头的忽略文件不再落到 Plain Text", () => {
    for (const name of [
      ".gitignore",
      ".gitignore_global",
      ".git-blame-ignore-revs",
      ".npmignore",
      ".vscodeignore",
      ".copilotignore",
      ".dockerignore",
      ".eslintignore",
      ".prettierignore",
    ]) {
      expect(detectLanguage(name).label, name).toBe("Ignore");
    }
    expect(detectLanguage("C:\\repo\\.gitignore").label).toBe("Ignore");
    expect(detectLanguage("repo/.GITIGNORE").label).toBe("Ignore");
  });

  it("dotenv 家族：.env / .env.* / .flaskenv；.envrc 仍是 Shell", () => {
    expect(detectLanguage(".env").label).toBe("Dotenv");
    expect(detectLanguage(".env.local").label).toBe("Dotenv");
    expect(detectLanguage(".env.production.local").label).toBe("Dotenv");
    expect(detectLanguage("app.env").label).toBe("Dotenv");
    expect(detectLanguage(".flaskenv").label).toBe("Dotenv");
    expect(detectLanguage("user-dirs.dirs").label).toBe("Dotenv");
    expect(detectLanguage(".envrc").label).toBe("Shell");
    // VS Code 的关联是扩展名 ".env"，没有点前缀的 `env` 不算
    expect(detectLanguage("env").label).toBe("Plain Text");
  });

  it("git / properties 配置走 Properties（VS Code 的 properties 家族）", () => {
    for (const name of [
      ".editorconfig",
      ".gitconfig",
      ".gitattributes",
      ".gitmodules",
      ".npmrc",
      "app.conf",
      "app.cfg",
    ]) {
      expect(detectLanguage(name).label, name).toBe("Properties");
    }
    expect(detectLanguage("C:\\Users\\me\\.config\\git\\config").label).toBe("Properties");
    expect(detectLanguage("/repo/.git/config").label).toBe("Properties");
  });

  it("JSON 家族：无扩展名的 rc 文件", () => {
    for (const name of [
      ".eslintrc",
      ".babelrc",
      ".swcrc",
      ".prettierrc",
      ".watchmanconfig",
      "tsconfig.base.json",
      "composer.lock",
      "app.js.map",
      "app.css.map",
    ]) {
      expect(detectLanguage(name).label, name).toBe("JSON");
    }
  });

  it("文件名通配：Dockerfile.* / Containerfile.* / Jenkinsfile*", () => {
    expect(detectLanguage("Dockerfile.dev").label).toBe("Dockerfile");
    expect(detectLanguage("Containerfile.ci").label).toBe("Dockerfile");
    expect(detectLanguage("Jenkinsfile.dev").label).toBe("Groovy");
  });

  it("VS Code 的常见完整文件名", () => {
    expect(detectLanguage("Gemfile").label).toBe("Ruby");
    expect(detectLanguage("Rakefile").label).toBe("Ruby");
    expect(detectLanguage("Vagrantfile").label).toBe("Ruby");
    expect(detectLanguage("PKGBUILD").label).toBe("Shell");
    expect(detectLanguage(".bashrc").label).toBe("Shell");
    expect(detectLanguage(".zshrc").label).toBe("Shell");
    expect(detectLanguage("Makefile").label).toBe("Makefile");
    expect(detectLanguage("GNUmakefile").label).toBe("Makefile");
    expect(detectLanguage("OCamlMakefile").label).toBe("Makefile");
    expect(detectLanguage("docker-compose.yml").label).toBe("YAML");
    expect(detectLanguage("compose.override.yml").label).toBe("YAML");
  });

  it("最长后缀胜出：.js.map 是 JSON，.h 归 C++（与 VS Code 一致）", () => {
    expect(detectLanguage("app.js.map").label).toBe("JSON");
    expect(detectLanguage("app.ts.map").label).toBe("JSON");
    expect(detectLanguage("src/app.js").label).toBe("JavaScript");
    expect(detectLanguage("a.h").label).toBe("C++");
    expect(detectLanguage("a.hpp.in").label).toBe("C++");
    expect(detectLanguage("a.i").label).toBe("C");
    expect(detectLanguage("a.c").label).toBe("C");
  });

  it("关联不命中时才回落到 shebang / 魔数", () => {
    expect(detectLanguage(".unknown", "#!/usr/bin/env bash").label).toBe("Shell");
    expect(detectLanguage(".unknown", '<?xml version="1.0"?>').label).toBe("XML");
    // 文件关联优先于 shebang（与 VS Code 同序）
    expect(detectLanguage(".gitignore", "#!/bin/bash").label).toBe("Ignore");
  });

  it("Ignore 只把行首 # 认作注释（VS Code 的 ignore 语法）", async () => {
    const { EditorState } = await import("@codemirror/state");
    const { syntaxTree } = await import("@codemirror/language");
    const state = EditorState.create({
      doc: "# 注释\nnode_modules/\n # 缩进后不是注释\n",
      extensions: [detectLanguage(".gitignore").extension!],
    });
    const comments: string[] = [];
    syntaxTree(state).iterate({
      enter(n) {
        if (n.name === "comment") comments.push(state.doc.sliceString(n.from, n.to));
      },
    });
    expect(comments).toEqual(["# 注释"]);
  });
});

// 折叠服务为纯状态计算（无 DOM 依赖），沿用默认 node 环境
describe("流式语言缩进折叠（回归：JSON 等除 Markdown 外全部不可折叠）", () => {
  it("JSON 嵌套块可折叠：缩进比本行深的连续块给出 fold 范围", async () => {
    const { foldable } = await import("@codemirror/language");
    const { EditorState } = await import("@codemirror/state");
    const info = detectLanguage("test.json");
    expect(info.extension).not.toBeNull();
    const doc = ["{", '  "a": {', '    "b": 1', "  }", "}", ""].join("\n");
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
    const doc = ["def f():", "    if x:", "        return 1", "", "def g():", "    pass", ""].join(
      "\n",
    );
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

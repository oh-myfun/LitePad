// @vitest-environment jsdom
// B319-A3 双击预览某一块 = 回源码那一行。
//
// 两层证据：
//  1) 运行时：PreviewPane 那一下双击必须把**被点那一块**的 lineStart 交出去（真行为）。
//  2) 静态契约：`revealSourceLine` 的**顺序**（先翻态再落位）与接线。
//     ⚠️ 第 2 层是静态契约而不是跑起来的：boot 整个 main 才能造出一个真实面板，
//     成本与本任务不成比例，而这条顺序在 tests/goto-line.test.ts 里就是同一族静态契约
//     （「转到行必须 y:start」）。像素级与焦点行为由真机那一轮收（见计划 Task 5 Step 6）。
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { PreviewPane } from "../src/markdown/preview";
import type { MdBlock } from "../src/markdown/pipeline";

function bk(html: string, lineStart: number): MdBlock {
  return { html, lineStart, lineEnd: lineStart };
}

function mkPane(): PreviewPane {
  const p = new PreviewPane();
  document.body.append(p.root);
  return p;
}

describe("预览双击（B319-A3）", () => {
  it("双击块内任意元素：回调拿到的是那一块的 lineStart", () => {
    const p = mkPane();
    p.setBlocks([bk("<p>一</p>", 1), bk("<p>二</p>", 3), bk("<p>三</p>", 5)]);
    const spy = vi.fn();
    p.setBlockDblClick(spy);
    const target = p.root.querySelectorAll(".md-block")[1].querySelector("p")!;
    target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(3);
  });

  it("双击岛外的空白处：一次都不回调", () => {
    const p = mkPane();
    p.setBlocks([bk("<p>一</p>", 1)]);
    const spy = vi.fn();
    p.setBlockDblClick(spy);
    p.root.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(spy).not.toHaveBeenCalled();
  });

  it("双击链接：不许翻回源码（那一发该交给浏览器打开链接）", () => {
    const p = mkPane();
    p.setBlocks([bk('<p>看 <a href="https://example.com">这个链接</a></p>', 1)]);
    const spy = vi.fn();
    p.setBlockDblClick(spy);
    p.root.querySelector("a")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(spy, "与既有 click 口径不一致：click 放过 <a>，dblclick 不该抢").not.toHaveBeenCalled();
  });

  it("没设回调时双击不炸（预览还没接上源码那一侧）", () => {
    const p = mkPane();
    p.setBlocks([bk("<p>一</p>", 1)]);
    expect(() =>
      p.root
        .querySelector(".md-block")!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    ).not.toThrow();
  });
});

describe("回源码那一行（revealSourceLine 的顺序与接线）", () => {
  const mdSrc = readFileSync("src/markdown.ts", "utf-8");

  function fnBody(name: string): string {
    const at = mdSrc.indexOf(`function ${name}(`);
    expect(at, `src/markdown.ts 里应能找到 ${name}`).toBeGreaterThan(-1);
    return mdSrc.slice(at, at + 1200);
  }

  it("先翻到源码态，再落位 —— 反了会被切换那发残值落位盖掉", () => {
    const body = fnBody("revealSourceLine");
    const flip = body.indexOf("toggleViewMode(");
    const land = body.indexOf("EditorView.scrollIntoView(");
    expect(flip, "必须调 toggleViewMode").toBeGreaterThan(-1);
    expect(land, "必须用 scrollIntoView 落位").toBeGreaterThan(-1);
    expect(flip, "翻态必须排在落位之前").toBeLessThan(land);
  });

  it("坐标由这一跳自己给（行号直接交给协调器），并把行夹进文档范围", () => {
    const body = fnBody("revealSourceLine");
    expect(body).toContain("syncCoordinator.syncTo(");
    // B301：不许把隐藏侧的锚点交给协调器去读
    expect(body).not.toContain("syncFromDriver(");
    expect(body).toMatch(/Math\.min\([\s\S]*doc\.lines/);
  });

  it("接线三处齐全：deps 绑定、面板挂回调、main 注入", () => {
    const deps = readFileSync("src/tabs/deps.ts", "utf-8");
    const lifecycle = readFileSync("src/tabs/lifecycle.ts", "utf-8");
    const main = readFileSync("src/main.ts", "utf-8");
    expect(deps).toContain("setRevealSourceLine");
    expect(deps).toMatch(/export \{[^}]*revealSourceLine[^}]*\}/);
    expect(lifecycle).toMatch(/setBlockDblClick\(\s*\(line\)\s*=>\s*revealSourceLine\(/);
    expect(main).toContain("setRevealSourceLine(revealSourceLine)");
  });
});

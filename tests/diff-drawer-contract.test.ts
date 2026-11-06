// @vitest-environment node
// B461 · Task 9 —— 左栏第五块「差异」的**跨文件契约**。
//
// 钉的全是 jsdom 跑不到、又最容易各写一份的东西：枚举与白名单必须同一份名单（漏一格是
// **静默回落大纲**，不是报错 —— B389 那条教训同形）、骨架三处 id 齐、点击归自己模块管
// （外壳代管任何一块的点击就会长出第五块点不动）、块表只有一份来源。
// 行为本身（条目怎么画、点一条做什么、光标跟随）在 tests/diff-panel.test.ts 里跑真骨架。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const srcOf = (p: string): string => readFileSync(p, "utf-8").replace(/\r\n/g, "\n");

const api = srcOf("src/ipc/api.ts");
const drawer = srcOf("src/shell/drawer.ts");
const html = srcOf("index.html");
const ui = srcOf("src/ui.ts");

describe("B461 · 抽屉第五块的名单同源（Task 9 Step 1）", () => {
  it("B461 · DrawerViewName 的每一员都在 viewFromSetting 白名单里（漏一格是静默回落大纲，不是报错）", () => {
    const union = /export type DrawerViewName =([^;]+);/.exec(api)![1];
    const enumNames = [...union.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(enumNames, "第五块「差异」得进枚举").toContain("diff");
    const guard = /function viewFromSetting[\s\S]*?\n}/.exec(drawer)![0];
    for (const n of enumNames) {
      expect(guard, `白名单漏了 ${n} ⇒ 上次开着它、下次启动静默换成大纲`).toContain(
        `raw === "${n}"`,
      );
    }
  });

  it("B461 · 骨架三处齐（键 + 面板 + 列表），且三处都在外壳那一节里", () => {
    for (const id of ["side-diff", "diff-panel", "diff-list"]) {
      expect(html, `index.html 缺 #${id}`).toContain(`id="${id}"`);
    }
    // 标题栏常驻、列表才重绘（B205 那条纪律：重绘只清 `#diff-list`，不许连头部一起换掉）
    expect(html).toContain(`id="diff-title"`);
    const head = /id="diff-head"[\s\S]*?id="diff-list"/.exec(html);
    expect(head, "头部与列表两截的次序：头部在前（与大纲/搜索那几块同形）").toBeTruthy();
  });

  it("B461 · 那颗键的点击归 diff/panel.ts 自己挂，外壳不许代管任何一块", () => {
    const panel = srcOf("src/diff/panel.ts");
    expect(panel).toMatch(/sideDiff\.addEventListener\("click"/);
    expect(drawer, "外壳一旦代管点击，第五块就会跟着「谁最后注册谁赢」漂").not.toMatch(/sideDiff/);
    // 登记 ≠ 挂按钮：两条都在同一个模块里，少一条就是「键点不动」（B314-8 那一发）
    expect(panel).toMatch(/registerDrawerView\(\s*"diff"/);
  });

  it("B461 · ui.ts 交出的三颗引用与 DOM id 一一对上（引用名漂移就是 undefined 崩在装配那一步）", () => {
    for (const [ref, id] of [
      ["sideDiff", "side-diff"],
      ["diffPanel", "diff-panel"],
      ["diffList", "diff-list"],
    ]) {
      expect(ui, `ui.ts 缺 ${ref} = el("…")`).toMatch(
        // 泛型只给需要事件类型的节点（本仓库惯例：按钮有、div 没有）⇒ 这里可省。
        new RegExp(`const ${ref}\\w* = el(<[^>]*>)?\\("${id}"\\)`),
      );
      expect(ui, `${ref} 要进导出清单（面板模块只认 import）`).toMatch(
        new RegExp(`\\b${ref}\\b[,:]`, "s"),
      );
    }
  });

  it("Review Focus 4 · 块表只有一份来源：面板/旁路/装饰三处都不许自己算对齐", () => {
    for (const f of ["src/diff/panel.ts", "src/diff/surface.ts", "src/diff/face.ts"]) {
      expect(srcOf(f), `${f} 里出现对齐内核 = 第二块表，两侧与侧栏迟早各说各话`).not.toMatch(
        /lcsAnchors|Uint32Array|dp\[/,
      );
    }
    expect(srcOf("src/diff/panel.ts"), "面板读的是 surface 的现值，不自存第二份块表").toContain(
      "diffSurfaceOf(",
    );
  });
});

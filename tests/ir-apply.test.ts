// @vitest-environment jsdom
// B352-7 换态落地：顺序判据（B293 那一族）+ 锁的真机制（计划增量 1，Review Focus 1&2）。
//
// 锁为什么不能只靠 `EditorView.editable(false)` / `EditorState.readOnly`：那两条只管**用户手势**，
// 挡不住程序化 `dispatch` —— 而 F5 插入时间、查找栏「替换全部」正是程序化写。
// 反过来，跨格/跨窗口的同源变更集、外部改文件后的重载也是程序化写，**必须**放行，
// 否则锁会把这三条一起堵死。⇒ 判据两头都钉：带 userEvent 的改文本被拒、不带的通过。
//
// ⚠️ `src/markdown.ts` 在模块求值时会经 `src/ui.ts` 逐个取 DOM 节点、取不到就抛，
//    而静态 `import` 一定抢在装骨架之前 ⇒ 这里先装 index.html 再动态 import（recents-panel 同款）。
import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { liveRenderExtensions } from "../src/markdown/live-render";
import { fnBody, stripLineComments } from "./static";
import type { IrState } from "../src/markdown/ir-state";
import type { Tab } from "../src/core/app-state";

const md = stripLineComments(readFileSync("src/markdown.ts", "utf-8"));

const IR_LOCKED: IrState = { liveRender: "ir", irLocked: true };
const IR_EDITABLE: IrState = { liveRender: "ir", irLocked: false };
const SOURCE: IrState = { liveRender: "off", irLocked: true };

let irExtensionsFor: typeof import("../src/markdown").irExtensionsFor;
let irEditable: typeof import("../src/markdown").irEditable;

beforeAll(async () => {
  const body = (
    readFileSync("index.html", "utf-8").match(/<body>([\s\S]*)<\/body>/)?.[1] ?? ""
  ).replace(/<script[\s\S]*?<\/script>/g, "");
  document.body.innerHTML = body;
  const mod = await import("../src/markdown");
  irExtensionsFor = mod.irExtensionsFor;
  irEditable = mod.irEditable;
});

function lockedState(doc = "# a\n\n- x\n"): EditorState {
  return EditorState.create({ doc, extensions: irExtensionsFor(IR_LOCKED) });
}

describe("B352-7 顺序判据：applyIrState 的落地顺序本身就是契约", () => {
  it("先读 v 再写状态；落位与重注册都在；换态全程不置脏", () => {
    const body = fnBody(md, "applyIrState");
    expect(body, "取到函数体了没？").toBeTruthy();
    const read = body.indexOf("readVisibleV(panel)");
    const write = body.indexOf("tab.liveRender =");
    expect(read, "必须先读 v 再写状态（B293）").toBeGreaterThan(-1);
    expect(write, "要有写状态那一发").toBeGreaterThan(-1);
    expect(
      write,
      "读 v 必须排在写状态之前（B293：读晚了 keepV 恒 1.00，落位把刚现形那侧钉回顶部）",
    ).toBeGreaterThan(read);
    expect(body, "换类之后补落位").toMatch(/landVisibleSideAtV\(panel,\s*keepV/);
    expect(body, "显隐变了就要重注册（B285/B310）").toMatch(/reconcileSyncRegistrations\(\)/);
    expect(body.indexOf("setSuppressDirty(true)"), "suppressDirty 要包住整段换态").toBeLessThan(
      body.indexOf("landVisibleSideAtV"),
    );
    expect(body, "finally 里要放开抑制").toMatch(
      /finally\s*\{[\s\S]{0,60}setSuppressDirty\(false\)/,
    );
  });

  it("渲染态关掉整条 gutter（B352-5 的裁定），源码态给回档位那份", () => {
    const body = fnBody(md, "applyIrState");
    expect(body, "换态必须重配 comps.gutter").toMatch(/comps\.gutter\.reconfigure\(/);
    expect(body, "渲染态那一支必须是空扩展").toMatch(
      /===\s*"ir"\s*\?\s*\[\]\s*:\s*gutterExtensions/,
    );
  });

  it("预览闸门：开着 IR 就不许再重画整篇预览（Step 5）", () => {
    const body = fnBody(md, "renderMarkdownFor");
    const gate = body.indexOf('liveRender === "ir"');
    const setBlocks = body.indexOf("preview.setBlocks(");
    expect(gate, "闸门要在").toBeGreaterThan(-1);
    expect(setBlocks, "预览确实有重画那一发").toBeGreaterThan(-1);
    expect(gate, "闸门必须排在重画之前（排在后面就等于没闸）").toBeLessThan(setBlocks);
  });

  it("三态的后继只能由 nextIrState 算（别处不许自己映射）", () => {
    const body = fnBody(md, "cycleIrState");
    expect(body, "必须走 Task 4 的状态机").toMatch(/nextIrState\(/);
    expect(body, "不许就地拼三态字面量").not.toMatch(/liveRender:\s*"ir"/);
    expect(body, "只读文档要喂给状态机（C 不可达）").toMatch(/readonly/);
  });
});

describe("B352-7 锁的机制：用户手势被拒、程序化写放行", () => {
  it("锁态下带 userEvent 的改文本被拒（键入/粘贴/拖放都在这一类）", () => {
    for (const ev of ["input", "paste", "drop", "delete"]) {
      const tr = lockedState().update({
        changes: { from: 0, insert: "Z" },
        annotations: Transaction.userEvent.of(ev),
      });
      expect(tr.changes.empty, `userEvent=${ev} 的写必须被锁挡下`).toBe(true);
    }
  });

  it("程序化写（同源变更集 / 外部重载）不带 userEvent ⇒ 必须放行", () => {
    const tr = lockedState().update({ changes: { from: 0, insert: "Z" } });
    expect(tr.docChanged, "同源变更集不许被锁挡死").toBe(true);
    expect(tr.state.doc.toString().startsWith("Z#"), "内容要真的进去").toBe(true);
  });

  it("只改选区的事务放行：锁态下大纲跳转 / 查找栏移动光标仍然要能用", () => {
    const state = lockedState("# a\n\n- x\n");
    const tr = state.update({
      selection: { anchor: 4 },
      annotations: Transaction.userEvent.of("select"),
    });
    expect(tr.state.selection.main.head, "锁只管改文本，选区要真的挪动").toBe(4);
  });

  it("editable 跟锁走：只有「渲染 + 锁」那一态把编辑面关掉", () => {
    const facetOf = (s: IrState) =>
      EditorState.create({ doc: "x", extensions: irExtensionsFor(s) }).facet(EditorView.editable);
    expect(facetOf(IR_LOCKED), "锁态必须关掉编辑面").toBe(false);
    expect(facetOf(IR_EDITABLE), "可写渲染态要开着").toBe(true);
    expect(facetOf(SOURCE), "源码面要开着（今天的行为）").toBe(true);
  });

  it("源码态与可写渲染态都不许装 changeFilter（装了就是给每一次按键加闸）", () => {
    for (const s of [IR_EDITABLE, SOURCE]) {
      const state = EditorState.create({ doc: "# a\n", extensions: irExtensionsFor(s) });
      const tr = state.update({
        changes: { from: 0, insert: "Z" },
        annotations: Transaction.userEvent.of("input"),
      });
      expect(tr.docChanged, `${s.liveRender}/${s.irLocked} 必须能打字`).toBe(true);
    }
  });

  it("真挂上装饰层：锁态下打字进不去，程序化写照样生效，装饰不受影响", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: "# Title\n",
        extensions: [
          liveRenderExtensions({ ir: true, locked: true, baseDir: null }),
          ...irExtensionsFor(IR_LOCKED),
        ],
      }),
      parent,
    });
    const before = view.state.doc.toString();
    view.dispatch({ changes: { from: 0, insert: "Z" }, userEvent: "input" });
    expect(view.state.doc.toString(), "锁态打字必须无效").toBe(before);
    view.dispatch({ changes: { from: 0, insert: "Z" } });
    expect(view.state.doc.toString(), "程序化写要生效").toBe(`Z${before}`);
    view.destroy();
    parent.remove();
  });
});

describe("B352-7 命令层闸门 irEditable", () => {
  it("只有「渲染 + 锁」不可写；源码面与可写渲染态都可写", () => {
    const tab = (liveRender: string, irLocked: boolean) =>
      ({ liveRender, irLocked }) as unknown as Tab;
    expect(irEditable(tab("ir", true))).toBe(false);
    expect(irEditable(tab("ir", false))).toBe(true);
    expect(irEditable(tab("off", true))).toBe(true);
    expect(irEditable(tab("off", false))).toBe(true);
  });
});

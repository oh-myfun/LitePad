// @vitest-environment jsdom
// B352-5 行号 / 折叠搬家进 Compartment + Tab 的两个 IR 字段。
//
// 为什么必须搬家（spec §5「冲突两条」第 2 条）：`lineNumbers()` 现在硬编在 `baseExtensions` 里，
// 而 baseExtensions 是**所有标签共享**的一份配置 ⇒ 想「IR 态换一种 gutter、源码态换另一种」
// 就没有可切的缝。Compartment 是 CM6 里唯一的按实例切换机制。
//
// 判据两头：静态那几条钉「不许再硬编」的口径（评审要一眼看到门槛还在），行为那条钉
// 「真的能按实例切」——后者才是搬家的目的，只有静态判据的话，把 compartment 写成
// 一个从不 reconfigure 的空槽也能全绿。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { gutterExtensions, makeTabState } from "../src/editor/editor";
import { perfProfileFor } from "../src/editor/perf";
import { stripLineComments, fnBody } from "./static";

const NOOP = (): void => {};
const MOUNT_DOC = "alpha\nbeta\ngamma";

function mount(cls: "normal" | "large" = "normal") {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const made = makeTabState(
    MOUNT_DOC,
    null,
    { dark: false, wrap: true, perf: perfProfileFor(cls) },
    NOOP,
  );
  const view = new EditorView({ state: made.state, parent });
  return { parent, view, comps: made.comps, perf: perfProfileFor(cls) };
}

function unmount(parent: HTMLElement): void {
  parent.remove();
}

describe("B352-5 静态契约：行号与折叠都不许再硬编", () => {
  const ts = stripLineComments(readFileSync("src/editor/editor.ts", "utf-8"));

  it("baseExtensions 里不再出现 lineNumbers() 或 foldGutter()（两条都归 gutter compartment）", () => {
    const base = fnBody(ts, "baseExtensions");
    expect(base, "取到函数体了没？").toBeTruthy();
    expect(base, "行号不许再硬编").not.toMatch(/lineNumbers\(\)/);
    expect(base, "折叠不许再裸 push").not.toMatch(/foldGutter\(/);
  });

  it("gutterExtensions 保住 M4 的 perf.folding 门槛，行号在里面（任何档位都有）", () => {
    const gut = fnBody(ts, "gutterExtensions");
    expect(gut, "取到函数体了没？").toBeTruthy();
    expect(gut, "M4 的 perf.folding 门槛还在").toMatch(/perf\.folding\s*\?[\s\S]{0,80}foldGutter/);
    expect(gut, "行号必须在这一份里（导航底线，不许被档位裁掉）").toMatch(/lineNumbers\(\)/);
  });

  it("makeTabState 把初值走 comps.gutter，并新建 ir 槽", () => {
    const mk = fnBody(ts, "makeTabState");
    expect(mk, "gutter 初值必须由 compartment 注入").toMatch(/comps\.gutter\.of\(/);
    expect(mk, "IR 也要有一槽（Task 6 往里放 StateField/ViewPlugin）").toMatch(
      /ir:\s*new Compartment\(\)/,
    );
    expect(mk, "gutter 也要有一槽").toMatch(/gutter:\s*new Compartment\(\)/);
  });

  it("TabCompartments 声明 ir 与 gutter（Task 6/7 就从这两个槽 reconfigure）", () => {
    const decl = ts.slice(
      ts.indexOf("interface TabCompartments"),
      ts.indexOf("interface TabCompartments") + 400,
    );
    expect(decl).toMatch(/ir:\s*Compartment/);
    expect(decl).toMatch(/gutter:\s*Compartment/);
  });

  it("Tab 的两个 IR 字段各出现一次，且带「为什么是实例级」的注释", () => {
    const raw = readFileSync("src/core/app-state.ts", "utf-8");
    for (const field of ["liveRender", "irLocked"]) {
      const hits = raw.match(new RegExp(`^\\s{2}${field}:`, "gm")) ?? [];
      expect(hits.length, `Tab 里 ${field} 应恰好声明一次`).toBe(1);
      // 声明行往上找注释（// 或 *）——评审要看得见这是**每份实例**的状态，不是文档级
      const lineIdx = raw.split("\n").findIndex((l) => new RegExp(`^\\s{2}${field}:`).test(l));
      const above = raw
        .split("\n")
        .slice(Math.max(0, lineIdx - 6), lineIdx)
        .join("\n");
      expect(above, `${field} 的声明上面要有注释`).toMatch(/\/\/|\/\*|\*/);
      expect(above, `${field} 要写明按实例（分屏两份各走各的）`).toMatch(/实例/);
    }
    expect(raw).toMatch(/liveRender:\s*IrRenderMode/);
    expect(raw).toMatch(/irLocked:\s*boolean/);
  });

  it("makeInstance 的返回字面量补了初值：源码态 + 锁着", () => {
    const dm = stripLineComments(readFileSync("src/doc-model.ts", "utf-8"));
    const mk = fnBody(dm, "makeInstance");
    expect(mk, "取到函数体了没？").toBeTruthy();
    expect(mk).toMatch(/liveRender:\s*"off"/);
    expect(mk).toMatch(/irLocked:\s*true/);
  });

  it("字段类型取自 ir-state（不许在 app-state 里再抄一份 union）", () => {
    const raw = readFileSync("src/core/app-state.ts", "utf-8");
    expect(raw, "必须从 ir-state import IrRenderMode").toMatch(
      /import\s+(?:type\s+)?\{[^}]*\bIrRenderMode\b[^}]*\}\s*from\s*"\.\.\/markdown\/ir-state"/,
    );
    expect(raw, "不许就地抄一份三态").not.toMatch(/liveRender:\s*"off"\s*\|\s*"ir"/);
  });
});

describe("B352-5 行为契约：gutter 真的能按实例切（这才是搬家的目的）", () => {
  it("comps.gutter.reconfigure([]) ⇒ 行号槽从 DOM 消失；换回 gutterExtensions ⇒ 又出现", () => {
    const m = mount();
    try {
      expect(m.parent.querySelector(".cm-lineNumbers"), "初值就该有行号").toBeTruthy();
      m.view.dispatch({ effects: m.comps.gutter.reconfigure([]) });
      expect(m.parent.querySelector(".cm-lineNumbers"), "切空之后不该再有行号槽").toBeNull();
      m.view.dispatch({ effects: m.comps.gutter.reconfigure(gutterExtensions(m.perf)) });
      expect(m.parent.querySelector(".cm-lineNumbers"), "换回来必须又出现").toBeTruthy();
    } finally {
      unmount(m.parent);
    }
  });

  it("两份实例同时挂着的文档，gutter 可以一份切空一份留着（按实例，不是全局）", () => {
    const a = mount();
    const b = mount();
    try {
      a.view.dispatch({ effects: a.comps.gutter.reconfigure([]) });
      expect(a.parent.querySelector(".cm-lineNumbers"), "切空那份没有行号").toBeNull();
      expect(b.parent.querySelector(".cm-lineNumbers"), "另一份不受影响").toBeTruthy();
    } finally {
      unmount(a.parent);
      unmount(b.parent);
    }
  });

  it("large 档：gutter 里没有折叠槽，但行号还在（M4 门槛没被搬家弄丢）", () => {
    const m = mount("large");
    try {
      expect(m.parent.querySelector(".cm-lineNumbers"), "任何档位都要保留行号").toBeTruthy();
      expect(m.parent.querySelector(".cm-foldGutter"), "large 档不许有折叠槽").toBeNull();
    } finally {
      unmount(m.parent);
    }
  });

  it("ir 槽初值必须真的在配置里：往里 reconfigure 一发探针扩展要能在 DOM 上看见", () => {
    // ⚠️ 这条是防「假绿」的：CM6 的 compartment 若**没进初始 extensions**，
    // 之后 `comps.ir.of(x)` 不报错，但值被静默丢弃 —— Task 6 的 StateField 就是这么消失的。
    const m = mount();
    try {
      expect(m.comps.ir, "ir 槽必须真的是 Compartment").toBeInstanceOf(Compartment);
      expect(
        m.parent.querySelector(".cm-content")?.getAttribute("data-ir-probe"),
        "空槽不该带探针",
      ).toBeNull();
      m.view.dispatch({
        effects: m.comps.ir.reconfigure(EditorView.contentAttributes.of({ "data-ir-probe": "on" })),
      });
      expect(
        m.parent.querySelector(".cm-content")?.getAttribute("data-ir-probe"),
        "切进去要真生效",
      ).toBe("on");
      m.view.dispatch({ effects: m.comps.ir.reconfigure([]) });
      expect(
        m.parent.querySelector(".cm-content")?.getAttribute("data-ir-probe"),
        "切回空要真撤掉",
      ).toBeNull();
      m.view.dispatch({ changes: { from: 0, insert: "z" } });
      expect(m.view.state.doc.toString(), "重配 ir 不许动文档").toBe(`z${MOUNT_DOC}`);
    } finally {
      unmount(m.parent);
    }
  });
});

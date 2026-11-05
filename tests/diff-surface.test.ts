// @vitest-environment jsdom
// B461 · Task 1 —— 差异标签的「落点」。
//
// 这一轮最大的接线风险（设计稿 ⑧·1）是「两颗 EditorView 与 `Panel.view` 单颗模型冲突」。
// 落点定的是：**`Panel.view` 继续是右栏那颗既有的 view**（那份文档本身 —— 脏标记、Ctrl+S、
// 撤销栈、会话快照全按它寻址，一行分支都不用加）。差异标签只多一个**旁路**：挂在
// `.panel-host` 内、`.panel-editor` 之前的一颗只读 `EditorView` + 一根只管这一栏之内的分割线。
// 于是风险从「几十处都要记得问 kind」降级成「一处挂、一处拆」—— 这里钉的就是这一挂一拆：
//   1) 三个新字段在模型层就位，而且**默认值都是普通编辑器**（`kind: "editor"` / `diff: null` /
//      `diffSurface: null`）—— 老路径一条都不许被改成「看起来像差异」；
//   2) 挂上去 / 拆下来真的作用在 `.panel-host` 的子节点上，而右栏那颗 view 不受牵连；
//   3) 左栏那颗 view **绝不进**同步滚动协调器（两份内容不是同一文档的两个视口，反目标见 ②）；
//   4) 接线只落在 `mountView` / `rebuildLayout` / `disposePanel` 这三处，`switchTab` 不加 kind 分支。
//
// ⚠️ 几何类判据（并排各占多宽、分割线落在哪个像素）不在这里：jsdom 里 `getBoundingClientRect`
// 恒为 0，那是真机台（Task 11）的事。单测只判「节点在不在、类加没加、view 有没有被 destroy、
// surface 有没有留在 panel 上」。
//
// ⚠️ 「拿源码文本当结构判据」是本仓库的既定契约层（`explorer-contract` / `gutter-diff-wiring` /
// `sync-scroll-sequence` 同形），钉的是跨文件不变量，不是实现细节。
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";
import { fnBody } from "./static";
import { tabs, type Panel, type Tab } from "../src/core/app-state";
import { createEditor, makeTabState } from "../src/editor/editor";
import { perfProfileFor } from "../src/editor/perf";
import {
  createDiffSurface,
  disposeDiffSurface,
  diffSurfaceOf,
  syncDiffSurface,
} from "../src/diff/surface";
import type { DiffSpec } from "../src/diff/model";

const srcOf = (p: string): string => readFileSync(p, "utf-8").replace(/\r\n/g, "\n");

let nextTabId = 1;

function spec(over: Partial<DiffSpec> = {}): DiffSpec {
  return {
    tier: "baseline",
    docId: 100,
    leftText: () => "左栏正文\n它的第二行",
    leftName: "a.md（上次保存）",
    rightName: "a.md",
    leftPath: null,
    ...over,
  };
}

/** 一张标签：`kind` 由调用方给死（`makeInstance` 那一条路恒 `"editor"`，见第一条用例）。 */
function tabWithKind(kind: "editor" | "diff"): Tab {
  const { state, comps } = makeTabState(
    "右栏正文\n它的第二行",
    null,
    { dark: false, wrap: true, perf: perfProfileFor("normal") },
    () => {},
  );
  return {
    tabId: nextTabId++,
    docId: 100,
    panelId: 0,
    comps,
    state,
    viewMode: "source",
    kind,
    diff: kind === "diff" ? spec() : null,
    scrollV: 1,
  };
}

function freshPanel(): Panel {
  return {
    panelId: 0,
    tabs: [],
    activeTabId: -1,
    view: null,
    viewTabId: null,
    bodyEl: null,
    diffSurface: null,
  };
}

/**
 * 复刻 `src/tabs/lifecycle.ts` 的 `mountView` 那几步（走真的那条路要把整壳启动起来，
 * 单测里不划算）：建 `.panel-editor` → 挂右栏那颗 view → 记 `bodyEl` →
 * 交给**生产的** `syncDiffSurface` 决定挂不挂旁路。
 * 旁路的挂/拆判据本身是生产代码，这里没有第二份实现。
 */
function mount(hostEl: HTMLElement, panel: Panel, tab: Tab): void {
  tabs.set(tab.tabId, tab);
  panel.tabs = [tab.tabId];
  panel.activeTabId = tab.tabId;
  panel.viewTabId = tab.tabId;
  const editorEl = document.createElement("div");
  editorEl.className = "panel-editor";
  hostEl.appendChild(editorEl);
  panel.bodyEl = hostEl;
  // 右栏那颗 view 只在第一次挂载时造 —— 第二次换标签走的是既有的 `setState` 那条路。
  if (!panel.view) panel.view = createEditor(editorEl, tab.state);
  syncDiffSurface(panel);
}

beforeEach(() => {
  tabs.clear();
  document.body.innerHTML = "";
  document.body.className = "";
});

describe("B461 · 差异标签的落点（Task 1）", () => {
  it("B461 · 差异标签的三个新字段都在模型层就位（默认值都是普通编辑器）", () => {
    expect(srcOf("src/doc-model.ts")).toMatch(/kind:\s*"editor"/); // makeInstance 仍是普通标签
    expect(srcOf("src/doc-model.ts")).toMatch(/diff:\s*null/);
    expect(srcOf("src/tabs/lifecycle.ts")).toMatch(/diffSurface:\s*null/); // 兜底面板字面量也带
  });

  it("B461 · 差异标签挂载时 .panel-host 里多出对照栏与分割线，普通标签一根都不加", () => {
    const hostEl = document.createElement("div");
    hostEl.className = "panel-host";
    document.body.appendChild(hostEl);
    const panel = freshPanel();
    mount(hostEl, panel, tabWithKind("diff"));
    expect(hostEl.querySelector(".diff-original")).toBeTruthy();
    expect(hostEl.querySelector(".diff-sash")).toBeTruthy();
    expect(hostEl.classList.contains("is-diff")).toBe(true);
    expect(panel.view).not.toBeNull(); // ⚠️ 右栏仍是那颗既有的 view（本轮的地基）
    mount(hostEl, panel, tabWithKind("editor"));
    expect(hostEl.querySelector(".diff-original")).toBeNull();
  });

  it("B461 · 拆面板/换标签必须 dispose 左栏那颗 view，不留孤儿 DOM 也不留 surface", () => {
    const hostEl = document.createElement("div");
    hostEl.className = "panel-host";
    document.body.appendChild(hostEl);
    const panel = freshPanel();
    mount(hostEl, panel, tabWithKind("diff"));
    const left = diffSurfaceOf(panel)!.left;
    disposeDiffSurface(panel);
    expect(diffSurfaceOf(panel)).toBeNull();
    expect(hostEl.querySelector(".diff-original")).toBeNull();
    expect(hostEl.classList.contains("is-diff")).toBe(false);
    // 那颗 view 真的被 destroy 过（不是只把外壳从树上摘掉）：CM6 的 `destroy()` 会
    // `this.dom.remove()` ⇒ `cm-editor` 的父节点（`.diff-original`）先变 null。
    // 只摘 host 子节点不 destroy 的话，父节点仍是那颗 `.diff-original`。
    expect(left.dom.parentElement).toBeNull();
    expect(hostEl.contains(left.dom)).toBe(false);
    // 右栏那颗不许被牵连（它是那份文档本身）
    expect(panel.view!.view.state.doc.toString()).toContain("右栏正文");
  });

  it("B461 · 左栏那颗只读两手一起给（editable 单给会让 focus 空操作、选不出字）", () => {
    const hostEl = document.createElement("div");
    hostEl.className = "panel-host";
    document.body.appendChild(hostEl);
    const panel = freshPanel();
    const surface = createDiffSurface(hostEl, panel, spec());
    expect(surface.left.state.readOnly).toBe(true); // 命令/扩展在动手之前问这一颗
    // `EditorView.editable` 是 **facet**（没有实例 getter），落到 DOM 上就是那颗
    // `contenteditable="false"` —— 两个口径都钉：前者是判据，后者是用户实际拿到的东西。
    expect(surface.left.state.facet(EditorView.editable)).toBe(false); // 敲字进不去
    expect(surface.left.contentDOM.getAttribute("contenteditable")).toBe("false");
    // ⚠️ 这两手挡的是**用户输入与命令**，不挡裸 `view.dispatch`（CM6 的
    // `EditorState.readOnly` 文档原话：consulted by commands and extensions）。
    // 这一格没有裸派发方：那颗 view 不进 doc 记账、不进协调器、也不在任何 `panel.view`
    // 寻址的路径上（`syncDocInstances` / `refreshGutterDiffBaselines` / 查找栏都只认
    // `panel.view`）。真要挡裸派发，仓库既有那一手是 `previewLock`（`EditorState.readOnly`
    // + 丢 docChanged 的 `transactionFilter`，见 `src/preview/wysiwyg.ts:39`）——
    // 留给 Task 3/6 里有实际写点的时候再上，不在这里空装。
    expect(surface.spec().leftName).toBe("a.md（上次保存）");
    // retarget（Task 6 的「交换左右」用它）：换输入、不换那颗 view 本身
    const before = surface.left;
    surface.retarget(spec({ leftText: () => "换过来了" }));
    expect(surface.left).toBe(before);
    expect(surface.left.state.doc.toString()).toContain("换过来了");
    expect(surface.spec().leftText()).toBe("换过来了");
    surface.dispose();
    expect(panel.diffSurface).toBeNull(); // dispose 自己把 panel 上的记账清掉（防悬空）
  });

  it("B461 · 左栏那颗 view 不注册进同步滚动协调器（两份内容不是同一文档的两个视口）", () => {
    // ⚠️ 这条比对的是**含注释**的源码原文（照简报）⇒ `src/diff/surface.ts` 的注释里
    // 不许出现这两个标识符，否则自己的说明会把守卫判红（`tests/static.ts` 记过的那类陷阱，
    // 这里是反向用法）。要提那套机制就写「同步滚动那套注册口」。
    expect(srcOf("src/diff/surface.ts")).not.toMatch(/reconcileSyncRegistrations|registerViewport/);
  });

  it("B461 · 接线只落在挂/拆两处，switchTab 一片都不问 kind", () => {
    const life = srcOf("src/tabs/lifecycle.ts");
    expect(life).toMatch(/syncDiffSurface\(p\)/); // mountView 挂旁路
    expect(life).toMatch(/disposeDiffSurface\(p\)/); // rebuildLayout 的销毁循环拆旁路
    expect(life).toMatch(/disposeDiffSurface\(panel\)/); // disposePanel 拆旁路
    expect(fnBody(life, "switchTab")).not.toMatch(/kind\s*===\s*"diff"|syncDiffSurface/);
    expect(srcOf("src/main.ts")).toMatch(/diff\/diff\.css/); // 样式接进 import 链
  });
});

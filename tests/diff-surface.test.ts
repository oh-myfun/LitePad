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
//   3) 左栏那颗**只读是硬的**：任何事务（含裸 `dispatch({changes})`）都改不动它的文档，
//      同时又点得进焦点（选不中也就复制不了）—— 设计稿 ⑤ 的事实项 + ⑦·⑤ 的验收对象；
//   4) 左栏那一族与右栏 `.panel-editor` 吃同一套几何链与同一套字量度 token；
//   5) 左栏那颗 view **绝不进**同步滚动协调器（两份内容不是同一文档的两个视口，反目标见 ②）；
//   6) 接线只落在 `mountView` / `rebuildLayout` / `disposePanel` 这三处，`switchTab` 不加 kind 分支。
//
// ⚠️ **像素**类判据（并排各占多宽、分割线落在哪个像素、滚动条出没出得来）不在这里：
// jsdom 里 `getBoundingClientRect` 恒为 0，那是真机台（Task 11 ②「量两侧那块起始行的视觉 y」
// + Step 3 截图肉眼）的事。单测判两件事：
//   · DOM / 行为 —— 节点在不在、类加没加、view 有没有被 destroy、surface 有没有留在 panel 上、
//     一发事务下去文档到底变没变；
//   · **样式表的链条在不在** —— 「这一族规则存在且与右栏取同一套 token」在 jsdom 里量得到
//     （读源码文本即可），缺一条就是真机上的裁切 / 滚不动 / 两栏字量度不一致。
//
// ⚠️ 「拿源码文本当结构判据」是本仓库的既定契约层（`explorer-contract` / `gutter-diff-wiring` /
// `sync-scroll-sequence` / `gutter-diff-style` 同形），钉的是跨文件不变量，不是实现细节。
//
// Task 4 在下面追加的那一块钉的是**跳块与步进**：两侧同时落位到各自那段的起始行、落位走
// 既有「显式落位」那一类（认领这一发造成的滚动，绝不 `syncTo` 广播给同文档的别的面板）、
// 键入期只映射不重算（停手 `DIFF_REFRESH_MS` 才算一次，且全差异面只有 surface 那一颗定时器）。
// 修复轮 1 按裁决补进这一块的两条口径：
//   · **R25** —— 落位必须**同步写完再向账本认领**（走 `landVisibleSideAtV`）：登记进去的意图
//     必须是写完之后读回的那一个位置，紧随其后的落位回声必须被判成「自己那一发」而不是
//     「用户滚动·广播」；
//   · **R26** —— 空段（删除块在权威侧那一栏）的**落点行**也算那一块的命中，但只在现有规则
//     谁都判不中时兜底 ⇒ 跳过去之后 `activeIndex()` 不再读成 -1。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { fnBody, ruleBlock, stripCssComments, stripLineComments } from "./static";
import {
  docs,
  panels,
  setIsWrap,
  tabs,
  type Doc,
  type Panel,
  type Tab,
} from "../src/core/app-state";
import { createEditor, makeTabState } from "../src/editor/editor";
import { perfProfileFor } from "../src/editor/perf";
import { makeDoc, markClean } from "../src/doc-model";
import { applyDarkToTabs, applyWrapToTabs } from "../src/appearance";
import {
  createDiffSurface,
  disposeDiffSurface,
  diffSurfaceOf,
  refreshDiffSurfaces,
  syncDiffSurface,
  type DiffSurface,
} from "../src/diff/surface";
import { DIFF_REFRESH_MS } from "../src/diff/align";
import { setDiffBlocksListener } from "../src/diff/model";
import type { DiffSpec } from "../src/diff/model";
import type { ScrollAnchor } from "../src/sync-scroll/anchor";
import { reconcileSyncRegistrations, syncCoordinator } from "../src/sync-scroll/wire";

const srcOf = (p: string): string => readFileSync(p, "utf-8").replace(/\r\n/g, "\n");

/** 块体里某颗属性的**最后一个**声明值（同 `gutter-diff-style` 的口径：后写的顶掉前面的）。 */
function lastDecl(block: string, name: string): string {
  const code = stripCssComments(block);
  const hits = [...code.matchAll(new RegExp(`${name}\\s*:\\s*([^;]+);`, "g"))];
  return hits.length ? hits[hits.length - 1][1].trim() : "";
}

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
  if (kind === "diff") {
    // A 档那道闸（评审 R31）会回 `docs` 问「这份文档的基线还在吗」⇒ 合成的差异标签得有真身：
    // 生产里这张标签只能由 `attachDiffTab(真 Doc)` 建出，`spec()` 那颗 docId=100 因此必须在册。
    // 顺带把上一张用例留在 100 号上的 Doc（可能已被置成 `baseline = null`）换掉 —— 用例之间
    // 不许隔空互相影响。
    const doc = makeDoc(100, "右栏正文\n它的第二行", "a.md", null, "UTF-8", "LF", false);
    doc.baseline = "左栏正文\n它的第二行";
    docs.set(100, doc);
  }
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

  it("B461 · 左栏那颗任何事务都改不动它的文档，而且点得进焦点（选不中也就复制不了）", () => {
    const hostEl = document.createElement("div");
    hostEl.className = "panel-host";
    document.body.appendChild(hostEl);
    const panel = freshPanel();
    let baseline = "左栏正文\n它的第二行";
    const surface = createDiffSurface(hostEl, panel, spec({ leftText: () => baseline }));
    const left = surface.left;
    const original = left.state.doc.toString();
    expect(original, "前置：左栏吃的是 spec.leftText()").toBe("左栏正文\n它的第二行");

    // ⚠️ 判据是**行为**，不是 facet 值。CM6 的 `EditorState.readOnly` 文档原话是
    // 「consulted by commands and extensions」—— 它只让命令与扩展自己早退，**不否决**裸
    // `view.dispatch({changes})`；`EditorView.editable(false)` 也只关浏览器那条输入口。
    // 所以「任何事务都不许改动它的文档」这一条只能由丢 docChanged 的 `transactionFilter`
    // 兑现（照仓库既有那把 `previewLock`：`src/preview/wysiwyg.ts:39-49`，不自造新锁）。
    left.dispatch({ changes: { from: 0, insert: "X" }, userEvent: "input.type" });
    expect(left.state.doc.toString(), "带 userEvent 那一发（输入处理走的路）进不去").toBe(original);
    left.dispatch({ changes: { from: 0, to: 4, insert: "改写基线" } });
    expect(left.state.doc.toString(), "绕不过去的才叫锁：裸派发一字不改").toBe(original);
    // 硬闸只管「改文档」，不许顺手把别的事务一起丢了：Task 3 的装饰走 effects、Task 4 的
    // 落位走 selection / 滚动，整片 `[]` 就等于把那两件事锁死（这条让「全丢」的错写法变红）。
    left.dispatch({ selection: { anchor: 3 } });
    expect(left.state.selection.main.anchor, "非 docChanged 的事务照过").toBe(3);

    // 可聚焦那一手（B399 真机抓到）：`editable(false)` 把 contentDOM 写成
    // `contenteditable="false"`，那样 `focus()` 是空操作 ⇒ 点不进焦点、选不出字、复制不了
    // （设计稿 ⑦·⑤「左栏能选中复制」的前提）。两道都必要，仓库在 `wysiwyg.ts:44-48` 记过。
    // ⚠️ 有鉴别力的是**那颗属性**（实测：摘掉 `contentAttributes` 那条 ⇒ `expected null to be "0"`）。
    // 下面这发 `focus()` 在 jsdom 里挡不住这一道 —— jsdom 把「带 contenteditable 属性的元素」
    // 一律算可聚焦，摘了 tabindex 照样落点，所以它钉的是「焦点落在这颗 contentDOM 上、而且它
    // 还挂在树上」这个不变量；「真点得进、真选得中」归真机台 ⑤。
    expect(left.contentDOM.getAttribute("contenteditable"), "打字仍然进不去").toBe("false");
    expect(left.contentDOM.getAttribute("tabindex"), "没有这颗 tabindex 就点不进焦点").toBe("0");
    left.focus();
    expect(document.activeElement, "焦点落点 = 那颗可读栏的 contentDOM").toBe(left.contentDOM);

    expect(surface.spec().leftName).toBe("a.md（上次保存）");
    // 换正文 = 整态换 state，不是事务 ⇒ 不受上面那道硬闸牵连（这正是它比 `dispatch({changes})`
    // 合适的地方）。走的是 A 档那条真路：`doc.baseline` 被就地换掉（保存 / 以磁盘为准重载）之后
    // `reassert` ③ 发现「左栏那份文档 ≠ 读取口现在的值」⇒ `resetLeftDoc` 把新正文换进去。
    // 「交换左右」不在这儿（裁决 R38：右栏那颗 view 就是那份文档本身，就地换 spec 会把两栏
    // 变成同一份内容 ⇒ 差异清零），它开的是**另一张**标签。
    const before = surface.left;
    baseline = "换过来了";
    surface.reassert();
    expect(surface.left).toBe(before);
    expect(surface.left.state.doc.toString()).toBe("换过来了");
    // 换过正文之后闸还在（闸是 state 自带的，不随换 state 掉）
    surface.left.dispatch({ changes: { from: 0, insert: "X" } });
    expect(surface.left.state.doc.toString(), "换 state 之后硬闸照样一字不改").toBe("换过来了");
    surface.dispose();
    expect(panel.diffSurface).toBeNull(); // dispose 自己把 panel 上的记账清掉（防悬空）
  });

  it("B461 · 左栏那一族与右栏 `.panel-editor` 吃同一套几何链（缺一样就是裁切 / 滚不动）", () => {
    const css = srcOf("src/diff/diff.css");
    // ① 列本身要成为竖排 flex 容器，且 `min-height: 0`（preview.css:1880-1883 原注：
    //    flex 项的 `min-height:auto` = 内容高度，缺了它就被整篇文档撑开、被 `.panel-host` 裁掉）。
    const col = ruleBlock(css, ".diff-original");
    expect(col).toContain("display: flex");
    expect(col).toContain("flex-direction: column");
    expect(col, "缺 min-height:0 ⇒ 左栏撑到内容高度、被 .panel-host 裁掉，滚不动").toContain(
      "min-height: 0",
    );
    // ② 那颗 `.cm-editor` 吃剩余高度
    const editor = ruleBlock(css, ".diff-original .cm-editor");
    expect(editor).toContain("flex: 1");
    expect(editor).toContain("min-height: 0");
    // ③ CM 基础主题只写 `overflow-x: auto` ⇒ 双轴滚动要显式声明（preview.css:1891-1894）
    expect(
      ruleBlock(css, ".diff-original .cm-scroller"),
      "缺 overflow:auto ⇒ 纵向滚不动",
    ).toContain("overflow: auto");
    // ④ `is-diff` × `md-bar-docked`（preview.css:1701）同为 0-2-0，靠 import 先后定输赢太脆
    //    ⇒ 用 0-3-0 钉死：编辑档那条占位条真落上也不许把两栏翻回竖排。
    expect(ruleBlock(css, ".panel-host.is-diff.md-bar-docked")).toContain("flex-direction: row");
  });

  it("B461 · 两栏的字阶 / 字体 / 行高取的是同一套 token（两套行盒 = 逐行对齐必差）", () => {
    const global = srcOf("src/styles/global.css");
    const css = srcOf("src/diff/diff.css");
    // 右栏那三条既有规则（global.css:4780-4817）就是权威 ⇒ 逐颗比对取值，而不是在这里
    // 再抄一遍字面量：抄两份的话谁改了 global.css 谁就把两栏的行盒错开，还不发红。
    const right = ruleBlock(global, ".panel-host .panel-editor .cm-editor");
    const rightFont = ruleBlock(
      global,
      ".panel-host .panel-editor .cm-editor, .panel-host .panel-editor .cm-editor .cm-scroller",
    );
    const rightLeading = ruleBlock(
      global,
      ".panel-host .panel-editor .cm-content, .panel-host .panel-editor .cm-gutterElement",
    );
    const left = ruleBlock(css, ".diff-original .cm-editor");
    const leftFont = ruleBlock(
      css,
      ".diff-original .cm-editor, .diff-original .cm-editor .cm-scroller",
    );
    const leftLeading = ruleBlock(
      css,
      ".diff-original .cm-content, .diff-original .cm-gutterElement",
    );
    expect(lastDecl(left, "font-size"), "字阶两栏同 token").toBe(lastDecl(right, "font-size"));
    expect(
      lastDecl(leftFont, "font-family"),
      "字体两栏同 token（.cm-scroller 会截胡，必须同时写）",
    ).toBe(lastDecl(rightFont, "font-family"));
    expect(lastDecl(leftLeading, "line-height"), "行高两栏同 token（行号栏那条不能省）").toBe(
      lastDecl(rightLeading, "line-height"),
    );
    // 反向闸：右栏那三条必须真的取到过值 —— 上面 `toBe` 的两边都空也是绿（假绿）。
    expect(lastDecl(right, "font-size")).not.toBe("");
    expect(lastDecl(rightFont, "font-family")).not.toBe("");
    expect(lastDecl(rightLeading, "line-height")).not.toBe("");
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

// --------------------------------------------------------------------------- #
// Task 4 —— 跳块、步进与「落位绕开同步滚动」
// --------------------------------------------------------------------------- #

/**
 * 现场清单：本块建的旁路在 `afterEach` 统一拆。
 *
 * ⚠️ 与 `tests/diff-face.test.ts` 同一纪律：surface 里那颗防抖计时器只有 `dispose()` 会
 * `clearTimeout`（R24 之后全差异面**只有这一颗**），不拆就会带着未触发的定时器出这条用例，
 * 下一发 `syncBlocks` 打在已经作废的视图上。
 */
const live: Array<() => void> = [];

/** 左栏正文由调用方给死的一张差异标签的输入描述（右栏正文归那颗既有的 view）。 */
function specOf(leftText: string): DiffSpec {
  return {
    tier: "baseline",
    docId: 100,
    leftText: () => leftText,
    leftName: "a.md（上次保存）",
    rightName: "a.md",
    leftPath: null,
  };
}

/**
 * 一挂就位的差异格：`.panel-host` + `.panel-editor` + 右栏那颗既有的 view + 生产的旁路。
 *
 * 走的是 `mountView` 那几步的同形复刻（与本文件 Task 1 那三条一致）：判据本身是生产代码，
 * 测试里不写第二份挂法。`tab.state` 一起带上，是为了 `syncBlocks` / `jumpTo` 那条
 * 「右栏快照回写」的路**真的有个标签可写**（写成 `null` 就只是空转，判不到东西）。
 */
function mountDiffPair(leftText: string, rightText: string): { panel: Panel; s: DiffSurface } {
  const hostEl = document.createElement("div");
  hostEl.className = "panel-host";
  document.body.appendChild(hostEl);
  const editorEl = document.createElement("div");
  editorEl.className = "panel-editor";
  hostEl.appendChild(editorEl);
  const { state, comps } = makeTabState(
    rightText,
    null,
    { dark: false, wrap: true, perf: perfProfileFor("normal") },
    () => {},
  );
  const diff = specOf(leftText);
  const tab: Tab = {
    tabId: nextTabId++,
    docId: 100,
    panelId: 0,
    comps,
    state,
    viewMode: "source",
    kind: "diff",
    diff,
    scrollV: 1,
  };
  tabs.set(tab.tabId, tab);
  const panel: Panel = {
    panelId: 0,
    tabs: [tab.tabId],
    activeTabId: tab.tabId,
    view: createEditor(editorEl, state),
    viewTabId: tab.tabId,
    bodyEl: hostEl,
    diffSurface: null,
  };
  const s = createDiffSurface(hostEl, panel, diff);
  // 走**生产的**拆法：用例里已经 `s.dispose()` 过的那一格，`panel.diffSurface` 早已归零，
  // 这里就是空转（不许在已经 destroy 的左栏上再 destroy 一次）。
  live.push(() => disposeDiffSurface(panel));
  return { panel, s };
}

/** 三块（两侧都非空 ⇒ 每块都落在真行上）：基线 1–9，当前改了第 1、4、8 行。 */
function mountedSurfaceWithThreeBlocks(): { panel: Panel; s: DiffSurface } {
  return mountDiffPair("1\n2\n3\n4\n5\n6\n7\n8\n9", "1A\n2\n3\n4B\n5\n6\n7\n8C\n9");
}

/** 打一个字（走真那条 `dispatch`，与 CM 的输入处理同一个入口）。 */
function typeChar(view: EditorView, ch: string): void {
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: ch } });
}

const advance = (ms: number): Promise<unknown> => vi.advanceTimersByTimeAsync(ms);

/**
 * 「块表重算了几次」的计数口 —— 由**测试自己**包一层（简报 Step 4 明令生产代码里不许留计数器）。
 *
 * 包的正是 `notifyDiffBlocks` 那一格注册槽：`syncBlocks()` 每跑一次广播一次（Task 9 的侧栏
 * 面板也从这里领新块表），于是读数就是「重算了几遍」，而不是「我记得调了几次」。
 */
function countSyncBlocks(): () => number {
  let n = 0;
  setDiffBlocksListener(() => {
    n += 1;
  });
  return () => n;
}

// --------------------------------------------------------------------------- #
// R25 取证用的「量得出来的布局」与「同文档的第二个视口」
// --------------------------------------------------------------------------- #

/** 一帧（`tests/setup.ts` 把 rAF 换成 `setTimeout(0)` ⇒ 这一拍就是下一帧）。 */
const nextFrame = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0));

/** 本文件临时注册进协调器的假视口（`afterEach` 统一注销）。 */
const spyHandles: Array<ReturnType<typeof syncCoordinator.register>> = [];

/**
 * 给**真的**那颗 view 装一层「量得出来的假布局」（R25 那条判据用）。
 *
 * jsdom 没有布局引擎：`scrollTop` 的 setter 是空操作、`getBoundingClientRect()` 恒 0 ⇒
 * 「同步写完再按写完的值认领」这一手在这台环境里既写不进去也读不回来，判据就成了空话。
 * 补三件事：
 *   · `scrollDOM.scrollTop` 存得住（`Object.defineProperty` 顶掉 jsdom 那对空桩，与
 *     `tests/sync-scroll-landing-conceal.test.ts:68` 同一手法）；
 *   · `lineBlockAt` / `lineBlockAtHeight` 按 `linePx` 逐行换算 —— 生产的 `EditorScrollAnchor`
 *     问的就这两颗（`src/sync-scroll/anchor.ts:104-152`），CM6 内部走的是 `viewState` 那一份，
 *     实例上的这一发覆盖不动它 ⇒ 装饰与映射照旧按真那条路跑；
 *   · **不**动 `getBoundingClientRect`（高度恒 0）⇒ `setVAt` 走 `lineBlockAt(pos).top` 那一支、
 *     `topPos()` 交回 null ⇒ 落位「一次就收口」（`stuckAtTop` 为假、`attempt` 为 0）⇒ 本用例
 *     既不排重试链，也不会把那半截 `visibility: hidden` 带进来。
 * 像素级「目标行贴容器顶」量不到，仍归 Task 11 真机台（设计稿 ⑦·②）。
 */
function installFakeLayout(
  view: EditorView,
  linePx: number,
): { px: () => number; put: (px: number) => void } {
  const el = view.scrollDOM;
  let px = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => px,
    set: (next: number) => {
      px = Math.max(0, next);
    },
  });
  const block = (line: number) => {
    const doc = view.state.doc;
    const n = Math.min(Math.max(line, 1), doc.lines);
    return { from: doc.line(n).from, top: (n - 1) * linePx, height: linePx, bottom: n * linePx };
  };
  // 生产的 `EditorScrollAnchor` 只读 `from` / `top` / `height`（`src/sync-scroll/anchor.ts:104-152`），
  // 这里交的就是那一小撮字段 —— CM6 那颗 `BlockInfo` 是带 getter 的类，伪造不出完整一颗，
  // 所以过一层 cast 而不是把那些用不着的字段也编出来（编了反而是在假装有布局）。
  const asBlockFn = (fn: (arg: number) => ReturnType<typeof block>) =>
    fn as unknown as EditorView["lineBlockAt"];
  view.lineBlockAt = asBlockFn((pos: number) => block(view.state.doc.lineAt(pos).number));
  view.lineBlockAtHeight = asBlockFn((height: number) => block(Math.floor(height / linePx) + 1));
  return { px: () => px, put: (next: number) => (px = next) };
}

/**
 * 把这一格按**生产那条注册口**登记进协调器（`reconcileSyncRegistrations` 只认全局 `panels`，
 * 而本文件的测试面板是手搓的）：注册出来的锚点与落位口都用生产那两份，不写第二套。
 */
function registerPanel(panel: Panel): void {
  panels.set(panel.panelId, panel);
  reconcileSyncRegistrations();
}

/**
 * 同一文档的**第二个视口**：「这一发有没有被广播出去」的唯一证据就是它被 `setV` 写过几次。
 * 假锚点（生产那颗 `EditorScrollAnchor` 要真布局才量得动，这里只当接收端）。
 */
function spyPane(docId: string, linePx: number): { calls: number[] } {
  const el = document.createElement("div");
  let px = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => px,
    set: (next: number) => {
      px = Math.max(0, next);
    },
  });
  const calls: number[] = [];
  const anchor: ScrollAnchor = {
    getV: () => 1 + px / linePx,
    setV: (v: number) => {
      calls.push(Number(v.toFixed(2)));
      px = (v - 1) * linePx;
      return v;
    },
  };
  spyHandles.push(
    syncCoordinator.register(anchor, docId, { events: el, label: "P9:editor(同文档第二视口)" }),
  );
  return { calls };
}

afterEach(() => {
  for (const stop of live.splice(0)) stop();
  for (const h of spyHandles.splice(0)) syncCoordinator.unregister(h);
  setDiffBlocksListener(null);
  vi.useRealTimers();
  // 协调器是**模块级单例**（`wire.ts` 那颗）：本文件里注册进去的面板与假视口必须在这里退场，
  // 否则下一发用例的广播对象清单里还挂着上一发那颗已 destroy 的 view。
  panels.clear();
  reconcileSyncRegistrations();
});

describe("B461 · 跳块与步进（Task 4）", () => {
  it("B461 · jumpTo(1) 把左右光标分别落在各自那块的起始行", () => {
    const { panel, s } = mountDiffPair("1\n2\n3\n4\n5", "1\n2\n3A\n4\n5B");
    s.syncBlocks();
    expect(s.blocks()).toHaveLength(2);
    s.jumpTo(1);
    const rightLine = panel.view!.view.state.doc.lineAt(
      panel.view!.view.state.selection.main.head,
    ).number;
    const leftLine = s.left.state.doc.lineAt(s.left.state.selection.main.head).number;
    expect(rightLine).toBe(5); // modifiedStart
    expect(leftLine).toBe(5); // originalStart
  });

  it("B461 · 跳块不许调 syncCoordinator.syncTo（同一文档的别的面板不该跟着跳）", () => {
    expect(srcOf("src/diff/surface.ts")).not.toMatch(/syncTo\s*\(/);
    // 简报这一行钉的字面量原本是 `claimVisibleHere(`。裁决 R25 把「落位认领」这条路换成了
    // 仓库那条**真落位口**（`landVisibleSideAtV`：同步写 + 同栈登记意图与真实落点 + 逐帧重试），
    // 钉的还是同一件事 ——「这一发滚动必须向账本认领」，只是认领的口换了。
    // `claimVisibleHere(` 于是反过来成了禁项：它的语义是「认领我已经写好的位置」，接在
    // `scrollIntoView` 之后就是把「已经写好」弯成「即将发生」（⇒ 见下面那条 R25 用例）。
    const code = stripLineComments(srcOf("src/diff/surface.ts"));
    expect(code, "落位必须走仓库那条同步写 + 同栈登记的口").toContain("landVisibleSideAtV(");
    // ⚠️ `stripLineComments` 只剥「整行 `//`」，JSDoc 块注释里的标识符照样参与比对
    // （与本文件 `:289` 那条同一纪律）⇒ 源码里要提那个口就换个写法，别把说明判成实现。
    expect(code, "R25：不许再按「即将发生」的位置认领").not.toMatch(/claimVisibleHere/);
    // 两颗 view 都仍要落位：左栏那颗不在注册口里 ⇒ 它那一发就是普通派发（无需认领），
    // 所以 `scrollIntoView` 只剩左栏这一处；右栏那一处换成了同步落位。
    expect(code.match(/scrollIntoView\(/g) ?? [], "只有左栏那一发还走 scrollIntoView").toHaveLength(
      1,
    );
  });

  it("B461 · R25：跳块登记的意图是**写完之后**读回的那一个位置，不是跳之前的", () => {
    const { panel, s } = mountDiffPair("1\n2\n3\n4\n5", "1\n2\n3A\n4\n5B");
    s.syncBlocks();
    const view = panel.view!.view;
    const lay = installFakeLayout(view, 20);
    registerPanel(panel);
    lay.put(20); // 用户先把这一格滚到第 2 行 —— 那是**跳之前**的位置
    expect(s.blocks()[1].modifiedStart, "前置：目标块在右栏第 5 行").toBe(5);
    s.jumpTo(1);
    expect(
      lay.px(),
      "落位必须**同步**写进 scrollTop（scrollIntoView 排在下一帧，认领赶不上）",
    ).toBe(80);
    expect(
      syncCoordinator.pendingExpectation(view.scrollDOM),
      "账本里那笔意图必须是写完之后的落点（第 5 行），不是跳之前的第 2 行",
    ).toBeCloseTo(5, 2);
  });

  it("B461 · R25：落位回声被判成自己那一发，不广播给同文档的第二个视口", async () => {
    const { panel, s } = mountDiffPair("1\n2\n3\n4\n5", "1\n2\n3A\n4\n5B");
    s.syncBlocks();
    const view = panel.view!.view;
    const el = view.scrollDOM;
    const lay = installFakeLayout(view, 20);
    registerPanel(panel);
    const other = spyPane("100", 20);
    lay.put(20);
    s.jumpTo(1);
    // 真实浏览器里，写完 `scrollTop` 之后由浏览器在下一拍派发这一发的 `scroll` 回声，
    // 报的就是刚落到的那一个像素（旧代码把**跳之前**的位置登记成意图 ⇒ 这一发既不是意图
    // 也不是落点像素 ⇒ 账本判成「被人挪走→用户滚动·广播」，正是设计稿 ⑥/⑩·3 禁的那一下）。
    lay.put(80);
    el.dispatchEvent(new Event("scroll"));
    await nextFrame();
    expect(other.calls, "跳块这一发不许被当成用户滚动广播给同文档的别的面板").toEqual([]);
    // 反向闸（上面那条不是靠把账本焊死做出来的）：用户真的把这一格挪到别处 ⇒ 照旧联动。
    lay.put(60);
    el.dispatchEvent(new Event("scroll"));
    await nextFrame();
    expect(other.calls, "用户滚动仍然要广播 ⇒ 抑制不是锁").toEqual([4]);
    // 多视口**像素级**抑制（两格宽度不同、回声真实落点差几个像素）jsdom 量不到 ⇒
    // 那一档仍是 Task 11 真机台的验收项（设计稿 ⑩·3 的多视口那条）。
  });

  it("B461 · step(1) 往后找、末块之后夹住；step(-1) 往回", () => {
    const { s } = mountedSurfaceWithThreeBlocks();
    s.jumpTo(0);
    expect(s.activeIndex()).toBe(0);
    s.step(1);
    expect(s.activeIndex()).toBe(1);
    s.step(1);
    s.step(1);
    s.step(1);
    expect(s.activeIndex()).toBe(2);
    s.step(-1);
    expect(s.activeIndex()).toBe(1);
  });

  it("B461 · activeIndex 只认右栏光标（左栏那一侧再点也不抢权威，设计稿 ⑩·2）", () => {
    const { panel, s } = mountedSurfaceWithThreeBlocks();
    const rightCaretTo = (line: number): void => {
      panel.view!.view.dispatch({
        selection: { anchor: panel.view!.view.state.doc.line(line).from },
      });
    };
    s.jumpTo(1);
    expect(s.activeIndex()).toBe(1);
    // 左栏光标跑到别的一块上：权威仍是右栏 ⇒ 读数不许变（⑩·2 那条闸门）
    s.left.dispatch({ selection: { anchor: s.left.state.doc.line(9).from } });
    expect(s.activeIndex(), "左栏光标不参与").toBe(1);
    // 右栏光标挪到两块之间（谁都没包住）⇒ -1
    rightCaretTo(2);
    expect(s.activeIndex(), "光标在块外 ⇒ 没有那块").toBe(-1);
  });

  it("B461 · jumpTo 索引越界夹到首/末块（不环绕）", () => {
    const { panel, s } = mountedSurfaceWithThreeBlocks();
    const line = (): number =>
      panel.view!.view.state.doc.lineAt(panel.view!.view.state.selection.main.head).number;
    s.jumpTo(99);
    expect(line(), "往后越界 ⇒ 末块（右栏第 8 行）").toBe(8);
    s.jumpTo(-5);
    expect(line(), "往前越界 ⇒ 首块（右栏第 1 行）").toBe(1);
  });

  it("B461 · 空段落两侧都落「块前缘那行的行首」，行号越界夹到本栏末行", () => {
    // 只在右栏末尾多打一行 ⇒ 这是一块 insert：左栏那一侧是**空段**（original 4..3）。
    // 落点按 `end + 1` = 第 4 行，而左栏只有 3 行 ⇒ 夹到末行（那一发不许抛，也不许落空）。
    const { panel, s } = mountDiffPair("A\nB\nC", "A\nB\nC\nD");
    s.syncBlocks();
    expect(s.blocks()).toHaveLength(1);
    expect(s.blocks()[0].kind).toBe("insert");
    s.jumpTo(0);
    expect(s.left.state.doc.lineAt(s.left.state.selection.main.head).number).toBe(3);
    expect(panel.view!.view.state.doc.lineAt(panel.view!.view.state.selection.main.head).number)
      // 右栏那一侧非空 ⇒ 落自己那段的起始行
      .toBe(4);
  });

  it("B461 · 删掉的行（右栏空段）不留「按上一个差异原地不动」的死角", () => {
    // 两块：第 2 行是**改**（两侧都有真行），第 4 行是**删掉的**（右栏那一侧是空段 4..3，
    // 落点 `modifiedEnd + 1` = 第 4 行 —— 正是光标站的那一行）。
    const { panel, s } = mountDiffPair("1\n2\n3\nX\n5", "1\n2Z\n3\n5");
    const line = (): number =>
      panel.view!.view.state.doc.lineAt(panel.view!.view.state.selection.main.head).number;
    const leftLine = (): number => s.left.state.doc.lineAt(s.left.state.selection.main.head).number;
    expect(s.blocks().map((b) => b.kind)).toEqual(["modify", "delete"]);
    s.jumpTo(1);
    expect(leftLine(), "左栏那一行就是被删掉的 X").toBe(4);
    expect(line(), "那道删除缝在右栏落在块前缘那行的**下一行**").toBe(4);
    // 裁决 R26：落位规则（`end + 1`）与 `blockAt` 的空段命中行（`start - 1`）本来差一行 ⇒
    // 刚跳过去的那一块读成 -1，侧栏高亮丢掉。现在空段的**落点行**也算命中（兜底），
    // 于是「跳过去的就是 active」这一条成立。
    expect(s.activeIndex(), "R26：落点行兜底命中 ⇒ 刚跳过去的那一块就是 active").toBe(1);
    s.step(-1);
    expect(line(), "往回必须真动起来（改块在右栏第 2 行），不许落回同一行").toBe(2);
    expect(s.activeIndex()).toBe(0);
    s.step(1);
    expect(line(), "再往前又是那道删除缝").toBe(4);
    expect(s.activeIndex(), "R26：再跳回来 active 仍然是那道删除（往返读数一致）").toBe(1);
  });

  it("B461 · R26：step(-1) 从删除缝之后落回那一块，读数就是那一块（不再被跳过）", () => {
    // 与上面那条相反的一头：光标停在删除缝**之后**（第 6 行），按「上一个差异」。
    // 这一支本来就不会「原地不动」（落点行 4 ≠ 光标行 6），`step` 早就把这一块当候选；
    // R26 之前坏在**读数**上 —— 落过去之后 `blockAt` 认不出第 4 行，读数是 -1，
    // 于是侧栏与「以 active 为起点再步进」那条路都当这一块不存在（= 这一块被跳过了）。
    const { panel, s } = mountDiffPair("1\n2\n3\nX\n5\n6\n7", "1\n2Z\n3\n5\n6\n7");
    const line = (): number =>
      panel.view!.view.state.doc.lineAt(panel.view!.view.state.selection.main.head).number;
    expect(s.blocks().map((b) => b.kind)).toEqual(["modify", "delete"]);
    panel.view!.view.dispatch({
      selection: { anchor: panel.view!.view.state.doc.line(6).from },
    });
    expect(s.activeIndex(), "前置：第 6 行谁都没包住（兜底只兜落点那一行）").toBe(-1);
    s.step(-1);
    expect(line(), "往回落在删除块的落点行（第 4 行）").toBe(4);
    expect(s.activeIndex(), "R26：那一块报得出自己 ⇒ step(-1) 不再把它跳过").toBe(1);
  });

  it("B461 · R26：贴文首的删除块跳过去之后 active 读数不丢（落点行是第 1 行）", () => {
    // 删除发生在**文档第一行**：右栏那一侧是空段 1..0 ⇒ 落位规则给的落点行是 1，
    // 而「块前缘那一行」在那儿是第 0 行（不存在）⇒ 只有兜底认得它。
    const { panel, s } = mountDiffPair("X\nA\nB", "A\nB");
    expect(s.blocks().map((b) => b.kind)).toEqual(["delete"]);
    s.jumpTo(0);
    expect(
      panel.view!.view.state.doc.lineAt(panel.view!.view.state.selection.main.head).number,
    ).toBe(1);
    expect(s.activeIndex(), "贴文首的删除块：落点行必须仍报出那一块，否则侧栏高亮必丢").toBe(0);
  });

  it("B461 · R26 兜底与既有命中规则不打架：两块之间那一行归删除块，块内行归自己", () => {
    const { panel, s } = mountDiffPair("1\n2\n3\nX\n5\n6\n7", "1\n2Z\n3\n5\n6\n7");
    const rightCaretTo = (line: number): void => {
      panel.view!.view.dispatch({
        selection: { anchor: panel.view!.view.state.doc.line(line).from },
      });
    };
    expect(s.blocks().map((b) => b.kind)).toEqual(["modify", "delete"]);
    // 块内行（第 2 行是改块）走现有规则 ⇒ 0；空段前缘（第 3 行）也走现有规则 ⇒ 1；
    // 空段落点（第 4 行）走兜底 ⇒ 1；落点之后（第 5 行）谁都不沾 ⇒ -1。
    rightCaretTo(2);
    expect(s.activeIndex()).toBe(0);
    rightCaretTo(3);
    expect(s.activeIndex(), "块前缘那一行照旧命中（现有规则不动）").toBe(1);
    rightCaretTo(4);
    expect(s.activeIndex(), "落点行 = 兜底").toBe(1);
    rightCaretTo(5);
    expect(s.activeIndex(), "兜底只兜那一行，不许把后面都吞了").toBe(-1);
  });

  it("B461 · syncBlocks / jumpTo 都把右栏那一发写回标签快照（切走再回来不丢状态）", () => {
    const { panel, s } = mountedSurfaceWithThreeBlocks();
    const tab = tabs.get(panel.viewTabId!)!;
    s.syncBlocks();
    expect(tab.state, "syncBlocks 之后快照就是那颗 view 的现态").toBe(panel.view!.view.state);
    s.jumpTo(2);
    expect(tab.state, "落位那一发（改了选区）同样回写").toBe(panel.view!.view.state);
    expect(tab.state.selection.main.head, "回写的必须是**落位之后**那一份").toBe(
      panel.view!.view.state.selection.main.head,
    );
  });

  it("B461 · setIgnoreTrimWhitespace 一拨就立刻重算并广播（不等防抖）", () => {
    const { s } = mountDiffPair("1\n  2  \n3", "1\n2\n3");
    const calls = countSyncBlocks();
    expect(s.ignoreTrimWhitespace(), "缺省不忽略，与 B458 那 4px 一列同口径").toBe(false);
    s.syncBlocks();
    expect(s.blocks(), "关着时那行缩进就是改动").toHaveLength(1);
    s.setIgnoreTrimWhitespace(true);
    expect(s.ignoreTrimWhitespace()).toBe(true);
    expect(s.blocks(), "忽略首尾空白之后两份正文等价 ⇒ 没有块").toHaveLength(0);
    expect(calls(), "翻开关 = 用户的一发动作 ⇒ 立刻广播，不排定时器").toBe(2);
    s.setIgnoreTrimWhitespace(true);
    expect(calls(), "同一个值再拨一次不重算").toBe(2);
  });
});

describe("B461 · 键入期只映射不重算（Task 4 Step 3/4 + 裁决 R24）", () => {
  it("B461 · 连打 20 发只在停手后算一次（同 B458 那条口径）", async () => {
    vi.useFakeTimers();
    const { panel, s } = mountedSurfaceWithThreeBlocks();
    const calls = countSyncBlocks();
    expect(calls(), "挂上旁路那一刻不广播（块表已现算好交给两臂）").toBe(0);
    for (let i = 0; i < 20; i++) typeChar(panel.view!.view, "x");
    expect(calls(), "键入期只把装饰跟着改动映射，一次都不重算").toBe(0);
    await advance(DIFF_REFRESH_MS - 1);
    expect(calls(), "差一毫秒也没到点").toBe(0);
    await advance(1);
    expect(calls(), "停手到点才算那一次").toBe(1);
    expect(s.blocks().length, "重算吃的是**打完字之后**那两份正文").toBeGreaterThan(0);
    s.dispose();
  });

  it("B461 · 到点就收口：没有第二次键入，就不会有第二次重算", async () => {
    vi.useFakeTimers();
    const { panel, s } = mountedSurfaceWithThreeBlocks();
    const calls = countSyncBlocks();
    panel.view!.view.dispatch({ changes: { from: 0, insert: "x" } });
    panel.view!.view.dispatch({ changes: { from: 0, insert: "y" } });
    await advance(DIFF_REFRESH_MS);
    expect(calls()).toBe(1);
    await advance(DIFF_REFRESH_MS);
    expect(calls(), "定时器不自己续期（否则会每 200ms 重算一遍全量）").toBe(1);
    s.dispose();
  });

  it("B461 · dispose 之后那颗定时器就没了（不许在已拆的视图上重算）", async () => {
    vi.useFakeTimers();
    const { panel, s } = mountedSurfaceWithThreeBlocks();
    const calls = countSyncBlocks();
    panel.view!.view.dispatch({ changes: { from: 0, insert: "x" } });
    s.dispose();
    await advance(DIFF_REFRESH_MS * 3);
    expect(calls(), "dispose 里 clearTimeout 那一发必须真生效").toBe(0);
  });

  it("B461 · 防抖只此一家（R24）：face.ts 不排定时器，块表也不拿全文串做比较", () => {
    const face = stripLineComments(srcOf("src/diff/face.ts"));
    expect(face, "臂内那颗 200ms 定时器已摘：重算只由 surface 那一处驱动").not.toMatch(
      /setTimeout|setInterval|ViewPlugin/,
    );
    expect(face, "摘掉定时器之后 face.ts 连那颗常数都不需要了").not.toMatch(/from "\.\/align"/);
    const code = stripLineComments(srcOf("src/diff/surface.ts"));
    expect(code.match(/setTimeout\(/g) ?? [], "surface 是全差异面唯一的一颗定时器").toHaveLength(1);
    expect(code, "不许再拿两份全文串比较当缓存：syncBlocks 自己就是那一份答案").not.toMatch(
      /cache\.(left|right)\s*===/,
    );
    expect(code, "延迟只 import 那颗常数，不留第二份 200").not.toMatch(/,\s*200\s*\)/);
  });
});

// --------------------------------------------------------------------------- #
// Task 5 —— A 档接全：换标签不换面板的挂/拆（R13/R14）、基线实时（R20）、
// 折行/主题/双 surface 三处漂移（R23）。
//
// 挂/拆的判据本身走**生产的** `syncDiffSurface`（`applyPanelMode` 末尾点的那一次名，
// 在单测里就直接点这一处 —— 两条路是同一个出口）。
// --------------------------------------------------------------------------- #

/** 与 `mountDiffPair` 同形的一格，但左栏吃**活基线**：`leftText` 读 `docs` 里的 `doc.baseline`。 */
function mountLiveBaselinePair(
  baseline: string,
  rightText: string,
): { panel: Panel; s: DiffSurface; doc: Doc } {
  const doc = makeDoc(100, rightText, "a.md", null, "UTF-8", "LF", false);
  doc.baseline = baseline; // 「打开后又改了」：当前正文是 rightText，基线仍停在 baseline
  docs.set(doc.tabId, doc);
  const hostEl = document.createElement("div");
  hostEl.className = "panel-host";
  document.body.appendChild(hostEl);
  const editorEl = document.createElement("div");
  editorEl.className = "panel-editor";
  hostEl.appendChild(editorEl);
  const { state, comps } = makeTabState(
    rightText,
    null,
    { dark: false, wrap: true, perf: perfProfileFor("normal") },
    () => {},
  );
  const diff: DiffSpec = {
    tier: "baseline",
    docId: doc.tabId,
    leftText: () => docs.get(doc.tabId)?.baseline ?? "",
    leftName: doc.name,
    rightName: doc.name,
    leftPath: null,
  };
  const tab: Tab = {
    tabId: nextTabId++,
    docId: doc.tabId,
    panelId: 0,
    comps,
    state,
    viewMode: "source",
    kind: "diff",
    diff,
    scrollV: 1,
  };
  tabs.set(tab.tabId, tab);
  const panel: Panel = {
    panelId: 0,
    tabs: [tab.tabId],
    activeTabId: tab.tabId,
    view: createEditor(editorEl, state),
    viewTabId: tab.tabId,
    bodyEl: hostEl,
    diffSurface: null,
  };
  // 注册进册：`refreshDiffSurfaces`（refreshAll 那一条统一出口）遍历的是这份全局 panels。
  panels.set(panel.panelId, panel);
  const s = createDiffSurface(hostEl, panel, diff);
  live.push(() => disposeDiffSurface(panel));
  return { panel, s, doc };
}

describe("B461 · 基线实时与判据接全（Task 5 R13/R14 + R20）", () => {
  it("B461 · R20：存盘（markClean）⇒ 左栏那份文档被重设成新基线，块表归零，全程没一处手动派发", () => {
    const { s, doc } = mountLiveBaselinePair("甲\n乙\n丙", "甲\n乙改\n丙");
    expect(s.blocks(), "前置：挂上时就差着一行").toHaveLength(1);
    markClean(doc, "甲\n乙改\n丙"); // 保存成功那一步：只换 doc.baseline，不给编辑器发事务
    refreshDiffSurfaces(); // refreshAll 的统一出口（保存路径不经过 applyPanelMode）
    expect(
      s.left.state.doc.toString(),
      "左栏必须换成新基线 —— 只重派 effects（refreshDiff）画不出：那颗文档还是旧的",
    ).toBe("甲\n乙改\n丙");
    expect(s.blocks(), "基线与正文一致 ⇒ 一块都没有（存盘即清空）").toEqual([]);
  });

  it("B461 · R20：同标签再点名不重建，但基线漂移照样补上（applyPanelMode 出口的判据）", () => {
    const { panel, s, doc } = mountLiveBaselinePair("甲\n乙\n丙", "甲\n乙改\n丙");
    syncDiffSurface(panel);
    expect(diffSurfaceOf(panel), "一致 ⇒ 一个字都不动（防每发刷新都重建）").toBe(s);
    markClean(doc, "甲\n乙改\n丙");
    syncDiffSurface(panel);
    expect(diffSurfaceOf(panel), "补基线不靠重建旁路").toBe(s);
    expect(s.left.state.doc.toString()).toBe("甲\n乙改\n丙");
    expect(s.blocks()).toEqual([]);
  });

  it("B461 · 基线被抹掉（文件删进回收站 ⇒ orphan 把 `baseline` 置 null）⇒ 旁路拆掉，不许把整篇画成新增", () => {
    // Review Focus 1 的另一半：开那一张的时候问过闸，**挂着的时候没人再问**。
    // `orphan()`（`src/explorer/paths.ts`）把 `doc.baseline` 置 null 并调 `refreshAll()` ⇒
    // 那颗读取口交出 `""`，`reassert` ③ 忠实地把左栏换成空文档 —— 右栏每一行都被判成「新增」，
    // 一张全绿的差异面。那一档根本没有「原样」可比 ⇒ 正确的样子是没这一排。
    const { panel, doc } = mountLiveBaselinePair("甲\n乙\n丙", "甲\n乙改\n丙");
    expect(diffSurfaceOf(panel), "前置：这一格现在挂着旁路").not.toBeNull();
    doc.baseline = null; // 「只知道它脏、不知道原样是啥」
    refreshDiffSurfaces(); // `refreshAll` 那条统一出口，与保存同一条路
    expect(diffSurfaceOf(panel), "基线未知 ⇒ 该无（把整篇画成新增 = 一张会说谎的脸）").toBeNull();
    expect(
      panel.bodyEl!.querySelectorAll(".diff-original"),
      "旁路那颗 view 与那一排占位都不许留着",
    ).toHaveLength(0);
  });

  it("B461 · Step 5 同形路径：换标签不换面板也挂/拆；摘掉时折行还回**设置**的值而不是被回写漏掉的快照（R23-1）", () => {
    setIsWrap(true); // 用户设置：开着折行（差异格里被强制关掉的那一发不许冒充他的设置）
    const { panel } = mountLiveBaselinePair("甲\n乙\n丙", "甲\n乙改\n丙");
    const diffTab = tabs.get(panel.viewTabId!)!;
    expect(
      diffTab.comps.wrap.get(panel.view!.view.state),
      "前置：旁路挂着时这一栏折行是关的",
    ).toEqual([]);
    // `switchTab` 切出时同形回写：强制关掉的折行就这样漏进了标签快照。
    diffTab.state = panel.view!.view.state;
    const editorTab = tabWithKind("editor");
    tabs.set(editorTab.tabId, editorTab);
    panel.tabs.push(editorTab.tabId);
    // 换到普通标签（三条同形路径之一）⇒ 旁路该拆
    panel.activeTabId = editorTab.tabId;
    panel.viewTabId = editorTab.tabId;
    syncDiffSurface(panel);
    expect(diffSurfaceOf(panel), "显示的不是差异标签 ⇒ 该无").toBeNull();
    // 换回差异标签：view 切到那份**漏了折行关闭**的快照，再点名
    panel.view!.setState(diffTab.state);
    panel.activeTabId = diffTab.tabId;
    panel.viewTabId = diffTab.tabId;
    syncDiffSurface(panel);
    expect(diffSurfaceOf(panel), "换标签不换面板 ⇒ 该挂").not.toBeNull();
    // 再换走、拆掉 ⇒ 旧判据（从 view.state 记现值）会还回「关着」，用户的折行再也回不来
    panel.activeTabId = editorTab.tabId;
    panel.viewTabId = editorTab.tabId;
    syncDiffSurface(panel);
    expect(
      diffTab.comps.wrap.get(panel.view!.view.state),
      "R23-1：还值的权威是设置，不是那颗被回写漏掉的快照",
    ).toBe(EditorView.lineWrapping);
  });

  it("B461 · R23-2：差异格挂着时折行被重新打开 ⇒ 同一个 syncDiffSurface 入口把强制关压回去", () => {
    const { panel } = mountLiveBaselinePair("甲\n乙\n丙", "甲\n乙改\n丙");
    const diffTab = tabs.get(panel.viewTabId!)!;
    setIsWrap(true);
    applyWrapToTabs(true); // 设置那一发：同一颗 Compartment 在 live surface 之下被重配
    expect(
      diffTab.comps.wrap.get(panel.view!.view.state),
      "设置那一发末尾补的那一遍要真的压回去（`refreshDiffSurfaces` 那条接线）",
    ).toEqual([]);
    // 再手动发一次**同样的漂移**（`applyWrapToTabs` 里就是这一手），但不跟着点
    // `refreshDiffSurfaces` —— 那一发的接线由上面那一条与下面的接线点位用例分别钉住；
    // 这里要单独证的是 `reassert` 自己认不认得出这层漂移（`applyPanelMode` 那一条出口）。
    panel.view!.view.dispatch({
      effects: diffTab.comps.wrap.reconfigure(EditorView.lineWrapping),
    });
    expect(
      diffTab.comps.wrap.get(panel.view!.view.state),
      "前置：刚翻回来是开的（两栏又分家了）",
    ).toBe(EditorView.lineWrapping);
    syncDiffSurface(panel); // 与 `applyPanelMode` 末尾同形：一致分支现在得把漂移补上
    expect(
      diffTab.comps.wrap.get(panel.view!.view.state),
      "翻设置之后差异格仍不许折行（行行对齐是设计稿 ⑥ 的头条）",
    ).toEqual([]);
  });

  it("B461 · R23-2：差异格挂着时翻主题 ⇒ 左栏按现值重配，两栏不许叠在不同基色上", () => {
    const { panel, s } = mountLiveBaselinePair("甲\n乙\n丙", "甲\n乙改\n丙");
    const diffTab = tabs.get(panel.viewTabId!)!;
    // 前置：这一格现在两张都是亮色。判据取 `EditorView.darkTheme` 那一颗 facet，不取 DOM
    // 类名 —— CM6 把基础亮/暗样式写成 `StyleModule.newName()` 生成的随机类名（没有 `cm-dark`
    // 这种稳定名可读），而这一颗 facet 才是「两张 view 叠在同一套基色上」的权威读数
    //（`src/editor/theme.ts` 的 `shellStyles` 那段注释把这一点记过一遍，B376 的回归点）。
    expect(s.left.state.facet(EditorView.darkTheme), "前置：左栏亮色").toBeFalsy();
    expect(panel.view!.view.state.facet(EditorView.darkTheme), "前置：右栏亮色").toBeFalsy();

    applyDarkToTabs(true, "2026"); // 设置那一发：右栏那颗主题 Compartment 换成暗色
    syncDiffSurface(panel); // 与 `applyPanelMode` 末尾同形：一致分支现在得把漂移补上

    expect(panel.view!.view.state.facet(EditorView.darkTheme), "前置：右栏真翻了暗色").toBeTruthy();
    // 判据是**两栏同一颗**：18% 的改动色是透明的，叠在不同基色上就不是同一个颜色（R22）。
    expect(
      s.left.state.facet(EditorView.darkTheme),
      "右栏翻了暗色而左栏还停在亮色 ⇒ 半深半浅的一张脸",
    ).toBeTruthy();
    expect(
      s.left.state.facet(EditorView.darkTheme),
      "两栏读到的必须是同一个值（左栏吃右栏的现值，不是自己再配一份）",
    ).toBe(panel.view!.view.state.facet(EditorView.darkTheme));
    expect(
      diffTab.comps.theme.get(panel.view!.view.state),
      "右栏的主题 Compartment 有现值",
    ).not.toBe(undefined);
  });

  it("B461 · R23-3：同一格第二次 createDiffSurface ⇒ 先拆在任那颗，不许两颗 live surface 叠着", () => {
    setIsWrap(true);
    const { panel, s: first } = mountLiveBaselinePair("甲\n乙\n丙", "甲\n乙改\n丙");
    const second = createDiffSurface(panel.bodyEl as HTMLElement, panel, {
      ...first.spec(),
      leftText: () => "换了一份基线",
    });
    expect(second).not.toBe(first);
    expect(panel.diffSurface, "记账位指的是新那一份").toBe(second);
    expect(
      first.left.dom.parentElement,
      "旧左栏那颗 view 真被 destroy（CM6 destroy 会摘掉自己的 DOM）",
    ).toBeNull();
    expect(panel.bodyEl!.querySelectorAll(".diff-original"), "一格只许一排旁路").toHaveLength(1);
    const diffTab = tabs.get(panel.viewTabId!)!;
    expect(diffTab.comps.wrap.get(panel.view!.view.state), "新那一份的强制关还在").toEqual([]);
    second.dispose();
    expect(
      diffTab.comps.wrap.get(panel.view!.view.state),
      "还值的是新那一份（旧那一份若在，会把这一手踩成它的现值）",
    ).toBe(EditorView.lineWrapping);
  });

  it("B461 · 换标签再换回来不许留下第二张底色面（拆之前回写进快照的那一臂必须摘掉）", () => {
    const { panel } = mountLiveBaselinePair("甲\n乙\n丙", "甲\n乙改\n丙");
    const diffTab = tabs.get(panel.viewTabId!)!;
    // `switchTab` 切出时的同形回写：快照里带着 surface#1 那一臂（provider 读的是它的旧块表）。
    diffTab.state = panel.view!.view.state;
    panel.activeTabId = -1;
    panel.viewTabId = -1; // 寻址已经离开这张标签（拆点只认「该不该有」）
    syncDiffSurface(panel); // 拆
    // 再显示它：setState 吃的正是那份快照，然后重挂。
    panel.view!.setState(diffTab.state);
    panel.activeTabId = diffTab.tabId;
    panel.viewTabId = diffTab.tabId;
    syncDiffSurface(panel);
    const s2 = diffSurfaceOf(panel);
    expect(s2, "换回来该重挂").not.toBeNull();
    // 把正文改成与基线一致 ⇒ 现 surface 重算成空块表。
    panel.view!.view.dispatch({ changes: { from: 3, to: 4 } }); // 删掉「改」⇒「甲\n乙\n丙」
    s2!.syncBlocks();
    expect(s2!.blocks(), "现这一份算出来是空的").toEqual([]);
    expect(
      panel.view!.view.dom.querySelectorAll(".cm-line[class*='diff-line-']").length,
      "旧那一臂的 provider 还读着拆掉前的块表 ⇒ 快照不摘臂就是永久画错行",
    ).toBe(0);
  });

  it("B461 · 接线点位：applyPanelMode 末尾 / 两颗外观 setter / refreshAll 统一出口 / md 两颗键退场", () => {
    // ⚠️ 判据取**剥掉行注释**的函数体：`fnBody` 里残留的说明文字会替实现「过关」
    //（`tests/diff-surface.test.ts:294` 那条反向纪律，Task 4 一轮真踩过）。
    expect(fnBody(stripLineComments(srcOf("src/markdown.ts")), "applyPanelMode")).toContain(
      "syncDiffSurface(panel)",
    );
    const appearance = stripLineComments(srcOf("src/appearance.ts"));
    expect(fnBody(appearance, "applyWrapToTabs")).toContain("refreshDiffSurfaces()");
    expect(fnBody(appearance, "applyDarkToTabs")).toContain("refreshDiffSurfaces()");
    const ui = srcOf("src/ui.ts");
    expect(
      fnBody(ui, "refreshAll"),
      "保存路径没有 applyPanelMode ⇒ 基线补色挂在这条统一出口",
    ).toContain("refreshDiffSurfacesRef()");
    const main = srcOf("src/main.ts");
    expect(main).toContain("setRefreshDiffSurfaces(refreshDiffSurfaces)");
    expect(main).toContain("setDiffRenderHooks(");
    expect(srcOf("src/tabs/render.ts")).toMatch(/act\.kind !== "diff"/);
  });
});

// --------------------------------------------------------------------------- #
// Task 6 —— B 档（files tier）：左栏那颗只读栏的锁**随旁路一起继承**，不分档位。
//
// 这条先写下来时就该是绿的：`createDiffSurface` 的只读锁（`EditorState.readOnly` +
// `editable(false)` + `contentAttributes` + 丢 docChanged 的 `transactionFilter`）是
// **spec 无关**的（Task 3 落地时就没按档位分叉）⇒ B 档不需要新代码，也**不许**需要。
// 它钉的是这条不变量本身：以后谁给旁路加档位分叉、把 files 档的左栏做成可写的，这里发红。
// --------------------------------------------------------------------------- #

/** 与 `mountDiffPair` 同形的一格，但 spec 是 B 档（files tier：左栏来自另一条路径的只读快照）。 */
function mountedBFilesSurface(): DiffSurface {
  const hostEl = document.createElement("div");
  hostEl.className = "panel-host";
  document.body.appendChild(hostEl);
  const editorEl = document.createElement("div");
  editorEl.className = "panel-editor";
  hostEl.appendChild(editorEl);
  const doc = makeDoc(100, "右栏正文\n它的第二行", "b.md", "D:/b.md", "UTF-8", "LF", false);
  docs.set(doc.tabId, doc);
  const { state, comps } = makeTabState(
    "右栏正文\n它的第二行",
    null,
    { dark: false, wrap: true, perf: perfProfileFor("normal") },
    () => {},
  );
  const diff: DiffSpec = {
    tier: "files",
    docId: doc.tabId,
    leftText: () => "左栏正文\n它的第二行",
    leftName: "a.md",
    rightName: "b.md",
    leftPath: "D:/a.md",
  };
  const tab: Tab = {
    tabId: nextTabId++,
    docId: doc.tabId,
    panelId: 0,
    comps,
    state,
    viewMode: "source",
    kind: "diff",
    diff,
    scrollV: 1,
  };
  tabs.set(tab.tabId, tab);
  const panel: Panel = {
    panelId: 0,
    tabs: [tab.tabId],
    activeTabId: tab.tabId,
    view: createEditor(editorEl, state),
    viewTabId: tab.tabId,
    bodyEl: hostEl,
    diffSurface: null,
  };
  const s = createDiffSurface(hostEl, panel, diff);
  live.push(() => disposeDiffSurface(panel));
  return s;
}

describe("B461 · B 档左栏继承只读锁（Task 6 Step 6）", () => {
  it("B461 · 左栏那颗视图真的写不进去，但选得了字", () => {
    const s = mountedBFilesSurface();
    const before = s.left.state.doc.toString();
    expect(s.left.state.facet(EditorState.readOnly)).toBe(true);
    s.left.dispatch({ changes: { from: 0, insert: "X" } });
    expect(s.left.state.doc.toString(), "裸派发进不去（锁是行为，不只 facet）").toBe(before);
    // `editable(false)` 写出的那颗属性必须是 false（`contentEditable` 属性读取不许是 "true"）
    expect(s.left.contentDOM.getAttribute("contenteditable")).toBe("false");
    expect(s.left.contentDOM.contentEditable).not.toBe("true");
    expect(s.left.contentDOM.getAttribute("tabindex"), "点得进焦点才选得了字").toBe("0");
    s.dispose();
  });
});

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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { EditorView } from "@codemirror/view";
import { fnBody, ruleBlock, stripCssComments, stripLineComments } from "./static";
import { tabs, type Panel, type Tab } from "../src/core/app-state";
import { createEditor, makeTabState } from "../src/editor/editor";
import { perfProfileFor } from "../src/editor/perf";
import {
  createDiffSurface,
  disposeDiffSurface,
  diffSurfaceOf,
  syncDiffSurface,
  type DiffSurface,
} from "../src/diff/surface";
import { DIFF_REFRESH_MS } from "../src/diff/align";
import { setDiffBlocksListener } from "../src/diff/model";
import type { DiffSpec } from "../src/diff/model";

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
    const surface = createDiffSurface(hostEl, panel, spec());
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
    // retarget（Task 6 的「交换左右」用它）：换输入、不换那颗 view 本身 —— 整态换 state
    // 不是事务，不受上面那道硬闸牵连（这正是它比 `dispatch({changes})` 合适的地方）。
    const before = surface.left;
    surface.retarget(spec({ leftText: () => "换过来了" }));
    expect(surface.left).toBe(before);
    expect(surface.left.state.doc.toString()).toContain("换过来了");
    expect(surface.spec().leftText()).toBe("换过来了");
    // 换过输入之后闸还在（闸是 state 自带的，不随 retarget 掉）
    surface.left.dispatch({ changes: { from: 0, insert: "X" } });
    expect(surface.left.state.doc.toString(), "retarget 之后硬闸照样一字不改").toBe("换过来了");
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

afterEach(() => {
  for (const stop of live.splice(0)) stop();
  setDiffBlocksListener(null);
  vi.useRealTimers();
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
    expect(srcOf("src/diff/surface.ts")).toContain("claimVisibleHere(");
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
    expect(s.activeIndex(), "空段包不住自己的落点 ⇒ 谁都没包住").toBe(-1);
    s.step(-1);
    expect(line(), "往回必须真动起来（改块在右栏第 2 行），不许落回同一行").toBe(2);
    expect(s.activeIndex()).toBe(0);
    s.step(1);
    expect(line(), "再往前又是那道删除缝").toBe(4);
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

// @vitest-environment jsdom
// B461 · Task 9 —— 左栏第五块「差异」的**行为**（`src/diff/panel.ts`）。
//
// 骨架用真实 index.html（`#side-diff` / `#diff-panel` / `#diff-list` 得是真节点），
// 旁路与块表都是**真的**：`createDiffSurface` + 真 `diffBlocks`，面板读的是 surface 的现值 ——
// 桩一块 surface 就等于把「同源」那条判据换成我自己的替身（跨文件契约在 tests/diff-drawer-contract.test.ts）。
//
// ⚠️ 摊开这一块**必须经过那一下点击**：`registerDrawerView` 不接管点击（B314-8 那颗死键
//    只有真点一下才照得出）。`setDrawer("diff")` 测的是外壳，不是这颗键。
// ⚠️ `src/ui.ts` 在模块求值期就逐个 `el(id)` 取节点，而 `ui.*` 那颗引用**只认灌骨架那一刻的
//    节点** ⇒ 本文件绝不在用例之间清空 body（清了就是「拿着一串脱链节点测 DOM」）。
//    要洗的是自己 append 的那几颗 `.panel-host`。
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Text } from "@codemirror/state";
import {
  activePanelId,
  docs,
  panels,
  setActivePanelId,
  tabs,
  type Panel,
  type Tab,
} from "../src/core/app-state";
import { createEditor, makeTabState } from "../src/editor/editor";
import { perfProfileFor } from "../src/editor/perf";
import { makeDoc } from "../src/doc-model";
import { syncDiffSurface, type DiffSurface } from "../src/diff/surface";
import { diffBlocks } from "../src/diff/blocks";
import { type DiffSide, type DiffSpec } from "../src/diff/model";

const LEFT = "1\n2\n3\n4\n5\n6\n7";
const RIGHT = "1\nX\n3\nN\n4\n6\n7";
/** A 档那份基线（可变：`surface.syncBlocks()` 现读它，用例据此把块表清空）。 */
let baseline = LEFT;

let drawer: typeof import("../src/shell/drawer");
let mod: typeof import("../src/diff/panel");
let ui: typeof import("../src/ui");

/** 装配**完成那一刻**列表里是什么（`beforeEach` 会清列表 ⇒ 这一格必须抓在清之前）。 */
let initialListText = "";

beforeAll(async () => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
  [drawer, mod, ui] = await Promise.all([
    import("../src/shell/drawer"),
    import("../src/diff/panel"),
    import("../src/ui"),
  ]);
  // 装配**只跑一次**：`registerDrawerView` 按名字进 Map（重复登记是换同一份 spec），
  // 而那颗键的 click 是往节点上加监听 —— 跑两遍就是点一次翻两回。
  mod.setupDiffPanel();
  initialListText = ui.diffList.textContent ?? "";
});

function spec(over: Partial<DiffSpec> = {}): DiffSpec {
  return {
    tier: "baseline",
    docId: 100,
    leftDocId: null,
    leftText: () => baseline,
    leftName: "a.md（上次保存）",
    rightName: "a.md",
    leftPath: null,
    ...over,
  };
}

/** 一张标签：右栏正文 = `RIGHT`；`kind === "diff"` 时 Doc 100 的基线 = `baseline`（A 档那道闸要问它）。 */
function makeTab(kind: "editor" | "diff", panelId = 0): Tab {
  const { state, comps } = makeTabState(
    RIGHT,
    null,
    { dark: false, wrap: true, perf: perfProfileFor("normal") },
    () => {},
  );
  const doc = makeDoc(100, RIGHT, "a.md", null, "UTF-8", "LF", false);
  doc.baseline = baseline;
  docs.set(100, doc);
  return {
    tabId: nextTabId++,
    docId: 100,
    panelId,
    comps,
    state,
    viewMode: "source",
    kind,
    diff: kind === "diff" ? spec() : null,
    scrollV: 1,
  };
}

let nextTabId = 1;

function freshPanel(panelId = 0): Panel {
  return {
    panelId,
    tabs: [],
    activeTabId: -1,
    view: null,
    viewTabId: null,
    bodyEl: null,
    diffSurface: null,
  };
}

/**
 * 复刻 `src/tabs/lifecycle.ts` 的 `mountView` 那几步（口径同 tests/diff-surface.test.ts）：
 * 建 `.panel-editor` → 挂右栏那颗 view → 记 `bodyEl` → 交给**生产的** `syncDiffSurface` 判挂不挂。
 * `sameView` 那一发是「同一格换一张标签显示」= `switchTab` 的 setState 那条路。
 */
function mount(hostEl: HTMLElement, p: Panel, tab: Tab, sameView = false): void {
  tabs.set(tab.tabId, tab);
  p.tabs = [tab.tabId];
  p.activeTabId = tab.tabId;
  p.viewTabId = tab.tabId;
  if (!sameView) {
    const editorEl = document.createElement("div");
    editorEl.className = "panel-editor";
    hostEl.appendChild(editorEl);
    p.bodyEl = hostEl;
    p.view = createEditor(editorEl, tab.state);
  } else {
    p.view!.setState(tab.state);
  }
  syncDiffSurface(p);
}

/** 同一格换一张标签显示（`switchTab` 的 setState 那条路）：view 不换，只换 state。 */
function swapShownTab(p: Panel, tab: Tab): void {
  mount(p.bodyEl as HTMLElement, p, tab, true);
}

function addHost(): HTMLElement {
  const hostEl = document.createElement("div");
  hostEl.className = "panel-host";
  document.body.appendChild(hostEl);
  return hostEl;
}

let surface: DiffSurface;

/** 一张差异标签挂在面板 0，装配第五块并把那一块摊开。 */
function setupDiff(): void {
  const p = freshPanel(0);
  panels.set(0, p);
  setActivePanelId(0);
  mount(addHost(), p, makeTab("diff"));
  surface = p.diffSurface as DiffSurface;
  drawer.setDrawer("diff", false);
}

const rows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>("#diff-list .diff-item"),
];
const activeRow = (): number => rows().findIndex((r) => r.classList.contains("diff-active"));
const rightCaret = (): number => {
  const v = panels.get(0)!.view!.view;
  return v.state.doc.lineAt(v.state.selection.main.head).number;
};
const emptyText = (): string => document.querySelector(".diff-empty")?.textContent ?? "";

beforeEach(() => {
  baseline = LEFT;
  tabs.clear();
  docs.clear();
  panels.clear();
  drawer.setDrawer(null, false);
  document.querySelectorAll("body > .panel-host").forEach((n) => n.remove());
  ui.diffList.innerHTML = "";
  ui.diffCount.textContent = "";
  nextTabId = 1;
});
// ⚠️ 块表通知那一格注册槽**不在用例之间清**：它是 `setupDiffPanel()`（只跑一次）装上的，
//    清掉就等于把「surface 广播 → 面板重画」这条接缝整段摘了 —— 两条用例会因此静默变红/变绿。

describe("B461 · diffRowsOf 纯函数（一块一行）", () => {
  const read = (side: DiffSide, n: number): string =>
    (side === "original" ? Text.of(LEFT.split("\n")) : Text.of(RIGHT.split("\n"))).line(n).text;

  it("B461 · 改 / 增 / 删各一行：摘要取右栏首行，删除那行取左栏并前置 −", () => {
    const out = mod.diffRowsOf(diffBlocks(LEFT, RIGHT), read);
    expect(out).toHaveLength(3);
    // 块表（真 `diffBlocks`）：modify 2–2 → 2–2；insert 左是空段（落点第 4 行）/ 右 4–4；
    // delete 左 5–5 / 右是空段（落点第 6 行）。
    expect(out[0]).toMatchObject({ index: 0, kind: "modify", summary: "X", range: "2–2 → 2–2" });
    expect(out[1]).toMatchObject({
      index: 1,
      kind: "insert",
      added: 1,
      summary: "N",
      range: "4 → 4–4",
    });
    expect(out[2]).toMatchObject({
      index: 2,
      kind: "delete",
      removed: 1,
      summary: "−5",
      range: "5–5 → 6",
    });
  });

  it("B461 · 徽标只有一侧有数：行级块表里 added 与 removed 恒不同时非零", () => {
    // `added = max(bLen - aLen, 0)` / `removed = max(aLen - bLen, 0)` ⇒ 简报举例的「+2 −1」
    // 那一形在**行级**块里出不来（它是字符级统计）。这条钉住的是「面板不自己另算一份计数」。
    for (const b of diffBlocks(LEFT, RIGHT)) {
      expect(Math.min(b.added, b.removed), JSON.stringify(b)).toBe(0);
    }
    const out = mod.diffRowsOf(diffBlocks("a\nb\nc", "a\nX\nY\nZ\nc"), read);
    expect(out[0].added).toBe(2);
    expect(out[0].removed).toBe(0);
  });

  it("B461 · 空态两句分场景，不许一片白", () => {
    expect(mod.emptyTextFor("notDiff")).toBe("当前标签不是差异编辑器");
    expect(mod.emptyTextFor("noBlocks")).toBe("两份内容一致 —— 没有差异项");
  });
});

describe("B461 · 装配那一刻就画（boot 还原出来的抽屉不等用户点一下）", () => {
  it("B461 · setupDiffPanel 落地即写出空态：抽屉开着而列表一片白 = 用户以为功能坏了", () => {
    // 病根：`setDrawer` 的 boot 回放先跑（那时本视图还没登记，`onShow` 落在空处），
    // 而 `registerDrawerView` 只管显隐与亮灭 —— 不补这一发，还原出来就是白板（真机 A-00 抓到）。
    expect(initialListText).not.toBe("");
    expect(initialListText).toContain(mod.emptyTextFor("notDiff"));
  });
});

describe("B461 · 第五块的行为", () => {
  it("B461 · 真点那颗键才摊开：条目数 == 块数，计数徽标跟着，再点收起", () => {
    setupDiff();
    drawer.setDrawer(null, false);
    expect(ui.diffPanel.hidden, "前置：先收着").toBe(true);
    ui.sideDiff.click();
    expect(ui.diffPanel.hidden).toBe(false);
    expect(ui.sideDiff.getAttribute("aria-pressed")).toBe("true");
    expect(rows()).toHaveLength(surface.blocks().length);
    expect(ui.diffCount.textContent).toBe(String(surface.blocks().length));
    ui.sideDiff.click();
    expect(ui.diffPanel.hidden, "再点一次是收起，不是换一块").toBe(true);
  });

  it("B461 · 点一条 = 两侧同时落到那块，活动行跟着搬且只有一行亮", () => {
    setupDiff();
    rows()[2].click();
    // 删除块：右栏落点 = 空段落点行（第 6 行），左栏 = 被删那一行（第 5 行）。
    expect(rightCaret()).toBe(6);
    expect(surface.left.state.selection.main.from).toBe(surface.left.state.doc.line(5).from);
    expect(activeRow()).toBe(2);
  });

  it("B461 · 画的是哪一格要记账：列是上一格画的时，点一条先把它设为活动格", () => {
    setupDiff();
    const drawn = panels.get(0)!;
    const other = freshPanel(1);
    panels.set(1, other);
    // 面板 1 挂一张普通标签（没有旁路）。它挂载那一刻不是活动格 ⇒ 不广播，抽屉仍画着面板 0。
    mount(addHost(), other, makeTab("editor", 1));
    // 只点面板 1 的正文（`markActivePanel` 那条路）：没有切标签，抽屉不会自动重画。
    setActivePanelId(1);
    expect(activePanelId).toBe(1);
    rows()[1].click();
    expect(activePanelId, "半跳状态：条目动了而那一格还不是活动格").toBe(drawn.panelId);
    expect(rightCaret(), "换完活动格之后那一跳得真落在 insert 块").toBe(4);
  });

  it("设计稿 ⑩·2 · 权威只有右栏：左栏里有选区也不许抢面板高亮", () => {
    setupDiff();
    rows()[2].click();
    expect(activeRow()).toBe(2);
    // 把**左栏**的光标挪到第 2 行（那是 modify 块的位置）。
    surface.left.dispatch({ selection: { anchor: surface.left.state.doc.line(2).from } });
    mod.refreshDiffAtCursor();
    expect(activeRow(), "左栏光标把高亮抢走了").toBe(2);
  });

  it("B388 闸 · 同一块不重建 DOM；抽屉收着时一个字都不画", () => {
    setupDiff();
    rows()[1].click();
    const first = document.querySelector("#diff-list .diff-item");
    mod.refreshDiffAtCursor();
    mod.refreshDiffAtCursor();
    expect(
      document.querySelector("#diff-list .diff-item"),
      "序号没变也重绘 = 每键一次全量重建",
    ).toBe(first);
    drawer.setDrawer(null, false);
    const p = panels.get(0)!;
    p.view!.view.dispatch({ selection: { anchor: p.view!.view.state.doc.line(6).from } });
    mod.refreshDiffAtCursor();
    expect(document.querySelector("#diff-list .diff-item")).toBe(first);
  });

  it("B486 · 切走那张差异标签：列表当场换成空态，不留在上一张的块上", () => {
    setupDiff();
    rows()[2].click();
    const p = panels.get(0)!;
    swapShownTab(p, makeTab("editor"));
    expect(p.diffSurface, "前置：旁路已被生产判据拆掉").toBeNull();
    expect(rows(), "切到普通标签后还画着上一张差异标签的块").toHaveLength(0);
    expect(emptyText()).toBe(mod.emptyTextFor("notDiff"));
    expect(ui.diffCount.textContent, "计数也得跟着走").toBe("");
    // 光标跟随那条路不许把旧行重新画回来。
    mod.refreshDiffAtCursor();
    expect(rows()).toHaveLength(0);
  });

  it("B461 · 点一条陈旧的（那一格已经没了）：当场换成那句空态，不许留一颗点不动的行", () => {
    setupDiff();
    // 模拟「最后一格被关掉、没有别的面板接棒」：条目还在，旁路与面板都没了。
    panels.delete(0);
    setActivePanelId(-1);
    rows()[0].click();
    expect(rows()).toHaveLength(0);
    expect(emptyText()).toBe(mod.emptyTextFor("notDiff"));
  });

  it("B205 · 头部常驻、只有列表重绘；块表清空了就换那句空态", () => {
    setupDiff();
    const title = document.getElementById("diff-title")!;
    title.textContent = "差异·哨兵";
    // 基线换成与右栏一致 ⇒ 真 `syncBlocks()` 重算（0 块）并经注册槽通知面板。
    baseline = RIGHT;
    surface.syncBlocks();
    expect(title.textContent, "重绘把标题栏一起抹了 = 头部常驻破了").toBe("差异·哨兵");
    expect(rows()).toHaveLength(0);
    expect(emptyText()).toBe(mod.emptyTextFor("noBlocks"));
    expect(ui.diffCount.textContent).toBe("0");
  });

  it("B461 · 非差异标签那一路：空态说的是「当前标签不是差异编辑器」，计数留空", () => {
    const p = freshPanel(0);
    panels.set(0, p);
    setActivePanelId(0);
    mount(addHost(), p, makeTab("editor"));
    drawer.setDrawer("diff", false);
    expect(emptyText()).toBe(mod.emptyTextFor("notDiff"));
    expect(ui.diffCount.textContent).toBe("");
  });

  it("B461 · 挂上旁路那一刻就画：切回差异标签不等下一次键入", () => {
    const p = freshPanel(0);
    panels.set(0, p);
    setActivePanelId(0);
    mount(addHost(), p, makeTab("editor"));
    drawer.setDrawer("diff", false);
    expect(rows(), "前置：这一格现在不是差异标签").toHaveLength(0);
    swapShownTab(p, makeTab("diff"));
    expect(rows(), "`syncDiffSurface` 挂上旁路却没广播 = 列表要等用户打一个字才复活").toHaveLength(
      3,
    );
  });
});

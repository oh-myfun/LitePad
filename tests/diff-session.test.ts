// @vitest-environment jsdom
// B461 · Task 10 —— 差异标签的**会话字段 / 恢复 / 禁搬移边界**。
//
// 三件事各自有唯一的红法：
//   ① 旧会话缺 `kind` 键 ⇒ 普通编辑器标签（B392 那一课：「没记过」不许被收成任何具体值）；
//   ② 两张差异标签都进会话、都恢复得回来（A 档右栏是同文档第二份实例，B 档左栏读一次盘）；
//   ③ 跨面板 / 跨窗口那几条路径**显式缺席**（设计稿 ⑧·3 + Review Focus 3），关差异标签不牵连原标签与 doc（⑦⑥）。
//
// ⚠️ `src/ui.ts` 在模块求值期就逐个 `el(id)` 取节点 ⇒ 灌骨架必须排在动态 import 之前，
//    且用例之间**绝不**清空 body（清了就是拿着一串脱链节点测 DOM）。洗的只是自己 append 的那几颗。
// ⚠️ 模型层用**命名空间**动态 import（`model.diffKindOf`）：出口还没落地时红在断言那一层
//    （「is not a function」），而不是整份文件红在 import 解析上 —— 后者会把其余用例一起遮住。
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  activePanelId,
  docs,
  layout,
  panels,
  setActivePanelId,
  setLayout,
  tabs,
  type Doc,
  type Panel,
  type Tab,
} from "../src/core/app-state";
import { countLeaves, leaf } from "../src/core/layout";
import { createEditor, makeTabState } from "../src/editor/editor";
import { perfProfileFor } from "../src/editor/perf";
import { makeDoc } from "../src/doc-model";
import { syncDiffSurface } from "../src/diff/surface";
import { sessionStore } from "../src/session/store";
import { closePopupMenu } from "../src/shell/menu";
import type { DiffSpec } from "../src/diff/model";

/** 盘上那一头（会话 / 只读对比缓冲 / 热退出副本）由用例现摆，恢复流程吃的是同一份。 */
const wire = vi.hoisted(() => ({
  session: null as unknown,
  backup: null as unknown,
  compare: new Map<string, string>(),
  /** 「盘上版本」夹具：与 compare 里的文本同一份，恢复基线时按它对表。 */
  compareVersion: new Map<string, { mtimeMs: number; size: number }>(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTitle: () => Promise.resolve(),
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    isAlwaysOnTop: () => Promise.resolve(false),
    setAlwaysOnTop: () => Promise.resolve(),
    onCloseRequested: () => Promise.resolve({ catch: () => {} }),
    close: () => Promise.resolve(),
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve({ unlisten: () => {} }),
  emit: () => Promise.resolve(),
  emitTo: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve({ unlisten: () => {} }),
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
  open: () => Promise.resolve(null),
  save: () => Promise.resolve(null),
}));

vi.mock("../src/ipc/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ipc/api")>();
  return {
    ...actual,
    loadSession: () => Promise.resolve(wire.session),
    saveSession: () => Promise.resolve(),
    logEvent: () => {},
    emitCrossWindow: async () => {},
    closeTab: () => Promise.resolve(),
    newTab: () =>
      Promise.resolve({
        tabId: 1,
        name: "未命名",
        readonly: false,
        encoding: "UTF-8",
        eol: "CRLF",
      }),
    // docId 与夹具里的记录对齐（100 + 首字母码位）：同源多实例按它归组，对不上就等于
    // 线上少了一层身份，「两条记录同一份 doc」这条判据永远命中不了。
    openFile: (path: string) =>
      Promise.resolve({
        tabId: 100 + path.charCodeAt(0),
        text: `T-${path}\nsecond line\nthird line`,
        name: path,
        path,
        encoding: "UTF-8",
        eol: "LF",
        readonly: false,
        mixedEol: false,
        reused: false,
        lossy: false,
        sizeClass: "normal",
        sizeHint: "",
        mtimeMs: 1,
        size: 30,
      }),
    restoreBackup: () => Promise.resolve(wire.backup),
    readCompareText: (path: string) => {
      const text = wire.compare.get(path);
      if (text === undefined) return Promise.reject(new Error(`读不到 ${path}`));
      const v = wire.compareVersion.get(path) ?? { mtimeMs: 0, size: 0 };
      return Promise.resolve({ text, encoding: "UTF-8", eol: "LF", ...v });
    },
  };
});

let model: typeof import("../src/diff/model");
let rebuild: typeof import("../src/session/rebuild");
let persist: typeof import("../src/session/persist");
let split: typeof import("../src/tabs/split");
let lifecycle: typeof import("../src/tabs/lifecycle");
let tabstrip: typeof import("../src/shell/tabstrip");
let ui: typeof import("../src/ui");

beforeAll(async () => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
  [model, rebuild, persist, split, lifecycle, tabstrip, ui] = await Promise.all([
    import("../src/diff/model"),
    import("../src/session/rebuild"),
    import("../src/session/persist"),
    import("../src/tabs/split"),
    import("../src/tabs/lifecycle"),
    import("../src/shell/tabstrip"),
    import("../src/ui"),
  ]);
});

beforeEach(() => {
  tabs.clear();
  docs.clear();
  panels.clear();
  sessionStore.reset();
  wire.session = null;
  wire.backup = null;
  wire.compare.clear();
  wire.compareVersion.clear();
  ui.sbMessage.textContent = "";
  closePopupMenu();
  for (const el of document.querySelectorAll("body > .panel-host, body > .tabstrip-host")) {
    el.remove();
  }
});

// ---------------------------------------------------------------- ① 会话字段

/** 一条落盘记录（只给会话真正关心的那几格）。 */
function rec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: "a.md",
    encoding: "UTF-8",
    eol: "LF",
    cursorLine: 1,
    cursorCol: 1,
    ...over,
  };
}

describe("B461 · 会话字段（Review Focus 2）", () => {
  it("老 session 里没有 kind 键 ⇒ 恢复成普通标签（不许把缺失读成 diff）", () => {
    const r = rec();
    expect(r.kind ?? null).toBeNull();
    expect(model.diffKindOf(r)).toBe("editor");
    expect(model.diffKindOf(rec({ kind: null }))).toBe("editor");
    // 认不出的串也不许当差异：会话是磁盘上的数据，不是枚举校验过的内存值。
    expect(model.diffKindOf(rec({ kind: "weird" }))).toBe("editor");
    expect(model.diffKindOf(rec({ kind: "diff" }))).toBe("diff");
  });

  it("kind / diffLeftPath 必须显式落盘成 null（不许整格抹掉）", () => {
    sessionStore.register(1, 100);
    sessionStore.setPanel(0, [1], 1);
    const plain = sessionStore.toSessionState(() => true).panels[0].tabs[0];
    expect(plain).toHaveProperty("kind");
    expect(plain).toHaveProperty("diffLeftPath");
    expect(JSON.parse(JSON.stringify(plain))).toHaveProperty("kind", null);
    expect(JSON.parse(JSON.stringify(plain))).toHaveProperty("diffLeftPath", null);

    sessionStore.setTabKind(1, "diff", "E:\\cmp\\left.md");
    const diff = sessionStore.toSessionState(() => true).panels[0].tabs[0];
    expect(diff.kind).toBe("diff");
    expect(diff.diffLeftPath).toBe("E:\\cmp\\left.md");
  });

  it("Rust 侧那两格必须是 Option，且不挂 skip_serializing_if", () => {
    const src = readFileSync("src-tauri/src/session/mod.rs", "utf-8");
    expect(src).toMatch(/pub kind: Option<String>/);
    expect(src).toMatch(/pub diff_left_path: Option<String>/);
    // 自证判据有鉴别力：把 Option 抹成 String，上面两条必须落空。
    const degraded = src
      .replace("pub kind: Option<String>", "pub kind: String")
      .replace("pub diff_left_path: Option<String>", "pub diff_left_path: String");
    expect(degraded).not.toBe(src);
    expect(degraded).not.toMatch(/pub kind: Option<String>/);
    expect(src).not.toMatch(
      /skip_serializing_if = "Option::is_none"\s*\n\s*pub (kind|diff_left_path):/,
    );
    // Default 也得带上这两格（漏一格 = 整个 struct 编不过，但判据要指着名字问）。
    const defaultBody = src.match(/impl Default for TabSession \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(defaultBody).toContain("kind: None");
    expect(defaultBody).toContain("diff_left_path: None");
  });
});

// ---------------------------------------------------------------- ② 恢复

/** 一份两会话面板的骨架：差异标签摆在**面板 1**，活动面板却是 0（落点不许坍到活动格）。 */
function sessionWith(tabs0: unknown[], tabs1: unknown[] = []): unknown {
  return {
    panels: [
      { active: 0, tabs: tabs0 },
      { active: 0, tabs: tabs1 },
    ],
    layout: {
      kind: "split",
      dir: "h",
      ratio: 0.5,
      a: { kind: "leaf", panelId: 0 },
      b: { kind: "leaf", panelId: 1 },
    },
    activePanel: 0,
  };
}

const A_PLAIN = rec({ path: "a.md", docId: 197 });
const A_DIFF = rec({ path: "a.md", docId: 197, kind: "diff", diffLeftPath: null });

describe("B461 · 差异标签进会话也恢复得回来", () => {
  it("A 档：右栏是同文档的第二份实例（一个 doc、两颗标签、基线是读取口）", async () => {
    wire.session = sessionWith([A_PLAIN, A_DIFF]);
    expect(await rebuild.restoreSession()).toBe(true);
    expect(docs.size, "两条记录同一个 path ⇒ 只该有一份 doc").toBe(1);
    expect(tabs.size).toBe(2);
    const diff = [...tabs.values()].find((t) => t.kind === "diff");
    expect(diff, "A 档那条记录得恢复成差异标签").toBeTruthy();
    expect(diff!.diff!.tier).toBe("baseline");
    expect(diff!.diff!.docId).toBe(197);
    expect(diff!.docId).toBe(197);
    const doc = docs.get(197) as Doc;
    expect(diff!.diff!.leftText()).toBe(doc.baseline);
    // 读取口不是快照：基线被换掉之后左栏跟着换（存完盘差异自己清空那条纪律）。
    doc.baseline = "换了基线";
    expect(diff!.diff!.leftText()).toBe("换了基线");
    expect(diff!.viewMode, "差异视图恒源码档").toBe("source");
  });

  it("B 档：左栏路径原样回来，正文读一次盘（不进文档登记表）", async () => {
    wire.compare.set("E:\\cmp\\left.md", "LEFT-B\nsecond");
    wire.session = sessionWith([
      rec({ path: "b.md", docId: 198 }),
      rec({ path: "b.md", docId: 198, kind: "diff", diffLeftPath: "E:\\cmp\\left.md" }),
    ]);
    expect(await rebuild.restoreSession()).toBe(true);
    const diff = [...tabs.values()].find((t) => t.kind === "diff");
    expect(diff, "B 档那条记录得恢复成差异标签").toBeTruthy();
    expect(diff!.diff!.tier).toBe("files");
    expect(diff!.diff!.leftPath).toBe("E:\\cmp\\left.md");
    expect(diff!.diff!.leftName).toBe("left.md");
    expect(diff!.diff!.leftText()).toBe("LEFT-B\nsecond");
    expect(docs.size, "只读对比缓冲不许注册成文档（不留孤儿 doc）").toBe(1);
  });

  it("差异标签回到它自己那一格，不是活动格", async () => {
    wire.session = sessionWith([A_PLAIN], [A_DIFF]);
    expect(await rebuild.restoreSession()).toBe(true);
    const diff = [...tabs.values()].find((t) => t.kind === "diff")!;
    expect(activePanelId).toBe([...panels.keys()][0]);
    expect(diff.panelId).not.toBe(activePanelId);
    expect(panels.get(diff.panelId)!.tabs).toContain(diff.tabId);
  });

  it("基线未知（热退出副本还原）⇒ 回落普通编辑器标签，不画一张全绿的脸", async () => {
    wire.backup = {
      tabId: 197,
      path: "a.md",
      name: "a.md",
      text: "脏正文",
      encoding: "UTF-8",
      eol: "LF",
      mixedEol: false,
      readonly: false,
      sizeClass: "normal",
      sizeHint: "",
    };
    wire.session = sessionWith([
      rec({ path: "a.md", docId: 197, backupId: "bk1" }),
      rec({ path: "a.md", docId: 197, backupId: "bk1", kind: "diff", diffLeftPath: null }),
    ]);
    expect(await rebuild.restoreSession()).toBe(true);
    expect(docs.get(197)!.baseline, "副本还原 ⇒ 没有基线").toBeNull();
    expect(tabs.size, "文件本身不许因为差异开不出来就丢掉").toBe(2);
    expect([...tabs.values()].every((t) => t.kind === "editor")).toBe(true);
  });

  /** 副本还原的夹具：盘上那份已保存正文 + 副本里改过之后的正文。 */
  function backupRestorePair(opts: {
    diskText: string;
    diskVersion: { mtimeMs: number; size: number };
    editedText: string;
    recordVersion?: { mtimeMs: number; size: number };
  }): void {
    wire.compare.set("a.md", opts.diskText);
    wire.compareVersion.set("a.md", opts.diskVersion);
    wire.backup = {
      tabId: 197,
      path: "a.md",
      name: "a.md",
      text: opts.editedText,
      encoding: "UTF-8",
      eol: "LF",
      mixedEol: false,
      readonly: false,
      sizeClass: "normal",
      sizeHint: "",
    };
    const v = opts.recordVersion ?? opts.diskVersion;
    wire.session = sessionWith([
      rec({ path: "a.md", docId: 197, backupId: "bk1", diskMtimeMs: v.mtimeMs, diskSize: v.size }),
      rec({
        path: "a.md",
        docId: 197,
        backupId: "bk1",
        kind: "diff",
        diffLeftPath: null,
        diskMtimeMs: v.mtimeMs,
        diskSize: v.size,
      }),
    ]);
  }

  it("副本还原的未保存文档：盘上还是上次保存那一版 ⇒ 基线取磁盘正文，可与它比较", async () => {
    backupRestorePair({
      diskText: "上次保存的正文\n第二行",
      diskVersion: { mtimeMs: 111, size: 20 },
      editedText: "改过之后\n第二行",
    });
    expect(await rebuild.restoreSession()).toBe(true);
    const doc = docs.get(197) as Doc;
    expect(doc.dirty, "副本还原仍是未保存状态").toBe(true);
    expect(doc.baseline, "基线该是盘上那份已保存正文").toBe("上次保存的正文\n第二行");
    expect(doc.diskMtimeMs, "已知磁盘版本 = 盘上那一版").toBe(111);
    const diff = [...tabs.values()].find((t) => t.kind === "diff");
    expect(diff, "基线补回来了，A 档差异标签不该再回落").toBeTruthy();
    expect(diff!.diff!.tier).toBe("baseline");
    // 用户看到的那条症状：左侧必须是「上一次保存」那份，不是当前编辑内容、也不是空。
    expect(diff!.diff!.leftText()).toBe("上次保存的正文\n第二行");
    expect(diff!.diff!.leftText()).not.toBe("改过之后\n第二行");
    expect(tabs.size).toBe(2);
  });

  it("关闭期间盘上被外部改过（版本对不上）⇒ 基线作废，仍回落普通编辑器标签", async () => {
    backupRestorePair({
      diskText: "外部改过的新内容",
      diskVersion: { mtimeMs: 222, size: 9 },
      editedText: "改过之后\n第二行",
      recordVersion: { mtimeMs: 111, size: 20 },
    });
    expect(await rebuild.restoreSession()).toBe(true);
    expect(docs.get(197)!.baseline, "版本对不上 ⇒ 不拿盘上新内容冒充基线").toBeNull();
    expect([...tabs.values()].every((t) => t.kind === "editor")).toBe(true);
  });

  it("落盘前刷新会话时，把文档的磁盘版本一并写进记录", () => {
    const doc = makeDoc(150, "改过之后", "a.md", "E:\\a.md", "UTF-8", "LF", false);
    doc.diskMtimeMs = 111;
    doc.diskSize = 20;
    docs.set(150, doc);
    tabs.set(1, {
      tabId: 1,
      docId: 150,
      panelId: 0,
      kind: "editor",
      diff: null,
      scrollV: 1,
    } as unknown as Tab);
    persist.refreshSession();
    const saved = sessionStore.get(1)!;
    expect(saved.diskMtimeMs).toBe(111);
    expect(saved.diskSize).toBe(20);

    // 反证：mtime 取不到（0）时整对留空，不许落成「看似有效」的 0 版本。
    doc.diskMtimeMs = 0;
    persist.refreshSession();
    const unknown = sessionStore.get(1)!;
    expect(unknown.diskMtimeMs).toBeNull();
    expect(unknown.diskSize).toBeNull();
  });

  it("B 档左栏读不成盘 ⇒ 回落普通编辑器标签（右栏那份文件仍在）", async () => {
    wire.session = sessionWith([
      rec({ path: "b.md", docId: 198 }),
      rec({ path: "b.md", docId: 198, kind: "diff", diffLeftPath: "gone.md" }),
    ]);
    expect(await rebuild.restoreSession()).toBe(true);
    expect(tabs.size).toBe(2);
    expect([...tabs.values()].every((t) => t.kind === "editor")).toBe(true);
  });
});

// ---------------------------------------------------------------- ③ 禁搬移 + 关标签

const LEFT = "1\n2\n3\n4\n5";
const RIGHT = "1\nX\n3\n4\n5";

function freshPanel(panelId: number): Panel {
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

function addHost(className = "panel-host"): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  document.body.appendChild(el);
  return el;
}

let nextTabId = 1;

/** 一颗真 view + 真旁路（口径同 tests/diff-panel.test.ts 的 mount）。 */
function mountTab(p: Panel, kind: "editor" | "diff", docId = 100): Tab {
  const { state, comps } = makeTabState(
    kind === "diff" ? RIGHT : LEFT,
    null,
    { dark: false, wrap: true, perf: perfProfileFor("normal") },
    () => {},
  );
  if (!docs.has(docId)) {
    const doc = makeDoc(docId, LEFT, "a.md", "E:\\a.md", "UTF-8", "LF", false);
    docs.set(docId, doc);
  }
  const spec: DiffSpec = {
    tier: "baseline",
    docId,
    leftDocId: null,
    leftText: () => docs.get(docId)?.baseline ?? "",
    leftName: "a.md",
    rightName: "a.md",
    leftPath: null,
  };
  const tab: Tab = {
    tabId: nextTabId++,
    docId,
    panelId: p.panelId,
    comps,
    state,
    viewMode: "source",
    kind,
    diff: kind === "diff" ? spec : null,
    scrollV: 1,
  };
  tabs.set(tab.tabId, tab);
  p.tabs.push(tab.tabId);
  p.activeTabId = tab.tabId;
  p.viewTabId = tab.tabId;
  const editorEl = document.createElement("div");
  editorEl.className = "panel-editor";
  addHost().appendChild(editorEl);
  p.bodyEl = editorEl.parentElement;
  p.view = createEditor(editorEl, tab.state);
  syncDiffSurface(p);
  return tab;
}

/** 两块分屏：差异标签在面板 0，面板 1 空着（搬过去会长出第二颗旁路吗？）。 */
function twoPanels(): { p0: Panel; p1: Panel; diff: Tab } {
  const p0 = freshPanel(0);
  const p1 = freshPanel(1);
  panels.set(0, p0);
  panels.set(1, p1);
  setLayout({ kind: "split", dir: "h", ratio: 0.5, a: leaf(0), b: leaf(1) });
  setActivePanelId(0);
  const diff = mountTab(p0, "diff");
  return { p0, p1, diff };
}

const MOVE_MESSAGE = "差异编辑器暂不支持跨面板移动";
const FORBIDDEN = ["在新窗口打开", "移回主窗口", "复制到相邻面板", "左右分屏", "上下分屏"];

/** 右键那一颗标签，把弹层里的文案读回来（菜单是 DOM，不是数组 —— 照用户看到的那一份判）。 */
function menuLabelsOf(el: HTMLElement): string[] {
  closePopupMenu();
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const menu = document.querySelector(".popup-menu");
  const labels = [...(menu?.querySelectorAll(".menu-label") ?? [])].map((n) => n.textContent ?? "");
  closePopupMenu();
  return labels;
}

function viewData(tabId: number, isDiff: boolean): import("../src/shell/tabstrip").TabViewData {
  return {
    tabId,
    name: isDiff ? "上次保存的 a.md ↔ a.md" : "a.md",
    dirty: false,
    readonly: false,
    active: true,
    path: "E:\\a.md",
    tip: isDiff ? "上次保存的 E:\\a.md ↔ E:\\a.md" : undefined,
    hasSibling: true,
    canDiffAgainstSaved: true,
    isDiff,
  };
}

describe("B461 · 差异标签不许跨面板 / 跨窗口（Review Focus 3）", () => {
  it("右键那五条搬移项整组缺席，且拖不动（同一颗弹层里普通标签照旧有 —— 对照）", () => {
    const host = addHost("tabstrip-host");
    tabstrip.renderTabstrip(host, [viewData(1, true), viewData(2, false)], {
      onActivate: () => {},
      onClose: () => {},
      onDuplicateToSibling: () => {},
      onSplitH: () => {},
      onSplitV: () => {},
      onOpenInNewWindow: () => {},
      onReturnToMain: () => {},
    });
    const diffEl = host.querySelector<HTMLElement>('[data-tab-id="1"]')!;
    const plainEl = host.querySelector<HTMLElement>('[data-tab-id="2"]')!;
    expect(diffEl.draggable, "差异标签拖不动（拖出去就是跨面板/跨窗口）").toBe(false);
    expect(plainEl.draggable, "对照：普通标签照旧拖得动").toBe(true);
    const diffLabels = menuLabelsOf(diffEl);
    for (const label of FORBIDDEN) {
      expect(diffLabels, `差异标签的右键不该有「${label}」`).not.toContain(label);
    }
    const plainLabels = menuLabelsOf(plainEl);
    for (const label of FORBIDDEN) {
      expect(plainLabels, `对照：普通标签的「${label}」不许被一并抹掉`).toContain(label);
    }
    expect(diffLabels, "关闭这一组仍在（差异标签关得掉）").toContain("关闭");
  });

  it("悬停气泡与标题同源：差异标签用 tip（两侧），普通标签仍报 path", () => {
    const host = addHost("tabstrip-host");
    tabstrip.renderTabstrip(host, [viewData(1, true), viewData(2, false)], {
      onActivate: () => {},
      onClose: () => {},
      onDuplicateToSibling: () => {},
      onSplitH: () => {},
      onSplitV: () => {},
      onOpenInNewWindow: () => {},
      onReturnToMain: () => {},
    });
    expect(
      host.querySelector<HTMLElement>('[data-tab-id="1"]')!.dataset.tip,
      "标题是「左 ↔ 右」，气泡只报右栏 path 就对不上",
    ).toBe("上次保存的 E:\\a.md ↔ E:\\a.md");
    expect(
      host.querySelector<HTMLElement>('[data-tab-id="2"]')!.dataset.tip,
      "对照：普通标签的提示仍是完整路径",
    ).toBe("E:\\a.md");
  });

  it("moveTabToPanel 拒绝：标签还在原格，目标格没长出第二颗旁路", () => {
    const { p0, p1, diff } = twoPanels();
    split.moveTabToPanel(diff.tabId, 1);
    expect(tabs.get(diff.tabId)!.panelId).toBe(0);
    expect(p1.tabs).toEqual([]);
    expect(p1.diffSurface).toBeNull();
    expect(p0.diffSurface, "原格那颗旁路仍指向自己").not.toBeNull();
    expect(ui.sbMessage.textContent, "静默不动会让人以为按键坏了").toBe(MOVE_MESSAGE);
  });

  it("splitPanelWithTab 拒绝（分屏会把这颗 view 连带搬走）", () => {
    const { p0, diff } = twoPanels();
    split.splitPanelWithTab(1, "h", diff.tabId, false, true);
    expect(tabs.get(diff.tabId)!.panelId).toBe(0);
    expect(countLeavesLeaf(), "布局不许被改").toBe(2);
    expect(p0.diffSurface).not.toBeNull();
    expect(ui.sbMessage.textContent).toBe(MOVE_MESSAGE);
  });

  it("splitActivePanel 拒绝（面板那颗分屏键与 Ctrl+\\ 走的是它）", () => {
    const { p0, diff } = twoPanels();
    split.splitActivePanel(0, "h");
    expect(tabs.get(diff.tabId)!.panelId).toBe(0);
    expect(countLeavesLeaf()).toBe(2);
    expect(p0.tabs).toContain(diff.tabId);
    expect(ui.sbMessage.textContent).toBe(MOVE_MESSAGE);
  });

  it("moveGroupToPanel 拒绝（整组拖拽 bypass 了单标签那几颗闸）", () => {
    const { p0, diff } = twoPanels();
    split.moveGroupToPanel(0, 1, "h", true);
    expect(tabs.get(diff.tabId)!.panelId).toBe(0);
    expect(p0.tabs).toContain(diff.tabId);
    expect(countLeavesLeaf()).toBe(2);
    expect(ui.sbMessage.textContent).toBe(MOVE_MESSAGE);
  });

  it("对照：普通标签跨面板移动照旧走得通（闸不是把整条路径封死）", () => {
    const p0 = freshPanel(0);
    const p1 = freshPanel(1);
    panels.set(0, p0);
    panels.set(1, p1);
    setLayout({ kind: "split", dir: "h", ratio: 0.5, a: leaf(0), b: leaf(1) });
    setActivePanelId(0);
    const plain = mountTab(p0, "editor");
    split.moveTabToPanel(plain.tabId, 1);
    expect(tabs.get(plain.tabId)!.panelId).toBe(1);
    expect(p1.tabs).toContain(plain.tabId);
    expect(ui.sbMessage.textContent).not.toBe(MOVE_MESSAGE);
  });
});

/** 布局树叶子数（`layout` 是 app-state 的活绑定，搬移/分屏之后现读它）。 */
function countLeavesLeaf(): number {
  return countLeaves(layout);
}

describe("B461 · 关掉差异标签只销毁这个实例（⑦⑥）", () => {
  it("原标签与 doc 都还在，旁路拆干净，不留孤儿 doc", async () => {
    const p0 = freshPanel(0);
    panels.set(0, p0);
    setLayout(leaf(0));
    setActivePanelId(0);
    const original = mountTab(p0, "editor");
    // 同一格换一张标签显示：差异标签接手那一颗 view（旁路跟着挂上）。
    const diff = mountTab(p0, "diff");
    p0.tabs = [original.tabId, diff.tabId];
    p0.activeTabId = diff.tabId;
    p0.viewTabId = diff.tabId;
    p0.view!.setState(diff.state);
    syncDiffSurface(p0);
    expect(p0.diffSurface, "前置：这一格确实挂着旁路").not.toBeNull();

    await lifecycle.closeTabById(diff.tabId);

    expect(docs.has(100), "doc 不许被牵连").toBe(true);
    expect(tabs.has(diff.tabId)).toBe(false);
    expect(tabs.has(original.tabId), "原标签还在").toBe(true);
    expect(p0.diffSurface, "旁路跟着这张标签退场").toBeNull();
    expect(p0.tabs).toEqual([original.tabId]);
  });
});

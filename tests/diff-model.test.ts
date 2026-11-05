// @vitest-environment node
// B461 · Task 1 —— 差异标签的数据层（`src/diff/model.ts`）。
//
// 钉两件跨文件才成立的事：
//   1) **A 档的闸**：基线未知就不许开差异编辑器（设计稿 ⑩·3 / Review Focus 1）。
//      空字符串基线是「存过一个空文件」，那是**已知**原样 ⇒ 必须放行；把 `""` 当假值判成
//      「开不了」就是这条闸最可能的错法。
//   2) **块数通知只有一个槽**（预审 R6）：侧栏那块视图注册自己、收起时注销；
//      surface 不反向 import 面板模块，否则成环。
//
// `leftText` 为什么是函数不是字符串，见 `src/diff/model.ts` 的头注（B458 同口径：读取口，
// 不是快照）—— 那条不由单测判，由 Task 5 的「Ctrl+S 自己清空」用例判。
import { describe, expect, it, vi } from "vitest";
import { docs, panels, tabs, type Doc } from "../src/core/app-state";
import { makeDiffInstance, makeDoc, makeInstance } from "../src/doc-model";
import { gutterDiffBaseline, hasGutterDiff } from "../src/editor/gutterDiff";
import {
  canOpenAgainstBaseline,
  diffTitleOf,
  notifyDiffBlocks,
  openFileDiff,
  setDiffRenderHooks,
  swapDiffInputs,
  setDiffBlocksListener,
  type DiffSpec,
} from "../src/diff/model";
import {
  clearCompareSelection,
  compareMenuItems,
  compareSelection,
  toggleCompareSelection,
} from "../src/diff/compare";
import type { MenuItem } from "../src/shell/menu";

// B 档要读盘（readCompareText）：桩掉 ipc/api 的这一颗，其余照旧（node 环境里
// `@tauri-apps/api/core` 只加载不执行，与 explorer-store.test.ts 同一手法）。
const { readCompareTextMock } = vi.hoisted(() => ({ readCompareTextMock: vi.fn() }));
vi.mock("../src/ipc/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ipc/api")>()),
  readCompareText: readCompareTextMock,
}));

const docWith = (baseline: string | null): Doc => ({ tabId: 1, baseline }) as unknown as Doc;

const spec = (over: Partial<DiffSpec> = {}): DiffSpec => ({
  tier: "baseline",
  docId: 1,
  leftText: () => "",
  leftName: "a.md（上次保存）",
  rightName: "a.md",
  leftPath: null,
  ...over,
});

describe("B461 · canOpenAgainstBaseline（A 档那道闸）", () => {
  it("没有文档 / 基线未知 ⇒ 不许开", () => {
    expect(canOpenAgainstBaseline(null)).toBe(false);
    expect(canOpenAgainstBaseline(docWith(null))).toBe(false);
  });

  it("基线是空字符串 = 存过一个空文件，那是**已知**原样 ⇒ 要放行", () => {
    expect(canOpenAgainstBaseline(docWith(""))).toBe(true);
  });

  it("基线有正文 ⇒ 放行（与脏不脏无关：干净时打开是一张全同的差异）", () => {
    expect(canOpenAgainstBaseline(docWith("旧正文"))).toBe(true);
    expect(canOpenAgainstBaseline({ tabId: 1, baseline: "旧正文", dirty: false } as Doc)).toBe(
      true,
    );
  });
});

describe("B461 · 块数变化的通知槽", () => {
  it("注册后广播送到它，注销后广播是空转（不许抛）", () => {
    const seen: DiffSpec[] = [];
    setDiffBlocksListener((s) => seen.push(s));
    const s = spec();
    notifyDiffBlocks(s);
    expect(seen).toEqual([s]);

    setDiffBlocksListener(null);
    expect(() => notifyDiffBlocks(spec())).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("只有一个槽：后注册的顶掉前一个（多播是给还不存在的需求付账 —— 预审 R6）", () => {
    const a: number[] = [];
    const b: number[] = [];
    setDiffBlocksListener(() => a.push(1));
    setDiffBlocksListener(() => b.push(1));
    notifyDiffBlocks(spec());
    expect(a).toEqual([]);
    expect(b).toEqual([1]);
    setDiffBlocksListener(null);
  });
});

// --------------------------------------------------------------------------- #
// Task 5 —— A 档（与上次保存比较）：标题拼接
// --------------------------------------------------------------------------- #

describe("B461 · diffTitleOf（Task 5 Step 1）", () => {
  it("B461 · 标题是「旧 ↔ 新」；两侧同名时左栏补描述（照 VS Code 的 ForceDescription）", () => {
    const files: DiffSpec = {
      tier: "files",
      docId: 1,
      leftText: () => "",
      leftName: "a.md",
      rightName: "b.md",
      leftPath: "D:/a.md",
    };
    expect(diffTitleOf(files, false)).toBe("a.md ↔ b.md");
    const same: DiffSpec = {
      ...files,
      tier: "baseline",
      leftName: "a.md",
      rightName: "a.md",
      leftPath: null,
    };
    expect(diffTitleOf(same, true)).toBe("上次保存的 a.md ↔ a.md");
  });
});

describe("B461 · makeDiffInstance（Task 5 Step 2）", () => {
  it("B461 · 差异标签那一份实例拿不到基线读取口 ⇒ 那列空着但仍占 4px", () => {
    const doc = makeDoc(7, "甲\n乙\n丙", "a.md", null, "UTF-8", "LF", false);
    const panelId = 0;
    const s = spec();
    const made = makeDiffInstance(doc, panelId, "甲\n乙改\n丙", s);
    expect(hasGutterDiff(made.state)).toBe(true); // 列还在（正文不因存盘左右跳）
    expect(gutterDiffBaseline(made.state)).toBeNull(); // 没处问基线 ⇒ 整片不画
    expect(made.kind).toBe("diff");
    expect(made.diff).toBe(s);
  });
});

// --------------------------------------------------------------------------- #
// Task 6 —— B 档：窗口级「选择以进行比较」状态机 + 那一对菜单标签
// --------------------------------------------------------------------------- #

/** 菜单标签逻辑的唯一真相在 `compare.ts`（explorer 与 tabstrip 都吃它），故这里直接测它。 */
const noopActions = { onSelectToCompare: () => {}, onCompareWith: () => {} };
const explorerMenu = (path: string): MenuItem[] => compareMenuItems(path, noopActions);
const labels = (items: MenuItem[]): (string | undefined)[] => items.map((i) => i.label);

describe("B461 · 比较选择的状态机（Task 6 Step 4）", () => {
  it("B461 · 选一条 → 选中；再选同一条 → 取消；选另一条 → 换过去", () => {
    clearCompareSelection();
    toggleCompareSelection("a.md");
    expect(compareSelection()).toBe("a.md");
    toggleCompareSelection("a.md");
    expect(compareSelection()).toBeNull();
    toggleCompareSelection("a.md");
    toggleCompareSelection("b.md");
    expect(compareSelection()).toBe("b.md");
    clearCompareSelection();
    expect(compareSelection()).toBeNull();
  });
});

describe("B461 · 右键菜单那一对按当前选中态（Task 6 Step 4）", () => {
  it("B461 · 没选中给「选择以进行比较」；选中别处给「与 X 比较」；同一行不给自己当对照物", () => {
    clearCompareSelection();
    expect(labels(explorerMenu("b.md"))).toContain("选择以进行比较");
    toggleCompareSelection("a.md");
    const m = explorerMenu("b.md");
    expect(labels(m)).toContain("与 a.md 比较");
    expect(labels(m)).not.toContain("选择以进行比较"); // 已选中时不给自己留两条入口
    expect(labels(explorerMenu("a.md"))).not.toContain("与 a.md 比较"); // 同一行不给自己当对照物
    clearCompareSelection();
  });
});

// --------------------------------------------------------------------------- #
// Task 6 —— openFileDiff：右栏复用/开档、同路径拒开、R32 同对复用、swapDiffInputs 档位闸
// --------------------------------------------------------------------------- #

/** 把 `panels` 摆成活动面板 0（`activePanelId` 缺省就是 0）—— 差异标签要真挂上去才进 `tabs`。 */
function mountPanel0(): void {
  docs.clear();
  tabs.clear();
  panels.clear();
  panels.set(0, {
    panelId: 0,
    tabs: [],
    activeTabId: -1,
    view: null,
    bodyEl: null,
    diffSurface: null,
  } as never);
}

const compareSnap = (text: string) => ({
  path: "D:/a.md",
  name: "a.md",
  text,
  encoding: "UTF-8",
  sizeClass: "normal",
});

describe("B461 · openFileDiff（Task 6 Step 6）", () => {
  it("B461 · 右路径已经开着就复用它的 doc，不再读一遍盘", async () => {
    mountPanel0();
    const bDoc = makeDoc(11, "乙\n正文", "b.md", "D:/b.md", "UTF-8", "LF", false);
    docs.set(bDoc.tabId, bDoc);
    setDiffRenderHooks({
      rebuildLayout: () => {},
      refreshAll: () => {},
      renderPanelTabs: () => {},
      showMessage: () => {},
      switchTab: () => {},
    });
    readCompareTextMock.mockReset().mockResolvedValue(compareSnap("甲\n正文"));
    const id = (await openFileDiff("D:/a.md", "D:/b.md"))!;
    expect(readCompareTextMock).toHaveBeenCalledTimes(1); // 只读了左栏那一份
    expect(readCompareTextMock).toHaveBeenCalledWith("D:/a.md");
    const tab = tabs.get(id)!;
    expect(tab.docId).toBe(bDoc.tabId); // 右栏 = 已在册的那份文档本身
    expect(tab.diff?.tier).toBe("files");
    expect(tab.diff?.leftPath).toBe("D:/a.md");
    expect(tab.diff?.leftText(), "左栏闭包交出读到的快照").toBe("甲\n正文");
    expect(tab.diff?.leftName).toBe("a.md");
    expect(tab.diff?.rightName).toBe("b.md");
  });

  it("B461 · 两个路径相同 ⇒ 不开（返回 null 并说明）；判同看的是归一化后的写法", async () => {
    mountPanel0();
    const messages: Array<[string, boolean | undefined]> = [];
    setDiffRenderHooks({
      rebuildLayout: () => {},
      refreshAll: () => {},
      renderPanelTabs: () => {},
      showMessage: (text, isError) => messages.push([text, isError]),
      switchTab: () => {},
    });
    readCompareTextMock.mockReset();
    expect(await openFileDiff("D:/a.md", "D:\\A.MD")).toBeNull();
    expect(messages).toEqual([["两个文件相同，不必比较", true]]);
    expect(tabs.size).toBe(0);
    expect(readCompareTextMock).not.toHaveBeenCalled();
  });

  it("B461 · R32：同一对文件再开一次 ⇒ 复用那张差异标签并露出来（不叠两张）", async () => {
    mountPanel0();
    const bDoc = makeDoc(12, "乙", "b.md", "D:/b.md", "UTF-8", "LF", false);
    docs.set(bDoc.tabId, bDoc);
    const switched: number[] = [];
    setDiffRenderHooks({
      rebuildLayout: () => {},
      refreshAll: () => {},
      renderPanelTabs: () => {},
      showMessage: () => {},
      switchTab: (_panelId, tabId) => switched.push(tabId),
    });
    readCompareTextMock.mockReset().mockResolvedValue(compareSnap("甲"));
    const first = (await openFileDiff("D:/a.md", "D:/b.md"))!;
    panels.get(0)!.activeTabId = -1; // 用户切走了那张（模拟「没露出来」）
    const second = (await openFileDiff("D:/a.md", "D:/b.md"))!;
    expect(second).toBe(first);
    expect(readCompareTextMock).toHaveBeenCalledTimes(1); // 复用路径不再读盘
    expect(switched).toEqual([first]);
    expect(panels.get(0)!.tabs).toHaveLength(1); // 面板里仍只有那一张
  });
});

describe("B461 · R33：左栏那条已经开着 ⇒ 复用它的正文，不再读一遍盘", () => {
  it("B461 · 左路径在册 ⇒ 不调 readCompareText；左栏读取口交的是那一格的**现值**并跟着键入走", async () => {
    mountPanel0();
    // 用户开着 a.md 且改了还没存：屏幕上那一格才是他要对照的东西（设计稿 ⑩·1
    // 「若那个 path 恰好已经开着，直接复用它的正文，不再读一遍盘」）。
    const aDoc = makeDoc(21, "甲\n盘上那份", "a.md", "D:/a.md", "UTF-8", "LF", false);
    docs.set(aDoc.tabId, aDoc);
    const aInst = makeInstance(aDoc, 0, "甲\n改过还没存");
    tabs.set(aInst.tabId, aInst);
    const bDoc = makeDoc(22, "乙", "b.md", "D:/b.md", "UTF-8", "LF", false);
    docs.set(bDoc.tabId, bDoc);
    setDiffRenderHooks({
      rebuildLayout: () => {},
      refreshAll: () => {},
      renderPanelTabs: () => {},
      showMessage: () => {},
      switchTab: () => {},
    });
    readCompareTextMock.mockReset().mockResolvedValue(compareSnap("甲\n盘上那份"));

    const id = (await openFileDiff("D:/a.md", "D:/b.md"))!;
    expect(
      readCompareTextMock,
      "那个 path 已经开着 ⇒ 不许再读一遍盘（读到的还是用户屏幕上没有的那一份）",
    ).not.toHaveBeenCalled();
    const leftText = tabs.get(id)!.diff!.leftText;
    expect(leftText(), "左栏 = 那一格此刻的正文，不是盘上那一份").toBe("甲\n改过还没存");

    // 规格要的是「读那份文档的现值」，不是「打开那一刻抄一份」：那一格敲字，左栏跟着变。
    aInst.state = aInst.state.update({
      changes: { from: 0, to: aInst.state.doc.length, insert: "甲\n改成第三版" },
    }).state;
    expect(leftText(), "读取口吃的是活的实例正文（快照会把差异冻在打开那一刻）").toBe(
      "甲\n改成第三版",
    );
  });
});

describe("B461 · swapDiffInputs 的档位闸（Task 6 Step 6）", () => {
  it("B461 · A 档不许交换（反目标：右栏必须是那份文档本身）⇒ 原样交回", async () => {
    const baseline: DiffSpec = {
      tier: "baseline",
      docId: 1,
      leftText: () => "",
      leftName: "a.md",
      rightName: "a.md",
      leftPath: null,
    };
    expect(await swapDiffInputs(baseline)).toBe(baseline);
  });
});

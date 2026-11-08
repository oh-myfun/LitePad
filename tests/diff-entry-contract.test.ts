// @vitest-environment jsdom
// B461 · Task 4 —— 差异步进的**入口契约**：两条命令进表、键位没抢别人的、上下文闸与分发接上。
//
// 这一层判的是「一条命令从键到动作的那条线断没断」，跨 `keymap.ts` / `main.ts` 两个文件，
// 单测里没法只靠一颗纯函数钉住 ⇒ 用仓库既定的**结构判据**（`explorer-contract` /
// `gutter-diff-wiring` / `sync-scroll-sequence` 同形）配**真跑的注册表断言**：
//   1) 表里就是那两条（id / label / group / 键位字面量逐字钉死 —— 改一个字的文案都发红）；
//   2) 那两颗键位**在本应用无人占**：不靠眼看表，靠 `duplicateKeys({})` 为空 +
//      「谁家的键」扫一遍整张表 + `resolveCommand` 真按出这两条（裸 `F5` 仍是插入时间/日期）；
//   3) 上下文闸与分发：不成时**不抢键**（把 `Alt+F5` 还给系统），成时走 `step(±1)`；
//   4) 键位字面量只许出现在 `src/shell/keymap.ts` 这一处（B389 立下的纪律）。
//
// ⚠️ `Alt+F5` / `Shift+Alt+F5` 是 VS Code「Go to Next/Previous Change」的实拍键位，
// 这条来历记在代码注释里就够了 —— 用户可见文案一律不写「复刻」二字（本产品的既定口径）。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { type Doc, type Panel, type Tab } from "../src/core/app-state";
import { collectTextFiles, fnBody, stripLineComments } from "./static";
import type { MenuItem } from "../src/shell/menu";
// 只引类型：运行时这一发被擦掉，不会在本文件铺好 DOM 骨架之前把 shell/diff 那一族拉起来。
import type { PanelRenderData, SplitviewCallbacks } from "../src/shell/splitview";
import type { DiffSurface } from "../src/diff/surface";
import type { DiffSpec } from "../src/diff/model";
import {
  COMMANDS,
  commandById,
  duplicateKeys,
  effectiveKeys,
  keyHint,
  normalizeSpec,
  parseKey,
  resolveCommand,
} from "../src/shell/keymap";

import { clearCompareSelection, compareSelection } from "../src/diff/compare";

// 「交换左右」那一路会关掉原来那张差异标签 ⇒ `closeTabById` 走跨窗口播报，
// `emitCrossWindow` 第一步就是 `getCurrentWindow().label`（jsdom 没有 Tauri 内部对象 ⇒
// 整条链在 `metadata` 上抛，close 那半截根本没跑完）。桩只补这一颗窗口身份。
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    setTitle: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }),
}));

const srcOf = (p: string): string => readFileSync(p, "utf-8").replace(/\r\n/g, "\n");

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

/** 现在真拿着这颗键位的命令 id（按**规范化后**比对，`Alt+Shift+F5` 与 `Shift+Alt+F5` 是一家）。 */
function owners(spec: string): string[] {
  return COMMANDS.filter((c) => c.keys.some((k) => normalizeSpec(k) === spec)).map((c) => c.id);
}

describe("B461 · 差异步进两条命令进表（Task 4 Step 5/6）", () => {
  it("B461 · 表里就是那两条：id / label / group / 键位逐字", () => {
    expect(commandById("diff.nextChange")).toMatchObject({
      id: "diff.nextChange",
      label: "下一个差异",
      group: "差异",
      keys: ["Alt+F5"],
    });
    expect(commandById("diff.prevChange")).toMatchObject({
      id: "diff.prevChange",
      label: "上一个差异",
      group: "差异",
      keys: ["Shift+Alt+F5"],
    });
    // 表里 `diff.` 打头的命令到此为止：Task 4 那两条步进 + Task 5 的 A 档入口 +
    // Task 8 那几条动作键 + 后续轮的换行/同步滚动两颗开关。
    // 多出一条没人认领的就要发红 —— 键位表里躺着一条没人分发的命令 = 命令面板里点不动的死键。
    expect(COMMANDS.filter((c) => c.id.startsWith("diff.")).map((c) => c.id)).toEqual([
      "diff.nextChange",
      "diff.prevChange",
      "diff.openAgainstSaved",
      "diff.toggleWhitespace",
      "diff.toggleCollapse",
      "diff.collapseAll",
      "diff.showAll",
      "diff.swapSides",
      "diff.toggleWrap",
      "diff.toggleSyncScroll",
      "diff.refresh",
    ]);
  });

  it("B461 · effectiveKeys 交出那两颗键，且 duplicateKeys 仍为空（键位没撞车）", () => {
    expect(effectiveKeys("diff.nextChange", {})).toEqual(["Alt+F5"]);
    expect(effectiveKeys("diff.prevChange", {})).toEqual(["Shift+Alt+F5"]);
    // 提示语走的是**规范化**那一档：`formatBinding` 的修饰键次序是 Ctrl→Alt→Shift
    // （与 `keyHint("panel.splitV")` 交的 `Alt+Shift+↓` 同一口径），所以按出来的显示名是
    // `Alt+Shift+F5`。表里声明的仍是 VS Code 那串写法 —— 两处都是那颗键，只是拼法不同。
    expect(keyHint("diff.nextChange", {})).toBe("Alt+F5");
    expect(keyHint("diff.prevChange", {})).toBe("Alt+Shift+F5");
    // 整张表自我检查：加了这两条之后仍然一处重复都没有 ⇒ 这两颗键本来就是空的
    expect(duplicateKeys({})).toEqual([]);
  });

  it("B461 · F5 一族三家各占一档，互不越界（裸 F5 仍是插入时间/日期）", () => {
    expect(owners("Alt+F5")).toEqual(["diff.nextChange"]);
    expect(owners("Alt+Shift+F5")).toEqual(["diff.prevChange"]);
    expect(owners("F5")).toEqual(["edit.timeDate"]);
    // 用户可改键的那一档：这两条必须是**可编辑**的（非 `editable: false` 的内置项）
    for (const id of ["diff.nextChange", "diff.prevChange"]) {
      expect(commandById(id)?.editable, `${id} 是应用自己的命令`).not.toBe(false);
      expect(parseKey(commandById(id)!.keys[0]), "键位串必须可解析").toBeTruthy();
    }
  });

  it("B461 · 事件真按得出这两条（分发口），修饰键多一颗少一颗都不算", () => {
    expect(resolveCommand(key({ code: "F5", key: "F5", altKey: true }), {})).toBe(
      "diff.nextChange",
    );
    expect(resolveCommand(key({ code: "F5", key: "F5", altKey: true, shiftKey: true }), {})).toBe(
      "diff.prevChange",
    );
    // 反向闸：这一族的邻居不许被抢走 —— 裸 F5 还是「插入时间/日期」（且它 `force: true`）；
    // 少一颗 Alt 的那一发没人绑 ⇒ 谁都不命中，也**不许**命中 `diff.prevChange`。
    expect(resolveCommand(key({ code: "F5", key: "F5" }), {})).toBe("edit.timeDate");
    expect(
      resolveCommand(key({ code: "F5", key: "F5", shiftKey: true }), {}),
      "Shift+F5 没人绑 ⇒ 不许当成「上一个差异」",
    ).toBeNull();
    expect(
      resolveCommand(key({ code: "F5", key: "F5", altKey: true, ctrlKey: true }), {}),
      "Ctrl+Alt+F5 没人绑 ⇒ 不许命中任何命令",
    ).toBeNull();
    // 用户解绑之后彻底不抢（覆盖表按 id 存，与有无默认无关）
    expect(
      resolveCommand(key({ code: "F5", key: "F5", altKey: true }), { "diff.nextChange": "" }),
    ).toBeNull();
  });

  it("B461 · 上下文闸与分发接在 main.ts：不成时不抢键，成时走 surface 的 step(±1)", () => {
    const main = srcOf("src/main.ts");
    // 注释里那些「与置灰/不抢键同源」的话不许进判据 ⇒ 先剥行注释再按形状匹配。
    const gate = stripLineComments(fnBody(main, "shortcutApplies"));
    expect(gate, "两条命令共用同一个闸（写成两行 case  fallthrough）").toMatch(
      /case "diff\.nextChange":\s*\n\s*case "diff\.prevChange":/,
    );
    expect(gate).toMatch(/return diffTabActive\(\)/);
    // 闸的判据本身：活动面板**挂着旁路**且显示的那张标签是差异标签
    const helper = stripLineComments(fnBody(main, "diffTabActive"));
    expect(helper).toMatch(/diffSurfaceOf\(/);
    expect(helper).toMatch(/kind\s*===\s*"diff"/);
    // 分发：按的是当前活动面板的那颗 surface
    const run = stripLineComments(fnBody(main, "runShortcut"));
    expect(run).toMatch(/case "diff\.nextChange":/);
    expect(run).toMatch(/diffSurfaceOf\(activePanel\(\)\)\?\.step\(1\)/);
    expect(run).toMatch(/diffSurfaceOf\(activePanel\(\)\)\?\.step\(-1\)/);
  });

  it("B461 · 键位字面量只许出现在 keymap.ts 这一处（B389 的纪律）", () => {
    const hits = collectTextFiles("src")
      .filter((p) => p.endsWith(".ts"))
      .map((p) => p.replace(/\\/g, "/"))
      .filter((p) => {
        const text = readFileSync(p, "utf-8").replace(/\r\n/g, "\n");
        return /Alt\+F5|Shift\+Alt\+F5/.test(text);
      });
    expect(hits, "分发那处只按 id 走、菜单那处只按 keyHint(id) 取 ⇒ 改一颗键只用改这张表").toEqual([
      "src/shell/keymap.ts",
    ]);
  });
});

// ── Task 5 · A 档「与上次保存比较」：入口三条 + 基线实时 ──────────────────────────
//
// 上面那一族钉的是**键**，这一族钉的是**入口**：菜单、标签右键、键盘三条路是不是真接在同
// 一颗判据上，以及设计稿 ③ 那句硬约定 —— 左栏读的是**活的**基线，Ctrl+S 之后块自己没了，
// 不靠任何一处「记得」补派发。
//
// ⚠️ 这条链一路 import 到 `src/ui.ts`，那颗模块在**求值时**就 `el("#layout-area")` 逐个取
// 节点、取不到直接抛 ⇒ 与 `explorer-paths.test.ts` 同款：先把 index.html 的骨架铺进
// document，再 dynamic import。写成静态 import 会在铺 DOM 之前求值，整个文件加载失败。
let appState: typeof import("../src/core/app-state");
let docModel: typeof import("../src/doc-model");
let render: typeof import("../src/tabs/render");
let diffModel: typeof import("../src/diff/model");
let diffBlocksMod: typeof import("../src/diff/blocks");
let splitview: typeof import("../src/shell/splitview");
let surfaceMod: typeof import("../src/diff/surface");
let actions: typeof import("../src/diff/actions");
let editorMod: typeof import("../src/editor/editor");
let perfMod: typeof import("../src/editor/perf");

beforeAll(async () => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
  [
    appState,
    docModel,
    render,
    diffModel,
    diffBlocksMod,
    splitview,
    surfaceMod,
    actions,
    editorMod,
    perfMod,
  ] = await Promise.all([
    import("../src/core/app-state"),
    import("../src/doc-model"),
    import("../src/tabs/render"),
    import("../src/diff/model"),
    import("../src/diff/blocks"),
    import("../src/shell/splitview"),
    import("../src/diff/surface"),
    import("../src/diff/actions"),
    import("../src/editor/editor"),
    import("../src/editor/perf"),
  ]);
});

/**
 * 铺一份「正开着、且改过一行」的文档：文档 + 原标签实例 + 面板都得是真的。
 * `openBaselineDiff` 右栏那份正文读的是**活的实例文档**（`instancesOfDoc(...)[0]`），
 * 拿 `{}` 冒充标签，测的就是我自己搭的假象而不是屏上那一格。
 */
function openDocWithBaseline(baseline: string, text: string, name = "note.md"): Doc {
  appState.docs.clear();
  appState.tabs.clear();
  appState.panels.clear();
  const doc = docModel.makeDoc(7, baseline, name, "D:\\note.md", "UTF-8", "LF", false);
  appState.docs.set(doc.tabId, doc);
  const inst = docModel.makeInstance(doc, 0, text);
  appState.tabs.set(inst.tabId, inst);
  appState.panels.set(0, {
    panelId: 0,
    tabs: [inst.tabId],
    activeTabId: inst.tabId,
    view: null,
    preview: null,
    previewTimer: null,
    bodyEl: null,
  } as never);
  // 脏不脏走产品那颗判据（B112），测试不自定一套 ⇒ `doc.dirty` 与标签上那颗点是同一件事。
  doc.dirty = docModel.isDirtyVsBaseline(doc, text);
  return doc;
}

describe("B461 · A 档「与上次保存比较」进表与三条入口（Task 5 Step 6/7）", () => {
  it("B461 · 表里多出第三条：id / label / group / 键位逐字，且这颗键位本应用没人占", () => {
    expect(commandById("diff.openAgainstSaved")).toMatchObject({
      id: "diff.openAgainstSaved",
      label: "与上次保存比较",
      group: "差异",
      keys: ["Ctrl+Shift+D"],
    });
    expect(effectiveKeys("diff.openAgainstSaved", {})).toEqual(["Ctrl+Shift+D"]);
    expect(owners("Ctrl+Shift+D")).toEqual(["diff.openAgainstSaved"]);
    expect(duplicateKeys({}), "加了第三条之后整张表仍一处重复都没有").toEqual([]);
    expect(resolveCommand(key({ code: "D", key: "D", ctrlKey: true, shiftKey: true }), {})).toBe(
      "diff.openAgainstSaved",
    );
  });

  it("B461 · Ctrl+Shift+D 的字面量也只许出现在 keymap.ts 这一处", () => {
    const hits = collectTextFiles("src")
      .filter((p) => p.endsWith(".ts"))
      .map((p) => p.replace(/\\/g, "/"))
      .filter((p) => /Ctrl\+Shift\+D/.test(readFileSync(p, "utf-8").replace(/\r\n/g, "\n")));
    expect(hits, "分发按 id、菜单按 keyHint(id) 取 ⇒ 改这颗键只用改这张表").toEqual([
      "src/shell/keymap.ts",
    ]);
  });

  it("B461 · 三条入口共用同一颗判据：键盘闸 / 菜单置灰 / 标签右键都问 baselineDiffTarget", () => {
    // ① 键盘：不成时**不抢键**（把 Ctrl+Shift+D 还给系统），成时按活动标签的 docId 开。
    // 命令面板那一路不经过这道闸 ⇒ 分发自己必须把「开不出」说出来，否则用户只看到没反应。
    const main = srcOf("src/main.ts");
    expect(stripLineComments(fnBody(main, "shortcutApplies"))).toMatch(
      /case "diff\.openAgainstSaved":\s*\n\s*return baselineDiffTarget\(\) !== null;/,
    );
    const openRun = stripLineComments(fnBody(main, "runShortcut"));
    expect(openRun).toMatch(
      /case "diff\.openAgainstSaved":\s*\{[\s\S]{0,160}?baselineDiffTarget\(\);[\s\S]{0,120}?openBaselineDiff\(target\)/,
    );
    expect(openRun, "面板那一途的落点：闸判空 ⇒ 说出那句说明（文案仍只有模型那一份）").toMatch(
      /showMessage\(BASELINE_UNKNOWN_MESSAGE, true\)/,
    );
    // ② 菜单：置灰判据与①同一颗函数，文案走 keyHint(id)。
    const commands = srcOf("src/commands.ts");
    expect(commands).toMatch(
      /canDiffAgainstSaved:\s*\(\)\s*=>\s*baselineDiffTarget\(\)\s*!==\s*null/,
    );
    const mb = srcOf("src/shell/menubar.ts");
    expect(mb).toMatch(/withKey\("与上次保存比较",\s*cb\.keyHint\("diff\.openAgainstSaved"\)\)/);
    expect(mb).toMatch(/disabled:\s*!cb\.canDiffAgainstSaved\(\)/);
    // ③ 标签右键：判据随快照走（`TabViewData.canDiffAgainstSaved`），置灰时文案自己说明为什么点不动。
    const ts = srcOf("src/shell/tabstrip.ts");
    expect(ts).toMatch(/disabled:\s*!t\.canDiffAgainstSaved/);
    expect(ts).toMatch(/与上次保存比较"[\s\S]{0,30}与上次保存比较（基线未知）"/);
    // 两个 producer 必须给同一颗菜单：splitview 首次构建那一发漏了回调，那条就永远不出现。
    expect(srcOf("src/tabs/render.ts")).toMatch(/onDiffAgainstSaved:/);
    expect(srcOf("src/tabs/lifecycle.ts")).toMatch(/onDiffAgainstSaved:/);
    expect(srcOf("src/shell/splitview.ts")).toMatch(
      /onDiffAgainstSaved:\s*\(tabId\)\s*=>\s*cb\.onDiffAgainstSaved\?\.\(tabId\)/,
    );
  });

  it("Review Focus 1 · 基线未知 ⇒ 闸为假；openBaselineDiff 一句说明、不新开一张", async () => {
    expect(diffModel.canOpenAgainstBaseline({ baseline: null } as Doc)).toBe(false);
    expect(diffModel.canOpenAgainstBaseline(null)).toBe(false);
    const seen: string[] = [];
    const switched: number[] = [];
    diffModel.setDiffRenderHooks({
      rebuildLayout: () => {},
      refreshAll: () => {},
      renderPanelTabs: () => {},
      showMessage: (text) => seen.push(text),
      switchTab: (panelId, tabId) => switched.push(panelId, tabId),
    });
    const doc = openDocWithBaseline("甲\n乙\n丙", "甲\n乙\n丙");
    // 磁盘上没这份文档的「原样」（新建/未保存）⇒ 那一档没有可比对的东西。
    doc.baseline = null;
    expect(await diffModel.openBaselineDiff(doc.tabId)).toBeNull();
    expect(seen, "置灰/不抢键之外，直接调模型也要给出那句说明").toEqual([
      "这份文档还没有可比对的已保存版本",
    ]);
    expect(
      appState.panels.get(0)!.tabs.length,
      "不许悄悄开出一张空的差异标签（面板那排还是原来那一颗）",
    ).toBe(1);
    expect(switched, "开不出 ⇒ 谁也不许被切过去").toEqual([]);
  });

  it("B461 · 存盘后 diffBlocks 收到的是新基线 ⇒ 块数归零（不靠任何一处手动派发）", async () => {
    const doc = openDocWithBaseline("甲\n乙\n丙", "甲\n乙改\n丙");
    const newTabId = await diffModel.openBaselineDiff(doc.tabId);
    expect(newTabId, "基线已知 ⇒ 开得出这一张").not.toBeNull();
    const tab = appState.tabs.get(newTabId!)!;
    expect(tab.kind).toBe("diff");
    expect(diffBlocksMod.diffBlocks(tab.diff!.leftText(), "甲\n乙改\n丙")).toHaveLength(1);
    docModel.markClean(doc, "甲\n乙改\n丙"); // 保存成功那一步（主干那条链，无差异面分支）
    expect(
      diffBlocksMod.diffBlocks(tab.diff!.leftText(), "甲\n乙改\n丙"),
      "左栏那颗读取口吃的是活的 `doc.baseline` ⇒ 保存之后不必有人记得补派发",
    ).toEqual([]);
  });

  it("B461 · A 档两张标签：脏点同源，标题各说各话（差异那张写「上次保存的 …」）", async () => {
    const doc = openDocWithBaseline("甲\n乙\n丙", "甲\n乙改\n丙");
    const newTabId = (await diffModel.openBaselineDiff(doc.tabId))!;
    const tab = appState.tabs.get(newTabId)!;
    expect(tab.docId, "差异那张不另立文档：它和原标签同指一份 `docs` 条目").toBe(doc.tabId);
    const rows = render.tabViewDataOf(appState.panels.get(0)!);
    expect(
      rows.map((r) => r.dirty),
      "两颗脏点是同一个 `doc.dirty`（不存在哪张才代表未保存）",
    ).toEqual([doc.dirty, doc.dirty]);
    expect(
      rows.map((r) => r.name),
      "两张一字不差的标签 = 数不清的哪颗是差异面",
    ).toEqual(["note.md", "上次保存的 note.md ↔ note.md"]);
    expect(rows.every((r) => r.canDiffAgainstSaved)).toBe(true);
    docModel.markClean(doc, "甲\n乙改\n丙");
    expect(
      render.tabViewDataOf(appState.panels.get(0)!).map((r) => r.dirty),
      "保存 ⇒ 两颗点一起没（同源才可能同步）",
    ).toEqual([false, false]);
  });

  it("B461 · 同一个 docId 第二次「与上次保存比较」⇒ 复用那一张，不叠两张同名标签", async () => {
    // 「新开一张」（用户拍板 ④·6）说的是**相对原文标签**新开，不是每点一次多一张。
    // 复用时若那张还没露出来，走 `switchTab` 那同一条激活路（模型不自己写 activeTabId）。
    const switched: number[] = [];
    diffModel.setDiffRenderHooks({
      rebuildLayout: () => {},
      refreshAll: () => {},
      renderPanelTabs: () => {},
      showMessage: () => {},
      switchTab: (_panelId, tabId) => switched.push(tabId),
    });
    const doc = openDocWithBaseline("甲\n乙\n丙", "甲\n乙改\n丙");
    const first = (await diffModel.openBaselineDiff(doc.tabId))!;
    // 用户切回原文标签再按一次：那一颗差异标签还在册，只是没露出来。
    // 按 `tabs[0]` 回指而不是 `doc.tabId` —— 夹具把 Doc 的 id 写死成 7，它会和新分配的
    // 差异标签撞号，用 docId 当「另一颗标签」是假的前提。
    const panel = appState.panels.get(0)!;
    panel.activeTabId = panel.tabs[0];
    const second = (await diffModel.openBaselineDiff(doc.tabId))!;
    expect(second, "连按两次 Ctrl+Shift+D 不该在标签条上留下两张一模一样的差异标签").toBe(first);
    expect(appState.panels.get(0)!.tabs, "原标签 + 那一张差异 = 两颗").toHaveLength(2);
    expect(
      appState.tabs.get(first)!.kind,
      "复用的那颗仍然就是差异那颗（不是把原标签改了个 kind）",
    ).toBe("diff");
    expect(switched, "复用要把它露出来，而不是原地不动让用户以为没反应").toEqual([first]);
  });

  it("B461 · 差异面的接线点：hooks 从 main.ts 注入（模型层不许 import 渲染层）", () => {
    // `src/ui.ts` 在模块求值时取 DOM ⇒ 数据层一旦 import 它，任何 node 环境的纯函数测试
    // 都加载不起来（Task 5 真踩过）。渲染出口全部由装配层**注入**：模型只认那颗缝。
    const main = srcOf("src/main.ts");
    expect(main).toMatch(
      /setDiffRenderHooks\(\{[\s\S]{0,160}?rebuildLayout[\s\S]{0,160}?showMessage/,
    );
    expect(main).toMatch(/setRefreshDiffSurfaces\(refreshDiffSurfaces\)/);
    const model = stripLineComments(srcOf("src/diff/model.ts"));
    expect(model, "模型层的 import 表里不许出现 ui / tabs / markdown").not.toMatch(
      /from "\.\.\/(ui|tabs|markdown)"/,
    );
    expect(model).toMatch(/hooks\.rebuildLayout\(\)/);
  });
});

// ── Task 6 · B 档「选择以进行比较」：标签右键那两条的接线 ────────────────────────
//
// 这一族钉的是**标签右键那一路**（explorer 那一路的标签与显隐真相由 `diff/compare.ts`
// 直接被单测判，见 `tests/diff-model.test.ts`）。Task 5 的教训：这一发菜单有**两个
// producer**（`tabs/render.ts` 的 `tabstripCallbacks` 与 `tabs/lifecycle.ts` 供给
// splitview 首建那一发的回调组），只接一个 ⇒ 另一条路上的入口永远隐形。
// 卫星窗口的要求与 A 档不同：比较选择是**窗口级**状态，卫星窗口没有资源管理器树跟它
// 配对（「先选一条再点另一条」的两击手势凑不齐）⇒ 两条按现有那形（回调没给）整组缺席，
// 不是「出现但点不动」。
describe("B461 · B 档标签右键两条的接线（Task 6 Step 5）", () => {
  it("B461 · 两个 producer + splitview 条件转发都接上；卫星窗口整组缺席走 windowKind 闸", () => {
    // ① tabstrip：两颗回调都是**可选**，那一对只在两颗都给时存在；标签走 compare.ts 那颗
    //    真相（不许在标签条这一处再写一遍「选择以进行比较」）。
    const ts = srcOf("src/shell/tabstrip.ts");
    expect(ts).toMatch(/onSelectToCompare\?:\s*\(tabId: number\) => void/);
    expect(ts).toMatch(/onCompareWith\?:\s*\(tabId: number\) => void/);
    expect(ts).toMatch(/t\.path && cb\.onSelectToCompare && cb\.onCompareWith/);
    expect(ts, "标签与显隐的真相只许在 diff/compare.ts 一处").toMatch(/compareMenuItems\(/);

    // ② 那颗共享构造器 + 两个 producer 各展开一次（Task 6 评审 Important 1：这一段
    //    原先在两个文件里逐字复制，行为改一次要改两处）。判据只认**形状**：
    //    窗口那道闸住在构造器里，两个 producer 必须都是「展开它」而不是各写一遍。
    const builder = stripLineComments(fnBody(srcOf("src/tabs/render.ts"), "compareTabCallbacks"));
    expect(builder, "两颗回调的标签/动作只在 compareTabCallbacks 一处给").toMatch(
      /onSelectToCompare:/,
    );
    expect(builder).toMatch(/onCompareWith:/);
    expect(builder, "「选择以进行比较」落进比较状态机").toMatch(/toggleCompareSelection\(/);
    expect(builder, "「与 X 比较」真的去开那张 B 档差异").toMatch(/openFileDiff\(/);
    const gates = builder.match(/windowKind === "satellite"\s*\?\s*undefined\s*:/g) ?? [];
    expect(
      gates,
      "卫星窗口 ⇒ 两颗都不给（both-or-neither：缺席是机制上的，不是画出来点不动）",
    ).toHaveLength(2);
    for (const p of ["src/tabs/render.ts", "src/tabs/lifecycle.ts"]) {
      const src = stripLineComments(srcOf(p));
      expect(src, `${p} 必须展开那颗共享的比较回调（不许再抄一份）`).toMatch(
        /\.\.\.\s*compareTabCallbacks\(\)/,
      );
    }

    // ③ splitview 首建那一发：**条件转发**（照 `onDragTabFile` / `onOpenInNewWindow` 那形）。
    //    无条件包装（`(tabId) => cb.x?.(tabId)`）会包出一颗永不为空的函数，
    //    「回调缺席 ⇒ 整组缺席」在这条路上就失真了 —— 那正是 A 档那条在首建路上的老坑。
    const sv = srcOf("src/shell/splitview.ts");
    expect(sv).toMatch(/onSelectToCompare\?:\s*\(tabId: number\) => void/);
    expect(sv).toMatch(/onCompareWith\?:\s*\(tabId: number\) => void/);
    expect(sv).toMatch(
      /onSelectToCompare:\s*cb\.onSelectToCompare\s*\?\s*\(tabId\) =>\s*cb\.onSelectToCompare\?\.\(tabId\)\s*:\s*undefined/,
    );
    expect(sv).toMatch(
      /onCompareWith:\s*cb\.onCompareWith\s*\?\s*\(tabId\) =>\s*cb\.onCompareWith\?\.\(tabId\)\s*:\s*undefined/,
    );
  });

  it("B461 · 真调 tabstripCallbacks：卫星窗口两颗都是 undefined，主窗口两颗都在", () => {
    // ① 与 ② 的静态判据只说明形状，这一发跑的是真产物：缺席必须是**机制**上的缺席。
    const bare = { panelId: 0, tabs: [], activeTabId: -1 } as never;
    appState.setWindowKind("satellite");
    try {
      const sat = render.tabstripCallbacks(bare);
      expect(sat.onSelectToCompare, "卫星窗口：回调根本没给").toBeUndefined();
      expect(sat.onCompareWith, "卫星窗口：回调根本没给").toBeUndefined();
    } finally {
      appState.setWindowKind("main");
    }
    const main = render.tabstripCallbacks(bare);
    expect(main.onSelectToCompare, "主窗口：两条都在").toBeTypeOf("function");
    expect(main.onCompareWith, "主窗口：两条都在").toBeTypeOf("function");

    // 抽成 `compareTabCallbacks` 之后，静态判据钉的是「两个 producer 都展开它」⇒ 这一发
    // 再跑一次**展开产物**的函数体：点「选择以进行比较」真的把那条落进窗口级选择里
    // （按标签找到它那份文档的路径，与 explorer 右键同一颗状态机）。
    clearCompareSelection();
    appState.docs.clear();
    appState.tabs.clear();
    const doc = docModel.makeDoc(91, "正文", "pick.md", "D:\\pick.md", "UTF-8", "LF", false);
    appState.docs.set(doc.tabId, doc);
    const inst = docModel.makeInstance(doc, 0, "正文");
    appState.tabs.set(inst.tabId, inst);
    main.onSelectToCompare!(inst.tabId);
    expect(compareSelection(), "回调体跟着展开走，不是一颗空壳").toBe("D:\\pick.md");
    clearCompareSelection();
  });
});

// ── Task 8 · 编辑器标题栏动作键：图标四颗 + 「⋯」里三条 ──────────────────────────
//
// 设计稿 ⑤ 那五行事实钉的是**字形与判据**，不是「差不多就行」：
//   · 上一个 / 下一个是 `arrow-up` / `arrow-down`（**不是**左右箭头）；
//   · 忽略首尾空白是一颗**带 toggled 状态**的 `whitespace`，按下判据取反 —— 上游那颗 action
//     的 `toggled` 就是 `!config.diffEditor.ignoreTrimWhitespace`；
//   · 折叠未改动区是 `map`（常驻）；全部折叠（`fold`）/ 全部展开（`unfold`）、换行、同步滚动、
//     交换左右（`arrow-swap`）、刷新都收进「⋯」（用户点名：标签条只留高频、低频进菜单），
//     开关性质的条目带 `checked`，并且**不给 Diff View 子菜单**（④·7）。
// 三层各判一件事：① `.panel-ops` 画的就是那四颗、顺序对、「…」仍钉最右（B224 的顺序纪律）；
// ②「⋯」那三条按**点开那一刻**的现状给（B422：渲染时的快照活不过一次击键）；
// ③ 八条动作只有 `src/diff/actions.ts` 一份 switch —— 图标键、命令分发、组菜单三条入口都转调它。
describe("B461 · 编辑器标题栏动作键与「⋯」那三条（Task 8 Step 2）", () => {
  /** 现场清单：`afterEach` 统一拆旁路（surface 那颗防抖只有 `dispose()` 才 clearTimeout，R24）。 */
  const live: Array<() => void> = [];
  let nextId = 500;

  afterEach(() => {
    for (const off of live) off();
    live.length = 0;
    document.body.innerHTML = "";
  });

  /** 够长出两段未改动区的输入（折叠三颗动作要数得出段数）。 */
  const LONG = {
    left: Array.from({ length: 40 }, (_, i) => `${i + 1}`).join("\n"),
    right: Array.from({ length: 40 }, (_, i) => (i === 19 ? "20X" : `${i + 1}`)).join("\n"),
  };

  /** 简报 Interfaces 里 `PanelRenderData.diff` 那一项（图标键的三份现值）。 */
  type DiffKeys = NonNullable<PanelRenderData["diff"]>;

  function diffRenderData(over: Partial<DiffKeys> = {}): PanelRenderData {
    return {
      panelId: 1,
      active: true,
      tabs: [],
      diff: {
        ignoreTrimWhitespace: true,
        collapseUnchanged: false,
        wrap: false,
        syncScroll: true,
        swappable: false,
        ...over,
      },
    };
  }

  /** 只渲染操作区要看的东西：单叶布局 + 一颗 `onDiffAction` 探针（壳层不启动，判据全在这块 DOM 上）。 */
  function mountOps(data: PanelRenderData): { root: HTMLElement; fired: ReturnType<typeof vi.fn> } {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const fired = vi.fn();
    const cb = {
      onActivatePanel: () => {},
      onActivateTab: () => {},
      onCloseTab: () => {},
      onRatioChange: () => {},
      onDropTabToPanel: () => {},
      mountView: () => {},
      onDiffAction: fired,
    } as unknown as SplitviewCallbacks;
    splitview.renderSplitview(
      root,
      { kind: "leaf", panelId: data.panelId },
      new Map([[data.panelId, data]]),
      cb,
    );
    return { root, fired };
  }

  const opsButtons = (root: HTMLElement): HTMLButtonElement[] => [
    ...root.querySelectorAll<HTMLButtonElement>(".panel-ops button"),
  ];
  function opByIcon(root: HTMLElement, id: string): HTMLButtonElement {
    const b = opsButtons(root).find((x) => x.querySelector(`.codicon-${id}`));
    expect(b, `现场：操作区得画出 codicon-${id} 那颗`).toBeTruthy();
    return b!;
  }
  /** 「…」之前那几颗的 codicon id，DOM 顺序 = 屏上顺序。 */
  function iconIds(root: HTMLElement): string[] {
    const btns = opsButtons(root);
    const more = btns.findIndex((b) => b.getAttribute("aria-label") === "更多操作");
    return btns.slice(0, more < 0 ? btns.length : more).map((b) => {
      const el = b.querySelector<HTMLElement>(".codicon");
      const hit = el ? [...el.classList].find((c) => c.startsWith("codicon-")) : undefined;
      return hit ? hit.slice("codicon-".length) : "?";
    });
  }

  /**
   * 真挂一格的差异现场：`.panel-host` + `.panel-editor` + 右栏那颗既有 view + **生产的**挂载判据
   * `syncDiffSurface`。`panelDataOf` / `applyDiffAction` 读的就是这份真状态，不是测试自造的替身。
   *
   * 右栏那份文档同时留一颗**普通**实例（生产里 `openDocForPath` ⇒ `doOpen` 先开它、
   * `attachDiffTab` 再补差异那张）：关掉差异标签时得有它兜着，否则整份文档被注销、
   * 「交换左右」那一发测的就是我自己搭的假象。
   */
  function mountDiffPanel(
    tier: "baseline" | "files",
    texts: { left: string; right: string } = LONG,
  ): { panel: Panel; s: DiffSurface; diffTab: Tab; doc: Doc } {
    appState.docs.clear();
    appState.tabs.clear();
    appState.panels.clear();
    const hostEl = document.createElement("div");
    hostEl.className = "panel-host";
    document.body.appendChild(hostEl);
    const editorEl = document.createElement("div");
    editorEl.className = "panel-editor";
    hostEl.appendChild(editorEl);

    const doc = docModel.makeDoc(
      nextId++,
      texts.right,
      "b.md",
      tier === "files" ? "D:\\b.md" : null,
      "UTF-8",
      "LF",
      false,
    );
    doc.baseline = tier === "baseline" ? texts.left : texts.right;
    appState.docs.set(doc.tabId, doc);
    const spec: DiffSpec =
      tier === "baseline"
        ? {
            tier,
            docId: doc.tabId,
            leftText: () => doc.baseline ?? "",
            leftName: "b.md（上次保存）",
            rightName: "b.md",
            leftPath: null,
          }
        : {
            tier,
            docId: doc.tabId,
            leftText: () => texts.left,
            leftName: "a.md",
            rightName: "b.md",
            leftPath: "D:\\a.md",
          };

    const { state, comps } = editorMod.makeTabState(
      texts.right,
      null,
      { dark: false, wrap: true, perf: perfMod.perfProfileFor("normal") },
      () => {},
    );
    const mk = (kind: "editor" | "diff"): Tab => ({
      tabId: nextId++,
      docId: doc.tabId,
      panelId: 0,
      comps,
      state,
      viewMode: "source",
      kind,
      diff: kind === "diff" ? spec : null,
      scrollV: 1,
    });
    const plainTab = mk("editor");
    const diffTab = mk("diff");
    appState.tabs.set(plainTab.tabId, plainTab);
    appState.tabs.set(diffTab.tabId, diffTab);
    const panel: Panel = {
      panelId: 0,
      tabs: [plainTab.tabId, diffTab.tabId],
      activeTabId: diffTab.tabId,
      view: editorMod.createEditor(editorEl, state),
      viewTabId: diffTab.tabId,
      bodyEl: hostEl,
      diffSurface: null,
    };
    appState.panels.set(0, panel);
    surfaceMod.syncDiffSurface(panel);
    const s = surfaceMod.diffSurfaceOf(panel);
    expect(s, "现场：这张差异标签得真把旁路挂上（挂不上就是假前提）").toBeTruthy();
    live.push(() => surfaceMod.disposeDiffSurface(panel));
    return { panel, s: s!, diffTab, doc };
  }

  /** 组菜单按**点开那一刻**算出的条目（`PanelRenderData.groupMenu` 给的是函数）。 */
  function groupMenuOf(panel: Panel): MenuItem[] {
    const src = render.panelDataOf(panel).groupMenu ?? [];
    return typeof src === "function" ? src() : src;
  }
  const labelsOf = (items: MenuItem[]): Array<string | undefined> =>
    items.filter((i) => !i.separator).map((i) => i.label);

  it("B461 · 差异档常驻只有四颗高频键：上/下差异、显示首尾空白差异、折叠未改动区", () => {
    const { root } = mountOps(diffRenderData({ ignoreTrimWhitespace: true }));
    expect(iconIds(root)).toEqual(["arrow-up", "arrow-down", "whitespace", "map"]);
    // 键位提示取自 `keyHint(id)`（B389 的纪律：字面量只在 keymap.ts 一处）⇒ 用例也按那颗取。
    expect(opByIcon(root, "arrow-up").getAttribute("aria-label")).toBe(
      `上一个差异（${keyHint("diff.prevChange", {})}）`,
    );
    expect(opByIcon(root, "arrow-down").getAttribute("aria-label")).toBe(
      `下一个差异（${keyHint("diff.nextChange", {})}）`,
    );
    expect(
      opsButtons(root).at(-1)!.getAttribute("aria-label"),
      "B224：文档级操作贴标签区，「…」仍钉最右",
    ).toBe("更多操作");
  });

  it("B461 · 忽略空白那颗按 ignoreTrimWhitespace == false 才算按下（上游的 toggled 就是取反）", () => {
    const ignoring = mountOps(diffRenderData({ ignoreTrimWhitespace: true }));
    expect(opByIcon(ignoring.root, "whitespace").getAttribute("aria-pressed")).toBe("false");
    expect(opByIcon(ignoring.root, "whitespace").classList.contains("on")).toBe(false);

    const notIgnoring = mountOps(diffRenderData({ ignoreTrimWhitespace: false }));
    const b = opByIcon(notIgnoring.root, "whitespace");
    expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(
      b.classList.contains("on"),
      "点亮态与 aria-pressed 同一颗键（explorer 那形同口径）",
    ).toBe(true);
    expect(b.getAttribute("aria-label"), "这颗键的文案不跟着状态翻（翻的是 map 那颗）").toBe(
      "显示首尾空白差异",
    );
  });

  it("B461 · map 那颗的文案跟着折叠现状翻：折着 ⇒「显示未改动的内容」，没折 ⇒「折叠未改动的内容」", () => {
    const folded = mountOps(diffRenderData({ collapseUnchanged: true }));
    expect(opByIcon(folded.root, "map").getAttribute("aria-label")).toBe("显示未改动的内容");
    expect(opByIcon(folded.root, "map").getAttribute("aria-pressed")).toBe("true");

    const plain = mountOps(diffRenderData({ collapseUnchanged: false }));
    expect(opByIcon(plain.root, "map").getAttribute("aria-label")).toBe("折叠未改动的内容");
    expect(opByIcon(plain.root, "map").getAttribute("aria-pressed")).toBe("false");
  });

  it("B461 · 差异那一支不捎带 md 那两颗键（显隐走「建不建」，不是建了再藏）", () => {
    const { root } = mountOps(diffRenderData({}));
    const btns = opsButtons(root);
    expect(btns.some((b) => b.querySelector(".codicon-open-preview"))).toBe(false);
    expect(btns.some((b) => b.querySelector(".codicon-preview"))).toBe(false);
    expect(btns.some((b) => b.querySelector(".codicon-edit-code"))).toBe(false);
    // 「差异档不画 md 键」这条判据的真正落点在 `panelDataOf`（`md` 与 `diff` 同时为真是
    // 生产里凑不出来的组合）⇒ 那一条由下面「渲染快照读的是 surface 现值」那条用例钉。
  });

  it("B461 · 四颗常驻键都转调 onDiffAction(panelId, 动作)，动作与图标一一对上", () => {
    const { root, fired } = mountOps({ ...diffRenderData({}), panelId: 3 });
    for (const id of ["arrow-up", "arrow-down", "whitespace", "map"]) opByIcon(root, id).click();
    expect(fired.mock.calls.map((c) => c[1])).toEqual(["prev", "next", "whitespace", "collapse"]);
    expect(
      fired.mock.calls.map((c) => c[0]),
      "panelId 必须是这颗键自己那一格（点左格的键不许把右格的动作拽过来，B228 同形）",
    ).toEqual([3, 3, 3, 3]);
  });

  it("B461 · 渲染快照那三份读的是 surface 现值；旁路拆掉 ⇒ 一颗键都不给", () => {
    const m = mountDiffPanel("baseline");
    expect(
      m.s.ignoreTrimWhitespace(),
      "挂上时的缺省：忽略首尾空白（上游 diffEditor.ignoreTrimWhitespace 默认 true）",
    ).toBe(true);
    m.s.setIgnoreTrimWhitespace(false);
    m.s.setCollapseUnchanged(true);
    const data = render.panelDataOf(m.panel);
    expect(data.diff).toEqual({
      ignoreTrimWhitespace: false,
      collapseUnchanged: true,
      wrap: false,
      syncScroll: true,
      swappable: false,
    });
    expect(data.md, "差异那张与原标签同 docId ⇒ isMdTab 天然为真，必须另外问一句 kind").toBe(false);

    surfaceMod.disposeDiffSurface(m.panel);
    expect(
      render.panelDataOf(m.panel).diff,
      "没有旁路就没有那几颗键（不是画出来点不动）",
    ).toBeUndefined();
  });

  it("B461 · 「⋯」收着低频的几条：交换左右 / 全部折叠 / 自动换行 / 同步滚动 / 刷新；A 档交换置灰", () => {
    const files = mountDiffPanel("files");
    const items = groupMenuOf(files.panel);
    expect(labelsOf(items)).toEqual(
      expect.arrayContaining(["交换左右", "全部折叠", "自动换行", "同步滚动", "刷新"]),
    );
    // 两颗纯开关带 `checked`，且出厂值照 VS Code：换行关、同步滚动开
    // （用户点名：菜单里不能只有一个点了不知道开没开的动作）。
    expect(items.find((i) => i.label === "自动换行")).toMatchObject({ checked: false });
    expect(items.find((i) => i.label === "同步滚动")).toMatchObject({ checked: true });
    expect(labelsOf(items), "④·7：并排⇄内联既不是图标键也不给子菜单").not.toContain("Diff View");
    expect(items.find((i) => i.label === "交换左右")).toMatchObject({ disabled: false });

    const baseline = mountDiffPanel("baseline");
    const swapA = groupMenuOf(baseline.panel).find((i) => i.label?.startsWith("交换左右"));
    expect(swapA, "A 档也列这一条，但点不动（列出来才看得见有这件事）").toMatchObject({
      disabled: true,
    });
    expect(
      swapA!.label,
      "`MenuItem` 没有 tooltip 字段 ⇒ 那句说法按仓库口径写进标签本身（与「与上次保存比较（基线未知）」同形）",
    ).not.toBe("交换左右");
  });

  it("B461 · 菜单里那两颗开关点了真翻面，`checked` 跟着现状走（不是画个死勾）", () => {
    const m = mountDiffPanel("baseline");
    const pick = (label: string): (() => void) =>
      groupMenuOf(m.panel).find((i) => i.label === label)!.onSelect!;

    pick("自动换行")();
    expect(m.s.wrapEnabled(), "点下去走 surface，不是菜单自己记账").toBe(true);
    expect(
      groupMenuOf(m.panel).find((i) => i.label === "自动换行"),
      "菜单每次点开按那一刻求值 ⇒ 勾跟着翻（B422 那条快照过期的教训）",
    ).toMatchObject({ checked: true });

    pick("同步滚动")();
    expect(m.s.syncScrollEnabled()).toBe(false);
    expect(groupMenuOf(m.panel).find((i) => i.label === "同步滚动")).toMatchObject({
      checked: false,
    });
  });

  it("B461 · 「全部折叠」真折上、文案自己换成「全部展开」；再点真展开", () => {
    const m = mountDiffPanel("baseline");
    const first = groupMenuOf(m.panel).find((i) => i.label === "全部折叠");
    expect(first?.onSelect, "现场：这一格折叠没开 ⇒ 条目该是「全部折叠」").toBeTruthy();
    first!.onSelect!();
    expect(
      m.s.foldRanges().length,
      "点下去真折上（走 surface 那颗动作，不是菜单自己记账）",
    ).toBeGreaterThan(0);
    expect(
      labelsOf(groupMenuOf(m.panel)),
      "菜单按点击那一刻求值 ⇒ 文案跟着翻（B422 那条快照过期的教训）",
    ).toContain("全部展开");

    groupMenuOf(m.panel).find((i) => i.label === "全部展开")!.onSelect!();
    expect(m.s.foldRanges()).toEqual([]);
    expect(m.s.collapseUnchanged(), "「全部展开」连开关一起关（下一次重算不许偷偷折回来）").toBe(
      false,
    );
  });

  it("B461 · 收进菜单不碰快捷键：命令 id 照旧在表里，Alt+Z 仍能翻换行", () => {
    const m = mountDiffPanel("baseline");
    // 快捷键路径走的是 `applyDiffCommand`（main.ts 的 runShortcut ⇒ actions 的唯一 switch），
    // 与图标键/菜单同一条落点 —— 按钮收进菜单后这条不许断路。
    expect(effectiveKeys("diff.toggleWrap", {}), "换行的键位没被搬动").toEqual(["Alt+Z"]);
    actions.applyDiffCommand(0, "diff.toggleWrap");
    expect(m.s.wrapEnabled(), "Alt+Z 那条命令仍能真翻面").toBe(true);
    actions.applyDiffCommand(0, "diff.toggleSyncScroll");
    expect(m.s.syncScrollEnabled()).toBe(false);
  });

  it("B461 · 六条动作命令进表：id / label / group 逐字，keys 全空（不给默认键位）", () => {
    const six: Array<[string, string]> = [
      ["diff.toggleWhitespace", "显示首尾空白差异"],
      ["diff.toggleCollapse", "折叠未改动的内容"],
      ["diff.collapseAll", "全部折叠未改动的内容"],
      ["diff.showAll", "全部展开未改动的内容"],
      ["diff.swapSides", "交换左右"],
      ["diff.refresh", "刷新差异"],
    ];
    for (const [id, label] of six) {
      expect(commandById(id), `${id} 得在表里`).toMatchObject({
        id,
        label,
        group: "差异",
        keys: [],
      });
      expect(
        effectiveKeys(id, {}),
        `${id} 不给默认键位（抢键风险 > 收益，走图标键与命令面板）`,
      ).toEqual([]);
    }
    expect(duplicateKeys({}), "空键位不许把这张表自己判成重复").toEqual([]);
    expect(keyHint("diff.refresh", {}), "没键位 ⇒ 提示串是空（菜单不许画出「()」）").toBe("");
  });

  it("B461 · 八条动作只有一份 switch：图标键、命令分发、组菜单三条入口都转调 applyDiffAction", () => {
    const main = srcOf("src/main.ts");
    const run = stripLineComments(fnBody(main, "runShortcut"));
    expect(run).toMatch(/applyDiffCommand\(activePanelId, id\)/);
    expect(run, "分发里不许抄第二份动作清单").not.toMatch(/case "collapseAll":/);
    expect(
      stripLineComments(fnBody(main, "shortcutApplies")),
      "六条共用「这一格正显示差异标签」那道闸（不成时不抢键）",
    ).toMatch(/case "diff\.toggleWhitespace":[\s\S]{0,240}?return diffTabActive\(\);/);

    expect(srcOf("src/shell/splitview.ts")).toMatch(
      /onDiffAction\?:\s*\(panelId: number, action: DiffAction\) => void/,
    );
    const lc = stripLineComments(srcOf("src/tabs/lifecycle.ts"));
    expect(lc).toMatch(
      /onDiffAction:\s*\(panelId,\s*action\)\s*=>\s*applyDiffAction\(panelId,\s*action\)/,
    );
    expect(stripLineComments(srcOf("src/tabs/render.ts"))).toMatch(
      /applyDiffAction\(\s*p\.panelId\s*,/,
    );

    const owners = collectTextFiles("src")
      .filter((p) => p.endsWith(".ts"))
      .map((p) => p.replace(/\\/g, "/"))
      .filter((p) => /case "collapseAll":/.test(readFileSync(p, "utf-8").replace(/\r\n/g, "\n")));
    expect(owners, "两处各写一遍必然漂移（Task 6 那条逐字复制的教训同一个形状）").toEqual([
      "src/diff/actions.ts",
    ]);
  });

  it("B461 · applyDiffAction 落到 surface 的真状态，末尾只刷那一格的操作区", () => {
    const m = mountDiffPanel("baseline");
    const { root } = mountOps(render.panelDataOf(m.panel));
    expect(iconIds(root)).toEqual(["arrow-up", "arrow-down", "whitespace", "map"]);
    // 缺省忽略首尾空白（上游 diffEditor.ignoreTrimWhitespace 默认 true）⇒ 这颗键进门是未按下态。
    expect(opByIcon(root, "whitespace").getAttribute("aria-pressed")).toBe("false");

    actions.applyDiffAction(0, "whitespace");
    expect(m.s.ignoreTrimWhitespace()).toBe(false);
    expect(
      opByIcon(root, "whitespace").getAttribute("aria-pressed"),
      "点完一颗键，那一格的操作区自己换成新状态（不靠用户再切一次标签）",
    ).toBe("true");

    actions.applyDiffAction(0, "collapse");
    expect(m.s.collapseUnchanged()).toBe(true);
    expect(m.s.foldRanges().length).toBeGreaterThan(0);

    actions.applyDiffAction(0, "showAll");
    expect(m.s.foldRanges()).toEqual([]);
    actions.applyDiffAction(0, "collapseAll");
    expect(m.s.foldRanges().length).toBeGreaterThan(0);

    // 收进菜单的两颗开关：默认值照 VS Code（换行关、同步滚动开），动作本身照旧落账。
    expect(m.s.wrapEnabled(), "VS Code 的 diffEditor.wordWrap 出厂是 off").toBe(false);
    actions.applyDiffAction(0, "wrap");
    expect(m.s.wrapEnabled()).toBe(true);
    actions.applyDiffAction(0, "wrap");
    expect(m.s.wrapEnabled()).toBe(false);

    expect(m.s.syncScrollEnabled(), "VS Code 的差异编辑器恒同步").toBe(true);
    actions.applyDiffAction(0, "syncScroll");
    expect(m.s.syncScrollEnabled()).toBe(false);

    const caretLine = (): number => {
      const v = m.panel.view!.view;
      return v.state.doc.lineAt(v.state.selection.main.head).number;
    };
    expect(caretLine(), "现场：光标在第 1 行").toBe(1);
    actions.applyDiffAction(0, "next");
    expect(caretLine(), "「下一个」落到那块改动行（第 20 行）").toBe(20);
    actions.applyDiffAction(0, "prev");
    expect(caretLine(), "只有一块 ⇒ 环绕仍是它自己（上游 goToPreviousDiff 到头回另一头）").toBe(20);
  });

  it("B461 · 「刷新」把块表按现在的两份正文重算一遍（保存之后差异自己没）", async () => {
    const m = mountDiffPanel("baseline");
    expect(m.s.blocks()).toHaveLength(1);
    docModel.markClean(m.doc, LONG.right); // 保存成功那一步：基线就地换成右栏正文
    expect(
      m.s.blocks(),
      "块表是**重算**出来的，不是键入时顺手改的 ⇒ 没点刷新之前还是旧的那份",
    ).toHaveLength(1);

    actions.applyDiffAction(0, "refresh");
    await vi.waitFor(() => {
      expect(m.s.blocks(), "刷新那一发读的是活的基线 ⇒ 差异清零").toEqual([]);
    });
  });

  it("B461 · B 档「交换左右」= 用反过来的那一对重开一张，原来那张关掉", async () => {
    // 为什么不是「就地换 spec」：右栏那颗 view 就是 `Panel.view`（那份文档本身，Task 1 定死的
    // 落点），就地只换得动左栏 ⇒ 两栏读同一份内容、差异清零。真就地换要把 `tab.docId` /
    // `tab.state` / `panel.view` 一起搬到另一份文档上（脏标记 / 存盘 / 撤销栈 / 孤儿 doc 那
    // 一大片记账重接一遍）—— 那是另一条活，本轮不做（裁决 R38）。
    const m = mountDiffPanel("files"); // 左 = D:\a.md（对照缓冲）· 右 = D:\b.md（在册）
    const oldDiffTabId = m.diffTab.tabId;
    const aDoc = docModel.makeDoc(900, "甲\n乙", "a.md", "D:\\a.md", "UTF-8", "LF", false);
    aDoc.baseline = "甲\n乙";
    appState.docs.set(aDoc.tabId, aDoc); // 反向重开时那份「已经开着」⇒ 右栏复用它，不读第二遍盘
    diffModel.setDiffRenderHooks({
      rebuildLayout: () => {},
      refreshAll: () => {},
      renderPanelTabs: () => {},
      showMessage: () => {},
      switchTab: () => {},
    });

    actions.applyDiffAction(0, "swap");
    // 「点一下就走」那一发（图标键与菜单都不 await）中间有一瞬**两张都在**、老那张还在 ⇒
    // 只等「差异标签剩一张」会在那一刻就误判通过（真机抓到过一次假绿）。等的是落定后的形状。
    await vi.waitFor(() => {
      const diffTabs = [...appState.tabs.values()].filter((t) => t.kind === "diff");
      expect(diffTabs).toHaveLength(1);
      expect(diffTabs[0].diff!.leftPath).toBe("D:\\b.md");
    });
    const swapped = [...appState.tabs.values()].find((t) => t.kind === "diff")!;
    expect(swapped.tabId, "新那一张是另一颗标签 ⇒ 老那张已经关掉").not.toBe(oldDiffTabId);
    expect(appState.tabs.has(oldDiffTabId), "每交换一次多一张 = 数不清的差异标签").toBe(false);
    expect(swapped.diff!.docId, "右栏换成原来左栏那份文档").toBe(aDoc.tabId);
    expect(
      appState.tabs.has(m.doc.tabId) ||
        [...appState.tabs.values()].some((t) => t.docId === m.doc.tabId),
      "原右栏那份文档不许被这一发注销（它还留着那颗普通实例）",
    ).toBe(true);
  });

  it("B461 · A 档点「交换左右」什么都不换（对照物是上次保存的正文，不是另一份文件）", async () => {
    const m = mountDiffPanel("baseline");
    const before = [...appState.tabs.keys()].sort();
    diffModel.setDiffRenderHooks({
      rebuildLayout: () => {},
      refreshAll: () => {},
      renderPanelTabs: () => {},
      showMessage: () => {},
      switchTab: () => {},
    });

    actions.applyDiffAction(0, "swap");
    // 这一发进门就退（`tier !== "files"`），但它是 async 的 ⇒ 让微任务队列跑完再判，
    // 免得「没换」只是因为还没换完。
    await new Promise((r) => setTimeout(r, 0));
    expect([...appState.tabs.keys()].sort(), "不许开出一张新的，也不许关掉原来那张").toEqual(
      before,
    );
    expect(m.s.spec(), "spec 原样（就地 retarget 会把两栏变成同一份内容 ⇒ 差异清零）").toBe(
      m.diffTab.diff,
    );
  });
});

// ---------------------------------------------------------------- Task 10 · 会话与禁搬移
//
// 这一组判的是「线接没接上」，跨 7 个文件；行为那一头在 tests/diff-session.test.ts。
// 结构判据都配一发**退化自证**（把被判的那一句摘掉，判据必须落空）—— 否则一条永远为真的
// `toContain` 只是在测我自己写的字符串（仓库既定的反假绿纪律）。
describe("B461 · Task 10 会话字段与禁搬移的跨文件接线", () => {
  // 先剥整行注释：本项目删一套接线时习惯留一行注释交代去向，拿原文判「有没有这一句」
  // 会被变更史喂成假绿（tests/static.ts 那条纪律的同一形）。
  const read = (p: string) => stripLineComments(readFileSync(p, "utf-8"));

  it("两格会话字段只有**一处**写点，且问的是 Tab 自己的 kind / diff.leftPath", () => {
    const writers = collectTextFiles("src").filter((p) =>
      read(p).includes("sessionStore.setDiff("),
    );
    expect(
      writers.map((p) => p.replace(/\\/g, "/")),
      "写点分裂就是 B304 那一课",
    ).toEqual(["src/session/persist.ts"]);
    const call = read("src/session/persist.ts").match(/sessionStore\.setDiff\(([^;]*)\);/)?.[1];
    expect(call, "取不到那一发 setDiff").toBeTruthy();
    expect(call).toContain('t.kind === "diff"');
    expect(call).toContain("t.diff?.leftPath");
  });

  it("toDisk 两格都带上，blankRecord 初值是 null（不许 undefined 混进落盘形状）", () => {
    const store = read("src/session/store.ts");
    const disk = fnBody(store, "toDisk");
    expect(disk).toContain("kind: r.kind");
    expect(disk).toContain("diffLeftPath: r.diffLeftPath");
    const blank = fnBody(store, "blankRecord");
    expect(blank).toContain("kind: null");
    expect(blank).toContain("diffLeftPath: null");
    // 退化自证：把 toDisk 里那一格摘掉，上面那条必须落空。
    expect(disk.replace("kind: r.kind,", "")).not.toContain("kind: r.kind");
  });

  it("恢复问模型层要 spec，按它选孪生构造器（不自己拼第二份 spec 字面量）", () => {
    const rebuild = read("src/session/rebuild.ts");
    const body = fnBody(rebuild, "buildInstance");
    expect(body, "取不到 buildInstance").toBeTruthy();
    expect(body).toContain("await restoreDiffSpec(st, doc)");
    expect(body).toContain("makeDiffInstance(doc, panelId, src.text, diffSpec)");
    expect(body, "回落那一支仍在（差异开不出来不许把文件丢掉）").toContain(
      "makeInstance(doc, panelId, src.text)",
    );
    expect(body, "不许在这里自己拼 tier/docId/leftText（那是模型层的真相）").not.toContain(
      'tier: "baseline"',
    );
    // 两处调用都得 await：漏一处就是「拿 Promise 当 Tab 用」，恢复出来的标签全是空的。
    expect(rebuild).toContain("await buildInstance(st, panel.panelId)");
    expect(rebuild).toContain("await buildInstance(st, -1)");
  });

  it("标签条那五条搬移项与拖拽手势都问 isDiff，判据由 render 一处产出", () => {
    const strip = read("src/shell/tabstrip.ts");
    expect(strip).toContain("el.draggable = !t.isDiff");
    for (const label of ["复制到相邻面板", "左右分屏", "上下分屏", "在新窗口打开", "移回主窗口"]) {
      // 每一条所在的那一组展开都得带闸：按「这一条之前最近的那个条件」判。
      const at = strip.indexOf(`label: "${label}"`);
      expect(at, `取不到「${label}」`).toBeGreaterThan(-1);
      const before = strip.slice(Math.max(0, at - 220), at);
      expect(before, `「${label}」那一组没带 !t.isDiff 闸`).toContain("!t.isDiff");
    }
    const render = read("src/tabs/render.ts");
    expect(render, "isDiff 只在快照这一处产出").toContain('isDiff: t.kind === "diff"');
    const producers = collectTextFiles("src").filter((p) => /isDiff:/.test(read(p)));
    expect(producers.map((p) => p.replace(/\\/g, "/"))).toEqual(["src/tabs/render.ts"]);
    // 退化自证：那个「往前 220 字」的窗口判据最容易空转（窗口里随便一处 !t.isDiff 就绿）。
    // 把五处闸全摘掉之后，上面那圈必须至少有一条落空 —— 否则它测的是我自己写的字符串。
    const degraded = strip.replaceAll("!t.isDiff && ", "");
    expect(degraded, "退化串要先自证原句还在").not.toBe(strip);
    const gated = (src: string) =>
      ["复制到相邻面板", "左右分屏", "上下分屏", "在新窗口打开", "移回主窗口"].every((label) => {
        const at = src.indexOf(`label: "${label}"`);
        return at > -1 && src.slice(Math.max(0, at - 220), at).includes("!t.isDiff");
      });
    expect(gated(strip)).toBe(true);
    expect(gated(degraded), "闸摘掉之后判据必须落空").toBe(false);
  });

  it("四颗跨面板搬移入口共用一句拒绝，跨窗口那颗也有闸", () => {
    const split = read("src/tabs/split.ts");
    for (const name of [
      "splitActivePanel",
      "moveTabToPanel",
      "moveGroupToPanel",
      "splitPanelWithTab",
    ]) {
      const body = fnBody(split, name);
      expect(body, `取不到 ${name}`).toBeTruthy();
      expect(body, `${name} 没问拒绝那一颗`).toContain("refusesDiffMove");
    }
    const guard = fnBody(split, "refusesDiffMove");
    expect(guard, "拒绝要说一次原因（静默不动 = 死键）").toContain("showMessage(");
    expect(guard).toContain('tabs.get(tabId)?.kind !== "diff"');
    const windows = read("src/multiwindow/windows.ts");
    const lend = fnBody(windows, "openTabsInNewWindow");
    expect(lend, "整组拖到桌面绕过标签自己的 draggable ⇒ 这颗漏斗也要有闸").toContain(
      'tabs.get(id)?.kind === "diff"',
    );
  });

  it("关差异标签在摘除之前先拆旁路（判据用 spec 身份，与 syncDiffSurface 同一把尺）", () => {
    const body = fnBody(read("src/tabs/lifecycle.ts"), "closeTabById");
    const disposeAt = body.indexOf("disposeDiffSurface(panel)");
    const deleteAt = body.indexOf("tabs.delete(tabId)");
    expect(disposeAt, "closeTabById 里要有拆旁路那一发").toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(-1);
    expect(disposeAt, "拆旁路必须排在摘除标签之前").toBeLessThan(deleteAt);
    const guard = body.slice(body.lastIndexOf("if (", disposeAt), disposeAt);
    expect(guard).toContain('tab.kind === "diff"');
    expect(guard, "按 spec 身份认，不按 viewTabId 猜").toContain(
      "panel.diffSurface?.spec() === tab.diff",
    );
  });
});

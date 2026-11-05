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
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { type Doc } from "../src/core/app-state";
import { collectTextFiles, fnBody, stripLineComments } from "./static";
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
    // 表里 `diff.` 打头的命令到此为止：Task 4 那两条步进 + Task 5 的 A 档入口
    //（标题栏那一族仍归 Task 8 ⇒ 多出一条没人认领的就要发红）。
    expect(COMMANDS.filter((c) => c.id.startsWith("diff.")).map((c) => c.id)).toEqual([
      "diff.nextChange",
      "diff.prevChange",
      "diff.openAgainstSaved",
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

beforeAll(async () => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
  [appState, docModel, render, diffModel, diffBlocksMod] = await Promise.all([
    import("../src/core/app-state"),
    import("../src/doc-model"),
    import("../src/tabs/render"),
    import("../src/diff/model"),
    import("../src/diff/blocks"),
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

    // ② 两个 producer：同一颗 windowKind 闸（卫星 ⇒ `undefined` ⇒ 整组缺席）。
    for (const p of ["src/tabs/render.ts", "src/tabs/lifecycle.ts"]) {
      const src = stripLineComments(srcOf(p));
      expect(src, `${p} 必须给「选择以进行比较」`).toMatch(
        /onSelectToCompare:\s*windowKind === "satellite"\s*\?\s*undefined\s*:/,
      );
      expect(src, `${p} 必须给「与 X 比较」`).toMatch(
        /onCompareWith:\s*windowKind === "satellite"\s*\?\s*undefined\s*:/,
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
  });
});

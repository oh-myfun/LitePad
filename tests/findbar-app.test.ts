// @vitest-environment jsdom
// B417 · 悬浮查找条的两条**应用级**契约（`src/find/findbar.ts`，不是 `src/shell/findbar.ts`）：
//   ① 预览档（禁编辑）里替换没有落点 ⇒ 替换行收起、左缘 chevron 压住、Ctrl+H 只落查找并说一句；
//   ② 「已替换 N 处」只属于上一发 —— 查找文本变了 / 换了文档就要退场（用户报的残留）。
//
// 骨架用真实 index.html（`src/ui.ts` 在模块求值时逐个 `el(id)` 取节点，缺一个就抛）；
// 编辑器 view 用「state + dispatch」的替身就够了 —— 这两条契约都不需要 CM6 的布局。
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { findHighlight, findRulerRanges } from "../src/editor/find";

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

vi.mock("../src/ipc/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/ipc/api")>();
  return {
    ...real,
    emitCrossWindow: () => {},
  };
});

let app: typeof import("../src/core/app-state");
let findbar: typeof import("../src/find/findbar");

/** 一个够用的 view 替身：`state` 可读、`dispatch(静) → 新 state`。 */
function fakeView(text: string, extra: Extension[] = []) {
  let state = EditorState.create({ doc: text, extensions: [findHighlight(), ...extra] });
  // B471：差异格的两栏各有一颗 dom —— 查找换侧的判据就是「focusin 落在哪颗 dom 里」。
  const dom = document.createElement("div");
  const contentDOM = document.createElement("span");
  dom.appendChild(contentDOM);
  document.body.appendChild(dom);
  const view = {
    dom,
    contentDOM,
    get state() {
      return state;
    },
    /** B419：模拟 main.ts 的 handleUpdate —— 只有事务**显式**设了选区才回调。 */
    onSelectionSet: null as (() => void) | null,
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
      if (spec.selection) view.onSelectionSet?.();
    },
    focus: () => {},
  };
  return view;
}

function openDoc(
  viewMode: string,
  text = "aa bb aa",
): {
  tab: Record<string, unknown>;
  view: ReturnType<typeof fakeView>;
} {
  const tabId = 10;
  const view = fakeView(text);
  const tab = {
    tabId,
    docId: 1,
    panelId: 0,
    comps: {},
    state: view.state,
    viewMode,
  };
  app.tabs.set(tabId, tab as never);
  app.panels.set(0, {
    panelId: 0,
    tabs: [tabId],
    activeTabId: tabId,
    view: { view } as never,
    viewTabId: tabId,
    bodyEl: null,
    diffSurface: null,
  });
  app.setActivePanelId(0);
  return { tab, view };
}

function status(): HTMLElement {
  return document.querySelector<HTMLElement>(".find-status")!;
}

function chevron(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(".find-chevron")!;
}

function replaceRow(): HTMLElement {
  return document.querySelector<HTMLElement>(".find-row-replace")!;
}

function typeFind(text: string): void {
  const input = document.querySelector<HTMLInputElement>(".find-input")!;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function typeReplace(text: string): void {
  const input = document.querySelector<HTMLInputElement>(".find-replace-input")!;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function countText(): string {
  return document.querySelector<HTMLElement>(".find-count")!.textContent ?? "";
}

beforeAll(async () => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
  [app, findbar] = await Promise.all([
    import("../src/core/app-state"),
    import("../src/find/findbar"),
  ]);
});

beforeEach(() => {
  app.tabs.clear();
  app.panels.clear();
  // 每次从关着的状态起：浮层是应用级单例，留着上一条的展开态会让判据失真
  findbar.getFindBar()?.close();
  // B419：选区开关也是浮层内的持久状态（单例），用例之间必须放回灭的 ——
  // 不然上一条开着的「在选区中查找」会改变下一条的命中范围。
  const sel = document.querySelector<HTMLButtonElement>(".find-sel");
  if (sel?.getAttribute("aria-pressed") === "true") sel.click();
});

describe("B417 · 预览模式禁用悬浮查找条的替换", () => {
  it("预览档：chevron 压住、替换行收起；Ctrl+H（openFindBar('replace')）只落查找并说明原因", () => {
    openDoc("preview");
    findbar.openFindBar("replace");
    const bar = findbar.getFindBar()!;
    expect(bar.isOpen()).toBe(true);
    expect(replaceRow().hidden, "预览档里替换行不许掀开").toBe(true);
    expect(chevron().disabled, "展开键压住").toBe(true);
    expect(chevron().getAttribute("aria-disabled")).toBe("true");
    expect(status().hidden).toBe(false);
    expect(status().textContent).toBe("预览模式下不可替换");
    expect(document.activeElement?.className.includes("find-input"), "焦点仍在查找框").toBe(true);
  });

  it("从源码档切到预览档（applyPanelMode 那一发出口）⇒ 替换入口立刻收掉", () => {
    const { tab } = openDoc("source");
    findbar.openFindBar("replace");
    expect(replaceRow().hidden, "源码档可以展开替换").toBe(false);
    tab.viewMode = "preview";
    findbar.syncFindBarReplaceable();
    expect(replaceRow().hidden).toBe(true);
    expect(chevron().disabled).toBe(true);
  });

  it("编辑档（可写）与源码档一样允许替换", () => {
    openDoc("edit");
    findbar.openFindBar("replace");
    expect(replaceRow().hidden).toBe(false);
    expect(chevron().disabled).toBe(false);
  });
});

describe("B417 · 「已替换 N 处」随查找文本 / 文档变化清掉", () => {
  it("查找框一改，上一次的替换提示就退场", () => {
    openDoc("source");
    findbar.openFindBar();
    const bar = findbar.getFindBar()!;
    typeFind("aa");
    bar.setStatus("已替换 1 处");
    expect(status().hidden).toBe(false);
    typeFind("bb");
    expect(status().hidden, "提示说的是上一发，跟着文本一起清").toBe(true);
  });

  it("换了文档（retargetFindBar）也清", () => {
    openDoc("source");
    findbar.openFindBar();
    const bar = findbar.getFindBar()!;
    bar.setStatus("已替换 3 处");
    findbar.retargetFindBar();
    expect(status().hidden).toBe(true);
  });

  it("换到预览档的文档：清提示的同时把替换入口收掉（两条契约同一发落地）", () => {
    const { tab } = openDoc("source");
    findbar.openFindBar("replace");
    const bar = findbar.getFindBar()!;
    bar.setStatus("已替换 2 处");
    tab.viewMode = "preview";
    findbar.retargetFindBar();
    expect(status().hidden).toBe(true);
    expect(replaceRow().hidden).toBe(true);
    expect(chevron().disabled).toBe(true);
  });
});

// B419（用户）：单次替换连点要累计；查询 / 替换串 / 范围 / 文档一变就清零。
describe("B419 · 单次替换的计数累计与清零", () => {
  it("连点「替换」：1 处 → 2 处（每一发各换一处）", () => {
    openDoc("source");
    findbar.openFindBar();
    typeReplace("cc");
    typeFind("aa");
    const one = document.querySelector<HTMLButtonElement>(".find-replace-one")!;
    click(one);
    expect(status().textContent).toBe("已替换 1 处");
    click(one);
    expect(status().textContent).toBe("已替换 2 处");
  });

  it("换查找内容 ⇒ 累计清零（下一发从 1 重新数）", () => {
    openDoc("source");
    findbar.openFindBar();
    typeReplace("cc");
    typeFind("aa");
    const one = document.querySelector<HTMLButtonElement>(".find-replace-one")!;
    click(one);
    click(one);
    expect(status().textContent).toBe("已替换 2 处");

    typeFind("bb");
    expect(status().hidden, "查找内容变了：上一发的数不再代表这一批").toBe(true);
    click(one);
    expect(status().textContent, "新查询从 1 重新数").toBe("已替换 1 处");
  });

  it("换替换内容 ⇒ 累计清零（替换串不参与匹配，但说的已不是这一批）", () => {
    openDoc("source");
    findbar.openFindBar();
    typeReplace("cc");
    typeFind("aa");
    const one = document.querySelector<HTMLButtonElement>(".find-replace-one")!;
    click(one);
    expect(status().textContent).toBe("已替换 1 处");
    typeReplace("dd");
    expect(status().hidden).toBe(true);
    click(one);
    expect(status().textContent, "重新从 1 数").toBe("已替换 1 处");
  });

  it("换文档（retargetFindBar）⇒ 累计清零", () => {
    openDoc("source");
    findbar.openFindBar();
    typeReplace("cc");
    typeFind("aa");
    click(document.querySelector<HTMLButtonElement>(".find-replace-one")!);
    expect(status().textContent).toBe("已替换 1 处");
    findbar.retargetFindBar();
    expect(status().hidden).toBe(true);
  });
});

// B419（用户）：查找栏开着且「在选区中查找」时，用户换选区 = 换了搜索范围，结果要刷新。
describe("B419 · 在选区中查找：选区变化刷新结果", () => {
  function selBtn(): HTMLButtonElement {
    return document.querySelector<HTMLButtonElement>(".find-sel")!;
  }

  it("换选区 ⇒ 重取锚点并重算；空选区不清锚点", () => {
    const { view } = openDoc("source", "aa bb aa aa aa"); // 全文 4 处 aa
    view.dispatch({ selection: { anchor: 0, head: 8 } }); // 选中「aa bb aa」
    findbar.openFindBar();
    // 模拟 main.ts 的 handleUpdate：事务显式设了选区才回调
    view.onSelectionSet = () => findbar.refreshFindOnSelectionChange();
    click(selBtn()); // 打开「在选区中查找」（锚点 = 0..8）
    typeFind("aa");
    expect(countText()).toBe("1 / 2");

    // 扩到整篇：范围变了 ⇒ 结果必须跟着变（4 处）
    view.dispatch({ selection: { anchor: 0, head: 14 } });
    expect(countText(), "换选区后结果没刷新 = 计数说的还是旧范围").toBe("1 / 4");

    // 空选区（点一下正文）不是「换了个更小的范围」：保留上一个非空选区当范围
    view.dispatch({ selection: { anchor: 3 } });
    expect(countText(), "空选区不许把范围扩回全文").toBe("1 / 4");
  });

  it("自己的步进不算「用户换范围」：锚点不被命中选区带塌", () => {
    const { view } = openDoc("source", "aa bb aa aa");
    view.dispatch({ selection: { anchor: 0, head: 8 } });
    findbar.openFindBar();
    view.onSelectionSet = () => findbar.refreshFindOnSelectionChange();
    click(selBtn());
    typeFind("aa");
    expect(countText()).toBe("1 / 2");

    // 步进会把选区换成命中本身（0..2）。若据此重取锚点，范围就塌成这一个命中 ⇒ 1 / 1。
    click(document.querySelector<HTMLButtonElement>(".find-next")!);
    expect(countText(), "步进后范围仍应是原来的选区").toBe("1 / 2");
    click(document.querySelector<HTMLButtonElement>(".find-next")!);
    expect(countText()).toBe("2 / 2");
    click(document.querySelector<HTMLButtonElement>(".find-next")!);
    expect(countText(), "到头环绕，范围没变").toBe("1 / 2");
  });
});

// B471（用户）：差异格里的查找作用于**当前聚焦的那一栏**（上游 `getFocusedCodeEditor`）——
// 切到左栏后 Ctrl+F 就在左栏里搜；命中高亮、概览标记、计数与替换入口一起换侧。
describe("B471 · 差异格双栏查找：目标跟随焦点侧", () => {
  /** 一颗差异格：右栏是标签正文，左栏默认是另一份可编辑文档（B 档）；用例可切成只读快照。 */
  function openDiffDoc(leftText: string, rightText: string, opts: { leftReadOnly?: boolean } = {}) {
    const tabId = 20;
    const right = fakeView(rightText);
    const left = fakeView(leftText, opts.leftReadOnly ? [EditorState.readOnly.of(true)] : []);
    const tab = {
      tabId,
      docId: 2,
      panelId: 0,
      comps: {},
      state: right.state,
      viewMode: "source",
    };
    app.tabs.set(tabId, tab as never);
    let side: "original" | "modified" = "modified";
    app.panels.set(0, {
      panelId: 0,
      tabs: [tabId],
      activeTabId: tabId,
      view: { view: right } as never,
      viewTabId: tabId,
      bodyEl: null,
      diffSurface: { left, focusedSide: () => side } as never,
    });
    app.setActivePanelId(0);
    const setSide = (s: "original" | "modified"): void => {
      side = s;
    };
    /** 模拟「用户点进某一栏」：surface 先记账，再让 focusin 冒到 document。 */
    const focusSide = (s: "original" | "modified"): void => {
      setSide(s);
      const view = s === "original" ? left : right;
      view.contentDOM.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    };
    return { left, right, focusSide };
  }

  const lines = (v: ReturnType<typeof fakeView>): number[] =>
    findRulerRanges(v.state).map((r) => r.fromLine);

  it("默认（焦点在右栏）⇒ 只点亮右栏，计数按右栏正文算", () => {
    const { left, right } = openDiffDoc("aa bb aa", "aa");
    findbar.openFindBar();
    typeFind("aa");
    expect(countText()).toBe("1 / 1");
    expect(lines(right)).toEqual([1]);
    expect(lines(left), "没聚焦的左栏一个字都不许亮").toEqual([]);
  });

  it("切到左栏 ⇒ 计数与命中换侧、右栏高亮清除；再切回右栏又换回来", () => {
    const { left, right, focusSide } = openDiffDoc("aa\nbb\naa", "aa");
    findbar.openFindBar();
    typeFind("aa");
    expect(countText()).toBe("1 / 1");

    focusSide("original");
    expect(countText(), "左栏 2 处，右栏 1 处 —— 计数必须问当前那一栏").toBe("1 / 2");
    expect(lines(left), "左栏点亮，且命中标记（概览标尺同一份装饰）在左侧").toEqual([1, 3]);
    expect(lines(right), "旧侧高亮必须清掉").toEqual([]);

    focusSide("modified");
    expect(countText()).toBe("1 / 1");
    expect(lines(right)).toEqual([1]);
    expect(lines(left)).toEqual([]);
  });

  it("步进作用在当前侧：左栏两次「下一个」在左栏的两个命中之间走", () => {
    const { left, right, focusSide } = openDiffDoc("aa\nbb\naa", "aa");
    findbar.openFindBar();
    typeFind("aa");
    focusSide("original");
    const next = document.querySelector<HTMLButtonElement>(".find-next")!;
    // 第一发落在光标处那一个命中（`nextMatchIndex` 含端点），第二发才走到下一个命中。
    click(next);
    click(next);
    expect(countText()).toBe("2 / 2");
    expect(left.state.selection.main.from, "选区落在左栏第二个命中").toBe(6);
    expect(right.state.selection.main.empty, "右栏选区不许被左栏的步进带走").toBe(true);
  });

  it("上一个：从当前命中退回前一个，到头环绕到最后一个", () => {
    const { view } = openDoc("source", "aa\nbb\naa\naa");
    findbar.openFindBar();
    typeFind("aa");
    const next = document.querySelector<HTMLButtonElement>(".find-next")!;
    const prev = document.querySelector<HTMLButtonElement>(".find-prev")!;
    click(next);
    click(next);
    expect(countText()).toBe("2 / 3");
    click(prev);
    // 步进刚把选区换成命中本身：若仍拿 head 往前找，找到的就是这一条 ⇒ 原地不动。
    expect(countText()).toBe("1 / 3");
    expect(view.state.selection.main.from).toBe(0);
    click(prev);
    expect(countText(), "第一个再往前 ⇒ 环绕到最后一个命中").toBe("3 / 3");
    expect(view.state.selection.main.from).toBe(9);
  });

  it("左栏只读（A 档基线 / 旧会话快照）：换到左栏后替换入口收掉，替换请求一字不改", () => {
    const { left, focusSide } = openDiffDoc("aa bb aa", "aa", { leftReadOnly: true });
    findbar.openFindBar("replace");
    expect(replaceRow().hidden, "右栏可替换").toBe(false);
    focusSide("original");
    expect(chevron().disabled, "只读快照 ⇒ 替换入口收掉").toBe(true);

    findbar.replaceCurrent({
      text: "aa",
      replace: "cc",
      caseSensitive: false,
      wholeWord: false,
      regexp: false,
      inSelection: false,
      preserveCase: false,
    });
    expect(left.state.doc.toString(), "对照栏正文不许被替换改写").toBe("aa bb aa");
    expect(status().textContent).toBe("对照栏只读，不能在左侧替换");
  });

  it("B 档左栏可编辑：替换入口照常可用，替换写进左栏那份文档", () => {
    const { left, focusSide } = openDiffDoc("aa bb aa", "aa");
    findbar.openFindBar("replace");
    focusSide("original");
    expect(chevron().disabled, "左栏背后是另一份文档 ⇒ 与右栏同权").toBe(false);

    findbar.replaceCurrent({
      text: "aa",
      replace: "cc",
      caseSensitive: false,
      wholeWord: false,
      regexp: false,
      inSelection: false,
      preserveCase: false,
    });
    expect(left.state.doc.toString(), "左栏自己那份正文被替换").toBe("cc bb aa");
  });

  it("关掉查找栏 ⇒ 两栏的高亮一起清（左栏不在 panels 表里，也要清）", () => {
    const { left, right, focusSide } = openDiffDoc("aa bb aa", "aa");
    findbar.openFindBar();
    typeFind("aa");
    focusSide("original");
    expect(lines(left).length).toBe(2);
    findbar.getFindBar()!.close();
    expect(lines(left), "关掉后左栏不许留着命中").toEqual([]);
    expect(lines(right)).toEqual([]);
  });
});

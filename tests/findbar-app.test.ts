// @vitest-environment jsdom
// B417 · 悬浮查找条的两条**应用级**契约（`src/find/findbar.ts`，不是 `src/shell/findbar.ts`）：
//   ① 预览档（禁编辑）里替换没有落点 ⇒ 替换行收起、左缘 chevron 压住、Ctrl+H 只落查找并说一句；
//   ② 「已替换 N 处」只属于上一发 —— 查找文本变了 / 换了文档就要退场（用户报的残留）。
//
// 骨架用真实 index.html（`src/ui.ts` 在模块求值时逐个 `el(id)` 取节点，缺一个就抛）；
// 编辑器 view 用「state + dispatch」的替身就够了 —— 这两条契约都不需要 CM6 的布局。
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { EditorState, type TransactionSpec } from "@codemirror/state";

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
function fakeView(text: string) {
  let state = EditorState.create({ doc: text });
  const view = {
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

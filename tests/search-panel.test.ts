// @vitest-environment jsdom
// B389 · 侧栏搜索**视图**（`src/search/panel.ts` + 写回层 `src/search/replace.ts`）。
//
// 用真实的 index.html 骨架跑：`#side-search` / `#search-panel` 那一串节点必须真在，
// 否则测的是测试自己搭的假结构（口径同 tests/explorer-panel.test.ts、recents-panel.test.ts）。
// store 用**真身**（只假 `ipc/api` 与 `explorer/store` 的根）：分流与去抖是 store 的职责，
// 面板要钉的是「点下去走对了哪条路、屏上画对了没有」，两边一起跑才测得到接缝。
//
// ⚠️ 动态用例**必须经过那一下点击 / 那一次输入**：`registerDrawerView` 不接管点击
//    （B314-8 那颗死键只有真点一下才照得出）。直接调 `setDrawer("search")` 的用例
//    测的是外壳，不是这颗键。
// ⚠️ `src/ui.ts` 在**模块求值时**就逐个 `el(id)` 取节点、取不到就抛 ⇒ 先灌骨架再动态 import。
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";

const h = vi.hoisted(() => ({
  /** 资源管理器那个根（`getRoot` 的替身返回值）；空串 = 没打开文件夹。 */
  root: "",
  /** `searchInFolder` 每一发的入参。 */
  calls: [] as Record<string, unknown>[],
  /** 这些查询串先不答，resolve 存 `release` —— 用例据此演示「在飞」。 */
  gated: new Set<string>(),
  release: new Map<string, (report: unknown) => void>(),
  report: { files: [], matches: 0, limitHit: false, scanned: 0 } as unknown,
  /** 非空 ⇒ `searchInFolder` 按这个理由失败。 */
  fail: "",
  /** `replaceInFiles` 收到的条目（只有**没开在标签里**的那些该出现在这儿）。 */
  replaced: [] as Record<string, unknown>[],
  replaceReport: { filesChanged: 0, occurrences: 0, errors: [] as string[] },
  /** `doOpen` 被点的路径（盘上那条命中）。 */
  opened: [] as string[],
  /** `switchTab` 的调用（面板 id, 实例 id）。 */
  switched: [] as [number, number][],
  /** `saveSettings` 落到盘上的快照。 */
  saved: [] as Record<string, unknown>[],
  /** 确认框答什么。 */
  askAnswer: true,
  askArgs: [] as [string, Record<string, unknown>][],
}));

// 根只有一个出口：面板问 store，store 问这里 —— 不留第二份「当前文件夹」。
vi.mock("../src/explorer/store", () => ({ getRoot: () => h.root }));

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

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: (message: string, opts: Record<string, unknown>) => {
    h.askArgs.push([message, opts]);
    return Promise.resolve(h.askAnswer);
  },
}));

// ⚠️ **部分** mock（保留真身，只换要盯的那几格）：整表替换那份清单少列一个导出，
//    就会在别的模块的调用点上炸出「全绿 + 一个未处理拒绝」（B305 踩过）。
vi.mock("../src/io/files", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/io/files")>();
  return {
    ...real,
    doOpen: (path: string) => {
      h.opened.push(path);
      return Promise.resolve(null);
    },
  };
});

vi.mock("../src/tabs", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/tabs")>();
  return {
    ...real,
    // 换标签真身要重建布局（`rebuildLayout`），面板测试只关心「走没走这一发」。
    switchTab: (panelId: number, tabId: number) => {
      h.switched.push([panelId, tabId]);
    },
    renderPanelTabs: () => {},
  };
});

vi.mock("../src/ipc/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/ipc/api")>();
  return {
    ...real,
    searchInFolder: (a: { query: string }) => {
      h.calls.push(a as unknown as Record<string, unknown>);
      if (h.fail) return Promise.reject(new Error(h.fail));
      if (h.gated.has(a.query)) {
        return new Promise((resolve) => {
          h.release.set(a.query, resolve);
        });
      }
      return Promise.resolve(h.report);
    },
    replaceInFiles: (items: Record<string, unknown>[]) => {
      h.replaced.push(...items);
      return Promise.resolve(h.replaceReport);
    },
    saveSettings: (s: Record<string, unknown>): Promise<void> => {
      h.saved.push(structuredClone(s));
      return Promise.resolve();
    },
  };
});

let panel: typeof import("../src/search/panel");
let store: typeof import("../src/search/store");
let drawer: typeof import("../src/shell/drawer");
let ui: typeof import("../src/ui");
let appState: typeof import("../src/core/app-state");

beforeAll(async () => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
  [panel, store, drawer, ui, appState] = await Promise.all([
    import("../src/search/panel"),
    import("../src/search/store"),
    import("../src/shell/drawer"),
    import("../src/ui"),
    import("../src/core/app-state"),
  ]);
  // 装配只做一次：`setupSearch` 是往元素上加监听，重复装配会让一次点击被处理好几遍。
  panel.setupSearch();
});

/** 盘上一条命中：`column` 是整行里的**字符**列（1 起），`start` 是裁过预览里的下标。 */
function fileHit(path: string, rel: string, name: string, rows: unknown[]) {
  return { path, rel, name, truncated: false, matches: rows };
}

function row(line: number, preview: string, start: number, length: number, column: number) {
  return { line, preview, start, length, column };
}

function report(files: unknown[], matches: number, limitHit = false): unknown {
  return { files, matches, limitHit, scanned: files.length };
}

/**
 * 一份开着的文档：`docs` 里那条账 + `tabs` 里那份实例（离屏：`panel.view = null`）。
 * 离屏是刻意的 —— `reveal` 的落点数学在不重建布局的那一支照样走，
 * 而测试可以直接读回 `inst.state` 验它。
 */
function openDoc(docId: number, path: string, text: string) {
  const doc = {
    tabId: docId,
    path,
    name: path.slice(path.lastIndexOf("\\") + 1),
    encoding: "UTF-8",
    eol: "CRLF",
    baselineEncoding: "UTF-8",
    baselineEol: "CRLF",
    mixedEol: false,
    readonly: false,
    dirty: false,
    baseline: text,
    external: false,
    langLabel: "Markdown",
    langOverride: null,
    diskMtimeMs: 0,
    diskSize: 0,
    sizeClass: "normal",
    backupId: null,
    backedUp: false,
  };
  appState.docs.set(docId, doc as never);
  const inst = {
    tabId: docId * 10,
    docId,
    panelId: 0,
    comps: {} as never,
    state: EditorState.create({ doc: text }),
    viewMode: "source",
  };
  appState.tabs.set(inst.tabId, inst as never);
  appState.panels.set(0, {
    panelId: 0,
    tabs: [inst.tabId],
    activeTabId: inst.tabId,
    view: null,
    viewTabId: null,
    preview: null,
    previewTimer: null,
    bodyEl: null,
  });
  appState.setActivePanelId(0);
  return { doc, inst };
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** 打字：改 value 再派发 `input`（面板读的是 DOM，不是参数）。 */
function type(el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 走一截去抖，并把在飞的 promise 链跑到底。 */
async function settle(ms = 300): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(0);
}

const files = () => [...ui.searchResults.querySelectorAll<HTMLElement>(".search-file")];
/** 某个文件行下面的第 N 行命中（`.search-lines` 紧跟在文件行之后，是它的兄弟节点）。 */
function lineAt(name: string, line: number): HTMLElement {
  const file = files().find((f) => f.querySelector(".search-filename")?.textContent === name);
  const kids = file?.nextElementSibling;
  const hit = kids?.querySelector<HTMLElement>(`.search-line[data-line="${line}"]`);
  if (!file || !hit) throw new Error(`没有这一行命中：${name}:${line}`);
  return hit;
}

beforeEach(() => {
  vi.useFakeTimers();
  appState.setWindowKind("main");
  appState.setSettings({ toc_open: false, drawer_view: "toc", toc_width: 240 } as never);
  h.root = "E:\\笔记";
  h.calls = [];
  h.gated = new Set();
  h.release = new Map();
  h.report = report([], 0);
  h.fail = "";
  h.replaced = [];
  h.replaceReport = { filesChanged: 0, occurrences: 0, errors: [] };
  h.opened = [];
  h.switched = [];
  h.saved = [];
  h.askAnswer = true;
  h.askArgs = [];
  appState.docs.clear();
  appState.tabs.clear();
  appState.panels.clear();
  document.getElementById("main-row")?.classList.remove("is-sidebar-off");
  // ⚠️ 三档不跟着 `clearAll` 走（那是「清除搜索」，VS Code 也只清查询、留着 Aa/ab/.*），
  //    所以用例之间必须自己把它们放回灭的 —— 不然上一条留下的档位会改变这一条的分支。
  store.setQuery({ caseSensitive: false, wholeWord: false, regexp: false });
  store.clearAll();
  drawer.setDrawer(null, false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("B389 · 按钮列那颗键与显隐（登记视图 ≠ 挂按钮）", () => {
  it("点一下：抽屉摊开、面板可见、键亮、`drawer_view` 落盘", () => {
    expect(ui.searchPanel.hidden, "初始收起").toBe(true);
    click(ui.sideSearch);
    expect(drawer.activeDrawer()).toBe("search");
    expect(ui.searchPanel.hidden).toBe(false);
    expect(ui.sideSearch.classList.contains("is-on")).toBe(true);
    expect(ui.sideSearch.getAttribute("aria-pressed")).toBe("true");
    expect(h.saved.at(-1)).toMatchObject({ toc_open: true, drawer_view: "search" });
  });

  it("再点一下收起，但「最后一次摊开的是哪块」仍记着（B312 那一格不许被抹掉）", () => {
    click(ui.sideSearch);
    h.saved.length = 0;
    click(ui.sideSearch);
    expect(drawer.activeDrawer()).toBe(null);
    expect(ui.searchPanel.hidden).toBe(true);
    expect(ui.sideSearch.getAttribute("aria-pressed")).toBe("false");
    expect(h.saved.at(-1), "收起只改「开没开」，不改「开着的是谁」").toMatchObject({
      toc_open: false,
      drawer_view: "search",
    });
  });

  it("整栏收着时点它：先把栏放出来，再摊开那一块（B198 的假死键）", () => {
    document.getElementById("main-row")?.classList.add("is-sidebar-off");
    click(ui.sideSearch);
    expect(
      document.getElementById("main-row")?.classList.contains("is-sidebar-off"),
      "整栏放出来",
    ).toBe(false);
    expect(ui.searchPanel.hidden).toBe(false);
  });

  it("卫星窗口里那颗是死的：不许在子窗口摊开搜索", () => {
    appState.setWindowKind("satellite");
    click(ui.sideSearch);
    expect(drawer.activeDrawer()).toBe(null);
    expect(ui.searchPanel.hidden).toBe(true);
  });
});

describe("B389 · 输入区与模型同源", () => {
  it("打字 300ms 后发一发，三档跟着那三颗键的点击走", async () => {
    type(ui.searchInput, "aa");
    await settle();
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]).toMatchObject({ query: "aa", caseSensitive: false, wholeWord: false });

    click(ui.searchCase);
    click(ui.searchWord);
    click(ui.searchRegex);
    await settle();
    expect(h.calls.length, "连点三颗只补一发：去抖跟着最后一次改").toBe(2);
    expect(h.calls[1]).toMatchObject({ caseSensitive: true, wholeWord: true, regex: true });
    expect(ui.searchCase.classList.contains("on")).toBe(true);
    expect(ui.searchCase.getAttribute("aria-pressed")).toBe("true");
    expect(ui.searchRegex.getAttribute("aria-pressed")).toBe("true");
  });

  it("回车不等去抖；在飞的那发定时器一起取消（否则跑出第二次）", async () => {
    type(ui.searchInput, "aa");
    ui.searchInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(h.calls.length, "按下回车就已经发了").toBe(1);
    await settle(1000);
    expect(h.calls.length, "去抖那一发不能补上").toBe(1);
  });

  it("⋯ 挂上 `.is-more` 并露出两行 glob；glob 的值跟着进 IPC；只改替换串不重搜", async () => {
    click(ui.searchDetailsToggle);
    expect(ui.searchDetails.classList.contains("is-more")).toBe(true);
    expect(ui.searchDetailsToggle.getAttribute("aria-expanded")).toBe("true");

    type(ui.searchInput, "aa");
    await settle();
    const before = h.calls.length;
    type(ui.searchInclude, "*.md");
    type(ui.searchExclude, "test-data");
    await settle();
    expect(h.calls.at(-1)).toMatchObject({ include: "*.md", exclude: "test-data" });

    h.calls.length = 0;
    type(ui.searchReplaceInput, "bb");
    await settle(600);
    expect(h.calls, "替换串不影响搜索结果 ⇒ 不许重搜").toEqual([]);
    expect(before, "上一段确实发过").toBeGreaterThan(0);
  });

  it("非法正则 ⇒ 输入框标红、计数行说人话、一发 IPC 都不发", async () => {
    click(ui.searchRegex);
    type(ui.searchInput, "(");
    await settle(600);
    expect(h.calls, "语法错的串发下去只会得到「后端说不认」，白跑一趟").toEqual([]);
    expect(ui.searchInput.closest(".search-field")?.classList.contains("is-invalid")).toBe(true);
    expect(ui.searchRegex.classList.contains("is-bad")).toBe(true);
    expect(ui.searchCount.textContent).toBe("正则表达式无效");
    expect(ui.searchCount.classList.contains("is-bad")).toBe(true);
  });

  it("在飞时计数行念「正在搜索…」；按清除 ⇒ 旧回包后到也不许把结果长回来", async () => {
    // 取消键已摘（B389 收尾：这一发搜得快到按不着，留着一颗只会让人以为它坏了）。
    // 「作废在飞那一发」这件事仍然有人管 —— 走 `clearAll()` 那条（它跟取消一样加 `seq`）。
    h.gated.add("aa");
    type(ui.searchInput, "aa");
    await settle();
    expect(ui.searchCount.textContent).toBe("正在搜索…");
    expect(document.getElementById("search-stop"), "那颗取消键已从骨架上摘掉").toBeNull();

    click(ui.searchClear);
    h.release.get("aa")?.(
      report([fileHit("E:\\笔记\\a.md", "a.md", "a.md", [row(1, "aa", 0, 2, 1)])], 1),
    );
    await settle(0);
    expect(files(), "旧回包不许把结果长回来").toEqual([]);
    expect(ui.searchCount.textContent).toBe("");
  });

  it("点清除 ⇒ 输入框、结果、计数行一起归零（不留「屏上还写着、模型里已空」）", async () => {
    h.report = report([fileHit("E:\\笔记\\a.md", "a.md", "a.md", [row(1, "aa", 0, 2, 1)])], 1);
    type(ui.searchInput, "aa");
    await settle();
    expect(files().length).toBe(1);

    click(ui.searchClear);
    expect(ui.searchInput.value).toBe("");
    expect(ui.searchCount.textContent).toBe("");
    expect(store.getGroups()).toEqual([]);
    expect(ui.searchResults.querySelector(".search-note")?.textContent).toBe("输入要搜索的内容。");
  });

  it("后端报错 ⇒ 原话进计数行并染红，而不是演成「没有结果」", async () => {
    h.fail = "搜索目录读不了";
    type(ui.searchInput, "aa");
    await settle();
    expect(ui.searchCount.textContent).toBe("搜索目录读不了");
    expect(ui.searchCount.classList.contains("is-bad")).toBe(true);
    h.fail = "";
    type(ui.searchInput, "");
    await settle();
    expect(ui.searchCount.textContent, "查询都空了还挂着失败原话＝像程序坏了").toBe("");
  });
});

describe("B389 · 结果树", () => {
  /** 两个文件：一个在根（rel == name ⇒ 灰字留空），一个在子目录。 */
  function seedResults(): void {
    h.report = report(
      [
        fileHit("E:\\笔记\\a.md", "a.md", "a.md", [
          row(2, "第一处 aa 在此", 4, 2, 5),
          row(5, "第二处 aa 在此", 4, 2, 5),
        ]),
        fileHit("E:\\笔记\\子目录\\b.md", "子目录\\b.md", "b.md", [row(1, "aa 只有一处", 0, 2, 1)]),
      ],
      3,
    );
  }

  it("两层行：文件行念「名字 + 相对路径 + 命中数」，命中行念「行号 + 命中那一段」", async () => {
    seedResults();
    type(ui.searchInput, "aa");
    await settle();
    expect(files().length).toBe(2);
    expect(files()[0].querySelector(".search-filename")?.textContent).toBe("a.md");
    expect(
      files()[0].querySelector(".search-rel")?.textContent,
      "rel 与名字相同时不重复念一遍",
    ).toBe("");
    expect(files()[1].querySelector(".search-rel")?.textContent).toBe("子目录\\b.md");
    expect(files()[0].querySelector(".search-badge")?.textContent).toBe("2");
    expect(ui.searchCount.textContent).toBe("在 2 个文件中发现 3 个结果");

    const hit = lineAt("a.md", 2);
    expect(hit.querySelector(".search-linenum")?.textContent).toBe("2");
    expect(hit.querySelector(".search-hit")?.textContent).toBe("aa");
    expect(hit.textContent, "整行原文仍在（裁过的预览只缺头尾，不缺中间）").toContain(
      "第一处 aa 在此",
    );
  });

  it("点文件行折/展；全量键跟着换图标与 `aria-pressed`，再点一次全展", async () => {
    seedResults();
    type(ui.searchInput, "aa");
    await settle();
    // ⚠️ 每一下点击之后都要重新取节点：折/展会整棵重绘，手上那份旧元素已经离开文档了。
    click(files()[0]);
    expect(files()[0].getAttribute("aria-expanded")).toBe("false");
    expect(files()[0].nextElementSibling?.classList.contains("search-lines")).toBe(true);
    expect((files()[0].nextElementSibling as HTMLElement).hidden).toBe(true);
    expect(ui.searchCollapseAll.getAttribute("aria-pressed"), "只折了一个 ⇒ 全量键不算折着").toBe(
      "false",
    );

    click(files()[0]);
    expect((files()[0].nextElementSibling as HTMLElement).hidden).toBe(false);

    click(ui.searchCollapseAll);
    expect(
      files().every((f) => f.getAttribute("aria-expanded") === "false"),
      "一发折全部",
    ).toBe(true);
    expect(ui.searchCollapseAll.getAttribute("aria-pressed")).toBe("true");
    expect(ui.searchCollapseAll.getAttribute("aria-label")).toBe("全部展开");

    click(ui.searchCollapseAll);
    expect(
      files().every((f) => f.getAttribute("aria-expanded") === "true"),
      "再点一发全展",
    ).toBe(true);
    expect(ui.searchCollapseAll.getAttribute("aria-label")).toBe("全部折叠");
  });

  it("点一条**开着的**命中：切标签 + 把选区摆到那六个字符（emoji 那行按字符列换算）", async () => {
    h.root = "E:\\笔记";
    const { inst } = openDoc(7, "E:\\笔记\\a.md", "😀 中文 needle 尾巴");
    h.report = report(
      [fileHit("E:\\笔记\\a.md", "a.md", "a.md", [row(1, "😀 中文 needle 尾巴", 5, 6, 6)])],
      1,
    );
    type(ui.searchInput, "needle");
    await settle();
    expect(store.getGroups()[0].docId, "同一份文件要认出正开着的那份").toBe(7);

    click(lineAt("a.md", 1));
    await settle(0);
    expect(h.switched).toEqual([[0, 70]]);
    expect(h.opened, "已经开着的不再去盘上开一遍").toEqual([]);
    const sel = inst.state.selection.main;
    expect(inst.state.sliceDoc(sel.from, sel.to)).toBe("needle");
    // 字符列 6 ⇒ UTF-16 是 6（emoji 那两个单元在字符 0 那一格里）；按字符直接摆会落到 5。
    expect(sel.from).toBe(6);
    expect(lineAt("a.md", 1).getAttribute("aria-selected")).toBe("true");
  });

  it("点一条**只在盘上**的命中：先 `doOpen` 那条路径（不自己开一扇漏斗）", async () => {
    h.report = report(
      [fileHit("E:\\笔记\\子目录\\b.md", "子目录\\b.md", "b.md", [row(1, "aa 只有一处", 0, 2, 1)])],
      1,
    );
    type(ui.searchInput, "aa");
    await settle();
    click(lineAt("b.md", 1));
    await settle(0);
    expect(h.opened).toEqual(["E:\\笔记\\子目录\\b.md"]);
  });

  it("没打开文件夹 ⇒ 画的是内存快照，并说明这一屏搜的是哪儿（用户口径第一条）", async () => {
    h.root = "";
    openDoc(3, "E:\\别处\\c.md", "标题\n这里 aa 没保存");
    type(ui.searchInput, "aa");
    await settle();
    expect(h.calls, "兜底那一支读内存，一次 IPC 都不发").toEqual([]);
    expect(files().length).toBe(1);
    expect(ui.searchCount.textContent).toBe("在 1 个打开的文档中发现 1 个结果");
    expect(ui.searchResults.querySelector(".search-note")?.textContent).toContain("没有打开文件夹");
  });

  it("一条没搜着 ⇒ 计数行「未找到结果。」并染红，空态不复读同一句", async () => {
    h.report = report([], 0);
    type(ui.searchInput, "aa");
    await settle();
    expect(ui.searchCount.textContent).toBe("未找到结果。");
    expect(ui.searchCount.classList.contains("is-bad")).toBe(true);
    expect(ui.searchResults.querySelector(".search-note"), "计数行已经说过，别再念一遍").toBeNull();
  });
});

describe("B389 · 全部替换（先确认，再分两批写）", () => {
  /** 一个开着的（走内存）+ 一个只在盘上的（走 IPC）。 */
  function seedTwoGroups(): void {
    h.report = report(
      [
        fileHit("E:\\笔记\\a.md", "a.md", "a.md", [row(1, "aa 在标签里", 0, 2, 1)]),
        fileHit("E:\\笔记\\b.md", "b.md", "b.md", [row(1, "aa 在盘上", 0, 2, 1)]),
      ],
      2,
    );
  }

  it("替换行由左缘那颗键开合，面板跟着挂 `.is-replace-shown`", () => {
    expect(ui.searchReplaceRow.hidden).toBe(true);
    click(ui.searchToggleReplace);
    expect(ui.searchReplaceRow.hidden).toBe(false);
    expect(ui.searchPanel.classList.contains("is-replace-shown")).toBe(true);
    expect(ui.searchToggleReplace.getAttribute("aria-expanded")).toBe("true");
    click(ui.searchToggleReplace);
    expect(ui.searchReplaceRow.hidden).toBe(true);
  });

  it("一条结果都没有 ⇒ 那颗键是压住的（不弹一个「将替换 0 个文件」的框）", async () => {
    click(ui.searchToggleReplace);
    type(ui.searchInput, "aa");
    type(ui.searchReplaceInput, "bb");
    await settle();
    expect(ui.searchReplaceAll.disabled).toBe(true);
    expect(h.askArgs).toEqual([]);
  });

  it("点全部替换 ⇒ 先问一次；答「取消」就一发都不发", async () => {
    openDoc(7, "E:\\笔记\\a.md", "aa 在标签里");
    seedTwoGroups();
    type(ui.searchInput, "aa");
    type(ui.searchReplaceInput, "bb");
    await settle();
    expect(ui.searchReplaceAll.disabled).toBe(false);

    h.askAnswer = false;
    click(ui.searchReplaceAll);
    await settle(0);
    expect(h.askArgs.length).toBe(1);
    expect(h.askArgs[0][1]).toMatchObject({
      kind: "warning",
      okLabel: "替换",
      cancelLabel: "取消",
    });
    expect(h.askArgs[0][0]).toContain("2 个文件");
    expect(h.replaced).toEqual([]);
    expect(appState.docs.get(7)).toMatchObject({ dirty: false });
  });

  it("确认 ⇒ 开着的只改内存、只在盘上的进 `replace_in_files`，计数行念结果并重搜", async () => {
    const { doc, inst } = openDoc(7, "E:\\笔记\\a.md", "aa 在标签里");
    seedTwoGroups();
    type(ui.searchInput, "aa");
    type(ui.searchReplaceInput, "bb");
    await settle();

    h.replaceReport = { filesChanged: 1, occurrences: 1, errors: [] };
    click(ui.searchReplaceAll);
    await settle(0);

    expect(inst.state.doc.toString(), "内存那一批改的是快照").toBe("bb 在标签里");
    expect(doc.dirty, "改过就要挂上未保存的原点").toBe(true);
    expect(
      h.replaced.map((i) => i.path),
      "盘上那一批只收没开在标签里的",
    ).toEqual(["E:\\笔记\\b.md"]);
    expect(h.replaced[0]).toMatchObject({ query: "aa", replacement: "bb" });
    expect(h.calls.length, "换完必须重搜一次：不然那一屏已经是假的").toBe(2);
    expect(ui.searchCount.textContent).toBe("已替换 2 处，改动 2 个文件");
  });

  it("搜索**之后**才点开的那一条：走内存，不许被当成「只在盘上」写回去", async () => {
    // 真机照出来的那一形（B389-7）：点一条命中 = 顺手把那个文件开出来了，而结果组里那份
    // `docId` 快照还是 null ⇒ 替换时它被划进盘上那一批，整份覆盖之后标签撞上
    // 「已在外部被修改」。分这一刀必须**现场问标签表**，确认框念的与实际写的同一份。
    h.report = report(
      [
        fileHit("E:\\笔记\\a.md", "a.md", "a.md", [row(1, "aa 后来被点开", 0, 2, 1)]),
        fileHit("E:\\笔记\\b.md", "b.md", "b.md", [row(1, "aa 在盘上", 0, 2, 1)]),
      ],
      2,
    );
    type(ui.searchInput, "aa");
    type(ui.searchReplaceInput, "bb");
    await settle();
    expect(
      store.getGroups().every((g) => g.docId === null),
      "搜的时候两份都没开着",
    ).toBe(true);

    const { doc, inst } = openDoc(7, "E:\\笔记\\a.md", "aa 后来被点开");
    h.replaceReport = { filesChanged: 1, occurrences: 1, errors: [] };
    click(ui.searchReplaceAll);
    await settle(0);

    expect(inst.state.doc.toString(), "开着的这一份按内存那一支改").toBe("bb 后来被点开");
    expect(doc.dirty).toBe(true);
    expect(
      h.replaced.map((i) => i.path),
      "盘上那一批只剩真没开着的",
    ).toEqual(["E:\\笔记\\b.md"]);
    expect(h.askArgs[0][0], "确认框念的「几个没开在标签里」与实际写回同一份分组").toContain(
      "其中 1 个没开在标签里",
    );
  });

  it("后端逐条报失败 ⇒ 原样念出来，不折叠成人话", async () => {
    // 只留盘上那一组：没有开着的 ⇒ 内存那一发不挡路，失败原话就是全部可念的东西
    h.report = report(
      [fileHit("E:\\笔记\\b.md", "b.md", "b.md", [row(1, "aa 在盘上", 0, 2, 1)])],
      1,
    );
    type(ui.searchInput, "aa");
    type(ui.searchReplaceInput, "bb");
    await settle();
    h.replaceReport = { filesChanged: 0, occurrences: 0, errors: ["E:\\笔记\\b.md：正被占用"] };
    click(ui.searchReplaceAll);
    await settle(0);
    expect(ui.searchCount.textContent).toBe("没有可替换的匹配；1 条失败：E:\\笔记\\b.md：正被占用");
    expect(ui.searchCount.classList.contains("is-bad")).toBe(true);
  });
});

describe("B389 · 从命令/快捷键摊开（种子取活动视图选中的那一串）", () => {
  /** 给面板挂一个「看得见的视图」：只要 `state` 与 `focus` 这两格，`openSearchView` 读得到就够。 */
  function visibleView(text: string, from: number, to: number): void {
    const state = EditorState.create({ doc: text, selection: { anchor: from, head: to } });
    appState.panels.set(0, {
      panelId: 0,
      tabs: [],
      activeTabId: 0,
      view: { view: { state, focus: () => {} } } as never,
      viewTabId: 0,
      preview: null,
      previewTimer: null,
      bodyEl: null,
    });
    appState.setActivePanelId(0);
  }

  it("选中的那一串填进搜索框（按下去就已经把要搜的词填好了）", () => {
    visibleView("标题\nneedle 在这里", 3, 9);
    panel.openSearchView();
    expect(drawer.activeDrawer()).toBe("search");
    expect(ui.searchInput.value).toBe("needle");
  });

  it("框里已经有字 ⇒ 不覆盖（再按一次是想回到面板，不是想丢掉刚打的那串）", () => {
    visibleView("needle 在这里", 0, 6);
    type(ui.searchInput, "已经打了一半");
    panel.openSearchView();
    expect(ui.searchInput.value).toBe("已经打了一半");
  });

  it("跨行的选区不当种子（那一串塞进单行输入框只会看着像坏了）", () => {
    visibleView("一\n二", 0, 3);
    panel.openSearchView();
    expect(ui.searchInput.value).toBe("");
  });

  it("「在文件中替换」那一发：同一个面板掀开替换行，焦点给替换框", () => {
    visibleView("needle 在这里", 0, 6);
    panel.openSearchView(true);
    expect(drawer.activeDrawer(), "不另起一块面板：还是搜索这一块").toBe("search");
    expect(ui.searchReplaceRow.hidden).toBe(false);
    expect(ui.searchPanel.classList.contains("is-replace-shown")).toBe(true);
    expect(ui.searchInput.value, "选区照样填进查找框（VS Code 两个框都种子化）").toBe("needle");
    expect(document.activeElement, "焦点在替换框：那一发要改的是替换串").toBe(
      ui.searchReplaceInput,
    );
  });

  it("命令表把这两条键位给出去了（用户点名照 VS Code 的 Ctrl+Shift+F / H）", async () => {
    const { commandById } = await import("../src/shell/keymap");
    expect(commandById("edit.findInFiles")?.keys).toEqual(["Ctrl+Shift+F"]);
    expect(commandById("edit.replaceInFiles")?.keys).toEqual(["Ctrl+Shift+H"]);
  });
});

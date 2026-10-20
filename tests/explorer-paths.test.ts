// @vitest-environment jsdom
// B315-4 · 「盘上的路径变了」之后，打开着的文档跟着改。
//
// 跑的是**真接缝**：`explorer/store` 的动作层（真身）→ `onPathsChanged` → `paths.ts` →
// `docs` 那份账 + 后端那条记录 + 「最近打开」+ 跨窗口广播。只有 IPC 与 Tauri 事件是假的。
// ⚠️ 静态 import 会抢在 `innerHTML` 之前把 `ui.ts` 的 `el()` 炸掉（口径同 explorer-panel.test.ts），
//    所以被测模块一律在 `beforeAll` 里 `await import(...)`；`core/events` 没有 DOM 依赖，静态留着 ——
//    事件名要的是「两端同一个常量」，而不是我自己再抄一遍字符串。
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { EVT_DOC_PATH_CHANGED } from "../src/core/events";

const h = vi.hoisted(() => ({
  /** `set_doc_path` 的每一发：[标签 id, 路径]。 */
  docPaths: [] as [number, string][],
  /** 广播出去的事件（`emitCrossWindow` 最终落到 `emit`）。 */
  emitted: [] as { event: string; payload: Record<string, unknown> }[],
  retitled: [] as [string, string][],
  forgotten: [] as string[],
  /** 装上的监听按事件名留着（传递依赖也会 `listen`，只留最后一条会拿错）。 */
  handlers: {} as Record<string, (payload: unknown) => void>,
  /** 本窗口 label：`emitCrossWindow` 注入的 `from` 与回声排除判据都用它。 */
  selfLabel: "main",
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (e: { payload: unknown }) => void) => {
    h.handlers[event] = (payload: unknown) => handler({ payload });
    return Promise.resolve(() => {});
  },
  emit: (event: string, payload: Record<string, unknown>) => {
    h.emitted.push({ event, payload });
    return Promise.resolve();
  },
  emitTo: () => Promise.resolve(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  // `refreshAll` 会一路走到窗口标题：`setTitle` 必须是函数，否则整条链在测试里先炸。
  getCurrentWindow: () => ({ label: h.selfLabel, setTitle: () => Promise.resolve() }),
}));

vi.mock("../src/ipc/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/ipc/api")>();
  const base = (p: string): string => p.slice(p.lastIndexOf("\\") + 1);
  const dirOf = (p: string): string => p.slice(0, p.lastIndexOf("\\"));
  const mk = (path: string, name: string) => ({ name, path, isDir: false, size: 1, mtimeMs: 0 });
  return {
    ...real,
    invoke: () => Promise.reject(new Error("测试里不许真发 IPC")),
    listDir: () => Promise.resolve({ entries: [], truncated: false }),
    renameEntry: (_root: string, path: string, newName: string) =>
      Promise.resolve(mk(`${dirOf(path)}\\${newName}`, newName)),
    moveEntry: (_root: string, src: string, destDir: string) =>
      Promise.resolve(mk(`${destDir}\\${base(src)}`, base(src))),
    copyEntry: (_root: string, src: string, destDir: string) =>
      Promise.resolve(mk(`${destDir}\\${base(src)}`, base(src))),
    deleteEntry: () => Promise.resolve(),
    setDocPath: (tabId: number, path: string) => {
      h.docPaths.push([tabId, path]);
      return Promise.resolve();
    },
    retitleRecent: (old: string, next: string) => {
      h.retitled.push([old, next]);
      return Promise.resolve([]);
    },
    forgetRecent: (path: string) => {
      h.forgotten.push(path);
      return Promise.resolve([]);
    },
    saveSettings: () => Promise.resolve(),
  };
});

let paths: typeof import("../src/explorer/paths");
let store: typeof import("../src/explorer/store");
let appState: typeof import("../src/core/app-state");
let docModel: typeof import("../src/doc-model");
let render: typeof import("../src/tabs/render");

const ROOT = "E:\\笔记";
const P = (...segs: string[]): string => [ROOT, ...segs].join("\\");

beforeAll(async () => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
  [paths, store, appState, docModel, render] = await Promise.all([
    import("../src/explorer/paths"),
    import("../src/explorer/store"),
    import("../src/core/app-state"),
    import("../src/doc-model"),
    import("../src/tabs/render"),
  ]);
  paths.setupPathRewiring();
});

/**
 * 造一份「正开着」的文档，并挂上标签实例与面板 —— `tabViewDataOf` 是标签条那一排显示
 * 内容的唯一出口，拿它断言才等于断言「用户看见的名字与路径变了」。
 */
function openDoc(tabId: number, path: string, text = "正文"): void {
  const name = path.slice(path.lastIndexOf("\\") + 1);
  const doc = docModel.makeDoc(tabId, text, name, path, "UTF-8", "LF", false);
  appState.docs.set(tabId, doc);
  // 真实例：`refreshAll` 一路走到状态栏，那里读的是 `tab.state.doc.length` ——
  // 拿一个 `{}` 冒充标签，测的就是我自己搭的假象，而不是屏上那一格。
  appState.tabs.set(tabId, { ...docModel.makeInstance(doc, 0, text), tabId });
  appState.panels.set(0, {
    panelId: 0,
    tabs: [...appState.tabs.keys()],
    activeTabId: tabId,
    view: null,
    preview: null,
    previewTimer: null,
    bodyEl: null,
  } as never);
}

function tabLabels(): [string, string | undefined][] {
  return render.tabViewDataOf(appState.panels.get(0)!).map((t) => [t.name, t.path]);
}

/**
 * 只数「路径变了」那一条广播。
 * `refreshAll` 里也有一条跨窗口的文档在场播报（`doc-open` / `doc-close-notify`），
 * 那是它自己的账，本用例不认 —— 但也不能反过来断言「一条广播都没发」，那是假绿。
 */
function pathBroadcasts(): Record<string, unknown>[] {
  return h.emitted.filter((e) => e.event === EVT_DOC_PATH_CHANGED).map((e) => e.payload);
}

beforeEach(() => {
  h.docPaths.length = 0;
  h.emitted.length = 0;
  h.retitled.length = 0;
  h.forgotten.length = 0;
  h.selfLabel = "main";
  appState.docs.clear();
  appState.tabs.clear();
  appState.panels.clear();
  store.setRoot(ROOT);
});

describe("B315 路径改写的纯判据", () => {
  it("同一条、大小写不同、目录里面每一条都要命中；尾巴保留自己的写法", () => {
    expect(paths.rewritePath(P("a.md"), P("a.md"), P("b.md"))).toBe(P("b.md"));
    expect(paths.rewritePath("E:\\笔记\\A.md", P("a.md"), P("b.md"))).toBe(P("b.md"));
    // 目录改名：牵到里面每一条，而那条自己怎么写的（大小写、层级）原样带过去
    expect(paths.rewritePath(P("Notes", "ReadMe.MD"), P("notes"), P("Docs"))).toBe(
      P("Docs", "ReadMe.MD"),
    );
    // 换根（整个文件夹搬到别处）：尾巴连层级一起带过去，不多不少一层
    expect(paths.rewritePath(P("notes", "sub", "x.md"), ROOT, "E:\\笔记2")).toBe(
      "E:\\笔记2\\notes\\sub\\x.md",
    );
  });

  it("不相干的、以及「只是字符串前缀」的不许碰", () => {
    expect(paths.rewritePath(P("abc.md"), P("ab"), P("xy"))).toBeNull();
    expect(paths.rewritePath(P("other", "a.md"), P("notes"), P("docs"))).toBeNull();
    // 正斜杠写法与带尾分隔符的写法都要认（同一件事，不该两种口径）
    expect(paths.rewritePath("E:/笔记/a.md/", `${P("a.md")}\\`, P("b.md"))).toBe(P("b.md"));
  });
});

describe("B315 打开着的文档跟着盘上改", () => {
  it("改名：路径与标签名一起换，后端那条记录也跟着换，名单就地改写", async () => {
    openDoc(7, P("a.md"));
    await store.renameEntryAt(ROOT, P("a.md"), "b.md");
    const doc = appState.docs.get(7);
    expect(doc?.path, "标签还写着旧名字").toBe(P("b.md"));
    expect(doc?.name).toBe("b.md");
    expect(tabLabels()).toEqual([["b.md", P("b.md")]]);
    // ⚠️ 后端那条是自动保存回落的地方：漏了这一发，改名后一按自动保存就把旧文件又写了出来
    expect(h.docPaths).toEqual([[7, P("b.md")]]);
    expect(h.retitled).toEqual([[P("a.md"), P("b.md")]]);
    expect(h.forgotten, "改名不是删除").toEqual([]);
    expect(pathBroadcasts()).toEqual([
      { changes: [{ from: P("a.md"), to: P("b.md") }], from: "main" },
    ]);
  });

  it("目录改名：里面每一条都换，不相干的那一条一字不动", async () => {
    openDoc(1, P("notes", "a.md"));
    openDoc(2, P("notes", "sub", "b.md"));
    openDoc(3, P("elsewhere", "c.md"));
    await store.renameEntryAt(ROOT, P("notes"), "docs");
    expect(appState.docs.get(1)?.path).toBe(P("docs", "a.md"));
    expect(appState.docs.get(1)?.name, "目录改名不改文件名").toBe("a.md");
    expect(appState.docs.get(2)?.path).toBe(P("docs", "sub", "b.md"));
    expect(appState.docs.get(3)?.path, "不相干的文档被牵到了").toBe(P("elsewhere", "c.md"));
    expect(h.docPaths.map(([id]) => id).sort()).toEqual([1, 2]);
    expect(h.retitled).toEqual([[P("notes"), P("docs")]]);
  });

  it("改名不动脏标记：内容一个字节都没变，盘上那份还是同一份", async () => {
    openDoc(7, P("a.md"));
    const before = appState.docs.get(7)!;
    before.baseline = "另一个版本";
    before.dirty = true;
    before.diskMtimeMs = 555;
    before.diskSize = 12;
    await store.renameEntryAt(ROOT, P("a.md"), "b.md");
    const after = appState.docs.get(7)!;
    expect(after.baseline, "基线跟着路径一起被改了 ⇒ 判脏口径脱节").toBe("另一个版本");
    expect(after.dirty).toBe(true);
    expect(after.diskMtimeMs, "同一份内容、同一个磁盘版本").toBe(555);
    expect(after.diskSize).toBe(12);
  });

  it("剪切到别处：新路径落进文档，名单改写而不是新增", async () => {
    openDoc(9, P("a.md"));
    store.setClipboard("cut", [{ path: P("a.md"), dir: ROOT }]);
    await store.pasteInto(P("docs"));
    expect(appState.docs.get(9)?.path).toBe(P("docs", "a.md"));
    expect(h.docPaths).toEqual([[9, P("docs", "a.md")]]);
    expect(h.retitled).toEqual([[P("a.md"), P("docs", "a.md")]]);
  });

  it("复制不动任何文档：源还在原地", async () => {
    openDoc(9, P("a.md"));
    store.setClipboard("copy", [{ path: P("a.md"), dir: ROOT }]);
    await store.pasteInto(P("docs"));
    expect(appState.docs.get(9)?.path).toBe(P("a.md"));
    expect(h.docPaths).toEqual([]);
    expect(h.retitled).toEqual([]);
    expect(pathBroadcasts(), "复制没改任何路径，不该广播").toEqual([]);
  });

  it("送进回收站：退回「未关联路径 + 未保存」，名单那条是删掉而不是改写", async () => {
    openDoc(11, P("a.md"));
    const doc = appState.docs.get(11)!;
    doc.diskMtimeMs = 123;
    doc.diskSize = 9;
    await store.trashAt(ROOT, P("a.md"));
    expect(doc.path, "留着旧路径 ⇒ 自动保存会把刚删的文件写回来").toBeNull();
    expect(doc.dirty, "标签上那颗点当下就要亮").toBe(true);
    expect(doc.baseline, "基线未知才恒判得脏").toBeNull();
    expect(doc.diskMtimeMs, "盘上已经没有版本可记").toBe(0);
    expect(doc.name, "名字还得留着，另存为时才有的填").toBe("a.md");
    expect(tabLabels(), "路径要跟着退成未关联那一态").toEqual([["a.md", undefined]]);
    expect(h.docPaths).toEqual([[11, ""]]);
    expect(h.forgotten).toEqual([P("a.md")]);
    expect(h.retitled, "删除没有「改成什么」可言").toEqual([]);
    expect(pathBroadcasts()[0].changes, "删除那一发要带得出「没有了」而不是空串").toEqual([
      { from: P("a.md"), to: null },
    ]);
  });

  it("目录整体进回收站：里面每一条都变未保存", async () => {
    openDoc(1, P("notes", "a.md"));
    openDoc(2, P("notes", "sub", "b.md"));
    await store.trashAt(ROOT, P("notes"));
    expect(appState.docs.get(1)?.path).toBeNull();
    expect(appState.docs.get(2)?.path).toBeNull();
    expect(appState.docs.get(2)?.dirty).toBe(true);
    expect(h.docPaths.map(([id]) => id).sort()).toEqual([1, 2]);
  });
});

describe("B315 跨窗口那一条监听", () => {
  it("别的窗口发起的：只改自己这份账，不动名单、也不再转发", () => {
    openDoc(5, P("a.md"));
    h.handlers[EVT_DOC_PATH_CHANGED]!({
      from: "sat-1",
      changes: [{ from: P("a.md"), to: P("b.md") }],
    });
    expect(appState.docs.get(5)?.path).toBe(P("b.md"));
    // 后端那条记录还是要本窗口去改：`state.docs` 全进程一份，谁拿着谁改（幂等）
    expect(h.docPaths).toEqual([[5, P("b.md")]]);
    expect(h.retitled, "名单只由发起方记一次").toEqual([]);
    expect(pathBroadcasts(), "回声不许再传一遍").toEqual([]);
  });

  it("自己那一发是回声：直接丢掉，不二次处理", () => {
    openDoc(5, P("b.md"));
    h.handlers[EVT_DOC_PATH_CHANGED]!({
      from: h.selfLabel,
      changes: [{ from: P("a.md"), to: P("b.md") }],
    });
    expect(h.docPaths).toEqual([]);
    expect(h.retitled).toEqual([]);
    expect(pathBroadcasts()).toEqual([]);
  });

  it("载荷形状不对就当没收到（跨语言事件名拼错只表现为「没反应」）", () => {
    openDoc(5, P("a.md"));
    h.handlers[EVT_DOC_PATH_CHANGED]!({ from: "sat-1", changes: [{ from: 123, to: null }] });
    h.handlers[EVT_DOC_PATH_CHANGED]!({ from: "sat-1" });
    expect(appState.docs.get(5)?.path).toBe(P("a.md"));
    expect(h.docPaths).toEqual([]);
  });
});

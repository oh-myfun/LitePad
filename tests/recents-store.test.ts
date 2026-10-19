// @vitest-environment jsdom
// B305 Task 4 · 名单的前端视图缓存 + 「这一扇此刻开着哪些文件」的上报。
//
// 这里测的是**账**，不是界面：开着的集合怎么算、什么时候才发一次 IPC、回包与广播怎么进缓存。
// 名单的记账规则本身在 Rust（`session/recent.rs` 的 #[cfg(test)]），这层不重复一遍 ——
// B308 起连「哪些是新出现的」都归 Rust 算（它手上有每扇窗口的上一份账）。
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as appState from "../src/core/app-state";

const h = vi.hoisted(() => ({
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  listRecents: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
  noteOpenedPaths: vi.fn((_paths: string[]): Promise<unknown[]> => Promise.resolve([])),
  forgetRecent: vi.fn((_path: string): Promise<unknown[]> => Promise.resolve([])),
  clearRecents: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
  getRecentLimit: vi.fn((): Promise<number> => Promise.resolve(20)),
  setRecentLimit: vi.fn((_n: number): Promise<number> => Promise.resolve(20)),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (ev: string, cb: (e: { payload: unknown }) => void) => {
    h.listeners.set(ev, cb);
    return Promise.resolve(() => {});
  },
  emit: () => Promise.resolve(),
}));

vi.mock("../src/ipc/api", () => ({
  listRecents: h.listRecents,
  noteOpenedPaths: h.noteOpenedPaths,
  forgetRecent: h.forgetRecent,
  clearRecents: h.clearRecents,
  getRecentLimit: h.getRecentLimit,
  setRecentLimit: h.setRecentLimit,
  // ⚠️ `core/logger` 的 `log()` 每一条都要调 `logEvent` 落后端日志。这份 mock 是**整表替换**
  //    模块的，少列一个导出，失败分支里那句 `logger.warn(...)` 就会在 `.catch` 里再抛一次
  //    —— vitest 报「1299 全绿 + 1 个未处理拒绝」，就是这么来的（不是产品代码的锅）。
  logEvent: () => Promise.resolve(),
}));

/** store 与各模块的状态都是模块级的，每个用例都得拿一份新的图。 */
async function fresh() {
  vi.resetModules();
  const [store, state] = await Promise.all([
    import("../src/recents/store"),
    import("../src/core/app-state"),
  ]);
  return { store, state };
}

/** 只填 `visibleOpenPaths` 真读的那几个字段（其余与本层无关，不必造假全套）。 */
function doc(id: number, path: string | null) {
  return { tabId: id, path, name: (path ?? "未命名").split(/[\\/]/).pop() ?? "" };
}
function inst(tabId: number, docId: number, panelId: number) {
  return { tabId, docId, panelId };
}

function withTabs(
  state: typeof appState,
  list: ReturnType<typeof inst>[],
  docs: ReturnType<typeof doc>[],
) {
  // 只填本层真读的字段：`EditorState` / `comps` 那些与「哪些路径可见」无关，
  // 造全套假只会让用例读起来像在测 CodeMirror。
  state.setDocs(new Map(docs.map((d) => [d.tabId, d])) as never);
  state.setTabs(new Map(list.map((t) => [t.tabId, t])) as never);
}

beforeEach(() => {
  h.listeners.clear();
  vi.clearAllMocks();
  h.listRecents.mockResolvedValue([]);
  h.noteOpenedPaths.mockResolvedValue([]);
  h.forgetRecent.mockResolvedValue([]);
  h.clearRecents.mockResolvedValue([]);
  h.getRecentLimit.mockResolvedValue(20);
  h.setRecentLimit.mockImplementation((n: number) => Promise.resolve(n));
});

describe("B305/B308 开着的集合上报", () => {
  it("只数可见实例：隐藏实例（panelId < 0）不进集合", async () => {
    const { store, state } = await fresh();
    withTabs(
      state,
      [inst(1, 100, 0), inst(2, 200, -1)],
      [doc(100, "C:\\x\\a.md"), doc(200, "C:\\x\\b.md")],
    );
    expect(store.visibleOpenPaths()).toEqual(["C:\\x\\a.md"]);
  });

  it("未命名（path 为 null 或空串）不进集合", async () => {
    const { store, state } = await fresh();
    withTabs(
      state,
      [inst(1, 100, 0), inst(2, 200, 0), inst(3, 300, 0)],
      [doc(100, null), doc(200, ""), doc(300, "C:\\x\\c.md")],
    );
    expect(store.visibleOpenPaths()).toEqual(["C:\\x\\c.md"]);
  });

  it("同一文档分屏成两份实例 ⇒ 只报一条", async () => {
    const { store, state } = await fresh();
    withTabs(state, [inst(1, 100, 0), inst(2, 100, 1)], [doc(100, "C:\\x\\a.md")]);
    expect(store.visibleOpenPaths()).toEqual(["C:\\x\\a.md"]);
  });

  it("集合没变 ⇒ 一次 IPC 都不发（refreshAll 触发得极频繁）", async () => {
    const { store, state } = await fresh();
    withTabs(state, [inst(1, 100, 0)], [doc(100, "C:\\x\\a.md")]);
    store.reportOpenedPaths();
    store.reportOpenedPaths();
    store.reportOpenedPaths();
    expect(h.noteOpenedPaths, "没变还发就是拿 IPC 刷 Rust").toHaveBeenCalledTimes(1);
    expect(h.noteOpenedPaths.mock.calls[0]).toEqual([["C:\\x\\a.md"]]);
  });

  it("集合变了 ⇒ 重报整份（差集归 Rust，它才有每扇窗口的上一份账）", async () => {
    const { store, state } = await fresh();
    withTabs(
      state,
      [inst(1, 100, 0), inst(2, 200, 0)],
      [doc(100, "C:\\x\\a.md"), doc(200, "C:\\x\\b.md")],
    );
    store.reportOpenedPaths();
    withTabs(state, [inst(1, 100, 0)], [doc(100, "C:\\x\\a.md")]);
    store.reportOpenedPaths();
    expect(h.noteOpenedPaths).toHaveBeenCalledTimes(2);
    expect(h.noteOpenedPaths.mock.calls[1]).toEqual([["C:\\x\\a.md"]]);
  });

  it("IPC 失败 ⇒ 上报基准退回去，下一次刷新会重试", async () => {
    // 不回退的话：一次失败就把「这份已经报过了」写成假历史 ⇒ 那次「新打开」永远不会补报，
    // 用户看到的正是「明明打开过却不在最近打开里」，还查不到原因。
    const { store, state } = await fresh();
    withTabs(state, [inst(1, 100, 0)], [doc(100, "C:\\x\\a.md")]);
    h.noteOpenedPaths.mockRejectedValueOnce(new Error("IPC 断了"));
    store.reportOpenedPaths();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.noteOpenedPaths).toHaveBeenCalledTimes(1);
    store.reportOpenedPaths();
    expect(h.noteOpenedPaths, "失败过就必须再试一次").toHaveBeenCalledTimes(2);
  });

  it("回包写进缓存并通知订阅者", async () => {
    const { store } = await fresh();
    const seen: number[] = [];
    store.onRecentsChange((entries) => seen.push(entries.length));
    h.noteOpenedPaths.mockResolvedValue([
      { path: "C:\\x\\a.md", name: "a.md", openedAt: 1 },
      { path: "C:\\x\\b.md", name: "b.md", openedAt: 2 },
    ]);
    store.reportOpenedPaths();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getRecents()).toHaveLength(2);
    expect(seen).toEqual([2]);
  });

  it("连续两次变化 ⇒ 迟到的旧回包不许盖掉新状态", async () => {
    // 场景：一次连点里连发两报（只有 A 开着 → A、B 都开着）。Rust 那边由 Mutex 串行，
    // 真值最后是「两条都打开过 ⇒ 名单里两条，B 在前」；但**两个 IPC 回包的到达顺序没有保证**，
    // 旧那一包后到就把名单写回只剩 A 的旧样子 —— 用户看到的是「刚打开的那份没露脸」。
    const { store, state } = await fresh();
    withTabs(state, [inst(1, 100, 0)], [doc(100, "C:\\x\\a.md")]);
    const deferred: Array<(v: unknown[]) => void> = [];
    h.noteOpenedPaths.mockImplementation(
      () =>
        new Promise((res) => {
          deferred.push(res as (v: unknown[]) => void);
        }),
    );
    store.reportOpenedPaths();
    withTabs(
      state,
      [inst(1, 100, 0), inst(2, 200, 0)],
      [doc(100, "C:\\x\\a.md"), doc(200, "C:\\x\\b.md")],
    );
    store.reportOpenedPaths();
    expect(deferred, "两报都该发出去").toHaveLength(2);
    deferred[1]([{ path: "b.md", name: "b.md", openedAt: 2 }]);
    deferred[0]([{ path: "a.md", name: "a.md", openedAt: 1 }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      store.getRecents().map((e) => e.path),
      "过期回包必须被丢掉",
    ).toEqual(["b.md"]);
  });

  it("recents-changed 广播换掉缓存并通知订阅者（别的窗口打开的文件要立刻露脸）", async () => {
    const { store } = await fresh();
    await store.initRecentsStore();
    const cb = h.listeners.get("recents-changed");
    expect(cb, "没装上广播监听 ⇒ 子窗口打开的文件永远不会出现在主窗口").toBeTypeOf("function");
    const seen: number[] = [];
    store.onRecentsChange((entries) => seen.push(entries.length));
    cb!({ payload: { entries: [{ path: "z.md", name: "z.md", openedAt: 9 }] } });
    expect(store.getRecents()).toHaveLength(1);
    expect(store.getRecents()[0].path).toBe("z.md");
    expect(seen).toEqual([1]);
  });

  it("反注册之后不再收到通知", async () => {
    const { store } = await fresh();
    await store.initRecentsStore();
    const seen: number[] = [];
    const off = store.onRecentsChange((entries) => seen.push(entries.length));
    off();
    h.listeners.get("recents-changed")!({
      payload: { entries: [{ path: "z.md", name: "z.md", openedAt: 9 }] },
    });
    expect(seen).toEqual([]);
  });

  it("initRecentsStore 拉首帧：名单与上限都从 Rust 取，不用前端默认值顶包", async () => {
    const { store } = await fresh();
    h.listRecents.mockResolvedValue([{ path: "a.md", name: "a.md", openedAt: 1 }]);
    h.getRecentLimit.mockResolvedValue(50);
    await store.initRecentsStore();
    expect(store.getRecents()).toHaveLength(1);
    expect(store.getRecentLimit(), "上限的权威是 Rust").toBe(50);
  });

  it("上限取到之后必须再通知一次 ⇒ 首帧的计数与入口显隐用的是真上限", async () => {
    const { store } = await fresh();
    h.listRecents.mockResolvedValue([{ path: "a.md", name: "a.md", openedAt: 1 }]);
    h.getRecentLimit.mockResolvedValue(0);
    const caps: number[] = [];
    store.onRecentsChange(() => caps.push(store.getRecentLimit()));
    await store.initRecentsStore();
    // 名单先到那一次通知里，上限还是模块里那个占位值。上限到手后必须再通知一次，
    // 否则首帧画成「1/20」而真上限是 0 ⇒ 计数、空态文案、那颗键的显隐全用错口径。
    expect(caps[caps.length - 1], "最后一次通知没带上 Rust 的上限").toBe(0);
  });

  it("单条清除与清空都按回包更新缓存", async () => {
    const { store } = await fresh();
    h.noteOpenedPaths.mockResolvedValue([{ path: "a.md", name: "a.md", openedAt: 1 }]);
    store.reportOpenedPaths();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getRecents()).toHaveLength(1);

    h.forgetRecent.mockResolvedValue([]);
    await store.forgetRecentEntry("a.md");
    expect(h.forgetRecent).toHaveBeenCalledWith("a.md");
    expect(store.getRecents()).toHaveLength(0);

    h.clearRecents.mockResolvedValue([{ path: "b.md", name: "b.md", openedAt: 2 }]);
    await store.clearRecentEntries();
    expect(store.getRecents()).toHaveLength(1);
  });

  it("applyRecentLimit 认回包（别的窗口可能刚把上限写过）", async () => {
    const { store } = await fresh();
    h.setRecentLimit.mockResolvedValue(10);
    await store.applyRecentLimit(999);
    expect(h.setRecentLimit).toHaveBeenCalledWith(999);
    expect(store.getRecentLimit()).toBe(10);
  });

  it("改上限也通知订阅者（面板那格「6/20」带的是上限，不是条数）", async () => {
    const { store } = await fresh();
    h.noteOpenedPaths.mockResolvedValue([{ path: "a.md", name: "a.md", openedAt: 1 }]);
    store.reportOpenedPaths();
    await Promise.resolve();
    await Promise.resolve();
    const seen: string[] = [];
    store.onRecentsChange((list) => seen.push(`${list.length}/${store.getRecentLimit()}`));
    h.setRecentLimit.mockResolvedValue(2);
    await store.applyRecentLimit(2);
    expect(seen, "只等条目变化的话，计数会停在旧上限那一段 ⇒ 用户读作「改了没反应」").toEqual([
      "1/2",
    ]);
  });
});

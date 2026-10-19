// @vitest-environment jsdom
// B305/B308 · 名单的前端视图缓存 + 「刚打开了哪份文件」的记入。
//
// 这里测的是**账**，不是界面：一次打开怎么报、回包与广播怎么进缓存、什么时候通知订阅者。
// 名单的记账规则本身在 Rust（`session/recent.rs` 的 #[cfg(test)]），这层不重复一遍 ——
// B308 收尾后连「哪些是新出现的」都不用自己算：记入源是**打开这个动作**（一次一发），
// 「恢复不算打开」是这条链的结构性质，由 tests/recents-contract.test.ts 钉住调用点。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  listRecents: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
  noteOpenedPath: vi.fn((_path: string): Promise<unknown[]> => Promise.resolve([])),
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
  noteOpenedPath: h.noteOpenedPath,
  forgetRecent: h.forgetRecent,
  clearRecents: h.clearRecents,
  getRecentLimit: h.getRecentLimit,
  setRecentLimit: h.setRecentLimit,
  // ⚠️ `core/logger` 的 `log()` 每一条都要调 `logEvent` 落后端日志。这份 mock 是**整表替换**
  //    模块的，少列一个导出，失败分支里那句 `logger.warn(...)` 就会在 `.catch` 里再抛一次
  //    —— vitest 报「全绿 + 1 个未处理拒绝」，就是这么来的（不是产品代码的锅）。
  logEvent: () => Promise.resolve(),
}));

/** store 的状态是模块级的，每个用例都得拿一份新的。 */
async function fresh() {
  vi.resetModules();
  const store = await import("../src/recents/store");
  return store;
}

/** 把 `noteOpened` 里那两跳微任务排空（回包 → applyIfFresh → 通知）。 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  h.listeners.clear();
  vi.clearAllMocks();
  h.listRecents.mockResolvedValue([]);
  h.noteOpenedPath.mockResolvedValue([]);
  h.forgetRecent.mockResolvedValue([]);
  h.clearRecents.mockResolvedValue([]);
  h.getRecentLimit.mockResolvedValue(20);
  h.setRecentLimit.mockImplementation((n: number) => Promise.resolve(n));
});

describe("B308 记入：一次打开报一发", () => {
  it("路径原样交出去（显示与身份键都由 Rust 定）", async () => {
    const store = await fresh();
    store.noteOpened("C:\\x\\a.md");
    expect(h.noteOpenedPath).toHaveBeenCalledTimes(1);
    expect(h.noteOpenedPath.mock.calls[0]).toEqual(["C:\\x\\a.md"]);
  });

  it("同一份文件再打开一次也要再报（LRU 要顶到最前，这里没有「报过就不报」那种闸）", async () => {
    // 旧版按「可见集合变了没」发 IPC，同一集合重复刷新直接早退；记入源换成打开动作之后
    // 早退就错了 —— 用户第二次打开同一条**是**一次打开。
    const store = await fresh();
    store.noteOpened("C:\\x\\a.md");
    store.noteOpened("C:\\x\\a.md");
    expect(h.noteOpenedPath).toHaveBeenCalledTimes(2);
  });

  it("回包写进缓存并通知订阅者", async () => {
    const store = await fresh();
    const seen: number[] = [];
    store.onRecentsChange((entries) => seen.push(entries.length));
    h.noteOpenedPath.mockResolvedValue([
      { path: "C:\\x\\a.md", name: "a.md", openedAt: 2 },
      { path: "C:\\x\\b.md", name: "b.md", openedAt: 1 },
    ]);
    store.noteOpened("C:\\x\\a.md");
    await flush();
    expect(store.getRecents().map((e) => e.path)).toEqual(["C:\\x\\a.md", "C:\\x\\b.md"]);
    expect(seen).toEqual([2]);
  });

  it("连点两行 ⇒ 迟到的旧回包不许盖掉新状态", async () => {
    // 场景：一次连点里连发两报。Rust 那边由 Mutex 串行，真值最后是「两条都打开过，
    // 后点的那条在最前」；但**两个 IPC 回包的到达顺序没有保证**，旧那一包后到就把名单
    // 写回旧样子 —— 用户看到的是「刚打开的那份没露脸」。
    const store = await fresh();
    const deferred: Array<(v: unknown[]) => void> = [];
    h.noteOpenedPath.mockImplementation(
      () =>
        new Promise((res) => {
          deferred.push(res as (v: unknown[]) => void);
        }),
    );
    store.noteOpened("a.md");
    store.noteOpened("b.md");
    expect(deferred, "两报都该发出去").toHaveLength(2);
    deferred[1]([{ path: "b.md", name: "b.md", openedAt: 2 }]);
    deferred[0]([{ path: "a.md", name: "a.md", openedAt: 1 }]);
    await flush();
    expect(
      store.getRecents().map((e) => e.path),
      "过期回包必须被丢掉",
    ).toEqual(["b.md"]);
  });

  it("IPC 失败 ⇒ 只留一行日志，名单不动（打开动作错过就错过了，不许假装记上了）", async () => {
    const store = await fresh();
    store.onRecentsChange(() => {
      throw new Error("不该有通知");
    });
    h.noteOpenedPath.mockRejectedValueOnce(new Error("IPC 断了"));
    store.noteOpened("C:\\x\\a.md");
    await flush();
    expect(store.getRecents()).toHaveLength(0);
  });

  it("IPC 同步炸（连 invoke 都没发出去）也不许把打开流程带崩", async () => {
    // ⚠️ `noteOpened` 挂在 `doOpen` 的主干上，而名单是旁路功能：这一发抛出去就是
    // 「用户双击 .md 结果文件打不开」。B305 那版栽过同款（测试里那份整表 mock 缺一个导出，
    // 同步抛错直接顶穿调用方）。
    const store = await fresh();
    h.noteOpenedPath.mockImplementationOnce(() => {
      throw new Error("宿主出口没了");
    });
    expect(() => store.noteOpened("C:\\x\\a.md")).not.toThrow();
  });
});

describe("B305 视图缓存", () => {
  it("recents-changed 广播换掉缓存并通知订阅者（别的窗口打开的文件要立刻露脸）", async () => {
    const store = await fresh();
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
    const store = await fresh();
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
    const store = await fresh();
    h.listRecents.mockResolvedValue([{ path: "a.md", name: "a.md", openedAt: 1 }]);
    h.getRecentLimit.mockResolvedValue(50);
    await store.initRecentsStore();
    expect(store.getRecents()).toHaveLength(1);
    expect(store.getRecentLimit(), "上限的权威是 Rust").toBe(50);
  });

  it("上限取到之后必须再通知一次 ⇒ 首帧的计数与入口显隐用的是真上限", async () => {
    const store = await fresh();
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
    const store = await fresh();
    h.noteOpenedPath.mockResolvedValue([{ path: "a.md", name: "a.md", openedAt: 1 }]);
    store.noteOpened("a.md");
    await flush();
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
    const store = await fresh();
    h.setRecentLimit.mockResolvedValue(10);
    await store.applyRecentLimit(999);
    expect(h.setRecentLimit).toHaveBeenCalledWith(999);
    expect(store.getRecentLimit()).toBe(10);
  });

  it("改上限也通知订阅者（面板那格「6/20」带的是上限，不是条数）", async () => {
    const store = await fresh();
    h.noteOpenedPath.mockResolvedValue([{ path: "a.md", name: "a.md", openedAt: 1 }]);
    store.noteOpened("a.md");
    await flush();
    const seen: string[] = [];
    store.onRecentsChange((list) => seen.push(`${list.length}/${store.getRecentLimit()}`));
    h.setRecentLimit.mockResolvedValue(2);
    await store.applyRecentLimit(2);
    expect(seen, "只等条目变化的话，计数会停在旧上限那一段 ⇒ 用户读作「改了没反应」").toEqual([
      "1/2",
    ]);
  });
});

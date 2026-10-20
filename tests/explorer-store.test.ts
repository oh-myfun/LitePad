// @vitest-environment node
// B314 · 资源管理器的缓存层（`src/explorer/store.ts`）。
//
// 纯逻辑 + 假 IPC：这一层不碰 DOM，所以不需要 jsdom 骨架（口径同 tests/recents-store.test.ts）。
// `listDir` 换成可控的假实现，测试才能指定「哪一层报错」「哪一回后到」。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  /** 每层该回什么；没登记的键一律按「读不了」报错。 */
  dirs: new Map<string, { name: string; isDir: boolean }[]>(),
  /** 每次调用记一笔，用来数「懒加载到底读了几层」。 */
  calls: [] as string[],
  /** 登记过的路径**先不答**，resolve 存这里 —— 由用例决定那一发什么时候落地。 */
  gated: new Set<string>(),
  pending: new Map<string, (listing: unknown) => void>(),
}));

function toListing(path: string, kids: { name: string; isDir: boolean }[]) {
  return {
    entries: kids.map((k) => ({
      name: k.name,
      path: `${path}\\${k.name}`,
      isDir: k.isDir,
      size: 1,
      mtimeMs: 0,
    })),
    truncated: false,
  };
}

vi.mock("../src/ipc/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/ipc/api")>();
  return {
    ...real,
    listDir: (path: string) => {
      h.calls.push(path);
      const kids = h.dirs.get(path);
      if (!kids) return Promise.reject(new Error(`读不了：${path}`));
      if (h.gated.has(path)) {
        return new Promise((resolve) => {
          h.pending.set(path, resolve);
        });
      }
      return Promise.resolve(toListing(path, kids));
    },
  };
});

let store: typeof import("../src/explorer/store");

async function load(): Promise<typeof import("../src/explorer/store")> {
  vi.resetModules();
  h.calls.length = 0;
  h.dirs.clear();
  h.gated.clear();
  h.pending.clear();
  return await import("../src/explorer/store");
}

beforeEach(async () => {
  store = await load();
});

describe("B314 资源管理器缓存层", () => {
  it("换根立刻读根那一层，且只有根（没展开的目录一次都不读）", async () => {
    h.dirs.set("E:\\笔记", [
      { name: "a.md", isDir: false },
      { name: "子目录", isDir: true },
    ]);
    store.setRoot("E:\\笔记");
    await vi.waitFor(() => expect(store.childrenOf("E:\\笔记")).toBeTruthy());
    expect(h.calls, "只该读了根这一层").toEqual(["E:\\笔记"]);
    expect(store.childrenOf("E:\\笔记")?.map((e) => e.name)).toEqual(["a.md", "子目录"]);
    expect(store.childrenOf("E:\\笔记\\子目录"), "没展开过就不该读").toBeUndefined();
  });

  it("展开时才读那一层；折叠不删缓存", async () => {
    h.dirs.set("E:\\根", [{ name: "d", isDir: true }]);
    h.dirs.set("E:\\根\\d", [{ name: "x.md", isDir: false }]);
    store.setRoot("E:\\根");
    await vi.waitFor(() => expect(store.childrenOf("E:\\根")).toBeTruthy());

    await store.toggleDir("E:\\根\\d");
    expect(store.isExpanded("E:\\根\\d")).toBe(true);
    expect(store.childrenOf("E:\\根\\d")?.map((e) => e.name)).toEqual(["x.md"]);

    await store.toggleDir("E:\\根\\d");
    expect(store.isExpanded("E:\\根\\d")).toBe(false);
    expect(store.childrenOf("E:\\根\\d"), "折叠把读过的那层丢掉 = 再展开先空一帧").toBeTruthy();
  });

  it("同一层被并发点开两次只发一次 IPC（双击快不该读两遍）", async () => {
    h.dirs.set("E:\\根", [{ name: "d", isDir: true }]);
    h.dirs.set("E:\\根\\d", [{ name: "x.md", isDir: false }]);
    store.setRoot("E:\\根");
    await vi.waitFor(() => expect(store.childrenOf("E:\\根")).toBeTruthy());
    await Promise.all([store.toggleDir("E:\\根\\d"), store.toggleDir("E:\\根\\d")]);
    expect(h.calls.filter((c) => c === "E:\\根\\d")).toHaveLength(1);
  });

  it("换根之后旧那一发才落地也不许画：代际一判就丢", async () => {
    h.dirs.set("E:\\旧", [{ name: "旧文件.md", isDir: false }]);
    h.dirs.set("E:\\新", [{ name: "新文件.md", isDir: false }]);
    h.gated.add("E:\\旧");
    store.setRoot("E:\\旧"); // 这一发被扣住在飞
    expect(store.isLoading("E:\\旧")).toBe(true);

    store.setRoot("E:\\新");
    await vi.waitFor(() => expect(store.childrenOf("E:\\新")).toBeTruthy());

    // 现在才让**旧那一发**回来：测的是「后到」，不是「压根没发」
    const late = h.pending.get("E:\\旧");
    expect(late, "假实现没把在飞那一发留住").toBeTruthy();
    late!(toListing("E:\\旧", h.dirs.get("E:\\旧")!));
    await vi.waitFor(() => expect(store.isLoading("E:\\旧")).toBe(false));

    expect(store.getRoot()).toBe("E:\\新");
    expect(
      store.childrenOf("E:\\旧"),
      "旧根的回包一落地就会被画进新树（用户读作「换了文件夹却没换」）",
    ).toBeUndefined();
    expect(store.errorOf("E:\\旧"), "作废那一发也不该顺手记一条错误").toBeUndefined();
  });

  it("一层读失败只脏那一条：别层照旧、错误能读出来", async () => {
    h.dirs.set("E:\\根", [
      { name: "能读", isDir: true },
      { name: "挡住的", isDir: true },
    ]);
    h.dirs.set("E:\\根\\能读", [{ name: "ok.md", isDir: false }]);
    store.setRoot("E:\\根");
    await vi.waitFor(() => expect(store.childrenOf("E:\\根")).toBeTruthy());

    await store.toggleDir("E:\\根\\挡住的");
    expect(store.errorOf("E:\\根\\挡住的"), "空目录与读不了是两件事").toContain("读不了");
    expect(store.childrenOf("E:\\根\\挡住的")).toBeUndefined();
    expect(store.childrenOf("E:\\根"), "根那一层不该被邻居的失败带崩").toBeTruthy();

    await store.toggleDir("E:\\根\\能读");
    expect(store.childrenOf("E:\\根\\能读")?.map((e) => e.name)).toEqual(["ok.md"]);
  });

  it("读失败过的层再展开能恢复（错误不是永久的）", async () => {
    h.dirs.set("E:\\根", [{ name: "d", isDir: true }]);
    store.setRoot("E:\\根");
    await vi.waitFor(() => expect(store.childrenOf("E:\\根")).toBeTruthy());

    await store.toggleDir("E:\\根\\d");
    expect(store.errorOf("E:\\根\\d")).toBeTruthy();

    h.dirs.set("E:\\根\\d", [{ name: "x.md", isDir: false }]);
    await store.refreshDir("E:\\根\\d");
    expect(store.errorOf("E:\\根\\d"), "读通了就该把错误擦掉").toBeUndefined();
    expect(store.childrenOf("E:\\根\\d")?.map((e) => e.name)).toEqual(["x.md"]);
  });

  it("刷新重读根与每个展开层，展开态保留", async () => {
    h.dirs.set("E:\\根", [{ name: "d", isDir: true }]);
    h.dirs.set("E:\\根\\d", [{ name: "x.md", isDir: false }]);
    store.setRoot("E:\\根");
    await vi.waitFor(() => expect(store.childrenOf("E:\\根")).toBeTruthy());
    await store.toggleDir("E:\\根\\d");
    h.calls.length = 0;

    await store.refresh();
    expect([...h.calls].sort()).toEqual(["E:\\根", "E:\\根\\d"].sort());
    expect(store.isExpanded("E:\\根\\d"), "刷新不许把用户的展开态抹了").toBe(true);
  });

  it("新建之后只重读那一个目录，不刷整棵树", async () => {
    h.dirs.set("E:\\根", [{ name: "d", isDir: true }]);
    h.dirs.set("E:\\根\\d", [{ name: "x.md", isDir: false }]);
    store.setRoot("E:\\根");
    await vi.waitFor(() => expect(store.childrenOf("E:\\根")).toBeTruthy());
    await store.toggleDir("E:\\根\\d");
    h.calls.length = 0;

    await store.refreshDir("E:\\根\\d");
    expect(h.calls).toEqual(["E:\\根\\d"]);
  });

  it("全部折叠清展开态但留住缓存；没根时 hasRoot 为假", async () => {
    expect(store.hasRoot(), "没打开过文件夹 = 没有根").toBe(false);
    h.dirs.set("E:\\根", [{ name: "d", isDir: true }]);
    h.dirs.set("E:\\根\\d", [{ name: "x.md", isDir: false }]);
    store.setRoot("E:\\根");
    await vi.waitFor(() => expect(store.childrenOf("E:\\根")).toBeTruthy());
    await store.toggleDir("E:\\根\\d");

    store.collapseAll();
    expect(store.expandedPaths()).toEqual([]);
    expect(store.childrenOf("E:\\根\\d"), "折叠不是缓存失效").toBeTruthy();
    expect(store.hasRoot()).toBe(true);
  });

  it("空串是「没有文件夹」那一态：清干净就行，不许发一次注定失败的读盘", async () => {
    h.dirs.set("E:\\根", [{ name: "a.md", isDir: false }]);
    store.setRoot("E:\\根");
    await vi.waitFor(() => expect(store.childrenOf("E:\\根")).toBeTruthy());

    store.setRoot("");
    expect(store.hasRoot()).toBe(false);
    expect(store.getRoot()).toBe("");
    expect(store.childrenOf("E:\\根"), "换到「没有」要清空缓存").toBeUndefined();
    await Promise.resolve();
    expect(
      h.calls.filter((c) => c === ""),
      "空路径不该发 IPC",
    ).toHaveLength(0);
    expect(store.errorOf(""), "也不该给空路径记一条错误").toBeUndefined();
  });

  it("读到内容会通知订阅者（面板只认通知，不自取）", async () => {
    const seen: number[] = [];
    store.onExplorerChange(() => seen.push(store.childrenOf("E:\\根")?.length ?? -1));
    h.dirs.set("E:\\根", [{ name: "a.md", isDir: false }]);
    store.setRoot("E:\\根");
    await vi.waitFor(() => expect(seen).toContain(1));
  });
});

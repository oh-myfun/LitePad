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
  /** B315：写操作各记一笔（`改名 E:\a.md -> b.md` 这种形状，用例按前缀判）。 */
  ops: [] as string[],
  /** 让某个写操作报错，键 = rename / copy / move / delete。 */
  failOn: new Set<string>(),
}));

const base = (p: string): string => p.slice(p.lastIndexOf("\\") + 1);
const parentOf = (p: string): string => p.slice(0, p.lastIndexOf("\\"));
const mk = (dir: string, name: string, isDir: boolean) => ({
  name,
  path: `${dir}\\${name}`,
  isDir,
  size: 1,
  mtimeMs: 0,
});

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
    renameEntry: (_root: string, path: string, newName: string) => {
      h.ops.push(`rename ${path} -> ${newName}`);
      if (h.failOn.has("rename")) return Promise.reject(new Error("这一层里已经有 它了"));
      return Promise.resolve(mk(parentOf(path), newName, h.dirs.has(path)));
    },
    copyEntry: (_root: string, src: string, destDir: string) => {
      h.ops.push(`copy ${src} -> ${destDir}`);
      if (h.failOn.has("copy")) return Promise.reject(new Error("复制不了"));
      return Promise.resolve(mk(destDir, base(src), h.dirs.has(src)));
    },
    moveEntry: (_root: string, src: string, destDir: string) => {
      h.ops.push(`move ${src} -> ${destDir}`);
      if (h.failOn.has("move")) return Promise.reject(new Error("挪不动"));
      return Promise.resolve(mk(destDir, base(src), h.dirs.has(src)));
    },
    deleteEntry: (_root: string, path: string) => {
      h.ops.push(`delete ${path}`);
      return h.failOn.has("delete") ? Promise.reject(new Error("送不进回收站")) : Promise.resolve();
    },
    revealInExplorer: (path: string) => {
      h.ops.push(`reveal ${path}`);
      return Promise.resolve();
    },
  };
});

let store: typeof import("../src/explorer/store");

async function load(): Promise<typeof import("../src/explorer/store")> {
  vi.resetModules();
  h.calls.length = 0;
  h.ops.length = 0;
  h.failOn.clear();
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

describe("B315 缓存层的动作与剪贴板", () => {
  const R = "E:\\笔记";
  /** 拼路径只用这一个帮手：反斜杠在源码里长什么样，测一次就够，不必每条都写两遍。 */
  const P = (...segs: string[]): string => segs.join("\\");

  type Change = { from: string; to: string | null };

  /** 起一个根、等它读出来，顺手挂上「路径改写」的探针。 */
  async function boot(kids: { name: string; isDir: boolean }[]): Promise<Change[]> {
    h.dirs.set(R, kids);
    store.setRoot(R);
    await vi.waitFor(() => expect(store.childrenOf(R)).toBeTruthy());
    const seen: Change[] = [];
    store.onPathsChanged((c) => seen.push(...c));
    return seen;
  }

  it("改名：广播 from→to，并只重读它所在那一层", async () => {
    const seen = await boot([{ name: "a.md", isDir: false }]);
    h.calls.length = 0;
    const made = await store.renameEntryAt(R, P(R, "a.md"), "b.md");
    expect(h.ops).toEqual([`rename ${P(R, "a.md")} -> b.md`]);
    expect(made.path).toBe(P(R, "b.md"));
    expect(seen).toEqual([{ from: P(R, "a.md"), to: P(R, "b.md") }]);
    expect(h.calls, "一次改名只动了一层，不该刷整棵树").toEqual([R]);
  });

  it("改名失败时什么都不动（不广播、不重读、错误原样透传）", async () => {
    const seen = await boot([{ name: "a.md", isDir: false }]);
    h.calls.length = 0;
    h.failOn.add("rename");
    await expect(store.renameEntryAt(R, P(R, "a.md"), "撞了.md")).rejects.toThrow("已经有");
    expect(seen, "没改成就不该广播「路径变了」").toEqual([]);
    expect(h.calls, "没改成就不该重读那一层").toEqual([]);
  });

  it("删除：广播 to=null，被删那条的展开态与那一层缓存一起掉", async () => {
    const d = P(R, "d");
    h.dirs.set(R, [{ name: "d", isDir: true }]);
    h.dirs.set(d, [{ name: "x.md", isDir: false }]);
    store.setRoot(R);
    await vi.waitFor(() => expect(store.childrenOf(R)).toBeTruthy());
    await store.toggleDir(d);
    expect(store.isExpanded(d)).toBe(true);
    const seen: Change[] = [];
    store.onPathsChanged((c) => seen.push(...c));

    await store.trashAt(R, d);
    expect(h.ops).toContain(`delete ${d}`);
    expect(seen).toEqual([{ from: d, to: null }]);
    expect(store.isExpanded(d), "删掉的目录不许还记着展开").toBe(false);
    expect(store.childrenOf(d), "也不许还留着它的子项").toBeUndefined();
  });

  it("删除失败：不广播（那份文档还该是干净的）", async () => {
    const seen = await boot([{ name: "a.md", isDir: false }]);
    h.failOn.add("delete");
    await expect(store.trashAt(R, P(R, "a.md"))).rejects.toThrow("回收站");
    expect(seen).toEqual([]);
  });

  it("复制粘贴：走 copy、剪贴板留着、一条路径都不广播", async () => {
    const sub = P(R, "子");
    const seen = await boot([
      { name: "a.md", isDir: false },
      { name: "子", isDir: true },
    ]);
    h.dirs.set(sub, []);
    store.setClipboard("copy", [{ path: P(R, "a.md"), dir: R }]);
    const made = await store.pasteInto(sub);
    expect(h.ops).toContain(`copy ${P(R, "a.md")} -> ${sub}`);
    expect(made[0].path).toBe(P(sub, "a.md"));
    expect(seen, "复制不动任何已打开的文档").toEqual([]);
    expect(store.getClipboard(), "复制那份要留着，好连着往几层粘").not.toBeNull();
  });

  it("剪切粘贴：走 move、每条成功就广播一次，全成了才清空剪贴板", async () => {
    const sub = P(R, "子");
    const seen = await boot([
      { name: "a.md", isDir: false },
      { name: "子", isDir: true },
    ]);
    h.dirs.set(sub, []);
    store.setClipboard("cut", [{ path: P(R, "a.md"), dir: R }]);
    await store.pasteInto(sub);
    expect(h.ops).toContain(`move ${P(R, "a.md")} -> ${sub}`);
    expect(seen).toEqual([{ from: P(R, "a.md"), to: P(sub, "a.md") }]);
    expect(store.getClipboard()).toBeNull();
  });

  it("粘贴半途失败：动过的两层照样刷过，剪贴板不清（用户能重来）", async () => {
    const sub = P(R, "子");
    const seen = await boot([
      { name: "a.md", isDir: false },
      { name: "子", isDir: true },
    ]);
    h.dirs.set(sub, []);
    store.setClipboard("cut", [{ path: P(R, "a.md"), dir: R }]);
    h.calls.length = 0;
    h.failOn.add("move");
    await expect(store.pasteInto(sub)).rejects.toThrow("挪不动");
    expect(store.getClipboard(), "没搬成的那份要还在剪贴板里").not.toBeNull();
    expect(seen, "一条都没落地，就不该广播路径改写").toEqual([]);
    expect(h.calls, "失败了也要把源层与目标层都刷一遍，别留半真半假的树").toEqual(
      expect.arrayContaining([R, sub]),
    );
  });

  it("空的一组 = 收起剪贴板（别留一条「0 项」的空剪贴板让粘贴是灰的还报成功）", () => {
    store.setClipboard("copy", [{ path: P(R, "a.md"), dir: R }]);
    expect(store.getClipboard()).not.toBeNull();
    store.setClipboard("copy", []);
    expect(store.getClipboard()).toBeNull();
    store.setClipboard("cut", [{ path: P(R, "a.md"), dir: R }]);
    store.clearClipboard();
    expect(store.getClipboard()).toBeNull();
  });
});

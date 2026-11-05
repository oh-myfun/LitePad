// @vitest-environment node
// B314 / B315 / B424 · 资源管理器的缓存层（`src/explorer/store.ts`）。
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
  /** B424：写操作收到的**锚点**（IPC 的 `root` 参数）—— 多根下「该由哪一根管」的判据。 */
  anchors: [] as string[],
  /** B427：复制 / 移动收到的**目标层锚点**（IPC 的 `destRoot`）—— 跨根粘贴时它 ≠ `anchors`。 */
  destAnchors: [] as string[],
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
    renameEntry: (root: string, path: string, newName: string) => {
      h.anchors.push(root);
      h.ops.push(`rename ${path} -> ${newName}`);
      if (h.failOn.has("rename")) return Promise.reject(new Error("这一层里已经有 它了"));
      return Promise.resolve(mk(parentOf(path), newName, h.dirs.has(path)));
    },
    copyEntry: (root: string, src: string, destDir: string, destRoot: string) => {
      h.anchors.push(root);
      h.destAnchors.push(destRoot);
      h.ops.push(`copy ${src} -> ${destDir}`);
      if (h.failOn.has("copy")) return Promise.reject(new Error("复制不了"));
      return Promise.resolve(mk(destDir, base(src), h.dirs.has(src)));
    },
    moveEntry: (root: string, src: string, destDir: string, destRoot: string) => {
      h.anchors.push(root);
      h.destAnchors.push(destRoot);
      h.ops.push(`move ${src} -> ${destDir}`);
      if (h.failOn.has("move")) return Promise.reject(new Error("挪不动"));
      return Promise.resolve(mk(destDir, base(src), h.dirs.has(src)));
    },
    deleteEntry: (root: string, path: string) => {
      h.anchors.push(root);
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
  h.anchors.length = 0;
  h.destAnchors.length = 0;
  h.failOn.clear();
  h.dirs.clear();
  h.gated.clear();
  h.pending.clear();
  return await import("../src/explorer/store");
}

beforeEach(async () => {
  store = await load();
});

/** 单根形状的夹具：这一批用例的主语都是「只开一根」（多根的_cases 在最后一个 describe 里）。 */
const openOne = (path: string): void => store.setRoots([path]);
const theOne = (): string => store.getRoots()[0] ?? "";

describe("B314 资源管理器缓存层", () => {
  it("换根立刻读根那一层，且只有根（没展开的目录一次都不读）", async () => {
    h.dirs.set("E:\\笔记", [
      { name: "a.md", isDir: false },
      { name: "子目录", isDir: true },
    ]);
    openOne("E:\\笔记");
    await vi.waitFor(() => expect(store.childrenOf("E:\\笔记")).toBeTruthy());
    expect(h.calls, "只该读了根这一层").toEqual(["E:\\笔记"]);
    expect(store.childrenOf("E:\\笔记")?.map((e) => e.name)).toEqual(["a.md", "子目录"]);
    expect(store.childrenOf("E:\\笔记\\子目录"), "没展开过就不该读").toBeUndefined();
  });

  it("展开时才读那一层；折叠不删缓存", async () => {
    h.dirs.set("E:\\根", [{ name: "d", isDir: true }]);
    h.dirs.set("E:\\根\\d", [{ name: "x.md", isDir: false }]);
    openOne("E:\\根");
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
    openOne("E:\\根");
    await vi.waitFor(() => expect(store.childrenOf("E:\\根")).toBeTruthy());
    await Promise.all([store.toggleDir("E:\\根\\d"), store.toggleDir("E:\\根\\d")]);
    expect(h.calls.filter((c) => c === "E:\\根\\d")).toHaveLength(1);
  });

  it("换根之后旧那一发才落地也不许画：不再归任何一根就丢", async () => {
    h.dirs.set("E:\\旧", [{ name: "旧文件.md", isDir: false }]);
    h.dirs.set("E:\\新", [{ name: "新文件.md", isDir: false }]);
    h.gated.add("E:\\旧");
    openOne("E:\\旧"); // 这一发被扣住在飞
    expect(store.isLoading("E:\\旧")).toBe(true);

    openOne("E:\\新");
    await vi.waitFor(() => expect(store.childrenOf("E:\\新")).toBeTruthy());

    // 现在才让**旧那一发**回来：测的是「后到」，不是「压根没发」
    const late = h.pending.get("E:\\旧");
    expect(late, "假实现没把在飞那一发留住").toBeTruthy();
    late!(toListing("E:\\旧", h.dirs.get("E:\\旧")!));
    await vi.waitFor(() => expect(store.isLoading("E:\\旧")).toBe(false));

    expect(theOne()).toBe("E:\\新");
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
    openOne("E:\\根");
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
    openOne("E:\\根");
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
    openOne("E:\\根");
    await vi.waitFor(() => expect(store.childrenOf("E:\\根")).toBeTruthy());
    await store.toggleDir("E:\\根\\d");
    h.calls.length = 0;

    await store.refreshRoot("E:\\根");
    expect([...h.calls].sort()).toEqual(["E:\\根", "E:\\根\\d"].sort());
    expect(store.isExpanded("E:\\根\\d"), "刷新不许把用户的展开态抹了").toBe(true);
  });

  it("新建之后只重读那一个目录，不刷整棵树", async () => {
    h.dirs.set("E:\\根", [{ name: "d", isDir: true }]);
    h.dirs.set("E:\\根\\d", [{ name: "x.md", isDir: false }]);
    openOne("E:\\根");
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
    openOne("E:\\根");
    await vi.waitFor(() => expect(store.childrenOf("E:\\根")).toBeTruthy());
    await store.toggleDir("E:\\根\\d");

    store.collapseAll();
    expect(store.expandedPaths()).toEqual([]);
    expect(store.childrenOf("E:\\根\\d"), "折叠不是缓存失效").toBeTruthy();
    expect(store.hasRoot()).toBe(true);
  });

  it("空表是「没有文件夹」那一态：清干净就行，不许发一次注定失败的读盘", async () => {
    h.dirs.set("E:\\根", [{ name: "a.md", isDir: false }]);
    openOne("E:\\根");
    await vi.waitFor(() => expect(store.childrenOf("E:\\根")).toBeTruthy());

    store.setRoots([]);
    expect(store.hasRoot()).toBe(false);
    expect(theOne()).toBe("");
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
    openOne("E:\\根");
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
    openOne(R);
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
    openOne(R);
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

describe("B316 缓存层：拖到某一层 = 移动", () => {
  const R = "E:\\笔记";
  const P = (...segs: string[]): string => segs.join("\\");

  it("走 move、广播 from→to，源层与目标层各刷一次", async () => {
    const sub = P(R, "子");
    h.dirs.set(R, [
      { name: "a.md", isDir: false },
      { name: "子", isDir: true },
    ]);
    h.dirs.set(sub, []);
    openOne(R);
    await vi.waitFor(() => expect(store.childrenOf(R)).toBeTruthy());
    const seen: { from: string; to: string | null }[] = [];
    store.onPathsChanged((c) => seen.push(...c));
    h.calls.length = 0;

    const made = await store.moveTo(P(R, "a.md"), R, sub);
    expect(h.ops).toEqual([`move ${P(R, "a.md")} -> ${sub}`]);
    expect(made.path).toBe(P(sub, "a.md"));
    expect(seen).toEqual([{ from: P(R, "a.md"), to: P(sub, "a.md") }]);
    expect(h.calls.sort()).toEqual([R, sub].sort());
    expect(store.getClipboard(), "拖拽不碰剪贴板").toBeNull();
  });

  it("移动失败：不广播、错误原样透传（面板那句「挪不动」要有出处）", async () => {
    h.dirs.set(R, [{ name: "a.md", isDir: false }]);
    openOne(R);
    await vi.waitFor(() => expect(store.childrenOf(R)).toBeTruthy());
    const seen: unknown[] = [];
    store.onPathsChanged((c) => seen.push(...c));
    h.failOn.add("move");
    await expect(store.moveTo(P(R, "a.md"), R, P(R, "子"))).rejects.toThrow("挪不动");
    expect(seen).toEqual([]);
  });
});

describe("B424 多根", () => {
  const P = (...segs: string[]): string => segs.join("\\");
  const 甲 = "E:\\甲";
  const 乙 = "D:\\乙";

  it("追加：各读自己那一层，顺序 = 名单顺序 = 屏幕从上到下", async () => {
    h.dirs.set(甲, [{ name: "a.md", isDir: false }]);
    h.dirs.set(乙, [{ name: "b.md", isDir: false }]);
    expect(store.addRoot(甲)).toBe(true);
    expect(store.addRoot(乙)).toBe(true);
    await vi.waitFor(() => expect(store.childrenOf(乙)).toBeTruthy());
    expect(store.getRoots()).toEqual([甲, 乙]);
    expect(h.calls.sort()).toEqual([甲, 乙].sort());
  });

  it("去重：同一目录的另一种写法（`/` 与尾斜杠）不算第二根，且报「没加上」", () => {
    expect(store.addRoot(甲)).toBe(true);
    expect(store.addRoot(`${甲}\\`), "尾斜杠是同一个目录").toBe(false);
    expect(store.addRoot(甲.replace(/\\/g, "/")), "分隔符另一种写法也是同一个目录").toBe(false);
    expect(store.getRoots()).toEqual([甲]);
    expect(store.addRoot(""), "空串不是一根").toBe(false);
  });

  it("换根作废改判「还归不归某一根」：加一根不许打掉另外几根在飞的读包", async () => {
    h.dirs.set(甲, [{ name: "a.md", isDir: false }]);
    h.gated.add(甲);
    h.dirs.set(乙, [{ name: "b.md", isDir: false }]);
    store.addRoot(甲);
    store.addRoot(乙); // ← 旧的「全局代际」写法在这里会把甲那一发一起作废掉
    await vi.waitFor(() => expect(store.childrenOf(乙)).toBeTruthy());

    const late = h.pending.get(甲);
    expect(late, "甲那一发还该在飞（不该被乙那一次追加牵连）").toBeTruthy();
    late!(toListing(甲, h.dirs.get(甲)!));
    await vi.waitFor(() => expect(store.childrenOf(甲)).toBeTruthy());
    expect(store.childrenOf(甲)?.map((e) => e.name)).toEqual(["a.md"]);
  });

  it("移除一根：只掉它名下的缓存与展开态，另一根一层都不许被抹", async () => {
    const 甲子 = P(甲, "子");
    const 乙子 = P(乙, "子");
    h.dirs.set(甲, [{ name: "子", isDir: true }]);
    h.dirs.set(甲子, [{ name: "a.md", isDir: false }]);
    h.dirs.set(乙, [{ name: "子", isDir: true }]);
    h.dirs.set(乙子, [{ name: "b.md", isDir: false }]);
    store.setRoots([甲, 乙]);
    await vi.waitFor(() => expect(store.childrenOf(乙)).toBeTruthy());
    await store.toggleDir(甲子);
    await store.toggleDir(乙子);

    store.removeRoot(甲);
    expect(store.getRoots(), "移除 = 从名单里摘掉这一根").toEqual([乙]);
    expect(store.childrenOf(甲), "它自己那一层的缓存要掉").toBeUndefined();
    expect(store.childrenOf(甲子), "它下层的缓存也要掉").toBeUndefined();
    expect(store.expandedPaths(), "展开态也只清它名下的").toEqual([乙子]);
    expect(store.childrenOf(乙子), "另一根读过的层不许被牵连").toBeTruthy();
  });

  it("移除不存在的根 = 空操作（不改名单、不重发读盘）", async () => {
    h.dirs.set(甲, [{ name: "a.md", isDir: false }]);
    store.setRoots([甲]);
    await vi.waitFor(() => expect(store.childrenOf(甲)).toBeTruthy());
    h.calls.length = 0;
    store.removeRoot("E:\\没开过");
    expect(store.getRoots()).toEqual([甲]);
    expect(h.calls, "什么都没移除就不该再发一次读盘").toEqual([]);
  });

  it("setRoots 去重并滤掉空串（启动回放拿到的旧配置可能带野值）", () => {
    store.setRoots([甲, `${甲}/`, "", 乙]);
    expect(store.getRoots()).toEqual([甲, 乙]);
  });

  it("rootOf：嵌套根取最里层，不归任何一根给 null", async () => {
    const 里 = P(甲, "子");
    h.dirs.set(甲, [{ name: "子", isDir: true }]);
    h.dirs.set(里, [{ name: "a.md", isDir: false }]);
    store.setRoots([甲, 里]);
    expect(store.rootOf(P(里, "a.md")), "两层都是根 ⇒ 最里层那根管").toBe(里);
    expect(store.rootOf(P(甲, "别的.md"))).toBe(甲);
    expect(store.rootOf(里), "根本身算界内（与 Rust 的 guard_within 同口径）").toBe(里);
    expect(store.rootOf("C:\\别处"), "不归任何一根").toBeNull();
    expect(store.rootOf("E:\\甲兄弟\\x.md"), "前缀像但不是那一层（不许把「甲」当根）").toBeNull();
  });

  it("refreshRoot 只刷那一根与它名下展开的层（另一根的在飞与缓存都不动）", async () => {
    h.dirs.set(甲, [{ name: "d", isDir: true }]);
    h.dirs.set(P(甲, "d"), [{ name: "a.md", isDir: false }]);
    h.dirs.set(乙, [{ name: "e", isDir: true }]);
    h.dirs.set(P(乙, "e"), [{ name: "b.md", isDir: false }]);
    store.setRoots([甲, 乙]);
    await vi.waitFor(() => expect(store.childrenOf(乙)).toBeTruthy());
    await store.toggleDir(P(甲, "d"));
    await store.toggleDir(P(乙, "e"));
    h.calls.length = 0;

    await store.refreshRoot(甲);
    expect([...h.calls].sort()).toEqual([甲, P(甲, "d")].sort());
  });

  it("写操作的锚点 = 这条路径自己归属的那一根（跨根粘贴各认各的地盘）", async () => {
    const 乙文件 = P(乙, "b.md");
    h.dirs.set(甲, [{ name: "a.md", isDir: false }]);
    h.dirs.set(乙, [{ name: "b.md", isDir: false }]);
    store.setRoots([甲, 乙]);
    await vi.waitFor(() => expect(store.childrenOf(乙)).toBeTruthy());

    await store.renameEntryAt(乙, 乙文件, "c.md");
    expect(h.anchors, "改名该由乙这根管").toEqual([乙]);
    store.setClipboard("copy", [{ path: 乙文件, dir: 乙 }]);
    await store.pasteInto(P(甲, "新层"));
    expect(
      h.anchors[h.anchors.length - 1],
      "源在乙 ⇒ 锚点也是乙（目标层由 destDir 自己带着）",
    ).toBe(乙);
  });

  it("锚点找不到归属那一根时传空串 ⇒ 后端那句「还没有打开文件夹」，而不是悄悄写进别的地盘", async () => {
    h.dirs.set(甲, [{ name: "a.md", isDir: false }]);
    store.setRoots([甲]);
    await store.renameEntryAt("C:\\别处", "C:\\别处\\x.md", "y.md").catch(() => undefined);
    expect(h.anchors, "不归任何一根 ⇒ 交空串，判据留给 Rust").toEqual([""]);
  });
});

describe("B427 · 跨根复制 / 剪切 / 粘贴各认各的锚点", () => {
  const P = (...segs: string[]): string => segs.join("\\");
  const 甲 = "E:\\甲";
  const 乙 = "D:\\乙";

  /** 两根各一层，都读到缓存。 */
  async function boot(): Promise<void> {
    h.dirs.set(甲, [{ name: "a.md", isDir: false }]);
    h.dirs.set(乙, [{ name: "b.md", isDir: false }]);
    store.setRoots([甲, 乙]);
    await vi.waitFor(() => expect(store.childrenOf(乙)).toBeTruthy());
  }

  it("从乙根复制到甲根的某一层：源锚点 = 乙、目标锚点 = 甲（B424 那句注释兑现了）", async () => {
    await boot();
    const 源 = P(乙, "b.md");
    const 目标层 = P(甲, "新层");
    store.setClipboard("copy", [{ path: 源, dir: 乙 }]);
    await store.pasteInto(目标层);
    expect(h.anchors, "源那条归乙").toEqual([乙]);
    expect(h.destAnchors, "目标层归甲 —— 传乙会被 Rust 拒成「不在已打开的文件夹内」").toEqual([甲]);
  });

  it("剪切跨根粘贴走的是同一对锚点（move 不是第二条路）", async () => {
    await boot();
    const 源 = P(乙, "b.md");
    store.setClipboard("cut", [{ path: 源, dir: 乙 }]);
    await store.pasteInto(P(甲, "新层"));
    expect(h.anchors).toEqual([乙]);
    expect(h.destAnchors).toEqual([甲]);
  });

  it("B316 拖到别根的一层 = 同一条 move，两个锚点各归各", async () => {
    await boot();
    const 源 = P(乙, "b.md");
    await store.moveTo(源, 乙, P(甲, "新层"));
    expect(h.anchors).toEqual([乙]);
    expect(h.destAnchors).toEqual([甲]);
  });

  it("目标层不归任何一根 ⇒ 目标锚点交空串，由 Rust 按界外拒", async () => {
    await boot();
    store.setClipboard("copy", [{ path: P(乙, "b.md"), dir: 乙 }]);
    await store.pasteInto("C:\\没在这几根里\\层");
    expect(h.anchors).toEqual([乙]);
    expect(h.destAnchors, "认不出归属不许拿源根顶上去 —— 那正好把守卫改成放行").toEqual([""]);
  });
});

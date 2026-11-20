// @vitest-environment jsdom
// B314 · 资源管理器**面板**（`src/explorer/panel.ts`）。
//
// 用真实的 index.html 骨架跑（`#side-explorer` / `#explorer-panel` / `#explorer-tree` 必须真在），
// store 用**真身**（只假 `ipc/api` 与 `io/files`）：懒加载、展开态、代际作废那些是 store 的
// 职责，面板测试要钉的是「画对了、点下去走对了哪条路」，两边一起跑才测得到接缝。
// ⚠️ 静态 import 会抢在 `innerHTML` 之前把 `ui.ts` 的 `el()` 炸掉（口径同 recents-panel.test.ts）。
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fireDrag, makeDataTransfer, type FakeDataTransfer } from "./dnd";
// 只取那两条常量：`shell/filedrop` 与 `shell/menu` 都不在模块顶层碰 DOM，静态 import 安全。
import { TREE_DRAG_FILE_MIME, TREE_DRAG_MIME } from "../src/shell/filedrop";

const h = vi.hoisted(() => ({
  /** 目录路径 → 该回的那一层子项（`[名, 是不是目录]`）。 */
  dirs: new Map<string, [string, boolean][]>(),
  calls: [] as string[],
  opened: [] as string[],
  created: [] as { kind: string; dir: string; name: string }[],
  /** 「打开文件夹」对话框要回的东西。 */
  pick: null as string | null,
  /** B315：五条写操作各记一笔。 */
  renamed: [] as [string, string][],
  copied: [] as [string, string][],
  moved: [] as [string, string][],
  deleted: [] as string[],
  revealed: [] as string[],
  /** 让某条写操作报错的开关。 */
  failOn: new Set<string>(),
  /** B427：过滤框发出的每一发（`root` / `query` / 两层的开关都在 `opts` 里）。 */
  filtered: [] as { root: string; query: string; opts: Record<string, unknown> }[],
  /** 每个根该回哪些名字命中（键 = 根路径）。 */
  filterHits: new Map<string, { name: string; path: string; rel: string; isDir: boolean }[]>(),
  /** 非空 ⇒ 每一发过滤都以这条错误拒绝（验「正则写坏了」那一档的呈现）。 */
  filterFail: "",
  /** B462：`openFileDiff` 拿到的左右两条（顺序就是断言的对象）。 */
  diffs: [] as [string, string][],
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: () => Promise.resolve(h.pick),
  save: () => Promise.resolve(null),
  ask: () => Promise.resolve(false),
}));

vi.mock("../src/ipc/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/ipc/api")>();
  const mk = (path: string, name: string, isDir: boolean) => ({
    name,
    path,
    isDir,
    size: 1,
    mtimeMs: 0,
  });
  return {
    ...real,
    listDir: (path: string) => {
      h.calls.push(path);
      const kids = h.dirs.get(path);
      if (!kids) return Promise.reject(new Error(`读不了：${path}`));
      return Promise.resolve({
        entries: kids.map(([n, d]) => mk(`${path}\\${n}`, n, d)),
        truncated: false,
      });
    },
    createFile: (dir: string, name: string) => {
      h.created.push({ kind: "file", dir, name });
      return Promise.resolve(mk(`${dir}\\${name}`, name, false));
    },
    createDir: (dir: string, name: string) => {
      h.created.push({ kind: "dir", dir, name });
      return Promise.resolve(mk(`${dir}\\${name}`, name, true));
    },
    // B315 五条。假实现**顺手改 `h.dirs`**：不然「删掉的那一行还画着」这种结论
    // 就只是断言了我自己记的那笔账，而不是屏幕上真变了样。
    renameEntry: (_root: string, path: string, newName: string) => {
      h.renamed.push([path, newName]);
      if (h.failOn.has("rename")) return Promise.reject(new Error("这一层里已经有 它了"));
      const dir = path.slice(0, path.lastIndexOf("\\"));
      const old = path.slice(path.lastIndexOf("\\") + 1);
      h.dirs.set(
        dir,
        (h.dirs.get(dir) ?? []).map((k) => (k[0] === old ? [newName, k[1]] : k)),
      );
      return Promise.resolve(mk(`${dir}\\${newName}`, newName, h.dirs.has(path)));
    },
    copyEntry: (_root: string, src: string, destDir: string) => {
      h.copied.push([src, destDir]);
      const name = src.slice(src.lastIndexOf("\\") + 1);
      const isDir = h.dirs.has(src);
      h.dirs.set(destDir, [...(h.dirs.get(destDir) ?? []), [name, isDir]]);
      return Promise.resolve(mk(`${destDir}\\${name}`, name, isDir));
    },
    moveEntry: (_root: string, src: string, destDir: string) => {
      h.moved.push([src, destDir]);
      if (h.failOn.has("move")) return Promise.reject(new Error("要挪的东西就在这层里"));
      const name = src.slice(src.lastIndexOf("\\") + 1);
      const from = src.slice(0, src.lastIndexOf("\\"));
      const isDir = h.dirs.has(src);
      h.dirs.set(
        from,
        (h.dirs.get(from) ?? []).filter((k) => k[0] !== name),
      );
      h.dirs.set(destDir, [...(h.dirs.get(destDir) ?? []), [name, isDir]]);
      return Promise.resolve(mk(`${destDir}\\${name}`, name, isDir));
    },
    deleteEntry: (_root: string, path: string) => {
      h.deleted.push(path);
      if (h.failOn.has("delete")) return Promise.reject(new Error("送不进回收站"));
      const dir = path.slice(0, path.lastIndexOf("\\"));
      const name = path.slice(path.lastIndexOf("\\") + 1);
      h.dirs.set(
        dir,
        (h.dirs.get(dir) ?? []).filter((k) => k[0] !== name),
      );
      return Promise.resolve();
    },
    revealInFolder: (path: string) => {
      h.revealed.push(path);
      return Promise.resolve();
    },
    // B333：这一条是不是目录 —— 假实现按「夹具认得这一层」答，与 listDir 同一份账，
    // 免得两个假各说一套（那正是契约测试最容易被假夹具糊过去的地方）。
    isDir: (path: string) => Promise.resolve(h.dirs.has(path)),
    // B427：过滤框的唯一数据源（实盘整棵扫在 Rust 那边，前端只认这条回包）。
    filterTree: (root: string, query: string, opts: Record<string, unknown>) => {
      h.filtered.push({ root, query, opts });
      if (h.filterFail) return Promise.reject(new Error(h.filterFail));
      return Promise.resolve({ hits: h.filterHits.get(root) ?? [], truncated: false });
    },
    saveSettings: () => Promise.resolve(),
  };
});

vi.mock("../src/io/files", () => ({
  doOpen: (path: string) => {
    h.opened.push(path);
    return Promise.resolve(null);
  },
}));

// 差异标签这一发只记「左右两条 + 顺序」：真正开标签的口径归 diff 那一族自己的测试。
vi.mock("../src/diff/model", () => ({
  openFileDiff: (left: string, right: string) => {
    h.diffs.push([left, right]);
    return Promise.resolve(null);
  },
}));

let panel: typeof import("../src/explorer/panel");
let store: typeof import("../src/explorer/store");
let drawer: typeof import("../src/shell/drawer");
let ui: typeof import("../src/ui");
let menu: typeof import("../src/shell/menu");

beforeAll(async () => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
  [panel, store, drawer, ui, menu] = await Promise.all([
    import("../src/explorer/panel"),
    import("../src/explorer/store"),
    import("../src/shell/drawer"),
    import("../src/ui"),
    import("../src/shell/menu"),
  ]);
  // 另两块视图也登记着：互斥与点亮态的判据要有写它们的人（口径同 recents-panel.test.ts）。
  drawer.registerDrawerView("toc", {
    panel: ui.tocPanel,
    button: ui.sideOutline,
    onShow: () => {},
  });
  drawer.registerDrawerView("recent", {
    panel: ui.recentPanel,
    button: ui.sideRecent,
    onShow: () => {},
  });
  panel.setupExplorer();
});

const ROOT = "E:\\笔记";

/**
 * 夹具（B424）：store 只有多根口径了，而这一批用例的主语多半是「就开这一根」。
 * 逐条写 `setRoots([ROOT])` 三十遍只会把 diff 撑大、把真正的判据埋得更深。
 */
const openRoots = (...list: string[]): void => store.setRoots(list);
const theRoot = (): string => store.getRoots()[0] ?? "";

function rows(): HTMLElement[] {
  return [...ui.explorerTree.querySelectorAll<HTMLElement>(".explorer-row, .explorer-root")];
}

function names(): string[] {
  return rows().map((r) => r.querySelector(".explorer-name")?.textContent ?? "");
}

function rowAt(name: string): HTMLElement {
  const r = rows().find((x) => x.querySelector(".explorer-name")?.textContent === name);
  if (!r) throw new Error(`没有这一行：${name}（现有：${names().join(", ")}）`);
  return r;
}

async function click(el: Element): Promise<void> {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await vi.waitFor(() => expect(true).toBe(true));
}

/** 根行右侧动作组里的某一颗（B429：新建文件 / 新建目录 / 刷新）。 */
function rootAction(root: string, kind: "file" | "dir" | "refresh"): HTMLElement {
  const row = rows().find((r) => r.dataset.path === root);
  if (!row) throw new Error(`没有这一根：${root}`);
  const sel =
    kind === "refresh" ? ".explorer-root-refresh" : `.explorer-root-new[data-kind="${kind}"]`;
  const btn = row.querySelector<HTMLElement>(sel);
  if (!btn) throw new Error(`根行里没有「${kind}」那颗键`);
  return btn;
}

/** 走右键菜单里的「新建文件 / 新建目录」（叶子目录仍是这几条动作的主语）。 */
async function createFromMenu(row: HTMLElement, label: "新建文件" | "新建目录"): Promise<void> {
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 30, clientY: 40 }));
  await vi.waitFor(() => expect(document.querySelector(".popup-menu")).toBeTruthy());
  const item = [...document.querySelectorAll<HTMLButtonElement>(".popup-menu button")].find((b) =>
    (b.querySelector(".menu-label")?.textContent ?? "").includes(label),
  );
  if (!item) throw new Error(`菜单里没有「${label}」`);
  await click(item);
}

/**
 * B427：把过滤框按回「空 + 三档关 + 两层开」。
 * 过滤态是**模块级**的 —— 上一条用例留下的字或开关会把这一条画成过滤结果。
 */
function resetFilterBox(): void {
  ui.explorerFilterInput.value = "";
  ui.explorerFilterInput.dispatchEvent(new Event("input"));
  const wants: [HTMLButtonElement, boolean][] = [
    [ui.explorerFilterCase, false],
    [ui.explorerFilterWord, false],
    [ui.explorerFilterRegex, false],
    [ui.explorerFilterExcludes, true],
  ];
  for (const [btn, want] of wants) {
    if ((btn.getAttribute("aria-pressed") === "true") !== want) {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  }
}

beforeEach(async () => {
  // 过滤框的开合也是模块级状态：上一条用例留着打开，这一条一敲字就画成命中树。
  if (!ui.explorerFilter.hidden) {
    ui.explorerFilterToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
  // 上一条用例如果在中途断言失败，`creating` / `renaming` 就漏在模块里 —— 于是整棵树被画成
  // 输入框，下面 `setRoot` 那句等「a.md」会超时，一条真失败变成三十条噪音。先把输入框按掉。
  for (const input of ui.explorerTree.querySelectorAll<HTMLInputElement>(".explorer-input")) {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }
  h.calls.length = 0;
  h.opened.length = 0;
  h.created.length = 0;
  h.renamed.length = 0;
  h.copied.length = 0;
  h.moved.length = 0;
  h.deleted.length = 0;
  h.revealed.length = 0;
  h.failOn.clear();
  h.filtered.length = 0;
  h.filterHits.clear();
  h.filterFail = "";
  h.diffs.length = 0;
  resetFilterBox();
  h.pick = null;
  store.clearClipboard();
  menu.closePopupMenu();
  h.dirs.clear();
  h.dirs.set(ROOT, [
    ["notes", true],
    ["b.md", false],
    ["a.md", false],
  ]);
  h.dirs.set(`${ROOT}\\notes`, [["deeper.md", false]]);
  store.setRoots([]);
  // 根行的折叠黑名单是模块级的：上一条用例（折叠状态保存那条）收起过根，这里要按回默认，
  // 否则后面每一条都只画出一行「笔记」。
  panel.restoreExplorerState([], []);
  await vi.waitFor(() => expect(ui.explorerTree.textContent).toContain("还没有打开文件夹"));
  store.setRoots([ROOT]);
  await vi.waitFor(() => expect(names()).toContain("a.md"));
});

describe("B314 资源管理器面板", () => {
  it("装配：那颗键填了字形、登记进外壳、摊开时轮得到它", () => {
    expect(ui.sideExplorer.innerHTML, "按钮列那颗要有字形").toContain("codicon");
    expect(ui.explorerFilterToggle.innerHTML, "头部过滤键要走 codicon").toContain("codicon-search");
    drawer.setDrawer("explorer", false);
    expect(ui.explorerPanel.hidden).toBe(false);
    expect(ui.tocPanel.hidden, "互斥是结构性的").toBe(true);
    expect(ui.sideExplorer.classList.contains("is-on")).toBe(true);
    drawer.setDrawer(null, false);
    expect(ui.explorerPanel.hidden).toBe(true);
  });

  it("树画成「根 + 子项」：目录在前、每行带层级与折叠箭头", () => {
    expect(names()[0], "根那一行永远是第一条").toBe("笔记");
    expect(rowAt("笔记").className).toContain("explorer-root");
    expect(names().slice(1)).toEqual(["notes", "b.md", "a.md"]);
    const dir = rowAt("notes");
    expect(dir.dataset.kind).toBe("dir");
    expect(dir.getAttribute("aria-expanded"), "默认收起").toBe("false");
    expect(dir.querySelector(".explorer-twisty")?.innerHTML).toContain("codicon-chevron-right");
    expect(
      dir.querySelector(".explorer-glyph"),
      "B370：目录行没有图标（VS Code 的 Seti 主题只给文件配图标）",
    ).toBeNull();
    const file = rowAt("a.md");
    expect(file.dataset.kind).toBe("file");
    expect(
      file.querySelector(".explorer-glyph .seti-icon")?.getAttribute("data-tone"),
      "文件图标走 Seti（B368），Markdown 是蓝色",
    ).toBe("blue");
    // B370/B373：行结构与 VS Code 对齐 —— 目录 = 箭头 + 名字；文件 = Seti 图标 + 名字。
    // 文件行**不再留空箭头槽**：图标槽本身吃掉箭头那 22px，两行的名字从同一 x 起排。
    expect(
      [...dir.children].map((el) => el.className),
      "目录行不该有图标槽",
    ).toEqual(["explorer-twisty", "explorer-name"]);
    expect(
      [...file.children].map((el) => el.className),
      "文件行 = Seti 图标 + 名字（没有空箭头槽）",
    ).toEqual(["explorer-glyph", "explorer-name"]);
    expect(file.getAttribute("aria-level"), "子项比根深一层").toBe("2");
  });

  it("B373：深层行带祖先引导线（depth-1 根），选中行的祖先链是实色", async () => {
    await click(rowAt("notes")); // 展开并选中目录
    const deep = rowAt("deeper.md");
    expect(deep.getAttribute("aria-level"), "notes 的子项深度 2").toBe("3");
    expect(
      [...deep.children].map((el) => el.className),
      "深层文件行 = 引导线列 + 图标 + 名字",
    ).toEqual(["explorer-indent", "explorer-glyph", "explorer-name"]);
    const indent = deep.querySelector<HTMLElement>(".explorer-indent");
    expect(indent, "深层行要有一列引导线").not.toBeNull();
    const guides = [...(indent?.children ?? [])] as HTMLElement[];
    expect(guides.length, "深度 2 ⇒ 只画祖先那 1 根（根不画）").toBe(1);
    expect(guides[0].dataset.guideFor, "线记着它对应哪一层（active 靠它）").toBe(`${ROOT}\\notes`);
    // 刚展开的目录被选中 ⇒ 它那一列（它的孩子行里那根线）是 active
    expect(guides[0].classList.contains("is-active")).toBe(true);
    expect(rowAt("notes").querySelector(".explorer-indent"), "顶层没有祖先线").toBeNull();

    // 选中顶层文件 ⇒ active 换到根那一列（没有线可亮），notes 这根退回 inactive；
    // 再选回深层文件 ⇒ 又亮起来。两发都不重画树，走的是 select 里的原位更新。
    await click(rowAt("a.md"));
    expect(guides[0].classList.contains("is-active")).toBe(false);
    await click(rowAt("deeper.md"));
    expect(guides[0].classList.contains("is-active")).toBe(true);
  });

  it("点目录 = 展开并读那一层；再点 = 收起", async () => {
    await click(rowAt("notes"));
    expect(store.isExpanded(`${ROOT}\\notes`)).toBe(true);
    expect(names()).toContain("deeper.md");
    expect(h.calls, "展开时才读那一层").toContain(`${ROOT}\\notes`);
    expect(rowAt("notes").getAttribute("aria-expanded")).toBe("true");
    expect(
      rowAt("notes").querySelector(".explorer-glyph"),
      "展开态也不挂图标：箭头方向才是状态，VS Code 的 Seti 主题同样只给文件配图标",
    ).toBeNull();

    await click(rowAt("notes"));
    expect(store.isExpanded(`${ROOT}\\notes`)).toBe(false);
    expect(names(), "收起后那一层的行不该还占着").not.toContain("deeper.md");
  });

  it("点文件 = 走 doOpen 那一扇漏斗（记入最近打开因此自动跟着生效）", async () => {
    await click(rowAt("a.md"));
    expect(h.opened).toEqual([`${ROOT}\\a.md`]);
  });

  it("没打开过文件夹时给一句提示加一颗入口键，点了走目录选择器", async () => {
    store.setRoots([]);
    await vi.waitFor(() => expect(ui.explorerTree.textContent).toContain("还没有打开文件夹"));
    expect(theRoot(), "空串不该发一次注定失败的读盘").toBe("");
    expect(
      h.calls.filter((c) => c === ""),
      "不许对空路径发 IPC",
    ).toHaveLength(0);

    const btn = ui.explorerTree.querySelector(".explorer-hint-btn");
    expect(btn, "提示里要带一个能点的入口").toBeTruthy();
    // B317（用户点名）：没根时顶部那一排键整排收起（样式表里 `.explorer-panel.no-root`
    // 那条负责隐藏）—— jsdom 不跑级联，所以这里钉的是**类挂上了**，样式那条走静态契约。
    expect(ui.explorerPanel.classList.contains("no-root")).toBe(true);
    h.pick = ROOT;
    await click(btn!);
    await vi.waitFor(() => expect(theRoot()).toBe(ROOT));
    expect(names()).toContain("a.md");
    expect(ui.explorerPanel.classList.contains("no-root"), "有了根就得把那排放回来").toBe(false);
  });

  it("B424：刷新键搬到每一根那一行，点它只刷这一根、不翻根行的面", async () => {
    const rootRow = rowAt("笔记");
    const btn = rootRow.querySelector<HTMLElement>(".explorer-root-refresh");
    expect(btn, "根行该自带一颗刷新").toBeTruthy();
    expect(
      ui.explorerOpen.closest(".explorer-tree"),
      "「打开文件夹」该在头部那一排（多根之后它不再跟着某一棵根行走）",
    ).toBeNull();
    const expandedBefore = rowAt("笔记").getAttribute("aria-expanded");

    await click(btn!);
    await vi.waitFor(() => expect(h.calls).toContain(ROOT));
    expect(
      rowAt("笔记").getAttribute("aria-expanded"),
      "树是委托点击 —— 没挡掉按钮的话，这一发会顺带把根折叠/展开一遍",
    ).toBe(expandedBefore);
  });

  it("B424：两根并排 = 两行根行 + 各自顶层，名单顺序就是屏幕顺序", async () => {
    const 第二根 = "E:\\工作";
    h.dirs.set(第二根, [["q.md", false]]);
    openRoots(ROOT, 第二根);
    await vi.waitFor(() =>
      expect(names()).toEqual(["笔记", "notes", "b.md", "a.md", "工作", "q.md"]),
    );
    expect(ui.explorerTree.querySelectorAll(".explorer-root"), "每根一行").toHaveLength(2);
    expect(ui.explorerTree.querySelectorAll(".explorer-root-refresh"), "每根一颗刷新").toHaveLength(
      2,
    );
  });

  it("刷新重读根与展开着的层；全部折叠连根目录一起收，再点一下全展开", async () => {
    await click(rowAt("notes"));
    h.calls.length = 0;
    await click(rowAt("笔记").querySelector<HTMLElement>(".explorer-root-refresh")!);
    await vi.waitFor(() => expect(h.calls).toContain(`${ROOT}\\notes`));

    await click(ui.explorerCollapse);
    expect(names(), "B493：根行也一起收，树上只剩根名").toEqual(["笔记"]);
    expect(store.expandedPaths()).toEqual([]);
    expect(ui.explorerCollapse.getAttribute("aria-label"), "全收着 ⇒ 键说「全部展开」").toBe(
      "全部展开",
    );
    expect(ui.explorerCollapse.getAttribute("aria-pressed")).toBe("true");

    await click(ui.explorerCollapse);
    expect(names(), "再点一下：根行放回顶层（子目录保持收起）").toEqual([
      "笔记",
      "notes",
      "b.md",
      "a.md",
    ]);
    expect(ui.explorerCollapse.getAttribute("aria-label")).toBe("全部折叠");
  });

  it("读不了的那一层画一句能读的话，别层照旧", async () => {
    await click(rowAt("notes"));
    h.dirs.delete(`${ROOT}\\notes`);
    await store.refreshDir(`${ROOT}\\notes`);
    await vi.waitFor(() => expect(ui.explorerTree.textContent).toContain("读不了："));
    expect(names(), "根与顶层不许被邻居的失败带崩").toEqual(["笔记", "notes", "b.md", "a.md"]);
  });

  it("文件名里的尖括号只当文字：不许变成真的元素", async () => {
    const evil = `<img src=x onerror=alert(1)>.md`;
    h.dirs.set(ROOT, [[evil, false]]);
    await store.refreshDir(ROOT);
    await vi.waitFor(() => expect(ui.explorerTree.textContent).toContain("onerror"));
    expect(ui.explorerTree.querySelector("img"), "拼 innerHTML 就是给自己造注入点").toBeNull();
    expect(rowAt(evil).querySelector(".explorer-name")?.textContent).toBe(evil);
    expect(rowAt(evil).dataset.tip, "完整路径进自绘提示层（B350：原生 title 撤了）").toBe(
      `${ROOT}\\${evil}`,
    );
    expect(rowAt(evil).dataset.tipFollow, "树行走文本档：跟鼠标、不画尖尖").toBe("1");
    expect(rowAt(evil).title, "不许再写原生 title").toBe("");
  });

  it("右键目录新建文件：输入框长在目标那一层，回车后建、刷那一层并打开", async () => {
    await click(rowAt("notes")); // 选中一个目录 ⇒ 新建的目标就是它
    await createFromMenu(rowAt("notes"), "新建文件");
    const input = ui.explorerTree.querySelector<HTMLInputElement>(".explorer-input");
    expect(input, "没画出输入框").toBeTruthy();
    // B373：输入框落在它将成为的那一层，结构也跟同层的文件行一致（图标槽 + 输入框，
    // 没有空箭头槽）—— 否则「新建」那一行会比同层名字缩进一截。
    const row = input!.closest<HTMLElement>(".explorer-row")!;
    expect(row.style.getPropertyValue("--depth"), "notes 的子层 = 深度 2").toBe("2");
    expect([...row.children].map((el) => el.className)).toEqual([
      "explorer-indent",
      "explorer-glyph",
      "explorer-input",
    ]);
    expect(row.querySelectorAll(".explorer-guide").length, "深度 2 画 1 根祖先线").toBe(1);
    input!.value = "新笔记.md";
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() =>
      expect(h.created).toEqual([{ kind: "file", dir: `${ROOT}\\notes`, name: "新笔记.md" }]),
    );
    await vi.waitFor(() => expect(h.opened).toEqual([`${ROOT}\\notes\\新笔记.md`]));
    expect(ui.explorerTree.querySelector(".explorer-input"), "提交之后输入框要收掉").toBeNull();
  });

  it("B429：根行新建键的主语是那一根（不看当前选中了谁）", async () => {
    await click(rowAt("b.md")); // 选中一个文件：旧口径会建进它的父亲目录
    await click(rootAction(ROOT, "file"));
    const input = ui.explorerTree.querySelector<HTMLInputElement>(".explorer-input");
    expect(input, "没画出输入框").toBeTruthy();
    // 输入框排在该层最前，且同层其余条目照旧画着（不被新建态整层藏掉）
    const host = input!.closest(".explorer-row")!.parentElement!;
    expect(host.classList.contains("explorer-children"), "父容器应是那一层的 children 容器").toBe(
      true,
    );
    expect(
      host.querySelectorAll(".explorer-row:not(.is-creating)").length,
      "同层其余条目被那个 return 整层藏了",
    ).toBeGreaterThanOrEqual(3); // notes / b.md / a.md
    expect(host.firstElementChild?.classList.contains("is-creating"), "输入框应排在最前").toBe(
      true,
    );
    input!.value = "根层.md";
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() =>
      expect(h.created).toEqual([{ kind: "file", dir: ROOT, name: "根层.md" }]),
    );
  });

  it("空目录进入新建态：只画输入框，不再挂一条「（空）」", async () => {
    h.dirs.set(`${ROOT}\\notes`, []);
    await click(rowAt("notes"));
    await createFromMenu(rowAt("notes"), "新建文件");
    const input = ui.explorerTree.querySelector<HTMLInputElement>(".explorer-input");
    expect(input, "空目录里也要画出输入框").toBeTruthy();
    expect(ui.explorerTree.textContent, "新建态下不该再挂「（空）」").not.toContain("（空）");
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(ui.explorerTree.querySelector(".explorer-input")).toBeNull());
  });

  it("新建目录走 createDir；空名字 = 取消，不发 IPC", async () => {
    await click(rootAction(ROOT, "dir"));
    const input = ui.explorerTree.querySelector<HTMLInputElement>(".explorer-input");
    expect(input, "根行那颗键该在根那一层建").toBeTruthy();
    input!.value = "   ";
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(ui.explorerTree.textContent).toContain("a.md"));
    expect(h.created, "空名字不该建出个没名字的东西").toEqual([]);
  });

  it("选中态与键盘：上下走可见行、只有一行可 tab", () => {
    // ⚠️ 同步派发、不夹 await：中间只要插一个 await，前一个用例遗留的重绘就可能把节点换掉，
    //    于是「点的是已经脱离文档的那一份」—— 假红比真红难查。
    //    keydown 派在**行本身**上：真实情形是焦点在那一行，事件目标就是它。
    const press = (el: Element, k: string): void => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    };
    const b = rowAt("b.md");
    b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(b.getAttribute("aria-selected")).toBe("true");
    expect(
      rows().filter((r) => r.tabIndex === 0),
      "roving tabindex：可见行里只留一个 tab 停靠点",
    ).toHaveLength(1);

    press(b, "ArrowDown");
    expect(rowAt("a.md").getAttribute("aria-selected")).toBe("true");
    press(rowAt("a.md"), "ArrowUp");
    expect(rowAt("b.md").getAttribute("aria-selected")).toBe("true");

    // 文件行按右箭头不该展开任何东西（左箭头回选中父目录）
    press(rowAt("b.md"), "ArrowRight");
    expect(store.expandedPaths()).toEqual([]);
    h.opened.length = 0; // 上面那次 click 已经开过一回了，这里要验的是回车那一条路
    press(rowAt("b.md"), "Enter");
    expect(h.opened, "回车 = 打开这一行").toEqual([`${ROOT}\\b.md`]);
  });

  it("外壳记「这一块开着」并落盘（B312 那两格在这里继续成立）", () => {
    drawer.setDrawer("explorer");
    expect(theRoot()).toBe(ROOT);
    drawer.setDrawer(null);
    drawer.setDrawer("explorer");
    expect(ui.explorerPanel.hidden).toBe(false);
  });

  it("按钮列那颗**点得动**：一下摊开、再一下收起（真机验收抓到的漏挂）", async () => {
    // 上面那条「装配」用例是 `setDrawer("explorer")` 之后断言亮灭 —— 那颗键根本没被点过，
    // 于是「只登记不挂点击」这一形在 jsdom 里全绿、在真机上点不动（B314-8）。
    drawer.setDrawer(null, false);
    expect(ui.explorerPanel.hidden).toBe(true);
    await click(ui.sideExplorer);
    expect(ui.explorerPanel.hidden, "点那颗键就该摊开").toBe(false);
    expect(ui.sideExplorer.classList.contains("is-on")).toBe(true);
    await click(ui.sideExplorer);
    expect(ui.explorerPanel.hidden, "再点一下收起").toBe(true);
    expect(ui.sideExplorer.classList.contains("is-on"), "收掉了键不许还亮着").toBe(false);
  });
});

describe("B315 右键菜单与常规操作", () => {
  function menuEl(): HTMLElement {
    const el = document.querySelector<HTMLElement>(".popup-menu");
    if (!el) throw new Error("菜单没弹出来");
    return el;
  }

  function labels(): string[] {
    return [...menuEl().querySelectorAll<HTMLButtonElement>("button")].map(
      (b) => b.querySelector(".menu-label")?.textContent ?? "",
    );
  }

  function menuItem(needle: string): HTMLButtonElement {
    const btn = [...menuEl().querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      (b.querySelector(".menu-label")?.textContent ?? "").includes(needle),
    );
    if (!btn) throw new Error(`菜单里没有「${needle}」（现有：${labels().join(" / ")}）`);
    return btn;
  }

  async function rightClick(el: Element): Promise<void> {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 30, clientY: 40 }));
    await vi.waitFor(() => expect(document.querySelector(".popup-menu")).toBeTruthy());
  }

  async function pick(needle: string): Promise<void> {
    menuItem(needle).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(true).toBe(true));
  }

  function press(el: Element, key: string, mods: KeyboardEventInit = {}): void {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...mods }));
  }

  it("右键文件行：菜单条目齐、那一行先被选中、没剪贴板时粘贴是灰的", async () => {
    await rightClick(rowAt("a.md"));
    expect(labels()).toEqual([
      "打开",
      "新建文件",
      "新建目录",
      "重命名",
      "复制",
      "剪切",
      "粘贴",
      "删除",
      // B461 Task 6：B 档那一对的第一条（未选中时给「选择以进行比较」，
      // 「与 X 比较」要等选中别处才出现 —— 状态机与显隐的真相见 tests/diff-model.test.ts）。
      "选择以进行比较",
      "复制路径",
      "在资源管理器中显示",
    ]);
    expect(rowAt("a.md").getAttribute("aria-selected"), "菜单问的是「选中了谁」，得先选中").toBe(
      "true",
    );
    expect(menuItem("粘贴").disabled, "剪贴板空着，粘贴该是灰的").toBe(true);
    expect(menuItem("重命名").disabled, "快捷键提示挂在标签里（\\t 那一段）").toBe(false);
  });

  it("右键根那一行：改名 / 复制 / 删除都不给，换成刷新这一根、移除目录与全部折叠", async () => {
    await rightClick(rowAt("笔记"));
    const got = labels();
    expect(got, "根就是整棵树，删了面板就空了").not.toContain("删除");
    expect(got).not.toContain("重命名");
    expect(got).not.toContain("复制");
    expect(got).toContain("新建文件");
    expect(got).toContain("刷新该文件夹");
    expect(got, "B424：移除目录是这一行自己的一条动作").toContain("移除目录");
    expect(got).toContain("全部折叠");
  });

  it("B424：「移除目录」只从名单里摘掉这一根，另一根与已开标签都不动", async () => {
    const 第二根 = "E:\\工作";
    h.dirs.set(第二根, [["q.md", false]]);
    openRoots(ROOT, 第二根);
    await vi.waitFor(() => expect(names()).toContain("q.md"));

    await rightClick(rowAt("笔记"));
    await pick("移除目录");

    await vi.waitFor(() => expect(store.getRoots()).toEqual([第二根]));
    expect(names(), "另一根照旧画着").toEqual(expect.arrayContaining(["工作", "q.md"]));
    expect(h.opened, "移除目录不发任何开文件/关标签的动作").toEqual([]);
  });

  it("菜单点删除 → 走 delete IPC，那一行从屏幕上消失", async () => {
    await rightClick(rowAt("b.md"));
    await pick("删除");
    expect(h.deleted).toEqual([`${ROOT}\\b.md`]);
    await vi.waitFor(() => expect(names()).not.toContain("b.md"));
    expect(names(), "别的行不受牵连").toEqual(expect.arrayContaining(["笔记", "a.md"]));
  });

  it("复制 → 右键目录粘贴：走 copy、落到那一层，源那一条还在", async () => {
    await rightClick(rowAt("a.md"));
    await pick("复制");
    expect(store.getClipboard()?.mode).toBe("copy");
    await rightClick(rowAt("notes"));
    expect(menuItem("粘贴").disabled, "有剪贴板了，粘贴该能点").toBe(false);
    await pick("粘贴");
    expect(h.copied).toEqual([[`${ROOT}\\a.md`, `${ROOT}\\notes`]]);
    expect(names(), "复制不动源").toContain("a.md");
    await click(rowAt("notes")); // 展开看那一层真收到了副本
    await vi.waitFor(() => expect(names()).toContain("deeper.md"));
    expect(names(), "副本画进了目标那一层").toContain("a.md");
  });

  it("剪切 → 粘贴走 move；复制那份粘完还留着（能连着粘几层）", async () => {
    await rightClick(rowAt("a.md"));
    await pick("复制");
    await rightClick(rowAt("notes"));
    await pick("粘贴");
    expect(store.getClipboard(), "复制那一份要留着").not.toBeNull();
    await rightClick(rowAt("b.md"));
    await pick("剪切");
    expect(store.getClipboard()?.mode).toBe("cut");
    await rightClick(rowAt("notes"));
    await pick("粘贴");
    expect(h.moved).toEqual([[`${ROOT}\\b.md`, `${ROOT}\\notes`]]);
    expect(store.getClipboard(), "剪切那份粘成功就该收掉").toBeNull();
  });

  it("粘贴落到「选中目录本身」而不是它的上一层：目录行 = 它自己，文件行 = 它所在层", async () => {
    await rightClick(rowAt("a.md"));
    await pick("剪切");
    await rightClick(rowAt("notes"));
    await pick("粘贴");
    expect(h.moved, "目标该是 notes 这一层").toEqual([[`${ROOT}\\a.md`, `${ROOT}\\notes`]]);
  });

  it("F2 改名：输入框预填当前名，回车发 IPC 并画出新名；Esc 取消不发", async () => {
    press(rowAt("a.md"), "F2");
    const input = ui.explorerTree.querySelector<HTMLInputElement>(".explorer-input");
    expect(input, "没画出改名输入框").toBeTruthy();
    expect(input!.value, "预填的是当前那一个名字").toBe("a.md");
    input!.value = "改好的.md";
    press(input!, "Enter");
    await vi.waitFor(() => expect(h.renamed).toEqual([[`${ROOT}\\a.md`, "改好的.md"]]));
    await vi.waitFor(() => expect(names()).toContain("改好的.md"));
    // 选中态要跟着走到新那一条：重绘是按**旧**路径做的，不补这一发就是「改完名选中凭空没了」。
    expect(rowAt("改好的.md").getAttribute("aria-selected"), "选中态没跟着改名走").toBe("true");
    expect(ui.explorerTree.querySelector(".explorer-input"), "提交后输入框要收掉").toBeNull();

    press(rowAt("b.md"), "F2");
    const second = ui.explorerTree.querySelector<HTMLInputElement>(".explorer-input");
    press(second!, "Escape");
    expect(renamingCount(), "Esc 之后不许还留着输入框").toBe(0);
    expect(h.renamed, "Esc 那条不发 IPC").toHaveLength(1);
  });

  it("名字没改就回车 = 取消（不发那一发没意义的 IPC）", () => {
    press(rowAt("a.md"), "F2");
    const input = ui.explorerTree.querySelector<HTMLInputElement>(".explorer-input")!;
    press(input, "Enter");
    expect(h.renamed).toEqual([]);
  });

  it("键盘那一路：Ctrl+C / Ctrl+V 与菜单同一套动作；Ctrl+Shift+C 不算", async () => {
    const a = rowAt("a.md");
    press(a, "c", { ctrlKey: true });
    expect(store.getClipboard()?.mode).toBe("copy");
    press(a, "C", { ctrlKey: true, shiftKey: true });
    expect(store.getClipboard()?.mode, "带 Shift 的组合不该被当成复制").toBe("copy");

    press(rowAt("notes"), "v", { ctrlKey: true });
    await vi.waitFor(() => expect(h.copied).toEqual([[`${ROOT}\\a.md`, `${ROOT}\\notes`]]));
  });

  it("Delete 键与菜单那条同一条路；根那一行按 Delete 什么都不发", async () => {
    press(rowAt("b.md"), "Delete");
    await vi.waitFor(() => expect(h.deleted).toEqual([`${ROOT}\\b.md`]));
    press(rowAt("笔记"), "Delete");
    expect(h.deleted, "根不许删").toHaveLength(1);
  });

  it("改名失败：树停在原样、错误原样进状态栏，不许留下一个改了一半的样子", async () => {
    h.failOn.add("rename");
    press(rowAt("a.md"), "F2");
    const input = ui.explorerTree.querySelector<HTMLInputElement>(".explorer-input")!;
    input.value = "撞了.md";
    press(input, "Enter");
    const bar = document.getElementById("sb-message")!;
    await vi.waitFor(() => expect(bar.textContent).toContain("已经有"));
    expect(bar.classList.contains("sb-message-error"), "报错那条要走错误色").toBe(true);
    expect(names()).toContain("a.md");
    expect(names()).not.toContain("撞了.md");
  });

  it("复制路径 / 在资源管理器中显示：两条都拿**这一行**的路径，不是选中那一条的", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: (s: string) => Promise.resolve(writes.push(s)) },
      configurable: true,
    });
    await rightClick(rowAt("b.md"));
    await pick("复制路径");
    await vi.waitFor(() => expect(writes).toEqual([`${ROOT}\\b.md`]));
    await rightClick(rowAt("notes"));
    await pick("在资源管理器中显示");
    expect(h.revealed).toEqual([`${ROOT}\\notes`]);
  });

  function renamingCount(): number {
    return ui.explorerTree.querySelectorAll(".explorer-input").length;
  }
});

describe("B316 树内拖拽 = 移动", () => {
  // 上一单留在飞行里的拖拽会让这一单的判据糊掉（`dragging` 是模块态）。走事件那扇门收摊：
  // `dragend` 的监听不问载荷，无条件清高亮 + 取消排队中的展开。
  beforeEach(() => {
    fireDrag("dragend", ui.explorerTree, null);
  });

  /** 起点。返回那份载荷给后面几步复用 —— 真机上一次拖拽自始至终是同一个 `DataTransfer`。 */
  function start(name: string): FakeDataTransfer {
    const dt = makeDataTransfer();
    fireDrag("dragstart", rowAt(name), dt);
    return dt;
  }
  function over(name: string, dt: FakeDataTransfer): MouseEvent {
    return fireDrag("dragover", rowAt(name), dt);
  }
  function leave(name: string, dt: FakeDataTransfer, to: Element | null): MouseEvent {
    return fireDrag("dragleave", rowAt(name), dt, { relatedTarget: to });
  }
  function drop(name: string, dt: FakeDataTransfer): MouseEvent {
    return fireDrag("drop", rowAt(name), dt);
  }
  /** 带某个类的那几行的名字（比数 `querySelectorAll` 的条数好读，而且报得出是谁）。 */
  function marked(cls: string): string[] {
    return [...ui.explorerTree.querySelectorAll<HTMLElement>(`.${cls}`)].map(
      (el) => el.querySelector(".explorer-name")?.textContent ?? el.dataset.path ?? "?",
    );
  }
  const waitHover = (): Promise<void> => new Promise((r) => setTimeout(r, 750));

  it("每一行都可拖，根那一行不可（它没有父亲）；拖起来只交出自家 MIME", () => {
    expect(rowAt("a.md").draggable).toBe(true);
    expect(rowAt("notes").draggable, "目录同样可拖").toBe(true);
    expect(rowAt("笔记").draggable, "根那一行压根不设 draggable").toBe(false);

    const dt = start("a.md");
    expect(
      dt.types,
      "两条自家的，不带 text/plain：拖到窗口外不做，也不给编辑器留一份文本可插",
    ).toEqual([TREE_DRAG_MIME, TREE_DRAG_FILE_MIME]);
    expect(dt.getData(TREE_DRAG_MIME)).toBe(`${ROOT}\\a.md`);
    expect(dt.getData(TREE_DRAG_FILE_MIME), "文件才带这一条 ⇒ 面板区那一路才认领（B316-3）").toBe(
      `${ROOT}\\a.md`,
    );
    expect(dt.effectAllowed).toBe("move");
    expect(marked("explorer-dragging")).toEqual(["a.md"]);

    const dirDt = start("notes");
    expect(
      dirDt.types,
      "目录不带第二条：面板区没有「打开一个目录」这回事，它只能在树里挪一层",
    ).toEqual([TREE_DRAG_MIME]);
    expect(marked("explorer-dragging"), "源行高亮跟着换成目录那一行").toEqual(["notes"]);

    const ev = fireDrag("dragstart", rowAt("笔记"), makeDataTransfer());
    expect(ev.defaultPrevented, "根被野路子拖起来（程序里直接派发事件）时要拦下").toBe(true);
    expect(marked("explorer-dragging"), "根不参与，源行高亮还留在上一单那一条上").toEqual([
      "notes",
    ]);
  });

  it("落点 = 目录行：移进它；状态栏报一句，那一层里看得见搬进来的那条", async () => {
    const dt = start("a.md");
    const notes = rowAt("notes");
    expect(over("notes", dt).defaultPrevented, "能落 ⇒ 必须 preventDefault，否则收不到 drop").toBe(
      true,
    );
    expect(dt.dropEffect).toBe("move");
    expect(marked("explorer-drop-on")).toEqual(["notes"]);
    drop("notes", dt);
    await vi.waitFor(() => expect(h.moved).toEqual([[`${ROOT}\\a.md`, `${ROOT}\\notes`]]));
    const bar = document.getElementById("sb-message")!;
    // 状态栏那句要单独等：`h.moved` 在假实现里是**同步**记的，而报话那句排在整条
    // 刷新链（挪 → 刷两层 → 重绘）之后，拿它当「渲染完了」的信号会读到上一单的残留。
    await vi.waitFor(() => expect(bar.textContent).toContain("已移动 a.md"));
    expect(bar.classList.contains("sb-message-error")).toBe(false);
    expect(marked("explorer-dragging"), "松手就收摊").toEqual([]);

    await click(rowAt("notes"));
    await vi.waitFor(() => expect(names()).toContain("a.md"));
    expect(
      names().filter((n) => n === "a.md"),
      "根那一层里不该还留着一份",
    ).toHaveLength(1);
    expect(notes.isConnected, "树是被重绘的：判据不能攥着旧元素").toBe(false);
  });

  it("落点 = 文件行：移到那个文件所在的那一层（与新建/粘贴同一判据）", async () => {
    await click(rowAt("notes"));
    await vi.waitFor(() => expect(names()).toContain("deeper.md"));
    const dt = start("deeper.md");
    expect(over("b.md", dt).defaultPrevented, "落点是 b.md 所在那一层，不是 b.md 自己").toBe(true);
    drop("b.md", dt);
    // 按**层级**等：`deeper.md` 挪到根之前也在屏幕上（notes 是展开着的），
    // 拿「有没有这一行」当信号会立刻结算，然后读到一半重绘的树。
    await vi.waitFor(() => expect(rowAt("deeper.md").getAttribute("aria-level")).toBe("2"));
    expect(h.moved).toEqual([[`${ROOT}\\notes\\deeper.md`, ROOT]]);
    expect(
      names().filter((n) => n === "deeper.md"),
      "只该在根看见一次",
    ).toHaveLength(1);
  });

  it("落点 = 根那一行：移到根", async () => {
    await click(rowAt("notes"));
    await vi.waitFor(() => expect(names()).toContain("deeper.md"));
    const dt = start("deeper.md");
    expect(marked("explorer-drop-on"), "还没移动指针时没有落点").toEqual([]);
    expect(over("笔记", dt).defaultPrevented).toBe(true);
    expect(marked("explorer-drop-on")).toEqual(["笔记"]);
    drop("笔记", dt);
    await vi.waitFor(() => expect(h.moved).toEqual([[`${ROOT}\\notes\\deeper.md`, ROOT]]));
  });

  it("同层 = 空操作：不拦 dragover（于是光标显示禁止）、松手什么都不发", () => {
    const dt = start("a.md");
    expect(over("b.md", dt).defaultPrevented, "不 preventDefault = 默认那根禁止光标").toBe(false);
    expect(marked("explorer-drop-on")).toEqual([]);
    drop("b.md", dt);
    expect(h.moved).toEqual([]);

    const dir = start("notes");
    expect(over("a.md", dir).defaultPrevented, "目录挪到自己待着的那一层").toBe(false);
    drop("a.md", dir);
    expect(h.moved).toEqual([]);
  });

  it("拖到自己身上 / 拖进自己的子孙里 = 禁止光标、什么都不发", async () => {
    h.dirs.set(`${ROOT}\\notes`, [
      ["deeper.md", false],
      ["sub", true],
    ]);
    h.dirs.set(`${ROOT}\\notes\\sub`, [["x.md", false]]);
    await click(rowAt("notes"));
    await vi.waitFor(() => expect(names()).toContain("sub"));
    await click(rowAt("sub"));
    await vi.waitFor(() => expect(names()).toContain("x.md"));

    const dt = start("notes");
    expect(over("notes", dt).defaultPrevented, "落在自己身上").toBe(false);
    expect(over("sub", dt).defaultPrevented, "落在自己的直接子孙里").toBe(false);
    expect(
      over("x.md", dt).defaultPrevented,
      "落在孙子的文件上：落点是它父亲 sub，仍在自己里面",
    ).toBe(false);
    expect(marked("explorer-drop-on")).toEqual([]);
    drop("sub", dt);
    expect(h.moved).toEqual([]);
  });

  it("落在树里的空白处不算落点（更不当成「移到根」—— 那会把一次误操作变成一次真搬家）", () => {
    const dt = start("a.md");
    const ev = fireDrag("dragover", ui.explorerTree, dt);
    expect(ev.defaultPrevented).toBe(false);
    expect(drop("笔记", dt).type, "先确认落点确实没算上").toBe("drop");
    expect(marked("explorer-drop-on")).toEqual([]);
  });

  it("悬停在折叠的目录上约 0.6 秒自动摊开，两层高亮跟着重绘后的新行重贴", async () => {
    const dt = start("a.md");
    over("notes", dt);
    expect(store.isExpanded(`${ROOT}\\notes`), "刚到那一格不该立刻展开").toBe(false);
    await vi.waitFor(() => expect(store.isExpanded(`${ROOT}\\notes`)).toBe(true), {
      timeout: 2000,
    });
    expect(marked("explorer-dragging"), "重绘把源行换成了新元素，高亮得按路径重贴").toEqual([
      "a.md",
    ]);
    expect(marked("explorer-drop-on")).toEqual(["notes"]);
    expect(names()).toContain("deeper.md");
    // 摊开之后落点仍是那一层：同层判据要用**当下**的源目录，展开前后不能变成两套。
    drop("notes", dt);
    await vi.waitFor(() => expect(h.moved).toEqual([[`${ROOT}\\a.md`, `${ROOT}\\notes`]]));
  });

  it("同一行里挪一格不算离开（不然悬停展开的计时每帧被重置，永远等不到）", async () => {
    const dt = start("a.md");
    const notes = rowAt("notes");
    over("notes", dt);
    fireDrag("dragleave", notes.querySelector(".explorer-name")!, dt, {
      relatedTarget: notes.querySelector(".explorer-name"),
    });
    await vi.waitFor(() => expect(store.isExpanded(`${ROOT}\\notes`)).toBe(true), {
      timeout: 2000,
    });
  });

  it("离开落点那一行就取消排队中的展开；dragend 之后高亮与松手一并作废", async () => {
    const dt = start("a.md");
    over("notes", dt);
    leave("notes", dt, rowAt("b.md"));
    expect(marked("explorer-drop-on")).toEqual([]);
    await waitHover();
    expect(store.isExpanded(`${ROOT}\\notes`), "那一发悬停展开作废了").toBe(false);

    const dir = start("b.md");
    over("notes", dir);
    fireDrag("dragend", rowAt("notes"), dir);
    expect(marked("explorer-dragging")).toEqual([]);
    expect(marked("explorer-drop-on")).toEqual([]);
    await waitHover();
    expect(store.isExpanded(`${ROOT}\\notes`)).toBe(false);
    drop("notes", dir);
    expect(h.moved, "拖拽已经结束了，迟到的 drop 不该再搬一次家").toEqual([]);
  });

  it("外部文件拖过树时不抢：自家 MIME 不在载荷里，dragover / drop 一概不接手", () => {
    const mine = start("a.md");
    over("notes", mine);
    const files = makeDataTransfer(["Files"]);
    expect(fireDrag("dragover", rowAt("notes"), files).defaultPrevented).toBe(false);
    expect(fireDrag("drop", rowAt("notes"), files).defaultPrevented).toBe(false);
    expect(h.moved).toEqual([]);
    expect(marked("explorer-drop-on"), "外部那一下不该把已算好的落点高亮抢走").toEqual(["notes"]);
  });

  it("改名时从输入框里拖选文字，不是拖这一行", () => {
    rowAt("a.md").dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    const input = ui.explorerTree.querySelector<HTMLInputElement>(".explorer-input")!;
    const dt = makeDataTransfer();
    fireDrag("dragstart", input, dt);
    expect(dt.types, "没交出自家 MIME = 这次拖拽不是树发起的").toEqual([]);
    expect(marked("explorer-dragging")).toEqual([]);
    // 收掉改名态：`renaming` 是模块态，留着它下一单的 beforeEach 重绘时那一行会画成输入框，
    // 于是「树里有没有 a.md 这一行」永远等不到（B315 那几单是靠提交/Escape 自己收的）。
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  it("挪不动时：错误原样进状态栏（走错误色），树上不留一个搬了一半的样子", async () => {
    h.failOn.add("move");
    const dt = start("a.md");
    over("notes", dt);
    drop("notes", dt);
    const bar = document.getElementById("sb-message")!;
    await vi.waitFor(() => expect(bar.textContent).toContain("就在这层里"));
    expect(bar.classList.contains("sb-message-error"), "报错那条要走错误色").toBe(true);
    expect(names()).toContain("a.md");
    expect(marked("explorer-dragging")).toEqual([]);
  });
});

describe("B333 拖一条目录落到资源管理器那一块 = 打开这个文件夹", () => {
  /** 拖进来的那条：夹具「认得这一层」= `isDir` 该回真（假实现与 listDir 共用同一份账）。 */
  const OTHER = "E:\\工作\\报价";

  /** 命中测试替身：桥只回传坐标，所以「这一点落在哪块元素上」是这一发唯一的注入点。 */
  const overPanel = () => ui.explorerTree;
  const overEditor = () => document.createElement("div");

  beforeEach(() => {
    h.dirs.set(OTHER, [["x.md", false]]);
  });

  it("单条目录 + 落点在面板里 ⇒ 追加一根、摊开资源管理器、这一发算认领", async () => {
    drawer.setDrawer(null, false);

    const taken = await panel.claimExplorerDrop([OTHER], 10, 10, overPanel);

    expect(taken, "认领了就轮不到「当文件打开」那一路").toBe(true);
    expect(store.getRoots(), "B424：拖进来是**追加**，原来那根不许被换掉").toEqual([ROOT, OTHER]);
    expect(drawer.activeDrawer(), "VS Code 的口径：加完根要把资源管理器摊开").toBe("explorer");
    expect(h.opened, "目录不该被当成文件去读盘").toEqual([]);
    await vi.waitFor(() => expect(names()).toContain("x.md"));
  });

  it("落点不在那一块 ⇒ 不认领、根不动：瞄准的是编辑区，就该按开文件办", async () => {
    const taken = await panel.claimExplorerDrop([OTHER], 400, 300, overEditor);

    expect(taken).toBe(false);
    expect(theRoot(), "不该被拖到编辑区的目录悄悄换掉根").toBe(ROOT);
  });

  it("单条**文件**落到那一块 ⇒ 不认领：后端判假，交回原来那一路", async () => {
    const taken = await panel.claimExplorerDrop([`${ROOT}\\a.md`], 10, 10, overPanel);

    expect(taken).toBe(false);
    expect(theRoot()).toBe(ROOT);
  });

  it("一次拖进来好几条目录 ⇒ 全部追加（B424：多根了，不用替用户猜开哪一个）", async () => {
    const taken = await panel.claimExplorerDrop([OTHER, `${ROOT}\\notes`], 10, 10, overPanel);

    expect(taken).toBe(true);
    expect(store.getRoots()).toEqual([ROOT, OTHER, `${ROOT}\\notes`]);
  });

  it("目录混着文件 ⇒ 不认领：交回开文件那一路，那一路的行为是完整的", async () => {
    const taken = await panel.claimExplorerDrop([OTHER, `${ROOT}\\a.md`], 10, 10, overPanel);

    expect(taken).toBe(false);
    expect(store.getRoots(), "半认领 = 屏上多出一根谁也没打算开的目录").toEqual([ROOT]);
  });

  it("子窗口 ⇒ 不认领：它没有左边栏，落盘会把主窗口的根抹掉", async () => {
    const appState = await import("../src/core/app-state");
    appState.setWindowKind("satellite");
    try {
      const taken = await panel.claimExplorerDrop([OTHER], 10, 10, overPanel);
      expect(taken).toBe(false);
      expect(theRoot()).toBe(ROOT);
    } finally {
      appState.setWindowKind("main");
    }
  });

  it("拖拽悬停在那一块上时点亮它（松手之前唯一的反馈）", () => {
    panel.markExplorerDropHover(10, 10, overPanel);
    expect(ui.explorerPanel.classList.contains("is-drop-hover"), "悬停进来该亮").toBe(true);

    panel.markExplorerDropHover(400, 300, overEditor);
    expect(ui.explorerPanel.classList.contains("is-drop-hover"), "挪出那一块该灭").toBe(false);

    panel.markExplorerDropHover(10, 10, overPanel);
    panel.clearExplorerDropHover();
    expect(ui.explorerPanel.classList.contains("is-drop-hover"), "松手/拖出窗口该收干净").toBe(
      false,
    );
  });
});

describe("B331 关闭文件夹（B424 后 = 移除全部目录）", () => {
  it("点那颗 ⇒ 根清空、设置里那张表跟着清空、树回初屏", async () => {
    const appState = await import("../src/core/app-state");
    appState.setSettings({ folder_roots: [ROOT] } as never);
    expect(names(), "前置条件：这单是在「已经开着文件夹」的状态下开始的").toContain("a.md");

    await panel.closeFolder();

    expect(theRoot(), "根要真的清掉（不是只把树折叠起来）").toBe("");
    expect(appState.settings?.folder_roots, "设置里留着的还是旧根 ⇒ 下次启动又回放回来").toEqual(
      [],
    );
    await vi.waitFor(() =>
      expect(ui.explorerPanel.classList.contains("no-root"), "回初屏那颗整宽「打开文件夹」").toBe(
        true,
      ),
    );
  });

  it("子窗口里那颗什么都不做：它没有左边栏，落盘会把主窗口的根抹掉", async () => {
    const appState = await import("../src/core/app-state");
    appState.setSettings({ folder_roots: [ROOT] } as never);
    appState.setWindowKind("satellite");
    try {
      await panel.closeFolder();
      expect(theRoot(), "子窗口不许动根").toBe(ROOT);
      expect(appState.settings?.folder_roots, "更不许替主窗口写盘").toEqual([ROOT]);
    } finally {
      appState.setWindowKind("main");
    }
  });
});

describe("资源管理器折叠状态保存 / 恢复", () => {
  it("展开目录 ⇒ 设置里记下它；收起 ⇒ 从表里摘掉", async () => {
    const appState = await import("../src/core/app-state");
    appState.setSettings({ folder_roots: [ROOT] } as never);

    await click(rowAt("notes"));
    await vi.waitFor(() => expect(names()).toContain("deeper.md"));
    expect(appState.settings?.explorer_expanded, "展开的那一层要落进设置").toEqual([
      `${ROOT}\\notes`,
    ]);

    await click(rowAt("notes"));
    await vi.waitFor(() => expect(names()).not.toContain("deeper.md"));
    expect(appState.settings?.explorer_expanded, "收起后不许留旧值").toEqual([]);
  });

  it("收起根那一行 ⇒ 记进黑名单；再点开 ⇒ 摘掉", async () => {
    const appState = await import("../src/core/app-state");
    appState.setSettings({ folder_roots: [ROOT] } as never);
    const rootRow = (): HTMLElement => {
      const row = ui.explorerTree.querySelector<HTMLElement>(".explorer-root");
      if (!row) throw new Error("没有根那一行");
      return row;
    };

    await click(rootRow());
    await vi.waitFor(() => expect(names()).not.toContain("a.md"));
    expect(appState.settings?.explorer_collapsed_roots, "收起的根要落进黑名单").toEqual([ROOT]);

    await click(rootRow());
    await vi.waitFor(() => expect(names()).toContain("a.md"));
    expect(appState.settings?.explorer_collapsed_roots, "重新摊开就该出表").toEqual([]);
  });

  it("启动回放：展开表与根黑名单装回 store / 面板，且不回写设置", async () => {
    const appState = await import("../src/core/app-state");
    appState.setSettings({ folder_roots: [ROOT] } as never);
    const before = JSON.stringify(appState.settings);

    panel.restoreExplorerState([`${ROOT}\\notes`], []);
    await vi.waitFor(() => expect(names()).toContain("deeper.md"));
    expect(store.isExpanded(`${ROOT}\\notes`), "回放要真进 store（不只是画一层）").toBe(true);

    panel.restoreExplorerState([], [ROOT]);
    await vi.waitFor(() => expect(names()).not.toContain("a.md"));
    expect(store.isExpanded(`${ROOT}\\notes`), "回放是整表替换，旧的展开态要清掉").toBe(false);
    expect(JSON.stringify(appState.settings), "回放不是用户操作，不许顺手落盘").toBe(before);
  });
});

// B427 · 顶部按名字过滤（用户口径：全量匹配、结果仍树状、框内带排除 / 忽略 + 清除、框内 Esc 可清）。
// 这一组全部**经过真实的事件**（input / click / keydown）走一遍：`registerDrawerView` 与
// 各种 helper 只登记不接管点击，漏挂线只有这条路径照得出（B314-8 的教训）。
describe("B427 · 顶部过滤框", () => {
  const hit = (rel: string, isDir = false) => ({
    name: rel.split("/").pop() ?? rel,
    path: `${ROOT}\\${rel.split("/").join("\\")}`,
    rel,
    isDir,
  });

  function type(text: string): void {
    ui.explorerFilterInput.value = text;
    ui.explorerFilterInput.dispatchEvent(new Event("input"));
  }

  it("敲字 ⇒ 攒一小段就发一发，命中按树画（深层命中把祖先补出来）", async () => {
    h.filterHits.set(ROOT, [hit("notes/deeper.md")]);
    type("deep");
    await vi.waitFor(() => expect(h.filtered.length).toBe(1));
    expect(h.filtered[0].query).toBe("deep");
    expect(h.filtered[0].root).toBe(ROOT);
    expect(h.filtered[0].opts).toMatchObject({
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      useExcludes: true,
      useIgnoreFiles: true,
    });
    await vi.waitFor(() => expect(names()).toContain("deeper.md"));
    expect(names(), "祖先补出来了").toContain("notes");
    expect(h.calls, "过滤不读 list_dir（命中树是合成出来的）").not.toContain(`${ROOT}\\notes`);
  });

  it("点过滤结果里的文件 = 打开它（行是真能用的，不是贴图）", async () => {
    h.filterHits.set(ROOT, [hit("notes/deeper.md")]);
    type("deep");
    await vi.waitFor(() => expect(names()).toContain("deeper.md"));
    await click(rowAt("deeper.md"));
    expect(h.opened).toContain(`${ROOT}\\notes\\deeper.md`);
  });

  it("点目录收起 ⇒ 子孙藏掉；再点就回来（纯视图，不读盘）", async () => {
    h.filterHits.set(ROOT, [hit("notes/deeper.md")]);
    type("deep");
    await vi.waitFor(() => expect(names()).toContain("deeper.md"));
    await click(rowAt("notes"));
    expect(names(), "收起 notes 之后只剩它自己").toEqual(["笔记", "notes"]);
    await click(rowAt("notes"));
    expect(names()).toContain("deeper.md");
    expect(h.calls, "开合不读盘").not.toContain(`${ROOT}\\notes`);
  });

  it("三颗匹配开关点亮后，下一发查询带上开关（点一下就重跑）", async () => {
    h.filterHits.set(ROOT, [hit("notes/deeper.md")]);
    type("deep");
    await vi.waitFor(() => expect(h.filtered.length).toBe(1));
    await click(ui.explorerFilterCase);
    await vi.waitFor(() => expect(h.filtered.length).toBe(2));
    expect(h.filtered[1].opts).toMatchObject({ caseSensitive: true });
    expect(ui.explorerFilterCase.getAttribute("aria-pressed")).toBe("true");
    expect(ui.explorerFilterCase.classList.contains("on")).toBe(true);
    await click(ui.explorerFilterRegex);
    await vi.waitFor(() => expect(h.filtered.length).toBe(3));
    expect(h.filtered[2].opts).toMatchObject({ regex: true });
  });

  it("只剩「排除」一颗：关掉 = 排除设置与忽略文件一起关（用户点名去掉第二颗）", async () => {
    expect(
      document.querySelector("#explorer-filter-ignores"),
      "「跟随 .gitignore / .ignore」那颗已并进「使用排除设置与忽略文件」",
    ).toBeNull();
    h.filterHits.set(ROOT, []);
    type("deep");
    await vi.waitFor(() => expect(h.filtered.length).toBe(1));
    expect(h.filtered[0].opts).toMatchObject({ useExcludes: true, useIgnoreFiles: true });
    await click(ui.explorerFilterExcludes);
    await vi.waitFor(() => expect(h.filtered.length).toBe(2));
    expect(
      h.filtered[1].opts,
      "一颗键管两层：关掉时忽略文件也跟着停（不再有独立开关）",
    ).toMatchObject({ useExcludes: false, useIgnoreFiles: false });
  });

  it("设置里的搜索排除跟着「排除」那口总闸走（与侧栏搜索同一发）", async () => {
    // 按钮叫「使用排除设置与忽略文件」⇒ 设置页那串持久排除必须真被吃进来；
    // 侧栏搜索的同一发是 `mergeGlobs(useExcludes ? settings.search_exclude : "")`，
    // 这里只钉交给 Rust 的那一格，剪枝本身由 Rust 单测负责。
    const appState = await import("../src/core/app-state");
    appState.setSettings({ search_exclude: "*.log, excl" } as never);
    try {
      h.filterHits.set(ROOT, []);
      type("note");
      await vi.waitFor(() => expect(h.filtered.length).toBe(1));
      expect(h.filtered[0].opts).toMatchObject({
        exclude: "*.log, excl",
        useExcludes: true,
      });
      await click(ui.explorerFilterExcludes);
      await vi.waitFor(() => expect(h.filtered.length).toBe(2));
      expect(h.filtered[1].opts).toMatchObject({
        exclude: "",
        useExcludes: false,
        useIgnoreFiles: false,
      });
    } finally {
      appState.setSettings(null);
    }
  });

  it("Esc：有字先清字并回到常规树；没字那一下不吞掉", async () => {
    h.filterHits.set(ROOT, [hit("notes/deeper.md")]);
    type("deep");
    await vi.waitFor(() => expect(names()).toContain("deeper.md"));
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    ui.explorerFilterInput.dispatchEvent(ev);
    expect(ev.defaultPrevented, "有字 ⇒ 这一下归框管").toBe(true);
    expect(ui.explorerFilterInput.value).toBe("");
    await vi.waitFor(() => expect(names()).toContain("a.md"));
    const ev2 = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    ui.explorerFilterInput.dispatchEvent(ev2);
    expect(ev2.defaultPrevented, "空框上的 Esc 让给外层").toBe(false);
  });

  it("清除键：有字才显形，点一下清空并回到常规树", async () => {
    h.filterHits.set(ROOT, [hit("notes/deeper.md")]);
    expect(ui.explorerFilterClear.hidden).toBe(true);
    type("deep");
    await vi.waitFor(() => expect(names()).toContain("deeper.md"));
    expect(ui.explorerFilterClear.hidden).toBe(false);
    await click(ui.explorerFilterClear);
    expect(ui.explorerFilterInput.value).toBe("");
    expect(ui.explorerFilterClear.hidden).toBe(true);
    await vi.waitFor(() => expect(names()).toContain("a.md"));
  });

  it("没有命中就直说；正则写坏了把 Rust 那句原话贴出来", async () => {
    h.filterHits.set(ROOT, []);
    type("zzz");
    await vi.waitFor(() => expect(ui.explorerTree.textContent).toContain("没有匹配的名字"));
    h.filterFail = "正则无效：regex parse error";
    type("([");
    await vi.waitFor(() => expect(ui.explorerTree.textContent).toContain("过滤失败：正则无效"));
    h.filterFail = "";
  });

  it("两根都开着 ⇒ 每根各画一段（根行常驻，命中挂在各自根下）", async () => {
    const R2 = "D:\\另一根";
    h.dirs.set(R2, [["other.md", false]]);
    h.filterHits.set(ROOT, [hit("notes/deeper.md")]);
    h.filterHits.set(R2, [
      { name: "other.md", path: `${R2}\\other.md`, rel: "other.md", isDir: false },
    ]);
    openRoots(ROOT, R2);
    await vi.waitFor(() => expect(store.getRoots()).toHaveLength(2));
    type("deep");
    await vi.waitFor(() => expect(h.filtered.length).toBe(2));
    expect(h.filtered.map((f) => f.root).sort()).toEqual([R2, ROOT].sort());
    await vi.waitFor(() => expect(names()).toContain("deeper.md"));
    expect(names()).toContain("另一根");
  });

  it("过滤态里顶部「全部折叠」收的是命中树；再点一下全展开（图标/文案跟着换）", async () => {
    h.filterHits.set(ROOT, [hit("notes/deeper.md")]);
    type("deep");
    await vi.waitFor(() => expect(names()).toContain("deeper.md"));
    const foldLabel = (): string | null => ui.explorerCollapse.getAttribute("aria-label");
    expect(foldLabel(), "起手是「全部折叠」口径").toBe("全部折叠");

    await click(ui.explorerCollapse);
    expect(names(), "收起命中树里的目录 ⇒ 只剩根与顶层目录行").toEqual(["笔记", "notes"]);
    expect(foldLabel(), "已经全收 ⇒ 这颗键下一秒说的是「展开」").toBe("全部展开");
    expect(ui.explorerCollapse.getAttribute("aria-pressed")).toBe("true");

    await click(ui.explorerCollapse);
    expect(names(), "再点一下：命中行全回来").toContain("deeper.md");
    expect(foldLabel()).toBe("全部折叠");
    expect(ui.explorerCollapse.getAttribute("aria-pressed")).toBe("false");
  });

  it("命中里没有可折的目录 ⇒ 那颗键禁用（不做按下去没反应的死键）", async () => {
    // ⚠️ 不能拿 `a.md` 当命中：常规树里本来就有它，`waitFor(names().toContain("a.md"))`
    // 会立刻放行（还在常规态），断言就对着上一帧的按钮放空了。用一个只活在命中里的名字。
    h.filterHits.set(ROOT, [hit("only.md")]);
    type("only");
    await vi.waitFor(() => expect(names()).toContain("only.md"));
    expect(ui.explorerCollapse.disabled, "全是根级文件，没东西可折").toBe(true);

    // 回到常规树 ⇒ 有目录了，键要活过来；文案也回到「全部折叠」
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    ui.explorerFilterInput.dispatchEvent(ev);
    await vi.waitFor(() => expect(ui.explorerCollapse.disabled).toBe(false));
    expect(ui.explorerCollapse.getAttribute("aria-label")).toBe("全部折叠");
  });
});

describe("B462 · 资源管理器多选与「将已选择进行比较」", () => {
  const modClick = (el: Element, init: MouseEventInit): void => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init }));
  };

  const selected = (): string[] =>
    rows()
      .filter((r) => r.getAttribute("aria-selected") === "true")
      .map((r) => r.querySelector(".explorer-name")?.textContent ?? "");

  function menuEl(): HTMLElement {
    const el = document.querySelector<HTMLElement>(".popup-menu");
    if (!el) throw new Error("菜单没弹出来");
    return el;
  }

  function labels(): string[] {
    return [...menuEl().querySelectorAll<HTMLButtonElement>("button")].map(
      (b) => b.querySelector(".menu-label")?.textContent ?? "",
    );
  }

  async function rightClick(el: Element): Promise<void> {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 30, clientY: 40 }));
    await vi.waitFor(() => expect(document.querySelector(".popup-menu")).toBeTruthy());
  }

  async function pick(needle: string): Promise<void> {
    const btn = [...menuEl().querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      (b.querySelector(".menu-label")?.textContent ?? "").includes(needle),
    );
    if (!btn) throw new Error(`菜单里没有「${needle}」（现有：${labels().join(" / ")}）`);
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(true).toBe(true));
  }

  it("Ctrl+点击切换入组状态；普通点击把这一组收成一条", async () => {
    await click(rowAt("b.md"));
    expect(selected()).toEqual(["b.md"]);

    modClick(rowAt("a.md"), { ctrlKey: true });
    expect(selected(), "Ctrl 是把这一条**加**进组，不是换掉前面那条").toEqual(["b.md", "a.md"]);
    expect(h.opened, "多选手势只选不动：不顺手预览").toEqual([`${ROOT}\\b.md`]);

    modClick(rowAt("a.md"), { ctrlKey: true });
    expect(selected(), "再 Ctrl 点一下 = 从组里摘掉").toEqual(["b.md"]);

    await click(rowAt("a.md"));
    expect(selected(), "普通点击让整组塌成一条").toEqual(["a.md"]);
  });

  it("Shift+点击按可见顺序从锚点连选（锚点不随 Shift 移动，反向也能连）", async () => {
    await click(rowAt("b.md"));
    modClick(rowAt("a.md"), { shiftKey: true });
    expect(selected()).toEqual(["b.md", "a.md"]);

    modClick(rowAt("笔记"), { shiftKey: true });
    expect(selected(), "锚点还在 b.md ⇒ 反向连到根，a.md 被让出").toEqual([
      "笔记",
      "notes",
      "b.md",
    ]);
    expect(h.opened, "Shift 那一下同样不打开").toEqual([`${ROOT}\\b.md`]);
  });

  it("恰好两条文件：右键出现「将已选择进行比较」，左栏是选中顺序里的第一条", async () => {
    await click(rowAt("a.md"));
    modClick(rowAt("b.md"), { ctrlKey: true });
    await rightClick(rowAt("b.md"));
    expect(
      rowAt("b.md").getAttribute("aria-selected"),
      "右键组内那条不许把整组打散（否则这一项永远等不到右键）",
    ).toBe("true");
    expect(labels()).toContain("将已选择进行比较");

    await pick("将已选择进行比较");
    expect(h.diffs).toEqual([[`${ROOT}\\a.md`, `${ROOT}\\b.md`]]);

    // 反过来选：次序就是左右，不是文件名/盘上顺序
    await click(ui.explorerTree);
    await click(rowAt("b.md"));
    modClick(rowAt("a.md"), { ctrlKey: true });
    await rightClick(rowAt("a.md"));
    await pick("将已选择进行比较");
    expect(h.diffs[1]).toEqual([`${ROOT}\\b.md`, `${ROOT}\\a.md`]);
  });

  it("一条 / 三条 / 掺了目录：不给这一项（判据不成立就不出现）", async () => {
    await click(rowAt("a.md"));
    await rightClick(rowAt("a.md"));
    expect(labels()).not.toContain("将已选择进行比较");

    await click(ui.explorerTree);
    modClick(rowAt("a.md"), { ctrlKey: true });
    modClick(rowAt("b.md"), { ctrlKey: true });
    modClick(rowAt("notes"), { ctrlKey: true });
    await rightClick(rowAt("a.md"));
    expect(selected()).toHaveLength(3);
    expect(labels(), "三条里两条是文件也不给：整组不是两条").not.toContain("将已选择进行比较");

    await click(ui.explorerTree);
    await click(rowAt("notes"));
    modClick(rowAt("a.md"), { ctrlKey: true });
    await rightClick(rowAt("a.md"));
    expect(labels(), "目录没有正文可比").not.toContain("将已选择进行比较");
  });

  it("点空白清干净选中；切换目录把组收成新目录那一条", async () => {
    await click(rowAt("a.md"));
    modClick(rowAt("b.md"), { ctrlKey: true });
    expect(selected()).toHaveLength(2);

    await click(ui.explorerTree);
    expect(selected(), "点空白不许留下幽灵选中").toEqual([]);
    expect(rowAt("笔记").tabIndex, "清空后树仍要有个 tab 停靠点").toBe(0);

    await click(rowAt("a.md"));
    modClick(rowAt("b.md"), { ctrlKey: true });
    await click(rowAt("notes"));
    expect(selected()).toEqual(["notes"]);
  });

  it("删除后不留幽灵选中：同组剩下的那条接手，比较项随人数退场", async () => {
    await click(rowAt("a.md"));
    modClick(rowAt("b.md"), { ctrlKey: true });
    // 走右键：组内那一条被删时整组还在（键盘 Delete 会先把焦点行变成唯一选中，见 onTreeKey）。
    await rightClick(rowAt("b.md"));
    await pick("删除");
    await vi.waitFor(() => expect(h.deleted).toEqual([`${ROOT}\\b.md`]));

    expect(names()).not.toContain("b.md");
    expect(selected(), "焦点与选中一起收到剩下那条，不给一条不存在的路径留座").toEqual(["a.md"]);

    await rightClick(rowAt("a.md"));
    expect(labels(), "只剩一条，比较项退场").not.toContain("将已选择进行比较");
  });
});

// B429 · 用户点名：新建 / 刷新搬到根行右侧、悬停那行才显形；头部加一颗过滤开关。
describe("B429 · 过滤开关与根行动作组", () => {
  const onlyHit = { name: "only.md", path: `${ROOT}\\only.md`, rel: "only.md", isDir: false };

  it("头部搜索键开合过滤框：开时可直接敲字，收起时清空并回常规树", async () => {
    expect(ui.explorerFilter.hidden, "默认收起").toBe(true);
    expect(ui.explorerFilterToggle.getAttribute("aria-expanded")).toBe("false");
    await click(ui.explorerFilterToggle);
    expect(ui.explorerFilter.hidden).toBe(false);
    expect(ui.explorerFilterToggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement, "打开就让人能直接敲字").toBe(ui.explorerFilterInput);

    h.filterHits.set(ROOT, [onlyHit]);
    ui.explorerFilterInput.value = "only";
    ui.explorerFilterInput.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(names()).toContain("only.md"));
    expect(names(), "过滤生效：常规树里的 a.md 退场").not.toContain("a.md");

    await click(ui.explorerFilterToggle);
    expect(ui.explorerFilter.hidden, "再点一下收起").toBe(true);
    expect(ui.explorerFilterToggle.getAttribute("aria-expanded")).toBe("false");
    expect(ui.explorerFilterInput.value, "收起时清空，不留看不见的过滤").toBe("");
    await vi.waitFor(() => expect(names()).toContain("a.md"));
  });

  it("根行动作组：新建文件 → 新建目录 → 刷新，每根各一组", async () => {
    const 第二根 = "E:\\工作";
    h.dirs.set(第二根, [["q.md", false]]);
    openRoots(ROOT, 第二根);
    await vi.waitFor(() => expect(names()).toContain("q.md"));
    for (const root of [ROOT, 第二根]) {
      const row = rows().find((r) => r.dataset.path === root);
      const box = row?.querySelector(".explorer-root-actions");
      expect(box, `根「${root}」要有一组动作键`).not.toBeNull();
      const kinds = [...box!.querySelectorAll("button")].map((b) =>
        b.classList.contains("explorer-root-refresh") ? "refresh" : (b.dataset.kind ?? "?"),
      );
      expect(kinds, "刷新在最后（用户点名的位置）").toEqual(["file", "dir", "refresh"]);
    }
  });

  it("过滤态里点根行新建：先收起过滤，输入框才画得出来", async () => {
    h.filterHits.set(ROOT, [onlyHit]);
    await click(ui.explorerFilterToggle);
    ui.explorerFilterInput.value = "only";
    ui.explorerFilterInput.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(names()).toContain("only.md"));

    await click(rootAction(ROOT, "file"));
    expect(ui.explorerFilter.hidden, "新建要让位给常规树").toBe(true);
    expect(ui.explorerFilterInput.value).toBe("");
    const input = ui.explorerTree.querySelector<HTMLInputElement>(".explorer-input");
    expect(input, "过滤收起后输入框才画得出来").toBeTruthy();
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(ui.explorerTree.querySelector(".explorer-input")).toBeNull());
  });
});

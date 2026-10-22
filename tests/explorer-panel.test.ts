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
    saveSettings: () => Promise.resolve(),
  };
});

vi.mock("../src/io/files", () => ({
  doOpen: (path: string) => {
    h.opened.push(path);
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

beforeEach(async () => {
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
  store.setRoot("");
  await vi.waitFor(() => expect(ui.explorerTree.textContent).toContain("还没有打开文件夹"));
  store.setRoot(ROOT);
  await vi.waitFor(() => expect(names()).toContain("a.md"));
});

describe("B314 资源管理器面板", () => {
  it("装配：那颗键填了字形、登记进外壳、摊开时轮得到它", () => {
    expect(ui.sideExplorer.innerHTML, "按钮列那颗要有字形").toContain("codicon");
    expect(ui.explorerNewFile.innerHTML).toContain("codicon-new-file");
    expect(ui.explorerNewDir.innerHTML).toContain("codicon-new-folder");
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
    expect(dir.querySelector(".explorer-glyph")?.innerHTML).toContain("codicon-folder");
    const file = rowAt("a.md");
    expect(file.dataset.kind).toBe("file");
    expect(file.querySelector(".explorer-glyph")?.innerHTML).toContain("codicon-file");
    expect(file.getAttribute("aria-level"), "子项比根深一层").toBe("2");
  });

  it("点目录 = 展开并读那一层；再点 = 收起", async () => {
    await click(rowAt("notes"));
    expect(store.isExpanded(`${ROOT}\\notes`)).toBe(true);
    expect(names()).toContain("deeper.md");
    expect(h.calls, "展开时才读那一层").toContain(`${ROOT}\\notes`);
    expect(rowAt("notes").getAttribute("aria-expanded")).toBe("true");
    expect(rowAt("notes").querySelector(".explorer-glyph")?.innerHTML).toContain("folder-opened");

    await click(rowAt("notes"));
    expect(store.isExpanded(`${ROOT}\\notes`)).toBe(false);
    expect(names(), "收起后那一层的行不该还占着").not.toContain("deeper.md");
  });

  it("点文件 = 走 doOpen 那一扇漏斗（记入最近打开因此自动跟着生效）", async () => {
    await click(rowAt("a.md"));
    expect(h.opened).toEqual([`${ROOT}\\a.md`]);
  });

  it("没打开过文件夹时给一句提示加一颗入口键，点了走目录选择器", async () => {
    store.setRoot("");
    await vi.waitFor(() => expect(ui.explorerTree.textContent).toContain("还没有打开文件夹"));
    expect(store.getRoot(), "空串不该发一次注定失败的读盘").toBe("");
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
    await vi.waitFor(() => expect(store.getRoot()).toBe(ROOT));
    expect(names()).toContain("a.md");
    expect(ui.explorerPanel.classList.contains("no-root"), "有了根就得把那排放回来").toBe(false);
  });

  it("B327：打开键住在根那一行的最右，点它只换目录、不翻根行的面", async () => {
    const rootRow = rowAt("笔记");
    const btn = rootRow.querySelector<HTMLElement>("#explorer-open");
    expect(btn, "打开键该被挂进根目录那一行").toBeTruthy();
    const expandedBefore = rootRow.getAttribute("aria-expanded");

    // 目录选择器回**同一个**根：这样「根行有没有被翻一次面」才是唯一读得出来的东西。
    h.pick = ROOT;
    await click(btn!);
    await vi.waitFor(() => expect(store.getRoot()).toBe(ROOT));
    expect(
      rowAt("笔记").getAttribute("aria-expanded"),
      "树是委托点击 —— 没挡掉按钮的话，这一发会顺带把根折叠/展开一遍",
    ).toBe(expandedBefore);
  });

  it("刷新键重读展开着的层；全部折叠收掉子目录但留着根", async () => {
    await click(rowAt("notes"));
    h.calls.length = 0;
    await click(ui.explorerRefresh);
    await vi.waitFor(() => expect(h.calls).toContain(`${ROOT}\\notes`));

    await click(ui.explorerCollapse);
    expect(names(), "折叠之后只剩根与顶层").toEqual(["笔记", "notes", "b.md", "a.md"]);
    expect(store.expandedPaths()).toEqual([]);
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
    expect(rowAt(evil).title, "完整路径进 title").toBe(`${ROOT}\\${evil}`);
  });

  it("新建文件：输入框长在目标那一层，回车后建、刷那一层并打开", async () => {
    await click(rowAt("notes")); // 选中一个目录 ⇒ 新建的目标就是它
    await click(ui.explorerNewFile);
    const input = ui.explorerTree.querySelector<HTMLInputElement>(".explorer-input");
    expect(input, "没画出输入框").toBeTruthy();
    input!.value = "新笔记.md";
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() =>
      expect(h.created).toEqual([{ kind: "file", dir: `${ROOT}\\notes`, name: "新笔记.md" }]),
    );
    await vi.waitFor(() => expect(h.opened).toEqual([`${ROOT}\\notes\\新笔记.md`]));
    expect(ui.explorerTree.querySelector(".explorer-input"), "提交之后输入框要收掉").toBeNull();
  });

  it("新建态不该把同层其余条目一起藏掉（输入框排在该层最前）", async () => {
    await click(ui.explorerNewFile); // 什么都没选 ⇒ 建在根那一层
    const input = ui.explorerTree.querySelector<HTMLInputElement>(".explorer-input");
    expect(input, "没画出输入框").toBeTruthy();
    // 输入框长在 `is-creating` 那一行里，「同层」判据要问的是**那一行的父容器**
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
    // ⚠️ 必须收掉新建态再走：`creating` 是模块级状态，漏着它就会把后面每一条用例都画成新建态
    // （口径同本文件 F2 改名用例结尾那发 Escape）。
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(ui.explorerTree.querySelector(".explorer-input")).toBeNull());
  });

  it("空目录进入新建态：只画输入框，不再挂一条「（空）」", async () => {
    h.dirs.set(`${ROOT}\\notes`, []);
    await click(rowAt("notes"));
    await click(ui.explorerNewFile);
    const input = ui.explorerTree.querySelector<HTMLInputElement>(".explorer-input");
    expect(input, "空目录里也要画出输入框").toBeTruthy();
    expect(ui.explorerTree.textContent, "新建态下不该再挂「（空）」").not.toContain("（空）");
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(ui.explorerTree.querySelector(".explorer-input")).toBeNull());
  });

  it("新建目录走 createDir；空名字 = 取消，不发 IPC", async () => {
    await click(ui.explorerNewDir);
    const input = ui.explorerTree.querySelector<HTMLInputElement>(".explorer-input");
    expect(input, "什么都没选时该在根那一层建").toBeTruthy();
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
    expect(store.getRoot()).toBe(ROOT);
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
      "复制路径",
      "在资源管理器中显示",
    ]);
    expect(rowAt("a.md").getAttribute("aria-selected"), "菜单问的是「选中了谁」，得先选中").toBe(
      "true",
    );
    expect(menuItem("粘贴").disabled, "剪贴板空着，粘贴该是灰的").toBe(true);
    expect(menuItem("重命名").disabled, "快捷键提示挂在标签里（\\t 那一段）").toBe(false);
  });

  it("右键根那一行：改名 / 复制 / 删除都不给，换成刷新与全部折叠", async () => {
    await rightClick(rowAt("笔记"));
    const got = labels();
    expect(got, "根就是整棵树，删了面板就空了").not.toContain("删除");
    expect(got).not.toContain("重命名");
    expect(got).not.toContain("复制");
    expect(got).toContain("新建文件");
    expect(got).toContain("刷新");
    expect(got).toContain("全部折叠");
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
      relatedTarget: notes.querySelector(".explorer-glyph"),
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

  it("单条目录 + 落点在面板里 ⇒ 换根、摊开资源管理器、这一发算认领", async () => {
    drawer.setDrawer(null, false);

    const taken = await panel.claimExplorerDrop([OTHER], 10, 10, overPanel);

    expect(taken, "认领了就轮不到「当文件打开」那一路").toBe(true);
    expect(store.getRoot()).toBe(OTHER);
    expect(drawer.activeDrawer(), "VS Code 的口径：换完根要把资源管理器摊开").toBe("explorer");
    expect(h.opened, "目录不该被当成文件去读盘").toEqual([]);
    await vi.waitFor(() => expect(names()).toContain("x.md"));
  });

  it("落点不在那一块 ⇒ 不认领、根不动：瞄准的是编辑区，就该按开文件办", async () => {
    const taken = await panel.claimExplorerDrop([OTHER], 400, 300, overEditor);

    expect(taken).toBe(false);
    expect(store.getRoot(), "不该被拖到编辑区的目录悄悄换掉根").toBe(ROOT);
  });

  it("单条**文件**落到那一块 ⇒ 不认领：后端判假，交回原来那一路", async () => {
    const taken = await panel.claimExplorerDrop([`${ROOT}\\a.md`], 10, 10, overPanel);

    expect(taken).toBe(false);
    expect(store.getRoot()).toBe(ROOT);
  });

  it("一次拖进来好几条 ⇒ 不认领：换根只能有一个，不猜用户想开哪个", async () => {
    const taken = await panel.claimExplorerDrop([OTHER, `${ROOT}\\notes`], 10, 10, overPanel);

    expect(taken).toBe(false);
    expect(store.getRoot()).toBe(ROOT);
  });

  it("子窗口 ⇒ 不认领：它没有左边栏，落盘会把主窗口的根抹掉", async () => {
    const appState = await import("../src/core/app-state");
    appState.setWindowKind("satellite");
    try {
      const taken = await panel.claimExplorerDrop([OTHER], 10, 10, overPanel);
      expect(taken).toBe(false);
      expect(store.getRoot()).toBe(ROOT);
    } finally {
      appState.setWindowKind("main");
    }
  });
});

describe("B331 关闭文件夹", () => {
  it("点「关闭文件夹」⇒ 根清空、设置里那一格跟着清空、树回初屏", async () => {
    const appState = await import("../src/core/app-state");
    appState.setSettings({ folder_root: ROOT } as never);
    expect(names(), "前置条件：这单是在「已经开着文件夹」的状态下开始的").toContain("a.md");

    await panel.closeFolder();

    expect(store.getRoot(), "根要真的清掉（不是只把树折叠起来）").toBe("");
    expect(appState.settings?.folder_root, "设置里留着的还是旧根 ⇒ 下次启动又回放回来").toBe("");
    await vi.waitFor(() =>
      expect(ui.explorerPanel.classList.contains("no-root"), "回初屏那颗整宽「打开文件夹」").toBe(
        true,
      ),
    );
  });

  it("子窗口里那颗什么都不做：它没有左边栏，落盘会把主窗口的根抹掉", async () => {
    const appState = await import("../src/core/app-state");
    appState.setSettings({ folder_root: ROOT } as never);
    appState.setWindowKind("satellite");
    try {
      await panel.closeFolder();
      expect(store.getRoot(), "子窗口不许动根").toBe(ROOT);
      expect(appState.settings?.folder_root, "更不许替主窗口写盘").toBe(ROOT);
    } finally {
      appState.setWindowKind("main");
    }
  });
});

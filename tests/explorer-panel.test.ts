// @vitest-environment jsdom
// B314 · 资源管理器**面板**（`src/explorer/panel.ts`）。
//
// 用真实的 index.html 骨架跑（`#side-explorer` / `#explorer-panel` / `#explorer-tree` 必须真在），
// store 用**真身**（只假 `ipc/api` 与 `io/files`）：懒加载、展开态、代际作废那些是 store 的
// 职责，面板测试要钉的是「画对了、点下去走对了哪条路」，两边一起跑才测得到接缝。
// ⚠️ 静态 import 会抢在 `innerHTML` 之前把 `ui.ts` 的 `el()` 炸掉（口径同 recents-panel.test.ts）。
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const h = vi.hoisted(() => ({
  /** 目录路径 → 该回的那一层子项（`[名, 是不是目录]`）。 */
  dirs: new Map<string, [string, boolean][]>(),
  calls: [] as string[],
  opened: [] as string[],
  created: [] as { kind: string; dir: string; name: string }[],
  /** 「打开文件夹」对话框要回的东西。 */
  pick: null as string | null,
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

beforeAll(async () => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
  [panel, store, drawer, ui] = await Promise.all([
    import("../src/explorer/panel"),
    import("../src/explorer/store"),
    import("../src/shell/drawer"),
    import("../src/ui"),
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
  h.calls.length = 0;
  h.opened.length = 0;
  h.created.length = 0;
  h.pick = null;
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
    h.pick = ROOT;
    await click(btn!);
    await vi.waitFor(() => expect(store.getRoot()).toBe(ROOT));
    expect(names()).toContain("a.md");
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
});

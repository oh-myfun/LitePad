// @vitest-environment jsdom
// VS Code 的预览标签（preview tab）：
//   资源管理器**单击** → 开一张可复用的预览标签（斜体），下一次单击原位替换它；
//   **双击**文件 / 双击标签 / 编辑内容 → 转正（pin），之后不再被单击顶掉。
//
// 这条用例守住三件事：
//   ① 打开漏斗（doOpen）的 `{ preview: true }` 分支真的做到「同面板至多一张、原位替换」；
//   ② 标签条 `.tab-preview` 是斜体那条唯一的视觉来源；
//   ③ 转正的三条入口（永久打开命中已有实例 / 双击标签 / 编辑置脏）都真的清掉标记。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
});

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
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve({ unlisten: () => {} }),
  emit: () => Promise.resolve(),
  emitTo: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve({ unlisten: () => {} }),
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
  open: () => Promise.resolve(null),
  save: () => Promise.resolve(null),
}));

/** 每个路径一个稳定 tabId；第二次打开同一路径时 `reused: true`（与 Rust 侧同口径）。 */
const h = vi.hoisted(() => {
  const ids = new Map<string, number>();
  const mediaIds = new Map<string, number>();
  /** 目录清单（按路径给）：图片翻页只认这里面的条目，默认空目录。 */
  const dirs = new Map<
    string,
    { name: string; path: string; isDir: boolean; size: number; mtimeMs: number }[]
  >();
  let next = 100;
  let nextMedia = 900;
  const text = "第一行\n\n第二行\n";
  return {
    ids,
    mediaIds,
    dirs,
    openFile(path: string) {
      const key = path.replace(/\\/g, "/");
      const reused = ids.has(key);
      if (!reused) ids.set(key, next++);
      return Promise.resolve({
        tabId: ids.get(key)!,
        reused,
        text,
        name: key.split("/").pop() ?? key,
        path: key,
        encoding: "UTF-8",
        eol: "LF",
        readonly: false,
        mixedEol: false,
        sizeClass: "normal",
        sizeHint: "",
        mtimeMs: 1000,
        size: text.length,
        lossy: false,
      });
    },
    openMedia(path: string) {
      const key = path.replace(/\\/g, "/");
      const reused = mediaIds.has(key);
      if (!reused) mediaIds.set(key, nextMedia++);
      return Promise.resolve({
        tabId: mediaIds.get(key)!,
        reused,
        path: key,
        name: key.split("/").pop() ?? key,
        size: 8,
      });
    },
    listDir(path: string) {
      const key = path.replace(/\\/g, "/").replace(/\/$/, "");
      return Promise.resolve({ entries: dirs.get(key) ?? [], truncated: false });
    },
  };
});

vi.mock("../src/ipc/api", () => ({
  assocList: () => Promise.resolve([]),
  assocSet: (ext: string, on: boolean) =>
    Promise.resolve({ ext, registered: on, isDefault: false }),
  assocSetMany: (exts: string[], on: boolean) =>
    Promise.resolve(exts.map((ext) => ({ ext, registered: on, isDefault: false }))),
  assocOpenSystemSettings: () => Promise.resolve(),
  emitCrossWindow: vi.fn(async () => {}),
  convertFileSrc: (p: string) => `asset://${p}`,
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve([{ label: "UTF-8", group: "Unicode（统一码）" }]),
  listEols: () => Promise.resolve(["CRLF", "LF"]),
  listDir: h.listDir,
  loadSession: () =>
    Promise.resolve({
      activePanel: 0,
      panels: [
        {
          active: 0,
          tabs: [
            {
              path: "D:/seed.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 1,
              cursorCol: 1,
              viewMode: "source",
            },
          ],
        },
      ],
    }),
  loadSettings: () =>
    Promise.resolve({
      theme: "system",
      word_wrap: true,
      font_size: 14,
      default_encoding: "UTF-8",
      default_eol: "CRLF",
      autosave: false,
      hot_exit: false,
    }),
  logEvent: () => {},
  takePendingFiles: () => Promise.resolve([]),
  listRecents: () => Promise.resolve([]),
  getRecentLimit: () => Promise.resolve(50),
  noteOpenedPath: () => Promise.resolve(),
  newTab: () =>
    Promise.resolve({ tabId: 1, name: "未命名", readonly: false, encoding: "UTF-8", eol: "CRLF" }),
  openFile: h.openFile,
  openMedia: h.openMedia,
  reloadFile: () =>
    Promise.resolve({
      tabId: 1,
      text: "",
      name: "x",
      path: "x",
      encoding: "UTF-8",
      eol: "LF",
      readonly: false,
      mixedEol: false,
    }),
  saveFile: () => Promise.resolve({ lossy: [], path: "" }),
  savePasteImage: () => Promise.resolve(""),
  saveSession: () => Promise.resolve(),
  saveSettings: () => Promise.resolve(),
  writeBackup: () => Promise.resolve(),
  restoreBackup: () => Promise.resolve(null),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
}));

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tabEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll(".tab")) as HTMLElement[];
}
function names(): string[] {
  return tabEls().map((el) => el.querySelector(".tab-name")?.textContent ?? "");
}
function previewEl(): HTMLElement | null {
  return document.querySelector(".tab.tab-preview");
}
function view(): EditorView | undefined {
  return EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement) ?? undefined;
}
function mouse(type: string): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 5,
    clientY: 5,
    button: 0,
  });
}
function click(el: HTMLElement): void {
  el.dispatchEvent(mouse("mousedown"));
  el.dispatchEvent(mouse("click"));
}

let doOpen: typeof import("../src/io/files").doOpen;

describe("VS Code 预览标签", () => {
  beforeAll(async () => {
    ({ doOpen } = await import("../src/io/files"));
    await import("../src/main");
    await wait(300);
  });

  it("单击打开：新标签带 tab-preview（斜体），CSS 只此一处", async () => {
    await doOpen("D:/a.md", undefined, undefined, { preview: true });
    await wait(20);
    expect(names()).toEqual(["seed.md", "a.md"]);
    const el = previewEl();
    expect(el, "单击打开的标签应带 tab-preview").not.toBeNull();
    expect(el!.querySelector(".tab-name")!.textContent).toBe("a.md");
    expect(el!.classList.contains("tab-active"), "预览标签应被激活").toBe(true);

    const css = readFileSync("src/styles/global.css", "utf-8");
    expect(css, "预览标签的斜体必须由 .tab-preview .tab-name 提供").toMatch(
      /\.tab-preview \.tab-name\s*\{[^}]*font-style:\s*italic/,
    );
  });

  it("再单击另一个文件：原位复用同一张预览标签，不新开", async () => {
    await doOpen("D:/b.md", undefined, undefined, { preview: true });
    await wait(20);
    expect(names()).toEqual(["seed.md", "b.md"]);
    expect(tabEls().filter((el) => el.classList.contains("tab-preview"))).toHaveLength(1);
    expect(previewEl()!.querySelector(".tab-name")!.textContent).toBe("b.md");
  });

  it("永久打开（双击/回车那一路）不受影响，也不会顶掉预览标签", async () => {
    await doOpen("D:/c.md");
    await wait(20);
    expect(names()).toEqual(["seed.md", "b.md", "c.md"]);
    expect(previewEl()!.querySelector(".tab-name")!.textContent).toBe("b.md");
  });

  it("预览标签没在显示时也会被替换，且保留原来的位置", async () => {
    // 先激活 seed（b.md 变成「没在显示」的预览标签）
    click(tabEls()[0]);
    await wait(20);
    expect(document.querySelector(".tab.tab-active .tab-name")!.textContent).toBe("seed.md");

    await doOpen("D:/d.md", undefined, undefined, { preview: true });
    await wait(20);
    expect(names(), "d.md 必须占据 b.md 原来那一格").toEqual(["seed.md", "d.md", "c.md"]);
    expect(previewEl()!.querySelector(".tab-name")!.textContent).toBe("d.md");
    expect(previewEl()!.classList.contains("tab-active")).toBe(true);
  });

  it("双击标签 = 转正（单面板也要生效，不是最大化）", async () => {
    const el = previewEl()!;
    el.dispatchEvent(mouse("dblclick"));
    await wait(20);
    expect(previewEl(), "双击后不应再是预览标签").toBeNull();
    expect(names()).toEqual(["seed.md", "d.md", "c.md"]);
  });

  it("双击资源管理器那一发（永久打开）命中预览标签 ⇒ 转正而不是另开一张", async () => {
    await doOpen("D:/e.md", undefined, undefined, { preview: true });
    await wait(20);
    expect(previewEl()!.querySelector(".tab-name")!.textContent).toBe("e.md");
    const before = tabEls().length;

    await doOpen("D:/e.md");
    await wait(20);
    expect(tabEls().length, "不得多开一张同名标签").toBe(before);
    expect(previewEl(), "复用分支必须把它转正").toBeNull();
    expect(names()).toContain("e.md");
  });

  it("编辑预览文档 ⇒ 转正（避免下一次单击把未保存内容顶掉）", async () => {
    await doOpen("D:/f.md", undefined, undefined, { preview: true });
    await wait(20);
    expect(previewEl()!.querySelector(".tab-name")!.textContent).toBe("f.md");

    const v = view();
    expect(v, "预览标签应挂上编辑器").toBeTruthy();
    v!.dispatch({ changes: { from: 0, insert: "X" } });
    await wait(20);
    expect(previewEl(), "编辑置脏后必须清掉预览态").toBeNull();
  });

  it("转正之后，下一次单击另开一张预览标签（不再复用旧的）", async () => {
    const before = tabEls().length;
    await doOpen("D:/g.md", undefined, undefined, { preview: true });
    await wait(20);
    expect(tabEls().length).toBe(before + 1);
    expect(previewEl()!.querySelector(".tab-name")!.textContent).toBe("g.md");
    expect(names()).toContain("f.md");
  });

  it("打开别的文件不重建面板树：媒体面 / 编辑器 / 宿主节点都原样保留（防图片闪一下）", async () => {
    const host = document.querySelector(".panel-host");
    const cm = document.querySelector(".cm-editor");
    // 图片先开成一张标签：它的媒体面挂在面板里。
    await doOpen("D:/pic.png", undefined, undefined, { preview: true });
    await wait(20);
    expect(document.querySelector(".panel-host"), "打开图片不该重建面板宿主").toBe(host);
    expect(document.querySelector(".cm-editor"), "打开图片不该重建编辑器").toBe(cm);
    const face = document.querySelector(".media-preview");
    expect(face, "图片标签应挂出媒体面").not.toBeNull();

    // 再打开一份文本（永久标签）：只是换前台标签，不该把面板树连媒体面一起拆了重挂。
    await doOpen("D:/h.md");
    await wait(20);
    expect(names()).toContain("h.md");
    expect(document.querySelector(".media-preview"), "媒体面节点必须是原来那颗").toBe(face);
    expect(document.querySelector(".panel-host"), "面板宿主节点不该重建").toBe(host);
    expect(document.querySelector(".cm-editor"), "编辑器 DOM 不该重建").toBe(cm);
  });

  it("单击图片后再单击文本：替换预览标签不得把旧视图状态写进新标签", async () => {
    // 真机症状：预览标签从图片换成文本后，编辑区一片空白、状态栏 0 个字符。
    // 根因是 `switchTab` 在 `viewTabId` 已为 null（旧预览标签刚被 `takePreviewSlot` 摘掉）
    // 时回落到 `activeTabId` 找旧快照 —— 而它早已被 `attachTabToPanel` 指到新标签，
    // 等于拿旧视图的空媒体状态盖掉新标签刚建好的正文。
    await doOpen("D:/swap.png", undefined, undefined, { preview: true });
    await wait(20);
    expect(previewEl()!.querySelector(".tab-name")!.textContent).toBe("swap.png");
    expect(document.querySelector(".media-preview"), "图片标签应挂出媒体面").not.toBeNull();

    await doOpen("D:/swap.md", undefined, undefined, { preview: true });
    await wait(20);
    expect(previewEl()!.querySelector(".tab-name")!.textContent).toBe("swap.md");
    const v = view();
    expect(v, "文本标签应挂上编辑器").toBeTruthy();
    expect(v!.state.doc.toString(), "换进来的文本标签必须是它自己的正文").toBe(
      "第一行\n\n第二行\n",
    );
    expect(document.querySelector(".media-preview"), "被替换的媒体面应已拆除").toBeNull();
  });

  it("会话记录带上预览标记（preview 是落盘的显式一格）", async () => {
    const { sessionStore } = await import("../src/session/store");
    sessionStore.reset();
    sessionStore.register(501, 501, { path: "D:/x.md" });
    sessionStore.setPanel(1, [501], 501);
    sessionStore.setPreview(501, true);
    const state = sessionStore.toSessionState(() => true);
    expect(state.panels[0].tabs[0].preview).toBe(true);

    sessionStore.setPreview(501, false);
    const off = sessionStore.toSessionState(() => true);
    expect(off.panels[0].tabs[0].preview).toBe(false);
  });
});

describe("图片预览的同目录翻页（行为）", () => {
  const entry = (name: string) => ({
    name,
    path: `D:/album/${name}`,
    isDir: false,
    size: 1,
    mtimeMs: 0,
  });

  /** 按路径找**标签实例** id（`openSiblingImage` 收的是标签 id，不是文档 id）。 */
  async function tabIdOf(path: string): Promise<number> {
    const { tabs, docs } = await import("../src/core/app-state");
    const found = [...tabs.values()].find((t) => docs.get(t.docId)?.path === path);
    if (!found) throw new Error(`找不到标签：${path}`);
    return found.tabId;
  }

  beforeAll(() => {
    h.dirs.set("D:/album", [
      { name: "sub", path: "D:/album/sub", isDir: true, size: 0, mtimeMs: 0 },
      entry("a.png"),
      entry("b.png"),
      entry("c.png"),
      entry("d.png"),
      entry("clip.mp4"),
      entry("notes.txt"),
    ]);
  });

  it("预览标签原位换成下一张：不新增标签、位置不变、预览态跟着走", async () => {
    const { openSiblingImage } = await import("../src/io/files");
    await doOpen("D:/album/b.png", undefined, undefined, { preview: true });
    await wait(20);
    const at = names().indexOf("b.png");
    expect(at, "b.png 应作为预览标签打开").toBeGreaterThan(-1);
    const total = tabEls().length;
    const bId = await tabIdOf("D:/album/b.png");

    expect(await openSiblingImage(bId, 1), "b 的下一张是 c（跳过 mp4 / txt / 目录）").toBe(true);
    await wait(40);
    expect(tabEls().length, "翻页不得新增标签").toBe(total);
    expect(names().indexOf("c.png"), "c.png 必须接替 b.png 那一格").toBe(at);
    expect(previewEl()?.querySelector(".tab-name")?.textContent, "预览态跟着翻页").toBe("c.png");

    const dId = await (async () => {
      expect(await openSiblingImage(await tabIdOf("D:/album/c.png"), 1)).toBe(true);
      await wait(40);
      return tabIdOf("D:/album/d.png");
    })();
    expect(names().indexOf("d.png"), "继续往右仍占同一格").toBe(at);
    expect(await openSiblingImage(dId, 1), "最后一张没有下一张（不轮播）").toBe(false);
  });

  it("固定标签翻页后仍是固定标签；第一张没有上一张", async () => {
    const { openSiblingImage } = await import("../src/io/files");
    await doOpen("D:/album/a.png");
    await wait(20);
    const at = names().indexOf("a.png");
    expect(at).toBeGreaterThan(-1);
    const aId = await tabIdOf("D:/album/a.png");
    expect(await openSiblingImage(aId, -1), "第一张没有上一张").toBe(false);

    expect(await openSiblingImage(aId, 1)).toBe(true);
    await wait(40);
    const active = document.querySelector(".tab.tab-active");
    expect(active?.querySelector(".tab-name")?.textContent).toBe("b.png");
    expect(active?.classList.contains("tab-preview"), "固定标签翻页不得变成预览").toBe(false);
    expect(names().indexOf("b.png"), "仍要接替 a.png 那一格").toBe(at);
  });
});

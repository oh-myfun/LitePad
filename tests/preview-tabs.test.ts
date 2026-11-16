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
  let next = 100;
  const text = "第一行\n\n第二行\n";
  return {
    ids,
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

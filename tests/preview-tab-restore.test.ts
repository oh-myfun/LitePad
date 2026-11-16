// @vitest-environment jsdom
// 预览标签的**会话往返**：退出前是斜体的那一张，重启后必须还是斜体
// （下一次单击仍会原位替换它），而不是悄悄变成永久标签。
//
// 与 `preview-tabs.test.ts` 分开两个文件，是因为 `loadSession` 的盘上内容
// 只在模块首次加载时读一次 —— 恢复口径必须在「启动那一刻就带着 preview 键」
// 的场景里单独验一遍。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

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

const h = vi.hoisted(() => {
  const ids = new Map<string, number>();
  let next = 200;
  const text = "# 标题\n\n正文\n";
  return {
    openFile(path: string) {
      const key = path.replace(/\\/g, "/");
      if (!ids.has(key)) ids.set(key, next++);
      return Promise.resolve({
        tabId: ids.get(key)!,
        reused: false,
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
  // 盘上：第一张是永久标签，第二张是上次单击打开、还没转正的预览标签。
  loadSession: () =>
    Promise.resolve({
      activePanel: 0,
      panels: [
        {
          active: 0,
          tabs: [
            {
              path: "D:/pinned.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 1,
              cursorCol: 1,
              viewMode: "source",
              preview: false,
            },
            {
              path: "D:/preview.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 1,
              cursorCol: 1,
              viewMode: "source",
              preview: true,
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

describe("预览标签的会话恢复", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(300);
  });

  it("盘上带 preview 的那一张恢复成斜体预览标签，另一张保持永久", () => {
    const tabs = Array.from(document.querySelectorAll(".tab")) as HTMLElement[];
    expect(tabs.map((el) => el.querySelector(".tab-name")?.textContent)).toEqual([
      "pinned.md",
      "preview.md",
    ]);
    expect(tabs[0].classList.contains("tab-preview"), "永久标签不许变斜体").toBe(false);
    expect(tabs[1].classList.contains("tab-preview"), "预览标签重启后仍是斜体").toBe(true);
  });
});

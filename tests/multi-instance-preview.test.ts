// @vitest-environment jsdom
// B130 · **同一个文件在窗口里打开多个实例**（有的看代码、有的看预览），重新打开后
// 必须各回各的：既不能全变成「只剩代码」，也不能两个实例共用同一份光标/视口。
//
// 这条用例盯的是「同源多实例」这条最刁的分支：会话里会有多条记录指向同一个
// path，恢复时只能读一次盘（restoredCache 按身份去重），于是「文档只有一份、
// 实例各有各的」——每个实例的光标、视口、**视图模式**都得是自己的。
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

/** 同一个 note.md 的两个实例：一个看代码、一个看预览。 */
const CURSOR = { source: 6, preview: 14 } as const;

vi.mock("../src/ipc/api", () => ({
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve(["UTF-8"]),
  listEols: () => Promise.resolve(["CRLF", "LF"]),
  loadSession: () =>
    Promise.resolve({
      activePanel: 0,
      panels: [
        {
          // active = 1 ⇒ 活动那个是**预览**实例
          active: 1,
          tabs: [
            {
              path: "note.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 6,
              cursorCol: 1,
              scrollTop: 100,
              viewMode: "source",
            },
            {
              path: "note.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 14,
              cursorCol: 1,
              scrollTop: 300,
              viewMode: "preview",
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
  newTab: () =>
    Promise.resolve({ tabId: 1, name: "未命名", readonly: false, encoding: "UTF-8", eol: "CRLF" }),
  openFile: (path: string) =>
    Promise.resolve({
      tabId: 0,
      text: Array.from({ length: 40 }, (_, i) => `# 标题 ${i + 1}\n\n正文第 ${i + 1} 段。`).join(
        "\n\n",
      ),
      name: path,
      path,
      encoding: "UTF-8",
      eol: "LF",
      readonly: false,
      mixedEol: false,
      sizeClass: "normal",
      sizeHint: "",
    }),
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

function installRectStubs(): () => void {
  const origRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const mk = (left: number, top: number, w: number, h: number) =>
      ({
        left,
        top,
        right: left + w,
        bottom: top + h,
        width: w,
        height: h,
        x: left,
        y: top,
        toJSON() {},
      }) as DOMRect;
    if (this.classList.contains("layout-panel")) {
      const idx = Array.from(document.querySelectorAll(".layout-panel")).indexOf(this);
      return mk(Math.max(0, idx) * 210, 0, 200, 200);
    }
    if (this.classList.contains("panel-tabstrip")) {
      const panel = this.closest(".layout-panel");
      const idx = panel ? Array.from(document.querySelectorAll(".layout-panel")).indexOf(panel) : 0;
      return mk(Math.max(0, idx) * 210, 0, 200, 24);
    }
    if (this.classList.contains("tab")) return mk(0, 0, 20, 24);
    return mk(0, 0, 200, 200);
  };
  return () => {
    Element.prototype.getBoundingClientRect = origRect;
  };
}
installRectStubs();

function host(): HTMLElement {
  return document.querySelector(".panel-host") as HTMLElement;
}
function view(): EditorView | undefined {
  return EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement);
}
function previewRoot(): HTMLElement | null {
  return document.querySelector(".md-preview") as HTMLElement | null;
}
function tabEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll(".tab")) as HTMLElement[];
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
function clickTab(el: HTMLElement): void {
  el.dispatchEvent(mouse("mousedown"));
  el.dispatchEvent(mouse("click"));
}
function cursorLine(): number {
  const head = view()!.state.selection.main.head;
  return view()!.state.doc.lineAt(head).number;
}

describe("B130 同源多实例：代码 / 预览各自回各的", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(300);
  });

  it("恢复后两个实例都还在（不是一个顶掉另一个）", () => {
    expect(tabEls().length, "同一个文件应有两个标签实例").toBe(2);
  });

  it("活动实例是预览 ⇒ 面板就是预览态，不是「只剩代码」", () => {
    const h = host();
    expect(
      h.classList.contains("mode-preview"),
      `活动实例应回到预览态，实际 class=${h.className}`,
    ).toBe(true);
    expect(h.classList.contains("mode-source")).toBe(false);
    // 预览容器得真有内容（渲染过），不能是个空壳
    const pv = previewRoot();
    expect(pv, "应渲染出预览容器").toBeTruthy();
    expect(pv!.textContent ?? "", "预览里应有渲染出来的正文").toContain("正文第");
  });

  it("切到看代码的那个实例：回到源码态，且光标是它自己的那一行", async () => {
    clickTab(tabEls()[0]);
    await wait(60);
    expect(host().classList.contains("mode-source"), "这个实例应是源码态").toBe(true);
    expect(cursorLine(), "源码实例的光标应是第 6 行").toBe(CURSOR.source);
  });

  it("切回预览实例：又变回预览，光标与视口也都是它自己的", async () => {
    clickTab(tabEls()[1]);
    await wait(60);
    expect(host().classList.contains("mode-preview"), "应回到预览态").toBe(true);
    expect(cursorLine(), "预览实例的光标应是第 14 行").toBe(CURSOR.preview);
    expect(previewRoot()!.scrollTop, "预览实例的视口应是自己的 300").toBe(300);
  });
});

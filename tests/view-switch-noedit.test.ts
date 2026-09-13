// @vitest-environment jsdom
// 用户反馈：只是切换 Markdown 预览/源码，或者点击一下内容区，不应该改动文件内容。
// 本文件用真实的 bootstrap 校验三条不变量：
//   1) 移动光标 / 点击内容区 → 不置脏、不写盘；
//   2) 文本完全等价的事务（docChanged 但前后文本一致）→ 不置脏、不写盘；
//   3) 切换 源码/预览 → 内容不变、不置脏、不写盘；
//   4) 真正的编辑 → 置脏并在防抖后自动保存（保证修复没有把正常保存也堵死）。
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
  // matchMedia / requestAnimationFrame / Range.getClientRects 等 jsdom 贴片
  // 已统一到 tests/setup.ts（vite.config.ts 的 test.setupFiles），不再各文件重复。
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTitle: () => Promise.resolve(),
    onCloseRequested: () => Promise.resolve({ catch: () => {} }),
    close: () => Promise.resolve(),
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve({ unlisten: () => {} }) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve({ unlisten: () => {} }) }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
  open: () => Promise.resolve(null),
  save: () => Promise.resolve(null),
}));

const saved: unknown[] = [];
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
          active: 0,
          tabs: [
            { path: "a.md", encoding: "UTF-8", viewMode: "source", cursorLine: 1, cursorCol: 1 },
          ],
        },
      ],
    }),
  loadSettings: () =>
    Promise.resolve({
      theme: "light",
      word_wrap: true,
      font_size: 14,
      default_encoding: "UTF-8",
      default_eol: "CRLF",
      autosave: true,
      toc_width: 240,
      preview_line_height: 1.7,
    }),
  logEvent: () => {},
  newTab: () =>
    Promise.resolve({ tabId: 1, name: "未命名", readonly: false, encoding: "UTF-8", eol: "CRLF" }),
  openFile: (p: string) =>
    Promise.resolve({
      tabId: 101,
      text: "# Title\n\nhello world\n\nsecond line\n",
      name: p,
      path: p,
      encoding: "UTF-8",
      eol: "LF",
      readonly: false,
      mixedEol: false,
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
  saveFile: (args: unknown) => {
    saved.push(args);
    return Promise.resolve({ lossy: [], path: "" });
  },
  savePasteImage: () => Promise.resolve(""),
  saveSession: () => Promise.resolve(),
  saveSettings: () => Promise.resolve(),
}));

const dirty = (): boolean =>
  Array.from(document.querySelectorAll(".tab-mark")).some((m) =>
    (m.textContent ?? "").includes("●"),
  );

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("切换视图 / 点击内容区不得改动文件", () => {
  it("移动光标、点击内容区、文本等价事务都不置脏也不写盘；真实编辑才会", async () => {
    await import("../src/main");
    await wait(300);
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
    const before = view.state.doc.toString();
    expect(dirty(), "初始不应有脏标记").toBe(false);
    expect(saved.length, "初始不应写盘").toBe(0);

    // ---- 1) 点击内容区（mousedown + 选区变化）----
    const content = document.querySelector(".cm-content") as HTMLElement;
    content.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, clientX: 10, clientY: 10, button: 0 }),
    );
    view.dispatch({ selection: { anchor: 3 } });
    await wait(200);
    expect(dirty(), "点击/移动光标不得置脏").toBe(false);
    expect(saved.length, "点击/移动光标不得写盘").toBe(0);

    // ---- 2) 文本完全等价的事务（docChanged 但内容一致）----
    const same = view.state.doc.sliceString(0, 5);
    view.dispatch({ changes: { from: 0, to: 5, insert: same } });
    await wait(200);
    expect(view.state.doc.toString(), "文本应保持一致").toBe(before);
    expect(dirty(), "文本等价事务不得置脏").toBe(false);
    expect(saved.length, "文本等价事务不得写盘").toBe(0);

    // ---- 3) 切换 源码/预览 两次 ----
    for (let i = 0; i < 2; i++) {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "/", ctrlKey: true, bubbles: true, cancelable: true }),
      );
      await wait(120);
    }
    expect(view.state.doc.toString(), "切换视图后内容必须原样保留").toBe(before);
    expect(dirty(), "切换视图不得置脏").toBe(false);
    expect(saved.length, "切换视图不得写盘").toBe(0);

    // ---- 4) 真正的编辑：应置脏并自动保存（证明没有误伤正常保存）----
    view.dispatch({ changes: { from: 0, insert: "X" } });
    await wait(50);
    expect(dirty(), "真实编辑必须置脏").toBe(true);
    await wait(1800);
    expect(saved.length, "真实编辑应触发自动保存").toBeGreaterThan(0);
  });
});

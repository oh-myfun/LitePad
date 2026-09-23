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
    // B97 自建标题栏：最大化键的图标要跟着窗口状态走，桩必须补这两个 API
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    // B99「钉在顶部」：给「未置顶」的最小实现。缺了这两条，isAlwaysOnTop 会抛错并被
    // refreshPinButton 的 catch 吞掉 —— 用例照样绿，但那是**静默降级**，不是健康。
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
  // ---- B68 热退出（桩必须覆盖主模块真实 import 的每个符号，
  //      否则缺的那个调用会抛 TypeError 把 bootstrap 打断）----
  writeBackup: () => Promise.resolve(),
  restoreBackup: () => Promise.resolve(null),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
}));

// B57 起 ● 是矢量字形且槽位恒定存在（靠 opacity 显隐），脏状态改看 tab-dirty 类。
const dirty = (): boolean =>
  Array.from(document.querySelectorAll(".tab.tab-dirty")).some(
    (t) => t.querySelector(".tab-mark i.codicon") !== null,
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

describe("非编辑操作不得改动文件（静态契约）", () => {
  it("非编辑操作不得改动文件：只有文本真变化才置脏/写盘（用户要求）", () => {
    // 用户反馈：切换 Markdown 预览/源码、或点击内容区，不应该改变文件内容。
    // 根因防线有三条，缺一条就会"没编辑却被自动保存改写磁盘文件"：
    const src = readFileSync("src/main.ts", "utf-8");
    const handler = src.match(/function handleUpdate\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(handler, "应有 handleUpdate").toBeTruthy();
    // ① docChanged 不等于"内容变了"——要比较前后文本
    expect(handler, "必须比较事务前后文本").toContain("const textChanged =");
    // ② 自动保存/热退出备份只能在内容真的变化时排程（单纯移动光标不写盘）。
    //    B68 起两者并排成块，但**都**必须在 `textChanged && !suppressDirty` 门控内：
    //    热退出写的是副本，若跟着任意事务走，切换视图/点击内容区也会每 1s 写一次盘。
    expect(handler, "必须有 textChanged 门控").toContain("if (textChanged && !suppressDirty) {");
    const gated = handler.slice(handler.indexOf("if (textChanged && !suppressDirty) {"));
    expect(gated, "自动保存必须在门控分支里").toContain("scheduleAutosave();");
    expect(gated, "热退出备份也必须在门控分支里").toContain("scheduleBackup();");
    expect(handler, "选区变化不应触发自动保存").not.toContain(
      "if (!suppressDirty) {\n    scheduleAutosave();",
    );
    // ③ 切换视图隐藏/恢复编辑器时 CM6 可能产生事务——整个切换过程抑制置脏
    const toggle = src.match(/function toggleViewMode\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(toggle, "切换视图必须抑制置脏").toContain("suppressDirty = true;");
  });
});

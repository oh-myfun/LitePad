// @vitest-environment jsdom
// B112：脏标记由「内容是否偏离基线」**算**出来，而不是「一改过就永远脏」。
//
// 用户反馈：编辑或撤销刚好回到修改前状态，就不该再显示「待保存」（标签上的 ●）。
// 老逻辑是 `if (textChanged && !doc.dirty) doc.dirty = true` —— 只要内容动过一次，
// ● 就再也摘不掉，撤销回原样也照样是「未保存」，关窗还要弹确认框、自动保存还要
// 把一字未改的内容再写一次盘。
//
// 这里用**真实的 bootstrap + 真实的 CodeMirror 撤销栈**跑三条：
//   1) 编辑 → 置脏（正常编辑仍然必须提醒，基线的引入不能把它弄丢）；
//   2) 撤销回原样 → 转回不脏（用户诉求本身）；
//   3) 改了又手动改回原文 → 同样转回不脏（不是只认 undo 命令）。
// ⚠️ 桩里刻意关掉自动保存：本文件只验「脏不脏」，写盘时机归 view-switch-noedit 那一份。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { stripLineComments } from "./static";

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
      // 关掉自动保存：本文件只验脏标记，写盘时机不在这里掺和
      autosave: false,
      toc_width: 240,
      preview_line_height: 1.7,
    }),
  logEvent: () => {},
  newTab: () =>
    Promise.resolve({ tabId: 1, name: "未命名", readonly: false, encoding: "UTF-8", eol: "CRLF" }),
  openFile: (p: string) =>
    Promise.resolve({
      tabId: 101,
      text: "# Title\n\nhello world\n",
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

describe("B112 内容回到修改前状态就不该再是待保存", () => {
  it("编辑置脏 → 撤销回原样转回不脏 → 手动改回原文同样转回不脏", async () => {
    await import("../src/main");
    await wait(300);
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
    const origin = view.state.doc.toString();
    expect(origin, "应打开到桩里那份内容").toContain("hello world");
    expect(dirty(), "刚打开不应有脏标记").toBe(false);

    // ---- 1) 真实编辑：必须置脏（基线不能把正常提醒弄丢）----
    view.dispatch({ changes: { from: 0, insert: "X" } });
    await wait(60);
    expect(view.state.doc.toString(), "应确实改了内容").toBe("X" + origin);
    expect(dirty(), "真实编辑必须置脏").toBe(true);

    // ---- 2) 撤销回原样（真实 CM6 撤销栈，不是手工 dispatch）----
    undo(view);
    await wait(60);
    expect(view.state.doc.toString(), "撤销后内容应回到原样").toBe(origin);
    expect(dirty(), "撤销回到修改前状态就不该再显示待保存").toBe(false);

    // ---- 3) 改了又手动改回原文（同一内容、不同路径）----
    view.dispatch({ changes: { from: 0, to: origin.length, insert: origin.slice(1) } });
    await wait(60);
    expect(dirty(), "内容偏离了就得置脏").toBe(true);
    view.dispatch({ changes: { from: 0, insert: origin.charAt(0) } });
    await wait(60);
    expect(view.state.doc.toString(), "应回到原文").toBe(origin);
    expect(dirty(), "改回原文同样不该再显示待保存").toBe(false);

    expect(saved.length, "全程不写盘（自动保存已关）").toBe(0);
  });

  it("编辑后偏离再编辑回来，长度不变但内容不同的中间态仍是脏", async () => {
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
    const origin = view.state.doc.toString();
    expect(dirty(), "用例起点应是不脏").toBe(false);

    // 等长替换：长度相同、内容不同 —— 这是「先比长度」那条捷径最容易漏的情形
    const head = origin.slice(0, 1);
    view.dispatch({ changes: { from: 0, to: 1, insert: head === "H" ? "h" : "H" } });
    await wait(60);
    expect(view.state.doc.length, "长度应与原文一致").toBe(origin.length);
    expect(dirty(), "等长但内容不同必须置脏").toBe(true);

    // 改回来
    view.dispatch({ changes: { from: 0, to: 1, insert: head } });
    await wait(60);
    expect(dirty(), "改回原文应转回不脏").toBe(false);
  });
});

describe("B112 静态契约：判脏靠基线，清脏靠 markClean", () => {
  it("handleUpdate 必须按基线判脏，而不是「一改过就永远脏」", () => {
    const src = stripLineComments(readFileSync("src/main.ts", "utf-8"));
    const handler = src.match(/function handleUpdate\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(handler, "应有 handleUpdate").toBeTruthy();
    // 退化写法是 `!doc.dirty` 门控 + 直接置 true —— 那样撤销回原样也摘不掉 ●
    expect(handler, "不得再按「当前不脏就置脏」单向置位").not.toContain("&& !doc.dirty");
    expect(handler, "必须走 isDirtyVsBaseline 判脏").toContain("isDirtyVsBaseline(");
    expect(handler, "脏状态变化时才刷新界面").toContain("if (shouldDirty !== doc.dirty)");
  });

  it("isDirtyVsBaseline：先比长度再比内容，基线未知时保守判脏", () => {
    const src = stripLineComments(readFileSync("src/main.ts", "utf-8"));
    const fn = src.match(/function isDirtyVsBaseline\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn, "应有 isDirtyVsBaseline").toBeTruthy();
    // 基线未知（热退出副本还原）：没有「原样」可参照，只能一直脏到用户保存
    expect(fn, "基线为 null 必须保守判脏").toMatch(/base === null[\s\S]{0,60}return true/);
    // 先比长度是性能捷径：绝大多数编辑都会改变长度，可免去大文件上的全文比较
    expect(fn, "必须先比长度再比内容").toMatch(
      /text\.length !== base\.length[\s\S]{0,80}text !== base/,
    );
    // 编码 / 行尾也算：切换行尾不改内存正文，只看正文会漏判
    expect(fn, "必须把编码与行尾纳入判据").toContain("doc.baselineEol");
  });

  it("markClean 必须同时钉正文/编码/行尾（只清 dirty 会让判据失真）", () => {
    const src = stripLineComments(readFileSync("src/main.ts", "utf-8"));
    const fn = src.match(/function markClean\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn, "应有 markClean").toBeTruthy();
    expect(fn, "必须钉正文").toContain("doc.baseline = text;");
    expect(fn, "必须钉编码").toContain("doc.baselineEncoding = doc.encoding;");
    expect(fn, "必须钉行尾").toContain("doc.baselineEol = doc.eol;");
  });

  it("清脏的四处都必须走 markClean（保存 / 自动保存 / 重载 / 以磁盘为准）", () => {
    const src = stripLineComments(readFileSync("src/main.ts", "utf-8"));
    const marks = src.match(/markClean\(/g) ?? [];
    // isDirtyVsBaseline 的定义 + markClean 的定义各 1 处，调用点应 ≥ 4
    expect(marks.length, "清脏处应全部改走 markClean").toBeGreaterThanOrEqual(4);
  });
});

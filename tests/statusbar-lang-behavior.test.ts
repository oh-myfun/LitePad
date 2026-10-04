// @vitest-environment jsdom
// B233 行为侧：状态栏语言项在**真实 bootstrap 出来的 DOM 上**是纯展示。
//
// 这里只断言 DOM 层（标签名 / class / 文案）—— 那是我实测能证明的部分。
//
// ⚠️⚠️ **别在这里试图断言「那个 click 监听器没挂」**（我第一版写的就是它，
//    真退化①把监听加回来后**照样绿**，判据无鉴别力）：状态栏那批 click 监听
//    挂在 `bindEvents()` 里，而这个 bootstrap 环境**根本没调它** —— 实测连
//    已知有监听的 `#sb-encoding` / `#sb-eol` 也一个都抓不到。
//    ⇒ 「监听器有没有挂」归**静态契约**（`tests/statusbar-lang.test.ts` 的
//    `not.toMatch(/sbLang\.addEventListener/)`），那边是真能红的。
//
// 另注：jsdom 的 `.click()` 是**直接派发**，不经浏览器的 mousedown+mouseup 合成；
// 「不可点」成立靠的是「没有监听器」，不需要合成那一步。

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
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve({ unlisten: () => {} }) }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
  open: () => Promise.resolve(null),
  save: () => Promise.resolve(null),
}));

const saved: unknown[] = [];
// ⚠️ 本 mock 必须**覆盖 src/ipc/api.ts 的全部 27 个导出**（B233 实测踩过：缺
//    `logEvent` / `loadSession` / `newTab` 时 main 启动走的是 catch 分支，
//    **用例照样绿**，只是安静地降级成「空会话 + 日志打不出去」）。
//    补法：复制 api.ts 的导出清单，别一个一个等报错来提醒。
vi.mock("../src/ipc/api", () => ({
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve([]),
  listEols: () => Promise.resolve([]),
  listFonts: () => Promise.resolve([]),
  listTabs: () => Promise.resolve([]),
  loadSession: () => Promise.resolve(null),
  loadSettings: () => Promise.resolve({}),
  logEvent: () => {},
  logLevel: () => Promise.resolve("info"),
  newTab: () => Promise.resolve(null),
  openFile: () => Promise.resolve(null),
  openSatelliteWindow: () => Promise.resolve(null),
  readFile: () => Promise.resolve(null),
  reloadFile: () => Promise.resolve(null),
  restoreBackup: () => Promise.resolve(null),
  saveFile: () => Promise.resolve(null),
  savePasteImage: () => Promise.resolve(null),
  saveSession: (p: unknown) => {
    saved.push(p);
    return Promise.resolve();
  },
  saveSettings: () => Promise.resolve(),
  setLogLevel: () => Promise.resolve(),
  takePendingFiles: () => Promise.resolve([]),
  windowPayload: () => Promise.resolve(null),
  writeBackup: () => Promise.resolve(),
}));

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
describe("B233 状态栏语言项：真 DOM 上是纯展示", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(300);
  });

  it("标签是 SPAN、无 .sb-btn、文案只有语言名", () => {
    const el = document.querySelector("#sb-lang") as HTMLElement | null;
    expect(el, "状态栏语言项应存在").toBeTruthy();

    // ⚠️ 反向闸排在正向断言之前
    // 纯展示：显示的是语言名，不带「M↓」徽标，也不含「语法/预览」字样
    expect(el!.textContent ?? "", "不应再有 M↓ 徽标").not.toContain("M↓");
    expect(el!.textContent ?? "", "不再显示语法/预览字样").not.toMatch(/语法|预览/);
    expect(el!.classList.contains("sb-btn"), "不该带 .sb-btn（那是可点样式）").toBe(false);
    expect(el!.hasAttribute("tabindex"), "不该有 tabindex（不可聚焦）").toBe(false);

    // 正向：标签是 SPAN（原为 BUTTON），文案是语言名
    expect(el!.tagName, "元素应是 SPAN").toBe("SPAN");
    expect((el!.textContent ?? "").length, "应显示语言名").toBeGreaterThan(0);
  });

  it("编码 / 行尾两颗仍是 BUTTON + .sb-btn（别一起改成纯展示）", () => {
    // 对照组：证明上一条不是「所有状态栏项都被改成 span 了」
    for (const id of ["sb-encoding", "sb-eol"]) {
      const el = document.querySelector(`#${id}`) as HTMLElement | null;
      expect(el, `${id} 应存在`).toBeTruthy();
      expect(el!.tagName, `${id} 确实可点，应保持 BUTTON`).toBe("BUTTON");
      expect(el!.classList.contains("sb-btn"), `${id} 应带 .sb-btn`).toBe(true);
    }
  });
});

// @vitest-environment jsdom
// B192：标题栏拖动**自己接管**（mousedown 记起点 → 第一个越过阈值的 mousemove 就
// 调 Rust 看门狗命令 `watchdog_start_drag` 交给系统移动循环，Rust 侧再兜 #10767 残余竞态）。
//
// 为什么要有运行时用例（光有静态契约不够）：
//   · 「纯点击一次都不碰拖拽」是绕开 Tauri #10767 的唯一保证 —— 少了它，点一下标题栏
//     也会进系统移动循环，窗口跟着鼠标走；
//   · 「越过阈值才起拖 / 只起一次 / 监听要摘干净」是三条相互独立的失效模式，
//     静态文本契约只能证明代码里**写了**，证明不了它**真的这么跑**。
// 这里用真实的 bootstrap（真 main.ts + 真 index.html 结构）跑一遍手势序列。
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

/** 起拖次数（B192 的核心可观测量）。 */
const drags = vi.hoisted(() => ({ count: 0 }));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTitle: () => Promise.resolve(),
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    isAlwaysOnTop: () => Promise.resolve(false),
    setAlwaysOnTop: () => Promise.resolve(),
    onCloseRequested: () => Promise.resolve({ catch: () => {} }),
    close: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
    // B192：标题栏拖动的自管出口 —— 只记次数，不真的进系统移动循环
    // （jsdom 里也没有那个循环可进）。
    startDragging: () => {
      drags.count += 1;
      return Promise.resolve();
    },
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: (cmd: string) => {
    // B192：标题栏拖动的唯一出口是 `watchdog_start_drag`，记次数即可
    // （不真进系统移动循环，jsdom 里也没有那个循环可进）。
    if (cmd === "watchdog_start_drag") {
      drags.count += 1;
    }
    return Promise.resolve();
  },
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

vi.mock("../src/ipc/api", () => ({
  assocList: () => Promise.resolve([]),
  assocSet: (ext: string, on: boolean) =>
    Promise.resolve({ ext, registered: on, isDefault: false }),
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
  saveFile: () => Promise.resolve({ lossy: [], path: "" }),
  savePasteImage: () => Promise.resolve(""),
  saveSession: () => Promise.resolve(),
  saveSettings: () => Promise.resolve(),
  // 启动时会捞「开窗口前就拖进来的文件」，缺了它 bootstrap 会抛 TypeError
  takePendingFiles: () => Promise.resolve([]),
  writeBackup: () => Promise.resolve(),
  restoreBackup: () => Promise.resolve(null),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
}));

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 在目标上派发一次鼠标事件（clientX/Y 才是拖动判据的输入）。 */
function mouse(el: EventTarget, type: string, x: number, y: number): void {
  el.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }),
  );
}

describe("B192 标题栏拖动：纯点击不起拖，真移动才交给系统", () => {
  it("纯点击（零位移）完全不起拖", async () => {
    await import("../src/main");
    await wait(300);
    const bar = document.getElementById("title-bar");
    expect(bar, "index.html 里必须有 #title-bar").toBeTruthy();

    drags.count = 0;
    // 按下 → 原地抖动（位移为 0，浏览器仍会发 mousemove）→ 松手：
    // 这是「只想点一下」的典型轨迹，绝不能进系统移动循环。
    mouse(bar!, "mousedown", 100, 10);
    mouse(window, "mousemove", 100, 10);
    mouse(window, "mouseup", 100, 10);
    await wait(50);
    expect(drags.count, "纯点击不得进系统移动循环（Tauri #10767 的触发条件）").toBe(0);

    // 松手之后监听要摘干净：再动鼠标不该起拖
    mouse(window, "mousemove", 300, 300);
    await wait(50);
    expect(drags.count, "松手后不得再起拖（临时监听要摘掉）").toBe(0);
  });

  it("手抖 1px 不起拖，越过 3px 阈值才起拖，且只起一次", async () => {
    const bar = document.getElementById("title-bar")!;
    drags.count = 0;
    mouse(bar, "mousedown", 100, 10);
    mouse(window, "mousemove", 101, 10); // 1px < 阈值 3 ⇒ 必须忽略
    await wait(30);
    expect(drags.count, "手抖 1px 不得起拖（否则又回到「窗口粘鼠标」）").toBe(0);
    mouse(window, "mousemove", 104, 10); // 越过 3px 阈值
    await wait(30);
    expect(drags.count, "越过阈值必须立刻交给系统移动循环").toBe(1);
    // 系统接管后本窗口不再处理：后续 mousemove / mouseup 都不得再起一次
    mouse(window, "mousemove", 180, 90);
    mouse(window, "mouseup", 180, 90);
    await wait(30);
    expect(drags.count, "一次手势只许起拖一次（重复起拖 = 窗口抖）").toBe(1);
  });

  it("按在标题栏的按钮上后移动，不得把窗口拖走", async () => {
    const bar = document.getElementById("title-bar")!;
    const btn = bar.querySelector("button");
    expect(btn, "标题栏里应有按钮（菜单键 / 窗口三键）").toBeTruthy();
    drags.count = 0;
    mouse(btn!, "mousedown", 100, 10);
    mouse(window, "mousemove", 160, 40);
    mouse(window, "mouseup", 160, 40);
    await wait(50);
    expect(drags.count, "按钮上的按下不算拖动（否则点菜单顺带把窗口拖走）").toBe(0);
  });
});

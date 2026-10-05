// @vitest-environment jsdom
// B240 三轮 · 用户原话：「同步不应该只对当前可见的文档有效果，不可见的文档也要同步
// 调整滚动位置，切换后位置不变。」
//
// 前两轮只修了「源码 + 源码」那一格 —— 而同文档的兄弟还有**算不出自己位置**的两种：
//   · 源是**预览**侧 ⇒ `px` 恒 `null`（预览只认行号），离屏的源码兄弟换不出 `lineBlockAt`
//     （视图归面板所有、正显示着别人）⇒ 它的槽一个字节都写不进；
//   · 兄弟是**预览**态且离屏 ⇒ 连容器都没有，同样写不进。
// 于是「切过去位置不对」，而 B154 白纸黑字要求「一个预览一个源码也要同步」。
//
// 所以本条用例盯的是切换那一刻的**收口**：同步开着时，切过来显示的这一份按**源**的位置
// 对齐（源此刻已离屏，但它的位置就停在 `src.scrollTop` 上，同文档同排版 ⇒ 同值同位）。
//
// ⚠️ 全程只碰 DOM（标签、滚动容器），不依赖任何内部调试出口 —— 断言的是用户真正
// 看得见的那件事：切回来之后编辑器停在哪个像素上。
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

const TXT = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");

vi.mock("../src/ipc/api", () => ({
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve([{ label: "UTF-8", group: "Unicode（统一码）" }]),
  listEols: () => Promise.resolve(["CRLF", "LF"]),
  // ⚠️ 两个标签**同路径**（同一文档），第二个还带 `viewMode: "preview"`
  //   （会话能恢复视图模式，见 `restoreSession`）—— 这条用例的分工就靠它：
  //   B154 明确要求「一个预览一个源码，同步滚动也要生效」。
  loadSession: () =>
    Promise.resolve({
      activePanel: 0,
      panels: [
        {
          // ⚠️ `active` 是**索引**（诊断过：0 ⇒ 第一个标签 tab-active）。
          //   这里让**第二个**（预览态那个）先显示，于是「滚预览的那一份」= 源，
          //   「切过去的那一份」= 离屏的源码兄弟 —— 正是算不出自己位置的那一种。
          active: 1,
          tabs: [
            {
              path: "a.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 1,
              cursorCol: 1,
              scrollTop: 0,
            },
            {
              path: "a.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 2,
              cursorCol: 1,
              scrollTop: 0,
              viewMode: "preview",
            },
          ],
        },
      ],
      layout: { kind: "leaf", panelId: 0 },
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
    Promise.resolve({ tabId: 9, name: "未命名", readonly: false, encoding: "UTF-8", eol: "CRLF" }),
  openFile: (path: string) =>
    Promise.resolve({
      tabId: 0,
      text: TXT,
      name: path,
      path,
      encoding: "UTF-8",
      eol: "LF",
      readonly: false,
      mixedEol: false,
      sizeClass: "normal",
      sizeHint: "",
    }),
  reloadFile: () => Promise.resolve(null),
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

/** 本面板的编辑器滚动容器。 */
function scroller(): HTMLElement {
  const el = document
    .querySelector(".layout-panel")
    ?.querySelector(".cm-scroller") as HTMLElement | null;
  if (!el) throw new Error("编辑器没挂载");
  return el;
}

/** 本面板的预览滚动容器（`.md-preview`，见 `PreviewPane`）。 */
function previewRoot(): HTMLElement {
  const el = document
    .querySelector(".layout-panel")
    ?.querySelector(".md-preview") as HTMLElement | null;
  if (!el) throw new Error("预览容器没挂载");
  return el;
}

/** 两个标签元素（DOM 顺序 = 会话里的顺序）。 */
function tabEls(): HTMLElement[] {
  const els = Array.from(document.querySelectorAll(".panel-tabstrip .tab")) as HTMLElement[];
  if (els.length < 2) throw new Error(`用例前提：两个标签都在（实际 ${els.length}）`);
  return els;
}

/** 点标签切过去（走的是生产那条 `switchTab`，不是内部函数）。 */
function clickTab(i: number): void {
  const el = tabEls()[i];
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.click();
}

/**
 * 用户滚容器：wheel 先清掉「程序来源」的黏性标记，再派发 scroll ——
 * 少了那一发 wheel，还原期 `markProgrammatic` 留的标记会把用户滚动也吞掉
 * （jsdom 不做布局，不派发 wheel 就永远「接管」不了滚动）。
 */
function userScroll(el: HTMLElement, px: number): void {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: px }));
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}

const RIGHT = 260;

describe("B240 三轮：切过来显示的这一份，按**源**的位置收口（不可见也算）", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(300);
  });

  it("切到预览态那份、再切回源码态那份，源码那边必须停在同步过来的位置", async () => {
    // 前提：同一面板两个同文档标签，第二个是预览态（B154 的组合）
    const [tabA, tabB] = tabEls();
    expect(tabA, "第一个标签应落在面板里").toBeTruthy();
    expect(tabB, "第二个（预览）标签应落在面板里").toBeTruthy();

    // 开同步滚动（标题栏那颗键；两份同文档 ⇒ 按钮显形）
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    expect(btn, "两个实例 ⇒ 同步键可见").toBeTruthy();
    btn?.click();
    await wait(60);

    // ① 滚**当前这一份**（预览态，会话 `active: 1`）—— 它是源。
    //    预览侧槽里装的是像素（B129），同一路也把坐标推给离屏的兄弟；
    //    而源是预览 ⇒ `px` 恒 `null`（B154 纪律：预览只认行号），
    //    离屏的源码兄弟换不出 `lineBlockAt` ⇒ 它那一路本来就写不进（见本文件头）。
    userScroll(previewRoot(), RIGHT);
    await wait(80);
    expect(previewRoot().scrollTop, "源（预览）这一份自己的落点").toBe(RIGHT);

    // ② 切过去的是**源码**那份：它当初离屏、算不出自己的编辑器像素，
    //    位置只能由切换那一刻**从源收口**（alignShownToSyncSource）。
    clickTab(0);
    await wait(200);

    expect(
      scroller().scrollTop,
      "切过去后编辑器应停在源同步过来的位置（既不是 0、也不是原始快照）",
    ).toBe(RIGHT);
  });
});

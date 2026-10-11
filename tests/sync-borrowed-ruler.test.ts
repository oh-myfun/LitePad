// @vitest-environment jsdom
// B280 · 「单个源码从其他标签切回显示时…跳回开头」的一条根因：**借尺子时没认文档**。
//
// 机制（`applySyncToSibling` 的源码态那一支）：离屏的源码兄弟没有自己的容器 ⇒ 借
// `panelOfTab(other.tabId).view`（**面板那块唯一的 EditorView**）去 `sourceTopOfV`。
// 而那块 view 显示的是**面板的活动标签** —— 那份可能是**别的文档**；拿它换算
// ⇒ `v` 被按别人的行数夹一遍（短文档直接夹成 0）⇒ `recordScroll` 写进这份兄弟的槽
// ⇒ 落盘固化 ⇒ 切过去 / 重启读到错值就**跳回开头**。
//
// 复现布局：
//   左格（panel 0）：显示 a.md（文档 X，24 行）← 源，滚到第 10 行（v=10 ⇒ 126px）
//   右格（panel 1）：显示 b.md（文档 Y，只有 5 行），**同时**挂着一份隐藏的 a.md（X）
// ⇒ 推给那份隐藏兄弟时，借到的尺子是右格那块正显示 **b.md** 的 view（文档 Y）：
//   · 有 bug：`sourceTopOfV(view_Y, 10)` ⇒ Y 只有 5 行 ⇒ v 夹到 5 ⇒ top = 4×14 = **56**
//   · 修好：认出文档对不上 ⇒ 改找同文档真正显示着的源码实例（左格 a.md）⇒ 9×14 = **126**
// 落盘后按 tabId 读回槽值即可区分（56 vs 126，差 70px，量级远超容差）。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

const ROW = 14;
const VIEW_H = 60;
/** 滚到这一 px ⇒ 顶行 = 第 10 行 ⇒ v = 10。 */
const SRC_PX = 9 * ROW; // 126
/** 借到文档 Y（5 行）的尺子时，v=10 会被夹到 5 ⇒ top = 4×14。 */
const POISON_PX = 4 * ROW; // 56 —— 借错尺子写进槽的值

const DOC_X = Array.from({ length: 24 }, (_, i) => `X 行 ${i + 1}`).join("\n");
const DOC_Y = Array.from({ length: 5 }, (_, i) => `Y 行 ${i + 1}`).join("\n");

const roCallbacks: Array<() => void> = [];

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      constructor(cb: () => void) {
        roCallbacks.push(cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
  const proto = window.Element.prototype as unknown as { getBoundingClientRect: () => DOMRect };
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    const el = this as HTMLElement;
    const isRoot = el.classList.contains("md-preview");
    const isLine = el.classList.contains("cm-line");
    const idx = Math.max(0, Array.prototype.indexOf.call(el.parentElement?.children ?? [], el));
    const top = isRoot ? el.scrollTop : idx * ROW;
    const height = isRoot ? VIEW_H : isLine ? ROW : 0;
    return {
      top,
      left: 0,
      right: 600,
      bottom: top + height,
      width: 600,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as unknown as DOMRect;
  };
  const protoRects = window.Element.prototype as unknown as { getClientRects: () => DOMRectList };
  protoRects.getClientRects = function (this: Element): DOMRectList {
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
  };
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

const session = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock("../src/ipc/api", () => ({
  // ⚠️ `makeDoc(tabId, …)` 的 tabId 直接来自 `openFile` 的返回值，而它就是这份文档的
  //    `docId`（doc-model.ts:95 `docId: doc.tabId`）⇒ **每个 path 必须给不同的 id**，
  //    否则 a.md 与 b.md 会被合成同一份文档、整个「借错尺子」的场景根本不成立。
  _unused: undefined,
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
        // 左格：显示 a.md（文档 X）—— 源
        {
          active: 0,
          tabs: [
            {
              path: "a.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 1,
              cursorCol: 1,
              scrollTop: 0,
            },
          ],
        },
        // 右格：显示 b.md（文档 Y），并挂着一份**隐藏**的 a.md（文档 X）⇒ 借尺子会借到 Y
        {
          active: 0,
          tabs: [
            {
              path: "b.md",
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
              cursorLine: 1,
              cursorCol: 1,
              scrollTop: 0,
            },
          ],
        },
      ],
      layout: {
        kind: "split",
        dir: "h",
        ratio: 0.5,
        a: { kind: "leaf", panelId: 0 },
        b: { kind: "leaf", panelId: 1 },
      },
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
  logLevel: () => Promise.resolve("trace"),
  setLogLevel: () => Promise.resolve(),
  logEvent: () => {},
  newTab: () =>
    Promise.resolve({ tabId: 9, name: "未命名", readonly: false, encoding: "UTF-8", eol: "CRLF" }),
  openFile: (() => {
    let next = 100;
    const ids = new Map<string, number>();
    return (path: string): Promise<Record<string, unknown>> => {
      if (!ids.has(path)) ids.set(path, next++);
      return Promise.resolve({
        tabId: ids.get(path),
        text: path === "b.md" ? DOC_Y : DOC_X,
        name: path,
        path,
        encoding: "UTF-8",
        eol: "LF",
        readonly: false,
        mixedEol: false,
        sizeClass: "normal",
        sizeHint: "",
      });
    };
  })(),
  reloadFile: () => Promise.resolve(null),
  saveFile: () => Promise.resolve({ lossy: [], path: "" }),
  savePasteImage: () => Promise.resolve(""),
  saveSession: (s: Record<string, unknown>) => {
    session.last = JSON.parse(JSON.stringify(s));
    return Promise.resolve();
  },
  saveSettings: () => Promise.resolve(),
  writeBackup: () => Promise.resolve(),
  restoreBackup: () => Promise.resolve(null),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
  takePendingFiles: () => Promise.resolve([]),
}));

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function panels(): HTMLElement[] {
  return Array.from(document.querySelectorAll(".layout-panel")) as HTMLElement[];
}
/** 给左格（源）装会裁剪的 scrollTop + 固定视口高（复刻浏览器）。 */
function installClamp(el: HTMLElement, maxScroll: number): void {
  let st = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => st,
    set: (v: number) => {
      st = Math.min(Math.max(v, 0), maxScroll);
    },
  });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => VIEW_H });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => maxScroll + VIEW_H });
}
function userScroll(el: HTMLElement, px: number): void {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: px }));
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}

describe("B280 借尺子必须认文档（否则隐藏兄弟的槽被别人几何污染）", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(500);
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click(); // 对文档 X 开同步
    await wait(220);
    expect(panels().length, "前提：两格分屏").toBe(2);
    roCallbacks.forEach((f) => {
      try {
        f();
      } catch {
        /* 别的实例 */
      }
    });
    await wait(200);
    // 前提钉死：左格显示 a.md（24 行）、右格显示 b.md（5 行）—— 文档确实不同
    expect(panels()[0].querySelectorAll(".cm-line").length, "前提：左格是 a.md（24 行）").toBe(24);
    expect(panels()[1].querySelectorAll(".cm-line").length, "前提：右格是 b.md（5 行）").toBe(5);
  });

  it("推给隐藏兄弟时，落点必须按**它自己那份文档**的几何算（不是借来的那块 view 的）", async () => {
    const left = panels()[0].querySelector(".cm-scroller") as HTMLElement | null;
    if (!left) throw new Error("左格没有编辑器");
    installClamp(left, 24 * ROW); // 24 行内容（不含留白）⇒ 上限 336
    userScroll(left, SRC_PX);
    await wait(1600); // 等防抖落盘

    const rec = session.last as {
      panels?: Array<{ tabs?: Array<{ path?: string; scrollTop?: number | null }> }>;
    } | null;
    expect(rec, "会话没落盘").not.toBeNull();
    const right = rec?.panels?.[1];
    expect(right, "会话里要有右格").toBeTruthy();
    // 右格第 2 颗标签 = 那份隐藏的 a.md（文档 X）
    const hidden = right?.tabs?.[1];
    expect(hidden?.path, "前提：右格第 2 颗标签是 a.md").toBe("a.md");
    expect(
      hidden?.scrollTop,
      "隐藏兄弟的落点要按文档 X（24 行）算 = 126；按借来的文档 Y（5 行）算会变成 56",
    ).toBeCloseTo(SRC_PX, 6);
    expect(hidden?.scrollTop ?? 0, "不许落到「借错尺子」的那个值上").not.toBeCloseTo(POISON_PX, 6);
  });
});

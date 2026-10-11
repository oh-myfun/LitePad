// @vitest-environment jsdom
// B279 · 「输入时预览跳错位」：重渲染换新块几何后，没人按同步游标补落一次。
//
// 机制：输入期间 `pushSyncToSiblings` 每次击键把预览按**当时的块几何**落位，而预览
// 重渲染是 120ms 防抖的 —— 落点永远追不上几何；重渲染（`setBlocks`）落地那一刻，先前
// 落进去的旧 px 对应的已是另一行，且没有任何人补落 ⇒ 预览停在错位上，直到用户再滚。
//
// 修法（src/markdown.ts `renderMarkdownFor`）：`setBlocks` 之后，同步开着且这份实例正以
// 预览态在屏、且已被同步定位过 ⇒ 按 `tab.syncV` 在**新几何**上重落一次。
//
// 鉴别手段（spy 计数，规避几何桩盲区）：`syncToLineProgrammatic` 的调用点只有
// 推播落点（sync-scroll）/ 预览还原（restorePreviewScroll）/ 编辑器滚动跟随
// （syncFromEditor）/ 本修复的补落。击键推播的调用发生在渲染**前**，修复的补落
// 发生在渲染**后** —— 断言「渲染窗口内新增了一次调用」即可把修复与其它路径区分开；
// 退化（删掉补落块）则渲染后零新增调用 ⇒ 用例红。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";
import { PreviewPane } from "../src/markdown/preview";

const ROW = 14;
const BLOCK = ROW * 3;
const VIEW_H = 60;

const MD = [
  ...Array.from({ length: 21 }, (_, i) => `# 标题 ${i + 1}`),
  "段落第一行",
  "段落第二行",
  "段落第三行",
].join("\n");

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
    const isBlock = el.classList.contains("md-block");
    const idx = Math.max(0, Array.prototype.indexOf.call(el.parentElement?.children ?? [], el));
    const top = isRoot ? el.scrollTop : isLine ? idx * ROW : isBlock ? idx * BLOCK : idx * ROW;
    const height = isRoot ? VIEW_H : isLine ? ROW : isBlock ? BLOCK : 0;
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

vi.mock("../src/ipc/api", () => ({
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
              cursorLine: 1,
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
  logLevel: () => Promise.resolve("trace"),
  setLogLevel: () => Promise.resolve(),
  logEvent: () => {},
  newTab: () =>
    Promise.resolve({ tabId: 9, name: "未命名", readonly: false, encoding: "UTF-8", eol: "CRLF" }),
  openFile: (path: string) =>
    Promise.resolve({
      tabId: 0,
      text: MD,
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
  takePendingFiles: () => Promise.resolve([]),
}));

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function panels(): HTMLElement[] {
  return Array.from(document.querySelectorAll(".layout-panel")) as HTMLElement[];
}
function hostOf(i: number): HTMLElement {
  const el = (document.querySelectorAll(".panel-host") as NodeListOf<HTMLElement>)[i];
  if (!el) throw new Error(`第 ${i} 格没有 panel-host`);
  return el;
}
function splitTab(): void {
  const tabs = Array.from(panels()[0].querySelectorAll(".panel-tabstrip .tab")) as HTMLElement[];
  const tab = tabs.find((t) => t.classList.contains("tab-active"));
  tab?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const btn = Array.from(document.querySelectorAll<HTMLElement>(".popup-menu > button")).find(
    (b) => b.querySelector(".menu-label")?.textContent === "左右分屏",
  );
  if (!btn) throw new Error("右键菜单里没有「左右分屏」这一项");
  btn.click();
}
function modeBtnOf(panelIdx: number): HTMLElement {
  const btn = panels()[panelIdx]?.querySelector<HTMLElement>('.panel-ops [aria-label^="切换到"]');
  if (!btn) throw new Error(`第 ${panelIdx} 格没有模式切换键`);
  return btn;
}
/** 左格（源码）的 CM6 视图。 */
function sourceView(): EditorView {
  const cm = document.querySelector(".layout-panel .cm-editor");
  if (!cm) throw new Error("编辑器没挂载");
  const view = EditorView.findFromDOM(cm as HTMLElement);
  if (!view) throw new Error("拿不到 CM6 视图");
  return view;
}

describe("B279 重渲染后按同步游标补落（输入时预览跳错位）", () => {
  const spy = vi.spyOn(PreviewPane.prototype, "syncToLineProgrammatic");

  beforeAll(async () => {
    await import("../src/main");
    await wait(500);
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click(); // 开同步
    await wait(220);
    // 建分屏（copy 分支），右格切预览 ⇒「源码 + 预览同屏」
    splitTab();
    await wait(600);
    const rightTabs = Array.from(
      panels()[1].querySelectorAll(".panel-tabstrip .tab"),
    ) as HTMLElement[];
    rightTabs[0].click();
    await wait(400);
    modeBtnOf(1).click();
    await wait(500);
    expect(panels().length, "前提：造出了两格分屏").toBe(2);
    expect(hostOf(1).classList.contains("mode-preview"), "前提：右格预览在屏").toBe(true);
    expect(hostOf(0).classList.contains("mode-source"), "前提：左格源码在屏").toBe(true);
    // 等 setup 期间的所有渲染/推播都尘埃落定，再拍基线
    await wait(400);
  });

  it("源码编辑 → 防抖重渲染落地后，必须再发生一次按 syncV 的补落调用", async () => {
    spy.mockClear();
    // isSyncSource 只认「编辑的面板 = 活动面板」⇒ 先把活动面板切回左格（源码）
    const leftTab = panels()[0].querySelector(".panel-tabstrip .tab") as HTMLElement | null;
    if (!leftTab) throw new Error("左格没有标签");
    leftTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    leftTab.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    leftTab.click();
    await wait(200);
    // 一次编辑：不换行、不滚动（v 恒为 1），只让正文变化
    const view = sourceView();
    view.dispatch({ changes: { from: 0, insert: "X" } });
    await wait(50); // 击键推播（同步落点，渲染前）已发生；120ms 防抖渲染未到
    const afterPush = spy.mock.calls.length;
    expect(afterPush, "前提：击键推播应已按旧几何落过一次").toBeGreaterThan(0);
    await wait(500); // 越过 120ms 防抖，重渲染 + 补落完成
    const afterRender = spy.mock.calls.length;
    expect(
      afterRender,
      "重渲染落地后必须再补落一次（退化 = 删掉 renderMarkdownFor 的补落块，此值不增）",
    ).toBeGreaterThan(afterPush);
    // 补落用的游标 = 规范游标（整数行 1，源在顶部）
    const last = spy.mock.calls[afterRender - 1]?.[0];
    expect(last, "补落必须按规范游标 syncV 落（顶部 = 行 1）").toBeGreaterThanOrEqual(1);
  });
});

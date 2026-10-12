// @vitest-environment jsdom
// 复现：预览标签拖到另一分屏的**边缘**（⇒ splitPanelWithTab move 支）时滚动跳 0。
//
// move 支末尾 `landOnFrameGeometry(tab, vDrop)` 的 `vDrop = syncSourceV(anchor)`，
// anchor 取的是「源面板此刻显示的那一份」= 源码标签（预览离屏）。于是预览标签被按
// **源码的游标**重落，而非它自己的位置 —— 同步关着时把它从 300 拽回文档开头（源码在顶 ⇒ 0）。
//
// 桩沿用 sync-drag-split.test.ts 那套（块高 ≠ 行高、补 jsdom 滚动尺寸）。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

const ROW = 14;
const blockH = (i: number): number => ROW + (i % 3) * 11;
function blockTopOf(k: number): number {
  let t = 0;
  for (let i = 0; i < k; i++) t += blockH(i);
  return t;
}
const MD = Array.from({ length: 60 }, (_, i) => `# 标题 ${i + 1}`).join("\n");
const B_MD = Array.from({ length: 60 }, (_, i) => `## block ${i + 1}`).join("\n");

function hiddenHost(el: Element): boolean {
  let p: Element | null = el;
  while (p) {
    const c = (p as HTMLElement).classList;
    if (c?.contains("panel-host") && c.contains("mode-preview")) return true;
    p = p.parentElement;
  }
  return false;
}

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
  const proto = window.Element.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
    getClientRects: () => DOMRectList;
  };
  proto.getClientRects = function (this: Element): DOMRectList {
    return hiddenHost(this)
      ? ([] as unknown as DOMRectList)
      : ([this.getBoundingClientRect()] as unknown as DOMRectList);
  };
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    const el = this as HTMLElement;
    const cls = el.classList;
    const isRoot = cls.contains("md-preview");
    const isLine = cls.contains("cm-line");
    const idx = Math.max(0, Array.prototype.indexOf.call(el.parentElement?.children ?? [], el));
    const ls = (el as HTMLElement).dataset?.lineStart;
    const isBlock = !isRoot && !isLine && ls !== undefined;
    const bi = isBlock ? Number(ls) - 1 : 0;
    const panels = Array.from(document.querySelectorAll<HTMLElement>(".layout-panel"));
    const pi = Math.max(0, panels.indexOf(el));
    const isStrip = cls.contains("panel-tabstrip");
    const isTab = cls.contains("tab") && !isStrip;
    const left = isTab
      ? Math.max(
          0,
          Array.prototype.indexOf.call(
            el.parentElement?.querySelectorAll<HTMLElement>(".tab") ?? [],
            el,
          ),
        ) * 140
      : (pi * 1200) / Math.max(1, panels.length);
    const top = isRoot ? el.scrollTop : isLine ? idx * ROW : isBlock ? blockTopOf(bi) : 0;
    const w = isTab ? 140 : 1200 / Math.max(1, panels.length);
    const height = isRoot ? ROW : isLine ? ROW : isBlock ? blockH(bi) : isStrip || isTab ? 40 : 800;
    return {
      top,
      left,
      right: left + w,
      bottom: top + height,
      width: w,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as unknown as DOMRect;
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
          ],
        },
      ],
      layout: {
        kind: "hsplit",
        panelId: 0,
        first: { kind: "leaf", panelId: 0 },
        second: { kind: "leaf", panelId: 1 },
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
  logEvent: () => {},
  newTab: () =>
    Promise.resolve({ tabId: 99, name: "未命名", readonly: false, encoding: "UTF-8", eol: "CRLF" }),
  openFile: (path: string) =>
    Promise.resolve({
      tabId: 0,
      text: path === "b.md" ? B_MD : MD,
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
  takePendingFiles: () => [],
}));

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const clamped = new WeakSet<HTMLElement>();
function installClamp(el: HTMLElement): void {
  if (clamped.has(el)) return;
  clamped.add(el);
  let st = el.scrollTop;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => st,
    set: (v: number) => {
      st = Math.min(Math.max(v, 0), Infinity);
    },
  });
}
function installMetrics(el: HTMLElement, isPrev: boolean): void {
  const line = () => (isPrev ? blockH(0) : ROW);
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 60 * line() });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 4 * line() });
}
const panelsEl = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(".layout-panel"));
function hostOf(i: number): HTMLElement {
  const h = panelsEl()[i]?.querySelector<HTMLElement>(".panel-host");
  if (!h) throw new Error(`面板 ${i} 没有 .panel-host`);
  return h;
}
const prevEl = (i = 0): HTMLElement | null =>
  hostOf(i).querySelector(".md-preview") as HTMLElement | null;

describe("预览标签拖到另一分屏边缘（splitPanelWithTab move 支）", () => {
  it("同步关着：预览自己的滚动位置应保留，不被源码游标覆盖", async () => {
    await import("../src/main");
    await wait(500);
    for (let i = 0; i < panelsEl().length; i++) {
      for (const el of [hostOf(i).querySelector(".cm-scroller"), prevEl(i)].filter(
        Boolean,
      ) as HTMLElement[]) {
        installClamp(el);
        installMetrics(el, el.classList.contains("md-preview"));
      }
    }
    expect(panelsEl().length, "前提：两分屏").toBe(2);

    const { tabs } = await import("../src/core/app-state");
    const { panelOfTab } = await import("../src/core/panels");
    const { splitPanelWithTab } = await import("../src/tabs/split");

    const previewTab = [...tabs.values()].find((t) => t.viewMode === "preview")!;
    expect(previewTab, "前提：存在预览标签").toBeTruthy();
    const srcPanelId = panelOfTab(previewTab.tabId)!.panelId;
    const otherPanelId = [...(await import("../src/core/app-state")).panels.keys()].find(
      (id) => id !== srcPanelId,
    )!;
    expect(otherPanelId, "前提：存在另一个面板").toBeTruthy();

    // 模拟用户在源面板把预览滚到 300px（同步关着）
    previewTab.scrollTop = 300;
    panelOfTab(previewTab.tabId)!.preview!.root.scrollTop = 300;
    // 同时把源面板的源码那份滚到文档开头（模拟常见状态），证明预览不应被它拽走
    const srcEditor = panelOfTab(previewTab.tabId)!.view?.view;
    if (srcEditor) {
      srcEditor.scrollDOM.scrollTop = 0;
    }

    // 拖到另一分屏的**边缘** ⇒ splitPanelWithTab move 支
    splitPanelWithTab(otherPanelId, "h", previewTab.tabId, false, false);
    await wait(200);

    const shown = panelOfTab(previewTab.tabId)!;
    expect(shown.viewTabId, "预览应落入新分屏").toBe(previewTab.tabId);
    expect(previewTab.scrollTop, "槽里位置应保留（≠0）").toBe(300);
    expect(shown.preview!.root.scrollTop, "边缘拖拽后预览滚动应保留（≠0）").toBe(300);
  });
});

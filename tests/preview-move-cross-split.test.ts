// @vitest-environment jsdom
// 复现用户报的 bug：预览标签从一个分屏拖动到另一分屏时，滚动位置跳回 0。
//
// 关键落点路径（center = 拖到目标面板本体）：`moveTabToPanel` ⇒ `rebuildLayout` ⇒
// `mountView` ⇒ `restorePreviewScroll`（读 t.scrollTop / t.syncV）。
// 本用例验证「跨分屏移动后，预览标签自己的滚动位置（t.scrollTop）能原样带过去」。
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

// 两分屏：panel A = 预览态 a.md；panel B = 源码态 b.md。
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

describe("预览标签跨分屏移动后滚动位置", () => {
  it("center 落点（moveTabToPanel）：预览滚动位置应保留", async () => {
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

    const { tabs, panels } = await import("../src/core/app-state");
    const { panelOfTab } = await import("../src/core/panels");
    const { moveTabToPanel } = await import("../src/tabs/split");

    const previewTab = [...tabs.values()].find((t) => t.viewMode === "preview")!;
    expect(previewTab, "前提：存在预览标签").toBeTruthy();
    const srcPanelId = panelOfTab(previewTab.tabId)!.panelId;
    const otherPanelId = [...panels.keys()].find((id) => id !== srcPanelId)!;
    expect(otherPanelId, "前提：存在另一个面板").toBeTruthy();

    // 模拟用户在源面板把预览滚到 300px（同时写进槽与 DOM）
    previewTab.scrollTop = 300;
    const srcPrev = panelOfTab(previewTab.tabId)!.preview!;
    srcPrev.root.scrollTop = 300;

    // 拖到另一个面板的本体（center ⇒ moveTabToPanel）
    moveTabToPanel(previewTab.tabId, otherPanelId, false);
    await wait(200);

    // 移动后源面板被腾空摘掉，剩下的那格就是显示该预览的面板
    const shownPanel = panelOfTab(previewTab.tabId)!;
    expect(shownPanel.panelId, "预览应已落入另一面板").toBe(otherPanelId);
    expect(shownPanel.viewTabId, "该面板应显示这份预览标签").toBe(previewTab.tabId);
    expect(previewTab.scrollTop, "槽里位置应保留（≠null/≠0）").toBe(300);
    expect(shownPanel.preview!.root.scrollTop, "跨分屏移动后预览滚动应保留（≠0）").toBe(300);
  });
});

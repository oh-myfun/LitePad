// @vitest-environment jsdom
// 复现「分屏（同文档 a.md，左源码 / 右预览并排，由 openPreviewToSide 造出）下，
// 把预览标签拖到另一分屏」后滚动位置跳回 0。
// 三个真实落点入口逐一覆盖：strip(moveTabToStrip) / center(moveTabToPanel) / edge(splitPanelWithTab)。
// 逐测试 resetModules 隔离。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const ROW = 14;
const blockH = (i: number): number => ROW + (i % 3) * 11;
function blockTopOf(k: number): number {
  let t = 0;
  for (let i = 0; i < k; i++) t += blockH(i);
  return t;
}
const MD = Array.from({ length: 60 }, (_, i) => `# 标题 ${i + 1}`).join("\n");

function hiddenHost(el: Element): boolean {
  let p: Element | null = el;
  while (p) {
    const c = (p as HTMLElement).classList;
    if (c?.contains("panel-host") && c.contains("mode-preview")) return true;
    p = p.parentElement;
  }
  return false;
}

async function setup(): Promise<void> {
  document.body.innerHTML = "";
  vi.resetModules();
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
}

beforeEach(async () => {
  await setup();
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
      activePanel: 1,
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
              viewMode: "source",
            },
          ],
        },
        {
          active: 0,
          tabs: [
            {
              path: "a.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 1,
              cursorCol: 1,
              scrollTop: 300,
              viewMode: "preview",
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
      tabId: 0, // 两栏同 path ⇒ 共享 docId=0（同源多实例）
      text: path === "b.md" ? "## b" : MD,
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

type DropKind = "strip" | "center" | "edge";
const dropKinds: DropKind[] = ["strip", "center", "edge"];

describe("分屏（同 docId 两栏）拖预览标签到另一分屏后滚动位置", () => {
  for (const syncOn of [true, false]) {
    for (const kind of dropKinds) {
      it(`[sync=${syncOn}] ${kind}：预览滚动应保留`, async () => {
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

        const { tabs, panels, docSyncModes } = await import("../src/core/app-state");
        const { panelOfTab } = await import("../src/core/panels");
        const { moveTabToStrip } = await import("../src/tabs/lifecycle");
        const { moveTabToPanel, splitPanelWithTab } = await import("../src/tabs/split");

        const allTabs = [...tabs.values()];
        expect(new Set(allTabs.map((t) => t.docId)).size, "前提：两栏同 docId").toBe(1);

        const previewTab = allTabs.find((t) => t.viewMode === "preview")!;
        expect(previewTab, "前提：存在预览标签").toBeTruthy();
        const srcPanelId = panelOfTab(previewTab.tabId)!.panelId;
        const otherPanelId = [...panels.keys()].find((id) => id !== srcPanelId)!;
        const otherTab = [...tabs.values()].find((t) => t.tabId !== previewTab.tabId)!;
        if (syncOn) docSyncModes.set(previewTab.docId, true);

        // 拖之前：把预览钉在深处（槽 + 规范游标 + 真实 DOM）
        previewTab.scrollTop = 300;
        previewTab.syncV = 20.71;
        panelOfTab(previewTab.tabId)!.preview!.root.scrollTop = 300;

        if (kind === "strip") {
          moveTabToStrip(otherPanelId, previewTab.tabId, otherTab.tabId);
        } else if (kind === "center") {
          moveTabToPanel(previewTab.tabId, otherPanelId, false);
        } else {
          // edge：落点在另一分屏边缘 ⇒ 在目标面板旁新建分屏放预览
          splitPanelWithTab(otherPanelId, "h", previewTab.tabId, false, false);
        }
        await wait(200);

        const shownPanel = panelOfTab(previewTab.tabId)!;
        console.log(
          `[DEBUG ${kind} sync=${syncOn}] 拖后 slot=${previewTab.scrollTop} ` +
            `syncV=${previewTab.syncV} dom=${shownPanel.preview?.root.scrollTop} ` +
            `shownPanel=${shownPanel.panelId}`,
        );
        expect(previewTab.scrollTop, "槽里位置应保留（≠null/≠0）").toBeGreaterThan(100);
        expect(previewTab.syncV, "syncV 应保留在深处（≠null/≠1）").toBeGreaterThan(1);
        expect(
          shownPanel.preview!.root.scrollTop,
          "拖到另一分屏后预览滚动应保留（≠0）",
        ).toBeGreaterThan(100);
      });
    }
  }
});

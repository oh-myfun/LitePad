// @vitest-environment jsdom
// B286：标签**并入**另一分屏后，滚动位置必须跟着走（`onDropTabToPanel` zone==="center"
//   → `moveTabToPanel`）。跨窗拖拽的落点提交（`commitTabDrop`）最终也走这一条。
//
// 用户报：标签从一个分屏/窗口切换到另一个分屏/窗口后，滚动位置出现跳变，甚至滚回顶部。
//
// ⚠️ 诚实体例：本条在当前几何下**全绿** ⇒ 它是**形状守卫**，不是能在这条 bug 上变红的判据。
//   B286 排查时把同窗口的搬迁入口全跑了一遍（`moveTabToPanel` / `moveTabToStrip` /
//   `splitPanelWithTab` move 支 / `moveGroupToPanel` / 最大化态搬迁 / 跨窗交还），
//   **位置都保持**；真正红的是跨窗口广播丢 `atFloor`（见 `sync-cross-window-floor.test.ts`）。
//   本条的价值在于：**并入这条路此前没有任何位置保持的回归**（`preview-edge-move.test.ts`
//   只覆盖拖到边缘的 `splitPanelWithTab`），所以把它钉住，防止将来退化。
//
// ⚠️ 曾经的误判（留档，免得后人重踩）：一度以为 `mountView` 漏调 `restorePreviewScroll`
//   （只调了 `restoreViewScroll`，而那一支对 `viewMode === "preview"` 第一行就 return）。
//   实际上 `mountView` **调了**（在 `applyPanelMode` 之后，源码约 350 行）—— 是按
//   「函数名前几行」下的结论，没读完整函数体。教训：根因必须由**能变红的回路**说话，
//   不能由「读到一段看起来漏了的代码」说话。
//
// ⚠️ 与 `tests/preview-edge-move.test.ts` 的分工：那条覆盖**拖到边缘**（`splitPanelWithTab`，
//   有 `landOnFrameGeometry` 显式重落）；本文件覆盖**落到中心 = 并入**（`moveTabToPanel`，
//   全程自己没有位置处理，靠 `rebuildLayout → mountView` 的还原链）。
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
/** 预览被用户滚到的中段位置（刻意非块高整数倍，看落点有没有被取整到块首）。 */
const PREV_AT = 300;
/** 源码被用户滚到的中段位置。 */
const SRC_AT = 140;

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

describe("B286 标签并入另一分屏：滚动位置必须跟着走", () => {
  it("⑦ 预览标签并入另一分屏后，预览仍停在用户滚到的位置（不是 0）", async () => {
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

    // 用户在源面板把预览滚到中段（同步关着 ⇒ 位置只活在它自己的槽 + DOM 上）
    previewTab.scrollTop = PREV_AT;
    panelOfTab(previewTab.tabId)!.preview!.root.scrollTop = PREV_AT;

    // 落到目标面板**中心** = 并入（`onDropTabToPanel` zone==="center" → moveTabToPanel）。
    // 跨窗拖拽的落点提交（commitTabDrop）最终也走这一条。
    const prevObjBefore = panelOfTab(previewTab.tabId)!.preview;
    const prevElBefore = panelOfTab(previewTab.tabId)!.preview?.root;
    console.log(
      "[PROBE-b286] before move: previewObj=",
      prevObjBefore ? "same" : "null",
      "scrollTop=",
      prevObjBefore?.root.scrollTop,
      "tabSlot=",
      previewTab.scrollTop,
    );
    moveTabToPanel(previewTab.tabId, otherPanelId);
    await wait(300);

    const shown = panelOfTab(previewTab.tabId)!;
    console.log(
      "[PROBE-b286] after move: previewObj=",
      shown.preview === prevObjBefore ? "SAME" : "NEW",
      "previewEl=",
      shown.preview?.root === prevElBefore ? "SAME" : "NEW",
      "scrollTop=",
      shown.preview?.root.scrollTop,
      "tabSlot=",
      previewTab.scrollTop,
      "viewTabId=",
      shown.viewTabId,
      "mode=",
      shown.bodyEl?.className,
    );
    expect(shown.panelId, "预览应已并入目标面板").toBe(otherPanelId);
    expect(shown.viewTabId, "目标面板应显示这个预览标签").toBe(previewTab.tabId);
    expect(shown.preview?.root.scrollTop, "并入后预览仍停在用户滚到的位置（≠0）").toBeCloseTo(
      PREV_AT,
      6,
    );
  });

  it("⑧ 对照：源码标签并入另一分屏后，编辑器仍停在用户滚到的位置", async () => {
    const { tabs, panels } = await import("../src/core/app-state");
    const { panelOfTab } = await import("../src/core/panels");
    const { moveTabToPanel } = await import("../src/tabs/split");

    // 取一个**源码态**标签（⑦ 已经跑完，布局里剩下的都算）
    const srcTab = [...tabs.values()].find((t) => t.viewMode !== "preview" && t.panelId >= 0)!;
    expect(srcTab, "前提：存在源码标签").toBeTruthy();
    const fromId = panelOfTab(srcTab.tabId)!.panelId;
    const toId = [...panels.keys()].find((id) => id !== fromId)!;
    srcTab.scrollTop = SRC_AT;
    const srcPanel = panelOfTab(srcTab.tabId)!;
    if (srcPanel.view && srcPanel.viewTabId === srcTab.tabId) {
      srcPanel.view.view.scrollDOM.scrollTop = SRC_AT;
    }

    moveTabToPanel(srcTab.tabId, toId);
    await wait(300);

    const shown = panelOfTab(srcTab.tabId)!;
    expect(shown.panelId, "源码标签应已并入目标面板").toBe(toId);
    expect(
      shown.view?.view.scrollDOM.scrollTop,
      "并入后编辑器仍停在用户滚到的位置（≠0）",
    ).toBeCloseTo(SRC_AT, 6);
  });
});

// @vitest-environment jsdom
// B286：**跨窗口交还标签时，滚动位置必须跟着走**（卫星窗口 → 主窗口）。
//
// 用户报：标签从一个分屏/窗口切换到另一个分屏/窗口后，滚动位置出现跳变，甚至滚回顶部。
// 本条覆盖「窗口」那一半：卫星窗口把标签交回主窗口（`"tabs-return"` 事件 →
// `applyTabsReturn` → `adoptTransferredTabs` → `rebuildLayout` → `mountView` → restore）。
//
// ⚠️ 为什么需要真事件总线：仓库里所有测试的 `@tauri-apps/api/event` mock 都是空桩
//   （listen 返空、emit 空转）⇒ 这条跨窗口链路此前**没有任何运行时覆盖**
//   （`tests/multiwindow.test.ts` 全是静态契约）。这里给一个真总线，让
//   「交还 → 认领 → 落位」第一次可测。
//
// ⚠️ 诚实体例：本条在当前几何下**全绿**（位置传递是通的）⇒ 它是**形状守卫**，
//   不是能在这条 bug 上变红的判据。它锁的是「别退化成 `makeInstance` 之后没人
//   `inst.scrollTop = st.scrollTop`」那个历史病（B126 之前就是从头看）。
//
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

const bus = vi.hoisted(() => {
  const m = new Map<string, Array<(e: { payload: unknown }) => void>>();
  return {
    listen: (event: string, cb: (e: { payload: unknown }) => void) => {
      const arr = m.get(event) ?? [];
      arr.push(cb);
      m.set(event, arr);
      return Promise.resolve({ unlisten: () => {} });
    },
    emit: (event: string, payload: unknown) => {
      for (const cb of m.get(event) ?? []) cb({ payload });
      return Promise.resolve();
    },
    emitTo: (_l: string, event: string, payload: unknown) => {
      for (const cb of m.get(event) ?? []) cb({ payload });
      return Promise.resolve();
    },
  };
});

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
    const top = isRoot ? el.scrollTop : isLine ? idx * ROW : isBlock ? blockTopOf(bi) : 0;
    const height = isRoot ? ROW : isLine ? ROW : isBlock ? blockH(bi) : isStrip(cls) ? 40 : 800;
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
  function isStrip(cls: DOMTokenList): boolean {
    return cls.contains("panel-tabstrip");
  }
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
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
  listen: (event: string, cb: (e: { payload: unknown }) => void) => bus.listen(event, cb),
  emit: (event: string, payload: unknown) => bus.emit(event, payload),
  emitTo: (label: string, event: string, payload: unknown) => bus.emitTo(label, event, payload),
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
const PREV_AT = 300;

describe("B286 探针：跨窗口交还标签的位置传递", () => {
  it("⑩ 卫星窗口交还一个预览标签（scrollTop=300）⇒ 主窗口接来后应停在 300", async () => {
    await import("../src/main");
    await wait(500);
    for (const el of [
      document.querySelector(".cm-scroller"),
      document.querySelector(".md-preview"),
    ].filter(Boolean) as HTMLElement[]) {
      installClamp(el);
      installMetrics(el, el.classList.contains("md-preview"));
    }

    const { tabs, docs, docSyncModes } = await import("../src/core/app-state");
    const docId = [...docs.keys()][0];
    expect(docId !== undefined, "前提：本地已有这份文档").toBe(true);

    // 卫星窗口交还：一个**预览态**实例，用户在里面滚到了 300
    await bus.emit("tabs-return", {
      from: "sat-1",
      tabs: [
        {
          docId,
          path: "a.md",
          name: "a.md",
          text: MD,
          encoding: "UTF-8",
          eol: "LF",
          readonly: false,
          dirty: false,
          viewMode: "preview",
          cursorLine: 1,
          cursorCol: 1,
          scrollTop: PREV_AT,
          syncMode: true,
          sizeClass: "normal",
          backupId: null,
          backedUp: false,
        },
      ],
    });
    await wait(500);

    const adopted = [...tabs.values()].find((t) => t.viewMode === "preview");
    // B169：同步开关必须跟着快照一起过来（否则主窗口亮着、卫星窗口灭着）
    expect(docSyncModes.get(docId), "交还时带的 syncMode 要被认下").toBe(true);
    const root = document.querySelector(".md-preview") as HTMLElement | null;
    expect(adopted, "应接来一个预览标签").toBeTruthy();
    expect(root?.scrollTop, "接来的预览应停在 300，不是 0").toBeCloseTo(PREV_AT, 6);
  });
});

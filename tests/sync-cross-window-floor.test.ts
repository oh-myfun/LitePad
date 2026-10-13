// @vitest-environment jsdom
// B286：**跨窗口同步滚动丢了两侧「到底」的锚点信息**。
//
// 用户报：多窗口同步滚动时，两个窗口里的源码和预览之间没有同步。
//
// ⚠️⚠️ 根因：B284 把「到底」做成**共享锚点**（源到底 ⇒ 兄弟落到自己那一侧的底），
//   判据 `atFloor` 靠 `applySyncToSibling` 的第三参在**本窗口内**传递。但跨窗口那条路
//   把它整条丢了：
//     · `broadcastSyncPos` 的 payload 只有 `{docId, srcTabId, v}` —— **没有 atFloor**；
//     · `applyRemoteSyncPos` 收下后 `applySyncToSibling(other, v)` —— **第二参就没了**。
//   ⇒ 对端窗口永远不知道源已到底 ⇒ 一律按游标 `v` 换算 ⇒ 落到 828 而不是自己那一侧的
//      底 864（36px 裂口，与 B285 同型）。用户看到的就是「两个窗口对不齐」。
//
// ⚠️ 本文件同时是**跨窗口同步的第一条运行时回归**：仓库里所有测试的
//   `@tauri-apps/api/event` mock 都是空桩（listen 返空、emit 空转）⇒ `EVT_SYNC_POS`
//   的事件流此前在任何测试里都跑不起来，`tests/multiwindow.test.ts` 全是静态契约。
//   这里给一个**真事件总线**（listen 真注册、emit 真派发），让
//   「滚 → 广播 → 对端接收 → 落位」第一次可测。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

const ROWS = 24;
const ROW = 14;
const BLOCK = ROW * 3;
/** 视口高：比 3 行多、比 1 块多 ⇒ 两侧自然上限明显不同（这条用例的命门）。 */
const VIEW_H = 60;
/** 源码自然上限（maxScroll）：内容 336 − 视口 60。**无留白**。 */
const SRC_MAX = ROWS * ROW - VIEW_H;
/** 预览自然上限（maxScroll）：内容 924 − 视口 60。 */
const PREV_MAX = 22 * BLOCK - VIEW_H;
/**
 * 源码到底时若按**游标换算**落预览：v = 276/14 + 1 ≈ 20.714 ⇒ 落在第 20 块内
 * ⇒ 798 + 0.714×42 ≈ **828**。与 `PREV_MAX`（864）差 36px ⇒ 判据有鉴别力。
 */
const PREV_BY_CURSOR = 19 * BLOCK + (SRC_MAX / ROW + 1 - 20) * BLOCK;
const MD = [
  ...Array.from({ length: 21 }, (_, i) => `# 标题 ${i + 1}`),
  "段落第一行",
  "段落第二行",
  "段落第三行",
].join("\n");

/** 真事件总线：listen 真注册、emit 真派发（同总线里所有同事件监听都收到）。 */
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
    emitTo: (_label: string, event: string, payload: unknown) => {
      for (const cb of m.get(event) ?? []) cb({ payload });
      return Promise.resolve();
    },
  };
});
/** 捕获 `emitCrossWindow` 的调用参数（真实现里它负责注入 from 并 emit）。 */
const xwin = vi.hoisted(() => ({ calls: [] as Array<{ event: string; payload: unknown }> }));

beforeAll(() => {
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
  // 与真实现同构：注入 from = 当前窗口 label（展开在后，压过误传），并记录调用参数
  emitCrossWindow: vi.fn(async (event: string, payload: Record<string, unknown>) => {
    xwin.calls.push({ event, payload: { ...payload, from: "main" } });
    bus.emit(event, { ...payload, from: "main" });
  }),
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
const editorMax = Infinity;
const previewMax = Infinity;
function userScroll(el: HTMLElement, px: number): void {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: px }));
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}
function countUnits(el: HTMLElement): number {
  return el.querySelectorAll(
    el.classList.contains("cm-scroller") ? ".cm-line" : "[data-line-start]",
  ).length;
}
function unitOf(el: HTMLElement): number {
  return el.classList.contains("cm-scroller") ? ROW : BLOCK;
}
const clamped = new WeakSet<HTMLElement>();
function naturalMax(el: HTMLElement): number {
  const base = el.parentElement?.children.length ? countUnits(el) * unitOf(el) : unitOf(el);
  return Math.max(0, base - VIEW_H);
}
function installClamp(el: HTMLElement, max: () => number): void {
  if (clamped.has(el)) return;
  clamped.add(el);
  let st = el.scrollTop;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => st,
    set: (v: number) => {
      st = Math.min(Math.max(v, 0), Math.min(max(), naturalMax(el)));
    },
  });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => VIEW_H });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () =>
      Math.max(
        VIEW_H,
        el.parentElement?.children.length ? countUnits(el) * unitOf(el) : unitOf(el),
      ),
  });
}
function panels(): HTMLElement[] {
  return Array.from(document.querySelectorAll(".layout-panel")) as HTMLElement[];
}
function hostPanels(): HTMLElement[] {
  return Array.from(document.querySelectorAll(".panel-host")) as HTMLElement[];
}
function tabEl(i: number): HTMLElement {
  const el = document.querySelectorAll(".layout-panel .tab")[i] as HTMLElement | undefined;
  if (!el) throw new Error(`标签 ${i} 没渲染`);
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
function hosts(): { cm: HTMLElement; prev: HTMLElement } {
  const hostSrc = hostPanels().find((h) => h.classList.contains("mode-source"));
  const hostPrev = hostPanels().find((h) => h.classList.contains("mode-preview"));
  if (!hostSrc || !hostPrev) throw new Error("分屏后既没有源码格也没有预览格");
  const cm = hostSrc.querySelector(".cm-scroller") as HTMLElement | null;
  const prev = hostPrev.querySelector(".md-preview") as HTMLElement | null;
  if (!cm) throw new Error("源码格没有编辑器");
  if (!prev) throw new Error("预览格没有预览");
  return { cm, prev };
}

describe("B286 跨窗口同步：到底的锚点信息必须一起广播", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(500);
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click(); // 开同步
    await wait(220);
    tabEl(0).click();
    await wait(300);
    splitTab();
    await wait(600);
    const rightTabs = Array.from(
      panels()[1].querySelectorAll(".panel-tabstrip .tab"),
    ) as HTMLElement[];
    if (rightTabs.length === 0) throw new Error("右格没有标签");
    rightTabs[0].click();
    await wait(400);
    const rightMode = panels()[1].querySelector<HTMLElement>('.panel-ops [aria-label^="切换到"]');
    if (!rightMode) throw new Error("右格没有模式切换键");
    rightMode.click();
    await wait(500);
  });

  it("⑪ 源码滚到底 ⇒ 广播里必须带 atFloor: true（否则对端不知道该落自己的底）", async () => {
    const { cm, prev } = hosts();
    installClamp(cm, () => editorMax);
    installClamp(prev, () => previewMax);
    xwin.calls.length = 0;
    userScroll(cm, 99999);
    await wait(400);
    expect(cm.scrollTop, "前提：源码滚到自己的底").toBeCloseTo(SRC_MAX, 6);
    expect(prev.scrollTop, "前提：在屏预览落在自己的底（864）").toBeCloseTo(PREV_MAX, 6);

    const posCalls = xwin.calls.filter((c) => c.event === "sync-scroll-pos");
    expect(posCalls.length, "源码滚动必须广播同步位置").toBeGreaterThan(0);
    const last = posCalls[posCalls.length - 1].payload as Record<string, unknown>;
    expect(
      last.atFloor,
      "到底时广播必须带 atFloor: true —— 少了它，对端只能按游标 v 换算，落 828 而非自己那一侧的底 864",
    ).toBe(true);
  });

  it("⑫ 对端广播带 atFloor ⇒ 本窗口预览要落到自己那一侧的底（864），不是游标换算的 828", async () => {
    const { prev } = hosts();
    // 先把预览拉回中段，避免「它本来就停在底」让判据恒真
    userScroll(prev, 300);
    await wait(350);
    expect(prev.scrollTop, "前提：预览此刻在中段").toBeCloseTo(300, 6);
    // ⚠️ 判据鉴别力：游标换算落点（828）必须与锚点落点（864）不同。
    expect(
      PREV_BY_CURSOR,
      "前提：游标换算的落点必须 ≠ 锚点落点（否则这条用例恒绿）",
    ).not.toBeCloseTo(PREV_MAX, 6);

    const { tabs } = await import("../src/core/app-state");
    const srcTab = [...tabs.values()].find((t) => t.viewMode !== "preview")!;
    // 模拟**另一个窗口**（sat-1）的源码滚到底后发来的广播（srcTabId 用本窗口不存在的 id）
    await bus.emit("sync-scroll-pos", {
      from: "sat-1",
      docId: srcTab.docId,
      srcTabId: 99999,
      v: SRC_MAX / ROW + 1,
      atFloor: true,
    });
    await wait(450);
    expect(
      prev.scrollTop,
      "对端到底 ⇒ 本窗口预览落自己那一侧的底（864），不是游标换算的 828",
    ).toBeCloseTo(PREV_MAX, 6);
  });

  it("⑬ 反向验证：把广播里的 atFloor 抹掉 ⇒ ⑫ 必须落回 828", async () => {
    const { prev } = hosts();
    userScroll(prev, 300);
    await wait(350);
    const { tabs } = await import("../src/core/app-state");
    const srcTab = [...tabs.values()].find((t) => t.viewMode !== "preview")!;
    // 不带 atFloor（= 修复前的广播形态）
    await bus.emit("sync-scroll-pos", {
      from: "sat-1",
      docId: srcTab.docId,
      srcTabId: 99999,
      v: SRC_MAX / ROW + 1,
    });
    await wait(450);
    expect(
      prev.scrollTop,
      "没有 atFloor ⇒ 只能按游标换算 ⇒ 落 828（这正是用户报的跨窗口对不齐）",
    ).toBeCloseTo(PREV_BY_CURSOR, 6);
  });
});

// @vitest-environment jsdom
// B285：**到底时，离屏的预览兄弟与在屏的预览兄弟落点不一致**（用户报：「没显示的预览标签
//   滚动位置和显示的预览标签滚动位置不一致」）。
//
// 台子几何与 `bottom-anchor.test.ts` 同源（24 行 md / 行高 14 / 块高 42 / 视口 60、**无留白**）：
//   · 源码上限 276，到底时顶行游标 v ≈ 20.71
//   · 预览上限 864，到底时顶行游标 v ≈ 21.57
//   · 两侧到底的顶行游标天生不相等 ⇒ B284 才需要「各自到底」锚点。
//
// ⚠️⚠️ 本文件的命门：B284 的锚点分支只管了**在屏**的兄弟。`applySyncToSibling` 里
//   `landAtOwnFloor` 要求 `shown?.preview` 有容器才落位并返回 true；离屏预览兄弟
//   `shown` 是 undefined ⇒ return false ⇒ 落回下面「预览态按游标换算」那一支，
//   而那一支对离屏预览是 `if (!shown?.preview) return`（没容器，一个字节都不写）。
//   ⇒ 离屏预览只拿到 `other.syncV = v`（**源那一侧**的 v = 20.71）。
//   ⇒ 切过去现形时 `restorePreviewScroll` 按 20.71 派生 ⇒ 落 **828**，
//      而在屏那个预览落在 **864**。36px 的裂口就是用户报的不一致。
//
// ⚠️ 桩顺序纪律：`installClamp` 会覆写 `clientHeight`/`scrollHeight` ⇒ 必须在预览
//   **现形之后**才装。提前装会把 `tabAtOwnFloor` 的「离屏闸」（`clientHeight <= 0`）
//   绕掉 ⇒ 离屏也判「到底」⇒ 锚点对离屏也生效 ⇒ 本用例恒绿（假绿）。
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

const editorMax = Infinity;
const previewMax = Infinity;

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      constructor() {
        /* 桩：只登记，不回调（本用例不需要 RO 补写） */
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
/** 右键活动标签 ⇒ 分屏（走 copy 分支；起点必须是当前显示中这一颗）。 */
function splitTab(dir: "h" | "v"): void {
  const label = dir === "h" ? "左右分屏" : "上下分屏";
  const tabs = Array.from(panels()[0].querySelectorAll(".panel-tabstrip .tab")) as HTMLElement[];
  const tab = tabs.find((t) => t.classList.contains("tab-active"));
  tab?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const btn = Array.from(document.querySelectorAll<HTMLElement>(".popup-menu > button")).find(
    (b) => b.querySelector(".menu-label")?.textContent === label,
  );
  if (!btn) throw new Error(`右键菜单里没有「${label}」这一项`);
  btn.click();
}
/** 此刻显示在屏的**源码格**与**预览格**（按 `mode-*` 找，不按 DOM 序）。 */
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
/** 左格第 i 颗标签（左格 = 分屏起点那一格，自带「源码标签 0 + 预览标签 1」）。 */
function leftTab(i: number): HTMLElement {
  const el = panels()[0].querySelectorAll(".panel-tabstrip .tab")[i] as HTMLElement | undefined;
  if (!el) throw new Error(`左格没有标签 ${i}`);
  return el;
}

describe("B285 到底时离屏预览兄弟：现形落点必须与在屏预览一致", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(500);
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click(); // 开同步
    await wait(220);
    tabEl(0).click();
    await wait(300);
    splitTab("h");
    await wait(600);
    // 右格切模式成预览 ⇒ 右格是在屏预览；左格留着「标签 0 源码 + 标签 1 预览」，
    //   活动是标签 0（源码）⇒ **标签 1 就是那个离屏的预览兄弟**。
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

  it("⑥ 源码滚到底 ⇒ 在屏预览落 864；切到离屏预览标签，它也要落在 864", async () => {
    const { cm, prev } = hosts();
    installClamp(cm, () => editorMax);
    installClamp(prev, () => previewMax);
    // 先把预览拉回中段，避免「它本来就停在底」让判据恒真。
    userScroll(prev, 300);
    await wait(300);
    expect(prev.scrollTop, "前提：预览此刻在中段").toBeCloseTo(300, 6);
    // 源码滚到底
    userScroll(cm, 99999);
    await wait(400);
    expect(cm.scrollTop, "前提：源码滚到自己的底").toBeCloseTo(SRC_MAX, 6);
    // ⚠️ 判据鉴别力：游标换算落点（828）必须与锚点落点（864）不同。
    expect(
      PREV_BY_CURSOR,
      "前提：游标换算的落点必须 ≠ 锚点落点（否则这条用例恒绿）",
    ).not.toBeCloseTo(PREV_MAX, 6);
    expect(prev.scrollTop, "前提：在屏预览落在自己的底（864）").toBeCloseTo(PREV_MAX, 6);

    // 切左格到标签 1（预览态）⇒ 那个离屏预览兄弟现形。
    // ⚠️ 必须在现形**之后**才 installClamp：提前装会覆写 clientHeight，
    //   把 tabAtOwnFloor 的「离屏闸」绕掉 ⇒ 离屏也判到底 ⇒ 锚点对离屏也生效 ⇒ 恒绿。
    // ⚠️ clamp 必须**提前**装（切标签之前）：收口那一发的 `landAtOwnFloor` 要量
    //   `ownFloorPx(preview.root)`，此刻容器刚现形、桩还没装 ⇒ 量出 0 ⇒ 落 0。
    //   ⚠️ 提前装不会污染「离屏」判定：`landAtOwnFloor` 认的是 `displayedPanelOfTab`
    //      返回的容器，左格标签 1 离屏时它是 undefined ⇒ 照样 return false；
    //      `tabAtOwnFloor` 只问**源**（左格标签 0 = 源码），不问这个预览。
    const leftPrev = panels()[0].querySelector(".md-preview") as HTMLElement | null;
    if (!leftPrev) throw new Error("左格离屏时没有预览容器（DOM 里就该在）");
    installClamp(leftPrev, () => previewMax);
    leftTab(1).click();
    await wait(700);
    expect(
      leftPrev.scrollTop,
      "离屏预览现形后要落在自己那一侧的底（864）—— 与在屏预览同一个落点，不是游标换算的 828",
    ).toBeCloseTo(PREV_MAX, 6);
  });
});

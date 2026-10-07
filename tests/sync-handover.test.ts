// @vitest-environment jsdom
// B260：交接游标不许因「切标签 / 切模式」被**自动减小**（用户拍定口径）。
//
// ⚠️ 几何必须让**两侧的自然上限不一样**（这是整条用例的前提）：
//   同一份 24 行 md、视口 3 行 / 3 块 ⇒ 预览能滚到 966（块 23），源码只能滚到 294（行 21）。
//   预览滚到底时它的游标是 23，而源码那一格被自己一侧的上限裁过、读回来只有 22 ——
//   照 22 落预览就从 966 掉到 882（差 84px = 两个块高），且切一轮掉一截。
//   行高与块高**必须不等**（14 vs 42）：相等的话跨侧量纲错配会被抹平，用例假绿。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

const ROWS = 24;
const ROW = 14;
const BLOCK = ROW * 3;
const VIEW_H = ROW * 3;
/** 预览滚到底的落点（24 块 × 42 − 42）。 */
const PREVIEW_BOTTOM = ROWS * BLOCK - VIEW_H;
/** 源码滚到底的落点（24 行 × 14 − 42）—— 比预览的**小得多**，B260 就病在这。 */
const SRC_BOTTOM = ROWS * ROW - VIEW_H;
/** 源码中段的落点（非上限 ⇒ 用来看「来回切会不会漂」）。 */
const SRC_MID = 287;
/**
 * B266：建模 B265 的源码侧 `--cm-bleed-bottom` 留白。真实 app 里留白 =
 * `lastRow.top + clientHeight - contentHeight` = `(rows-1)*ROW + VIEW_H - rows*ROW`
 * = `VIEW_H - ROW`，使源码滚动区延伸到「末行贴视口顶」（源码 max v = 行数）。
 * 不建模这层，桩里源码仍按 `rows*ROW - VIEW_H`(=294/v≈22) 封顶，B260 旧前提在
 * 桩里依旧成立，删 handover 会让 3 条用例假红。建模后源码 naturalMax=322(v=24)，
 * 与预览侧(966/v=24) 对齐，反映 B265 真实几何。
 */
const SRC_BLEED = VIEW_H - ROW;
const MD = Array.from({ length: ROWS }, (_, i) => `# 标题 ${i + 1}`).join("\n");

const editorMax = Infinity;
const previewMax = Infinity;

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
    const idx = Math.max(0, Array.prototype.indexOf.call(el.parentElement?.children ?? [], el));
    const top = isRoot ? el.scrollTop : isLine ? idx * ROW : idx * BLOCK;
    const height = isRoot || isLine ? ROW : 0;
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
            // 第二个实例 = 面板里那颗「预览」标签（纯预览态，与源码那份同源）
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

function src(): HTMLElement {
  const el = document.querySelectorAll(".layout-panel .cm-scroller")[0] as HTMLElement | undefined;
  if (!el) throw new Error("编辑器没挂载");
  return el;
}
function pv(): HTMLElement {
  const el = document.querySelector(".layout-panel .md-preview") as HTMLElement | null;
  if (!el) throw new Error("预览没挂载");
  return el;
}
function userScroll(el: HTMLElement, px: number): void {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: px }));
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}
const clamped = new WeakSet<HTMLElement>();
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
  // ⚠️ jsdom 不做布局、`scrollHeight` / `clientHeight` 恒为 0 —— 不补这两个，
  //    「源码是不是顶到自己一侧的上限」在桩上恒真（`0 - 0 - scrollTop <= 1` 永远成立）
  //    ⇒ `sourceAtOwnFloor` 那条判据被架空、③ 退化成「旧位置永远赢」。这两个 getter
  //    就是这一侧的自然上边界面，按同一套几何（`行数×行高` / `块数×块高` + 视口高）给。
  const unit = el.classList.contains("cm-scroller") ? ROW : BLOCK;
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => VIEW_H });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => Math.max(VIEW_H, el.parentElement?.children.length ? countUnits(el) * unit : unit),
  });
}
/** 这一侧的内容块数（`.cm-line` 数 / 预览 `[data-line-start]` 数）—— 与 `naturalMax` 同一口径。 */
function countUnits(el: HTMLElement): number {
  return el.querySelectorAll(
    el.classList.contains("cm-scroller") ? ".cm-line" : "[data-line-start]",
  ).length;
}
function naturalMax(el: HTMLElement): number {
  const isEditor = el.classList.contains("cm-scroller");
  const rows = isEditor
    ? el.querySelectorAll(".cm-line").length
    : el.querySelectorAll("[data-line-start]").length;
  // ⚠️ B266：源码侧加 B265 留白（见 `SRC_BLEED`），否则桩里源码封顶在 294(v≈22)，
  //    与预览侧(966/v=24) 上限错配残留 —— 那正是 B260 要修的病，删 handover 后会假红。
  const unit = isEditor ? ROW : BLOCK;
  return Math.max(0, rows * unit - VIEW_H + (isEditor ? SRC_BLEED : 0));
}
/** 标签条上某一栏的标签：按 DOM 序点。 */
function tabEl(i: number): HTMLElement {
  const el = document.querySelectorAll(".layout-panel .tab")[i] as HTMLElement | undefined;
  if (!el) throw new Error(`标签 ${i} 没渲染`);
  return el;
}
/** 模式切换键（双字形开关，aria-label 是 `切换到预览（Ctrl+/）` / `切换到源码（Ctrl+/）`）。 */
function modeBtn(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.panel-ops [aria-label^="切换到"]');
  if (!el) throw new Error("模式切换键没渲染");
  return el;
}

describe("B260 交接游标不许被自动减小", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(500);
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click(); // 开同步
    await wait(220);
    installClamp(src(), () => editorMax);
    const root = document.querySelector(".layout-panel .md-preview");
    if (root) installClamp(root, () => previewMax);
  });

  it("① 切**标签**：预览滚到底 ⇒ 切走再切回，预览不许被自动减小", async () => {
    tabEl(1).click(); // 切到预览标签
    await wait(400);

    userScroll(pv(), PREVIEW_BOTTOM); // 预览滚到底
    await wait(400);
    expect(pv().scrollTop, "前提：预览停在最底下").toBeCloseTo(PREVIEW_BOTTOM, 6);

    tabEl(0).click(); // 切到源码标签
    await wait(400);
    tabEl(1).click(); // 切回预览标签
    await wait(400);
    const back = pv().scrollTop;
    expect(
      back,
      `切标签把预览从 ${PREVIEW_BOTTOM} 拖小了（实际 ${back}）——换标签/换模式不许自动减小滚动位置`,
    ).toBeCloseTo(PREVIEW_BOTTOM, 6);

    // 再来一轮：歪值被冻住的话，第二轮也会停在歪的地方
    tabEl(0).click();
    await wait(400);
    tabEl(1).click();
    await wait(400);
    expect(pv().scrollTop, "第二轮又掉了一截").toBeCloseTo(PREVIEW_BOTTOM, 6);
  });

  it("② 切**模式**：预览滚到底 ⇒ 切源码模式再切回，预览不许被自动减小", async () => {
    // 先让预览在最底下（① 结束时就停在这儿），再走模式这一路
    expect(pv().scrollTop, "前提：预览还在最底下").toBeCloseTo(PREVIEW_BOTTOM, 6);

    modeBtn().click(); // → 源码模式
    await wait(400);
    modeBtn().click(); // → 回预览模式
    await wait(400);
    const back = pv().scrollTop;
    expect(
      back,
      `切模式把预览从 ${PREVIEW_BOTTOM} 拖小了（实际 ${back}）——预览滚到底 → 切源码 → 切回预览 要停回原处`,
    ).toBeCloseTo(PREVIEW_BOTTOM, 6);

    modeBtn().click(); // → 源码模式
    await wait(400);
    modeBtn().click(); // → 回预览模式
    await wait(400);
    expect(pv().scrollTop, "第二轮又掉了一截").toBeCloseTo(PREVIEW_BOTTOM, 6);
  });

  it("③ 反向：源码停在中段 ⇒ 切预览模式再切回，源码不许漂（也不许被两边裁小）", async () => {
    tabEl(0).click(); // 切到源码标签
    await wait(400);

    userScroll(src(), SRC_MID);
    await wait(400);
    expect(src().scrollTop, "前提：源码停在中段").toBeCloseTo(SRC_MID, 6);

    modeBtn().click(); // → 预览模式
    await wait(400);
    const inPreview = pv().scrollTop;
    modeBtn().click(); // → 回源码模式
    await wait(400);

    expect(src().scrollTop, `切一轮模式把源码从 ${SRC_MID} 挪走了`).toBeCloseTo(SRC_MID, 6);
    // 「落点换了一侧」的副证：预览跟着停在同一份游标上（287 ⇒ 块 20 顶 + 半块 = 861）
    expect(
      inPreview,
      "前提：切预览那一路的落点必须与源同一份游标，否则这条用例没有鉴别力",
    ).toBeCloseTo(20 * BLOCK + ((SRC_MID - 20 * ROW) / ROW) * BLOCK, 6);
    expect(SRC_BOTTOM, "口径常量：源码上限必须小于预览上限，否则整条用例的前提不成立").toBeLessThan(
      PREVIEW_BOTTOM,
    );
  });
});

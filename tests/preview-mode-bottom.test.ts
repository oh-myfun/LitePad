// @vitest-environment jsdom
// B269：预览模式（单格，预览是唯一可见面板）下，最后一个块必须能继续向上滚到容器顶
// （手动滚动 / 同步滚动两条路径都如此）—— 与源码侧「最后一行贴容器顶」同一个口径。
//
// ⚠️ 这条用例是 B265/B268 全家桶里**唯一缺的那一格**：现有 ② 滚的是「源码标签激活时
// 那个被 display:none 藏起来的预览」（注释自己承认是假局面），⑧ 滚的是「分屏里当源的预览」。
// 用户报的是**单格预览模式**—— 预览铺满整格、源码彻底藏住—— 这一格的 bleed 测量时序
// 跟另两格不同（进入预览模式那一帧 `applyPanelMode` 先切 class 再 `setBlocks`，宽度从
// 半屏变成整屏，块要重排），所以单列一条专门咬它。
//
// 几何前提同 scroll-bottom-bleed.test.ts：24 行 md、行高 14、块高 42（末块跨 22–24 三行）、
// 视口 60 ⇒ 预览留白 = 视口 60 − 末块 42 = 18，滚到底 = 末块 top = 21×42 = 882。
//
// ───────────────────────────────────────────────────────────────────────────
// **这条用例要咬住的是 B269 的修复本身（rAF 补量），不是「切到预览」那一手**：
// 旧的退化版（无离屏闸门 + 无 rAF 补量）在「启动/恢复即在预览态」时，首帧 `clientHeight = 0`
// 被算成 0 写死、之后 `.md-preview` 是固定高容器、RO 不触发、**再也没机会补回正数** ⇒ 末块
// 永远差 `clientHeight − 末块高` 一截贴不上容器顶。B269 的修法是 `setBlocks` 里排一帧 rAF
// 补量，布局落定后再量一次。要证「这条用例咬的是修复、不是别的东西」，必须：
//   1. 启动即预览态（`loadSession` 的激活标签 `viewMode: "preview"`）；
//   2. 把 `clientHeight` .mock 在 boot 之后才装（模拟「首帧量不出、随后布局落定」）；
//   3. **手动 flush 那个 rAF 队列**（而不是让它自动 fire）—— 否则 setup.ts 把 rAF 换成
//      `setTimeout(0)`，补量会在 `clientHeight` 还是 0 时就提前烧掉，反而测不出修复。
// 临时撤掉 preview.ts 的离屏闸门 / rAF 补量 ⇒ 这条用例应变红（证非假绿）。
// ───────────────────────────────────────────────────────────────────────────
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

// ⚠️ 覆盖 setup.ts 的 `setTimeout(0)` 版 rAF：改成「手动队列」，让 B269 的 rAF 补量
// 不会在 `clientHeight` 还是 0 时就自动烧掉。flushRaf() 在 installClamp 之后才调用。
const rafQueue: FrameRequestCallback[] = [];
window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  rafQueue.push(cb);
  return 0;
}) as typeof window.requestAnimationFrame;
window.cancelAnimationFrame = (() => {}) as typeof window.cancelAnimationFrame;
/** 把积攒的 rAF 回调跑干净（CM6 也会塞回调进来，包 try 吞掉；限定轮数防成环）。 */
function flushRaf(rounds = 8): void {
  for (let r = 0; r < rounds; r++) {
    if (rafQueue.length === 0) break;
    const batch = rafQueue.splice(0, rafQueue.length);
    for (const cb of batch) {
      try {
        cb(performance.now());
      } catch {
        /* 别让 CM6 的 measure 回调把整轮 flush 打断 */
      }
    }
  }
}

const ROWS = 24;
const ROW = 14;
const BLOCK = ROW * 3;
const VIEW_H = 60;
const PREV_FLOOR = 21 * BLOCK;
const PREV_BLEED = VIEW_H - BLOCK;
const MD = [
  ...Array.from({ length: 21 }, (_, i) => `# 标题 ${i + 1}`),
  "段落第一行",
  "段落第二行",
  "段落第三行",
].join("\n");

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
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
              // ⚠️ 关键：这一格的激活标签**直接以预览态启动**（模拟「用户恢复会话时
              // 上次停在预览模式」）—— 正是 B269 报 bug 的那一手。首帧 `clientHeight = 0`
              // 量不出，旧写法会把 bleed 写死成 0；B269 靠 rAF 补量在布局落定后翻回正数。
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
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => VIEW_H });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => Math.max(VIEW_H, countUnits(el) * BLOCK + appliedBleed(el)),
  });
}
function countUnits(el: HTMLElement): number {
  return el.querySelectorAll("[data-line-start]").length;
}
function appliedBleed(el: HTMLElement): number {
  return Number.parseFloat(el.style.getPropertyValue("--md-bleed-bottom")) || 0;
}
function naturalMax(el: HTMLElement): number {
  const base = countUnits(el) * BLOCK + appliedBleed(el);
  return Math.max(0, base - VIEW_H);
}
/** 末块此刻相对容器顶的位置：`== 0` 即「贴顶」。 */
function lastBlockTop(el: HTMLElement): number {
  const blocks = Array.from(el.querySelectorAll("[data-line-start]")) as HTMLElement[];
  return (
    (blocks[blocks.length - 1]?.getBoundingClientRect().top ?? 0) - el.getBoundingClientRect().top
  );
}

describe("B269 预览模式（单格，启动即在预览态）：最后一个块能滚到容器顶", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(500); // 等 boot 把预览挂载（此时 clientHeight 还是 jsdom 默认 0 ⇒ 首帧量不出）
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click();
    await wait(220);
    // ⚠️ 关键顺序：先把「布局落定后 clientHeight = 视口」这件事 mock 上去，
    // 再 flush 那个被 B269 排进来的 rAF 补量 ⇒ 补量在 clientHeight 可用时重算 → 写出 18。
    // 若颠倒（先 flush / 让 setup.ts 的 setTimeout(0) 提前烧掉补量）⇒ 补量在 clientHeight=0
    // 时跑、返回不写，之后 `.md-preview` 固定高、RO 不触发 ⇒ bleed 永远 0（就是用户报的 bug）。
    installClamp(pv(), () => PREV_FLOOR);
    flushRaf();
    await wait(60);
  });

  it("① 启动即在预览态 ⇒ --md-bleed-bottom = 视口 − 末块高（= 18），不是 0", () => {
    expect(
      Number.parseFloat(pv().style.getPropertyValue("--md-bleed-bottom")) || 0,
      "预览模式单格：留白 = 60 − 42 = 18（B269 修复前这里会卡在 0）",
    ).toBeCloseTo(PREV_BLEED, 6);
  });

  it("② 手动滚到底 ⇒ 最后一块贴容器顶，游标 = 文档末行", async () => {
    userScroll(pv(), 99999);
    await wait(400);
    expect(pv().scrollTop, "预览模式滚到底 = 末块 top (882)").toBeCloseTo(PREV_FLOOR, 6);
    expect(lastBlockTop(pv()), "滚到底时最后一块必须贴在容器顶（下面留一屏空白）").toBeCloseTo(
      0,
      6,
    );
    // 末块顶到容器顶时，游标交的是「块末行」= 文档末行（B265/B268 的口径）。
    const blocks = Array.from(pv().querySelectorAll("[data-line-start]")) as HTMLElement[];
    const last = blocks[blocks.length - 1];
    expect(Number(last.dataset.lineEnd)).toBe(ROWS);
  });
});

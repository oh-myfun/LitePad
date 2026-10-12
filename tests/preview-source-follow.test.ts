// @vitest-environment jsdom
// B283：单面板（预览在屏、源码被 display:none 藏住）时，**预览滚动 ⇒ 被藏的源码兄弟也要跟到
//   同一位置**（切回源码时位置才对）。这条专门咬「预览→源码」这一路：
//     · `PreviewPane.onPreviewScroll` 推的游标必须是**小数 `topVisibleLine()`**（末块交 `lineEnd`
//       = 文档末行），不能再只推整数 `data-line-start`（块首，差末块那几行）；
//     · `host.scrollToLine` 落点必须走 `sourceTopOfV(v)`（支持小数、末行贴顶），不能再只取
//       `lineBlockAt(l.from).top`（整数行首）。
//
// ⚠️ 为什么单开一个文件、不复用 scroll-bottom-bleed.test.ts 的 ⑧：⑧ 是**分屏**（两格都可见），
//   `applySyncToSibling` 会读 `syncSourceV(preview)` 直接把源码兄弟钉到正确位置、把
//   `onPreviewScroll` 的推播盖掉 ⇒ 在那条用例里退化 `onPreviewScroll` 也恒绿（自测台抓到）。
//   单面板预览在屏时，被藏的源码兄弟**没有**「在屏视图」⇒ `applySyncToSibling` 的
//   `rulerHidden` 闸门直接 return，不再覆盖 ⇒ 这一路只能靠 `onPreviewScroll` → `host.scrollToLine`
//   自己把位置写进隐藏源码的 scrollTop。这正是用户报的「预览滚到底、源码停在上一块首」。
//
// 几何同 scroll-bottom-bleed.test.ts（24 行、行高 14、块高 42、视口 60）。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

const ROWS = 24;
const ROW = 14;
const BLOCK = ROW * 3;
const VIEW_H = 60;
const SRC_FLOOR = (ROWS - 1) * ROW; // 末行 top = 322
const PREV_FLOOR = 21 * BLOCK + 2 * ROW; // 末行 top = 910
const MD = [
  ...Array.from({ length: 21 }, (_, i) => `# 标题 ${i + 1}`),
  "段落第一行",
  "段落第二行",
  "段落第三行",
].join("\n");

const editorMax = Infinity;
const previewMax = Infinity;
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
  // ⚠️ 起点就是**预览模式**：单面板、源码那格被 display:none 藏住（正是用户报的场景）。
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
function appliedBleed(el: HTMLElement): number {
  const name = el.classList.contains("cm-scroller") ? "--cm-bleed-bottom" : "--md-bleed-bottom";
  return Number.parseFloat(el.style.getPropertyValue(name)) || 0;
}
function hidden(): boolean {
  const host = src().closest(".panel-host");
  return !!host && host.classList.contains("mode-preview");
}
const clamped = new WeakSet<HTMLElement>();
function naturalMax(el: HTMLElement): number {
  const unit = el.classList.contains("cm-scroller") ? ROW : BLOCK;
  const base = el.parentElement?.children.length ? countUnits(el) * unit + appliedBleed(el) : unit;
  return Math.max(0, base - (el === src() && hidden() ? 0 : VIEW_H));
}
function countUnits(el: HTMLElement): number {
  return el.querySelectorAll(
    el.classList.contains("cm-scroller") ? ".cm-line" : "[data-line-start]",
  ).length;
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
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => (el === src() && hidden() ? 0 : VIEW_H),
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () =>
      Math.max(
        VIEW_H,
        el.parentElement?.children.length
          ? countUnits(el) * (el.classList.contains("cm-scroller") ? ROW : BLOCK) + appliedBleed(el)
          : el.classList.contains("cm-scroller")
            ? ROW
            : BLOCK,
      ),
  });
}

describe("B283 单面板预览在屏：预览滚 ⇒ 被藏的源码兄弟跟到同一位置", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(500);
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click(); // 开同步
    await wait(220);
    installClamp(src(), () => editorMax);
    installClamp(pv(), () => previewMax);
    // ⚠️ 留白是在视图创建那刻算不出（clientHeight=0 ⇒ 有闸门、不写），真机由 ResizeObserver
    //   补这拍。桩里手动触发 RO 回调（补两轮，头一轮 CM6 的 contentHeight 可能还没量出 ⇒ 闸门跳过），
    //   把预览/源码的 `--md-bleed-bottom` / `--cm-bleed-bottom` 写下去，否则可滚上限少一屏、
    //   「滚到底=末行贴顶」在桩上发生不了。
    for (let round = 0; round < 2; round++) {
      roCallbacks.forEach((f) => {
        try {
          f();
        } catch {
          /* 别的实例抛错，吞掉继续 */
        }
      });
      await wait(150);
    }
    // 起点就是预览模式：切一轮标签让离屏的 CM6 实例按新几何重算（与 scroll-bottom-bleed 同款补法）
    const tabs = Array.from(document.querySelectorAll(".layout-panel .tab")) as HTMLElement[];
    tabs[0]?.click();
    await wait(300);
  });

  it("前提：面板是预览模式、源码被藏住（clientHeight = 0）", () => {
    expect(pv().clientHeight, "预览在屏、视口高 60").toBe(VIEW_H);
    expect(src().clientHeight, "源码离屏、视口高 0").toBe(0);
    expect(hidden(), "源码这一格确实被 mode-preview 藏住").toBe(true);
  });

  it("① 预览滚到底（末块顶到容器顶）⇒ 被藏源码兄弟落到「末行贴顶」（= SRC_FLOOR，不是上一块首）", async () => {
    userScroll(pv(), 99999);
    await wait(400);
    expect(pv().scrollTop, "前提：预览滚到自己那一侧的底（末行 top）").toBeCloseTo(PREV_FLOOR, 6);
    // ⚠️ 旧写法 `onPreviewScroll` 推整数 `data-line-start`（末块 = 22）⇒ host.scrollToLine(22)
    //   ⇒ 源码停在第 22 行顶（294），差末块那几行；新写法推 `topVisibleLine()`（末块交 lineEnd
    //   = 24）⇒ sourceTopOfV(24) = 322 = 末行贴顶。
    expect(src().scrollTop, "被藏源码兄弟必须跟到末行贴顶（322），不是上一块首（294）").toBeCloseTo(
      SRC_FLOOR,
      6,
    );
  });

  it("② 预览滚到「中段块内半行」位置 ⇒ 被藏源码兄弟按**小数**落点（≠ 整数阶梯）", async () => {
    // 取中段块（idx=10，start=11，跨 11–13 三行）内滚到 ratio=0.5 ⇒ v = 11 + 0.5×3 = 12.5。
    // 预览块高 42 ⇒ scrollTop = 该块 top(10×42=420) + 0.5×42 = 441。
    const scrollTopForHalf = 10 * BLOCK + 0.5 * BLOCK;
    userScroll(pv(), scrollTopForHalf);
    await wait(400);
    // 源码侧小数落点：源行高 14 ⇒ 第 11 行顶(10×14=154) + 0.5×14 = 161。
    const expected = 10 * ROW + 0.5 * ROW;
    // ⚠️ 末块顶到顶边时 `topVisibleLine()` 交 `lineEnd`（整行末行），小数插值只发生在中段块；
    //   旧 `host.scrollToLine` 只认整数行首（doc.line 取整 ⇒ 钉到 154 即第 11 行顶），
    //   永远差半个行高；新写法走 `sourceTopOfV` 插值 ⇒ 正好 161。
    expect(
      src().scrollTop,
      "被藏源码兄弟按小数游标插值落点（161），不是整数阶梯（154）",
    ).toBeCloseTo(expected, 6);
  });
});

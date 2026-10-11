// @vitest-environment jsdom
// B261 第八轮（用户报）：**多分屏同步滚动，一个分屏里同时挂着「源码标签」与「预览标签」
// 两个同文件标签，从源码标签切到预览标签 ⇒ 滚动位置变化了**。
//
// ⚠️⚠️ 桩必须补上真机才会有的那一维：**编辑器 `display:none` 时 scrollTop 被清零、
//     scrollHeight / clientHeight 一起归 0**。jsdom 不布局、也不做 CSS 级联，
//     `.panel-editor` 被 `display:none` 之后它照样报上次的值 —— 于是
//     `sourceAtOwnFloor` 那条判据（`scrollHeight - clientHeight - scrollTop <= 1`）
//     在桩上**判得出来**，在真机上恒读 0-0-0=0 ⇒ 恒真 ⇒ “顶到上限”永远成立。
//     不补这一维，这条用例会**假绿**（现有 `sync-handover` 就是这么漏的）。
//
// ⚠️ 为什么只有「一个分屏里两个同文件标签」才暴露：单标签切模式（Ctrl+/）走的是
//     `toggleViewMode`，那儿是**动手改之前同帧**问的（`sourceAtOwnFloor` 判得准）；
//     跨「源码标签 ↔ 预览标签」切走的是 `switchTab` 的收口，它的判据排在
//     `applyPanelMode` **之后**（编辑器已被 display:none）⇒ 问不出真话。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

const ROWS = 24;
const ROW = 14;
const BLOCK = ROW * 3;
const VIEW_H = ROW * 3;
/** 预览滚到底的落点（24 块 × 42 − 42）。 */
const PREVIEW_BOTTOM = ROWS * BLOCK - VIEW_H;
/** 源码**中段**的落点：v = 287/14 = 20.5（非上限 ⇒ 源那份是真值）。 */
const SRC_MID = 287;
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

// ⚠️ `../src/ipc/api` 的桩必须**导出全部**：漏一个 ⇒ 调用点静默降级、用例照样绿。
vi.mock("../src/ipc/api", () => ({
  emitCrossWindow: vi.fn(async () => {}),
  convertFileSrc: (p: string) => `asset://${p}`,
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve([{ label: "UTF-8", group: "Unicode（统一码）" }]),
  listEols: () => Promise.resolve(["CRLF", "LF"]),
  // ⚠️ 两个同文件标签：0 = 源码标签，1 = **预览标签**（与源码那份同源）
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
  const unit = el.classList.contains("cm-scroller") ? ROW : BLOCK;
  // ⚠️⚠️ `display:none` ⇒ 这一侧量不出来（真机：scrollTop 清零、scrollHeight /
  //     clientHeight 全 0）。桩里不模拟 ⇒ `sourceAtOwnFloor` 在桩上判得出真话、
  //     在真机上恒真 ⇒ 用例假绿。
  const hidden = (): boolean => {
    const host = el.closest(".panel-host") as HTMLElement | null;
    return !!host && host.classList.contains("mode-preview");
  };
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => (hidden() ? 0 : VIEW_H),
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () =>
      hidden()
        ? 0
        : Math.max(VIEW_H, el.parentElement?.children.length ? countUnits(el) * unit : unit),
  });
}
/** 这一侧的内容块数（`.cm-line` 数 / 预览 `[data-line-start]` 数）。 */
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
  return Math.max(0, rows * (isEditor ? ROW : BLOCK) - VIEW_H);
}
/** 标签条上某一栏的标签：按 DOM 序点。 */
function tabEl(i: number): HTMLElement {
  const el = document.querySelectorAll(".layout-panel .tab")[i] as HTMLElement | undefined;
  if (!el) throw new Error(`标签 ${i} 没渲染`);
  return el;
}

describe("B261 第八轮：一个分屏里「源码标签 ↔ 预览标签」切换不许换位置", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(500);
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click(); // 开同步（两个同文档实例 ⇒ multi 闸放行）
    await wait(220);
    installClamp(src(), () => editorMax);
    const root = document.querySelector(".layout-panel .md-preview");
    if (root) installClamp(root, () => previewMax);
  });

  it("源码标签停在中段 ⇒ 切到预览标签，预览要落在**源那一格**的游标上（不是预览标签自己的旧位置）", async () => {
    // 先把预览标签那一格的槽做成「更靠后」的旧值：切过去滚到底。
    tabEl(1).click(); // → 预览标签
    await wait(400);
    userScroll(pv(), PREVIEW_BOTTOM);
    await wait(400);
    expect(pv().scrollTop, "前提：预览滚在最底下（= 预览标签自己那格的旧位置）").toBeCloseTo(
      PREVIEW_BOTTOM,
      6,
    );

    tabEl(0).click(); // → 源码标签
    await wait(400);
    userScroll(src(), SRC_MID); // 源码停在中段（v=20.5，非上限 ⇒ 源交的是真值）
    await wait(400);
    expect(src().scrollTop, "前提：源码停在中段").toBeCloseTo(SRC_MID, 6);

    tabEl(1).click(); // → 切回预览标签（跨模式收口）
    await wait(400);
    const got = pv().scrollTop;
    // 源游标 20.5 ⇒ 预览落点 = 20.5 × BLOCK
    const want = 20.5 * BLOCK;
    expect(
      got,
      `从源码标签切到预览标签，预览落点变了（源游标 20.5 该落 ${want}，实际 ${got}）` +
        `——源停在中段时它交的是真值，不许拿「预览标签自己那格的旧位置（${PREVIEW_BOTTOM}）」把源顶走`,
    ).toBeCloseTo(want, 6);

    // 再来一轮：歪值被冻住的话，第二轮会停在歪的地方
    tabEl(0).click();
    await wait(400);
    userScroll(src(), SRC_MID);
    await wait(400);
    tabEl(1).click();
    await wait(400);
    expect(pv().scrollTop, "第二轮又落到另一处了").toBeCloseTo(want, 6);
  });
});

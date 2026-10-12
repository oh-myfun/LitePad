// @vitest-environment jsdom
// B284：**撤销底部留白**，改为把「滚动到底」做成**共享锚点** —— 源顶到自己的底 ⇒ 兄弟落到
//   **它自己那一侧的底**（各自到底），不再按顶行游标换算。
//
// 用户口径：不在底下加空白；但同步滚动滚到底部后，不许因为两侧「首行位置不一致」而跳变。
//
// ⚠️ 几何必须让**两侧的自然上限明显不同**（这是整条用例的前提，也是跳变的根源）：
//   24 行 md、行高 14、块高 42（= 3 行）、视口 60、**无留白** ⇒
//     · 源码：内容 24×14 = 336 ⇒ 上限 = 336 − 60 = **276** ⇒ 到底时顶行 v = 276/14 + 1 ≈ 20.71
//     · 预览：内容 22×42 = 924 ⇒ 上限 = 924 − 60 = **864** ⇒ 到底时顶行 v ≈ 21.57
//   两侧到底的**顶行游标天生不等**（20.71 vs 21.57）。若照 v 互推：
//     · 源码到底 ⇒ 预览按 v≈20.714 落到 **828**，离它自己的底 864 还差 36px；
//     · 预览到底 ⇒ 源码按 v≈21.571 换出 288，被浏览器裁到 276（＝它的底，这一路碰巧对齐）。
//   ⇒ 锚点真正要钉的是第一条：**源到底 ⇒ 兄弟必须落在 864，而不是 828**。
//
// ⚠️ 分屏是必需的：单面板里「预览在屏 ⇒ 源码必然离屏」，离屏那一侧 `clientHeight = 0` ⇒
//   `tabAtOwnFloor` 恒答「没到底」（它那道闸就是防这个），锚点在桩上根本验证不到。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

const ROWS = 24;
const ROW = 14;
const BLOCK = ROW * 3;
/** 视口高：比 3 行多、比 1 块多 ⇒ 两侧自然上限明显不同（这条用例的命门）。 */
const VIEW_H = 60;
/** 源码自然上限（maxScroll）：内容 336 − 视口 60。**无留白** ⇒ 末行停在视口底。 */
const SRC_MAX = ROWS * ROW - VIEW_H;
/** 预览自然上限（maxScroll）：内容 924 − 视口 60。 */
const PREV_MAX = 22 * BLOCK - VIEW_H;
/**
 * 源码到底时若按**游标换算**落预览：v = 276/14 + 1 ≈ 20.714 ⇒ 落在第 20 块内
 * （块 idx 19、top 798、块内比 0.714）⇒ 798 + 0.714×42 ≈ **828**。
 * ⚠️ 这正是「没有锚点」时的落点，与 `PREV_MAX`（864）差 36px ⇒ 判据有鉴别力。
 */
const PREV_BY_CURSOR = 19 * BLOCK + (SRC_MAX / ROW + 1 - 20) * BLOCK;
/**
 * ⚠️ 末块必须**跨多行**（这里 3 行）：若每块只占一行，末块的 `start` 与 `lineEnd` 是同一个数，
 * `topVisibleLine()` 交「块起始行」与交「块末行」在数值上完全等价 ⇒ 退化针打在空处、用例恒绿。
 * ⇒ 前 21 行各成一块，末块（连续三行 ⇒ 一个段落）跨 22–24 行：`start`=22、`lineEnd`=24。
 */
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
  // ⚠️ B284：**无留白** ⇒ 可滚上限 = 内容高 − 视口高（不再叠加 CSS 变量那一截）。
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
    // ⚠️ 必须按**真实上限裁剪**：预览被按游标换算落到 828 时，「能不能再滚到 864」
    //    全靠这一刀 —— 没有它，锚点与否在桩上量不出差别（假绿）。
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

describe("B284 到底锚定：各自到底（撤留白，不再按游标换算）", () => {
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
    // 右格切模式成预览（操作区只渲染活动面板那一份 ⇒ 先激活右格、再点它自己的那颗键）
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

  it("① 前提：两侧自然上限不同，且到底时顶行游标天生不等（这就是跳变的根源）", () => {
    const { cm, prev } = hosts();
    installClamp(cm, () => editorMax);
    installClamp(prev, () => previewMax);
    expect(naturalMax(cm), "源码上限 = 336 − 60").toBe(SRC_MAX);
    expect(naturalMax(prev), "预览上限 = 924 − 60").toBe(PREV_MAX);
    expect(SRC_MAX, "前提：两侧上限必须不同（否则锚点无从验证）").not.toBe(PREV_MAX);
    // 两侧各自到底 ⇒ 顶行游标不相等（20.71 vs 21.57）⇒ 「到底」不能靠游标对齐。
    const vSrc = SRC_MAX / ROW + 1;
    const vPrev = 21 + (PREV_MAX - 20 * BLOCK) / BLOCK;
    expect(vSrc, "源码到底的顶行游标").toBeCloseTo(20.714, 2);
    expect(vPrev, "预览到底的顶行游标").toBeCloseTo(21.571, 2);
    expect(vSrc, "两侧到底的游标必须不相等（才需要锚点）").not.toBeCloseTo(vPrev, 1);
  });

  it("② 源码滚到底 ⇒ 预览（在屏）落到**它自己那一侧的底**（864），不是游标换算的 828", async () => {
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
    expect(prev.scrollTop, "源码到底 ⇒ 预览落到它自己的底（864），不是游标换算的 828").toBeCloseTo(
      PREV_MAX,
      6,
    );
  });

  it("③ 预览滚到底 ⇒ 源码（在屏）落到**它自己那一侧的底**（276）", async () => {
    const { cm, prev } = hosts();
    userScroll(cm, 200); // 先把源码拉回中段
    await wait(300);
    userScroll(prev, 99999);
    await wait(400);
    expect(prev.scrollTop, "前提：预览滚到自己的底").toBeCloseTo(PREV_MAX, 6);
    expect(cm.scrollTop, "预览到底 ⇒ 源码落到它自己的底（276）").toBeCloseTo(SRC_MAX, 6);
  });

  it("④ 不动点：两侧轮流滚到底，谁的位置都不许变（滚到底后不跳变）", async () => {
    const { cm, prev } = hosts();
    userScroll(cm, 99999);
    await wait(400);
    const srcAt = cm.scrollTop;
    const prevAt = prev.scrollTop;
    expect(srcAt, "前提：源码已在底").toBeCloseTo(SRC_MAX, 6);
    expect(prevAt, "前提：预览已在底").toBeCloseTo(PREV_MAX, 6);
    // 再从预览那侧滚到底（它已在底，再推一次）
    userScroll(prev, 99999);
    await wait(400);
    expect(cm.scrollTop, "预览再滚到底 ⇒ 源码位置不许变（不动点）").toBeCloseTo(srcAt, 6);
    expect(prev.scrollTop, "预览仍在自己的底").toBeCloseTo(prevAt, 6);
    // 再从源码那侧滚到底
    userScroll(cm, 99999);
    await wait(400);
    expect(prev.scrollTop, "源码再滚到底 ⇒ 预览位置不许变（不动点）").toBeCloseTo(prevAt, 6);
    expect(cm.scrollTop, "源码仍在自己的底").toBeCloseTo(srcAt, 6);
  });

  it("⑤ 撤留白：两侧都不许再写出底部空白，内容高 = 单元数 × 单元高", async () => {
    const { cm, prev } = hosts();
    expect(
      Number.parseFloat(cm.style.getPropertyValue("--cm-bleed-bottom")) || 0,
      "源码：不许再有底部留白",
    ).toBe(0);
    expect(
      Number.parseFloat(prev.style.getPropertyValue("--md-bleed-bottom")) || 0,
      "预览：不许再有底部留白",
    ).toBe(0);
    expect(cm.scrollHeight, "源码可滚内容 = 24 行 × 14（无留白）").toBe(ROWS * ROW);
    expect(prev.scrollHeight, "预览可滚内容 = 22 块 × 42（无留白）").toBe(22 * BLOCK);
  });
});

describe("B284 静态契约：到底锚点的两个不可省略件", () => {
  const syncSrc = readFileSync("src/sync-scroll.ts", "utf-8");

  it("「到底」由 tabAtOwnFloor 判，且离屏（clientHeight<=0）时恒答「没到底」", () => {
    // ⚠️ 这道闸是 B261 用血换来的：离屏时 `scrollHeight - 0 - scrollTop` 恒 ≤ 容差
    //    ⇒ 不闸住就**恒判「到底」** ⇒ 切标签收口每次都把位置顶走。
    expect(syncSrc, "要有到底判定函数").toContain("export function tabAtOwnFloor(");
    expect(syncSrc, "离屏量不出 ⇒ 恒答没到底（不许把「看不见」当「到底」）").toMatch(
      /if \(el\.clientHeight <= 0\) return false;/,
    );
  });

  it("落点那一支接 atFloor，且到底时落「自己那一侧的底」（ownFloorPx），不再按游标换算", () => {
    expect(syncSrc, "applySyncToSibling 要接 atFloor 参数").toMatch(
      /export function applySyncToSibling\(\s*other: Tab,\s*v: number \| null,\s*atFloor = false/,
    );
    // ⚠️ 到底的落位抽在 `landAtOwnFloor` 里（内联进落点函数体会把既有切片契约全锚错，
    //    见源里那条注释），两分支各盯一处 ownFloorPx。
    expect(syncSrc, "到底 ⇒ 预览落到自己的底").toMatch(
      /const floorPx = ownFloorPx\(preview\.root\);/,
    );
    expect(syncSrc, "到底 ⇒ 源码落到自己的底").toMatch(
      /const floorPx = ownFloorPx\(sv\.scrollDOM\);/,
    );
  });

  it("反向验证：摘掉 atFloor 分支 ⇒ 上面那条必须落空", () => {
    const CALL = "if (atFloor && landAtOwnFloor(other, shown)) return;";
    expect(syncSrc, "退化串要先自证原句还在").toContain(CALL);
    const degraded = syncSrc.replace(CALL, "");
    expect(degraded, "退化实现应真的换了写法").not.toBe(syncSrc);
    expect(degraded, "退化后到底不再走「各自到底」（锚点消失 ⇒ ② 那条用例必红）").not.toContain(
      CALL,
    );
  });
});

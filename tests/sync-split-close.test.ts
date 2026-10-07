// @vitest-environment jsdom
// B261 **第七轮**：**减少分屏**（`closePanelById` → `disposePanel` → `rebuildLayout`）
// —— S11（第六轮：新建分屏）的**反向半边**。
//
// ⚠️ 病与 S11 完全同型、只差方向：分屏那一刻**几何变窄** ⇒ 修法是把**两格都按游标重落**
//    （`tests/sync-split-narrow-off.test.ts` 盯的就是「旧像素不许被拿去钉窄栏」）；
//    而**关掉**一个分屏后剩下的那格**变宽** ⇒ `rebuildLayout` 的 `restoreViewScroll`
//    读的是槽里那份**窄栏像素** ⇒ 同一个像素在宽栏里是**另一行**，而且
//    **`pushSyncToSiblings` 帮不上忙**：关完只剩一个面板、同文档没有兄弟实例可推
//    （`sibs.length === 0` ⇒ 入口就 return），所以**同步开着也是错的**。
//
// ⚠️ 为什么必须「先分屏、再关掉」这一串、不能只起手就直接关：要把槽里的像素做成
//    **游标落出来的值**（分屏那一趟按新几何重落 ⇒ 槽从 287 变成 95.67），再让它面对
//    「几何变回整宽」。—— 若槽里一直是分屏前整宽量出来的 287，关掉后钉回 287 反而
//    **看着是对的**（同一个像素在两种几何下各是各的行，错在**跨几何**那一层，
//    不在像素本身）⇒ 不串这一段，本用例怎么退化都绿。
//
// 桩与 `sync-split-narrow-off.test.ts` 同型（行高 ≠ 块高、scrollTop 带浏览器式裁剪、
// 确定性布局、行几何按面板数实时换算），判据是**写死的绝对落点**，不取「实际读到的值」。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";

/** 源码行高（px）。 */
const ROW = 14;
/** ⚠️ 预览块高（px）：刻意 3 倍于行高 —— 跨侧（块 ⇄ 行）的换算错才量得出来。 */
const BLOCK = ROW * 3;
/** 视口高（px）：3 行 ⇒ 源码自然上限 = 60×ROW/3 − VIEW_H，预览 = 60×BLOCK − VIEW_H。 */
const VIEW_H = ROW * 3;
/** 源码滚动位置（px）：压在**行中间**（+7）⇒ 游标带 0.5 的行内比例。 */
const SRC_PX = ROW * 20 + 7; // 287：整宽（单面板）时滚到它采到的游标对应的像素

/** md 正文：一行一个标题 ⇒ 预览块 k 与源码行 k+1 一一对应，块顶 = k×BLOCK。 */
const MD = Array.from({ length: 60 }, (_, i) => `# 标题 ${i + 1}`).join("\n");

const editorMax = Infinity;
const previewMax = Infinity;

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;

  // 确定性布局：预览容器顶边 = 它自己的 scrollTop；`.cm-line` 顶边 = DOM 序 × 视觉行高；
  // 预览块顶边 = DOM 序 × 块高。
  const proto = window.Element.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
  };
  // CM6 量行位置走 `getClientRects()[0] ?? getBoundingClientRect()`；jsdom 的
  // getClientRects 恒空 ⇒ 这里补上（否则 CM6 走不到我们的假布局、行位置永远不动）。
  const protoRects = window.Element.prototype as unknown as {
    getClientRects: () => DOMRectList;
  };
  protoRects.getClientRects = function (this: Element): DOMRectList {
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
  };
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    const el = this as HTMLElement;
    const isRoot = el.classList.contains("md-preview");
    const isLine = el.classList.contains("cm-line");
    const idx = Math.max(0, Array.prototype.indexOf.call(el.parentElement?.children ?? [], el));
    const top = isRoot ? el.scrollTop : isLine ? idx * rowH() : idx * BLOCK;
    const height = isRoot ? ROW : isLine ? rowH() : 0;
    const r: Record<string, number> = {
      top,
      left: 0,
      right: 600,
      bottom: top + height,
      width: 600,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    };
    return r as unknown as DOMRect;
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

// ⚠️ 会话只有**一个**面板、挂一份 md：这样「新建分屏」才真的会新建一个面板，
//    而「关掉分屏」才真的能把面板数从 2 变回 1（几何随之变回整宽）。
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
}));

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function scroller(panelIdx = 0): HTMLElement {
  const el = document.querySelectorAll(".layout-panel .cm-scroller")[panelIdx] as
    HTMLElement | undefined;
  if (!el) throw new Error(`面板 ${panelIdx} 的编辑器没挂载`);
  return el;
}

function userScroll(el: HTMLElement, px: number): void {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: px }));
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}

const clamped = new WeakSet<HTMLElement>();

/** 浏览器式裁剪 + 内容高 − 视口高的自然上限（不补这层，桩永远滚不到「真·到底」）。 */
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
}

function naturalMax(el: HTMLElement): number {
  const isEditor = el.classList.contains("cm-scroller");
  const rows = isEditor
    ? el.querySelectorAll(".cm-line").length
    : el.querySelectorAll("[data-line-start]").length;
  return Math.max(0, rows * (isEditor ? rowH() : BLOCK) - VIEW_H);
}

/**
 * **视觉行高**：真机上关掉一个分屏 ⇒ 剩下那格变宽 ⇒ word_wrap 少折行 ⇒ 一条逻辑行摊的
 * 视觉行变少。桩里用「面板数 ≥ 2 就算窄栏」来表达这一维（单面板 ⇒ 整宽 ⇒ 行高 ROW）。
 */
function rowH(): number {
  return document.querySelectorAll(".layout-panel").length >= 2 ? ROW / 3 : ROW;
}

/**
 * 给 `EditorView` 装上**按 `rowH()` 实时换算**的行几何（一行 = 一块、块高 = 视觉行高）。
 *
 * ⚠️ 必须每条**动态**求值 `rowH()`：关分屏那一刻 `.layout-panel` 从 2 个变 1 个 ⇒ 行几何
 *    同帧变宽。写死在闭包里就退化成「几何不变」，本用例又变回假绿。
 */
function installLineGeometry(): void {
  const proto = EditorView.prototype as unknown as {
    lineBlockAt: unknown;
    lineBlockAtHeight: unknown;
  };
  const blockOf = (view: EditorView, n: number): unknown => {
    const doc = view.state.doc;
    const line = doc.line(Math.min(Math.max(n, 1), doc.lines));
    const top = (line.number - 1) * rowH();
    const height = rowH();
    return { from: line.from, to: line.to, top, height, bottom: top + height };
  };
  proto.lineBlockAt = function (this: EditorView, pos: number): unknown {
    const doc = this.state.doc;
    const line = doc.lineAt(Math.min(Math.max(pos, 0), doc.length));
    return blockOf(this, line.number);
  };
  proto.lineBlockAtHeight = function (this: EditorView, px: number): unknown {
    return blockOf(this, Math.floor(Math.max(0, px) / rowH()) + 1);
  };
}

/**
 * 「新建分屏」= 标签右键 → 「左右分屏」→ `onSplitTab` → `splitPanelWithTab(..., copy=true)`。
 * 见 `sync-split-narrow-off.test.ts` 里那条「为什么不能用键位」的说明：右键挂的是 copy 分支。
 */
function splitH(): void {
  const tab = document.querySelector(".layout-panel .tab") as HTMLElement | null;
  if (!tab) throw new Error("标签条上没有标签");
  tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  // ⚠️ 菜单项是 `<button>`，**自身不带 `menu-item` class**（只在 `item.active` 时才挂
  //    `menu-item-current`）—— 用 `.popup-menu .menu-item` 选会选不到（B208 那类口径坑）。
  const btn = Array.from(document.querySelectorAll<HTMLElement>(".popup-menu > button")).find(
    (b) => b.querySelector(".menu-label")?.textContent === "左右分屏",
  );
  if (!btn)
    throw new Error(
      `右键菜单里没有「左右分屏」这一项；现有项 = ${Array.from(
        document.querySelectorAll(".popup-menu .menu-label"),
      )
        .map((e) => e.textContent)
        .join("/")}；菜单数=${document.querySelectorAll(".popup-menu").length}`,
    );
  btn.click();
}

/**
 * 「减少分屏」= 面板操作区那颗 ⨯（`onClosePanel` → `closePanelById`）→ `disposePanel`。
 * ⚠️ 认它靠 **`aria-label` 前缀**（`buildPanelOps` 里 `setTip` 之后那行）：
 *    `data.closeDetail` 缺省时 aria-label = `移除该分屏（标签并入相邻面板）`；唯一面板
 *    那颗被 `disabled` 且 label 另写（"唯一面板不可移除…"）⇒ 用前缀正好把两种形态分开。
 */
function closePanelBtn(panelIdx: number): HTMLElement {
  const panel = document.querySelectorAll(".layout-panel")[panelIdx] as HTMLElement | undefined;
  if (!panel) throw new Error(`面板 ${panelIdx} 不存在`);
  const btn = Array.from(panel.querySelectorAll<HTMLElement>(".panel-op")).find((b) =>
    (b.getAttribute("aria-label") ?? "").startsWith("移除该分屏"),
  );
  if (!btn) {
    throw new Error(
      `面板 ${panelIdx} 的操作区里没有「移除该分屏」；现有 = ${Array.from(
        panel.querySelectorAll<HTMLElement>(".panel-op"),
      )
        .map((b) => b.getAttribute("aria-label") ?? b.textContent)
        .join("/")}`,
    );
  }
  if (btn.disabled) throw new Error(`面板 ${panelIdx} 的「移除该分屏」是禁用态（前提破了）`);
  btn.click();
  return btn;
}

/** 同一个游标的落点（px）= v × 当前视觉行高。 */
const V = SRC_PX / ROW; // 20.5：整宽（行高 ROW）下滚 SRC_PX 采到的游标
const NARROW_ROW = ROW / 3;
/** 分屏后两栏都窄 ⇒ 那一格按游标重落，落在这个像素上。 */
const NARROW_PX = V * NARROW_ROW; // ≈ 95.67
/** 关掉一个分屏 ⇒ 剩下那格整宽 ⇒ 同一个游标落在这里。 */
const WIDE_PX = V * ROW; // = SRC_PX = 287

describe("B261 第七轮：关掉一个分屏 ⇒ 剩下那格不许被窄栏像素钉进整宽几何", () => {
  beforeAll(async () => {
    installLineGeometry();
    await import("../src/main");
    await wait(500);
    installClamp(scroller(), () => editorMax);
    const root = document.querySelector(".layout-panel .md-preview");
    if (root) installClamp(root, () => previewMax);
  });

  it("分屏 → 关分屏：剩下的整宽面板仍停在同一行，不是被窄栏像素钉回去的那一行", async () => {
    userScroll(scroller(), SRC_PX);
    await wait(300);
    expect(scroller().scrollTop, "前提：单面板整宽，滚到 SRC_PX（行高 ROW）").toBe(SRC_PX);

    splitH();
    await wait(450);
    expect(document.querySelectorAll(".layout-panel").length, "前提：确实分出了新面板").toBe(2);
    expect(
      scroller(0).scrollTop,
      `前提：分屏后左栏按游标重落到窄栏像素 ${NARROW_PX.toFixed(2)}`,
    ).toBeCloseTo(NARROW_PX, 2);

    // ⚠️ **同步要开着才看得见病**：关完只剩一个面板、同文档再没有兄弟实例 ⇒
    //    `pushSyncToSiblings` 入口（`sibs.length === 0`）就 return，**没有任何推播会
    //    把位置扳回来**（与 `sync-split-narrow-off` 不同：那边必须关同步，这边开着也一样病）。
    //    ⚠️ 顺序不能反：`refreshSyncButton` 有 `multi = 可见实例数 > 1` 那道闸，
    //       **单实例时按钮是 hidden 态、aria-pressed 压根不会被写** ⇒ 必须先分屏再开同步。
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    if (btn.getAttribute("aria-pressed") !== "true") {
      btn.click();
      await wait(220);
    }
    expect(
      btn.getAttribute("aria-pressed"),
      "前提：同步要打开（关完分屏就没人能把它扳回来了）",
    ).toBe("true");

    closePanelBtn(1);
    await wait(450);
    expect(document.querySelectorAll(".layout-panel").length, "前提：确实关掉了一个分屏").toBe(1);

    const left = scroller().scrollTop;
    expect(
      left,
      `关掉分屏 ⇒ 剩下那格整宽，同一游标该落 ${WIDE_PX}；` +
        `而槽里那份窄栏像素 ${NARROW_PX.toFixed(2)} 钉进整宽几何是另一行`,
    ).toBeCloseTo(WIDE_PX, 2);
  });
});

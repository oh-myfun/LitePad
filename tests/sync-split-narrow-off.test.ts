// @vitest-environment jsdom
// B261 **第六轮（用户：「新建分屏时原标签内滚动位置出现了变化，可能跟面板宽度变化有关」）**
// —— `tests/sync-split-narrow.test.ts` 那组用例**盯不住**这一条，原因写在它的头注释里：
//    同步开着 ⇒ 分屏后 `refreshAll()` 尾那趟 `pushSyncToSiblings` 会以**新副本**为源，
//    按**新几何**把游标推给同文档的每一个兄弟（含原标签）⇒ 左栏那份**哪怕被旧像素
//    钉歪过也会在推播里被改回来** ⇒ 「落位排在 rebuild 前 / 后」「源那格重不重落」
//    这两个顺序维度在桩里**怎么退化都绿**（退化实测过，别再信「退化红」的直觉）。
//
// ⚠️⚠️ **所以这一组用例专门把同步「关」掉**：`pushSyncToSiblings` 入口那句
//     `if (docSyncModes.get(src.docId) !== true) return;` ⇒ 同步关着时**没有任何推播**，
//     分屏那一刻 `rebuildLayout()` 把左栏按**槽里那份旧像素**还原进**已变窄**的编辑器
//     ⇒ 旧像素在新几何下是**另一行**，而且**再也没人把它扳回来** —— 这正是用户报的
//     「原标签内滚动位置出现了变化，可能跟面板宽度变化有关」在真机上的**稳态形态**
//     （同步开着只表现为「闪一下再被推播扳回来」，同步关着是**一直错**）。
//
// ⚠️ 这一条判据盯的**正是** S11 的真根因：**分屏那一瞬间，左栏不许被旧像素 `SRC_PX`
//     钉过去**（新副本落位这条路有没有，与它无关 —— 它走的完全是另一条：`restoreViewScroll`
//     读槽 ⇒ 槽里那份是分屏前整宽量出来的像素）。
//
// ⚠️ **为什么必须是独立文件、不能并进 `sync-split-narrow.test.ts`**：本组用例要的是
//    「分屏前整宽 ⇒ 分屏后窄」这个**几何会变**的一维，而那一条的 `rowH()` 是按
//    `.layout-panel` 的个数判的（≥2 ⇒ 窄）；同一个文件里前一条已经把会话分成了 2 个面板，
//    再分下去几何**一直是窄的** ⇒ 宽度这一维当场死掉、判据又变回假绿。
//    ⇒ 这两条用例是一对互补的**拆分工况**：一条开同步（盯「两格落点一致」的结果）、
//      一条关同步（盯「旧像素不被拿去钉新几何」的**唯一可能看出病的工况**）。
//
// 桩与 `sync-split-narrow.test.ts` 同型（行高 ≠ 块高、scrollTop 带浏览器式裁剪、确定性布局、
// 行几何按面板数实时换算），判据同样是**写死的绝对落点**，不取「实际读到的值」。
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
const SRC_PX = ROW * 20 + 7; // 287：分屏前的整宽像素（= 存在槽里的「旧像素」）

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
//    并且原标签留在左栏（要被旧像素钉歪的那一个）。
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
 * **视觉行高**：真机上分屏 ⇒ 两栏半宽 ⇒ word_wrap 折行 ⇒ 一条逻辑行摊成多个视觉行。
 * 桩里用「面板数 ≥ 2 就算窄栏」来表达这一维（分屏前只有 1 个面板 ⇒ 整宽 ⇒ 行高 ROW）。
 */
function rowH(): number {
  return document.querySelectorAll(".layout-panel").length >= 2 ? ROW / 3 : ROW;
}

/**
 * 给 `EditorView` 装上**按 `rowH()` 实时换算**的行几何（一行 = 一块、块高 = 视觉行高）。
 *
 * ⚠️ 必须每条**动态**求值 `rowH()`：分屏那一刻 `.layout-panel` 从 1 个变 2 个 ⇒ 行几何
 *    同帧变窄。写死在闭包里就退化成「几何不变」，本组用例又变回假绿。
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
 *
 * ⚠️ **为什么不用键位 `panel.splitH`（Alt+Shift+→）**：那条命令 id 在 `onCommand` 里挂的是
 *    `splitActivePanel`（**移动**当前标签、原面板空了就异步塞一个空白标签），而右键挂的是
 *    `splitPanelWithTab`（**复制**）。同一个命令 id 两套语义 —— 走右键才能测到 copy 分支。
 *    ⚠️ 这条口径本身要在静态契约里钉住，别让哪天有人把两边接反。
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

/** 分屏后两栏都变窄 ⇒ 同一个游标的落点（px）= v × 窄栏视觉行高。 */
const V = SRC_PX / ROW; // 20.5：分屏前（整宽）滚 SRC_PX 采到的游标
const NARROW_ROW = ROW / 3;
const WANT = V * NARROW_ROW; // ≈ 95.67：左栏该落在这（新几何下的同一行）
/** 窄栏的自然上限：60×NARROW_ROW − VIEW_H = 238 —— 旧像素 287 钉进去只能钉到这（另一行）。 */
const NARROW_MAX = 60 * NARROW_ROW - VIEW_H;

describe("B261 第六轮：同步关着时新建分屏 ⇒ 左栏不许被旧像素钉进新几何", () => {
  beforeAll(async () => {
    installLineGeometry();
    await import("../src/main");
    await wait(500);
    // ⚠️ **这里刻意不点 `#sync-scroll`**（同步保持关）：同步一开，`refreshAll()` 尾的推播
    //    会把左栏扳回来，本用例立刻退化成「怎么退化都绿」的假绿。
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    if (btn.getAttribute("aria-pressed") === "true")
      throw new Error("前提破了：同步是关着的（本用例要的就是同步关的工况）");
    await wait(220);
    installClamp(scroller(), () => editorMax);
    const root = document.querySelector(".layout-panel .md-preview");
    if (root) installClamp(root, () => previewMax);
  });

  it("同步关着时新建分屏：原标签落在窄栏那一行，不是旧像素被裁后的那一行", async () => {
    userScroll(scroller(), SRC_PX);
    await wait(300);
    expect(scroller().scrollTop, "前提：分屏前源滚到 SRC_PX（整宽行高 ROW）").toBe(SRC_PX);

    splitH();
    await wait(450);

    expect(document.querySelectorAll(".layout-panel").length, "前提：确实分出了新面板").toBe(2);
    const left = scroller().scrollTop;
    expect(
      left,
      `同步关着 ⇒ 没有推播会扳回来，左栏还按旧像素钉着：` +
        `旧像素 ${SRC_PX} 在窄栏被裁到 ${NARROW_MAX}（应 ${WANT.toFixed(2)}）`,
    ).toBeCloseTo(WANT, 2);
    // ⚠️ 顺带守一眼右栏：新副本那条落位（`landPreviewAtSource`）与有没有推播无关，
    //    它不走 `docSyncModes` 闸 —— 退化掉它这里要红，别误读成「同步关了它该不动」。
    expect(
      scroller(1).scrollTop,
      `新建分屏的那份副本没落在新几何的同一行（应 ${WANT.toFixed(2)}）`,
    ).toBeCloseTo(WANT, 2);
  });
});

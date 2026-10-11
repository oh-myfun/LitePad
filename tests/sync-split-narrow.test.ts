// @vitest-environment jsdom
// B261 **第四轮（用户：「新建分屏时原标签内滚动位置出现了变化，可能跟面板宽度变化有关」）**：
// 上面那几条用例在真机上**从来没修好过症状②**，因为**桩没有布局、没有宽度** —— 分屏那一刻
// 左栏从整宽变半宽、编辑器折行重排，同一样 `scrollTop` 像素在新几何下是**另一行**；而这份
// 实例的槽里**只有像素**（`recordScroll` 直接写 px），跨宽度的尺子只有**游标 `v`**。
//
// ⚠️ 所以这一组用例专门补上「宽度会变」这一维：**桩按面板数决定视觉行高** —— 单面板（整宽）
//    ⇒ 行高 `ROW`；一旦出现 ≥2 个面板（分屏 ⇒ 两栏都半宽）⇒ 视觉行高 `ROW/3`（真机上 word_wrap
//    开着，窄栏把一条逻辑行摊成好几个视觉行 ⇒ 行更密 ⇒ 内容更高）。
//    分屏前源滚到 `SRC_PX` ⇒ 采到的游标 `v` = 20.5（旧几何）；分屏后两格都应当落在**新几何**
//    的同一行 ⇒ 落点 = 20.5 × ROW/3（≈ 95.67），**不是** 20.5 × ROW（287）。
//    ⚠️ 第五轮实测订正（别被「退化该红」的直觉骗了）：把落位移回 `rebuildLayout()` 之前，
//       本组用例**照样绿**（两侧都还是 95.67）—— 因为同步落位之后 `refreshAll()` 那趟
//       推播会以新副本为源、按**新几何**把游标推给同文档每个兄弟，两格都被推到位。
//       ⇒ 这条判据盯的是**最终两格都落在按新几何算出的同一位置**这个**结果**，
//         **盯不住**「落位排 rebuild 前后」这个顺序（顺序那条在桩里被推播兜掉了），
//         更盯不住「源与新副本各显式落一遍」。
//       ⚠️ 同步关着时它连 S11 都盯不住（见下面第六轮那条）：`pushSyncToSiblings` 入口那句
//         `docSyncModes` 闸 ⇒ 关着时没有推播会扳回来，S11 的真形态只在那边现形。
//
// ⚠️ 第五轮订正：这一条判据盯的是**「落位排 `rebuildLayout()` 之后」这个顺序**，
//    **不是**「源与新副本各显式落一次」。同步落位之后 `refreshAll()` 那趟推播会以新副本
//    为源把游标推给同文档的每一个兄弟 ⇒ 左栏那份自然落到同一位置。所以「摘掉源那格的重落」
//    桩里**也绿**（退化实测过）—— 那是推播覆盖的结果，判据因此没有鉴别力。
//
// ⚠️⚠️ **第六轮订正（第五轮那句「别再加回冗余代码」是错的，本轮把源那格那一行加回来了）**：
//    上面「摘掉源那格的重落 ⇒ 桩里也绿」的实测**只在同步开着时才成立** —— 推播确实会兜。
//    但 `pushSyncToSiblings` 入口那句 `docSyncModes.get(src.docId) !== true ⇒ return` 意味着
//    **同步关着根本没有推播**，而左栏是 `rebuildLayout()` → `restoreViewScroll`
//    拿**槽里那份分屏前按整宽量出来的旧像素**还原进**已变窄**的编辑器 ⇒ 旧像素在新几何下是
//    另一行、**再没人把它扳回来** —— 这正是用户报的「新建分屏时原标签内滚动位置出现了变化
//    （可能跟面板宽度变化有关）」在真机上的**稳态形态**：同步开着只闪一下就被推播扳回正确
//    位置，同步关着是**一直错**。
//    ⇒ 本轮在 `src/main.ts` 的 copy 分支里把「源那格的重落」**加回来**
//      （`landPreviewAtSource(tab, vCopy)`，排在 `rebuildLayout()` 之后、用新几何，
//      与新副本走同一个源游标），并补一条**同步关着**的工况用例
//      `tests/sync-split-narrow-off.test.ts`：退化「摘掉源那格这一行」⇒ **那条红**
//      （左栏 287 ≠ 95.67）、**本条照样绿**（推播兜着）。
//      ⚠️ 两条用例是**互补的一对**：本条（同步开）守「两格落点一致」的结果，那条（同步关）
//      守「旧像素不被拿去钉新几何」本身 —— 只留任何一条，S11 都会变回「怎么退化都绿」的
//      假绿。谁也别再把源那格那一行当冗余删掉。
//
// ⚠️⚠️ **为什么还要覆写 `EditorView` 的行几何**：jsdom 不做布局，CM6 量行走 DOM Range，而
//    jsdom 的 `Range.getClientRects()` 恒空 ⇒ CM6 退回「估算行高」，行位置**建 view 那一帧
//    就定死、再也不动**（自测台探针：分屏后 `lineBlockAt(21行).top` 仍是整宽那套的 280）。
//    于是「面板变窄 ⇒ 折行 ⇒ 行更密」这一维在桩里**根本表达不出来** —— 上面那几条「真退化」
//    之所以全绿，根子就在这。所以这里直接把行几何交给桩：一行一个块、块高 = `rowH()`，
//    每次调用都**动态**按当前面板数重算 ⇒ 分屏那一刻几何真的变了。
//
// B261：**「新建分屏」（右键「左右分屏」/ Alt+Shift+→）⇒ 原标签不许被推到文档开头。
//
// 入口：标签右键 → 「左右分屏」→ `onSplitTab` → `splitPanelWithTab(..., copy=true)` 的
// copy 分支。那个分支尾部的 `rebuildLayout(); refreshAll();` ⇒ `refreshAll` 最后那件事是
// `pushSyncToSiblings(activeTab())`（B152：新出现的那一份该对齐当前激活文档），而此刻
// `activeTab()` 正是**刚 `makeInstance` 出来的那份空档副本**（`scrollTop: null` ⇒
// `sourceCursorPx` 退读 DOM ⇒ 恒 0 ⇒ 游标 `v` = 1）⇒ 顺着 `applySyncToSibling` 把**同
// 文档的那些兄弟（含原标签）**记成 `top = 0` 并钉进 DOM。
//
// ⚠️ 实测（自测台，24 行 md / 视口 3 行）：退化掉落位那两行 ⇒ 原标签与新副本**双双顶到
//    0**；补回来 ⇒ 两边都是 287（原标签不动、新副本落在源的那一格）。
//
// ⚠️ 与 B259 的区别：这次不只夹推播的问题 —— 连 **`landPreviewAtSource` 落位**都没有。
//    `openPreviewToSide` 那一路有它（B259 补的），所以在「开侧边预览」上只看得出「新那份
//    落在开头」；copy 分支这条路上，新副本的槽从 `null` 一路空到 `restoreViewScroll`，
//    顺带让推播有空子可钻，于是原标签也一起被拽到 0。用户报「两个问题都还在」。
//
// ⚠️ 为什么用右键这条入口而**不用**键位 `panel.splitH`（Alt+Shift+→）：那条命令 id 在
//    `onCommand` 里挂的是 `splitActivePanel`（**移动**当前标签，原面板空了就异步补一个
//    空白标签），右键挂的是 `splitPanelWithTab`（**复制**）。同一个命令 id 两套语义，
//    测 copy 分支只能走右键 —— 这条口径本身由 `tests/layout.test.ts` 钉着，别接反。
//
// 桩与 `sync-side-preview.test.ts` 同型（行高 ≠ 块高、scrollTop 带浏览器式裁剪、确定性
// 布局），判据是**写死的绝对落点**，不取「实际读到的值」—— 后者在退化时基线本身就带错值，
// 会「恒等于错值」而绿。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";

/** 源码行高（px）。 */
const ROW = 14;
/** ⚠️ 预览块高（px）：刻意 3 倍于行高 —— 跨侧（块 ⇄ 行）的换算错才量得出来。 */
const BLOCK = ROW * 3;
/** 视口高（px）：3 行 ⇒ 源码自然上限 = 24×14 − 42 = 294，预览 = 24×42 − 42 = 966。 */
const VIEW_H = ROW * 3;
/** 源码滚动位置（px）：压在**行中间**（+7）⇒ 游标带 0.5 的行内比例。 */
const SRC_PX = ROW * 20 + 7; // 287

/** md 正文：一行一个标题 ⇒ 预览块 k 与源码行 k+1 一一对应，块顶 = k×BLOCK。
 *  ⚠️ 行数取 60：窄栏（行高 ROW/3）下内容高 = 60×14/3 = 280 ⇒ 自然上限 280 − 42 = 238，
 *    判据里的落点 95.67 不会被裁剪掩盖掉（24 行时上限只有 70，会被 clamp 截到同一批值）。*/
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
//    并且原标签留在左栏（要被推的那一个）。
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
 *
 * ⚠️ 这是**真机确实存在**、而不是往桩里塞假真机行为的一维 —— 上一轮那两组「真退化」全绿
 *    恰恰是因为桩里这一维恒等于「没变」⇒ 假绿。
 */
function rowH(): number {
  return document.querySelectorAll(".layout-panel").length >= 2 ? ROW / 3 : ROW;
}

/**
 * 给 `EditorView` 装上**按 `rowH()` 实时换算**的行几何（一行 = 一块、块高 = 视觉行高）。
 *
 * ⚠️ 必须每条**动态**求值 `rowH()`：分屏那一刻 `.layout-panel` 从 1 个变 2 个 ⇒ 行几何
 *    同帧变窄。写死在闭包里就退化成「几何不变」，本组用例又变回假绿。
 *
 * ⚠️ 两个方法都得覆：`topVisibleLineFrac`（取值口）走 `lineBlockAtHeight` 找视口顶行 +
 *    `lineBlockAt` 取行顶、`sourceTopOfV`（落点出口）走 `lineBlockAt`。只覆一个，
 *    取与落就会各按各的几何 ⇒ 互逆性被打破、往返漂移。
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

/** 同步滚动按钮（`#sync-scroll`）的当前开合。 */
function syncOn(): boolean {
  const btn = document.getElementById("sync-scroll") as HTMLElement | null;
  if (!btn) throw new Error("同步键没出现");
  return btn.getAttribute("aria-pressed") === "true";
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
const WANT = V * NARROW_ROW; // ≈ 95.67：两格都该落在这（新几何下的同一行）

describe("B261 第四轮：新建分屏 ⇒ 面板宽度变了，两格都按新几何落在同一行", () => {
  beforeAll(async () => {
    installLineGeometry();
    await import("../src/main");
    await wait(500);
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    if (!syncOn()) btn.click();
    await wait(220);
    installClamp(scroller(), () => editorMax);
    const root = document.querySelector(".layout-panel .md-preview");
    if (root) installClamp(root, () => previewMax);
  });

  it("新建分屏：原标签与新副本都落在窄栏的同一行（不是旧像素的那一行）", async () => {
    userScroll(scroller(), SRC_PX);
    await wait(300);
    expect(scroller().scrollTop, "前提：分屏前源滚到 SRC_PX（整宽行高 ROW）").toBe(SRC_PX);

    splitH();
    await wait(450);

    expect(document.querySelectorAll(".layout-panel").length, "前提：确实分出了新面板").toBe(2);
    // ⚠️ 分屏后两栏都窄：源（左栏）与新副本（右栏）都该落在 **WANT**，
    //    退化（落位排在 rebuildLayout 之前 ⇒ 按旧几何换算、按旧像素钉）⇒ 两格都停在 287。
    const both = `${scroller().scrollTop}/${scroller(1).scrollTop}`;
    expect(
      scroller().scrollTop,
      `新建分屏后左栏（原标签）落在旧像素那一行了（应 ${WANT.toFixed(2)}，两侧实测 = ${both}）`,
    ).toBeCloseTo(WANT, 2);
    expect(
      scroller(1).scrollTop,
      `新建分屏的那份副本没落在新几何的同一行（应 ${WANT.toFixed(2)}）`,
    ).toBeCloseTo(WANT, 2);
  });
});

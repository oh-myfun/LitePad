// @vitest-environment jsdom
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

/** 源码行高（px）。 */
const ROW = 14;
/** ⚠️ 预览块高（px）：刻意 3 倍于行高 —— 跨侧（块 ⇄ 行）的换算错才量得出来。 */
const BLOCK = ROW * 3;
/** 视口高（px）：3 行 ⇒ 源码自然上限 = 24×14 − 42 = 294，预览 = 24×42 − 42 = 966。 */
const VIEW_H = ROW * 3;
/** 源码滚动位置（px）：压在**行中间**（+7）⇒ 游标带 0.5 的行内比例。 */
const SRC_PX = ROW * 20 + 7; // 287
/** 分屏那一帧里用户滚到的另一处（在自然上限 294 之内）。 */
const OTHER = ROW * 14; // 196

/** md 正文：一行一个标题 ⇒ 预览块 k 与源码行 k+1 一一对应，块顶 = k×BLOCK。 */
const MD = Array.from({ length: 24 }, (_, i) => `# 标题 ${i + 1}`).join("\n");

const editorMax = Infinity;
const previewMax = Infinity;

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;

  // 确定性布局：预览容器顶边 = 它自己的 scrollTop；`.cm-line` 顶边 = DOM 序 × 行高；
  // 预览块顶边 = DOM 序 × 块高。
  const proto = window.Element.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
  };
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    const el = this as HTMLElement;
    const isRoot = el.classList.contains("md-preview");
    const isLine = el.classList.contains("cm-line");
    const idx = Math.max(0, Array.prototype.indexOf.call(el.parentElement?.children ?? [], el));
    const top = isRoot ? el.scrollTop : isLine ? idx * ROW : idx * BLOCK;
    const height = isRoot || isLine ? ROW : 0;
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
  return Math.max(0, rows * (isEditor ? ROW : BLOCK) - VIEW_H);
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

describe("B261：新建分屏 ⇒ 原标签不许被推到文档开头", () => {
  beforeAll(async () => {
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

  it("新建分屏：原标签保持在 SRC_PX，新副本落在源的那一格", async () => {
    userScroll(scroller(), SRC_PX);
    await wait(300);
    expect(scroller().scrollTop, "前提：源滚到 SRC_PX").toBe(SRC_PX);

    splitH();
    await wait(450);

    expect(document.querySelectorAll(".layout-panel").length, "前提：确实分出了新面板").toBe(2);
    // ⚠️ 防假绿：先自证「没修」时这里会是 0 —— 否则这条判据恒真、退化也不红。
    expect(
      scroller().scrollTop,
      `新建分屏把原标签带跑了（应该还是 SRC_PX）；两侧实测 = ${scroller().scrollTop}/${scroller(1).scrollTop}`,
    ).toBe(SRC_PX);
    expect(scroller(1).scrollTop, "新建分屏的那份副本没落在源的那一格").toBe(SRC_PX);
  });

  // ⚠️⚠️ B261 第五轮：这条守的是**落位的时序**，不是落点。
  //   第四轮把 copy 分支的落位做成 `rAF + setTimeout(0)`（本意是等 CM6 量出新几何），
  //   于是分屏那一帧里**先发生**的任何事（用户滚一下 / 切标签 / 又跑一轮 rebuildLayout）
  //   都会被那一拍**用分屏前采的陈旧游标 `vCopy` 盖回去** —— 那一拍还按
  //   `displayedPanelOfTab(other.tabId)` 现取面板，取的很可能已经不是落位时那一份。
  //   真机表现：用户报「切标签 / 切换不同步」；桩里用这一条把它钉住：
  //   **分屏当场落位 ⇒ 之后用户滚到哪就该停哪**。
  //   退化（把两格落位移进 `setTimeout(0)` 跨过一帧）⇒ 位置被旧游标钉回 SRC_PX ⇒ 本例精确红。
  it("分屏后的那一帧里发生滚动/切换，落位不许把位置按分屏前的旧游标盖回去", async () => {
    await wait(200);
    expect(
      scroller().scrollTop,
      `前提：上一例已分屏并同步落位，此刻左栏 = ${scroller().scrollTop}`,
    ).toBe(SRC_PX);

    // ⚠️ **必须再分一次屏**：待跑的那一拍是 copy 分支注册出来的，上一例那拍早就跑完了。
    //    不重新触发，这一例里根本不存在「跨帧落位」可盯 ⇒ 退化也绿（第一次写这条时
    //    就栽在这：用例测了个空气）。
    splitH(); // ← 这次分屏才注册落位那一拍
    // ⚠️ 落位注册之后、那一拍跑之前，用户滚到了别处（真机 = 同一帧里滚了/切了）
    userScroll(scroller(), OTHER);
    await wait(300);

    const both = `${scroller().scrollTop}/${scroller(1).scrollTop}`;
    expect(
      scroller().scrollTop,
      `分屏那一帧里滚了却被分屏前的旧游标钉回去了（应 ${OTHER}，两侧实测 = ${both}）`,
    ).toBe(OTHER);
    expect(
      scroller(1).scrollTop,
      `新副本没跟上那一帧里的滚动（应 ${OTHER}，两侧实测 = ${both}）`,
    ).toBe(OTHER);
  });
});

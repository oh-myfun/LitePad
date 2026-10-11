// @vitest-environment jsdom
// B261 第三处同型缺口：**「复制标签」⇒ 新副本的滚动位置没被带上**（用户：复制标签也有同样
// 的问题，滚动位置没有复制）。
//
// 入口：标签右键 → 「复制标签」/「复制到相邻面板」/ Ctrl 拖到面板中心 → `duplicateTabToPanel`
// → `makeInstance`（空档实例：`scrollTop: null`、编辑器视口恒 0）→ `attachTabToPanel` →
// `rebuildLayout(); refreshAll();`。这条路径**从头到尾没有任何落位**（B261 前两轮修的是
// `splitPanelWithTab` 的 copy 分支与 `openPreviewToSide`，都没盖到它）⇒ 两面受害：
//   · **新副本自己**停在文档开头（用户报的那个症状）：它的槽一直是 `null`，直到
//     `restoreViewScroll` 才轮到它，而此刻面板刚挂上、视口是 0；
//   · **同文档的原标签**被 `refreshAll` 尾那趟 `pushSyncToSiblings(activeTab())` 以这份
//     空档为源推成 `top = 0` 并钉进 DOM（与 copy 分支同一个病根，B152/B254）。
//
// ⚠️ 修法与 copy 分支同口径：在 `rebuildLayout()` **之前**先 `syncSourceV(src)` 采游标、
//    `landPreviewAtSource(inst, v)` 落到新实例上（排在任何重建之前 —— 源此刻还在屏上）。
//
// ⚠️ 为什么先要用「左右分屏」造出两个面板：菜单项「复制到相邻面板」只在 `hasSibling` 时才
//    出现（见 `src/shell/tabstrip.ts`），单面板下只能测「复制标签」（复制到本面板 ⇒ 还得
//    再点一次新标签才看得到位置，一眼判不了）。这里走「分屏造邻 → 滚 → 复制标签到邻」，
//    新副本立刻落在邻面板并显示 ⇒ 两个面板的落点同帧可读。
//
// 桩与 `sync-split-copy.test.ts` 完全同型（行高 ≠ 块高、scrollTop 带浏览器式裁剪、确定性
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
 * 在指定面板的标签上打开右键菜单并点某一项。
 *
 * ⚠️ 菜单项是 `<button>`，**自身不带 `menu-item` class**（只在 `item.active` 时才挂
 *    `menu-item-current`）—— 用 `.popup-menu .menu-item` 选会选不到（B208 那类口径坑）。
 */
function clickMenu(label: string, tab: HTMLElement): void {
  tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const btn = Array.from(document.querySelectorAll<HTMLElement>(".popup-menu > button")).find(
    (b) => b.querySelector(".menu-label")?.textContent === label,
  );
  if (!btn)
    throw new Error(
      `右键菜单里没有「${label}」这一项；现有项 = ${Array.from(
        document.querySelectorAll(".popup-menu .menu-label"),
      )
        .map((e) => e.textContent)
        .join("/")}；菜单数=${document.querySelectorAll(".popup-menu").length}`,
    );
  btn.click();
}

/** 某个面板里的第一颗标签（面板序 = 布局叶子序，左→右）。 */
function tabInPanel(idx: number): HTMLElement {
  const p = document.querySelectorAll(".layout-panel")[idx] as HTMLElement | undefined;
  const t = p?.querySelector(".tab") as HTMLElement | null;
  if (!t) throw new Error(`面板 ${idx} 的标签条上没有标签`);
  return t;
}

/**
 * 「新建分屏」= 标签右键 → 「左右分屏」→ `onSplitTab` → `splitPanelWithTab(..., copy=true)`。
 *
 * ⚠️ **为什么不用键位 `panel.splitH`（Alt+Shift+→）**：那条命令 id 在 `onCommand` 里挂的是
 *    `splitActivePanel`（**移动**当前标签、原面板空了就异步塞一个空白标签），而右键挂的是
 *    `splitPanelWithTab`（**复制**）。同一个命令 id 两套语义 —— 走右键才能测到 copy 分支。
 *    ⚠️ 这条口径本身要在静态契约里钉住，别让哪天有人把两边接反。
 *
 * ⚠️ 这里的「左右分屏」只是**造一个邻居**（让「复制到相邻面板」这一项出现），
 *    它自己的落位由 `tests/sync-split-copy.test.ts` 看着。
 */
function splitH(): void {
  clickMenu("左右分屏", tabInPanel(0));
}

describe("B261：复制标签 ⇒ 新副本要带上源的滚动位置，原标签不许被推到文档开头", () => {
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

  it("复制标签：新副本落在 SRC_PX，原标签也不许被推走", async () => {
    // 第一步：分屏造出邻居（左 0 / 右 1），且新副本已落在源的那一格 —— 后面要拿它当源。
    splitH();
    await wait(450);
    expect(document.querySelectorAll(".layout-panel").length, "前提：分出了两个面板").toBe(2);
    installClamp(scroller(1), () => editorMax);
    installClamp(scroller(0), () => editorMax);

    // 第二步：滚到 SRC_PX（此时**右栏**是活动面板）。
    userScroll(scroller(1), SRC_PX);
    await wait(300);
    expect(scroller(1).scrollTop, "前提：源（右栏）滚到 SRC_PX").toBe(SRC_PX);

    // 第三步：右键**右栏**的标签 → 「复制到相邻面板」⇒ 新副本落到**左栏**并显示。
    clickMenu("复制到相邻面板", tabInPanel(1));
    await wait(450);

    // ⚠️ 两个面板都是同文档同排版，两侧落点必须一模一样（绝对判据，退化时这里会是 0）。
    const both = `${scroller(0).scrollTop}/${scroller(1).scrollTop}`;
    expect(
      scroller(0).scrollTop,
      `复制标签：新副本没带上源的滚动位置（应 ${SRC_PX}，两侧实测 = ${both}）`,
    ).toBe(SRC_PX);
    expect(scroller(1).scrollTop, `复制标签把原标签带跑了（应 ${SRC_PX}，实测 = ${both}）`).toBe(
      SRC_PX,
    );
  });
});

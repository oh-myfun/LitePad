// @vitest-environment jsdom
// **B264（用户报：打开同文件标签 2 个 —— 源码 / 预览任意组合；初始未分屏；把其中一个标签
// **拖拽**成第二个分屏 ⇒ 滚动位置出现偏移，且两个标签滚动位置出现差异）**
//
// 链路：`dragstart(.tab)` → `tabdnd.startTabDrag` → 页面级 `dragover/drop`
//   → `previewDropAt` / `commitTabDrop` → `onDropTabToPanel(tabId, panelId, zone, over, ctrl)`
//   → 同面板 + 非 Ctrl + zone≠center ⇒ `splitPanelWithTab(..., copy=false)` = **move 支**
//    （把标签从这一格**搬**到新建的那一格，不是复制；与 B261/B262 修的 **copy 支**是同一
//     入口的两条分支）。
//
// ⚠️ move 支与 copy 支的差别（本用例守的就是这两条）：
//   · copy 支：`vCopy = syncSourceV(tab)` → `rebuildLayout()` → 两格 `landOnFrameGeometry`；
//   · move 支原本：直接 `rebuildLayout(); refreshAll();` —— **一个游标都不采、一次都不重落**。
//
// 桩沿用 `sync-three-tabs.test.ts` 那套（行高 ≠ 块高、离屏 report 0、补 jsdom 滚动尺寸），
// 另加一维：**面板数决定几何**（分屏 ⇒ 两栏都半宽 ⇒ 一行摊成更多视觉行，`rowH` 14 → 7）。
// ⚠️ 这条不是装饰：桩里 `rowH()` 一变，「旧像素在新几何下是另一行」才量得出来 —— 与
//    `sync-split-narrow.test.ts` 同一手法（必须块高 ≠ 行高，否则跨侧换算被量纲巧合抹平）。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";
import { makeDataTransfer, fireDrag } from "./dnd";

/** 最近一次会话落盘（800ms 防抖）。 */
const cap = vi.hoisted(() => ({
  session: null as null | {
    panels: { tabs: { scrollTop?: number | null; syncV?: number | null }[] }[];
  },
}));
type CapSession = { panels: { tabs: { scrollTop?: number | null; syncV?: number | null }[] }[] };

const ROW = 14;
/** 预览块高：逐块不同（14/25/36 循环）—— 与行高脱钩，跨侧换算才量得出来。 */
const blockH = (i: number): number => ROW + (i % 3) * 11;
function blockTopOf(k: number): number {
  let t = 0;
  for (let i = 0; i < k; i++) t += blockH(i);
  return t;
}
const SRC_PX = 100; // 刻意非行高整数倍
const MD = Array.from({ length: 60 }, (_, i) => `# 标题 ${i + 1}`).join("\n");

/** 真机：分屏 ⇒ 两栏半宽 ⇒ word_wrap 折行 ⇒ 一行摊成多个视觉行。 */
function rowH(): number {
  return document.querySelectorAll(".layout-panel").length >= 2 ? ROW / 2 : ROW;
}
/** 分屏前的期望游标（整宽行高 14，滚 100px ⇒ 第 8.14 行）。 */
const EXPECT_V = SRC_PX / ROW + 1;

function hiddenHost(el: Element): boolean {
  let p: Element | null = el;
  while (p) {
    const c = (p as HTMLElement).classList;
    if (c?.contains("panel-host") && c.contains("mode-preview")) return true;
    p = p.parentElement;
  }
  return false;
}

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;

  const proto = window.Element.prototype as unknown as { getBoundingClientRect: () => DOMRect };
  const protoRects = window.Element.prototype as unknown as { getClientRects: () => DOMRectList };
  protoRects.getClientRects = function (this: Element): DOMRectList {
    return hiddenHost(this)
      ? ([] as unknown as DOMRectList)
      : ([this.getBoundingClientRect()] as unknown as DOMRectList);
  };
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    const el = this as HTMLElement;
    const cls = el.classList;
    const isRoot = cls.contains("md-preview");
    const isLine = cls.contains("cm-line");
    const idx = Math.max(0, Array.prototype.indexOf.call(el.parentElement?.children ?? [], el));
    const ls = (el as HTMLElement).dataset?.lineStart;
    const isBlock = !isRoot && !isLine && ls !== undefined;
    const bi = isBlock ? Number(ls) - 1 : 0;
    // ⚠️ 面板按 DOM 序**均分**窗口宽：单栏 = 整宽，分屏后两栏各半 ⇒ 落点几何真的变了。
    const panels = Array.from(document.querySelectorAll<HTMLElement>(".layout-panel"));
    const pi = Math.max(0, panels.indexOf(el));
    // ⚠️ 标签条是**顶部一条窄带**：落点判定（stripUnder / tabUnder）全靠它。给了整高矩形
    //    会把「拖到面板右缘」误判成落在标签区（center ⇒ 只排序、不分屏）。
    const isStrip = cls.contains("panel-tabstrip");
    // ⚠️⚠️ **`.tab` 必须是「标签条上的一小格」**：早先它掉进 generic 分支（整面板大矩形，
    //     0..1200 × 0..800）⇒ `tabUnder` 在任何落点都命中 ⇒ 拖到面板右缘也被判成「落在
    //     标签区」⇒ `onDropTabToPanel` 走 `reorderTabInPanel`（只排序、不分屏）⇒ 这一手
    //     在桩里永远跑不出来。分屏 / 排序两种口径就差这条 rect，桩给错 = 复现台空转。
    const isTab = cls.contains("tab") && !isStrip;
    const left = isTab
      ? Math.max(
          0,
          Array.prototype.indexOf.call(
            el.parentElement?.querySelectorAll<HTMLElement>(".tab") ?? [],
            el,
          ),
        ) * 140
      : (pi * 1200) / Math.max(1, panels.length);
    const top = isRoot ? el.scrollTop : isLine ? idx * rowH() : isBlock ? blockTopOf(bi) : 0;
    const w = isTab ? 140 : 1200 / Math.max(1, panels.length);
    const height = isRoot
      ? ROW
      : isLine
        ? rowH()
        : isBlock
          ? blockH(bi)
          : isStrip || isTab
            ? 40
            : 800;
    return {
      top,
      left,
      right: left + w,
      bottom: top + height,
      width: w,
      height,
      x: left,
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

// 单面板 + 同文件两标签（源码 tab1 / 预览 tab2）⇒ 初始未分屏，拖一个出去才分出第二栏。
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
  logEvent: () => {},
  newTab: () =>
    Promise.resolve({ tabId: 9, name: "未命名", readonly: false, encoding: "UTF-8", eol: "CRLF" }),
  openFile: () =>
    Promise.resolve({
      tabId: 0,
      text: MD,
      name: "a.md",
      path: "a.md",
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
  saveSession: (s: unknown) => {
    cap.session = s as CapSession;
    return Promise.resolve();
  },
  saveSettings: () => Promise.resolve(),
  writeBackup: () => Promise.resolve(),
  restoreBackup: () => Promise.resolve(null),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
  // 桩里没用到的导出：缺了会静默降级（见 pitfalls/0109），给全。
  takePendingFiles: () => [],
}));

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function userScroll(el: HTMLElement, px: number): void {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: px }));
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}
const clamped = new WeakSet<HTMLElement>();
function installClamp(el: HTMLElement): void {
  if (clamped.has(el)) return;
  clamped.add(el);
  let st = el.scrollTop;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => st,
    set: (v: number) => {
      st = Math.min(Math.max(v, 0), Infinity);
    },
  });
}
const DOC_LINES = 60;
function installMetrics(el: HTMLElement, isPrev: boolean): void {
  const line = () => (isPrev ? blockH(0) : rowH());
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => DOC_LINES * line() });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 4 * line() });
}
function installLineGeometry(): void {
  const proto = EditorView.prototype as unknown as {
    lineBlockAt: unknown;
    lineBlockAtHeight: unknown;
  };
  const blockOf = (view: EditorView, n: number): unknown => {
    const line = view.state.doc.line(Math.min(Math.max(n, 1), view.state.doc.lines));
    const top = (line.number - 1) * rowH();
    return { from: line.from, to: line.to, top, height: rowH(), bottom: top + rowH() };
  };
  const blockOfLive = (view: EditorView, n: number): unknown =>
    hiddenHost(view.scrollDOM)
      ? { from: 0, to: 0, top: 0, height: 0, bottom: 0 }
      : blockOf(view, n);
  proto.lineBlockAt = function (this: EditorView, pos: number): unknown {
    const line = this.state.doc.lineAt(Math.min(Math.max(pos, 0), this.state.doc.length));
    return blockOfLive(this, line.number);
  };
  proto.lineBlockAtHeight = function (this: EditorView, px: number): unknown {
    return blockOfLive(this, Math.floor(Math.max(0, px) / rowH()) + 1);
  };
}

const panels = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(".layout-panel"));
function host(i: number): HTMLElement {
  const h = panels()[i]?.querySelector<HTMLElement>(".panel-host");
  if (!h) throw new Error(`面板 ${i} 没有 .panel-host`);
  return h;
}
const srcEl = (i = 0): HTMLElement => host(i).querySelector(".cm-scroller") as HTMLElement;
const prevEl = (i = 0): HTMLElement | null =>
  host(i).querySelector(".md-preview") as HTMLElement | null;

/** 把第 `tabIdx` 个标签拖到**自己面板的右缘** ⇒ 分屏（move 支）。 */
function dragTabToRightEdge(tabIdx: number): void {
  const el = Array.from(document.querySelectorAll<HTMLElement>(".panel-tabstrip .tab"))[tabIdx];
  if (!el) throw new Error(`没有第 ${tabIdx} 个标签`);
  const dt = makeDataTransfer();
  fireDrag("dragstart", el, dt);
  const over = fireDrag("dragover", document, dt, { clientX: 1100, clientY: 300 });
  const drop = fireDrag("drop", document, dt, { clientX: 1100, clientY: 300 });
  fireDrag("dragend", el, dt);
  if (!over.defaultPrevented || !drop.defaultPrevented) {
    throw new Error("标签拖拽没被页面认领（dragover/drop 没 preventDefault）");
  }
}

/** 一格此刻的游标 v（源码格：1-based 行号+行内比例；预览格：块 start + 比例×跨行数）。 */
function vOf(el: HTMLElement | null): number | null {
  if (!el) return null;
  if (el.classList.contains("cm-scroller")) return el.scrollTop / rowH() + 1;
  const blocks = Array.from(el.children) as HTMLElement[];
  let idx = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (blockTopOf(i) <= el.scrollTop + 1e-6) idx = i;
    else break;
  }
  if (idx < 0) return null;
  const s = Number(blocks[idx].dataset.lineStart);
  const next = blocks[idx + 1];
  if (!next) return s;
  const range = Number(next.dataset.lineStart) - s;
  const ratio = Math.min(
    1,
    Math.max(0, (el.scrollTop - blockTopOf(idx)) / (blockTopOf(idx + 1) - blockTopOf(idx))),
  );
  return s + ratio * range;
}

describe("B264 同文件两标签、单栏 → 拖标签成第二个分屏", () => {
  it("拖离屏（预览）标签出去：两格游标一致、位置不被抹回开头", async () => {
    installLineGeometry();
    await import("../src/main");
    await wait(500);
    for (let i = 0; i < panels().length; i++) {
      for (const el of [srcEl(i), prevEl(i)]) {
        if (!el) continue;
        installClamp(el);
        installMetrics(el, el.classList.contains("md-preview"));
      }
    }
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click();
    await wait(200);

    expect(panels().length, "前提：初始单栏").toBe(1);
    expect(vOf(srcEl()), "前提：分屏前整宽几何下游标 = 1").toBeCloseTo(1, 6);

    userScroll(srcEl(), SRC_PX);
    await wait(300);
    const vBefore = vOf(srcEl());
    expect(vBefore, "前提：分屏前游标 = 行号比例合一").toBeCloseTo(EXPECT_V, 2);

    // 把**离屏的预览标签**拖出去 ⇒ move 支。此刻屏幕上真在显示的源码格是 tab1，被拖的
    // 是离屏的 tab2 —— 游标必须采「屏幕上真显示的那一份」（B264 的病点之一）。
    dragTabToRightEdge(1);
    await wait(500);

    expect(panels().length, "拖到面板右缘应真的分出第二格").toBe(2);
    const vSrc = vOf(srcEl(0));
    const vPrev = vOf(prevEl(1));
    // ⚠️ 反例闸：v≈1 就是「被推播钉回文档开头」的那条病路（修复前 ② 实测就是这个值）。
    expect(vSrc, "老源码格不许被同步推播钉回开头").toBeGreaterThan(EXPECT_V - 1);
    expect(vPrev, "新预览格不许被同步推播钉回开头").toBeGreaterThan(EXPECT_V - 1);
    expect(vSrc, "分屏后老格游标）。").toBeCloseTo(EXPECT_V, 1);
    expect(vPrev, "分屏后新格游标（两格不许出现差异）").toBeCloseTo(EXPECT_V, 1);
    expect(vSrc, "两格游标一致").toBeCloseTo(vPrev as number, 1);
    // ⚠️ 几何换算：分屏后半宽 ⇒ 行高 14 → 7，v=8.14 落下去应是 (8.14-1)×7 ≈ 50，
    //    不是分屏前那枚**旧像素** 100（跨几何的旧像素是另一行）。
    expect(srcEl(0).scrollTop, "老格要按新几何落，不能拿旧像素").toBeCloseTo(
      (EXPECT_V - 1) * (ROW / 2),
      0,
    );

    await wait(1400); // 800ms 会话防抖
    // B288⑤-1c：落盘已无像素 —— 盯规范游标（不许两格都被抹成 null）。
    const rec = (cap.session?.panels ?? []).flatMap((p) => p.tabs.map((t) => t.syncV));
    expect(rec.length, "会话应记两格").toBe(2);
    expect(
      rec.filter((v) => v !== null && v !== undefined).length,
      "会话不许把两格游标都抹成 null",
    ).toBeGreaterThanOrEqual(1);
    expect(
      rec.some((v) => Math.abs((v ?? 0) - EXPECT_V) < 1),
      "会话里得留着源码格这份游标（修复前实测 null | null ⇒ 位置永久丢）",
    ).toBe(true);
  });
});

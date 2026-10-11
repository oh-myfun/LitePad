// @vitest-environment jsdom
// B262（用户报：「打开侧边预览或添加删除分屏时，原先的标签中滚动位置不能变化」）。
//
// ⚠️⚠️ 本文件补的是**所有现有 sync 用例都盖不住的那一层：CM6 的几何滞后一帧**。
//
//      真机上 `rebuildLayout()` 换上去的那批 `EditorView`，heightMap 还是**旧宽度**的 ——
//      CM6 的 `requestMeasure()` 排的是**下一帧**的 rAF，在那之前 `lineBlockAt` 报的是
//      旧宽度下的行顶。而现有那批用例把 `lineBlockAt` 覆写成**实时**几何（面板数一变
//      立刻跟着变）⇒ 桩上「游标全程闭合」是**桩的特权**，不是产品的行为：
//      真机上一按「打开侧边预览」，源码格就把**旧几何算出来的** 287 钉进**已变窄**的
//      编辑器 ⇒ 同一份游标在新的行高下是**另一行**（自测台滞后几何桩实测：该落 95.67，
//      实际落 287 = 第 61 行，差 40 行；往返回来永远是歪的）。
//
// ⚠️ 所以本文件留守的那条判据是：**几何变化之后，重落必须按这一帧的几何算**。
//      实现在 `src/main.ts` 的 `landOnFrameGeometry` —— 落点换算排进 CM6 measure 的
//      `write` 阶段（**同一帧**、measure 之后跑）⇒ `lineBlockAt` 已是这一帧的几何。
//      退化把它换回「当场落」（`landPreviewAtSource`）⇒ 本文件立刻红。
//
// ⚠️ 判据仍是**游标 `v`**，不是「像素不变」：几何一变，同一游标的**像素**本来就该变
//      （整宽 287 ⇒ 窄栏 95.67）。要「像素不变」等于要求钉子不跟着尺子走；要的是
//      **看得见的还是那一行**。
//
// ⚠️ 桩沿用矩阵那套（缺一必假绿）：行高 ≠ 块高（BLOCK = 3×ROW）、浏览器式裁剪、
//    确定性布局（`getBoundingClientRect`）。**这一文件的命门是「CM 的尺子滞后一帧」**：
//    `rowH()`（真几何 / DOM rect / 断言那条）实时，`cmRowH()`（`lineBlockAt` 那条）
//    要等这一帧的 measure 才换 —— 两者故意不一样。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";

/** 源码行高（px）。 */
const ROW = 14;
/** ⚠️ 预览块高（px）：刻意 3 倍于行高 —— 跨侧（块 ⇄ 行）的换算错才量得出来。 */
const BLOCK = ROW * 3;
/** 之源游标 `v`：压在行中间（+7）⇒ 带 0.5 的行内比例。 */
const V = 20.5;
/** 整宽（单面板）⇒ 落点像素 = v × ROW。 */
const WIDE_PX = V * ROW; // 287
/** 窄栏（面板数 ≥ 2）⇒ 落点像素 = v × ROW/3。 */
const NARROW_PX = V * (ROW / 3); // ≈ 95.67
/** 预览那侧：块高与面板数无关 ⇒ 落点像素 = v × BLOCK，全程不变。 */
const PREVIEW_PX = V * BLOCK; // 861

/** md 正文：一行一个标题 ⇒ 预览块 k 与源码行 k+1 一一对应，块顶 = k×BLOCK。 */
const MD = Array.from({ length: 60 }, (_, i) => `# 标题 ${i + 1}`).join("\n");

// ---------------------------------------------------------------- 滞后几何（本文件命门）

/**
 * **真几何**：面板数一变立刻变（DOM rect 是新的、断言按它换算 —— 与真机一致）。
 * 与 `cmRowH()` 的区别就是「尺子换没换」这一维：真机只有 CM 那把尺子会滞后。
 */
function rowH(): number {
  return document.querySelectorAll(".layout-panel").length >= 2 ? ROW / 3 : ROW;
}

/** **CM6 的尺子**：几何一变，这一帧之内**还是旧值**，帧开始（measure 那一下）才换。 */
let cmRow = ROW;
let pendingRow: number | null = null;

/** 几何**已经**变完之后、第一个 rAF 之前调用：告诉 CM「你的 heightMap 要等下一帧」。 */
function markGeometryChanged(): void {
  pendingRow = rowH();
}

const rawRAF = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  rawRAF((t: number) => {
    // ⚠️ CM6 的 heightMap 是在**那一帧的 measure 周期里**才刷新的（不是帧初、也不是
    //    几何变化那一刻）。落在 rAF 回调**之前**换尺子 ⇒ 「同步（当场）落位」这一路
    //    仍然量的是旧几何，只有**排在 measure 之后**的那一落才量得到新的。
    if (pendingRow !== null) {
      cmRow = pendingRow;
      pendingRow = null;
    }
    cb(t);
  })) as unknown as typeof window.requestAnimationFrame;

/** `lineBlockAt` 用的尺子 = CM6 这个时刻认的行高。 */
const cmRowH = (): number => cmRow;

// ---------------------------------------------------------------- 桩/环境

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;

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
  // ⚠️ 这一条走**真几何** `rowH()`（DOM rect 在真机上是浏览器立刻算出来的）——
  //    只有 CM 的 heightMap 会滞后，别把这一条也拖成滞后（ Cork 一滞后，断言就铅了）。
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

// ⚠️ 会话起手：**单面板 + 两个不同文档**（a.md 激活 / b.md）。
//    ① 后面每一步都能让面板数 +1/−1，「几何这一维」才是活的（几何不变 ⇒ 本文件退化成假绿）。
//    ② 判定的是「重落有没有按新几何算」，跟文档份数无关，先用两份干净的文档起手。
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
              path: "b.md",
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

function userScroll(el: HTMLElement, px: number): void {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: px }));
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}

const clamped = new WeakSet<HTMLElement>();

/** 浏览器式裁剪（jsdom 不自己裁）。上限按 `Infinity`（本文件离上限都很远，只求「别被抹成 0」）。 */
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

/** 给 `EditorView` 装上**按 CM 的尺子**换行的行几何（必须动态求值，见 `cmRowH` 那段⚠️）。 */
function installLineGeometry(): void {
  const proto = EditorView.prototype as unknown as {
    lineBlockAt: unknown;
    lineBlockAtHeight: unknown;
  };
  const blockOf = (view: EditorView, n: number): unknown => {
    const doc = view.state.doc;
    const line = doc.line(Math.min(Math.max(n, 1), doc.lines));
    const top = (line.number - 1) * cmRowH();
    const height = cmRowH();
    return { from: line.from, to: line.to, top, height, bottom: top + height };
  };
  proto.lineBlockAt = function (this: EditorView, pos: number): unknown {
    const doc = this.state.doc;
    const line = doc.lineAt(Math.min(Math.max(pos, 0), doc.length));
    return blockOf(this, line.number);
  };
  proto.lineBlockAtHeight = function (this: EditorView, px: number): unknown {
    return blockOf(this, Math.floor(Math.max(0, px) / cmRowH()) + 1);
  };
}

function panels(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".layout-panel"));
}
/** ⚠️ 宿主（`.panel-host`）上的 `mode-*`：两个容器都在 DOM 里，按元素选会把隐藏那一格（恒 0）也数进来 ⇒ 假绿。 */
function hosts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".layout-panel .panel-host"));
}
function visibleScroller(host: HTMLElement): HTMLElement | null {
  const c = host.classList;
  if (!c.contains("mode-source") && !c.contains("mode-split")) return null;
  return host.querySelector(".cm-scroller");
}
function visiblePreview(host: HTMLElement): HTMLElement | null {
  const c = host.classList;
  if (!c.contains("mode-preview") && !c.contains("mode-split")) return null;
  return host.querySelector(".md-preview");
}
const srcEls = (): HTMLElement[] =>
  hosts()
    .map(visibleScroller)
    .filter((e): e is HTMLElement => e !== null);
const prevEls = (): HTMLElement[] =>
  hosts()
    .map(visiblePreview)
    .filter((e): e is HTMLElement => e !== null);
const srcPxs = (): number[] => srcEls().map((e) => e.scrollTop);
const prevPxs = (): number[] => prevEls().map((e) => e.scrollTop);

/** rebuildLayout 换元素 ⇒ 裁剪失效，跑一次结构性操作就得补一遍。 */
function syncClamps(): void {
  for (const h of hosts()) {
    for (const el of [visibleScroller(h), visiblePreview(h)]) {
      if (el) installClamp(el);
    }
  }
}

/** 断言「这一格还停在游标 V 上」—— 落点像素按**当前真几何**换算。 */
function expectCursor(label: string, got: number[], want: number): void {
  const fmt = (n: number): string => n.toFixed(2);
  // ⚠️ 反假绿：一栏一个都没有时，`for` 一次都不转 ⇒ 恒绿。前置闸「这一栏还在」。
  if (got.length === 0) throw new Error(`${label}：这一栏一个可见格都没有 ⇒ 本判据会假绿`);
  for (const px of got) {
    expect(
      px,
      `${label}：几何变了 ⇒ 同一游标 V=${V} 该落 ${fmt(want)}（实际 ${fmt(px)}）`,
    ).toBeCloseTo(want, 2);
  }
}

/** 点面板标签（mousedown/mouseup/click 三拍）。 */
function clickTab(panelIdx: number, tabIdx: number): void {
  const tabs = Array.from(
    panels()[panelIdx].querySelectorAll(".panel-tabstrip .tab"),
  ) as HTMLElement[];
  if (!tabs[tabIdx])
    throw new Error(`面板 ${panelIdx} 的第 ${tabIdx} 个标签不存在（共 ${tabs.length}）`);
  const el = tabs[tabIdx];
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.click();
}

/** 面板操作区按 aria-label 前缀找那颗键。 */
function clickPanelOp(labelPrefix: string): void {
  const btn = Array.from(document.querySelectorAll<HTMLElement>(".panel-op")).find((b) =>
    (b.getAttribute("aria-label") ?? "").startsWith(labelPrefix),
  );
  if (!btn)
    throw new Error(
      `找不到「${labelPrefix}」这颗面板键；现有 = ${
        Array.from(document.querySelectorAll<HTMLElement>(".panel-op"))
          .map((b) => b.getAttribute("aria-label") ?? "")
          .join("/") || "（无）"
      }`,
    );
  btn.click();
}

/** 新增分屏：右键面板里第一个标签 → 「左右分屏」（copy 分支）。 */
function splitH(): void {
  const host = hosts()[0];
  const panel = host.closest(".layout-panel") as HTMLElement | null;
  if (!panel) throw new Error("宿主不在面板里（DOM 序对我不可信）");
  const tab = panel.querySelector(".panel-tabstrip .tab") as HTMLElement | null;
  if (!tab) throw new Error("这一栏的标签条上没有标签");
  tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const btn = Array.from(document.querySelectorAll<HTMLElement>(".popup-menu > button")).find(
    (b) => b.querySelector(".menu-label")?.textContent === "左右分屏",
  );
  if (!btn) throw new Error("右键菜单里没有「左右分屏」这一项");
  btn.click();
}

function panelOf(host: HTMLElement): HTMLElement {
  const panel = host.closest(".layout-panel") as HTMLElement | null;
  if (!panel) throw new Error("宿主不在面板里（DOM 序对我不可信）");
  return panel;
}

function closePanelOp(panel: HTMLElement): void {
  const btn = Array.from(panel.querySelectorAll<HTMLElement>(".panel-op")).find((b) =>
    (b.getAttribute("aria-label") ?? "").startsWith("移除该分屏"),
  );
  if (!btn) throw new Error("这一栏没有「移除该分屏」这颗键");
  if (btn.disabled) throw new Error("这一栏的「移除该分屏」是禁用态（前提破了）");
  btn.click();
}

/**
 * 结构性操作三步走：**点 → 记几何 → 等一帧**。
 *
 * ⚠️ `markGeometryChanged()` 必须排在 `await` **之前**且在点击**之后**（点完 DOM 面板数
 *    已经是新的，而第一个 rAF 还没跑）—— 顺序反了「CM 的尺子」就换早了，本文件退化成假绿。
 *    ⚠️ 更关键的是这三步**不能跨帧**：真机上那一帧里插不进任何用户输入，这正是
 *    `landOnFrameGeometry` 敢把落点换算排到 measure 之后的底气（第四轮那个 `landAfterMeasure`
 *    就是因为**跨了帧**才被撤的：那一帧里切标签/切模式 ⇒ 按陈旧游标把用户切好的位置钉回去）。
 */
async function geoOp(run: () => void): Promise<void> {
  run();
  markGeometryChanged();
  await wait(500);
  syncClamps();
}

describe("B262 几何滞后一帧：开/关侧边预览、加/删分屏之后，原标签还停在同一行", () => {
  beforeAll(async () => {
    installLineGeometry();
    await import("../src/main");
    await wait(500);
    syncClamps();
    expect(panels().length, "前提：从单面板整宽起手").toBe(1);
  });

  it("① 起手：整宽单面板滚到 v=20.5，落点 287（CM 与真几何此刻一致）", async () => {
    expect(cmRowH(), "前提：起手两把尺子一致").toBe(rowH());
    userScroll(srcEls()[0], WIDE_PX);
    await wait(300);
    expect(srcPxs(), "单面板整宽，只有一个源码格").toEqual([WIDE_PX]);
  });

  it("② 打开侧边预览（1⇒2）：源码格必须按**新几何**重落 95.67，不是旧几何的 287", async () => {
    await geoOp(() => clickPanelOp("打开侧边预览"));
    expect(panels().length, "前提：侧边预览确实开出新面板").toBe(2);
    // ⚠️ 这一拍就是本文件的命门：旧几何（整宽 287）= 新几何下的第 61 行 ⇒ 真机上
    //    「打开侧边预览」之后原标签**跳到别的行**全靠这一条拦住。
    expectCursor("开侧边预览后（源码格变窄）", srcPxs(), NARROW_PX);
    expectCursor("开侧边预览后（预览格）", prevPxs(), PREVIEW_PX);
  });

  it("③ 新增分屏（2⇒3）：两格源码都还是 95.67（新几何），预览 861", async () => {
    await geoOp(() => splitH());
    expect(panels().length, "前提：确实分出了新面板").toBe(3);
    expect(srcEls().length, "前提：确实多出一个源码格（复制出来的那份）").toBe(2);
    expectCursor("新增分屏后（两格都窄）", srcPxs(), NARROW_PX);
    expectCursor("新增分屏后（预览格）", prevPxs(), PREVIEW_PX);
  });

  it("④ 减少分屏（3⇒2）：剩下的源码格还在 95.67，不是变宽后按旧几何算的 287", async () => {
    // ⚠️ 关的是「最后那一格**源码**」：关预览那一格会把预览清空，下面那句预览判据就被
    //    反假绿闸顶掉、等于没判（matrix ⑥ 同一条纪律）。
    const srcIdx = hosts().reduce((last, h, i) => (visibleScroller(h) ? i : last), -1);
    if (srcIdx < 1) throw new Error(`前提：三格里至少要有两格源码（实际 ${srcEls().length} 格）`);
    await geoOp(() => closePanelOp(panelOf(hosts()[srcIdx])));
    expect(panels().length, "前提：面板数少了一个").toBe(2);
    expectCursor(
      "减少分屏后（几何按新面板数重算）",
      srcPxs(),
      rowH() === ROW ? WIDE_PX : NARROW_PX,
    );
    expectCursor("减少分屏后（预览格）", prevPxs(), PREVIEW_PX);
  });

  it("⑤ 一路关回单面板：几何回到整宽，源码格又该是 287", async () => {
    let guard = 0;
    while (panels().length > 1) {
      await geoOp(() => closePanelOp(panelOf(hosts()[hosts().length - 1])));
      if (++guard > 4) throw new Error("关分屏关不干净（面板数下不来）");
    }
    expect(panels().length, "前提：最后剩一个面板").toBe(1);
    expectCursor("关回单面板后（整宽）", srcPxs(), WIDE_PX);
  });

  it("⑥ 切换标签不受影响：切到 b.md 再切回 a.md，a.md 还在同一游标上", async () => {
    clickTab(0, 1); // b.md
    await wait(280);
    userScroll(srcEls()[0], 120); // 在 b.md 上挪一下，证明切回来的是 a.md 自己的位置
    await wait(240);
    expect(srcPxs(), "前提：b.md 停在别处").toEqual([120]);

    clickTab(0, 0); // a.md
    await wait(300);
    expectCursor("切回 a.md 后", srcPxs(), WIDE_PX);
  });
});

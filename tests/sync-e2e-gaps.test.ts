// @vitest-environment jsdom
// B261 **端到端补漏矩阵**（用户点名：「设计端到端用例，测试各种添加删除分屏、打开侧边预览、
// 标签切换、源码/预览模式切换的滚动位置一致性测试用例，目前还是会有些情况会漏掉」）。
//
// ⚠️ 这不是 `sync-e2e-matrix` 的重复。那一条矩阵串的是**几何**那根轴（整宽 ⇄ 窄栏 ⇄ 整宽）；
//    本文件补的是**入口**那根轴 —— 现有 17 个 `sync-*` 行为文件里，下面这 7 类入口是**整列空**：
//      · 从**预览侧**发起滚（17/17 都从源码发起滚；预览当源只落在静态契约上）；
//      · 分屏**第二格（复制出来的那份）**当源发起滚（右键分屏走 copy 分支，覆盖为零）；
//      · 关**活动**面板 vs 关**非活动**面板（现有只有笼统一句「关某个分屏」）；
//      · 关侧边预览（真·合并路径：预览标签并入左栏，再切过去落点回不回得来）；
//      · **侧边预览态下**切模式（两格都是预览，再切回源码那一格）；
//      · 新建标签 / 关标签**之后**切回（新标签那条链走 `newUntitled` + `closeTabById`）；
//      · **上下分屏**（`dir:"v"`，17 个文件零出现）。
//
// ⚠️ 判据仍是**游标 `v`**，不是「像素不变」：几何（ROW / BLOCK 3 倍差）一旦恒定，跨侧
//    换算的错才量得出来。
// ⚠️⚠️ 两侧的 `v` **口径一致**（都是「行/块**行号** + 自己那一侧的行内比例」，互不差 1）：
//      `topVisibleLineFrac`（源码）= `topVisibleLine()`（预览）= `行号 + 比例`。
//      落点统一是 `(v − 1 + 比例) × 单位高`，也就是 `(v − 1) × 单位高`。
//    ⇒ 本文件的常数 `V` = `v − 1 + 比例` = **视口顶行号 −1 再带上那一行的比例**：
//      源码侧落点 `SRC_PX = V × ROW`、预览侧落点 `PREV_PX = V × BLOCK`，两侧同源同一个 `V`。
//      ⚠️ 别按「落点 = v × 行高」写判据 —— 那样整数行会差一整行（287 写成 301）。
//
// ⚠️ 桩沿用两处的各自那一维，缺一必假绿：
//      · 来自 `sync-e2e-matrix`：**行高 ≠ 块高**（BLOCK = 3×ROW）、浏览器式裁剪、
//        确定性布局（`getBoundingClientRect` 造出来的）；
//      · 来自 `sync-tab-preview-switch`：**这一侧被 `display:none` 时 `clientHeight` /
//        `scrollHeight` 一起归 0**（真机行为；不补 ⇒ `sourceAtOwnFloor` 在桩上判得出真话、
//        真机上恒读 0-0-0=0 恒真 ⇒「顶到上限」永远成立）。
//    ⚠️ 裁剪上限**不按内容算**（同 matrix）：预览块 DOM 是异步铺开的，数到 0 ⇒ 上限 0 ⇒
//       之后每次赋值都被裁成 0。本用例落点离上限都远，只需要「别被裁」+「隐藏 ⇒ 量归零」。
//
// ⚠️ 反假绿三件套（缺一必然假绿）：① 断言「这一栏还在」前置 `got.length === 0 ⇒ throw`；
//    ② 用 `max`/`every` 而不是 `toContain`（分屏会让格子变多）；③ **前提断言**（面板数、
//    标签名、同步键点亮态）—— 前提破了就等于没判。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";

/** 源码行高（px）。 */
const ROW = 14;
/** ⚠️ 预览块高（px）：刻意 3 倍于行高 —— 跨侧（块 ⇄ 行）的换算错才量得出来。 */
const BLOCK = ROW * 3;
/** 视口高（两侧同）。 */
const VIEW_H = ROW * 3;
/** 正文 24 行，一行一个标题 ⇒ 预览块 k 与源码行 k+1 一一对应。 */
const ROWS = 24;
/** 之源游标 `v`：压在行中间（+0.5）⇒ 带行内比例。 */
const V = 20.5;
/** 源码侧落点 = v × ROW（= 287，未到源码上限 24×14−42 = 294 ⇒ 源交的是真值）。 */
const SRC_PX = V * ROW;
/** 预览侧落点 = v × BLOCK（= 861，未到预览上限 24×42−42 = 966）。 */
const PREV_PX = V * BLOCK;

const MD = Array.from({ length: ROWS }, (_, i) => `# 标题 ${i + 1}`).join("\n");

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;

  const proto = window.Element.prototype as unknown as { getBoundingClientRect: () => DOMRect };
  // CM6 量行位置走 `getClientRects()[0] ?? getBoundingClientRect()`；jsdom 的
  // getClientRects 恒空 ⇒ 这里补上（否则 CM6 走不到我们的假布局、行位置永远不动）。
  const protoRects = window.Element.prototype as unknown as { getClientRects: () => DOMRectList };
  protoRects.getClientRects = function (this: Element): DOMRectList {
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
  };
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

// ⚠️ 会话起手：**单面板 + 两个不同文档**（a.md 激活 / b.md）。两文档 ⇒ 切标签是真的切走
//    再切回，不是同文档换实例；一个面板 ⇒ 每次「开侧边预览 / 新增分屏」面板数 +1、
//    「关分屏」−1，几何与合并路径两条维度都是活的。
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
  // ⚠️⚠️ `tabId` **必须每次不同**：会话里有 a.md 与 b.md 两个标签，而 `docs` 是按 tabId
  //     收口的 —— 恒返回 0 ⇒ 两份标签被并成**同一个文档**（日志里 "restored 1 docs / 2
  //     instances" 就是这个），后面每一条「切标签 = 真的切走另一份文档」的前提全塌，
  //     判据看着是行为测试、实际在同文档换实例上打转。
  openFile: (path: string) =>
    Promise.resolve({
      tabId: OPEN_SEQ++,
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

/** 会话恢复时 `openFile` 的 tabId 自增源（见 mock 里那条 ⚠️）。 */
let OPEN_SEQ = 100;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function userScroll(el: HTMLElement, px: number): void {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: px }));
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}

const clamped = new WeakSet<HTMLElement>();

/** 浏览器式裁剪（jsdom 不自己裁）；上限**不按内容算**，理由见文件头。 */
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
  const unit = el.classList.contains("cm-scroller") ? ROW : BLOCK;
  // ⚠️⚠️ `display:none` ⇒ 这一侧量不出来（真机：scrollTop 清零、scrollHeight / clientHeight
  //     全 0）。桩里不模拟 ⇒ `sourceAtOwnFloor` 在桩上判得出真话、真机上恒真 ⇒ 假绿。
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

/**
 * ⚠️ 每次**结构性**操作（分屏 / 关分屏 / 切模式 / 切标签 / 建标签 / 关标签）之后都要再跑一次：
 *    那些操作会 `rebuildLayout` 换掉一批 `.cm-scroller` / `.md-preview` 元素，新元素没裁过
 *    ⇒ jsdom 的 `scrollTop` 存不进值 ⇒ 后面每一条判据都读 0。
 */
function syncClamps(): void {
  for (const h of hosts()) {
    for (const el of [visibleScroller(h), visiblePreview(h)]) {
      if (el) installClamp(el);
    }
  }
}

/** 给 `EditorView` 装上确定性行几何（必须动态求值，见文件头）。 */
function installLineGeometry(): void {
  const proto = EditorView.prototype as unknown as {
    lineBlockAt: unknown;
    lineBlockAtHeight: unknown;
  };
  const blockOf = (view: EditorView, n: number): unknown => {
    const doc = view.state.doc;
    const line = doc.line(Math.min(Math.max(n, 1), doc.lines));
    const top = (line.number - 1) * ROW;
    const height = ROW;
    return { from: line.from, to: line.to, top, height, bottom: top + height };
  };
  proto.lineBlockAt = function (this: EditorView, pos: number): unknown {
    const doc = this.state.doc;
    const line = doc.lineAt(Math.min(Math.max(pos, 0), doc.length));
    return blockOf(this, line.number);
  };
  proto.lineBlockAtHeight = function (this: EditorView, px: number): unknown {
    return blockOf(this, Math.floor(Math.max(0, px) / ROW) + 1);
  };
}

function panels(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".layout-panel"));
}
/**
 * ⚠️ 宿主（`.panel-host`）上的 `mode-source` / `mode-preview` / `mode-split` 才是「这一格
 *    此刻**看得见的是哪一侧**」的唯一凭据 —— `.cm-scroller` / `.md-preview` 两个都在 DOM
 *    里（预览态只给编辑器 `display:none`），按元素选会把隐藏的那一格（scrollTop 恒 0）
 *    也数进来 ⇒ 判据全是「实际 0.00」的假绿。
 */
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

/**
 * 断言「这一栏每一格都还停在游标 V 上」（按当前几何换算）。
 * ⚠️ 用 `max` 而不是 `toContain`：断言的是**每一格**，不是「某几格」；格子变多也不会假绿。
 */
function expectCursor(label: string, got: number[], want: number): void {
  const fmt = (n: number): string => n.toFixed(2);
  // ⚠️ 反假绿：一栏一个都没有时，`for` 一次都不转 ⇒ 恒绿。「这一栏还在」必须先断言。
  if (got.length === 0) throw new Error(`${label}：一栏里一个可见格都没有 ⇒ 本判据会假绿`);
  for (const px of got) {
    expect(
      px,
      `${label}：几何变了 ⇒ 同一游标 V=${V} 该落 ${fmt(want)}（实际 ${fmt(px)}）`,
    ).toBeCloseTo(want, 2);
  }
}

/**
 * 前提断言：同步滚动确实开着（`aria-pressed="true"`）。
 *
 * ⚠️ 得在**本窗口已经有 ≥2 份可见实例之后**调才判得出 —— `refreshSyncButton` 里
 *    `const multi = … visibleInstancesOfDoc(tab.docId).length > 1 || remoteHasDoc(…)`，
 *    不满足就 `if (!multi) return`，`aria-pressed` 停在初值 `false`（键此时也 hidden）。
 *    单面板那一步断言这个 ⇒ 恒红；而分出第二格之后再断言 ⇒ 同时验掉「键露脸」和「真的开着」。
 */
function expectSyncOn(label: string): void {
  expect(
    document.getElementById("sync-scroll")?.getAttribute("aria-pressed"),
    `${label}（前提断言：同步滚动真的开着）`,
  ).toBe("true");
}

function panelOf(host: HTMLElement): HTMLElement {
  const panel = host.closest(".layout-panel") as HTMLElement | null;
  if (!panel) throw new Error("宿主不在面板里（DOM 序对我不可信）");
  return panel;
}

/** 点某一栏里**指定名字**的标签 —— 合并分屏 / 关侧边预览之后标签序会变，按 DOM 序点会点到错的。 */
function clickTabByName(panelIdx: number, name: string): void {
  const el = tabElByName(panelIdx, name);
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.click();
}
function tabElByName(panelIdx: number, name: string): HTMLElement {
  const tabs = Array.from(
    panels()[panelIdx].querySelectorAll(".panel-tabstrip .tab"),
  ) as HTMLElement[];
  const el = tabs.find((t) => t.querySelector(".tab-name")?.textContent === name);
  if (!el) {
    throw new Error(
      `面板 ${panelIdx} 里没有叫「${name}」的标签（现有 = ${tabs
        .map((t) => t.querySelector(".tab-name")?.textContent ?? "?")
        .join("/")}）`,
    );
  }
  return el;
}
/** 点某一栏里**最后一个**同名标签（关分屏的合并路径是 push 到末尾，新并进来的那份在最后）。 */
function clickLastTabNamed(panelIdx: number, name: string): void {
  const tabs = Array.from(
    panels()[panelIdx].querySelectorAll(".panel-tabstrip .tab"),
  ) as HTMLElement[];
  const hit = tabs.filter((t) => t.querySelector(".tab-name")?.textContent === name);
  const el = hit[hit.length - 1];
  if (!el) throw new Error(`面板 ${panelIdx} 里没有叫「${name}」的标签`);
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.click();
}

function expectTabNames(label: string, panelIdx: number, want: string[]): void {
  const got = Array.from(panels()[panelIdx].querySelectorAll(".panel-tabstrip .tab .tab-name")).map(
    (e) => e.textContent,
  );
  expect(got, `${label}（前提断言）`).toEqual(want);
}

/** 让某一栏成为活动面板（面板 mousedown → onActivatePanel → markActivePanel）。 */
function activatePanel(panel: HTMLElement): void {
  panel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
}

/** 面板操作区那颗键（按 aria-label 前缀）；只在活动面板上挂 md 两颗，所以全局找唯一。 */
function clickPanelOp(prefix: string): void {
  const btn = clickPanelOpIn(null, prefix);
  void btn;
}
function clickPanelOpIn(panel: HTMLElement | null, prefix: string): HTMLElement {
  const scope = panel ?? (document as unknown as HTMLElement);
  const btn = Array.from(scope.querySelectorAll<HTMLElement>(".panel-op")).find((b) =>
    (b.getAttribute("aria-label") ?? "").startsWith(prefix),
  );
  if (!btn) {
    throw new Error(
      `找不到「${prefix}」这颗面板键（现有 = ${
        Array.from(scope.querySelectorAll<HTMLElement>(".panel-op"))
          .map((b) => b.getAttribute("aria-label") ?? "")
          .join("/") || "（无）"
      }）`,
    );
  }
  btn.click();
  return btn;
}

/** 新增 / 减少分屏：面板操作区那颗 ⨯（onClosePanel → closePanelById → disposePanel）。 */
function closePanelOp(panel: HTMLElement): void {
  const btn = Array.from(panel.querySelectorAll<HTMLElement>(".panel-op")).find((b) =>
    (b.getAttribute("aria-label") ?? "").startsWith("移除该分屏"),
  );
  if (!btn) throw new Error("这一栏没有「移除该分屏」这颗键");
  if (btn.disabled) throw new Error(`这一栏的「移除该分屏」是禁用态（前提破了）`);
  btn.click();
}

/**
 * 右键菜单分屏：`dir` 决定左右 / 上下（copy 分支，不是移动式）。
 *
 * ⚠️ 起点是**当前显示的那一格**（`.tab-active`）而不是标签条第一个 —— 分屏的源是
 *    `syncSourceV(tab)`，它读的是**这份标签自己的槽**，不是屏幕上的 DOM；点错一份，
 *    交出来的游标就是那份旧槽里的值（见 `primeA` 注释里第 ⑦ 条那个实测）。
 */
function splitTab(dir: "h" | "v"): void {
  const label = dir === "h" ? "左右分屏" : "上下分屏";
  const tabs = Array.from(panels()[0].querySelectorAll(".panel-tabstrip .tab")) as HTMLElement[];
  const tab = tabs.find((t) => t.classList.contains("tab-active"));
  if (!tab) throw new Error("这一栏的标签条上没有活动标签");
  const name = tab.querySelector(".tab-name")?.textContent;
  if (name !== "a.md") {
    throw new Error(`前提破了：要分屏的应当是活动中的 a.md（实际 = ${String(name)}）`);
  }
  tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const btn = Array.from(document.querySelectorAll<HTMLElement>(".popup-menu > button")).find(
    (b) => b.querySelector(".menu-label")?.textContent === label,
  );
  if (!btn) throw new Error(`右键菜单里没有「${label}」这一项`);
  btn.click();
}

/** 关标签：标签上的那颗 ×（aria-label = `关闭 ${name}`）。 */
function closeTabByName(panelIdx: number, name: string): void {
  const el = tabElByName(panelIdx, name);
  const btn = el.querySelector<HTMLElement>(".tab-close");
  if (!btn) throw new Error(`「${name}」这一格没有关闭键`);
  btn.click();
}

/** 标签条空白处双击 = 新建标签（renderTabstrip 里 `host.ondblclick` 只认 target === strip）。 */
function newTabIn(panel: HTMLElement): void {
  const strip = panel.querySelector(".panel-tabstrip") as HTMLElement | null;
  if (!strip) throw new Error("这一栏没有标签条");
  strip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
}

/** 收回到单面板（只关**最后一个**面板 ⇒ 幸存那一栏的标签序不变）。 */
async function resetToSingle(): Promise<void> {
  let guard = 0;
  while (panels().length > 1) {
    closePanelOp(panelOf(hosts()[hosts().length - 1]));
    await wait(450);
    if (++guard > 6) throw new Error("关分屏关不干净（面板数下不来）");
  }
  syncClamps();
}

/**
 * 每个场景的**共同前提**：单面板 ⇒ a.md 正显示 ⇒ 整宽 287 ⇒ 游标就是真值。
 *
 * ⚠️ 这条不是「顺手摆一下」—— 分屏 / 关分屏会往同一栏里塞**同文档的多个副本**，
 *    `clickTabByName` 按名字点会点到其中任意一份，而各份的槽在不同轮次里被落过不同的值
 *    （第 ⑦ 条就是这么红的：分屏的源取到了「另一份旧副本」的槽，交出 `v=2` 而不是 20.5）。
 *    ⇒ 必须先点**活动**标签把它钉成显示中的那份，再滚、再断言。
 */
async function primeA(): Promise<void> {
  await resetToSingle();
  clickTabByName(0, "a.md");
  await wait(360);
  syncClamps();
  userScroll(srcEls()[0], SRC_PX);
  await wait(420);
  expectCursor("前提：单面板整宽、a.md 停在中段", srcPxs(), SRC_PX);
}

describe("B261 端到端补漏：7 类现有用例整列无覆盖的入口，同一游标不许掉", () => {
  beforeAll(async () => {
    installLineGeometry();
    await import("../src/main");
    await wait(600);
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    // ⚠️ 必须显式开同步：`docSyncModes` 是每条同步路径的闸口，不开 ⇒ 所有断言走 B149 基线
    //    「各认各的」⇒ 位置恰好也成立 ⇒ **整条用例退化成假绿**（这是本文件最大的一条陷阱）。
    btn.click();
    await wait(250);
    syncClamps();
    expect(panels().length, "前提：从单面板整宽起手").toBe(1);
    // ⚠️ 这里**故意不**断言同步键点亮态：`refreshSyncButton` 的 `if (!multi) return` 让它在
    //    「本窗口只有一份可见实例」时连 `aria-pressed` 都不写（键本身也 hidden）。点亮态这条
    //    前提挪到「分出第二格之后」用 `expectSyncOn` 断言 —— 见那里同样的 ⚠️。
  });

  // ---------------------------------------------------------------- ①
  it("① 从**预览侧**发起滚 → 在该格切模式（预览→源码）→ 再切回预览", async () => {
    await primeA();
    clickPanelOp("打开侧边预览"); // 右格 = 预览（活动面板）
    await wait(520);
    syncClamps();
    expect(panels().length, "前提：侧边预览确实开出新面板").toBe(2);
    expectSyncOn("侧边预览开出来之后");

    // 从**预览**那一格发起滚（现有 17 个行为用例一次都没这么起手过）
    userScroll(prevEls()[0], PREV_PX);
    await wait(420);
    expect(prevPxs(), "前提：预览停在中段").toEqual([PREV_PX]);
    expectCursor("预览发起滚 ⇒ 左格源码跟着同一个游标", srcPxs(), SRC_PX);

    // 在**这一格**切模式：预览 → 源码（预览当源的交接，走 toggleViewMode 那一路）
    const right = panelOf(hosts()[1]);
    expectTabNames("前提：右格挂的是 a.md 的副本", 1, ["a.md"]);
    clickPanelOpIn(right, "切换到源码");
    await wait(480);
    syncClamps();
    expectCursor("从预览切到源码（两格都在同一游标）", srcPxs(), SRC_PX);
    expect(prevPxs(), "切到源码后预览格退场").toEqual([]);

    // 再切回预览：落点还是同一个游标
    clickPanelOpIn(right, "切换到预览");
    await wait(480);
    syncClamps();
    expectCursor("切回预览（落点还是同一游标）", prevPxs(), PREV_PX);
    expectCursor("左格源码没被切模式带偏", srcPxs(), SRC_PX);
  });

  // ---------------------------------------------------------------- ②
  it("② 分屏第二格（**复制出来的那份**）当源发起滚 → 切标签 → 切回", async () => {
    await primeA();
    splitTab("h"); // 右键「左右分屏」= copy 分支
    await wait(520);
    syncClamps();
    expect(panels().length, "前提：确实分出了新面板").toBe(2);
    expectSyncOn("分屏之后");
    expect(srcPxs().length, "前提：两格都是源码（复制出来的那份）").toBe(2);

    // 前提：分屏这一下就必须把**两格**都按 `vCopy` 落好（copy 分支的 `landPreviewAtSource`
    //       两行 —— 少了新副本那一行，这一条立刻红）
    expectCursor("分屏出来 ⇒ 源与新副本都落在同一游标", srcPxs(), SRC_PX);

    // ⚠️ 源取**第二格**（复制出来的那份）—— 与「第一格当源」是两条不同的推播路径
    userScroll(srcEls()[1], SRC_PX);
    await wait(420);
    expectCursor("复制那份发起滚 ⇒ 两格都跟上同一个游标", srcPxs(), SRC_PX);

    clickTabByName(0, "b.md"); // 左格切到别的文档
    await wait(420);
    expectCursor("切到 b.md 后（复制那份还在原处）", srcPxs(), SRC_PX);

    clickTabByName(0, "a.md"); // 切回
    await wait(450);
    syncClamps();
    expectCursor("切回 a.md 后（两格都还在同一游标）", srcPxs(), SRC_PX);
  });

  // ---------------------------------------------------------------- ③
  it("③ 关**非活动**面板 / 关**活动**面板 ⇒ 幸存那一格还在同一游标", async () => {
    await primeA();

    clickPanelOp("打开侧边预览");
    await wait(520);
    syncClamps();
    expect(panels().length, "前提：两格").toBe(2);
    expectSyncOn("侧边预览开出来之后");

    // —— 先关**非活动**那一格（右格预览）
    closePanelOp(panelOf(hosts()[1]));
    await wait(520);
    syncClamps();
    expect(panels().length, "前提：面板数 −1").toBe(1);
    expectCursor("关**非活动**面板 ⇒ 幸存那一格还在同一游标", srcPxs(), SRC_PX);

    // —— 再造一个分屏，把**活动面板**换到左格再关它
    splitTab("h");
    await wait(520);
    syncClamps();
    expect(panels().length, "前提：又两格").toBe(2);
    const left = panels()[0];
    activatePanel(left);
    await wait(240);
    expect(left.classList.contains("layout-panel-active"), "前提：左格已是活动面板").toBe(true);

    closePanelOp(left);
    await wait(540);
    syncClamps();
    expect(panels().length, "前提：面板数 −1").toBe(1);
    expectCursor("关**活动**面板 ⇒ 并入来的那一格还在同一游标", srcPxs(), SRC_PX);
  });

  // ---------------------------------------------------------------- ④
  it("④ 关侧边预览（真·合并路径）⇒ 切到合并进来的那一格预览，落点回得来", async () => {
    await primeA();

    clickPanelOp("打开侧边预览");
    await wait(520);
    syncClamps();
    expect(panels().length, "前提：两格").toBe(2);
    expectSyncOn("侧边预览开出来之后");
    userScroll(prevEls()[0], PREV_PX); // 预览那一格停在中段
    await wait(420);
    expectCursor("前提：预览停在 PREV_PX，源码跟着走", srcPxs(), SRC_PX);

    // 关掉**预览那一格** ⇒ 它的标签并入左栏（closePanelById 的合并路径）
    closePanelOp(panelOf(hosts()[1]));
    await wait(540);
    syncClamps();
    expect(panels().length, "前提：只剩一格").toBe(1);
    expectCursor("关侧边预览 ⇒ 左格源码还在同一游标", srcPxs(), SRC_PX);
    const names = Array.from(panels()[0].querySelectorAll(".panel-tabstrip .tab .tab-name")).map(
      (e) => e.textContent,
    );
    if (names.filter((n) => n === "a.md").length < 2) {
      throw new Error(`前提破了：右格那份预览标签应当并进左栏（现有 = ${names.join("/")}）`);
    }

    // 切到合并进来的那一格（预览态那份）：取**最后一个** a.md（合并是 push 到末尾的）
    clickLastTabNamed(0, "a.md");
    await wait(480);
    syncClamps();
    expect(prevPxs().length, "前提：确实切到了那一格预览").toBeGreaterThan(0);
    expectCursor("切到合并进来的预览格 ⇒ 落点还是同一游标", prevPxs(), PREV_PX);
  });

  // ---------------------------------------------------------------- ⑤
  it("⑤ 侧边预览态下切模式：两格都变预览 → 再切回源码", async () => {
    await primeA();

    clickPanelOp("打开侧边预览"); // 右格 = 预览，并且被设成活动面板
    await wait(520);
    syncClamps();
    expect(panels().length, "前提：两格").toBe(2);
    expectSyncOn("侧边预览开出来之后");

    activatePanel(panels()[0]); // 把活动面板拽回左格 ⇒ 左格那颗切换键才存在
    await wait(320);
    syncClamps();
    userScroll(srcEls()[0], SRC_PX); // 左格源码当源
    await wait(420);
    expectCursor("左格滚 ⇒ 右格预览跟着同一个游标", prevPxs(), PREV_PX);

    // 活动面板（左格）自己也切到预览 ⇒ 两个预览格
    clickPanelOp("切换到预览");
    await wait(500);
    syncClamps();
    expect(prevPxs().length, "前提：两个预览格").toBe(2);
    expectCursor("两格都切到预览 ⇒ 都在同一游标", prevPxs(), PREV_PX);
    expect(srcPxs(), "预览态下源码格退场").toEqual([]);

    // 再切回源码（两个源码格）
    clickPanelOpIn(panels()[0], "切换到源码");
    await wait(500);
    syncClamps();
    expectCursor("切回源码 ⇒ 两格源码都在同一游标", srcPxs(), SRC_PX);
    expectCursor("右格预览没被切模式拽走", prevPxs(), PREV_PX);
  });

  // ---------------------------------------------------------------- ⑥
  it("⑥ 新建标签 / 关标签之后切回 ⇒ a.md 还在原处", async () => {
    await primeA();

    // ⚠️ 本场景全程单面板 ⇒ 同步键的 `aria-pressed` 报不出来（见 `expectSyncOn` 那条 ⚠️）。
    //    为了不让「同步其实关着、判据走 B149 基线各认各的」这类假绿溜过去，先分一格把
    //    「同步确实开着」验掉，再收回来 —— 验过这条，后面「切回 / 关标签后落点还在」才不是白判。
    splitTab("h");
    await wait(520);
    syncClamps();
    expectSyncOn("前提探针：本场景全程单面板，先分一格验同步确实开着");
    await resetToSingle();

    const before = Array.from(panels()[0].querySelectorAll(".panel-tabstrip .tab")).length;

    newTabIn(panels()[0]); // 标签条空白处双击 = newUntitled
    await wait(650);
    syncClamps();
    expect(panels().length, "前提：新建标签不动布局").toBe(1);
    const after = Array.from(panels()[0].querySelectorAll(".panel-tabstrip .tab")).length;
    expect(after, `前提：多出一个「未命名」标签（${before} ⇒ ${after}）`).toBe(before + 1);

    clickTabByName(0, "a.md"); // 切回来
    await wait(480);
    syncClamps();
    expectCursor("新建标签后切回 a.md", srcPxs(), SRC_PX);

    closeTabByName(0, "未命名"); // 关掉新标签
    await wait(560);
    syncClamps();
    expect(
      Array.from(panels()[0].querySelectorAll(".panel-tabstrip .tab")).length,
      "前提：新标签已摘掉",
    ).toBe(before);
    expectCursor("关掉新建标签后 a.md 还在原处", srcPxs(), SRC_PX);
  });

  // ---------------------------------------------------------------- ⑦
  it('⑦ **上下分屏**（dir="v"）：两格源码都在同一游标 → 切预览 → 再关回单面板', async () => {
    await primeA();

    splitTab("v"); // 上下分屏 —— 17 个行为文件零覆盖
    await wait(540);
    syncClamps();
    expect(panels().length, "前提：确实分出了新面板").toBe(2);
    expectSyncOn("上下分屏之后");
    expect(
      document.querySelectorAll(".layout-split.layout-v").length,
      "前提：布局确实是上下分屏（不是左右）",
    ).toBeGreaterThan(0);
    expect(srcPxs().length, "前提：两格源码").toBe(2);
    expectCursor("上下分屏 ⇒ 两格源码都在同一游标", srcPxs(), SRC_PX);

    clickPanelOp("切换到预览"); // 活动面板切到预览
    await wait(500);
    syncClamps();
    expectCursor("上下分屏下切预览 ⇒ 落点还是同一游标", prevPxs(), PREV_PX);

    let guard = 0;
    while (panels().length > 1) {
      closePanelOp(panelOf(hosts()[hosts().length - 1]));
      await wait(460);
      if (++guard > 4) throw new Error("关分屏关不干净");
    }
    syncClamps();
    expectCursor("上下分屏关回单面板 ⇒ 几何回到整宽、游标不掉", srcPxs(), SRC_PX);
  });

  // ---------------------------------------------------------------- ⑧
  // ⚠️ **必须排在最后一条**：这条会**关掉同步**，它后面的场景全靠「同步开着」当前提。
  it("⑧ 关侧边预览合并（**同步关着**的工况）：没人补位，落点只能靠合并那一路带回来", async () => {
    await primeA();

    // ⚠️ 这条要看的是「合并那一路**自己**把位置带回来」。同步开着时 `pushSyncToSiblings`
    //    下一趟就把落位补回来了（B261 第六轮那句「同步开着只闪一下就被扳回」同型）——
    //    实测：把「合并丢位置」退化进去，同步开着的那几条**一条都不红**。
    //    ⇒ 必须先把同步关掉；⚠️ 且「已关」这条前提断言要落在**还有 ≥2 份实例**的时候
    //      （`refreshSyncButton` 早退 ⇒ 单面板时 `aria-pressed` 恒 `false`，拿它当前提
    //      等于写了个恒真断言 = 假绿）。
    splitTab("h");
    await wait(520);
    syncClamps();
    expectSyncOn("前提：先摆出第二份实例，同步键才报得出状态");
    (document.getElementById("sync-scroll") as HTMLElement).click(); // 关同步
    await wait(360);
    syncClamps();
    expect(
      document.getElementById("sync-scroll")?.getAttribute("aria-pressed"),
      "前提断言：同步已关（此刻还有两份实例 ⇒ 这条断言有牙齿）",
    ).toBe("false");

    await resetToSingle(); // 收回到单面板（同步仍是关的）

    clickPanelOp("打开侧边预览");
    await wait(520);
    syncClamps();
    expect(panels().length, "前提：又开出一格").toBe(2);
    closePanelOp(panelOf(hosts()[hosts().length - 1])); // 关掉这格 ⇒ 预览标签又并回来
    await wait(540);
    syncClamps();
    expect(panels().length, "前提：又只剩一格").toBe(1);

    clickLastTabNamed(0, "a.md"); // 切到合并进来的那一格预览
    await wait(500);
    syncClamps();
    expect(prevPxs().length, "前提：切到了合并进来的预览格").toBeGreaterThan(0);
    expectCursor("同步关着 + 关侧边预览合并 ⇒ 切过来落点还是同一游标", prevPxs(), PREV_PX);
  });
});

/**
 * 反验证记录：三条退化跑过，逐条对照（**不粉饰弱判据**）。
 *
 * · **退化 #1** —— `syncSourceV` 预览分支丢块内比例（`Math.floor`）：
 *     ⇒ ① ④ ⑤ 转红（280 而不是 287）。这三条正是「预览当源 / 跨侧」的入口，牙齿有。
 * · **退化 #2** —— copy 分支不给**新副本**落位（`landPreviewAtSource(inst, 1)`，老病形态）：
 *     ⇒ ② 转红（0 而不是 287）；另外 ③ ⑥ ⑦ 跟着红 —— 它们都得先 `splitTab`（copy 分支）
 *        才能进分屏。牙齿有。
 * · **退化 #3** —— 合并路径把并入标签的槽清掉（`t.scrollTop = null`）：
 *     ⇒ **8 条全绿**（包括同步关着的 ⑧）。已定位原因，不是判据松，是退化没造出真机形态：
 *       槽空时产品行为就是「不落位、DOM 沿用旧值」，桩里 `.cm-scroller` / `.md-preview`
 *       元素在切标签/关面板时被**复用**（`syncClamps` 只补裁剪、不清零），于是旧位置还在；
 *       真机关面板会换 DOM ⇒ 新元素 scrollTop = 0 ⇒ 位置真的丢。
 *       ⇒ ③ / ⑧ 这两条**桩层面弱鉴别力**，真机验证口径见下；别拿「退化全绿」当它们没用。
 *
 * ⚠️ 真机上验 ③ / ⑧ 的位置保持，看的是「DOM 是不是**新元素**上的落位」：
 *    关掉一格 ⇒ 幸存那格的滚动条是否还停在同一行；关侧边预览后切回预览标签，
 *    预览是否还停在同一段（不是弹回开头）。桩模拟不了这一层，只能靠人工看。
 */

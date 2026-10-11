// @vitest-environment jsdom
// B261 **第十轮**（用户点名：「还是有遗漏，添加分屏场景多标签切换（**来回切换多次**）的
// 端到端测试用例」）。
//
// ⚠️⚠️ 这不是 `sync-e2e-gaps` 的重复，那一份补的是**入口**那根轴（17 个 sync 行为文件里
//      7 类整列空着的触发入口）；本文件补的是**时间**那根轴：
//      - 现有 17 个 sync 行为文件 + gaps 那 8 条，切换**一律只做一次**（滚 → 切走 → 切回 → 断言）。
//      - 「来回切多次」才是 B254 那个症状的真形状：**单轮时**收口 / `pushSyncToSiblings`
//        下一趟还能把歪值扳回来（B261 第六轮那句「同步开着只闪一下就被扳回」），
//        **多轮之后**歪值已经写进槽里 ⇒ 收口只管「接班那一份」+ B241 跳过推播 ⇒
//        「后续切标签不再变化」＝被冻住。单轮用例在结构上就测不出这一层。
//      - 并且是**分屏 + 多标签**：单面板两标签时「切标签」只是换文档；分屏之后同一份
//        a.md 在多个格子里各有各的一份，切来切去要盯的是**每一格各停在哪**。
//
// ⚠️ 判据仍是**游标 `v`**，不是「像素不变」：几何（ROW / BLOCK 3 倍差）一旦恒定，跨侧
//    换算的错才量得出来。两侧 `v` 口径一致（落点 = `(v − 1) × 单位高`），本文件
//    `V = 20.5` ⇒ 源码落点 `SRC_PX = 287`、预览落点 `PREV_PX = 861`。
//
// ⚠️⚠️ **本文件的判据形状（和 gaps 那条 ③/⑧ 的诚实标注是同一条纪律）**：
//      jsdom 里面板只有**一个** `.cm-scroller` 元素被它的标签们共用（切标签换的是 state，
//      不是 DOM）⇒ 切到从没滚过的 b.md 时，那一格的 scrollTop **沿用旧值**。
//      ⇒ 「切走那一拍」去断言「还在 287」是**弱判据**（沿用值本来就对），本文件因此：
//        · 切走之后**不断言**这一格的位置，只断言「**另一格**没被这个离去的源带跑」
//          （这条有牙：跨文档错推 / 推播源取错就会红）；
//        · 真正咬人的一拍是**切回 a.md 之后**：那一步走 `switchTab` 的收口
//          （`restoreViewScroll` 按槽落 DOM），槽被写歪 ⇒ 立刻红。
//      ⚠️ 别把「切走后还 287」当成鉴别力 —— 那是桩的元素复用送的，真机上换文档是空档 0。
//
// ⚠️ 桩沿用 gaps 那套（缺一必假绿）：行高 ≠ 块高（BLOCK = 3×ROW）、浏览器式裁剪、
//    确定性布局（`getBoundingClientRect`）、**这一侧 `display:none` 时 clientHeight /
//    scrollHeight 归 0**（真机行为；不补 ⇒ `sourceAtOwnFloor` 桩上恒判真）。
//    ⚠️ 每做完一次结构性操作就跑一次 `syncClamps()`（rebuildLayout 换元素 ⇒ 裁剪失效）。
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
/** 「切走那一格」临时滚到的另一个位置 —— 刻意 ≠ SRC_PX，否则「没被带跑」这条判据没牙。 */
const OTHER_PX = 140;

const MD = Array.from({ length: ROWS }, (_, i) => `# 标题 ${i + 1}`).join("\n");

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

// ⚠️ 会话起手：**单面板 + 三个不同文档**（a.md 激活 / b.md / c.md）。
//    三个而不是两个：多轮来回切时「每一轮切到**不同**那份」，才能避免「每轮都走同一条
//    切走路径」把某个环节藏起来（gaps ② 只用了 a→b→a，b 那条的覆盖是恒定的）。
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
            {
              path: "c.md",
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
  // ⚠️⚠️ `tabId` **必须每次不同**：a/b/c 三份标签是按 tabId 收口的 —— 恒返回同一个值 ⇒
  //      三份标签被并成**同一个文档**，「切标签 = 真切走另一份文档」这条前提全塌
  //      （gaps 文件里踩过，是本文件最大的一条陷阱）。
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

/** `openFile` 的 tabId 自增源（见 mock 里那条 ⚠️）。 */
let OPEN_SEQ = 100;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function userScroll(el: HTMLElement, px: number): void {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: px }));
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}

const clamped = new WeakSet<HTMLElement>();

/** 浏览器式裁剪（jsdom 不自己裁）；上限**不按内容算**（预览块 DOM 异步铺开会数到 0）。 */
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
  // ⚠️ 这一侧被 `display:none`（宿主 `mode-preview`）⇒ 量不出来（真机 scrollTop 清零、
  //    scrollHeight / clientHeight 全 0）。桩里不补 ⇒ `sourceAtOwnFloor` 恒判真 ⇒ 假绿。
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
function countUnits(el: HTMLElement): number {
  return el.querySelectorAll(
    el.classList.contains("cm-scroller") ? ".cm-line" : "[data-line-start]",
  ).length;
}

/** 每次结构性操作之后都要再跑一次：rebuildLayout 换掉一批元素，新元素没裁过 ⇒ 判据读 0。 */
function syncClamps(): void {
  for (const h of hosts()) {
    for (const el of [visibleScroller(h), visiblePreview(h)]) {
      if (el) installClamp(el);
    }
  }
}

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
/** 「这一格此刻看得见哪一侧」的唯一凭据是 `.panel-host` 上的 mode-* class（元素都在 DOM 里）。 */
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
// ⚠️ 这里**故意不写**「把所有格子的 scrollTop 一起列出来再断言」那种全局判据：某一格上
//    此刻显示的是别的文档（切走那一拍），它的位置本来就不该是 SRC_PX —— 卷进来要么假红、
//    要么为了不红写成恒真 ⇒ 一律逐格取、逐格判（见下面 `srcElOf` / `expectPrevPx`）。

// ---------------------------------------------------------------- 逐格判据
/**
 * ⚠️ 本文件**不用**全局 `srcPxs()` 去断言「每一格都 287」：分屏 + 多标签时，某一格上此刻
 *    显示的是 b.md / c.md（切走那一拍），它的位置本来就不该是 SRC_PX —— 全局断言会把它
 *    一起卷进来 ⇒ 要么假红、要么为了不红而写成恒真。
 *    ⇒ 逐格取、逐格判，且**先自证这一格此刻有可见的那一侧**（`got === null ⇒ throw`，
 *      否则 `want ?? 0` 会变成一条恒真断言）。
 */
function srcElOf(host: HTMLElement): HTMLElement {
  const el = visibleScroller(host);
  if (!el) throw new Error(`这一格现在没有可见的源码格（判据会假绿）`);
  return el;
}
function srcPxOf(host: HTMLElement): number {
  return srcElOf(host).scrollTop;
}
function prevPxOf(host: HTMLElement): number {
  const el = visiblePreview(host);
  if (!el) throw new Error(`这一格现在没有可见的预览格（判据会假绿）`);
  return el.scrollTop;
}
function srcPxIn(panelIdx: number): number {
  return srcPxOf(hosts()[panelIdx]);
}
function prevPxIn(panelIdx: number): number {
  return prevPxOf(hosts()[panelIdx]);
}
function expectSrc(label: string, got: number, want: number): void {
  expect(
    got,
    `${label}：几何变了 ⇒ 同一游标 V=${V} 该落 ${want.toFixed(2)}（实际 ${got.toFixed(2)}）`,
  ).toBeCloseTo(want, 2);
}
/** 断言「第 panelIdx 格切回 a.md 之后停在 SRC_PX」—— 那一步走 switchTab 的收口，是主判据。 */
function expectSrcIn(label: string, panelIdx: number): void {
  expectSrc(label, srcPxIn(panelIdx), SRC_PX);
}
/** 断言「第 panelIdx 格此刻停在 PREV_PX」（预览那一格的落点判据）。 */
function expectPrevIn(label: string, panelIdx: number): void {
  expectSrc(label, prevPxIn(panelIdx), PREV_PX);
}
/** 预览侧逐格判据（拿 host，不拿索引 —— 见 ④ 那条 ⚠️）。 */
function expectPrevPx(label: string, got: number, want = PREV_PX): void {
  expectSrc(label, got, want);
}
/** 面板元素 → 它那一格（`.panel-host`）。 */
function hostOf(panel: HTMLElement): HTMLElement {
  const host = panel.querySelector(".panel-host") as HTMLElement | null;
  if (!host) throw new Error("这一栏里没有 .panel-host（DOM 序对我不可信）");
  return host;
}
/** 某一栏里现有标签的名字（认格用，别按索引认 —— 见 ④ 那条 ⚠️）。 */
function tabNames(panel: HTMLElement): string[] {
  return Array.from(panel.querySelectorAll(".panel-tabstrip .tab .tab-name")).map(
    (e) => e.textContent ?? "?",
  );
}
/**
 * ⚠️ 点某一栏里**指定名字**的标签，取**第一份**（DOM 序）—— 不是最后一份。
 *      面板形态是**活动标签自己的 `viewMode`** 推出来的（`applyPanelMode`），点最后一份
 *      就是激活合并路径带进来的那份 preview 味副本 ⇒ 整格翻成 `mode-preview`（④ 实测）。
 *      要切回的是**自己那份槽**，那就是第一份。
 */
function clickTabIn(panel: HTMLElement, name: string): void {
  clickTabNamedIn(panel, name, false);
}
/** 点某一栏里**指定名字**的标签（不按索引认格，见 ④ 那条 ⚠️）。 */
function clickTabNamedIn(panel: HTMLElement, name: string, pickLast: boolean): void {
  const tabs = Array.from(panel.querySelectorAll(".panel-tabstrip .tab")) as HTMLElement[];
  const hits = tabs.filter((t) => t.querySelector(".tab-name")?.textContent === name);
  const el = pickLast ? hits[hits.length - 1] : hits[0];
  if (!el) {
    throw new Error(`这一栏里没有叫「${name}」的标签（现有 = ${tabNames(panel).join("/")}）`);
  }
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.click();
}
/** 前提断言：同步滚动确实开着。⚠️ 只能在「本窗口已有 ≥2 份可见实例」之后调（`refreshSyncButton` 早退）。 */
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
function activatePanel(panel: HTMLElement): void {
  panel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
}

/** 面板操作区那颗键（按 aria-label 前缀）；md 两颗只在活动面板上挂。 */
function clickPanelOpIn(panel: HTMLElement | null, prefix: string): HTMLElement {
  const scope = panel ?? (document as unknown as HTMLElement);
  const btn = Array.from(scope.querySelectorAll<HTMLButtonElement>(".panel-op")).find((b) =>
    (b.getAttribute("aria-label") ?? "").startsWith(prefix),
  );
  if (!btn) {
    throw new Error(
      `找不到「${prefix}」这颗面板键（现有 = ${
        Array.from(scope.querySelectorAll<HTMLButtonElement>(".panel-op"))
          .map((b) => b.getAttribute("aria-label") ?? "")
          .join("/") || "（无）"
      }）`,
    );
  }
  btn.click();
  return btn;
}

/**
 * 「切换到预览 / 切换到源码」按这一格**当前**的形态点。
 *
 * ⚠️ 这两颗键是**互斥**的：预览态那一格只挂「切换到源码」，源码态只挂「切换到预览」
 *    （实测报错形态：`找不到「切换到预览」这颗面板键（现有 = 打开侧边预览…/切换到源码…）`）
 *    ⇒ 按奇偶硬点某一颗必然前提破。
 */
function toggleModeIn(panel: HTMLElement): void {
  const host = panel.querySelector(".panel-host") as HTMLElement;
  const isSource = visibleScroller(host) !== null;
  clickPanelOpIn(panel, isSource ? "切换到预览" : "切换到源码");
}

function closePanelOp(panel: HTMLElement): void {
  const btn = Array.from(panel.querySelectorAll<HTMLButtonElement>(".panel-op")).find((b) =>
    (b.getAttribute("aria-label") ?? "").startsWith("移除该分屏"),
  );
  if (!btn) throw new Error("这一栏没有「移除该分屏」这颗键");
  if (btn.disabled) throw new Error("这一栏的「移除该分屏」是禁用态（前提破了）");
  btn.click();
}

/**
 * 右键菜单分屏：`dir` 决定左右 / 上下（走 copy 分支，不是移动式）。
 * ⚠️ 起点必须是**当前显示中的那一格**（`.tab-active`）：分屏的源是 `syncSourceV(tab)`，
 *    它读**这份标签自己的槽**，点错一份 ⇒ 交出另一份的旧值。
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

/** 收回到单面板（只关最后一个面板 ⇒ 幸存那一栏的标签序不变）。 */
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
 * 每个场景的共同前提：单面板整宽 + a.md 停在中段（游标就是真值）。
 * ⚠️ 必须先点**活动**标签把它钉成显示中的那份：分屏 / 关分屏会往同一栏塞同文档的多个副本，
 *    按名字点会点到任意一份（gaps ② 第 ⑦ 条栽过：源取到另一份旧副本的槽，交出 v=2）。
 */
async function primeA(): Promise<void> {
  await resetToSingle();
  clickTabByName(0, "a.md");
  await wait(360);
  syncClamps();
  userScroll(srcEls()[0], SRC_PX);
  await wait(420);
  expectSrc("前提：单面板整宽、a.md 停在中段", srcPxIn(0), SRC_PX);
}

/**
 * ⭐ **一轮「切走 → 在那一格滚到别处 → 切回」** —— 本文件的基本动作。
 *
 * 为什么是这三拍而不是「切走 → 切回」：只切走再切回，切走那一格的位置**始终是沿用值**
 * （桩里面板只有一个 scroller 元素），等于什么都没判；插入「滚到别处」这一拍之后，
 * 这一格才真的有个「不是 SRC_PX」的位置，切回时 `switchTab` 的收口必须把 a.md **自己的**
 * 游标还回来 —— 槽被写歪 / 交接取错就会在这一拍现形。
 */
async function roundTrip(
  panelIdx: number,
  away: string,
  otherMode: "src" | "prev" = "src",
): Promise<void> {
  // ① 切走（那一格显示别的文档）
  clickTabByName(panelIdx, away);
  await wait(430);
  syncClamps();
  // ⚠️ 这里**不**断言这一格自己在哪（沿用值，无鉴别力，见文件头）；只自证「切走了」。
  const awayHost = hosts()[panelIdx];
  const awayHere = visibleScroller(awayHost);
  if (!awayHere) throw new Error(`第 ${panelIdx} 格切到 ${away} 之后没有可见源码格`);

  // ② 在这一格滚到另一个位置 ⇒ 它此刻有个「不是 SRC_PX」的位置
  userScroll(awayHere, OTHER_PX);
  await wait(430);
  syncClamps();
  expectSrc(`第 ${panelIdx} 格切到 ${away} 之后滚到 OTHER_PX`, awayHere.scrollTop, OTHER_PX);
  // ⚠️ 有牙的一条：**另一个格没被这个离去的源带跑**（跨文档错推 / 推播源取错 ⇒ 这条红）
  const otherIdx = panelIdx === 0 ? 1 : 0;
  const otherTag = otherMode === "src" ? "源码格" : "预览格";
  if (otherMode === "src")
    expectSrcIn(`第 ${panelIdx} 格切成 ${away} 滚过之后，另一格还在同一游标`, otherIdx);
  else expectPrevIn(`第 ${panelIdx} 格切成 ${away} 滚过之后，另一格还在同一游标`, otherIdx);

  // ③ 切回 a.md —— 主判据那一拍
  clickTabByName(panelIdx, "a.md");
  await wait(480);
  syncClamps();
  expectSrcIn(`切回 a.md 之后（第 ${panelIdx} 格）`, panelIdx);
  if (otherMode === "src") expectSrcIn(`切回 a.md 之后（另一格 ${otherTag}）`, otherIdx);
  else expectPrevIn(`切回 a.md 之后（另一格 ${otherTag}）`, otherIdx);
  void otherTag;
}

describe("B261 第十轮：分屏 + 多标签，来回切换多轮 —— 同一游标不许累积漂移", () => {
  beforeAll(async () => {
    installLineGeometry();
    await import("../src/main");
    await wait(600);
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    // ⚠️ 必须显式开同步：`docSyncModes` 是每条同步路径的闸口，不开 ⇒ 走 B149 基线「各认各的」
    //    ⇒ 位置恰好也成立 ⇒ 整份用例退化成假绿（本文件最大的一条陷阱）。
    btn.click();
    await wait(250);
    syncClamps();
    expect(panels().length, "前提：从单面板整宽起手").toBe(1);
  });

  // ---------------------------------------------------------------- ①
  it("① 两格分屏 + 三标签：左格当源，来回切 3 轮（每轮换不同目标）都不许漂移", async () => {
    await primeA();
    splitTab("h"); // 右键「左右分屏」= copy 分支
    await wait(520);
    syncClamps();
    expect(panels().length, "前提：确实分出了新面板").toBe(2);
    expectSyncOn("分屏之后");
    expect(
      visibleScroller(hosts()[0]) !== null && visibleScroller(hosts()[1]) !== null,
      "前提：两格都是源码（复制出来的那份也是源码）",
    ).toBe(true);
    expectSrcIn("分屏出来 ⇒ 源与新副本都落在同一游标", 0);
    expectSrcIn("分屏出来 ⇒ 源与新副本都落在同一游标", 1);

    // ⚠️ 3 轮，且**每轮切走的目标不同**（b → c → b）：都切同一份 ⇒ 每轮都走同一条路径，
    //    第一条路径上的一次性脏值会被后面两轮盖掉 ⇒ 判据看着跑了 3 轮、实际只测了 1 轮。
    for (const away of ["b.md", "c.md", "b.md"]) {
      await roundTrip(0, away);
    }
    expectSrcIn("3 轮切回之后（左格）", 0);
    expectSrcIn("3 轮切回之后（右格）", 1);
  });

  // ---------------------------------------------------------------- ②
  it("② 两格分屏：源在两格之间**交替**，每轮「切走→滚别处→切回」3 轮", async () => {
    await primeA();
    splitTab("h");
    await wait(520);
    syncClamps();
    expect(panels().length, "前提：两格").toBe(2);
    expectSyncOn("分屏之后");

    // ⚠️ 前提：copy 分支只把**活动那一份** a.md 复制过去 ⇒ 右格只有 `a.md` 一个标签，
    //    切不到别的文档。⇒ 「多标签切走/切回」这一拍只能落在左格（a/b/c 三份在那儿），
    //    右格的角色是「**被推播照顾的那一格**」：每一轮都断言它没被离去的源带跑、
    //    也没被切回的那一次交接带跑。
    const r1 = panelOf(hosts()[1]);

    // 轮 1：左格当源（滚 287）→ 左格切走（滚别处）→ 切回
    userScroll(srcEls()[0], SRC_PX);
    await wait(420);
    syncClamps();
    expectSrcIn("轮1 前提：左格滚到中段 ⇒ 右格跟上", 1);
    await roundTrip(0, "c.md");

    // 轮 2：**换右格当源**（上面全是左格当源；源的那一侧换了 ⇒ 交接与推播方向都跟着换）
    userScroll(srcEls()[1], SRC_PX);
    await wait(420);
    syncClamps();
    expectSrcIn("轮2 前提：右格滚到中段 ⇒ 左格跟上", 0);
    await roundTrip(0, "b.md");
    expectSrcIn("轮2 · 右格（这一轮的源）没被左格的切走/切回带跑", 1);

    // 轮 3：两格**同时**动 —— 左格切走切回 + 右格切模式（源码 ⇄ 预览）打断
    clickTabByName(0, "c.md"); // 左格切走
    activatePanel(r1); // 模式键只在活动面板上
    await wait(300);
    syncClamps();
    toggleModeIn(r1); // 右格改形态（预览）
    await wait(520);
    syncClamps();
    expectSrcIn("轮3 · 左格切成 c.md 之后自己还在同一游标", 0);
    expectSrc(`轮3 · 右格切到预览 ⇒ 落在同一游标`, prevPxIn(1), PREV_PX);

    clickTabByName(0, "a.md"); // 左格切回
    activatePanel(r1);
    await wait(300);
    syncClamps();
    toggleModeIn(r1); // 右格切回源码
    await wait(520);
    syncClamps();
    expectSrcIn("轮3 · 两格都切回 a.md（左）", 0);
    expectSrcIn("轮3 · 两格都切回 a.md（右）", 1);
  });

  // ---------------------------------------------------------------- ③
  it("③ 两格（源码↔预览）：标签来回切 **+ 模式切换**穿插，3 轮都不许跑偏", async () => {
    await primeA();

    clickPanelOpIn(null, "打开侧边预览"); // 右格 = a.md 的预览（新面板被设为活动面板）
    await wait(520);
    syncClamps();
    expect(panels().length, "前提：两格").toBe(2);
    expectSyncOn("侧边预览开出来之后");
    expect(
      visiblePreview(hosts()[1]) !== null && visibleScroller(hosts()[0]) !== null,
      "前提：左格源码 / 右格预览",
    ).toBe(true);

    userScroll(srcEls()[0], SRC_PX); // 左格源码当源
    await wait(430);
    syncClamps();
    expectSrcIn("前提：左格滚到中段 ⇒ 右格预览跟着同一个游标", 0);

    const right = panelOf(hosts()[1]);
    /**
     * 把右格摆成**指定的形态**（预览 / 源码 交替）—— 模式切换与标签切换**穿插**，
     * 逼着 `switchTab` 的交接与 `toggleViewMode` 的交接轮着干活（这两条是 B261 第八轮那
     * 两条独立路径，单轮用例只各测一次，多轮才会暴露累积漂移）。
     */
    async function ensureRightMode(wantPreview: boolean): Promise<void> {
      const isPreview = visiblePreview(hosts()[1]) !== null;
      if (isPreview === wantPreview) return;
      activatePanel(right); // 模式键只在活动面板上
      await wait(300);
      syncClamps();
      toggleModeIn(right); // 形态感知（两颗键互斥）
      await wait(520);
      syncClamps();
    }
    const away = ["b.md", "c.md", "b.md"];
    for (let round = 1; round <= 3; round++) {
      const wantPreview = round % 2 === 1;
      await ensureRightMode(wantPreview);
      const shape = wantPreview ? "右格预览" : "右格源码";
      expectSrc(`第 ${round} 轮·摆好形态之后（左格源码）`, srcPxIn(0), SRC_PX);
      if (wantPreview) expectPrevIn(`第 ${round} 轮·摆好形态之后（${shape}）`, 1);
      else expectSrcIn(`第 ${round} 轮·摆好形态之后（${shape}）`, 1);

      // 顺带把「多标签切走/切回」插进模式切换的串里；另一格当前是什么形态就按什么形态判
      await roundTrip(0, away[round - 1], wantPreview ? "prev" : "src");
      await ensureRightMode(wantPreview); // 切走/切回可能把它又带回另一形态 ⇒ 摆回去
      expectSrc(`第 ${round} 轮·切回 a.md 之后（左格源码）`, srcPxIn(0), SRC_PX);
      if (wantPreview) expectPrevIn(`第 ${round} 轮·切回 a.md 之后（${shape}）`, 1);
      else expectSrcIn(`第 ${round} 轮·切回 a.md 之后（${shape}）`, 1);
    }
    expectSrcIn("3 轮穿插之后（左格）", 0);
    if (visiblePreview(hosts()[1]) !== null) expectPrevIn("3 轮穿插之后（右格预览）", 1);
    else expectSrcIn("3 轮穿插之后（右格源码）", 1);
  });

  // ---------------------------------------------------------------- ④
  it("④ 三格分屏 + 三标签：多轮来回切 → 关回单面板，几何变宽后游标仍不许掉", async () => {
    await primeA();

    splitTab("h"); // ⇒ 2 格
    await wait(520);
    syncClamps();
    expectSyncOn("两格之后");
    activatePanel(panelOf(hosts()[1]));
    await wait(300);
    syncClamps();
    clickPanelOpIn(panelOf(hosts()[1]), "打开侧边预览"); // 在活动面板（右格）再开一格 ⇒ 3 格
    await wait(540);
    syncClamps();
    expect(panels().length, "前提：三格").toBe(3);
    expectSyncOn("三格之后");
    const srcCount = srcEls().length;
    expect(srcCount, "前提：至少两格是源码（第三格是预览）").toBeGreaterThanOrEqual(2);

    // ⚠️⚠️ 三格形态（实测，别凭想象）：`0 = 源码(a,b,c) | 1 = 源码(a.md 副本) | 2 = 预览(a.md)`。
    //     ⇒ **只有 0 号格有三个标签**（copy 分支只复制活动那一份，预览格也是单标签），
    //       所以「多标签来回切」只能落在那一个源码格，其余两格当**观察者**：每一轮都断言
    //       它们没被离去的源带跑、也没被切回那一次交接带跑。只切一格的话，「被正确还原」
    //       这一半根本轮不到执行 —— 判据测的就成了「没被弄坏」。
    // ⚠️ 而且这些格子**不能用索引认**：切标签会触发 rebuildLayout，DOM 序会漂（实测
    //    「第 0 格现在没有可见的源码格」就是索引认错了格）。按**形状**找：三标签的源码格 /
    //    另一个源码格 / 预览格。
    // ⚠️ `visibleScroller` / `visiblePreview` 只认 **host**（`.panel-host`）—— 传 panel
    //    进去 classList 只有 `layout-panel` ⇒ 恒 null ⇒ 找格永远失败（这个坑我自己踩了两次）。
    /** 认格失败时把自己糊在脸上：每一格的形态 / 标签 / 两侧是否可见，一条不落。 */
    const modeState = (): string =>
      hosts()
        .map((h) => [...h.classList].find((c) => c.startsWith("mode-")) ?? "?")
        .join(" | ");
    const diagState = (): string =>
      hosts()
        .map(
          (h, i) =>
            `${i}:${[...h.classList].find((c) => c.startsWith("mode-")) ?? "?"}` +
            `|src=${visibleScroller(h) ? "y" : "n"}` +
            `|prev=${visiblePreview(h) ? "y" : "n"}` +
            `|${tabNames(panelOf(h)).join(",")}`,
        )
        .join("  //  ");
    /**
     * ⚠️⚠️ **别按「含 b.md/c.md」认格**（第一版就是这么写的 ⇒ 全跑时红、④ 单跑绿）。
     *      `resetToSingle()` 关最后一格走的是**合并路径**，① ② ③ 留下的 a.md 副本会被并进
     *      第 0 格，而且**每换一遍用例顺序多几份都不固定**（实测轮 1 起始 =
     *      `a.md,b.md,c.md,a.md,a.md` → 再跑一次变 6 个）⇒ 按名字/数目钉前提＝换个顺序就假红。
     *      ⇒ 认格按**形状**（源码格 / 预览格）+ **标签数最多的那格 = 多标签格**。
     */
    const sourceHosts = (): HTMLElement[] => hosts().filter((h) => visibleScroller(h) !== null);
    /** 真正挂着 a/b/c 三份的那一格（原栏）—— 多标签来回切只能落在它身上。 */
    const triSourcePanel = (): HTMLElement => {
      const ranked = sourceHosts().map((h) => ({ h, n: tabNames(panelOf(h)).length }));
      const best = ranked.reduce<{ h: HTMLElement; n: number } | null>(
        (a, b) => (a === null || b.n > a.n ? b : a),
        null,
      );
      if (!best || best.n < 3) {
        throw new Error(
          `找不到「挂着 a/b/c 三份的源码格」（标签最多的那格只有 ${best?.n ?? "无"} 个）；当时 = ${diagState()}`,
        );
      }
      return panelOf(best.h);
    };
    /** 另一个源码格（分屏 / 侧边预览复制出来的单标签副本）——「被推播照顾的观察者」。 */
    const otherSourcePanel = (): HTMLElement => {
      const other = sourceHosts().find((h) => h !== hostOf(triSourcePanel()));
      if (!other) throw new Error(`找不到「另一个源码格」；当时 = ${diagState()}`);
      return panelOf(other);
    };
    const previewPanel = (): HTMLElement => {
      const host = hosts().find((h) => visiblePreview(h) !== null);
      if (!host) throw new Error(`找不到「预览格」；当时 = ${diagState()}`);
      return panelOf(host);
    };

    /**
     * 三格前提的**自证闸**：格数 + 形态（源码 / 源码 / 预览）+「挂着 a/b/c 的那格还在」。
     *
     * ⚠️ 为什么要点完标签也复核一遍：面板形态是**活动标签自己的 `viewMode`** 推出来的
     *    （`applyPanelMode`），点到一个 preview 味的标签就等于把整格翻成 `mode-preview`
     *    ⇒ 不复核的话，失败信息会是「标签最多的那格只有 1 个标签」这种看不懂的话；
     *    复核之后当场就能看出「形态被点了」，据此去查点的是哪一份。
     */
    function expectTriShape(round: number, where: string): void {
      expect(panels().length, `（三格·轮${round}·${where}）前提：三格`).toBe(3);
      expect(modeState(), `（三格·轮${round}·${where}）三格形态`).toBe(
        "mode-source | mode-source | mode-preview",
      );
      const n = Math.max(0, ...sourceHosts().map((h) => tabNames(panelOf(h)).length));
      expect(
        n,
        `（三格·轮${round}·${where}）多标签那格还在（挂着 a/b/c 三份）`,
      ).toBeGreaterThanOrEqual(3);
    }

    const awayNames = ["b.md", "c.md", "b.md"];
    for (let round = 1; round <= 3; round++) {
      const away = awayNames[round - 1];
      // ⚠️ 前提断言只钉**形态**（三格），**不钉标签数**：`resetToSingle()` 关最后一格走的是
      //    合并路径，① ② ③ 留下的 a.md 副本会被并进这栏（实测轮 1 起始变成 6 个标签），
      //    钉死数量 ⇒ 换个用例顺序就假红；而「哪一格有多标签」按**是否含 b.md/c.md** 认。
      // ⚠️ 前提只钉**形态**（3 格 = 源码 / 源码 / 预览）+ 格数；钉标签名/数目会随用例顺序假红
      //    （实测，见上面 `triSourcePanel` 那条 ⚠️⚠️）。
      expectTriShape(round, "起始");
      // ⚠️ host **每步重新解析**，不能缓存：点标签会触发 rebuildLayout 重建面板 DOM，
      //    缓存下来拿到的是旧元素 ⇒ `这一格现在没有可见的源码格`。
      clickTabIn(triSourcePanel(), away);
      await wait(460);
      syncClamps();
      userScroll(srcElOf(hostOf(triSourcePanel())), OTHER_PX);
      await wait(430);
      syncClamps();
      expectSrc(
        `（三格·轮${round}）切成 ${away} 后滚到 OTHER_PX`,
        srcPxOf(hostOf(triSourcePanel())),
        OTHER_PX,
      );
      // ⚠️ 另外两格不许被这个离去的源带跑（跨文档错推 / 推播源取错 ⇒ 这两条红）
      expectSrc(
        `（三格·轮${round}）另一格源码没被带跑`,
        srcPxOf(hostOf(otherSourcePanel())),
        SRC_PX,
      );
      expectPrevPx(`（三格·轮${round}）预览格没被带跑`, prevPxOf(hostOf(previewPanel())));

      // 切回 a.md（**取 DOM 序第一份** = `primeA` 钉过、滚到 SRC_PX 的那一份）。
      // ⚠️⚠️ 别点「最后一份」（第一版就是这么写的 ⇒ 全跑时红、④ 单跑绿）：
      //        `applyPanelMode`（src/main.ts:5607-5619）里**面板形态取自活动标签自己的
      //        `viewMode`**，而合并路径带进来的那些 a.md 副本是 **preview 味**的（③ 那几格
      //        本来就是预览）⇒ 点最后一份 = 激活一个 preview 味标签 ⇒ 整格翻成 `mode-preview`
      //        ⇒ 认格立刻失败。要切回的是**源那一份自己的槽**，那一份就是第一个 a.md。
      clickTabIn(triSourcePanel(), "a.md");
      await wait(520);
      syncClamps();
      expectSrc(
        `（三格·轮${round}）切回 a.md（多标签格）`,
        srcPxOf(hostOf(triSourcePanel())),
        SRC_PX,
      );
      expectSrc(
        `（三格·轮${round}）切回 a.md（另一格源码）`,
        srcPxOf(hostOf(otherSourcePanel())),
        SRC_PX,
      );
      expectPrevPx(`（三格·轮${round}）切回 a.md（预览格）`, prevPxOf(hostOf(previewPanel())));
      expectTriShape(round, "切回后");
    }

    // 收关回单面板：几何从「三格」回到整宽，同一游标不许掉（B261 第四轮那根轴）
    await resetToSingle();
    expect(panels().length, "前提：回到单面板").toBe(1);
    expectSrcIn("三格来回切之后关回单面板（整宽几何）", 0);
  });
});

/**
 * 反验证记录（退化跑过，逐条对照；**不粉饰弱判据**）。
 *
 * | 退化 | 退化内容 | 本文件 ①②③④ | 咬不咬得住 |
 * |---|---|---|---|
 * | d1 | `handoverV` 第三参回到「当场问 `sourceAtOwnFloor(shownTab)`」（B261 第八轮那处时机） | 全绿 | ✗ |
 * | d2 | `handoverV` 一律取 `max`（B260 那个病根） | 全绿 | ✗ |
 * | d3 | `switchTab` 里夹住 `setState` 的 `suppressSyncPush` 拿掉（B254 切标签推播） | 全绿 | ✗ |
 *
 * 退化脚本：`.tmp/degrade-cycle.mjs d1|d2|d3`（锚点唯一性守卫，命中 ≠ 1 直接拒绝退化）、
 * 还原 `.tmp/restore-cycle.mjs`（`writeFileSync` + md5 核对，非 `cp` —— 别把旧 mtime 带回来）。
 *
 * ⚠️⚠️ **三条全绿不是「判据松」，是这批用例压根造不出那三条路径的局面**：
 *
 * 1. **d1 / d2 咬不动 —— 交接那两条路径一次都没进过。**
 *    `syncSourceSnapshot` 一开头就是 `if (docSyncModes.get(src.docId) !== true) return null`
 *    （同步档是**按 docId** 存的，不是按窗口），而本文件每一轮「切走」的目标都是
 *    **b.md / c.md（别的文档）** —— 那两份从没被点开过同步 ⇒ 交回来恒 `null` ⇒
 *    `handV` 恒 `null` ⇒ `alignShownToSyncSource` 在 `if (snap === null) return false`
 *    那一行就早退了。就算进得去也不看 d2 的脸色：稳态下源那一格与「接班自己那一格」
 *    本来就相等，`Math.max(from, to)` 是**恒等运算** ⇒ max 开不开都落在同一个数上。
 *    ⇒ 真缺的是**工况**，不是断言：**「同文档两个实例来回切」（a.md ⇄ a.md 副本）**
 *    与**「滚到底那一路（`atFloor` 取到真值）」**这两块本文件没有覆盖。
 *    （补上之后 d1 才有牙：只有源真顶到自己一侧的上限、`from ≠ to` 时，`max` / `atFloor`
 *     这两处的选择才会在落点上看得出来。）
 *
 * 2. **d3 咬不动 —— 那一趟推播没有同文档预览可钉。**
 *    B254 那发是「`setState` 把源归零 ⇒ 那一趟推播把**同文档的预览**钉回开头」。本文件
 *    切走的目标是别的文档的标签 ⇒ 那一趟推播的兄弟是**别的文档**的实例，同文档预览一个
 *    都不在 ⇒ 推不出「被钉回开头」那个值。
 *
 * 3. ⇒ 这批用例真正的鉴别力在**几何 / 形态 / 多格一致性**：三格关回整宽后游标不掉、
 *    另外两格没被离去的源带跑、每一轮切回之后各格都还在 `SRC_PX` / `PREV_PX`。
 *    性质是**回归护栏**（守住「多轮来回切不许累积漂移」这条用户症状），不是把
 *    `handoverV` / `suppressSyncPush` 那几条修复单独钉死。
 *
 * ⚠️ 换句话说：要补的是工况（同文档实例切换 / 滚到底 / 同文档预览兄弟），不是把断言写紧。
 *    见 `.workbuddy/memory/open-items/backlog.md`。
 *
 * 详见 `.workbuddy/memory/2026-10-07.md`（B261 第十轮）—— 每次退化后更新这一段。
 */

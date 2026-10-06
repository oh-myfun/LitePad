// @vitest-environment jsdom
// B259：**「打开侧边预览」这条路径的滚动落点**（用户报：开着同步滚动打开侧边预览，
// 新打开的标签内滚动位置没有同步）。
//
// B257/B258 已经把三条同步路径（切标签收口 / 切模式交接 / 跟随推播）钉住，但**「开
// 侧边预览」这一条从没进过同步链路**：它建新实例、mount 新面板、applyPanelMode 切到
// 预览，全程没人把**源**的位置交过来 —— 新那份预览只能按 `applyPanelMode` 那一个
// `anchorLine` 读（而它读的是**新实例自己那个空档视口**，scrollTop 恒 0）⇒ 新预览从
// 文档开头起。用户报的就是这个。
//
// 桩与 `sync-stability.test.ts` 同型（行高 ≠ 块高、scrollTop 带浏览器式裁剪、确定性
// 布局），判据也是**写死的绝对落点**，不取「实际读到的值」—— 后者在退化时基线本身带
// 错值，会「恒等于错值」而绿。
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
/** 源码停在 `SRC_PX` 时，预览该落的**绝对**位置（块 20 顶 840 + 半个块高 21 = 861）。 */
const LANDED = BLOCK * 20 + BLOCK / 2;

/** md 正文：一行一个标题 ⇒ 预览块 k 与源码行 k+1 一一对应，块顶 = k×BLOCK。 */
const MD = Array.from({ length: 24 }, (_, i) => `# 标题 ${i + 1}`).join("\n");

/** 编辑器 / 预览此刻的可滚动上限（px）：`Infinity` = 内容已撑开。 */
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

// ⚠️ 会话只有一个面板、挂两份同 md 实例（源 + 预览）：这样同步键才露脸，
//    而点击「打开侧边预览」时右侧**没有**邻居 ⇒ 走新建分屏那一支。
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
}));

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function scroller(): HTMLElement {
  const el = document.querySelectorAll(".layout-panel .cm-scroller")[0] as HTMLElement | undefined;
  if (!el) throw new Error("编辑器没挂载");
  return el;
}

/**
 * 找「打开侧边预览」那颗键。`aria-label` 是 `打开侧边预览（在右侧分屏中打开预览）`
 * （见 `src/shell/splitview.ts` 的 `mkOp`）。
 *
 * ⚠️ 用 `aria-label` 而不是「`.panel-op` 的第二个」：操作区里还有切换源码/预览、
 * 移除分屏好几颗，按下标取错了就测的是另一条路径。
 */
function openSidePreviewBtn(panelIdx: number): HTMLElement {
  const panel = document.querySelectorAll(".layout-panel")[panelIdx] as HTMLElement | undefined;
  if (!panel) throw new Error(`面板 ${panelIdx} 没挂载`);
  const el = panel.querySelector<HTMLElement>('.panel-ops [aria-label^="打开侧边预览"]');
  if (!el) throw new Error(`面板 ${panelIdx} 的「打开侧边预览」键没渲染`);
  return el;
}

/** 某个面板的预览根（`.md-preview`）。⚠️ 按**面板序号**取，不是 DOM 的 pid 值。 */
function previewOf(panelIdx: number): HTMLElement {
  const panel = document.querySelectorAll(".layout-panel")[panelIdx] as HTMLElement | undefined;
  if (!panel) throw new Error(`面板 ${panelIdx} 没挂载`);
  const el = panel.querySelector(".md-preview") as HTMLElement | null;
  if (!el) throw new Error(`面板 ${panelIdx} 的预览容器还没建`);
  return el;
}

function clickOpenSidePreview(panelIdx = 0): void {
  openSidePreviewBtn(panelIdx).click();
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

/** 活动面板那颗键只在活动面板上渲染 ⇒ 要点某栏的键，先把那一栏点亮。 */
function activatePanel(panelIdx: number): void {
  const panel = document.querySelectorAll(".layout-panel")[panelIdx] as HTMLElement | undefined;
  if (!panel) throw new Error(`面板 ${panelIdx} 没挂载`);
  panel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
}

function closeSidePanelBtn(panelIdx: number): HTMLElement {
  const panel = document.querySelectorAll(".layout-panel")[panelIdx] as HTMLElement | undefined;
  if (!panel) throw new Error(`面板 ${panelIdx} 没挂载`);
  const el = panel.querySelector<HTMLElement>('.panel-ops [aria-label^="移除该分屏"]');
  if (!el) throw new Error(`面板 ${panelIdx} 的「移除该分屏」键没渲染`);
  return el;
}

/** 同步滚动按钮（`#sync-scroll`）的当前开合。 */
function syncOn(): boolean {
  const btn = document.getElementById("sync-scroll") as HTMLElement | null;
  if (!btn) throw new Error("同步键没出现");
  return btn.getAttribute("aria-pressed") === "true";
}

/**
 * **真浏览器建模**：DOM 节点被摘除 ⇒ `scrollTop` 归零 ⇒ **派发一发 scroll**（B261）。
 *
 * jsdom **不建模这一条**（`scrollTop` 是普通属性，摘与不摘都还在）⇒ 不加这条建模，
 * 「重建面板时旧 view 被摘掉」那一发回执在桩上**根本不存在**，下面那些判据永远绿。
 *
 * ⚠️ 两个坑（都踩过）：
 *   · 别用 `el instanceof HTMLElement` —— 这个 vitest 的 jsdom 环境没注入该全局，
 *     抛 ReferenceError 会把「清零」那一半整个吞掉（建模名存实亡，还看不出错）。
 *   · 事件构造器要在**测试主体这个 realm** 里取（`const Ev = Event`）：MutationObserver
 *     回调试在微任务里，那儿摸到的 `Event` 是 Node 那个 ⇒ `dispatchEvent` 报
 *     `parameter 1 is not of type 'Event'`（清零照做、scroll 那半被吞 ⇒ 只测到半条）。
 */
function installDetachZeroesScroll(): void {
  const Ev = Event;
  // 鸭子类型取滚动容器：`.cm-scroller` 自己或被摘掉的那个子树里的编辑器
  const zero = (el: Node): void => {
    const host = el as unknown as {
      classList?: { contains(n: string): boolean };
      querySelector?(s: string): { scrollTop: number } | null;
      scrollTop?: number;
      dispatchEvent?(e: Event): boolean;
    };
    const sc = host.classList?.contains("cm-scroller")
      ? host
      : (host.querySelector?.(".cm-scroller") ?? null);
    if (!sc) return;
    const before = sc.scrollTop;
    sc.scrollTop = 0;
    if (before !== 0) sc.dispatchEvent(new Ev("scroll"));
  };
  new MutationObserver((recs) => {
    for (const r of recs) for (const n of Array.from(r.removedNodes)) zero(n);
  }).observe(document.body, { childList: true, subtree: true });
}

describe("B259：开侧边预览 ⇒ 新那份预览要落在「源此刻那一格」", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(500);
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click();
    await wait(220);
    installClamp(scroller(), () => editorMax);
    const root = document.querySelector(".layout-panel .md-preview");
    if (root) installClamp(root, () => previewMax);
    installDetachZeroesScroll();
  });

  it("① 新建分屏：新开的右分屏预览要落在 LANDED，源不许被带跑", async () => {
    userScroll(scroller(), SRC_PX);
    await wait(280);
    const srcBefore = scroller().scrollTop;

    clickOpenSidePreview();
    await wait(400);

    const right = previewOf(1).scrollTop;
    expect(
      right,
      `开侧边预览之后新那份预览没落在源的那一格（源 ${srcBefore} ⇒ 应该 ${LANDED}，实际 ${right}）`,
    ).toBe(LANDED);
    // ⚠️ 防假绿：光把新预览碰巧推对不算，源自己不许被这一下带走。
    expect(scroller().scrollTop, "开侧边预览把源带跑了").toBe(srcBefore);
    // ⚠️⚠️ B261 症状② 的闸（用户报「新建分屏时原标签内滚动位置出现变化」）：
    //    「开侧边预览」这一支会 rebuildLayout ⇒ 真机上源面板的 .cm-scroller 被摘一次
    //    ⇒ 归零那一发 scroll 是**异步**到的；到的时候 p.viewTabId 已指向此刻正显示的
    //    那一份，而闭包里的 shownView 是被摘掉的那个 ⇒ 旧容器的 0 会被写进这份的
    //    快照、再把兄弟（上面那个刚落好的新预览）一起抹到开头。断言写**绝对值**
    //    （不只是 `srcBefore`）＝这一拍重建之后原标签到底停在哪。
    expect(
      scroller().scrollTop,
      `新建分屏之后，左栏（原标签）自己停的位置变了（应 ${SRC_PX}，实际 ${scroller().scrollTop}）`,
    ).toBe(SRC_PX);
  });

  it("② 分屏已存在（右栏挂着同源预览）：再点一次不许把任何一份带跑", async () => {
    userScroll(scroller(), SRC_PX + 3); // 仍在行 20 内（7+3=10 < 14）⇒ 落点 = 块 20 内 21×(10/14)
    await wait(320);
    const want = BLOCK * 20 + ((SRC_PX + 3 - ROW * 20) / ROW) * BLOCK;
    const rightBefore = previewOf(1).scrollTop;
    expect(rightBefore, "前提：右分屏预览已经跟着源滚到了本轮的落点").toBeCloseTo(want, 6);

    activatePanel(0);
    clickOpenSidePreview(0); // 右邻居存在且挂着同文档预览 ⇒ 走 switchTab 那支
    await wait(400);

    expect(
      previewOf(1).scrollTop,
      `分屏已存在时再点「打开侧边预览」，右分屏预览跳走了（切前 ${rightBefore}）`,
    ).toBe(rightBefore);
    expect(scroller().scrollTop, "源被这一下带跑了").toBe(SRC_PX + 3);
  });

  it("③ 同步**关着**也一样要落位（用户拍定：不管同步开关，开侧边预览都对齐当前位置）", async () => {
    // 收复成单面板（② 之后右栏还在），好在同步关着的情况下再走一遍「新建一个分屏」那一支。
    closeSidePanelBtn(1).click();
    await wait(400);
    expect(document.querySelectorAll(".layout-panel").length, "前提：已经收成单面板").toBe(1);
    expect(syncOn(), "前提：同步还开着").toBe(true);

    (document.getElementById("sync-scroll") as HTMLElement).click(); // 关同步
    await wait(240);
    expect(syncOn(), "前提：同步已关").toBe(false);

    userScroll(scroller(), SRC_PX);
    await wait(320);
    expect(scroller().scrollTop, "前提：源滚到 SRC_PX").toBe(SRC_PX);

    activatePanel(0);
    clickOpenSidePreview(0); // 无右邻居 ⇒ 新建分屏 + 新实例
    await wait(420);

    const right = previewOf(1).scrollTop;
    expect(
      right,
      `同步关着时开侧边预览，新那份还是落在开头（源 ${SRC_PX} ⇒ 应该 ${LANDED}，实际 ${right}）`,
    ).toBe(LANDED);
    expect(scroller().scrollTop, "同步关着时源不许被带跑").toBe(SRC_PX);
  });

  // ⚠️ ② 是「已存在分屏 + 同步开」这一格的**不回归闸**：同步开着时右栏本来就跟着源滚，
  //    退化 `landPreviewAtSource` 之后落点不变 ⇒ 它不会红，那是预期的（这一格本来就
  //    没有缺口可修）。真正咬住「已存在分屏」那支根因的是下面 ④ —— 右栏停在旧落点时。
  it("④ 分屏已存在 + 同步**关着**：右栏那份要按源落位（同步关着不跟随 ⇒ 落点必然是旧的）", async () => {
    expect(document.querySelectorAll(".layout-panel").length, "前提：分屏还挂着").toBe(2);
    expect(syncOn(), "前提：同步还关着（③ 关的）").toBe(false);

    const stale = previewOf(1).scrollTop; // ③ 落下那一格
    userScroll(scroller(), SRC_PX + 3); // 换到新落点；同步关着 ⇒ 右栏不跟随，停在 stale
    await wait(320);

    const want = BLOCK * 20 + ((SRC_PX + 3 - ROW * 20) / ROW) * BLOCK;
    expect(previewOf(1).scrollTop, "前提：右栏停在旧落点（同步关着 ⇒ 没跟着源滚）").toBeCloseTo(
      stale,
      6,
    );
    // ⚠️ 防假绿：旧落点若和新落点相等，这条判据恒真、退化也不红 —— 先自证两者不同。
    expect(stale, "前提：旧落点必须 ≠ 新落点，否则④ 没有鉴别力").not.toBeCloseTo(want, 6);

    activatePanel(0);
    clickOpenSidePreview(0); // 右邻居存在且挂着同文档预览 ⇒ 走 switchTab 那一支
    await wait(400);

    const now = previewOf(1).scrollTop;
    expect(
      now,
      `分屏已存在 + 同步关着时再点「打开侧边预览」，右栏那份没跟上（旧 ${stale} ⇒ 应该 ${want}，实际 ${now}）`,
    ).toBeCloseTo(want, 6);
    expect(scroller().scrollTop, "④ 源被这一下带跑了").toBe(SRC_PX + 3);
  });
});

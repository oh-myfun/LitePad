// @vitest-environment jsdom
// **B263 常驻判据**（用户报：同文档三个标签 —— 分屏 A 挂「源码标签 a + 预览标签 b」、
// 分屏 B 挂「纯预览标签 c」；同步滚动开着；滚动任意一个标签后再切激活标签 a / b，
// 位置出现偏移）。
//
// 复现出来的那一手：**先切到预览标签 b，再滚 B 栏的纯预览 c**，然后切回源码标签 a ——
// a 直接回顶（自测台：滚 c 到 v=33.31，切回 a 落到 v=1.00，源码停在第一行）。
//
// ⚠️⚠️ 根因 = `applySyncToSibling` 源码支**拿了一块量不到几何的尺子**：
//      源码那一路要「行号 → 编辑器像素」，得借一个 `EditorView` 的 `lineBlockAt`。
//      一个 panel 只挂一个 `EditorView`，面板正显示预览标签时源码那一格连容器一起
//      `display:none`，view 还活着、state 也在，但 CM6 量不出行顶 ⇒ `top` 恒 0 ⇒
//      调用方一 `recordScroll` 就把那份离屏兄弟的槽写成「第 1 行」⇒ 切过去 `restoreViewScroll`
//      读出来就是 0 ⇒ 回顶。B248 的第二层兜底（`panelOfTab(...)?.view?.view`）拿到的
//      **正是这一块**。
//      修法＝**分两次写**：那一刻量不成，就把游标挂进 `pendingSyncCursor`，等这份兄弟
//      **自己现形**（切标签切到它、`applyPanelMode` 把编辑器从 `display:none` 放出来）时
//      再量一次补写进它自己的槽，紧邻的 `restoreViewScroll` 就读到补好的值。
//      ⚠️ 不是「换不出就留死格」：不写会让这份离屏源码**跟不上同步**（B248 那条老病），
//         而且留下的旧值切过去照样漂。挂起记的是**游标**（哪一行），不是替代位置。
//
// ⚠️⚠️ 这一维**所有现有 `sync-*` 用例都盖住了**：桩里 `.cm-line` 的 rect 恒有效、
//      `getClientRects()` 恒返回一个 ⇒ 「离屏 view 量不到几何」在桩上根本不成立。
//      本文件把两件事一起补上：① `display:none` 下 `getClientRects()` 返回**空列表**；
//      ② 离屏 `EditorView` 的 `lineBlockAt` 报 0 行顶。
//
// ⚠️ 判据仍是**游标 `v`**（1-based 行号 + 行内比例），不是「像素不动」。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";

/**
 * 最近一次**会话落盘**的载荷（由下面 `saveSession` 桩记下）。
 * ⚠️ `vi.mock` 工厂被提升到 import 之上 ⇒ 这个夹子必须也用 `vi.hoisted` 造，否则 TDZ。
 */
const cap = vi.hoisted(() => ({
  session: null as null | { panels: { tabs: { scrollTop: number | null }[] }[] },
}));
type CapSession = { panels: { tabs: { scrollTop: number | null }[] }[] };

const ROW = 14;
/** ⚠️ 预览块高：逐块不同（真机：长行换行 ⇒ 块高 = n×行高，n 逐块变）。14 / 25 / 36 循环。 */
const blockH = (i: number): number => ROW + (i % 3) * 11;
/** 第 k 块的顶边（累加）。 */
/**
 * 这个元素正被 `display:none` 藏着吗 —— 面板挂 `mode-preview` 时，它的 `.panel-editor`
 * 整块不可见，里面的 `.cm-*`（含 `view.scrollDOM`）都量不到尺寸。
 */
function hiddenHost(el: Element): boolean {
  let p: Element | null = el;
  while (p) {
    const c = (p as HTMLElement).classList;
    if (c?.contains("panel-host") && c.contains("mode-preview")) return true;
    p = p.parentElement;
  }
  return false;
}

function blockTopOf(k: number): number {
  let t = 0;
  for (let i = 0; i < k; i++) t += blockH(i);
  return t;
}
const SRC_PX = 100; // 刻意非行高整数倍：看落点有没有被「取整到行首」
const PREV_PX = 800; // 刻意非块高整数倍：同上
const MD = Array.from({ length: 60 }, (_, i) => `# 标题 ${i + 1}`).join("\n");

function rowH(): number {
  return document.querySelectorAll(".layout-panel").length >= 2 ? ROW / 2 : ROW;
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
  // ⚠️ `display:none` 下 **`getClientRects()` 必须返回空列表**（浏览器的老实话）。桩里
  //    若恒返回 1 个 rect ⇒ 「离屏 view 量不到几何」这一维在桩上根本不存在 ⇒ 本用例怎么
  //    退化都绿（既有 `sync-*` 的桩就是恒返回，见文件头）。
  //    ⚠️ 但本用例**不是**拿这个当产品闸门：`getClientRects().length > 0` 那条判据在只有
  //       `getBoundingClientRect` 的桩上恒假 ⇒ 既有用例会集体翻红（实测定：4 例）。
  //       这里只用它把「离屏量不到」这一维**造出来**。
  protoRects.getClientRects = function (this: Element): DOMRectList {
    return hiddenHost(this)
      ? ([] as unknown as DOMRectList)
      : ([this.getBoundingClientRect()] as unknown as DOMRectList);
  };
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    const el = this as HTMLElement;
    const isRoot = el.classList.contains("md-preview");
    const isLine = el.classList.contains("cm-line");
    const idx = Math.max(0, Array.prototype.indexOf.call(el.parentElement?.children ?? [], el));
    // ⚠️ 预览块（带 `data-line-start` 的 md 块）按**不均匀的累加块高**排 —— 这一条就是
    //    本文件的命门：块顶与源码行顶彻底脱钩后，「源码行号 + 行内比例」与「预览块顶 +
    //    块内比例」才是两种**不同量纲**的坐标。
    const ls = (el as HTMLElement).dataset?.lineStart;
    const isBlock = !isRoot && !isLine && ls !== undefined;
    const bi = isBlock ? Number(ls) - 1 : 0; // MD 一行一标题 ⇒ 块序号 = 行号 − 1
    const top = isRoot
      ? el.scrollTop
      : isLine
        ? idx * rowH()
        : isBlock
          ? blockTopOf(bi)
          : idx * blockH(0);
    const height = isRoot ? ROW : isLine ? rowH() : isBlock ? blockH(bi) : 0;
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
              viewMode: "preview",
            },
          ],
        },
      ],
      layout: {
        kind: "split",
        dir: "h",
        ratio: 0.5,
        a: { kind: "leaf", panelId: 0 },
        b: { kind: "leaf", panelId: 1 },
      },
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
    // B263 判据要用的**会话落盘载荷**（`recordScroll` 走 `sessionStore.setScroll`，
    // 闸门若没挡住，那个量不出来的 0 就进到这里面 ⇒ 关窗一存 ⇒ 下次启动回顶）。
    cap.session = s as CapSession;
    return Promise.resolve();
  },
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

/**
 * **滚动尺寸**（jsdom 恒 0，必须补 —— 这是缺了它整片判据都假的那一维）。
 *
 * `sourceAtOwnFloor` 判「顶到自然上限」用的是 `scrollHeight - clientHeight - scrollTop`；
 * jsdom 里两个尺寸恒 0 ⇒ 只要 scrollTop ≥ 1 就恒判「顶到上限」⇒ `handoverV` 的
 * `max` 每次都开、切换标签时老位置每次都去顶源 ⇒ 桩上出现**假病**。
 */
function installMetrics(el: HTMLElement, kind: "src" | "prev"): void {
  const line = () => (kind === "src" ? rowH() : blockH(0));
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => DOC_LINES * line() });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 4 * line() });
}

function installLineGeometry(): void {
  const proto = EditorView.prototype as unknown as {
    lineBlockAt: unknown;
    lineBlockAtHeight: unknown;
  };
  const blockOf = (view: EditorView, n: number): unknown => {
    const doc = view.state.doc;
    const line = doc.line(Math.min(Math.max(n, 1), doc.lines));
    const top = (line.number - 1) * rowH();
    return { from: line.from, to: line.to, top, height: rowH(), bottom: top + rowH() };
  };
  /**
   * ⚠️⚠️ 真机第 ② 维：**离屏的 `EditorView` 量不到几何**。
   *
   * `.panel-host.mode-preview` 之下是 `.panel-editor { display: none }`，那个位置的
   * `EditorView` 正被隐藏 ⇒ CM6 的 heightMap 无从测量，`lineBlockAt` 报的是 0（或上一次
   * measure 的陈旧值）。而 `applySyncToSibling` 源码支的第二层兜底（B248）**正是拿这块
   * 离屏 view 当尺子**：`shownView ?? panelOfTab(other.tabId)?.view?.view`。
   *
   * 桩里 `.cm-line` 的 rect 恒返回 `idx * rowH`、与 display 无关 ⇒ 这一维**完全被盖住**，
   * 现有那批 `sync-*` 用例（含 B248 的）在桩上全绿。
   *
   * ⚠️ 判据口径仍是游标 `v`：离屏期间量不出 ⇒ `sourceTopOfV` 落 0 ⇒ 槽被写成 0 ⇒
   *    切回来自然回顶 —— 这正是用户说的「切 a / b 位置偏移」。
   */
  const hidden = (view: EditorView): boolean => hiddenHost(view.scrollDOM);
  const blockOfLive = (view: EditorView, n: number): unknown =>
    hidden(view) ? { from: 0, to: 0, top: 0, height: 0, bottom: 0 } : blockOf(view, n);
  proto.lineBlockAt = function (this: EditorView, pos: number): unknown {
    const line = this.state.doc.lineAt(Math.min(Math.max(pos, 0), this.state.doc.length));
    return blockOfLive(this, line.number);
  };
  proto.lineBlockAtHeight = function (this: EditorView, px: number): unknown {
    return blockOfLive(this, Math.floor(Math.max(0, px) / rowH()) + 1);
  };
}

function panels(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".layout-panel"));
}
function hosts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".layout-panel .panel-host"));
}
function clickTab(panelIdx: number, tabIdx: number): void {
  const tabs = Array.from(panels()[panelIdx].querySelectorAll<HTMLElement>(".panel-tabstrip .tab"));
  const el = tabs[tabIdx];
  if (!el) throw new Error(`no tab ${tabIdx}`);
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.click();
}

describe("B263 同文档三标签（分屏 A = 源码 a + 预览 b，分屏 B = 纯预览 c）", () => {
  it("先切到预览标签 b、再滚 B 栏纯预览 c，切回源码标签 a 不许回顶", async () => {
    installLineGeometry();
    await import("../src/main");
    await wait(500);
    for (const h of hosts()) {
      for (const el of [h.querySelector(".cm-scroller"), h.querySelector(".md-preview")]) {
        if (!el) continue;
        const e = el as HTMLElement;
        installClamp(e);
        installMetrics(e, e.classList.contains("md-preview") ? "prev" : "src");
      }
    }
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("no sync btn");
    btn.click();
    await wait(160);

    // ---- 定序取证（B263 症状锁）----

    /**
     * 预览停在像素 `st` 时读回来的游标 —— 与产品 `topVisibleLine()` **同定义**：最后
     * 一个「块顶 ≤ st」的块，再按**像素比例**乘 `跨行数`（源码行数）插进去。
     * ⚠️ 比例的分母是源码行数、分子是像素差（见 `preview.ts` 的 `applySyncToLine`）——
     *    块高不均匀时只有这个写法能对得上，别改成「按块高插」。
     */
    const prevVAt = (el: HTMLElement, st: number): number | null => {
      const blocks = Array.from(el.children) as HTMLElement[];
      let idx = -1;
      for (let i = 0; i < blocks.length; i++) {
        if (blockTopOf(i) <= st + 1e-6) idx = i;
        else break;
      }
      if (idx < 0) return null;
      const s = Number(blocks[idx].dataset.lineStart);
      const next = blocks[idx + 1];
      if (!next) return s;
      const range = Number(next.dataset.lineStart) - s;
      const ratio = Math.min(
        1,
        Math.max(0, (st - blockTopOf(idx)) / (blockTopOf(idx + 1) - blockTopOf(idx))),
      );
      return s + ratio * range;
    };
    /** 某格此刻的游标（源码格 / 预览格各一把尺）。 */
    const vOf = (el: HTMLElement | null): number | null => {
      if (!el) return null;
      // ⚠️ 源码侧的 `v` 是 **1-based 行号 + 行内比例**（`topVisibleLineFrac` 读 `doc.lineAt`
      //    的行号）⇒ 0 像素 = 第 1 行 = v 1，不是 0。按 0-based 记账 ⇒ 全程差一行（假警）。
      if (el.classList.contains("cm-scroller")) return el.scrollTop / rowH() + 1;
      return prevVAt(el, el.scrollTop);
    };
    const srcEl = (): HTMLElement => hosts()[0].querySelector(".cm-scroller") as HTMLElement;
    const prevEl = (): HTMLElement => hosts()[0].querySelector(".md-preview") as HTMLElement;
    const cEl = (): HTMLElement => panels()[1].querySelector(".md-preview") as HTMLElement;
    /** a 停的位置（源码格：1-based 行号 + 行内比例）。 */
    const vA = (): number => SRC_PX / rowH() + 1;
    /** c 停的位置（预览格：块 lineStart + 像素比例 × 跨行数）。 */
    const vC = (): number => prevVAt(cEl(), PREV_PX) as number;

    /** ⚠️ 反假绿：读了 null 就 throw —— 一栏读不出来时「for 一次都不转」会恒绿。 */
    const expectAt = (label: string, got: number | null, want: number): void => {
      if (got === null) throw new Error(`${label}：这一格读不出游标 ⇒ 本判据会假绿`);
      expect(got, `${label}：期望 v=${want.toFixed(2)}`).toBeCloseTo(want, 2);
    };

    // ⚠️ 定序（不是随机、也不是「三格必须同一 v」）：真机上病的是**「先切到预览 b、
    //    再滚 c」**这一手 —— 那一下推 a（源码、离屏）走 `applySyncToSibling` 源码支的
    //    第二层兜底，拿 A 栏那个 `display:none` 的 EditorView 当尺子。判据因此锁成
    //    **「每一格不许被切标签动作挪走」**：③ 之后 a 与 c 之间隔着「换不出尺子」，
    //    那是物理限制（留死格），硬要它们同 v 就是把留死格也判成病。
    userScroll(srcEl(), SRC_PX);
    await wait(260);
    expectAt("① 滚 A 栏源码 a 之后", vOf(srcEl()), vA());
    expectAt("① B 栏纯预览 c 跟上", vOf(cEl()), vA());

    clickTab(0, 1);
    await wait(260);
    expectAt("② 切到预览标签 b 之后，b 落在 a 的位置上", vOf(prevEl()), vA());

    userScroll(cEl(), PREV_PX);
    await wait(260);
    expectAt("③ 滚 B 栏纯预览 c 之后", vOf(cEl()), vC());

    // ⚠️ ③′ **闸门这一半**的判据（关掉闸门会让 ④ 照样绿，所以这一条单独盯着它）：
    //    滚 c 之后，a 那份的**会话记录**不许被那个量不出来的 0 盖掉。
    //    ⚠️ 这里锁的不是「位置对不对」—— ④ 的补写会把槽修回来；锁的是**那次坏写压根
    //       别发生**：`recordScroll` → `sessionStore.setScroll` → 落盘 ⇒ 那个 0 进了会话
    //       文件就是「下次启动回顶」，症状与用户报的完全同一类，只是换到重启那一天。
    //    ⚠️ 抓的是**会话落盘载荷**（800ms 防抖）而不是槽本身：槽此刻已经没人看得见。
    await wait(1400);
    const aRec = cap.session?.panels?.[0]?.tabs?.[0]?.scrollTop ?? null;
    expect(aRec, "③′ 会话里没记下 a 的位置 ⇒ 这条判据会假绿（抓空了）").not.toBe(null);
    expect(
      aRec,
      `③′ 滚 c 把 a 的会话位置写成 ${aRec}（该是 ${SRC_PX}）——量不出的尺子不许拿 0 落盘`,
    ).toBeCloseTo(SRC_PX, 0);

    // ⚠️⚠️ 病位：此刻 a 离屏、A 栏的 EditorView 被 `display:none` 藏着 ⇒ 量不到几何。
    //    修前那版 `recordScroll(a, 0)` ⇒ 切回来 `restoreViewScroll` 读 0 ⇒ **回顶**
    //    （自测台实测：切回 a 落 v=1.00，而它该跟同步停在 v=33.31）。
    //    ⚠️ 期望值取 **vC() 而不是 vA()**：同步滚开着 ⇒ 离屏那份源码本就该跟着滚（B248），
    //      切回 a 停在「③ 之前那个旧位置 v=15.29」是**留死格**留下的假象 —— 那不是「没动」，
    //      是这份离屏源码压根没跟上来、只是旧值恰好没被动过。这里锁的是「切回来落在同步
    //      该落的地方，且不许回顶」：vC()(33.31) 与 vA()(15.29) 差一大截，回顶(1.00)同样红。
    clickTab(0, 0);
    await wait(280);
    expectAt("④ 切回源码标签 a：不许回顶、要落在同步位置上（B263）", vOf(srcEl()), vC());

    for (const i of [1, 0, 1, 0]) {
      clickTab(0, i);
      await wait(260);
      // ⚠️ 只锁**当前这一格**（接班那份）不许漂 —— 「B 栏 c 不许被带跑」是**写错的判据**：
      //    `switchTab` 收口后按 B152 把兄弟推到「源（此刻是接班前那份）的位置」上，
      //    那是有意设计（B258 那趟补推也一样）。契约红时先分清打的是哪一条：这里要守的
      //    是「切换动作本身不许把接班那份挪到别处 / 打到第 1 行」，不是「兄弟不许同步」。
      expectAt(
        `⑤ 切到${i === 1 ? "预览 b" : "源码 a"}之后不许漂`,
        i === 1 ? vOf(prevEl()) : vOf(srcEl()),
        vC(),
      );
    }
  });
});

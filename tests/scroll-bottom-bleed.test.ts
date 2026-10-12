// @vitest-environment jsdom
// B265：底部留白（scroll past end）—— **最后一行 / 最后一块能滚到容器顶**，下面留一屏空白。
//
// 用户口径：同步滚动 + 标签 / 模式切换仍然一致；顺带把「滚到底时两者 top 位置对不上」消掉。
//
// ⚠️ 几何必须让**两侧的自然上限明显不同**（这是整条用例的前提）：
//   24 行 md、行高 14、块高 42（= 3 行）、视口 60 ⇒
//     · 源码：内容 336、末行 top = 322 ⇒ 留白 46 ⇒ 滚到底 = **322**（末行贴容器顶）
//     · 预览：内容 924、末行 top = 910 ⇒ 留白 46 ⇒ 滚到底 = **910**（末行贴容器顶；
//         22 块 × 42，末块跨 22–24 三行、占 42 高，末行在块内偏移 2×ROW = 28 ⇒ 882 + 28）
//   不放留白的话这两格分别只能到 336−60=276 与 924−60=864 —— 前者停在**倒数第 5 行**贴顶、
//   后者停在末块顶（末行还差一截才到顶），两侧底根本不是同一个位置（B260 那句「预览 966 / 源码 294」同型）。
//
// ⚠️ 桩里 `scrollHeight` / `naturalMax` **必须把源码写出去的那截留白算进去**（读 CSS 变量
//    `--cm-bleed-bottom` / `--md-bleed-bottom`），否则桩里的「可滚上限」会比真机短一截，
//   「滚到底 = 末单元贴顶」这一整件事在桩上根本发生不了、用例变假绿。
// ⚠️ `.md-block` 的高度也给了 BLOCK（与它已有的 top 建模同口径）—— 预览那截留白就量自
//    「末行的高」（本单修复：此前量的是末块高，末块跨多行时末行滚不到顶），给 0 会让留白虚高一屏。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

const ROWS = 24;
const ROW = 14;
const BLOCK = ROW * 3;
/** 视口高：比 3 行多、比 1 块多 ⇒ 两侧自然上限明显不同（这条用例的命门）。 */
const VIEW_H = 60;
/** 源码滚到底（= 最后一行 top）。 */
const SRC_FLOOR = (ROWS - 1) * ROW;
/**
 * 预览滚到底（= **最后一行** top，不是最后一块）：22 块 × 42，末块跨 22–24 三行、占 42 高，
 * 末行在块内偏移 2×ROW = 28 ⇒ 最后一行 top = 21×BLOCK + 2×ROW = 882 + 28 = 910。
 * ⚠️ 这正是本单修复的点：此前留白按「末块高」算，滚到底只能到末块顶（882），末行永远差一截。
 */
const PREV_FLOOR = 21 * BLOCK + 2 * ROW;
/** 两侧该留的白。 */
const SRC_BLEED = VIEW_H - ROW;
const PREV_BLEED = VIEW_H - ROW;
/**
 * ⚠️ 末块必须**跨多行**（这里 3 行）：若每块只占一行，末块的 `start` 与 `lineEnd` 是同一个数，
 * `topVisibleLine()` 交「块起始行」与交「块末行」在数值上完全等价 ⇒ 退化针③打在空处、
 * 用例恒绿（踩过：24 行标题 ⇒ 退化 `return start` 之后 8 条全绿）。
 * ⇒ 前 21 行各成一块，末块（连续三行 ⇒ 一个段落）跨 22–24 行：`start`=22、`lineEnd`=24。
 */
const MD = [
  ...Array.from({ length: 21 }, (_, i) => `# 标题 ${i + 1}`),
  "段落第一行",
  "段落第二行",
  "段落第三行",
].join("\n");

const editorMax = Infinity;
const previewMax = Infinity;

/**
 * 「留白在实例创建那刻算不出来、真机靠 ResizeObserver 补」这一拍的桩实现 —— 记下回调、
 * 等谁点谁触发（与真机同一条补链路，只是触发权交回用例）。
 * ⚠️ 不补这一拍，分屏新建的那一格永远补不上：它的 `clientHeight` 在实例创建时还是 0
 *    ⇒ 留白写 0（有闸门、不会写坏，但也补不回来）⇒ 那格的可滚上限少一整屏。
 */
const roCallbacks: Array<() => void> = [];

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      constructor(cb: () => void) {
        roCallbacks.push(cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
  const proto = window.Element.prototype as unknown as { getBoundingClientRect: () => DOMRect };
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    const el = this as HTMLElement;
    const isRoot = el.classList.contains("md-preview");
    const isLine = el.classList.contains("cm-line");
    const isBlock = el.classList.contains("md-block");
    const idx = Math.max(0, Array.prototype.indexOf.call(el.parentElement?.children ?? [], el));
    const top = isRoot ? el.scrollTop : isLine ? idx * ROW : isBlock ? idx * BLOCK : idx * ROW;
    const height = isRoot ? VIEW_H : isLine ? ROW : isBlock ? BLOCK : 0;
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
  // CM6 量行位置走 `getClientRects()[0] ?? getBoundingClientRect()`；jsdom 恒空 ⇒ 补上。
  const protoRects = window.Element.prototype as unknown as { getClientRects: () => DOMRectList };
  protoRects.getClientRects = function (this: Element): DOMRectList {
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
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

const session = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

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
            // 第二个实例 = 面板里那颗「预览」标签（纯预览态，与源码那份同源）
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
  saveSession: (s: Record<string, unknown>) => {
    session.last = JSON.parse(JSON.stringify(s));
    return Promise.resolve();
  },
  saveSettings: () => Promise.resolve(),
  writeBackup: () => Promise.resolve(),
  restoreBackup: () => Promise.resolve(null),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
  takePendingFiles: () => Promise.resolve([]),
}));

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function src(): HTMLElement {
  const el = document.querySelectorAll(".layout-panel .cm-scroller")[0] as HTMLElement | undefined;
  if (!el) throw new Error("编辑器没挂载");
  return el;
}
function pv(): HTMLElement {
  const el = document.querySelector(".layout-panel .md-preview") as HTMLElement | null;
  if (!el) throw new Error("预览没挂载");
  return el;
}
function userScroll(el: HTMLElement, px: number): void {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: px }));
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}
/** 这一侧是不是被 `display:none` 藏住了（真机：藏住 ⇒ clientHeight = 0）。 */
function hidden(): boolean {
  const host = src().closest(".panel-host");
  return !!host && host.classList.contains("mode-preview");
}
function countUnits(el: HTMLElement): number {
  return el.querySelectorAll(
    el.classList.contains("cm-scroller") ? ".cm-line" : "[data-line-start]",
  ).length;
}
/** 源码实际写出去的那截留白（px）—— 桩靠它把 scrollHeight / 上限算对。 */
function appliedBleed(el: HTMLElement): number {
  const name = el.classList.contains("cm-scroller") ? "--cm-bleed-bottom" : "--md-bleed-bottom";
  return Number.parseFloat(el.style.getPropertyValue(name)) || 0;
}
const clamped = new WeakSet<HTMLElement>();
/**
 * @param disableNaturalMax ⑧ 分屏那一格专用的开关：那一格的 `--cm-bleed-bottom` 在桩里
 *   补不上（CM6 那格量不出 `contentHeight` ⇒ 有闸门、一个字节都不写；真机由 ResizeObserver
 *   + 真实布局补）⇒ 桩的 `naturalMax` 会把可滚上限算少一屏、322 压根写不进去。
 *   留白本身由 ① ⑥ ⑦ 单独钉着，⑧ 咬的是「`v` 的换算」，不该被这一层的桩缺陷挡住。
 */
function installClamp(
  el: HTMLElement,
  max: () => number,
  opts?: { disableNaturalMax?: boolean },
): void {
  if (clamped.has(el)) return;
  clamped.add(el);
  let st = el.scrollTop;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => st,
    set: (v: number) => {
      st = Math.min(
        Math.max(v, 0),
        opts?.disableNaturalMax ? max() : Math.min(max(), naturalMax(el)),
      );
    },
  });
  const unit = el.classList.contains("cm-scroller") ? ROW : BLOCK;
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => (el === src() && hidden() ? 0 : VIEW_H),
  });
  // ⚠️ B265：可滚范围 = 内容 + 源码刚写出去的那截**底部留白**。
  //    不叠这一截 ⇒ 上限比真机短一屏，「滚到底 = 末单元贴容器顶」在桩上永远不成立。
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () =>
      Math.max(
        VIEW_H,
        el.parentElement?.children.length ? countUnits(el) * unit + appliedBleed(el) : unit,
      ),
  });
}
function naturalMax(el: HTMLElement): number {
  const unit = el.classList.contains("cm-scroller") ? ROW : BLOCK;
  const base = el.parentElement?.children.length ? countUnits(el) * unit + appliedBleed(el) : unit;
  return Math.max(0, base - (el === src() && hidden() ? 0 : VIEW_H));
}
/**
 * 一格此刻的游标 `v`（规范游标：行号 + 归一化比例）。
 * 与源码口径同源：源码侧 = `行号 + 行内比例`；预览侧 = `块 start + 比例×跨行数`，
 * **末块顶到容器顶时交块末行**（B265 就是改的这一处 ⇒ 这条判据能咬住两侧是否对齐）。
 */
function vOf(el: HTMLElement): number | null {
  if (el.classList.contains("cm-scroller")) return el.scrollTop / ROW + 1;
  const blocks = Array.from(el.querySelectorAll("[data-line-start]")) as HTMLElement[];
  let idx = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (i * BLOCK <= el.scrollTop + 1e-6) idx = i;
    else break;
  }
  if (idx < 0) return null;
  const s = Number(blocks[idx].dataset.lineStart);
  const next = blocks[idx + 1];
  if (!next) return Number(blocks[idx].dataset.lineEnd);
  const range = Number(next.dataset.lineStart) - s;
  const ratio = Math.min(1, Math.max(0, (el.scrollTop - idx * BLOCK) / BLOCK));
  return s + ratio * range;
}
/** 末单元（最后一块）此刻的容器相对位置：== 容器顶 ⇒ 「贴顶」成立。 */
function lastBlockTop(el: HTMLElement): number {
  const blocks = Array.from(el.querySelectorAll("[data-line-start]")) as HTMLElement[];
  return (
    (blocks[blocks.length - 1]?.getBoundingClientRect().top ?? 0) - el.getBoundingClientRect().top
  );
}
/**
 * 末**行**（最后一块里最后那一行）此刻的容器相对位置：== 容器顶 ⇒ 最后一行贴顶成立。
 * ⚠️ 本单修复的关键判据：此前留白按「末块高」算，滚到底只能到末块顶（lastBlockTop=0、
 * 但末行还差一截）；修复后留白按「末行高」算，滚到底末行贴顶（此函数 = 0、lastBlockTop 为负）。
 * 测试桩：每块高 BLOCK、每源行占 ROW，故末行在块内偏移 = (lineEnd − lineStart) × ROW。
 */
function lastPreviewLineTop(el: HTMLElement): number {
  const blocks = Array.from(el.querySelectorAll("[data-line-start]")) as HTMLElement[];
  const last = blocks[blocks.length - 1];
  if (!last) return 0;
  const blockTop = last.getBoundingClientRect().top - el.getBoundingClientRect().top;
  const lines = Number(last.dataset.lineEnd) - Number(last.dataset.lineStart);
  return blockTop + lines * ROW;
}
/**
 * 源码那侧**不这么量** —— CM6 虚拟化：视口外的行不在 DOM 里，拿「最后一个 `.cm-line` 的
 * 位置」问末行在哪会问到一个**渲染出来的**行（桩里量到 308 = 行 23，不是行 24）。
 * 源码侧的「最后一行贴容器顶」由游标直接钉死：`v` 的整数部分 = 文档行数、比例 = 0
 * （用例里就是 `vOf(src()) === ROWS`），而 `scrollTop === 末行 top` 由首条断言锁住。
 */
const lastLineTop = (): number => (ROWS - 1) * ROW;
function tabEl(i: number): HTMLElement {
  const el = document.querySelectorAll(".layout-panel .tab")[i] as HTMLElement | undefined;
  if (!el) throw new Error(`标签 ${i} 没渲染`);
  return el;
}
function panels(): HTMLElement[] {
  return Array.from(document.querySelectorAll(".layout-panel")) as HTMLElement[];
}
/**
 * 一格的层级：`.layout-panel`（格）> `.panel-host`（`panel.bodyEl`，`mode-*` 挂在这层）
 * > `.cm-scroller` / `.md-preview`；而 `.panel-tabstrip`（标签条）是**格的子层、host 的兄弟**。
 * ⇒ 认格用 `.layout-panel`（只有它同时装得住标签条和 host）；读 mode 得往**里面**找
 *   `.panel-host`，用 `closest` 往上找会找不着 —— host 在下面、不在上面。
 */
function hostPanels(): HTMLElement[] {
  return Array.from(document.querySelectorAll(".panel-host")) as HTMLElement[];
}
/** 第 i 格里那块挂着 `mode-*` 的宿主（`panel.bodyEl` = `.panel-host`）。 */
function hostOf(i: number): HTMLElement {
  const el = hostPanels()[i];
  if (!el) throw new Error(`第 ${i} 格没有 panel-host`);
  return el;
}
/** 右键活动标签 ⇒ 分屏（走 copy 分支；起点必须是当前显示中这一颗，别拿错标签的槽）。 */
function splitTab(dir: "h" | "v"): void {
  const label = dir === "h" ? "左右分屏" : "上下分屏";
  const tabs = Array.from(panels()[0].querySelectorAll(".panel-tabstrip .tab")) as HTMLElement[];
  const tab = tabs.find((t) => t.classList.contains("tab-active"));
  const name = tab?.querySelector(".tab-name")?.textContent;
  if (name !== "a.md") {
    throw new Error(
      `前提破了：要分屏的应该是活动中的 a.md（实际 = ${String(name)}；格0 标签 ${
        tabs.length
      } 颗：${JSON.stringify(tabs.map((t) => ({ c: t.className, n: t.querySelector(".tab-name")?.textContent })))}；活动类在 ${
        Array.from(document.querySelectorAll(".tab-active")).length
      } 个节点上：${JSON.stringify(
        Array.from(document.querySelectorAll(".tab-active")).map((e) => e.className),
      )}）`,
    );
  }
  tab?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const btn = Array.from(document.querySelectorAll<HTMLElement>(".popup-menu > button")).find(
    (b) => b.querySelector(".menu-label")?.textContent === label,
  );
  if (!btn) throw new Error(`右键菜单里没有「${label}」这一项`);
  btn.click();
}
function modeBtn(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.panel-ops [aria-label^="切换到"]');
  if (!el) throw new Error("模式切换键没渲染");
  return el;
}

describe("B265 底部留白：最后一行 / 最后一块能滚到容器顶", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(500);
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click(); // 开同步
    await wait(220);
    installClamp(src(), () => editorMax);
    const root = document.querySelector<HTMLElement>(".layout-panel .md-preview");
    if (root) installClamp(root, () => previewMax);
    // ⚠️ 留白是在**视图创建时**算的（那时 jsdom 还没给 clientHeight ⇒ 量不出、写的是 0），
    //    要等一次 `setState`（换标签会重建插件实例）才按新几何重算。所以装上钳位之后先
    //    切一轮标签——不是给用例打补丁，而是把「真机上 ResizeObserver 会补的那一次」补回来。
    tabEl(1).click();
    await wait(320);
    tabEl(0).click();
    await wait(320);
  });

  it("① 滚到底 ⇒ 源码最后一行贴容器顶，游标 = 文档末行", async () => {
    expect(appliedBleed(src()), "前提：源码这一格已经留出「视口 − 末行」的一屏空白").toBeCloseTo(
      SRC_BLEED,
      6,
    );
    userScroll(src(), 99999);
    await wait(400);
    expect(src().scrollTop, "源码该滚到自己那一侧的底（= 末行 top）").toBeCloseTo(lastLineTop(), 6);
    expect(vOf(src()), "源码到底交回来的游标 = 文档末行（比例 0 ⇒ 末行正好贴容器顶）").toBeCloseTo(
      ROWS,
      6,
    );
  });

  it("② 滚到底 ⇒ 预览**最后一行**（不是最后一块）贴容器顶，游标也 = 文档末行", async () => {
    userScroll(pv(), 99999);
    await wait(400);
    expect(pv().scrollTop, "预览该滚到自己那一侧的底（= 末行 top）").toBeCloseTo(PREV_FLOOR, 6);
    expect(
      lastPreviewLineTop(pv()),
      "滚到底时最后一行必须贴在容器顶（下面留一屏空白）—— 本单修复的关键判据",
    ).toBeCloseTo(0, 6);
    expect(
      lastBlockTop(pv()),
      "末行贴顶 ⇒ 最后一块已经被滚过容器顶（块顶在 0 之上），不再是「只到末块顶」",
    ).toBeLessThan(0);
    // ⚠️⚠️ 这里**故意不**断言「源码被同步推过来」：面板正显示源码标签时，那一格里的
    //   预览是被 `display:none` 藏住的（真机上用户滚不到它），产品那条 scroll 监听第一行
    //   `if (!t || t.viewMode !== "preview") return;` 就直接 return 了 ── 桩把 display:none
    //   屏蔽掉 ⇒ 桩里「滚得动」这件事本身就是假局面，断言在那里恒绿、零鉴别力（踩过）。
    //   「预览到底是源」这一拍放到 ⑧：切到预览标签、让预览**真在屏**，再滚到底。
  });

  it("③ 两侧到底 ⇒ 游标严格相等（这正是「top 位置对不上」的根）", async () => {
    userScroll(src(), 99999);
    await wait(400);
    const vSrc = vOf(src());
    expect(vSrc).not.toBeNull();
    // 源码滚到底（= 末行贴顶）；预览在 ② 已滚到底（= 末行贴顶），隐藏态下同步不反推它，
    // 故仍停在末行顶。两侧游标都 = 文档末行 ⇒ 严格相等。
    expect(pv().scrollTop, "预览在 ② 已滚到底（= 末行 top）").toBeCloseTo(PREV_FLOOR, 6);
    expect(vOf(pv()), "两侧到底的游标必须严格相等").toBeCloseTo(vSrc as number, 6);
  });

  it("④ 切**标签** / 切**模式**之后，两格都还在底、游标都还是文档末行", async () => {
    const vAt = vOf(src());
    tabEl(1).click(); // 切到预览标签
    await wait(400);
    tabEl(0).click(); // 切回源码标签
    await wait(400);
    expect(src().scrollTop, "切标签把源码从底拖小了").toBeCloseTo(SRC_FLOOR, 6);
    expect(vOf(src()), "切标签后源码游标 = 文档末行").toBeCloseTo(vAt as number, 6);

    modeBtn().click(); // 切预览模式
    await wait(400);
    modeBtn().click(); // 切回源码模式
    await wait(400);
    expect(src().scrollTop, "切模式把源码从底拖小了").toBeCloseTo(SRC_FLOOR, 6);
    expect(vOf(src()), "切模式后源码游标 = 文档末行").toBeCloseTo(vAt as number, 6);
  });

  it("⑤ 会话落盘记的是「底」（不是旧上限，也不是 0）", async () => {
    await wait(1400); // 等排程落盘
    const rec = session.last as { panels?: Array<{ tabs?: Array<{ scrollTop?: number }> }> } | null;
    expect(rec, "会话没落盘").not.toBeNull();
    const tops = (rec?.panels ?? []).flatMap((p) => p.tabs ?? []).map((t) => t.scrollTop ?? 0);
    expect(tops.length, "会话里该有两份位置记录").toBe(2);
    expect(
      tops.some((px) => Math.abs(px - SRC_FLOOR) < 1),
      "源码那份记的是底",
    ).toBe(true);
    expect(
      tops.some((px) => Math.abs(px - PREV_FLOOR) < 1),
      "预览那份记的是底",
    ).toBe(true);
  });

  it("⑥ 留白量 = 视口高 − 末单元高（写进 CSS 变量，不是拍脑袋）", async () => {
    expect(
      Number.parseFloat(src().style.getPropertyValue("--cm-bleed-bottom")) || 0,
      "源码留白 = 视口 60 − 末行 14",
    ).toBeCloseTo(SRC_BLEED, 6);
    expect(
      Number.parseFloat(pv().style.getPropertyValue("--md-bleed-bottom")) || 0,
      "预览留白 = 视口 60 − 末行 14（本单修复：此前是 视口 60 − 末块 42 = 18）",
    ).toBeCloseTo(PREV_BLEED, 6);
  });

  it("⑦ 源码**离屏**那一帧不许把留白抹成 0（留白是常驻几何，不是瞬态）", async () => {
    expect(appliedBleed(src()), "前提：源码在屏时留着 46").toBeCloseTo(SRC_BLEED, 6);
    tabEl(1).click(); // 切到预览标签 ⇒ 源码那一格 display:none、clientHeight = 0
    await wait(400);
    expect(hidden(), "前提：源码这一格此刻确实被藏住了").toBe(true);
    expect(src().clientHeight, "前提：离屏视口高 = 0").toBe(0);
    // ⚠️ `setState` 同步派发 update ⇒ 这一帧会去重算留白；B257 同型：
    //    「写瞬态的 0」比「一个字节都不写」更糟（真机要等 ResizeObserver 才补，补之前是错的）。
    expect(appliedBleed(src()), "离屏那一帧算不出几何 ⇒ 必须保持原值，不许写 0").toBeCloseTo(
      SRC_BLEED,
      6,
    );
    tabEl(0).click(); // 切回源码标签
    await wait(400);
    expect(appliedBleed(src()), "切回后依旧是 46").toBeCloseTo(SRC_BLEED, 6);
  });

  it("⑧ 分屏：预览（源，在屏）滚到底 ⇒ 源码兄弟落在「末行贴顶」（末块必须补满到文档末行）", async () => {
    // ⚠️⚠️ 为什么非得分屏不可 —— 单面板里「预览在屏 ⇒ 源码必然离屏」，两条推播都被堵死：
    //   · 预览的 scroll 监听第一行 `if (!t || t.viewMode !== "preview") return;`，而 `t` 取的是
    //     面板正显示的那份（源码标签）⇒ 直接 return；
    //   · 就算推得动，`alignShownToSyncSource` 的 B247 守卫（`src.viewMode === "preview" &&
    //     shown.viewMode !== "preview" ⇒ return false`）也让它彻底不推、交回 `restoreViewScroll`
    //     按那份自己的槽还原 ⇒ 退化态照样绿（自测台抓到：收口在稳态下恒等、咬不动）。
    // 分屏 ⇒ 预览在左格显示、源码在右格**同样显示** ⇒ `applySyncToSibling` 拿到 `shownView`
    //（在屏、量得出行顶）⇒ 落点 = `sourceTopOfV(v)`，v 就是 `PreviewPane.topVisibleLine()`。
    tabEl(0).click(); // 回到源码标签（分屏的源是 `syncSourceV(tab)` 读这份自己的槽）
    await wait(400);
    splitTab("h");
    await wait(600);
    // ⚠️ 两格都是刚建的实例：留白在实例创建那刻算不出来（clientHeight = 0 ⇒ 有闸门，不会写
    //    坏但也补不回来），真机这一拍由 ResizeObserver 补 —— 桩里就是上面那个可手动触发的
    //    替身。不补 ⇒ 这格可滚上限少一整屏 ⇒ 322 压根写不进去（正常态就红/假绿）。
    // ⚠️ 逐个 try：RO 回调里混着源码侧和预览侧两套 `applyBottomBleed`，一个抛错会把整轮
    //    forEach 断在中间、后面那格永远补不上。补两轮：头一轮 CM6 的 `contentHeight` 往往
    //    还没量出来 ⇒ 闸门同样会跳过（真机 ResizeObserver 下一帧再补一次）。
    const flushRO = async (): Promise<void> => {
      for (let round = 0; round < 2; round++) {
        roCallbacks.forEach((f) => {
          try {
            f();
          } catch {
            /* 抛的是别的实例（已销毁 / 量不到），吞掉继续 */
          }
        });
        await wait(150);
      }
    };
    expect(panels().length, "前提：造出了两格分屏").toBe(2);

    // 右格切模式成预览（操作区只渲染活动面板那一份 ⇒ 先激活右格、再点它自己的那颗键）
    const rightTabs = Array.from(
      panels()[1].querySelectorAll(".panel-tabstrip .tab"),
    ) as HTMLElement[];
    if (rightTabs.length === 0) throw new Error("右格没有标签");
    rightTabs[0].click();
    await wait(400);
    const rightMode = panels()[1].querySelector<HTMLElement>('.panel-ops [aria-label^="切换到"]');
    if (!rightMode) throw new Error("右格没有模式切换键");
    rightMode.click();
    await wait(500);
    expect(hostOf(1).classList.contains("mode-preview"), "前提：右格预览在屏").toBe(true);
    expect(hostOf(0).classList.contains("mode-source"), "前提：左格源码在屏").toBe(true);
    // ⚠️ 补 RO 必须排在**切模式之后**：那一刻 CM6 才量得出 `contentHeight`，早一步闸门
    //   （`contentHeight <= 0 ⇒ 一个字节都不写`）会把整轮补写成空 ⇒ 那格上限少一屏。
    await flushRO();

    // ⚠️ 按 `mode-*` **找格**，不按 DOM 序：分屏之后 `mode-preview` 那格可能排在前面，
    //    拿「全局第 0 个 `.cm-scroller`」当源码格会拿到被藏的那一格（clientHeight = 0）。
    const hostSrc = hostPanels().find((h) => h.classList.contains("mode-source"));
    const hostPrev = hostPanels().find((h) => h.classList.contains("mode-preview"));
    if (!hostSrc || !hostPrev) throw new Error("分屏后既没有源码格也没有预览格");
    const cmSrc = hostSrc.querySelector(".cm-scroller") as HTMLElement | null;
    if (!cmSrc) throw new Error("源码格没有编辑器");
    const pvRight = hostPrev.querySelector(".md-preview") as HTMLElement | null;
    if (!pvRight) throw new Error("预览格没有预览");
    // ⚠️ 两格都是分屏刚建的实例 ⇒ 桩里补不出它们的留白（见 `installClamp` 的注释），
    //    `naturalMax` 会算少一屏 ⇒ 上限直接给「真机事实」：源码格 = 末行贴顶、预览格 =
    //    末块贴顶。留白本身不归这一条管（① ⑥ ⑦ 各钉一处）。
    installClamp(cmSrc, () => SRC_FLOOR, { disableNaturalMax: true });
    installClamp(pvRight, () => PREV_FLOOR, { disableNaturalMax: true });
    // 桩的 `clientHeight` 是 installClamp 装上去的 ⇒ 这条前提只能排在它后面。
    expect(hostSrc.classList.contains("mode-source"), "前提：源码格在屏").toBe(true);
    expect(hostPrev.classList.contains("mode-preview"), "前提：预览格在屏").toBe(true);
    expect(cmSrc.clientHeight, "前提：源码格视口高 60").toBe(VIEW_H);
    expect(pvRight.clientHeight, "前提：预览格视口高 60").toBe(VIEW_H);

    // ⚠️ 退化取证的关键：先把左格拉回中段（分屏 copy 会把「底」带过去）—— 否则「接班那格
    //    自己记的」与源一样靠后，`handoverV` 那一路拿旧值顶住 ⇒ 退化被旧值盖掉、咬不动。
    userScroll(cmSrc, 287); // 左格源码 ≈ 第 21 行
    await wait(400);
    expect(cmSrc.scrollTop, "前提：左格源码停在中段（不是底）").toBeCloseTo(287, 6);

    // 右格预览滚到底（预览是源 ⇒ 交回 `topVisibleLine()`）
    userScroll(pvRight, 99999);
    await wait(500);
    expect(pvRight.scrollTop, "前提：右格预览滚到自己那一侧的底").toBeCloseTo(PREV_FLOOR, 6);

    // ⚠️ 这条是**真咬产品 `PreviewPane.topVisibleLine()`** 的判据：末块若只交「块起始行」
    //    （退化 ⇒ v = 23）⇒ `sourceTopOfV` 算出 308（末块顶、下面还剩一整行没滚完）；
    //    补满到文档末行（v = 24）⇒ 正好 322 = 末行贴顶。差一整行 ⇒ 用户看到的就是
    //    「分屏里滚到底的那个，另一格总是差一点到底」。
    expect(cmSrc.scrollTop, "预览滚到底（源）⇒ 在屏的源码兄弟必须落在末行贴顶").toBeCloseTo(
      SRC_FLOOR,
      6,
    );
  });

  it("⑨ ResizeObserver 回调里「值没变」就一个字节都不写（否则浏览器抛 ResizeObserver loop）", async () => {
    // ⚠️ 用户实拍：`boot error: ResizeObserver loop completed with undelivered notifications`。
    //    机理：回调里动样式 ⇒ 浏览器在同一帧里又收一轮通知，攒够就抛；而 `index.html` 的
    //    全局 `error` 监听把它当成启动失败渲染成红条。**收敛保证**就是这一条 ——
    //    算出来跟上次一样 ⇒ 不写 ⇒ 这一帧没有真变化 ⇒ 循环到此为止。
    const cm = src();
    const md = pv();
    const cmWrites: string[] = [];
    const mdWrites: string[] = [];
    const spy = (el: HTMLElement, sink: string[], name: string): void => {
      const style = el.style as unknown as { setProperty: (k: string, v: string) => void };
      const orig = style.setProperty.bind(el.style);
      style.setProperty = (k: string, v: string): void => {
        if (k === name) sink.push(v);
        orig(k, v);
      };
    };
    spy(cm, cmWrites, "--cm-bleed-bottom");
    spy(md, mdWrites, "--md-bleed-bottom");
    // ⚠️ 逐个 try：RO 回调里混着源码侧与预览侧两套 `applyBottomBleed`，一个抛错会断整轮。
    const flush = async (rounds: number): Promise<void> => {
      for (let i = 0; i < rounds; i++) {
        roCallbacks.forEach((f) => {
          try {
            f();
          } catch {
            /* 抛的是别的实例（已销毁 / 量不到），吞掉继续 */
          }
        });
        await wait(150);
      }
    };
    // 先补三轮：分屏后那两格的 `contentHeight` 是逐步量出来的 ⇒ 头几轮值**会**变、会写。
    // 这几轮不算数，只是把状态推到稳态。
    await flush(3);
    cmWrites.length = 0;
    mdWrites.length = 0;
    // 容器高与文档都没动 ⇒ 算出来的值必然与上次相同 ⇒ 一次都不许写。
    // 退化（摘掉「值没变就 return」）⇒ 每轮都写 ⇒ 这里变成 2 ⇒ 红。
    await flush(2);
    expect(cmWrites.length, "源码：值没变 ⇒ 不许再写样式（每写一次浏览器就多收一轮通知）").toBe(0);
    expect(mdWrites.length, "预览：同上").toBe(0);
  });

  it("⑩ 两处 ResizeObserver 必须观察 border-box（我们写的 padding 不能改到「被观察量」）", async () => {
    // ⚠️ `ResizeObserver` 默认看 content-box，而我们写的正是 padding / 内盒 ⇒ 那一笔把
    //    被观察量改小 ⇒ 回调再来一轮 ⇒ **自反馈成环**。border-box 不受 padding 影响。
    const edSrc = readFileSync("src/editor/editor.ts", "utf-8");
    const pvSrc = readFileSync("src/markdown/preview.ts", "utf-8");
    expect(
      edSrc,
      "源码侧：留白写进 .cm-content 的 padding，观察量必须是 scrollDOM 的 border-box",
    ).toMatch(/ro\.observe\(view\.scrollDOM,\s*\{\s*box:\s*"border-box"\s*\}\)/);
    expect(pvSrc, "预览侧：留白写在 root 自己的 padding-bottom 上，更要观察 border-box").toMatch(
      /ro\.observe\(this\.root,\s*\{\s*box:\s*"border-box"\s*\}\)/,
    );
  });
});

/**
 * B280 · **留白公式不许依赖异步测量的 `contentHeight`**（用户要求：从编辑器源头根治，
 * 别在每个场景补钉去凑底部位置）。
 *
 * 旧式 `末行top + clientH − contentHeight` 与预览侧 `clientH − 末块高` 代数等价，但绕道
 * `contentHeight` ⇒ 新建视图 / `setState` 那一帧它是 **0** ⇒ 闸门拦下 ⇒ 留白写 0 ⇒
 * 可滚范围少一屏 ⇒ 于是切标签 / 切模式 / 分屏 / 同步落点都得靠补钉去救（B256/B270/B278）。
 */
describe("B280 静态契约：留白 = 视口高 − 末行高（与预览侧同一个公式）", () => {
  const edSrc = readFileSync("src/editor/editor.ts", "utf-8");

  it("源码侧改用直接公式：末行高 = 末视觉块底 − 首视觉块顶（软折行整行高），量不出退 defaultLineHeight", () => {
    // ⚠️ 软折行：一个逻辑行被 CM6 拆成多个视觉块，`lineBlockAt(末行.from)` 只给首视觉块高
    //    （单行高）。必须按「末视觉块底 − 首视觉块顶」取整行高，否则末行折行时留白偏小、
    //    末行贴不了顶、兄弟格跟不到底（用户报：源码末行折行后滚不到顶）。
    expect(edSrc, "末行整高 = 末视觉块底 − 首视觉块顶（与预览侧 lastLineHeightOf 同口径）").toMatch(
      /const fullH = lastBlock\.top \+ lastBlock\.height - firstBlock\.top;/,
    );
    expect(
      edSrc,
      "末行高量不出（heightMap 还在估算）⇒ 退回 CM6 默认行高（同步可得、恒 > 0，永不退回 0）",
    ).toMatch(
      /if \(!\(firstBlock\.height > 0\)\) return Math\.max\(0, clientH - view\.defaultLineHeight\);/,
    );
    expect(edSrc, "留白 = 视口高 − 末行高（与预览侧 clientH − 末块高 同一个式子）").toMatch(
      /return Math\.max\(0, clientH - lastH\);/,
    );
  });

  it("闸门只留「容器高量不出」这一道，不许再叠 contentHeight（否则新公式的优势被吃掉）", () => {
    expect(edSrc, "旧的 contentHeight 闸门必须已删除").not.toMatch(/\|\| view\.contentHeight <= 0/);
    expect(edSrc, "只按容器高判（离屏 display:none ⇒ 一个字节都不写，保留旧值）").toMatch(
      /if \(view\.scrollDOM\.clientHeight <= 0\) return;/,
    );
  });

  it("反向验证：退回 contentHeight 那套，上面两条必须全部落空", () => {
    const CURRENT = "return Math.max(0, clientH - lastH);";
    expect(edSrc, "退化串要先自证原句还在").toContain(CURRENT);
    const degraded = edSrc.replace(
      CURRENT,
      "return Math.max(0, block.top + clientH - view.contentHeight);",
    );
    expect(degraded, "退化实现应真的换了写法").not.toBe(edSrc);
    expect(degraded, "退化后又依赖 contentHeight（第二条此时必须落空）").toMatch(
      /\|\| view\.contentHeight <= 0|view\.contentHeight/,
    );
  });

  it("反向验证：退回「只取首视觉块高」，上面的整行高锚点必须落空", () => {
    const CURRENT = "const fullH = lastBlock.top + lastBlock.height - firstBlock.top;";
    expect(edSrc, "退化串要先自证原句还在").toContain(CURRENT);
    // 退化成「末行高 = 首视觉块高」（旧 bug：软折行末行留白偏小、贴不了顶）
    const degraded = edSrc.replace(CURRENT, "const fullH = firstBlock.height;");
    expect(degraded, "退化实现应真的换了写法").not.toBe(edSrc);
    expect(
      degraded,
      "退化成只取首视觉块高（旧 bug：折行末行留白偏小）⇒ 整行高锚点落空",
    ).not.toMatch(/const fullH = lastBlock\.top \+ lastBlock\.height - firstBlock\.top;/);
  });
});

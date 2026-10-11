// @vitest-environment jsdom
// ⚠️ 本文件的存在理由（B251 第四轮）：同步滚动的「跟随」路径（**源=源码 → 兄弟=预览**）
//    已经连续四轮靠**静态契约**兜底，而全量全绿、真机照样偏 —— 说明这套判据没齿。
//    病根在桩的**量纲**：既有跨侧桩里「预览一个块 = 一行 = 14px == 源码行高 14」，于是
//    「把源码的行内比例小数交过去、预览按块高插值」这个错落点 = `frac × (块高 − 行高)` = 0，
//    退化成旧写法也照样全绿。这里把预览块高拉成 `3 × 行高`，跨侧小数这个错才会真的偏出去。
//
// ⚠️ B257 翻案（本轮定案）：上面那格错落点**确实存在**（真机日志 + 自测台都抓到了：
//    源码停 287、切模式一来一回变 280），但**修法不是「跨侧丢小数」** ——
//    B251 立论「两个小数归一在不同高度上（行高 vs 块高）」**不成立**：预览读 `start + ratio×range`
//    把块高折回「行」、写 `into / range` 除回去，乘除抵消 ⇒ 两侧小数是**同一个量**
//    （「这一格走了多少」），不是两种东西。所以跨侧**照交完整 `v`**，落点 = 块顶 + frac × 块高。
//    丢小数 = **每跨一次侧吃一格比例**（用户说的「切换时有点偏移」就是它），已由
//    `tests/sync-stability.test.ts` 逐轮往返盯死。
//
// 复现路径（用户报）：左分屏源码滚到底 → 切左分屏预览 → 切回左分屏源码，
//   第二次切换时**另一个预览标签**的滚动位置出现偏移，且之后切标签不再变。
//   这里取其中最具体的一格：源是源码、兄弟是预览，跟随把坐标推过去，预览该落在哪。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

/** 源码行高（px）：`.cm-line` 顶边 = 下标 × 这一行。 */
const ROW = 14;
/** ⚠️ 预览块高（px）：**刻意不等于** `ROW`。同量纲会把跨侧小数错抹平 ⇒ 桩没齿（见头注）。 */
const BLOCK = ROW * 3;

/** 一个预览块的「块顶」在桩里的排法：**按 DOM 序 × 块高**（真实布局里块连续排开）。 */
function blockTopOf(el: Element): number {
  const idx = Array.prototype.indexOf.call(el.parentElement?.children ?? [], el);
  return Math.max(0, idx) * BLOCK;
}

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;

  // 造布局：预览容器顶边 = 它自己的 scrollTop（内容区随滚动上移）；块按 DOM 序 × 块高排；
  // 编辑器行按 DOM 序 × 行高排（CM6 的 heightMap 靠它量高度）。
  const proto = window.Element.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
  };
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    const el = this as HTMLElement;
    const isRoot = el.classList.contains("md-preview");
    const isLine = el.classList.contains("cm-line");
    const top = isRoot
      ? el.scrollTop
      : isLine
        ? Math.max(0, Array.prototype.indexOf.call(el.parentElement?.children ?? [], el)) * ROW
        : blockTopOf(el);
    const height = isRoot || isLine ? ROW : 0;
    // toJSON 是函数，Record<string, number> 装不下 —— 反正下面 as unknown as DOMRect 已逃生
    const r: Record<string, unknown> = {
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

// 每个 md 块只占**一行**（纯标题）⇒ 块的 `lineStart` 与 DOM 序一一对应，块顶可推算。
// （混排段落时一个块跨多行，小数行号会被块内比例吃掉，这条用例就判不出东西了。）
const MD = Array.from({ length: 40 }, (_, i) => `# 标题 ${i + 1}`).join("\n");

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
      // ⚠️⚠️ 两分屏（与用户复现路径同型）：左分屏开着**源码**，右分屏开着**预览**（同文档）。
      //    预览那一格必须是**在屏**的 —— B240 三轮定了「离屏的预览兄弟不写任何位置」
      //    （写了就是拿编辑器像素污染预览槽），所以单面板桩里预览是离屏的 ⇒ 跟随根本不写，
      //    量不到任何东西。右分屏那份预览一直显示在自己的面板上，跟随才推得动它。
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
function previewRoot(): HTMLElement {
  // ⚠️ 每个面板都挂着一份预览宿主（源码 tab 那半分是隐藏的占位），DOM 序里排在前面 ——
  //    代码只写「正在显示的那一格」⇒ 这里必须按 panelId 精确挑右分屏那一份（在屏）。
  const all = Array.from(document.querySelectorAll<HTMLElement>(".layout-panel .md-preview"));
  // ⚠️ 每个面板都挂着一份预览宿主（源码 tab 那半分是空的占位），代码只写**渲染过**那份。
  //    面板 id 是恢复时新分配的（`ensurePanel` 自增），未必等于会话里的下标 ⇒ 不按
  //    `data-panel-id` 猜，直接认「渲染出块的那一份」。
  const withBlocks = all.filter((e) => e.querySelectorAll("[data-line-start]").length > 0);
  if (withBlocks.length === 0) {
    throw new Error(
      `预览宿主共 ${all.length} 份，一份都没渲染出块（清单：${all
        .map(
          (e) => `${e.closest<HTMLElement>(".layout-panel")?.dataset.panelId}:${e.children.length}`,
        )
        .join(",")}）`,
    );
  }
  return withBlocks[0];
}
function scroller(): HTMLElement {
  const el = document.querySelectorAll(".layout-panel .cm-scroller")[0] as HTMLElement | undefined;
  if (!el) throw new Error("编辑器没挂载");
  return el;
}
function userScroll(el: HTMLElement, px: number): void {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: px }));
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}

describe("B257：跟随路径（源=源码 → 兄弟=预览）跨侧照交完整 `v`，落点带住行内比例", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(400);
  });

  it("源是源码时推给预览兄弟的落点，必须带住源码那份行内比例（块顶 + frac × 块高）", async () => {
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click();
    await wait(80);

    // 前提：左分屏起始就显示着源码（loadSession 里 active: 0），它滚一下就是「源」。
    // ⚠️ 滚到**行中间**（不是正好压行顶）：这样源的顶行带一个非 0 的行内比例小数，
    //    跨侧若把这个小数交过去，预览侧 `applySyncToLine` 会按**块高**插值
    //    （`top += (块高) × into / range`）⇒ 落点偏出 `frac × 块高` 这么一大段。
    const px = ROW * 3 + 7; // frac = 7/14 ≈ 0.5，既非 0 也非 1
    userScroll(scroller(), px);
    await wait(220);

    // 前提：源码确实停在**行中间**（否则小数是 0，这条用例成了摆设）。
    const srcFrac = (scroller().scrollTop - Math.floor(scroller().scrollTop / ROW) * ROW) / ROW;
    expect(srcFrac, "前提：源码顶边落在行内部（行内比例非 0）").toBeGreaterThan(0);

    const root = previewRoot();
    expect(
      root.querySelectorAll("[data-line-start]").length,
      "前提：右分屏预览已经渲染出块（没渲染 ⇒ 这条用例量的是空壳，不是同步）",
    ).toBeGreaterThan(0);
    const top = root.scrollTop;
    expect(top, "前提：预览确实被推过位置了（不是压根没跟随）").toBeGreaterThan(0);
    // ⚠️ B257 翻案（B251 的「跨侧交整数块首」**错了**）：源码那份 `v` 的小数是**同一把尺**
    //    （预览侧读 `start + ratio × range`、写 `/ range` 除回去，乘除抵消 ⇒ 小数是同一个量），
    //    所以跨侧**照交完整 `v`**，预览落点 = 块顶 + `frac × 块高`，**不是**压块顶。
    // ⚠️ 这条就是本回合的牙：退回「跨侧丢小数 / 交整数块首」⇒ 落点 `top % BLOCK === 0` ⇒ 红。
    const frac = (top % BLOCK) / BLOCK;
    expect(
      frac,
      `跨侧落点必须带住源码那份行内比例（源码 ${srcFrac}，块高 ${BLOCK}px ⇒ 块内偏移 ${(
        srcFrac * BLOCK
      ).toFixed(1)}px），实际落点 ${top}px（块内比例 ${frac}）`,
    ).toBeCloseTo(srcFrac, 2);
  });
});

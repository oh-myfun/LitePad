// @vitest-environment jsdom
// ⚠️ 本文件的存在理由（B256）：真机日志（B255 取证包）把根因钉死在 `switchTab` **尾那趟
//    补推**上（用户路径：左分屏 源码 + 预览，右分屏 预览，滚左源码到底 → 切左预览 → 切回左源码）：
//      · 21:16:09.121 切**到**左预览：收口 `applySyncToSibling` 只落了 `other=2`（左预览，
//        shown=true）—— 右预览（other=3）**一个字节都没被碰**，停在 1421。
//      · 21:16:10.493 切**回**左源码：`restoreViewScroll` 往编辑器写 1222.67，浏览器按
//        「此刻还没被 measure 撑开的内容高度」**裁成 858.67**（下一帧 10.514 的「锚点补偿」
//        才把它钉回 1222.67）。
//      · 21:16:10.508 紧接着的补推 `syncSourceV` 读的是**实时 DOM** ⇒ 拿到裁小后的 858.67，
//        算出 v=41（同几何下真值 59）⇒ 把右预览从 1421 钉到 **1043**（用户报的「向上偏移」），
//        并且 21:16:13.320 第二轮切回源码**一模一样** ⇒ 「之后怎么切都停在这个值」。
//    所以这条用例盯的就是**用户看得见的那一格**：源没动、切个标签，**别的预览不许自己跳**。
//
//    ⚠️ 桩的盲区必须自己补：jsdom 的 `scrollTop` setter **只存值、不裁剪**（不按
//    `scrollHeight − clientHeight` 夹、也不模拟 `display:none` 清零），于是真机上「写入被
//    裁小」这整个窗口在桩里根本不存在 —— 不补这一块，这条用例会**怎么退化都绿**。
//    这里给编辑器容器装上「浏览器式裁剪」，并把可滚上限做成**测试可改的**，
//    好精确造出「还原写入那一刻内容还没撑开」那一帧。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

/** 源码行高（px）：`.cm-line` 顶边 = 下标 × 这一行。 */
const ROW = 14;
/** ⚠️ 预览块高（px）：**刻意不等于** `ROW` —— 见 `sync-push-cross.test.ts` 头注：
 *    同量纲会把跨侧换算的错抹平 ⇒ 桩没齿。 */
const BLOCK = ROW * 3;
/** 源码滚动位置（px）：刻意压在**行中间**（+7），好让游标带一个非 0 行内比例小数。 */
const SRC_PX = ROW * 20 + 7; // ⇒ 行内比例 0.5
/**
 * ⚠️ 「还原写入那一刻」的可滚上限（px）。
 *
 * 真机上刚 `setState` 换文档，CM6 用的还是**估算行高**建的 heightMap，可滚余量比最终短；
 * 浏览器于是把还原写进去的值裁小。下一帧 measure 跑完，余量长回来、下一趟 pin 就钉到位
 * （真机日志里的「锚点补偿挪走了位置 实际 858.67 → 钉回 1222.67」正是这一帧）。
 *
 * 这里取 `10 × ROW`，把「真实位置 287」裁成「140」⇒ 跨侧跟着交 v=11（真值 21）。
 */
const CLAMP_PX = ROW * 10;

/** 源码：每 3 行一段 + 段间空行 ⇒ 预览块与源码行**非 1:1**（跨侧才判得出对错）。 */
const MD = Array.from({ length: 24 }, (_, j) => `para${j}a\npara${j}b\npara${j}c\n\n`).join("");

/** 编辑器此刻「可滚动上限」（px）：`Infinity` = 内容已撑开；测试可临时改小造裁剪窗口。 */
let editorMaxScroll = Infinity;

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;

  // 确定性布局：预览容器顶边 = 它自己的 scrollTop；`.cm-line` 顶边 = DOM 序 × 行高
  // （CM6 的 heightMap 照它量）；块顶 = DOM 序 × 块高。
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

vi.mock("../src/ipc/api", () => ({
  emitCrossWindow: vi.fn(async () => {}),
  convertFileSrc: (p: string) => `asset://${p}`,
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve([{ label: "UTF-8", group: "Unicode（统一码）" }]),
  listEols: () => Promise.resolve(["CRLF", "LF"]),
  // ⚠️ 同文档三份实例（与用户路径**逐格同型**）：
  //    panel0 = 源码 tab + 预览 tab（左分屏），panel1 = 预览 tab（右分屏）。
  //    右分屏那份预览必须**在屏**（B240 三轮：离屏的预览兄弟不写任何位置 ⇒ 量不到东西）。
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
 * 给编辑器容器装上「浏览器式裁剪」（B256 的桩补盲区）。
 *
 * ⚠️ 只在**实例上**覆盖：jsdom 的 `Element.prototype.scrollTop` 是个只存值的访问器，
 * 覆盖不到「按可滚余量裁剪」这一点 —— 不补，真机上那个「还原写入被裁小」的窗口在桩里
 * 压根不存在，这条用例就退化成恒绿。
 */
function installClamp(): void {
  const el = scroller();
  let st = el.scrollTop;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => st,
    set: (v: number) => {
      st = Math.min(Math.max(v, 0), editorMaxScroll);
    },
  });
}

/**
 * 「右分屏那份预览」—— 只认**一份**，开局认一次，全程复用这份引用。
 *
 * ⚠️ 不能每步重选：切到左预览之后两个面板都渲染出块了，重选会挑到左预览去（而左预览
 *    离屏、压根不写位置 ⇒ 这一步的判据会假绿）。
 */
function previewRoot(): HTMLElement {
  const all = Array.from(document.querySelectorAll<HTMLElement>(".layout-panel .md-preview"));
  const withBlocks = all.filter((e) => e.querySelectorAll("[data-line-start]").length > 0);
  if (withBlocks.length === 0) {
    throw new Error(
      `预览宿主共 ${all.length} 份，一份都没渲染出块（清单：${all
        .map(
          (e) =>
            `panel=${e.closest(".layout-panel")?.dataset.panelId}:${
              e.querySelectorAll("[data-line-start]").length
            }块`,
        )
        .join(",")}）`,
    );
  }
  return withBlocks[0];
}

function clickTab(panelIdx: number, i: number): void {
  const panel = document.querySelectorAll(".layout-panel")[panelIdx] as HTMLElement;
  const els = Array.from(panel.querySelectorAll(".panel-tabstrip .tab")) as HTMLElement[];
  if (els.length <= i) throw new Error(`面板 ${panelIdx} 只有 ${els.length} 个标签`);
  const el = els[i];
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.click();
}

function userScroll(el: HTMLElement, px: number): void {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: px }));
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}

describe("B256：切回源码时，别的预览不许被「还原没立住的那帧」带走", () => {
  /** 右分屏那份预览的**引用**（`scrollTop` 走我们装的裁剪 setter）。 */
  let right: HTMLElement;

  beforeAll(async () => {
    await import("../src/main");
    await wait(500);
  });

  it("源位置没变 ⇒ 切标签这一下不能动右分屏预览", async () => {
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click();
    await wait(160);
    installClamp();
    right = previewRoot();

    // ① 滚左分屏源码（源=源码，右分屏预览在屏 ⇒ 跟随推过去 ⇒ 右预览落到「正确」那格）
    userScroll(scroller(), SRC_PX);
    await wait(280);
    const before = right.scrollTop;
    expect(before, "前提：右分屏预览已被正常跟随推过位置（不是压根没跟随）").toBeGreaterThan(0);
    // ⚠️ B257（旧判据是 `toBe(0)`：跟随落点**压块顶**，那正是 B251 的「跨侧丢小数」口径）。
    //    现在跨侧照交完整 `v` ⇒ 落点 = 块顶 + 「行内比例 ÷ 该块跨几行」× 块高，**不压块顶**。
    //    ⇒ 这里的牙翻个方向：退回「跨侧丢小数 ⇒ 只交整数块首」⇒ 余数恒 0 ⇒ 这条红。
    //    ⚠️ 绝对值（落点到底算不算「对齐源」）由 `sync-stability` 的前提 + `sync-push-cross`
    //       盯（本用例是相对比较：②/③ 只比切标签前后同不一样，落点本身对不对它判不了）。
    expect(
      before % BLOCK,
      `前提：跟随落点带住块内比例（块高 ${BLOCK}px），实际 ${before}（余数 ${before % BLOCK}）`,
    ).not.toBe(0);

    // ② 切到左分屏的预览标签：收口只落左预览，右预览照旧（真机 09.121 那条）
    clickTab(0, 1);
    await wait(340);
    expect(right.scrollTop, "切到左预览不该动右预览").toBe(before);

    // ③ 造「还原写入被裁小」那一帧，然后切回左分屏源码标签
    editorMaxScroll = CLAMP_PX;
    clickTab(0, 0);
    // 同步收尾：还原写完、补推已经跑完（真机 10.493 / 10.508 之间那一瞬）
    expect(
      scroller().scrollTop,
      `前提：还原刚写完被浏览器裁成 ${CLAMP_PX}（DOM 还没接过它）⇒ 补推此刻读到的就是这个值`,
    ).toBe(CLAMP_PX);

    // ⚠️ 这一条就是这一轮要修的牙：源没动、切个标签，右分屏预览不许自己往上跳。
    expect(
      right.scrollTop,
      `切回源码后右分屏预览不许动（它本来就对齐着源）：切前 ${before} → 切后 ${right.scrollTop}`,
    ).toBe(before);

    // ④ 内容撑开之后，源自己那份位置要钉回来（证明上面那格不是「啥都没干」）
    editorMaxScroll = Infinity;
    await wait(340);
    expect(scroller().scrollTop, "下一帧源必须回到自己那份位置（浏览器长回来、补钉跟上）").toBe(
      SRC_PX,
    );
    expect(right.scrollTop, "源立住之后右预览仍然该停在同一格").toBe(before);
  });
});

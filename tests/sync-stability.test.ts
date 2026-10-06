// @vitest-environment jsdom
// B257：**自测台** —— 同步滚动 / 切模式 / 切标签三路**往返一致性**（用户报：同步滚动时
// 切换标签还是会有些偏移的小问题）。前几轮（B240~B256）每一轮都是「用户真机复现 → 取日志
// → 定案」，本轮起改成**自己复现**：jsdom 桩把真机那几条模型（写入当帧被浏览器裁小、
// 下一帧才追平）做成**常态**，然后连跑多轮往返，看落点逐轮变不变。
//
// 与 `sync-switch-land.test.ts`（B256）的分工：那份只盯**一次**「切回源码时右预览不许跳」
// 那一格；这份盯**多轮往返** —— 「第一轮对、第二轮就开始漂」这类残差只有跑圈才抓得到。
//
// 桩补的两处盲区（不补这两块，下面的断言**怎么退化都绿**）：
//   · `Element.prototype.scrollTop` 只存值、不按可滚余量裁剪、也不模拟 display:none 清零
//     ⇒ 「写入当帧被裁小」这个窗口在桩里根本不存在；这里给**编辑器 + 预览**两类容器
//       都装上浏览器式裁剪，且可滚上限由测试随时改。
//   · 预览块高 **≠** 源码行高（42 vs 14）⇒ 跨侧（块 ⇄ 行）的换算错才量得出来
//     （同 `sync-push-cross.test.ts` 那条老规矩：同量纲会把错抹平）。
//
// 日志：本文件把 `logger` 的 debug/trace/info/warn 钩进 `LOGS`，断言失败时把同步链路的
// 轨迹一起打出来 —— 「抓日志分析」这一步留在测试里，以后再报就不会重演「改一行再出包」
// 的老路（B255 那次就是为此才临时把发布版日志级别调到 trace，出完还得回退）。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

/** 源码行高（px）：`.cm-line` 顶边 = 下标 × 这一行。 */
const ROW = 14;
/** ⚠️ 预览块高（px）：**刻意 3 倍于行高** —— 见上面头注。 */
const BLOCK = ROW * 3;
/** 源码滚动位置（px）：压在**行中间**（+7）⇒ 游标带 0.5 的行内比例。 */
const SRC_PX = ROW * 20 + 7; // 280 ⇒ 第 21 行顶；+7 ⇒ 行内走到一半
/**
 * 源码停在 `SRC_PX` 时，右分屏预览该落的**绝对**位置（块 20 顶 840 + 半个块高 21 = 861）。
 * ⚠️ 下面几条往返用例的基线**不能**取「跟随后实际读到的那个值」—— 跨侧一旦丢小数，
 *    基线本身就带着错值（840），再拿它当 `toEqual` 的目标 ⇒ 四条往返全部「恒等于错值」而绿
 *    （退化取证就是这么红的：前提红、往返绿）。这里换成**写死的期望**，退化 ⇒ 往返一起红。
 */
const LANDED = BLOCK * 20 + BLOCK / 2;
/** 「还原刚写完、内容还没撑开」那一帧的可滚上限（px）：把 287 裁成 140。 */
const CLAMP_PX = ROW * 10;
/** 视口高（px）：3 行 ⇒ 源码自然上限 = 24×14 − 42 = **294**（≥ SRC_PX 287，留 7px 富余）。 */
const VIEW_H = ROW * 3;
/**
 * ⚠️ 预览的自然上限 = 24 × BLOCK − VIEW_H = 966（≥ LANDED 861，富余 105px）。
 *
 * ⚠️⚠️ **B258 取证需要的那一层**：真机上「滚到底」不是「滚到某个固定值」，而是
 * `scrollTop` 被浏览器按 **内容高 − 视口高** 裁住 —— 源码 24 行×14 = 336，预览 24 块×42 =
 * 1008，**两侧上限差 3 倍**。于是「预览滚到底」时源码那一格**到底不了**（钉过去的值超上限
 * 被裁），再切回预览，接班那一份按 `v` 落、兄弟那一份停在上一趟推播被裁后的值 ⇒ 两格错位。
 * 旧的桩只装了**测试可改的** `editorMax` / `previewMax`（都是 `Infinity`）⇒ 永远不裁 ⇒
 * 这条路径在桩里**必然全绿**，连根因都照不到。这里再叠一层**自然上限**（更硬，取 min）。
 */
const PREVIEW_MAX_PX = 24 * BLOCK - VIEW_H;

/**
 * md 正文：**一行一个标题** ⇒ 预览块 k 与源码行 k+1 一一对应，块顶 = k×BLOCK。
 *
 * ⚠️ 纯标题（一个块一行）是刻意的：块内比例能按整块算，`topVisibleLine()` 的小数才有
 *    确切含义；换成混排段落，小数会被块内多行吃掉，「取整口径」这件事就判不出来了。
 */
const MD = Array.from({ length: 24 }, (_, i) => `# 标题 ${i + 1}`).join("\n");

/** 编辑器 / 预览此刻的「可滚动上限」（px）：`Infinity` = 内容已撑开，测试可临时改小。 */
let editorMax = Infinity;
/** 预览那一路全程不裁（本测台只裁编辑器，造的是 B256 那一帧；预览另由 `sync-switch-land` 裁）。 */
const previewMax = Infinity;

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;

  // 确定性布局：预览容器顶边 = 它自己的 scrollTop；`.cm-line` 顶边 = DOM 序 × 行高
  // （CM6 的 heightMap 照它量）；其它（预览块）顶边 = DOM 序 × 块高。
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
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve([{ label: "UTF-8", group: "Unicode（统一码）" }]),
  listEols: () => Promise.resolve(["CRLF", "LF"]),
  // ⚠️ 同文档三份实例（与用户路径**逐格同型**）：
  //    panel0 = 源码 tab + 预览 tab（左分屏），panel1 = 预览 tab（右分屏）。
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
  // ⚠️ logLevel 必须给真值：`syncLevel()` 开局拉一次，把它当成 undefined 会走 catch
  //    把级别复位成 info ⇒ 下面钩的 trace 一条都收不到，「抓日志」就成了空壳。
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

/** 捕获下来的同步链路轨迹（`[级别] target: detail`）。 */
const LOGS: string[] = [];

function scroller(): HTMLElement {
  const el = document.querySelectorAll(".layout-panel .cm-scroller")[0] as HTMLElement | undefined;
  if (!el) throw new Error("编辑器没挂载");
  return el;
}

/** 某个面板的预览根（`.md-preview`）。⚠️ 按**面板序号**取（0/1），不是 DOM 的 pid 值。 */
function previewOf(panelIdx: number): HTMLElement {
  const panel = document.querySelectorAll(".layout-panel")[panelIdx] as HTMLElement | undefined;
  if (!panel) throw new Error(`面板 ${panelIdx} 没挂载`);
  const el = panel.querySelector(".md-preview") as HTMLElement | null;
  if (!el) throw new Error(`面板 ${panelIdx} 的预览容器还没建（多半是这一侧仍是源码态）`);
  return el;
}

/** 已经装过裁剪的容器（预览容器是**懒建**的：那一侧还是源码态时压根没有 `.md-preview`）。 */
const clamped = new WeakSet<HTMLElement>();

/**
 * 给容器装上「浏览器式裁剪」并接到测试可控的上限上（B256 的桩补盲区，本轮扩到预览）。
 *
 * ⚠️ 只在**实例上**覆盖：jsdom 的 `Element.prototype.scrollTop` 只存值、不裁剪 ——
 *    不补，真机上「写入被裁小」那整个窗口在桩里压根不存在，断言就退化成恒绿。
 *
 * ⚠️ B258：上限取 **两层 min** —— 测试可控的 `max()`（造「内容还没撑开」那一帧）与
 *    内容高 − 视口高（真实浏览器那层，永远在）。只留前者 ⇒ 桩永远滚不到底 ⇒ 这条路径绿。
 */
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

/** 容器「内容高 − 视口高」的自然上限（每次写入按**当前** DOM 算，内容换过也跟得上）。 */
function naturalMax(el: HTMLElement): number {
  const isEditor = el.classList.contains("cm-scroller");
  const rows = isEditor
    ? el.querySelectorAll(".cm-line").length
    : el.querySelectorAll("[data-line-start]").length;
  return Math.max(0, rows * (isEditor ? ROW : BLOCK) - VIEW_H);
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

/** Ctrl+/：`view.toggle` —— 与 `tests/view-switch-noedit.test.ts` 同一触发方式。 */
function toggleMode(): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "/", ctrlKey: true, bubbles: true, cancelable: true }),
  );
}

function userScroll(el: HTMLElement, px: number): void {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: px }));
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}

/** 此刻两侧的可观测位置：编辑器 / 右分屏预览。 */
function snap(): { src: number; p1: number } {
  return { src: scroller().scrollTop, p1: previewOf(1).scrollTop };
}

function dumpLogs(n = 40): string {
  return LOGS.slice(-n).join("\n");
}

describe("B257：同步滚动 / 切模式 / 切标签三路往返，落点必须逐轮恒等（自测台）", () => {
  /** 右分屏那份预览的**引用**（开局认一次，全程复用 —— 重选会挑到左预览去）。 */
  let right: HTMLElement;

  beforeAll(async () => {
    // ⚠️ 顺序：先钩 logger，再 import main —— main 里同步链路的 debug/trace 全都得落进来。
    const mod = await import("../src/core/logger");
    mod.setLevel("trace");
    const rec =
      (lv: string) =>
      (target: string, detail?: string): void => {
        LOGS.push(`[${lv}] ${target}: ${detail ?? ""}`);
      };
    mod.logger.debug = rec("debug");
    mod.logger.trace = rec("trace");
    mod.logger.info = rec("info");
    mod.logger.warn = rec("warn");

    await import("../src/main");
    await wait(500);

    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click();
    await wait(200);

    // 两类容器都装上裁剪：编辑器（B256 那一路）+ 预览（本轮新补的镜像盲区）
    installClamp(scroller(), () => editorMax);
    for (const panel of Array.from(document.querySelectorAll<HTMLElement>(".layout-panel"))) {
      const root = panel.querySelector(".md-preview");
      if (root) installClamp(root, () => previewMax);
    }
    right = previewOf(1);
    if (right.querySelectorAll("[data-line-start]").length === 0) {
      throw new Error("右分屏预览一份块都没渲染，这条用例无从测起");
    }
  });

  it("前提：同步开着时滚源码，右分屏预览要跟到「同一行的同一格比例」", async () => {
    userScroll(scroller(), SRC_PX);
    await wait(300);
    const s = snap();
    expect(s.p1, "前提：右分屏预览确实被跟随推过位置").toBeGreaterThan(0);
    // ⚠️ 精确落点（不是「压在块顶」）：源码 287 = 行 20 顶 + 半个行高 ⇒ 预览同内容位置
    //    是块 20 顶（20×BLOCK=840）再走半个块高（BLOCK/2）⇒ 861。
    //    ⚠️ 这条预设有鉴别力：退回「跨侧丢小数」那一版 ⇒ 游标变整数块首 ⇒ 右预览落 840，
    //      下面几轮的「恒等」是踩在错前提上的空转，一眼看不出来。
    expect(s.p1, `前提：跟随落点 = 块 20 顶 + 半个块高（源码走了一行的一半），实际 ${s.p1}`).toBe(
      BLOCK * 20 + BLOCK / 2,
    );
    // ⚠️ 防假绿：这条用例必须真的走在同步链路上，否则下面几轮的「恒等」是空转。
    expect(
      LOGS.some((l) => l.includes("[debug] sync: 推 src=")),
      `前提没成立：同步链路的推播日志一条都没抓到（末 20 条：${dumpLogs(20)}）`,
    ).toBe(true);
  });

  it("切标签往返 4 轮：编辑器与右分屏预览每轮都要一模一样", async () => {
    userScroll(scroller(), SRC_PX);
    await wait(300);
    const first = snap();
    for (let k = 0; k < 4; k++) {
      clickTab(0, 1); // 源码 → 左分屏的预览标签
      await wait(300);
      clickTab(0, 0); // 预览 → 回到左分屏源码标签
      await wait(300);
      const now = snap();
      expect(
        now,
        `第 ${k + 1} 轮「切到预览再切回源码」之后位置变了（切前 ${JSON.stringify(
          first,
        )} → 现在 ${JSON.stringify(now)}）；轨迹末 30 条：\n${dumpLogs(30)}`,
      ).toEqual(first);
      // ⚠️ 硬基线：跟随后预览就是 861，切一轮不许挪一个像素（写死 LANDED，不取实际值）。
      expect(now.p1, `第 ${k + 1} 轮之后右预览掉出了绝对落点 ${LANDED}（实际 ${now.p1}）`).toBe(
        LANDED,
      );
    }
  });

  it("切模式往返 4 轮（Ctrl+/ 一来一回）：编辑器与右分屏预览每轮都要一模一样", async () => {
    userScroll(scroller(), SRC_PX);
    await wait(300);
    const first = snap();
    for (let k = 0; k < 4; k++) {
      toggleMode(); // 源码 → 预览
      await wait(300);
      toggleMode(); // 预览 → 源码
      await wait(300);
      const now = snap();
      expect(
        now,
        `第 ${k + 1} 轮「切模式一来一回」之后位置变了（切前 ${JSON.stringify(
          first,
        )} → 现在 ${JSON.stringify(now)}）；轨迹末 30 条：\n${dumpLogs(30)}`,
      ).toEqual(first);
      // ⚠️ 硬基线（同 ②：丢小数时 `first` 本身就带错值，得写死 LANDED）。
      expect(
        now.p1,
        `第 ${k + 1} 轮切模式之后右预览掉出了绝对落点 ${LANDED}（实际 ${now.p1}）`,
      ).toBe(LANDED);
    }
  });

  it("混合：滚 → 切模式 → 切标签 → 切回来，位置不许挪（再来两轮）", async () => {
    for (let k = 0; k < 3; k++) {
      const px = SRC_PX + k * 3; // +3k 仍在行 20 内（7+6=13 < 14）⇒ 行内比例 (7+3k)/14
      userScroll(scroller(), px);
      await wait(300);
      const before = snap();
      // ⚠️ 硬基线：本轮跟随后预览就该落在「块 20 顶 + 行内比例 × 块高」。
      //    不取「读到的值」当基线 —— 跨侧丢小数时那本身就是错的值，往返会「恒等于错值」而绿。
      const want = BLOCK * 20 + ((px % ROW) / ROW) * BLOCK;
      expect(
        before.p1,
        `第 ${k + 1} 轮（源码 ${px}）跟随后右预览就该落在 ${want}，实际 ${before.p1}`,
      ).toBeCloseTo(want, 6);
      toggleMode(); // 源码 → 预览
      await wait(260);
      clickTab(0, 1); // 切到左分屏预览标签（此时这一侧已是预览）
      await wait(260);
      clickTab(0, 0); // 切回左分屏源码标签
      await wait(300);
      toggleMode(); // 预览 → 源码（收口成源码态，回到上面那一趟的入口）
      await wait(300);
      const now = snap();
      expect(
        now,
        `第 ${k + 1} 轮混合路径之后位置变了（滚完那一刻 ${JSON.stringify(
          before,
        )} → 现在 ${JSON.stringify(now)}）；轨迹末 30 条：\n${dumpLogs(30)}`,
      ).toEqual(before);
    }
  });

  it("B258 取证：预览滚**到底** → 切源码 → 切回预览 ⇒ 兄弟预览（右分屏）要跟着对齐", async () => {
    // 用户原话：「如果是预览模式标签滚动到底，切换到源码模式标签，…再次切换回同分屏的
    // 预览模式标签可以看到该标签内的 top 位置同步到了源码 top 行对应的位置，但是**其他
    // 分屏的预览模式标签 top 位置没有同步**」。
    //
    // 机理（桩补上「自然上限裁切」后就能量到）：预览到底 = 966（内容 1008 − 视口 42），
    // 「块内比例」按 3 行/块折成行号 ⇒ 源码那侧的目标像素 336 **超过源码自然上限 294**
    // ⇒ 源码被裁到 294（「源码也滚动到底了，但 top 不对应预览 top」）。
    // 切回预览时收口只写**接班那一份**，B241 让 `switchTab` 尾那趟推播整个跳过 ⇒
    // 兄弟那一份停在上一趟被裁过的值 ⇒ 两格错位。
    clickTab(0, 1); // 左分屏切到预览标签（源 = 预览）
    await wait(320);
    userScroll(previewOf(0), PREVIEW_MAX_PX + 99); // 故意超上限 ⇒ 真·滚到底
    await wait(320);
    const pvTop = previewOf(0).scrollTop;
    expect(pvTop, "前提：预览确实停在自己的自然上限（滚到底了）").toBe(PREVIEW_MAX_PX);

    clickTab(0, 0); // 源=预览 → 切源码（B247 守卫挡收口 ⇒ aligned=false ⇒ 这趟会推兄弟）
    await wait(340);
    clickTab(0, 1); // 切回预览：收口只写这一格 ⇒ 兄弟那趟推播被 B241 跳过
    await wait(380);
    const left = previewOf(0).scrollTop;
    const right = previewOf(1).scrollTop;
    // ⚠️ 这条就是这一轮要钉的牙：右预览（兄弟）必须与左预览（接班那一份）完全同位。
    expect(
      right,
      `切回预览后兄弟预览没跟上（左 ${left} / 右 ${right}；滚前 ${pvTop}）` +
        `\n轨迹末 30 条：\n${dumpLogs(30)}`,
    ).toBe(left);
    // ⚠️ 取证用完复位：后面那条 B256 用例的前提是「左分屏停在源码 tab」，
    //    本条把它停在预览 tab ⇒ 不复位会串味（B256 那条会红在「下一帧源必须回到自己那份」）。
    clickTab(0, 0);
    await wait(320);
  });

  it("还原那一帧被裁小的窗口里切标签，右分屏预览不许被减小（B256 回归 + 多轮）", async () => {
    userScroll(scroller(), SRC_PX);
    await wait(300);
    const before = snap();
    editorMax = CLAMP_PX; // 内容还没撑开 ⇒ 还原写进去会被裁小
    clickTab(0, 1);
    await wait(300);
    clickTab(0, 0);
    // ⚠️⚠️ **B260 换判据**：这条原先钉的是「右分屏预览不许**动**」。那是 B256 那会儿的
    //    副产物 —— 那会儿 B241 让「收口生效 ⇒ 整趟推播被跳过」，兄弟压根没被推过，永远
    //    停在上一次的旧值上 ⇒ 「不动」是「没人管它」的结果，不是「不许动」的纪律。
    //    B258 之后兄弟**必须**按交接游标与接班同位；B260 又定「交接不许减小」⇒ 兄弟
    //    从 861 跟到 966 是**跟着走**，不是被减小。判据改钉两件：① 不许跌破切前任一方
    //    （退化成「按源那个被裁小的值落位」会直接掉到 0 档，这里拦得住）；② 与接班同位。
    const floor = Math.min(before.p1, previewOf(0).scrollTop);
    const sameAsShown = previewOf(0).scrollTop;
    expect(
      right.scrollTop,
      `切完标签右分屏预览被减小了（切前 ${before.p1} → 现在 ${right.scrollTop}，底线 ${floor}）`,
    ).toBeGreaterThanOrEqual(floor);
    expect(right.scrollTop, "右分屏预览要与接班那一格同位（B258）").toBe(sameAsShown);
    editorMax = Infinity;
    await wait(340);
    expect(scroller().scrollTop, "下一帧源必须回到自己那份位置").toBe(SRC_PX);
    expect(right.scrollTop, "源立住之后右预览仍停在同一格").toBe(sameAsShown);
  });

  it("源是预览那一侧（左分屏预览在屏）：切两个预览标签往返 4 轮，两侧预览每轮都要恒等", async () => {
    // 前提：切到左分屏的预览标签 ⇒ 源是预览、接班也是预览（**同侧** ⇒ 交完整 `v`，
    // 小数 = 块内比例 —— 这一段走的是预览侧那条 `topVisibleLine()` 分支，与源码侧镜像）。
    clickTab(0, 1);
    await wait(320);
    userScroll(previewOf(0), BLOCK * 20 + 7); // 停在块 20 走了 7px（63≈半个块）
    await wait(320);
    const first = { p0: previewOf(0).scrollTop, p1: previewOf(1).scrollTop };
    expect(first.p0, "前提：左预览确实被滚到了块内（不是压在块顶）").toBeGreaterThan(0);

    for (let k = 0; k < 4; k++) {
      clickTab(0, 0); // 切到源码标签（源预览 ⇒ 收口早退，尾部补推走源码侧）
      await wait(300);
      clickTab(0, 1); // 切回预览标签（源预览 ⇒ 同侧，交完整 v）
      await wait(320);
      const now = { p0: previewOf(0).scrollTop, p1: previewOf(1).scrollTop };
      expect(
        now,
        `第 ${k + 1} 轮「切走源码标签再切回预览标签」之后预览位置变了（切前 ${JSON.stringify(
          first,
        )} → 现在 ${JSON.stringify(now)}）；轨迹末 30 条：\n${dumpLogs(30)}`,
      ).toEqual(first);
    }
  });
});

// @vitest-environment jsdom
// B241：跨侧（预览 ⇄ 源码）切换的**往返闭合性**。
// jsdom 默认没有布局（getBoundingClientRect 全 0 ⇒ blockTop 退化成恒等于 scrollTop，
// 每轮换算固定掉 8px，看起来的「越切越歪」其实是退化假象）。
// 这里给预览造一个**确定性的布局**（每个块一行 14px、块顶 = 行号 × 14），
//   于是「滚预览 → 切源码 → 切预览」的往返闭合与否才判得出来 —— 这层布局是这条
//   用例的全部价值：没有它（jsdom 默认 rect 全 0）预览换算会退化，测出来的是假象。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

// 行高（px）。预览的往返换算全靠这个数对得上。
const ROW = 14;

/**
 * 一个预览块的「块顶」在桩里的排法：**按 DOM 序 × 行高**。
 *
 * ⚠️ 真实布局里块是**连续排开**的（第 i 个块的顶边 = 前 i 个块的高度之和），跟它内部的
 *    `data-line-start` 是多少没有必然关系 —— 同一个 `md-block` 里可能带好几个
 *    `data-line-start`（渲染器按元素写：标题 1、空块 1、正文 3…）。若按 lineStart 排，
 *    桩里的块顶会**不单调**（实测外层/内层同顶），而 `indexOfBlockAtOffset` 的二分
 *    只在单调布局上成立 ⇒ 不单调就查错块，量出来的是假象。
 */
function blockTopOf(el: Element): number {
  const idx = Array.prototype.indexOf.call(el.parentElement?.children ?? [], el);
  return Math.max(0, idx) * ROW;
}

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;

  // ⚠️ 造布局：预览容器本身的顶边 = 它自己的 scrollTop（内容区随滚动上移），
  //    其它块按 data-line-start 排开 —— `blockTop` 的口径就还原成真实浏览器那样。
  const proto = window.Element.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
  };
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    const el = this as HTMLElement;
    const isRoot = el.classList.contains("md-preview");
    // ⚠️ B243：编辑器那几行也得**排开**（`.cm-line` 的 top = 下标 × 行高），否则 CM6 的
    //    heightMap 退化成「每行 0 高」⇒ 量不出「编辑器落在哪一行」。
    const isLine = el.classList.contains("cm-line");
    // ⚠️ 预览块会**套一层内层容器**，两个节点都带 `data-line-start`（内层恒写 1）。
    //    桩里若各按自己的 lineStart 排，块顶就**不单调**（内层恒同顶），
    //    `indexOfBlockAtOffset` 的二分会查错块、量出来的是假象。真实布局里块的顶边由
    //    **最外层那个块**决定 ⇒ 这里取「自身 + 所有祖先里最大的 lineStart」当块顶。
    const top = isRoot
      ? el.scrollTop
      : isLine
        ? Math.max(0, Array.prototype.indexOf.call(el.parentElement?.children ?? [], el)) * ROW
        : blockTopOf(el);
    // 预览块内层高度按 0 算（内层容器不撑高），编辑器行与预览根按整行高。
    const height = isRoot || isLine ? el.clientHeight || 0 || ROW : ROW * 0;
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

// ⚠️ B243：每个 md 块只占**一行**（纯标题）⇒ 预览的块与源码行一一对应、块顶 = 行号×行高，
//    于是「预览顶上停的是哪一块」才能换算成「对应哪一行的行首」—— 取整口径对错才量得出来。
//    （混排段落时一个块跨好几行，小数行号会被块内比例吃掉，这条用例就判不出东西了。）
const MD = Array.from({ length: 24 }, (_, i) => `# 标题 ${i + 1}`).join("\n");

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
          // 先显示**预览**那份 ⇒ 源是预览侧，切过去的是离屏的源码兄弟
          active: 1,
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
              cursorLine: 2,
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
  const el = document.querySelector(".layout-panel .md-preview") as HTMLElement | null;
  if (!el) throw new Error("预览容器没挂载");
  return el;
}
function scroller(): HTMLElement {
  const el = document.querySelector(".layout-panel .cm-scroller") as HTMLElement | null;
  if (!el) throw new Error("编辑器没挂载");
  return el;
}
/** Ctrl+/：view.toggle —— 与 tests/view-switch-noedit.test.ts 同一触发方式。 */
function toggleMode(): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "/", ctrlKey: true, bubbles: true, cancelable: true }),
  );
}
function tabEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll(".panel-tabstrip .tab")) as HTMLElement[];
}
function clickTab(i: number): void {
  const el = tabEls()[i];
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.click();
}
function userScroll(el: HTMLElement, px: number): void {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: px }));
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}

describe("B242 跨侧：同步滚动与切源码/预览用同一套位置计算，切来切去不漂", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(400);
  });

  /** 开同步 + 滚预览到 120，然后切一次收口到「行首对齐点」，返回 {预览, 源码} 落点。 */
  async function alignOnce(): Promise<{ preview: number; src: number }> {
    userScroll(previewRoot(), 120);
    await wait(120);
    clickTab(0); // 预览 → 源码（跨侧收口）
    await wait(260);
    const src = scroller().scrollTop;
    clickTab(1); // 源码 → 预览（跨侧收口）
    await wait(260);
    return { preview: previewRoot().scrollTop, src };
  }

  it("滚预览 → 切源码 → 切预览，来回滚几圈落点必须恒等", async () => {
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click();
    await wait(80);

    // ⚠️ 首圈会「掉」一下：用户滚出来的行内比例跨侧没法带（源码按行排版、预览按块
    //   排版，比例搬过来量纲就错），所以照切源码/预览那一路丢掉比例、落到行首/块首。
    //    那一掉是与切模式一致的既定行为；这里要盯的是**掉完以后不再动**。
    const first = await alignOnce();
    expect(first.preview, "收口后预览要落在块首（行首对齐那一格）").toBeGreaterThan(0);

    const seq: number[] = [first.preview];
    const srcSeq: number[] = [first.src];
    for (let k = 0; k < 3; k++) {
      clickTab(0); // 切到源码
      await wait(260);
      srcSeq.push(scroller().scrollTop);
      clickTab(1); // 切回预览
      await wait(260);
      seq.push(previewRoot().scrollTop);
    }
    expect(
      seq.every((v) => v === seq[0]),
      "预览侧每圈落点要一模一样（不许先漂再稳、更不许一圈圈爬）",
    ).toBe(true);
    expect(
      srcSeq.every((v) => v === srcSeq[0]),
      "源码侧每圈落点也要一模一样",
    ).toBe(true);
  });

  /** 预览此刻顶上那一块的**起始行**（`data-line-start` 那一格）。 */
  function previewTopBlockLine(): number {
    const s = previewRoot().scrollTop + 8; // 与 `topVisibleLine()` 的 +8 同一口径
    const els = Array.from(previewRoot().querySelectorAll("[data-line-start]")) as HTMLElement[];
    let best = -1;
    // 块顶沿 DOM 序单调 ⇒ 取「块顶不越过视口顶」这批里的最后一个（起始行最大的那一块）
    for (const el of els) {
      const start = Number(el.dataset.lineStart);
      if (!Number.isFinite(start) || start <= best) continue;
      if (blockTopOf(el) <= s) best = start;
    }
    return best;
  }

  /** 编辑器此刻顶上那一条**逻辑行**（几何：第一个行顶不高于滚动位置的那一行）。 */
  function sourceTopLine(): number {
    const s = scroller().scrollTop;
    const lines = Array.from(scroller().querySelectorAll(".cm-line")) as HTMLElement[];
    for (let i = 0; i < lines.length; i++) {
      if (i * ROW >= s) return i + 1;
    }
    return lines.length;
  }

  it("跨侧切过去，落到的是预览顶上那一块的行首（不许差一行）", async () => {
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click();
    await wait(80);

    // 滚到一个**块中间**的位置：这样 `topVisibleLine()` 给出来的是带小数的小数行号
    // （例如 6.4），才会把「取整口径」这件事暴露出来 —— 正好落在块首的话两种口径同值。
    userScroll(previewRoot(), 120);
    await wait(120);
    const block = previewTopBlockLine();
    expect(block, "前提：预览确实是停在某个块上（否则这条用例测不到取整口径）").toBeGreaterThan(0);

    clickTab(0); // 预览 → 源码（跨侧收口）
    await wait(260);
    const top = sourceTopLine();

    // ⚠️ CM6 的 `doc.line(小数)` 是**向上取整**（`lineInner` 里判 `line >= target`），
    //    而预览侧 `syncToLineProgrammatic(Math.floor(line))` 是向下取整 —— 两边各差一行
    //    ⇒ 切过去顶上不是预览顶上那一块（用户报的「切过去位置对不上」）。
    expect(top, `跨侧落点必须落在预览顶上那一块（第 ${block} 块）的行首，不能顺延到下一行`).toBe(
      block,
    );
  });

  it("跨侧收口落点 == 切源码/预览那一路的落点（两条路径同一套计算）", async () => {
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click();
    await wait(80);

    // 路径 A：跨侧切 tab（同步滚动那套换算）
    const a = await alignOnce();
    const pathA = a.src;

    // 路径 B：同一份「预览停在块首」的状态，按 Ctrl+/ 切回源码 —— 这一下走的是
    //   `toggleViewMode` 的 handoff（预览顶行 → `editorLineTopPx`），与路径 A 的跨侧
    //   收口是同一个函数。⚠️ 起点不能再滚：多滚一点就换了目标行，落点本就不该相等。
    toggleMode(); // 预览 → 源码（handoff）
    await wait(280);
    const pathB = scroller().scrollTop;

    expect(pathB, "切模式的落点必须与跨侧切 tab 一致（否则两条路径各算一套）").toBe(pathA);
  });
});

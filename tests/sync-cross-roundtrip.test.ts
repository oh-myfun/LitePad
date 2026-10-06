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

    // ⚠️ B247（用户拍板「切 tab 不许产生自动偏移」，参照系＝切模式）：同步源是预览时
    //    「预览 tab → 源码 tab」不再按整数块首把源码**再压一次**，源码保住
    //    `restoreViewScroll` 还原出来的自己那份位置（与切模式同一参照）；随后切回预览，
    //    预览按源码这一侧的位置对齐。首圈落点因此就是稳定落点，这里盯的是**不再漂**。
    const first = await alignOnce();

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
    const s = previewRoot().scrollTop + 0.5; // 与 preview.ts 的 `TOP_PROBE` 同一口径
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

  /** 预览此刻顶边落在顶上那一块里的**比例**（0 = 正压块顶）。 */
  function previewTopFrac(): number {
    // ⚠️ B251（ANCHOR = 0）：`s` 只用来定「顶边压在哪一块上」，**比例不许吃它** ——
    //    与 preview.ts 的 `topVisibleLine` 同构（探测点管身份、比例用真·`scrollTop`）。
    //    旧写法把这个常数一起算进比例，而落点写的是块顶（不补它）⇒ 每走一次往返就偏
    //    那么多（实测差 0.5/ROW = 0.036，正好是这一格的误差）。
    const s = previewRoot().scrollTop + 0.5; // 与 preview.ts 的 `TOP_PROBE` 同口径
    const els = Array.from(previewRoot().querySelectorAll("[data-line-start]")) as HTMLElement[];
    let top: { start: number; top: number } | null = null;
    for (const el of els) {
      const start = Number(el.dataset.lineStart);
      if (!Number.isFinite(start)) continue;
      const t = blockTopOf(el);
      // 块顶沿 DOM 序单调 ⇒ 取「块顶不越过视口顶」这批里的最后一个（起始行最大的那一块）
      if (t <= s && (!top || top.start <= start)) top = { start, top: t };
    }
    if (!top) return 0;
    // 桩里每个块一行（见 MD 那段）⇒ 块高 = ROW；nextBlockTop − blockTop 也是同量。
    return Math.min(1, Math.max(0, (previewRoot().scrollTop - top.top) / ROW));
  }

  /**
   * 编辑器此刻顶上那一条**逻辑行**（几何：行号 n 的行顶 = (n−1) × 行高）。
   *
   * ⚠️ B251 换判据：旧写法 `for (i…) if (i*ROW >= s) return i+1` 只在 s **正好压在行顶上**
   *    时才对 —— s 落在行内部（比如 126 → 128）它就把下一行报出来（返回 n+1 而不是 n），
   *    于是「块内走了多少比例」这件事在这个 helper 里根本表达不出来。现在按
   *    「第 n 行占 [(n−1)·ROW, n·ROW)」直接算，行内比例也就顺带落在同一个数上，
   *    下面那条判据才抓得住「比例被掐成行首」。
   */
  function sourceTopLine(): number {
    return Math.floor(scroller().scrollTop / ROW) + 1;
  }

  /** 编辑器顶边落在这一行内部的**比例**（0 = 正压行顶）。 */
  function sourceTopFrac(): number {
    const s = scroller().scrollTop;
    const n = sourceTopLine();
    return (s - (n - 1) * ROW) / ROW;
  }

  it("跨侧切过去，落的是预览那份 `v` 在源码侧的同一个位置（不许差一行，也不许掐掉比例）", async () => {
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click();
    await wait(80);

    clickTab(1); // 先切到预览 tab，下面用**切模式**这一条同样从 `syncSourceV` 取值的路
    await wait(200);
    // 滚到一个**块中间**的位置：这样 `topVisibleLine()` 给出来的是带小数的小数行号
    // （例如 6.4），才会把「取整口径 / 比例口径」这件事暴露出来 —— 正好落在块首的话
    // 「只交整数块首」与「交完整 v」两种写法同值，这条用例就成了摆设。
    userScroll(previewRoot(), 120);
    await wait(120);
    const block = previewTopBlockLine();
    expect(block, "前提：预览确实是停在某个块上（否则这条用例测不到取整口径）").toBeGreaterThan(0);
    const fracBefore = previewTopFrac();
    expect(
      fracBefore,
      "前提：预览确实是停在**块内**、不是压在块顶（否则比例无从判）",
    ).toBeGreaterThan(0);

    toggleMode(); // 预览 → 源码（同一份 tab 的 handoff，B251 完整 `v`）
    await wait(260);
    const top = sourceTopLine();

    // ⚠️ CM6 的 `doc.line(小数)` 是**向上取整**（`lineInner` 里判 `line >= target`），
    //    而预览侧 `Math.floor` / `blockAtLine` 是向下取整 —— 两边各差一档 ⇒ 切过去顶上
    //    不是预览顶上那一块（B243/B249 实测：预览顶在块 5 走了 70%，切过去落到第 7 行，
    //    差两行；用户报的「切过去位置对不上」就是这一路）。
    //    ⚠️⚠️ B251 之后**本条判据被推翻过一次**（用户报：切换 tab 往上偏移又出现）。
    //    B251 让跨侧交**完整 `v`**（小数 = 预览块内比例），本条于是断言「落点要保住块内
    //    比例」。那是错的：预览的小数归一在**块高**上、源码侧 `sourceTopOfV` 按**行高**插
    //    ⇒ 落点差 `ratio × (块高 − 块行数×行高)`，而预览渲染普遍比源码松（块高偏大）
    //    ⇒ 偏差**恒为往上**，正是用户看到的「越切越靠顶」。桩里 ROW=14 == 源码行高 14，
    //    这一档错题在桩里被抹平（全量 1291 全绿却真机偏）。
    //    ⇒ 跨侧（预览⇄源码）只交**整数块首**：落点 = 块首行顶，零偏差、闭合。
    expect(
      top,
      `切模式落点必须落在预览顶上那一块的**行**（第 ${block} 块），不能顺延到下一行`,
    ).toBe(block);
    expect(
      sourceTopFrac(),
      "跨侧落点是块首行顶：不许带出预览那份块内比例（带出去就恒偏上）",
    ).toBeCloseTo(0, 2);
    // ⚠️ 反过来钉住的那一面（防「只交行号、把整块比例弄丢」的真退化）：落点必须**真的
    //    落在这一块上**，而不是被谁短路成文档开头 / 上一行 —— 上面那 `toBe(block)` 就是
    //    这一面的闸；这里再补一条「不是整块往下漂」的闸，两道合起来才有鉴别力。
    expect(block, "前提：预览确实停在某个块上").toBeGreaterThan(1);
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

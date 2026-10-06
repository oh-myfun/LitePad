// @vitest-environment jsdom
// B243 复核：用户原话——
//   「开启滚动同步时：激活标签 a 代码位置 A，对应同分屏标签 b 不可视预览对应位置 A'，
//    不同分屏标签 c 代码位置 A，不同分屏标签 d 预览对应位置 A'，
//    来回切换激活标签 a/b/c/d，标签 abcd 滚动位置不会变化，
//    标签 abcd 切换代码或者预览模式，滚动位置变为 A 或 A'，其他 3 个标签滚动位置不变」
//
// 也就是把同步滚动的两条不变量钉死：
//   ① **切稳定性** —— 4 个标签（2 面板 / 1 源码 + 1 预览 各半）来回切 N 圈，谁都不许漂；
//   ② **切模式收敛** —— 单个标签自己换源码 / 预览之后，落点是 A 或 A'（对应位置），
//      不是 0、也不是被换算值刷过的别的值，且**只动它自己这一格**（同文档兄弟不跟着跑）。
//
// ⚠️ jsdom 默认没有布局（rect 全 0）⇒ 预览换算退化成「块顶恒等于 scrollTop」，
//    上面两条都会假绿。所以这里照 `sync-cross-roundtrip.test.ts` 造确定性布局
//    （行高 20、块顶 = DOM 序 × 20、`.cm-line` 也排开），否则测的是桩不是产品。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

// ⚠️ **行高必须是 14，不是 20**：`topVisibleLineFrac` / `editorLineTopPx` 都走
//    CM6 的 heightMap，而 CM6 在 jsdom 里把每行量成 **14px**（取不到 lineHeight 时按
//    `font_size: 14` 兜底）。桩若按 20 摆位，同一处源码侧会报「第 18.2 行」、预览侧是
//    「第 13 块」⇒ 测出来的是**两边单位不一致**，不是产品行为（实测 px=240 ⇒ line=18.21）。
//    预览块与 `.cm-line` 的高度都用这个数，两侧口径才对得上。
const ROW = 14;

/**
 * 预览块顶：**真实几何**——块高不等宽（模拟 h1 / 段落块高参差），块顶 = 前面各块高度累加。
 *
 * ⚠️ 曾经这里写成 `idx * ROW`（等宽），并且把 `A'` **写死**成「顶边 − 8」的 168/160。
 *    那在等宽假设下自洽，但真实里块高参差时「预览第 13 块的顶」根本不是 168 ——
 *    非等宽一上，先炸的是**桩自己的期望值**（`warm-up`、`前提：b 预览停在 A'`），
 *    根本走不到产品逻辑 ⇒ 测的是桩不是产品（B246 踩过）。
 *    所以：① 块顶按真实累加算；② `A'`/`A` **从块几何推导**（见 `topOfBlock`），不写死。
 *    （B244 修掉 `renderBlocks` 的 open/close 双块后，DOM 下标即块序，不再有内层伪块。）
 */
function blockHeight(idx: number): number {
  // 块高不等宽：第 idx 块比基准行高多出 (idx%3) 档，正好模拟真实里标题/段落高度参差
  return ROW + (idx % 3) * 11;
}

/** 第 k 块的顶边（前面 k 块高度之和）。`A'` 就是 `topOfBlock(12)`（ANCHOR = 0，块顶=落点），不再写死。 */
function topOfBlock(k: number): number {
  let s = 0;
  for (let i = 0; i < k; i++) s += blockHeight(i);
  return s;
}

function blockTopOf(el: Element): number {
  const idx = Math.max(0, Array.prototype.indexOf.call(el.parentElement?.children ?? [], el));
  let s = 0;
  for (let i = 0; i < idx; i++) s += blockHeight(i);
  return s;
}

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;

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
    const height = isRoot || isLine ? el.clientHeight || 0 || ROW : ROW * 0;
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

// ⚠️ 纯标题文档 ⇒ 每个预览块正好一行，块顶 = 行号 × 行高，源码行与预览块一一对应，
//    「对应位置」这件事才有确定值可判（混排时一个块跨多行，量不出对应关系）。
const MD = Array.from({ length: 24 }, (_, i) => `# 标题 ${i + 1}`).join("\n");

// ⚠️ 两个面板：面板 1 = 标签 a(源码) + b(预览)，面板 2 = 标签 c(源码) + d(预览)。
//    layout 是**二叉树**（`{a, b}`，写 children 会静默塌成单面板）。
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

/** 面板元素（DOM 序 = 布局左右，0 = a/b 那一栏，1 = c/d 那一栏）。 */
function panelEls(): HTMLElement[] {
  const els = Array.from(document.querySelectorAll<HTMLElement>(".layout-panel"));
  if (els.length < 2) throw new Error(`用例前提：两个面板都在（实际 ${els.length}）`);
  return els;
}
function scroller(i: number): HTMLElement {
  const el = panelEls()[i].querySelector(".cm-scroller") as HTMLElement | null;
  if (!el) throw new Error(`面板 ${i} 编辑器没挂载`);
  return el;
}
function previewOf(i: number): HTMLElement {
  const el = panelEls()[i].querySelector(".md-preview") as HTMLElement | null;
  if (!el) throw new Error(`面板 ${i} 预览没挂载`);
  return el;
}
/** 面板 i 的标签条（DOM 序 = a, b 或 c, d）。 */
function tabsOf(i: number): HTMLElement[] {
  const els = Array.from(panelEls()[i].querySelectorAll(".panel-tabstrip .tab")) as HTMLElement[];
  if (els.length < 2) throw new Error(`用例前提：面板 ${i} 两个标签都在（实际 ${els.length}）`);
  return els;
}
function clickTab(panel: number, idx: number): void {
  const el = tabsOf(panel)[idx];
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.click();
}
/** 用户滚容器：先 wheel 清「程序来源」标记，再手动 scroll（jsdom 不自己滚）。 */
function userScroll(el: HTMLElement, px: number): void {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: px }));
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}
function toggleMode(): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "/", ctrlKey: true, bubbles: true, cancelable: true }),
  );
}

// 源码侧的位置 A：第 13 行的行首（下标 12 ⇒ 顶 = 12 × 行高）。
const A = 12 * ROW;
// 预览侧对应位置 A'：**同一个块**（行 13）的顶边。
//
// ⚠️ 这两个值**从块几何推导，绝不写死**：
//    `applySyncToLine` 落点 = `块顶 + 块内比例 × 块高`（ANCHOR = 0，不减不增；B257 起跨侧
//    **不丢**小数），而 `topVisibleLine()`（B251 的 `topBlockStartLine()` 已删）用
//    `scrollTop + TOP_PROBE` 反算回同一个 `v` ⇒ 两个方向自洽 —— 本用例只量「顶」这一档
//    （AP 压在块顶 ⇒ 比例恒 0），小数那档另由 `sync-push-cross` / `cross-roundtrip` 盯。
//    块高不等宽时「第 13 块的顶」≠ 168，写死就会先炸桩的前提断言（B246 教训）。
//    别把这 8 写成 0，否则量的是「落点漂 8px」而不是「四格稳不稳」。
const AP = topOfBlock(12);

describe("B243 复核：两面板 / 四标签（a 源码 + b 预览 同栏，c 源码 + d 预览 异栏）", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(500);
  });

  it("① 来回切换激活标签 a/b/c/d，四格滚动位置都不许变", async () => {
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click();
    await wait(120);

    // 源是 a（面板 1 激活的是 a）⇒ 滚它，同步把坐标推给 b / c / d。
    userScroll(scroller(0), A);
    await wait(160);
    expect(scroller(0).scrollTop, "源 a 的位置 A").toBe(A);
    expect(scroller(1).scrollTop, "异屏的 c 也该同步到 A").toBe(A);

    /** 每格此刻「看得见的位置」：源码格读编辑器像素，预览格读预览像素。 */
    const seen = () => ({
      a: scroller(0).scrollTop,
      c: scroller(1).scrollTop,
      b: previewOf(0).scrollTop,
      d: previewOf(1).scrollTop,
    });

    // ⚠️ warm-up（不是作弊，是把判据摆到用户描述的那个起点上）：离屏预览（b / d）在
    // 被切过去之前压根没落过位、就是 0；同步写的是它的**快照槽**，切过去那一下
    // `restoreViewScroll` 才把它钉到 A'。所以先把 b、d 各切过去再切回源码，
    // 四格都已在 A/A' 上，**之后**才开始记循环 —— 记的才是「来回切不许动它们」，
    // 而不是「首次落位」。
    clickTab(0, 1); // b（同栏预览，第一次切过去 ⇒ 落到 A'）
    await wait(200);
    clickTab(0, 0); // a
    await wait(200);
    clickTab(1, 1); // d（异栏预览，第一次切过去 ⇒ 落到 A'）
    await wait(200);
    clickTab(1, 0); // c
    await wait(200);
    const wu = [
      scroller(0).scrollTop,
      previewOf(0).scrollTop,
      scroller(1).scrollTop,
      previewOf(1).scrollTop,
    ].join("/");
    expect(wu, "warm-up 后四格都该在 A/A'").toBe([A, AP, A, AP].join("/"));

    // 切一圈：面板 1 内 a→b→a，面板 2 内 c→d→c，再跨面板 a→c→d→b。
    const seq: string[] = [];
    const steps: Array<() => void> = [
      () => clickTab(0, 1), // b（同栏预览）
      () => clickTab(0, 0), // a
      () => clickTab(1, 1), // d（异栏预览）
      () => clickTab(1, 0), // c
      () => clickTab(0, 1), // b
      () => clickTab(1, 1), // d
      () => clickTab(0, 0), // a
      () => clickTab(1, 0), // c
    ];
    for (const step of steps) {
      step();
      await wait(200);
      const s = seen();
      seq.push([`a=${s.a}`, `b=${s.b}`, `c=${s.c}`, `d=${s.d}`].join(","));
    }

    // ⚠️ 判据：每格在自己那一侧都停在 A / A'（不许被切换动作改掉、更不许一圈圈爬）。
    const stable = seq.every((row) => row === `a=${A},b=${AP},c=${A},d=${AP}`);
    if (!stable)
      throw new Error(`漂移（每步期望 a=${A},b=${AP},c=${A},d=${AP}）：\n${seq.join("\n")}`);
  });

  it("② 单标签切换源码 / 预览模式：落点变成对应位置，其他 3 个标签不动", async () => {
    // 前提：位置回到 a=A / b=A' / c=A / d=A'（上一轮切完就是，这里再确认一次）。
    expect(scroller(0).scrollTop).toBe(A);
    expect(scroller(1).scrollTop).toBe(A);
    expect(previewOf(0).scrollTop).toBe(AP);
    expect(previewOf(1).scrollTop).toBe(AP);

    // ① a：源码 → 预览。落点应是 A'（预览对应位置），**b / c / d 不许被带跑**。
    toggleMode();
    await wait(280);
    expect(previewOf(0).scrollTop, "a 切成预览 ⇒ 落在 A'").toBe(AP);
    expect(previewOf(1).scrollTop, "其他标签：d 不动").toBe(AP);

    // ② a：预览 → 源码。落点应是 A。
    toggleMode();
    await wait(280);
    expect(scroller(0).scrollTop, "a 切回源码 ⇒ 落在 A").toBe(A);
    expect(scroller(1).scrollTop, "其他标签：c 不动").toBe(A);

    // ③ 反向验一遍：在 c（异屏源码）上切模式，同样只动 c 这一格。
    toggleMode();
    await wait(280);
    expect(previewOf(1).scrollTop, "c 切成预览 ⇒ 落在 A'").toBe(AP);
    expect(previewOf(0).scrollTop, "其他标签：b 不动").toBe(AP);
    expect(scroller(0).scrollTop, "其他标签：a 不动").toBe(A);

    toggleMode();
    await wait(280);
    expect(scroller(1).scrollTop, "c 切回源码 ⇒ 落在 A").toBe(A);
    expect(scroller(0).scrollTop, "其他标签：a 仍不动").toBe(A);
  });

  it("③ 亚像素取锚：预览停在「块顶-8」再带个小数时，切回源码不许退回上一块", async () => {
    // 用户实测 symptom：每次切「代码 tab ↔ 预览 tab」都往上挪，越靠顶挪得越少。
    // 机制：落点就是块顶，取锚 `scrollTop + TOP_PROBE`（半像素探测），
    // `topAt <= offset` 于是命中**前一个块** ⇒ 源码被钉到上一块的首行 ⇒ 越切越靠顶。
    // 先切到 b 预览，让它自己落到 A'（160）。
    clickTab(0, 1);
    await wait(220);
    expect(previewOf(0).scrollTop, "前提：b 预览停在 A'").toBe(AP);

    // 故意把预览的 scrollTop 压成「块顶 - 0.2」——真实浏览器里 scrollTop 常是这样的小数。
    previewOf(0).scrollTop = AP - 0.5;
    await wait(120);

    // 切回源码：取锚必须还是「第 13 块（行 13）」，不许退回第 12 块。
    clickTab(0, 0);
    await wait(260);
    expect(scroller(0).scrollTop, "预览只差半像素 ⇒ 源码仍落在 A（退回上一块就会小于 A）").toBe(A);
  });

  it("④ 切到「预览 tab」的落点 == 本标签切「源码/预览模式」的落点", async () => {
    // 用户诉求：同步滚动下，「切换源码/预览模式的标签」和「同一个标签切源码/预览模式」
    // 必须得到**同一个**滚动位置 —— 现在同标签切模式是准的，切标签不是。
    clickTab(0, 0);
    await wait(220);
    expect(scroller(0).scrollTop, "前提：a 在 A").toBe(A);

    // 路径一：**切到另一个 tab**（b 预览）⇒ 预览落点 P_tab
    clickTab(0, 1);
    await wait(280);
    const pTab = previewOf(0).scrollTop;

    // 回到源码，再把本标签 a 切模式（source → preview）⇒ 预览落点 P_toggle
    clickTab(0, 0);
    await wait(220);
    toggleMode();
    await wait(320);
    const pToggle = previewOf(0).scrollTop;

    expect(pToggle, "切 tab / 切本标签模式 两条路必须落在同一个预览位置").toBe(pTab);

    // 收尾：切回源码
    toggleMode();
    await wait(300);
    expect(scroller(0).scrollTop).toBe(A);
  });

  it("⑤ 滚激活的预览 ⇒ 未显示的代码标签位置跟着走（槽要被推成新值，不是停在老位置）", async () => {
    // ⚠️ B248：用户报「滚动激活的预览模式文件，未显示的代码模式文件位置没有变化」。
    //    同步源是预览 ⇒ `applySyncToSibling` 拿不到编辑器像素（`px === null`），
    //    只能拿预览那一路算出的**行号**；离屏的源码兄弟没有自己的视图，旧写法
    //    `if (!shownView) return;` 于是整条不写 ⇒ 它的槽永远停在切走前的老位置，
    //    切过去 `restoreViewScroll` 读出来就是**旧位置**（用户眼里的「没变化」）。
    //    判据：预览顶在块 12 ⇒ 该推给源码的行号是 12 ⇒ 源码落点 == A（块首）。
    clickTab(0, 0);
    await wait(220);
    expect(scroller(0).scrollTop, "前提：a 在 A").toBe(A);

    clickTab(0, 1); // 激活预览 tab b，源码 a 离屏
    await wait(240);
    userScroll(previewOf(0), AP); // 预览顶正好落在块 12（顶 ⇒ 块内比例 0，B257 起仍照交完整 v）
    await wait(240);

    clickTab(0, 0); // 切回源码 a —— 此刻收口被 B247 守卫挡着，位置只能来自它自己的槽
    await wait(300);

    expect(
      scroller(0).scrollTop,
      "未显示的代码标签要落在预览顶上那一块（块 12）的块首 = A，不能停在切走前的老位置",
    ).toBe(A);
  });
});

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
 * 预览块顶：与 `sync-cross-roundtrip.test.ts` 同一族，但口径是「DOM 下标 × 行高」。
 *
 * ⚠️ 预览的 DOM：B244 修掉 `renderBlocks` 把 open/close 切成两块之后，每个 block 就是
 *    一个 `.md-block`，**DOM 下标即块序** ⇒ **块顶 = DOM 下标 × 行高**。
 *    （曾经踩过：pipeline 把「开标签块 + 闭标签块」交替塞进来，两层顶边同高、内层
 *    `data-line-start` 恒 1；按 DOM 下标算会让 `applySyncToLine` 的每块多算一整档，
 *    落点飞走。现在 24 行标题 ⇒ 24 块，下标即块序。）
 */
function blockTopOf(el: Element): number {
  const idx = Math.max(0, Array.prototype.indexOf.call(el.parentElement?.children ?? [], el));
  return idx * ROW;
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

// 源码侧的位置 A：第 13 行的行首（下标 12 ⇒ 顶 = 240）。
const A = 12 * ROW;
// 预览侧对应位置 A'：**同一个块**（行 13）。
// ⚠️ 不是 240 而是 240 - 8：`applySyncToLine` 落点是 `块顶 - 8`（给 `topVisibleLine()`
//    的「+8 偏移」留口径），而 `topBlockStartLine()` 又用 `scrollTop + 8` 反算回同一个块
//    ⇒ 两个方向自洽 ⇒ 预览停在 232 就正对行 13 的行首。别把这 8 写成 0，否则这条用例
//    量的是「落点漂 8px」而不是「四格稳不稳」。
const AP = A - 8;

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
});

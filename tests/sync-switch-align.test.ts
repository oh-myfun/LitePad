// @vitest-environment jsdom
// B241 · 用户原话（第三轮）：「两个同文件 tab 来回切换，同步滚动位置会变化」。
// 场景 = 同一面板两个同文档标签（一个源码 + 一个预览，B154 的组合），来回切位置会漂。
//
// B240 三轮给切换加了「收口」（切过来那份按源的位置对齐），方向是对的 ——
// 但收口之后尾部还有一趟 `pushSyncToSiblings`，它把**刚按源换算落位的接班值**写回了
// 兄弟（此刻正是源）的槽 ⇒ **切换动作把源的位置也改了**；跨侧（行号⇄像素）每轮换算都
// 不等值，于是误差一圈圈吸收进源那一格，越切越歪。
//
// ⚠️ 所以本条用例（同侧：两个都是源码，`px` 直通 ⇒ jsdom 也能真验落点）盯的是
//    **往返稳定性**：滚一次 → 来回切 N 圈 → 每次都停在同一个像素。
//    跨侧那一格（源预览 ⇄ 接班源码）jsdom **没有布局**，行号换算算不出像素
//    （B240 三轮那条「断言编辑器 260」其实是假绿：预览像素与编辑器像素碰巧都是 260），
//    只能由 `sync-scroll-mode.test.ts` 的静态契约 + headless 判据兜住。
//
// ⚠️ 全程只碰 DOM（标签、滚动容器），不依赖任何内部调试出口 —— 断言的是用户真正
// 看得见的那件事：切回来之后编辑器停在哪个像素上。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
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

const TXT = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");

vi.mock("../src/ipc/api", () => ({
  emitCrossWindow: vi.fn(async () => {}),
  convertFileSrc: (p: string) => `asset://${p}`,
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve([{ label: "UTF-8", group: "Unicode（统一码）" }]),
  listEols: () => Promise.resolve(["CRLF", "LF"]),
  // ⚠️ 两个标签**同路径**（同一文档）、**都是源码态** —— 同侧 ⇒ `px` 直通，jsdom 里
  //   也能真验「切过去落在哪个像素上」（换成「一个预览」就得走行号换算，jsdom 没有
  //   布局、算不出像素，断言只会是假绿）。B154 的跨侧那一格交给静态契约。
  loadSession: () =>
    Promise.resolve({
      activePanel: 0,
      panels: [
        {
          // ⚠️ `active` 是**索引**（诊断过：0 ⇒ 第一个标签 tab-active）。先显示第一个。
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
              cursorLine: 2,
              cursorCol: 1,
              scrollTop: 0,
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
      text: TXT,
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

/** 本面板的编辑器滚动容器。 */
function scroller(): HTMLElement {
  const el = document
    .querySelector(".layout-panel")
    ?.querySelector(".cm-scroller") as HTMLElement | null;
  if (!el) throw new Error("编辑器没挂载");
  return el;
}

/** 两个标签元素（DOM 顺序 = 会话里的顺序）。 */
function tabEls(): HTMLElement[] {
  const els = Array.from(document.querySelectorAll(".panel-tabstrip .tab")) as HTMLElement[];
  if (els.length < 2) throw new Error(`用例前提：两个标签都在（实际 ${els.length}）`);
  return els;
}

/** 点标签切过去（走的是生产那条 `switchTab`，不是内部函数）。 */
function clickTab(i: number): void {
  const el = tabEls()[i];
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.click();
}

/**
 * 用户滚容器：wheel 先清掉「程序来源」的黏性标记，再派发 scroll ——
 * 少了那一发 wheel，还原期 `markProgrammatic` 留的标记会把用户滚动也吞掉
 * （jsdom 不做布局，不派发 wheel 就永远「接管」不了滚动）。
 */
function userScroll(el: HTMLElement, px: number): void {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: px }));
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}

const RIGHT = 260;

describe("B240 三轮：切过来显示的这一份，按**源**的位置收口（不可见也算）", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(300);
  });

  it("两个同文档源码标签来回切，位置必须钉在同一个像素上（不能越切越歪）", async () => {
    // 前提：同一面板两个同文档、都是源码态（同侧 ⇒ px 直通，这条用例能真验落点）
    const [tabA, tabB] = tabEls();
    expect(tabA, "第一个标签应落在面板里").toBeTruthy();
    expect(tabB, "第二个标签应落在面板里").toBeTruthy();

    // 开同步滚动（标题栏那颗键；两份同文档 ⇒ 按钮显形）
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    expect(btn, "两个实例 ⇒ 同步键可见").toBeTruthy();
    btn?.click();
    await wait(60);

    // ① 滚当前这一份（A）—— 它是源，同一路把坐标推给离屏的兄弟 B。
    userScroll(scroller(), RIGHT);
    await wait(80);
    expect(scroller().scrollTop, "源这一份自己的落点").toBe(RIGHT);

    // ② 切到 B：B 当初离屏算不出自己的像素，位置由那一刻从源收口。
    clickTab(1);
    await wait(200);
    expect(scroller().scrollTop, "切过去那份应停在源同步过来的位置").toBe(RIGHT);

    // ③ 切回 A：源此时是 B。收口 + 不再把换算值回推给源 ⇒ A 必须还是 RIGHT。
    clickTab(0);
    await wait(200);
    expect(scroller().scrollTop, "切回来后 A 不该被切换动作改掉").toBe(RIGHT);

    // ④ 再切两圈：每圈都从当前源收口，不许一轮轮累积偏差。
    clickTab(1);
    await wait(200);
    clickTab(0);
    await wait(200);
    clickTab(1);
    await wait(200);
    expect(scroller().scrollTop, "切到 B 这一格应仍是 RIGHT").toBe(RIGHT);
    clickTab(0);
    await wait(200);
    expect(scroller().scrollTop, "来回切完一圈圈仍停在 RIGHT（这就是用户报的「位置变化」）").toBe(
      RIGHT,
    );
  });

  it("在 B 上滚过之后再切回来，两边仍同源对齐（不把换算值刷回源）", async () => {
    // 在 B 上滚到别的像素，然后切回 A —— A 应该跟 B 对齐到同一位置；
    // 关键是**下一轮**再切到 B 时，B 还得停在自己那一格，不能越切越歪。
    userScroll(scroller(), RIGHT * 2);
    await wait(80);
    expect(scroller().scrollTop, "先把 A 挪到别的位置").toBe(RIGHT * 2);

    clickTab(1);
    await wait(200);
    const atB = scroller().scrollTop;
    expect(atB, "切到 B 应停在 A 的位置").toBe(RIGHT * 2);

    clickTab(0);
    await wait(200);
    expect(scroller().scrollTop, "切回 A：应仍在 RIGHT*2，不是被换算值刷过的别的值").toBe(
      RIGHT * 2,
    );

    clickTab(1);
    await wait(200);
    expect(scroller().scrollTop, "再切到 B 还得是同一个值（漂移会发生在这一步）").toBe(RIGHT * 2);
  });
});

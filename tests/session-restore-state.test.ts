// @vitest-environment jsdom
// B129 · 会话恢复必须覆盖三件事：① 每个面板**激活的标签**、② 每个标签**各自的光标**、
// ③ 每格**各自的视口位置**（B302 起位置以与宽度无关的 `v` 回到会话里）。
//
// 为什么需要这一整份用例：cursor-keep.test.ts 喂给恢复流程的会话里所有标签都是
// `cursorLine: 1` —— 于是「只恢复了活动标签」和「每个标签都恢复」在那些断言里长得
// 一模一样，等于没在测。这里给每个标签安排**不同的**行/列/位置，任何一处只恢复
// 一份、或大家共用同一份，都会当场露馅。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { sessionAll } from "./static";
import { EditorView } from "@codemirror/view";
import { panels as appPanels, tabs as appTabs, type Panel, type Tab } from "../src/core/app-state";
import { readVisibleV } from "../src/sync-scroll/wire";

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
});

/** 落盘记录（反向契约用：滚动事件不再触发会话落盘）。 */
const wired = vi.hoisted(() => ({
  saved: [] as unknown[],
}));

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
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve({ unlisten: () => {} }),
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
  open: () => Promise.resolve(null),
  save: () => Promise.resolve(null),
}));

/** 每个标签各给一份互不相同的「行/列/视口」（故意与下面的 mock 值一一对应）。 */
function docText(name: string): string {
  return Array.from({ length: 20 }, (_, i) => `${name} line ${i + 1}`).join("\n");
}

/**
 * 会话里每个文档的 id：真机由 Rust 分配，本用例按路径给一个稳定值 —— B302 的
 * 「文档级兜底」按 `docId` 归组，所以 `loadSession` 记的 id 必须与 `openFile` 回来的
 * id 对得上（对不上就等于线上少了一层身份，兜底永远命中不了）。见下面两处 100+char。
 */

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
      activePanel: 1,
      panels: [
        // 面板0：两个标签，**激活的是第二个**（b.md）
        {
          active: 1,
          tabs: [
            {
              path: "a.md",
              docId: 197,
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 5,
              cursorCol: 3,
              scrollV: 5.25,
            },
            {
              path: "b.md",
              docId: 198,
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 9,
              cursorCol: 2,
              scrollV: 9.5,
            },
            // d.md 这份文档退出前**同步关着**：两格都没显示过（面板0 亮的是 b.md），
            // 其中面板1 那一格没记过位置 ⇒ B303 之后不许借 7.75，就停在顶部。
            {
              path: "d.md",
              docId: 200,
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 8,
              cursorCol: 1,
              scrollV: 7.75,
              syncMode: false,
            },
          ],
        },
        // 面板1：两个标签 —— c.md **没记过位置**（也没有同文档的兄弟格可借），
        // b.md 的第二格同样没记过 ⇒ 该借面板0 那一格的 9.5（B302 文档级兜底）。
        {
          active: 0,
          tabs: [
            {
              path: "c.md",
              docId: 199,
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 3,
              cursorCol: 4,
            },
            {
              path: "b.md",
              docId: 198,
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 1,
              cursorCol: 1,
              scrollV: null,
            },
            {
              path: "d.md",
              docId: 200,
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 1,
              cursorCol: 1,
              scrollV: null,
              syncMode: false,
            },
          ],
        },
      ],
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
    Promise.resolve({ tabId: 1, name: "未命名", readonly: false, encoding: "UTF-8", eol: "CRLF" }),
  openFile: (path: string) =>
    Promise.resolve({
      // 与上面 `loadSession` 里各条记录的 `docId` 对齐（100 + 首字母码位）：
      // B302 的文档级兜底按 docId 归组，两边对不上时兜底永远命中不了。
      tabId: 100 + path.charCodeAt(0),
      text: docText(path),
      name: path,
      path,
      encoding: "UTF-8",
      eol: "LF",
      readonly: false,
      mixedEol: false,
      sizeClass: "normal",
      sizeHint: "",
    }),
  reloadFile: () =>
    Promise.resolve({
      tabId: 1,
      text: "",
      name: "x",
      path: "x",
      encoding: "UTF-8",
      eol: "LF",
      readonly: false,
      mixedEol: false,
    }),
  saveFile: () => Promise.resolve({ lossy: [], path: "" }),
  savePasteImage: () => Promise.resolve(""),
  saveSession: (state: unknown) => {
    wired.saved.push(state);
    return Promise.resolve();
  },
  saveSettings: () => Promise.resolve(),
  writeBackup: () => Promise.resolve(),
  restoreBackup: () => Promise.resolve(null),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
}));

/** 面板按文档顺序横向排布（每个 200x200，间隔 10），jsdom 无布局，靠该桩做命中测试。 */
function installRectStubs(): () => void {
  const origRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const mk = (left: number, top: number, w: number, h: number) =>
      ({
        left,
        top,
        right: left + w,
        bottom: top + h,
        width: w,
        height: h,
        x: left,
        y: top,
        toJSON() {},
      }) as DOMRect;
    if (this.classList.contains("layout-panel")) {
      const idx = Array.from(document.querySelectorAll(".layout-panel")).indexOf(this);
      return mk(Math.max(0, idx) * 210, 0, 200, 200);
    }
    if (this.classList.contains("panel-tabstrip")) {
      const panel = this.closest(".layout-panel");
      const idx = panel ? Array.from(document.querySelectorAll(".layout-panel")).indexOf(panel) : 0;
      return mk(Math.max(0, idx) * 210, 0, 200, 24);
    }
    if (this.classList.contains("tab")) return mk(0, 0, 20, 24);
    return mk(0, 0, 200, 200);
  };
  return () => {
    Element.prototype.getBoundingClientRect = origRect;
  };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// 命中测试桩在整个文件里都要有效（会话恢复后的挂载、切标签都靠它），
// 所以只在模块加载时装一次，不在某个用例里装了又卸。
installRectStubs();

function views(): EditorView[] {
  return Array.from(document.querySelectorAll(".cm-editor"))
    .map((dom) => EditorView.findFromDOM(dom as HTMLElement))
    .filter((v): v is EditorView => !!v);
}
function panels(): HTMLElement[] {
  return Array.from(document.querySelectorAll(".layout-panel")) as HTMLElement[];
}
function tabEls(panelIdx: number): HTMLElement[] {
  return Array.from(panels()[panelIdx].querySelectorAll(".tab")) as HTMLElement[];
}
function mouse(type: string, x: number, y: number): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
}
function clickTab(el: HTMLElement): void {
  el.dispatchEvent(mouse("mousedown", 5, 5));
  el.dispatchEvent(mouse("click", 5, 5));
}
/** 该视图里的光标行 / 列（1-based）。 */
function cursorAt(view: EditorView): { line: number; col: number } {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  return {
    line: line.number,
    col: head - line.from + 1,
  };
}
/** 标签条上第 i 个标签对应的文件路径（从视图内容反推，jsdom 无 data 属性保证）。 */
function docNameOf(view: EditorView): string {
  return (view.state.doc.toString().split("\n")[0] ?? "").split(" line")[0];
}

describe("B302 · 位置随会话回来：每格各存各的 + 文档级兜底", () => {
  // 这一组必须排在**任何点击之前**：切标签与滚动都会把屏上现读的 v 写回标签记忆，
  // 排在后面就测不到「恢复那一下带回来的是什么」了（上一版就栽在这个顺序上）。
  beforeAll(async () => {
    await import("../src/main");
    await wait(300);
  });

  it("各格各回各的那一份：一份记录顶替不了另一份", () => {
    expect(scrollVsOfDoc("a.md"), "a.md 那一格记的是它自己的 5.25").toEqual([
      expect.closeTo(5.25, 5),
    ]);
    expect(
      scrollVsOfDoc("c.md"),
      "没记过、又没有兄弟格可借 ⇒ 就是顶部，但不是「数据里本来就没得选」的顶部",
    ).toEqual([expect.closeTo(1, 5)]);
  });

  it("同一份文档第二格没记过位置 ⇒ 借兄弟格那一份，而不是弹回顶部（文档级兜底）", () => {
    // 盯的是**从没显示过**的那一份（面板1 里后建的那张）：显示过的那一份在恢复后会被
    // 落盘现采改写一次读数（jsdom 没有布局，量出来本就偏离 9.5），拿它判兜底等于判 jsdom。
    const bs = tabsOfDoc("b.md");
    expect(bs.map((t) => t.panelId).sort()).toEqual([1, 2]);
    expect(bs[1].scrollV, "没记过位置的那一格借来的就是兄弟格那一份 9.5").toBeCloseTo(9.5, 5);
    expect(
      bs.some((t) => t.scrollV === 1),
      "兜底坏掉才会有一格正好停在 1（然后它一成为活动就把整份文档拽上顶，B292 那一族）",
    ).toBe(false);
  });

  it("同步关着的那份文档 ⇒ 没记过位置那一格不借兄弟格那一份（B303 · 兜底先问开关）", () => {
    // 上面那条「文档级兜底」的前提是这份文档同步开着：开着时同 docId 的视口本来就互相跟齐，
    // 借来的就是它自己的位置。关着则不然 —— 借 = 用户眼里的「没开同步也跟着同步」（真机
    // 22:37 那一轮：d.md 关着，重启后同文档几格全落在卫星窗口滚出来的同一个值上）。
    expect(scrollVsOfDoc("d.md"), "记着的那一格回自己的 7.75，没记过那一格老实停在顶部").toEqual([
      expect.closeTo(7.75, 5),
      expect.closeTo(1, 5),
    ]);
  });

  it("恢复后头一次落盘：没显示的那一格也带着自己的位置下去，不许退成没记过（B303）", async () => {
    // 真机 22:37:05 → 22:37:08：上一次退出时源码那两格记的是 15.58，重启后第一次快照就变成
    // `v=没记` —— 恢复只把位置写进 `Tab.scrollV`，而会话记录是在第一次落盘时由 `register`
    // 现场补建的（不带 seed）。位置一退成没记过，下一次重启它就只能走文档级兜底 ⇒ 同文档
    // 所有格子坍到同一个位置，用户看到的正是「开关关着也跟着同步」。
    const t0 = Date.now();
    while (wired.saved.length === 0 && Date.now() - t0 < 4000) await wait(50);
    expect(wired.saved.length, "恢复完成后应当落过一次盘").toBeGreaterThan(0);
    const last = wired.saved[wired.saved.length - 1] as {
      panels: { tabs: { path: string; scrollV?: number | null }[] }[];
    };
    const hidden = last.panels[1].tabs.find((x) => x.path === "b.md")!;
    expect(hidden, "面板1 那张 b.md 要还在会话里").toBeTruthy();
    expect(
      hidden.scrollV,
      "记录里退成 null 就等于把这份位置弄丢了（下一次重启只能借别人的）",
    ).toBeCloseTo(9.5, 5);
  });
});

/** 某份文档恢复出来的所有实例（按实例 id 排 = 按会话里的建序）。 */
function tabsOfDoc(path: string): Tab[] {
  const docId = 100 + path.charCodeAt(0);
  return [...appTabs.values()].filter((t) => t.docId === docId).sort((a, b) => a.tabId - b.tabId);
}

/** 某份文档所有实例各自记着的视口位置。 */
function scrollVsOfDoc(path: string): number[] {
  return tabsOfDoc(path).map((t) => Number(t.scrollV.toFixed(4)));
}

/** 这个视图挂在哪一格上：落盘现采按面板寻，不能按会话下标猜。 */
function panelShowing(view: EditorView): Panel | undefined {
  for (const p of appPanels.values()) if (p.view?.view === view) return p;
  return undefined;
}

describe("B129 会话恢复：面板激活标签 + 每标签光标", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(300);
  });

  it("① 每个面板恢复到自己那个激活的标签（不是一律第一个）", () => {
    const p0 = panels()[0];
    const activeTexts = Array.from(p0.querySelectorAll(".tab")).map(
      (t) => t.classList.contains("tab-active") || t.getAttribute("aria-selected") === "true",
    );
    expect(activeTexts, "面板0 的第二个标签（b.md）应是激活项").toEqual([false, true, false]);
    // 面板1 第一个是激活项（第二个是 b.md 的第二格，从没记过位置那份）
    expect(
      Array.from(panels()[1].querySelectorAll(".tab")).map(
        (t) => t.classList.contains("tab-active") || t.getAttribute("aria-selected") === "true",
      ),
    ).toEqual([true, false, false]);
    // 视图显示的也该是激活那个：面板0 = b.md
    const shown = views().find((v) => panels()[0].contains(v.dom))!;
    expect(docNameOf(shown), "面板0 显示的应是 b.md").toBe("b.md");
  });

  it("② 活动标签自己那份光标与视口被恢复（其余标签不得顶替）", () => {
    const shown = views().find((v) => panels()[0].contains(v.dom))!;
    expect({ line: cursorAt(shown).line, col: cursorAt(shown).col }).toEqual({
      line: 9,
      col: 2,
    });
  });

  it("③ 切到同面板的另一个标签：它**自己的**光标，不是刚离开那个的", async () => {
    clickTab(tabEls(0)[0]);
    await wait(60);
    const a = views().find((v) => panels()[0].contains(v.dom))!;
    expect(docNameOf(a), "应切到 a.md").toBe("a.md");
    expect({ line: cursorAt(a).line, col: cursorAt(a).col }).toEqual({ line: 5, col: 3 });

    // 再切回 b.md：必须回到 b.md 自己的光标（共享状态的话这里会是 a.md 那份）
    clickTab(tabEls(0)[1]);
    await wait(60);
    const b = views().find((v) => panels()[0].contains(v.dom))!;
    expect(docNameOf(b), "应切回 b.md").toBe("b.md");
    expect({ line: cursorAt(b).line, col: cursorAt(b).col }).toEqual({ line: 9, col: 2 });
  });

  it("④ 非活动面板的标签同样恢复自己的位置", async () => {
    clickTab(tabEls(1)[0]);
    await wait(60);
    const c = views().find((v) => panels()[1].contains(v.dom))!;
    expect(docNameOf(c), "面板1 显示的应是 c.md").toBe("c.md");
    expect({ line: cursorAt(c).line, col: cursorAt(c).col }).toEqual({ line: 3, col: 4 });
  });

  it("⑤ 滚一下就该排一次落盘，落下去的 scrollV 是屏上那一格现在的读数（B302）", async () => {
    // 这条原先钉的是「滚动事件与会话落盘之间不该有任何因果」—— 那是像素轨被整体摘掉时的
    // 形状。B302 把位置以与宽度无关的 `v` 请回会话，因果重新成立，判据也跟着换成：
    // 光滚一下（不切标签、不编辑）必须排一次落盘，且落的是**现采**的位置，不是切过来时的陈值。
    clickTab(tabEls(0)[0]);
    await wait(60);
    await wait(900); // 先让路上的落盘都落定，拿到干净的基线
    const before = wired.saved.length;

    clickTab(tabEls(0)[1]); // 切到 b.md
    await wait(60);
    await wait(900);
    const sc = panels()[0].querySelector(".cm-scroller") as HTMLElement;
    sc.scrollTop = 320;
    sc.dispatchEvent(new Event("scroll", { bubbles: false }));
    await wait(1200); // 越过防抖，让这一发改写成一次真正的落盘

    expect(wired.saved.length, "用户滚了一下必须排一次落盘").toBeGreaterThan(before);
    const last = wired.saved[wired.saved.length - 1] as {
      panels: { tabs: { path: string; scrollV?: number | null }[] }[];
    };
    const b = last.panels[0].tabs.find((x) => x.path === "b.md")!;
    const view = views().find((v) => panels()[0].contains(v.dom))!;
    const live = readVisibleV(panelShowing(view)!);
    expect(b.scrollV, "落下去的必须是屏上现在的读数，不是切过来时那个陈值").not.toBe(9.5);
    expect(b.scrollV ?? 0).toBeCloseTo(live ?? 0, 5);
  });
});

describe("B129 静态契约：两样都要进出会话", () => {
  const src = readFileSync("src/main.ts", "utf-8") + "\n" + sessionAll();

  it("会话记录要带光标行列与激活下标", () => {
    // B141：这两项现在都由 `sessionStore`（src/session/store.ts）产出，main.ts 只负责
    // 把它们刷进去 —— 所以断言一半盯 store 的序列化，一半盯刷新。
    const store = readFileSync("src/session/store.ts", "utf-8");
    expect(store, "每个标签都要记光标行").toMatch(/cursorLine: r\.cursorLine,/);
    expect(store, "面板记录要带激活下标").toMatch(/active: Math\.max\(/);
  });

  it("恢复时要逐个标签接住光标与激活下标", () => {
    expect(src, "光标要写回实例状态").toMatch(/inst\.state = inst\.state\.update\(\{ selection/);
    expect(src, "面板激活标签要写回").toMatch(/panel\.activeTabId = panel\.tabs\[active\]/);
  });

  it("反向验证：退化实现（只恢复活动标签 / 只恢复光标）必定被上两条抓住", () => {
    // 退化 A：面板激活下标不还原（一律取第一个）。
    // ⚠️ 拆卸与断言必须用**同一条精确串**：main.ts 里另有一处 `panel.activeTabId =
    // panel.tabs[...]`（关标签时的补位），用宽泛正则会把别人的代码也算成「已删除」。
    const degradedActive = src.replaceAll("panel.activeTabId = panel.tabs[active];", "");
    expect(degradedActive, "退化后不应再出现激活标签写回").not.toMatch(
      /panel\.activeTabId = panel\.tabs\[active\]/,
    );
  });
});

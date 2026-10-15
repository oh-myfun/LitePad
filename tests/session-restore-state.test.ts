// @vitest-environment jsdom
// B129 · 会话恢复必须覆盖两件事：① 每个面板**激活的标签**、② 每个标签**各自的光标**。
// （③ 各自的视图位置 —— 滚动记忆/还原已随同步滚动重构整体移除，不再恢复。）
//
// 为什么需要这一整份用例：cursor-keep.test.ts 喂给恢复流程的会话里所有标签都是
// `cursorLine: 1` —— 于是「只恢复了活动标签」和「每个标签都恢复」在那些断言里长得
// 一模一样，等于没在测。这里给每个标签安排**不同的**行/列，任何一处只恢复
// 一份、或大家共用同一份，都会当场露馅。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { sessionAll } from "./static";
import { EditorView } from "@codemirror/view";

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
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 5,
              cursorCol: 3,
            },
            {
              path: "b.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 9,
              cursorCol: 2,
            },
          ],
        },
        // 面板1：一个标签
        {
          active: 0,
          tabs: [
            {
              path: "c.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 3,
              cursorCol: 4,
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
      tabId: 0,
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
    expect(activeTexts, "面板0 的第二个标签（b.md）应是激活项").toEqual([false, true]);
    // 面板1 唯一那个是激活项
    expect(
      Array.from(panels()[1].querySelectorAll(".tab")).map(
        (t) => t.classList.contains("tab-active") || t.getAttribute("aria-selected") === "true",
      ),
    ).toEqual([true]);
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

  it("⑤ 滚动事件不再触发会话落盘（位置记忆已移除的反向契约）", async () => {
    // 同步滚动 / 位置记忆整体清除后，滚动事件与会话落盘之间不该再有任何因果：
    // 谁要是把 scroll 监听（或 recordScroll 那类写槽）加回来，这条就得红。
    clickTab(tabEls(0)[0]);
    await wait(60);
    await wait(900); // 先让路上的落盘都落定，拿到干净的基线
    const before = wired.saved.length;

    clickTab(tabEls(0)[1]); // 切到 b.md
    const sc = panels()[0].querySelector(".cm-scroller") as HTMLElement;
    sc.scrollTop = 0;
    sc.dispatchEvent(new Event("scroll", { bubbles: false }));
    await wait(900); // 越过 800ms 防抖

    expect(wired.saved.length, "滚动事件不该再排一次落盘").toBe(before);
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

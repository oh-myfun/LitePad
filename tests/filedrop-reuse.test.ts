// @vitest-environment jsdom
// B131 · 拖一个**已经打开过**的文件进窗口：落点和原位置不同 ⇒ 不要动原来那个标签，
// 在落点另开一个同源实例；落点就是原位置 ⇒ 仍是「复用」（不新建、不搬走）。
//
// 为什么用真事件驱动：这条链路的入口是 Rust 的 `tauri://drag-drop`（路径桥回传），
// 光对着源码做文本断言分不清「判据写对了」和「判据压根没跑到」。这里把 webview 的
// `onDragDropEvent` 回调**截获**下来，再按真实载荷喂它，走的是线上那条路。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
});

/** 截获拖放回调：喂给它的是 `{ type, paths, position }`（物理像素，jsdom 下 dpr=1）。 */
const dropHandler = vi.hoisted(() => ({
  cb: null as
    | ((ev: {
        payload: { type: string; paths: string[]; position: { x: number; y: number } };
      }) => void)
    | null,
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
    // 关键：把回调留下来，测试里直接调
    onDragDropEvent: (cb: (ev: unknown) => void) => {
      dropHandler.cb = cb as typeof dropHandler.cb;
      return Promise.resolve({ unlisten: () => {} });
    },
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
  open: () => Promise.resolve(null),
  save: () => Promise.resolve(null),
}));

/** 第一次按路径打开是「新开」，之后 Rust 会回 `reused: true`。 */
let opened = 0;

vi.mock("../src/ipc/api", () => ({
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve(["UTF-8"]),
  listEols: () => Promise.resolve(["CRLF", "LF"]),
  // 左右两块面板：a.txt 开在**左**边，右边空着 —— 这样「落点=原位置」和
  // 「落点≠原位置」才有区别（单面板下拖到哪儿都落在同一块，测不出判据）。
  // 会话里的 layout 是**索引**（0 基），恢复时经 idMap 换成真实面板 id。
  loadSession: () =>
    Promise.resolve({
      activePanel: 0,
      panels: [
        {
          active: 0,
          tabs: [
            {
              path: "a.txt",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 1,
              cursorCol: 1,
              scrollTop: null,
            },
          ],
        },
        { active: -1, tabs: [] },
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
    Promise.resolve({ tabId: 1, name: "未命名", readonly: false, encoding: "UTF-8", eol: "CRLF" }),
  openFile: (path: string) => {
    opened += 1;
    return Promise.resolve({
      tabId: 0,
      // 与 Rust 一致：同一个路径第二次打开时复用文档（`reused` 为真）
      reused: opened > 1,
      text: `alpha\nbeta\ngamma\n`,
      name: path,
      path,
      encoding: "UTF-8",
      eol: "LF",
      readonly: false,
      mixedEol: false,
      sizeClass: "normal",
      sizeHint: "",
    });
  },
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
  saveSession: () => Promise.resolve(),
  saveSettings: () => Promise.resolve(),
  writeBackup: () => Promise.resolve(),
  restoreBackup: () => Promise.resolve(null),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
}));

/** 面板横向排布（每个 200x200，间隔 10）：落点判定与命中测试都靠它。 */
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
installRectStubs();

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 落下 n 个文件到坐标（物理像素，与 Rust 载荷同口径）。 */
function dropFiles(paths: string[], x: number, y: number): void {
  expect(dropHandler.cb, "应已装上拖放收接").toBeTruthy();
  dropHandler.cb!({ payload: { type: "drop", paths, position: { x, y } } });
}

function panelEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll(".layout-panel")) as HTMLElement[];
}
/** 每个面板里各显示着哪份文档的首行（jsdom 里靠视图内容反推）。 */
function shownFirstLineOf(panelIdx: number): string {
  const v = EditorView.findFromDOM(panelEls()[panelIdx].querySelector(".cm-editor") as HTMLElement);
  return v ? (v.state.doc.toString().split("\n")[0] ?? "") : "";
}
function allTabCount(): number {
  const strips = Array.from(document.querySelectorAll(".panel-tabstrip"));
  return strips.reduce((n, s) => n + s.querySelectorAll(".tab").length, 0);
}

describe("B131 拖入已打开的文件：落点不同就别动原标签", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(300);
  });

  it("前置：会话已打开一份 a.txt（面板0）", () => {
    expect(panelEls().length, "应有两个面板").toBe(2);
    expect(allTabCount(), "恢复后应只有一个标签").toBe(1);
    expect(shownFirstLineOf(0)).toContain("alpha");
  });

  it("落点就是原位置（面板0 中央）⇒ 复用：不新建、不搬走", async () => {
    dropFiles(["a.txt"], 100, 100); // 面板0 中央
    await wait(120);
    expect(allTabCount(), "同一位置应复用，不该多出标签").toBe(1);
    expect(shownFirstLineOf(0), "面板0 仍显示 a.txt").toContain("alpha");
  });

  it("落点不同（面板1 中央）⇒ 在落点另开一个实例，原来的标签照旧在原地", async () => {
    dropFiles(["a.txt"], 310, 100); // 面板1 中央
    await wait(120);
    expect(allTabCount(), "落点不同应多出一个同源实例").toBe(2);
    expect(shownFirstLineOf(0), "面板0 原来的标签必须还在").toContain("alpha");
    expect(shownFirstLineOf(1), "面板1 也应显示同一份文件").toContain("alpha");
  });

  it("再落回原位置：复用那一个，总数不变（不会越拖越多）", async () => {
    dropFiles(["a.txt"], 100, 100);
    await wait(120);
    expect(allTabCount(), "复用不应新增标签").toBe(2);
    expect(shownFirstLineOf(0), "面板0 仍是原来那个标签").toContain("alpha");
  });

  it("反向验证：这个判据不是恒真的（退化实现会把它做成「永远跳回原面板」）", () => {
    const src = readFileSync("src/main.ts", "utf-8");
    // 退化：不看落点，一律取第一个实例（修复前的写法）
    const degraded = src.replaceAll(
      "const inTarget =\n        targetPanelId !== undefined ? all.find((t) => t.panelId === targetPanelId) : undefined;",
      "const inTarget = undefined;",
    );
    expect(degraded, "退化后应不再有按落点挑实例的判据").not.toMatch(
      /const inTarget =[\s\S]{0,120}?targetPanelId/,
    );
    expect(src, "正向实现必须真的按落点挑实例").toMatch(
      /all\.find\(\(t\) => t\.panelId === targetPanelId\)/,
    );
  });
});

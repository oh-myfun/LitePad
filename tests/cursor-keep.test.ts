// @vitest-environment jsdom
// B126 · 编辑器光标 / 视口位置不得因「切换标签 / 重建布局 / 关闭窗口」而复位。
//
// 为什么必须自己存取：CM6 的滚动位置只活在 `scrollDOM.scrollTop` 上，**不进
// EditorState**。切标签是 `view.setState()`（重建 ViewState）、重建布局是视图
// 销毁重建 —— 两种都会把视口拉回文档开头。光标随 EditorState 走，但滚动位置
// 必须由 main.ts 在切走前记、切回后还。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";
import { fireDrag, makeDataTransfer } from "./dnd";

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
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve({ unlisten: () => {} }),
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
  open: () => Promise.resolve(null),
  save: () => Promise.resolve(null),
}));

/** 最后一次落盘的会话（B126：断言 scrollTop 真的进去了）。 */
const savedSession = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock("../src/ipc/api", () => ({
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve(["UTF-8"]),
  listEols: () => Promise.resolve(["CRLF", "LF"]),
  loadSession: () =>
    Promise.resolve({
      activePanel: 0,
      panels: [
        {
          active: 0,
          tabs: [
            { path: "a.md", encoding: "UTF-8", viewMode: "source", cursorLine: 1, cursorCol: 1 },
          ],
        },
        {
          active: 0,
          tabs: [
            { path: "a.md", encoding: "UTF-8", viewMode: "source", cursorLine: 1, cursorCol: 1 },
            { path: "b.md", encoding: "UTF-8", viewMode: "source", cursorLine: 1, cursorCol: 1 },
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
      hot_exit: true,
    }),
  logEvent: () => {},
  newTab: () =>
    Promise.resolve({ tabId: 1, name: "未命名", readonly: false, encoding: "UTF-8", eol: "CRLF" }),
  openFile: (_path: string) =>
    Promise.resolve({
      tabId: _path === "a.md" ? 101 : 102,
      text: _path === "a.md" ? "alpha\nbeta\ngamma\ndelta\nepsilon" : "second document from B",
      name: _path,
      path: _path,
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
  saveSession: (s: Record<string, unknown>) => {
    savedSession.last = s;
    return Promise.resolve();
  },
  saveSettings: () => Promise.resolve(),
  writeBackup: () => Promise.resolve(),
  restoreBackup: () => Promise.resolve(null),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
}));

function mouse(type: string, x: number, y: number): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
}
/** 真实点击 = mousedown + click（mousedown 会重置拖拽吞击标记）。 */
function clickTab(tab: HTMLElement): void {
  tab.dispatchEvent(mouse("mousedown", 5, 5));
  tab.dispatchEvent(mouse("click", 5, 5));
}

/** 面板按文档顺序横向排布（每个 200x200，间隔 10），标签条 20x24：jsdom 无布局，
 *  命中测试（panelAt / tabUnder）全靠该桩。与 smoke 用例同一套坐标。 */
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

/** 所有挂载中的编辑器视图。 */
function views(): EditorView[] {
  return Array.from(document.querySelectorAll(".cm-editor"))
    .map((dom) => EditorView.findFromDOM(dom as HTMLElement))
    .filter((v): v is EditorView => !!v);
}

describe("B126 编辑器光标 / 视口不得复位", () => {
  it("切换标签再切回：光标位置不变", async () => {
    await import("../src/main");
    await wait(300);

    const panels = Array.from(document.querySelectorAll(".layout-panel")) as HTMLElement[];
    expect(panels.length, "应有两个面板").toBe(2);
    // 面板1 有 a.md / b.md 两个标签，用它做切换
    const strip = panels[1].querySelectorAll(".tab") as NodeListOf<HTMLElement>;
    expect(strip.length, "面板1 应有两个标签").toBe(2);

    const view = views()[1];
    expect(view, "面板1 应挂载编辑器").toBeTruthy();
    expect(view.state.doc.toString()).toContain("gamma");

    // 光标摆到第 3 行第 3 列（"gamma" 里），并滚到 60px
    const CARET = view.state.doc.line(3).from + 2;
    const SCROLL = 60;
    view.dispatch({ selection: { anchor: CARET } });
    view.scrollDOM.scrollTop = SCROLL;
    await wait(40);

    // 切到 b.md 再切回 a.md
    clickTab(strip[1]);
    await wait(60);
    expect(views()[1].state.doc.toString(), "应切到 b.md").toContain("second document");

    const back = panels[1].querySelectorAll(".tab")[0] as HTMLElement;
    clickTab(back);
    await wait(60);

    const now = views()[1];
    expect(now.state.doc.toString(), "应切回 a.md").toContain("gamma");
    expect(now.state.selection.main.head, "光标必须还在原处").toBe(CARET);
    expect(now.scrollDOM.scrollTop, "视口必须还在原处").toBe(SCROLL);
  });

  it("重建布局（标签拖去分屏）：光标与视口都跟着走", async () => {
    const CARET_LINE = 4;
    const SCROLL = 120;
    const panels = Array.from(document.querySelectorAll(".layout-panel")) as HTMLElement[];

    // 面板0 的 a.md 上摆好光标与视口
    const v0 = views()[0];
    const CARET = v0.state.doc.line(CARET_LINE).from + 1;
    v0.dispatch({ selection: { anchor: CARET } });
    v0.scrollDOM.scrollTop = SCROLL;
    await wait(40);
    expect(v0.state.selection.main.head, "前置：面板0 光标已就位").toBe(CARET);

    // 把面板0 的标签拖到面板1 的左侧区域 → splitPanelWithTab → rebuildLayout
    // （视图销毁重建：新的 scrollDOM，滚动位置天然是 0，只能靠显式还原）
    const restoreRects = installRectStubs();
    const tab0 = panels[0].querySelector(".tab") as HTMLElement;
    const dt = makeDataTransfer();
    fireDrag("dragstart", tab0, dt, { clientX: 10, clientY: 12 });
    fireDrag("dragover", document, dt, { clientX: 215, clientY: 100 });
    fireDrag("drop", document, dt, { clientX: 215, clientY: 100 });
    fireDrag("dragend", tab0, dt, { clientX: 215, clientY: 100 });
    restoreRects();
    await wait(80);

    const carried = views().find(
      (v) => v.state.doc.toString().includes("gamma") && v.state.selection.main.head === CARET,
    );
    expect(carried, "被搬走的标签应带着自己的光标出现在新面板").toBeTruthy();
    expect(carried!.scrollDOM.scrollTop, "重建视图后视口必须还原，不能停在开头").toBe(SCROLL);
  });

  it("关闭窗口：会话要带上光标行列与视口位置", async () => {
    // 触发一次会话落盘（handleUpdate → scheduleSessionSave，800ms 防抖）
    const v = views()[0];
    v.dispatch({ changes: { from: 0, insert: "X" } });
    await wait(1100);

    const sess = savedSession.last as unknown as {
      panels: Array<{ tabs: Array<Record<string, unknown>> }>;
    };
    expect(sess, "会话应已落盘").toBeTruthy();
    const allTabs = sess.panels.flatMap((p) => p.tabs);
    expect(allTabs.length, "会话里应有标签").toBeGreaterThan(0);
    for (const t of allTabs) {
      expect(typeof t.cursorLine, "每个标签都要记光标行").toBe("number");
      expect("scrollTop" in t, "标签记录必须带 scrollTop 字段").toBe(true);
    }
    // 至少有一个标签带着非 0 的视口位置（上面刚滚过）
    expect(
      allTabs.some((t) => typeof t.scrollTop === "number" && t.scrollTop > 0),
      "滚过的标签进会话时必须带上视口位置",
    ).toBe(true);
    // 光标行列必须是**此刻**的：a.md 上摆的是第 4 行
    expect(
      allTabs.some((t) => t.path === "a.md" && t.cursorLine === 4),
      `会话里的光标行应为 4，实际：${JSON.stringify(allTabs)}`,
    ).toBe(true);
  });

  it("反向验证：退化实现（只 setState / 只重建视图、不还原滚动）必然丢视口", async () => {
    // 这条用例回答「上面的断言是不是恒真」：平台不会替我们保留视口，
    // 所以「重建后 scrollTop === 原值」只有显式还原才成立。
    const src = views()[0];
    src.scrollDOM.scrollTop = 200;
    await wait(20);

    // 退化替身：新建一个视图（等价于 rebuildLayout 的 mountView），只带 EditorState，
    // 不做任何滚动还原 —— 这正是修复前的写法。
    const host = document.createElement("div");
    document.body.appendChild(host);
    const degraded = new EditorView({ state: src.state, parent: host });
    expect(
      degraded.scrollDOM.scrollTop,
      "退化实现必须回到开头（否则「显式还原」这条修复就是多余的）",
    ).toBe(0);
    degraded.destroy();
    host.remove();
  });
});

describe("B126 静态契约：滚动位置必须自己存取", () => {
  const src = readFileSync("src/main.ts", "utf-8");

  it("必须有成对的「记住 / 还原」两个helper，且还原真的写回 scrollTop", () => {
    expect(src, "切走前要记住滚动位置").toContain("function rememberViewScroll");
    expect(src, "切回后要还原滚动位置").toContain("function restoreViewScroll");
    expect(src, "还原必须把快照里的值写回 scrollDOM（光调 helper 名不算）").toMatch(
      /view\.scrollDOM\.scrollTop = t\.scrollTop/,
    );
  });

  it("反向验证：删掉写回那一行，上一条断言必须失败", () => {
    const degraded = src.replace(/view\.scrollDOM\.scrollTop = t\.scrollTop;/, "// 已删除");
    expect(degraded).not.toBe(src);
    expect(degraded, "退化后不应再匹配到写回语句（否则这条断言形同虚设）").not.toMatch(
      /view\.scrollDOM\.scrollTop = t\.scrollTop/,
    );
  });

  it("销毁视图的每一处现场都必须先记住滚动位置", () => {
    // 两处：rebuildLayout 的循环、disposePanel。少了任何一处，
    // 「重建布局后视口归零」就会复活。
    const destroySites = src.match(/\.view\.destroy\(\)/g) ?? [];
    expect(destroySites.length, "视图销毁现场应恰好两处").toBe(2);
    const rememberSites = src.match(/rememberViewScroll\(/g) ?? [];
    // 定义 1 处 + 调用 ≥ 2 处（两处销毁 + 切标签）
    expect(rememberSites.length, "记住滚动的调用点应覆盖所有销毁现场").toBeGreaterThanOrEqual(3);
    for (const site of ["rebuildLayout", "disposePanel"]) {
      const start = src.indexOf(`function ${site}`);
      expect(start, `应能定位 ${site}`).toBeGreaterThan(-1);
      const body = src.slice(start, start + 1200);
      expect(body, `${site} 销毁视图前必须记住滚动位置`).toContain("rememberViewScroll(");
    }
  });

  it("切标签 / 接管标签的每一处 setState 之后都必须还原滚动", () => {
    const setStateSites = src.match(/panel\.view\.setState\(/g) ?? [];
    expect(setStateSites.length, "面板视图的整态切换应至少三处").toBeGreaterThanOrEqual(3);
    const restoreSites = src.match(/restoreViewScroll\(/g) ?? [];
    // 定义 1 处 + 调用点（切标签 / 关标签 / 挂载 / 搬标签 / 重建实例 …）
    expect(restoreSites.length, "还原滚动的调用点必须覆盖所有整态切换").toBeGreaterThanOrEqual(6);
  });

  it("会话与跨窗口载荷都要带 scrollTop", () => {
    expect(src, "会话记录要带 scrollTop").toMatch(/scrollTop: scrollTopOfTab\(/);
    expect(src, "恢复会话时要接住 scrollTop").toMatch(/inst\.scrollTop = st\.scrollTop/);
    const api = readFileSync("src/ipc/api.ts", "utf-8");
    expect(api, "TabSession 要有 scrollTop").toContain("scrollTop?: number | null");
    expect(api, "SatelliteTab 要有 scrollTop").toContain("scrollTop: number | null");
    const rust = readFileSync("src-tauri/src/session/mod.rs", "utf-8");
    expect(rust, "Rust 会话结构要有 scroll_top，否则落盘时被丢掉").toContain(
      "pub scroll_top: Option<u32>",
    );
  });
});

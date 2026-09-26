// @vitest-environment jsdom
// B129 · 会话恢复必须覆盖三件事：① 每个面板**激活的标签**、② 每个标签**各自的光标**、
// ③ 每个标签**各自的视图位置**。
//
// 为什么需要这一整份用例：cursor-keep.test.ts 喂给恢复流程的会话里所有标签都是
// `cursorLine: 1` —— 于是「只恢复了活动标签」和「每个标签都恢复」在那些断言里长得
// 一模一样，等于没在测。这里给每个标签安排**不同的**行/列/视口，任何一处只恢复
// 一份、或大家共用同一份，都会当场露馅。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";
import {
  installViewportSpy,
  lastViewportTarget,
  settleViewport,
  takeViewportTargets,
} from "./viewport-target";

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

/** 每个标签各给一份互不相同的「行/列/视口」（故意与下面的 mock 值一一对应）。 */
function docText(name: string): string {
  return Array.from({ length: 20 }, (_, i) => `${name} line ${i + 1}`).join("\n");
}

vi.mock("../src/ipc/api", () => ({
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve(["UTF-8"]),
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
              // B136：编辑器侧的位置是**顶行行号**（逻辑坐标，与文档长度无关）
              topLine: 8,
              scrollTop: null,
            },
            {
              path: "b.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 9,
              cursorCol: 2,
              topLine: 15,
              scrollTop: null,
            },
          ],
        },
        // 面板1：两个标签，激活的是第二个（d.md）—— 用例先切到 d.md 再切回 c.md，
        // 这样「每个标签各记各的位置」才测得到（点一个已经激活的标签是早退的）
        {
          active: 1,
          tabs: [
            {
              path: "c.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 3,
              cursorCol: 4,
              topLine: 4,
              scrollTop: null,
            },
            {
              path: "d.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 1,
              cursorCol: 1,
              topLine: 12,
              scrollTop: null,
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
  saveSession: () => Promise.resolve(),
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
  return { line: line.number, col: head - line.from + 1 };
}
/** 偏移落在第几行。 */
function lineOfPos(view: EditorView, pos: number): number {
  return view.state.doc.lineAt(Math.min(Math.max(pos, 0), view.state.doc.length)).number;
}
/**
 * 恢复时「按哪一行定位」是不是指定行（B136）。
 *
 * jsdom 不做布局，CM6 的 `editorHeight` 恒为 0，`scrollIntoView` 效果投递了却不会
 * 落到 `scrollDOM.scrollTop` 上 —— 所以看**定位目标**（真实投递出来的效果），
 * 而不是最终 px。想要「最终落到了第几行」，请用 `settleViewport` 先替浏览器落位。
 */
function restoredTo(view: EditorView, line: number): boolean {
  return takeViewportTargets().some((t) => lineOfPos(view, t.pos) === line);
}

/**
 * 把面板视图里「上一次定位」的那一行真正落进 `scrollDOM`（jsdom 专用的一步）。
 *
 * 真机上 CM6 的 measure 会把 `scrollIntoView` 的效果写到 `scrollDOM.scrollTop` 上，
 * 于是「切走时记顶行」记到的是用户实际看到的那一行。jsdom 里这步不会发生，视图的
 * scrollTop 恒为 0，`rememberViewScroll` 就会把位置记成第 1 行（看起来像「位置丢了」）。
 * 这里按刚投递出来的定位目标补一次落位，用例才能测到「每个标签各记各的」。
 */
/** 面板里挂载着的编辑器视图。 */
function viewOf(panelIdx: number): EditorView {
  return views().find((v) => panels()[panelIdx].contains(v.dom))!;
}
/** 标签条上第 i 个标签对应的文件路径（从视图内容反推，jsdom 无 data 属性保证）。 */
function docNameOf(view: EditorView): string {
  return (view.state.doc.toString().split("\n")[0] ?? "").split(" line")[0];
}

describe("B129 会话恢复：面板激活标签 + 每标签光标 + 每标签视图位置", () => {
  beforeAll(async () => {
    installViewportSpy(); // 要在 src/main 之前装：启动时的恢复也是一次定位
    await import("../src/main");
    await wait(300);
  });

  it("① 每个面板恢复到自己那个激活的标签（不是一律第一个）", () => {
    const p0 = panels()[0];
    const activeTexts = Array.from(p0.querySelectorAll(".tab")).map(
      (t) => t.classList.contains("tab-active") || t.getAttribute("aria-selected") === "true",
    );
    expect(activeTexts, "面板0 的第二个标签（b.md）应是激活项").toEqual([false, true]);
    // 面板1 激活的是第二个（d.md）
    expect(
      Array.from(panels()[1].querySelectorAll(".tab")).map(
        (t) => t.classList.contains("tab-active") || t.getAttribute("aria-selected") === "true",
      ),
    ).toEqual([false, true]);
    // 视图显示的也该是激活那个：面板0 = b.md
    const shown = views().find((v) => panels()[0].contains(v.dom))!;
    expect(docNameOf(shown), "面板0 显示的应是 b.md").toBe("b.md");
  });

  it("② 活动标签自己那份光标与视口被恢复（其余标签不得顶替）", () => {
    const shown = views().find((v) => panels()[0].contains(v.dom))!;
    // 先替浏览器把启动那次定位落进 scrollDOM：不然下一步「切走时记顶行」记的是
    // jsdom 里那个恒为 0 的 scrollTop（= 第 1 行），下面的断言就成了自欺欺人。
    settleViewport(viewOf(0), 15);
    expect(cursorAt(shown), "b.md 应回到第 9 行第 2 列").toEqual({ line: 9, col: 2 });
    expect(restoredTo(shown, 15), "b.md 应定位回它自己那一行（15）").toBe(true);
  });

  it("③ 切到同面板的另一个标签：它**自己的**光标与视口，不是刚离开那个的", async () => {
    clickTab(tabEls(0)[0]);
    await wait(60);
    const a = views().find((v) => panels()[0].contains(v.dom))!;
    expect(docNameOf(a), "应切到 a.md").toBe("a.md");
    expect(cursorAt(a), "a.md 应回到第 5 行第 3 列").toEqual({ line: 5, col: 3 });
    const leftAt = lineOfPos(a, lastViewportTarget()!.pos); // 切走前 a.md 停在第几行
    expect(leftAt, "前置：a.md 应停在它的第 8 行").toBe(8);
    expect(restoredTo(a, 8), "a.md 应定位回它自己那一行（8），不是刚离开那个的 15").toBe(true);

    // 再切回 b.md：必须回到 b.md 自己的位置（共享视口的话这里会是 a.md 的那一行）
    settleViewport(viewOf(0), 8); // 先替浏览器把 a.md 的定位落进 scrollDOM
    clickTab(tabEls(0)[1]);
    await wait(60);
    const b = views().find((v) => panels()[0].contains(v.dom))!;
    expect(docNameOf(b), "应切回 b.md").toBe("b.md");
    expect(cursorAt(b), "b.md 应回到自己的第 9 行").toEqual({ line: 9, col: 2 });
    expect(
      restoredTo(b, 15),
      "切回 b.md 要定位到第 15 行（=a.md 离开时停的那一行时就是共享视口了）",
    ).toBe(true);
  });

  it("④ 非活动面板的标签同样恢复自己的位置", async () => {
    // 面板1 里激活的是 d.md：先切到后台那个 c.md，再切回来，两个都要各归各的
    settleViewport(viewOf(1), 12); // 同上：先替浏览器把启动时的定位落进 scrollDOM
    clickTab(tabEls(1)[0]);
    await wait(60);
    const c = views().find((v) => panels()[1].contains(v.dom))!;
    expect(docNameOf(c), "面板1 应显示 c.md").toBe("c.md");
    expect(cursorAt(c), "c.md 应回到第 3 行第 4 列").toEqual({ line: 3, col: 4 });
    expect(restoredTo(c, 4), "c.md 应定位回它自己那一行（4），不是 d.md 的 12").toBe(true);

    settleViewport(viewOf(1), 4);
    clickTab(tabEls(1)[1]);
    await wait(60);
    const d = views().find((v) => panels()[1].contains(v.dom))!;
    expect(docNameOf(d), "应切回 d.md").toBe("d.md");
    expect(restoredTo(d, 12), "d.md 应定位回它自己那一行（12），不是 c.md 的 4").toBe(true);
  });
});

describe("B129 静态契约：三样都要进出会话", () => {
  const src = readFileSync("src/main.ts", "utf-8");

  it("会话记录要同时带光标行列、视口与激活下标", () => {
    expect(src, "每个标签都要记光标行").toMatch(/cursorLine:/);
    expect(src, "每个标签都要记视口位置").toMatch(/\.\.\.viewportOfTab\(/);
    expect(src, "面板记录要带激活下标").toMatch(/active: Math\.max\(/);
  });

  it("恢复时要逐个标签接住这三样", () => {
    expect(src, "光标要写回实例状态").toMatch(/inst\.state = inst\.state\.update\(\{ selection/);
    expect(src, "视口要写回实例快照").toMatch(/inst\.topLine = st\.topLine \?\? null;/);
    expect(src, "面板激活标签要写回").toMatch(/panel\.activeTabId = panel\.tabs\[active\]/);
  });

  it("反向验证：退化实现（只恢复活动标签 / 只恢复光标）必定被上两条抓住", () => {
    // 退化 A：不逐个标签接住视口（比如只处理活动标签那一个）
    // 注意用 replaceAll —— main.ts 里有两处写回（会话恢复 / 跨窗口接管），
    // 只摘掉一处时正则仍能在另一处匹配到，断言就会变成假绿。
    const degradedCursor = src.replaceAll(/inst\.topLine = st\.topLine \?\? null;/g, "// 已删除");
    expect(degradedCursor, "退化后不应再匹配视口写回").not.toMatch(/inst\.topLine = st\.topLine/);
    // 退化 B：面板激活下标不还原（一律取第一个）。
    // ⚠️ 拆卸与断言必须用**同一条精确串**：main.ts 里另有一处 `panel.activeTabId =
    // panel.tabs[...]`（关标签时的补位），用宽泛正则会把别人的代码也算成「已删除」。
    const degradedActive = src.replaceAll("panel.activeTabId = panel.tabs[active];", "");
    expect(degradedActive, "退化后不应再出现激活标签写回").not.toMatch(
      /panel\.activeTabId = panel\.tabs\[active\]/,
    );
  });
});

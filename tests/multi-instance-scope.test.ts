// @vitest-environment jsdom
// 「同一文件打开多份时，**无需关联**光标和滚动位置」（用户拍板，B149）。
//
// 当前基线：同源多实例之间**只同步文本**（`syncDocInstances` 只派发 `{ changes }`），
// 光标、视口、视图模式各归各的 —— 同步滚动模式是后面的独立需求，现在不做。
//
// 这条用例把这条**基线**钉住：它不是一个可以随手改的偏好，而是下面几条契约共同
// 撑着的现状 —— 一旦有人为了「方便」把光标/视口也串起来，这些用例就得先变红。
// 将来真要做同步滚动模式，应该把这里整段替换成新口径，而不是在这里开洞。
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

/** 同一个 a.md 开两份：左面板光标在末行、视口 600；右面板光标在开头、视口 120。 */
const LEFT = { cursorLine: 30, scrollTop: 600 } as const;
const RIGHT = { cursorLine: 2, scrollTop: 120 } as const;

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
      // 左右两块面板各挂一个实例 —— 「同一份文档的两个实例同时可见」才有得比
      panels: [
        {
          active: 0,
          tabs: [
            {
              path: "a.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 30,
              cursorCol: 1,
              viewMode: "source",
              scrollTop: 600,
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
              cursorLine: 2,
              cursorCol: 1,
              viewMode: "source",
              scrollTop: 120,
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
      text: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"),
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

/** 第 i 块面板的编辑器容器。 */
function panelScroller(i: number): HTMLElement {
  const panel = document.querySelectorAll(".layout-panel")[i] as HTMLElement | undefined;
  const el = panel?.querySelector(".cm-scroller") as HTMLElement | null;
  if (!el) throw new Error(`第 ${i} 块面板的编辑器没挂载`);
  return el;
}
/** 第 i 块面板的 EditorView（取它才能读光标与文档，光看 DOM 读不到）。 */
function panelView(i: number): EditorView {
  const panel = document.querySelectorAll(".layout-panel")[i] as HTMLElement | undefined;
  const editor = panel?.querySelector(".cm-editor") as HTMLElement | null;
  if (!editor) throw new Error(`第 ${i} 块面板没挂载编辑器`);
  const v = EditorView.findFromDOM(editor);
  if (!v) throw new Error(`第 ${i} 块面板的 EditorView 找不到`);
  return v;
}
/** 用户滚容器：派发一发 scroll，走的正是生产环境那条监听。 */
function setScroll(el: HTMLElement, px: number): void {
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}

describe("B149 同源多实例：只同步文本，光标与视口各归各的", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(300);
  });

  it("两个实例都挂在各自面板上（用例才有得比）", () => {
    expect(document.querySelectorAll(".layout-panel").length).toBe(2);
    expect(panelView(0)).toBeTruthy();
    expect(panelView(1)).toBeTruthy();
  });

  it("左边滚到 600，右边的视口不许跟着动", async () => {
    // 先给右边一个明确的落点，再动左边 —— 「右边的值被动过」才判得出来
    setScroll(panelScroller(1), RIGHT.scrollTop);
    await wait(60);
    setScroll(panelScroller(0), LEFT.scrollTop);
    await wait(120);

    expect(
      panelScroller(1).scrollTop,
      `右边的视口应仍是 ${RIGHT.scrollTop}，不该被左边的滚动带着走`,
    ).toBe(RIGHT.scrollTop);
  });

  it("左边改文本：右边文本同源跟着变，但光标与视口都不被搬走", async () => {
    const leftView = panelView(0);
    const rightView = panelView(1);
    const rightHeadBefore = rightView.state.selection.main.head;
    const rightScrollBefore = panelScroller(1).scrollTop;
    const lenBefore = rightView.state.doc.length;

    // 一次真实的编辑：走 handleUpdate → broadcastDocChange → syncDocInstances。
    // 在**末尾**追加 —— 它不影响前面的位置，于是「光标有没有被搬走」看得最清楚。
    leftView.dispatch({
      changes: { from: leftView.state.doc.length, insert: "append-at-end\n" },
    });
    await wait(120);

    const rightText = rightView.state.doc.toString();
    expect(rightText.length, "同一个文档的两份内容应同源（文本要跟着变）").toBe(lenBefore + 14);

    expect(
      rightView.state.selection.main.head,
      "右边光标应仍停在它自己的位置，不该被设成左边的",
    ).toBe(rightHeadBefore);

    expect(
      panelScroller(1).scrollTop,
      `右边视口应仍是 ${rightScrollBefore}，不该被左边这次编辑带着走`,
    ).toBe(rightScrollBefore);
  });
});

const src = readFileSync("src/main.ts", "utf-8");

/** 取出某个函数的**函数体**（从 header 处起做花括号配平）。 */
function bodyOf(header: string, from: string = src): string {
  const at = from.indexOf(header);
  if (at < 0) throw new Error(`找不到 ${header}`);
  const open = from.indexOf("{", at + header.length - 1);
  let depth = 0;
  for (let i = open; i < from.length; i += 1) {
    if (from[i] === "{") depth += 1;
    else if (from[i] === "}") {
      depth -= 1;
      if (depth === 0) return from.slice(open, i + 1);
    }
  }
  throw new Error(`${header} 的花括号没配平`);
}

describe("B149 静态契约：同源实例只接文本，不许顺手接光标/视口", () => {
  it("syncDocInstances 只派发文本变更", () => {
    const body = bodyOf("function syncDocInstances(");
    expect(body, "文本同步的出口要还在").toMatch(/dispatch\(\{ changes \}\)/);
    // 「只同步文本」的意思是**派发的那笔事务里只有文本** —— 顺手把 selection
    // 塞进去，看起来就是「帮兄弟实例挪了光标」。
    expect(body, "派发时不许带 selection：那是把光标同步出去了，不是同步文本").not.toMatch(
      /dispatch\(\{[^}]*selection/,
    );
    expect(body, "不许碰视口：写兄弟实例的 scrollTop 等于把两个实例的视口焊在一起").not.toMatch(
      /scrollTop/,
    );
  });

  it("光标只写自己那份记录，不外溢到兄弟实例", () => {
    const body = bodyOf("function handleUpdate(");
    expect(body, "光标一律写自己的 tabId").toMatch(/sessionStore\.setCursor\(tab\.tabId,/);
    // 按 tabId 寻址是硬要求：一旦改成「按 docId 找兄弟」，就等于把光标同步了
    expect(body, "定位要按 tabId，不能按 docId 广播").not.toMatch(
      /setCursor\(instancesOfDoc\(|setCursor\(.*docId/,
    );
  });

  it("反向验证：把 selection 塞进派发、或按 docId 广播光标，上面几条必须变红", () => {
    const withSel = src.replace(
      "        p.view.view.dispatch({ changes });",
      "        p.view.view.dispatch({ changes, selection: { anchor: 0 } });",
    );
    expect(withSel, "退化版要真的换了写法").not.toBe(src);
    expect(bodyOf("function syncDocInstances(", withSel)).toMatch(/dispatch\(\{[^}]*selection/);

    const broadcast = src.replace(
      "sessionStore.setCursor(tab.tabId, caretLine.number, caretPos - caretLine.from + 1);",
      "for (const sib of instancesOfDoc(tab.docId)) sessionStore.setCursor(sib.tabId, caretLine.number, caretPos - caretLine.from + 1);",
    );
    expect(broadcast, "退化版要真的换了写法").not.toBe(src);
    expect(bodyOf("function handleUpdate(", broadcast)).toMatch(/setCursor\(sib\.tabId/);
  });
});

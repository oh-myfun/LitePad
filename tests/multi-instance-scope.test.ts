// @vitest-environment jsdom
// 「同一文件打开多份时，文本同源、光标各归各」——B149 的这一半仍然成立，且本文件锁定它
// （`syncDocInstances` 只派发 `{ changes }`，绝不带 cursor / scrollTop）。
//
// 但「视口（滚动位置）」的同步已由 B152 同步滚动接管（2026-10-16 重新引入）：B152 开
// （默认）→ 同 docId 的 editor/preview/其它面板 视口同步；B152 关 → 同文档多实例视口
// 各归各（即 B149 当初钉的「视口不跟随」基线，在 B152 关时成立）。跨窗视口独立仍由 B178
// 广播链维持 inert，不在本文件范围。
//
// 本文件分两块动态用例：① B152 开 —— 同 docId 多实例视口跟随；② B152 关 —— 同 docId
// 多实例视口独立（B149 基线）。后者把「别顺手把视口串起来」钉住；一旦有人在 syncDocInstances
// 里塞 cursor/scrollTop，下面静态契约用例就得先变红。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";
import { tabs } from "../src/core/app-state";
import { syncCoordinator } from "../src/sync-scroll/wire";

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
/**
 * 静默摆位：只写 scrollTop、**不派发 scroll**。
 * 用来给右边铺一个已知起点。派发 scroll 的话右边就成了 driver，会向左边广播并留下一笔
 * 在途承诺；紧接着再动左边，左边那发就被账本判成「我们没兑现的承诺」而被补写按住 ——
 * 于是右边永远看不到左边过来（账本的正确行为，但不是这条用例想测的东西）。
 */
function placeSilently(el: HTMLElement, px: number): void {
  el.scrollTop = px;
}

/**
 * 用户滚容器：设 scrollTop 并派发 scroll。
 * 协调器只听 `scroll`（落定后的位置），`wheel` 之类手势事件本身不驱动广播，所以
 * T7 时代「先派发 wheel 解除结构性锁」那一行已经跟着那把锁一起删掉了。
 */
function setScroll(el: HTMLElement, px: number): void {
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}

/** 启动真实 app（main 已挂到 document.body，含两个 a.md 面板）。 */
async function bootApp(): Promise<void> {
  await import("../src/main");
  await wait(300);
}
/** 当前在册 tab 的 docId（两个 a.md 实例共享同一 docId，协调器即按它分组）。 */
function currentDocId(): string {
  const tab = [...tabs.values()][0];
  if (!tab) throw new Error("没拿到 tab，无法定位 docId");
  return String(tab.docId);
}

describe("B152 开（默认）：同 docId 多实例视口同步", () => {
  beforeAll(async () => {
    await bootApp();
    // 默认即开；显式置位以免疫后续用例改了全局状态。
    syncCoordinator.setEnabled(currentDocId(), true);
  });

  it("两个实例都挂在各自面板上（用例才有得比）", () => {
    expect(document.querySelectorAll(".layout-panel").length).toBe(2);
    expect(panelView(0)).toBeTruthy();
    expect(panelView(1)).toBeTruthy();
  });

  it("左边滚到 600，右边视口跟着走（同 docId 视口同步，B152 开）", async () => {
    // 先给右边一个明确的落点，再动左边 —— 右边的值「被带过去」才判得出来
    placeSilently(panelScroller(1), RIGHT.scrollTop);
    await wait(80);
    setScroll(panelScroller(0), LEFT.scrollTop);
    await wait(150);

    const right = panelScroller(1).scrollTop;
    const left = panelScroller(0).scrollTop;
    expect(
      right,
      `B152 开时同 docId 视口应同步：右边应离开 ${RIGHT.scrollTop} 跟着左边走`,
    ).not.toBe(RIGHT.scrollTop);
    expect(
      Math.abs(right - left),
      `右边应跟到左边附近（允许行高取整：左边 ${left} / 右边 ${right}）`,
    ).toBeLessThan(80);
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

describe("B152 关：同 docId 多实例视口独立（B149 基线在此成立）", () => {
  beforeAll(async () => {
    await bootApp();
    syncCoordinator.setEnabled(currentDocId(), false);
  });

  it("左边滚到 600，右边视口不许跟着动（B152 关，B149 基线）", async () => {
    placeSilently(panelScroller(1), RIGHT.scrollTop);
    await wait(80);
    setScroll(panelScroller(0), LEFT.scrollTop);
    await wait(150);

    expect(
      panelScroller(1).scrollTop,
      `B152 关时同 docId 视口应各自独立：右边应仍是 ${RIGHT.scrollTop}，不该被左边的滚动带着走`,
    ).toBe(RIGHT.scrollTop);
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

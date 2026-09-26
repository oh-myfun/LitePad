// @vitest-environment jsdom
// B136 · 「恢复的位置会往后偏」。
//
// 会话里存的是 px（`scrollTop`），而 px 是**渲染坐标**：行高、换行、文档长度一变，
// 同一个数值就落到另一行上（实测「滚到第 123 行，重启后第 133 行」）。行号是逻辑坐标，
// 与渲染无关 —— 所以编辑器侧的视口位置改成存**可视区顶行行号** `topLine`，还原时按行号
// 定位（把那一行顶到视口顶部），不再回写 px。
//
// px 并没有整条丢掉：**纯预览**侧仍用 `scrollTop`（预览是 HTML 块流，没有稳定行坐标）。
// 两个字段各管一段，不共用一个槽（混用会把「编辑器顶行」污染成 0，B129 那个坑）。
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

/** 最后一次落盘的会话（B132：滚动要自己排程，关窗前那一刻也得存）。 */
const wired = vi.hoisted(() => ({
  saved: [] as { panels: { tabs: { path: string; topLine: number | null }[] }[] }[],
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
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve({ unlisten: () => {} }) }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
  open: () => Promise.resolve(null),
  save: () => Promise.resolve(null),
}));

/** 60 行文本：够把顶行摆在文档中间。 */
const docText = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");

vi.mock("../src/ipc/api", () => ({
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve(["UTF-8"]),
  listEols: () => Promise.resolve(["CRLF", "LF"]),
  // 两个标签各记一份**互不相同**的顶行：共享一个值就测不出「谁定位到了谁」
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
              cursorLine: 12,
              cursorCol: 1,
              topLine: 12,
              scrollTop: null,
            },
            {
              path: "b.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 1,
              cursorCol: 1,
              topLine: 30,
              scrollTop: null,
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
      text: docText,
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
  saveSession: (state: { panels: { tabs: { path: string; topLine: number | null }[] }[] }) => {
    wired.saved.push(state);
    return Promise.resolve();
  },
  saveSettings: () => Promise.resolve(),
  writeBackup: () => Promise.resolve(),
  restoreBackup: () => Promise.resolve(null),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
}));

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── jsdom 几何桩 ──────────────────────────────────────────────────────────────
// CM6 要量出「一行多高 / 视口多高」才会去算行块位置，进而把 `scrollIntoView` 的效果
// 落到 `scrollDOM.scrollTop` 上。jsdom 不做布局，两者皆 0 —— 于是「按行号定位」整条
// 链路都量不到东西。这里补上**真实量级**的几何：面板 600x600、行高 18px（60 行≈1080px）。
const VIEW_H = 600;
/** 行高可改：用例要靠它复现「渲染一变，px 锚点就漂」。 */
const geom = { lineH: 18 };
function setLineHeight(px: number): void {
  geom.lineH = px;
}

function installRectStubs(): void {
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
    if (this.classList.contains("cm-line")) return mk(0, 0, 200, geom.lineH);
    if (this.classList.contains("layout-panel")) {
      const idx = Array.from(document.querySelectorAll(".layout-panel")).indexOf(this);
      return mk(Math.max(0, idx) * 610, 0, 600, VIEW_H);
    }
    if (this.classList.contains("tab")) return mk(0, 0, 20, 24);
    return mk(0, 0, 600, VIEW_H);
  };
  // CM6 读 `view.scrollDOM.clientHeight` 当视口高（jsdom 恒 0）
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("cm-scroller") ? VIEW_H : 0;
    },
  });
}
installRectStubs();

function panelView(): EditorView {
  const dom = document.querySelector(".layout-panel .cm-editor") as HTMLElement | null;
  if (!dom) throw new Error("面板里没有编辑器");
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error("找不到 EditorView");
  return view;
}
function clickTab(i: number): void {
  const tabs = Array.from(document.querySelectorAll(".layout-panel .tab")) as HTMLElement[];
  const el = tabs[i];
  el.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
  );
  el.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
  );
}
/** 该视图里第 n 行的偏移量。 */
function posOfLine(view: EditorView, line: number): number {
  return view.state.doc.line(line).from;
}
/** 一次定位目标落在第几行。 */
function lineOfPos(view: EditorView, pos: number): number {
  return view.state.doc.lineAt(Math.min(Math.max(pos, 0), view.state.doc.length)).number;
}
/** 恢复时有没有排过「定位到第 line 行」。 */
function restoredTo(view: EditorView, line: number): boolean {
  return takeViewportTargets().some((t) => lineOfPos(view, t.pos) === line);
}
/**
 * 某个 px 位置正对着第几行（只看**量过的**行块）。
 *
 * ⚠️ 别直接拿 `view.lineBlockAtHeight(px)`：它先查视口内的行块，查不到就退回
 * `heightMap`，而 jsdom 里只有视口附近的行块真被量过、`heightMap` 全是 0，
 * 于是「高度 → 行」这条路量出来恒是最后一行（实测 px=2200 落回第 60 行）。
 * 行块 top 随行号单调，反过来扫一遍就准 —— 口径与源码 `topVisibleLineOf` 一致
 * （`px+1` 落在哪个行块里，就是哪一行）。
 */
function topLineAt(view: EditorView, px: number): number {
  const at = px + 1;
  const last = view.state.doc.lines;
  for (let n = 1; n <= last; n++) {
    const b = view.lineBlockAt(posOfLine(view, n));
    if (b.top <= at && at < b.top + b.height) return n;
  }
  return last;
}
/** 当前 scrollDOM 正对着的可视区顶行。 */
function currentTopLine(view: EditorView): number {
  return topLineAt(view, view.scrollDOM.scrollTop);
}

describe("B136 视口位置记行号，不记 px", () => {
  beforeAll(async () => {
    installViewportSpy(); // 要在 src/main 之前装：启动时的恢复也是一次定位
    await import("../src/main");
    await wait(300);
  });

  it("① 存：滚过之后落盘的载荷里是顶行行号，px 槽留空", async () => {
    const view = panelView();
    const sc = view.scrollDOM;
    sc.scrollTop = 400; // 约第 23 行
    sc.dispatchEvent(new Event("scroll", { bubbles: false }));
    await wait(900); // 越过 800ms 防抖

    const tab = wired.saved[wired.saved.length - 1]?.panels[0]?.tabs[0];
    expect(tab, "滚动应已排程落盘").toBeTruthy();
    const at = topLineAt(view, sc.scrollTop);
    expect(tab!.topLine, `落盘的位置应是滚过之后那一行（${at}），不是会话里那份 12`).toBe(at);
    expect(tab!.topLine, "滚过了就别再照抄会话里的旧值").not.toBe(12);
    expect(tab!.scrollTop, "编辑器侧的 px 槽必须留空（位置归 topLine）").toBeNull();
  });

  it("② 还原：会话里那个行号就是恢复时瞄准的行", () => {
    // 启动即恢复：会话里 a.md 记的是第 12 行
    expect(restoredTo(panelView(), 12), "启动时应按 topLine 定位到第 12 行").toBe(true);
  });

  it("③ 漂：渲染一变，px 锚点就漂走，行号锚点原地不动", async () => {
    const view = panelView();

    // 前置：此刻视口确实停在第 12 行
    settleViewport(view, 12);
    expect(currentTopLine(view), "前置：视口应停在第 12 行").toBe(12);
    // 那一刻若按老办法存 px，存下来就是这个高度
    const anchorPx = view.lineBlockAt(posOfLine(view, 12)).top;
    expect(anchorPx, "px 锚点应是可验证的高度").toBeGreaterThan(0);

    // 「没保存的编辑 / 换行变化」把视口上方的行撑高了：行高 18 → 30
    setLineHeight(30);
    // ⚠️ 光 requestMeasure 不成：CM6 只在**文档真的变了**时才重跑测量（实测
    // requestMeasure 等 300ms 高度纹丝不动，末尾插一个字符才按新行高重算）。
    // 插在文档末尾 —— 在视口下方，不影响下面的行号断言。
    view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } });
    await wait(120);
    expect(view.contentHeight, "前置：测量应已按新行高重跑").toBeGreaterThan(anchorPx);

    // 反证：同一份 px 现在对不上原来那一行了 —— 老办法恢复就会「往后偏」
    const drifted = currentTopLine(view);
    expect(drifted, `px 锚点应已漂到别的行（现在落在第 ${drifted} 行）`).not.toBe(12);

    // 行号锚点（会话里那个 12）是逻辑坐标，不受渲染影响：切走再切回，仍瞄准第 12 行
    settleViewport(view, 12);
    clickTab(1); // b.md（会话里第 30 行）
    await wait(60);
    expect(restoredTo(view, 30), "切到 b.md 应按它自己的第 30 行定位").toBe(true);

    settleViewport(view, 30);
    clickTab(0); // 切回 a.md
    await wait(60);
    expect(
      restoredTo(view, 12),
      "行高变了，还原仍瞄准第 12 行（位置由文档结构决定，不由渲染决定）",
    ).toBe(true);
  });
});

describe("B136 静态契约：编辑器侧不许回写 px", () => {
  const src = readFileSync("src/main.ts", "utf-8");

  it("还原一律按行号定位，编辑器视口不得再被写 px", () => {
    expect(lastViewportTarget, "定位记录器应还在（守卫跑错文件的话这里会立刻红）").toBeTypeOf(
      "function",
    );
    expect(src, "还原要按 topLine 定位").toMatch(
      /const line = view\.state\.doc\.line\(Math\.min\(t\.topLine[^)]*\)\);/,
    );
    // 之前是 `pinScrollTop(view.scrollDOM, t.scrollTop)` —— 那条路已经拆掉
    expect(src, "编辑器侧不得再把 px 写回 scrollDOM").not.toMatch(
      /view\.scrollDOM\.scrollTop = t\.scrollTop|pinScrollTop\(view\.scrollDOM/,
    );
  });

  it("反向验证：退化成回写 px，上一条必须失败", () => {
    const ANCHOR = /const line = view\.state\.doc\.line\(Math\.min\(t\.topLine[^)]*\)\);/;
    const degraded = src.replace(
      ANCHOR,
      "const line = view.state.doc.line(1); // B136 退化：改回写 px",
    );
    expect(degraded, "退化实现应真的换了写法").not.toBe(src);
    expect(degraded, "退化后不应再有按行定位（否则这条断言形同虚设）").not.toMatch(ANCHOR);
  });
});

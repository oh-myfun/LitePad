// @vitest-environment jsdom
// 用户报的同步滚动错乱（3 实例同文档，B270）：
//   左分屏一个源码标签 + 一个预览标签（同文档 a.md），右分屏一个预览（同文档）。
//   两个预览激活并同步滚动 ⇒ 然后「激活左分屏源码」⇒ 发现源码位置和预览对不上；
//   再「激活左分屏预览」⇒ 滚动位置跳变。
//
// ⚠️⚠️ 第一版复现失败（3/3 全绿）—— 桩漏了真机一维：**估算行高**。
//   `switchTab` 里 `flushPendingSyncCursor` 的补写发生在 `setState` 之后、measure 之前，
//   CM6 的 heightMap 还是**估算行高**（B256 已证真机 estimate ≠ 实测：写 1222 落 858）。
//   换出来的 `top` 是「估算空间」的像素，钉上后 measure 换成实测排版，同一个 px 对应的
//   就是另一行 ⇒ 源码与预览「对不上」；切回预览时 `syncSourceSnapshot` 按这份歪位采 `v`
//   ⇒ 两个预览被推得「跳变」。jsdom 里 CM6 的估算恰好与桩几何一致 ⇒ bug 不可见 ⇒ 全绿。
//
//   补法：覆写 `EditorView.prototype` 的 `setState` / `lineBlockAt` / `lineBlockAtHeight`
//   （jsdom 桩盲区 #4 的既定手法：两个都得覆、动态求值别写进闭包），建模
//   「刚 setState ⇒ 估算行高 EST_ROW=20；measure 完成后 ⇒ 实测 ROW=14」。
//   rAF 包装器先 `unmeasuredViews.clear()` 再跑回调 —— 模拟「CM6 的 measure 在同一帧里
//   先于产品的 rAF 回调完成」。
//
// 几何：24 行 md、实测行高 14、估算行高 20、块高 42、视口 60。
// 取 X = 200（两侧都在范围内，避免 clamp 把一侧裁掉造成假象）。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

const ROWS = 24;
const ROW = 14;
const EST_ROW = 20;
const BLOCK = ROW * 3;
const VIEW_H = 60;
const MD = Array.from({ length: ROWS }, (_, i) => `# 标题 ${i + 1}`).join("\n");

const editorMax = Infinity;
const previewMax = Infinity;

// ── 估算行高维度（见文件头）────────────────────────────────────────────────────
// 刚 `setState` 过的视图 =「未测量」⇒ `lineBlockAt*` 按估算行高答；下一帧 rAF 回调跑之前
// 先清掉（CM6 的 measure 在同一帧先完成）⇒ 之后按实测行高答。
// ⚠️ `@codemirror/view` 不能在测试文件顶部静态 import（与 vi.mock 提升相互作用，
//    vitest 收集期直接报「failed to find the runner」）—— 在 beforeAll 里动态拿。
const unmeasuredViews = new Set<unknown>();
type DocLike = {
  lines: number;
  lineAt(pos: number): { from: number; to: number };
  line(n: number): { from: number };
};
const rawRaf = window.requestAnimationFrame.bind(window);
const settleThenRun = (cb: FrameRequestCallback): number =>
  rawRaf((t: number) => {
    unmeasuredViews.clear(); // measure 先于本帧其余 rAF 回调完成
    cb(t);
  });

async function installEstimateOverrides(): Promise<void> {
  const ev = (await import("@codemirror/view")).EditorView;
  const realSetState = ev.prototype.setState;
  ev.prototype.setState = function (this: unknown, ...args: unknown[]) {
    (realSetState as (...a: unknown[]) => void).apply(this, args);
    unmeasuredViews.add(this);
  };
  const proto = ev.prototype as unknown as Record<string, unknown>;
  proto.lineBlockAt = function (this: { state: { doc: DocLike } }, pos: number) {
    const unit = unmeasuredViews.has(this) ? EST_ROW : ROW;
    const line = this.state.doc.lineAt(pos);
    return { from: line.from, to: line.to, top: (line.number - 1) * unit, height: unit };
  };
  proto.lineBlockAtHeight = function (this: { state: { doc: DocLike } }, y: number) {
    const unit = unmeasuredViews.has(this) ? EST_ROW : ROW;
    const n = Math.min(this.state.doc.lines, Math.max(1, Math.floor(y / unit) + 1));
    const line = this.state.doc.line(n);
    return { from: line.from, to: line.to, top: (n - 1) * unit, height: unit };
  };
}

beforeAll(() => {
  window.requestAnimationFrame = settleThenRun;
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
  const elProto = window.Element.prototype as unknown as { getBoundingClientRect: () => DOMRect };
  elProto.getBoundingClientRect = function (this: Element): DOMRect {
    const el = this as HTMLElement;
    const isRoot = el.classList.contains("md-preview");
    const isLine = el.classList.contains("cm-line");
    const isBlock = el.classList.contains("md-block");
    const idx = Math.max(0, Array.prototype.indexOf.call(el.parentElement?.children ?? [], el));
    const top = isRoot ? el.scrollTop : isLine ? idx * ROW : isBlock ? idx * BLOCK : idx * ROW;
    const height = isRoot ? VIEW_H : isLine ? ROW : isBlock ? BLOCK : 0;
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
  const protoRects = window.Element.prototype as unknown as { getClientRects: () => DOMRectList };
  protoRects.getClientRects = function (this: Element): DOMRectList {
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
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

// 左面板：tab0 = 源码、tab1 = 预览（同文档 a.md）；active = 1（启动即预览，使源码离屏藏在
// mode-preview 面板里 —— 这正是 `applySyncToSibling` 里 `rulerHidden` 那条分支）。
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
      panels: [
        {
          active: 1,
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
  logLevel: () => Promise.resolve("trace"),
  setLogLevel: () => Promise.resolve(),
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
  takePendingFiles: () => Promise.resolve([]),
}));

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function hostPanels(): HTMLElement[] {
  return Array.from(document.querySelectorAll(".panel-host")) as HTMLElement[];
}
function srcEl(): HTMLElement {
  const el = hostPanels()[0]?.querySelector(".cm-scroller") as HTMLElement | null;
  if (!el) throw new Error("源码编辑器没挂载");
  return el;
}
function leftPv(): HTMLElement {
  const el = hostPanels()[0]?.querySelector(".md-preview") as HTMLElement | null;
  if (!el) throw new Error("左预览没挂载");
  return el;
}
function rightPv(): HTMLElement {
  const el = hostPanels()[1]?.querySelector(".md-preview") as HTMLElement | null;
  if (!el) throw new Error("右预览没挂载（分屏没发生？）");
  return el;
}
function userScroll(el: HTMLElement, px: number): void {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: px }));
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}
function tabEl(i: number): HTMLElement {
  const el = document.querySelectorAll(".layout-panel .tab")[i] as HTMLElement | undefined;
  if (!el) throw new Error(`标签 ${i} 没渲染`);
  return el;
}
const clamped = new WeakSet<HTMLElement>();
function installClamp(el: HTMLElement, max: () => number): void {
  if (clamped.has(el)) return;
  clamped.add(el);
  let st = el.scrollTop;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => st,
    set: (v: number) => {
      st = Math.min(Math.max(v, 0), Math.min(max(), naturalMax(el)));
    },
  });
  const isEditor = el.classList.contains("cm-scroller");
  const unit = isEditor ? ROW : BLOCK;
  const hidden = (): boolean => {
    const host = el.closest(".panel-host") as HTMLElement | null;
    return !!host && host.classList.contains("mode-preview");
  };
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => (hidden() ? 0 : VIEW_H),
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () =>
      hidden()
        ? 0
        : Math.max(VIEW_H, el.parentElement?.children.length ? countUnits(el) * unit : unit),
  });
}
function countUnits(el: HTMLElement): number {
  return el.querySelectorAll(
    el.classList.contains("cm-scroller") ? ".cm-line" : "[data-line-start]",
  ).length;
}
function appliedBleed(el: HTMLElement): number {
  const name = el.classList.contains("cm-scroller") ? "--cm-bleed-bottom" : "--md-bleed-bottom";
  return Number.parseFloat(el.style.getPropertyValue(name)) || 0;
}
function naturalMax(el: HTMLElement): number {
  const isEditor = el.classList.contains("cm-scroller");
  const rows = isEditor
    ? el.querySelectorAll(".cm-line").length
    : el.querySelectorAll("[data-line-start]").length;
  return Math.max(0, rows * (isEditor ? ROW : BLOCK) + appliedBleed(el) - VIEW_H);
}
function splitTab(dir: "h" | "v"): void {
  const tabs = Array.from(
    document.querySelectorAll(".layout-panel .panel-tabstrip .tab"),
  ) as HTMLElement[];
  const tab = tabs.find((t) => t.classList.contains("tab-active"));
  tab?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const label = dir === "h" ? "左右分屏" : "上下分屏";
  const btn = Array.from(document.querySelectorAll<HTMLElement>(".popup-menu > button")).find(
    (b) => b.querySelector(".menu-label")?.textContent === label,
  );
  if (!btn) throw new Error(`右键菜单里没有「${label}」`);
  btn.click();
}

const X = 200;
// 预览顶行游标：块 idx 4（第 5 行）覆盖 168..210，ratio = (200-168)/42。
const vX = 5 + (X - 4 * BLOCK) / BLOCK;
// `sourceTopOfV` 互逆换算：base=5 ⇒ lineTop=(5-1)×ROW，行内比例 × ROW。
const expectedSrcPx = 4 * ROW + (vX - 5) * ROW;

describe("同步滚动错乱：左源码+左预览+右预览，切换源码后位置对不上 / 回预览跳变", () => {
  beforeAll(async () => {
    await installEstimateOverrides();
    await import("../src/main");
    await wait(500);
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click(); // 开同步（三个同文档实例 ⇒ 多实例闸放行）
    await wait(220);
    // 启动即预览态（active=1），源码离屏藏在 mode-preview 面板里 ⇒ 先制造右分屏预览
    installClamp(srcEl(), () => editorMax);
    installClamp(leftPv(), () => previewMax);
    splitTab("h");
    await wait(600);
    // 右分屏预览已建 ⇒ 装它的钳位（右面板纯预览、无编辑器）
    installClamp(rightPv(), () => previewMax);
    await wait(60);
  });

  it("① 右预览滚到 X ⇒ 左预览跟着到 X（同步建立，前提）", async () => {
    expect(hostPanels().length, "前提：分屏出了两个面板").toBe(2);
    userScroll(rightPv(), X);
    await wait(400);
    expect(rightPv().scrollTop, "前提：右预览在 X").toBeCloseTo(X, 6);
    expect(leftPv().scrollTop, "前提：左预览同步到 X").toBeCloseTo(X, 6);
  });

  it("② 激活左源码 ⇒ 源码落点须与预览同一游标（用户：对应不上）", async () => {
    userScroll(rightPv(), X);
    await wait(400);
    tabEl(0).click(); // 左分屏切到源码标签
    await wait(400);
    // 源码此刻在屏、可读。它必须落在 `sourceTopOfV(vX)`（≈66.67，实测空间）。
    // 若补写发生在 measure 之前（估算行高 heightMap），落点是估算空间的 ≈95.24 ⇒ 红。
    expect(srcEl().scrollTop, "源码落点 = vX 换算的源码像素（不得落成估算空间的 px）").toBeCloseTo(
      expectedSrcPx,
      0,
    );
    expect(leftPv().scrollTop, "激活源码不许拖动左预览（B247 守卫）").toBeCloseTo(X, 6);
    expect(rightPv().scrollTop, "激活源码不许拖动右预览").toBeCloseTo(X, 6);
  });

  it("③ 接 ②（源码停在歪位上）⇒ 切回左预览不得跳变（用户：跳变）", async () => {
    // ⚠️ 这里**不许**再 userScroll：那一发会把左源码（此刻在屏、量得出）按 B248 修正回
    //    实测空间，用户症状就没了 —— 用户是在「激活源码看到歪位」**之后直接**切回预览的。
    tabEl(1).click(); // → 回预览
    await wait(400);
    expect(leftPv().scrollTop, "切回预览：左预览应仍停在 X，不得跳变").toBeCloseTo(X, 6);
    expect(rightPv().scrollTop, "切回预览：右预览须仍停在 X（同步不被源码歪值污染）").toBeCloseTo(
      X,
      6,
    );
  });
});

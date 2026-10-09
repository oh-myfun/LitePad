// @vitest-environment jsdom
// ⚠️⚠️ 金标准端到端验证台（用户拍定，B271）：
//
//   「所有同文件标签不管是否激活，滚动位置都完全一致（代码和预览之间位置通过换算公式
//   严格对齐），切换标签、切换模式、分屏变化、复制标签、打开侧边预览（分屏+复制标签）
//   都不会改变原有和新增标签的滚动位置。」
//
// 落地方式：**日志式端到端审计** —— 完整跑一遍操作矩阵，每个检查点用 `audit()` 把
// 当前所有同文档实例（在屏的源码格 / 预览格）的滚动位置按换算公式折算成规范游标 v
// **打到日志里**（console.log，vitest 输出可见），再断言全部与 v* 严格一致。
// 隐藏实例的检验 = roundTrip（逐标签激活读屏）：激活本身也是金标准的一项操作
// （「切换标签不改变位置」），激活后读到的就是它槽里的真实位置。
//
// 几何：24 行标题 md、实测行高 14、估算行高 20（B270 盲区 #5）、块高 42、视口 60。
// v* = 5.761905（预览 px=200；源码 px=66.67）；v2 = 9.5（源码 px=119；预览 px=357）。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

const ROWS = 24;
const ROW = 14;
const EST_ROW = 20;
const BLOCK = ROW * 3;
const VIEW_H = 60;
const MD = Array.from({ length: ROWS }, (_, i) => `# 标题 ${i + 1}`).join("\n");

const V1 = 5 + (200 - 4 * BLOCK) / BLOCK; // 5.761905（预览 px=200）
const V2 = 9.5;

// ── 桩（与 B270 同族：几何 rect + 估算行高 + rAF settle）───────────────────────
const unmeasuredViews = new Set<unknown>();
const rawRaf = window.requestAnimationFrame.bind(window);
const settleThenRun = (cb: FrameRequestCallback): number =>
  rawRaf((t: number) => {
    unmeasuredViews.clear(); // measure 先于本帧其余 rAF 回调完成
    cb(t);
  });

type DocLike = {
  lines: number;
  lineAt(pos: number): { from: number; to: number };
  line(n: number): { from: number };
};

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

vi.mock("../src/ipc/api", () => ({
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

// ── DOM / 几何助手 ─────────────────────────────────────────────────────────────
function hostPanels(): HTMLElement[] {
  return Array.from(document.querySelectorAll(".panel-host")) as HTMLElement[];
}
function layoutPanels(): HTMLElement[] {
  return Array.from(document.querySelectorAll(".layout-panel")) as HTMLElement[];
}
function tabsOf(panelIdx: number): HTMLElement[] {
  return Array.from(
    layoutPanels()[panelIdx]?.querySelectorAll(".panel-tabstrip .tab") ?? [],
  ) as HTMLElement[];
}
function scrollerOf(panelIdx: number): HTMLElement | null {
  return (hostPanels()[panelIdx]?.querySelector(".cm-scroller") as HTMLElement) ?? null;
}
function previewOf(panelIdx: number): HTMLElement | null {
  return (hostPanels()[panelIdx]?.querySelector(".md-preview") as HTMLElement) ?? null;
}
function modeOf(panelIdx: number): "source" | "preview" | "split" {
  const host = hostPanels()[panelIdx];
  if (!host) throw new Error(`面板 ${panelIdx} 不存在`);
  if (host.classList.contains("mode-preview")) return "preview";
  if (host.classList.contains("mode-split")) return "split";
  return "source";
}
function opBtn(panelIdx: number, ariaPrefix: string): HTMLElement {
  const el = layoutPanels()[panelIdx]?.querySelector(
    `.panel-ops button[aria-label^="${ariaPrefix}"]`,
  ) as HTMLElement | undefined;
  if (!el) throw new Error(`面板 ${panelIdx} 没有按钮 ${ariaPrefix}`);
  return el;
}
function menuClick(label: string): void {
  const tabs = Array.from(
    document.querySelectorAll(".layout-panel .panel-tabstrip .tab"),
  ) as HTMLElement[];
  const tab = tabs.find((t) => t.classList.contains("tab-active"));
  tab?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const btn = Array.from(document.querySelectorAll<HTMLElement>(".popup-menu > button")).find(
    (b) => b.querySelector(".menu-label")?.textContent === label,
  );
  if (!btn) throw new Error(`右键菜单里没有「${label}」`);
  btn.click();
}
function userScroll(el: HTMLElement, px: number): void {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: px }));
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}
/** 活动面板由面板 mousedown 触发（markActivePanel）—— .click() 不会激活面板。 */
function activatePanel(panelIdx: number): void {
  layoutPanels()[panelIdx]?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
}

// 换算公式（与产品互逆的**独立实现**，不复刻产品代码）：
//   源码：v = 行号 + 行内比例，行号 = floor(px/ROW)+1
//   预览：v = 块起始行 + 块内比例（一行一块 ⇒ range=1）
function srcPxToV(px: number): number {
  const line = Math.floor(px / ROW) + 1;
  return line + (px - (line - 1) * ROW) / ROW;
}
function prevPxToV(px: number): number {
  const idx = Math.floor(px / BLOCK);
  return idx + 1 + (px - idx * BLOCK) / BLOCK;
}
function vToSrcPx(v: number): number {
  const line = Math.floor(v);
  return (line - 1) * ROW + (v - line) * ROW;
}

const clamped = new WeakSet<HTMLElement>();
function installClamp(el: HTMLElement): void {
  if (clamped.has(el)) return;
  clamped.add(el);
  const isEditor = el.classList.contains("cm-scroller");
  const unit = isEditor ? ROW : BLOCK;
  let st = el.scrollTop;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => st,
    set: (v: number) => {
      st = Math.min(Math.max(v, 0), Math.max(0, naturalMax(el)));
    },
  });
  const host = el.closest(".panel-host") as HTMLElement | null;
  const hidden = (): boolean =>
    !host ||
    (isEditor && host.classList.contains("mode-preview")) ||
    (!isEditor && host.classList.contains("mode-source"));
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => (hidden() ? 0 : VIEW_H),
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => (hidden() ? 0 : Math.max(VIEW_H, countUnits(el) * unit + appliedBleed(el))),
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
  return Math.max(0, countUnits(el) * (isEditor ? ROW : BLOCK) + appliedBleed(el) - VIEW_H);
}
/** 结构性操作（分屏/复制/切标签/切模式）都会 rebuildLayout 换元素 ⇒ 每步后重装钳位。 */
function syncClamps(): void {
  for (const el of document.querySelectorAll<HTMLElement>(".cm-scroller, .md-preview")) {
    installClamp(el);
  }
}

// ── 金标准审计 ─────────────────────────────────────────────────────────────────
interface AuditEntry {
  where: string;
  v: number;
}
function audit(label: string): AuditEntry[] {
  const out: AuditEntry[] = [];
  hostPanels().forEach((_, i) => {
    const mode = modeOf(i);
    if (mode !== "preview") {
      const sc = scrollerOf(i);
      if (sc && sc.clientHeight > 0) out.push({ where: `P${i}:code`, v: srcPxToV(sc.scrollTop) });
    }
    if (mode !== "source") {
      const pv = previewOf(i);
      if (pv && pv.clientHeight > 0) out.push({ where: `P${i}:prev`, v: prevPxToV(pv.scrollTop) });
    }
  });
  console.log(
    `[audit ${label}] ${out.map((o) => `${o.where}=${o.v.toFixed(3)}`).join("  ") || "(空)"}`,
  );
  return out;
}
function expectAllAt(label: string, expected: number): void {
  const out = audit(label);
  expect(out.length, `${label}: 至少要有一个在屏实例`).toBeGreaterThan(0);
  for (const o of out) {
    expect(o.v, `${label}: ${o.where} 游标偏离`).toBeCloseTo(expected, 1);
  }
}
describe("B273：离屏预览兄弟跟随后，关掉当前标签让其跃升为活动预览应落在跟随游标", () => {
  beforeAll(async () => {
    await installEstimateOverrides();
    await import("../src/main");
    await wait(500);
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click(); // 开同步
    await wait(220);
    syncClamps();
  });

  it("关掉当前源码标签 ⇒ 离屏预览兄弟跃升为活动预览，落在跟随游标 V2（非陈旧 V1）", async () => {
    // 前提：单面板、单标签 a.md，源码态，滚到 V1 建立基准。
    expect(layoutPanels().length, "前提：单面板").toBe(1);
    const sc = scrollerOf(0);
    if (!sc) throw new Error("源码没挂载");
    userScroll(sc, vToSrcPx(V1));
    await wait(400);
    expectAllAt("基准", V1);

    // 复制出第二个同文档标签 T1（与 T0 同 docId）。
    activatePanel(0);
    await wait(200);
    menuClick("复制标签");
    await wait(600);
    syncClamps();
    expect(tabsOf(0).length, "前提：复制出第二个标签").toBe(2);

    // 把 T1 翻成预览态、再切回 T0 源码 ⇒ T0 在屏源码、T1 离屏预览。
    tabsOf(0)[1].click(); // 激活 T1
    await wait(300);
    opBtn(0, "切换到").click(); // T1 翻预览
    await wait(400);
    syncClamps();
    expect(modeOf(0), "T1 翻成预览态").toBe("preview");
    tabsOf(0)[0].click(); // 切回 T0 源码
    await wait(400);
    syncClamps();
    expect(modeOf(0), "切回源码态").toBe("source");

    // 跟随：滚 T0 源码到 V2 ⇒ 离屏的 T1（预览）也应被同步（其 syncV 更新为 V2）。
    // ⚠️ 结构性操作后面板 DOM 已重建 ⇒ 必须重新取 scroller，不能复用前面的 `sc`。
    const sc2 = scrollerOf(0);
    if (!sc2) throw new Error("P0 源码没挂载（跟随前）");
    userScroll(sc2, vToSrcPx(V2));
    await wait(500);
    expectAllAt("跟随后 P0 源码", V2);

    // 关掉 T0（活动源码）⇒ T1 跃升为活动预览，且 closeTab 路径**不经过
    // alignShownToSyncSource 收口** —— 只靠 restorePreviewScroll 读位置。
    // 旧实现读陈旧 scrollTop（离屏时没跟到 V2）⇒ 落回 V1；修后从 syncV 派生 ⇒ 落 V2。
    const closeBtn = tabsOf(0)[0].querySelector(".tab-close") as HTMLElement | null;
    if (!closeBtn) throw new Error("活动标签没有关闭键");
    closeBtn.click();
    await wait(500);
    syncClamps();
    expect(modeOf(0), "T1 跃升为活动预览").toBe("preview");
    // 关键判据：T1 必须落在 V2（跟随游标），而不是陈旧的 V1。
    expectAllAt("T1 跃升后", V2);
  });
});

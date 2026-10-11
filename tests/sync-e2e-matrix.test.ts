// @vitest-environment jsdom
// B261 **端到端矩阵**（用户点名：「端到端验证确认各种情况下的标签切换、源码/预览模式切换、
// 打开侧边预览、新增/减少分屏等情况下滚动位置能否保持一致」）。
//
// ⚠️ 这条用例**不是**四个场景的重复 —— 现有 `sync-*` 那几条是**各自起手、各自几何**，
//    而这里要的是**一条链**：从「单面板整宽」起手，一路走到「三面板窄栏」再关回整宽，
//    **每一步都验同一个游标 `v` 还在不在**。单场景用例拦得住「这一格错了」，拦不住
//    「跨几何换手时丢了」—— 后者只有串起来才会露出来（分屏那一趟按新几何把槽里的
//    像素挪成游标落点，下一趟几何再变，那一格就得重算）。
//
// ⚠️ 判据是**游标**，不是「像素不变」：面板数一变，几何就变 ⇒ 同一游标的**像素**本来
//    就该变（整宽 287 ⇒ 窄栏 95.67 ⇒ 再整宽 287）。要「像素不变」等于要求钉子不跟着
//    尺子走。所以每一步断言都是 **每个可见源码格 / 每个可见预览格都还在同一个 `v` 上**。
//
// 桩与 `sync-split-close.test.ts` 同型（行高 ≠ 块高、scrollTop 带浏览器式裁剪、确定性
// 布局、行几何按面板数实时换算），`rowH()` 按面板数实时换算这一维是**整个矩阵的命门**：
// 几何若恒不变，所有落点恒 287，这条用例就退化成「什么也没测」。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";

/** 源码行高（px）。 */
const ROW = 14;
/** ⚠️ 预览块高（px）：刻意 3 倍于行高 —— 跨侧（块 ⇄ 行）的换算错才量得出来。 */
const BLOCK = ROW * 3;
/** 之源游标 `v`：压在行中间（+7）⇒ 带 0.5 的行内比例。 */
const V = 20.5;

/** 整宽（单面板）⇒ 落点像素 = v × ROW。 */
const WIDE_PX = V * ROW; // 287
/** 窄栏（面板数 ≥ 2）⇒ 落点像素 = v × ROW/3。 */
const NARROW_PX = V * (ROW / 3); // ≈ 95.67
/** 预览那侧：块高与面板数无关 ⇒ 落点像素 = v × BLOCK，全程不变。 */
const PREVIEW_PX = V * BLOCK; // 861

/** md 正文：一行一个标题 ⇒ 预览块 k 与源码行 k+1 一一对应，块顶 = k×BLOCK。 */
const MD = Array.from({ length: 60 }, (_, i) => `# 标题 ${i + 1}`).join("\n");

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;

  const proto = window.Element.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
  };
  // CM6 量行位置走 `getClientRects()[0] ?? getBoundingClientRect()`；jsdom 的
  // getClientRects 恒空 ⇒ 这里补上（否则 CM6 走不到我们的假布局、行位置永远不动）。
  const protoRects = window.Element.prototype as unknown as {
    getClientRects: () => DOMRectList;
  };
  protoRects.getClientRects = function (this: Element): DOMRectList {
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
  };
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    const el = this as HTMLElement;
    const isRoot = el.classList.contains("md-preview");
    const isLine = el.classList.contains("cm-line");
    const idx = Math.max(0, Array.prototype.indexOf.call(el.parentElement?.children ?? [], el));
    const top = isRoot ? el.scrollTop : isLine ? idx * rowH() : idx * BLOCK;
    const height = isRoot ? ROW : isLine ? rowH() : 0;
    // toJSON 是函数，Record<string, number> 装不下 —— 反正下面 as unknown as DOMRect 已逃生
    const r: Record<string, unknown> = {
      top,
      left: 0,
      right: 600,
      bottom: top + height,
      width: 600,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    };
    return r as unknown as DOMRect;
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

// ⚠️ 会话起手：**单面板 + 两个不同文档**（a.md 激活 / b.md）。
//    ① 两个文档 ⇒ 切标签那一步是真的「切走 / 切回」，不是同文档换实例；
//    ② 一个面板 ⇒ 后面「开侧边预览 / 新增分屏」每一步都能让面板数 +1，「关分屏」能 −1，
//       几何这条维度才是活的（几何不变 ⇒ 本用例退化成假绿）。
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
            {
              path: "b.md",
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
}));

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function userScroll(el: HTMLElement, px: number): void {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: px }));
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}

const clamped = new WeakSet<HTMLElement>();

/**
 * 浏览器式裁剪（jsdom 不自己裁）。
 *
 * ⚠️ 上限**不按内容算**：预览这块 DOM 是**异步**撑开的（`previewTimer` + `setBlocks`），
 *    在它还没铺 `[data-line-start]` 时去数行数 ⇒ 数到 0 ⇒ 上限 0 ⇒ **之后每一次赋值都
 *    被裁成 0**（真踩过：切模式到预览那一格恒 0，看着像产品把位置抹了）。内容撑开后
 *    再补这层裁切没有意义 —— 本用例的落点离上限都很远，只需要「别被裁」。
 */
function installClamp(el: HTMLElement): void {
  if (clamped.has(el)) return;
  clamped.add(el);
  let st = el.scrollTop;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => st,
    set: (v: number) => {
      st = Math.min(Math.max(v, 0), Infinity);
    },
  });
}

/**
 * **视觉行高**：真机上分屏 / 关分屏 ⇒ 面板宽度变 ⇒ word_wrap 折行数变 ⇒ 一条逻辑行的
 * 视觉行高变。桩里用「面板数 ≥ 2 就算窄栏」表达这一维。
 */
function rowH(): number {
  return document.querySelectorAll(".layout-panel").length >= 2 ? ROW / 3 : ROW;
}

/** 给 `EditorView` 装上**按 `rowH()` 实时换算**的行几何（必须动态求值，见 `rowH` 那段的⚠️）。 */
function installLineGeometry(): void {
  const proto = EditorView.prototype as unknown as {
    lineBlockAt: unknown;
    lineBlockAtHeight: unknown;
  };
  const blockOf = (view: EditorView, n: number): unknown => {
    const doc = view.state.doc;
    const line = doc.line(Math.min(Math.max(n, 1), doc.lines));
    const top = (line.number - 1) * rowH();
    const height = rowH();
    return { from: line.from, to: line.to, top, height, bottom: top + height };
  };
  proto.lineBlockAt = function (this: EditorView, pos: number): unknown {
    const doc = this.state.doc;
    const line = doc.lineAt(Math.min(Math.max(pos, 0), doc.length));
    return blockOf(this, line.number);
  };
  proto.lineBlockAtHeight = function (this: EditorView, px: number): unknown {
    return blockOf(this, Math.floor(Math.max(0, px) / rowH()) + 1);
  };
}

function panels(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".layout-panel"));
}
/**
 * ⚠️ 宿主（`.panel-host`）上的 `mode-source` / `mode-preview` / `mode-split` 才是「这一格
 *    此刻**看得见的是哪一侧**」的唯一凭据 —— `.cm-scroller` / `.md-preview` 两个都在 DOM
 *    里（预览态只给编辑器 `display:none`，见 `styles/preview.css` 那条
 *    `.panel-host.mode-preview .panel-editor { display: none }`），按元素选会把隐藏的那一
 *    格（scrollTop 恒 0）也数进来 ⇒ 判据全是「实际 0.00」的假绿。
 */
function hosts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".layout-panel .panel-host"));
}
function visibleScroller(host: HTMLElement): HTMLElement | null {
  const c = host.classList;
  if (!c.contains("mode-source") && !c.contains("mode-split")) return null;
  return host.querySelector(".cm-scroller");
}
function visiblePreview(host: HTMLElement): HTMLElement | null {
  const c = host.classList;
  if (!c.contains("mode-preview") && !c.contains("mode-split")) return null;
  return host.querySelector(".md-preview");
}
/** 当前**真的看得见**的源码格元素。 */
function srcEls(): HTMLElement[] {
  return hosts()
    .map(visibleScroller)
    .filter((e): e is HTMLElement => e !== null);
}
/** 当前**真的看得见**的预览格元素。 */
function prevEls(): HTMLElement[] {
  return hosts()
    .map(visiblePreview)
    .filter((e): e is HTMLElement => e !== null);
}
/** 当前**真的看得见**的源码格落点（px）。 */
const srcPxs = (): number[] => srcEls().map((e) => e.scrollTop);
/** 当前**真的看得见**的预览格落点（px）。 */
const prevPxs = (): number[] => prevEls().map((e) => e.scrollTop);

/**
 * 断言「这一格还停在游标 V 上」—— 落点像素按**当前几何**换算（`rowH()` 实时读面板数）。
 *
 * ⚠️ 用 `max` 而不是 `toContain`：断言的是**每一格**，不是「某几格」；
 *    `toContain` 在落点变多时（分屏）会假绿。
 */
function expectCursor(label: string, got: number[], want: number): void {
  const fmt = (n: number): string => n.toFixed(2);
  // ⚠️ 反假绿：一栏一个都没有时，`for` 一次都不转 ⇒ 恒绿。断言「这一栏还在」必须前置。
  if (got.length === 0) throw new Error(`${label}：这一栏一个可见格都没有 ⇒ 本判据会假绿`);
  for (const px of got) {
    expect(
      px,
      `${label}：几何变了 ⇒ 同一游标 V=${V} 该落 ${fmt(want)}（实际 ${fmt(px)}）`,
    ).toBeCloseTo(want, 2);
  }
}

/** 点面板标签（mousedown/mouseup/click 三拍，见 `sync-four-tabs` 那批用例）。 */
function clickTab(panelIdx: number, tabIdx: number): void {
  const tabs = Array.from(
    panels()[panelIdx].querySelectorAll(".panel-tabstrip .tab"),
  ) as HTMLElement[];
  if (!tabs[tabIdx])
    throw new Error(`面板 ${panelIdx} 的第 ${tabIdx} 个标签不存在（共 ${tabs.length}）`);
  const el = tabs[tabIdx];
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.click();
}

/** 源码 / 预览模式切换（Ctrl+/，`tests/sync-four-tabs` 用的那一拍）。 */
function toggleMode(): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "/", ctrlKey: true, bubbles: true, cancelable: true }),
  );
}

/** 面板操作区按 aria-label 前缀找那颗键（只认活动面板会渲染的那几颗 md 键）。 */
function clickPanelOp(labelPrefix: string): void {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>(".panel-op")).find((b) =>
    (b.getAttribute("aria-label") ?? "").startsWith(labelPrefix),
  );
  if (!btn)
    throw new Error(
      `找不到「${labelPrefix}」这颗面板键；现有 = ${
        Array.from(document.querySelectorAll<HTMLButtonElement>(".panel-op"))
          .map((b) => b.getAttribute("aria-label") ?? "")
          .join("/") || "（无）"
      }`,
    );
  btn.click();
}

/** 面板元素（按 `.layout-panel` 的 DOM 序定位，别按 index 猜）。 */
function panelOf(host: HTMLElement): HTMLElement {
  const panel = host.closest(".layout-panel") as HTMLElement | null;
  if (!panel) throw new Error("宿主不在面板里（DOM 序对我不可信）");
  return panel;
}

/** 新增分屏：右键面板里第一个标签 → 「左右分屏」（copy 分支，不是键位的移动式）。 */
function splitH(): void {
  const host = hosts()[0];
  const panel = panelOf(host);
  const tab = panel.querySelector(".panel-tabstrip .tab") as HTMLElement | null;
  if (!tab) throw new Error("这一栏的标签条上没有标签");
  tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const btn = Array.from(document.querySelectorAll<HTMLElement>(".popup-menu > button")).find(
    (b) => b.querySelector(".menu-label")?.textContent === "左右分屏",
  );
  if (!btn) throw new Error("右键菜单里没有「左右分屏」这一项");
  btn.click();
}

/**
 * 减少分屏：面板操作区那颗 ⨯（`onClosePanel` → `closePanelById` → `disposePanel`）。
 * ⚠️ 传的是**面板元素**而不是下标：面板数一变 DOM 序未必是我以为的那个，按 index 去
 *    关会把「关错那一格」伪装成「位置不对」。
 */
function closePanelOp(panel: HTMLElement): void {
  const btn = Array.from(panel.querySelectorAll<HTMLButtonElement>(".panel-op")).find((b) =>
    (b.getAttribute("aria-label") ?? "").startsWith("移除该分屏"),
  );
  if (!btn) throw new Error(`这一栏没有「移除该分屏」这颗键`);
  if (btn.disabled) throw new Error(`这一栏的「移除该分屏」是禁用态（前提破了）`);
  btn.click();
}

describe("B261 端到端矩阵：同一游标在「标签切换 / 模式切换 / 侧边预览 / 新增分屏 / 减少分屏」全程不掉", () => {
  beforeAll(async () => {
    installLineGeometry();
    await import("../src/main");
    await wait(500);
    for (const h of hosts()) {
      for (const el of [visibleScroller(h), visiblePreview(h)]) {
        if (el) installClamp(el);
      }
    }
    expect(panels().length, "前提：从单面板整宽起手").toBe(1);
  });

  it("① 起手：整宽单面板滚到 v=20.5，落点 287", async () => {
    userScroll(srcEls()[0], WIDE_PX);
    await wait(300);
    expect(srcPxs(), "单面板整宽，只有一个源码格").toEqual([WIDE_PX]);
  });

  it("② 标签切换：切走 b.md 再切回 a.md ⇒ a.md 的落点不变（整宽 287）", async () => {
    clickTab(0, 1); // b.md
    await wait(280);
    userScroll(srcEls()[0], 120); // 在 b.md 上随便挪一下，证明「切回来的是 a.md 自己的位置」
    await wait(240);
    expect(srcPxs(), "前提：b.md 停在别处").toEqual([120]);

    clickTab(0, 0); // a.md
    await wait(300);
    expectCursor("切回 a.md 后", srcPxs(), WIDE_PX);
  });

  it("③ 源码/预览模式切换：预览格落在同一游标（v×BLOCK），切回源码还是 287", async () => {
    toggleMode(); // 源码 → 预览
    await wait(320);
    expectCursor("切到预览后", prevPxs(), PREVIEW_PX);
    expect(srcPxs(), "切到预览后源码格退场").toEqual([]);

    toggleMode(); // 预览 → 源码
    await wait(320);
    expectCursor("切回源码后", srcPxs(), WIDE_PX);
  });

  it("④ 打开侧边预览：面板数 1⇒2 ⇒ 源码格按窄栏几何重落（95.67），预览格还是 861", async () => {
    clickPanelOp("打开侧边预览");
    await wait(500);
    expect(panels().length, "前提：侧边预览确实开出新面板").toBe(2);
    expectCursor("开侧边预览后（源码格变窄）", srcPxs(), NARROW_PX);
    expectCursor("开侧边预览后（预览格）", prevPxs(), PREVIEW_PX);
  });

  it("⑤ 新增分屏（复制式）：两格源码都还在同一个游标上（窄栏 95.67）", async () => {
    clickTab(0, 0); // 先让 a.md 这一格重新活动（md 两颗面板键只给活动面板）
    await wait(280);
    splitH();
    await wait(500);
    expect(panels().length, "前提：确实分出了新面板").toBe(3);
    expect(srcPxs().length, "前提：确实多出一个源码格（复制出来的那份）").toBe(2);
    expectCursor("新增分屏后（两格都窄）", srcPxs(), NARROW_PX);
  });

  it("⑥ 减少分屏：关掉一个分屏 ⇒ 面板数 3⇒2/1，剩下的源码格还在同一游标上", async () => {
    const before = panels().length;
    // ⚠️ 关的是「新分出来的那一格**源码**」，不是预览那一格：关预览会把预览栏清空，
    //    下面那句预览判据就被反假绿闸（got.length === 0）顶掉、等于没判。
    const copyIdx = hosts().reduce((last, h, i) => (visibleScroller(h) ? i : last), -1);
    if (copyIdx < 1) throw new Error(`前提：三格里至少要有两格源码（实际 ${srcPxs().length} 格）`);
    closePanelOp(panelOf(hosts()[copyIdx]));
    await wait(500);
    expect(panels().length, "前提：面板数确实少了一个").toBe(before - 1);
    expectCursor(
      "减少分屏后（几何按新面板数重算）",
      srcPxs(),
      rowH() === ROW ? WIDE_PX : NARROW_PX,
    );
    expectCursor("减少分屏后（预览格）", prevPxs(), PREVIEW_PX);
  });

  it("⑦ 一路关回单面板：几何回到整宽，源码格又该是 287", async () => {
    let guard = 0;
    while (panels().length > 1) {
      closePanelOp(panelOf(hosts()[hosts().length - 1]));
      await wait(450);
      if (++guard > 4) throw new Error("关分屏关不干净（面板数下不来）");
    }
    expect(panels().length, "前提：最后剩一个面板").toBe(1);
    expectCursor("关回单面板后（整宽）", srcPxs(), WIDE_PX);
  });
});

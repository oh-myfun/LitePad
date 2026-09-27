// @vitest-environment jsdom
// B148 · 用户报的症状：「markdown 源码和预览模式反复切换，滚动位置会持续偏移」。
//
// 根因是**左右两侧共用同一个 px 槽、而切换时从不交接**（`t.scrollTop` 一个字段装的是
// 「当前这一侧」的像素）：
//   · 纯预览态下，编辑器是 `display:none`，它的 `scrollDOM.scrollTop` 被浏览器清零，
//     CM6 的 `inputState.lastScrollTop`（`observers.scroll` 记的那个）也被那发 0 值
//     scroll 改写 —— 编辑器的位置**无从恢复**；
//   · 而预览的滚动监听照常把预览的像素写进同一个 `t.scrollTop`；
//   · 切回源码时，`measureAndKeepScroll` 下一帧的 `reassertViewScroll` 认的是
//     `t.viewMode !== "preview"`（此时已是源码）⇒ 就把**预览的像素**钉到编辑器上。
// 于是 editor@E → preview@syncToLine(E) → 用户滚预览到 P' → source@P'（而不是 E）→
// 预览再按这个新顶行定位 …… 每绕一圈偏一次，这就是「持续偏移」。
//
// 修法不是加第二个字段（B138 已拍板不再为位置加字段），而是**交接**：切回源码之前，
// 先把「预览此刻停在哪一行」换成**编辑器侧的像素**写进同一个槽，之后这一侧认的就是它。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
});

/** 最后一次落盘的会话。 */
const wired = vi.hoisted(() => ({
  saved: [] as {
    panels: { tabs: { path: string; scrollTop: number | null; viewMode: string | null }[] }[];
  }[],
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

/** 够长的文档：源码与预览都能滚起来。 */
const docText = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n");

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
            {
              path: "a.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 30,
              cursorCol: 1,
              viewMode: "source",
              scrollTop: 400,
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
  reloadFile: () => Promise.resolve(null),
  saveFile: () => Promise.resolve({ lossy: [], path: "" }),
  savePasteImage: () => Promise.resolve(""),
  saveSession: (state: { panels: { tabs: { path: string; scrollTop: number | null }[] }[] }) => {
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

function scroller(): HTMLElement {
  const el = document.querySelector(".layout-panel .cm-scroller") as HTMLElement | null;
  if (!el) throw new Error("编辑器容器没挂载");
  return el;
}
function previewRoot(): HTMLElement {
  const el = document.querySelector(".layout-panel .md-preview") as HTMLElement | null;
  if (!el) throw new Error("预览容器没挂载");
  return el;
}
function toggleViewModeByClick(): void {
  const btn = document.querySelector("#sb-lang") as HTMLElement | null;
  if (!btn) throw new Error("状态栏语言按钮没挂载");
  btn.click();
}
/** 装一个**会记值**的 scrollTop（jsdom 不做布局，顺带顺便记录最后一次写进去的值）。 */
function trackScrollTop(el: HTMLElement): { get: () => number; set: (v: number) => void } {
  let real = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => real,
    set: (v: number) => {
      real = Math.max(0, Number(v) || 0);
    },
  });
  return {
    get: () => real,
    set: (v: number) => {
      real = v;
    },
  };
}
function savedScrollTop(): number | null {
  return wired.saved[wired.saved.length - 1]?.panels[0]?.tabs[0]?.scrollTop ?? null;
}

describe("B148 源码 / 预览反复切换：位置不许在两侧之间串档", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(300);
  });

  it("纯预览滚过之后再切回源码，编辑器不许落在预览的像素上", async () => {
    const sc = scroller();
    const track = trackScrollTop(sc);
    const preview = previewRoot();
    const previewTrack = trackScrollTop(preview);

    // ① 源码态：用户在编辑器里滚到一个位置（走滚动监听，真路径）
    track.set(400);
    sc.dispatchEvent(new Event("scroll"));
    await wait(60);

    // ② 切到纯预览：预览按编辑器顶行对齐（applyPanelMode 的 syncToLine）
    toggleViewModeByClick();
    await wait(120);

    // ③ 用户在预览里滚到别处 —— 这一步会把**预览的像素**写进同一个 t.scrollTop
    previewTrack.set(3000);
    preview.dispatchEvent(new Event("scroll"));
    await wait(60);

    // ④ 切回源码
    toggleViewModeByClick();
    await wait(150); // 越过测量收尾那一帧（reassertViewScroll 就在这里动手）

    const landed = track.get();
    expect(landed, "编辑器不许被钉到预览的 3000（B148：这就是每切一轮偏一次的那一手）").not.toBe(
      3000,
    );
    expect(previewTrack.get(), "预览侧的像素也不许反过来污染编辑器之外的判定").not.toBe(-1);
  });

  it("往返一轮之后，落盘里也不许出现预览那个像素", async () => {
    // 上一条已经切回源码：这一轮走完整，看会话记录里这一侧认的是不是编辑器自己的值。
    await wait(900); // 越过 800ms 防抖
    const saved = savedScrollTop();
    expect(saved, "落盘里不该是预览那 3000").not.toBe(3000);
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

describe("B148 静态契约：切模式是一次明确的交接，不是各认各的", () => {
  it("切回源码之前要先问预览停在哪一行", () => {
    const body = bodyOf("function toggleViewMode(");
    expect(body, "没有预览顶行就无从反推编辑器位置").toMatch(/topVisibleLine\(\)/);
  });

  it("问行号必须在改 viewMode 之前（之后编辑器已被清零，问不到）", () => {
    const body = bodyOf("function toggleViewMode(");
    const ask = body.indexOf("topVisibleLine(");
    const flip = body.indexOf("tab.viewMode =");
    expect(ask, "取顶行的那一行得还在").toBeGreaterThan(-1);
    expect(flip, "改 viewMode 的那一行得还在").toBeGreaterThan(-1);
    expect(ask, "行号要在切换之前取：切换后编辑器已是 display:none，顶行无从反推").toBeLessThan(
      flip,
    );
  });

  it("交接过去的必须是**编辑器侧**的像素，且走唯一闸口", () => {
    const body = bodyOf("function toggleViewMode(");
    // 按行反推出的像素：靠 lineBlockAt 定位，不是把预览的像素原样搬过去
    expect(body, "要按文档行反推编辑器像素").toMatch(/lineBlockAt\(/);
    expect(body, "换了这一侧的像素就得走唯一闸口").toMatch(/recordScroll\(/);
    // 之后还有还原与测量收尾两步，缺一个都会让交接落空
    expect(body, "交接之后要立刻钉回去，否则下一帧的测量收尾会拿旧值动手").toMatch(
      /restoreViewScroll\(panel\);/,
    );
    expect(body, "测量收尾仍是最后一道").toMatch(/measureAndKeepScroll\(panel\);/);
  });
});

describe("B148 反向验证：把交接摘掉，上面几条必须变红", () => {
  it("退回「切回源码时直接沿用预览的像素」，契约必须抓住", () => {
    // 退化：拿掉取顶行、按行反推、写闸口三步，只留 `tab.viewMode =` 与后续的还原。
    // ⚠️ 整块按原样搬（缩进也算）：只摘不插的话原处还会留一份，退化会悄悄变成「没改」。
    const ASK = "    const line = panel.preview?.topVisibleLine() ?? null;\n";
    const CONVERT =
      "      handoff = Math.max(0, view.lineBlockAt(view.state.doc.line(n).from).top);\n";
    const WRITE = "  if (handoff !== null) recordScroll(tab.tabId, handoff);\n";
    let degraded = src;
    let removed = 0;
    for (const snippet of [ASK, CONVERT, WRITE]) {
      expect(src, `退化用的原句必须还在：${snippet.trim().slice(0, 24)}…`).toContain(snippet);
      degraded = degraded.replace(snippet, "");
      removed += 1;
    }
    expect(removed).toBe(3);
    expect(degraded, "退化版要真的换了写法").not.toBe(src);

    const body = bodyOf("function toggleViewMode(", degraded);
    expect(body, "退化后不再问预览的顶行").not.toMatch(/topVisibleLine\(\)/);
    expect(body, "退化后不再按行反推编辑器像素").not.toMatch(/lineBlockAt\(/);
    expect(body, "退化后不再交接像素").not.toMatch(/recordScroll\(/);
  });

  it("退化成「先切 mode 再问顶行」，顺序契约必须抓住", () => {
    const ASK = "    const line = panel.preview?.topVisibleLine() ?? null;\n";
    const FLIP = '  tab.viewMode = toPreview ? "preview" : "source";\n';
    expect(src).toContain(ASK);
    expect(src).toContain(FLIP);
    // 把「问顶行」这一行整个搬到最后 —— 只摘不移的话原处还会留一份，顺序照样判不出来
    const moved = src.replace(ASK, "").replace(FLIP, FLIP + ASK);
    expect(moved, "退化版要真的换了写法").not.toBe(src);

    const body = bodyOf("function toggleViewMode(", moved);
    expect(body.indexOf("tab.viewMode =")).toBeGreaterThan(-1);
    expect(
      body.indexOf("topVisibleLine("),
      "退化后取顶行应排在改 viewMode 之后（顺序契约此时必须落空）",
    ).toBeGreaterThan(body.indexOf("tab.viewMode ="));
  });
});

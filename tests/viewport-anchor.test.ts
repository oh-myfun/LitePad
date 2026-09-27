// @vitest-environment jsdom
// B146 · 用户报的症状：「切换标签，markdown 文档的滚动位置会不断往下移，
// 不管是源码模式还是预览模式」。
//
// 根因在 **CM6 自己的「滚动锚点补偿」**（`@codemirror/view` 的 measure 收尾逻辑）：
// 它拿视口顶行那块的高度和上次记下的锚点比，差超过 1px 就 `scrollTop += diff`，
// 目的是编辑时内容别乱跳。而 `setState` 换文档后 heightMap 是拿 `HeightOracle`
// 按**估算行高**建的，measure 一跑换成**实测行高** —— 软换行 / 中英文混排下实测
// 普遍更高，`diff` 就恒为正 ⇒ 每切一次标签视口往下挪一点，切十次偏出好几屏。
//
// 难躲在时序：`requestMeasure()` 排的是**下一帧**的 rAF，而 `pinScrollTop` 第一次
// 就「立住」了、不再补钉，中间没人把关 —— 补偿改完位置就永久生效。
// 所以修复是「测量之后再确认一次」，本文件的行为用例就把这一手复刻出来。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { sessionStore } from "../src/session/store";

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

const docText = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");

vi.mock("../src/ipc/api", () => ({
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve(["UTF-8"]),
  listEols: () => Promise.resolve(["CRLF", "LF"]),
  // a.md 视口 500 / b.md 视口 120，各记一份不相同的值
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
              scrollTop: 500,
            },
            {
              path: "b.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 2,
              cursorCol: 1,
              scrollTop: 120,
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
  saveSession: () => Promise.resolve(),
  saveSettings: () => Promise.resolve(),
  writeBackup: () => Promise.resolve(),
  restoreBackup: () => Promise.resolve(null),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
}));

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 漂移状态：复刻 CM6 的锚点补偿。
 * `left` 是还剩几次漂移 —— 真机上它只在 measure 那一次结算，不会无限推。
 */
const drift = vi.hoisted(() => ({ left: 0, diff: 7 }));

/** 装一个「写完会在下一帧把位置再往下推 diff」的 scrollTop。 */
function installDriftScroll(): void {
  const sc = document.querySelector(".layout-panel .cm-scroller") as HTMLElement | null;
  if (!sc) throw new Error("找不到 .cm-scroller");
  let real = 0;
  Object.defineProperty(sc, "scrollTop", {
    configurable: true,
    get: () => real,
    set: (v: number) => {
      real = Math.max(0, v);
      if (drift.left > 0) {
        drift.left -= 1;
        const d = drift.diff;
        requestAnimationFrame(() => {
          real = Math.max(0, real + d);
        });
      }
    },
  });
}

function clickTab(i: number): void {
  const el = (document.querySelectorAll(".layout-panel .tab") as NodeListOf<HTMLElement>)[i];
  const m = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    clientX: 5,
    clientY: 5,
  });
  el.dispatchEvent(m);
  el.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
  );
}

function scrollTopNow(): number {
  return (
    (document.querySelector(".layout-panel .cm-scroller") as HTMLElement | null)?.scrollTop ?? -1
  );
}

describe("B146 滚动锚点补偿：测量把位置往下推之后要收回来", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(300);
  });

  it("补偿把落点往下推了 7px，最终仍要钉回标签自己的那份 500", async () => {
    installDriftScroll();
    // 只漂一次，且正好消耗在 switchTab 里那一次还原赋值上（真机就是这一手）
    drift.left = 1;
    drift.diff = 7; // 必须 > 1，否则 CM6 自己都不会结算

    clickTab(0); // a.md，视口 500
    await wait(120); // 越过测量与收尾的那一帧

    expect(scrollTopNow(), "锚点补偿后的位置必须被收回去").toBe(500);
  });
});

describe("B146 换文档：setState 期间自动派发的滚动不许记进任何一张标签", () => {
  it("两张标签的记录都要原封不动（换文档那两下自动滚动不算用户停过的位置）", async () => {
    // 标签条里两张的 tabId 是 1 / 2（a.md / b.md，由 `loadSession` 那份载荷决定 ——
    // 视口日志里「切换 · 采旧位置后 tab=1 → 还原窗口内 tab=2」就是这两张）。
    const sc = document.querySelector(".layout-panel .cm-scroller") as HTMLElement | null;
    if (!sc) throw new Error("找不到 .cm-scroller");
    let real = 777;
    Object.defineProperty(sc, "scrollTop", {
      configurable: true,
      get: () => real,
      set: (v: number) => {
        real = Math.max(0, v);
      },
    });
    sessionStore.reset();
    sessionStore.register(1, 1, { path: "a.md" });
    sessionStore.register(2, 2, { path: "b.md" });
    sessionStore.setScroll(1, 777); // 出去的那张（= 容器当前值，切走时照旧记一遍）
    sessionStore.setScroll(2, 120); // 进来的那张

    // ⚠️ 不能在 setter 里派发 scroll：那一刻的写入是**我们自己的钉位置**，本来就归
    // 「程序滚动不许写快照」管（B139），派发了也照样被挡 —— 等于什么都没模拟。
    // 要模拟的是 CM6 换完文档自己动的那一下：钩住 `setState`，在它**之后**把容器
    // 挪一个值（真机上就是浏览器按新内容长度裁剪 scrollTop）并派发一发 scroll。
    const CM = await import("@codemirror/view");
    const setState = CM.EditorView.prototype.setState;
    let swapped = false;
    CM.EditorView.prototype.setState = function patched(this: unknown, s: unknown): void {
      setState.call(this, s);
      if (swapped) return;
      swapped = true;
      real = 999;
      sc.dispatchEvent(new Event("scroll"));
    };

    clickTab(1); // → 第二张
    await wait(120); // 越过还原窗口与那一帧的释放
    CM.EditorView.prototype.setState = setState;

    expect(sessionStore.get(1)?.scrollTop, "出去那张的记录不许被换文档的滚动污染").toBe(777);
    expect(sessionStore.get(2)?.scrollTop, "进来的那张的记录不许被动过").toBe(120);
  });
});

const src = readFileSync("src/main.ts", "utf-8");

/** 取出某个函数 / 回调的**函数体**（从 header 处起做花括号配平）。 */
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

/** 剥掉注释：说明文字里正好提到 `requestMeasure()`，照原文匹配会永远为真（B145 同一条坑）。 */
const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("B146 静态契约：测量统一走收尾，别在各处裸调 requestMeasure", () => {
  it("applyPanelMode 不再自己 requestMeasure：测量改走会收尾的那一条", () => {
    const body = code(bodyOf("function applyPanelMode("));
    expect(body, "裸测量会被补偿推走，且没人收回来").not.toMatch(/requestMeasure\(\)/);
  });

  it("四条还原 / 切模式的路径都要在测量之后收尾", () => {
    for (const [site, header] of [
      ["切标签", "function switchTab("],
      ["挂载", "mountView: (panelId, hostEl) => {"],
      ["关闭标签后接班", "async function closeTabById("],
      ["切换源码/预览", "function toggleViewMode("],
    ] as const) {
      expect(code(bodyOf(header)), `${site} 这条路径要在测量之后把位置收回来`).toMatch(
        /measureAndKeepScroll\(/,
      );
    }
  });

  it("收尾只在位置真的被动过时才补钉", () => {
    const body = bodyOf("function reassertViewScroll(");
    // 没被动过就别钉：白钉会占用 pinningContainers / 抑制区间，干扰随后的采样
    expect(body).toMatch(/scrollTop === px/);
    expect(body, "补钉要过唯一闸口").toMatch(/pinScrollTop\(/);
    expect(body, "补钉期间派发的 scroll 不能写回记录").toMatch(/restoringViewport\(/);
  });

  it("预览按像素钉完之后要抹掉待重定位行号（否则会被二次定位拽走）", () => {
    const body = bodyOf("function restorePreviewScroll(");
    expect(body).toMatch(/clearPendingSync\(\);/);
  });
});

describe("B146 反向验证：把收尾摘掉，上面那几条必须变红", () => {
  it("退回「viewTabId 在 setState 之后才改」后，罩住换文档的契约必须抓住", () => {
    // 这正是修复前的样子：换完文档才认新标签，中间那几下自动滚动没人管
    const VID = "  panel.viewTabId = tabId;\n";
    const SETSTATE = "  view.setState(tab.state);\n";
    const at = src.indexOf(VID, src.indexOf("function switchTab("));
    expect(at, "退化用的原句必须还在").toBeGreaterThan(-1);
    const ss = src.indexOf(SETSTATE, at);
    expect(ss, "退化用的 setState 行必须还在").toBeGreaterThan(at);
    // 干净地搬：先把整行摘掉（连带后面那行一起左移，别把 `restoringViewport` 留在上面），
    // 再插到 setState 之后 —— 只摘不插的话原处还会留一份，顺序照旧判不出来
    const noVid = src.slice(0, at) + src.slice(at + VID.length);
    const ss2 = noVid.indexOf(SETSTATE, noVid.indexOf("function switchTab("));
    expect(ss2, "摘掉那一行后仍要能找到 setState").toBeGreaterThan(-1);
    const degraded =
      noVid.slice(0, ss2 + SETSTATE.length) + VID + noVid.slice(ss2 + SETSTATE.length);

    const body = bodyOf("function switchTab(", degraded);
    const vid = body.indexOf("viewTabId = ");
    const setState = body.indexOf("setState(");
    expect(vid, "退化版里 viewTabId 赋值仍在").toBeGreaterThan(-1);
    expect(vid, "退化版里 viewTabId 应排在 setState 之后").toBeGreaterThan(setState);
  });

  it("退回「各处裸调 requestMeasure、没有收尾」后，契约必须抓住", () => {
    // ⚠️ 字面量替换（老规矩）：正则一改排版就失配，退化会变成「什么都没改」
    const CALLS = ["  measureAndKeepScroll(panel);\n", "  measureAndKeepScroll(p);\n"];
    let degraded = src;
    let removed = 0;
    for (const c of CALLS) {
      // 只切掉「切标签 / 切模式 / 关闭接班」那几处（挂载那条排在 switchTab 之前，
      // 用另一个用例盯）。同一行式样在多个站点出现，所以要循环着摘干净。
      const from = degraded.indexOf("function switchTab(");
      let at = degraded.indexOf(c, from);
      while (at >= 0) {
        degraded = degraded.slice(0, at) + degraded.slice(at + c.length);
        removed += 1;
        at = degraded.indexOf(c, at);
      }
    }
    expect(removed, "退化用的原句必须还在").toBeGreaterThan(0);
    expect(removed, "切标签与切模式这两处都要真的摘掉").toBeGreaterThanOrEqual(2);
    for (const [site, header] of [
      ["切标签", "function switchTab("],
      ["切换源码/预览", "function toggleViewMode("],
    ] as const) {
      expect(code(bodyOf(header, degraded)), `${site} 退化后应不再有收尾`).not.toMatch(
        /measureAndKeepScroll\(/,
      );
    }
  });
});

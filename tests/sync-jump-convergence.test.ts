// @vitest-environment jsdom
// B-收敛：触发式位置跳转（大纲点击 / 转到行 / 查找命中）必须经由统一入口
//   `pushSyncToSiblings(..., crossWindow=true)` 发出跨窗口 `EVT_SYNC_POS` 广播。
//
// 根因：toc.onJump / commands.openGotoLine / find.openFindHit 三处各自手工
//   `for (inst of instancesOfDoc(...))` 循环本地实例，**完全没有 crossWindow 广播**，
//   且重写了兄弟派发逻辑（与 `pushSyncToSiblings` 行为差异：y:"center" vs y:"start"、
//   漏光标派发、漏离屏快照落槽……）。多窗口下点击大纲跳转不跟随就是这一条漏广播。
//
// 修复：三条触发源都改调 `syncJumpToLine(src, v)` —— 它等于
//   `pushSyncToSiblings(src, true, { v })`，本地兄弟 + 跨窗口广播全收口到这一条路径。
//
// 本文件给出**第一条能稳定变红的回路**：boot 主程序一次、开启同步滚动，分别驱动三种触发，
// 断言三者都经 `emitCrossWindow` 发出 `sync-scroll-pos`（跨窗口广播）。修复前三者都不发
// （测试红），修复后都发（测试绿）。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

const MD = [
  ...Array.from({ length: 21 }, (_, i) => `# 标题 ${i + 1}`),
  "段落第一行",
  "段落第二行",
  "段落第三行",
].join("\n");

/** 真事件总线：listen 真注册、emit 真派发（同总线里所有同事件监听都收到）。 */
const bus = vi.hoisted(() => {
  const m = new Map<string, Array<(e: { payload: unknown }) => void>>();
  return {
    listen: (event: string, cb: (e: { payload: unknown }) => void) => {
      const arr = m.get(event) ?? [];
      arr.push(cb);
      m.set(event, arr);
      return Promise.resolve({ unlisten: () => {} });
    },
    emit: (event: string, payload: unknown) => {
      for (const cb of m.get(event) ?? []) cb({ payload });
      return Promise.resolve();
    },
    emitTo: (_label: string, event: string, payload: unknown) => {
      for (const cb of m.get(event) ?? []) cb({ payload });
      return Promise.resolve();
    },
  };
});
/** 捕获 `emitCrossWindow` 的调用参数（真实现里它负责注入 from 并 emit）。 */
const xwin = vi.hoisted(() => ({ calls: [] as Array<{ event: string; payload: unknown }> }));

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
  window.matchMedia = (q: string) =>
    ({
      matches: false,
      media: q,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  window.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number;
  window.cancelAnimationFrame = (id: number) => clearTimeout(id);
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
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
  listen: (event: string, cb: (e: { payload: unknown }) => void) => bus.listen(event, cb),
  emit: (event: string, payload: unknown) => bus.emit(event, payload),
  emitTo: (label: string, event: string, payload: unknown) => bus.emitTo(label, event, payload),
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
  // 与真实现同构：注入 from = 当前窗口 label（展开在后，压过误传），并记录调用参数
  emitCrossWindow: vi.fn(async (event: string, payload: Record<string, unknown>) => {
    xwin.calls.push({ event, payload: { ...payload, from: "main" } });
    bus.emit(event, { ...payload, from: "main" });
  }),
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
          ],
        },
      ],
    }),
  loadSettings: () =>
    Promise.resolve({
      theme: "light",
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

/**
 * 大纲 TOC 入口已随顶栏按钮移除，唯一入口是「查看 → 大纲 TOC」菜单
 * （与 tests/toc-follows-panel.test.ts 同路数）。
 */
async function toggleTocViaMenu(): Promise<void> {
  const host = document.getElementById("menu-bar") as HTMLElement;
  const view = [...host.querySelectorAll("button.menu-btn")].find((b) =>
    b.textContent?.startsWith("查看"),
  );
  expect(view, "菜单栏应有「查看」").toBeTruthy();
  view!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await wait(0);
  for (const menu of document.querySelectorAll(".popup-menu")) {
    const item = [...menu.querySelectorAll(":scope > button")].find((b) =>
      (b.querySelector(".menu-label")?.textContent ?? "").includes("大纲 TOC"),
    );
    if (item) {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await wait(0);
      return;
    }
  }
  throw new Error("菜单项「大纲 TOC」未找到");
}

/** 开启活动文档的同步滚动（点击标题栏那颗同步键）。 */
async function enableSync(): Promise<void> {
  const btn = document.getElementById("sync-scroll") as HTMLElement | null;
  expect(btn, "同步键应存在").toBeTruthy();
  btn!.click();
  await wait(150);
  const { docSyncModes } = await import("../src/core/app-state");
  const { tabs } = await import("../src/core/app-state");
  const first = [...tabs.values()][0];
  expect(
    first && docSyncModes.get(first.docId) === true,
    "点击同步键后活动文档应进入同步滚动",
  ).toBe(true);
}

/** 断言本窗口发出了跨窗口位置广播（排除自身的 EVT_SYNC_MODE 等）。 */
function assertBroadcast(trigger: string): void {
  const posCalls = xwin.calls.filter((c) => c.event === "sync-scroll-pos");
  expect(
    posCalls.length,
    `${trigger} 必须经由统一入口发出跨窗口位置广播 sync-scroll-pos`,
  ).toBeGreaterThan(0);
}

describe("B-收敛：三种触发位置跳转都必须跨窗口广播（统一入口）", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(400);
    const panels = Array.from(document.querySelectorAll(".layout-panel")) as HTMLElement[];
    expect(panels.length, "应恢复一个面板").toBe(1);
    await enableSync();
  });

  it("① 点击大纲条目 ⇒ 跨窗口广播 sync-scroll-pos", async () => {
    const tocPanelEl = document.getElementById("toc-panel") as HTMLElement;
    if (tocPanelEl.hidden) await toggleTocViaMenu();
    await wait(50);
    const items = Array.from(document.querySelectorAll("#toc-panel .toc-item")) as HTMLElement[];
    expect(items.length, "a.md 应渲染出大纲条目").toBeGreaterThan(0);

    xwin.calls.length = 0; // 隔离：只看本次触发
    items[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait(200);
    assertBroadcast("点击大纲条目");
  });

  it("② 转到行（Ctrl+G 浮层回车）⇒ 跨窗口广播 sync-scroll-pos", async () => {
    const { openGotoLine } = await import("../src/commands");
    xwin.calls.length = 0; // 隔离：只看本次触发
    openGotoLine();
    const input = document.querySelector(".goto-input") as HTMLInputElement | null;
    expect(input, "转到行浮层应出现输入框").toBeTruthy();
    input!.value = "10";
    input!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await wait(200);
    assertBroadcast("转到行");
  });

  it("③ 查找命中跳转（openFindHit）⇒ 跨窗口广播 sync-scroll-pos", async () => {
    const { tabs } = await import("../src/core/app-state");
    const first = [...tabs.values()][0];
    expect(first, "应有活动文档实例").toBeTruthy();
    const { openFindHit } = await import("../src/find/findbar");
    xwin.calls.length = 0; // 隔离：只看本次触发
    openFindHit({
      docId: first.docId,
      path: "a.md",
      name: "a.md",
      line: 5,
      col: 1,
      text: "段落",
      from: 10,
      to: 12,
    });
    await wait(200);
    assertBroadcast("查找命中跳转");
  });
});

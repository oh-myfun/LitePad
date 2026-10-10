// @vitest-environment jsdom
// B193 · 会话里的 `satelliteTabs` 必须按**卫星窗口**还原：按 `owner` 分组，一组一个窗口。
//
// 为什么需要这一份用例：恢复链路跑在 Tauri 里（真开窗、跨进程事件），静态契约只能盯住
// 「写了哪几行」，盯不住「到底开了几个窗口、标签有没有落回主窗口」。而 v1 的行为恰好是
// 把卫星标签 append 进 `sp[0].tabs` —— 从行数上看两套实现都有那些行，只有真跑一遍、
// 数 `openSatelliteWindow` 的载荷才分得开。
//
// 判据刻意安排成「两个 owner 组」（sat-1 两个标签 / sat-2 一个标签）+ 主窗口一个标签：
//   · 坍缩成一个窗口 ⇒ 组数对不上；
//   · 并回主窗口 ⇒ 主窗口标签数变成 4（而非 1），且一个窗口都不开。
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

const wired = vi.hoisted(() => ({
  /** 每次 `openSatelliteWindow` 收到的载荷（只留标签名，够判分组） */
  windows: [] as string[][],
  /** 主窗口注册的 `satellite-ready` 监听（mock 开窗后要主动广播，否则永远等不到就绪） */
  readyCbs: [] as Array<(e: { payload: unknown }) => void>,
  /** 每次落盘的会话（用来验证 owner 真的被写回去，而不只是恢复端认得它） */
  saved: [] as Array<{ satelliteTabs?: Array<{ path: string; owner?: string | null }> }>,
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
  // ⚠️ 真 Tauri 的 `listen` resolve 出来的是**一个函数**（取消监听），不是对象 ——
  // `openTabsInNewWindow` 拿到返回值后会直接 `onReady()` 调用它。mock 成对象会让
  // 那行抛 TypeError，进而跳过后面的 `remoteTabLocally`（曾让本用例假红）。
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    if (name === "satellite-ready") wired.readyCbs.push(cb);
    return Promise.resolve(() => {
      const i = wired.readyCbs.indexOf(cb);
      if (i >= 0) wired.readyCbs.splice(i, 1);
    });
  },
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

function docText(name: string): string {
  return Array.from({ length: 20 }, (_, i) => `${name} line ${i + 1}`).join("\n");
}

/** 每个路径一个稳定且不重复的文档 id（同 `openFile` 返回的 tabId = 文档 id）。 */
const idSeq = { n: 100 };
const ids = new Map<string, number>();
function idFor(path: string): number {
  const hit = ids.get(path);
  if (hit !== undefined) return hit;
  const id = idSeq.n++;
  ids.set(path, id);
  return id;
}
function openedOf(path: string) {
  return {
    tabId: idFor(path),
    text: docText(path),
    name: path,
    path,
    encoding: "UTF-8",
    eol: "LF",
    readonly: false,
    mixedEol: false,
    sizeClass: "normal",
    sizeHint: "",
  };
}

function tab(path: string, owner?: string) {
  return {
    path,
    encoding: "UTF-8",
    eol: "LF",
    cursorLine: 1,
    cursorCol: 1,
    scrollTop: 0,
    // 分组键：sat-1 两个标签、sat-2 一个标签
    ...(owner ? { owner } : {}),
  };
}

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
      panels: [{ active: 0, tabs: [tab("main.md")] }],
      satelliteTabs: [tab("s1a.md", "sat-1"), tab("s1b.md", "sat-1"), tab("s2.md", "sat-2")],
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
  openFile: (path: string) => Promise.resolve(openedOf(path)),
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
  saveSession: (state: { satelliteTabs?: Array<{ path: string; owner?: string | null }> }) => {
    wired.saved.push(state);
    return Promise.resolve();
  },
  saveSettings: () => Promise.resolve(),
  // B144：缺它会让启动收尾报一条 `pending: take failed`，掩盖真实的待打开路径问题
  takePendingFiles: () => Promise.resolve([]),
  writeBackup: () => Promise.resolve(),
  restoreBackup: () => Promise.resolve(null),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
  // B193 的观察点：记录每个窗口收到的标签，并立刻广播「已就绪」让主窗口敢摘本地标签
  openSatelliteWindow: (_title: string, payload: { tabs: Array<{ name: string }> }) => {
    wired.windows.push(payload.tabs.map((t) => t.name));
    const label = `sat-${wired.windows.length}`;
    for (const cb of wired.readyCbs) cb({ payload: { label } });
    return Promise.resolve(label);
  },
  windowPayload: () => Promise.resolve({ kind: "main", label: "main", payload: null }),
}));

/** 面板按文档顺序横向排布（每个 200x200，间隔 10），jsdom 无布局，靠该桩做命中测试。 */
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
    if (this.classList.contains("layout-panel")) {
      const idx = Array.from(document.querySelectorAll(".layout-panel")).indexOf(this);
      return mk(Math.max(0, idx) * 210, 0, 200, 200);
    }
    return mk(0, 0, 200, 200);
  };
}
installRectStubs();

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询等到条件成立（而不是猜一个固定毫秒数）。
 *
 * 开窗是 fire-and-forget、落盘还带 800ms 防抖 —— 固定 `wait(1300)` 在单跑时够、
 * 全量跑（机器更忙）时会偶发红。所以这里一律轮询等条件，超时就放弃（由各条断言
 * 自己去报「期望 2 个窗口、实际 0 个」这种**看得懂**的失败，而不是一句 waitFor 超时）。
 */
async function waitFor(cond: () => boolean, ms: number): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - t0 > ms) return;
    await wait(50);
  }
}
function mainTabCount(): number {
  return document.querySelectorAll(".tab").length;
}

describe("B193 会话里的卫星标签按卫星窗口还原", () => {
  beforeAll(async () => {
    await import("../src/main");
    // 开窗是 fire-and-forget（`restoreSession` 不 await）：轮询等两个窗口都开出来
    await waitFor(() => wired.windows.length === 2, 5000);
    // 落盘带 800ms 防抖：同样轮询，等到会话里出现卫星标签为止
    await waitFor(() => wired.saved.some((s) => (s.satelliteTabs?.length ?? 0) > 0), 5000);
  });

  it("① 每个 owner 组各开一个卫星窗口（不是坍缩成一个）", () => {
    expect(wired.windows.length, "两个 owner 组应开出两个窗口").toBe(2);
  });

  it("② 分组内容正确：sat-1 两个标签、sat-2 一个", () => {
    const names = wired.windows.map((w) => [...w].sort());
    expect(names).toContainEqual(["s1a.md", "s1b.md"]);
    expect(names).toContainEqual(["s2.md"]);
  });

  it("③ 卫星标签**不**并回主窗口（主窗口只剩自己那个标签）", () => {
    // v1 会把 3 个卫星标签 append 进第一个面板 ⇒ 这里是 4。
    expect(mainTabCount(), "主窗口标签条只该有 main.md 一个").toBe(1);
  });

  it("④ 落盘回环：交给窗口后，owner 要跟着写回会话（下次重启才能再分组）", () => {
    // 只测「恢复端认得 owner」是不够的 —— 若落盘不带 owner，下次启动又会坍缩成一份。
    // 所以这里盯 `saveSession` 收到的 satelliteTabs：交给窗口后必须各自带上归属。
    const last = [...wired.saved].reverse().find((s) => (s.satelliteTabs?.length ?? 0) > 0);
    expect(last, "落过盘的会话里要有卫星标签").toBeTruthy();
    const sats = last!.satelliteTabs!;
    expect(sats.length, "三个卫星标签都要被登记").toBe(3);
    const owners = new Set(sats.map((s) => s.owner));
    expect(owners.size, "两个窗口 ⇒ 两个不同的 owner").toBe(2);
  });
});

describe("B193 静态契约：分组要落盘、失败要兜底", () => {
  const main = (
    readFileSync("src/main.ts", "utf-8") +
    "\n" +
    readFileSync("src/multiwindow/windows.ts", "utf-8") +
    "\n" +
    readFileSync("src/session/session.ts", "utf-8")
  ).replace(/\r\n/g, "\n");
  const store = readFileSync("src/session/store.ts", "utf-8").replace(/\r\n/g, "\n");

  it("落盘要把 owner（窗口归属）带上，否则多窗口会被坍缩成一份", () => {
    expect(store, "卫星标签落盘要带 owner").toMatch(/owner: s\.owner/);
  });

  it("恢复要按 owner 分组，而不是并回主窗口第一个面板", () => {
    expect(main, "分组要用到 st.owner").toMatch(/const key = st\.owner \?\? "";/);
    // v1 的并回写法必须已经不存在
    expect(main, "不该再把卫星标签 append 进 sp[0]").not.toMatch(/sp\[0\]\.tabs = \[/);
  });

  it("开窗失败要有兜底：没被接走的隐藏实例必须收回主窗口", () => {
    expect(main, "兜底要认「仍隐藏且未登记为已借出」").toMatch(
      /t\.panelId === -1 && !remotedTabs\.has\(t\.docId\)/,
    );
  });

  it("B193 反向验证：摘掉兜底 → 上面那条必须落空", () => {
    const ORIG =
      "      if (t && t.panelId === -1 && !remotedTabs.has(t.docId)) reclaimRemoted(tabId);";
    expect(main, "退化串要先自证原句还在").toContain(ORIG);
    const degraded = main.replace(ORIG, "");
    expect(degraded, "退化后不再有收回兜底").not.toMatch(/(?<!\w)reclaimRemoted\(tabId\)/);
  });
});

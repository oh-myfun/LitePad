// @vitest-environment jsdom
// B391 spike · Task 5 —— 装饰预览接进面板模型（`Settings.deco_preview` 开关隔离）。
//
// 三条判据的形状抄自 tests/view-switch-noedit.test.ts（本仓库唯一能在 jsdom 里
// 真启动 `src/main.ts` 的那份配方：26 个 ipc/api 导出不许缺，缺一个 bootstrap 就
// 以 TypeError 死掉）。这里刻意**不打桩**装饰面本身：它走的是真 `createDecoMirror`，
// 于是「开关开着 ⇒ 这一格预览侧真的是 CM6 装饰面」是被真启动证明的，不是被我 mock 证明的。
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
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve({ unlisten: () => {} }) }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
  open: () => Promise.resolve(null),
  save: () => Promise.resolve(null),
}));

const saved: unknown[] = [];
vi.mock("../src/ipc/api", () => ({
  assocList: () => Promise.resolve([]),
  assocSet: (ext: string, on: boolean) =>
    Promise.resolve({ ext, registered: on, isDefault: false }),
  assocSetMany: (exts: string[], on: boolean) =>
    Promise.resolve(exts.map((ext) => ({ ext, registered: on, isDefault: false }))),
  assocOpenSystemSettings: () => Promise.resolve(),
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
            { path: "a.md", encoding: "UTF-8", viewMode: "source", cursorLine: 1, cursorCol: 1 },
          ],
        },
      ],
    }),
  // 唯一与 view-switch-noedit 不同的地方：这颗开关是开的。
  // 关着的那一路已由那份文件真启动覆盖（它的 loadSettings 没有这个键 ⇒ undefined ⇒ 假）。
  loadSettings: () =>
    Promise.resolve({
      theme: "light",
      word_wrap: true,
      font_size: 14,
      default_encoding: "UTF-8",
      default_eol: "CRLF",
      autosave: true,
      toc_width: 240,
      preview_line_height: 1.7,
      deco_preview: true,
    }),
  logEvent: () => {},
  newTab: () =>
    Promise.resolve({
      tabId: 1,
      name: "未命名",
      readonly: false,
      encoding: "UTF-8",
      eol: "CRLF",
    }),
  openFile: (p: string) =>
    Promise.resolve({
      tabId: 101,
      text: "# Title\n\nhello world\n\nsecond line\n",
      name: p,
      path: p,
      encoding: "UTF-8",
      eol: "LF",
      readonly: false,
      mixedEol: false,
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
  saveFile: (args: unknown) => {
    saved.push(args);
    return Promise.resolve({ lossy: [], path: "" });
  },
  savePasteImage: () => Promise.resolve(""),
  saveSession: () => Promise.resolve(),
  saveSettings: () => Promise.resolve(),
  writeBackup: () => Promise.resolve(),
  restoreBackup: () => Promise.resolve(null),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
  // ---- 配方抄自 view-switch-noedit.test.ts，但那份文件写于 B305/B314/B315/B389 之前：
  //      ipc/api 后来又长了 27 个导出。缺一个不会红，只会在日志里留一条
  //      「首帧名单没取到 / take failed」的 warn —— 那是**静默降级**，不是健康。
  //      按本仓库既有的「api.ts 加导出要同步补 vi.mock」规矩补齐。----
  clearRecents: () => Promise.resolve(),
  copyEntry: () => Promise.resolve(true),
  createDir: () => Promise.resolve(null),
  createFile: () => Promise.resolve(null),
  deleteEntry: () => Promise.resolve(true),
  forgetRecent: () => Promise.resolve(),
  getRecentLimit: () => Promise.resolve(50),
  isDir: () => Promise.resolve(false),
  listDir: () => Promise.resolve([]),
  listFonts: () => Promise.resolve([]),
  listRecents: () => Promise.resolve([]),
  listTabs: () => Promise.resolve([]),
  logFilePath: () => Promise.resolve(""),
  logLevel: () => Promise.resolve("info"),
  moveEntry: () => Promise.resolve(true),
  noteOpenedPath: () => Promise.resolve(),
  openSatelliteWindow: () => Promise.resolve(),
  renameEntry: () => Promise.resolve(true),
  replaceInFiles: () => Promise.resolve({ files: [], replacements: 0 }),
  retitleRecent: () => Promise.resolve(),
  revealInFolder: () => Promise.resolve(),
  searchInFolder: () => Promise.resolve({ files: [], matches: [], truncated: false }),
  setDocPath: () => Promise.resolve(),
  setLogLevel: () => Promise.resolve(),
  setRecentLimit: () => Promise.resolve(),
  takePendingFiles: () => Promise.resolve([]),
  windowPayload: () => Promise.resolve(null),
  // ⚠️ 这里**没有** `isDecoPreviewEnabled`：那颗闸门住在 `core/app-state.ts`（没有一份测试
  // mock 过那个模块），所以这份文件测的是「真闸门读真设置」——闸门被 mock 掉的绿不算绿。
}));

// B57 起 ● 是矢量字形且槽位恒定存在（靠 opacity 显隐），脏状态改看 tab-dirty 类。
const dirty = (): boolean =>
  Array.from(document.querySelectorAll(".tab.tab-dirty")).some(
    (t) => t.querySelector(".tab-mark i.codicon") !== null,
  );

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 每按一次 Ctrl+/ 切一回视图模式。 */
async function toggleView(times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "/", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    await wait(60);
  }
}

describe("B391-5 装饰预览接进面板模型", () => {
  /**
   * ① 静态守卫：`createDecoMirror(` 的每一个调用点都必须落在
   * `isDecoPreviewEnabled(...)` 为**真**的那个分支块里（按大括号配平取块体，不按行号猜）。
   *
   * 这条不需要启动应用，也不必等 Task 5 的实现跑起来 —— 它是「关掉开关 ⇒ src/spike
   * 整个不可达」这条 Global Constraint 的唯一机械证明。
   */
  it("① 关着时不构造装饰实例（每个 createDecoMirror 调用点都在开关分支内）", () => {
    const src = readFileSync("src/tabs/lifecycle.ts", "utf-8");
    const callsites = src.split("createDecoMirror(").length - 1;
    expect(callsites, "预览构造点应改走 createDecoMirror").toBeGreaterThan(0);

    // 收集所有「条件里正向问 isDecoPreviewEnabled」的 if 块体。
    // ⚠️ 条件用 lazy `.+?` 而不是 `[^)]*`：`isDecoPreviewEnabled(settings)` 自带一层括号，
    //    后者会在第一个 `)` 处截断、再要求紧跟 `{`，于是**永远匹配不上**（第一版就栽在这儿：
    //    守卫数到 0 个分支，测试红得像是「没接线」，其实是判据自己写错了）。
    const guarded: Array<[number, number]> = [];
    const re = /if\s*\((.+?)\)\s*\{/g;
    for (let m = re.exec(src); m !== null; m = re.exec(src)) {
      const cond = m[1];
      if (!cond.includes("isDecoPreviewEnabled") || /!\s*isDecoPreviewEnabled/.test(cond)) continue;
      const open = m.index + m[0].length - 1;
      let depth = 0;
      let end = src.length;
      for (let i = open; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      guarded.push([open, end]);
    }
    expect(guarded.length, "应存在 isDecoPreviewEnabled 为真的分支").toBeGreaterThan(0);

    let idx = src.indexOf("createDecoMirror(");
    while (idx !== -1) {
      expect(
        guarded.some(([from, to]) => idx > from && idx < to),
        `调用点 ${idx} 不在开关分支内`,
      ).toBe(true);
      idx = src.indexOf("createDecoMirror(", idx + 1);
    }
  });

  it("② 开关开着：这一格预览侧的 DOM 是 .cm-editor，不是 .md-rendered", async () => {
    await import("../src/main");
    await wait(300);

    const decoHost = document.querySelector(".panel-host .md-deco-host");
    expect(decoHost, "开关开着 ⇒ 预览侧应挂装饰面宿主").not.toBeNull();
    expect(decoHost?.querySelector(".cm-editor"), "装饰面宿主里应是 CM6 视图").not.toBeNull();
    expect(
      document.querySelectorAll(".panel-host .md-deco-host .md-rendered").length,
      "装饰面里不该再出现派生 DOM（.md-rendered 是现方案的预览根）",
    ).toBe(0);
    // 现方案那颗 PreviewPane 不该还挂在树上（开关开着时它整个不该被构造）
    expect(document.querySelectorAll(".panel-host .md-preview.md-rendered").length).toBe(0);
  });

  it("③ 连切 20 次视图：不置脏、不排程写盘；真编辑才走一次自动保存", async () => {
    // 源码侧那颗 view 必须按 `.panel-editor` 取：装饰面也是 .cm-editor，
    // 用裸 `.cm-editor` 会先撞上预览侧那一颗（DOM 顺序：editor 在前，但 mode-* 一藏
    // 就等于换了一棵树可查）。
    const srcView = EditorView.findFromDOM(
      document.querySelector(".panel-editor .cm-editor") as HTMLElement,
    )!;
    expect(srcView, "源码侧编辑器应在").toBeTruthy();
    const before = srcView.state.doc.toString();
    expect(saved.length, "启动后不应写盘").toBe(0);

    await toggleView(20);
    expect(srcView.state.doc.toString(), "切换视图不得改内容").toBe(before);
    expect(dirty(), "切换 20 次视图不得置脏").toBe(false);
    expect(saved.length, "切换视图不得写盘（幽灵 docChanged 必须被判掉）").toBe(0);

    // 装饰面此刻显示的必须还是同一篇（镜像跟着换文档重新播种过）
    const decoView = EditorView.findFromDOM(
      document.querySelector(".md-deco-host .cm-editor") as HTMLElement,
    )!;
    expect(decoView.state.doc.toString(), "装饰面应与源码同文").toBe(before);

    // ---- 真编辑：置脏 + 一次自动保存 + 镜像跟着变（回写桥在真路径上通）----
    srcView.dispatch({ changes: { from: 0, insert: "X" } });
    await wait(50);
    expect(dirty(), "真实编辑必须置脏").toBe(true);
    expect(decoView.state.doc.toString(), "编辑必须经 ChangeSet 桥镜像进装饰面").toBe(
      srcView.state.doc.toString(),
    );
    await wait(1800);
    expect(saved.length, "真实编辑应且只应触发一次自动保存").toBe(1);
  });
});

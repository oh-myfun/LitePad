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
    const guarded: Array<[number, number, string]> = [];
    const re = /if\s*\((.+?)\)\s*\{/g;
    // 分支条件允许两种写法：① 直接问闸；② 问 `shouldMountDecoPreview`（B391F-3 起
    // 挂载点还要问「是不是 Markdown」「档位让不让自动预览」两条，三条挤在一个条件里
    // 就没法被谓词级判据量到）。**间接那一跳必须被证明是诚实的** —— 见下面两条断言：
    // 谓词本体要正向问闸、开关关着就 return false，否则这一路就是绕过闸的口子。
    const asksGate = (cond: string) =>
      (cond.includes("isDecoPreviewEnabled") || cond.includes("shouldMountDecoPreview(")) &&
      !/!\s*(isDecoPreviewEnabled|shouldMountDecoPreview)/.test(cond);
    for (let m = re.exec(src); m !== null; m = re.exec(src)) {
      if (!asksGate(m[1])) continue;
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
      guarded.push([open, end, m[1]]);
    }
    expect(guarded.length, "应存在 isDecoPreviewEnabled 为真的分支").toBeGreaterThan(0);

    if (guarded.some(([, , cond]) => cond.includes("shouldMountDecoPreview("))) {
      const at = src.indexOf("export function shouldMountDecoPreview");
      expect(at, "挂载点走谓词，而谓词不在本文件里 ⇒ 闸链断了").toBeGreaterThan(-1);
      const body = src.slice(at, src.indexOf("\n}", at));
      expect(
        body.includes("!isDecoPreviewEnabled(settings)") && body.includes("return false"),
        "谓词本体必须「开关关着就 return false」，否则分支条件绕过了那道闸",
      ).toBe(true);
    }

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

  /**
   * ④⑤⑥ 是最终评审抓出来的三条（评审 Important #1 与 #5）。三条都按**行为**判，
   * 不按源码文本判 —— 写它们的时候生产代码还没改，所以每条都先红过一次：
   * ④ 旧镜像没被 destroy（重建一次漏一颗活视图，CM6 的 `selectionchange` 是挂在
   *    `document` 上的，只有 `destroy()` 会摘）；⑤ 桥只看长度，等长的另一篇文档
   *    会被套上别人的变更；⑥ 桥写完整态面却没在账本里认领，那一面自己的裁剪会被
   *    判成「用户滚动」广播回源码（Review Focus 第 2 条那个「位置抖动」）。
   */
  it("④ rebuildLayout 之前必须拆掉旧的装饰实例", async () => {
    await import("../src/main");
    const { panels } = await import("../src/core/app-state");
    const { rebuildLayout } = await import("../src/tabs");
    const p = [...panels.values()][0];
    const first = p.decoMirror;
    expect(first, "开关开着时这一格应有装饰实例").toBeTruthy();

    // `EditorView.destroyed` 是私有字段（tsc 拦），所以按「`destroy()` 有没有被调到」判：
    // 包住原型方法、记下 every receiver —— 旧的那颗必须出现在里面。
    // 判别力先证过一次：加这行守卫之前，第一版按 `view.destroyed` 读到的就是 `false`。
    const destroyed: unknown[] = [];
    const orig = EditorView.prototype.destroy;
    const spy = vi.spyOn(EditorView.prototype, "destroy").mockImplementation(function (
      this: EditorView,
    ) {
      destroyed.push(this);
      return orig.call(this);
    });

    rebuildLayout();
    spy.mockRestore();

    expect(
      destroyed,
      "旧装饰视图必须 destroy（CM6 的 selectionchange 挂在 document 上，只有 destroy() 会摘）",
    ).toContain(first!.view);
    expect(p.decoMirror, "重建后这一格应有新的装饰实例").toBeTruthy();
    expect(p.decoMirror).not.toBe(first);
  });

  it("⑤ 镜像躺着别的文档时桥必须拒收（等长也不会被写出花）", async () => {
    await import("../src/main");
    const { panels, tabs } = await import("../src/core/app-state");
    const { syncDecoMirrors } = await import("../src/tabs");
    const { reseedDecoMirror } = await import("../src/spike/deco/mirror");
    const p = [...panels.values()].find((x) => x.decoMirror)!;
    const mirror = p.decoMirror!;
    const shown = tabs.get(p.viewTabId ?? p.activeTabId)!;
    const srcView = EditorView.findFromDOM(
      document.querySelector(".panel-editor .cm-editor") as HTMLElement,
    )!;
    const other = "x".repeat(srcView.state.doc.length);
    // 换显示但没重新播种那一形（`tabs/split.ts` / `io/files.ts` 两处还没接线）留下的状态：
    // 面板说的是 doc1，镜像里躺着的是**另一篇等长**文档。
    reseedDecoMirror(mirror, other, 999);
    const tr = srcView.state.update({ changes: { from: 0, insert: "Y" } });

    syncDecoMirrors(shown, tr.changes);

    expect(mirror.view.state.doc.toString(), "桥不得把别人的文档的变更套进这颗镜像").toBe(other);
  });

  it("⑥ 桥写进镜像之后必须在账本里认领那一发", async () => {
    await import("../src/main");
    const { panels, tabs } = await import("../src/core/app-state");
    const { syncDecoMirrors } = await import("../src/tabs");
    const { syncCoordinator } = await import("../src/sync-scroll/wire");
    const { reseedDecoMirror } = await import("../src/spike/deco/mirror");
    const p = [...panels.values()].find((x) => x.decoMirror)!;
    const mirror = p.decoMirror!;
    const shown = tabs.get(p.viewTabId ?? p.activeTabId)!;
    const srcView = EditorView.findFromDOM(
      document.querySelector(".panel-editor .cm-editor") as HTMLElement,
    )!;
    reseedDecoMirror(mirror, srcView.state.doc.toString(), shown.docId); // 回到同文档同文
    const before = mirror.view.state.doc.toString();
    const spy = vi.spyOn(syncCoordinator, "expectSurfaceV");
    const tr = srcView.state.update({ changes: { from: 0, insert: "Z" } });

    syncDecoMirrors(shown, tr.changes);
    const claimed = spy.mock.calls.some(([el]) => el === mirror.view.scrollDOM);
    spy.mockRestore();

    expect(mirror.view.state.doc.toString(), "前置：这一发应真的写进了镜像").not.toBe(before);
    expect(claimed, "写完整态面要按「落在哪就是哪」认领，否则它的裁剪被当作用户滚动广播回去").toBe(
      true,
    );
  });
});

/**
 * B391F-1 · 装饰面必须吃编辑器的三条排版 token。
 *
 * 装饰面宿主 `.md-deco-host` 是 `.panel-host` 的直接子节点、**不在 `.panel-editor` 里**，
 * 而这三条规则的选择器全都以 `.panel-host .panel-editor` 打头 ⇒ 字号 / 字体 / 行距一条没落到它身上。
 * 真机量出来的后果：同一篇 5001 行、同一 `clientHeight` 667，源码格 `scrollHeight=90296`、
 * 装饰面 `scrollHeight=69019` ⇒ 行距 18.05px vs 13.80px —— 同一份文档两套几何，
 * 「relayout 后顶边差一行」（P2-4）就是这笔几何差的零头。所以这一条不是美观问题，是落位问题。
 */
describe("B391F-1 装饰面吃编辑器排版 token", () => {
  /** 抹掉注释再按 `selector { body }` 拆块（注释里的散文会喂假判据）。 */
  function cssBlocks(): { sel: string; body: string }[] {
    const raw = readFileSync("src/styles/global.css", "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
    const out: { sel: string; body: string }[] = [];
    for (const m of raw.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      out.push({ sel: m[1].trim(), body: m[2] });
    }
    return out;
  }

  const coversDeco = (decl: string) =>
    cssBlocks().some(
      (b) =>
        b.body.includes(decl) &&
        b.sel.split(",").some((s) => s.includes(".md-deco-host") && s.includes(".cm-")),
    );

  for (const [name, decl] of [
    ["字号", "font-size: var(--font-size)"],
    ["字体", "var(--font-code)"],
    ["行距", "line-height: var(--editor-line-height"],
  ] as const) {
    it(`${name}：有一条把该声明给到 .md-deco-host 里 .cm-* 的规则`, () => {
      expect(coversDeco(decl), `global.css 里没有覆盖装饰面宿主的「${decl}」规则`).toBe(true);
    });
  }
});

/**
 * B391F-2 · 四条同形路径的播种守卫。
 *
 * 不变量：**谁给面板的 view 换 state，谁就得给这一格的装饰面播种一次**。
 * 装饰面不是 Tab 实例，不在 `syncDocInstances` 的兄弟遍历里 —— 换完 state 不播种，
 * 镜像就停在旧文档上，而桥的归属闸（判据 ⑤）会正确地拒收别人的变更，
 * 于是症状是「预览面显示一篇旧文、再也不跟着动」（数据不坏，但那一格死了）。
 * 静态数一遍是这里最划算的判据：漏接线的那一形在 jsdom 里造齐四条真路径的成本太高。
 */
describe("B391F-2 换 state 必播种装饰面", () => {
  for (const f of ["src/tabs/lifecycle.ts", "src/tabs/split.ts", "src/io/files.ts"]) {
    it(`${f}：refreshDecoMirror 的发数不少于 view.setState 的发数`, () => {
      const src = readFileSync(f, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "") // 注释里提到函数名不算接线
        .replace(/^\s*\/\/.*$/gm, "");
      const sets = (src.match(/view\.setState\(/g) ?? []).length;
      const seeds = (src.match(/refreshDecoMirror\(/g) ?? []).length;
      expect(sets, `${f} 一条 setState 都没有 ⇒ 判据空转，先确认扫描点没搬走`).toBeGreaterThan(0);
      expect(
        seeds,
        `${f}：${sets} 发 view.setState，只有 ${seeds} 发装饰面播种`,
      ).toBeGreaterThanOrEqual(sets);
    });
  }
});

/**
 * B391F-3 · 挂载装饰面的三道闸（spike 结果文档⑤切片 11 那一形）。
 *
 * 走谓词而不是整窗启动：jsdom 里造一篇 `.txt` 与一份 `huge` 文档的**真**面板成本，
 * 全花在装配夹具上，判据本身一个字都不多。谓词在 `lifecycle.ts` 里，
 * `mountView` 那条分支只调它 —— 闸少一处，判据才量得到全部。
 */
describe("B391F-3 装饰面挂载的三道闸", () => {
  let docSeq = 9100;

  async function tabOf(name: string, sizeClass: "normal" | "large" | "huge") {
    const { docs } = await import("../src/core/app-state");
    const { makeDoc, makeInstance, registerDoc } = await import("../src/doc-model");
    const doc = makeDoc(
      ++docSeq,
      "# 标题\n\n正文",
      name,
      `E:\\tmp\\${name}`,
      "UTF-8",
      "LF",
      false,
      sizeClass,
    );
    registerDoc(doc);
    return { tab: makeInstance(doc, 0, "# 标题\n\n正文"), docId: doc.tabId, docs };
  }

  async function setDeco(on: boolean): Promise<void> {
    const { settings } = await import("../src/core/app-state");
    settings!.deco_preview = on;
  }

  it("开关关着 ⇒ 一篇普通 .md 也不挂（`src/spike/**` 不进运行路径）", async () => {
    const { tab } = await tabOf("a.md", "normal");
    const { shouldMountDecoPreview } = await import("../src/tabs/lifecycle");
    await setDeco(false);
    expect(shouldMountDecoPreview(tab)).toBe(false);
  });

  it("开关开着 + Markdown + normal ⇒ 挂", async () => {
    const { tab } = await tabOf("b.md", "normal");
    const { shouldMountDecoPreview } = await import("../src/tabs/lifecycle");
    await setDeco(true);
    expect(shouldMountDecoPreview(tab), "这一形是装饰面的正题，判 false 就等于把功能关了").toBe(
      true,
    );
  });

  for (const cls of ["large", "huge"] as const) {
    it(`开关开着 + Markdown + ${cls} 档 ⇒ 不挂（生产那一档是「停用自动预览 + 给提示」）`, async () => {
      const { tab } = await tabOf(`c-${cls}.md`, cls);
      const { shouldMountDecoPreview } = await import("../src/tabs/lifecycle");
      await setDeco(true);
      expect(shouldMountDecoPreview(tab)).toBe(false);
    });
  }

  it("开关开着 + 非 Markdown（.txt）⇒ 不挂（装饰面吃 markdown 语法树）", async () => {
    const { tab } = await tabOf("d.txt", "normal");
    const { shouldMountDecoPreview } = await import("../src/tabs/lifecycle");
    await setDeco(true);
    expect(shouldMountDecoPreview(tab)).toBe(false);
  });

  it("孤儿实例（文档不在册）⇒ 不挂，且**不许抛**", async () => {
    const { shouldMountDecoPreview } = await import("../src/tabs/lifecycle");
    await setDeco(true);
    const ghost = await tabOf("e.md", "normal");
    ghost.docs.delete(ghost.docId); // 抽掉文档记录：`docOf` 这一形会抛
    expect(() => shouldMountDecoPreview(ghost.tab)).not.toThrow();
    expect(shouldMountDecoPreview(ghost.tab)).toBe(false);
    expect(shouldMountDecoPreview(undefined), "空面板没有活动标签 ⇒ 同样不挂").toBe(false);
  });
});

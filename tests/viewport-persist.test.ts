// @vitest-environment jsdom
// B132 · 「视口位置还是没保存恢复」的真因不在存取两端，而在**保存时机**：
//   ① 滚动只把位置写进内存快照，**没有排程落盘** —— 用户滚到中段、没干别的事就关窗，
//      会话里留下的还是滚之前那份；
//   ② 关窗时若无脏文档，代码直接 `return` 放行，**一次快照都不拍** —— 而「干净文档 +
//      滚过位置」恰恰是最常见的不相干组合。
// 存与转存都是好的，坏在「谁在什么时候去存」。
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

/**
 * 截获 `onCloseRequested`、落盘载荷，外加一路**调用序列**：
 * 「先存再关」这条契约靠 `events` 的顺序断言，光看 saveSession 被调用过抓不住
 * —— 上一版正是「调了但没等它返回」，用例全绿而真机照样丢。
 */
const wired = vi.hoisted(() => ({
  close: null as ((ev: { preventDefault(): void }) => void) | null,
  events: [] as string[],
  saved: [] as {
    panels: { tabs: { path: string; scrollTop: number | null; cursorLine?: number }[] }[];
  }[],
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTitle: () => Promise.resolve(),
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    isAlwaysOnTop: () => Promise.resolve(false),
    setAlwaysOnTop: () => Promise.resolve(),
    // 留着真回调：关窗这条链要**真跑一遍**才知道「无脏文档那支是不是压根没存」
    onCloseRequested: (cb: (ev: { preventDefault(): void }) => void) => {
      wired.close = cb;
      return Promise.resolve({ catch: () => {} });
    },
    // 关窗动作也要记进序列：用来证明「存」确实排在「关」前面
    close: () => {
      wired.events.push("close");
      return Promise.resolve();
    },
    // B135：收尾现在走 destroy()（close() 会再发一次 CloseRequested，容易绕回来）。
    // 同样记成 "close"，好让顺序断言继续盯住「存 → 关」这一件事。
    destroy: () => {
      wired.events.push("close");
      return Promise.resolve();
    },
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

/** 20 行文本，够区分「滚之前」和「滚之后」。 */
const docText = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

vi.mock("../src/ipc/api", () => ({
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve(["UTF-8"]),
  listEols: () => Promise.resolve(["CRLF", "LF"]),
  // 会话里 scrollTop 落 0：说明「恢复前」那份；用例要证明它会被**后来的滚动**顶掉
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
      // 故意关掉热退出：这样走的就是「无脏文档 → 直接放行」那一支
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
  // 落盘载荷留档：用例要断言「存下来的那份视口是滚之后的」
  saveSession: (state: { panels: { tabs: { path: string; scrollTop: number | null }[] }[] }) => {
    wired.events.push("save");
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

function editorView(): EditorView {
  const dom = document.querySelector(".layout-panel .cm-editor") as HTMLElement;
  return EditorView.findFromDOM(dom)!;
}
/** 滚到某个位置并派发一次真 scroll 事件（监听器就挂在 scrollDOM 上）。 */
function scrollTo(px: number): void {
  const sc = editorView().scrollDOM;
  sc.scrollTop = px;
  sc.dispatchEvent(new Event("scroll", { bubbles: false }));
}
function lastSaved(): number | null {
  const last = wired.saved[wired.saved.length - 1];
  return last?.panels[0]?.tabs[0]?.scrollTop ?? null;
}

describe("B132 视口位置：滚动要能自己排程落盘，关窗要兜底存一次", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(300);
  });

  it("① 滚动后不做任何别的动作：会话必须自己落盘一次，且存的是滚之后的视口", async () => {
    const before = wired.saved.length;
    scrollTo(500);
    await wait(900); // 越过 800ms 防抖
    expect(wired.saved.length, "滚动应自己排程落盘（否则关窗前那一刻=没存）").toBeGreaterThan(
      before,
    );
    expect(lastSaved(), "落盘的视口应是滚动后的 500，而不是会话里的 0").toBe(500);
  });

  it("② 无脏文档关窗：先拦下窗口、存完再关（Rust 侧没有关窗钩子，不等就白存）", async () => {
    expect(wired.close, "应已装上关窗收接").toBeTruthy();
    const before = wired.saved.length;
    let prevented = false;
    wired.events.length = 0; // 只看这一次关窗的先后顺序
    wired.close!({
      preventDefault: () => {
        prevented = true;
      },
    });
    await wait(150);
    expect(prevented, "无脏文档也要先拦住默认关闭，否则进程收尾、IPC 白发").toBe(true);
    expect(wired.saved.length, "无脏文档关窗也要存现场").toBeGreaterThan(before);
    // 关键：顺序。'close' 一旦排在 'save' 前面，存就赶不上窗口关闭了。
    // 设置不进这条序列：它在设置窗口里改动时就存了，关窗不重复写（B140）。
    expect(wired.events, "必须先落盘（save）、再关窗（close）").toEqual(["save", "close"]);
    expect(lastSaved(), "关窗时存的应是当前视口 500").toBe(500);
  });

  it("③ 移光标 + 滚动后直接关窗：落盘的就是此刻的（B140）", async () => {
    // `t.state` 只在切标签 / 重建 / 拖标签那几处回写，所以「打开 → 改 → 直接关窗」
    // 落下去的是打开时那份。这里刻意**不派发 scroll 事件**（jsdom 裸写就是不派发），
    // 也正是「最后一次变化没有事件」那条最刁钻的路径。
    const v = editorView();
    v.dispatch({ selection: { anchor: v.state.doc.line(8).from } });
    v.scrollDOM.scrollTop = 300;
    await wait(50);

    wired.events.length = 0;
    wired.close!({ preventDefault: () => {} });
    await wait(150);

    const last = wired.saved[wired.saved.length - 1];
    const tab = last?.panels[0]?.tabs.find((t) => t.path === "a.md");
    expect(tab?.cursorLine, "落盘的光标应是此刻的第 8 行，不是打开时的第 1 行").toBe(8);
    expect(tab?.scrollTop, "落盘的视口应是此刻的 300").toBe(300);
  });
});

/**
 * B135 关窗死锁（回调里 await IPC ⇒ 永久卡死）之后的关窗契约，三条缺一不可：
 *   ① 回调只做「拦窗 + 丢一条没人 await 的收尾」：`event.preventDefault()` 必须排在
 *      `void finishAndDestroy(dirty)` **之前**，且收尾**不带 await**。
 *   ② 收尾内部，无脏文档那支要先 `await persistSession()`。
 *   ③ 收尾以 `destroySelf()` 收场 —— `destroy()` 不发 CloseRequested，不会绕回来；
 *      `close()` 会再发一次。
 */
const CLOSE_CALLBACK =
  /onCloseRequested\(\(event\) => \{[\s\S]{0,900}?event\.preventDefault\(\);[\s\S]{0,200}?void finishAndDestroy\(dirty\);/;
const CLEAN_BRANCH = /if \(dirty\.length === 0\) \{[\s\S]{0,200}?await persistSession\(\);/;
const CLOSE_TAIL = /async function finishAndDestroy[\s\S]{0,4000}?await destroySelf\(\);/;

/** 取出某个函数的完整函数体（花括号配对）。用来对整段做「不许有 await」这类更强契约。 */
function functionBody(src: string, header: string): string {
  const at = src.indexOf(header);
  if (at < 0) throw new Error(`找不到 ${header}`);
  const open = src.indexOf("{", at + header.length - 1);
  if (open < 0) throw new Error(`${header} 没有左花括号`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`${header} 的花括号没配平`);
}

/** 去掉注释（块注释 + 行注释），免得注释里的字样被当成代码。`:` 后跟 `//` 的算协议，不算注释。 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("B132 静态契约：滚动排程 + 关窗兜底", () => {
  const src = readFileSync("src/main.ts", "utf-8");

  it("滚动监听里要排程会话保存，关窗的放行支要走「拦下 → 存完 → 再关」", () => {
    expect(src, "滚动后要排程落盘").toMatch(
      /if \(t\) t\.scrollTop = shownView\.scrollDOM\.scrollTop;[\s\S]{0,220}?scheduleSessionSave\(\);/,
    );
    expect(src, "关窗回调要『先拦下 → 再丢一条没人 await 的收尾』").toMatch(CLOSE_CALLBACK);
    expect(src, "无脏文档那支要先等会话落盘，光排队等于没存").toMatch(CLEAN_BRANCH);
    expect(src, "收尾要以 destroy() 收场（close() 会再发一次 CloseRequested）").toMatch(CLOSE_TAIL);
    // 收尾一律 destroy()：退回 close() 就会二次触发关窗流程
    const tailFrom = src.indexOf("async function finishAndDestroy");
    expect(src.slice(tailFrom), "收尾里出现 close() 是退回会绕回来的写法").not.toMatch(
      /getCurrentWindow\(\)\s*\.\s*close\(\)/,
    );
  });

  it("B140 落盘前要把当前视图的最新状态回写进标签（光标 / 视口）", () => {
    // `t.state` 只在切标签 / 重建 / 拖标签那几处回写过，直接关窗落的是打开时那份。
    expect(src, "快照出口要先同步一次").toMatch(
      /function snapshotSession\(\): Parameters<typeof saveSession>\[0\] \{\s*\n\s*syncShownViewToTab\(\);/,
    );
    expect(src, "同步要同时回写 state 与视口").toMatch(
      /function syncShownViewToTab\(\): void \{[\s\S]{0,200}?t\.state = p\.view\.view\.state;[\s\S]{0,120}?rememberViewScroll\(p\);/,
    );
  });

  it("反向验证：两条退化都要被上一条抓住", () => {
    // ⚠️ 拆卸与断言必须用**同一条精确串**（老规矩）：按缩进猜字符串这次又没对上，
    // 结果「没拆掉」却被判成「拆掉了」—— 一条假绿。改成同一个正则做替换。
    const SCROLL_ANCHOR =
      /if \(t\) t\.scrollTop = shownView\.scrollDOM\.scrollTop;[\s\S]{0,220}?scheduleSessionSave\(\);/;
    const degradedScroll = src.replace(
      SCROLL_ANCHOR,
      "if (t) t.scrollTop = shownView.scrollDOM.scrollTop;",
    );
    expect(degradedScroll, "退化后滚动分支不应再有排程").not.toMatch(SCROLL_ANCHOR);

    // 退化 1：回调里 `await` 收尾 —— 这就是 B135 实测永久死锁的写法，契约必须抓住
    const degradedAwait = src.replace(
      "void finishAndDestroy(dirty);",
      "await finishAndDestroy(dirty);",
    );
    expect(degradedAwait, "关窗回调里 await 任何 IPC 都会死锁，契约必须拦下").not.toMatch(
      CLOSE_CALLBACK,
    );
    // 退化 2：不等落盘就关
    const degradedNoWait = src.replace("await persistSession();", "persistSession();");
    expect(degradedNoWait, "不等会话落盘就关窗等于没存").not.toMatch(CLEAN_BRANCH);
    // 退化 3：退回 close()
    const degradedCloseCall = src.replaceAll(
      "await destroySelf();",
      "await getCurrentWindow().close();",
    );
    expect(degradedCloseCall, "收尾退回 close() 会二次触发关窗流程").not.toMatch(CLOSE_TAIL);

    // 退化 4：快照出口不做同步（B140 前状）—— 编辑 / 移光标 / 滚动后直接关窗，
    // 落下去的还是打开时那份
    const degradedNoSync = src.replace(
      "function snapshotSession(): Parameters<typeof saveSession>[0] {\n  syncShownViewToTab();",
      "function snapshotSession(): Parameters<typeof saveSession>[0] {",
    );
    expect(degradedNoSync, "少了同步就该被 B140 契约抓住").not.toMatch(
      /function snapshotSession\(\): Parameters<typeof saveSession>\[0\] \{\s*\n\s*syncShownViewToTab\(\);/,
    );
  });

  // ⚠️ B135 最狠的一条：流转成代码「看着对」、静态正则也 full-match，真机却永久死锁。
  // 光匹配片段不够 —— 得整段扫：关窗回调体内**一个 await 都不许有**。
  it("B135：两个关窗回调体内不许出现任何 await（整段扫描）", () => {
    const mainBody = functionBody(src, "function registerWindowClose(): void {");
    // 注释里满篇都是「await」这个词，先剥掉再扫真代码
    const mainCode = stripComments(mainBody);
    expect(mainCode, "主窗口关窗回调体内不许 await 任何东西（含收尾）").not.toMatch(/await\b/);
    expect(mainCode, "主窗口关窗回调要『先拦下 → 再丢一条没人 await 的收尾』").toMatch(
      /event\.preventDefault\(\);[\s\S]{0,200}?void finishAndDestroy\(dirty\);/,
    );

    const satCode = stripComments(functionBody(src, "function registerSatelliteClose(): void {"));
    expect(satCode, "卫星窗口关窗回调体内同样不许 await（卫星关窗曾一起死锁）").not.toMatch(
      /await\b/,
    );
    expect(satCode, "卫星窗口关窗回调要以 destroySelf() 收场").toMatch(
      /void finishSatelliteClose\(\);/,
    );
    expect(satCode, "卫星窗口关窗回调要拦窗").toMatch(/event\.preventDefault\(\);/);

    // 反证：把退化写法（回调里 await 收尾）塞回去，整段扫描必须报警
    const degraded = stripComments(
      mainBody.replace("void finishAndDestroy(dirty);", "await finishAndDestroy(dirty);"),
    );
    expect(degraded, "退化后整段扫描应抓到 await").toMatch(/await\b/);
  });
});

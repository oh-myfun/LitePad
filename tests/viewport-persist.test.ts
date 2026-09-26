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
  saved: [] as { panels: { tabs: { path: string; scrollTop: number | null }[] }[] }[],
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
    // 关键：顺序。'close' 一旦排在 'save' 前面，存就赶不上窗口关闭了
    expect(wired.events, "必须先落盘（save）、再关窗（close）").toEqual(["save", "close"]);
    expect(lastSaved(), "关窗时存的应是当前视口 500").toBe(500);
  });
});

/** 「无脏文档」这支的完整流程：拦下 → 存完 → 自己关。缺任意一环都算没做。 */
const CLOSE_FLOW =
  /if \(dirty\.length === 0\) \{[\s\S]{0,200}?event\.preventDefault\(\);[\s\S]{0,240}?await persistSession\(\);[\s\S]{0,200}?await getCurrentWindow\(\)\.close\(\);/g;

describe("B132 静态契约：滚动排程 + 关窗兜底", () => {
  const src = readFileSync("src/main.ts", "utf-8");

  it("滚动监听里要排程会话保存，关窗的放行支要走「拦下 → 存完 → 再关」", () => {
    expect(src, "滚动后要排程落盘").toMatch(
      /if \(t\) t\.scrollTop = shownView\.scrollDOM\.scrollTop;[\s\S]{0,220}?scheduleSessionSave\(\);/,
    );
    expect(src, "无脏文档关窗要『拦下→存完→再关』，光存不等等于没存").toMatch(CLOSE_FLOW);
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

    const degradedClose = src.replaceAll(CLOSE_FLOW, "if (dirty.length === 0) {}");
    expect(degradedClose, "退化后放行支不应再有『存完再关』").not.toMatch(CLOSE_FLOW);
  });
});

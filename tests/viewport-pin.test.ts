// @vitest-environment jsdom
// B134 · 「位置恢复有问题，打开后位置全部变回了顶部（预览模式时切换标签后编辑器里
// 位置也回到顶部了）」。
//
// 排除了保存侧（B132/B133 已修好落盘时机），剩下的只有**恢复侧**：赋值那一刻容器
// 常常还没布局完 —— 编辑器刚从 `display:none` 出来、预览刚 `setBlocks` 把内容撑开。
// 浏览器按规范会把「超出可滚动范围」的赋值**裁掉**，未布局时就是裁成 0；这次赋值
// 还会派发 scroll 事件，把 0 写回快照。于是「设上了又弹回顶部」，下一轮存的也是 0。
//
// jsdom 不做布局，赋值永远读得回来，所以这里给 scroller 装一个**会裁剪的 scrollTop**
// （复刻浏览器行为），看位置能不能在布局稳定后仍然立住。
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

const docText = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");

vi.mock("../src/ipc/api", () => ({
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve(["UTF-8"]),
  listEols: () => Promise.resolve(["CRLF", "LF"]),
  // 两个标签各记一份**互不相同**的视口：共享一个值的话，测不出「谁钉住了谁」
  loadSession: () =>
    Promise.resolve({
      activePanel: 0,
      panels: [
        {
          // 激活的是**第二个**（b.md）：这样用例点第一个标签时才是一次真的切换
          // （`switchTab` 对当前已激活的标签是直接早退的，点了个寂寞）。
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
  saveSession: () => Promise.resolve(),
  saveSettings: () => Promise.resolve(),
  writeBackup: () => Promise.resolve(),
  restoreBackup: () => Promise.resolve(null),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
}));

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 复刻「赋值那一刻还没布局」：布局就绪之前的赋值会被裁成 0，之后才按真实可滚动范围收。
 * 布局就绪的那一帧由用例自己安排（先于恢复动作注册），正好对应真机上
 * 「切标签/挂载那一帧内容还没撑开」。
 */
const geom = vi.hoisted(() => ({ ready: false }));

function installClampingScroll(): void {
  const sc = document.querySelector(".layout-panel .cm-scroller") as HTMLElement | null;
  if (!sc) throw new Error("找不到 .cm-scroller");
  let real = 0;
  Object.defineProperty(sc, "scrollTop", {
    configurable: true,
    get: () => real,
    set: (v: number) => {
      if (!geom.ready) {
        real = 0; // 未布局：读回来就是被裁过的 0
        sc.dispatchEvent(new Event("scroll"));
      } else {
        real = Math.max(0, v);
      }
    },
  });
}

function clickTab(i: number): void {
  const tabs = Array.from(document.querySelectorAll(".layout-panel .tab")) as HTMLElement[];
  const el = tabs[i];
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

describe("B134 视口恢复：赋值被浏览器裁剪后要能钉回来", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(300);
    // 就在切换之前安排「下一帧布局就绪」
    requestAnimationFrame(() => {
      geom.ready = true;
    });
  });

  it("切回那个视口 500 的标签：位置必须在布局稳定后仍然立住（而不是被裁成 0）", async () => {
    installClampingScroll();
    expect(geom.ready, "用例应已安排好布局就绪的那一帧").toBe(false);

    // 点 a.md（500）—— 这次赋值发生在布局就绪那一帧之前
    clickTab(0);
    expect(scrollTopNow(), "赋值当帧应已被浏览器裁掉").toBe(0);

    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await wait(60);
    expect(scrollTopNow(), "布局稳定后位置应钉回 500，而不是停在顶部").toBe(500);
  });
});

describe("B134 静态契约：两条恢复路径都要走「钉稳」", () => {
  const src = readFileSync("src/main.ts", "utf-8");

  it("编辑器侧与预览侧都不得裸写 scrollTop", () => {
    expect(src, "编辑器侧要走 pinScrollTop").toMatch(
      /if \(t\.scrollTop !== null\) \{\s*\n\s*pinScrollTop\(view\.scrollDOM, t\.scrollTop\);/,
    );
    expect(src, "预览侧要走 pinScrollTop（同一帧 setBlocks 会把高度撑开）").toMatch(
      /const root = panel\.preview\.root as HTMLElement;[\s\S]{0,200}?pinScrollTop\(root, px\);/,
    );
  });

  it("反向验证：退化成裸写 scrollTop 后，上一条必须抓住", () => {
    const PIN = /pinScrollTop\(view\.scrollDOM, t\.scrollTop\);/g;
    const degradedEditor = src.replaceAll(PIN, "view.scrollDOM.scrollTop = t.scrollTop!;");
    expect(degradedEditor, "退化后编辑器侧不应再有钉稳").not.toMatch(PIN);
    expect(degradedEditor, "退化后仍应是裸写").toMatch(/view\.scrollDOM\.scrollTop = t\.scrollTop/);

    const PIN_PREVIEW = /pinScrollTop\(root, px\);/g;
    const degradedPreview = src.replaceAll(PIN_PREVIEW, "root.scrollTop = px;");
    expect(degradedPreview, "退化后预览侧不应再有钉稳").not.toMatch(PIN_PREVIEW);
  });
});

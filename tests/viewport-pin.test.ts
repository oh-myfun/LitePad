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
//
// B136：编辑器那半边不再走 px 了 —— 位置改记**顶行行号**，还原交给 CM6 自己的
// `scrollIntoView`（在 measure 里、布局之后执行，天然躲开「赋值太早被裁」）。
// 这条用例因此转盯两件事：**编辑器侧不许再把 px 写回 scrollDOM**、**还原按行号生效**。
// 预览那半边（HTML 块流，没有稳定行坐标）仍用 px，钉稳的契约原样保留。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";
import { installViewportSpy, takeViewportTargets } from "./viewport-target";

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
              // B136：编辑器侧的位置是**顶行行号**（不是 px）。
              // 20 与 45 都在这个 60 行的文档里，够区分「谁定位到了谁」。
              topLine: 20,
              scrollTop: null,
            },
            {
              path: "b.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 2,
              cursorCol: 1,
              topLine: 45,
              scrollTop: null,
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
    installViewportSpy();
    await import("../src/main");
    await wait(300);
    // 就在切换之前安排「下一帧布局就绪」
    requestAnimationFrame(() => {
      geom.ready = true;
    });
  });

  it("切回那个存了 topLine 20 的标签：按行号定位，且编辑器侧不再被塞 px", async () => {
    installClampingScroll();
    // B136：先把布局判成就绪 —— 这样「不许写 px」不是靠「写进去又被裁成 0」蒙对的，
    // 而是**写进去就该是那个值**，结果仍是 0 就说明压根没写。
    geom.ready = true;

    clickTab(0); // a.md，会话里记的是第 20 行
    expect(scrollTopNow(), "编辑器视口不得再把 px 写回 scrollDOM（B136 取消 px fallback）").toBe(0);

    // 定位本身按行号生效：把第 20 行顶到视口顶部
    const targets = takeViewportTargets();
    const onLine20 = targets.filter((t) => lineOfPos(viewOfPanel(), t.pos) === 20);
    expect(
      onLine20.length,
      `应定位到会话里那一行（20），实际收到：${JSON.stringify(targets)}`,
    ).toBeGreaterThan(0);
    expect(
      onLine20.some((t) => t.y === "start"),
      "应把顶行对齐到视口顶部（而不是居中/最小滚动）",
    ).toBe(true);
  });
});

/** 面板里的编辑器视图（jsdom 下与 main.ts 拿到的是同一个）。 */
function viewOfPanel(): EditorView {
  const dom = document.querySelector(".layout-panel .cm-editor") as HTMLElement | null;
  if (!dom) throw new Error("面板里没有编辑器");
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error("找不到 EditorView");
  return view;
}

/** 一个文档偏移落在第几行。 */
function lineOfPos(view: EditorView, pos: number): number {
  return view.state.doc.lineAt(Math.min(Math.max(pos, 0), view.state.doc.length)).number;
}

describe("B134 静态契约：预览侧仍要「钉稳」，编辑器侧不再写 px", () => {
  const src = readFileSync("src/main.ts", "utf-8");

  it("预览侧要走 pinScrollTop，编辑器侧不得再回写 px", () => {
    expect(src, "预览侧要走 pinScrollTop（同一帧 setBlocks 会把高度撑开）").toMatch(
      /const root = panel\.preview\.root as HTMLElement;[\s\S]{0,200}?pinScrollTop\(root, px\);/,
    );
    // B136：编辑器侧的位置回流一律走 CM6 的 scrollIntoView，px 写回这条路已经拆掉
    expect(src, "编辑器恢复不得再把 px 写回 scrollDOM").not.toMatch(
      /view\.scrollDOM\.scrollTop = t\.scrollTop/,
    );
  });

  it("反向验证：退化成裸写 scrollTop 后，上一条必须抓住", () => {
    const PIN_PREVIEW = /pinScrollTop\(root, px\);/g;
    const degradedPreview = src.replaceAll(PIN_PREVIEW, "root.scrollTop = px;");
    expect(degradedPreview, "退化后预览侧不应再有钉稳").not.toMatch(PIN_PREVIEW);

    const degradedEditor = src.replace(
      "return { topLine: topVisibleLineOf(p.view.view), scrollTop: null };",
      "return { topLine: null, scrollTop: t.topLine }; // B136 退化：编辑器侧回写 px\n  view.scrollDOM.scrollTop = t.scrollTop!;",
    );
    expect(degradedEditor, "退化实现应真的换了写法").not.toBe(src);
    expect(degradedEditor, "退化成编辑器侧回写 px 后必须被上一条抓到").toMatch(
      /view\.scrollDOM\.scrollTop = t\.scrollTop/,
    );
  });
});

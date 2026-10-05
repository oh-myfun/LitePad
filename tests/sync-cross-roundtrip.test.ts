// @vitest-environment jsdom
// B241：跨侧（预览 ⇄ 源码）切换的**往返闭合性**。
// jsdom 默认没有布局（getBoundingClientRect 全 0 ⇒ blockTop 退化成恒等于 scrollTop，
// 每轮换算固定掉 8px，看起来的「越切越歪」其实是退化假象）。
// 这里给预览造一个**确定性的布局**（每个块一行 20px、块顶 = 行号 × 20），
//   于是「滚预览 → 切源码 → 切预览」的往返闭合与否才判得出来 —— 这层布局是这条
//   用例的全部价值：没有它（jsdom 默认 rect 全 0）预览换算会退化，测出来的是假象。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

// 行高（px）。预览的往返换算全靠这个数对得上。
const ROW = 20;

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;

  // ⚠️ 造布局：预览容器本身的顶边 = 它自己的 scrollTop（内容区随滚动上移），
  //    其它块按 data-line-start 排开 —— `blockTop` 的口径就还原成真实浏览器那样。
  const proto = window.Element.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
  };
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    const el = this as HTMLElement;
    const isRoot = el.classList.contains("md-preview");
    const top = isRoot ? el.scrollTop : Number(el.dataset?.lineStart ?? 0) * ROW;
    const height = isRoot ? el.clientHeight || 0 : ROW;
    const r: Record<string, number> = {
      top,
      left: 0,
      right: 600,
      bottom: top + height,
      width: 600,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    };
    return r as unknown as DOMRect;
  };
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

// 多标题 ⇒ preview 渲染出多个块（有 data-line-start，往返换算才Multiple有意义）
const MD = Array.from(
  { length: 12 },
  (_, i) => `## 标题 ${i + 1}\n\n这是第 ${i + 1} 段正文，用来把预览撑出高度。\n`,
).join("\n");

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
      panels: [
        {
          // 先显示**预览**那份 ⇒ 源是预览侧，切过去的是离屏的源码兄弟
          active: 1,
          tabs: [
            {
              path: "a.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 1,
              cursorCol: 1,
              scrollTop: 0,
            },
            {
              path: "a.md",
              encoding: "UTF-8",
              eol: "LF",
              cursorLine: 2,
              cursorCol: 1,
              scrollTop: 0,
              viewMode: "preview",
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
}));

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function previewRoot(): HTMLElement {
  const el = document.querySelector(".layout-panel .md-preview") as HTMLElement | null;
  if (!el) throw new Error("预览容器没挂载");
  return el;
}
function tabEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll(".panel-tabstrip .tab")) as HTMLElement[];
}
function clickTab(i: number): void {
  const el = tabEls()[i];
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.click();
}
function userScroll(el: HTMLElement, px: number): void {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: px }));
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}

describe("B241 跨侧：滚预览 → 切源码 → 切预览，来回滚几圈落点必须闭合", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(400);
  });

  it("滚预览 → 切源码 → 切预览，来回滚几圈，落点必须闭合", async () => {
    const btn = document.getElementById("sync-scroll") as HTMLElement | null;
    if (!btn) throw new Error("同步键没出现");
    btn.click();
    await wait(80);

    const seq: number[] = [];
    userScroll(previewRoot(), 120);
    await wait(120);
    seq.push(previewRoot().scrollTop);

    for (let k = 0; k < 3; k++) {
      clickTab(0); // 切到源码
      await wait(260);
      clickTab(1); // 切回预览
      await wait(260);
      seq.push(previewRoot().scrollTop);
    }
    expect(seq[seq.length - 1], "跨侧来回滚 3 圈还得闭合（每轮都重算就会一圈圈爬）").toBe(seq[0]);
    expect(
      seq.every((v) => v === seq[0]),
      "每圈落点要一模一样（不许先漂再稳）",
    ).toBe(true);
  });
});

// @vitest-environment jsdom
// 用户反馈 B23：大纲内容有时候没有随着当前选中文档进行切换
// （打开一个文本 + 一个 markdown 并分屏，两文件间切换时大纲始终显示 md 文件的大纲）。
// 根因：onActivatePanel 只改 activePanelId，没有刷新大纲；而 switchTab 里的
// updateTocDrawer 又被 `panelId === activePanelId` 挡住 —— 分屏下点另一块面板
// （不是点标签）走的是 onActivatePanel 路径，大纲因此停在上一份文档上。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

beforeAll(() => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
  // @ts-expect-error jsdom 兜底
  window.matchMedia = (q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
  // @ts-expect-error jsdom 兜底
  window.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number;
  // @ts-expect-error jsdom 兜底
  window.cancelAnimationFrame = (id: number) => clearTimeout(id);
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTitle: () => Promise.resolve(),
    onCloseRequested: () => Promise.resolve({ catch: () => {} }),
    close: () => Promise.resolve(),
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve({ unlisten: () => {} }) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve({ unlisten: () => {} }) }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
  open: () => Promise.resolve(null),
  save: () => Promise.resolve(null),
}));

// 会话：左面板一个 Markdown，右面板一个纯文本（复现用户场景）
vi.mock("../src/ipc/api", () => ({
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve(["UTF-8"]),
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
        {
          active: 0,
          tabs: [
            { path: "b.txt", encoding: "UTF-8", viewMode: "source", cursorLine: 1, cursorCol: 1 },
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
      autosave: true,
      toc_width: 240,
      preview_line_height: 1.7,
    }),
  logEvent: () => {},
  newTab: () =>
    Promise.resolve({ tabId: 1, name: "未命名", readonly: false, encoding: "UTF-8", eol: "CRLF" }),
  openFile: (p: string) =>
    Promise.resolve({
      tabId: p.includes("a.md") ? 101 : 102,
      text: p.includes("a.md") ? "# A标题\n\n正文A\n\n## A二级\n" : "pure text without heading\n",
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
  saveFile: () => Promise.resolve({ lossy: [], path: "" }),
  savePasteImage: () => Promise.resolve(""),
  saveSession: () => Promise.resolve(),
  saveSettings: () => Promise.resolve(),
  searchFiles: () => Promise.resolve([]),
}));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 面板激活由 .layout-panel 的 mousedown 触发（splitview 指针编排）。 */
function activatePanel(panel: HTMLElement): void {
  panel.dispatchEvent(
    new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      clientX: 5,
      clientY: 5,
      button: 0,
    }),
  );
}

describe("大纲必须跟随活动面板的当前文档", () => {
  it("分屏下在 md 与纯文本之间切换面板，大纲随之切换/清空", async () => {
    await import("../src/main");
    await wait(300);

    const panels = Array.from(document.querySelectorAll(".layout-panel")) as HTMLElement[];
    expect(panels.length, "应恢复两个面板").toBe(2);

    const outline = document.getElementById("btn-outline") as HTMLButtonElement | null;
    expect(outline, "btn-outline 应存在").toBeTruthy();
    outline!.click();
    await wait(50);

    const tocTexts = () =>
      Array.from(document.querySelectorAll("#toc-panel .toc-item")).map((e) => e.textContent ?? "");
    const tocEmpty = () => document.querySelector("#toc-panel .toc-empty") !== null;

    // 左面板（md）
    activatePanel(panels[0]);
    await wait(50);
    expect(tocTexts(), "活动面板是 md 时应显示其大纲").toEqual(["A标题", "A二级"]);
    expect(tocEmpty(), "md 面板不应显示空态").toBe(false);

    // 右面板（纯文本）→ 大纲必须清空，而不是继续挂着 md 的大纲
    activatePanel(panels[1]);
    await wait(50);
    expect(tocTexts(), "切到纯文本文档后不应再有标题项").toEqual([]);
    expect(tocEmpty(), "纯文本文档应显示空态").toBe(true);

    // 切回 md 面板 → 大纲回来
    activatePanel(panels[0]);
    await wait(50);
    expect(tocTexts(), "切回 md 面板应恢复大纲").toEqual(["A标题", "A二级"]);
  });

  it("B33 点击文档内容（cm-content）激活另一面板，大纲必须清空", async () => {
    // 用户报告：带大纲文件 → 不带大纲文件（跨面板、点击文档内容激活），
    // 左侧大纲仍残留。内容点击会冒泡到 .layout-panel 触发 onActivatePanel；
    // 该路径必须有幂等的大纲刷新兜底。
    await import("../src/main");
    await wait(300);

    const outline = document.getElementById("btn-outline") as HTMLButtonElement;
    const tocPanelEl = document.getElementById("toc-panel") as HTMLElement;
    // 用例间共享模块状态：前一个用例可能已把抽屉打开/关闭，这里确保打开
    if (tocPanelEl.hidden) outline.click();
    await wait(50);
    const tocItems = () =>
      Array.from(document.querySelectorAll("#toc-panel .toc-item")).map((e) => e.textContent ?? "");
    const panels = Array.from(document.querySelectorAll(".layout-panel")) as HTMLElement[];
    expect(tocPanelEl.hidden, "大纲抽屉应已打开").toBe(false);
    expect(tocItems().length, "初始应显示 md 大纲").toBe(2);

    const content = (i: number) => panels[i].querySelector(".cm-content") as HTMLElement;
    const click = (el: HTMLElement) =>
      el.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          clientX: 5,
          clientY: 5,
          button: 0,
        }),
      );

    click(content(1));
    await wait(50);
    expect(tocItems(), "点击纯文本面板内容后大纲应清空").toEqual([]);

    click(content(0));
    await wait(50);
    expect(tocItems(), "点回 md 面板内容应恢复大纲").toEqual(["A标题", "A二级"]);

    click(content(1));
    await wait(50);
    expect(tocItems(), "再次点击文本内容应再次清空").toEqual([]);
  });
});

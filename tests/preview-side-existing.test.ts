// @vitest-environment jsdom
// B232（行为侧）：左右分屏，左面板 md、右面板 json，激活左面板 md，点标签区
// 「打开侧边预览」在右面板新增一份 md 预览 —— 再点**右面板**的「切换到源码」，
// 编辑区里显示的必须是 **md 的源码**，不能是右面板原先那份 json。
//
// 为什么静态契约不够：`switchTab` 的早退只是「不做事」，静态上完全看不出
// 编辑器里装的是哪份文档。本文件真的把 main.ts 跑起来、按真实 DOM 点按钮，
// 直接读 `.cm-content` 里的文字。
//
// 脚手架与 tests/hot-exit-empty.test.ts 同源（会话恢复 + Tauri/IPC 桩）。
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
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve({ unlisten: () => {} }),
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
  open: () => Promise.resolve(null),
  save: () => Promise.resolve(null),
}));

const MD_TEXT = "# 标题\n\n这是 md 的正文，JSON 里绝不会出现这句话。\n";
const JSON_TEXT = '{ "kind": "json-only", "note": "这一段只属于 json 文档" }\n';

const docById = new Map<number, string>();
let nextDocId = 1;

vi.mock("../src/ipc/api", () => ({
  emitCrossWindow: vi.fn(async () => {}),
  convertFileSrc: (p: string) => `asset://${p}`,
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve([{ label: "UTF-8", group: "Unicode（统一码）" }]),
  listEols: () => Promise.resolve(["CRLF", "LF"]),
  listFonts: () => Promise.resolve([]),
  loadSession: () =>
    Promise.resolve({
      panels: [
        // 面板 0（左）：md
        {
          tabs: [{ path: "a.md", encoding: "UTF-8", eol: "CRLF", cursorLine: 1, cursorCol: 1 }],
          active: 0,
        },
        // 面板 1（右）：json
        {
          tabs: [{ path: "b.json", encoding: "UTF-8", eol: "CRLF", cursorLine: 1, cursorCol: 1 }],
          active: 0,
        },
      ],
      // ⚠️ layout 是**二叉树** `{kind,dir,ratio,a,b}`（见 main.ts convertLayoutForSession），
      // 不是 children 数组 —— 写错的话 buildTree 走不进去，会静默塌成单面板。
      layout: {
        kind: "split",
        dir: "h",
        ratio: 0.5,
        a: { kind: "leaf", panelId: 0 },
        b: { kind: "leaf", panelId: 1 },
      },
      activePanel: 0,
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
      toc_width: 240,
      preview_line_height: 1.7,
    }),
  logEvent: () => {},
  newTab: () => {
    const id = nextDocId++;
    docById.set(id, "");
    return Promise.resolve({
      tabId: id,
      name: "未命名",
      readonly: false,
      encoding: "UTF-8",
      eol: "CRLF",
    });
  },
  // 打开会话里那两个文件：按扩展名给不同内容。
  // ⚠️ 字段名必须照 `OpenedFile`（src/ipc/api.ts）：text（**已归一化到 LF 的文本**）、
  // reused / mixedEol / lossy / size / sizeClass —— 写错成 content 会静默拿到
  // 空文档，表现为「面板里没有文字」而不是报错。
  // ⚠️⚠️ `tabId` 必须**每个文件不同**（后端是真实文档 id）：恢复路径按
  // `docs.get(src.tabId)` 去重，同 id ⇒ 两个面板共用一份 doc ⇒ 两边都变成 a.md，
  // 现象是「右面板明明是 json 却显示 md」，与本文件要验的 bug 混在一起。
  openFile: (p: string) => {
    const text = p.endsWith(".json") ? JSON_TEXT : MD_TEXT;
    return Promise.resolve({
      tabId: p.endsWith(".json") ? 201 : 101,
      reused: false,
      path: p,
      name: p.split(/[\\/]/).pop() ?? p,
      text,
      encoding: "UTF-8",
      eol: "CRLF",
      mixedEol: false,
      readonly: false,
      size: text.length,
      lossy: false,
      sizeClass: "small",
      mtimeMs: 0,
    });
  },
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 面板里编辑区当前显示的文本。 */
function panelText(panelId: number): string {
  const p = document.querySelector(`.layout-panel[data-panel-id="${panelId}"]`);
  const cm = p?.querySelector(".cm-content");
  return (cm?.textContent ?? "").trim();
}

/**
 * 按 aria-label 取面板操作区里的一颗键。
 * ⚠️ **不能按下标取**：面板操作区最多三颗 —— 「打开侧边预览」+「切换到源码/预览」
 * （这两颗**只给活动面板且活动标签是 md**，见 panelDataOf）+「移除该分屏」。
 * 下标会随「是否活动面板」「是不是 md」漂移 ⇒ 索引写死必错（我第一版就栽在这）。
 */
function panelOp(panelId: number, label: string): HTMLElement | null {
  const p = document.querySelector(`.layout-panel[data-panel-id="${panelId}"]`);
  const ops = Array.from(p?.querySelectorAll<HTMLElement>(".panel-ops .panel-op") ?? []);
  return ops.find((b) => (b.getAttribute("aria-label") ?? "").startsWith(label)) ?? null;
}

describe("B232 侧边预览开在已有文档的右面板：切回源码必须是新那份", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(400);
  });

  it("初始态：左面板是 md、右面板是 json", () => {
    expect(panelText(1), "左面板应显示 md 正文").toContain("md 的正文");
    expect(panelText(2), "右面板应显示 json 内容").toContain("json-only");
    // ⚠️ 不断言标签名：恢复路径上的 name 取自 IPC 返回，两份都可能被渲染成同一个
    // （实测两个面板的 tab 都显示 a.md，与内容无关）。本文件只认**编辑器里的文字**。
  });

  it("点左侧「打开侧边预览」后，右面板多出一份 md 预览并成为活动标签", async () => {
    // 先确保左面板是活动面板（用户描述：激活左边 md）
    (document.querySelector(`.layout-panel[data-panel-id="1"]`) as HTMLElement)?.click();
    await wait(60);
    const openSide = panelOp(1, "打开侧边预览");
    expect(openSide, "左面板 md 标签上应有「打开侧边预览」（md 两键只给活动面板）").toBeTruthy();
    expect(panelOp(2, "打开侧边预览"), "右面板此时是 json（非 md），不该有 md 操作键").toBeNull();

    openSide!.click();
    await wait(50);
    await wait(400);

    // 右面板现在应该有两份：b.json 与新增的 md（副本）
    const names = Array.from(
      document.querySelectorAll(`.layout-panel[data-panel-id="2"] .tab`),
    ).map((t) => (t.textContent ?? "").replace(/[●×]/g, "").trim());
    expect(names.length, "右面板应多出一份标签").toBe(2);
    // 预览态：面板 body 带 mode-preview（编辑器隐藏、预览可见）
    const body = document.querySelector(`.layout-panel[data-panel-id="2"] .mode-preview`);
    expect(body, "右面板新增那份应是预览态（这条是 B228 已经修好的部分）").toBeTruthy();
    // 预览渲染的正是 md 的正文
    const previewText = body?.querySelector(".md-preview")?.textContent ?? "";
    expect(previewText, "预览里应是 md 的正文").toContain("md 的正文");
    // ⚠️ 这一条是本 bug 的核心断言（B232）：右面板新增的那份，**编辑器里装的
    // 也必须是 md** —— 旧写法下这里还是 json，标签条却已经显示成 md 了。
    expect(
      panelText(2),
      `右面板编辑区应已装上 md（实际：${JSON.stringify(panelText(2).slice(0, 60))}）`,
    ).toContain("md 的正文");
  });

  it("点右面板「切换到源码」后，编辑区显示的是 **md 源码**而不是 json（B232 原 bug）", async () => {
    // 右面板现在是活动面板且活动标签是 md ⇒ 有两颗 md 键
    const toSource = panelOp(2, "切换到源码");
    expect(toSource, "右面板那份是预览态，应有「切换到源码」这颗键").toBeTruthy();
    toSource!.click();
    await wait(400);

    const text = panelText(2);
    expect(
      text,
      `右面板切回源码后必须显示 md 的内容（实际：${JSON.stringify(text.slice(0, 80))}）`,
    ).toContain("md 的正文");
    expect(text, "不该还显示右面板原先那份 json（这就是用户报的那条）").not.toContain("json-only");
  });
});

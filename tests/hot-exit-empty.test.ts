// @vitest-environment jsdom
// B69：热退出开着时，**空的新建文档**也要能跨重启回来。
//
// 为什么需要单独一条：空的新建文档既没有 `path`、也不脏（没输入过内容 →
// 压根不会写副本），而 B68 的会话包含条件是 `有 path || 有副本`，
// 于是它整条被漏掉——「新建了还没开始打字」的标签重启后凭空消失。
//
// 本文件钉住**恢复方向**（本文件专属的会话桩）：会话里两个空未命名标签
// ⇒ 启动后应回来两个空白标签。写入方向（空文档会不会进会话）见
// tests/hot-exit.test.ts；副本格式/路径穿越由 Rust 单测覆盖。
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

// ---- 桩：Tauri 运行时 ----
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
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve({ unlisten: () => {} }),
  // B71 ④：跨窗口同步要广播变更集。缺了 emit 的话 handleUpdate 里的广播会同步抛错
  // （CM6 只把它记成一条 listener error），测试就变成「看着是绿的、其实编辑路径带伤」。
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

// ---- 会话：两个**空**的未命名标签（无 path、无 backupId，只有 docId）----
const EMPTY_TAB = { path: "", encoding: "UTF-8", eol: "CRLF", cursorLine: 1, cursorCol: 1 };
const SESSION = {
  panels: [
    {
      tabs: [
        { ...EMPTY_TAB, docId: 7 },
        { ...EMPTY_TAB, docId: 8 },
      ],
      active: 0,
    },
  ],
  layout: { kind: "leaf", panelId: 0 },
  activePanel: 0,
};

// ---- IPC 桩：记账 ----
let newTabCalls = 0;
let restoreBackupCalls = 0;
let writeBackupCalls = 0;

vi.mock("../src/ipc/api", () => ({
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve(["UTF-8"]),
  listEols: () => Promise.resolve(["CRLF", "LF"]),
  loadSession: () => Promise.resolve(SESSION),
  loadSettings: () =>
    Promise.resolve({
      theme: "light",
      word_wrap: true,
      font_size: 14,
      default_encoding: "UTF-8",
      default_eol: "CRLF",
      autosave: false,
      hot_exit: true,
      toc_width: 240,
      preview_line_height: 1.7,
    }),
  logEvent: () => {},
  // 每个空文档都要一个新文档 ID；返回递增 id 便于区分
  newTab: () =>
    Promise.resolve({
      tabId: ++newTabCalls,
      name: "未命名",
      readonly: false,
      encoding: "UTF-8",
      eol: "CRLF",
    }),
  openFile: () => Promise.resolve(null),
  reloadFile: () => Promise.resolve(null),
  saveFile: () => Promise.resolve({ lossy: [], path: "" }),
  savePasteImage: () => Promise.resolve(""),
  saveSession: () => Promise.resolve(),
  saveSettings: () => Promise.resolve(),
  writeBackup: () => {
    writeBackupCalls++;
    return Promise.resolve();
  },
  restoreBackup: () => {
    restoreBackupCalls++;
    return Promise.resolve(null);
  },
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
}));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("B69 会话恢复：空的未命名文档", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(300);
  });

  it("两个空标签必须回来两个空白文档（回归：空文档被会话整条漏掉）", async () => {
    const tabs = Array.from(document.querySelectorAll<HTMLElement>(".tab"));
    expect(tabs.length, `应恢复两个标签，实际 ${tabs.length} 个`).toBe(2);

    const contents = Array.from(document.querySelectorAll(".cm-content")).map(
      (c) => c.textContent ?? "",
    );
    expect(
      contents.length,
      `每个恢复的标签都该有视图，实际 ${contents.length} 个`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      contents.every((t) => t.length === 0),
      `恢复的空文档必须是空的，实际：${JSON.stringify(contents)}`,
    ).toBe(true);

    // 每个空标签都要一个**独立**的空白文档：只造一个 = 第二个标签凭空消失。
    expect(newTabCalls, "两个空标签 → 建两个空白文档").toBe(2);
  });

  it("空文档没有内容可备份：不读副本、也不写副本", async () => {
    // 会话里没有 backupId → 不该去备份区讨；恢复出的文档不脏 → 也不该写副本。
    expect(restoreBackupCalls, "没有 backupId 就不该读副本").toBe(0);
    expect(writeBackupCalls, "空文档没有未保存内容 → 不写副本").toBe(0);
  });

  it("恢复出来的空文档不是脏的（不该亮 ●、关窗也不该弹框）", async () => {
    const dots = document.querySelectorAll(".tab-action");
    // ● 只在脏时显示；两个刚恢复的空标签都不该有未保存标记。
    const dirtyMarks = Array.from(dots).filter((el) => (el.textContent ?? "").includes("●"));
    expect(dirtyMarks.length, "刚恢复的空文档不该显示未保存圆点").toBe(0);
  });
});

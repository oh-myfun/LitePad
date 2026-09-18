// @vitest-environment jsdom
// B68 热退出：把未保存内容写进**独立副本**，于是关窗不必再弹「未保存将丢失」，
// 下次启动再由副本还原成未保存标签。
//
// 这里用真实 bootstrap 钉住用户能直接感知的两条：
//   1) 真实编辑只写**副本**（writeBackup），绝不碰原文件（saveFile 不被调用）——
//      这正是热退出与「自动保存」的分野；
//   2) 有脏文档时关窗不弹确认框（ask 不被调用），且会话先落盘再关窗
//      （副本文件本身不含归属索引，全靠会话里的 backupId 把它认领回来）。
//
// 副本的落盘格式、魔数、路径穿越防护、孤儿清理由 Rust 单测覆盖
// （src-tauri/src/backup/mod.rs）；本文件只管前端编排。
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

// ---- 桩：Tauri 运行时 ----
const closeHandlers: Array<(e: { preventDefault: () => void }) => void> = [];
let closeCalls = 0;
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTitle: () => Promise.resolve(),
    onCloseRequested: (cb: (e: { preventDefault: () => void }) => void) => {
      closeHandlers.push(cb);
      return Promise.resolve({ catch: () => {} });
    },
    close: () => {
      closeCalls++;
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

// ---- 桩：对话框（确认框被调用就是「没走热退出快路径」的证据）----
const askCalls: string[] = [];
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: (msg: string) => {
    askCalls.push(msg);
    return Promise.resolve(true);
  },
  open: () => Promise.resolve(null),
  save: () => Promise.resolve(null),
}));

// ---- 桩：IPC 层，逐项记账 ----
const backups: Array<{ id: string; text: string; path: string; name: string }> = [];
const saves: unknown[] = [];
const sessions: unknown[] = [];

vi.mock("../src/ipc/api", () => ({
  checkEncodable: () => Promise.resolve([]),
  closeTab: () => Promise.resolve(),
  exportFile: () => Promise.resolve(),
  isUnicodeEncoding: () => true,
  listEncodings: () => Promise.resolve(["UTF-8"]),
  listEols: () => Promise.resolve(["CRLF", "LF"]),
  // 无会话 → 冷启动出一个未命名标签；未命名文档没有磁盘路径，
  // 恰好是最能体现热退出价值（也最容易丢）的场景。
  loadSession: () => Promise.resolve(null),
  loadSettings: () =>
    Promise.resolve({
      theme: "light",
      word_wrap: true,
      font_size: 14,
      default_encoding: "UTF-8",
      default_eol: "CRLF",
      // B68 的重点：自动保存**关**、热退出**开**（VS Code 桌面版的默认组合）
      autosave: false,
      hot_exit: true,
      toc_width: 240,
      preview_line_height: 1.7,
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
  openFile: () => Promise.resolve(null),
  reloadFile: () => Promise.resolve(null),
  saveFile: (args: unknown) => {
    saves.push(args);
    return Promise.resolve({ lossy: [], path: "" });
  },
  savePasteImage: () => Promise.resolve(""),
  saveSession: (state: unknown) => {
    sessions.push(state);
    return Promise.resolve();
  },
  saveSettings: () => Promise.resolve(),
  writeBackup: (args: { id: string; text: string; path: string; name: string }) => {
    backups.push(args);
    return Promise.resolve();
  },
  restoreBackup: () => Promise.resolve(null),
  discardBackup: () => Promise.resolve(),
  discardOrphanBackups: () => Promise.resolve(0),
}));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("B68 热退出（自动保存关 / 热退出开）", () => {
  beforeAll(async () => {
    await import("../src/main");
    await wait(300);
  });

  it("新建的空文档也要进会话（带 docId），下次启动才回得来", async () => {
    // B69：冷启动出的空文档既没有 path、也不脏（没输入过内容 → 不会写副本），
    // 若会话只认「有 path || 有副本」，它就被整条漏掉、重启后凭空消失。
    await wait(1200); // 越过 800ms 会话防抖
    expect(sessions.length, "冷启动后应已存过一次会话").toBeGreaterThan(0);
    const snap = sessions[sessions.length - 1] as {
      panels: Array<{
        tabs: Array<{ path?: string; backupId?: string | null; docId?: number | null }>;
      }>;
    };
    const tabs = snap.panels.flatMap((p) => p.tabs);
    const empty = tabs.find((t) => !t.path && !t.backupId);
    expect(empty, `空文档应被写进会话，实际会话标签：${JSON.stringify(tabs)}`).toBeTruthy();
    expect(
      typeof empty!.docId,
      "必须带 docId：它是认领这个空文档（以及分屏时判断「同一个文档」）的唯一凭据",
    ).toBe("number");
    expect(backups.length, "空文档没有内容可备份 → 不该写副本").toBe(0);
  });

  it("真实编辑只写副本，绝不写原文件", async () => {
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement);
    expect(view, "编辑器应已挂载").toBeTruthy();

    view!.dispatch({ changes: { from: 0, insert: "# 未保存的草稿\n" } });
    await wait(1600); // 越过 1s 备份防抖

    expect(backups.length, "编辑后应写出热退出副本").toBeGreaterThan(0);
    const job = backups[backups.length - 1];
    expect(job.text, "副本正文应是当前内容").toContain("未保存的草稿");
    expect(job.id, "副本 ID 只能含白名单字符（它直接拼进备份区路径）").toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(job.path, "未命名文档没有原路径").toBe("");
    // 核心不变量：热退出只写副本。写原文件是「自动保存」的职责，而它此时是关的。
    expect(saves.length, "自动保存关闭 → 绝不写原文件").toBe(0);
  });

  it("有脏文档时关窗不弹确认框，且会话先落盘再关窗", async () => {
    expect(closeHandlers.length, "关窗处理器应已注册").toBeGreaterThan(0);
    expect(askCalls, "此前不应弹过任何确认框").toHaveLength(0);
    const before = sessions.length;

    let prevented = false;
    closeHandlers[0]({
      preventDefault: () => {
        prevented = true;
      },
    });
    await wait(1200);

    expect(askCalls, "副本写成功 → 不得弹「未保存的内容将丢失」").toHaveLength(0);
    expect(prevented, "有脏文档时应先拦下默认关闭").toBe(true);

    expect(sessions.length, "关窗前必须把会话存下来（副本靠它才被认领）").toBeGreaterThan(before);
    const snap = sessions[sessions.length - 1] as {
      panels: Array<{ tabs: Array<{ backupId?: string | null }> }>;
    };
    const ids = snap.panels.flatMap((p) => p.tabs.map((t) => t.backupId));
    expect(
      ids.some((id) => typeof id === "string" && id.length > 0),
      "会话必须带上 backupId，否则副本下次启动没人认领",
    ).toBe(true);
    expect(ids[0], "会话里的 backupId 应与写盘时用的是同一个").toBe(backups[0].id);
    expect(closeCalls, "应真正关掉窗口").toBe(1);
  });
});

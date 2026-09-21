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
import { topLevelFnBody } from "./static";

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

describe("B69 空的新建文档也要跨重启回来", () => {
  // 用户报告：热退出开着，新建了但还没打字的空文档，下次打开却没了。
  // 根因：它既没有 path、也不脏（没输入 → 不写副本），而 B68 的会话包含条件是
  // 「有 path || 有副本」，于是整条被漏掉。改法是靠 docId 认领。
  const src = readFileSync("src/main.ts", "utf-8");
  const api = readFileSync("src/ipc/api.ts", "utf-8");
  const rustSession = readFileSync("src-tauri/src/session/mod.rs", "utf-8");

  /** 截取某个顶层函数的源码体（见顶层 topLevelFnBody 的说明）。 */
  function fnBody(name: string): string {
    const body = topLevelFnBody(src, name);
    expect(body, `必须能定位 ${name}`).not.toBe("");
    return body;
  }

  it("快照接纳空的未命名文档，但**绝不**接纳「脏却没备份成功」的", () => {
    // B71 ④ 起「值不值得进会话」抽到了 sessionWorthy（卫星窗口与隐藏实例共用同一判据），
    // 所以断言跟着挪到那个函数体上 —— 判据本身没变。
    const body = fnBody("function sessionWorthy");
    // 空文档（无 path、不脏）必须进会话，否则重启后凭空消失
    expect(body, "热退出开着时要接纳「无路径且不脏」的文档").toMatch(
      /settings\?\.hot_exit === true && !d\.dirty/,
    );
    // ⚠️ 反向约束：判定必须带 !d.dirty。若退化成「无路径就收」，
    // 「脏、但备份失败」的未命名文档也会被收进去，恢复时按空文档处理
    // ——那会真的把用户打的字丢掉。那种情况只能走关窗确认框。
    expect(body, "判定必须同时约束 dirty，不能只看有没有路径").toMatch(/!d\.dirty/);
    // 有路径或有副本的立即放行（B68 的原判据）
    expect(body, "有路径或有副本的立即入会话").toMatch(
      /if \(d\.path \|\| d\.backedUp\) return true;/,
    );
  });

  it("空文档靠 docId 认领：会话 schema 与快照都要带上", () => {
    expect(rustSession, "Rust TabSession 必须有 doc_id").toMatch(/pub doc_id: Option<u64>/);
    expect(rustSession, "doc_id 要有 snake_case alias 兼容旧会话").toMatch(
      /#\[serde\(alias = "doc_id"\)\]/,
    );
    expect(api, "前端 TabSession 必须有 docId").toMatch(/docId\?: number \| null;/);
    // 标签记录构造抽到了 sessionTabRecordOf（面板标签与卫星标签共用），断言跟过去
    expect(fnBody("function sessionTabRecordOf"), "快照必须写入 docId").toMatch(/docId: d\.tabId,/);
  });

  it("恢复时按 docId 认身份：同一个空文档在多个面板只造一份", () => {
    const body = fnBody("async function restoreSession");
    // 没有 docId 分支时，两个空标签的身份会退化成同一个键，被去重成一份
    expect(body, "identityOf 必须有 docId 分支").toMatch(/#doc:\$\{st\.docId\}/);
    // 无路径、无副本 ⇒ 空文档：必须新开一个空白文档，而不是整条跳过
    expect(body, "无路径无副本的标签要 newTab 造空文档").toMatch(
      /await ipcNewTab\([\s\S]*?kind: "empty"/,
    );
  });

  it("恢复出来的空文档不是脏的（不亮 ●、关闭不弹框）", () => {
    const body = fnBody("async function restoreSession");
    // 置脏只属于副本分支：空文档内容本来就是空的，标脏会亮 ● 且关闭时要问「保存吗」
    const dirtyAssigns = body.match(/dirty = true/g) ?? [];
    expect(dirtyAssigns.length, "恢复流程里只有副本分支可以置脏").toBe(1);
    expect(body, "置脏必须在副本分支内").toMatch(
      /if \(hit\.kind === "backup"\)[\s\S]{0,300}dirty = true/,
    );
  });
});

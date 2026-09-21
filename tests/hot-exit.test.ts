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
import { topLevelFnBody } from "./static";
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

describe("B68 热退出：关窗不询问，下次启动还原未保存内容", () => {
  const src = readFileSync("src/main.ts", "utf-8");
  const api = readFileSync("src/ipc/api.ts", "utf-8");
  const rustBackup = readFileSync("src-tauri/src/backup/mod.rs", "utf-8");
  const rustCommands = readFileSync("src-tauri/src/commands/mod.rs", "utf-8");
  const rustMain = readFileSync("src-tauri/src/main.rs", "utf-8");

  /** 截取某个顶层函数的源码体（见顶层 topLevelFnBody 的说明）。 */
  function fnBody(name: string): string {
    const body = topLevelFnBody(src, name);
    expect(body, `必须能定位 ${name}`).not.toBe("");
    return body;
  }

  it("关窗流程：先 flush 副本，逐文档确认后才跳过确认框，否则仍要问", () => {
    const body = fnBody("function registerWindowClose");
    // 排程中的备份（1s 防抖）必须在关窗时立刻兑现——防抖窗口里关窗是最常见的丢数据场景
    expect(body, "关窗前必须取消防抖排程").toMatch(
      /cancelPendingBackup\(\);[\s\S]*?settings\?\.hot_exit/,
    );
    expect(body, "必须等待 flushBackups 落盘").toContain("await flushBackups();");
    // 判定必须逐文档查 backedUp，而不能只信 flushBackups 的返回值
    expect(body, "必须以 backedUp 逐文档判定").toMatch(
      /filter\(\(d\) => d\.dirty && !d\.backedUp\)/,
    );
    // 兜底确认框必须还在：备份失败 / 关掉热退出时不能静默丢内容
    expect(body, "备份没成时必须退回确认框").toContain("未保存的内容将丢失");
    // 跳过确认框之前必须先把会话写下来，否则重启后没人认领那些副本
    const fast = body.slice(body.indexOf("if (settings?.hot_exit)"));
    expect(fast, "快路径必须先存会话再关窗").toMatch(
      /const unbacked[\s\S]*?saveSession\(snapshotSession\(\)\)[\s\S]*?\.close\(\)/,
    );
  });

  it("保存 / 自动保存 / 重载后必须丢弃副本（否则旧快照会顶掉已保存内容）", () => {
    for (const fn of ["async function saveDocCore", "function scheduleAutosave"]) {
      expect(fnBody(fn), `${fn} 里转干净后必须丢弃副本`).toContain("discardBackupFor(doc)");
    }
  });

  it("副本 ID 只能含白名单字符（它直接参与拼路径，防穿越）", () => {
    const body = fnBody("function newBackupId");
    expect(body, "必须用密码学随机源").toContain("crypto.getRandomValues");
    expect(body, "必须只产出十六进制").toContain("toString(16)");
    expect(body, "只用连字符分隔").toContain('"-"');
    // 白名单必须与 Rust 侧一致
    expect(rustBackup, "Rust 侧必须有同款白名单校验").toContain("pub fn is_valid_id");
    expect(rustBackup, "白名单必须是 ascii_alphanumeric + '-'").toMatch(
      /is_ascii_alphanumeric\(\)\s*\|\|\s*c == '-'/,
    );
  });

  it("副本是独立文件，格式自带魔数与头部，且从不写原文件", () => {
    expect(rustBackup, "必须有版本化魔数").toContain('MAGIC: &str = "LitePadBackup/1"');
    expect(rustBackup, "副本落在 %APPDATA%\\LitePad\\backups").toContain(
      '.join("LitePad").join("backups")',
    );
    // write_backup 命令只收内容与元数据，没有任何「写到 path」的动作
    const wb = rustCommands.slice(rustCommands.indexOf("pub fn write_backup"));
    expect(wb.slice(0, 900), "write_backup 只应交给 backup::write").toContain("backup::write(");
    // 四条命令都要注册进 invoke_handler，否则前端调用会静默失败
    for (const cmd of [
      "commands::write_backup",
      "commands::restore_backup",
      "commands::discard_backup",
      "commands::discard_orphan_backups",
    ]) {
      expect(rustMain, `${cmd} 必须注册`).toContain(cmd);
    }
  });

  it("同一文档在多个面板时只预取一次（否则副本会还原成两份不同步的文档）", () => {
    const body = src.slice(src.indexOf("async function restoreSession"));
    // 同一个文件可以同时在多个面板打开并共用同一份 doc（同源多实例）。
    // 若按「面板索引|路径」各取一次，`restore_backup` 每次都新建标签，
    // 就会得到两份**互不同步**的文档，把同源多实例悄悄破坏掉。
    expect(body, "预取 key 只能是文档身份，不能带面板索引").toMatch(
      /const key = identityOf\(st\);/,
    );
    expect(body, "组装阶段必须按同一身份键取值").toContain("restoredCache.get(identityOf(st))");
    expect(body, "不得再出现带面板索引的缓存键").not.toContain("${i}|");
  });

  it("会话必须带上 backupId，未命名文档靠它才能恢复", () => {
    expect(src, "会话快照必须写 backupId").toContain("backupId: d.backupId");
    // 没有路径的未命名文档，只有在备份区里确实有副本时才该进会话
    // （B69 起拆成两步 return：先认 path/副本，再补「热退出 + 空的未命名」，
    //  后半条的判定与守卫见下面 B69 块）
    expect(src, "有路径或有副本的立即入会话").toMatch(
      /if \(d\.path \|\| d\.backedUp\) return true;/,
    );
  });

  it("孤儿副本清理必须以「会话读成功」为前提（防会话坏掉时误删全部副本）", () => {
    const body = fnBody("async function bootstrap");
    expect(body, "清理必须在 restored 为真时才做").toMatch(/if \(restored\) \{[\s\S]*?keep/);
    expect(body, "keep 只收已备份的文档").toMatch(/filter\(\(d\) => d\.backedUp && d\.backupId\)/);
  });

  it("前端必须按 camelCase 读 IPC 字段（size_class / size_hint 是真实事故）", () => {
    // B68 之前 api.ts 把这两个字段写成 snake_case，于是 `file.size_class` 恒为
    // undefined → normalizeSizeClass 回落 "normal" → **M4 大文件降级从未生效**。
    // Rust 侧 `rename_all = "camelCase"` 才是线上真名（有 cargo 测试钉住）。
    expect(api, "OpenedFile 必须用 sizeClass").toMatch(/sizeClass: string;/);
    expect(api, "OpenedFile 必须用 sizeHint").toMatch(/sizeHint: string;/);
    expect(api, "不得再有 snake_case 的 size_class 声明").not.toContain("size_class: string");
    expect(src, "不得再读 file.size_class").not.toContain("file.size_class");
    expect(src, "不得再读 file.size_hint").not.toContain("file.size_hint");
    expect(src, "必须读 file.sizeClass").toContain("normalizeSizeClass(file.sizeClass)");
  });

  it("两个开关是独立的，且默认值对齐 VS Code 桌面版", () => {
    const menubar = readFileSync("src/shell/menubar.ts", "utf-8");
    expect(menubar, "文件菜单要有热退出项").toContain("热退出（关窗不询问）");
    expect(menubar, "热退出走独立回调").toContain("onToggleHotExit");
    expect(src, "热退出默认开（?? true）").toContain("settings?.hot_exit ?? true");
    expect(src, "自动保存默认关（?? false）").toContain("settings?.autosave ?? false");
    // 关掉热退出时必须把现存副本一并丢掉，否则「关了还生效」
    const off = fnBody("async function setHotExit");
    expect(off, "关掉热退出要丢弃现存副本").toMatch(/if \(!on\) discardAllBackups\(\);/);
  });
});

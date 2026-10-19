// @vitest-environment node
// B305 跨语言/跨层契约。这些形状一旦漂走，**每一侧的单测都还是绿的**：命令名拼错的 IPC 在
// Rust 侧只是没被注册、在前端只是没人调；窗口销毁那条链只有真机跑得动，本地无从验。
// 所以这里钉的是「两侧必须同时存在同一串字」，不是行为（行为在 recent.rs 的 #[cfg(test)] 里）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const rustMain = readFileSync("src-tauri/src/main.rs", "utf-8");

/** 取 `start` 到 `end` 之间的那一段（找不到就抛，别让断言对着空串自娱自乐）。 */
function between(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  expect(a, `找不到起点「${start}」`).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(end, a);
  expect(b, `找不到终点「${end}」`).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe("B305 · Rust 命令注册与窗口销毁接线", () => {
  it("六条 recents 命令都在 invoke_handler 注册表里", () => {
    const handler = between(rustMain, "generate_handler![", "])");
    for (const n of [
      "sync_open_paths",
      "list_recents",
      "forget_recent",
      "clear_recents",
      "get_recent_limit",
      "set_recent_limit",
    ]) {
      expect(handler, `命令 ${n} 没注册（前端调它只会拿到「命令不存在」）`).toContain(
        `recents::${n}`,
      );
    }
  });

  it("主窗口销毁立退出旗标，卫星销毁清自己那条账（Review Focus #3）", () => {
    const winEvent = between(rustMain, ".on_window_event(|win, event| {", ".setup(|app| {");
    const mainBranch = between(
      winEvent,
      "win.label() == windows::MAIN_LABEL",
      "let app = win.app_handle();",
    );
    expect(
      mainBranch,
      "关主窗口 = 退出：必须先立退出旗标，否则各窗口销毁时会把用户正在用的文件全记成「刚关掉」",
    ).toContain("mark_quitting");
    const satBranch = winEvent.slice(winEvent.indexOf("reg.forget_pending(win.label())"));
    expect(
      satBranch,
      "子窗口销毁必须收口到最近打开那条链（「文档只在子窗口并关掉」全靠它）",
    ).toContain("on_window_destroyed");
    expect(
      winEvent,
      "窗口事件可能早于 manage：拿共享状态只许 try_state，unwrap 会把进程 panic 在关窗那一刻",
    ).not.toContain("unwrap_state");
  });

  it("退出兜底：RunEvent 里也立旗标（updater relaunch 与强杀都够不到前端那条链）", () => {
    const run = rustMain.slice(rustMain.indexOf(".run(|"));
    expect(run).toContain("ExitRequested");
    expect(run).toContain("mark_quitting");
  });

  it("卫星收口里剪枝排在记录之前（先记后剪会让名单闪一条又没了）", () => {
    const rs = readFileSync("src-tauri/src/commands/recents.rs", "utf-8");
    const body = rs.slice(rs.indexOf("pub fn on_window_destroyed"));
    expect(body, "窗口没了必须清掉它那一份可见账").toContain("drop_window");
    expect(body.indexOf("prune_open"), "剪枝必须早于记录").toBeLessThan(
      body.indexOf("record_closed"),
    );
    const sync = rs.slice(rs.indexOf("pub fn sync_open_paths"));
    expect(sync.indexOf("prune_open")).toBeLessThan(sync.indexOf("record_closed"));
    expect(rs).toContain('"recents-changed"');
  });
});

describe("B305 · 可见路径上报只挂一处", () => {
  const ui = readFileSync("src/ui.ts", "utf-8");
  const body = between(ui, "function broadcastDocPresence(): void {", "\nfunction refreshAll(");

  it("上报并入 broadcastDocPresence —— 它已经是「可见集合变了」的唯一广播点", () => {
    expect(body).toContain("syncVisiblePaths()");
  });

  it("打开/关闭流程里不许再各写一遍上报（两处上报 = 两个基准 = 迟早互相覆盖）", () => {
    expect(readFileSync("src/io/files.ts", "utf-8")).not.toContain("syncOpenPaths");
    expect(readFileSync("src/tabs/lifecycle.ts", "utf-8")).not.toContain("syncOpenPaths");
    expect(readFileSync("src/multiwindow/windows.ts", "utf-8")).not.toContain("syncOpenPaths");
  });
});

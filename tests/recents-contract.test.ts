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

describe("B305 · 侧栏结构与子窗口收口", () => {
  const html = readFileSync("index.html", "utf-8");
  const css = readFileSync("src/styles/preview.css", "utf-8");
  const globalCss = readFileSync("src/styles/global.css", "utf-8");

  it("六颗 id 齐备，且「最近打开」键排在大纲键之后（按钮列自上而下 = 心智顺序）", () => {
    for (const id of [
      "side-recent",
      "recent-panel",
      "recent-head",
      "recent-count",
      "recent-clear",
      "recent-list",
    ]) {
      expect(html, `缺 #${id}`).toContain(`id="${id}"`);
    }
    expect(
      html.indexOf('id="side-recent"'),
      "第二颗键必须排在大纲键之后（按钮列是常驻一列，顺序就是读法）",
    ).toBeGreaterThan(html.indexOf('id="side-outline"'));
    expect(html).toMatch(/id="recent-panel"[^>]*hidden/);
  });

  it("`.recent-panel[hidden]` 兜底必须写（作者样式表压过 UA 那条隐藏规则，B207 同款坑）", () => {
    // `.toc-panel` 当年就栽在这里：`display: flex` 一写，hidden 属性只改了个属性、
    // 面板照旧占着宽度。jsdom 不做 CSS 级联 ⇒ 运行时断言 `hidden === true` 是**假绿**，
    // 这条只能用静态契约盯住（口径同 tests/sidebar.test.ts）。
    expect(css).toMatch(/\.recent-panel\s*\{[^}]*display:\s*flex/);
    expect(css, "没这条就会「收起来了却还占着一片」").toMatch(
      /\.recent-panel\[hidden\]\s*\{[^}]*display:\s*none/,
    );
  });

  it("子窗口收掉整条左栏：卡片、空隙、标题栏那颗左栏键一起收（Review Focus #5）", () => {
    for (const sel of ["#side-shell", "#side-resizer", "#sidebar-toggle"]) {
      expect(
        globalCss,
        `子窗口还留着 ${sel}：左边栏多出一块没有内容的空白，那颗键点了也没东西可看`,
      ).toContain(`html[data-window-kind="satellite"] ${sel}`);
    }
  });

  it("B306：`.side-btn[hidden]` 兜底必须写（上限 0 收起那颗键走的是同一条级联坑）", () => {
    // `.side-btn` 自己写了 `display: flex` ⇒ 作者样式表压过 UA 那条 `[hidden]`，
    // `hidden = true` 只改属性不改显示，键会留在按钮列里空占一格（点了还没反应）。
    // jsdom 不做 CSS 级联 ⇒ 运行时断言 `hidden === true` 证明不了它真的不占位。
    expect(globalCss, "没这条就是「收起来了却还占着一格」").toMatch(
      /\.side-btn\[hidden\]\s*\{[^}]*display:\s*none/,
    );
  });

  it("两颗新图标走 codicon 字形（仓库红线：不手绘 SVG）", () => {
    const icons = readFileSync("src/shell/codicons.ts", "utf-8");
    expect(icons).toMatch(/history:\s*"history"/);
    expect(icons).toMatch(/trash:\s*"trash"/);
  });
});

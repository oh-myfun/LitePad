// @vitest-environment node
// B305/B308 跨语言/跨层契约。这些形状一旦漂走，**每一侧的单测都还是绿的**：命令名拼错的 IPC 在
// Rust 侧只是没被注册、在前端只是没人调；「谁负责算差集」这种职责错位本地也只能靠串字钉住。
// 所以这里钉的是「两侧必须同时存在同一串字」，不是行为（行为在 recent.rs 的 #[cfg(test)] 里）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const rustMain = readFileSync("src-tauri/src/main.rs", "utf-8");
const recentsRs = readFileSync("src-tauri/src/commands/recents.rs", "utf-8");

/** 取 `start` 到 `end` 之间的那一段（找不到就抛，别让断言对着空串自娱自乐）。 */
function between(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  expect(a, `找不到起点「${start}」`).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(end, a);
  expect(b, `找不到终点「${end}」`).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe("B305/B308 · Rust 命令注册与窗口销毁那条链", () => {
  it("六条 recents 命令都在 invoke_handler 注册表里", () => {
    const handler = between(rustMain, "generate_handler![", "])");
    for (const n of [
      "note_opened",
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

  it("窗口销毁那条链不再碰名单（B308：记的是打开动作，关窗不产生任何记入事件）", () => {
    const winEvent = between(rustMain, ".on_window_event(|win, event| {", ".setup(|app| {");
    expect(
      winEvent,
      "名单一挂回窗口销毁，正常关主窗口就会把用户正在用的文件全记成「刚关掉」——那正是 B308 删掉的旧语义",
    ).not.toContain("recents::");
    // 那条链本身还在，只是它服务的是卫星标签接还，不是最近打开。
    expect(winEvent).toContain("forget_pending");
    expect(
      winEvent,
      "窗口事件可能早于 manage：拿共享状态只许 try_state，unwrap 会把进程 panic 在关窗那一刻",
    ).not.toContain("unwrap_state");
    const run = rustMain.slice(rustMain.indexOf(".run(|"));
    expect(run, "退出兜底只剩日志压尾（RunEvent::Exit）").toContain("RunEvent::Exit");
    expect(
      run,
      "「退出中就不记」那面旗整套删了：再立一次就是把「打开过就在册」改回「退出前不算」",
    ).not.toContain("ExitRequested");
  });

  it("AppState 只剩一份名单账：recents（per-window 可见集合那本账已随旧语义删掉）", () => {
    const mod = readFileSync("src-tauri/src/commands/mod.rs", "utf-8");
    const body = between(mod, "pub struct AppState {", "\n}");
    expect(body).toContain("recents: Mutex<Recents>");
    expect(
      body,
      "记的是打开动作，一次一发 ⇒ 没有「上一份可见集合」可存了；留着就是有人在等一个不会来的差集",
    ).not.toContain("open_sets");
    expect(body, "退出旗标字段还留着 = 有人以为它有用").not.toMatch(/quitting|AtomicBool/);
  });

  it("note_opened 的形状：一份路径 → 现算身份键 → LRU 记入", () => {
    const body = between(recentsRs, "pub fn note_opened(", "/// 列名单");
    expect(
      body,
      "参数必须是一条路径。回集合就得有人算差集，而算差集只能看集合 ⇒ 恢复会被记成打开",
    ).toMatch(/path:\s*String/);
    expect(
      body,
      "身份键必须在 Rust 现算（canonicalize + 剥前缀 + 小写），前端那份字符串不算数",
    ).toContain("key_of(&path)");
    expect(body, "改名单必须走 note() 那一个口子：绕过它就等于绕过「变了才落盘 + 广播」").toContain(
      'note(&app, &state, "记录打开"',
    );
    expect(body, "per-window 那本账已经删了，别再回来").not.toContain("open_sets");
    expect(recentsRs).toContain('"recents-changed"');
  });
});

describe("B308 · 记入只挂在「打开」这一处（恢复不算打开）", () => {
  const files = readFileSync("src/io/files.ts", "utf-8");

  it("唯一调用点在 doOpen，且排在 openFile 成功之后（拿退化替身自证判据有牙）", () => {
    // ⚠️ 替身在内存里造，**不往交付文件里注破坏内容**：那种做法会被拦下来，还会留下坏文件。
    const check = (src: string): string[] => {
      const v: string[] = [];
      const at = src.indexOf("async function doOpen(");
      if (at < 0) return ["找不到 doOpen 的声明"];
      const body = src.slice(at, src.indexOf("\n}", at) + 2);
      const read = body.indexOf("await openFile(");
      const rec = body.indexOf("noteOpened(");
      if (read < 0) v.push("doOpen 里没有读盘调用");
      if (rec < 0) v.push("doOpen 里没有记入调用");
      else if (rec < read) v.push("记入排在读盘之前：取消对话框与读盘失败也会留一条记录");
      if (!body.includes("noteOpened(file.path)"))
        v.push("记的必须是 Rust 回的那条路径（已归一化），不是前端手上的原始串");
      return v;
    };
    expect(check(files), "真实源码的违规条目").toEqual([]);
    const degraded = files
      .replace("    noteOpened(file.path);\n", "")
      .replace(
        "    const file = await openFile(target, encoding ?? null);",
        "    noteOpened(target);\n    const file = await openFile(target, encoding ?? null);",
      );
    expect(degraded, "替身必须真的改了地方（没改上就是拿原文件自证通过 = 恒真）").not.toEqual(
      files,
    );
    expect(check(degraded), "退化替身必须被点名").toEqual([
      "记入排在读盘之前：取消对话框与读盘失败也会留一条记录",
      "记的必须是 Rust 回的那条路径（已归一化），不是前端手上的原始串",
    ]);
  });

  it("会话恢复与各条打开旁路都不许记 —— 恢复走 rebuild 的 open_file，压根不是「打开」这个动作", () => {
    for (const f of [
      "src/session/rebuild.ts",
      "src/session/persist.ts",
      "src/tabs/lifecycle.ts",
      "src/multiwindow/windows.ts",
      "src/ui.ts",
    ]) {
      expect(readFileSync(f, "utf-8"), `${f} 里不该出现记入调用`).not.toContain("noteOpened");
    }
    // 把恢复改成「借道 doOpen」同样能让它进名单 —— 那等于让一次重构顺手决定「恢复算不算
    // 打开」这句话。要改，先回来改这条契约与用户确认。
    expect(
      readFileSync("src/session/rebuild.ts", "utf-8"),
      "恢复流程不许借用打开那条漏斗（doOpen 现在是「用户打开了它」的同义词）",
    ).not.toMatch(/\bdoOpen\(/);
  });

  it("旧那套「整份可见集合上报」不许回来（回来了就又开始把恢复记成打开）", () => {
    expect(files).not.toMatch(/reportOpenedPaths|visibleOpenPaths/);
    expect(readFileSync("src/ui.ts", "utf-8")).not.toMatch(/reportOpenedPaths|visibleOpenPaths/);
    expect(readFileSync("src/recents/store.ts", "utf-8")).not.toMatch(/lastReportedKey/);
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
    // B307：收起的是**外壳**，两块面板各自只带「轮到我没」那一层。
    // 首屏必须连壳一起藏着，否则开屏先画出一块抽屉再被启动回放收掉。
    expect(html, "外壳首屏就得藏着").toMatch(/id="side-drawer"[^>]*hidden/);
  });

  it("B307：外壳 `.side-drawer` 也写了 display ⇒ 同样要一条 [hidden] 兜底", () => {
    // 与下面 `.recent-panel` 那条是同一个坑：作者样式表的 `display: flex` 压过 UA 的隐藏规则。
    // 壳是这一族里最要命的一个 —— 它漏了就是「两块抽屉一起占着位，左栏折不起来」。
    expect(css).toMatch(/\.side-drawer\s*\{[^}]*display:\s*flex/);
    expect(css, "没这条就是「收了壳却还占着一片」").toMatch(
      /\.side-drawer\[hidden\]\s*\{[^}]*display:\s*none/,
    );
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

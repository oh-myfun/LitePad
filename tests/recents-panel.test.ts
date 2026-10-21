// @vitest-environment jsdom
// B305 Task 6 · 面板行为。用**真实的 index.html 骨架**跑：`#side-recent` / `#recent-panel`
// 那些节点必须真在，否则测的是测试自己搭的假结构。
//
// ⚠️ 顺序有讲究：`src/ui.ts` 在**模块求值时**就 `el("layout-area")` 逐个取节点、取不到就抛。
//    而 ESM 的 `import` 声明比文件正文先执行 ⇒ 静态 import 一定会抢在 `innerHTML` 之前炸。
//    所以这里先把骨架装好，再动态 import 被测模块。
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const h = vi.hoisted(() => ({
  entries: [] as {
    path: string;
    name: string;
    openedAt: number;
    /** B332：旧样本一律不写这一格 = 当作文件（与 Rust 读旧盘的 `#[serde(default)]` 同一口径）。 */
    kind?: "file" | "folder";
  }[],
  limit: 20,
  onRecentsChange: vi.fn((_cb: (e: unknown[]) => void) => () => {}),
  forgetRecentEntry: vi.fn(() => Promise.resolve()),
  clearRecentEntries: vi.fn(() => Promise.resolve()),
  openPath: vi.fn((_path: string) => Promise.resolve(null)),
}));

vi.mock("../src/recents/store", () => ({
  onRecentsChange: h.onRecentsChange,
  getRecents: () => h.entries,
  getRecentLimit: () => h.limit,
  forgetRecentEntry: h.forgetRecentEntry,
  clearRecentEntries: h.clearRecentEntries,
}));

vi.mock("../src/io/files", () => ({
  doOpen: (path: string) => h.openPath(path),
}));

let panel: typeof import("../src/recents/panel");
let drawer: typeof import("../src/shell/drawer");
let appState: typeof import("../src/core/app-state");
let ui: typeof import("../src/ui");

beforeAll(async () => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
  [panel, drawer, appState, ui] = await Promise.all([
    import("../src/recents/panel"),
    import("../src/shell/drawer"),
    import("../src/core/app-state"),
    import("../src/ui"),
  ]);
  // 大纲那一块也登记进外壳：生产里由 `setupSideBar` 做，这里不装配整条按钮列，
  // 但互斥的判据（`tocPanel.hidden`）要有写它的人，否则测的是「没人登记」而不是「互斥」。
  drawer.registerDrawerView("toc", {
    panel: ui.tocPanel,
    button: ui.sideOutline,
    onShow: () => {},
  });
});

/** 三条样本：两个同名不同目录（B 行形状就是为了分开它们）+ 一个别的目录。 */
function seed(): void {
  const now = Date.now();
  h.entries = [
    { path: "D:\\工作\\报价\\单.md", name: "单.md", openedAt: now - 60_000 },
    { path: "D:\\工作\\10月\\单.md", name: "单.md", openedAt: now - 3_600_000 },
    { path: "C:\\notes\\三.md", name: "三.md", openedAt: now - 86_400_000 * 2 },
  ];
  h.limit = 20;
}

beforeEach(() => {
  appState.setWindowKind("main");
  seed();
  vi.clearAllMocks();
  panel.setupRecentsPanel();
  // B307：显隐归外壳（`setDrawer` 是唯一出口），面板自己不再有别出口。
  drawer.setDrawer(null, false);
  panel.renderRecents();
});

const rows = () => [...document.querySelectorAll<HTMLElement>(".recent-row")];

describe("B305 最近打开面板", () => {
  it("B332：文件夹那一组始终排在文件之上，两类都在时才挂分组标题", () => {
    const now = Date.now();
    h.entries = [
      { path: "C:\\notes\\a.md", name: "a.md", openedAt: now - 1_000 },
      { path: "D:\\工作\\报价", name: "报价", openedAt: now - 2_000, kind: "folder" },
      { path: "C:\\notes\\b.md", name: "b.md", openedAt: now - 3_000 },
      { path: "D:\\other", name: "other", openedAt: now - 4_000, kind: "folder" },
    ];
    panel.renderRecents();
    expect(
      rows().map((r) => r.dataset.path),
      "桶内保持 Rust 给的那个顺序（新→旧），桶间才是文件夹在上",
    ).toEqual(["D:\\工作\\报价", "D:\\other", "C:\\notes\\a.md", "C:\\notes\\b.md"]);
    expect(
      [...document.querySelectorAll(".recent-group")].map((g) => g.textContent),
      "两类都在 ⇒ 各挂一个标题，否则光看名字分不清哪个是目录",
    ).toEqual(["文件夹", "文件"]);
  });

  it("B332：只有一类时不挂标题（整屏本来就是那一类，标题是噪音）", () => {
    seed(); // 三条全是文件
    panel.renderRecents();
    expect(document.querySelectorAll(".recent-group").length).toBe(0);
    expect(rows().length, "行数不许因为标题而少一条").toBe(3);
  });

  it("B332：计数那颗按两类各报一次（上限现在是**每类**的，合起来报会读成「快满了」）", () => {
    const now = Date.now();
    h.entries = [
      { path: "D:\\工作\\报价", name: "报价", openedAt: now - 1_000, kind: "folder" },
      { path: "D:\\other", name: "other", openedAt: now - 2_000, kind: "folder" },
      { path: "C:\\notes\\a.md", name: "a.md", openedAt: now - 3_000 },
    ];
    h.limit = 20;
    panel.renderRecents();
    expect(ui.recentCount.textContent).toBe("2+1/20");
    expect(ui.recentCount.getAttribute("aria-label")).toBe("文件夹 2 条、文件 1 条，每类上限 20");
  });

  it("点「最近打开」⇒ 自己摊开、大纲收起（两块互斥，同时只露一块）", () => {
    drawer.setDrawer("recent", false);
    expect(ui.recentPanel.hidden, "最近打开没摊开").toBe(false);
    expect(ui.sideDrawer.hidden, "外壳自己也得跟着摊开").toBe(false);
    expect(ui.tocPanel.hidden, "大纲必须一起收起").toBe(true);
    expect(ui.sideRecent.classList.contains("is-on"), "键要点亮").toBe(true);
    expect(ui.sideRecent.getAttribute("aria-pressed")).toBe("true");
  });

  it("大纲那条路摊开时 ⇒ 最近打开收起来（两个方向都得闭合，否则能同时露两块）", () => {
    drawer.setDrawer("recent", false);
    drawer.setDrawer("toc", false);
    expect(ui.recentPanel.hidden, "大纲打开时最近打开还摊着 ⇒ 两块抽屉并排占位").toBe(true);
    expect(ui.sideRecent.classList.contains("is-on"), "收掉了键还亮着就是半同步").toBe(false);
    expect(ui.sideRecent.getAttribute("aria-pressed")).toBe("false");
  });

  it("一行两截：主行文件名、次行目录（用户选的 B 形状）", () => {
    panel.renderRecents();
    const [first, second] = rows();
    expect(first.querySelector(".recent-name")?.textContent).toBe("单.md");
    expect(first.querySelector(".recent-dir")?.textContent).toBe("D:\\工作\\报价");
    expect(second.querySelector(".recent-dir")?.textContent).toBe("D:\\工作\\10月");
  });

  it("路径里的尖括号只当文字，不当标签（不许拿 innerHTML 拼用户路径）", () => {
    h.entries = [
      { path: "C:\\a\\<img src=x onerror=alert(1)>.md", name: "x", openedAt: Date.now() },
    ];
    panel.renderRecents();
    expect(document.querySelector("img"), "路径被当成 HTML 注入了").toBeNull();
    expect(rows()[0].dataset.path).toBe("C:\\a\\<img src=x onerror=alert(1)>.md");
  });

  it("悬停属性带完整路径与相对时间（截断了也有地方看全）", () => {
    panel.renderRecents();
    const row = rows()[0];
    expect(row.getAttribute("data-tip")).toBe("D:\\工作\\报价\\单.md");
    expect(row.getAttribute("data-tip-detail")).toContain("分钟前");
  });

  it("标题栏计数是「文件夹+文件/每类上限」（B332 起两类各一份额度）", () => {
    panel.renderRecents(); // seed() 那三条都是文件
    expect(ui.recentCount.textContent).toBe("0+3/20");
  });

  it("上限 0 ⇒ 空态说清「不是还没打开过，是不再记录」", () => {
    h.entries = [];
    h.limit = 0;
    panel.renderRecents();
    expect(ui.recentList.textContent).toBe("已停止记录（上限为 0）");
  });

  it("上限 0 ⇒ 那颗键整条收掉不占位，正摊着的抽屉一起收起", () => {
    drawer.setDrawer("recent", false);
    expect(ui.sideRecent.hidden, "上限 20 时键该在").toBe(false);
    h.limit = 0;
    panel.renderRecents();
    // 入口留着就是「点进去只有一句已停止记录」：功能关了就把门也关上。
    expect(ui.sideRecent.hidden, "上限 0 还留着入口").toBe(true);
    expect(ui.sideDrawer.hidden, "门收了外壳还摊着 ⇒ 一块没有入口的抽屉").toBe(true);
    expect(ui.recentPanel.hidden, "外壳收了这一块也必须跟着收").toBe(true);
    expect(ui.sideRecent.classList.contains("is-on"), "收掉的键不许还亮着").toBe(false);
  });

  it("上限从 0 调回非 0 ⇒ 键跟着回来（不许做成单向的门）", () => {
    h.limit = 0;
    panel.renderRecents();
    expect(ui.sideRecent.hidden).toBe(true);
    h.limit = 50;
    panel.renderRecents();
    expect(ui.sideRecent.hidden, "把上限调回来门却永远回不来").toBe(false);
  });

  it("上限 0 时点快捷键：不摊开抽屉，也不顺手把整条左栏放出来", () => {
    h.limit = 0;
    panel.renderRecents();
    ui.mainRow.classList.add("is-sidebar-off");
    panel.toggleRecentPanel();
    expect(ui.recentPanel.hidden, "功能关着却把抽屉打开了").toBe(true);
    // `toggleRecentPanel` 开头有一句「整栏收着先放出来」：功能关着时这句也不许跑到，
    // 否则一次空转就把用户的「左栏收起」偏好改掉了（还会落盘）。
    expect(ui.mainRow.classList.contains("is-sidebar-off"), "空转改掉了整栏收起态").toBe(true);
    ui.mainRow.classList.remove("is-sidebar-off");
  });

  it("名单空 ⇒ 空态是「还没有打开过的文件」", () => {
    h.entries = [];
    panel.renderRecents();
    expect(ui.recentList.textContent).toBe("还没有打开过的文件或文件夹");
  });

  it("点一行 ⇒ 用那一行的路径走现有打开流程", () => {
    panel.renderRecents();
    rows()[2].click();
    expect(h.openPath).toHaveBeenCalledWith("C:\\notes\\三.md");
  });

  it("悬停那颗 ✕ ⇒ 只清那一条", () => {
    panel.renderRecents();
    const del = rows()[1].querySelector<HTMLElement>(".recent-del");
    expect(del, "行里没有单条清除键").not.toBeNull();
    del!.click();
    expect(h.forgetRecentEntry).toHaveBeenCalledWith("D:\\工作\\10月\\单.md");
  });

  it("点 ✕ 不许同时触发「打开这一行」（同一颗点击面里的两个动作）", () => {
    panel.renderRecents();
    rows()[0].querySelector<HTMLElement>(".recent-del")!.click();
    expect(h.openPath).not.toHaveBeenCalled();
  });

  it("标题栏那颗垃圾桶 ⇒ 清空并留一句提示", async () => {
    panel.renderRecents();
    document.getElementById("recent-clear")!.click();
    // 清空是异步的（`await` 回包之后才发提示），不排一下微任务就会读到还没写的状态栏。
    await Promise.resolve();
    await Promise.resolve();
    expect(h.clearRecentEntries).toHaveBeenCalledTimes(1);
    expect(document.body.textContent ?? "").toContain("已清空");
  });

  it("子窗口里那颗键空转（Review Focus #5：看不见的面板不该被打开并写脏设置）", () => {
    appState.setWindowKind("satellite");
    panel.toggleRecentPanel();
    expect(ui.recentPanel.hidden, "子窗口把抽屉打开了").toBe(true);
    appState.setWindowKind("main");
  });

  it("relativeTime 六档文案", () => {
    // ⚠️ 全部用**本地时间**构造：`Date.UTC` 配 `getHours()` 会把用例挂在「这台机器是
    //    UTC+8」这个前提上，换时区就假红（HH:mm 那几档尤其明显）。
    const now = new Date(2026, 9, 19, 12, 0, 0).getTime();
    expect(panel.relativeTime(now - 30_000, now)).toBe("刚刚");
    expect(panel.relativeTime(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(panel.relativeTime(new Date(2026, 9, 19, 9, 0, 0).getTime(), now)).toBe("3 小时前");
    expect(panel.relativeTime(new Date(2026, 9, 18, 12, 40, 0).getTime(), now)).toBe("昨天 12:40");
    expect(panel.relativeTime(new Date(2026, 9, 16, 12, 0, 0).getTime(), now)).toBe(
      "10月16日 12:00",
    );
    expect(panel.relativeTime(new Date(2019, 0, 2, 8, 0, 0).getTime(), now)).toBe("2019年1月2日");
  });

  it("dirOf 两种分隔符与无目录输入", () => {
    expect(panel.dirOf("C:\\a\\b.md")).toBe("C:\\a");
    expect(panel.dirOf("/x/y/z.md")).toBe("/x/y");
    expect(panel.dirOf("bare.md")).toBe("");
  });
});

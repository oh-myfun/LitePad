// @vitest-environment jsdom
// B307 · 展开区**外壳**（`src/shell/drawer.ts`）。
//
// 用真实 index.html 骨架跑：壳 / 两块面板 / 两颗键 / 分隔条都得是真节点，
// 否则测的是测试自己搭的假结构（口径同 tests/recents-panel.test.ts）。
//
// ⚠️ `src/ui.ts` 在**模块求值时**就逐个 `el(id)` 取节点、取不到就抛 ⇒ 必须先灌骨架再
//    动态 import，静态 import 一定抢在 `innerHTML` 之前炸。
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const h = vi.hoisted(() => ({ saved: [] as Record<string, unknown>[] }));

// ⚠️ **部分** mock（保留真身，只换 `saveSettings`）：整表替换那份清单少列一个导出，
//    就会在别的模块的调用点上炸出「全绿 + 一个未处理拒绝」（B305 踩过）。
vi.mock("../src/ipc/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/ipc/api")>();
  return {
    ...real,
    saveSettings: (s: Record<string, unknown>): Promise<void> => {
      h.saved.push(structuredClone(s));
      return Promise.resolve();
    },
  };
});

let drawer: typeof import("../src/shell/drawer");
let ui: typeof import("../src/ui");
let appState: typeof import("../src/core/app-state");

beforeAll(async () => {
  const html = readFileSync("index.html", "utf-8");
  const body = (html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  document.body.innerHTML = body;
  [drawer, ui, appState] = await Promise.all([
    import("../src/shell/drawer"),
    import("../src/ui"),
    import("../src/core/app-state"),
  ]);
  // 分隔条只挂一次：`attachSideResizer` 是往元素上加监听，重复装配会让一次拖拽被处理好几遍。
  drawer.setupSideResizer();
});

/** 两块视图都登记进来（生产里分别在 setupSideBar / setupRecentsPanel 里登记）。 */
function registerBoth(): void {
  drawer.registerDrawerView("toc", {
    panel: ui.tocPanel,
    button: ui.sideOutline,
    onShow: () => {},
  });
  drawer.registerDrawerView("recent", {
    panel: ui.recentPanel,
    button: ui.sideRecent,
    onShow: () => {},
  });
}

function mouse(el: EventTarget, type: string, clientX: number): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, button: 0 }));
}

/** 一次完整拖拽：按下 → 移动 → 松手。 */
function drag(resizer: EventTarget, from: number, to: number): void {
  mouse(resizer, "mousedown", from);
  mouse(document, "mousemove", to);
  mouse(document, "mouseup", to);
}

beforeEach(() => {
  appState.setSettings({ toc_open: false, drawer_view: "toc", toc_width: 240 } as never);
  h.saved.length = 0;
  registerBoth();
  drawer.setDrawer(null, false);
});

describe("B307 展开区外壳", () => {
  it('setDrawer("toc") 一次写齐六件事：壳 / 竖线 / 缝 / 两块面板 / 两颗键 / 重绘', () => {
    const shown: string[] = [];
    drawer.registerDrawerView("toc", {
      panel: ui.tocPanel,
      button: ui.sideOutline,
      onShow: () => shown.push("toc"),
    });
    drawer.registerDrawerView("recent", {
      panel: ui.recentPanel,
      button: ui.sideRecent,
      onShow: () => shown.push("recent"),
    });
    drawer.setDrawer("toc", false);
    expect(ui.sideDrawer.hidden, "外壳没摊开").toBe(false);
    expect(
      ui.sideShell.classList.contains("is-collapsed"),
      "竖线还被收着 ⇒ 就是用户报的那个症状",
    ).toBe(false);
    expect(ui.sideResizer.classList.contains("is-off"), "收起态的缝标记没翻过来").toBe(false);
    expect(ui.tocPanel.hidden, "轮到大纲却还藏着").toBe(false);
    expect(ui.recentPanel.hidden, "互斥没生效 ⇒ 两块同时摊着").toBe(true);
    expect(ui.sideOutline.classList.contains("is-on"), "键要点亮").toBe(true);
    expect(ui.sideOutline.getAttribute("aria-pressed")).toBe("true");
    expect(ui.sideRecent.classList.contains("is-on"), "收掉的键不许还亮着").toBe(false);
    expect(shown, "只该重绘当前那一块").toEqual(["toc"]);
  });

  it("setDrawer(null)：两块都收、卡片挂回 is-collapsed、两颗键都灭", () => {
    drawer.setDrawer("recent", false);
    drawer.setDrawer(null, false);
    expect(ui.sideDrawer.hidden).toBe(true);
    expect(ui.sideShell.classList.contains("is-collapsed"), "折着却不收线 ⇒ 2px 粗的一条").toBe(
      true,
    );
    expect(ui.tocPanel.hidden).toBe(true);
    expect(ui.recentPanel.hidden).toBe(true);
    expect(ui.sideRecent.classList.contains("is-on")).toBe(false);
    expect(ui.sideRecent.getAttribute("aria-pressed")).toBe("false");
  });

  it("换视图是**一次调用**：不许出现两块同时摊着、也不许出现都不摊着", () => {
    drawer.setDrawer("toc", false);
    drawer.setDrawer("recent", false);
    expect(ui.recentPanel.hidden).toBe(false);
    expect(ui.tocPanel.hidden, "切到最近却把大纲留着 ⇒ 并排占位").toBe(true);
    expect(ui.sideDrawer.hidden, "换视图时外壳自己关了").toBe(false);
    expect(ui.sideRecent.classList.contains("is-on")).toBe(true);
    expect(ui.sideOutline.classList.contains("is-on")).toBe(false);
  });

  it("面板的 hidden 只表示「轮到我没」：外壳收起时两块都是 hidden", () => {
    // `markdown.ts` 那一路与 `updateTocDrawer` 的早退都拿 `tocPanel.hidden` 当「大纲正摊着」，
    // 这条把它钉死：收起外壳 ⇒ 大纲那块也必须 hidden（不是只把壳藏起来）。
    drawer.setDrawer("toc", false);
    drawer.setDrawer(null, false);
    expect(ui.tocPanel.hidden).toBe(true);
  });

  it("落盘两格各管一件事：开没开写 toc_open，开着的是谁写 drawer_view", () => {
    drawer.setDrawer("toc");
    expect(appState.settings?.toc_open, "大纲摊开必须记 true").toBe(true);
    expect(appState.settings?.drawer_view).toBe("toc");
    drawer.setDrawer("recent");
    expect(appState.settings?.toc_open, "B312：壳一样是摊开的，不许因为换了一块就记 false").toBe(
      true,
    );
    expect(appState.settings?.drawer_view).toBe("recent");
    drawer.setDrawer(null);
    expect(appState.settings?.toc_open).toBe(false);
    expect(appState.settings?.drawer_view, "收起不许抹掉最后一次摊开的那块").toBe("recent");
    expect(
      h.saved.map((s) => s.toc_open),
      "每一次都要真的落盘",
    ).toEqual([true, true, false]);
  });

  it("persist = false 的启动回放只搬 DOM，不反写盘（免得把默认值固化成用户设置）", () => {
    drawer.setDrawer("toc", false);
    expect(ui.sideDrawer.hidden).toBe(false);
    expect(h.saved, "回放不该发一次 saveSettings").toEqual([]);
  });
});

describe("B312 展开区「哪一块」也进设置", () => {
  it("启动回放读两格：开着的是最近 ⇒ 那块摊开，且不反写盘", () => {
    appState.setSettings({ toc_open: true, drawer_view: "recent", toc_width: 240 } as never);
    drawer.replayDrawer();
    expect(ui.sideDrawer.hidden, "回放说开着，壳就该开着").toBe(false);
    expect(ui.recentPanel.hidden, "该摊开的是最近那块").toBe(false);
    expect(ui.tocPanel.hidden, "互斥照旧").toBe(true);
    expect(h.saved, "回放只是搬 DOM").toEqual([]);
  });

  it("toc_open 为 false 时收起，但「哪一块」照旧搬进 lastView（拖分隔条拖回来露它）", () => {
    appState.setSettings({ toc_open: false, drawer_view: "recent", toc_width: 240 } as never);
    drawer.replayDrawer();
    expect(ui.sideDrawer.hidden).toBe(true);
    drag(ui.sideResizer, 100, 300);
    expect(ui.sideDrawer.hidden, "拖开没生效").toBe(false);
    expect(ui.recentPanel.hidden, "拖回来露的是大纲而不是盘上那块").toBe(false);
  });

  it("盘上是未知值（手改文件 / 别的版本写的串）⇒ 回落大纲，不许把壳搞崩", () => {
    appState.setSettings({ toc_open: true, drawer_view: "nope", toc_width: 240 } as never);
    drawer.replayDrawer();
    expect(ui.sideDrawer.hidden).toBe(false);
    expect(ui.tocPanel.hidden).toBe(false);
    expect(ui.recentPanel.hidden).toBe(true);
  });

  it("登记晚于回放的那一块，登记那一刻补写当前开合态", async () => {
    // 生产次序就是这样：回放排在 setupShell 里，最近那块排在会话恢复之后才登记。
    // 外壳的循环只认已登记的视图 ⇒ 迟到者在「壳已开、它还没进册」那一刻必须补上，
    // 否则重启后「最近打开」永远是一片空白。
    vi.resetModules();
    const [d, ui2, st] = await Promise.all([
      import("../src/shell/drawer"),
      import("../src/ui"),
      import("../src/core/app-state"),
    ]);
    st.setSettings({ toc_open: true, drawer_view: "recent", toc_width: 240 } as never);
    d.replayDrawer();
    expect(ui2.sideDrawer.hidden, "回放判的是外壳，与登没登记无关").toBe(false);
    d.registerDrawerView("recent", {
      panel: ui2.recentPanel,
      button: ui2.sideRecent,
      onShow: () => {},
    });
    expect(ui2.recentPanel.hidden, "迟到的那块没在登记时补写 ⇒ 壳开着却空一片").toBe(false);
    expect(ui2.sideRecent.classList.contains("is-on"), "那颗键也要补亮").toBe(true);
    expect(ui2.sideRecent.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("B307 分隔条归外壳", () => {
  it("宽度只写在壳上：两块面板都不带 inline 宽度（抄送那一步整个没了）", () => {
    expect(ui.sideDrawer.style.width, "attach 那一刻就该把宽度落到壳上").toBeTruthy();
    expect(ui.tocPanel.style.width, "大纲那块还被人写宽度 = 第二处口径").toBe("");
    expect(ui.recentPanel.style.width, "最近那块还被人写宽度 = 第二处口径").toBe("");
  });

  it("换视图不许跳宽（壳带着 inline 宽度走）", () => {
    drawer.setDrawer("toc", false);
    drag(ui.sideResizer, 500, 700);
    const w = ui.sideDrawer.style.width;
    expect(Number.parseInt(w, 10), "拖宽之后壳得真的变宽").toBeGreaterThan(240);
    drawer.setDrawer("recent", false);
    expect(ui.sideDrawer.style.width, "换一块抽屉宽度跳回默认").toBe(w);
  });

  it("拖到收起再拖回来：恢复的是上次摊开的那一块，而不是永远大纲", () => {
    drawer.setDrawer("recent", false);
    // 收起：往左拖过的距离**大于当前宽度 + 阈值**（阈值 = 最小宽的一半 = 80），
    // 不写死数字是为了不受前面几条拖拽留下的宽度影响。
    drag(ui.sideResizer, 1000, 100);
    expect(ui.sideDrawer.hidden, "拖过线了壳却没收起").toBe(true);
    // 展开：壳不占位时锚从 0 起算，拖 200px 稳过那条线。
    drag(ui.sideResizer, 100, 300);
    expect(ui.sideDrawer.hidden, "拖回来没放开").toBe(false);
    expect(ui.recentPanel.hidden, "放出来的是大纲而不是上次那块").toBe(false);
    expect(ui.tocPanel.hidden).toBe(true);
  });
});
